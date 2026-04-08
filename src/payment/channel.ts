/**
 * Unidirectional BSV payment channel for per-piece micropayments.
 *
 * Leecher funds a UTXO, then signs incrementally larger payments
 * to the seeder (with creator split) for each torrent piece received.
 * Only 2 on-chain transactions: fund + settle.
 *
 * Each payment update is a valid, broadcastable transaction.
 * The seeder holds the latest one and can broadcast it anytime to collect.
 */

import { Transaction, P2PKH } from '@bsv/sdk';
import type {
  ChannelConfig,
  ChannelState,
  ChannelStateUpdate,
  PaymentChannelRecord,
} from '../types/payment.js';
import { Wallet } from './wallet.js';
import { randomBytes } from 'node:crypto';

export class PaymentChannel {
  readonly channelId: string;
  readonly config: ChannelConfig;

  private _state: ChannelState = 'opening';
  private _sequenceNumber = 0;
  private _totalPaidPieces = 0;
  private _seederAmount = 0;
  private _creatorAmount = 0;
  private _latestTxHex = '';

  /** Set after funding tx is broadcast */
  private _fundingTxid = '';
  private _fundingVout = 0;
  private _fundingTx: Transaction | null = null;

  /** Max pieces this channel can pay for */
  readonly maxPieces: number;

  constructor(config: ChannelConfig, channelId?: string) {
    this.config = config;
    this.channelId = channelId ?? randomBytes(16).toString('hex');

    // Calculate how many pieces we can afford
    // Each piece costs satsPerPiece. Miner fee is ~200 sats.
    const usableFunding = config.fundingAmount - 200;
    this.maxPieces = Math.floor(usableFunding / config.satsPerPiece);

    if (this.maxPieces <= 0) {
      throw new Error(
        `Funding amount ${config.fundingAmount} too low for ${config.satsPerPiece} sats/piece`,
      );
    }
  }

  get state(): ChannelState {
    return this._state;
  }

  get sequenceNumber(): number {
    return this._sequenceNumber;
  }

  get totalPaidPieces(): number {
    return this._totalPaidPieces;
  }

  get seederAmount(): number {
    return this._seederAmount;
  }

  get creatorAmount(): number {
    return this._creatorAmount;
  }

  get remainingPieces(): number {
    return this.maxPieces - this._totalPaidPieces;
  }

  get latestTxHex(): string {
    return this._latestTxHex;
  }

  get fundingTxid(): string {
    return this._fundingTxid;
  }

  /**
   * Set the funding transaction details after it's been broadcast.
   * Call this once the funding tx is confirmed in mempool.
   */
  fund(fundingTxid: string, fundingVout: number, fundingTx: Transaction): void {
    if (this._state !== 'opening') {
      throw new Error(`Cannot fund channel in state: ${this._state}`);
    }
    this._fundingTxid = fundingTxid;
    this._fundingVout = fundingVout;
    this._fundingTx = fundingTx;
    this._state = 'open';
  }

  /**
   * Create the next payment update (called by the leecher).
   *
   * Builds a transaction spending the funding UTXO with:
   * - Output 0: creator's cumulative share
   * - Output 1: seeder's cumulative share
   * - Output 2: leecher's change
   *
   * The transaction is signed and valid for broadcast.
   *
   * @param pieceIndex - The torrent piece this payment is for
   * @param wallet - The leecher's wallet (holds the funding key)
   * @returns The channel state update with signed tx
   */
  async createPayment(pieceIndex: number, wallet: Wallet): Promise<ChannelStateUpdate> {
    if (this._state !== 'open') {
      throw new Error(`Channel not open (state: ${this._state})`);
    }
    if (this._totalPaidPieces >= this.maxPieces) {
      throw new Error('Channel exhausted — no more pieces can be paid for');
    }
    if (!this._fundingTx) {
      throw new Error('Channel not funded');
    }

    this._sequenceNumber++;
    this._totalPaidPieces++;

    // Calculate cumulative amounts
    const totalPiecePayment = this._totalPaidPieces * this.config.satsPerPiece;
    this._creatorAmount = Math.floor(
      (totalPiecePayment * this.config.creatorSplitBps) / 10_000,
    );
    this._seederAmount = totalPiecePayment - this._creatorAmount;

    // Build the payment transaction
    const tx = wallet.buildPaymentTx({
      fundingTxid: this._fundingTxid,
      fundingVout: this._fundingVout,
      fundingAmount: this.config.fundingAmount,
      creatorAddress: this.config.creatorAddress,
      creatorAmount: this._creatorAmount,
      seederAddress: this.config.seederAddress,
      seederAmount: this._seederAmount,
      sequenceNumber: this._sequenceNumber,
      sourceTransaction: this._fundingTx,
    });

    // Sign the transaction
    await tx.sign();

    this._latestTxHex = tx.toHex();

    const minerFee = 200;
    const leecherChange =
      this.config.fundingAmount -
      this._creatorAmount -
      this._seederAmount -
      minerFee;

    return {
      sequenceNumber: this._sequenceNumber,
      pieceIndex,
      seederAmount: this._seederAmount,
      creatorAmount: this._creatorAmount,
      leecherChange: Math.max(0, leecherChange),
      signedTxHex: this._latestTxHex,
    };
  }

  /**
   * Validate an incoming payment update (called by the seeder).
   *
   * Checks:
   * - Sequence number is higher than current
   * - Seeder amount is correct (cumulative)
   * - Creator amount is correct (split)
   * - Transaction is parseable
   *
   * @returns true if valid, throws on invalid
   */
  validatePayment(update: ChannelStateUpdate): boolean {
    if (update.sequenceNumber <= this._sequenceNumber) {
      throw new Error(
        `Stale sequence: got ${update.sequenceNumber}, have ${this._sequenceNumber}`,
      );
    }

    // Verify amounts are cumulative and correct
    const expectedPieces = update.sequenceNumber; // 1:1 mapping for PoC
    const expectedTotal = expectedPieces * this.config.satsPerPiece;
    const expectedCreator = Math.floor(
      (expectedTotal * this.config.creatorSplitBps) / 10_000,
    );
    const expectedSeeder = expectedTotal - expectedCreator;

    if (update.seederAmount !== expectedSeeder) {
      throw new Error(
        `Seeder amount mismatch: got ${update.seederAmount}, expected ${expectedSeeder}`,
      );
    }
    if (update.creatorAmount !== expectedCreator) {
      throw new Error(
        `Creator amount mismatch: got ${update.creatorAmount}, expected ${expectedCreator}`,
      );
    }

    // Parse the transaction to verify it's well-formed
    try {
      Transaction.fromHex(update.signedTxHex);
    } catch (e) {
      throw new Error(`Invalid transaction hex: ${e}`);
    }

    // Accept the update
    this._sequenceNumber = update.sequenceNumber;
    this._totalPaidPieces = expectedPieces;
    this._seederAmount = update.seederAmount;
    this._creatorAmount = update.creatorAmount;
    this._latestTxHex = update.signedTxHex;

    return true;
  }

  /**
   * Get the settlement transaction hex (called by the seeder to close).
   * This is simply the latest payment update — it's already a valid,
   * broadcastable transaction.
   */
  getSettlementTx(): string {
    if (!this._latestTxHex) {
      throw new Error('No payments made — nothing to settle');
    }
    return this._latestTxHex;
  }

  /** Close the channel */
  close(): void {
    this._state = 'closed';
  }

  /** Export channel state as a record */
  toRecord(): PaymentChannelRecord {
    return {
      channelId: this.channelId,
      state: this._state,
      fundingTxid: this._fundingTxid,
      fundingVout: this._fundingVout,
      fundingAmount: this.config.fundingAmount,
      satsPerPiece: this.config.satsPerPiece,
      seederAddress: this.config.seederAddress,
      creatorAddress: this.config.creatorAddress,
      creatorSplitBps: this.config.creatorSplitBps,
      timeoutBlockHeight: this.config.timeoutBlockHeight,
      sequenceNumber: this._sequenceNumber,
      seederAmount: this._seederAmount,
      creatorAmount: this._creatorAmount,
      leecherChange:
        this.config.fundingAmount -
        this._seederAmount -
        this._creatorAmount -
        200,
      latestTxHex: this._latestTxHex,
      maxPieces: this.maxPieces,
      totalPaidPieces: this._totalPaidPieces,
    };
  }
}
