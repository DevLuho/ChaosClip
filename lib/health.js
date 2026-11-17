// Vérification au démarrage : outils présents, encodeurs matériels, espace disque.
const fs = require('fs');
const { FFMPEG, FFPROBE, GIFSICLE, DIRS, DATA, VERSION } = require('./env');
const { run } = require('./proc');
const ytdlp = require('./ytdlp');
const fonts = require('./fonts');

let hwCache = null;

// Un encodeur matériel n'est utilisable que si un vrai encodage d'essai réussit.
async function hardwareEncoders() {
  if (hwCache) return hwCache;
  const found = [];
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']) {
    const { code } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2',
      '-c:v', enc, '-f', 'null', '-']).catch(() => ({ code: 1 }));
    if (code === 0) found.push(enc);
  }
  hwCache = found;
  return found;
}

async function version(bin, args = ['-version']) {
  try {
    const { code, out } = await run(bin, args);
    return code === 0 ? out.split('\n')[0].trim() : null;
  } catch { return null; }
}

async function check() {
  await ytdlp.ensure().catch(() => {});
  let disk = null;
  try {
    const s = fs.statfsSync(DATA);
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { /* statfs absent sur les vieux Node */ }
  return {
    version: VERSION,
    ffmpeg: await version(FFMPEG),
    ffprobe: await version(FFPROBE),
    gifsicle: GIFSICLE ? await version(GIFSICLE, ['--version']) : null,
    ytdlp: ytdlp.getVersion(),
    font: fonts.defaultFont()?.family || null,
    fontCount: fonts.list().length,
    hw: await hardwareEncoders(),
    disk,
    dirs: DIRS,
  };
}

module.exports = { check, hardwareEncoders };
