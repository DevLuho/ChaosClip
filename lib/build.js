// Construit les arguments ffmpeg à partir des réglages de l'interface.
// Pur (aucun accès disque) pour pouvoir être testé.
const { frameTime, seekTime } = require('./frames');

const FORMATS = ['gif', 'webp', 'apng', 'avif', 'mp4', 'webm', 'mp3', 'png', 'sheet'];
const VIDEO_FORMATS = ['mp4', 'webm'];
const DITHERS = ['sierra2_4a', 'floyd_steinberg', 'bayer', 'sierra2', 'sierra3', 'burkes', 'atkinson', 'heckbert', 'none'];
const POSITIONS = ['tl', 'tr', 'bl', 'br', 'c'];

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const int = (v, def, min, max) => Math.round(num(v, def, min, max));
const color = (c, def) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : def);
const rect = (r, info) => {
  if (!r || !(r.w > 0) || !(r.h > 0)) return null;
  const x = int(r.x, 0, 0, info.width - 2);
  const y = int(r.y, 0, 0, info.height - 2);
  return { x, y, w: int(r.w, info.width, 2, info.width - x), h: int(r.h, info.height, 2, info.height - y) };
};

// Valide et normalise les réglages reçus du navigateur.
function normalize(s, info) {
  const fps = info.fps;
  const lastFrame = Math.max(0, (info.frameTimes?.length ?? Math.round(info.duration * fps)) - 1);
  const format = FORMATS.includes(s.format) ? s.format : 'gif';

  // Segments : la sélection simple est un segment unique.
  let segs = Array.isArray(s.segments) && s.segments.length ? s.segments : [{ start: s.startFrame, end: s.endFrame }];
  segs = segs.slice(0, 50).map((g) => {
    const start = int(g.start, 0, 0, lastFrame);
    const end = int(g.end, start, start, lastFrame);
    return { start, end, frames: end - start + 1,
      duration: frameTime(info, end + 1) - frameTime(info, start),
      speed: num(g.speed, 1, 0.1, 10), hold: num(g.hold, 0, 0, 30) };
  });
  const globalSpeed = num(s.speed, 1, 0.1, 10);
  segs.forEach((g) => { g.speed *= globalSpeed; });

  const crop = rect(s.crop, info);
  // Clés de recadrage animé : position du cadre à une image donnée (la taille reste fixe).
  const cropKeys = crop && Array.isArray(s.cropKeys)
    ? s.cropKeys.slice(0, 50).map((k) => ({
        frame: int(k.frame, 0, 0, lastFrame),
        x: int(k.x, crop.x, 0, info.width - crop.w),
        y: int(k.y, crop.y, 0, info.height - crop.h),
      })).sort((a, b) => a.frame - b.frame)
    : [];

  const f = s.filters || {};
  const texts = (Array.isArray(s.texts) ? s.texts : (s.text ? [s.text] : []))
    .filter((t) => t && String(t.content || '').trim())
    .slice(0, 20)
    .map((t) => ({
      content: String(t.content).slice(0, 500),
      start: num(t.start, 0, 0, 3600),
      end: num(t.end, 0, 0, 3600), // 0 = jusqu'à la fin
      x: num(t.x, 50, 0, 100),
      y: num(t.y, t.position === 'top' ? 8 : 90, 0, 100),
      font: String(t.font || '').slice(0, 100).replace(/[,{}\\]/g, ''),
      size: num(t.size, 9, 1, 40), // % de la hauteur
      color: color(t.color, '#ffffff'),
      outlineColor: color(t.outlineColor, '#000000'),
      outline: num(t.outline, 8, 0, 40), // % de la taille du texte
      bold: t.bold !== false,
      italic: !!t.italic,
    }));

  const subs = s.subs && ['stream', 'external'].includes(s.subs.kind) && Number.isInteger(s.subs.index) && s.subs.index >= 0
    ? { kind: s.subs.kind, index: s.subs.index, offset: num(s.subs.offset, 0, -3600, 3600) }
    : (Number.isInteger(s.subStream) && s.subStream >= 0 ? { kind: 'stream', index: s.subStream, offset: 0 } : null);

  const logo = s.logo && s.logo.file ? {
    file: String(s.logo.file),
    animated: !!s.logo.animated,
    position: POSITIONS.includes(s.logo.position) ? s.logo.position : 'br',
    size: num(s.logo.size, 15, 1, 100), // % de la largeur
    opacity: num(s.logo.opacity, 100, 0, 100),
  } : null;

  const n = {
    segments: segs,
    format,
    crop, cropKeys,
    blurZones: (Array.isArray(s.blurZones) ? s.blurZones : []).slice(0, 10).map((r) => rect(r, info)).filter(Boolean),
    rotate: [0, 90, 180, 270].includes(Number(s.rotate)) ? Number(s.rotate) : 0,
    flipH: !!s.flipH,
    flipV: !!s.flipV,
    width: int(s.width, 0, 0, 7680), // 0 = taille d'origine
    fps: num(s.fps, 0, 0, 120), // 0 = fps d'origine
    loop: int(s.loop, 0, -1, 100), // 0 = infini, -1 = une seule lecture
    pingpong: !!s.pingpong,
    reverse: !!s.reverse,
    crossfade: num(s.crossfade, 0, 0, 5),
    zoom: num(s.zoom, 1, 1, 4), // zoom progressif : facteur atteint à la fin
    filters: {
      brightness: num(f.brightness, 0, -1, 1),
      contrast: num(f.contrast, 1, 0, 3),
      saturation: num(f.saturation, 1, 0, 3),
      gamma: num(f.gamma, 1, 0.1, 3),
      sharpen: num(f.sharpen, 0, 0, 2),
      denoise: num(f.denoise, 0, 0, 10),
      deinterlace: !!f.deinterlace,
      grayscale: !!f.grayscale,
      sepia: !!f.sepia,
      fadeIn: num(f.fadeIn, 0, 0, 10),
      fadeOut: num(f.fadeOut, 0, 0, 10),
      interpolate: !!f.interpolate,
    },
    texts,
    subs,
    logo,
    transparent: s.transparent && s.transparent.color ? {
      color: color(s.transparent.color, '#00ff00'),
      similarity: num(s.transparent.similarity, 0.15, 0.01, 1),
    } : null,
    colors: int(s.colors, 256, 2, 256),
    dither: DITHERS.includes(s.dither) ? s.dither : 'sierra2_4a',
    bayerScale: int(s.bayerScale, 3, 0, 5),
    lossy: int(s.lossy, 0, 0, 200), // gifsicle --lossy
    quality: int(s.quality, defaultQuality(format), 0, 100), // webp/avif : qualité ; mp4/webm : crf
    audio: !!s.audio && ['mp4', 'webm', 'mp3'].includes(format),
    audioTrack: int(s.audioTrack, 0, 0, 50),
    hw: !!s.hw,
    sheet: { cols: int(s.sheet && s.sheet.cols, 5, 1, 30), rows: int(s.sheet && s.sheet.rows, 0, 0, 30) },
    maxSizeMB: num(s.maxSizeMB, 0, 0, 1000),
    sacrifice: Array.isArray(s.sacrifice) && s.sacrifice.length
      ? s.sacrifice.filter((k) => ['width', 'fps', 'quality'].includes(k))
      : ['width', 'fps', 'quality'],
    srcFps: fps,
  };
  // Passage plus court qu'une image de sortie (une seule image, image fixe) : le filtre fps n'en sortirait aucune.
  if (n.fps && outputDuration(n) * n.fps < 1) n.fps = 0;
  if (format === 'mp3') n.audio = true;
  // Son incompatible avec l'aller-retour et le fondu en boucle (il faudrait le dupliquer).
  if (n.pingpong || n.crossfade) n.audio = n.audio && format === 'mp3';
  return n;
}

function defaultQuality(format) {
  return { webp: 75, avif: 30, mp4: 20, webm: 30 }[format] || 75;
}

const outFps = (n) => (n.fps > 0 ? n.fps : n.srcFps);

// Durée de chaque segment en sortie, puis du clip (aller-retour et fondu compris).
function segmentDuration(g, srcFps) {
  return (g.duration ?? g.frames / srcFps) / g.speed + g.hold;
}
function outputDuration(n) {
  let d = n.segments.reduce((a, g) => a + segmentDuration(g, n.srcFps), 0);
  if (n.pingpong) d *= 2;
  if (n.crossfade && n.crossfade * 2 < d) d -= n.crossfade;
  return d;
}

// Dimensions finales (paires) : recadrage, rotation, largeur demandée (pas d'agrandissement).
function outputSize(n, info, widthOverride) {
  let w0 = n.crop ? n.crop.w : info.width;
  let h0 = n.crop ? n.crop.h : info.height;
  if (n.rotate === 90 || n.rotate === 270) [w0, h0] = [h0, w0];
  let w = widthOverride || (n.width > 0 ? Math.min(n.width, w0) : w0);
  w = Math.max(2, Math.round(w / 2) * 2);
  const h = Math.max(2, Math.round((w * h0) / w0 / 2) * 2);
  return { w, h };
}

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

const hex = (c) => `0x${c.slice(1)}`;
const f6 = (v) => Number(v).toFixed(6);

// Expression linéaire par morceaux pour la position du cadre animé (t = temps source en s).
// Placée entre apostrophes dans le graphe : les virgules n'ont pas à être échappées.
function keyExpr(keys, axis, fps, info = { fps }) {
  if (keys.length === 1) return String(keys[0][axis]);
  let expr = String(keys[keys.length - 1][axis]);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]; const b = keys[i + 1];
    const ta = frameTime(info, a.frame); const tb = frameTime(info, b.frame);
    const seg = tb > ta ? `${a[axis]}+(${b[axis] - a[axis]})*(t-${f6(ta)})/${f6(tb - ta)}` : String(b[axis]);
    expr = `if(lt(t,${f6(tb)}),${seg},${expr})`;
  }
  return `if(lt(t,${f6(frameTime(info, keys[0].frame))}),${keys[0][axis]},${expr})`;
}

// Fichier ASS des textes incrustés, aux dimensions exactes de la sortie.
function textAss(n, size, fallbackFont) {
  const bgr = (c) => `&H00${c.slice(5, 7)}${c.slice(3, 5)}${c.slice(1, 3)}`;
  const time = (s) => {
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  };
  const events = n.texts.map((t) => {
    const fs = Math.max(4, Math.round((t.size / 100) * size.h));
    const content = t.content.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
    const tags = `{\\an5\\pos(${Math.round((t.x / 100) * size.w)},${Math.round((t.y / 100) * size.h)})` +
      `\\fn${t.font || fallbackFont}\\fs${fs}\\c${bgr(t.color)}\\3c${bgr(t.outlineColor)}` +
      `\\bord${((fs * t.outline) / 100).toFixed(1)}\\b${t.bold ? 1 : 0}\\i${t.italic ? 1 : 0}}`;
    return `Dialogue: 0,${time(t.start)},${t.end > t.start ? time(t.end) : '9:59:59.00'},T,${tags}${content}`;
  });
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${size.w}`, `PlayResY: ${size.h}`, 'ScaledBorderAndShadow: yes', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV',
    `Style: T,${fallbackFont},40,&H00FFFFFF,&H00000000,&H80000000,-1,0,1,3,0,5,10,10,10`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Text',
    ...events, '',
  ].join('\n');
}

// n : réglages normalisés. opts : { src, out, info, hasAudio, bitrateKbps, sampleSeconds, widthOverride,
//   fpsOverride, colorsOverride, qualityOverride, subsFile, subsImage, fontsDir, textFile, logoFile,
//   hwEncoder, frameOnly }. Chemins des filtres relatifs au dossier de travail (cwd de ffmpeg).
function buildArgs(n, opts) {
  const fps = n.srcFps;
  const info = opts.info;
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  const graph = [];
  const vOnly = n.format !== 'mp3';
  const useAudio = n.audio && opts.hasAudio;

  // Une entrée par segment : -ss rapide et précis à l'image.
  n.segments.forEach((g) => {
    // Un quart d'image avant le début : ffmpeg garde la première image dont pts >= ss.
    const ss = seekTime(info, g.start);
    const span = info.frameTimes ? frameTime(info, g.end + 1) - ss - 0.000001 : g.frames / fps;
    args.push('-ss', f6(ss), '-t', f6(span), '-i', opts.src);
  });
  let logoInput = -1;
  if (vOnly && n.logo && opts.logoFile) {
    logoInput = n.segments.length;
    if (n.logo.animated) args.push('-ignore_loop', '0', '-i', opts.logoFile);
    else args.push('-loop', '1', '-i', opts.logoFile);
  }

  const fo = opts.fpsOverride || outFps(n);
  const size = outputSize(n, info, opts.widthOverride);

  // --- par segment ---
  n.segments.forEach((g, i) => {
    const ss = seekTime(info, g.start);
    if (vOnly) {
      const v = [];
      if (info.frameTimes && !opts.subsFile) v.push('setpts=PTS-STARTPTS');
      let label = `${i}:v:0`;
      if (opts.subsImage) {
        graph.push(`[${i}:v:0][${i}:s:${n.subs.index}]overlay=eof_action=pass[sb${i}]`);
        label = `sb${i}`;
      }
      if (opts.subsFile) {
        // Les sous-titres sont calés sur le temps de la vidéo d'origine.
        v.push(`setpts=PTS+${f6(ss - n.subs.offset)}/TB`);
        v.push(`subtitles=${opts.subsFile}${opts.fontsDir ? `:fontsdir=${opts.fontsDir}` : ''}`);
        v.push('setpts=PTS-STARTPTS');
      }
      if (n.filters.deinterlace) v.push('bwdif=mode=send_frame');
      let chain = `[${label}]${v.length ? v.join(',') : 'null'}`;
      n.blurZones.forEach((z, k) => {
        const r = Math.max(1, Math.min(40, Math.floor(Math.min(z.w, z.h) / 4)));
        const cr = Math.max(1, Math.floor(r / 2));
        chain += `[bz${i}_${k}];[bz${i}_${k}]split[bm${i}_${k}][bs${i}_${k}];` +
          `[bs${i}_${k}]crop=${z.w}:${z.h}:${z.x}:${z.y},boxblur=${r}:3:${cr}:3[bb${i}_${k}];` +
          `[bm${i}_${k}][bb${i}_${k}]overlay=${z.x}:${z.y}`;
      });
      const after = [];
      if (n.crop) {
        if (n.cropKeys.length) {
          // t est le temps du segment : on y ajoute son début pour retrouver le temps source.
          const shift = (axis) => keyExpr(n.cropKeys, axis, fps, info).replace(/\bt\b/g, `(t+${f6(frameTime(info, g.start))})`);
          after.push(`crop=${n.crop.w}:${n.crop.h}:x='${shift('x')}':y='${shift('y')}'`);
        } else after.push(`crop=${n.crop.w}:${n.crop.h}:${n.crop.x}:${n.crop.y}`);
      }
      if (g.speed !== 1) after.push(`setpts=PTS/${g.speed}`);
      // Mise à l'échelle commune avant la concaténation (les segments doivent avoir la même taille).
      after.push(n.rotate === 90 || n.rotate === 270
        ? `scale=${size.h}:${size.w}:flags=lanczos`
        : `scale=${size.w}:${size.h}:flags=lanczos`);
      after.push('setsar=1');
      // Cadence fixe par segment : nécessaire à tpad et à la concaténation.
      if (!opts.frameOnly) after.push(n.filters.interpolate && g.speed < 1
        ? `minterpolate=fps=${fo}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`
        : `fps=${fo}`);
      if (g.hold) after.push(`tpad=stop_mode=clone:stop_duration=${f6(g.hold)}`);
      graph.push(`${chain},${after.join(',')}[sv${i}]`);
    }
    if (useAudio) {
      const a = [`aresample=48000`];
      if (g.speed !== 1) a.push(atempoChain(g.speed));
      if (g.hold) a.push(`apad=pad_dur=${f6(g.hold)}`);
      graph.push(`[${i}:a:${n.audioTrack}]${a.join(',')}[sa${i}]`);
    }
  });

  const k = n.segments.length;
  const ins = n.segments.map((_, i) => `${vOnly ? `[sv${i}]` : ''}${useAudio ? `[sa${i}]` : ''}`).join('');
  graph.push(`${ins}concat=n=${k}:v=${vOnly ? 1 : 0}:a=${useAudio ? 1 : 0}${vOnly ? '[cv]' : ''}${useAudio ? '[ca]' : ''}`);

  if (useAudio && n.reverse) graph.push('[ca]areverse[ca2]');
  let aLabel = useAudio ? (n.reverse ? '[ca2]' : '[ca]') : null;
  if (aLabel && opts.sampleSeconds) {
    graph.push(`${aLabel}atrim=start=${f6(opts.sampleStart || 0)}:duration=${f6(opts.sampleSeconds)},asetpts=PTS-STARTPTS[asample]`);
    aLabel = '[asample]';
  }

  if (vOnly) {
    const v = [];
    if (n.reverse) v.push('reverse');
    let pre = `[cv]${v.length ? v.join(',') : 'null'}`;
    if (n.pingpong) pre += '[pp];[pp]split[pf][pr];[pr]reverse[prv];[pf][prv]concat=n=2:v=1:a=0';
    if (!opts.frameOnly) pre += `,fps=${fo}`;
    graph.push(`${pre}[fv]`);
    let cur = '[fv]';

    let dur = n.segments.reduce((a, g) => a + segmentDuration(g, fps), 0) * (n.pingpong ? 2 : 1);
    if (n.crossfade && n.crossfade * 2 < dur) {
      const c = n.crossfade;
      // fps après setpts : xfade exige une cadence déclarée, que setpts efface.
      graph.push(`${cur}split[xa][xb];[xa]trim=start=${f6(c)},setpts=PTS-STARTPTS,fps=${fo}[xa2];` +
        `[xb]trim=duration=${f6(c)},setpts=PTS-STARTPTS,fps=${fo}[xb2];` +
        `[xa2][xb2]xfade=transition=fade:duration=${f6(c)}:offset=${f6(dur - 2 * c)}[xf]`);
      cur = '[xf]';
      dur -= c;
    }

    const post = [];
    if (n.rotate === 90) post.push('transpose=1');
    if (n.rotate === 180) post.push('transpose=1,transpose=1');
    if (n.rotate === 270) post.push('transpose=2');
    if (n.flipH) post.push('hflip');
    if (n.flipV) post.push('vflip');
    const fl = n.filters;
    if (fl.brightness || fl.contrast !== 1 || fl.saturation !== 1 || fl.gamma !== 1) {
      post.push(`eq=brightness=${fl.brightness}:contrast=${fl.contrast}:saturation=${fl.saturation}:gamma=${fl.gamma}`);
    }
    if (fl.grayscale) post.push('hue=s=0');
    if (fl.sepia) post.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
    if (fl.denoise) post.push(`hqdn3d=${fl.denoise}`);
    if (fl.sharpen) post.push(`unsharp=5:5:${fl.sharpen}:5:5:0`);
    if (n.zoom > 1) {
      const frames = Math.max(2, Math.round(dur * fo));
      post.push(`zoompan=z='1+${n.zoom - 1}*on/${frames - 1}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size.w}x${size.h}:fps=${fo}`);
    }
    if (opts.textFile) post.push(`ass=${opts.textFile}${opts.fontsDir ? `:fontsdir=${opts.fontsDir}` : ''}`);
    graph.push(`${cur}${post.length ? post.join(',') : 'null'}[pv]`);
    cur = '[pv]';

    if (logoInput >= 0) {
      const lw = Math.max(2, Math.round((size.w * n.logo.size) / 100));
      const m = Math.round(size.w * 0.03);
      const pos = {
        tl: `${m}:${m}`, tr: `W-w-${m}:${m}`, bl: `${m}:H-h-${m}`, br: `W-w-${m}:H-h-${m}`, c: '(W-w)/2:(H-h)/2',
      }[n.logo.position];
      graph.push(`[${logoInput}:v]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${(n.logo.opacity / 100).toFixed(2)}[lg];` +
        `${cur}[lg]overlay=${pos}:shortest=1:format=auto[lv]`);
      cur = '[lv]';
    }

    const end = [];
    if (fl.fadeIn) end.push(`fade=t=in:st=0:d=${f6(fl.fadeIn)}`);
    if (fl.fadeOut) end.push(`fade=t=out:st=${f6(Math.max(0, dur - fl.fadeOut))}:d=${f6(fl.fadeOut)}`);
    const alpha = n.transparent && ['gif', 'webp', 'apng', 'webm', 'avif', 'png', 'sheet'].includes(n.format);
    if (alpha) end.push(`colorkey=${hex(n.transparent.color)}:${n.transparent.similarity}:0.05`);
    if (n.format === 'sheet') {
      const total = Math.max(1, Math.round(dur * fo));
      const cols = n.sheet.cols;
      const rows = n.sheet.rows || Math.ceil(total / cols);
      const cells = cols * rows;
      // Images réparties uniformément sur le clip.
      if (cells < total) end.push(`fps=${f6(cells / dur)}`);
      end.push(`tile=${cols}x${rows}:padding=4:margin=4`);
    }
    if (VIDEO_FORMATS.includes(n.format) || n.format === 'avif') end.push(alpha && n.format !== 'mp4' ? 'format=yuva420p' : 'format=yuv420p');
    if (opts.sampleSeconds) end.push(`trim=start=${f6(opts.sampleStart || 0)}:duration=${f6(opts.sampleSeconds)},setpts=PTS-STARTPTS`);
    let tail = `${cur}${end.length ? end.join(',') : 'null'}`;
    if (n.format === 'gif') {
      const colors = opts.colorsOverride || n.colors;
      const dither = n.dither === 'bayer' ? `bayer:bayer_scale=${n.bayerScale}` : n.dither;
      tail += `,split[pa][pb];[pa]palettegen=max_colors=${colors}:stats_mode=${opts.frameOnly ? 'full' : 'diff'}${alpha ? ':reserve_transparent=1' : ''}[pal];` +
        `[pb][pal]paletteuse=dither=${dither}:diff_mode=rectangle${alpha ? ':alpha_threshold=128' : ''}`;
    }
    graph.push(`${tail}[vout]`);
  }

  args.push('-filter_complex', graph.join(';'));
  if (vOnly) args.push('-map', '[vout]');
  if (aLabel && n.format !== 'gif') args.push('-map', aLabel);
  if (opts.sampleSeconds) args.push('-t', f6(opts.sampleSeconds));
  if (opts.frameOnly || n.format === 'png' || n.format === 'sheet') args.push('-frames:v', '1');

  const q = opts.qualityOverride ?? n.quality;
  const alpha = !!n.transparent;
  const br = opts.bitrateKbps;
  const rateArgs = (crfArgs) => (br ? ['-b:v', `${br}k`, '-maxrate', `${Math.round(br * 1.3)}k`, '-bufsize', `${br * 2}k`] : crfArgs);
  switch (n.format) {
    case 'gif':
      args.push('-loop', String(n.loop), '-f', 'gif');
      break;
    case 'webp':
      args.push('-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(q), '-compression_level', '5',
        '-loop', String(n.loop < 0 ? 1 : n.loop));
      if (alpha) args.push('-pix_fmt', 'yuva420p');
      args.push('-f', 'webp');
      break;
    case 'apng':
      // apng : -plays 0 = infini.
      args.push('-c:v', 'apng', '-plays', String(n.loop < 0 ? 1 : n.loop), '-pred', 'mixed', '-f', 'apng');
      break;
    case 'avif':
      // Qualité 0-100 ramenée à un CRF libaom 63-0.
      args.push('-c:v', 'libaom-av1', '-crf', String(Math.round(63 - (q * 63) / 100)), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1', '-f', 'avif');
      break;
    case 'mp4': {
      const hw = opts.hwEncoder;
      if (hw === 'h264_nvenc') args.push('-c:v', hw, '-preset', 'p5', ...rateArgs(['-rc', 'vbr', '-cq', String(Math.min(q, 51)), '-b:v', '0']));
      else if (hw === 'h264_qsv') args.push('-c:v', hw, ...rateArgs(['-global_quality', String(Math.min(q, 51))]));
      else if (hw === 'h264_amf') args.push('-c:v', hw, ...rateArgs(['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q)]));
      else args.push('-c:v', 'libx264', '-preset', 'slow', ...rateArgs(['-crf', String(Math.min(q, 51))]));
      if (aLabel) args.push('-c:a', 'aac', '-b:a', '128k');
      args.push('-movflags', '+faststart', '-f', 'mp4');
      break;
    }
    case 'webm':
      args.push('-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
        ...rateArgs(['-crf', String(Math.min(q, 63)), '-b:v', '0']));
      if (alpha) args.push('-pix_fmt', 'yuva420p');
      if (aLabel) args.push('-c:a', 'libopus', '-b:a', '96k');
      args.push('-f', 'webm');
      break;
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3');
      break;
    case 'png':
    case 'sheet':
      args.push('-c:v', 'png', '-f', 'image2', '-update', '1');
      break;
  }
  if (opts.frameOnly && n.format !== 'gif' && n.format !== 'png' && n.format !== 'sheet') {
    // Aperçu d'une image : on remplace la sortie par un PNG.
    const i = args.lastIndexOf('-c:v');
    if (i >= 0) args.splice(i);
    args.push('-c:v', 'png', '-f', 'image2', '-update', '1');
  }
  args.push(opts.out);
  return args;
}

const EXT = { gif: 'gif', webp: 'webp', apng: 'png', avif: 'avif', mp4: 'mp4', webm: 'webm', mp3: 'mp3', png: 'png', sheet: 'png' };

module.exports = {
  normalize, buildArgs, textAss, outputSize, outputDuration, segmentDuration, atempoChain, keyExpr,
  outFps, EXT, VIDEO_FORMATS, defaultQuality,
};
