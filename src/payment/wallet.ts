/**
 * BSV wallet wrapper for payment channel operations.
 *
 * Handles key management, UTXO fetching, and transaction building
 * using @bsv/sdk v2.
 */

import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import type { UTXO, BroadcastResult } from '../types/payment.js';

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';

/**
 * Fee rate in satoshis per kilobyte. Theoretical BSV network
 * minimum is 1 sat/KB, but real-world relay policies enforce a
 * higher floor: GorillaPool ARC currently requires at least ~50
 * sat/KB and Taal ARC is similar. At 100 sat/KB a typical P2PKH
 * tx of ~260 bytes costs ~26 sats — comfortably above every ARC
 * minimum we have seen while staying well under a cent.
 *
 * Import this constant anywhere you construct a SatoshisPerKilobyte
 * to keep the fee policy consistent across the repo.
 */
export const NETWORK_FEE_SATS_PER_KB = 100;

export const NETWORK_FEE_MODEL = new SatoshisPerKilobyte(NETWORK_FEE_SATS_PER_KB);

/**
 * Retry a fetch with exponential backoff when the response is 429
 * (rate-limited) or a transient 5xx. The decision to retry is made
 * on the HTTP response itself, so fetch-level exceptions (DNS, abort)
 * still throw on the first attempt.
 *
 * delayMs schedule: 250 -> 500 -> 1000 -> 2000 -> 4000 with ±20% jitter.
 * Total worst-case wait: ~8 seconds across 5 attempts.
 */
async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  maxAttempts = 5,
): Promise<Response> {
  let attempt = 0;
  let lastRes: Response | null = null;
  while (attempt < maxAttempts) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const shouldRetry = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!shouldRetry) return res;
    lastRes = res;
    attempt++;
    if (attempt >= maxAttempts) break;
    const base = 250 * Math.pow(2, attempt - 1);
    const jitter = base * (Math.random() * 0.4 - 0.2);
    const delay = Math.round(base + jitter);
    await new Promise((r) => setTimeout(r, delay));
  }
  return lastRes!;
}

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
    const res = await fetchWithRetry(
      `${WOC_BASE}/address/${this.address}/unspent`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      throw new Error(`UTXO fetch failed: ${res.status}`);
    }

    const raw = (await res.json()) as Array<{
      tx_hash: string;
      tx_pos: number;
      value: number;
    }>;

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
   * Fans out to N recipients (token holders) proportionally.
   * No fixed split — recipients and amounts are determined by
   * the token holder snapshot at channel creation time.
   */
  buildPaymentTx(opts: {
    fundingVout: number;
    fundingAmount: number;
    /** Recipients with their cumulative sat amounts */
    recipients: Array<{ address: string; amount: number }>;
    sequenceNumber: number;
    sourceTransaction: Transaction;
  }): Transaction {
    const tx = new Transaction();

    tx.addInput({
      sourceTransaction: opts.sourceTransaction,
      sourceOutputIndex: opts.fundingVout,
      unlockingScriptTemplate: new P2PKH().unlock(this.privateKey),
      sequence: opts.sequenceNumber,
    });

    // Outputs: one per recipient with amount > 0
    let totalPaid = 0;
    for (const r of opts.recipients) {
      if (r.amount > 0) {
        tx.addP2PKHOutput(r.address, r.amount);
        totalPaid += r.amount;
      }
    }

    // Change output back to leecher
    const minerFee = 150 + opts.recipients.length * 34; // base + per-output
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
    const res = await fetchWithRetry(
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
    const res = await fetchWithRetry(`${WOC_BASE}/tx/raw`, {
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
