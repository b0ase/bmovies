/**
 * On-chain subscription payment helpers.
 *
 * A financier subscribes to a producer's offer by sending real BSV
 * to the producer's P2PKH address. The amount is the sat value
 * decided by the financier's thesis evaluator.
 *
 * Two entry points match the presale module:
 *   - buildSubscriptionTx:  pure, takes an explicit source tx;
 *                           used in unit tests.
 *   - subscribeOnChain:     fetches UTXOs from WhatsOnChain, builds,
 *                           broadcasts; used by the live swarm.
 *
 * Every successful broadcast also triggers a POST to the HTTP
 * agent registry so the off-chain offer record is updated; that
 * step is handled by the caller via HttpRegistryClient.subscribe.
 */

import { Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from '../payment/wallet.js';
import type { ProductionOffer } from './registry.js';

export interface SubscriptionReceipt {
  offerId: string;
  financierAddress: string;
  producerAddress: string;
  sats: number;
  txid: string;
  txHex: string;
  broadcastAt: number;
}

export interface BuildSubscriptionOptions {
  financier: Wallet;
  offer: ProductionOffer;
  sats: number;
  sourceTx: Transaction;
  sourceVout: number;
}

export async function buildSubscriptionTx(
  opts: BuildSubscriptionOptions,
): Promise<Transaction> {
  const { financier, offer, sats, sourceTx, sourceVout } = opts;
  if (sats <= 0) throw new Error('sats must be > 0');

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: sourceVout,
    unlockingScriptTemplate: new P2PKH().unlock(financier.privateKey),
    sequence: 0xffffffff,
  });
  // Output 0: payment to producer
  tx.addP2PKHOutput(offer.producerAddress, sats);
  // Output 1: change back to financier (fee() will balance)
  tx.addP2PKHOutput(financier.address);
  await tx.fee(new SatoshisPerKilobyte(1));
  await tx.sign();
  return tx;
}

/**
 * Fetch UTXOs for the financier, build a subscription tx paying
 * `sats` to the producer, broadcast it, and return the receipt.
 */
export async function subscribeOnChain(
  financier: Wallet,
  offer: ProductionOffer,
  sats: number,
): Promise<SubscriptionReceipt> {
  if (sats <= 0) throw new Error('sats must be > 0');

  const utxos = await financier.fetchUtxos();
  if (utxos.length === 0) {
    throw new Error(
      `Financier ${financier.address} has no UTXOs — fund it before subscribing`,
    );
  }

  // Need enough for the payment + a safety margin for miner fee and change.
  const required = sats + 500;
  const utxo = utxos.find((u) => u.satoshis >= required);
  if (!utxo) {
    throw new Error(
      `Financier ${financier.address} has no UTXO large enough. ` +
        `Need ${required}, best is ${utxos[0]?.satoshis ?? 0}`,
    );
  }

  const sourceTx = await financier.fetchTransaction(utxo.txid);
  const tx = await buildSubscriptionTx({
    financier,
    offer,
    sats,
    sourceTx,
    sourceVout: utxo.vout,
  });

  const result = await financier.broadcast(tx);
  if (!result.success) {
    throw new Error(`Subscription broadcast failed: ${result.error}`);
  }

  return {
    offerId: offer.id,
    financierAddress: financier.address,
    producerAddress: offer.producerAddress,
    sats,
    txid: result.txid,
    txHex: tx.toHex(),
    broadcastAt: Date.now(),
  };
}
