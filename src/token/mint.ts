/**
 * BSV-21 token minting for content tokenization.
 *
 * Mints a fungible token (BSV-21 deploy+mint) linked to a piece of content.
 * The token's address becomes the revenue destination — all streaming
 * payments flow there and are distributed to token holders as dividends.
 *
 * BSV-21 format: a 1sat ordinal inscription with JSON metadata:
 * { "p": "bsv-20", "op": "deploy+mint", "tick": "$TICKER", "max": "N", "amt": "N" }
 */

import { PrivateKey, Transaction, P2PKH, Script, SatoshisPerKilobyte } from '@bsv/sdk';
import { Wallet } from '../payment/wallet.js';
import type { ContentToken } from './types.js';
import type { ContentManifest } from '../types/torrent.js';

export interface MintOptions {
  /** Token ticker symbol (e.g. "EMPRESS") */
  ticker: string;
  /** Display name */
  name: string;
  /** Total supply */
  supply: number;
  /** Content manifest this token is linked to */
  manifest: ContentManifest;
  /** Creator's wallet */
  wallet: Wallet;
  /** Whether to broadcast on-chain */
  live: boolean;
}

/**
 * Build the BSV-21 deploy+mint inscription data.
 */
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

/**
 * Build an OP_RETURN + inscription output script.
 *
 * Format: OP_FALSE OP_RETURN <ord> <content-type> <data>
 * This is the standard 1sat ordinals inscription format.
 */
function buildInscriptionScript(data: Buffer): Script {
  const contentType = Buffer.from('application/bsv-20', 'utf-8');
  const ordTag = Buffer.from('ord', 'utf-8');

  // Build: OP_FALSE OP_RETURN "ord" <content-type-length> <content-type> <data-length> <data>
  const bytes = [
    0x00,                    // OP_FALSE
    0x6a,                    // OP_RETURN
    ...pushData(ordTag),
    0x01,                    // content-type field marker
    ...pushData(contentType),
    0x00,                    // data field marker
    ...pushData(data),
  ];

  // @bsv/sdk v2: `new Script(numArray)` does not parse raw bytes.
  // Use Script.fromBinary so chunks are decoded correctly. The old
  // form silently produced an empty script.
  return Script.fromBinary(bytes);
}

/** Build push data opcodes */
function pushData(data: Buffer): number[] {
  if (data.length < 76) {
    return [data.length, ...data];
  } else if (data.length < 256) {
    return [0x4c, data.length, ...data];
  } else {
    return [0x4d, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
  }
}

/**
 * Mint a BSV-21 token for a piece of content.
 *
 * In live mode: builds and broadcasts a real transaction.
 * In simulated mode: builds the transaction but doesn't broadcast.
 */
export async function mintContentToken(opts: MintOptions): Promise<ContentToken> {
  const { ticker, name, supply, manifest, wallet, live } = opts;
  const inscriptionData = buildInscriptionData(ticker, supply);
  const inscriptionScript = buildInscriptionScript(inscriptionData);

  // The revenue address is the creator's address
  // All streaming payments for this content will go here
  const revenueAddress = wallet.address;

  let deployTxid: string;

  if (live) {
    // Build a real transaction with the inscription
    const utxos = await wallet.fetchUtxos();
    if (!utxos.length) throw new Error('No UTXOs available for minting');

    const utxo = utxos.find(u => u.satoshis >= 1000);
    if (!utxo) throw new Error('Need at least 1000 sats to mint');

    const sourceTx = await wallet.fetchTransaction(utxo.txid);

    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: utxo.vout,
      unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKey),
      sequence: 0xffffffff,
    });

    // Output 0: 1sat inscription (the token)
    tx.addOutput({
      lockingScript: inscriptionScript,
      satoshis: 1,
    });

    // Output 1: change back to creator
    tx.addP2PKHOutput(wallet.address);

    await tx.fee(new SatoshisPerKilobyte(1));
    await tx.sign();

    // Broadcast
    const result = await wallet.broadcast(tx);
    if (!result.success) {
      throw new Error(`Mint broadcast failed: ${result.error}`);
    }
    deployTxid = result.txid;
    console.log(`[TOKEN] Minted ${ticker} on-chain: ${deployTxid}`);
  } else {
    // Simulated: build the tx but don't broadcast
    const sourceTx = new Transaction();
    sourceTx.addOutput({
      lockingScript: new P2PKH().lock(wallet.address),
      satoshis: 2000,
    });

    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(wallet.privateKey),
      sequence: 0xffffffff,
    });

    tx.addOutput({
      lockingScript: inscriptionScript,
      satoshis: 1,
    });

    tx.addP2PKHOutput(wallet.address);
    await tx.fee(new SatoshisPerKilobyte(1));
    await tx.sign();

    deployTxid = tx.id('hex');
    console.log(`[TOKEN] Minted ${ticker} (simulated): ${deployTxid}`);
  }

  const tokenId = `${deployTxid}_0`;

  return {
    tokenId,
    ticker,
    name,
    supply,
    infohash: manifest.infohash,
    revenueAddress,
    deployTxid,
    creatorAddress: wallet.address,
    mintedAt: Date.now(),
    live,
  };
}
