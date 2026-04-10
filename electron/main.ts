/**
 * bMovies — Electron Main Process
 *
 * Runs the seeder, payment channels, and API server in the background.
 * System tray shows earnings. Window shows the catalog + player UI.
 */

import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, mkdir, readFile, writeFile, access, stat } from 'node:fs/promises';
import { createServer, type ServerOptions } from '../src/api/server.js';
import { ingest } from '../src/ingest/index.js';
import { Wallet } from '../src/payment/wallet.js';
import { mintContentToken } from '../src/token/mint.js';
import type { ContentToken } from '../src/token/types.js';
import { DEFAULTS } from '../src/types/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Config ─────────────────────────────────────────────
const CONFIG_PATH = join(app.getPath('userData'), 'config.json');
const DATA_DIR = join(app.getPath('userData'), 'data');
const PORT = 8404;

interface AppConfig {
  seederWif: string;
  leecherWif: string;
  contentFolders: string[];
  pricePerPiece: number;
  /** Minted content tokens: infohash → token */
  tokens?: Record<string, ContentToken>;
}

async function loadConfig(): Promise<AppConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveConfig(config: AppConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── App State ──────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: Awaited<ReturnType<typeof createServer>> | null = null;
let config: AppConfig | null = null;

// ─── Window ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'bMovies',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load the web UI from the local Fastify server
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of quitting
    e.preventDefault();
    mainWindow?.hide();
  });
}

// ─── System Tray ────────────────────────────────────────
function createTray() {
  // Simple tray icon (1x1 orange pixel as placeholder)
  const icon = nativeImage.createFromBuffer(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAH0lEQVQ4y2P4z8DwHwMNMIwaMGrAqAGjBgyrMAAAZI8F/wse0RcAAAAASUVORK5CYII=', 'base64'),
    { width: 16, height: 16 },
  );

  tray = new Tray(icon);
  tray.setToolTip('bMovies — Seeding');

  updateTrayMenu();

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const status = server?.seeder?.getStatus();
  const earnings = status?.economics?.totalSeederEarnings ?? 0;
  const content = status?.seededContent ?? 0;
  const peers = status?.totalPeers ?? 0;

  const menu = Menu.buildFromTemplate([
    { label: `bMovies`, enabled: false },
    { type: 'separator' },
    { label: `Seeding: ${content} video(s)`, enabled: false },
    { label: `Peers: ${peers}`, enabled: false },
    { label: `Earned: ${earnings} sats`, enabled: false },
    { type: 'separator' },
    { label: 'Open Window', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Add Videos...', click: addVideos },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]);

  tray.setContextMenu(menu);
}

// Update tray every 10s
setInterval(updateTrayMenu, 10_000);

// ─── Add Videos ─────────────────────────────────────────
async function addVideos() {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'avi'] }],
  });

  if (result.canceled || !result.filePaths.length) return;
  if (!server || !config) return;

  for (const videoPath of result.filePaths) {
    const title = videoPath
      .split('/').pop()!
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    console.log(`[APP] Ingesting: ${title}`);
    try {
      const ingestResult = await ingest({
        videoPath,
        title,
        creatorAddress: new Wallet(config.seederWif).address,
        satsPerPiece: config.pricePerPiece,
        outputDir: DATA_DIR,
      });

      const seeded = await server.seeder.seed(ingestResult.fmp4Path, ingestResult.manifest);
      server.manifests.set(seeded.infohash, { ...ingestResult.manifest, infohash: seeded.infohash });
      server.magnetURIs.set(seeded.infohash, seeded.torrent.magnetURI);
      server.fmp4Paths.set(seeded.infohash, ingestResult.fmp4Path);
      console.log(`[APP] Seeding: ${title} (${ingestResult.manifest.totalPieces} pieces)`);
    } catch (err) {
      console.error(`[APP] Failed: ${title}`, err);
    }
  }

  updateTrayMenu();
  // Reload the renderer to show new content
  mainWindow?.webContents.reload();
}

// ─── IPC Handlers ───────────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-config', () => {
    if (!config) return null;
    // Return config with addresses (never expose WIFs to renderer)
    return {
      seederAddress: new Wallet(config.seederWif).address,
      leecherAddress: new Wallet(config.leecherWif).address,
      contentFolders: config.contentFolders,
      pricePerPiece: config.pricePerPiece,
    };
  });
  ipcMain.handle('get-status', () => server?.seeder?.getStatus());
  ipcMain.handle('get-wallet', async () => {
    if (!config) return null;
    const w = new Wallet(config.leecherWif || config.seederWif);
    let balance = 0;
    try {
      const utxos = await w.fetchUtxos();
      balance = utxos.reduce((s, u) => s + u.satoshis, 0);
    } catch {}
    return { address: w.address, balance, live: !!config.leecherWif };
  });
  ipcMain.handle('add-videos', addVideos);

  // Settings: update config
  ipcMain.handle('save-settings', async (_event, settings: {
    seederWif?: string;
    leecherWif?: string;
    contentFolders?: string[];
    pricePerPiece?: number;
  }) => {
    if (!config) return { error: 'No config' };
    if (settings.seederWif) config.seederWif = settings.seederWif;
    if (settings.leecherWif) config.leecherWif = settings.leecherWif;
    if (settings.contentFolders) config.contentFolders = settings.contentFolders;
    if (settings.pricePerPiece !== undefined) config.pricePerPiece = settings.pricePerPiece;
    await saveConfig(config);
    return {
      saved: true,
      seederAddress: new Wallet(config.seederWif).address,
      leecherAddress: new Wallet(config.leecherWif).address,
    };
  });

  // Add a content folder
  ipcMain.handle('add-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select content folder',
    });
    if (result.canceled || !result.filePaths.length || !config) return null;
    const folder = result.filePaths[0];
    if (!config.contentFolders.includes(folder)) {
      config.contentFolders.push(folder);
      await saveConfig(config);
    }
    return folder;
  });

  // Remove a content folder
  ipcMain.handle('remove-folder', async (_event, folder: string) => {
    if (!config) return;
    config.contentFolders = config.contentFolders.filter(f => f !== folder);
    await saveConfig(config);
  });

  // List all media files across content folders
  ipcMain.handle('list-media', async () => {
    if (!config) return [];
    const MEDIA_EXTS = ['.mp4', '.mkv', '.mov', '.avi', '.mp3', '.m4a', '.flac', '.wav', '.webm'];
    const files: Array<{ name: string; folder: string; path: string; size: number; ext: string }> = [];

    for (const folder of config.contentFolders) {
      try {
        const entries = await readdir(folder, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
          if (!MEDIA_EXTS.includes(ext)) continue;
          const fullPath = join(folder, entry.name);
          try {
            const s = await stat(fullPath);
            files.push({
              name: entry.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
              folder,
              path: fullPath,
              size: s.size,
              ext: ext.substring(1).toUpperCase(),
            });
          } catch {}
        }
      } catch {}
    }

    return files.sort((a, b) => a.name.localeCompare(b.name));
  });

  // Ingest a single file by path (from sidebar click) — seeds + returns infohash
  ipcMain.handle('ingest-file', async (_event, videoPath: string) => {
    if (!config || !server) return { error: 'Not ready' };

    const title = videoPath
      .split('/').pop()!
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    try {
      const ingestResult = await ingest({
        videoPath,
        title,
        creatorAddress: new Wallet(config.seederWif).address,
        satsPerPiece: config.pricePerPiece,
        outputDir: DATA_DIR,
      });

      const seeded = await server.seeder.seed(ingestResult.fmp4Path, ingestResult.manifest);
      server.manifests.set(seeded.infohash, { ...ingestResult.manifest, infohash: seeded.infohash });
      server.magnetURIs.set(seeded.infohash, seeded.torrent.magnetURI);
      server.fmp4Paths.set(seeded.infohash, ingestResult.fmp4Path);

      updateTrayMenu();
      return { infohash: seeded.infohash, title };
    } catch (err: any) {
      return { error: err.message || String(err) };
    }
  });

  // Tokenize content: mint a BSV-21 token linked to a video
  ipcMain.handle('tokenize', async (_event, opts: {
    infohash: string;
    ticker: string;
    name: string;
    supply: number;
  }) => {
    if (!config || !server) return { error: 'Not ready' };

    const manifest = server.manifests.get(opts.infohash);
    if (!manifest) return { error: 'Content not found' };

    const wallet = new Wallet(config.seederWif);
    const live = !!config.leecherWif;

    try {
      const token = await mintContentToken({
        ticker: opts.ticker,
        name: opts.name,
        supply: opts.supply,
        manifest,
        wallet,
        live,
      });

      // Store token in config
      if (!config.tokens) config.tokens = {};
      config.tokens[opts.infohash] = token;
      await saveConfig(config);

      // Update the manifest's creator address to the token's revenue address
      const updated = { ...manifest, creator: { ...manifest.creator, address: token.revenueAddress } };
      server.manifests.set(opts.infohash, updated);

      return { token };
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // Get token for a piece of content
  ipcMain.handle('get-token', (_event, infohash: string) => {
    return config?.tokens?.[infohash] ?? null;
  });

  // Get all tokens
  ipcMain.handle('get-tokens', () => {
    return config?.tokens ?? {};
  });

  // Regenerate wallet keypair
  ipcMain.handle('regen-wallet', async (_event, which: 'seeder' | 'leecher') => {
    if (!config) return null;
    const w = Wallet.random();
    if (which === 'seeder') config.seederWif = w.privateKey.toWif();
    else config.leecherWif = w.privateKey.toWif();
    await saveConfig(config);
    return { address: w.address };
  });
}

// ─── First Run Setup ────────────────────────────────────
async function firstRunSetup(): Promise<AppConfig> {
  const seederWallet = Wallet.random();
  const leecherWallet = Wallet.random();

  // Default content folders: ~/Movies and ~/Music
  const defaultFolders: string[] = [];
  for (const name of ['Movies', 'Music']) {
    const p = join(app.getPath('home'), name);
    try { await access(p); defaultFolders.push(p); } catch {}
  }

  const newConfig: AppConfig = {
    seederWif: seederWallet.privateKey.toWif(),
    leecherWif: leecherWallet.privateKey.toWif(),
    contentFolders: defaultFolders,
    pricePerPiece: 1,
  };

  await saveConfig(newConfig);

  console.log('[APP] First run — generated wallets:');
  console.log(`  Seeder:  ${seederWallet.address}`);
  console.log(`  Leecher: ${leecherWallet.address}`);
  console.log(`  Content: ${defaultFolders.join(', ') || 'none'}`);
  console.log(`  Fund these addresses with BSV to enable live payments`);

  return newConfig;
}

// ─── Startup ────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
  await mkdir(DATA_DIR, { recursive: true });

  // Load or create config
  config = await loadConfig();
  if (!config) {
    config = await firstRunSetup();
  }
  // Migrate old configs that had videoDir instead of contentFolders
  if (!config.contentFolders) {
    const old = (config as any).videoDir;
    config.contentFolders = old ? [old] : [];
    delete (config as any).videoDir;
    await saveConfig(config);
    console.log('[APP] Migrated config: videoDir → contentFolders');
  }

  // Start the server
  const opts: ServerOptions = {
    privateKeyWif: config.seederWif,
    storagePath: DATA_DIR,
    maxStorageBytes: 50 * 1024 * 1024 * 1024,
    defaultSatsPerPiece: config.pricePerPiece,
    port: PORT,
    leecherKeyWif: config.leecherWif,
    live: !!config.leecherWif,
  };

  server = await createServer(opts);

  // Start server + UI immediately, scan folders in background
  await server.start();
  console.log(`[APP] Server running on port ${PORT}`);

  setupIPC();
  createTray();
  createWindow();

  // Scan content folders in background (non-blocking)
  const MEDIA_EXTS = ['.mp4', '.mkv', '.mov', '.avi'];
  (async () => {
    let totalIngested = 0;
    for (const folder of config!.contentFolders) {
      try {
        const files = await readdir(folder);
        const media = files.filter(f => MEDIA_EXTS.some(ext => f.toLowerCase().endsWith(ext)));
        console.log(`[APP] Scanning ${folder}: ${media.length} media file(s)`);

        for (const file of media.slice(0, 10)) {
          const videoPath = join(folder, file);
          const title = file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          try {
            const result = await ingest({
              videoPath,
              title,
              creatorAddress: new Wallet(config!.seederWif).address,
              satsPerPiece: config!.pricePerPiece,
              outputDir: DATA_DIR,
            });
            const seeded = await server!.seeder.seed(result.fmp4Path, result.manifest);
            server!.manifests.set(seeded.infohash, { ...result.manifest, infohash: seeded.infohash });
            server!.magnetURIs.set(seeded.infohash, seeded.torrent.magnetURI);
            server!.fmp4Paths.set(seeded.infohash, result.fmp4Path);
            totalIngested++;
            console.log(`[APP] Seeding: ${title}`);
          } catch {}
        }
      } catch {
        console.log(`[APP] Skipped ${folder}`);
      }
    }
    console.log(`[APP] Ingested ${totalIngested} files`);
    updateTrayMenu();
  })();
  } catch (err) {
    console.error('[APP] FATAL:', err);
  }
});

app.on('window-all-closed', () => {
  // Don't quit — keep seeding in the background via tray
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});
