/**
 * BSVAPI x402 client.
 *
 * Wraps the "GET 402 -> pay BSV -> retry with x-bsv-payment header"
 * dance that BSVAPI (https://github.com/b0ase/bsvapi) expects. The
 * client is stateless — each call does its own price discovery,
 * payment, and retry — which is correct for one-shot content
 * generation from the autonomous swarm.
 *
 * Flow:
 *   1. POST the request to the configured BSVAPI base URL
 *   2. If response is 402, read the three payment headers:
 *        x-bsv-payment-version
 *        x-bsv-payment-satoshis-required
 *        x-bsv-payment-address
 *   3. Build a P2PKH payment transaction from the supplied wallet
 *      (or pool slot) sending satoshisRequired to payToAddress
 *   4. Broadcast it (via ARC if a broadcaster is supplied, otherwise
 *      via wallet.broadcast())
 *   5. Retry the original request with x-bsv-payment: <txid>
 *   6. Return the parsed response body
 *
 * The caller is responsible for handling retry-on-transient-failure
 * beyond the single retry built into this flow. This client will
 * surface a thrown error on every non-200 that is not a 402.
 */

import {
  Transaction,
  P2PKH,
  SatoshisPerKilobyte,
} from '@bsv/sdk';
import type { Wallet } from '../payment/wallet.js';
import type { TxBroadcaster } from '../payment/broadcaster.js';

export interface BsvapiClientOptions {
  /** Base URL of the BSVAPI deployment, e.g. https://bsvapi.com */
  baseUrl: string;
  /**
   * Wallet used to pay for content generation. Typically the
   * ProducerAgent's wallet, since the producer has just received
   * the financing token sale and wants to spend some of it on
   * actually making the content.
   */
  wallet: Wallet;
  /**
   * Optional broadcaster for the payment transaction. When
   * omitted, wallet.broadcast() is used (WhatsOnChain). The
   * agent swarm passes in an ArcBroadcaster so the payment goes
   * through the same high-throughput path as the streaming loop.
   */
  broadcaster?: TxBroadcaster;
  /**
   * Optional cushion to add to the satoshisRequired amount so a
   * race between price quoting and payment verification does not
   * undersend. Defaults to 0.
   */
  payCushionSats?: number;
  /**
   * Optional UTXO to spend. If omitted, the client calls
   * wallet.fetchUtxos() and picks the first UTXO large enough to
   * cover satoshisRequired + payCushionSats + a small fee reserve.
   */
  sourceUtxoFinder?: () => Promise<{
    txid: string;
    vout: number;
    sourceTx: Transaction;
    satoshis: number;
  } | null>;
}

export interface BsvapiChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: false;
}

export interface BsvapiImageRequest {
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  /** Number of images to generate; server may clamp */
  n?: number;
}

export interface BsvapiVideoRequest {
  model: string;
  prompt: string;
  duration_seconds?: number;
  aspect_ratio?: string;
}

export interface BsvapiResponse<T = unknown> {
  status: 'ok';
  body: T;
  paymentTxid: string;
  satoshisPaid: number;
}

/**
 * Lower-level fetch that builds and broadcasts the x402 payment if
 * the server returns a 402. Used by the typed helpers below.
 */
export class BsvapiClient {
  readonly baseUrl: string;
  private readonly wallet: Wallet;
  private readonly broadcaster?: TxBroadcaster;
  private readonly payCushionSats: number;
  private readonly sourceUtxoFinder?: BsvapiClientOptions['sourceUtxoFinder'];

  constructor(opts: BsvapiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.wallet = opts.wallet;
    this.broadcaster = opts.broadcaster;
    this.payCushionSats = opts.payCushionSats ?? 0;
    this.sourceUtxoFinder = opts.sourceUtxoFinder;
  }

  /**
   * POST a JSON body to a BSVAPI path, paying any 402 it returns.
   * Returns the parsed JSON response on success.
   */
  async postAndPay<T>(path: string, body: unknown): Promise<BsvapiResponse<T>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;

    // Initial request, no payment header
    const first = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (first.status === 200) {
      return {
        status: 'ok',
        body: (await first.json()) as T,
        paymentTxid: '',
        satoshisPaid: 0,
      };
    }

    if (first.status !== 402) {
      const text = await first.text().catch(() => '');
      throw new Error(
        `BSVAPI ${path} returned ${first.status}: ${text.slice(0, 400)}`,
      );
    }

    const requiredSats = Number(
      first.headers.get('x-bsv-payment-satoshis-required') ?? '0',
    );
    const payTo = first.headers.get('x-bsv-payment-address');
    if (!requiredSats || !payTo) {
      throw new Error(
        `BSVAPI ${path} returned 402 without a valid payment requirement ` +
          `(required=${requiredSats}, address=${payTo})`,
      );
    }

    // Build the payment tx
    const totalPay = requiredSats + this.payCushionSats;
    const paymentTx = await this.buildPaymentTx(payTo, totalPay);

    // Broadcast
    const broadcastResult = this.broadcaster
      ? await this.broadcaster.broadcast(paymentTx)
      : await this.wallet.broadcast(paymentTx);
    if (!broadcastResult.success) {
      throw new Error(`BSVAPI payment broadcast failed: ${broadcastResult.error}`);
    }

    // Retry the original request with the txid in the header
    const retry = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bsv-payment': broadcastResult.txid,
      },
      body: JSON.stringify(body),
    });
    if (retry.status !== 200) {
      const text = await retry.text().catch(() => '');
      throw new Error(
        `BSVAPI ${path} retry after payment returned ${retry.status}: ${text.slice(0, 400)}`,
      );
    }

    return {
      status: 'ok',
      body: (await retry.json()) as T,
      paymentTxid: broadcastResult.txid,
      satoshisPaid: totalPay,
    };
  }

  /**
   * Build a P2PKH transaction spending a wallet UTXO to payToAddress
   * with change back to the wallet. Uses sourceUtxoFinder if
   * provided, otherwise fetches from WhatsOnChain.
   */
  private async buildPaymentTx(
    payToAddress: string,
    satoshis: number,
  ): Promise<Transaction> {
    let sourceTx: Transaction;
    let vout: number;

    if (this.sourceUtxoFinder) {
      const utxo = await this.sourceUtxoFinder();
      if (!utxo) throw new Error('sourceUtxoFinder returned null');
      sourceTx = utxo.sourceTx;
      vout = utxo.vout;
    } else {
      const utxos = await this.wallet.fetchUtxos();
      if (utxos.length === 0) {
        throw new Error(`BSVAPI payer ${this.wallet.address} has no UTXOs`);
      }
      const need = satoshis + 500;
      const pick = utxos.find((u) => u.satoshis >= need);
      if (!pick) {
        throw new Error(
          `BSVAPI payer ${this.wallet.address} has no UTXO large enough. ` +
            `Need ${need}, best is ${utxos[0]?.satoshis ?? 0}`,
        );
      }
      sourceTx = await this.wallet.fetchTransaction(pick.txid);
      vout = pick.vout;
    }

    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: vout,
      unlockingScriptTemplate: new P2PKH().unlock(this.wallet.privateKey),
      sequence: 0xffffffff,
    });
    tx.addP2PKHOutput(payToAddress, satoshis);
    tx.addP2PKHOutput(this.wallet.address);
    await tx.fee(new SatoshisPerKilobyte(1));
    await tx.sign();
    return tx;
  }

  // ───── Typed convenience helpers ─────────────────────────────

  chat<T = unknown>(req: BsvapiChatRequest): Promise<BsvapiResponse<T>> {
    return this.postAndPay<T>('/api/v1/chat/completions', req);
  }

  generateImage<T = unknown>(req: BsvapiImageRequest): Promise<BsvapiResponse<T>> {
    return this.postAndPay<T>('/api/v1/images/generate', req);
  }

  generateVideo<T = unknown>(req: BsvapiVideoRequest): Promise<BsvapiResponse<T>> {
    return this.postAndPay<T>('/api/v1/video/generate', req);
  }
}
