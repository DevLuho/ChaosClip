// Export, estimation, aperçu et ajustement au poids max.
const fs = require('fs');
const path = require('path');
const { FFMPEG, GIFSICLE, DIRS } = require('./env');
const { run, id } = require('./proc');
const B = require('./build');
const fonts = require('./fonts');
const store = require('./store');
const health = require('./health');

// Prépare un dossier de travail : ffmpeg y est lancé et les filtres y lisent des chemins
// relatifs, ce qui évite l'échappement des chemins Windows (C:\…) dans -filter_complex.
async function prepare(src, n, job, widthOverride) {
  const dir = path.join(DIRS.work, `job-${id()}`);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  const extra = { fontsDir: 'fonts', dir };

  if (n.texts.length) {
    const fallback = fonts.defaultFont();
    fonts.copyFamilies(n.texts.map((t) => t.font || (fallback && fallback.family)), path.join(dir, 'fonts'));
    extra.writeText = (size) => fs.writeFileSync(path.join(dir, 'text.ass'), B.textAss(n, size, fallback ? fallback.family : 'Arial'));
    extra.writeText(B.outputSize(n, src.info, widthOverride));
    extra.textFile = 'text.ass';
  }

  if (n.subs) {
    if (n.subs.kind === 'external') {
      const ext = src.externalSubs[n.subs.index];
      if (!ext) throw new Error('Fichier de sous-titres introuvable');
      const file = `subs${path.extname(ext.path).toLowerCase() || '.ass'}`;
      fs.copyFileSync(ext.path, path.join(dir, file));
      extra.subsFile = file;
      // Décalage propre au fichier (passage téléchargé) ajouté à celui choisi.
      n.subs.offset += ext.offset || 0;
    } else {
      const sub = src.info.subtitles[n.subs.index];
      if (!sub) throw new Error('Piste de sous-titres introuvable');
      if (sub.image) extra.subsImage = true;
      else {
        const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-i', src.path, '-map', `0:s:${n.subs.index}`, 'subs.ass'], { cwd: dir, job });
        if (code !== 0) throw new Error(`Extraction des sous-titres impossible : ${err.slice(-300)}`);
        extra.subsFile = 'subs.ass';
        // Polices intégrées au MKV (fréquent pour l'animé) : sortie en erreur attendue, les polices sont quand même écrites.
        await run(FFMPEG, ['-hide_banner', '-y', '-dump_attachment:t', '', '-i', src.path], { cwd: path.join(dir, 'fonts'), job });
      }
    }
  }

  if (n.logo) {
    const logo = path.join(DIRS.work, 'logos', path.basename(n.logo.file));
    if (!fs.existsSync(logo)) throw new Error('Image du logo introuvable');
    const file = `logo${path.extname(logo)}`;
    fs.copyFileSync(logo, path.join(dir, file));
    extra.logoFile = file;
  }

  if (n.hw && B.VIDEO_FORMATS.includes(n.format)) {
    const hw = await health.hardwareEncoders();
    if (n.format === 'mp4' && hw.length) extra.hwEncoder = hw[0];
  }
  return extra;
}

async function encode(job, src, n, opts, label) {
  if (opts.writeText && opts.widthOverride) opts.writeText(B.outputSize(n, src.info, opts.widthOverride));
  const args = B.buildArgs(n, { ...opts, src: src.path, info: src.info, hasAudio: src.info.hasAudio });
  const full = B.outputDuration(n);
  const total = opts.sampleSeconds ? Math.min(opts.sampleSeconds, full) : full;
  if (job) job.message = label;
  const { code, err } = await run(FFMPEG, args, {
    cwd: opts.dir,
    job,
    onLine: (l) => {
      const m = l.match(/^out_time_us=(\d+)/);
      if (m && total && job) job.progress = Math.min(0.99, (opts.progressBase || 0) + (m[1] / 1e6 / total) * (opts.progressSpan || 1));
    },
  });
  if (code !== 0) {
    // Encodeur matériel refusé (pilote, taille) : nouvel essai en logiciel.
    if (opts.hwEncoder) return encode(job, src, n, { ...opts, hwEncoder: null }, label);
    throw new Error(`ffmpeg a échoué : ${err.slice(-800)}`);
  }
  if (n.format === 'gif' && GIFSICLE && (n.lossy || opts.lossyOverride)) {
    const lossy = opts.lossyOverride || n.lossy;
    const tmp = `${opts.out}.tmp.gif`;
    const r = await run(GIFSICLE, ['-O3', `--lossy=${lossy}`, opts.out, '-o', tmp], { job });
    if (r.code === 0) fs.renameSync(tmp, opts.out);
  }
  return fs.statSync(opts.out).size;
}

function cleanupDir(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// Estimation sur les 2 premières secondes de sortie, extrapolée à la durée totale.
async function estimate(job, src, settings) {
  const n = B.normalize(settings, src.info);
  const extra = await prepare(src, n, job);
  try {
    const dur = B.outputDuration(n);
    const sample = Math.min(dur, 2);
    const out = path.join(extra.dir, `sample.${B.EXT[n.format]}`);
    const size = await encode(job, src, n, { ...extra, out, sampleSeconds: sample }, 'Estimation…');
    const keep = path.join(DIRS.work, `preview-${id()}.${B.EXT[n.format]}`);
    fs.renameSync(out, keep);
    const bytes = ['png', 'sheet'].includes(n.format) ? size : Math.round((size * dur) / sample);
    return { estimate: true, bytes, duration: dur, sample: `/work/${path.basename(keep)}`, sampleBytes: size, format: n.format, size: B.outputSize(n, src.info) };
  } finally { cleanupDir(extra.dir); }
}

// Aperçu d'une image avec tous les réglages (palette GIF comprise).
async function previewFrame(job, src, settings, frame) {
  const n = B.normalize({ ...settings, segments: [{ start: frame, end: frame }] }, src.info);
  // Une seule image : pas de cadence, de fondu ni d'effet dans le temps (l'image pourrait être sautée).
  Object.assign(n, { pingpong: false, reverse: false, crossfade: 0, zoom: 1, fps: 0 });
  n.segments[0].speed = 1;
  n.segments[0].hold = 0;
  Object.assign(n.filters, { fadeIn: 0, fadeOut: 0, interpolate: false });
  const extra = await prepare(src, n, job);
  try {
    const ext = n.format === 'gif' ? 'gif' : 'png';
    const out = path.join(DIRS.work, `frame-${id()}.${ext}`);
    await encode(job, src, n, { ...extra, out, frameOnly: true }, 'Aperçu…');
    return { url: `/work/${path.basename(out)}` };
  } finally { cleanupDir(extra.dir); }
}

function fileName(src, n, template) {
  const t = String(template || '{titre}-{debut}-{fin}');
  const title = path.parse(src.name).name.replace(/\s*\[[\w-]{6,}\]$/, '');
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const values = {
    titre: title, debut: n.segments[0].start, fin: n.segments[n.segments.length - 1].end,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    heure: `${pad(d.getHours())}h${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    format: n.format, largeur: B.outputSize(n, src.info).w,
  };
  let name = t.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'clip';
  return name;
}

function outputDir() {
  const dir = store.read('settings', {}).outputDir;
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { /* dossier invalide : défaut */ }
  }
  return DIRS.exports;
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
  return p;
}

// Ajustement au poids max. Les leviers sont essayés dans l'ordre choisi (n.sacrifice).
async function exportClip(job, src, settings, meta = {}) {
  const n = B.normalize(settings, src.info);
  const extra = await prepare(src, n, job);
  const ext = B.EXT[n.format];
  const out = uniquePath(outputDir(), fileName(src, n, meta.nameTemplate), ext);
  const maxBytes = n.maxSizeMB * 1024 * 1024;
  const isVideo = B.VIDEO_FORMATS.includes(n.format);
  const sizable = maxBytes && !['png', 'sheet', 'mp3'].includes(n.format);
  const opts = { ...extra, out };
  const dur = B.outputDuration(n);
  const attempts = [];
  try {
    let width = B.outputSize(n, src.info).w;
    let fps = B.outFps(n);
    let quality = n.quality;
    let colors = n.colors;
    let lossy = n.lossy;

    if (sizable && isVideo) {
      const audioKbps = n.audio && src.info.hasAudio ? (n.format === 'mp4' ? 128 : 96) : 0;
      opts.bitrateKbps = Math.max(50, Math.floor((maxBytes * 8 * 0.92) / dur / 1000 - audioKbps));
    } else if (sizable) {
      // Première estimation rapide pour viser juste dès le premier vrai export.
      const sample = Math.min(dur, 2);
      const sOut = path.join(extra.dir, `sample.${ext}`);
      const s = await encode(job, src, n, { ...opts, out: sOut, sampleSeconds: sample, progressSpan: 0.2 }, 'Estimation du poids…');
      const est = (s * dur) / sample;
      if (est > maxBytes * 0.95) plan(maxBytes * 0.9 / est);
    }

    // Répartit la réduction r (< 1) sur les leviers, dans l'ordre de sacrifice.
    function plan(r) {
      for (const k of n.sacrifice) {
        if (r >= 0.999) break;
        if (k === 'width') {
          const next = Math.max(160, Math.floor(width * Math.sqrt(r)));
          r /= (next / width) ** 2;
          width = next;
        } else if (k === 'fps') {
          const next = Math.max(8, Math.floor(fps * r));
          r /= next / fps;
          fps = next;
        } else if (k === 'quality') {
          if (n.format === 'gif') {
            // Moins de couleurs puis compression avec pertes (gifsicle).
            if (GIFSICLE && lossy < 120) { lossy = Math.min(120, lossy + 60); r /= 0.7; }
            if (r < 0.999 && colors > 64) { colors = Math.max(64, Math.floor(colors / 2)); r /= 0.85; }
          } else if (quality > 20) {
            const next = Math.max(20, Math.floor(quality - 25 * (1 - r)));
            r /= 1 - (quality - next) / 100;
            quality = next;
          }
        }
      }
      // Dernier recours : on rétrécit encore.
      if (r < 0.999) width = Math.max(96, Math.floor(width * Math.sqrt(r)));
    }

    let size = 0;
    for (let i = 0; i < 6; i++) {
      Object.assign(opts, {
        widthOverride: width, fpsOverride: fps, qualityOverride: quality, colorsOverride: colors, lossyOverride: lossy,
        progressBase: sizable && !isVideo ? 0.2 : 0, progressSpan: sizable && !isVideo ? 0.8 : 1,
      });
      size = await encode(job, src, n, opts, i ? `Ajustement au poids max (essai ${i + 1})…` : 'Export…');
      attempts.push({ width, fps, quality, colors, lossy, bitrateKbps: opts.bitrateKbps, bytes: size });
      if (!sizable || size <= maxBytes) break;
      if (isVideo) opts.bitrateKbps = Math.max(30, Math.floor(opts.bitrateKbps * (maxBytes / size) * 0.9));
      else plan((maxBytes * 0.92) / size);
    }
    const file = path.basename(out);
    const entry = {
      id: id(), file, path: out, bytes: size, format: n.format, date: Date.now(),
      fitsMax: !sizable || size <= maxBytes, attempts, size: B.outputSize(n, src.info, width),
      duration: dur, source: { path: src.path, name: src.name, origin: src.origin || null }, settings,
    };
    const history = store.read('history', []);
    history.unshift(entry);
    store.write('history', history.slice(0, 300));
    return { ...entry, url: `/out/${entry.id}` };
  } catch (e) {
    fs.rm(out, { force: true }, () => {});
    throw e;
  } finally { cleanupDir(extra.dir); }
}

module.exports = { exportClip, estimate, previewFrame, fileName };
