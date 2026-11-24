// Miroir en lecture seule des fichiers de page du site Chaos Tools. La fenêtre ChaosBooru charge par ici
// l'éditeur du site lui-même (public/js/booru-page.js) : un changement là-bas arrive dans ChaosClip sans
// nouvelle version. Chaque fichier est gardé sur le disque : site injoignable, la dernière copie sert encore.
const fs = require('fs');
const path = require('path');
const { DATA } = require('./env');
const { BASE } = require('./booru');

// Scripts, feuilles de style et expressions de ChaosBoo seulement, jamais l'API ni un chemin qui remonte.
const ALLOWED = /^\/(js|assets\/css)\/[\w./-]+\.(mjs|js|css)$|^\/assets\/images\/chaos-nexus[\w-]*\.webp$/;
const FRESH = 10 * 60e3; // comme le catalogue : le site est réinterrogé au plus toutes les 10 minutes

async function file(p) {
  if (!ALLOWED.test(p) || p.includes('..')) throw Object.assign(new Error('Fichier hors du miroir'), { status: 404 });
  const cached = path.join(DATA, 'site', p);
  const age = () => { try { return Date.now() - fs.statSync(cached).mtimeMs; } catch { return Infinity; } };
  let failure = null; // gardée pour le journal si aucune copie ne peut servir
  if (age() > FRESH) {
    try {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.writeFileSync(cached, Buffer.from(await r.arrayBuffer()));
      } else failure = { code: `HTTP ${r.status}` };
    } catch (e) { failure = e; /* site injoignable : la copie gardée sert, s'il y en a une */ }
  }
  if (age() === Infinity) throw Object.assign(new Error('Chaos Tools ne répond pas : vérifie ta connexion', { cause: failure }), { status: 502 });
  return cached;
}

module.exports = { file };
