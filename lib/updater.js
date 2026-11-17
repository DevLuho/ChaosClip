// Mise à jour depuis GitHub. Clone git : git pull + npm install. Appli installée :
// gérée par Electron (electron-updater), ce module ne fait alors que comparer les versions.
const fs = require('fs');
const path = require('path');
const { ROOT, VERSION, IS_WIN } = require('./env');
const { run } = require('./proc');

const REPO = 'DevLuho/ChaosClip';
const isGit = () => fs.existsSync(path.join(ROOT, '.git'));
const packaged = () => !!process.versions.electron && ROOT.includes('app.asar');

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function check() {
  const out = { current: VERSION, mode: packaged() ? 'installer' : isGit() ? 'git' : 'zip', latest: null, available: false };
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

module.exports = { check, apply, newer };
