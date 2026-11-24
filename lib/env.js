// Chemins et binaires. CHAOSCLIP_DATA permet à l'appli Electron de ranger les données
// dans le profil utilisateur plutôt qu'à côté du code.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CHAOSCLIP_DATA || ROOT;

const DIRS = {
  bin: path.join(DATA, 'bin'),
  work: path.join(DATA, 'work'),
  data: path.join(DATA, 'data'),
  downloads: path.join(DATA, 'telechargements'),
  exports: process.env.CHAOSCLIP_EXPORTS || path.join(DATA, 'exports'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// Dans une appli empaquetée, les binaires sont hors de l'archive asar.
const unpacked = (p) => p && p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// ffmpeg complet de l'appli Windows (décodeur AV1 dav1d, build/ffmpeg.js) : dans resources/ffmpeg une fois installée,
// dans vendor/ffmpeg après « node build/ffmpeg.js » ; sinon celui de ffmpeg-static.
const shipped = (exe) => [process.resourcesPath, path.join(ROOT, 'vendor')].filter(Boolean)
  .map((dir) => path.join(dir, 'ffmpeg', exe)).find((file) => fs.existsSync(file));
const FFMPEG = process.env.FFMPEG_PATH || shipped('ffmpeg.exe') || unpacked(require('ffmpeg-static'));
const FFPROBE = process.env.FFPROBE_PATH || shipped('ffprobe.exe') || unpacked(require('ffprobe-static').path);
let GIFSICLE = process.env.GIFSICLE_PATH || null;
if (!GIFSICLE) {
  try { GIFSICLE = unpacked(require('gifsicle')); } catch { GIFSICLE = null; }
}
const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform];
const YTDLP = process.env.YTDLP_PATH || path.join(DIRS.bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const VERSION = require('../package.json').version;
const IS_WIN = process.platform === 'win32';
const VIDEOS_DIR = path.join(os.homedir(), 'Videos');

module.exports = { ROOT, DATA, DIRS, FFMPEG, FFPROBE, GIFSICLE, YTDLP, YTDLP_ASSET, VERSION, IS_WIN, VIDEOS_DIR };
