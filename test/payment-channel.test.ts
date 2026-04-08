import { describe, it, expect, beforeAll } from 'vitest';
import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { PaymentChannel } from '../src/payment/channel.js';
import { Wallet } from '../src/payment/wallet.js';
import type { ChannelConfig, ChannelStateUpdate } from '../src/types/payment.js';

/**
 * Creates a mock funding transaction for testing.
 * In production, this would be an on-chain tx; here we build one locally.
 */
function createMockFundingTx(
  leecherKey: PrivateKey,
  amount: number,
): Transaction {
  // Create a fake "source" transaction that pays to the leecher
  const sourceTx = new Transaction();
  sourceTx.addOutput({
    lockingScript: new P2PKH().lock(leecherKey.toAddress()),
    satoshis: amount + 1000, // extra for fees
  });

  // Now create the funding tx that spends the source
  const fundingTx = new Transaction();
  fundingTx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(leecherKey),
    sequence: 0xffffffff,
  });
  fundingTx.addOutput({
    lockingScript: new P2PKH().lock(leecherKey.toAddress()),
    satoshis: amount,
  });

  return fundingTx;
}

describe('PaymentChannel', () => {
  let leecherWallet: Wallet;
  let seederKey: PrivateKey;
  let creatorKey: PrivateKey;
  let channelConfig: ChannelConfig;
  let fundingTx: Transaction;

  beforeAll(async () => {
    // Generate test keys
    leecherWallet = Wallet.random();
    seederKey = PrivateKey.fromRandom();
    creatorKey = PrivateKey.fromRandom();

    channelConfig = {
      fundingAmount: 10_000, // 10k sats
      satsPerPiece: 10,
      seederAddress: seederKey.toAddress(),
      creatorAddress: creatorKey.toAddress(),
      creatorSplitBps: 6000, // 60% to creator
      timeoutBlockHeight: 900_000,
    };

    // Create mock funding tx
    fundingTx = createMockFundingTx(leecherWallet.privateKey, 10_000);
    await fundingTx.fee(new SatoshisPerKilobyte(1));
    await fundingTx.sign();
  });

  it('should create a channel with correct max pieces', () => {
    const channel = new PaymentChannel(channelConfig);
    // (10000 - 200 fee) / 10 sats per piece = 980
    expect(channel.maxPieces).toBe(980);
    expect(channel.state).toBe('opening');
  });

  it('should reject underfunded channels', () => {
    expect(
      () =>
        new PaymentChannel({
          ...channelConfig,
          fundingAmount: 100,
          satsPerPiece: 200,
        }),
    ).toThrow('too low');
  });

  it('should transition to open state after funding', () => {
    const channel = new PaymentChannel(channelConfig);
    const txid = fundingTx.id('hex');
    channel.fund(txid, 0, fundingTx);
    expect(channel.state).toBe('open');
    expect(channel.fundingTxid).toBe(txid);
  });

  it('should create 10 sequential payment updates', async () => {
    const channel = new PaymentChannel(channelConfig);
    const txid = fundingTx.id('hex');
    channel.fund(txid, 0, fundingTx);

    const updates: ChannelStateUpdate[] = [];

    for (let i = 0; i < 10; i++) {
      const update = await channel.createPayment(i, leecherWallet);
      updates.push(update);

      // Verify sequence numbers are incrementing
      expect(update.sequenceNumber).toBe(i + 1);
      expect(update.pieceIndex).toBe(i);

      // Verify signed tx is parseable
      const tx = Transaction.fromHex(update.signedTxHex);
      expect(tx.inputs.length).toBe(1);
      expect(tx.outputs.length).toBeGreaterThanOrEqual(2);
    }

    // After 10 pieces at 10 sats each = 100 sats total
    // Creator gets 60%: 60 sats
    // Seeder gets 40%: 40 sats
    const last = updates[9];
    expect(last.creatorAmount).toBe(60);
    expect(last.seederAmount).toBe(40);
    expect(last.sequenceNumber).toBe(10);

    // Channel state should reflect 10 paid pieces
    expect(channel.totalPaidPieces).toBe(10);
    expect(channel.remainingPieces).toBe(970); // 980 - 10
  });

  it('should have monotonically increasing amounts', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    let prevSeeder = 0;
    let prevCreator = 0;

    for (let i = 0; i < 5; i++) {
      const update = await channel.createPayment(i, leecherWallet);
      expect(update.seederAmount).toBeGreaterThan(prevSeeder);
      expect(update.creatorAmount).toBeGreaterThan(prevCreator);
      prevSeeder = update.seederAmount;
      prevCreator = update.creatorAmount;
    }
  });

  it('should enforce 60/40 creator/seeder split', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Pay for 100 pieces = 1000 sats
    for (let i = 0; i < 100; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    const record = channel.toRecord();
    const totalPaid = record.creatorAmount + record.seederAmount;
    expect(totalPaid).toBe(1000); // 100 pieces * 10 sats

    // Creator gets 60%
    expect(record.creatorAmount).toBe(600);
    // Seeder gets 40%
    expect(record.seederAmount).toBe(400);
  });

  it('should validate incoming payments (seeder side)', async () => {
    // Leecher creates channel and payments
    const leecherChannel = new PaymentChannel(channelConfig);
    leecherChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Seeder creates their view of the same channel
    const seederChannel = new PaymentChannel(channelConfig, leecherChannel.channelId);
    seederChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 5; i++) {
      const update = await leecherChannel.createPayment(i, leecherWallet);

      // Seeder validates
      expect(seederChannel.validatePayment(update)).toBe(true);
      expect(seederChannel.sequenceNumber).toBe(i + 1);
    }

    expect(seederChannel.seederAmount).toBe(20); // 5 * 10 * 0.4 = 20
    expect(seederChannel.creatorAmount).toBe(30); // 5 * 10 * 0.6 = 30
  });

  it('should reject stale sequence numbers', async () => {
    const leecherChannel = new PaymentChannel(channelConfig);
    leecherChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    const seederChannel = new PaymentChannel(channelConfig, leecherChannel.channelId);
    seederChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Send payment 1
    const update1 = await leecherChannel.createPayment(0, leecherWallet);
    seederChannel.validatePayment(update1);

    // Send payment 2
    const update2 = await leecherChannel.createPayment(1, leecherWallet);
    seederChannel.validatePayment(update2);

    // Try to replay payment 1 — should fail
    expect(() => seederChannel.validatePayment(update1)).toThrow('Stale sequence');
  });

  it('should reject incorrect amounts', async () => {
    const leecherChannel = new PaymentChannel(channelConfig);
    leecherChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    const seederChannel = new PaymentChannel(channelConfig, leecherChannel.channelId);
    seederChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    const update = await leecherChannel.createPayment(0, leecherWallet);

    // Tamper with seeder amount
    const tampered = { ...update, seederAmount: 999 };
    expect(() => seederChannel.validatePayment(tampered)).toThrow('Seeder amount mismatch');
  });

  it('should produce a valid settlement transaction', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Pay for 50 pieces
    for (let i = 0; i < 50; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    const settlementHex = channel.getSettlementTx();
    const settlementTx = Transaction.fromHex(settlementHex);

    // Should have 3 outputs: creator, seeder, leecher change
    expect(settlementTx.outputs.length).toBe(3);

    // Verify output amounts
    // 50 pieces * 10 sats = 500 total
    // Creator: 300 (60%), Seeder: 200 (40%)
    expect(settlementTx.outputs[0].satoshis).toBe(300); // creator
    expect(settlementTx.outputs[1].satoshis).toBe(200); // seeder
    // Change: 10000 - 300 - 200 - 200(fee) = 9300
    expect(settlementTx.outputs[2].satoshis).toBe(9300);
  });

  it('should throw when channel is exhausted', async () => {
    const smallChannel = new PaymentChannel({
      ...channelConfig,
      fundingAmount: 250, // only ~5 pieces (250 - 200 fee) / 10 = 5
    });
    smallChannel.fund(fundingTx.id('hex'), 0, fundingTx);

    expect(smallChannel.maxPieces).toBe(5);

    // Pay for all 5 pieces
    for (let i = 0; i < 5; i++) {
      await smallChannel.createPayment(i, leecherWallet);
    }

    // 6th should fail
    await expect(
      smallChannel.createPayment(5, leecherWallet),
    ).rejects.toThrow('exhausted');
  });

  it('should close the channel', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);
    await channel.createPayment(0, leecherWallet);

    channel.close();
    expect(channel.state).toBe('closed');

    // Can't create payments after close
    await expect(
      channel.createPayment(1, leecherWallet),
    ).rejects.toThrow('not open');
  });

  it('should export a complete channel record', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);
    await channel.createPayment(0, leecherWallet);

    const record = channel.toRecord();
    expect(record.channelId).toBeTruthy();
    expect(record.state).toBe('open');
    expect(record.fundingAmount).toBe(10_000);
    expect(record.satsPerPiece).toBe(10);
    expect(record.seederAddress).toBe(seederKey.toAddress());
    expect(record.creatorAddress).toBe(creatorKey.toAddress());
    expect(record.sequenceNumber).toBe(1);
    expect(record.totalPaidPieces).toBe(1);
    expect(record.latestTxHex).toBeTruthy();
  });
});

describe('Wire Messages', () => {
  it('should encode and decode messages', async () => {
    const { encodeMessage, decodeMessage, BctMessageType } = await import(
      '../src/wire/messages.js'
    );

    const msg = {
      type: BctMessageType.PIECE_PAYMENT,
      channelId: 'abc123',
      pieceIndex: 42,
      sequenceNumber: 5,
      seederAmount: 20,
      creatorAmount: 30,
      signedTxHex: 'deadbeef',
    } as const;

    const buf = encodeMessage(msg);
    const decoded = decodeMessage(buf);

    expect(decoded.type).toBe(BctMessageType.PIECE_PAYMENT);
    expect((decoded as typeof msg).pieceIndex).toBe(42);
    expect((decoded as typeof msg).seederAmount).toBe(20);
  });
});
