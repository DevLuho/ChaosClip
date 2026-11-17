// Appli Windows : lance le serveur local dans le processus principal et l'affiche dans une fenêtre.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeImage, Menu } = require('electron');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// Données dans le profil utilisateur, exports dans Vidéos\ChaosClip (le dossier de l'appli est en lecture seule).
process.env.CHAOSCLIP_DATA = app.getPath('userData');
process.env.CHAOSCLIP_EXPORTS = path.join(app.getPath('videos'), 'ChaosClip');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
let win = null;

// Fichier passé en argument (« Ouvrir avec ChaosClip », glisser sur l'icône).
const fileArg = (argv) => argv.slice(1).find((a) => !a.startsWith('-') && a !== '.' && path.isAbsolute(a) && fs.existsSync(a) && fs.statSync(a).isFile());

function openPath(p) {
  if (!p || !win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('open', p);
}

app.on('second-instance', (_e, argv) => openPath(fileArg(argv)));

async function listen() {
  const { start } = require('../server');
  // Port fixe : localStorage (langue, réglages, raccourcis) dépend de l'origine.
  try { return await start(4871, { open: false }); } catch { return start(0, { open: false }); }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { url } = await listen();
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#0f0d17', icon: ICON, title: 'ChaosClip',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.once('ready-to-show', () => win.show());
  // Liens externes dans le navigateur, jamais dans l'appli.
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(url)) { e.preventDefault(); shell.openExternal(u); } });
  win.webContents.on('before-input-event', (_e, i) => { if (i.type === 'keyDown' && i.key === 'F12') win.webContents.toggleDevTools(); });
  await win.loadURL(url);
  openPath(fileArg(process.argv));

  if (app.isPackaged) {
    // Téléchargée en arrière-plan, installée à la fermeture.
    try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify(); } catch { /* hors ligne */ }
  }
});

app.on('window-all-closed', () => app.quit());

// ---------- fonctions natives exposées par preload.js ----------

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv', 'ts', 'm2ts', 'gif', 'mpg', 'mpeg'];

ipcMain.handle('openFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Vidéos', extensions: VIDEO_EXT }, { name: '*', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('startDrag', (e, file) => {
  if (!file || !fs.existsSync(file)) return;
  e.sender.startDrag({ file, icon: nativeImage.createFromPath(ICON).resize({ width: 64 }) });
});
ipcMain.on('notify', (_e, title, body) => {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
});
ipcMain.on('relaunch', () => { app.relaunch(); app.exit(0); });
