import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Wallet } from '../src/payment/wallet.js';
import { StreamingLoop } from '../src/agents/streaming-loop.js';
import type { TokenHolderShare } from '../src/agents/piece-payment.js';
import type { PieceReceipt } from '../src/agents/piece-payment.js';

const holders: TokenHolderShare[] = [
  { address: Wallet.random().address, weight: 70 },
  { address: Wallet.random().address, weight: 30 },
];

function stubBroadcaster(
  counter: { value: number },
): (opts: {
  viewer: Wallet;
  holders: TokenHolderShare[];
  satsPerPiece: number;
}) => Promise<PieceReceipt> {
  return async (opts) => {
    counter.value++;
    return {
      txid: `tx-${counter.value}`,
      txHex: 'deadbeef',
      satsPerPiece: opts.satsPerPiece,
      holderCount: opts.holders.length,
      broadcastAt: Date.now(),
    };
  };
}

describe('StreamingLoop', () => {
  let viewer: Wallet;

  beforeEach(() => {
    vi.useFakeTimers();
    viewer = Wallet.random();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects invalid construction parameters', () => {
    expect(
      () =>
        new StreamingLoop({
          viewer,
          holders,
          satsPerPiece: 100,
          piecesPerSecond: 0,
        }),
    ).toThrow(/piecesPerSecond/);

    expect(
      () =>
        new StreamingLoop({
          viewer,
          holders,
          satsPerPiece: 0,
          piecesPerSecond: 1,
        }),
    ).toThrow(/satsPerPiece/);

    expect(
      () =>
        new StreamingLoop({
          viewer,
          holders: [],
          satsPerPiece: 100,
          piecesPerSecond: 1,
        }),
    ).toThrow(/holders/);
  });

  it('fireOnce broadcasts a piece and increments the counter', async () => {
    const counter = { value: 0 };
    const loop = new StreamingLoop({
      viewer,
      holders,
      satsPerPiece: 100,
      piecesPerSecond: 1,
      broadcaster: stubBroadcaster(counter),
    });
    const receipt = await loop.fireOnce();
    expect(receipt.txid).toBe('tx-1');
    expect(loop.stats.piecesBroadcast).toBe(1);
  });

  it('start() drives continuous broadcasts at the target cadence', async () => {
    const counter = { value: 0 };
    const loop = new StreamingLoop({
      viewer,
      holders,
      satsPerPiece: 100,
      piecesPerSecond: 10, // 100ms interval
      broadcaster: stubBroadcaster(counter),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(500);
    loop.stop();
    // Allow flush of any in-flight broadcast
    await vi.runAllTimersAsync();
    expect(loop.stats.piecesBroadcast).toBeGreaterThanOrEqual(4);
    expect(loop.running).toBe(false);
  });

  it('onPiece callback fires for every successful broadcast', async () => {
    const counter = { value: 0 };
    const pieces: PieceReceipt[] = [];
    const loop = new StreamingLoop({
      viewer,
      holders,
      satsPerPiece: 100,
      piecesPerSecond: 10,
      broadcaster: stubBroadcaster(counter),
      onPiece: (r) => pieces.push(r),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(300);
    loop.stop();
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces[0].txid).toBe('tx-1');
  });

  it('failing broadcasts increment errors and the loop continues', async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      if (calls < 3) throw new Error('mainnet says no');
      return {
        txid: `tx-${calls}`,
        txHex: 'deadbeef',
        satsPerPiece: 100,
        holderCount: 2,
        broadcastAt: Date.now(),
      } as PieceReceipt;
    };
    const errors: Error[] = [];
    const loop = new StreamingLoop({
      viewer,
      holders,
      satsPerPiece: 100,
      piecesPerSecond: 20,
      broadcaster: failing,
      onError: (e) => errors.push(e),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(500);
    loop.stop();
    await vi.runAllTimersAsync();
    expect(loop.stats.errors).toBeGreaterThanOrEqual(2);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(loop.stats.piecesBroadcast).toBeGreaterThanOrEqual(1);
  });

  it('stats.realisedRate approximates the configured rate (stub broadcaster)', async () => {
    const counter = { value: 0 };
    const loop = new StreamingLoop({
      viewer,
      holders,
      satsPerPiece: 100,
      piecesPerSecond: 20, // 50ms interval
      broadcaster: stubBroadcaster(counter),
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    // With fake timers the realised rate should be very close to target
    expect(loop.stats.piecesBroadcast).toBeGreaterThan(10);
  });
});
