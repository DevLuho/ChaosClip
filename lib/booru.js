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

// ---------- catalogue et classement (les mêmes données que l'éditeur du site) ----------

let catalogueCache = null;
// Dans l'ordre attendu par l'éditeur du site.
const KINDS = ['oeuvres', 'sagas', 'personnages', 'tags'];

async function catalogues() {
  if (catalogueCache && Date.now() - catalogueCache.at < 10 * 60000) return catalogueCache.lists;
  const lists = await Promise.all(KINDS.map((k) => call(`${API}/${k}`)));
  catalogueCache = { at: Date.now(), lists };
  return lists;
}

// Champs du formulaire du site, bornés ; le site refait toutes les vérifications.
function draftState(body) {
  const text = (v, max) => String(v || '').trim().slice(0, max);
  const sourceUrl = text(body.sourceUrl, 2000);
  const state = {
    title: text(body.title, 120), description: text(body.description, 2000),
    origin: ['identified', 'original', 'unknown'].includes(body.origin) ? body.origin : 'unknown',
    support: text(body.support, 20) || 'unknown', sourceUrl, sourceUnknown: sourceUrl ? !!body.sourceUnknown : true, credit: text(body.credit, 160),
    spoiler: !!body.spoiler, spoilerReason: text(body.spoilerReason, 160),
    entities: (Array.isArray(body.entities) ? body.entities : []).map(Number).filter(Number.isSafeInteger),
  };
  if (body.assistance && typeof body.assistance === 'object') state.assistance = body.assistance;
  return state;
}

// POST /classement/apercu : tags ajoutés d'office, suggestions, erreurs par champ (réponse du site telle quelle).
const preview = (body) => call(`${API}/classement/apercu`, { method: 'POST', body: draftState(body) });

// Logo ou icône du catalogue. Le site interdit leur affichage depuis une autre origine
// (Cross-Origin-Resource-Policy: same-origin) : la page les demande donc à ChaosClip, qui les relaie.
async function icon(kind, id, original) {
  if (!KINDS.includes(kind) || !Number.isSafeInteger(id)) throw Object.assign(new Error('Icône introuvable'), { status: 404 });
  const tok = token();
  const r = await fetch(`${API}/${kind}/${id}/icone${original ? '?variant=original' : ''}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {}, signal: AbortSignal.timeout(30000) });
  if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw Object.assign(new Error('Icône introuvable'), { status: 404 });
  return { type: r.headers.get('content-type'), data: Buffer.from(await r.arrayBuffer()) };
}

// ---------- envoi ----------

const MAX_BYTES = 100 * 1024 * 1024;

// remember(versionId) : le brouillon créé est réutilisé si l'envoi est relancé après une erreur.
async function send(job, entry, body, remember = () => {}) {
  if (!FORMATS.includes(entry.format)) throw new Error('ChaosBooru accepte les GIF, WebP et PNG : exporte dans un de ces formats');
  if (!fs.existsSync(entry.path)) throw new Error('Le fichier exporté n’existe plus');
  if (fs.statSync(entry.path).size > MAX_BYTES) throw new Error('ChaosBooru limite les fichiers à 100 Mo');
  const step = (progress, message) => {
    if (job.cancelled) throw new Cancelled();
    Object.assign(job, { progress, message });
  };

  step(0.05, 'Vérification du classement');
  const p = await preview(body);
  p.fields ||= {};
  const submit = body.submit !== false;
  if (!p.fields.title && p.effective.title.length < 3) p.fields.title = 'Indique un titre d’au moins 3 caractères.';
  const blocking = submit ? p.fields : { title: p.fields.title, sourceUrl: p.fields.sourceUrl, support: p.fields.support };
  const errors = Object.values(blocking).filter(Boolean);
  if (errors.length) throw new Error(`ChaosBooru : ${errors.join(' ')}`);

  step(0.1, 'Création du brouillon');
  let v = null;
  if (entry.booru?.versionId) {
    v = await call(`${API}/versions/${entry.booru.versionId}`).catch(() => null);
    if (v && !['draft', 'changes_requested'].includes(v.state)) v = null;
  }
  if (!v) {
    v = await call(`${API}/ressources`, { method: 'POST', body: { requestId: crypto.randomUUID() } });
    remember(v.id);
  }

  if (!v.file_id) {
    step(0.15, 'Envoi du fichier');
    const form = new FormData();
    form.append('requestId', crypto.randomUUID());
    form.append('image', new Blob([fs.readFileSync(entry.path)]), path.basename(entry.path));
    let task = await call(`${API}/versions/${v.id}/fichier`, { method: 'POST', form });
    step(0.5, 'Décodage par ChaosBooru');
    const until = Date.now() + 5 * 60000;
    while (!['ready', 'failed'].includes(task.status)) {
      if (Date.now() > until) throw new Error('ChaosBooru met trop de temps à traiter le fichier : retrouve le brouillon sur le site');
      await new Promise((r) => setTimeout(r, 1000));
      step(0.6, 'Décodage par ChaosBooru');
      task = await call(`${API}/taches/${task.id}`);
    }
    if (task.status === 'failed') throw new Error(`ChaosBooru a refusé le fichier : ${task.error || task.error_code}`);
    v = await call(`${API}/versions/${v.id}`);
  }

  // Même enregistrement que l'import du site : état « effectif » de l'analyse, étiquettes et assistance.
  step(0.8, 'Titre et étiquettes');
  const e = p.effective;
  v = await call(`${API}/versions/${v.id}`, {
    method: 'PUT',
    body: {
      title: e.title, description: e.description, origin: e.origin, support: e.support, sourceUrl: e.sourceUrl, sourceUnknown: e.sourceUnknown,
      credit: e.credit, spoiler: e.spoiler, spoilerReason: e.spoilerReason, entities: [...p.entities], assistance: p.assistance, expectedVersion: v.lock_version,
    },
  });

  if (submit) {
    step(0.9, 'Soumission');
    v = await call(`${API}/versions/${v.id}/soumettre`, { method: 'POST', body: { expectedVersion: v.lock_version } });
  }
  return { versionId: v.id, resourceId: v.resource_id, state: v.state, url: `${BASE}/engine/chaosbooru/contributions/${v.id}` };
}

module.exports = { status, setToken, catalogues, preview, icon, send, BASE, FORMATS };
