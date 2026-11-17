// Envoi d'un export vers Chaos Tools › ChaosBooru, avec le jeton de connexion du membre.
// Le jeton reste dans data/booru.json (sur ce PC seulement), jamais dans les réglages renvoyés à la page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { Cancelled } = require('./proc');

const BASE = (process.env.CHAOSTOOLS_URL || 'https://chaos-tools-rp.fly.dev').replace(/\/$/, '');
const API = `${BASE}/api/chaosbooru`;
// Formats acceptés par ChaosBooru (JPEG, PNG non animé, GIF, WebP).
const FORMATS = ['gif', 'webp', 'png'];
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

const token = () => store.read('booru', {}).token || null;

async function call(url, { method = 'GET', body, form, tok = token() } = {}) {
  if (!tok) throw Object.assign(new Error('Connecte-toi à Chaos Tools dans les Réglages'), { status: 401 });
  const headers = { Authorization: `Bearer ${tok}` };
  if (body) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(url, { method, headers, body: form || (body && JSON.stringify(body)), signal: AbortSignal.timeout(120000) });
  } catch { throw new Error('Chaos Tools ne répond pas : vérifie ta connexion'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error('Connexion à Chaos Tools expirée : reconnecte-toi dans les Réglages'), { status: 401 });
  if (!r.ok) {
    const fields = data.fields ? ` (${Object.values(data.fields).join(' ')})` : '';
    throw new Error(`ChaosBooru : ${data.error || `erreur ${r.status}`}${fields}`);
  }
  return data;
}

async function status() {
  if (!token()) return { connected: false, site: BASE };
  try {
    const me = await call(`${BASE}/api/auth/me`);
    return { connected: true, site: BASE, user: me.username || me.user?.username || '' };
  } catch (e) {
    return { connected: false, site: BASE, expired: e.status === 401, error: e.status === 401 ? null : e.message };
  }
}

async function setToken(raw) {
  const tok = String(raw || '').trim().replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
  if (!tok) { store.write('booru', {}); catalogueCache = null; return status(); }
  if (!JWT.test(tok)) throw Object.assign(new Error('Jeton invalide : copie la valeur de chaos_token'), { status: 400 });
  await call(`${BASE}/api/auth/me`, { tok });
  store.write('booru', { token: tok });
  return status();
}

// ---------- catalogue (tags, personnages, œuvres) ----------

let catalogueCache = null;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function loadCatalogue() {
  if (catalogueCache && Date.now() - catalogueCache.at < 10 * 60000) return catalogueCache.items;
  const kinds = ['tags', 'personnages', 'oeuvres'];
  const lists = await Promise.all(kinds.map((k) => call(`${API}/${k}`)));
  const items = lists.flatMap((l, i) => (l.items || []).map((c) => ({
    id: c.id, kind: kinds[i], name: c.name, group: c.category_name || '',
    keys: [c.name, ...(c.aliases || [])].map(fold),
  })));
  catalogueCache = { at: Date.now(), items };
  return items;
}

async function catalogue(q) {
  const items = await loadCatalogue();
  const f = fold(q).trim();
  const hit = f ? items.filter((c) => c.keys.some((k) => k.includes(f))) : items.filter((c) => c.kind === 'tags');
  // Les noms qui commencent par la recherche d'abord.
  hit.sort((a, b) => (b.keys.some((k) => k.startsWith(f)) - a.keys.some((k) => k.startsWith(f))) || a.name.localeCompare(b.name));
  return { items: hit.slice(0, 40).map(({ keys, ...c }) => c) };
}

// ---------- envoi ----------

async function send(job, entry, body) {
  if (!FORMATS.includes(entry.format)) throw new Error('ChaosBooru accepte les GIF, WebP et PNG : exporte dans un de ces formats');
  if (!fs.existsSync(entry.path)) throw new Error('Le fichier exporté n’existe plus');
  const title = String(body.title || '').trim();
  if (title.length < 3) throw new Error('Indique un titre d’au moins 3 caractères');
  const entities = (Array.isArray(body.entities) ? body.entities : []).map(Number).filter(Number.isSafeInteger);
  const step = (progress, message) => {
    if (job.cancelled) throw new Cancelled();
    Object.assign(job, { progress, message });
  };

  step(0.05, 'Création du brouillon');
  let v = await call(`${API}/ressources`, { method: 'POST', body: { requestId: crypto.randomUUID() } });

  step(0.15, 'Envoi du fichier');
  const form = new FormData();
  form.append('requestId', crypto.randomUUID());
  form.append('image', new Blob([fs.readFileSync(entry.path)]), path.basename(entry.path));
  let task = await call(`${API}/versions/${v.id}/fichier`, { method: 'POST', form });

  step(0.5, 'Traitement par ChaosBooru');
  const until = Date.now() + 5 * 60000;
  while (!['ready', 'failed'].includes(task.status)) {
    if (Date.now() > until) throw new Error('ChaosBooru met trop de temps à traiter le fichier : retrouve le brouillon sur le site');
    await new Promise((r) => setTimeout(r, 1500));
    step(0.6, 'Traitement par ChaosBooru');
    task = await call(`${API}/taches/${task.id}`);
  }
  if (task.status === 'failed') throw new Error(`ChaosBooru a refusé le fichier : ${task.error || task.code}`);

  step(0.8, 'Titre et étiquettes');
  v = await call(`${API}/versions/${v.id}`);
  const source = /^https:\/\//.test(body.sourceUrl || '') ? body.sourceUrl : /^https:\/\//.test(entry.source?.origin || '') ? entry.source.origin : '';
  const isWork = (await loadCatalogue().catch(() => [])).some((c) => c.kind === 'oeuvres' && entities.includes(c.id));
  v = await call(`${API}/versions/${v.id}`, {
    method: 'PUT',
    body: {
      title, description: String(body.description || ''), credit: '',
      origin: isWork ? 'identified' : 'unknown', support: body.support || 'anime',
      sourceUrl: source, sourceUnknown: !source, spoiler: !!body.spoiler, spoilerReason: body.spoiler ? String(body.spoilerReason || '') : '',
      entities, expectedVersion: v.lock_version,
    },
  });

  if (body.submit !== false) {
    step(0.9, 'Soumission');
    v = await call(`${API}/versions/${v.id}/soumettre`, { method: 'POST', body: { expectedVersion: v.lock_version } });
  }
  return { versionId: v.id, resourceId: v.resource_id, state: v.state, url: `${BASE}/engine/chaosbooru/contributions/${v.id}` };
}

module.exports = { status, setToken, catalogue, send, BASE, FORMATS };
