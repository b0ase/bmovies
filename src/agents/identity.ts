/**
 * Agent identity layer — BRC-77 signed message helpers used by
 * the HTTP registry to prove that an offer record genuinely comes
 * from a given agent's BRC-100 identity key.
 *
 * This module does NOT implement the full BRC-100 wallet interface.
 * It relies on the BRC-77 signing primitive from @bsv/sdk, which is
 * the cryptographic foundation that BRC-100 wallets use underneath
 * for signing messages.
 *
 * Offer records are canonicalised into a deterministic byte string,
 * signed by the producer's PrivateKey, and shipped with the signature
 * + identity public key. Financiers verify before acting.
 */

import { PrivateKey, PublicKey, SignedMessage } from '@bsv/sdk';
import type { NewOffer } from './registry.js';

const brc77Sign = SignedMessage.sign;
const brc77Verify = SignedMessage.verify;

/**
 * Signed offer envelope posted to the HTTP registry.
 * All fields are required except tokenTicker which is carried inside
 * the inner offer record.
 */
export interface SignedOfferRecord {
  /** The offer payload the producer is asking to publish */
  offer: NewOffer;
  /** Hex-encoded BRC-77 signature over the canonicalised offer bytes */
  signatureHex: string;
  /** Hex-encoded public key of the signer (the producer's identity key) */
  identityKeyHex: string;
  /** Unix timestamp (ms) when the signature was produced */
  signedAt: number;
}

/**
 * Signed subscription envelope. A financier publishes this to the
 * registry to declare its intent to subscribe to an offer, alongside
 * (or before) broadcasting the on-chain BSV payment.
 */
export interface SignedSubscriptionRecord {
  offerId: string;
  agentId: string;
  address: string;
  sats: number;
  signatureHex: string;
  identityKeyHex: string;
  signedAt: number;
}

/**
 * Canonicalise a NewOffer payload into a deterministic byte string
 * suitable for signing. Fields are sorted and concatenated; this is
 * intentionally hand-rolled so the signed bytes are independent of
 * JSON-stringify quirks.
 */
export function canonicaliseOffer(offer: NewOffer, signedAt: number): number[] {
  const parts = [
    `producerId=${offer.producerId}`,
    `producerAddress=${offer.producerAddress}`,
    `title=${offer.title}`,
    `synopsis=${offer.synopsis}`,
    `requiredSats=${offer.requiredSats}`,
    `tokenTicker=${offer.tokenTicker}`,
    `signedAt=${signedAt}`,
  ];
  const joined = parts.join('\n');
  return Array.from(new TextEncoder().encode(joined));
}

export function canonicaliseSubscription(
  sub: Omit<SignedSubscriptionRecord, 'signatureHex' | 'identityKeyHex'>,
): number[] {
  const parts = [
    `offerId=${sub.offerId}`,
    `agentId=${sub.agentId}`,
    `address=${sub.address}`,
    `sats=${sub.sats}`,
    `signedAt=${sub.signedAt}`,
  ];
  return Array.from(new TextEncoder().encode(parts.join('\n')));
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): number[] {
  if (hex.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Array<number>(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Sign an offer record with the producer's private key.
 * The returned envelope is universally verifiable — anyone with the
 * identity public key can confirm authenticity.
 */
export function signOffer(
  offer: NewOffer,
  signer: PrivateKey,
): SignedOfferRecord {
  const signedAt = Date.now();
  const message = canonicaliseOffer(offer, signedAt);
  const sig = brc77Sign(message, signer);
  return {
    offer,
    signatureHex: bytesToHex(sig),
    identityKeyHex: signer.toPublicKey().toString(),
    signedAt,
  };
}

/**
 * Verify a signed offer record. Returns true if the signature is
 * valid AND the embedded identity key matches the claimed
 * producerAddress (prevents a producer from claiming someone
 * else's address).
 */
export function verifyOffer(record: SignedOfferRecord): boolean {
  try {
    const message = canonicaliseOffer(record.offer, record.signedAt);
    const sig = hexToBytes(record.signatureHex);
    if (!brc77Verify(message, sig)) return false;

    // Ensure the identity key the record claims actually hashes to
    // the producerAddress inside the offer payload.
    const pk = PublicKey.fromString(record.identityKeyHex);
    const derivedAddress = pk.toAddress();
    return derivedAddress === record.offer.producerAddress;
  } catch {
    return false;
  }
}

export function signSubscription(
  offerId: string,
  agentId: string,
  address: string,
  sats: number,
  signer: PrivateKey,
): SignedSubscriptionRecord {
  const signedAt = Date.now();
  const base = { offerId, agentId, address, sats, signedAt };
  const message = canonicaliseSubscription(base);
  const sig = brc77Sign(message, signer);
  return {
    ...base,
    signatureHex: bytesToHex(sig),
    identityKeyHex: signer.toPublicKey().toString(),
  };
}

export function verifySubscription(
  record: SignedSubscriptionRecord,
): boolean {
  try {
    const { signatureHex, identityKeyHex, ...base } = record;
    const message = canonicaliseSubscription(base);
    const sig = hexToBytes(signatureHex);
    if (!brc77Verify(message, sig)) return false;
    const pk = PublicKey.fromString(identityKeyHex);
    return pk.toAddress() === record.address;
  } catch {
    return false;
  }
}
