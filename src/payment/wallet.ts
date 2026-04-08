/**
 * BSV wallet wrapper for payment channel operations.
 *
 * Handles key management, UTXO fetching, and transaction building
 * using @bsv/sdk v2.
 */

import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import type { UTXO, BroadcastResult } from '../types/payment.js';

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';

export class Wallet {
  readonly privateKey: PrivateKey;
  readonly address: string;
  readonly publicKeyHex: string;

  constructor(wif: string) {
    this.privateKey = PrivateKey.fromWif(wif);
    this.address = this.privateKey.toAddress();
    this.publicKeyHex = this.privateKey.toPublicKey().toString();
  }

  /** Generate a fresh random wallet */
  static random(): Wallet {
    const pk = PrivateKey.fromRandom();
    return new Wallet(pk.toWif());
  }

  /** Fetch unspent outputs from WhatsOnChain */
  async fetchUtxos(): Promise<UTXO[]> {
    const res = await fetch(
      `${WOC_BASE}/address/${this.address}/unspent`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      throw new Error(`UTXO fetch failed: ${res.status}`);
    }

    const raw: Array<{ tx_hash: string; tx_pos: number; value: number }> =
      await res.json();

    const lockingScript = new P2PKH().lock(this.address);
    const scriptHex = Buffer.from(lockingScript.toBinary()).toString('hex');

    return raw.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script: scriptHex,
    }));
  }

  /**
   * Build a payment channel update transaction.
   *
   * This creates a valid, broadcastable transaction spending a funding UTXO
   * and splitting the output between creator, seeder, and leecher change.
   *
   * @param fundingTxid - TXID of the funding output
   * @param fundingVout - Output index of the funding output
   * @param fundingAmount - Total satoshis in the funding output
   * @param creatorAddress - Creator's BSV address
   * @param creatorAmount - Satoshis to pay the creator
   * @param seederAddress - Seeder's BSV address
   * @param seederAmount - Satoshis to pay the seeder
   * @param sequenceNumber - nSequence value (increments per payment)
   * @param sourceTransaction - The funding transaction object (for signing)
   * @returns Signed transaction hex
   */
  buildPaymentTx(opts: {
    fundingTxid: string;
    fundingVout: number;
    fundingAmount: number;
    creatorAddress: string;
    creatorAmount: number;
    seederAddress: string;
    seederAmount: number;
    sequenceNumber: number;
    sourceTransaction: Transaction;
  }): Transaction {
    const tx = new Transaction();

    // Input: spend the funding UTXO
    tx.addInput({
      sourceTransaction: opts.sourceTransaction,
      sourceOutputIndex: opts.fundingVout,
      unlockingScriptTemplate: new P2PKH().unlock(this.privateKey),
      sequence: opts.sequenceNumber,
    });

    // Output 0: creator's share
    if (opts.creatorAmount > 0) {
      tx.addP2PKHOutput(opts.creatorAddress, opts.creatorAmount);
    }

    // Output 1: seeder's share
    if (opts.seederAmount > 0) {
      tx.addP2PKHOutput(opts.seederAddress, opts.seederAmount);
    }

    // Output 2: leecher's change
    const totalPaid = opts.creatorAmount + opts.seederAmount;
    const minerFee = 200; // ~200 bytes at 1 sat/byte
    const change = opts.fundingAmount - totalPaid - minerFee;
    if (change > 0) {
      tx.addP2PKHOutput(this.address, change);
    }

    return tx;
  }

  /**
   * Build and sign a simple P2PKH funding transaction.
   * Sends `amount` satoshis to the leecher's own address (self-fund for channel).
   */
  async buildFundingTx(amount: number): Promise<Transaction> {
    const utxos = await this.fetchUtxos();
    if (utxos.length === 0) {
      throw new Error(`No UTXOs available for ${this.address}`);
    }

    // Find a UTXO large enough
    const utxo = utxos.find((u) => u.satoshis >= amount + 500);
    if (!utxo) {
      throw new Error(
        `No UTXO large enough. Need ${amount + 500}, best is ${utxos[0]?.satoshis ?? 0}`,
      );
    }

    // Fetch the source transaction for signing
    const sourceTx = await this.fetchTransaction(utxo.txid);

    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(this.privateKey),
      sequence: 0xffffffff,
    });

    // Channel funding output (to self)
    tx.addP2PKHOutput(this.address, amount);

    // Change output
    tx.addP2PKHOutput(this.address); // change flag handled by fee()

    await tx.fee(new SatoshisPerKilobyte(1));
    await tx.sign();

    return tx;
  }

  /** Fetch a raw transaction by TXID and parse it */
  async fetchTransaction(txid: string): Promise<Transaction> {
    const res = await fetch(
      `${WOC_BASE}/tx/${txid}/hex`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      throw new Error(`TX fetch failed: ${res.status}`);
    }
    const hex = await res.text();
    return Transaction.fromHex(hex.trim());
  }

  /** Broadcast a signed transaction */
  async broadcast(tx: Transaction): Promise<BroadcastResult> {
    const hex = tx.toHex();
    const res = await fetch(`${WOC_BASE}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: hex }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown');
      return { txid: '', success: false, error: `Broadcast failed: ${res.status} ${err}` };
    }

    const txid = (await res.text()).replace(/["\s]/g, '');
    return { txid, success: true };
  }
}
