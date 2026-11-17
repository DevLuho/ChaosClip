// Construit les arguments ffmpeg à partir des réglages de l'interface.
// Pur (aucun accès disque) pour pouvoir être testé.

const FORMATS = ['gif', 'webp', 'mp4', 'webm'];
const DITHERS = ['sierra2_4a', 'floyd_steinberg', 'bayer', 'sierra2', 'sierra3', 'burkes', 'atkinson', 'heckbert', 'none'];

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

// Valide et normalise les réglages reçus du navigateur.
function normalize(s, info) {
  const fps = info.fps;
  const startFrame = Math.round(num(s.startFrame, 0, 0, 1e9));
  const endFrame = Math.round(num(s.endFrame, startFrame, startFrame, 1e9));
  const format = FORMATS.includes(s.format) ? s.format : 'gif';
  let crop = null;
  if (s.crop && s.crop.w > 0 && s.crop.h > 0) {
    const x = Math.round(num(s.crop.x, 0, 0, info.width - 2));
    const y = Math.round(num(s.crop.y, 0, 0, info.height - 2));
    crop = {
      x, y,
      w: Math.round(num(s.crop.w, info.width, 2, info.width - x)),
      h: Math.round(num(s.crop.h, info.height, 2, info.height - y)),
    };
  }
  const text = s.text && String(s.text.content || '').trim()
    ? {
        content: String(s.text.content).slice(0, 500),
        size: Math.round(num(s.text.size, 8, 2, 30)), // % de la hauteur
        position: s.text.position === 'top' ? 'top' : 'bottom',
        color: /^#[0-9a-f]{6}$/i.test(s.text.color) ? s.text.color : '#ffffff',
      }
    : null;
  return {
    startFrame, endFrame,
    frames: endFrame - startFrame + 1,
    format,
    crop,
    width: Math.round(num(s.width, 0, 0, 7680)), // 0 = taille d'origine
    fps: num(s.fps, 0, 0, 120), // 0 = fps d'origine
    speed: num(s.speed, 1, 0.25, 4),
    loop: Math.round(num(s.loop, 0, -1, 100)), // 0 = infini, -1 = une seule lecture
    pingpong: !!s.pingpong,
    colors: Math.round(num(s.colors, 256, 2, 256)),
    dither: DITHERS.includes(s.dither) ? s.dither : 'sierra2_4a',
    bayerScale: Math.round(num(s.bayerScale, 3, 0, 5)),
    quality: Math.round(num(s.quality, format === 'webp' ? 75 : 23, 0, 100)), // webp: q, mp4/webm: crf
    audio: !!s.audio && (format === 'mp4' || format === 'webm'),
    subStream: Number.isInteger(s.subStream) && s.subStream >= 0 ? s.subStream : null,
    text,
    maxSizeMB: num(s.maxSizeMB, 0, 0, 1000),
    srcFps: fps,
  };
}

// Dimensions de sortie (avant pair-isation) pour le calcul de la taille visée.
function outputWidth(n, info) {
  const w = n.crop ? n.crop.w : info.width;
  return n.width > 0 ? Math.min(n.width, w) : w;
}

function outputDuration(n) {
  return (n.frames / n.srcFps) / n.speed * (n.pingpong ? 2 : 1);
}

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

// n: réglages normalisés. opts: { src, out, bitrateKbps, sampleSeconds, hasAudio,
// subsFile, fontsDir, fontFile, textFile } (chemins relatifs au cwd de ffmpeg pour les filtres).
function buildArgs(n, opts) {
  const fps = n.srcFps;
  // Un quart d'image avant le début : ffmpeg garde la première image dont pts >= ss.
  const ss = Math.max(0, (n.startFrame - 0.25) / fps);
  let dur = n.frames / fps;
  if (opts.sampleSeconds) dur = Math.min(dur, opts.sampleSeconds * n.speed);

  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
    '-ss', ss.toFixed(6), '-t', dur.toFixed(6), '-i', opts.src];

  const v = [];
  if (opts.subsFile) {
    // Les sous-titres sont calés sur le temps de la vidéo d'origine.
    v.push(`setpts=PTS+${ss.toFixed(6)}/TB`);
    v.push(`subtitles=${opts.subsFile}${opts.fontsDir ? `:fontsdir=${opts.fontsDir}` : ''}`);
    v.push('setpts=PTS-STARTPTS');
  }
  if (n.crop) v.push(`crop=${n.crop.w}:${n.crop.h}:${n.crop.x}:${n.crop.y}`);
  if (n.speed !== 1) v.push(`setpts=PTS/${n.speed}`);
  if (n.fps > 0) v.push(`fps=${n.fps}`);
  const w = opts.widthOverride || (n.width > 0 ? outputWidth(n, opts.info) : 0);
  // -2 : hauteur paire, requis par x264/vp9 et sans effet visible pour gif/webp.
  if (w > 0) v.push(`scale=${Math.round(w / 2) * 2}:-2:flags=lanczos`);
  else v.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  // Texte rendu par libass (drawtext n'est pas inclus dans tous les builds de ffmpeg).
  if (opts.textFile) v.push(`ass=${opts.textFile}${opts.fontsDir ? `:fontsdir=${opts.fontsDir}` : ''}`);
  if (n.format === 'mp4' || n.format === 'webm') v.push('format=yuv420p');

  let graph = `[0:v]${v.join(',')}`;
  if (n.pingpong) graph += '[fw];[fw]split[f0][r0];[r0]reverse[rv];[f0][rv]concat=n=2:v=1:a=0';
  if (n.format === 'gif') {
    const dither = n.dither === 'bayer' ? `bayer:bayer_scale=${n.bayerScale}` : n.dither;
    graph += `,split[pa][pb];[pa]palettegen=max_colors=${n.colors}:stats_mode=diff[pal];` +
      `[pb][pal]paletteuse=dither=${dither}:diff_mode=rectangle`;
  }
  graph += '[vout]';
  args.push('-filter_complex', graph, '-map', '[vout]');

  const useAudio = n.audio && !n.pingpong && opts.hasAudio;
  if (useAudio) {
    args.push('-map', '0:a:0');
    if (n.speed !== 1) args.push('-af', atempoChain(n.speed));
  }

  switch (n.format) {
    case 'gif':
      args.push('-loop', String(n.loop), '-f', 'gif');
      break;
    case 'webp':
      // webp : 0 = infini, sinon nombre total de lectures.
      args.push('-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(n.quality),
        '-compression_level', '5', '-loop', String(n.loop < 0 ? 1 : n.loop), '-f', 'webp');
      break;
    case 'mp4':
      args.push('-c:v', 'libx264', '-preset', 'slow');
      if (opts.bitrateKbps) args.push('-b:v', `${opts.bitrateKbps}k`, '-maxrate', `${Math.round(opts.bitrateKbps * 1.3)}k`, '-bufsize', `${opts.bitrateKbps * 2}k`);
      else args.push('-crf', String(Math.min(n.quality, 51)));
      if (useAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      args.push('-movflags', '+faststart', '-f', 'mp4');
      break;
    case 'webm':
      args.push('-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2');
      if (opts.bitrateKbps) args.push('-b:v', `${opts.bitrateKbps}k`, '-maxrate', `${Math.round(opts.bitrateKbps * 1.3)}k`, '-bufsize', `${opts.bitrateKbps * 2}k`);
      else args.push('-crf', String(Math.min(n.quality, 63)), '-b:v', '0');
      if (useAudio) args.push('-c:a', 'libopus', '-b:a', '96k');
      args.push('-f', 'webm');
      break;
  }
  args.push(opts.out);
  return args;
}

// Fichier ASS d'une ligne pour le texte incrusté. fontName : nom de famille de la police.
function textAss(n, info, fontName) {
  const aspect = n.crop ? n.crop.w / n.crop.h : info.width / info.height;
  const hex = n.text.color.slice(1);
  const bgr = `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
  const size = n.text.size * 10;
  const content = n.text.content.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResY: 1000', `PlayResX: ${Math.round(1000 * aspect)}`, 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV',
    `Style: T,${fontName},${size},${bgr},&H00000000,&H80000000,-1,1,${Math.max(2, size / 12).toFixed(1)},0,${n.text.position === 'top' ? 8 : 2},20,20,40`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Text',
    `Dialogue: 0,0:00:00.00,9:59:59.00,T,${content}`, '',
  ].join('\n');
}

module.exports = { textAss, normalize, buildArgs, outputWidth, outputDuration, atempoChain };
