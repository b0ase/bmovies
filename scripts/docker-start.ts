import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { createServer } from '../src/api/server.js';
import { ingest } from '../src/ingest/index.js';
import { Wallet } from '../src/payment/wallet.js';
import { DEFAULTS } from '../src/types/config.js';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const wif = process.env.BSV_PRIVATE_KEY ?? Wallet.random().privateKey.toWif();
const leecherWif = process.env.BSV_LEECHER_KEY;
const wallet = new Wallet(wif);
const creatorAddress = process.env.CREATOR_ADDRESS ?? wallet.address;
const price = parseInt(process.env.PRICE_PER_PIECE ?? '1', 10);
const port = parseInt(process.env.PORT ?? '8404', 10);
const videoDir = process.env.VIDEO_DIR ?? '/videos';

const dataDir = '/app/data';
await mkdir(dataDir, { recursive: true });

console.log('BitCoinTorrent Server');
console.log('=====================');
console.log(`Mode:    ${leecherWif ? 'LIVE' : 'SIMULATED'}`);
console.log(`Seeder:  ${wallet.address}`);
console.log(`Port:    ${port}`);
console.log(`Videos:  ${videoDir}`);

const server = await createServer({
  privateKeyWif: wif,
  storagePath: dataDir,
  maxStorageBytes: 50 * 1024 * 1024 * 1024,
  defaultSatsPerPiece: price,
  port,
  leecherKeyWif: leecherWif,
  live: !!leecherWif,
});

// Find and ingest all mp4 files in video dir
try {
  const files = await readdir(videoDir);
  const mp4s = files.filter(f => f.endsWith('.mp4')).sort();

  for (const file of mp4s) {
    const videoPath = join(videoDir, file);
    const title = file.replace(/\.mp4$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    console.log(`Ingesting: ${title}...`);
    try {
      const result = await ingest({ videoPath, title, creatorAddress, satsPerPiece: price, outputDir: dataDir });
      const seeded = await server.seeder.seed(result.fmp4Path, result.manifest);
      server.manifests.set(seeded.infohash, { ...result.manifest, infohash: seeded.infohash });
      server.magnetURIs.set(seeded.infohash, seeded.torrent.magnetURI);
      server.fmp4Paths.set(seeded.infohash, result.fmp4Path);
      console.log(`  OK: ${title} — ${result.manifest.totalPieces} pieces`);
    } catch (err) {
      console.error(`  FAIL: ${title} — ${err}`);
    }
  }
} catch {
  console.log(`No video directory at ${videoDir} — start with empty catalog`);
}

await server.start();
console.log(`\nOpen http://localhost:${port}`);
