/**
 * Proof of Serve — cryptographic receipts for content delivery.
 *
 * Each time a seeder delivers a piece and receives payment,
 * they generate a signed proof that can be verified by anyone.
 *
 * Uses BSM (Bitcoin Signed Message) for signing/verification.
 */

import { PrivateKey, PublicKey, BSM, Signature } from '@bsv/sdk';
import { createHash } from 'node:crypto';

export interface ServeProof {
  version: 1;
  contentHash: string;
  infohash: string;
  pieceIndex: number;
  leecherPubkey: string;
  seederAddress: string;
  /** Seeder's public key hex (needed for verification) */
  seederPubkey: string;
  sequenceNumber: number;
  satsPaid: number;
  timestamp: number;
  /** BSM signature in DER hex */
  signature: string;
}

function proofMessage(fields: Omit<ServeProof, 'signature'>): string {
  return [
    fields.version,
    fields.contentHash,
    fields.infohash,
    fields.pieceIndex,
    fields.leecherPubkey,
    fields.seederAddress,
    fields.sequenceNumber,
    fields.satsPaid,
    fields.timestamp,
  ].join('|');
}

/**
 * Create a signed serve proof.
 */
export function createServeProof(
  seederPrivateKey: PrivateKey,
  params: {
    contentHash: string;
    infohash: string;
    pieceIndex: number;
    leecherPubkey: string;
    sequenceNumber: number;
    satsPaid: number;
  },
): ServeProof {
  const fields: Omit<ServeProof, 'signature'> = {
    version: 1,
    contentHash: params.contentHash,
    infohash: params.infohash,
    pieceIndex: params.pieceIndex,
    leecherPubkey: params.leecherPubkey,
    seederAddress: seederPrivateKey.toAddress(),
    seederPubkey: seederPrivateKey.toPublicKey().toString(),
    sequenceNumber: params.sequenceNumber,
    satsPaid: params.satsPaid,
    timestamp: Date.now(),
  };

  const message = proofMessage(fields);
  const messageBytes = Array.from(Buffer.from(message, 'utf-8'));
  const sig = BSM.sign(messageBytes, seederPrivateKey, 'raw') as unknown as Signature;
  const derHex = Buffer.from(sig.toDER()).toString('hex');

  return {
    ...fields,
    signature: derHex,
  };
}

/**
 * Verify a serve proof's signature.
 */
export function verifyServeProof(proof: ServeProof): boolean {
  const { signature: _sig, ...fields } = proof;
  const message = proofMessage(fields);
  const messageBytes = Array.from(Buffer.from(message, 'utf-8'));

  try {
    const pubkey = PublicKey.fromString(proof.seederPubkey);

    // Check pubkey matches claimed address
    if (pubkey.toAddress() !== proof.seederAddress) return false;

    // Reconstruct Signature from stored DER hex
    const derBytes = Array.from(Buffer.from(proof.signature, 'hex'));
    const sig = Signature.fromDER(derBytes);

    return BSM.verify(messageBytes, sig, pubkey);
  } catch {
    return false;
  }
}

/**
 * Compute SHA-256 hash of content.
 */
export function hashContent(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Store for collecting serve proofs during a session.
 */
export class ProofStore {
  private proofs: ServeProof[] = [];

  add(proof: ServeProof): void {
    this.proofs.push(proof);
  }

  getByContent(infohash: string): ServeProof[] {
    return this.proofs.filter((p) => p.infohash === infohash);
  }

  getByPeer(leecherPubkey: string): ServeProof[] {
    return this.proofs.filter((p) => p.leecherPubkey === leecherPubkey);
  }

  get count(): number {
    return this.proofs.length;
  }

  export(): string {
    return JSON.stringify(this.proofs, null, 2);
  }

  import(json: string): void {
    const imported = JSON.parse(json) as ServeProof[];
    this.proofs.push(...imported);
  }
}
