// Analyse des fichiers et registre des sources ouvertes.
const fs = require('fs');
const path = require('path');
const { FFMPEG, FFPROBE, DIRS } = require('./env');
const { run, id } = require('./proc');

const sources = new Map();
const IMAGE_SUBS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];
// Formats que Chromium ne sait pas lire dans <video> : on prépare une copie d'aperçu.
const NEEDS_PROXY = ['gif', 'webp', 'apng', 'hevc', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'wmv3', 'vc1', 'prores', 'dnxhd', 'h263', 'flv1', 'rawvideo'];

async function probe(file) {
  const { code, err, out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  if (code !== 0) throw new Error(`Fichier illisible : ${err.slice(-300)}`);
  const data = JSON.parse(out);
  const v = data.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('Aucune piste vidéo dans ce fichier');
  const rate = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0; };
  let fps = rate(v.avg_frame_rate);
  if (!(fps > 0 && fps < 240)) fps = rate(v.r_frame_rate) || 24;
  // Rotation des vidéos de téléphone : on échange largeur et hauteur affichées.
  const rot = Math.abs(Number((v.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation || v.tags?.rotate || 0)) % 180;
  const audio = data.streams.filter((s) => s.codec_type === 'audio');
  const subs = data.streams.filter((s) => s.codec_type === 'subtitle');
  return {
    width: rot ? v.height : v.width,
    height: rot ? v.width : v.height,
    fps,
    duration: Number(data.format.duration) || Number(v.duration) || 0,
    vcodec: v.codec_name,
    pixFmt: v.pix_fmt,
    bitDepth: /10|12/.test(v.pix_fmt || '') ? 10 : 8,
    title: data.format.tags?.title || null,
    hasAudio: audio.length > 0,
    audioTracks: audio.map((s, i) => ({ index: i, label: [s.tags?.language, s.tags?.title, s.codec_name].filter(Boolean).join(' · ') })),
    subtitles: subs.map((s, i) => ({
      index: i,
      label: [s.tags?.title || s.tags?.language, s.codec_name].filter(Boolean).join(' · '),
      image: IMAGE_SUBS.includes(s.codec_name),
    })),
  };
}

async function addSource(file, extra = {}) {
  const info = await probe(file);
  const src = {
    id: id(), path: file, name: path.basename(file), info, playPath: file,
    externalSubs: [], ...extra,
  };
  sources.set(src.id, src);
  // Image fixe : <video> ne l'affiche pas, on prépare tout de suite l'aperçu (l'export part du fichier d'origine).
  if (info.width && info.duration <= 0.05 && ['png', 'mjpeg', 'webp', 'bmp', 'tiff'].includes(info.vcodec)) await makeProxy({ procs: new Set() }, src);
  return src;
}

const publicSource = (s) => ({
  id: s.id, name: s.name, path: s.path, info: s.info, proxied: s.playPath !== s.path,
  needsProxy: needsProxy(s), externalSubs: s.externalSubs.map((x, i) => ({ index: i, label: x.label })),
  origin: s.origin || null,
});

const needsProxy = (s) => s.playPath === s.path && (NEEDS_PROXY.includes(s.info.vcodec) || s.info.bitDepth > 8);

async function makeProxy(job, src, { hw } = {}) {
  const out = path.join(DIRS.work, `proxy-${src.id}.mp4`);
  const total = src.info.duration;
  job.message = 'Création d’une copie lisible par le navigateur…';
  const enc = hw ? ['-c:v', hw, '-b:v', '6M'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', src.path,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:min(720\\,ih),format=yuv420p',
    ...enc, '-g', '12', '-fps_mode', 'passthrough',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], {
    job,
    onLine: (l) => { const m = l.match(/^out_time_us=(\d+)/); if (m && total) job.progress = Math.min(1, m[1] / 1e6 / total); },
  });
  if (code !== 0) {
    if (hw) return makeProxy(job, src); // l'encodeur matériel a échoué : repli logiciel
    throw new Error(`Conversion impossible : ${err.slice(-300)}`);
  }
  src.playPath = out;
  return publicSource(src);
}


// ---------- frise de miniatures ----------

// Planche horizontale de n vignettes entre from et to (secondes). Les longues plages ne
// décodent que les images clés : beaucoup plus rapide, assez précis pour une vue d'ensemble.
async function thumbs(src, from, to, n, h) {
  const dir = path.join(DIRS.work, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const key = `${src.id}-${from.toFixed(3)}-${to.toFixed(3)}-${n}-${h}.jpg`;
  const out = path.join(dir, key);
  if (fs.existsSync(out)) return out;
  const span = Math.max(0.05, to - from);
  const fast = span > 60 ? ['-skip_frame', 'nokey'] : [];
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', ...fast, '-ss', from.toFixed(3), '-t', span.toFixed(3), '-i', src.path,
    '-vf', `fps=${(n / span).toFixed(6)},scale=-2:${h},tile=${n}x1`, '-frames:v', '1', '-q:v', '5', out]);
  if (code !== 0 || !fs.existsSync(out)) throw new Error(`Miniatures impossibles : ${err.slice(-200)}`);
  return out;
}

// ---------- changements de plan ----------

async function detectScenes(job, src, threshold = 0.3) {
  if (src.scenes && src.scenesThreshold === threshold) return src.scenes;
  const total = src.info.duration;
  job.message = 'Recherche des changements de plan…';
  const frames = [];
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', src.path, '-an', '-sn',
    '-vf', `scale=256:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], {
    job,
    onLine: (l) => {
      const m = l.match(/pts_time:([\d.]+)/);
      if (m) {
        frames.push(Math.round(Number(m[1]) * src.info.fps));
        if (total) job.progress = Math.min(0.99, Number(m[1]) / total);
      }
    },
  });
  if (code !== 0) throw new Error(`Détection impossible : ${err.slice(-200)}`);
  src.scenes = frames;
  src.scenesThreshold = threshold;
  return frames;
}

// ---------- bandes noires ----------

async function cropDetect(src, frame) {
  const t = Math.max(0, frame / src.info.fps - 1);
  const { err } = await run(FFMPEG, ['-hide_banner', '-ss', t.toFixed(3), '-i', src.path, '-t', '4', '-an', '-sn',
    '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-']);
  const all = [...err.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length) return null;
  const [, w, h, x, y] = all[all.length - 1].map(Number);
  if (w >= src.info.width && h >= src.info.height) return null;
  return { x, y, w, h };
}

// ---------- image précise ----------

async function frameImage(src, frame, maxW = 0) {
  const out = path.join(DIRS.work, `still-${src.id}-${frame}-${maxW}.png`);
  if (fs.existsSync(out)) return out;
  const ss = Math.max(0, (frame - 0.25) / src.info.fps);
  const vf = maxW ? ['-vf', `scale='min(${maxW},iw)':-2`] : [];
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-ss', ss.toFixed(6), '-i', src.path, ...vf, '-frames:v', '1', out]);
  if (code !== 0) throw new Error(`Image impossible : ${err.slice(-200)}`);
  return out;
}

// ---------- sources fabriquées : images, enregistrement d'écran ----------

// Images (dans l'ordre donné) → vidéo sans perte visible, puis source normale.
async function fromImages(job, files, fps, name) {
  const dir = path.dirname(files[0]);
  const list = path.join(dir, 'list.txt');
  const d = 1 / fps;
  // Le démuxeur concat ne prend la durée qu'entre deux fichiers : on répète le dernier.
  const lines = files.flatMap((f) => [`file '${f.replace(/'/g, "'\\''")}'`, `duration ${d.toFixed(6)}`]);
  lines.push(`file '${files[files.length - 1].replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(list, lines.join('\n'));
  const out = path.join(DIRS.work, `images-${id()}.mp4`);
  job.message = 'Assemblage des images…';
  // Toutes les images prennent la taille de la première (bandes si besoin).
  const first = await probe(files[0]).catch(() => null);
  const w = first ? first.width : 1280; const h = first ? first.height : 720;
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-g', '1', out], { job });
  if (code !== 0) throw new Error(`Assemblage impossible : ${err.slice(-300)}`);
  return addSource(out, { name: name || `Images (${files.length})`, origin: { kind: 'images' } });
}

// Enregistrement du navigateur (WebM à cadence variable) → MP4 à cadence fixe, navigable à l'image.
async function fromRecording(job, file, fps = 30) {
  const out = path.join(DIRS.work, `capture-${id()}.mp4`);
  job.message = 'Préparation de la capture…';
  const { code, err } = await run(FFMPEG, ['-hide_banner', '-y', '-i', file, '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '14', '-preset', 'veryfast', '-g', '15', '-c:a', 'aac', out], { job });
  if (code !== 0) throw new Error(`Capture illisible : ${err.slice(-300)}`);
  fs.rm(file, { force: true }, () => {});
  const d = new Date();
  return addSource(out, { name: `Capture ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR')}`, origin: { kind: 'capture' } });
}

module.exports = {
  sources, probe, addSource, publicSource, makeProxy, needsProxy, thumbs, detectScenes, cropDetect, frameImage,
  fromImages, fromRecording,
};
