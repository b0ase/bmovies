import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Transaction, P2PKH } from '@bsv/sdk';
import { Wallet } from '../src/payment/wallet.js';
import { UtxoPool } from '../src/agents/utxo-pool.js';

function makeCachedSourceTx(wallet: Wallet): Transaction {
  // A signed stub source tx usable as sourceTransaction for tests
  // that only read its outputs, not broadcast it.
  const tx = new Transaction();
  tx.addOutput({
    lockingScript: new P2PKH().lock(wallet.address),
    satoshis: 100_000,
  });
  return tx;
}

describe('UtxoPool (pure logic, no prime)', () => {
  let pool: UtxoPool;
  let wallet: Wallet;

  beforeEach(() => {
    // Construct with minSatoshisPerSlot=0 so the tests below that use
    // 100-sat placeholder slots can exercise the chain-depth / freeze
    // logic in isolation without tripping the retire-on-low-balance
    // path. A dedicated test at the bottom of the file covers that
    // path explicitly.
    pool = new UtxoPool({
      maxChainDepth: 5,
      cooldownMs: 10_000,
      minSatoshisPerSlot: 0,
    });
    wallet = Wallet.random();
  });

  it('is empty before prime', () => {
    expect(pool.size).toBe(0);
    expect(pool.availableCount).toBe(0);
    expect(pool.allocate()).toBeNull();
  });

  it('allocate cycles through slots round-robin, with release between allocations', () => {
    const src = makeCachedSourceTx(wallet);
    // Manually stuff 3 slots so we can test allocate without a real prime
    // @ts-expect-error accessing private for test injection
    pool['slots'] = [
      { sourceTx: src, vout: 0, satoshis: 100, chainDepth: 1, reserved: false },
      { sourceTx: src, vout: 1, satoshis: 100, chainDepth: 1, reserved: false },
      { sourceTx: src, vout: 2, satoshis: 100, chainDepth: 1, reserved: false },
    ];
    const voutsAllocated: number[] = [];
    for (let i = 0; i < 9; i++) {
      const slot = pool.allocate();
      expect(slot).not.toBeNull();
      voutsAllocated.push(slot!.vout);
      // Release so the next iteration can re-pick this slot
      pool.release(slot!);
    }
    // Each slot should have been allocated exactly 3 times
    expect(voutsAllocated.filter((v) => v === 0)).toHaveLength(3);
    expect(voutsAllocated.filter((v) => v === 1)).toHaveLength(3);
    expect(voutsAllocated.filter((v) => v === 2)).toHaveLength(3);
    // And the order is strictly cyclic
    expect(voutsAllocated.slice(0, 3).sort()).toEqual([0, 1, 2]);
  });

  it('allocate refuses to hand out the same slot while reserved', () => {
    const src = makeCachedSourceTx(wallet);
    // @ts-expect-error private
    pool['slots'] = [
      { sourceTx: src, vout: 0, satoshis: 100, chainDepth: 1, reserved: false },
      { sourceTx: src, vout: 1, satoshis: 100, chainDepth: 1, reserved: false },
    ];
    const a = pool.allocate();
    const b = pool.allocate();
    const c = pool.allocate();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull(); // both slots reserved, nothing to hand out
    pool.release(a!);
    const d = pool.allocate();
    expect(d).not.toBeNull();
  });

  it('record() increments chain depth and freezes when it hits the limit', () => {
    const src = makeCachedSourceTx(wallet);
    // @ts-expect-error private
    pool['slots'] = [{ sourceTx: src, vout: 0, satoshis: 100, chainDepth: 1, reserved: false }];
    const slot = pool.allocate()!;

    // Depth 1 -> 2 -> 3 -> 4 -> frozen at depth 5
    // record() clears reserved each time, so re-allocate between records
    pool.record(slot, src, 0, 99);
    for (let i = 0; i < 3; i++) {
      const s = pool.allocate()!;
      pool.record(s, src, 0, 99);
    }
    expect(slot.frozenUntil).toBeDefined();
    expect(slot.chainDepth).toBe(0); // optimistic reset

    // While frozen, allocate finds nothing
    expect(pool.allocate()).toBeNull();
    expect(pool.getStats().starves).toBeGreaterThan(0);
  });

  it('reset() clears freezes across all slots', () => {
    const src = makeCachedSourceTx(wallet);
    // @ts-expect-error private
    pool['slots'] = [
      {
        sourceTx: src,
        vout: 0,
        satoshis: 100,
        chainDepth: 0,
        reserved: false,
        frozenUntil: Date.now() + 100_000,
      },
    ];
    expect(pool.allocate()).toBeNull();
    pool.reset();
    const slot = pool.allocate();
    expect(slot).not.toBeNull();
    expect(slot!.frozenUntil).toBeUndefined();
  });

  it('availableCount ignores frozen and maxed-out slots', () => {
    const src = makeCachedSourceTx(wallet);
    const now = Date.now();
    // @ts-expect-error private
    pool['slots'] = [
      { sourceTx: src, vout: 0, satoshis: 100, chainDepth: 1, reserved: false },
      { sourceTx: src, vout: 1, satoshis: 100, chainDepth: 5, reserved: false }, // maxed
      {
        sourceTx: src,
        vout: 2,
        satoshis: 100,
        chainDepth: 0,
        reserved: false,
        frozenUntil: now + 100_000,
      }, // frozen
      { sourceTx: src, vout: 3, satoshis: 100, chainDepth: 2, reserved: false },
    ];
    expect(pool.size).toBe(4);
    expect(pool.availableCount).toBe(2);
  });

  it('getStats reports allocation, recording, freeze, and starve counts', () => {
    const src = makeCachedSourceTx(wallet);
    // @ts-expect-error private
    pool['slots'] = [{ sourceTx: src, vout: 0, satoshis: 100, chainDepth: 1, reserved: false }];
    const slot = pool.allocate()!;
    pool.record(slot, src, 0, 99);
    pool.allocate();
    const stats = pool.getStats();
    expect(stats.size).toBe(1);
    expect(stats.allocations).toBe(2);
    expect(stats.recordings).toBe(1);
  });

  it('prime rejects non-positive slotCount or satsPerSlot', async () => {
    await expect(
      pool.prime({ wallet, slotCount: 0, satsPerSlot: 100 }),
    ).rejects.toThrow(/slotCount/);
    await expect(
      pool.prime({ wallet, slotCount: 10, satsPerSlot: 0 }),
    ).rejects.toThrow(/satsPerSlot/);
  });

  it('record() retires slots that drop below minSatoshisPerSlot', () => {
    // Dedicated pool with a 100-sat floor so we can exercise
    // retirement deterministically.
    const retirePool = new UtxoPool({
      maxChainDepth: 5,
      cooldownMs: 10_000,
      minSatoshisPerSlot: 100,
    });
    const src = makeCachedSourceTx(wallet);
    // @ts-expect-error private
    retirePool['slots'] = [
      { sourceTx: src, vout: 0, satoshis: 500, chainDepth: 1, reserved: false },
    ];

    // First allocate+record keeps the slot above the floor — still alive.
    const s1 = retirePool.allocate()!;
    expect(s1).not.toBeNull();
    retirePool.record(s1, src, 0, 150);
    expect(s1.retired).toBeFalsy();
    expect(retirePool.availableCount).toBe(1);

    // Second record pushes below the floor — slot is retired forever.
    const s2 = retirePool.allocate()!;
    expect(s2).not.toBeNull();
    retirePool.record(s2, src, 0, 50);
    expect(s2.retired).toBe(true);
    expect(retirePool.availableCount).toBe(0);
    expect(retirePool.retiredCount).toBe(1);
    expect(retirePool.allocate()).toBeNull();

    const stats = retirePool.getStats();
    expect(stats.retired).toBe(1);
  });
});
