// Téléchargement via yt-dlp (installé automatiquement dans bin/).
const fs = require('fs');
const path = require('path');
const { YTDLP, YTDLP_ASSET, FFMPEG, DIRS } = require('./env');
const { run } = require('./proc');
const log = require('./log');

let ready = null;
let version = null;

function ensure() {
  if (!ready) {
    ready = (async () => {
      if (!fs.existsSync(YTDLP)) {
        if (!YTDLP_ASSET) throw new Error('Plateforme non prise en charge pour yt-dlp');
        log.info('Téléchargement de yt-dlp…');
        const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`);
        if (!r.ok) throw new Error(`Téléchargement de yt-dlp impossible (${r.status})`);
        fs.writeFileSync(YTDLP, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
      }
      version = (await run(YTDLP, ['--version'])).out.trim() || null;
    })();
    ready.catch((e) => { ready = null; log.warn(`yt-dlp : ${e.message}`); });
  }
  return ready;
}

async function update() {
  await ensure();
  const { out, err } = await run(YTDLP, ['-U']);
  version = (await run(YTDLP, ['--version'])).out.trim() || version;
  return { version, message: (out + err).trim().split('\n').pop() };
}

const getVersion = () => version;

// Options communes : cookies du navigateur (vidéos restreintes) et limite de débit.
function commonArgs(o = {}) {
  const a = ['--no-warnings', '--ffmpeg-location', path.dirname(FFMPEG)];
  if (o.cookiesBrowser) a.push('--cookies-from-browser', o.cookiesBrowser);
  return a;
}

// Infos avant téléchargement : titre, miniature, durée, qualités, langues audio, sous-titres.
async function analyze(url, o = {}, job) {
  await ensure();
  const { code, out, err } = await run(YTDLP, [...commonArgs(o), '-J', '--flat-playlist', '--', url], { job });
  if (code !== 0) throw new Error(ytError(err));
  const j = JSON.parse(out);
  if (j._type === 'playlist') {
    return {
      playlist: true, title: j.title, platform: j.extractor_key || j.extractor, count: (j.entries || []).length,
      entries: (j.entries || []).map((e) => ({ url: e.url || e.webpage_url, title: e.title, duration: e.duration })),
    };
  }
  const formats = j.formats || [];
  const heights = [...new Set(formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height).map((f) => f.height))].sort((a, b) => b - a);
  const langs = [...new Set(formats.filter((f) => f.acodec && f.acodec !== 'none' && f.language).map((f) => f.language))];
  const subs = Object.keys(j.subtitles || {}).filter((k) => k !== 'live_chat');
  const autoSubs = Object.keys(j.automatic_captions || {}).filter((k) => !k.includes('-'));
  return {
    playlist: false, title: j.title, platform: j.extractor_key || j.extractor, site: j.webpage_url_domain || null, thumbnail: j.thumbnail, duration: j.duration, uploader: j.uploader,
    heights, audioLangs: langs, subtitles: subs, autoSubtitles: autoSubs.slice(0, 30),
    fps: Math.max(0, ...formats.map((f) => f.fps || 0)) || null,
  };
}

function ytError(err) {
  const lines = err.split('\n').filter((l) => /ERROR/.test(l));
  let msg = lines.join(' ') || err.slice(-300);
  if (/Sign in to confirm|age|members-only|cookies/i.test(msg)) msg += ' — Essaie avec les cookies de ton navigateur (réglages de téléchargement).';
  if (/Unsupported URL/i.test(msg)) msg = 'Ce site n’est pas pris en charge par yt-dlp (liste : github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).';
  if (/Private video|private/i.test(msg) && !/cookies/.test(msg)) msg += ' — Vidéo privée : connecte-toi sur le site dans ton navigateur puis active les cookies.';
  if (/DRM/i.test(msg)) msg = 'Cette vidéo est protégée par DRM : ChaosClip ne peut pas la télécharger.';
  return `yt-dlp : ${msg}`;
}

const hms = (s) => {
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`;
};

// o : { height, audioLang, section: {start, end} (secondes), rateLimit ('5M'), cookiesBrowser, subLangs: [] }
async function download(job, url, o = {}) {
  job.message = 'Préparation de yt-dlp…';
  await ensure();
  const h = Number(o.height) > 0 ? `[height<=${Number(o.height)}]` : '';
  const lang = o.audioLang ? `[language^=${String(o.audioLang).replace(/[^\w-]/g, '')}]` : '';
  const fmt = `bv*${h}+ba${lang}/bv*${h}+ba/b${h}/b`;
  const args = [
    ...commonArgs(o),
    '--no-playlist', '--newline', '--no-mtime', '--continue',
    '-f', fmt,
    '-P', DIRS.downloads,
    '-o', '%(title).120B [%(id)s]%(section_start&-{}|)s.%(ext)s',
    '--print', 'after_move:filepath',
  ];
  if (o.rateLimit) args.push('-r', String(o.rateLimit).replace(/[^\dKMG.]/gi, ''));
  if (o.section && Number(o.section.end) > Number(o.section.start)) {
    args.push('--download-sections', `*${hms(Number(o.section.start))}-${hms(Number(o.section.end))}`, '--force-keyframes-at-cuts');
  }
  if (o.subLangs && o.subLangs.length) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', o.subLangs.join(','), '--convert-subs', 'ass');
  }
  args.push('--', url);
  let file = null;
  const { code, err } = await run(YTDLP, args, {
    job,
    onLine: (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) { job.progress = Number(m[1]) / 100; job.message = line.replace('[download]', '').trim(); }
      else if (line.startsWith('[Merger]')) job.message = 'Fusion vidéo + audio…';
      else if (path.isAbsolute(line.trim()) && fs.existsSync(line.trim())) file = line.trim();
    },
  });
  if (code !== 0 || !file) throw new Error(ytError(err));
  // Sous-titres écrits à côté : « titre [id].fr.ass ».
  const base = file.replace(/\.[^.]+$/, '');
  const subs = fs.readdirSync(path.dirname(file))
    .filter((f) => f.startsWith(path.basename(base) + '.') && f.endsWith('.ass'))
    .map((f) => ({ path: path.join(path.dirname(file), f), label: f.slice(path.basename(base).length + 1, -4) }));
  return { file, subs, offset: o.section ? Number(o.section.start) || 0 : 0 };
}

module.exports = { ensure, update, getVersion, analyze, download };
