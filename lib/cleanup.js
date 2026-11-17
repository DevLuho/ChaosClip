// Nettoyage des fichiers temporaires et mesure de la place occupée.
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./env');
const log = require('./log');

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try { total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch { /* fichier disparu */ }
  }
  return total;
}

function usage() {
  return Object.fromEntries(['work', 'downloads', 'exports'].map((k) => [k, dirSize(DIRS[k])]));
}

// Au démarrage : dossiers de travail orphelins, copies d'aperçu et envois de plus de maxDays.
function containsProtected(candidate, keep) {
  return [...keep].some((file) => {
    const relative = path.relative(candidate, file);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  });
}

function sweep(maxDays = 7, keep = new Set()) {
  const limit = Date.now() - maxDays * 86400e3;
  let removed = 0;
  for (const e of fs.readdirSync(DIRS.work, { withFileTypes: true })) {
    const p = path.join(DIRS.work, e.name);
    if (containsProtected(p, keep)) continue;
    try {
      const old = fs.statSync(p).mtimeMs < limit;
      if (e.name.startsWith('job-') || old) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch { /* déjà supprimé */ }
  }
  if (removed) log.info(`Nettoyage : ${removed} élément(s) temporaire(s) supprimé(s)`);
  return removed;
}

// Vidage manuel d'un dossier depuis l'interface (work ou telechargements).
function empty(kind, keep = new Set()) {
  if (!['work', 'downloads'].includes(kind)) throw new Error('Dossier non nettoyable');
  let freed = 0;
  for (const e of fs.readdirSync(DIRS[kind], { withFileTypes: true })) {
    const p = path.join(DIRS[kind], e.name);
    if (containsProtected(p, keep)) continue;
    try {
      freed += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* fichier ouvert : on passe */ }
  }
  return freed;
}

module.exports = { usage, sweep, empty };
