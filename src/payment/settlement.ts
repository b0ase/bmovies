/**
 * Payment channel settlement.
 *
 * Handles broadcasting the final payment channel state on-chain
 * and verifying the settlement transaction outputs.
 *
 * Settlement flow:
 * 1. Seeder takes the latest signed payment tx from the channel
 * 2. Broadcasts it to BSV (mainnet or testnet)
 * 3. Verifies the tx was accepted
 * 4. Records the settlement for accounting
 */

import { Transaction } from '@bsv/sdk';
import type { PaymentChannel } from './channel.js';
import type { BroadcastResult } from '../types/payment.js';

const WOC_MAINNET = 'https://api.whatsonchain.com/v1/bsv/main';
const WOC_TESTNET = 'https://api.whatsonchain.com/v1/bsv/test';

export type Network = 'mainnet' | 'testnet';

export interface SettlementResult {
  channelId: string;
  txid: string;
  network: Network;
  success: boolean;
  error?: string;
  /** Output breakdown */
  outputs: {
    creatorAddress: string;
    creatorAmount: number;
    seederAddress: string;
    seederAmount: number;
    leecherChange: number;
  };
  /** Total pieces paid for */
  totalPieces: number;
  /** Raw transaction hex */
  rawTxHex: string;
}

export interface SettlementVerification {
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  /** Whether output amounts match expected values */
  outputsValid: boolean;
}

/**
 * Settle a payment channel by broadcasting the latest payment tx.
 */
export async function settleChannel(
  channel: PaymentChannel,
  network: Network = 'mainnet',
): Promise<SettlementResult> {
  const base: Omit<SettlementResult, 'txid' | 'success' | 'error'> = {
    channelId: channel.channelId,
    network,
    outputs: {
      creatorAddress: channel.config.creatorAddress,
      creatorAmount: channel.creatorAmount,
      seederAddress: channel.config.seederAddress,
      seederAmount: channel.seederAmount,
      leecherChange: channel.config.fundingAmount - channel.creatorAmount - channel.seederAmount - 200,
    },
    totalPieces: channel.totalPaidPieces,
    rawTxHex: '',
  };

  // Get the settlement tx
  let rawTxHex: string;
  try {
    rawTxHex = channel.getSettlementTx();
    base.rawTxHex = rawTxHex;
  } catch (err) {
    return {
      ...base,
      txid: '',
      success: false,
      error: `No settlement tx available: ${err}`,
    };
  }

  // Broadcast
  const broadcastResult = await broadcastTx(rawTxHex, network);

  // Close the channel
  channel.close();

  return {
    ...base,
    txid: broadcastResult.txid,
    success: broadcastResult.success,
    error: broadcastResult.error,
  };
}

/**
 * Verify a settlement transaction on-chain.
 */
export async function verifySettlement(
  txid: string,
  expectedCreatorAmount: number,
  expectedSeederAmount: number,
  network: Network = 'mainnet',
): Promise<SettlementVerification> {
  const baseUrl = network === 'testnet' ? WOC_TESTNET : WOC_MAINNET;

  try {
    // Fetch tx details
    const res = await fetch(`${baseUrl}/tx/hash/${txid}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { txid, confirmed: false, outputsValid: false };
    }

    const txData: any = await res.json();

    // Check confirmation
    const confirmed = (txData.confirmations ?? 0) > 0;
    const blockHeight = txData.blockheight ?? undefined;
    const blockHash = txData.blockhash ?? undefined;

    // Verify output amounts
    const outputs = txData.vout ?? [];
    let outputsValid = false;

    if (outputs.length >= 2) {
      const creatorOut = outputs[0];
      const seederOut = outputs[1];
      const creatorSats = Math.round((creatorOut?.value ?? 0) * 1e8);
      const seederSats = Math.round((seederOut?.value ?? 0) * 1e8);

      outputsValid =
        creatorSats === expectedCreatorAmount &&
        seederSats === expectedSeederAmount;
    }

    return { txid, confirmed, blockHeight, blockHash, outputsValid };
  } catch {
    return { txid, confirmed: false, outputsValid: false };
  }
}

/**
 * Validate a settlement transaction structure without broadcasting.
 * Parses the raw hex and checks:
 * - Has at least 2 outputs (creator + seeder)
 * - Output amounts match expected values
 * - Input references the funding txid
 */
export function validateSettlementTx(
  rawTxHex: string,
  expectedCreatorAmount: number,
  expectedSeederAmount: number,
  expectedFundingTxid?: string,
): {
  valid: boolean;
  errors: string[];
  parsedTx: Transaction | null;
} {
  const errors: string[] = [];
  let parsedTx: Transaction | null = null;

  try {
    parsedTx = Transaction.fromHex(rawTxHex);
  } catch (e) {
    return { valid: false, errors: [`Invalid tx hex: ${e}`], parsedTx: null };
  }

  // Check outputs
  if (parsedTx.outputs.length < 2) {
    errors.push(`Expected at least 2 outputs, got ${parsedTx.outputs.length}`);
  } else {
    const creatorSats = parsedTx.outputs[0].satoshis ?? 0;
    const seederSats = parsedTx.outputs[1].satoshis ?? 0;

    if (creatorSats !== expectedCreatorAmount) {
      errors.push(
        `Creator output: expected ${expectedCreatorAmount}, got ${creatorSats}`,
      );
    }
    if (seederSats !== expectedSeederAmount) {
      errors.push(
        `Seeder output: expected ${expectedSeederAmount}, got ${seederSats}`,
      );
    }
  }

  // Check input references funding tx
  if (expectedFundingTxid && parsedTx.inputs.length > 0) {
    const inputTxid = parsedTx.inputs[0].sourceTXID;
    if (inputTxid && inputTxid !== expectedFundingTxid) {
      errors.push(
        `Input references ${inputTxid}, expected funding tx ${expectedFundingTxid}`,
      );
    }
  }

  // Check sequence number (should be > 0 for a payment update)
  if (parsedTx.inputs.length > 0) {
    const seq = parsedTx.inputs[0].sequence;
    if (seq === 0xffffffff) {
      errors.push('Sequence is 0xFFFFFFFF — this looks like a funding tx, not a payment update');
    }
  }

  return { valid: errors.length === 0, errors, parsedTx };
}

/**
 * Batch settle multiple channels.
 */
export async function batchSettle(
  channels: PaymentChannel[],
  network: Network = 'mainnet',
): Promise<SettlementResult[]> {
  const results: SettlementResult[] = [];

  for (const channel of channels) {
    if (channel.totalPaidPieces === 0) continue;
    const result = await settleChannel(channel, network);
    results.push(result);
  }

  return results;
}

// ─── Internal ──────────────────────────────────────────────

async function broadcastTx(
  rawTxHex: string,
  network: Network,
): Promise<BroadcastResult> {
  const baseUrl = network === 'testnet' ? WOC_TESTNET : WOC_MAINNET;

  try {
    const res = await fetch(`${baseUrl}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: rawTxHex }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown');
      return { txid: '', success: false, error: `Broadcast failed: ${res.status} ${err}` };
    }

    const txid = (await res.text()).replace(/["\s]/g, '');
    return { txid, success: true };
  } catch (err) {
    return {
      txid: '',
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : err}`,
    };
  }
}
