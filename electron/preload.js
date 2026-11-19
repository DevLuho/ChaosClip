// Pont entre la page et Electron : window.chaosclip (voir public/js/util.js → native).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Les fichiers reçus avant que la page écoute sont gardés pour elle.
let onOpen = null;
// Dernier état de mise à jour, gardé pour la page si elle écoute plus tard.
let onUpdate = null;
let lastUpdate = null;
ipcRenderer.on('update', (_e, u) => { lastUpdate = { ...lastUpdate, ...u }; if (onUpdate) onUpdate(lastUpdate); });
const pending = [];
ipcRenderer.on('open', (_e, p) => (onOpen ? onOpen(p) : pending.push(p)));

contextBridge.exposeInMainWorld('chaosclip', {
  openFile: () => ipcRenderer.invoke('openFile'),
  openFolder: () => ipcRenderer.invoke('openFolder'),
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  startDrag: (file) => ipcRenderer.send('startDrag', file),
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  progress: (p) => ipcRenderer.send('progress', p),
  relaunch: () => ipcRenderer.send('relaunch'),
  onUpdate: (cb) => { onUpdate = cb; if (lastUpdate) cb(lastUpdate); },
  installUpdate: () => ipcRenderer.send('installUpdate'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  booruLogin: () => ipcRenderer.invoke('booruLogin'),
  onOpen: (cb) => { onOpen = cb; pending.splice(0).forEach(cb); },
});
