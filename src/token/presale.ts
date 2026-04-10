/**
 * Presale financing token mint.
 *
 * A presale token is a BSV-21 deploy+mint inscription that represents
 * financing rights in a production that does not yet exist. It is
 * minted by a ProducerAgent against a ProductionOffer. Every satoshi
 * of the offer budget maps to one token unit.
 *
 * The design purposefully reuses the existing BSV-21 inscription
 * format from src/token/mint.ts so indexers that already understand
 * BSV-21 can pick up presale tokens without any extra work.
 *
 * Two entry points:
 *   - buildPresaleMintTx:   pure function, takes an explicit source
 *                           transaction and output index, builds and
 *                           signs a mint transaction without touching
 *                           the network. Used in unit tests.
 *   - mintPresaleOnChain:   fetches a UTXO from WhatsOnChain, builds,
 *                           broadcasts. Used by the live swarm.
 */

import {
  Transaction,
  P2PKH,
  Script,
  SatoshisPerKilobyte,
} from '@bsv/sdk';
import { Wallet } from '../payment/wallet.js';
import type { ProductionOffer } from '../agents/registry.js';

export interface PresaleToken {
  offerId: string;
  ticker: string;
  supply: number;
  producerAddress: string;
  deployTxid: string;
  deployTxHex: string;
  /** Canonical token id in {txid}_{vout} form */
  tokenId: string;
  mintedAt: number;
}

function buildInscriptionData(ticker: string, supply: number): Buffer {
  const json = JSON.stringify({
    p: 'bsv-20',
    op: 'deploy+mint',
    tick: ticker,
    max: String(supply),
    amt: String(supply),
  });
  return Buffer.from(json, 'utf-8');
}

function pushData(data: Buffer): number[] {
  if (data.length < 76) return [data.length, ...data];
  if (data.length < 256) return [0x4c, data.length, ...data];
  return [0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

function buildInscriptionScript(data: Buffer): Script {
  const contentType = Buffer.from('application/bsv-20', 'utf-8');
  const ordTag = Buffer.from('ord', 'utf-8');
  const bytes = [
    0x00, // OP_FALSE
    0x6a, // OP_RETURN
    ...pushData(ordTag),
    0x01,
    ...pushData(contentType),
    0x00,
    ...pushData(data),
  ];
  // @bsv/sdk v2: `new Script(numbers)` does not interpret raw bytes.
  // Use Script.fromBinary so the chunk stream is parsed correctly.
  return Script.fromBinary(bytes);
}

export interface BuildPresaleMintOptions {
  offer: ProductionOffer;
  wallet: Wallet;
  /** The source transaction whose output is being spent */
  sourceTx: Transaction;
  /** The vout in sourceTx that the wallet can spend */
  sourceVout: number;
}

/**
 * Build and sign a presale mint transaction. Does not broadcast.
 * Throws if wallet.address does not match offer.producerAddress.
 */
export async function buildPresaleMintTx(
  opts: BuildPresaleMintOptions,
): Promise<Transaction> {
  const { offer, wallet, sourceTx, sourceVout } = opts;
  if (wallet.address !== offer.producerAddress) {
    throw new Error(
      `Presale mint must be signed by the producer wallet. ` +
        `wallet=${wallet.address} offer.producer=${offer.producerAddress}`,
    );
  }

  const data = buildInscriptionData(offer.tokenTicker, offer.requiredSats);
  const script = buildInscriptionScript(data);

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: sourceVout,
    unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKey),
    sequence: 0xffffffff,
  });
  // Output 0: 1sat inscription (the presale token)
  tx.addOutput({ lockingScript: script, satoshis: 1 });
  // Output 1: change back to producer
  tx.addP2PKHOutput(wallet.address);
  await tx.fee(new SatoshisPerKilobyte(1));
  await tx.sign();
  return tx;
}

/**
 * Fetch a UTXO from WhatsOnChain, build a presale mint tx,
 * broadcast it, and return the resulting PresaleToken record.
 */
export async function mintPresaleOnChain(
  offer: ProductionOffer,
  wallet: Wallet,
): Promise<PresaleToken> {
  if (wallet.address !== offer.producerAddress) {
    throw new Error('Presale mint must be signed by the producer wallet');
  }

  const utxos = await wallet.fetchUtxos();
  if (utxos.length === 0) {
    throw new Error(
      `Producer ${wallet.address} has no UTXOs — fund it before minting`,
    );
  }
  const utxo = utxos.find((u) => u.satoshis >= 2_000);
  if (!utxo) {
    throw new Error(
      `Producer ${wallet.address} has no UTXO with at least 2000 sats`,
    );
  }
  const sourceTx = await wallet.fetchTransaction(utxo.txid);
  const tx = await buildPresaleMintTx({
    offer,
    wallet,
    sourceTx,
    sourceVout: utxo.vout,
  });

  const result = await wallet.broadcast(tx);
  if (!result.success) {
    throw new Error(`Presale mint broadcast failed: ${result.error}`);
  }

  const txid = result.txid;
  return {
    offerId: offer.id,
    ticker: offer.tokenTicker,
    supply: offer.requiredSats,
    producerAddress: wallet.address,
    deployTxid: txid,
    deployTxHex: tx.toHex(),
    tokenId: `${txid}_0`,
    mintedAt: Date.now(),
  };
}
