import { describe, it, expect, beforeAll } from 'vitest';
import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { PaymentChannel } from '../src/payment/channel.js';
import { Wallet } from '../src/payment/wallet.js';
import type { ChannelConfig, ChannelStateUpdate } from '../src/types/payment.js';

function createMockFundingTx(key: PrivateKey, amount: number): Transaction {
  const sourceTx = new Transaction();
  sourceTx.addOutput({
    lockingScript: new P2PKH().lock(key.toAddress()),
    satoshis: amount + 1000,
  });
  const fundingTx = new Transaction();
  fundingTx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key),
    sequence: 0xffffffff,
  });
  fundingTx.addOutput({
    lockingScript: new P2PKH().lock(key.toAddress()),
    satoshis: amount,
  });
  return fundingTx;
}

describe('PaymentChannel (fan-out to token holders)', () => {
  let leecherWallet: Wallet;
  let holder1Key: PrivateKey;
  let holder2Key: PrivateKey;
  let holder3Key: PrivateKey;
  let fundingTx: Transaction;

  beforeAll(async () => {
    leecherWallet = Wallet.random();
    holder1Key = PrivateKey.fromRandom();
    holder2Key = PrivateKey.fromRandom();
    holder3Key = PrivateKey.fromRandom();
    fundingTx = createMockFundingTx(leecherWallet.privateKey, 10_000);
    await fundingTx.fee(new SatoshisPerKilobyte(1));
    await fundingTx.sign();
  });

  it('should create a channel with single recipient (100%)', () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: holder1Key.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    expect(channel.maxPieces).toBeGreaterThan(0);
    expect(channel.state).toBe('opening');
  });

  it('should reject recipients that dont sum to 10000 bps', () => {
    expect(() => new PaymentChannel({
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [
        { address: holder1Key.toAddress(), bps: 5000 },
        { address: holder2Key.toAddress(), bps: 3000 },
      ],
      timeoutBlockHeight: 900_000,
    })).toThrow('must sum to 10000');
  });

  it('should pay single holder 100% of revenue', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: holder1Key.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 10; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    // 10 pieces * 10 sats = 100 sats, all to holder1
    expect(channel.totalPaid).toBe(100);
    expect(channel.recipientAmounts[0].amount).toBe(100);
  });

  it('should fan out to multiple holders proportionally', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [
        { address: holder1Key.toAddress(), bps: 6000 },  // 60%
        { address: holder2Key.toAddress(), bps: 3000 },  // 30%
        { address: holder3Key.toAddress(), bps: 1000 },  // 10%
      ],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 100; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    // 100 pieces * 10 sats = 1000 sats total
    expect(channel.totalPaid).toBe(1000);
    expect(channel.recipientAmounts[0].amount).toBe(600); // 60%
    expect(channel.recipientAmounts[1].amount).toBe(300); // 30%
    expect(channel.recipientAmounts[2].amount).toBe(100); // 10%
  });

  it('should produce valid settlement TX with N outputs', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [
        { address: holder1Key.toAddress(), bps: 5000 },
        { address: holder2Key.toAddress(), bps: 5000 },
      ],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 50; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    const settlementHex = channel.getSettlementTx();
    const tx = Transaction.fromHex(settlementHex);

    // 50 pieces * 10 sats = 500 total, 250 each
    // Outputs: holder1(250) + holder2(250) + change
    expect(tx.outputs.length).toBe(3);
    expect(tx.outputs[0].satoshis).toBe(250);
    expect(tx.outputs[1].satoshis).toBe(250);
  });

  it('should validate payments between leecher and seeder sides', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [
        { address: holder1Key.toAddress(), bps: 7000 },
        { address: holder2Key.toAddress(), bps: 3000 },
      ],
      timeoutBlockHeight: 900_000,
    };

    const leecherChan = new PaymentChannel(config);
    leecherChan.fund(fundingTx.id('hex'), 0, fundingTx);

    const seederChan = new PaymentChannel(config, leecherChan.channelId);
    seederChan.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 5; i++) {
      const update = await leecherChan.createPayment(i, leecherWallet);
      expect(seederChan.validatePayment(update)).toBe(true);
    }

    expect(seederChan.totalPaid).toBe(50);
  });

  it('should reject stale sequence numbers', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: holder1Key.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };

    const leecherChan = new PaymentChannel(config);
    leecherChan.fund(fundingTx.id('hex'), 0, fundingTx);
    const seederChan = new PaymentChannel(config, leecherChan.channelId);
    seederChan.fund(fundingTx.id('hex'), 0, fundingTx);

    const u1 = await leecherChan.createPayment(0, leecherWallet);
    seederChan.validatePayment(u1);
    const u2 = await leecherChan.createPayment(1, leecherWallet);
    seederChan.validatePayment(u2);

    expect(() => seederChan.validatePayment(u1)).toThrow('Stale');
  });

  it('should handle channel exhaustion', async () => {
    const config: ChannelConfig = {
      fundingAmount: 300,
      satsPerPiece: 10,
      recipients: [{ address: holder1Key.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Use all available pieces
    for (let i = 0; i < channel.maxPieces; i++) {
      await channel.createPayment(i, leecherWallet);
    }
    await expect(channel.createPayment(999, leecherWallet)).rejects.toThrow('exhausted');
  });

  it('should close the channel', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: holder1Key.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);
    await channel.createPayment(0, leecherWallet);
    channel.close();
    expect(channel.state).toBe('closed');
    await expect(channel.createPayment(1, leecherWallet)).rejects.toThrow('not open');
  });

  it('should export a complete channel record', async () => {
    const config: ChannelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [
        { address: holder1Key.toAddress(), bps: 6000 },
        { address: holder2Key.toAddress(), bps: 4000 },
      ],
      timeoutBlockHeight: 900_000,
    };
    const channel = new PaymentChannel(config);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);
    await channel.createPayment(0, leecherWallet);

    const record = channel.toRecord();
    expect(record.channelId).toBeTruthy();
    expect(record.state).toBe('open');
    expect(record.recipients).toHaveLength(2);
    expect(record.recipientAmounts).toHaveLength(2);
    expect(record.totalPaidPieces).toBe(1);
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
  });
});
