#!/usr/bin/env tsx
/**
 * Seed multiple video files at once.
 *
 * Usage:
 *   npx tsx scripts/seed-multi.ts <video1> <video2> ... [--price 1] [--port 8404]
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { parseArgs } from 'node:util';
import { createServer } from '../src/api/server.js';
import { ingest } from '../src/ingest/index.js';
import { Wallet } from '../src/payment/wallet.js';
import { DEFAULTS } from '../src/types/config.js';
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    price: { type: 'string', short: 'p', default: '1' },
    creator: { type: 'string', short: 'c' },
    port: { type: 'string', default: String(DEFAULTS.port) },
  },
});

// No videos is OK — starts with empty catalog (add via Electron UI or API)

const wif = process.env.BSV_PRIVATE_KEY ?? Wallet.random().privateKey.toWif();
const leecherWif = process.env.BSV_LEECHER_KEY;
const wallet = new Wallet(wif);
const creatorAddress = values.creator ?? wallet.address;
const price = parseInt(values.price!, 10);
const port = parseInt(values.port!, 10);
const isLive = !!leecherWif;

const dataDir = join(process.cwd(), 'data');
await mkdir(dataDir, { recursive: true });

console.log('BitCoinTorrent Multi-Seeder');
console.log('==========================');
console.log(`Mode:    ${isLive ? 'LIVE (real BSV mainnet)' : 'SIMULATED (real crypto, no broadcast)'}`);
console.log(`Seeder:  ${wallet.address}`);
if (isLive) {
  const lw = new Wallet(leecherWif!);
  console.log(`Leecher: ${lw.address}`);
}
console.log(`Price:   ${price} sat/piece`);
console.log(`Videos:  ${positionals.length}`);
console.log('');

const server = await createServer({
  privateKeyWif: wif,
  storagePath: dataDir,
  maxStorageBytes: 10 * 1024 * 1024 * 1024,
  defaultSatsPerPiece: price,
  port,
  leecherKeyWif: leecherWif,
  live: isLive,
});

for (const videoPath of positionals) {
  const title = basename(videoPath, '.mp4')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  console.log(`Ingesting: ${title}...`);
  try {
    const result = await ingest({
      videoPath,
      title,
      creatorAddress,
      satsPerPiece: price,
      outputDir: dataDir,
    });

    const seeded = await server.seeder.seed(result.fmp4Path, result.manifest);
    const liveInfohash = seeded.infohash;
    server.manifests.set(liveInfohash, { ...result.manifest, infohash: liveInfohash });
    server.magnetURIs.set(liveInfohash, seeded.torrent.magnetURI);
    server.fmp4Paths.set(liveInfohash, result.fmp4Path);

    console.log(`  ✓ ${title} — ${result.manifest.totalPieces} pieces, ${result.manifest.totalPieces * price} sats`);
  } catch (err) {
    console.error(`  ✗ ${title} — ${err}`);
  }
}

console.log('');
await server.start();
console.log(`\nOpen http://localhost:${port} to stream ${positionals.length} videos`);
