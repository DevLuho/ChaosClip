// IPv4 d'abord : chez certains membres, l'IPv6 ouvre la connexion puis la coupe au bout de 6 s (ECONNRESET), et la
// course entre les deux adresses faisait échouer une requête vers Chaos Tools sur deux. L'IPv6 reste en secours.
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const series = require('./lib/series');
const secrets = require('./lib/secrets');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('./lib/env');
const log = require('./lib/log');
const store = require('./lib/store');
const { startJob, cancelJob, jobs, publicJob, id, run, shownError } = require('./lib/proc');
const media = require('./lib/media');
const ytdlp = require('./lib/ytdlp');
const exporter = require('./lib/exporter');
const health = require('./lib/health');
const cleanup = require('./lib/cleanup');
const fonts = require('./lib/fonts');
const discord = require('./lib/discord');
const updater = require('./lib/updater');
const booru = require('./lib/booru');
const site = require('./lib/site');

const { DIRS } = env;
const PORT = Number(process.env.PORT) || 4870;
const TOKEN = process.env.CHAOSCLIP_TOKEN;

const app = express();
app.disable('x-powered-by');

// Protection : l'appli n'écoute que sur 127.0.0.1, mais une page web ouverte dans le navigateur
// pourrait viser localhost. On refuse les noms d'hôte étrangers (rebinding DNS) et on exige un
// en-tête maison sur toute écriture, ce qu'un autre site ne peut pas envoyer sans pré-vol CORS.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).end();
  // Android : les autres applis du téléphone peuvent joindre 127.0.0.1. L'appli tire un secret
  // à chaque lancement et le donne à sa WebView en cookie ; sans lui, rien ne passe.
  if (TOKEN && !String(req.headers.cookie || '').split(/;\s*/).includes(`cc=${TOKEN}`)) return res.status(403).end();
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-chaosclip'] !== '1') return res.status(403).json({ error: 'Requête refusée' });
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(env.ROOT, 'public'), { index: 'index.html' }));
app.use('/work', express.static(DIRS.work, { maxAge: 0 }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  // Vignette d'une vue quittée : rien d'anormal. Erreur réseau : sa vraie cause (ECONNRESET, certificat…) suit le message.
  if (!e.cancelled) log.error(`${req.method} ${req.path} : ${e.stack || e.message}${e.cause ? ` (cause : ${booru.why(e.cause)})` : ''}`);
  if (!res.headersSent) res.status(e.status || 400).json({ error: shownError(e), code: e.code });
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
// Fichiers à garder : ceux des séries, et vidéo, copie d'aperçu et sous-titres des sources ouvertes.
function openFiles() {
  const keep = series.protectedFiles();
  for (const source of media.sources.values()) {
    keep.add(source.path);
    keep.add(source.playPath);
    for (const sub of source.externalSubs) keep.add(sub.path);
  }
  return keep;
}
app.post('/api/cleanup', wrap(async (req, res) => {
  // Les fichiers des sources ouvertes et les dossiers des exports en cours ne sont jamais supprimés.
  const keep = openFiles();
  for (const dir of exporter.activeDirs) keep.add(dir);
  res.json({ freed: cleanup.empty(req.body.kind, keep) });
}));
app.get('/api/fonts', (req, res) => res.json({ fonts: fonts.list().map((f) => f.family), default: fonts.defaultFont()?.family || null }));

app.get('/api/settings', wrap(async (_req, res) => res.json(discord.publicSettings())));
app.put('/api/settings', wrap(async (req, res) => {
  const cur = store.read('settings', {});
  const { webhooks, ...settings } = req.body;
  store.write('settings', { ...cur, ...settings });
  res.json(discord.publicSettings());
}));
app.post('/api/settings/webhooks', wrap(async (req, res) => {
  discord.addHook(String(req.body.name || 'Discord').trim().slice(0, 120), String(req.body.url || ''));
  res.json(discord.publicSettings());
}));
app.delete('/api/settings/webhooks/:id', wrap(async (req, res) => {
  discord.removeHook(req.params.id);
  res.json(discord.publicSettings());
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
  items: [...jobs.values()].filter((j) => ['export', 'download'].includes(j.kind)).sort((a, b) => b.created - a.created).map(publicJob),
}));

app.get('/api/series', wrap(async (_req, res) => {
  res.json(series.list().map(({ id, title, source, clips, updated }) => ({ id, title, source: source.name, path: source.path, count: clips.length, updated })));
}));
app.post('/api/series/:id', wrap(async (req, res) => res.json(series.view(series.create(getSource(req), req.body.title)))));
app.get('/api/series/:id', wrap(async (req, res) => res.json(series.view(series.get(req.params.id)))));
app.patch('/api/series/:id', wrap(async (req, res) => {
  const current = series.get(req.params.id);
  const source = media.sources.get(req.body.sourceId);
  const externalSubs = source?.path === current.source.path ? source.externalSubs : undefined;
  res.json(series.view(series.applyEdit(current, { ...req.body, externalSubs })));
}));
app.post('/api/series/:id/source', wrap(async (req, res) => {
  const current = series.get(req.params.id);
  res.json({ source: media.publicSource(await series.openSource(current)) });
}));
app.put('/api/series/:id/source', wrap(async (req, res) => {
  const replacement = media.sources.get(req.body.sourceId);
  if (!replacement) throw new Error('Ouvre le fichier de remplacement dans ChaosClip.');
  res.json(series.view(series.relink(series.get(req.params.id), replacement, req.body.revision)));
}));
app.post('/api/series/:id/prepare', wrap(async (req, res) => {
  res.json(series.prepare(series.get(req.params.id), req.body.clip, req.body.format));
}));
app.post('/api/series/:id/portable', wrap(async (req, res) => {
  const current = series.view(series.get(req.params.id));
  const clip = current.clips.find((item) => item.id === req.body.clip);
  const entry = clip?.outputs.webp.entry;
  if (!entry) throw new Error('Prépare le WebP de cet extrait.');
  series.checkShare(entry.id, 'webp');
  const data = await booru.portable(entry, clip.publicationDraft);
  res.attachment(path.parse(entry.file).name + '-classe.webp').send(data);
}));

// ---------- sources ----------

app.post('/api/analyze', wrap(async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Adresse invalide');
  const settings = store.read('settings', {});
  sendJob(res, startJob('analyze', (j) => ytdlp.analyze(url, { cookiesBrowser: settings.cookiesBrowser }, j)));
}));

// Chapitres d'une vidéo en ligne (ChaosBoo s'en sert pour nommer le passage d'un clip), gardés le temps de la session.
const chapterCache = new Map();
app.get('/api/chapters', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Adresse invalide');
  if (!chapterCache.has(url)) {
    const settings = store.read('settings', {});
    chapterCache.set(url, ytdlp.analyze(url, { cookiesBrowser: settings.cookiesBrowser }).then((r) => r.chapters || []));
    chapterCache.get(url).catch(() => chapterCache.delete(url));
  }
  res.json({ chapters: await chapterCache.get(url) });
}));

function downloadJob(url, options = {}) {
  const settings = store.read('settings', {});
  const o = { cookiesBrowser: settings.cookiesBrowser, rateLimit: settings.rateLimit, ...options };
  return startJob('download', async (j) => {
    const r = await ytdlp.download(j, url, o);
    j.message = 'Analyse…';
    const extra = {
      origin: { kind: 'url', url, title: options.title || null, section: o.section || null },
      externalSubs: r.subs.map((s) => ({ ...s, offset: -r.offset })),
    };
    rememberDownload(r.file, extra);
    const src = await media.addSource(r.file, extra);
    return media.publicSource(src);
  }, { lane: 'download', label: options.title || url, created: Date.now() });
}

// Lien d'origine et sous-titres de chaque vidéo téléchargée, par chemin : une vidéo rouverte par son chemin
// (session, bibliothèque, projet, série) les retrouve. Les fichiers disparus sont oubliés à l'écriture suivante.
function rememberDownload(file, extra) {
  const known = Object.fromEntries(Object.entries(store.read('downloads', {})).filter(([p]) => fs.existsSync(p)));
  store.write('downloads', { ...known, [path.resolve(file)]: extra });
}

// URL (http/https) ou chemin d'un fichier local.
app.post('/api/source', wrap(async (req, res) => {
  const input = String(req.body.input || '').trim().replace(/^"(.*)"$/, '$1');
  if (!input) throw new Error('Rien à charger');
  if (/^https?:\/\//i.test(input)) return sendJob(res, downloadJob(input, req.body.options || {}));
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`Fichier introuvable : ${input}`);
  const previous = req.body.historyId ? historyEntry(req.body.historyId).source : null;
  const downloaded = store.read('downloads', {})[path.resolve(input)];
  const known = previous?.path === path.resolve(input) ? previous : downloaded;
  const extra = known
    ? { origin: known.origin, externalSubs: known.externalSubs || [] }
    : { origin: { kind: 'file' } };
  const src = await media.addSource(path.resolve(input), extra);
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
  sendJob(res, startJob('images', async (j) => media.publicSource(await media.fromImages(j, order, fps, path.basename(String(req.body.name || ''))))));
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
const libraryFile = (raw) => {
  const p = path.resolve(String(raw || ''));
  if (path.dirname(p) !== path.resolve(DIRS.downloads) || !fs.existsSync(p)) throw Object.assign(new Error('Fichier hors de la bibliothèque'), { status: 404 });
  return p;
};
// Miniature d'une vidéo téléchargée (gardée dans les temporaires).
app.get('/api/library/thumb', wrap(async (req, res) => {
  const p = libraryFile(req.query.path);
  const out = path.join(DIRS.work, `lib-${require('crypto').createHash('sha1').update(p + fs.statSync(p).mtimeMs).digest('hex')}.jpg`);
  for (const ss of ['3', '0']) {
    if (fs.existsSync(out)) break;
    await run(env.FFMPEG, ['-hide_banner', '-y', '-ss', ss, '-i', p, '-frames:v', '1', '-vf', 'scale=128:-2', out]);
  }
  if (!fs.existsSync(out)) throw Object.assign(new Error('Miniature impossible'), { status: 404 });
  res.set('Cache-Control', 'max-age=86400').sendFile(out);
}));
app.post('/api/library/reveal', wrap(async (req, res) => { reveal(libraryFile(req.body.path)); res.json({ ok: true }); }));
// Vidéos téléchargées depuis plus de N jours (yt-dlp écrit avec --no-mtime : la date est celle du téléchargement).
app.post('/api/library/purge', wrap(async (req, res) => {
  const limit = Date.now() - Math.max(1, Number(req.body.days) || 30) * 86400e3;
  const keep = openFiles();
  let freed = 0;
  let count = 0;
  for (const f of fs.readdirSync(DIRS.downloads)) {
    const p = path.join(DIRS.downloads, f);
    const st = fs.statSync(p);
    if (!st.isFile() || st.mtimeMs >= limit || keep.has(p)) continue;
    fs.rmSync(p, { force: true });
    freed += st.size;
    if (/\.(mp4|mkv|webm|mov|avi|m4v|flv)$/i.test(f)) count++;
  }
  res.json({ freed, count });
}));
app.delete('/api/library', wrap(async (req, res) => {
  const p = path.resolve(String(req.body.path || ''));
  if (path.dirname(p) !== path.resolve(DIRS.downloads)) throw new Error('Fichier hors de la bibliothèque');
  if (series.protectedFiles().has(p)) throw new Error('Ce fichier est utilisé dans une série.');
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
  const q = req.query;
  const at = (v) => Math.min(s.info.duration, Math.max(0, Number(v) || 0));
  const h = Math.min(160, Math.max(24, Number(q.h) || 54));
  const n = Math.min(100, Math.max(1, Math.round(Number(q.n)) || 1));
  const i = Math.min(n - 1, Math.max(0, Math.round(Number(q.i)) || 0));
  // k : rangée d'images exactes, une toutes les k à partir de l'image f (frise au plus près) ; cell : rangée à peu près
  // à l'image (frise zoomée) ; sinon une vignette d'image clé à t secondes (vue large).
  const file = Number(q.k) > 0
    ? await media.thumbFrames(s, Math.max(0, Math.round(Number(q.f)) || 0), Math.min(1000, Math.round(Number(q.k))), n, h, i)
    : Number(q.cell) > 0
      ? await media.thumbRow(s, at(q.from), Math.max(0.001, Number(q.cell)), n, h, i)
      : await media.thumb(s, at(q.t), h);
  res.set('Cache-Control', 'max-age=3600').sendFile(file);
}));
app.post('/api/scenes/:id', wrap(async (req, res) => {
  const s = getSource(req);
  const t = Math.min(0.9, Math.max(0.05, Number(req.body.threshold) || 0.3));
  sendJob(res, startJob('scenes', (j) => media.detectScenes(j, s, t)));
}));
app.post('/api/cropdetect/:id', wrap(async (req, res) => res.json({ crop: await media.cropDetect(getSource(req), Number(req.body.frame) || 0) })));
app.get('/api/frame/:id', wrap(async (req, res) => res.sendFile(await media.frameImage(getSource(req), Number(req.query.f) || 0, Number(req.query.w) || 0))));
// Repli quand le navigateur refuse l'écriture d'image dans le presse-papiers : le PNG est copié comme fichier.
app.post('/api/frame/:id/copy', wrap(async (req, res) => {
  if (!env.IS_WIN) throw new Error('Copie de fichier disponible sous Windows seulement');
  const file = await media.frameImage(getSource(req), Number(req.body.f) || 0, 0);
  const { code, err } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:CHAOSCLIP_FILE'], { env: { CHAOSCLIP_FILE: file } });
  if (code !== 0) throw new Error(`Copie impossible : ${err.slice(-200)}`);
  res.json({ ok: true });
}));

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
  const nameTemplate = String(req.body.name || '').trim() || store.read('settings', {}).nameTemplate;
  sendJob(res, startJob('export', (j) => exporter.exportClip(j, s, settings, { nameTemplate }), {
    lane: 'export', label: `${s.name} · ${String(settings.format || 'gif').toUpperCase()}`, created: Date.now(),
  }));
}));

// ---------- historique des exports ----------

const historyEntry = (hid) => {
  const e = store.read('history', []).find((x) => x.id === hid) || series.findOutput(hid)?.render.entry;
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
  const { path: file, format } = historyEntry(req.params.id);
  series.checkShare(req.params.id, format);
  if (!fs.existsSync(file)) throw new Error('Le fichier exporté n’existe plus.');
  // Android : seules les vérifications ci-dessus servent, la page ouvre ensuite la feuille de partage.
  if (process.platform === 'android') return res.json({ ok: true });
  if (!env.IS_WIN) throw new Error('Copie de fichier disponible sous Windows seulement');
  const { code, err } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Set-Clipboard -LiteralPath $env:CHAOSCLIP_FILE'], { env: { CHAOSCLIP_FILE: file } });
  if (code !== 0) throw new Error(`Copie impossible : ${err.slice(-200)}`);
  res.json({ ok: true });
}));

app.post('/api/history/:id/webhook', wrap(async (req, res) => {
  const e = historyEntry(req.params.id);
  series.checkShare(e.id, e.format);
  const hooks = discord.hooks();
  const hook = req.body.hookId ? hooks.find((item) => item.id === req.body.hookId) : hooks[Number(req.body.index) || 0];
  if (!hook) throw new Error('Aucun webhook Discord configuré (Réglages)');
  const receipt = await discord.send(secrets.open(hook.url), e.path, String(req.body.message || ''));
  store.write('discord-' + e.id, { ...receipt, hookId: hook.id, date: Date.now() });
  res.json({ ok: true, receipt });
}));

// ---------- mise à jour, Chaos Tools ----------

app.get('/api/update', wrap(async (req, res) => res.json(await updater.check())));
app.get('/api/nouveautes', wrap(async (req, res) => res.json({ items: await updater.releaseNotes() })));
app.post('/api/update', wrap(async (req, res) => sendJob(res, startJob('update', (j) => updater.apply(j)))));

app.get('/api/booru/status', wrap(async (req, res) => res.json(await booru.status())));
app.put('/api/booru/token', wrap(async (req, res) => res.json(await booru.setToken(req.body.token))));
app.get('/api/booru/catalogues', wrap(async (req, res) => res.json(await booru.catalogues())));
app.post('/api/history/:id/booru', wrap(async (req, res) => {
  const e = historyEntry(req.params.id);
  series.checkShare(e.id, 'webp');
  // Une file : ChaosBooru refuse un 2e import pendant qu'un autre est traité.
  sendJob(res, startJob('booru', (j) => {
    series.checkShare(e.id, 'webp');
    const key = 'booru-' + e.id;
    const transfer = store.read(key, e.booru || {});
    return booru.send(j, { ...e, booru: transfer }, req.body || {}, undefined, (value) => store.write(key, value), series.lot(e.id));
  }, { lane: 'booru', label: `ChaosBooru · ${e.file}`, created: Date.now() }));
}));
app.post('/api/history/:id/booru/status', wrap(async (req, res) => {
  const e = historyEntry(req.params.id);
  const key = 'booru-' + e.id;
  const transfer = store.read(key, e.booru || {});
  const result = await booru.publication(transfer);
  const latest = store.read(key, transfer);
  if (latest.versionId === transfer.versionId && JSON.stringify(latest.result) === JSON.stringify(transfer.result)) {
    store.write(key, { ...latest, result });
  }
  res.json(result);
}));
// Fichiers de page du site Chaos Tools, chargés par la fenêtre ChaosBooru (lib/site.js).
app.get('/site/*', wrap(async (req, res) => res.set('Cache-Control', 'no-cache').sendFile(await site.file(req.path.slice(5)))));
// Logos et icônes du catalogue : le site interdit leur affichage depuis une autre origine, ChaosClip les relaie.
// Deux adresses : la sienne, et celle que le code du site écrit lui-même (/api/chaosbooru).
app.get(['/api/booru/site/:kind/:id/icone', '/api/chaosbooru/:kind/:id/icone'], wrap(async (req, res) => {
  const { type, data } = await booru.icon(req.params.kind, Number(req.params.id), req.query.variant === 'original');
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).send(data);
}));
// Le reste de l'API du site, pour sa page « Importer un lot » chargée telle quelle : relayé avec la connexion du membre.
app.get('/api/booru/me', wrap(async (req, res) => res.json(await booru.me())));
app.all('/api/chaosbooru/*', wrap(async (req, res) => booru.relay(req, res, series.outputNamed)));
app.post('/api/booru/preview', wrap(async (req, res) => res.json(await booru.preview(req.body || {}))));
// ChaosBoo, l'assistant du site : son état, et l'analyse d'un export (images réduites par la page, lib/booru.js).
app.get('/api/booru/nexus', wrap(async (req, res) => res.json(await booru.nexus())));
app.post('/api/booru/nexus', wrap(async (req, res) => res.json(await booru.nexus(req))));
// Ses expressions : le code du site les demande à cette adresse, ChaosClip les sert depuis le miroir.
app.get('/assets/images/:file', wrap(async (req, res) => res.set('Cache-Control', 'no-cache').sendFile(await site.file(req.path))));

// ---------- démarrage ----------

function start(port = PORT, { open = !process.env.NO_OPEN } = {}) {
  cleanup.sweep(7, series.protectedFiles());
  return new Promise((resolve, reject) => {
    // 127.0.0.1 uniquement : l'appli n'est pas joignable depuis le réseau.
    const server = app.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${server.address().port}`;
      log.info(`ChaosClip ${env.VERSION} prêt sur ${url}`);
      ytdlp.ensure().catch(() => {});
      series.resume();
      if (open) {
        const [cmd, args] = env.IS_WIN ? ['cmd', ['/c', 'start', '', url]]
          : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      }
      resolve({ server, url });
    });
    server.on('error', reject);
  });
}

if (require.main === module) start();

module.exports = { app, start };
