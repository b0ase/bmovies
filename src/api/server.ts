/**
 * BitCoinTorrent API Server.
 *
 * Fastify server that:
 * - Serves content catalog
 * - Gates streaming via $402 payment required
 * - Exposes seeder status and earnings
 * - Serves the browser player
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { PrivateKey, Transaction, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk';
import { SwarmManager } from '../swarm/swarm-manager.js';
import type { ClientSwarmMessage, ServerSwarmMessage } from '../types/swarm.js';
import { Seeder } from '../seeder/seeder.js';
import { ingest } from '../ingest/index.js';
import { PaymentChannel } from '../payment/channel.js';
import { Wallet } from '../payment/wallet.js';
import { validateSettlementTx } from '../payment/settlement.js';
import { createPaymentGate } from './middleware/payment-gate.js';
import { estimateTotalCost } from '../ingest/manifest.js';
import type { ContentManifest, CatalogEntry } from '../types/torrent.js';
import type { ChannelConfig } from '../types/payment.js';
import type { SeederConfig } from '../types/config.js';
import { DEFAULTS } from '../types/config.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions extends SeederConfig {
  /** Content directory for ingested files */
  contentDir?: string;
  /** Leecher wallet WIF (if set, uses real on-chain funding + settlement) */
  leecherKeyWif?: string;
  /** Use mainnet (true) or simulation mode (false, default) */
  live?: boolean;
}

export async function createServer(opts: ServerOptions) {
  const app = Fastify({ logger: true });
  const seeder = new Seeder(opts);

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Serve index.html at root
  app.get('/', async (_request, reply) => {
    // Resolve index.html — works both in dev (src/api/) and bundled (electron/)
    const candidates = [
      join(__dirname, '..', 'client', 'index.html'),  // dev: src/api/../client/
      join(__dirname, '..', 'src', 'client', 'index.html'),  // bundled: electron/../src/client/
    ];
    let htmlPath = '';
    for (const c of candidates) {
      try { await readFile(c); htmlPath = c; break; } catch {}
    }
    if (!htmlPath) throw new Error('index.html not found');
    const html = await readFile(htmlPath, 'utf-8');
    return reply.type('text/html').send(html);
  });

  // Track manifests, magnet URIs, and file paths
  const manifests = new Map<string, ContentManifest>();
  const magnetURIs = new Map<string, string>();
  const fmp4Paths = new Map<string, string>();

  // Swarm manager for P2P re-seeding payments
  const swarmManager = new SwarmManager(manifests, seeder.wallet.address);
  swarmManager.on('payment', (info: any) => {
    console.log(`[SWARM] Payment: ${info.from.substring(0,8)} → ${info.to.substring(0,8)}, piece ${info.pieceIndex}, ${info.sats} sats`);
  });

  const paymentGate = createPaymentGate({
    getManifest: (hash) => manifests.get(hash),
    getMagnetURI: (hash) => magnetURIs.get(hash),
  });

  // ─── Routes ───────────────────────────────────────────────

  /** POST /api/content — Ingest a video file */
  app.post<{
    Body: {
      videoPath: string;
      title: string;
      creatorAddress: string;
      creatorName?: string;
      satsPerPiece?: number;
    };
  }>('/api/content', async (request, reply) => {
    const { videoPath, title, creatorAddress, creatorName, satsPerPiece } = request.body;

    const result = await ingest({
      videoPath,
      title,
      creatorAddress,
      creatorName,
      satsPerPiece,
      outputDir: opts.contentDir ?? opts.storagePath,
    });

    // Seed it
    const content = await seeder.seed(result.fmp4Path, result.manifest);

    // Store manifest and magnet URI
    manifests.set(content.infohash, content.manifest);
    magnetURIs.set(content.infohash, content.torrent.magnetURI);

    return {
      infohash: content.infohash,
      magnetURI: content.torrent.magnetURI,
      title,
      totalPieces: result.manifest.totalPieces,
      estimatedCost: estimateTotalCost(result.manifest),
    };
  });

  /** GET /api/content/:infohash — Get manifest */
  app.get<{ Params: { infohash: string } }>(
    '/api/content/:infohash',
    async (request, reply) => {
      const manifest = manifests.get(request.params.infohash);
      if (!manifest) return reply.status(404).send({ error: 'Not found' });
      return manifest;
    },
  );

  /** GET /api/stream/:infohash — $402 payment gate */
  app.get<{ Params: { infohash: string } }>(
    '/api/stream/:infohash',
    paymentGate,
  );

  /** GET /api/catalog — List all content */
  app.get('/api/catalog', async () => {
    const entries: CatalogEntry[] = [];
    for (const content of seeder.listContent()) {
      entries.push({
        infohash: content.infohash,
        magnetURI: content.torrent.magnetURI,
        title: content.manifest.title,
        duration: content.manifest.duration,
        satsPerPiece: content.manifest.pricing.satsPerPiece,
        totalCost: estimateTotalCost(content.manifest),
        seeders: content.torrent.numPeers + 1, // +1 for self
        manifest: content.manifest,
      });
    }
    return entries;
  });

  /** GET /api/download/:infohash — Serve fMP4 file (throttled to let P2P compete) */
  app.get<{ Params: { infohash: string } }>(
    '/api/download/:infohash',
    async (request, reply) => {
      const content = seeder.getContent(request.params.infohash);
      if (!content) return reply.status(404).send({ error: 'Not found' });

      const fmp4Path = fmp4Paths.get(request.params.infohash);
      if (!fmp4Path) return reply.status(404).send({ error: 'File not found' });

      const data = await readFile(fmp4Path);

      // Throttle HTTP to ~500KB/s so P2P peers can contribute pieces.
      // On a real network this wouldn't be needed — the CDN is far away
      // and nearby peers are faster. On localhost, HTTP is instant.
      const { Readable } = await import('node:stream');
      const CHUNK = 64 * 1024; // 64KB chunks
      const DELAY = 120;       // ms between chunks (~500KB/s)

      reply.type('video/mp4').header('Accept-Ranges', 'bytes');

      const stream = new Readable({
        read() {},
      });

      let offset = 0;
      const pump = () => {
        if (offset >= data.length) {
          stream.push(null);
          return;
        }
        const end = Math.min(offset + CHUNK, data.length);
        stream.push(data.subarray(offset, end));
        offset = end;
        setTimeout(pump, DELAY);
      };
      pump();

      return reply.send(stream);
    },
  );

  // ─── Payment Channel API ─────────────────────────────────
  // When opts.live=true and leecherKeyWif is set:
  //   - Funding TX uses a real on-chain UTXO
  //   - Settlement broadcasts to BSV mainnet
  // Otherwise: uses simulated funding (still real signed TXs)

  const isLive = !!(opts.live && opts.leecherKeyWif);
  const leecherWallet = opts.leecherKeyWif
    ? new Wallet(opts.leecherKeyWif)
    : Wallet.random();

  if (isLive) {
    console.log(`LIVE MODE — leecher wallet: ${leecherWallet.address}`);
    console.log(`Fund this address with BSV to enable real payments`);
  }

  const sessions = new Map<string, {
    channel: PaymentChannel;
    wallet: Wallet;
    fundingTx: Transaction;
    infohash: string;
    live: boolean;
    fundingBroadcast: boolean;
    payments: Array<{ piece: number; seq: number; txid: string; creatorSats: number; seederSats: number; txHex: string }>;
  }>();

  /** POST /api/channel/open — Open a payment channel */
  app.post<{
    Body: { infohash: string };
  }>('/api/channel/open', async (request) => {
    const { infohash } = request.body;
    const manifest = manifests.get(infohash);
    if (!manifest) throw { statusCode: 404, message: 'Content not found' };

    const totalPieces = manifest.totalPieces;
    const satsPerPiece = manifest.pricing.satsPerPiece;
    const fundingAmount = totalPieces * satsPerPiece + 200; // + miner fee

    let fundingTx: Transaction;
    let fundingBroadcast = false;

    if (isLive) {
      // LIVE: Build funding TX from real UTXOs
      console.log(`[LIVE] Building funding TX: ${fundingAmount} sats`);
      fundingTx = await leecherWallet.buildFundingTx(fundingAmount);
      // Broadcast the funding TX to mainnet
      const broadcastResult = await leecherWallet.broadcast(fundingTx);
      if (!broadcastResult.success) {
        throw { statusCode: 500, message: `Funding broadcast failed: ${broadcastResult.error}` };
      }
      console.log(`[LIVE] Funding TX broadcast: ${broadcastResult.txid}`);
      fundingBroadcast = true;
    } else {
      // SIMULATED: Build mock funding TX (still real crypto, just no on-chain UTXO)
      const sourceTx = new Transaction();
      sourceTx.addOutput({
        lockingScript: new P2PKH().lock(leecherWallet.address),
        satoshis: fundingAmount + 1000,
      });
      fundingTx = new Transaction();
      fundingTx.addInput({
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(leecherWallet.privateKey),
        sequence: 0xffffffff,
      });
      fundingTx.addOutput({
        lockingScript: new P2PKH().lock(leecherWallet.address),
        satoshis: fundingAmount,
      });
      await fundingTx.fee(new SatoshisPerKilobyte(1));
      await fundingTx.sign();
    }

    const fundingTxid = fundingTx.id('hex');

    const config: ChannelConfig = {
      fundingAmount,
      satsPerPiece,
      seederAddress: seeder.wallet.address,
      creatorAddress: manifest.creator.address,
      creatorSplitBps: manifest.creator.splitBps,
      timeoutBlockHeight: 900_000,
    };

    const channel = new PaymentChannel(config);
    channel.fund(fundingTxid, 0, fundingTx);

    const sessionId = channel.channelId;
    sessions.set(sessionId, {
      channel,
      wallet: leecherWallet,
      fundingTx,
      infohash,
      live: isLive,
      fundingBroadcast,
      payments: [],
    });

    return {
      sessionId,
      channelId: channel.channelId,
      fundingTxid,
      fundingAmount,
      maxPieces: channel.maxPieces,
      satsPerPiece,
      leecherAddress: leecherWallet.address,
      seederAddress: seeder.wallet.address,
      creatorAddress: manifest.creator.address,
      creatorSplitBps: manifest.creator.splitBps,
      live: isLive,
      fundingBroadcast,
    };
  });

  /** POST /api/channel/pay — Pay for a piece (creates real signed BSV tx) */
  app.post<{
    Body: { sessionId: string; pieceIndex: number };
  }>('/api/channel/pay', async (request) => {
    const { sessionId, pieceIndex } = request.body;
    const session = sessions.get(sessionId);
    if (!session) throw { statusCode: 404, message: 'Session not found' };

    const { channel, wallet } = session;

    // Create REAL signed payment transaction
    const update = await channel.createPayment(pieceIndex, wallet);

    // Validate the tx we just created
    const validation = validateSettlementTx(
      update.signedTxHex,
      update.creatorAmount,
      update.seederAmount,
    );

    const txid = Transaction.fromHex(update.signedTxHex).id('hex');

    session.payments.push({
      piece: pieceIndex,
      seq: update.sequenceNumber,
      txid,
      creatorSats: update.creatorAmount,
      seederSats: update.seederAmount,
      txHex: update.signedTxHex,
    });

    return {
      pieceIndex,
      sequenceNumber: update.sequenceNumber,
      creatorAmount: update.creatorAmount,
      seederAmount: update.seederAmount,
      leecherChange: update.leecherChange,
      txid,
      txHex: update.signedTxHex,
      txValid: validation.valid,
      totalPaidPieces: channel.totalPaidPieces,
      remainingPieces: channel.remainingPieces,
    };
  });

  /** POST /api/channel/close — Settle the channel (broadcasts in live mode) */
  app.post<{
    Body: { sessionId: string };
  }>('/api/channel/close', async (request) => {
    const { sessionId } = request.body;
    const session = sessions.get(sessionId);
    if (!session) throw { statusCode: 404, message: 'Session not found' };

    const { channel } = session;
    const settlementHex = channel.getSettlementTx();
    const settlementTx = Transaction.fromHex(settlementHex);
    const localTxid = settlementTx.id('hex');

    let broadcastTxid = localTxid;
    let broadcastSuccess = false;
    let broadcastError = '';

    // In live mode, broadcast the settlement TX to mainnet
    if (session.live) {
      console.log(`[LIVE] Broadcasting settlement TX...`);
      const result = await leecherWallet.broadcast(settlementTx);
      broadcastTxid = result.txid || localTxid;
      broadcastSuccess = result.success;
      broadcastError = result.error ?? '';
      if (result.success) {
        console.log(`[LIVE] Settlement broadcast: ${result.txid}`);
        console.log(`[LIVE] https://whatsonchain.com/tx/${result.txid}`);
      } else {
        console.error(`[LIVE] Settlement broadcast failed: ${result.error}`);
      }
    }

    channel.close();

    return {
      settled: true,
      live: session.live,
      channelId: channel.channelId,
      totalPieces: channel.totalPaidPieces,
      settlementTxid: broadcastTxid,
      settlementTxHex: settlementHex,
      broadcast: session.live ? { success: broadcastSuccess, error: broadcastError } : null,
      wocUrl: session.live && broadcastSuccess
        ? `https://whatsonchain.com/tx/${broadcastTxid}`
        : null,
      outputs: settlementTx.outputs.map((o, i) => ({
        index: i,
        satoshis: o.satoshis,
        scriptHex: Buffer.from(o.lockingScript.toBinary()).toString('hex').substring(0, 50) + '...',
      })),
      totalCreator: channel.creatorAmount,
      totalSeeder: channel.seederAmount,
      paymentCount: session.payments.length,
    };
  });

  /** GET /api/channel/:sessionId — Get channel state */
  app.get<{ Params: { sessionId: string } }>(
    '/api/channel/:sessionId',
    async (request) => {
      const session = sessions.get(request.params.sessionId);
      if (!session) throw { statusCode: 404, message: 'Session not found' };
      return {
        ...session.channel.toRecord(),
        payments: session.payments,
      };
    },
  );

  // ─── P2P Swarm WebSocket + HTTP ──────────────────────────

  /** WebSocket: /api/swarm/ws — real-time browser↔server swarm coordination */
  app.get('/api/swarm/ws', { websocket: true }, (socket, req) => {
    let peerId: string | null = null;

    socket.on('message', async (raw: Buffer) => {
      let msg: ClientSwarmMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      const sendMsg = (m: ServerSwarmMessage) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(m));
      };

      switch (msg.type) {
        case 'register': {
          const peer = swarmManager.registerPeer(msg.infohash, sendMsg);
          peerId = peer.peerId;
          sendMsg({ type: 'registered', peerId: peer.peerId, walletAddress: peer.walletAddress });
          console.log(`[SWARM] Peer ${peerId.substring(0,8)} registered for ${msg.infohash.substring(0,8)}`);
          break;
        }
        case 'piece_downloaded': {
          if (!peerId) break;
          // Map wire peerId if we see a new one
          if (msg.fromPeerId) {
            // Try to find which internal peer this wire belongs to
            // For now, store the mapping (browser will send its own wirePeerId on register)
          }
          await swarmManager.handlePieceDownload(peerId, msg.pieceIndex, msg.fromPeerId, msg.bytes);
          break;
        }
        case 'piece_uploaded': {
          if (!peerId) break;
          swarmManager.handlePieceUpload(peerId, msg.pieceIndex, msg.toPeerId, msg.bytes);
          break;
        }
      }
    });

    socket.on('close', () => {
      if (peerId) {
        console.log(`[SWARM] Peer ${peerId.substring(0,8)} disconnected`);
        swarmManager.disconnectPeer(peerId);
      }
    });
  });

  /** GET /api/swarm/status — Current swarm state */
  app.get('/api/swarm/status', async () => {
    return swarmManager.getStatus();
  });

  /** GET /api/swarm/peers — List connected peers with earnings */
  app.get('/api/swarm/peers', async () => {
    return swarmManager.getStatus().peers;
  });

  /** GET /api/wallet — Leecher wallet info + balance */
  app.get('/api/wallet', async () => {
    let balance = 0;
    let utxoCount = 0;
    if (isLive) {
      try {
        const utxos = await leecherWallet.fetchUtxos();
        balance = utxos.reduce((sum, u) => sum + u.satoshis, 0);
        utxoCount = utxos.length;
      } catch { /* wallet may be empty */ }
    }
    return {
      address: leecherWallet.address,
      live: isLive,
      balance,
      utxoCount,
      seederAddress: seeder.wallet.address,
    };
  });

  /** GET /api/status — Seeder status */
  app.get('/api/status', async () => {
    return seeder.getStatus();
  });

  /** GET /api/earnings — Revenue breakdown */
  app.get('/api/earnings', async () => {
    return seeder.economics.getAllEarnings();
  });

  // ─── Lifecycle ────────────────────────────────────────────

  const start = async () => {
    await app.listen({ port: opts.port, host: '0.0.0.0' });
    console.log(`BitCoinTorrent seeder running on port ${opts.port}`);
    console.log(`Seeder address: ${seeder.wallet.address}`);
  };

  const stop = async () => {
    await seeder.destroy();
    await app.close();
  };

  return { app, seeder, swarmManager, start, stop, manifests, magnetURIs, fmp4Paths };
}

// CLI entry point (only when running this file directly, not when bundled/imported)
if (process.argv[1]?.endsWith('server.ts') && import.meta.url.includes('api/server')) {
  (async () => {
    const wif = process.env.BSV_PRIVATE_KEY;
    if (!wif) {
      console.error('Set BSV_PRIVATE_KEY env var (WIF format)');
      process.exit(1);
    }

    const srv = await createServer({
      privateKeyWif: wif,
      storagePath: './data',
      maxStorageBytes: 10 * 1024 * 1024 * 1024,
      defaultSatsPerPiece: DEFAULTS.satsPerPiece,
      port: DEFAULTS.port,
    });

    await srv.start();
  })();
}
