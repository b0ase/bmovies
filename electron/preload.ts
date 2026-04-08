/**
 * Preload script — exposes IPC bridge to renderer.
 *
 * The renderer (index.html) can call window.bitcointorrent.*
 * to communicate with the main process.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bitcointorrent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getWallet: () => ipcRenderer.invoke('get-wallet'),
  addVideos: () => ipcRenderer.invoke('add-videos'),
  isElectron: true,
});
