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
  type TokenHolderShare,
  type PieceReceipt,
} from './piece-payment.js';

export interface StreamingLoopOptions {
  viewer: Wallet;
  holders: TokenHolderShare[];
  satsPerPiece: number;
  /** Desired target pieces-per-second; realised rate may be lower. */
  piecesPerSecond: number;
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
  private handle: ReturnType<typeof setInterval> | null = null;
  private busy = false;
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
      if (this.busy) return;
      this.busy = true;
      this.fireOnce()
        .catch((err: unknown) => {
          this.errors++;
          const e = err instanceof Error ? err : new Error(String(err));
          this.opts.onError?.(e, this.errors);
        })
        .finally(() => {
          this.busy = false;
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
   */
  async fireOnce(): Promise<PieceReceipt> {
    const broadcaster = this.opts.broadcaster ?? broadcastPiecePayment;
    const receipt = await broadcaster({
      viewer: this.opts.viewer,
      holders: this.opts.holders,
      satsPerPiece: this.opts.satsPerPiece,
    });
    this.piecesBroadcast++;
    this.opts.onPiece?.(receipt);
    return receipt;
  }
}
