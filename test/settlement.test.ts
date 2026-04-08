import { describe, it, expect, beforeAll } from 'vitest';
import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { PaymentChannel } from '../src/payment/channel.js';
import { Wallet } from '../src/payment/wallet.js';
import { validateSettlementTx } from '../src/payment/settlement.js';
import {
  createServeProof,
  verifyServeProof,
  hashContent,
  ProofStore,
} from '../src/seeder/proof-of-serve.js';
import type { ChannelConfig } from '../src/types/payment.js';

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

describe('Settlement TX Validation', () => {
  let leecherWallet: Wallet;
  let seederKey: PrivateKey;
  let creatorKey: PrivateKey;
  let channelConfig: ChannelConfig;
  let fundingTx: Transaction;

  beforeAll(async () => {
    leecherWallet = Wallet.random();
    seederKey = PrivateKey.fromRandom();
    creatorKey = PrivateKey.fromRandom();

    channelConfig = {
      fundingAmount: 10_000,
      satsPerPiece: 10,
      seederAddress: seederKey.toAddress(),
      creatorAddress: creatorKey.toAddress(),
      creatorSplitBps: 6000,
      timeoutBlockHeight: 900_000,
    };

    fundingTx = createMockFundingTx(leecherWallet.privateKey, 10_000);
    await fundingTx.fee(new SatoshisPerKilobyte(1));
    await fundingTx.sign();
  });

  it('should validate a correct settlement tx', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Pay for 50 pieces = 500 sats
    for (let i = 0; i < 50; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    const settlementHex = channel.getSettlementTx();
    const result = validateSettlementTx(
      settlementHex,
      300,  // creator: 500 * 0.6
      200,  // seeder: 500 * 0.4
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsedTx).not.toBeNull();
    expect(result.parsedTx!.outputs.length).toBe(3);
  });

  it('should detect wrong creator amount', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 50; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    const result = validateSettlementTx(
      channel.getSettlementTx(),
      999,  // wrong
      200,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Creator output'))).toBe(true);
  });

  it('should detect wrong seeder amount', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    for (let i = 0; i < 50; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    const result = validateSettlementTx(
      channel.getSettlementTx(),
      300,
      999,  // wrong
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Seeder output'))).toBe(true);
  });

  it('should reject invalid tx hex', () => {
    const result = validateSettlementTx('not-a-real-tx', 100, 100);
    expect(result.valid).toBe(false);
    expect(result.parsedTx).toBeNull();
  });

  it('should verify sequence number is not final', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    await channel.createPayment(0, leecherWallet);

    const result = validateSettlementTx(channel.getSettlementTx(), 6, 4);
    expect(result.valid).toBe(true);

    // Check that the input sequence is 1 (not 0xFFFFFFFF)
    expect(result.parsedTx!.inputs[0].sequence).toBe(1);
  });

  it('should validate a full channel lifecycle settlement', async () => {
    const channel = new PaymentChannel(channelConfig);
    channel.fund(fundingTx.id('hex'), 0, fundingTx);

    // Pay for 100 pieces = 1000 sats total
    for (let i = 0; i < 100; i++) {
      await channel.createPayment(i, leecherWallet);
    }

    // Validate before settlement
    const record = channel.toRecord();
    expect(record.creatorAmount).toBe(600);
    expect(record.seederAmount).toBe(400);

    const result = validateSettlementTx(
      channel.getSettlementTx(),
      600,
      400,
      fundingTx.id('hex'),
    );

    expect(result.valid).toBe(true);

    // Verify all 3 outputs
    const tx = result.parsedTx!;
    expect(tx.outputs[0].satoshis).toBe(600);  // creator
    expect(tx.outputs[1].satoshis).toBe(400);  // seeder
    expect(tx.outputs[2].satoshis).toBe(8800); // change: 10000 - 600 - 400 - 200
  });
});

describe('Proof of Serve', () => {
  let seederKey: PrivateKey;

  beforeAll(() => {
    seederKey = PrivateKey.fromRandom();
  });

  it('should create and verify a serve proof', () => {
    const proof = createServeProof(seederKey, {
      contentHash: 'abc123',
      infohash: 'def456',
      pieceIndex: 42,
      leecherPubkey: 'deadbeef',
      sequenceNumber: 5,
      satsPaid: 50,
    });

    expect(proof.version).toBe(1);
    expect(proof.pieceIndex).toBe(42);
    expect(proof.seederAddress).toBe(seederKey.toAddress());
    expect(proof.seederPubkey).toBe(seederKey.toPublicKey().toString());
    expect(proof.signature).toBeTruthy();
    expect(typeof proof.signature).toBe('string');
    expect(proof.timestamp).toBeGreaterThan(0);

    // Verify
    const valid = verifyServeProof(proof);
    expect(valid).toBe(true);
  });

  it('should reject tampered proofs', () => {
    const proof = createServeProof(seederKey, {
      contentHash: 'abc123',
      infohash: 'def456',
      pieceIndex: 42,
      leecherPubkey: 'deadbeef',
      sequenceNumber: 5,
      satsPaid: 50,
    });

    // Tamper with the piece index
    const tampered = { ...proof, pieceIndex: 99 };
    expect(verifyServeProof(tampered)).toBe(false);
  });

  it('should reject proofs with wrong claimed key', () => {
    const otherKey = PrivateKey.fromRandom();

    const proof = createServeProof(seederKey, {
      contentHash: 'abc123',
      infohash: 'def456',
      pieceIndex: 42,
      leecherPubkey: 'deadbeef',
      sequenceNumber: 5,
      satsPaid: 50,
    });

    // Swap in a different public key — address won't match signature
    const fake = {
      ...proof,
      seederAddress: otherKey.toAddress(),
      seederPubkey: otherKey.toPublicKey().toString(),
    };
    expect(verifyServeProof(fake)).toBe(false);
  });

  it('should hash content consistently', () => {
    const data = Buffer.from('hello world');
    const hash1 = hashContent(data);
    const hash2 = hashContent(data);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });
});

describe('ProofStore', () => {
  it('should store and query proofs', () => {
    const seederKey = PrivateKey.fromRandom();
    const store = new ProofStore();

    // Add proofs for different content
    for (let i = 0; i < 5; i++) {
      store.add(
        createServeProof(seederKey, {
          contentHash: 'hash-a',
          infohash: 'info-a',
          pieceIndex: i,
          leecherPubkey: 'peer-1',
          sequenceNumber: i + 1,
          satsPaid: (i + 1) * 10,
        }),
      );
    }

    for (let i = 0; i < 3; i++) {
      store.add(
        createServeProof(seederKey, {
          contentHash: 'hash-b',
          infohash: 'info-b',
          pieceIndex: i,
          leecherPubkey: 'peer-2',
          sequenceNumber: i + 1,
          satsPaid: (i + 1) * 10,
        }),
      );
    }

    expect(store.count).toBe(8);
    expect(store.getByContent('info-a')).toHaveLength(5);
    expect(store.getByContent('info-b')).toHaveLength(3);
    expect(store.getByPeer('peer-1')).toHaveLength(5);
    expect(store.getByPeer('peer-2')).toHaveLength(3);
  });

  it('should export and import proofs', () => {
    const seederKey = PrivateKey.fromRandom();
    const store = new ProofStore();

    store.add(
      createServeProof(seederKey, {
        contentHash: 'hash-x',
        infohash: 'info-x',
        pieceIndex: 0,
        leecherPubkey: 'peer-x',
        sequenceNumber: 1,
        satsPaid: 10,
      }),
    );

    const json = store.export();
    expect(json).toContain('info-x');

    const store2 = new ProofStore();
    store2.import(json);
    expect(store2.count).toBe(1);
    expect(store2.getByContent('info-x')).toHaveLength(1);
  });
});
