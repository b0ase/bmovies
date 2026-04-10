/**
 * Live swarm coordinator.
 *
 * Reads config/agents.json, instantiates Wallet + Agent pairs for
 * every record, and wires them together with a shared MemoryRegistry
 * (extensible to HttpRegistryClient for distributed runs). Plugs in
 * the on-chain presale mint and subscription broadcast hooks so the
 * producer and financier tick loops translate registry-level actions
 * into real BSV mainnet transactions.
 *
 * This is the entry point for `pnpm agents:swarm` and for the live
 * integration demo that ships with the BSVA hackathon submission.
 */

import { Wallet } from '../payment/wallet.js';
import { Agent, type AgentIdentity } from './agent.js';
import { ProducerAgent } from './producer.js';
import { FinancierAgent } from './financier.js';
import { MemoryRegistry } from './registry.js';
import type { AgentRegistry, ProductionOffer } from './registry.js';
import { loadAgentConfig, type AgentConfigRecord } from './config.js';
import { mintPresaleOnChain, type PresaleToken } from '../token/presale.js';
import { subscribeOnChain, type SubscriptionReceipt } from './subscribe.js';
import { BsvapiClient } from './bsvapi-client.js';
import type { TxBroadcaster } from '../payment/broadcaster.js';

export interface SwarmLogEntry {
  ts: number;
  kind: 'tx' | 'event' | 'error';
  agentId: string;
  message: string;
  txid?: string;
}

export interface Swarm {
  registry: AgentRegistry;
  agents: Agent[];
  producers: ProducerAgent[];
  financiers: FinancierAgent[];
  /** All presale tokens minted so far, keyed by offerId */
  presales: Map<string, PresaleToken>;
  /** All subscription broadcasts so far */
  subscriptions: SubscriptionReceipt[];
  /** Running log of cross-agent swarm events */
  log: SwarmLogEntry[];
  start(): void;
  stop(): void;
  snapshot(): SwarmSnapshot;
}

export interface SwarmSnapshot {
  agents: Array<{
    id: string;
    name: string;
    role: string;
    address: string;
    running: boolean;
    logCount: number;
  }>;
  openOffers: ProductionOffer[];
  presaleCount: number;
  subscriptionCount: number;
  recentLog: SwarmLogEntry[];
}

export interface BuildSwarmOptions {
  /** Registry implementation; defaults to in-process MemoryRegistry */
  registry?: AgentRegistry;
  /**
   * When true (default), the producer's onOfferPosted hook calls
   * mintPresaleOnChain and the financier's onSubscribed hook calls
   * subscribeOnChain — both hit BSV mainnet. Unit tests pass
   * live=false so the hooks are omitted and no network traffic is
   * generated; in production the live swarm always runs with live=true.
   */
  live?: boolean;
  /**
   * Optional BSVAPI base URL. When set AND live is true, the
   * producer's onOfferFunded hook calls BSVAPI to generate real
   * content (via Grok/Atlas/etc) for every funded offer and
   * attaches the resulting artifact URL to the offer record.
   */
  bsvapiBaseUrl?: string;
  /** BSVAPI model to use for content generation (defaults to "wan-2.1") */
  bsvapiVideoModel?: string;
  /**
   * Optional broadcaster for BSVAPI payment txs. Typically the same
   * ArcBroadcaster used by the streaming loop.
   */
  bsvapiBroadcaster?: TxBroadcaster;
  /** Tick interval in ms for every agent in the swarm */
  tickIntervalMs: number;
  /** Per-producer budget in sats */
  producerBudgetSats: number;
  /** Max concurrent open offers per producer */
  producerMaxOpenOffers: number;
  /** Pool of production titles producers cycle through */
  productionIdeas: string[];
  /** Max concurrent positions per financier */
  financierMaxPositions: number;
  /** Per-financier sats deployed per subscription */
  financierMaxSatsPerOffer: number;
  financierMinOfferBudget: number;
  financierMaxOfferBudget: number;
}

/**
 * Build a Swarm from a set of loaded agent config records.
 * Exposed as a pure function (no file I/O) so tests can pass
 * in-memory configs and verify wiring without touching disk or
 * the network.
 */
export function buildSwarm(
  agents: AgentConfigRecord[],
  opts: BuildSwarmOptions,
): Swarm {
  const registry = opts.registry ?? new MemoryRegistry();
  const live = opts.live ?? true;
  const bsvapiBaseUrl = opts.bsvapiBaseUrl;
  const bsvapiVideoModel = opts.bsvapiVideoModel ?? 'wan-2.1';
  const bsvapiBroadcaster = opts.bsvapiBroadcaster;
  const presales = new Map<string, PresaleToken>();
  const subscriptions: SubscriptionReceipt[] = [];
  const log: SwarmLogEntry[] = [];
  const builtAgents: Agent[] = [];
  const producers: ProducerAgent[] = [];
  const financiers: FinancierAgent[] = [];

  function swarmLog(entry: Omit<SwarmLogEntry, 'ts'>): void {
    log.push({ ts: Date.now(), ...entry });
    if (log.length > 1000) log.splice(0, log.length - 1000);
  }

  for (const rec of agents) {
    const wallet = new Wallet(rec.wif);
    const identity: AgentIdentity = {
      id: rec.id,
      name: rec.name,
      role: rec.role,
      persona: rec.persona,
    };

    if (rec.role === 'producer') {
      const agent = new ProducerAgent(identity, wallet, {
        registry,
        budgetSats: opts.producerBudgetSats,
        maxOpenOffers: opts.producerMaxOpenOffers,
        productionIdeas: opts.productionIdeas,
        onOfferFunded:
          live && bsvapiBaseUrl
            ? async (offer) => {
                const client = new BsvapiClient({
                  baseUrl: bsvapiBaseUrl,
                  wallet,
                  broadcaster: bsvapiBroadcaster,
                });
                try {
                  const res = await client.generateVideo<{
                    url?: string;
                    video_url?: string;
                    output?: string;
                  }>({
                    model: bsvapiVideoModel,
                    prompt: `${offer.title}. ${offer.synopsis}`,
                    duration_seconds: 4,
                    aspect_ratio: '16:9',
                  });
                  const url =
                    res.body.url ??
                    res.body.video_url ??
                    res.body.output ??
                    '';
                  if (!url) {
                    throw new Error(
                      'BSVAPI response did not include a content URL',
                    );
                  }
                  registry.attachArtifact(offer.id, {
                    kind: 'video',
                    url,
                    model: bsvapiVideoModel,
                    prompt: offer.title,
                    paymentTxid: res.paymentTxid,
                    createdAt: Date.now(),
                  });
                  swarmLog({
                    kind: 'tx',
                    agentId: rec.id,
                    message: `Generated video for ${offer.id} via BSVAPI (${bsvapiVideoModel}) — ${url}`,
                    txid: res.paymentTxid,
                  });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  swarmLog({
                    kind: 'error',
                    agentId: rec.id,
                    message: `BSVAPI content generation failed for ${offer.id}: ${msg}`,
                  });
                  throw err;
                }
              }
            : undefined,
        onOfferPosted: live
          ? async (offer) => {
              try {
                const token = await mintPresaleOnChain(offer, wallet);
                presales.set(offer.id, token);
                swarmLog({
                  kind: 'tx',
                  agentId: rec.id,
                  message: `Minted presale token ${token.ticker} for ${offer.id}`,
                  txid: token.deployTxid,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                swarmLog({
                  kind: 'error',
                  agentId: rec.id,
                  message: `Presale mint failed for ${offer.id}: ${msg}`,
                });
                throw err;
              }
            }
          : undefined,
      });
      builtAgents.push(agent);
      producers.push(agent);
    } else if (rec.role === 'financier') {
      const agent = new FinancierAgent(identity, wallet, {
        registry,
        thesis: {
          maxSatsPerOffer: opts.financierMaxSatsPerOffer,
          minOfferBudget: opts.financierMinOfferBudget,
          maxOfferBudget: opts.financierMaxOfferBudget,
          preferredProducers: [],
        },
        maxPositions: opts.financierMaxPositions,
        onSubscribed: live
          ? async (offer, sats) => {
              try {
                const receipt = await subscribeOnChain(wallet, offer, sats);
                subscriptions.push(receipt);
                swarmLog({
                  kind: 'tx',
                  agentId: rec.id,
                  message: `Subscribed to ${offer.id} with ${sats} sats (on-chain)`,
                  txid: receipt.txid,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                swarmLog({
                  kind: 'error',
                  agentId: rec.id,
                  message: `Subscription broadcast failed for ${offer.id}: ${msg}`,
                });
                throw err;
              }
            }
          : undefined,
      });
      builtAgents.push(agent);
      financiers.push(agent);
    } else {
      // Seeder / compute roles are handled in tasks 5 and 6.
      swarmLog({
        kind: 'event',
        agentId: rec.id,
        message: `Agent ${rec.id} role "${rec.role}" is not handled by the presale swarm yet`,
      });
    }
  }

  return {
    registry,
    agents: builtAgents,
    producers,
    financiers,
    presales,
    subscriptions,
    log,
    start() {
      for (const a of builtAgents) a.start(opts.tickIntervalMs);
      swarmLog({
        kind: 'event',
        agentId: 'swarm',
        message: `Swarm started with ${builtAgents.length} agent(s)`,
      });
    },
    stop() {
      for (const a of builtAgents) a.stop();
      swarmLog({
        kind: 'event',
        agentId: 'swarm',
        message: 'Swarm stopped',
      });
    },
    snapshot() {
      return {
        agents: builtAgents.map((a) => ({
          id: a.identity.id,
          name: a.identity.name,
          role: a.identity.role,
          address: a.address,
          running: a.running,
          logCount: a.logCount,
        })),
        openOffers: registry.listOpenOffers(),
        presaleCount: presales.size,
        subscriptionCount: subscriptions.length,
        recentLog: log.slice(-20).reverse(),
      };
    },
  };
}

/**
 * Convenience wrapper: load config/agents.json and build a live
 * swarm using the default production parameters. Used by the
 * scripts/run-agent-swarm.ts entry point.
 */
export async function loadLiveSwarm(
  opts: Partial<BuildSwarmOptions> = {},
): Promise<Swarm> {
  const config = await loadAgentConfig();
  if (!config) {
    throw new Error(
      'No config/agents.json found. Run `pnpm agents:setup` first.',
    );
  }
  const defaults: BuildSwarmOptions = {
    tickIntervalMs: 10_000,
    producerBudgetSats: 20_000,
    producerMaxOpenOffers: 1,
    productionIdeas: [
      'Star Wars Episode 1000',
      'The Last Piece',
      'Midnight Swarm',
      'An Agent at Work',
      'Signal Over Noise',
    ],
    financierMaxPositions: 5,
    financierMaxSatsPerOffer: 10_000,
    financierMinOfferBudget: 5_000,
    financierMaxOfferBudget: 100_000,
  };
  return buildSwarm(config.agents, { ...defaults, ...opts });
}
