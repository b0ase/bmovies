/**
 * Live swarm runner.
 *
 * Starts:
 *   - the autonomous agent swarm (producer + financier tick loops)
 *   - the BRC-77 signed registry HTTP routes
 *   - the dashboard HTML + snapshot API
 *   - a streaming loop per funded offer, using the ClawNode-A
 *     seeder wallet as the viewer and the offer's subscribers as
 *     the token-holder set.
 *
 * Every broadcast is a real BSV mainnet transaction.
 *
 * Usage:
 *   pnpm agents:swarm
 *   pnpm agents:swarm -- --pps 5 --sats-per-piece 10 --port 8500
 *
 * Flags:
 *   --pps N              pieces per second per streaming loop (default 5)
 *   --sats-per-piece N   fan-out budget per piece (default 10)
 *   --port N             dashboard http port (default 8500)
 *   --no-stream          run only the agent tick loops, skip streaming
 *   --slots N            pool slot count primed before streaming (default 100)
 *   --sats-per-slot N    sats allocated to each pool slot (default 500)
 *   --prime-txid HEX     prefer this txid's utxo when priming the pool
 *   --inflight N         concurrent broadcasts per loop (default 3)
 *   --max-offers N       max simultaneous open offers per producer (default 5)
 *   --bsvapi URL         enable BSVAPI content generation via this base URL
 *   --bsvapi-image-model M   which BSVAPI image model to use (default z-image/turbo)
 *   --team               dispatch a 4-role agent team (writer/director/storyboard/composer)
 *                        in parallel for every funded offer instead of a single image call
 */

// Load .env.local before any module that might read process.env.
// tsx does not auto-load dotenv files, so SUPABASE_*, PITCH_*, and
// TAAL_ARC_API_KEY would otherwise be undefined here.
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import Fastify from 'fastify';
import { Wallet } from '../src/payment/wallet.js';
import { loadAgentConfig } from '../src/agents/config.js';
import { buildSwarm } from '../src/agents/swarm.js';
import type { Swarm } from '../src/agents/swarm.js';
import type { ProductionOffer } from '../src/agents/registry.js';
import { registerAgentRoutes } from '../src/agents/server-routes.js';
import { registerDashboardRoutes } from '../src/agents/dashboard-routes.js';
import { StreamingLoop } from '../src/agents/streaming-loop.js';
import type { TokenHolderShare } from '../src/agents/piece-payment.js';
import { UtxoPool } from '../src/agents/utxo-pool.js';
import { ArcBroadcaster, type TxBroadcaster } from '../src/payment/broadcaster.js';
import { registryFromEnv, type SupabaseRegistry } from '../src/agents/registry-supabase.js';
import { PitchVerifier } from '../src/agents/pitch-verifier.js';
import { createClient } from '@supabase/supabase-js';

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const piecesPerSecond = Number(flags.pps ?? 5);
  const satsPerPiece = Number(flags['sats-per-piece'] ?? 10);
  const port = Number(flags.port ?? 8500);
  const skipStream = flags['no-stream'] === true;
  const slotCount = Number(flags.slots ?? 100);
  const satsPerSlot = Number(flags['sats-per-slot'] ?? 500);
  const primeTxid =
    typeof flags['prime-txid'] === 'string'
      ? (flags['prime-txid'] as string)
      : undefined;
  const maxInflight = Number(flags.inflight ?? 3);
  const maxOpenOffers = Number(flags['max-offers'] ?? 5);
  const bsvapiBaseUrl =
    typeof flags.bsvapi === 'string' ? (flags.bsvapi as string) : undefined;
  const bsvapiImageModel =
    typeof flags['bsvapi-image-model'] === 'string'
      ? (flags['bsvapi-image-model'] as string)
      : undefined;
  const teamMode = flags.team === true;

  // Piece broadcaster selection.
  //   --arc                          → GorillaPool public ARC (no key needed)
  //   --arc-endpoint URL             → custom ARC endpoint
  //   env TAAL_ARC_API_KEY=mainnet_… → Taal ARC with the key
  //   otherwise                      → WhatsOnChain via viewer.broadcast()
  let pieceBroadcaster: TxBroadcaster | undefined;
  const arcKey = process.env.TAAL_ARC_API_KEY;
  const arcEndpoint =
    typeof flags['arc-endpoint'] === 'string'
      ? (flags['arc-endpoint'] as string)
      : flags.arc === true
        ? 'https://arc.gorillapool.io'
        : undefined;
  if (arcEndpoint) {
    pieceBroadcaster = new ArcBroadcaster({
      endpoint: arcEndpoint,
      apiKey: arcKey,
    });
    console.log(
      `Piece broadcaster: ARC at ${arcEndpoint}` +
        (arcKey ? ` (key: ${arcKey.slice(0, 12)}...)` : ' (anonymous)'),
    );
  } else if (arcKey && arcKey.length > 0) {
    pieceBroadcaster = new ArcBroadcaster({
      endpoint: 'https://api.taal.com/arc',
      apiKey: arcKey,
    });
    console.log(`Piece broadcaster: Taal ARC (key: ${arcKey.slice(0, 12)}...)`);
  } else {
    console.log('Piece broadcaster: WhatsOnChain (default; pass --arc for GorillaPool)');
  }

  // Registry selection: prefer Supabase when SUPABASE_URL +
  // SUPABASE_SERVICE_ROLE_KEY are set in the env. Falls back to
  // the in-memory MemoryRegistry that buildSwarm creates by default
  // when the env is missing.
  let persistentRegistry: SupabaseRegistry | null = null;
  const supaRegistry = registryFromEnv();
  if (supaRegistry) {
    persistentRegistry = supaRegistry;
    await persistentRegistry.start();
    console.log('Registry: Supabase (persistent)');
  } else {
    console.log('Registry: in-memory (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to persist)');
  }

  const config = await loadAgentConfig();
  if (!config) {
    console.error(
      'No config/agents.json found. Run `pnpm agents:setup` first.',
    );
    process.exit(1);
  }

  // Find the viewer wallet (ClawNode-A seeder) — it drives the
  // per-piece fan-out. If missing, streaming is disabled.
  const viewerRec = config.agents.find((a) => a.role === 'seeder');
  if (!viewerRec && !skipStream) {
    console.warn(
      'No seeder in config — streaming loops will not start. ' +
        'Run with --no-stream or add a seeder record.',
    );
  }
  const viewerWallet = viewerRec ? new Wallet(viewerRec.wif) : null;

  // Build the swarm (live on-chain hooks for producer/financier).
  const swarm: Swarm = buildSwarm(config.agents, {
    registry: persistentRegistry ?? undefined,
    tickIntervalMs: 15_000,
    producerBudgetSats: 5_000,
    producerMaxOpenOffers: maxOpenOffers,
    bsvapiBaseUrl,
    bsvapiImageModel,
    bsvapiBroadcaster: pieceBroadcaster,
    teamMode,
    productionIdeas: [
      'Star Wars Episode 1000',
      'The Last Piece',
      'Midnight Swarm',
      'An Agent at Work',
      'Signal Over Noise',
    ],
    financierMaxPositions: 3,
    financierMaxSatsPerOffer: 2_500,
    financierMinOfferBudget: 1_000,
    financierMaxOfferBudget: 50_000,
  });

  // Counters visible on the dashboard
  let pieceTxCount = 0;
  let totalSatsDistributed = 0;
  const activeLoops = new Map<string, StreamingLoop>();
  const counters = {
    getPieceTxCount: () => pieceTxCount,
    getTotalSatsDistributed: () => totalSatsDistributed,
    getActiveStreams: () => activeLoops.size,
  };

  // Shared UTXO pool for the viewer wallet. Primed once up front so
  // the streaming hot loop never has to hit WhatsOnChain for UTXOs
  // or source transactions, and so consecutive piece broadcasts sit
  // on parallel chains rather than one long chain that trips the
  // "too-long-mempool-chain" relay policy.
  let pool: UtxoPool | null = null;
  if (viewerWallet && !skipStream) {
    pool = new UtxoPool({ maxChainDepth: 20, cooldownMs: 12 * 60 * 1000 });
    console.log(
      `Priming UTXO pool: ${slotCount} slots × ${satsPerSlot} sats ` +
        `(${(slotCount * satsPerSlot).toLocaleString()} sats locked in split tx)`,
    );
    try {
      const { splitTxid } = await pool.prime({
        wallet: viewerWallet,
        slotCount,
        satsPerSlot,
        preferTxid: primeTxid,
        broadcaster: pieceBroadcaster,
      });
      console.log(`Pool primed. Split txid: ${splitTxid}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Pool prime failed: ${msg}`);
      console.error('Streaming will be disabled. Fund the seeder or adjust --slots/--sats-per-slot.');
      pool = null;
    }
  }

  // Fastify server hosts registry + dashboard
  const app = Fastify({ logger: false });
  registerAgentRoutes(app, { registry: swarm.registry });
  registerDashboardRoutes(app, { swarm, counters });
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Dashboard live at http://localhost:${port}/agents`);

  swarm.start();
  console.log(`Swarm started with ${swarm.agents.length} agent(s)`);
  if (teamMode) {
    console.log(
      'Team mode ON: every funded offer will dispatch writer + director + storyboard + composer in parallel',
    );
  }

  // Start the pitch verifier when the runner has both Supabase
  // service-role credentials AND a configured pitch receive address.
  // It polls bct_pitches every 30s, verifies payment via WoC, and
  // turns verified pitches into real bct_offers rows that the
  // producer agents pick up automatically on their next tick.
  let pitchVerifier: PitchVerifier | null = null;
  const pitchAddress = process.env.PITCH_RECEIVE_ADDRESS;
  const pitchSupaUrl =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const pitchSupaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (pitchAddress && pitchSupaUrl && pitchSupaKey) {
    const pitchProducerRec = config.agents.find((a) => a.role === 'producer');
    if (!pitchProducerRec) {
      console.warn(
        '[PitchVerifier] no producer in config — visitor pitches will not be picked up',
      );
    } else {
      const supa = createClient(pitchSupaUrl, pitchSupaKey, {
        auth: { persistSession: false },
      });
      pitchVerifier = new PitchVerifier({
        supabase: supa,
        receiveAddress: pitchAddress,
        minSats: Number(process.env.PITCH_MIN_SATS ?? 1000),
        producerAgentId: pitchProducerRec.id,
        producerAddress: new Wallet(pitchProducerRec.wif).address,
      });
      pitchVerifier.start();
      console.log(
        `[PitchVerifier] watching bct_pitches → ${pitchAddress} (min ${process.env.PITCH_MIN_SATS ?? 1000} sats)`,
      );
    }
  } else if (pitchAddress) {
    console.log(
      '[PitchVerifier] PITCH_RECEIVE_ADDRESS set but Supabase env missing; skipping',
    );
  }

  // Watch the registry for newly funded offers and spawn a streaming
  // loop for each. The loop calls the viewer wallet's UTXOs directly
  // via broadcastPiecePayment.
  const spawnStreamFor = (offer: ProductionOffer) => {
    if (!viewerWallet || activeLoops.has(offer.id)) return;
    if (offer.subscribers.length === 0) return;
    if (!pool) {
      // Pool never primed (or prime failed) — streaming is disabled
      return;
    }
    const holders: TokenHolderShare[] = offer.subscribers.map((s) => ({
      address: s.address,
      weight: s.sats,
    }));
    const loop = new StreamingLoop({
      viewer: viewerWallet,
      holders,
      satsPerPiece,
      piecesPerSecond,
      maxInflight,
      pool,
      txBroadcaster: pieceBroadcaster,
      onPiece: (receipt) => {
        pieceTxCount++;
        totalSatsDistributed += receipt.satsPerPiece;
        if (pieceTxCount % 25 === 0) {
          const elapsed = (Date.now() - started) / 1000;
          const rate = pieceTxCount / Math.max(1, elapsed);
          const projected24h = Math.round(rate * 86_400);
          console.log(
            `[STREAM] ${pieceTxCount} TXs broadcast | ${rate.toFixed(2)} TX/s | projected 24h: ${projected24h.toLocaleString()}`,
          );
        }
      },
      onError: (err) => {
        console.error(`[STREAM] broadcast error: ${err.message}`);
      },
    });
    loop.start();
    activeLoops.set(offer.id, loop);
    console.log(
      `[STREAM] Started loop for offer ${offer.id} ${offer.tokenTicker} | ${holders.length} holder(s) | ${piecesPerSecond} pps`,
    );
  };

  const started = Date.now();
  const reaper = setInterval(() => {
    if (skipStream) return;
    for (const offer of swarm.producers.flatMap((p) => p.getMyOffers())) {
      if (offer.status === 'funded' || offer.status === 'producing') {
        spawnStreamFor(offer);
      }
    }
  }, 3_000);

  const shutdown = async () => {
    console.log('\nShutting down swarm...');
    clearInterval(reaper);
    for (const loop of activeLoops.values()) loop.stop();
    swarm.stop();
    pitchVerifier?.stop();
    persistentRegistry?.stop();
    try {
      await app.close();
    } catch {}
    const elapsed = (Date.now() - started) / 1000;
    const rate = pieceTxCount / Math.max(1, elapsed);
    console.log(
      `\nFinal: ${pieceTxCount} TXs in ${elapsed.toFixed(1)}s | ${rate.toFixed(2)} TX/s | ${totalSatsDistributed.toLocaleString()} sats distributed`,
    );
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('run-agent-swarm failed:', err);
  process.exit(1);
});
