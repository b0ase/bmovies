/**
 * HTTP-backed AgentRegistry implementation.
 *
 * This is the registry that ships in the hackathon submission.
 * Producers sign their offer records with BRC-77 and POST them to
 * a shared endpoint; financiers GET the offer list and subscribe
 * by POSTing a signed subscription record alongside an on-chain
 * BSV payment.
 *
 * The server side of this registry is a set of routes on the
 * existing BitCoinTorrent Fastify server (src/api/server.ts). That
 * server runs in the same process as the demo and persists offers
 * in memory backed by a MemoryRegistry instance.
 *
 * The ONLY thing the server adds on top of MemoryRegistry is
 * signature verification — every incoming record is checked with
 * verifyOffer() / verifySubscription() before being accepted.
 */

import { PrivateKey } from '@bsv/sdk';
import type {
  AgentRegistry,
  NewOffer,
  OfferStatus,
  OfferSubscription,
  ProductionArtifact,
  ProductionOffer,
} from './registry.js';
import {
  signOffer,
  signSubscription,
  verifyOffer,
  verifySubscription,
  type SignedOfferRecord,
  type SignedSubscriptionRecord,
} from './identity.js';

/**
 * Client-side HTTP registry used by a ProducerAgent or
 * FinancierAgent to interact with a running registry server.
 *
 * Because the AgentRegistry interface is synchronous but HTTP is
 * async, this client keeps a locally cached view of offers that is
 * updated on demand by calling refresh(). Offer posts and
 * subscriptions are fire-and-forget against the server and the
 * local cache is updated optimistically.
 */
export class HttpRegistryClient implements AgentRegistry {
  private readonly baseUrl: string;
  private readonly signer: PrivateKey;
  private cache = new Map<string, ProductionOffer>();

  constructor(opts: { baseUrl: string; signer: PrivateKey }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.signer = opts.signer;
  }

  /** Pull the current offer list from the server into the local cache */
  async refresh(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/agents/offers`);
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
    const body = (await res.json()) as { offers: ProductionOffer[] };
    this.cache.clear();
    for (const offer of body.offers) {
      this.cache.set(offer.id, offer);
    }
  }

  postOffer(offer: NewOffer): ProductionOffer {
    // Sign synchronously, POST async in the background; return a
    // pending offer placeholder with a client-generated id.
    const signed = signOffer(offer, this.signer);
    const pendingId = `pending-${signed.signedAt}`;
    const placeholder: ProductionOffer = {
      id: pendingId,
      raisedSats: 0,
      subscribers: [],
      status: 'open',
      createdAt: signed.signedAt,
      ...offer,
    };
    this.cache.set(pendingId, placeholder);

    // Fire the HTTP POST; once the server responds with the real
    // id we replace the placeholder.
    void this.submitOffer(signed, pendingId).catch(() => {});

    return placeholder;
  }

  private async submitOffer(
    signed: SignedOfferRecord,
    pendingId: string,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/agents/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { offer: ProductionOffer };
    this.cache.delete(pendingId);
    this.cache.set(body.offer.id, body.offer);
  }

  listOpenOffers(): ProductionOffer[] {
    return [...this.cache.values()]
      .filter((o) => o.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getOffer(id: string): ProductionOffer | null {
    return this.cache.get(id) ?? null;
  }

  subscribe(
    offerId: string,
    sub: Omit<OfferSubscription, 'ts'>,
  ): ProductionOffer | null {
    const offer = this.cache.get(offerId);
    if (!offer) return null;
    const signed = signSubscription(
      offerId,
      sub.agentId,
      sub.address,
      sub.sats,
      this.signer,
    );
    void this.submitSubscription(signed).catch(() => {});
    // Optimistic local update
    offer.subscribers.push({ ...sub, ts: signed.signedAt });
    offer.raisedSats += sub.sats;
    if (offer.raisedSats >= offer.requiredSats) offer.status = 'funded';
    return offer;
  }

  private async submitSubscription(
    signed: SignedSubscriptionRecord,
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/agents/offers/${signed.offerId}/subscribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      },
    );
    if (!res.ok) return;
    const body = (await res.json()) as { offer: ProductionOffer };
    this.cache.set(body.offer.id, body.offer);
  }

  updateStatus(offerId: string, status: OfferStatus): ProductionOffer | null {
    const offer = this.cache.get(offerId);
    if (!offer) return null;
    offer.status = status;
    // Server-side status changes are applied by the producer's
    // separate POST /api/agents/offers/:id/status endpoint — but
    // only the producer of the offer should call it. Deferred to
    // the streaming loop task where producer.tick drives it.
    return offer;
  }

  attachArtifact(
    offerId: string,
    artifact: ProductionArtifact,
  ): ProductionOffer | null {
    const offer = this.cache.get(offerId);
    if (!offer) return null;
    offer.artifact = artifact;
    // Artifact persistence is currently local-only. A future
    // version will POST /api/agents/offers/:id/artifact with a
    // signed record so other peers learn about the produced
    // content too.
    return offer;
  }
}

/**
 * Server-side validator helper. Given a signed record, returns true
 * if the signature is valid and the identity key matches the
 * claimed address inside the payload. Thin wrapper around the
 * identity module so the Fastify route has a single import.
 */
export function validateOfferRecord(record: SignedOfferRecord): boolean {
  return verifyOffer(record);
}

export function validateSubscriptionRecord(
  record: SignedSubscriptionRecord,
): boolean {
  return verifySubscription(record);
}
