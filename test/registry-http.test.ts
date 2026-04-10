import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrivateKey } from '@bsv/sdk';
import { MemoryRegistry } from '../src/agents/registry.js';
import { createAgentRegistryServer } from '../src/agents/server-routes.js';
import {
  signOffer,
  signSubscription,
  type SignedOfferRecord,
  type SignedSubscriptionRecord,
} from '../src/agents/identity.js';
import type { NewOffer } from '../src/agents/registry.js';

describe('agent registry HTTP routes (Fastify inject)', () => {
  let registry: MemoryRegistry;
  let app: FastifyInstance;

  beforeEach(async () => {
    registry = new MemoryRegistry();
    const result = await createAgentRegistryServer(registry);
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function buildSignedOffer(signer: PrivateKey): SignedOfferRecord {
    const offer: NewOffer = {
      producerId: 'spielbergx',
      producerAddress: signer.toAddress(),
      title: 'Star Wars Episode 1000',
      synopsis: 'Signed offer from the test suite',
      requiredSats: 10_000,
      tokenTicker: 'SPLBRG001',
    };
    return signOffer(offer, signer);
  }

  it('GET /api/agents/offers returns an empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/offers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ offers: [] });
  });

  it('POST /api/agents/offers accepts a valid signed record and stores it', async () => {
    const signer = PrivateKey.fromRandom();
    const signed = buildSignedOffer(signer);
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: signed,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { offer: { id: string; title: string } };
    expect(body.offer.id).toMatch(/^offer-/);
    expect(body.offer.title).toBe('Star Wars Episode 1000');
    expect(registry.listOpenOffers().length).toBe(1);
  });

  it('POST /api/agents/offers rejects a tampered signed record', async () => {
    const signer = PrivateKey.fromRandom();
    const signed = buildSignedOffer(signer);
    const tampered: SignedOfferRecord = {
      ...signed,
      offer: { ...signed.offer, requiredSats: 1 },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
    expect(registry.listOpenOffers().length).toBe(0);
  });

  it('POST /api/agents/offers rejects a spoofed producerAddress', async () => {
    const signer = PrivateKey.fromRandom();
    const other = PrivateKey.fromRandom();
    const signed = buildSignedOffer(signer);
    const spoofed: SignedOfferRecord = {
      ...signed,
      offer: { ...signed.offer, producerAddress: other.toAddress() },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: spoofed,
    });
    expect(res.statusCode).toBe(401);
  });

  it('subscribe flow: producer posts, financier subscribes, offer becomes funded', async () => {
    const producer = PrivateKey.fromRandom();
    const financier = PrivateKey.fromRandom();

    const postRes = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: buildSignedOffer(producer),
    });
    const { offer } = postRes.json() as { offer: { id: string } };

    const sub = signSubscription(
      offer.id,
      'vcx',
      financier.toAddress(),
      10_000,
      financier,
    );
    const subRes = await app.inject({
      method: 'POST',
      url: `/api/agents/offers/${offer.id}/subscribe`,
      payload: sub,
    });
    expect(subRes.statusCode).toBe(200);
    const subBody = subRes.json() as { offer: { status: string; raisedSats: number } };
    expect(subBody.offer.status).toBe('funded');
    expect(subBody.offer.raisedSats).toBe(10_000);
  });

  it('subscribe with a mismatched url/body offerId returns 400', async () => {
    const producer = PrivateKey.fromRandom();
    const financier = PrivateKey.fromRandom();
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: buildSignedOffer(producer),
    });
    const { offer } = postRes.json() as { offer: { id: string } };
    const sub = signSubscription(
      'offer-wrong-id',
      'vcx',
      financier.toAddress(),
      10_000,
      financier,
    );
    const subRes = await app.inject({
      method: 'POST',
      url: `/api/agents/offers/${offer.id}/subscribe`,
      payload: sub,
    });
    expect(subRes.statusCode).toBe(400);
  });

  it('subscribe with a tampered sats amount is rejected with 401', async () => {
    const producer = PrivateKey.fromRandom();
    const financier = PrivateKey.fromRandom();
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: buildSignedOffer(producer),
    });
    const { offer } = postRes.json() as { offer: { id: string } };
    const sub = signSubscription(
      offer.id,
      'vcx',
      financier.toAddress(),
      1_000,
      financier,
    );
    const tampered: SignedSubscriptionRecord = { ...sub, sats: 999_999 };
    const subRes = await app.inject({
      method: 'POST',
      url: `/api/agents/offers/${offer.id}/subscribe`,
      payload: tampered,
    });
    expect(subRes.statusCode).toBe(401);
  });

  it('status update requires the caller identity key to match the producer', async () => {
    const producer = PrivateKey.fromRandom();
    const imposter = PrivateKey.fromRandom();
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/agents/offers',
      payload: buildSignedOffer(producer),
    });
    const { offer } = postRes.json() as { offer: { id: string } };

    const impostorRes = await app.inject({
      method: 'POST',
      url: `/api/agents/offers/${offer.id}/status`,
      payload: {
        status: 'producing',
        identityKeyHex: imposter.toPublicKey().toString(),
        signatureHex: 'deadbeef',
      },
    });
    expect(impostorRes.statusCode).toBe(403);

    const legitRes = await app.inject({
      method: 'POST',
      url: `/api/agents/offers/${offer.id}/status`,
      payload: {
        status: 'producing',
        identityKeyHex: producer.toPublicKey().toString(),
        signatureHex: 'deadbeef',
      },
    });
    expect(legitRes.statusCode).toBe(200);
  });

  it('GET /api/agents/offers/:id returns 404 for unknown offers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/offers/does-not-exist',
    });
    expect(res.statusCode).toBe(404);
  });
});
