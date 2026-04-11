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
import { WriterAgent } from './roles/writer.js';
import { DirectorAgent } from './roles/director.js';
import { StoryboardAgent } from './roles/storyboard.js';
import { ComposerAgent } from './roles/composer.js';
import type { RoleAgent, RoleAgentConfig } from './roles/role-agent.js';

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
  /**
   * Offers that have progressed past 'open' — either funded,
   * currently producing (BSVAPI call in flight), or released
   * with an artifact attached. The dashboard uses this to
   * render the "Productions" grid.
   */
  productions: ProductionOffer[];
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
   * content (via AtlasCloud) for every funded offer and
   * attaches the resulting artifact URL to the offer record.
   */
  bsvapiBaseUrl?: string;
  /**
   * BSVAPI image model to use for content generation.
   * Defaults to the cheapest working AtlasCloud model, z-image/turbo
   * ($0.01/image, ~10s sync latency).
   */
  bsvapiImageModel?: string;
  /**
   * When true, the producer's onOfferFunded hook dispatches a
   * full team of role agents (Writer, Director, Storyboard,
   * Composer) in parallel instead of a single generateImage call.
   * Each role makes its own BSVAPI call and attaches its own
   * artifact row. Default false so the proven single-producer path
   * keeps running until the team path has been exercised live.
   */
  teamMode?: boolean;
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
  const bsvapiImageModel = opts.bsvapiImageModel ?? 'z-image/turbo';
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
    // Mirror to stdout so the operator can see mint / subscribe /
    // team dispatch events live. The dashboard JSON snapshot still
    // serves the full ring buffer.
    const tag =
      entry.kind === 'error'
        ? '[SWARM ✗]'
        : entry.kind === 'tx'
          ? '[SWARM ✓]'
          : '[SWARM  ]';
    const txSuffix = entry.txid ? ` tx ${entry.txid.slice(0, 12)}…` : '';
    console.log(`${tag} ${entry.agentId}: ${entry.message}${txSuffix}`);
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
                if (opts.teamMode) {
                  // Team path: dispatch writer/director/storyboard/composer
                  // in parallel. Each role makes its own BSVAPI call and
                  // attaches its own artifact row tagged with its role. A
                  // failed role (e.g. composer when REPLICATE_API_TOKEN is
                  // missing upstream) does not block the others.
                  const roleCfg: RoleAgentConfig = {
                    bsvapiBaseUrl: bsvapiBaseUrl!,
                    broadcaster: bsvapiBroadcaster,
                    registry,
                    budgetSats: Math.floor(offer.requiredSats / 4),
                  };
                  const mkIdentity = (
                    role: 'writer' | 'director' | 'storyboard' | 'composer',
                  ): AgentIdentity => ({
                    id: `${rec.id}-${role}`,
                    name: `${rec.name} (${role})`,
                    role,
                    persona: rec.persona,
                  });
                  const team: RoleAgent[] = [
                    new WriterAgent(mkIdentity('writer'), wallet, roleCfg),
                    new DirectorAgent(mkIdentity('director'), wallet, roleCfg),
                    new StoryboardAgent(
                      mkIdentity('storyboard'),
                      wallet,
                      roleCfg,
                    ),
                    new ComposerAgent(mkIdentity('composer'), wallet, roleCfg),
                  ];
                  // Run roles SEQUENTIALLY, not in parallel. All four
                  // share the producer's wallet — running them in
                  // parallel makes them race for the same UTXO and
                  // ARC rejects 3/4 with DOUBLE_SPEND_ATTEMPTED. The
                  // serialised path is slower (~30s for 4 BSVAPI
                  // round-trips) but each role consumes a UTXO, the
                  // wallet's change output flows into the next role,
                  // and every broadcast is unique.
                  const results: PromiseSettledResult<
                    Awaited<ReturnType<RoleAgent['execute']>>
                  >[] = [];
                  for (const r of team) {
                    try {
                      const value = await r.execute(offer);
                      results.push({ status: 'fulfilled', value });
                    } catch (reason) {
                      results.push({ status: 'rejected', reason });
                    }
                  }
                  let successes = 0;
                  results.forEach((res, i) => {
                    const role = team[i].role;
                    if (res.status === 'fulfilled') {
                      successes++;
                      swarmLog({
                        kind: 'tx',
                        agentId: `${rec.id}-${role}`,
                        message: `Team ${role} delivered ${res.value.kind} for ${offer.id} — ${res.value.url}`,
                        txid: res.value.paymentTxid,
                      });
                    } else {
                      const msg =
                        res.reason instanceof Error
                          ? res.reason.message
                          : String(res.reason);
                      swarmLog({
                        kind: 'error',
                        agentId: `${rec.id}-${role}`,
                        message: `Team ${role} failed for ${offer.id}: ${msg}`,
                      });
                    }
                  });
                  if (successes === 0) {
                    throw new Error(`All team roles failed for ${offer.id}`);
                  }
                  return;
                }

                // Single-producer path (default)
                const client = new BsvapiClient({
                  baseUrl: bsvapiBaseUrl,
                  wallet,
                  broadcaster: bsvapiBroadcaster,
                });
                try {
                  const res = await client.generateImage<{
                    url?: string;
                    output?: string;
                    outputs?: string[];
                  }>({
                    model: bsvapiImageModel,
                    prompt: `${offer.title}. ${offer.synopsis}`,
                  });
                  const url =
                    res.body.url ??
                    res.body.output ??
                    (Array.isArray(res.body.outputs)
                      ? res.body.outputs[0]
                      : undefined) ??
                    '';
                  if (!url) {
                    throw new Error(
                      'BSVAPI response did not include a content URL',
                    );
                  }
                  registry.attachArtifact(offer.id, {
                    kind: 'image',
                    url,
                    model: bsvapiImageModel,
                    prompt: offer.title,
                    paymentTxid: res.paymentTxid,
                    createdAt: Date.now(),
                  });
                  swarmLog({
                    kind: 'tx',
                    agentId: rec.id,
                    message: `Generated image for ${offer.id} via BSVAPI (${bsvapiImageModel}) — ${url}`,
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
      // Aggregate every offer a producer has posted, so the
      // snapshot can report both open offers and in-progress
      // productions. Producers track their own offers locally;
      // the registry listOpenOffers() only exposes 'open' ones.
      const productions: ProductionOffer[] = [];
      for (const p of producers) {
        for (const offer of p.getMyOffers()) {
          if (offer.status !== 'open') productions.push(offer);
        }
      }
      productions.sort((a, b) => b.createdAt - a.createdAt);

      return {
        agents: builtAgents.map((a) => ({
          id: a.identity.id,
          name: a.identity.name,
          role: a.identity.role,
          address: a.address,
          running: a.running,
          logCount: a.logCount,
          // Surface the most recent agent-internal log so the
          // dashboard JSON shows hook errors. Without this, errors
          // captured by agent.record() are invisible to the operator.
          recentLog: a.getLog(10),
        })),
        openOffers: registry.listOpenOffers(),
        productions,
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
