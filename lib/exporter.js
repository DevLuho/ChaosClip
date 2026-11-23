// Export, estimation, aperçu et ajustement au poids max.
const fs = require('fs');
const path = require('path');
const { FFMPEG, FFPROBE, GIFSICLE, DIRS } = require('./env');
const { run, id, Cancelled } = require('./proc');
const B = require('./build');
const fonts = require('./fonts');
const store = require('./store');
const health = require('./health');

// Prépare un dossier de travail : ffmpeg y est lancé et les filtres y lisent des chemins
// relatifs, ce qui évite l'échappement des chemins Windows (C:\…) dans -filter_complex.
// Dossiers de travail en cours d'utilisation : le nettoyage des temporaires n'y touche pas.
const activeDirs = new Set();
async function prepare(src, n, job, widthOverride) {
  const dir = path.join(DIRS.work, `job-${id()}`);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  activeDirs.add(dir);
  try { return await fill(dir, src, n, job, widthOverride); } catch (e) { cleanupDir(dir); throw e; }
}
async function fill(dir, src, n, job, widthOverride) {
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
      if (!ext || !fs.existsSync(ext.path)) throw new Error('Fichier de sous-titres introuvable');
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
  activeDirs.delete(dir);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// Conserve les rendus courts pour l'export suivant quand les paramètres correspondent.
const exactPreviews = new Map();
function previewKey(src, settings) {
  const files = [src.path];
  if (settings.logo) files.push(path.join(DIRS.work, 'logos', path.basename(settings.logo.file)));
  if (settings.subs?.kind === 'external') files.push(src.externalSubs[settings.subs.index]?.path);
  return JSON.stringify([files.map((file) => {
    const stat = file && fs.statSync(file, { throwIfNoEntry: false });
    return [file, stat?.size, stat?.mtimeMs];
  }), B.normalize(settings, src.info)]);
}

async function measure(job, src, n, extra) {
  const duration = B.outputDuration(n);
  const exact = duration <= 6 || ['png', 'sheet'].includes(n.format);
  const sampleSeconds = exact ? undefined : 1;
  const fractions = exact ? [0] : [0.1, 0.5, 0.9];
  let bytes = 0;
  let first;
  for (const [i, fraction] of fractions.entries()) {
    const out = path.join(extra.dir, `sample-${i}.${B.EXT[n.format]}`);
    const size = await encode(job, src, n, {
      ...extra, out, sampleSeconds, sampleStart: (duration - (sampleSeconds || 0)) * fraction,
      progressBase: i / fractions.length, progressSpan: 1 / fractions.length,
    }, 'Estimation…');
    first ||= { out, size };
    bytes += size;
  }
  return { bytes: exact ? bytes : Math.round((bytes * duration) / fractions.length), first, exact };
}

async function estimate(job, src, settings) {
  const n = B.normalize(settings, src.info);
  const key = previewKey(src, settings);
  const extra = await prepare(src, n, job);
  try {
    const dur = B.outputDuration(n);
    const { bytes, first, exact } = await measure(job, src, n, extra);
    const keep = path.join(DIRS.work, `preview-${id()}.${B.EXT[n.format]}`);
    fs.renameSync(first.out, keep);
    if (exact) {
      exactPreviews.set(key, keep);
      if (exactPreviews.size > 16) exactPreviews.delete(exactPreviews.keys().next().value);
    }
    return { estimate: !exact, bytes, duration: dur, sample: `/work/${path.basename(keep)}`, sampleBytes: first.size, format: n.format, size: B.outputSize(n, src.info) };
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
  const ext = B.EXT[n.format];
  const finalPath = meta.outputPath || uniquePath(outputDir(), fileName(src, n, meta.nameTemplate), ext);
  const exportId = meta.exportId || id();
  const out = path.join(path.dirname(finalPath), `.${exportId}-${id()}.part`);
  const extra = await prepare(src, n, job);
  const maxBytes = n.maxSizeMB * 1024 * 1024;
  const isVideo = B.VIDEO_FORMATS.includes(n.format);
  const sizable = maxBytes && !['png', 'sheet', 'mp3'].includes(n.format);
  const opts = { ...extra, out };
  const dur = B.outputDuration(n);
  const attempts = [];
  try {
    meta.onTemporary?.(out);
    let width = B.outputSize(n, src.info).w;
    let fps = B.outFps(n);
    let quality = n.quality;
    let colors = n.colors;
    let lossy = n.lossy;

    if (sizable && isVideo) {
      const audioKbps = n.audio && src.info.hasAudio ? (n.format === 'mp4' ? 128 : 96) : 0;
      opts.bitrateKbps = Math.max(50, Math.floor((maxBytes * 8 * 0.92) / dur / 1000 - audioKbps));
    } else if (sizable && dur > 6) {
      const { bytes: est } = await measure(job, src, n, extra);
      if (est > maxBytes * 0.95) plan(maxBytes * 0.9 / est);
    }

    // Répartit la réduction r (< 1) sur les leviers, dans l'ordre de sacrifice.
    function plan(r) {
      for (const k of n.sacrifice) {
        if (r >= 0.999) break;
        if (k === 'width') {
          const next = Math.min(width, Math.max(160, Math.floor(width * Math.sqrt(r))));
          r /= (next / width) ** 2;
          width = next;
        } else if (k === 'fps') {
          const next = Math.min(fps, Math.max(8, Math.floor(fps * r)));
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
      if (r < 0.999) width = Math.min(width, Math.max(96, Math.floor(width * Math.sqrt(r))));
    }

    let size = 0;
    for (let i = 0; i < 6; i++) {
      Object.assign(opts, {
        widthOverride: width, fpsOverride: fps, qualityOverride: quality, colorsOverride: colors, lossyOverride: lossy,
        progressBase: sizable && !isVideo ? 0.2 : 0, progressSpan: sizable && !isVideo ? 0.8 : 1,
      });
      const cached = i === 0 && !opts.bitrateKbps ? exactPreviews.get(previewKey(src, settings)) : null;
      if (cached && fs.existsSync(cached) && (!sizable || fs.statSync(cached).size <= maxBytes)) {
        fs.copyFileSync(cached, out);
        size = fs.statSync(out).size;
      } else {
        size = await encode(job, src, n, opts, i ? `Ajustement au poids max (essai ${i + 1})…` : 'Export…');
      }
      attempts.push({ width, fps, quality, colors, lossy, bitrateKbps: opts.bitrateKbps, bytes: size });
      if (!sizable || size <= maxBytes) break;
      if (isVideo) opts.bitrateKbps = Math.max(30, Math.floor(opts.bitrateKbps * (maxBytes / size) * 0.9));
      else plan((maxBytes * 0.92) / size);
    }
    if (job.cancelled) throw new Cancelled();
    // FFprobe's bundled WebP decoder cannot inspect animated WebP. For that
    // format, validate the RIFF envelope and let the successful encoder check the payload.
    if (n.format === 'webp') {
      const header = Buffer.alloc(12);
      const fd = fs.openSync(out, 'r');
      try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WEBP' || header.readUInt32LE(4) + 8 !== size) {
        throw new Error('Le WebP produit est incomplet.');
      }
    } else {
      const { code, out: streams } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { job });
      if (code || !streams.trim()) throw new Error('Le fichier produit est illisible.');
    }
    const entry = {
      id: exportId, file: path.basename(finalPath), path: finalPath, bytes: size, format: n.format, date: Date.now(),
      mtimeMs: fs.statSync(out).mtimeMs,
      fitsMax: !sizable || size <= maxBytes, attempts, size: B.outputSize(n, src.info, width),
      duration: dur, source: { path: src.path, name: src.name, origin: src.origin || null, externalSubs: src.externalSubs }, settings,
    };
    if (job.cancelled) throw new Cancelled();
    if (fs.existsSync(finalPath)) throw new Error('Ce nom de fichier est déjà utilisé.');
    meta.beforePublish?.(entry);
    fs.renameSync(out, finalPath);
    rememberExport(entry);
    return { ...entry, url: `/out/${entry.id}` };
  } catch (e) {
    fs.rm(out, { force: true }, () => {});
    fs.rm(`${out}.tmp.gif`, { force: true }, () => {});
    throw e;
  } finally { cleanupDir(extra.dir); }
}

function rememberExport(entry) {
  const history = store.read('history', []);
  if (!history.some((item) => item.id === entry.id)) store.write('history', [entry, ...history].slice(0, 1000));
}

function reserveOutput(src, settings, nameTemplate) {
  const normalized = B.normalize(settings, src.info);
  return uniquePath(outputDir(), fileName(src, normalized, nameTemplate), B.EXT[normalized.format]);
}

module.exports = { exportClip, estimate, previewFrame, fileName, rememberExport, reserveOutput, activeDirs };
