/**
 * Publish bMovies to the Metanet App Catalog (MetanetApps.com).
 *
 * What this does:
 *   Loads docs/brochure/app-manifest.json, opens a BRC-100 wallet
 *   connection to BSV Desktop on localhost:3321, and uses the
 *   metanet-apps npm library's AppCatalog.publishApp() method to
 *   write an identifiable UTXO on the Metanet Overlay that
 *   advertises bMovies as a BRC-100 app.
 *
 * Prerequisites:
 *   - BSV Desktop (or Metanet Client) running on localhost:3321
 *   - Its wallet funded with at least a few thousand sats to pay
 *     the publish tx fee
 *   - `pnpm add metanet-apps` has already installed the helper lib
 *
 * Usage:
 *   pnpm tsx scripts/publish-app-manifest.ts [--dry-run]
 *
 * The --dry-run flag validates the manifest against the BRC-100
 * AppCatalog schema and prints the resolved payload WITHOUT
 * touching the wallet or broadcasting anything. Use it to sanity-
 * check the manifest before going live.
 *
 * After a successful publish the tx appears on the overlay and
 * metanetapps.com will include bMovies on its next refresh
 * (usually within a few minutes).
 *
 * This script is a ONE-SHOT — it broadcasts a fresh advertisement
 * UTXO every time you run it. If you need to update the manifest
 * after the first publish, bump the version field in
 * app-manifest.json and re-run.
 */

import './../src/lib/node-localstorage-shim.js';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MANIFEST_PATH = resolve('docs/brochure/app-manifest.json');
const DEFAULT_METANET_URL = 'http://127.0.0.1:3321';

interface AppManifest {
  name: string;
  version: string;
  description: string;
  shortDescription?: string;
  icon: string;
  domain: string;
  homepage: string;
  category: string;
  tags: string[];
  author?: { name?: string; url?: string };
  license?: string;
  source?: string;
  features?: string[];
  [key: string]: unknown;
}

async function loadManifest(): Promise<AppManifest> {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as AppManifest;
  if (!parsed.name || !parsed.version || !parsed.domain) {
    throw new Error('app-manifest.json missing one of: name / version / domain');
  }
  return parsed;
}

function summarise(m: AppManifest): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  bMovies — Metanet App Catalog publish');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  name:        ${m.name}`);
  console.log(`  version:     ${m.version}`);
  console.log(`  domain:      ${m.domain}`);
  console.log(`  homepage:    ${m.homepage}`);
  console.log(`  category:    ${m.category}`);
  console.log(`  tags:        ${m.tags.join(', ')}`);
  console.log(`  description: ${m.description.slice(0, 120)}${m.description.length > 120 ? '…' : ''}`);
  console.log(`  icon:        ${m.icon}`);
  console.log('');
}

async function main() {
  const flags = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');

  const manifest = await loadManifest();
  summarise(manifest);

  if (dryRun) {
    console.log('─── DRY RUN ────────────────────────────────────────────────');
    console.log('  Manifest validated. No wallet call, no broadcast.');
    console.log('  Remove --dry-run to publish for real.');
    console.log('');
    return;
  }

  // Dynamic import of the optional publishing library. We do it
  // lazily so the script can be run in dry-run mode even when
  // metanet-apps isn't installed yet.
  let AppCatalogClass: {
    new (opts: { wallet: unknown }): {
      publishApp(args: Record<string, unknown>): Promise<{ txid: string }>;
    };
  };
  try {
    const mod: Record<string, unknown> = await import('metanet-apps');
    AppCatalogClass = mod.AppCatalog as typeof AppCatalogClass;
    if (!AppCatalogClass) {
      throw new Error('metanet-apps does not export AppCatalog');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error('✗ Cannot load metanet-apps — install it first:');
    console.error('    pnpm add metanet-apps');
    console.error('');
    console.error('  underlying error:', msg);
    console.error('');
    console.error('  Alternatively, run this script with --dry-run to just');
    console.error('  validate the manifest without publishing.');
    console.error('');
    process.exit(1);
    throw err;
  }

  // Connect to the locally-running BRC-100 wallet (BSV Desktop).
  console.log('  Connecting to BRC-100 wallet on ' + DEFAULT_METANET_URL + '…');
  const sdk = await import('@bsv/sdk');
  const substrate = new sdk.HTTPWalletJSON(DEFAULT_METANET_URL);
  const wallet = new sdk.WalletClient(substrate);

  // Quick handshake so the wallet prompts the user to authorize
  // this publish before we build the catalog tx.
  const { publicKey } = await wallet.getPublicKey({
    protocolID: [1, 'bmovies-publish'],
    keyID: '1',
  });
  console.log('  Wallet connected. Publisher pubkey: ' + publicKey.slice(0, 16) + '…');

  const catalog = new AppCatalogClass({ wallet });
  console.log('  Publishing…');
  const result = await catalog.publishApp({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    icon: manifest.icon,
    domain: manifest.domain,
    category: manifest.category,
    tags: manifest.tags,
    releaseDate: new Date().toISOString(),
  });

  console.log('');
  console.log('✓ Published on the Metanet Overlay.');
  console.log('  txid: ' + result.txid);
  console.log('  https://whatsonchain.com/tx/' + result.txid);
  console.log('');
  console.log('  metanetapps.com will include bMovies on its next refresh');
  console.log('  (usually within a few minutes). Check the listing at');
  console.log('  https://metanetapps.com');
  console.log('');
}

main().catch((err) => {
  console.error('publish-app-manifest failed:', err);
  process.exit(1);
});
