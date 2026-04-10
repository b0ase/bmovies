import { describe, it, expect } from 'vitest';
import { Transaction, P2PKH } from '@bsv/sdk';
import { Wallet } from '../src/payment/wallet.js';
import {
  splitFanOut,
  buildPiecePaymentTx,
  type TokenHolderShare,
} from '../src/agents/piece-payment.js';

async function fundedSource(wallet: Wallet, amount: number): Promise<Transaction> {
  const upstream = new Transaction();
  upstream.addOutput({
    lockingScript: new P2PKH().lock(wallet.address),
    satoshis: amount + 1000,
  });
  const funding = new Transaction();
  funding.addInput({
    sourceTransaction: upstream,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKey),
    sequence: 0xffffffff,
  });
  funding.addOutput({
    lockingScript: new P2PKH().lock(wallet.address),
    satoshis: amount,
  });
  await funding.sign();
  return funding;
}

describe('splitFanOut', () => {
  it('allocates proportionally to weights and sums exactly to satsPerPiece', () => {
    const holders: TokenHolderShare[] = [
      { address: 'a', weight: 40 },
      { address: 'b', weight: 30 },
      { address: 'c', weight: 30 },
    ];
    const out = splitFanOut(holders, 100);
    const total = out.reduce((s, o) => s + o.amount, 0);
    expect(total).toBe(100);
    expect(out.find((o) => o.address === 'a')?.amount).toBe(40);
  });

  it('pushes rounding remainder to the first positive-weight holder', () => {
    const holders: TokenHolderShare[] = [
      { address: 'a', weight: 1 },
      { address: 'b', weight: 1 },
      { address: 'c', weight: 1 },
    ];
    const out = splitFanOut(holders, 10);
    const total = out.reduce((s, o) => s + o.amount, 0);
    expect(total).toBe(10);
  });

  it('gives dust holders at least 1 sat when the budget allows', () => {
    const holders: TokenHolderShare[] = [
      { address: 'whale', weight: 1_000_000 },
      { address: 'ant', weight: 1 },
    ];
    const out = splitFanOut(holders, 100);
    expect(out.find((o) => o.address === 'ant')?.amount).toBe(1);
    const total = out.reduce((s, o) => s + o.amount, 0);
    expect(total).toBe(100);
  });

  it('returns an empty array when all weights are zero or negative', () => {
    const holders: TokenHolderShare[] = [
      { address: 'a', weight: 0 },
      { address: 'b', weight: -1 },
    ];
    expect(splitFanOut(holders, 100)).toEqual([]);
  });

  it('returns an empty array when holders is empty', () => {
    expect(splitFanOut([], 100)).toEqual([]);
  });
});

describe('buildPiecePaymentTx', () => {
  it('produces one output per holder (positive allocations only) plus a change output', async () => {
    const viewer = Wallet.random();
    const holders: TokenHolderShare[] = [
      { address: Wallet.random().address, weight: 40 },
      { address: Wallet.random().address, weight: 30 },
      { address: Wallet.random().address, weight: 30 },
    ];
    const sourceTx = await fundedSource(viewer, 20_000);
    const tx = await buildPiecePaymentTx({
      viewer,
      holders,
      satsPerPiece: 1_000,
      sourceTx,
      sourceVout: 0,
    });
    // 3 holder outputs + 1 change output = 4
    expect(tx.outputs.length).toBe(4);
    // Sum of the first three outputs must equal satsPerPiece
    const fanoutTotal =
      (tx.outputs[0].satoshis ?? 0) +
      (tx.outputs[1].satoshis ?? 0) +
      (tx.outputs[2].satoshis ?? 0);
    expect(fanoutTotal).toBe(1_000);
  });

  it('rejects zero or negative satsPerPiece', async () => {
    const viewer = Wallet.random();
    const holders: TokenHolderShare[] = [
      { address: Wallet.random().address, weight: 1 },
    ];
    const sourceTx = await fundedSource(viewer, 20_000);
    await expect(
      buildPiecePaymentTx({
        viewer,
        holders,
        satsPerPiece: 0,
        sourceTx,
        sourceVout: 0,
      }),
    ).rejects.toThrow(/satsPerPiece/);
  });

  it('rejects an empty holders list', async () => {
    const viewer = Wallet.random();
    const sourceTx = await fundedSource(viewer, 20_000);
    await expect(
      buildPiecePaymentTx({
        viewer,
        holders: [],
        satsPerPiece: 100,
        sourceTx,
        sourceVout: 0,
      }),
    ).rejects.toThrow(/holders/);
  });

  it('signs the viewer input so the transaction can serialise', async () => {
    const viewer = Wallet.random();
    const holders: TokenHolderShare[] = [
      { address: Wallet.random().address, weight: 1 },
    ];
    const sourceTx = await fundedSource(viewer, 20_000);
    const tx = await buildPiecePaymentTx({
      viewer,
      holders,
      satsPerPiece: 500,
      sourceTx,
      sourceVout: 0,
    });
    expect(tx.inputs[0].unlockingScript).toBeDefined();
    expect(tx.inputs[0].unlockingScript!.toBinary().length).toBeGreaterThan(0);
    // toHex should not throw (would throw if unsigned)
    expect(tx.toHex().length).toBeGreaterThan(0);
  });
});
