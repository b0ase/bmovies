#!/usr/bin/env tsx
/**
 * CLI: Seed a video file.
 *
 * Usage:
 *   pnpm run seed -- <video-path> [--title "My Video"] [--price 1] [--creator <address>]
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
import { join } from 'node:path';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string', short: 't', default: 'Untitled' },
    price: { type: 'string', short: 'p', default: '1' },
    creator: { type: 'string', short: 'c' },
    port: { type: 'string', default: String(DEFAULTS.port) },
  },
});

const videoPath = positionals[0];
if (!videoPath) {
  console.error('Usage: pnpm run seed -- <video-path> [--title "My Video"] [--price 1]');
  process.exit(1);
}

// Generate a random wallet if no key provided
const wif = process.env.BSV_PRIVATE_KEY ?? Wallet.random().privateKey.toWif();
const wallet = new Wallet(wif);
const creatorAddress = values.creator ?? wallet.address;

const dataDir = join(process.cwd(), 'data');
await mkdir(dataDir, { recursive: true });

console.log('BitCoinTorrent Seeder');
console.log('====================');
console.log(`Video:    ${videoPath}`);
console.log(`Title:    ${values.title}`);
console.log(`Price:    ${values.price} sat/piece`);
console.log(`Creator:  ${creatorAddress}`);
console.log(`Seeder:   ${wallet.address}`);
console.log('');

// Ingest
console.log('Ingesting video...');
const result = await ingest({
  videoPath,
  title: values.title!,
  creatorAddress,
  satsPerPiece: parseInt(values.price!, 10),
  outputDir: dataDir,
});

console.log(`Infohash: ${result.infohash}`);
console.log(`Magnet:   ${result.magnetURI}`);
console.log(`Pieces:   ${result.manifest.totalPieces}`);
console.log(`Est cost: ${result.manifest.totalPieces * parseInt(values.price!, 10)} sats`);
console.log('');

// Start server
const server = await createServer({
  privateKeyWif: wif,
  storagePath: dataDir,
  maxStorageBytes: 10 * 1024 * 1024 * 1024,
  defaultSatsPerPiece: parseInt(values.price!, 10),
  port: parseInt(values.port!, 10),
});

// Seed the ingested content — use WebTorrent's infohash (may differ from create-torrent's)
const seeded = await server.seeder.seed(result.fmp4Path, result.manifest);
const liveInfohash = seeded.infohash;
const liveManifest = { ...result.manifest, infohash: liveInfohash };
server.manifests.set(liveInfohash, liveManifest);
server.magnetURIs.set(liveInfohash, seeded.torrent.magnetURI);
server.fmp4Paths.set(liveInfohash, result.fmp4Path);
console.log(`Live infohash: ${liveInfohash}`);

await server.start();
console.log(`Open http://localhost:${values.port} to stream`);
