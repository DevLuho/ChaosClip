const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalize, buildArgs, textAss, outputWidth, outputDuration } = require('./lib/build');

const PORT = Number(process.env.PORT) || 4870;
const ROOT = __dirname;
const DIRS = {
  bin: path.join(ROOT, 'bin'),
  work: path.join(ROOT, 'work'),
  downloads: path.join(ROOT, 'telechargements'),
  exports: path.join(ROOT, 'exports'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const FFPROBE = process.env.FFPROBE_PATH || require('ffprobe-static').path;
const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform];
const YTDLP = process.env.YTDLP_PATH || path.join(DIRS.bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const id = () => crypto.randomBytes(6).toString('hex');
const sources = new Map();
const jobs = new Map();

// ---------- processus ----------

function run(cmd, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let err = '';
    let out = '';
    let buf = '';
    const feed = (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      if (onLine) lines.forEach(onLine);
    };
    p.stdout.on('data', (c) => { out += c; feed(c.toString()); });
    p.stderr.on('data', (c) => { err = (err + c.toString()).slice(-4000); if (onLine) feed(c.toString()); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, err, out }));
  });
}

function newJob() {
  const job = { id: id(), status: 'running', progress: 0, message: '', result: null, error: null };
  jobs.set(job.id, job);
  return job;
}

function startJob(fn) {
  const job = newJob();
  fn(job).then((result) => { job.result = result; job.status = 'done'; job.progress = 1; })
    .catch((e) => { job.status = 'error'; job.error = e.message; console.error(e); });
  return job;
}

// ---------- yt-dlp ----------

let ytdlpReady = null;
function ensureYtdlp() {
  if (!ytdlpReady) {
    ytdlpReady = (async () => {
      if (fs.existsSync(YTDLP)) {
        // YouTube change souvent : on tente une mise à jour silencieuse.
        run(YTDLP, ['-U']).catch(() => {});
        return;
      }
      if (!YTDLP_ASSET) throw new Error('Plateforme non prise en charge pour yt-dlp');
      console.log('Téléchargement de yt-dlp…');
      const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`);
      if (!r.ok) throw new Error(`Téléchargement de yt-dlp impossible (${r.status})`);
      fs.writeFileSync(YTDLP, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
    })();
    ytdlpReady.catch(() => { ytdlpReady = null; });
  }
  return ytdlpReady;
}

async function download(job, url) {
  job.message = 'Préparation de yt-dlp…';
  await ensureYtdlp();
  let file = null;
  const { code, err } = await run(YTDLP, [
    '--no-playlist', '--newline', '--no-mtime',
    // Meilleure vidéo + meilleur son, fusionnés par ffmpeg.
    '-f', 'bv*+ba/b',
    '--ffmpeg-location', path.dirname(FFMPEG),
    '-P', DIRS.downloads,
    '-o', '%(title).150B [%(id)s].%(ext)s',
    '--print', 'after_move:filepath',
    '--', url,
  ], {
    onLine: (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) { job.progress = Number(m[1]) / 100; job.message = line.replace('[download]', '').trim(); }
      else if (line.startsWith('[Merger]')) job.message = 'Fusion vidéo + audio…';
      else if (path.isAbsolute(line.trim()) && fs.existsSync(line.trim())) file = line.trim();
    },
  });
  if (code !== 0 || !file) throw new Error(`yt-dlp a échoué : ${err.split('\n').filter((l) => /ERROR/.test(l)).join(' ') || err.slice(-300)}`);
  job.message = 'Analyse…';
  return addSource(file);
}

// ---------- sources ----------

async function probe(file) {
  const { code, err, out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  if (code !== 0) throw new Error(`Fichier illisible : ${err.slice(-300)}`);
  const data = JSON.parse(out);
  const v = data.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('Aucune piste vidéo dans ce fichier');
  const rate = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0; };
  let fps = rate(v.avg_frame_rate);
  if (!(fps > 0 && fps < 240)) fps = rate(v.r_frame_rate) || 24;
  const subs = data.streams.filter((s) => s.codec_type === 'subtitle');
  return {
    width: v.width, height: v.height, fps,
    duration: Number(data.format.duration) || Number(v.duration) || 0,
    vcodec: v.codec_name,
    hasAudio: data.streams.some((s) => s.codec_type === 'audio'),
    subtitles: subs.map((s, i) => ({
      index: i,
      label: [s.tags && (s.tags.title || s.tags.language), s.codec_name].filter(Boolean).join(' · '),
      // Les sous-titres image (PGS, VobSub) ne passent pas par libass.
      text: !['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'].includes(s.codec_name),
    })),
  };
}

async function addSource(file) {
  const info = await probe(file);
  const src = { id: id(), path: file, name: path.basename(file), info, playPath: file };
  sources.set(src.id, src);
  return publicSource(src);
}

const publicSource = (s) => ({ id: s.id, name: s.name, info: s.info, proxied: s.playPath !== s.path });

async function makeProxy(job, src) {
  const out = path.join(DIRS.work, `proxy-${src.id}.mp4`);
  const total = src.info.duration;
  job.message = 'Création d’une copie lisible par le navigateur…';
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', src.path,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:min(720\\,ih),format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '12', '-fps_mode', 'passthrough',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], {
    onLine: (l) => { const m = l.match(/^out_time_us=(\d+)/); if (m && total) job.progress = Math.min(1, m[1] / 1e6 / total); },
  });
  if (code !== 0) throw new Error(`Conversion impossible : ${err.slice(-300)}`);
  src.playPath = out;
  return publicSource(src);
}

// ---------- export ----------

// [fichier, nom de famille] : la première police présente sert au texte incrusté.
function findFont() {
  return [
    ['C:/Windows/Fonts/impact.ttf', 'Impact'], ['C:/Windows/Fonts/arialbd.ttf', 'Arial'],
    ['/System/Library/Fonts/Supplemental/Impact.ttf', 'Impact'], ['/Library/Fonts/Arial Bold.ttf', 'Arial'],
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'], ['/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
  ].find(([f]) => fs.existsSync(f)) || [null, 'Arial'];
}

// Prépare un dossier de travail : ffmpeg y est lancé et les filtres y lisent des chemins
// relatifs, ce qui évite l'échappement des chemins Windows (C:\…) dans -filter_complex.
async function prepareWorkdir(src, n) {
  const dir = path.join(DIRS.work, `job-${id()}`);
  fs.mkdirSync(dir);
  const extra = { fontsDir: 'fonts' };
  fs.mkdirSync(path.join(dir, 'fonts'));
  if (n.text) {
    const [font, family] = findFont();
    if (font) fs.copyFileSync(font, path.join(dir, 'fonts', path.basename(font)));
    fs.writeFileSync(path.join(dir, 'text.ass'), textAss(n, src.info, family));
    extra.textFile = 'text.ass';
  }
  if (n.subStream !== null) {
    const sub = src.info.subtitles[n.subStream];
    if (!sub || !sub.text) throw new Error('Cette piste de sous-titres est une image (PGS/VobSub) et ne peut pas être incrustée.');
    const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-i', src.path, '-map', `0:s:${n.subStream}`, 'subs.ass'], { cwd: dir });
    if (code !== 0) throw new Error(`Extraction des sous-titres impossible : ${err.slice(-300)}`);
    // Polices intégrées au MKV (fréquent pour l'animé) : sortie en erreur attendue, les polices sont quand même écrites.
    await run(FFMPEG, ['-hide_banner', '-y', '-dump_attachment:t', '', '-i', src.path], { cwd: path.join(dir, 'fonts') });
    extra.subsFile = 'subs.ass';
  }
  return { dir, extra };
}

async function encode(job, src, n, opts, dir, label) {
  const args = buildArgs(n, { ...opts, src: src.path, info: src.info, hasAudio: src.info.hasAudio });
  const total = opts.sampleSeconds ? Math.min(opts.sampleSeconds, outputDuration(n)) : outputDuration(n);
  job.message = label;
  const { code, err } = await run(FFMPEG, args, {
    cwd: dir,
    onLine: (l) => { const m = l.match(/^out_time_us=(\d+)/); if (m && total) job.progress = Math.min(0.99, m[1] / 1e6 / total); },
  });
  if (code !== 0) throw new Error(`ffmpeg a échoué : ${err.slice(-600)}`);
  return fs.statSync(opts.out).size;
}

async function exportClip(job, src, settings, estimate) {
  const n = normalize(settings, src.info);
  const { dir, extra } = await prepareWorkdir(src, n);
  try {
    const outDur = outputDuration(n);
    if (estimate) {
      const sample = Math.min(outDur, 2);
      const out = path.join(dir, `sample.${n.format}`);
      const size = await encode(job, src, n, { ...extra, out, sampleSeconds: sample }, dir, 'Estimation…');
      return { estimate: true, bytes: Math.round(size * outDur / sample), duration: outDur };
    }

    const base = `${path.parse(src.name).name.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'clip'}-${n.startFrame}-${n.endFrame}`;
    const file = `${base}-${Date.now().toString(36)}.${n.format}`;
    const out = path.join(DIRS.exports, file);
    const maxBytes = n.maxSizeMB * 1024 * 1024;
    const isVideo = n.format === 'mp4' || n.format === 'webm';
    const opts = { ...extra, out };
    let width = outputWidth(n, src.info);
    const attempts = [];
    if (isVideo && maxBytes) {
      const audioKbps = n.audio && src.info.hasAudio && !n.pingpong ? (n.format === 'mp4' ? 128 : 96) : 0;
      opts.bitrateKbps = Math.max(50, Math.floor(maxBytes * 8 * 0.92 / outDur / 1000 - audioKbps));
    }
    let size;
    for (let i = 0; i < 8; i++) {
      size = await encode(job, src, n, opts, dir, i ? `Ajustement pour la taille max (essai ${i + 1})…` : 'Export…');
      attempts.push({ width, fps: n.fps || n.srcFps, bitrateKbps: opts.bitrateKbps, bytes: size });
      if (!maxBytes || size <= maxBytes) break;
      if (isVideo) {
        opts.bitrateKbps = Math.max(30, Math.floor(opts.bitrateKbps * (maxBytes / size) * 0.9));
      } else {
        // GIF/WebP : on réduit d'abord la largeur, puis le FPS sous 240 px.
        const next = Math.floor(width * Math.sqrt(maxBytes / size) * 0.95);
        if (next >= 240) {
          width = next;
          opts.widthOverride = width;
        } else {
          width = Math.max(240, Math.min(width, next));
          opts.widthOverride = width;
          n.fps = Math.max(8, Math.floor((n.fps || n.srcFps) * 0.8));
        }
      }
    }
    return {
      file, url: `/exports/${encodeURIComponent(file)}`, bytes: size,
      fitsMax: !maxBytes || size <= maxBytes, attempts, format: n.format,
    };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

// ---------- HTTP ----------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/exports', express.static(DIRS.exports));

const getSource = (req, res) => {
  const s = sources.get(req.params.id);
  if (!s) res.status(404).json({ error: 'Source inconnue (le serveur a peut-être redémarré)' });
  return s;
};

// URL (http/https) ou chemin d'un fichier local.
app.post('/api/source', async (req, res) => {
  const input = String(req.body.input || '').trim().replace(/^"(.*)"$/, '$1');
  if (!input) return res.status(400).json({ error: 'Rien à charger' });
  if (/^https?:\/\//i.test(input)) {
    const job = startJob((j) => download(j, input));
    return res.json({ job: job.id });
  }
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) return res.status(400).json({ error: 'Fichier introuvable : ' + input });
  try { res.json({ source: await addSource(path.resolve(input)) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Fichier choisi dans le navigateur : envoyé en flux brut puis copié dans work/.
app.post('/api/upload', (req, res) => {
  if (req.headers['content-type'] !== 'application/octet-stream') return res.status(415).end();
  const name = path.basename(String(req.query.name || 'video')).replace(/[<>:"|?*]/g, '_');
  const file = path.join(DIRS.work, `${id()}-${name}`);
  const ws = fs.createWriteStream(file);
  req.pipe(ws);
  ws.on('finish', async () => {
    try { res.json({ source: await addSource(file) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  ws.on('error', (e) => res.status(500).json({ error: e.message }));
});

app.get('/api/media/:id', (req, res) => {
  const s = getSource(req, res);
  if (s) res.sendFile(s.playPath);
});

app.post('/api/proxy/:id', (req, res) => {
  const s = getSource(req, res);
  if (s) res.json({ job: startJob((j) => makeProxy(j, s)).id });
});

app.post('/api/export/:id', (req, res) => {
  const s = getSource(req, res);
  if (s) res.json({ job: startJob((j) => exportClip(j, s, req.body.settings || {}, !!req.body.estimate)).id });
});

app.get('/api/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Tâche inconnue' });
  res.json(j);
});

app.post('/api/open-exports', (req, res) => {
  const opener = { win32: 'explorer', darwin: 'open' }[process.platform] || 'xdg-open';
  spawn(opener, [DIRS.exports], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  res.json({ ok: true });
});

if (require.main === module) {
  // 127.0.0.1 uniquement : l'appli n'est pas joignable depuis le réseau.
  app.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`ChaosClip prêt sur ${url}`);
    ensureYtdlp().catch((e) => console.warn('yt-dlp :', e.message));
    if (!process.env.NO_OPEN) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  });
}

module.exports = { app };
