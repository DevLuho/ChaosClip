// Appli Windows : lance le serveur local dans le processus principal et l'affiche dans une fenêtre.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeImage, Menu, screen } = require('electron');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// Données dans le profil utilisateur, exports dans Vidéos\ChaosClip (le dossier de l'appli est en lecture seule).
process.env.CHAOSCLIP_DATA ||= app.getPath('userData');
process.env.CHAOSCLIP_EXPORTS ||= path.join(app.getPath('videos'), 'ChaosClip');

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

// Lien de retour de la connexion à Chaos Tools (voir booruLogin) : Windows relance ChaosClip avec le lien en argument.
const AUTH_SCHEME = 'fr.chaosreborn.tools';
if (process.defaultApp) app.setAsDefaultProtocolClient(AUTH_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(AUTH_SCHEME);

app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith(`${AUTH_SCHEME}://`));
  if (link) loginLink?.(link);
  else openPath(fileArg(argv));
});

async function listen() {
  const { start } = require('../server');
  // Port fixe : localStorage (langue, réglages, raccourcis) dépend de l'origine.
  try { return await start(4871, { open: false }); } catch { return start(0, { open: false }); }
}

// Taille et position de la fenêtre, reprises au lancement si elles tiennent encore sur un écran.
const BOUNDS = () => path.join(app.getPath('userData'), 'window.json');
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS(), 'utf8'));
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 20 && b.y < area.y + area.height - 100;
    return visible ? b : null;
  } catch { return null; }
}

let updating = false; // installation d'une mise à jour en cours : la fenêtre se ferme sans redemander

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const { url } = await listen();
  const bounds = savedBounds();
  win = new BrowserWindow({
    width: 1400, height: 900, ...(bounds && { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
    minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#191b1a', icon: ICON, title: 'ChaosClip',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.once('ready-to-show', () => { if (bounds?.maximized) win.maximize(); win.show(); });
  win.on('close', (e) => {
    // Fermer coupe le serveur : on prévient si un export ou un téléchargement tourne encore.
    const busy = [...require('../lib/proc').jobs.values()].filter((j) => ['running', 'queued'].includes(j.status) && ['export', 'download'].includes(j.kind)).length;
    if (busy && !updating && dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Fermer quand même', 'Annuler'], defaultId: 1, cancelId: 1, title: 'ChaosClip',
      message: busy > 1 ? `${busy} exports ou téléchargements en cours seront interrompus.` : 'Un export ou un téléchargement en cours sera interrompu.',
    }) === 1) { e.preventDefault(); return; }
    try { fs.writeFileSync(BOUNDS(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* facultatif */ }
  });
  // Liens externes dans le navigateur, jamais dans l'appli.
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(url)) { e.preventDefault(); shell.openExternal(u); } });
  win.webContents.on('before-input-event', (_e, i) => { if (i.type === 'keyDown' && i.key === 'F12') win.webContents.toggleDevTools(); });
  await win.loadURL(url);
  openPath(fileArg(process.argv));

  if (app.isPackaged) {
    // Téléchargée en arrière-plan ; la page affiche l'avancement et le bouton « Mettre à jour » (sinon installée à la fermeture).
    // Seule source de vérité pour l'appli installée : la release GitHub (latest.yml), pas package.json sur main.
    try {
      const log = require('../lib/log');
      const { autoUpdater } = require('electron-updater');
      autoUpdater.logger = { info: log.info, warn: log.warn, error: log.error, debug() {} };
      let ready = false;
      const tell = (state, extra = {}) => { if (!win.isDestroyed()) win.webContents.send('update', { state, ...extra }); };
      autoUpdater.on('update-available', (i) => tell('downloading', { version: i.version, percent: 0 }));
      autoUpdater.on('download-progress', (p) => tell('downloading', { percent: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', (i) => { ready = true; tell('ready', { version: i.version }); });
      const { updateErrorMessage } = require('../lib/updater');
      autoUpdater.on('error', (e) => tell('error', { message: updateErrorMessage(e) }));
      const check = async () => {
        if (ready) return { available: true, ready: true };
        const r = await autoUpdater.checkForUpdates();
        return { available: !!r?.isUpdateAvailable, version: r?.updateInfo?.version || null };
      };
      ipcMain.on('installUpdate', () => { updating = true; autoUpdater.quitAndInstall(true, true); }); // la page a déjà demandé confirmation
      ipcMain.handle('checkUpdate', () => check().catch((e) => ({ error: updateErrorMessage(e) })));
      check().catch(() => {});
      // L'appli reste souvent ouverte toute la journée : on revérifie toutes les 4 h.
      setInterval(() => check().catch(() => {}), 4 * 3600e3).unref();
    } catch (e) { console.error(e); }
  }
});

app.on('window-all-closed', () => app.quit());

// ---------- fonctions natives exposées par preload.js ----------

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv', 'ts', 'm2ts', 'gif', 'mpg', 'mpeg', 'png', 'jpg', 'jpeg', 'webp'];

ipcMain.handle('openFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Vidéos et images', extensions: VIDEO_EXT }, { name: '*', extensions: ['*'] }] });
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
// Avancement dans la barre des tâches : 0 à 1, ou -1 pour l'enlever.
ipcMain.on('progress', (_e, p) => { if (win && !win.isDestroyed()) win.setProgressBar(Number(p)); });
ipcMain.on('notify', (_e, title, body) => {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
});
// Connexion à Chaos Tools dans le navigateur du membre, où le site et Discord marchent déjà : une fenêtre intégrée
// restait blanche chez certains membres. Le site renvoie le code par le lien fr.chaosreborn.tools://auth de son appli
// Android (absente sous Windows), que ChaosClip reçoit ici ; lib/booru.js l'échange contre le jeton.
let loginLink = null; // reçoit le lien de retour de la connexion en cours
ipcMain.handle('booruLogin', async () => {
  loginLink?.(null); // une connexion relancée remplace la précédente
  const login = require('../lib/booru').browserLogin();
  const link = await new Promise((resolve) => {
    const timer = setTimeout(() => loginLink?.(null), 10 * 60e3);
    loginLink = (l) => { clearTimeout(timer); loginLink = null; resolve(l); };
    shell.openExternal(login.url);
  });
  if (!link) return {};
  if (win.isMinimized()) win.restore();
  win.focus();
  try { return { token: await login.finish(link) }; } catch (e) { return { error: e.message }; }
});
ipcMain.on('relaunch', () => { app.relaunch(); app.exit(0); });
