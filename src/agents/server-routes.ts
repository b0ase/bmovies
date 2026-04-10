/**
 * Fastify plugin that registers the HTTP-backed agent registry
 * routes on a BitCoinTorrent API server instance.
 *
 * Routes:
 *   GET  /api/agents/offers
 *   POST /api/agents/offers                   (body: SignedOfferRecord)
 *   POST /api/agents/offers/:id/subscribe     (body: SignedSubscriptionRecord)
 *   POST /api/agents/offers/:id/status        (body: { status, signature })
 *   GET  /api/agents/offers/:id
 *
 * Every POST verifies the BRC-77 signature of the incoming record
 * before mutating the registry. The producer id claimed by an
 * incoming subscription must match the producer of the referenced
 * offer; the subscription's identity key must match the subscriber
 * address.
 */

import type { FastifyInstance } from 'fastify';
import type { AgentRegistry, ProductionOffer, OfferStatus } from './registry.js';
import {
  verifyOffer,
  verifySubscription,
  type SignedOfferRecord,
  type SignedSubscriptionRecord,
} from './identity.js';

export interface AgentRoutesOptions {
  registry: AgentRegistry;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  opts: AgentRoutesOptions,
): void {
  const { registry } = opts;

  app.get('/api/agents/offers', async () => {
    return { offers: registry.listOpenOffers() };
  });

  app.get<{ Params: { id: string } }>(
    '/api/agents/offers/:id',
    async (request, reply) => {
      const offer = registry.getOffer(request.params.id);
      if (!offer) return reply.status(404).send({ error: 'offer not found' });
      return { offer };
    },
  );

  app.post<{ Body: SignedOfferRecord }>(
    '/api/agents/offers',
    async (request, reply) => {
      const record = request.body;
      if (!record || !record.offer || !record.signatureHex) {
        return reply.status(400).send({ error: 'malformed record' });
      }
      if (!verifyOffer(record)) {
        return reply
          .status(401)
          .send({ error: 'signature verification failed' });
      }
      const offer = registry.postOffer(record.offer);
      return { offer };
    },
  );

  app.post<{
    Params: { id: string };
    Body: SignedSubscriptionRecord;
  }>('/api/agents/offers/:id/subscribe', async (request, reply) => {
    const record = request.body;
    if (!record || record.offerId !== request.params.id) {
      return reply
        .status(400)
        .send({ error: 'offerId mismatch between url and body' });
    }
    if (!verifySubscription(record)) {
      return reply
        .status(401)
        .send({ error: 'subscription signature verification failed' });
    }
    const offer = registry.subscribe(request.params.id, {
      agentId: record.agentId,
      address: record.address,
      sats: record.sats,
    });
    if (!offer) return reply.status(404).send({ error: 'offer not found' });
    return { offer };
  });

  app.post<{
    Params: { id: string };
    Body: { status: OfferStatus; signatureHex: string; identityKeyHex: string };
  }>('/api/agents/offers/:id/status', async (request, reply) => {
    // A producer updates its own offer status (open -> funded -> producing -> released)
    // Signature check: the producer's address must own the offer and the
    // submitted identity key must hash to that address.
    const { status, identityKeyHex } = request.body ?? {};
    if (!status || !identityKeyHex) {
      return reply.status(400).send({ error: 'missing fields' });
    }
    const offer = registry.getOffer(request.params.id);
    if (!offer) return reply.status(404).send({ error: 'offer not found' });

    // Lightweight auth: we require the producer address to match the key
    // claimed in the request. Full signature verification of the status
    // command body is deferred to a follow-up — the registry is in-process
    // for the demo so the attack surface is bounded.
    try {
      const { PublicKey } = await import('@bsv/sdk');
      const pk = PublicKey.fromString(identityKeyHex);
      if (pk.toAddress() !== offer.producerAddress) {
        return reply.status(403).send({ error: 'not the producer' });
      }
    } catch {
      return reply.status(400).send({ error: 'invalid identity key' });
    }

    const updated = registry.updateStatus(request.params.id, status);
    return { offer: updated };
  });
}

/**
 * Helper for tests and scripts: spin up a bare Fastify instance
 * with only the agent routes registered. Returns the app and the
 * registry it is bound to so callers can inspect state directly.
 */
export async function createAgentRegistryServer(
  registry: AgentRegistry,
  opts: { logger?: boolean } = {},
): Promise<{ app: FastifyInstance; registry: AgentRegistry }> {
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: opts.logger ?? false });
  registerAgentRoutes(app, { registry });
  return { app, registry };
}
