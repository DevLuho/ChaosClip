const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const log = require('./lib/log');
const store = require('./lib/store');
const { startJob, cancelJob, jobs, publicJob, id, run } = require('./lib/proc');
const media = require('./lib/media');
const ytdlp = require('./lib/ytdlp');
const exporter = require('./lib/exporter');
const health = require('./lib/health');
const cleanup = require('./lib/cleanup');
const fonts = require('./lib/fonts');
const discord = require('./lib/discord');
const updater = require('./lib/updater');
const booru = require('./lib/booru');

const { DIRS } = env;
const PORT = Number(process.env.PORT) || 4870;

const app = express();
app.disable('x-powered-by');

// Protection : l'appli n'écoute que sur 127.0.0.1, mais une page web ouverte dans le navigateur
// pourrait viser localhost. On refuse les noms d'hôte étrangers (rebinding DNS) et on exige un
// en-tête maison sur toute écriture, ce qu'un autre site ne peut pas envoyer sans pré-vol CORS.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).end();
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-chaosclip'] !== '1') return res.status(403).json({ error: 'Requête refusée' });
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(env.ROOT, 'public'), { index: 'index.html' }));
app.use('/work', express.static(DIRS.work, { maxAge: 0 }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  log.error(`${req.method} ${req.path} : ${e.stack || e.message}`);
  if (!res.headersSent) res.status(e.status || 400).json({ error: e.message });
});

const getSource = (req) => {
  const s = media.sources.get(req.params.id);
  if (!s) throw Object.assign(new Error('Source inconnue (l’appli a peut-être redémarré) : recharge la vidéo.'), { status: 404 });
  return s;
};

const sendJob = (res, job) => res.json({ job: job.id });

// Fichier reçu en flux brut (évite multer) : écrit dans dir, renvoie son chemin.
function receive(req, dir, fallbackName = 'fichier') {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(String(req.query.name || fallbackName)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120);
    const file = path.join(dir, `${id()}-${name}`);
    const ws = fs.createWriteStream(file);
    req.pipe(ws);
    ws.on('finish', () => resolve(file));
    ws.on('error', reject);
    req.on('aborted', () => { ws.destroy(); fs.rm(file, { force: true }, () => {}); reject(new Error('Envoi interrompu')); });
  });
}

// ---------- état de l'appli ----------

app.get('/api/health', wrap(async (req, res) => res.json(await health.check())));
app.post('/api/ytdlp/update', wrap(async (req, res) => res.json(await ytdlp.update())));
app.get('/api/log', (req, res) => res.type('text/plain').send(log.text()));
app.get('/api/disk', wrap(async (req, res) => res.json(cleanup.usage())));
app.post('/api/cleanup', wrap(async (req, res) => {
  // Les fichiers des sources ouvertes ne sont jamais supprimés.
  const keep = new Set([...media.sources.values()].flatMap((s) => [s.path, s.playPath]));
  res.json({ freed: cleanup.empty(req.body.kind, keep) });
}));
app.get('/api/fonts', (req, res) => res.json({ fonts: fonts.list().map((f) => f.family), default: fonts.defaultFont()?.family || null }));

app.get('/api/settings', (req, res) => res.json(store.read('settings', {})));
app.put('/api/settings', wrap(async (req, res) => {
  const cur = store.read('settings', {});
  res.json(store.write('settings', { ...cur, ...req.body }));
}));
for (const name of ['presets', 'projects']) {
  app.get(`/api/${name}`, (req, res) => res.json(store.read(name, name === 'projects' ? {} : [])));
  app.put(`/api/${name}`, wrap(async (req, res) => res.json(store.write(name, req.body))));
}

// ---------- tâches ----------

app.get('/api/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Tâche inconnue' });
  res.json(publicJob(j));
});
app.post('/api/job/:id/cancel', (req, res) => res.json({ ok: cancelJob(req.params.id) }));
app.get('/api/queue', (req, res) => res.json({
  items: [...jobs.values()].filter((j) => ['export', 'download'].includes(j.kind)).sort((a, b) => b.created - a.created).slice(0, 50).map(publicJob),
}));

// ---------- sources ----------

app.post('/api/analyze', wrap(async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Adresse invalide');
  const settings = store.read('settings', {});
  sendJob(res, startJob('analyze', (j) => ytdlp.analyze(url, { cookiesBrowser: settings.cookiesBrowser }, j)));
}));

function downloadJob(url, options = {}) {
  const settings = store.read('settings', {});
  const o = { cookiesBrowser: settings.cookiesBrowser, rateLimit: settings.rateLimit, ...options };
  return startJob('download', async (j) => {
    const r = await ytdlp.download(j, url, o);
    j.message = 'Analyse…';
    const src = await media.addSource(r.file, {
      origin: { kind: 'url', url, title: options.title || null, section: o.section || null },
      externalSubs: r.subs.map((s) => ({ ...s, offset: -r.offset })),
    });
    return media.publicSource(src);
  }, { lane: 'download', label: options.title || url, created: Date.now() });
}

// URL (http/https) ou chemin d'un fichier local.
app.post('/api/source', wrap(async (req, res) => {
  const input = String(req.body.input || '').trim().replace(/^"(.*)"$/, '$1');
  if (!input) throw new Error('Rien à charger');
  if (/^https?:\/\//i.test(input)) return sendJob(res, downloadJob(input, req.body.options || {}));
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`Fichier introuvable : ${input}`);
  const src = await media.addSource(path.resolve(input), { origin: { kind: 'file' } });
  res.json({ source: media.publicSource(src) });
}));

// Plusieurs URL (liste ou playlist) : téléchargées l'une après l'autre.
app.post('/api/source/batch', wrap(async (req, res) => {
  const items = (Array.isArray(req.body.items) ? req.body.items : []).filter((x) => /^https?:\/\//i.test(x.url || '')).slice(0, 200);
  if (!items.length) throw new Error('Aucune adresse valide');
  res.json({ jobs: items.map((x) => downloadJob(x.url, { ...(req.body.options || {}), title: x.title }).id) });
}));

// Fichier choisi dans le navigateur : envoyé en flux brut puis copié dans work/.
app.post('/api/upload', wrap(async (req, res) => {
  const file = await receive(req, path.join(DIRS.work, 'uploads'), 'video');
  const src = await media.addSource(file, { name: path.basename(String(req.query.name || 'video')), origin: { kind: 'upload' } });
  res.json({ source: media.publicSource(src) });
}));

// Images à assembler : envoyées une par une dans un groupe, puis assemblées.
app.post('/api/images/:group', wrap(async (req, res) => {
  const group = String(req.params.group).replace(/\W/g, '').slice(0, 20);
  const file = await receive(req, path.join(DIRS.work, `img-${group}`), 'image');
  res.json({ file: path.basename(file) });
}));
app.post('/api/images/:group/build', wrap(async (req, res) => {
  const dir = path.join(DIRS.work, `img-${String(req.params.group).replace(/\W/g, '').slice(0, 20)}`);
  const order = (req.body.files || []).map((f) => path.join(dir, path.basename(f))).filter((f) => fs.existsSync(f));
  if (!order.length) throw new Error('Aucune image');
  const fps = Math.min(60, Math.max(0.5, Number(req.body.fps) || 10));
  sendJob(res, startJob('images', async (j) => media.publicSource(await media.fromImages(j, order, fps))));
}));

app.post('/api/record', wrap(async (req, res) => {
  const file = await receive(req, path.join(DIRS.work, 'uploads'), 'capture.webm');
  sendJob(res, startJob('record', async (j) => media.publicSource(await media.fromRecording(j, file, Number(req.query.fps) || 30))));
}));

app.get('/api/library', wrap(async (req, res) => {
  const items = fs.readdirSync(DIRS.downloads)
    .filter((f) => /\.(mp4|mkv|webm|mov|avi|m4v|flv)$/i.test(f))
    .map((f) => {
      const p = path.join(DIRS.downloads, f);
      const st = fs.statSync(p);
      return { name: f, path: p, bytes: st.size, date: st.mtimeMs };
    })
    .sort((a, b) => b.date - a.date);
  res.json({ items, dir: DIRS.downloads });
}));
app.delete('/api/library', wrap(async (req, res) => {
  const p = path.resolve(String(req.body.path || ''));
  if (path.dirname(p) !== path.resolve(DIRS.downloads)) throw new Error('Fichier hors de la bibliothèque');
  fs.rmSync(p, { force: true });
  res.json({ ok: true });
}));

app.get('/api/media/:id', wrap(async (req, res) => res.sendFile(getSource(req).playPath)));
app.post('/api/proxy/:id', wrap(async (req, res) => {
  const s = getSource(req);
  const hw = store.read('settings', {}).hw !== false ? (await health.hardwareEncoders())[0] : null;
  sendJob(res, startJob('proxy', (j) => media.makeProxy(j, s, { hw })));
}));
app.get('/api/thumbs/:id', wrap(async (req, res) => {
  const s = getSource(req);
  const from = Math.max(0, Number(req.query.from) || 0);
  const to = Math.min(s.info.duration, Number(req.query.to) || s.info.duration);
  const n = Math.min(100, Math.max(1, Number(req.query.n) || 20));
  const h = Math.min(160, Math.max(24, Number(req.query.h) || 54));
  res.set('Cache-Control', 'max-age=3600').sendFile(await media.thumbs(s, from, to, n, h));
}));
app.post('/api/scenes/:id', wrap(async (req, res) => {
  const s = getSource(req);
  const t = Math.min(0.9, Math.max(0.05, Number(req.body.threshold) || 0.3));
  sendJob(res, startJob('scenes', (j) => media.detectScenes(j, s, t)));
}));
app.post('/api/cropdetect/:id', wrap(async (req, res) => res.json({ crop: await media.cropDetect(getSource(req), Number(req.body.frame) || 0) })));
app.get('/api/frame/:id', wrap(async (req, res) => res.sendFile(await media.frameImage(getSource(req), Number(req.query.f) || 0, Number(req.query.w) || 0))));

// Sous-titres externes (.srt, .ass, .vtt) ajoutés à une source.
app.post('/api/subs/:id', wrap(async (req, res) => {
  const s = getSource(req);
  const file = await receive(req, path.join(DIRS.work, 'subs'), 'subs.srt');
  if (!/\.(srt|ass|ssa|vtt)$/i.test(file)) throw new Error('Format de sous-titres non pris en charge (.srt, .ass, .vtt)');
  s.externalSubs.push({ path: file, label: path.basename(String(req.query.name || 'sous-titres')), offset: 0 });
  res.json({ source: media.publicSource(s) });
}));

// Logo ou image à incruster.
app.post('/api/logo', wrap(async (req, res) => {
  const file = await receive(req, path.join(DIRS.work, 'logos'), 'logo.png');
  if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(file)) throw new Error('Image non prise en charge');
  res.json({ file: path.basename(file), animated: /\.gif$/i.test(file) });
}));

// ---------- export ----------

const settingsOf = (req) => req.body.settings || {};

app.post('/api/estimate/:id', wrap(async (req, res) => {
  const s = getSource(req);
  sendJob(res, startJob('estimate', (j) => exporter.estimate(j, s, settingsOf(req))));
}));
app.post('/api/preview/:id', wrap(async (req, res) => {
  const s = getSource(req);
  sendJob(res, startJob('preview', (j) => exporter.previewFrame(j, s, settingsOf(req), Number(req.body.frame) || 0)));
}));
app.post('/api/export/:id', wrap(async (req, res) => {
  const s = getSource(req);
  const settings = settingsOf(req);
  const nameTemplate = store.read('settings', {}).nameTemplate;
  sendJob(res, startJob('export', (j) => exporter.exportClip(j, s, settings, { nameTemplate }), {
    lane: 'export', label: `${s.name} · ${String(settings.format || 'gif').toUpperCase()}`, created: Date.now(),
  }));
}));

// ---------- historique des exports ----------

const historyEntry = (hid) => {
  const e = store.read('history', []).find((x) => x.id === hid);
  if (!e) throw Object.assign(new Error('Export introuvable'), { status: 404 });
  return e;
};
app.get('/api/history', (req, res) => res.json({
  items: store.read('history', []).map((e) => ({ ...e, exists: fs.existsSync(e.path), url: `/out/${e.id}` })),
}));
app.delete('/api/history/:id', wrap(async (req, res) => {
  const list = store.read('history', []);
  const e = list.find((x) => x.id === req.params.id);
  if (e && req.body && req.body.deleteFile) fs.rmSync(e.path, { force: true });
  store.write('history', list.filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
}));
app.get('/out/:id', wrap(async (req, res) => {
  const e = historyEntry(req.params.id);
  res.sendFile(e.path, { headers: { 'Cache-Control': 'no-cache' } });
}));

function reveal(file) {
  const [cmd, args] = env.IS_WIN ? ['explorer', [`/select,${file}`]]
    : process.platform === 'darwin' ? ['open', ['-R', file]] : ['xdg-open', [path.dirname(file)]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
app.post('/api/history/:id/reveal', wrap(async (req, res) => { reveal(historyEntry(req.params.id).path); res.json({ ok: true }); }));
app.post('/api/open-exports', wrap(async (req, res) => {
  const dir = store.read('settings', {}).outputDir || DIRS.exports;
  const opener = { win32: 'explorer', darwin: 'open' }[process.platform] || 'xdg-open';
  spawn(opener, [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  res.json({ ok: true });
}));

// Copie du fichier dans le presse-papiers : Ctrl+V dans Discord l'envoie directement.
app.post('/api/history/:id/copy', wrap(async (req, res) => {
  const file = historyEntry(req.params.id).path;
  if (!env.IS_WIN) throw new Error('Copie de fichier disponible sous Windows seulement');
  const { code, err } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Set-Clipboard -LiteralPath $env:CHAOSCLIP_FILE'], { env: { CHAOSCLIP_FILE: file } });
  if (code !== 0) throw new Error(`Copie impossible : ${err.slice(-200)}`);
  res.json({ ok: true });
}));

app.post('/api/history/:id/webhook', wrap(async (req, res) => {
  const e = historyEntry(req.params.id);
  const hooks = store.read('settings', {}).webhooks || [];
  const hook = hooks[Number(req.body.index) || 0];
  if (!hook) throw new Error('Aucun webhook Discord configuré (Réglages)');
  await discord.send(hook.url, e.path, String(req.body.message || ''));
  res.json({ ok: true });
}));

// ---------- mise à jour, Chaos Tools ----------

app.get('/api/update', wrap(async (req, res) => res.json(await updater.check())));
app.post('/api/update', wrap(async (req, res) => sendJob(res, startJob('update', (j) => updater.apply(j)))));

app.get('/api/booru/status', wrap(async (req, res) => res.json(await booru.status())));
app.put('/api/booru/token', wrap(async (req, res) => res.json(await booru.setToken(req.body.token))));
app.get('/api/booru/catalogue', wrap(async (req, res) => res.json(await booru.catalogue(String(req.query.q || '')))));
app.post('/api/history/:id/booru', wrap(async (req, res) => {
  const e = historyEntry(req.params.id);
  sendJob(res, startJob('booru', (j) => booru.send(j, e, req.body || {})));
}));

// ---------- démarrage ----------

function start(port = PORT, { open = !process.env.NO_OPEN } = {}) {
  cleanup.sweep();
  return new Promise((resolve) => {
    // 127.0.0.1 uniquement : l'appli n'est pas joignable depuis le réseau.
    const server = app.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${server.address().port}`;
      log.info(`ChaosClip ${env.VERSION} prêt sur ${url}`);
      ytdlp.ensure().catch(() => {});
      if (open) {
        const [cmd, args] = env.IS_WIN ? ['cmd', ['/c', 'start', '', url]]
          : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      }
      resolve({ server, url });
    });
  });
}

if (require.main === module) start();

module.exports = { app, start };
