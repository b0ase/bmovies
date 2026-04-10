/**
 * Supabase-backed implementation of AgentRegistry.
 *
 * Replaces the in-memory MemoryRegistry in the live swarm so that
 * offers, subscriptions, and generated artifacts survive runner
 * restarts and can be queried by the public /productions viewer.
 *
 * Reuses the existing self-hosted Supabase on Hetzner (same
 * instance BSVAPI uses). Schema is versioned in
 * supabase/migrations/0001_init.sql; apply via ssh before the
 * runner starts:
 *
 *   ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres" \
 *     < supabase/migrations/0001_init.sql
 *
 * Environment variables expected at construction time:
 *   SUPABASE_URL                  or NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY     (bypasses RLS — we use it because
 *                                  the runner is a trusted backend)
 *
 * This implementation is deliberately synchronous-ish: the
 * AgentRegistry interface returns values immediately, so we keep
 * an in-memory cache of rows and write through to Supabase on
 * every mutation. A background refresh loop rehydrates the cache
 * from the database every N seconds so two runners on the same
 * database eventually converge. Read paths are cache-backed;
 * writes are through-write async fire-and-forget with error
 * logging.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentRegistry,
  NewOffer,
  OfferStatus,
  OfferSubscription,
  ProductionArtifact,
  ProductionOffer,
} from './registry.js';

interface OfferRow {
  id: string;
  producer_id: string;
  producer_address: string;
  title: string;
  synopsis: string;
  required_sats: number;
  raised_sats: number;
  status: OfferStatus;
  token_ticker: string;
  presale_txid: string | null;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  id: number;
  offer_id: string;
  agent_id: string;
  address: string;
  sats: number;
  payment_txid: string | null;
  created_at: string;
}

interface ArtifactRow {
  id: number;
  offer_id: string;
  kind: 'image' | 'video' | 'text' | 'audio';
  url: string;
  model: string;
  prompt: string;
  payment_txid: string;
  created_at: string;
  role: string | null;
}

function rowToOffer(
  row: OfferRow,
  subs: SubscriptionRow[],
  artifact: ArtifactRow | null,
): ProductionOffer {
  return {
    id: row.id,
    producerId: row.producer_id,
    producerAddress: row.producer_address,
    title: row.title,
    synopsis: row.synopsis,
    requiredSats: Number(row.required_sats),
    raisedSats: Number(row.raised_sats),
    status: row.status,
    tokenTicker: row.token_ticker,
    createdAt: new Date(row.created_at).getTime(),
    subscribers: subs.map((s) => ({
      agentId: s.agent_id,
      address: s.address,
      sats: Number(s.sats),
      ts: new Date(s.created_at).getTime(),
    })),
    artifact: artifact
      ? {
          kind: artifact.kind,
          url: artifact.url,
          model: artifact.model,
          prompt: artifact.prompt,
          paymentTxid: artifact.payment_txid,
          createdAt: new Date(artifact.created_at).getTime(),
          role: (artifact.role as ProductionArtifact['role']) ?? undefined,
        }
      : undefined,
  };
}

export interface SupabaseRegistryOptions {
  /** https URL of the Supabase instance */
  url: string;
  /** Service-role key (bypasses RLS) */
  serviceKey: string;
  /** Optional background refresh interval, ms (default 5s) */
  refreshIntervalMs?: number;
}

export class SupabaseRegistry implements AgentRegistry {
  private readonly client: SupabaseClient;
  private readonly refreshInterval: number;
  private readonly cache = new Map<string, ProductionOffer>();
  private refreshHandle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SupabaseRegistryOptions) {
    this.client = createClient(opts.url, opts.serviceKey, {
      auth: { persistSession: false },
    });
    this.refreshInterval = opts.refreshIntervalMs ?? 5_000;
  }

  /**
   * Pull the full offers-subscriptions-artifacts join into the
   * local cache. Called once at startup and periodically by the
   * refresh loop.
   */
  async refresh(): Promise<void> {
    const { data: offerRows, error: offerErr } = await this.client
      .from('bct_offers')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (offerErr) {
      console.error('[SupabaseRegistry] refresh offers failed:', offerErr);
      return;
    }
    const { data: subRows } = await this.client
      .from('bct_subscriptions')
      .select('*');
    const { data: artRows } = await this.client
      .from('bct_artifacts')
      .select('*')
      .order('created_at', { ascending: false });

    const subsByOffer = new Map<string, SubscriptionRow[]>();
    for (const s of (subRows ?? []) as SubscriptionRow[]) {
      const arr = subsByOffer.get(s.offer_id) ?? [];
      arr.push(s);
      subsByOffer.set(s.offer_id, arr);
    }
    // Keep only the most recent artifact per offer
    const artByOffer = new Map<string, ArtifactRow>();
    for (const a of (artRows ?? []) as ArtifactRow[]) {
      if (!artByOffer.has(a.offer_id)) artByOffer.set(a.offer_id, a);
    }

    this.cache.clear();
    for (const row of (offerRows ?? []) as OfferRow[]) {
      this.cache.set(
        row.id,
        rowToOffer(
          row,
          subsByOffer.get(row.id) ?? [],
          artByOffer.get(row.id) ?? null,
        ),
      );
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.refreshHandle) return;
    this.refreshHandle = setInterval(() => {
      this.refresh().catch((err) =>
        console.error('[SupabaseRegistry] refresh error:', err),
      );
    }, this.refreshInterval);
  }

  stop(): void {
    if (this.refreshHandle) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
  }

  // ───── AgentRegistry interface (sync) ─────────────────────────

  postOffer(offer: NewOffer): ProductionOffer {
    const id = `offer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const full: ProductionOffer = {
      id,
      raisedSats: 0,
      subscribers: [],
      status: 'open',
      createdAt: now,
      ...offer,
    };
    this.cache.set(id, full);

    void this.client
      .from('bct_offers')
      .insert({
        id,
        producer_id: offer.producerId,
        producer_address: offer.producerAddress,
        title: offer.title,
        synopsis: offer.synopsis,
        required_sats: offer.requiredSats,
        raised_sats: 0,
        status: 'open',
        token_ticker: offer.tokenTicker,
      })
      .then(({ error }) => {
        if (error)
          console.error('[SupabaseRegistry] insert offer failed:', error);
      });

    return full;
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
    if (offer.status !== 'open') return null;
    if (sub.sats <= 0) return null;
    if (offer.subscribers.some((s) => s.agentId === sub.agentId)) return offer;

    const remaining = offer.requiredSats - offer.raisedSats;
    if (remaining <= 0) return offer;
    const sats = Math.min(sub.sats, remaining);

    offer.subscribers.push({ ...sub, sats, ts: Date.now() });
    offer.raisedSats += sats;
    if (offer.raisedSats >= offer.requiredSats) offer.status = 'funded';

    void this.client
      .from('bct_subscriptions')
      .insert({
        offer_id: offerId,
        agent_id: sub.agentId,
        address: sub.address,
        sats,
      })
      .then(({ error }) => {
        if (error)
          console.error('[SupabaseRegistry] insert subscription failed:', error);
      });
    void this.client
      .from('bct_offers')
      .update({ raised_sats: offer.raisedSats, status: offer.status })
      .eq('id', offerId)
      .then(({ error }) => {
        if (error)
          console.error('[SupabaseRegistry] update offer raised failed:', error);
      });

    return offer;
  }

  updateStatus(offerId: string, status: OfferStatus): ProductionOffer | null {
    const offer = this.cache.get(offerId);
    if (!offer) return null;
    offer.status = status;
    void this.client
      .from('bct_offers')
      .update({ status })
      .eq('id', offerId)
      .then(({ error }) => {
        if (error)
          console.error('[SupabaseRegistry] update status failed:', error);
      });
    return offer;
  }

  attachArtifact(
    offerId: string,
    artifact: ProductionArtifact,
  ): ProductionOffer | null {
    const offer = this.cache.get(offerId);
    if (!offer) return null;
    offer.artifact = artifact;

    void this.client
      .from('bct_artifacts')
      .insert({
        offer_id: offerId,
        kind: artifact.kind,
        url: artifact.url,
        model: artifact.model,
        prompt: artifact.prompt,
        payment_txid: artifact.paymentTxid,
        role: artifact.role ?? null,
      })
      .then(({ error }) => {
        if (error)
          console.error('[SupabaseRegistry] insert artifact failed:', error);
      });
    return offer;
  }
}

/**
 * Build a SupabaseRegistry from environment variables, or return
 * null if the required vars are not set. Lets the runner fall back
 * to MemoryRegistry cleanly when the operator has not configured
 * Supabase.
 */
export function registryFromEnv(): SupabaseRegistry | null {
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !serviceKey) return null;
  return new SupabaseRegistry({ url, serviceKey });
}
