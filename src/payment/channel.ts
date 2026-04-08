/**
 * Payment channel with fan-out to N token holders.
 *
 * 100% of streaming revenue goes to token holders proportionally.
 * No 60/40 split. The settlement TX fans out directly to holders.
 * Token = licence = revenue right.
 */

import { Transaction } from '@bsv/sdk';
import type {
  ChannelConfig,
  ChannelState,
  ChannelStateUpdate,
  PaymentChannelRecord,
  RecipientPayment,
} from '../types/payment.js';
import { Wallet } from './wallet.js';
import { randomBytes } from 'node:crypto';

export class PaymentChannel {
  readonly channelId: string;
  readonly config: ChannelConfig;

  private _state: ChannelState = 'opening';
  private _sequenceNumber = 0;
  private _totalPaidPieces = 0;
  private _totalPaid = 0;
  private _recipientAmounts: RecipientPayment[] = [];
  private _latestTxHex = '';

  private _fundingTxid = '';
  private _fundingVout = 0;
  private _fundingTx: Transaction | null = null;

  readonly maxPieces: number;

  constructor(config: ChannelConfig, channelId?: string) {
    this.config = config;
    this.channelId = channelId ?? randomBytes(16).toString('hex');

    // Validate recipients sum to 10000 bps
    const totalBps = config.recipients.reduce((s, r) => s + r.bps, 0);
    if (totalBps !== 10_000) {
      throw new Error(`Recipients must sum to 10000 bps, got ${totalBps}`);
    }

    // Calculate fee based on number of recipients
    const minerFee = 150 + config.recipients.length * 34;
    const usableFunding = config.fundingAmount - minerFee;
    this.maxPieces = Math.floor(usableFunding / config.satsPerPiece);

    if (this.maxPieces <= 0) {
      throw new Error(
        `Funding amount ${config.fundingAmount} too low for ${config.satsPerPiece} sats/piece with ${config.recipients.length} recipients`,
      );
    }

    // Initialize recipient amounts
    this._recipientAmounts = config.recipients.map((r) => ({
      address: r.address,
      amount: 0,
    }));
  }

  get state(): ChannelState { return this._state; }
  get sequenceNumber(): number { return this._sequenceNumber; }
  get totalPaidPieces(): number { return this._totalPaidPieces; }
  get totalPaid(): number { return this._totalPaid; }
  get recipientAmounts(): RecipientPayment[] { return [...this._recipientAmounts]; }
  get remainingPieces(): number { return this.maxPieces - this._totalPaidPieces; }
  get latestTxHex(): string { return this._latestTxHex; }
  get fundingTxid(): string { return this._fundingTxid; }

  // Legacy accessors for backward compatibility
  get seederAmount(): number {
    // Sum of all non-first recipients (or 0 if single recipient)
    return this._recipientAmounts.slice(1).reduce((s, r) => s + r.amount, 0);
  }
  get creatorAmount(): number {
    return this._recipientAmounts[0]?.amount ?? 0;
  }

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
   * Create the next payment update.
   *
   * Fans out cumulative amounts to all recipients proportionally.
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

    // Calculate cumulative total
    this._totalPaid = this._totalPaidPieces * this.config.satsPerPiece;

    // Distribute proportionally to recipients
    let distributed = 0;
    for (let i = 0; i < this.config.recipients.length; i++) {
      const r = this.config.recipients[i];
      const amount = Math.floor((this._totalPaid * r.bps) / 10_000);
      this._recipientAmounts[i] = { address: r.address, amount };
      distributed += amount;
    }

    // Give rounding remainder to first recipient
    const remainder = this._totalPaid - distributed;
    if (remainder > 0 && this._recipientAmounts.length > 0) {
      this._recipientAmounts[0].amount += remainder;
    }

    // Build the fan-out payment transaction
    const tx = wallet.buildPaymentTx({
      fundingVout: this._fundingVout,
      fundingAmount: this.config.fundingAmount,
      recipients: this._recipientAmounts,
      sequenceNumber: this._sequenceNumber,
      sourceTransaction: this._fundingTx,
    });

    await tx.sign();
    this._latestTxHex = tx.toHex();

    const minerFee = 150 + this.config.recipients.length * 34;
    const leecherChange = this.config.fundingAmount - this._totalPaid - minerFee;

    return {
      sequenceNumber: this._sequenceNumber,
      pieceIndex,
      recipientAmounts: [...this._recipientAmounts],
      totalPaid: this._totalPaid,
      leecherChange: Math.max(0, leecherChange),
      signedTxHex: this._latestTxHex,
    };
  }

  /**
   * Validate an incoming payment update.
   */
  validatePayment(update: ChannelStateUpdate): boolean {
    if (update.sequenceNumber <= this._sequenceNumber) {
      throw new Error(
        `Stale sequence: got ${update.sequenceNumber}, have ${this._sequenceNumber}`,
      );
    }

    const expectedPieces = update.sequenceNumber;
    const expectedTotal = expectedPieces * this.config.satsPerPiece;

    if (update.totalPaid !== expectedTotal) {
      throw new Error(
        `Total paid mismatch: got ${update.totalPaid}, expected ${expectedTotal}`,
      );
    }

    // Verify proportional distribution
    for (let i = 0; i < this.config.recipients.length; i++) {
      const expected = Math.floor((expectedTotal * this.config.recipients[i].bps) / 10_000);
      const actual = update.recipientAmounts[i]?.amount ?? 0;
      // Allow +-1 for rounding
      if (Math.abs(actual - expected) > 1) {
        throw new Error(
          `Recipient ${i} amount mismatch: got ${actual}, expected ~${expected}`,
        );
      }
    }

    try {
      Transaction.fromHex(update.signedTxHex);
    } catch (e) {
      throw new Error(`Invalid transaction hex: ${e}`);
    }

    // Accept
    this._sequenceNumber = update.sequenceNumber;
    this._totalPaidPieces = expectedPieces;
    this._totalPaid = update.totalPaid;
    this._recipientAmounts = [...update.recipientAmounts];
    this._latestTxHex = update.signedTxHex;

    return true;
  }

  getSettlementTx(): string {
    if (!this._latestTxHex) {
      throw new Error('No payments made — nothing to settle');
    }
    return this._latestTxHex;
  }

  close(): void {
    this._state = 'closed';
  }

  toRecord(): PaymentChannelRecord {
    const minerFee = 150 + this.config.recipients.length * 34;
    return {
      channelId: this.channelId,
      state: this._state,
      fundingTxid: this._fundingTxid,
      fundingVout: this._fundingVout,
      fundingAmount: this.config.fundingAmount,
      satsPerPiece: this.config.satsPerPiece,
      recipients: this.config.recipients,
      timeoutBlockHeight: this.config.timeoutBlockHeight,
      sequenceNumber: this._sequenceNumber,
      recipientAmounts: [...this._recipientAmounts],
      totalPaid: this._totalPaid,
      leecherChange: this.config.fundingAmount - this._totalPaid - minerFee,
      latestTxHex: this._latestTxHex,
      maxPieces: this.maxPieces,
      totalPaidPieces: this._totalPaidPieces,
    };
  }
}
