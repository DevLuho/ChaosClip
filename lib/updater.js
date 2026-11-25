// Mise à jour depuis GitHub. Clone git : git pull + npm install. Appli installée :
// gérée par Electron (electron-updater), ce module ne fait alors que comparer les versions.
// Appli Android : l'APK de la dernière release, téléchargé ici puis installé par MainActivity.
const fs = require('fs');
const path = require('path');
const { ROOT, VERSION, IS_WIN } = require('./env');
const { run, Cancelled } = require('./proc');

const REPO = 'DevLuho/ChaosClip';
const isGit = () => fs.existsSync(path.join(ROOT, '.git'));
const packaged = () => !!process.versions.electron && ROOT.includes('app.asar');
const ANDROID = process.platform === 'android';
// L'APK de cette architecture. « npm run apk » ne joint aux releases que celui des téléphones (arm64-v8a) :
// l'émulateur (x86_64) ne trouve donc jamais le sien, et ne propose pas de mise à jour.
const apkName = (version) => `ChaosClip-${version}-${process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}-release.apk`;

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// Android : une release ne compte que si elle porte déjà l'APK (il est envoyé après l'installateur Windows).
async function checkApk(out) {
  out.mode = 'apk';
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'ChaosClip' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const release = await r.json();
      out.latest = String(release.tag_name).replace(/^v/, '');
      out.available = newer(out.latest, out.current) && release.assets.some((a) => a.name === apkName(out.latest));
    }
  } catch { /* hors ligne */ }
  return out;
}

// Télécharge l'APK là où MainActivity l'attend (install). Android vérifie lui-même, à l'installation,
// qu'il est signé avec la même clé que l'appli en place.
async function downloadApk(job) {
  const { latest, available } = await check();
  if (!available) throw new Error('ChaosClip est à jour.');
  job.message = 'Téléchargement de la mise à jour…';
  const r = await fetch(`https://github.com/${REPO}/releases/download/v${latest}/${apkName(latest)}`);
  if (!r.ok) throw new Error(`Téléchargement de la mise à jour impossible (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const file = path.join(process.env.CHAOSCLIP_APK_DIR, 'ChaosClip.apk');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(`${file}.part`, 'w');
  let done = 0;
  try {
    for await (const chunk of r.body) {
      if (job.cancelled) throw new Cancelled();
      fs.writeSync(fd, chunk);
      done += chunk.length;
      if (total) job.progress = done / total;
    }
  } finally { fs.closeSync(fd); }
  fs.renameSync(`${file}.part`, file); // ChaosClip.apk n'existe que complet
  return { install: true, message: 'Mise à jour téléchargée : Android demande de confirmer l’installation.' };
}

async function check() {
  const out = { current: VERSION, mode: packaged() ? 'installer' : isGit() ? 'git' : 'zip', latest: null, available: false };
  if (ANDROID) return checkApk(out);
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      out.latest = (await r.json()).version;
      out.available = newer(out.latest, VERSION);
    }
  } catch { /* hors ligne */ }
  if (out.mode === 'git') {
    // Même version mais nouveaux commits : on le signale aussi.
    const f = await run('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT }).catch(() => null);
    if (f && f.code === 0) {
      const c = await run('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: ROOT });
      out.commits = Number(c.out.trim()) || 0;
      if (out.commits) out.available = true;
    }
  }
  return out;
}

async function apply(job) {
  if (ANDROID) return downloadApk(job);
  if (packaged()) throw new Error('L’appli installée se met à jour toute seule au prochain démarrage.');
  if (!isGit()) throw new Error(`Télécharge la nouvelle version sur github.com/${REPO} (ou clone le dépôt avec git pour les mises à jour en un clic).`);
  job.message = 'Téléchargement de la mise à jour…';
  const pull = await run('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: ROOT, job });
  if (pull.code !== 0) throw new Error(`git pull a échoué (modifications locales ?) : ${pull.err.slice(-300)}`);
  job.message = 'Installation des dépendances…';
  const npm = await run(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, job, shell: IS_WIN });
  if (npm.code !== 0) throw new Error(`npm install a échoué : ${npm.err.slice(-300)}`);
  return { restart: true, message: 'Mise à jour installée : relance ChaosClip.' };
}

// Appli installée : un message court pour l'utilisateur à la place de l'erreur brute d'electron-updater (le détail va au journal).
function updateErrorMessage(e) {
  const m = String(e?.message || e || '');
  if (/latest\.yml|HttpError: 404/.test(m)) return 'La nouvelle version est encore en préparation. Réessaie dans quelques minutes.';
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|getaddrinfo/.test(m)) return 'Impossible de joindre GitHub. Vérifie ta connexion et réessaie.';
  return 'La vérification n’a pas abouti. Réessaie plus tard.';
}

// Notes des dernières releases pour la fenêtre « Nouveautés » de l'appli, gardées 10 min.
let notesCache = null;
async function releaseNotes() {
  if (notesCache && Date.now() - notesCache.at < 600000) return notesCache.items;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, { headers: { 'User-Agent': 'ChaosClip' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Les nouveautés sont indisponibles pour le moment.');
  const items = (await r.json()).filter((x) => !x.draft).map((x) => ({ version: String(x.tag_name).replace(/^v/, ''), date: x.published_at, notes: String(x.body || '') }));
  notesCache = { at: Date.now(), items };
  return items;
}

module.exports = { releaseNotes, check, checkApk, apkName, apply, newer, updateErrorMessage };
