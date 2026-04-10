import { describe, it, expect } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import {
  signOffer,
  verifyOffer,
  signSubscription,
  verifySubscription,
  canonicaliseOffer,
  type SignedOfferRecord,
} from '../src/agents/identity.js';
import type { NewOffer } from '../src/agents/registry.js';

function makeOffer(address: string): NewOffer {
  return {
    producerId: 'spielbergx',
    producerAddress: address,
    title: 'Star Wars Episode 1000',
    synopsis: 'A test production posted by SpielbergX',
    requiredSats: 10_000,
    tokenTicker: 'SPLBRG001',
  };
}

describe('agent identity (BRC-77 signed records)', () => {
  it('signOffer produces a verifiable record', () => {
    const signer = PrivateKey.fromRandom();
    const address = signer.toAddress();
    const offer = makeOffer(address);
    const signed = signOffer(offer, signer);

    expect(signed.offer).toEqual(offer);
    expect(signed.signatureHex).toMatch(/^[0-9a-f]+$/);
    expect(signed.identityKeyHex).toBe(signer.toPublicKey().toString());
    expect(signed.signedAt).toBeGreaterThan(0);
    expect(verifyOffer(signed)).toBe(true);
  });

  it('verifyOffer rejects a record whose offer body was tampered', () => {
    const signer = PrivateKey.fromRandom();
    const address = signer.toAddress();
    const signed = signOffer(makeOffer(address), signer);
    const tampered: SignedOfferRecord = {
      ...signed,
      offer: { ...signed.offer, requiredSats: 1 },
    };
    expect(verifyOffer(tampered)).toBe(false);
  });

  it('verifyOffer rejects a record whose signedAt was tampered', () => {
    const signer = PrivateKey.fromRandom();
    const address = signer.toAddress();
    const signed = signOffer(makeOffer(address), signer);
    const tampered: SignedOfferRecord = {
      ...signed,
      signedAt: signed.signedAt + 1000,
    };
    expect(verifyOffer(tampered)).toBe(false);
  });

  it('verifyOffer rejects a record whose identity key does not match producerAddress', () => {
    const signer = PrivateKey.fromRandom();
    const otherKey = PrivateKey.fromRandom();
    const signed = signOffer(makeOffer(signer.toAddress()), signer);
    const spoofed: SignedOfferRecord = {
      ...signed,
      // Keep the signer's actual key in the signature but swap in a
      // different identity key that does NOT match producerAddress.
      offer: { ...signed.offer, producerAddress: otherKey.toAddress() },
    };
    expect(verifyOffer(spoofed)).toBe(false);
  });

  it('canonicaliseOffer produces deterministic bytes for the same input', () => {
    const signer = PrivateKey.fromRandom();
    const offer = makeOffer(signer.toAddress());
    const a = canonicaliseOffer(offer, 123);
    const b = canonicaliseOffer(offer, 123);
    expect(a).toEqual(b);
    const c = canonicaliseOffer(offer, 124);
    expect(c).not.toEqual(a);
  });

  it('signSubscription + verifySubscription round-trip', () => {
    const signer = PrivateKey.fromRandom();
    const signed = signSubscription(
      'offer-1',
      'vcx',
      signer.toAddress(),
      5_000,
      signer,
    );
    expect(verifySubscription(signed)).toBe(true);
  });

  it('verifySubscription rejects a spoofed address', () => {
    const signer = PrivateKey.fromRandom();
    const other = PrivateKey.fromRandom();
    const signed = signSubscription(
      'offer-1',
      'vcx',
      signer.toAddress(),
      5_000,
      signer,
    );
    const spoofed = { ...signed, address: other.toAddress() };
    expect(verifySubscription(spoofed)).toBe(false);
  });

  it('verifySubscription rejects a tampered sats amount', () => {
    const signer = PrivateKey.fromRandom();
    const signed = signSubscription(
      'offer-1',
      'vcx',
      signer.toAddress(),
      5_000,
      signer,
    );
    const tampered = { ...signed, sats: 1_000_000 };
    expect(verifySubscription(tampered)).toBe(false);
  });
});
