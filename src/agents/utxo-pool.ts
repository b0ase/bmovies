/**
 * UtxoPool — parallel UTXO slots for sustained high-rate broadcasting.
 *
 * bMovies's streaming loop broadcasts a new on-chain tx for
 * every piece served. Naively chaining these (each piece spending
 * the change output of the previous) runs into two walls almost
 * immediately:
 *
 *   1. BSV mempool ancestor policy rejects the ~25th unconfirmed
 *      descendant in a single chain ("too-long-mempool-chain").
 *   2. Every call to fetchUtxos / fetchTransaction hammers
 *      WhatsOnChain and trips their free-tier rate limit.
 *
 * UtxoPool solves both by:
 *
 *   - prime()ing once: broadcast a single split transaction that
 *     divides a large viewer UTXO into N equal "slots". Each slot
 *     becomes the root of an independent ancestry chain.
 *   - allocate()ing round-robin so consecutive piece broadcasts
 *     sit on DIFFERENT chains, spreading mempool pressure.
 *   - record()ing the change output from each successful spend
 *     back into the same slot, keeping its chain depth accurate.
 *   - freezing slots that hit maxChainDepth for a cooldown window
 *     so we wait for block confirmation rather than getting
 *     rejected.
 *
 * After prime() the hot loop never calls fetchUtxos or
 * fetchTransaction again — it builds piece transactions from the
 * cached Transaction objects in memory and only hits the network
 * for the final broadcast.
 */

import { Transaction, P2PKH } from '@bsv/sdk';
import { NETWORK_FEE_MODEL, type Wallet } from '../payment/wallet.js';
import type { TxBroadcaster } from '../payment/broadcaster.js';

export interface UtxoSlot {
  sourceTx: Transaction;
  vout: number;
  satoshis: number;
  /** Unconfirmed ancestor depth from the currently spendable UTXO */
  chainDepth: number;
  /**
   * True while a broadcast against this slot is in flight. Set by
   * allocate(), cleared by record() or release(). Prevents a
   * second concurrent allocate() from handing out the same slot
   * to a different worker (which would produce a double-spend).
   */
  reserved: boolean;
  /**
   * If set, the slot is frozen until this timestamp. Used after
   * chainDepth hits the limit to wait for a block confirmation
   * that clears the ancestor chain.
   */
  frozenUntil?: number;
}

export interface UtxoPoolOptions {
  /**
   * Maximum allowed unconfirmed ancestors per slot. BSV mempool
   * default is 25; we leave a safety margin of 5 and cap at 20.
   */
  maxChainDepth?: number;
  /**
   * How long to freeze a slot after it hits maxChainDepth, in ms.
   * One BSV block is ~10 minutes, so 12 minutes is a safe default.
   */
  cooldownMs?: number;
}

export class UtxoPool {
  private slots: UtxoSlot[] = [];
  private cursor = 0;
  private readonly maxChainDepth: number;
  private readonly cooldownMs: number;
  /** Running counts for dashboard / debugging */
  private stats = {
    allocations: 0,
    recordings: 0,
    freezes: 0,
    starves: 0,
    releases: 0,
  };

  constructor(opts: UtxoPoolOptions = {}) {
    this.maxChainDepth = opts.maxChainDepth ?? 20;
    this.cooldownMs = opts.cooldownMs ?? 12 * 60 * 1000;
  }

  get size(): number {
    return this.slots.length;
  }

  get availableCount(): number {
    const now = Date.now();
    return this.slots.filter(
      (s) =>
        !s.reserved &&
        s.chainDepth < this.maxChainDepth &&
        (!s.frozenUntil || s.frozenUntil <= now),
    ).length;
  }

  getStats(): typeof this.stats & { size: number; available: number } {
    return {
      ...this.stats,
      size: this.size,
      available: this.availableCount,
    };
  }

  /**
   * Broadcast a single split transaction that divides one large UTXO
   * owned by `wallet` into `slotCount` equal outputs of `satsPerSlot`
   * each, then populate this pool with the resulting slots.
   *
   * Throws if:
   *   - the wallet has no UTXO large enough to cover
   *     slotCount * satsPerSlot + fee + safety margin
   *   - the split transaction fails to broadcast
   *
   * After a successful prime() the pool has exactly `slotCount`
   * slots, all at chainDepth=0, all ready for allocate().
   */
  async prime(opts: {
    wallet: Wallet;
    slotCount: number;
    satsPerSlot: number;
    /**
     * If set, strongly prefer the UTXO whose tx_hash matches this
     * string. Used to route around chain-deep UTXOs by pointing at
     * a freshly funded output whose ancestry is known-shallow.
     */
    preferTxid?: string;
    /**
     * Optional alternative broadcaster (e.g. ArcBroadcaster) for the
     * split-tx broadcast. When omitted the wallet's own broadcast()
     * method is used, which hits WhatsOnChain. Useful when WoC's
     * mempool view is tangled from prior runs.
     */
    broadcaster?: TxBroadcaster;
  }): Promise<{ splitTxid: string }> {
    const { wallet, slotCount, satsPerSlot, preferTxid, broadcaster } = opts;
    if (slotCount <= 0) throw new Error('slotCount must be > 0');
    if (satsPerSlot <= 0) throw new Error('satsPerSlot must be > 0');

    const needed = slotCount * satsPerSlot + 1_000; // rough fee reserve
    const utxos = await wallet.fetchUtxos();
    if (utxos.length === 0) {
      throw new Error(`Viewer ${wallet.address} has no UTXOs to split`);
    }
    const candidates = utxos.filter((u) => u.satoshis >= needed);
    if (candidates.length === 0) {
      throw new Error(
        `Viewer ${wallet.address} has no UTXO large enough to prime pool. ` +
          `Need ${needed} sats, largest is ${utxos[0]?.satoshis ?? 0}`,
      );
    }
    // Prefer a known-shallow UTXO when the caller supplies preferTxid,
    // otherwise fall back to the first candidate.
    const source =
      (preferTxid && candidates.find((u) => u.txid === preferTxid)) ||
      candidates[0];

    const sourceTx = await wallet.fetchTransaction(source.txid);

    const splitTx = new Transaction();
    splitTx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: source.vout,
      unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKey),
      sequence: 0xffffffff,
    });
    for (let i = 0; i < slotCount; i++) {
      splitTx.addP2PKHOutput(wallet.address, satsPerSlot);
    }
    // Change back to viewer — fee() will balance
    splitTx.addP2PKHOutput(wallet.address);
    await splitTx.fee(NETWORK_FEE_MODEL);
    await splitTx.sign();

    const result = broadcaster
      ? await broadcaster.broadcast(splitTx)
      : await wallet.broadcast(splitTx);
    if (!result.success) {
      throw new Error(`Split broadcast failed: ${result.error}`);
    }

    for (let i = 0; i < slotCount; i++) {
      this.slots.push({
        sourceTx: splitTx,
        vout: i,
        satoshis: satsPerSlot,
        chainDepth: 1, // split tx itself is unconfirmed
        reserved: false,
      });
    }

    return { splitTxid: result.txid };
  }

  /**
   * Return the next allocatable slot (round-robin). Skips slots
   * that are reserved, at max chain depth, or inside their frozen
   * window. The returned slot is marked reserved and will not be
   * handed out again until record() or release() is called on it.
   * Returns null if every slot is currently unusable — caller
   * should back off and retry.
   */
  allocate(): UtxoSlot | null {
    const now = Date.now();
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.cursor + i) % this.slots.length;
      const s = this.slots[idx];
      if (s.reserved) continue;
      if (s.chainDepth >= this.maxChainDepth) continue;
      if (s.frozenUntil && s.frozenUntil > now) continue;
      s.reserved = true;
      this.cursor = (idx + 1) % this.slots.length;
      this.stats.allocations++;
      return s;
    }
    this.stats.starves++;
    return null;
  }

  /**
   * Return a reserved slot to the pool without advancing its chain
   * depth. Used when a broadcast fails and we want to retry the
   * same slot later without burning a depth increment.
   */
  release(slot: UtxoSlot): void {
    slot.reserved = false;
    this.stats.releases++;
  }

  /**
   * After a successful broadcast, update the slot so its new state
   * points at the change output of the transaction that just spent
   * it. If this push takes the slot to maxChainDepth, the slot is
   * frozen for cooldownMs so the ancestor chain can confirm.
   */
  record(
    slot: UtxoSlot,
    newSourceTx: Transaction,
    newVout: number,
    newSatoshis: number,
  ): void {
    slot.sourceTx = newSourceTx;
    slot.vout = newVout;
    slot.satoshis = newSatoshis;
    slot.chainDepth += 1;
    slot.reserved = false;
    this.stats.recordings++;
    if (slot.chainDepth >= this.maxChainDepth) {
      slot.frozenUntil = Date.now() + this.cooldownMs;
      slot.chainDepth = 0; // optimistic reset for post-cooldown reuse
      this.stats.freezes++;
    }
  }

  /**
   * Manually reset all slots' chain depth and clear freezes. Called
   * when the caller has evidence that the ancestor chain has been
   * confirmed (for example, a periodic call to fetchUtxos shows a
   * fresh utxo set).
   */
  reset(): void {
    for (const s of this.slots) {
      s.chainDepth = 0;
      s.frozenUntil = undefined;
    }
  }
}
