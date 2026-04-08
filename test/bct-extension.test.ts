import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { createBctPayExtension } from '../src/wire/bct-extension.js';
import { Wallet } from '../src/payment/wallet.js';
import { ChannelManager } from '../src/payment/channel-manager.js';
import { BctMessageType, decodeMessage } from '../src/wire/messages.js';
import type { ContentManifest } from '../src/types/torrent.js';

/**
 * Mock wire that captures sent messages and can deliver them to a peer.
 */
function createMockWire() {
  const sent: Array<{ ext: string; buf: Buffer }> = [];
  return {
    sent,
    peerExtendedMapping: { bct_pay: 1 },
    extended(ext: string | number, buf: Buffer | Uint8Array) {
      sent.push({ ext: String(ext), buf: Buffer.from(buf) });
    },
  };
}

/** Deliver the last message from one wire's extension to another */
function deliverMessage(
  fromWire: ReturnType<typeof createMockWire>,
  toExtension: { onMessage: (buf: Buffer) => void },
) {
  const last = fromWire.sent[fromWire.sent.length - 1];
  if (!last) throw new Error('No message to deliver');
  toExtension.onMessage(last.buf);
}

/** Create a mock funding transaction */
function createMockFundingTx(
  key: PrivateKey,
  amount: number,
): Transaction {
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

const TEST_MANIFEST: ContentManifest = {
  version: 1,
  infohash: 'abcdef1234567890abcdef1234567890abcdef12',
  title: 'Test Video',
  contentType: 'video/mp4',
  duration: 120,
  totalPieces: 500,
  totalBytes: 131_072_000,
  pricing: {
    satsPerPiece: 10,
    initPiecesFree: true,
    currency: 'BSV',
  },
  creator: {
    address: '', // filled in beforeAll
    name: 'Test Creator',
    splitBps: 6000,
  },
  codec: {
    mimeCodec: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    initPieceCount: 1,
    fragmentMap: [],
  },
};

describe('BctPay Wire Extension', () => {
  let leecherWallet: Wallet;
  let seederWallet: Wallet;
  let creatorKey: PrivateKey;
  let manifest: ContentManifest;
  let fundingTx: Transaction;

  beforeAll(async () => {
    leecherWallet = Wallet.random();
    seederWallet = Wallet.random();
    creatorKey = PrivateKey.fromRandom();

    manifest = {
      ...TEST_MANIFEST,
      creator: { ...TEST_MANIFEST.creator, address: creatorKey.toAddress() },
    };

    fundingTx = createMockFundingTx(leecherWallet.privateKey, 10_000);
    await fundingTx.fee(new SatoshisPerKilobyte(1));
    await fundingTx.sign();
  });

  it('should set extension name to bct_pay', () => {
    const ExtClass = createBctPayExtension({
      role: 'leecher',
      wallet: leecherWallet,
      manifest,
    });
    expect(ExtClass.prototype.name).toBe('bct_pay');
  });

  it('should complete CHANNEL_OPEN → CHANNEL_ACCEPT handshake', () => {
    const leecherWire = createMockWire();
    const seederWire = createMockWire();

    const LeecherExt = createBctPayExtension({
      role: 'leecher',
      wallet: leecherWallet,
      manifest,
    });
    const SeederExt = createBctPayExtension({
      role: 'seeder',
      wallet: seederWallet,
      manifest,
    });

    const leecher = new LeecherExt(leecherWire as any);
    const seeder = new SeederExt(seederWire as any);

    // Track events
    const leecherEvents: string[] = [];
    const seederEvents: string[] = [];
    leecher.on('channel:open', () => leecherEvents.push('open'));
    seeder.on('channel:open', () => seederEvents.push('open'));

    // Step 1: Leecher sends CHANNEL_OPEN
    leecher.openChannel(10_000);
    expect(leecherWire.sent.length).toBe(1);

    const openMsg = decodeMessage(leecherWire.sent[0].buf);
    expect(openMsg.type).toBe(BctMessageType.CHANNEL_OPEN);

    // Step 2: Deliver to seeder
    deliverMessage(leecherWire, seeder);
    expect(seederEvents).toContain('open');
    expect(seeder.channel).not.toBeNull();

    // Step 3: Seeder should have sent CHANNEL_ACCEPT
    expect(seederWire.sent.length).toBe(1);
    const acceptMsg = decodeMessage(seederWire.sent[0].buf);
    expect(acceptMsg.type).toBe(BctMessageType.CHANNEL_ACCEPT);

    // Step 4: Deliver CHANNEL_ACCEPT to leecher
    deliverMessage(seederWire, leecher);
    expect(leecherEvents).toContain('open');
    expect(leecher.channel).not.toBeNull();
  });

  it('should exchange payment for piece and receive ack', async () => {
    const leecherWire = createMockWire();
    const seederWire = createMockWire();

    const LeecherExt = createBctPayExtension({
      role: 'leecher',
      wallet: leecherWallet,
      manifest,
    });
    const SeederExt = createBctPayExtension({
      role: 'seeder',
      wallet: seederWallet,
      manifest,
    });

    const leecher = new LeecherExt(leecherWire as any);
    const seeder = new SeederExt(seederWire as any);

    // Open channel
    leecher.openChannel(10_000);
    deliverMessage(leecherWire, seeder);
    deliverMessage(seederWire, leecher);

    // Fund the leecher's channel
    const txid = fundingTx.id('hex');
    leecher.channel!.fund(txid, 0, fundingTx);

    // Fund seeder's view too (they need the funding tx for validation)
    seeder.channel!.fund(txid, 0, fundingTx);

    // Track events
    const acks: number[] = [];
    const received: number[] = [];
    leecher.on('payment:ack', (pieceIdx: number) => acks.push(pieceIdx));
    seeder.on('payment:received', (pieceIdx: number) => received.push(pieceIdx));

    // Pay for piece 0
    await leecher.payForPiece(0);
    expect(leecherWire.sent.length).toBe(2); // open + payment

    // Deliver payment to seeder
    deliverMessage(leecherWire, seeder);
    expect(received).toContain(0);
    expect(seeder.paidPieces.has(0)).toBe(true);

    // Seeder should have sent ack
    deliverMessage(seederWire, leecher);
    expect(acks).toContain(0);
    expect(leecher.paidPieces.has(0)).toBe(true);
    expect(leecher.pendingPieces.has(0)).toBe(false);
  });

  it('should handle full 5-piece payment flow', async () => {
    const leecherWire = createMockWire();
    const seederWire = createMockWire();

    const LeecherExt = createBctPayExtension({
      role: 'leecher',
      wallet: leecherWallet,
      manifest,
    });
    const SeederExt = createBctPayExtension({
      role: 'seeder',
      wallet: seederWallet,
      manifest,
    });

    const leecher = new LeecherExt(leecherWire as any);
    const seeder = new SeederExt(seederWire as any);

    // Handshake
    leecher.openChannel(10_000);
    deliverMessage(leecherWire, seeder);
    deliverMessage(seederWire, leecher);

    // Fund
    const txid = fundingTx.id('hex');
    leecher.channel!.fund(txid, 0, fundingTx);
    seeder.channel!.fund(txid, 0, fundingTx);

    // Pay for 5 pieces
    for (let i = 0; i < 5; i++) {
      await leecher.payForPiece(i);
      deliverMessage(leecherWire, seeder); // payment
      deliverMessage(seederWire, leecher); // ack
    }

    expect(leecher.paidPieces.size).toBe(5);
    expect(seeder.paidPieces.size).toBe(5);

    // Verify seeder's channel state
    expect(seeder.channel!.sequenceNumber).toBe(5);
    expect(seeder.channel!.totalPaid).toBe(50); // 5 * 10 = 50 sats, 100% to creator
  });

  it('should handle channel close', async () => {
    const leecherWire = createMockWire();
    const seederWire = createMockWire();

    const LeecherExt = createBctPayExtension({
      role: 'leecher',
      wallet: leecherWallet,
      manifest,
    });
    const SeederExt = createBctPayExtension({
      role: 'seeder',
      wallet: seederWallet,
      manifest,
    });

    const leecher = new LeecherExt(leecherWire as any);
    const seeder = new SeederExt(seederWire as any);

    // Handshake
    leecher.openChannel(10_000);
    deliverMessage(leecherWire, seeder);
    deliverMessage(seederWire, leecher);

    // Fund
    const txid = fundingTx.id('hex');
    leecher.channel!.fund(txid, 0, fundingTx);
    seeder.channel!.fund(txid, 0, fundingTx);

    // Pay for 1 piece
    await leecher.payForPiece(0);
    deliverMessage(leecherWire, seeder);
    deliverMessage(seederWire, leecher);

    // Close
    const closeEvents: string[] = [];
    seeder.on('channel:close', () => closeEvents.push('closed'));

    leecher.closeChannel('complete');
    deliverMessage(leecherWire, seeder);

    expect(closeEvents).toContain('closed');
    expect(seeder.channel!.state).toBe('closed');
    expect(leecher.channel!.state).toBe('closed');

    // Settlement tx should be available
    const settlementHex = seeder.channel!.getSettlementTx();
    expect(settlementHex).toBeTruthy();
    const tx = Transaction.fromHex(settlementHex);
    expect(tx.outputs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ChannelManager', () => {
  let leecherWallet: Wallet;
  let seederKey: PrivateKey;
  let creatorKey: PrivateKey;
  let fundingTx: Transaction;

  beforeAll(async () => {
    leecherWallet = Wallet.random();
    seederKey = PrivateKey.fromRandom();
    creatorKey = PrivateKey.fromRandom();

    fundingTx = createMockFundingTx(leecherWallet.privateKey, 10_000);
    await fundingTx.fee(new SatoshisPerKilobyte(1));
    await fundingTx.sign();
  });

  it('should manage multiple channels', async () => {
    const manager = new ChannelManager();

    const config = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: creatorKey.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };

    // Create channels for 3 peers
    const ch1 = manager.createChannel('peer-1', config);
    const ch2 = manager.createChannel('peer-2', config);
    const ch3 = manager.createChannel('peer-3', config);

    // Fund all
    const txid = fundingTx.id('hex');
    ch1.fund(txid, 0, fundingTx);
    ch2.fund(txid, 0, fundingTx);
    ch3.fund(txid, 0, fundingTx);

    expect(manager.activeCount).toBe(3);

    // Pay on channel 1
    await ch1.createPayment(0, leecherWallet);
    await ch1.createPayment(1, leecherWallet);

    // Pay on channel 2
    await ch2.createPayment(0, leecherWallet);

    expect(manager.totalPiecesServed).toBe(3);
    expect(manager.totalPiecesServed).toBe(3); // verified above

    // Close channel 3
    manager.closeChannel(ch3.channelId);
    expect(manager.activeCount).toBe(2);

    // Peer lookup
    expect(manager.getChannelForPeer('peer-1')?.channelId).toBe(ch1.channelId);
    expect(manager.getChannelForPeer('peer-3')).toBeUndefined();
  });

  it('should collect settlement txs', async () => {
    const manager = new ChannelManager();

    const config = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: creatorKey.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };

    const ch1 = manager.createChannel('peer-a', config);
    const ch2 = manager.createChannel('peer-b', config);
    ch1.fund(fundingTx.id('hex'), 0, fundingTx);
    ch2.fund(fundingTx.id('hex'), 0, fundingTx);

    // Only ch1 has payments
    await ch1.createPayment(0, leecherWallet);

    const settlements = manager.getSettlementTxs();
    expect(settlements.length).toBe(1);
    expect(settlements[0].channelId).toBe(ch1.channelId);
  });

  it('should export all channel records', () => {
    const manager = new ChannelManager();

    const config = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      recipients: [{ address: creatorKey.toAddress(), bps: 10_000 }],
      timeoutBlockHeight: 900_000,
    };

    manager.createChannel('peer-x', config);
    manager.createChannel('peer-y', config);

    const records = manager.toRecords();
    expect(records.length).toBe(2);
    expect(records[0].satsPerPiece).toBe(10);
  });
});
