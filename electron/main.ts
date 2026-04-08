/**
 * BitCoinTorrent — Electron Main Process
 *
 * Runs the seeder, payment channels, and API server in the background.
 * System tray shows earnings. Window shows the catalog + player UI.
 */

import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createServer, type ServerOptions } from '../src/api/server.js';
import { ingest } from '../src/ingest/index.js';
import { Wallet } from '../src/payment/wallet.js';
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
  videoDir: string;
  pricePerPiece: number;
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
    title: 'BitCoinTorrent',
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
  tray.setToolTip('BitCoinTorrent — Seeding');

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
    { label: `BitCoinTorrent`, enabled: false },
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
  ipcMain.handle('get-config', () => config);
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
}

// ─── First Run Setup ────────────────────────────────────
async function firstRunSetup(): Promise<AppConfig> {
  // Generate fresh wallets
  const seederWallet = Wallet.random();
  const leecherWallet = Wallet.random();

  const newConfig: AppConfig = {
    seederWif: seederWallet.privateKey.toWif(),
    leecherWif: leecherWallet.privateKey.toWif(),
    videoDir: join(app.getPath('home'), 'Movies'),
    pricePerPiece: 1,
  };

  await saveConfig(newConfig);

  console.log('[APP] First run — generated wallets:');
  console.log(`  Seeder:  ${seederWallet.address}`);
  console.log(`  Leecher: ${leecherWallet.address}`);
  console.log(`  Fund these addresses with BSV to enable live payments`);

  return newConfig;
}

// ─── Startup ────────────────────────────────────────────
app.whenReady().then(async () => {
  await mkdir(DATA_DIR, { recursive: true });

  // Load or create config
  config = await loadConfig();
  if (!config) {
    config = await firstRunSetup();
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

  // Auto-ingest videos from the configured video directory
  try {
    const files = await readdir(config.videoDir);
    const mp4s = files.filter(f => f.endsWith('.mp4'));
    for (const file of mp4s.slice(0, 10)) { // max 10 at startup
      const videoPath = join(config.videoDir, file);
      const title = file.replace(/\.mp4$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      try {
        const result = await ingest({
          videoPath,
          title,
          creatorAddress: new Wallet(config.seederWif).address,
          satsPerPiece: config.pricePerPiece,
          outputDir: DATA_DIR,
        });
        const seeded = await server.seeder.seed(result.fmp4Path, result.manifest);
        server.manifests.set(seeded.infohash, { ...result.manifest, infohash: seeded.infohash });
        server.magnetURIs.set(seeded.infohash, seeded.torrent.magnetURI);
        server.fmp4Paths.set(seeded.infohash, result.fmp4Path);
        console.log(`[APP] Auto-seeded: ${title}`);
      } catch {}
    }
  } catch {}

  await server.start();
  console.log(`[APP] Server running on port ${PORT}`);

  setupIPC();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // Don't quit — keep seeding in the background via tray
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});
