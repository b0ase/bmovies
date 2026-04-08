import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bitcointorrent', {
  isElectron: true,
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getWallet: () => ipcRenderer.invoke('get-wallet'),
  addVideos: () => ipcRenderer.invoke('add-videos'),
  saveSettings: (s: any) => ipcRenderer.invoke('save-settings', s),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  removeFolder: (f: string) => ipcRenderer.invoke('remove-folder', f),
  regenWallet: (which: string) => ipcRenderer.invoke('regen-wallet', which),
});
