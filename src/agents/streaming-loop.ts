/**
 * StreamingLoop — drives a continuous sequence of per-piece
 * fan-out broadcasts for a single production.
 *
 * Given a viewer wallet, a token-holder set, and a target rate in
 * pieces-per-second, the loop calls broadcastPiecePayment at a
 * steady cadence. This is the primary TX generator for the BSVA
 * Open Run Agentic Pay 1.5M-in-24h requirement.
 *
 * Why a dedicated loop class instead of a setInterval inside an
 * Agent subclass? The piece cadence needs to be decoupled from the
 * agent tick rate so we can crank it up independently for the 24h
 * volume run without also spinning the agent decision loop that
 * fast. One agent can run many streaming loops in parallel (one
 * per production it is currently watching).
 */

import type { Wallet } from '../payment/wallet.js';
import {
  broadcastPiecePayment,
  broadcastPiecePaymentPooled,
  type TokenHolderShare,
  type PieceReceipt,
} from './piece-payment.js';
import type { UtxoPool } from './utxo-pool.js';
import type { TxBroadcaster } from '../payment/broadcaster.js';

export interface StreamingLoopOptions {
  viewer: Wallet;
  holders: TokenHolderShare[];
  satsPerPiece: number;
  /** Desired target pieces-per-second; realised rate may be lower. */
  piecesPerSecond: number;
  /**
   * Maximum concurrent in-flight broadcasts per loop. When network
   * latency dominates (every broadcast is 200-500ms against WoC),
   * allowing concurrency is the only way a single loop can exceed
   * 2 TX/s. Defaults to 1 for backwards compatibility; raise it to
   * 3-5 for the live swarm.
   */
  maxInflight?: number;
  /**
   * Optional callback fired after every successful broadcast.
   * Used by the swarm coordinator to update counters and the UI.
   */
  onPiece?: (receipt: PieceReceipt) => void;
  /**
   * Optional callback fired when a broadcast attempt fails.
   * The loop keeps running regardless; skip count is incremented.
   */
  onError?: (err: Error, attempt: number) => void;
  /**
   * Optional pre-primed UtxoPool. When provided, the loop uses
   * broadcastPiecePaymentPooled which reuses cached source
   * transactions and avoids WhatsOnChain UTXO / tx fetches on every
   * piece. Strongly recommended for any sustained run.
   */
  pool?: UtxoPool;
  /**
   * Optional alternative broadcaster (e.g. ArcBroadcaster). Used
   * only when `pool` is also set. When omitted, piece TXs are
   * broadcast via the viewer wallet's own .broadcast() method,
   * which hits WhatsOnChain.
   */
  txBroadcaster?: TxBroadcaster;
  /**
   * Optional callback the loop calls INSTEAD of broadcastPiecePayment.
   * Used by unit tests to avoid network traffic. When provided, the
   * loop passes the same arguments and treats the returned receipt
   * as the broadcast result.
   */
  broadcaster?: (opts: {
    viewer: Wallet;
    holders: TokenHolderShare[];
    satsPerPiece: number;
  }) => Promise<PieceReceipt>;
}

export class StreamingLoop {
  private readonly opts: StreamingLoopOptions;
  private readonly maxInflight: number;
  private handle: ReturnType<typeof setInterval> | null = null;
  private inflight = 0;
  private piecesBroadcast = 0;
  private errors = 0;
  private startedAt = 0;

  constructor(opts: StreamingLoopOptions) {
    if (opts.piecesPerSecond <= 0) {
      throw new Error('piecesPerSecond must be > 0');
    }
    if (opts.satsPerPiece <= 0) {
      throw new Error('satsPerPiece must be > 0');
    }
    if (opts.holders.length === 0) {
      throw new Error('holders must be non-empty');
    }
    this.maxInflight = opts.maxInflight ?? 1;
    if (this.maxInflight < 1) {
      throw new Error('maxInflight must be >= 1');
    }
    this.opts = opts;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  get stats(): {
    piecesBroadcast: number;
    errors: number;
    elapsedMs: number;
    realisedRate: number;
  } {
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const realisedRate =
      elapsedMs > 0 ? (this.piecesBroadcast * 1000) / elapsedMs : 0;
    return {
      piecesBroadcast: this.piecesBroadcast,
      errors: this.errors,
      elapsedMs,
      realisedRate,
    };
  }

  start(): void {
    if (this.handle) return;
    const intervalMs = Math.max(1, Math.floor(1000 / this.opts.piecesPerSecond));
    this.startedAt = Date.now();
    this.handle = setInterval(() => {
      if (this.inflight >= this.maxInflight) return;

      // Pool-aware short-circuit: if a pool is wired in and every
      // slot is exhausted, stop the loop instead of grinding out
      // guaranteed-to-fail broadcasts. Without this the loop prints
      // thousands of [465] errors per minute after the slots bleed
      // below ARC's fee floor, which drowns out every other log line.
      const pool = this.opts.pool;
      if (pool && pool.size > 0 && pool.availableCount === 0) {
        const retired = pool.retiredCount;
        if (retired === pool.size) {
          const e = new Error(
            `UtxoPool exhausted: all ${pool.size} slots retired (balance below minimum). ` +
              `Re-prime the pool with a higher --sats-per-slot to keep streaming.`,
          );
          this.errors++;
          this.opts.onError?.(e, this.errors);
          this.stop();
          return;
        }
        // Otherwise the slots are frozen on chain-depth cooldown —
        // skip this tick and wait. Don't count as an error.
        return;
      }

      this.inflight++;
      this.fireOnce()
        .catch((err: unknown) => {
          this.errors++;
          const e = err instanceof Error ? err : new Error(String(err));
          this.opts.onError?.(e, this.errors);
        })
        .finally(() => {
          this.inflight--;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * Fire a single broadcast immediately, outside the interval. The
   * live swarm calls this at startup to emit a first TX without
   * waiting a full interval.
   *
   * Precedence:
   *   - explicit broadcaster (tests) wins
   *   - else if a pool was provided, use the pooled hot path
   *   - else fall back to fetchUtxos-every-time (legacy, network-heavy)
   */
  async fireOnce(): Promise<PieceReceipt> {
    let receipt: PieceReceipt;
    if (this.opts.broadcaster) {
      receipt = await this.opts.broadcaster({
        viewer: this.opts.viewer,
        holders: this.opts.holders,
        satsPerPiece: this.opts.satsPerPiece,
      });
    } else if (this.opts.pool) {
      receipt = await broadcastPiecePaymentPooled({
        viewer: this.opts.viewer,
        holders: this.opts.holders,
        satsPerPiece: this.opts.satsPerPiece,
        pool: this.opts.pool,
        broadcaster: this.opts.txBroadcaster,
      });
    } else {
      receipt = await broadcastPiecePayment({
        viewer: this.opts.viewer,
        holders: this.opts.holders,
        satsPerPiece: this.opts.satsPerPiece,
      });
    }
    this.piecesBroadcast++;
    this.opts.onPiece?.(receipt);
    return receipt;
  }
}
