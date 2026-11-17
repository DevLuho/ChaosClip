// Envoi d'un export vers Chaos Tools › ChaosBooru, avec le jeton de connexion du membre.
// Le jeton reste dans data/booru.json (sur ce PC seulement), jamais dans les réglages renvoyés à la page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const secrets = require('./secrets');
const { Cancelled } = require('./proc');

const BASE = (process.env.CHAOSTOOLS_URL || 'https://chaos-tools-rp.fly.dev').replace(/\/$/, '');
const API = `${BASE}/api/chaosbooru`;
// Formats acceptés par ChaosBooru (JPEG, PNG non animé, GIF, WebP).
const FORMATS = ['gif', 'webp', 'png'];
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function token() {
  const connection = store.read('booru', {});
  if (typeof connection.token === 'string') {
    const sealed = secrets.seal(connection.token);
    if (typeof sealed !== 'string') store.write('booru', { ...connection, token: sealed });
  }
  return secrets.open(connection.token);
}

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
    throw Object.assign(new Error(`ChaosBooru : ${data.error || `erreur ${r.status}`}${fields}`), { status: r.status, code: data.code });
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
  const me = await call(`${BASE}/api/auth/me`, { tok });
  store.write('booru', { token: secrets.seal(tok), account: String(me.userId ?? me.id ?? me.user?.id ?? me.username ?? '') });
  catalogueCache = null;
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
const preview = (body, tok) => call(`${API}/classement/apercu`, { method: 'POST', body: draftState(body), tok });

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
const resultFor = (v) => ({ versionId: v.id, resourceId: v.resource_id, state: v.state, url: `${BASE}/engine/chaosbooru/contributions/${v.id}` });
function checkAccount(transfer) {
  const account = store.read('booru', {}).account;
  if (transfer.account && account && transfer.account !== account) {
    throw new Error('Reconnecte le compte Chaos Tools qui a créé cette contribution.');
  }
  return account;
}

async function publication(transfer) {
  if (!transfer.versionId) throw new Error('La contribution n’a pas encore été créée.');
  checkAccount(transfer);
  return resultFor(await call(`${API}/versions/${transfer.versionId}`));
}

async function checkWebp(entry) {
  if (entry.format !== 'webp') return;
  const { inspectWebpMetadata } = await import('./booru-file-metadata.mjs');
  const handle = await fs.promises.open(entry.path, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (offset, length) => {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return buffer;
    };
    const info = await inspectWebpMetadata(read, size);
    if (!info) throw new Error('WebP illisible.');
    const frames = info.chunks.filter((chunk) => chunk.kind === 'ANMF').length || 1;
    if (frames > 1500) throw new Error('ChaosBooru accepte au maximum 1 500 images par animation.');
    const header = info.chunks.find((chunk) => chunk.kind === 'VP8X');
    if (header && header.length !== 10) throw new Error('En-tête WebP illisible.');
    const extended = header && await read(header.offset + 8, 10);
    const w = extended ? extended.readUIntLE(4, 3) + 1 : entry.size?.w;
    const h = extended ? extended.readUIntLE(7, 3) + 1 : entry.size?.h;
    if (w > 6000 || h > 6000 || w * h * frames > (frames === 1 ? 24000000 : 1600000000)) {
      throw new Error('Les dimensions ou le nombre de pixels de ce WebP dépassent la limite de ChaosBooru.');
    }
    const lossless = info.chunks.find((chunk) => chunk.kind === 'VP8L');
    const flags = lossless?.length >= 5 && await read(lossless.offset + 8, 5);
    return { hasAlpha: !!(extended?.[0] & 16) || info.chunks.some((chunk) => chunk.kind === 'ALPH') || !!(flags?.[4] & 16) };
  } finally { await handle.close(); }
}

async function portable(entry, body) {
  const lists = await catalogues();
  const hasWork = lists[0].items.some((item) => body.entities?.includes(item.id));
  const p = await preview({ ...body, origin: body.origin || (hasWork ? 'identified' : 'unknown'), sourceUnknown: !body.sourceUrl });
  if (!p.valid || Object.keys(p.fields || {}).length) {
    throw new Error(Object.values(p.fields || {}).join(' ') || 'Vérifie le classement dans l’éditeur ChaosBooru.');
  }
  const { hasAlpha } = await checkWebp(entry);
  const byId = new Map(lists.flatMap((list, index) => list.items.map((item) => [item.id, { ...item, kind: KINDS[index] }])));
  const entities = p.entities.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error('Recharge le catalogue ChaosBooru avant d’exporter le classement.');
    const work = item.works?.length === 1 && byId.get(item.works[0])?.name;
    return { kind: item.kind, name: item.name, ...(work && ['personnages', 'sagas'].includes(item.kind) ? { work } : {}) };
  });
  const { title, description, support, sourceUrl, credit } = p.effective;
  const { embedBooruWebp } = await import('./booru-file-metadata.mjs');
  const file = await fs.promises.readFile(entry.path);
  const data = await embedBooruWebp(file, { version: 1, title, description, support, sourceUrl, credit, entities }, {
    width: entry.size.w, height: entry.size.h, hasAlpha,
  });
  if (data.byteLength > MAX_BYTES) throw new Error('Le WebP avec classement dépasse 100 Mio.');
  return Buffer.from(data);
}

// remember(versionId) : le brouillon créé est réutilisé si l'envoi est relancé après une erreur.
async function send(job, entry, body, remember = () => {}, persist = () => {}) {
  if (!FORMATS.includes(entry.format)) throw new Error('ChaosBooru accepte les GIF, WebP et PNG : exporte dans un de ces formats');
  if (!fs.existsSync(entry.path)) throw new Error('Le fichier exporté n’existe plus');
  if (fs.statSync(entry.path).size > MAX_BYTES) throw new Error('ChaosBooru limite les fichiers à 100 Mo');
  const step = (progress, message) => {
    if (job.cancelled) throw new Cancelled();
    Object.assign(job, { progress, message });
  };

  const transfer = { ...entry.booru };
  const account = checkAccount(transfer);
  const tok = token();
  const remote = (url, options) => call(url, { ...options, tok });
  const checkpoint = (patch) => { Object.assign(transfer, { account, ...patch }); persist(transfer); };
  const remoteVersion = () => remote(`${API}/versions/${transfer.versionId}`);
  let v = transfer.versionId ? await remoteVersion() : null;
  if (v && !['draft', 'changes_requested'].includes(v.state)) {
    const result = resultFor(v);
    checkpoint({ result });
    return result;
  }
  if (transfer.result?.state === 'draft' && transfer.lockVersion !== undefined && v.lock_version !== transfer.lockVersion) {
    throw new Error('Le brouillon a changé sur ChaosBooru. Ouvre son lien et vérifie la version distante.');
  }
  if (!v?.file_id) await checkWebp(entry);
  step(0.05, 'Vérification du classement');
  const p = await preview(body, tok);
  p.fields ||= {};
  const submit = body.submit !== false;
  if (!p.fields.title && p.effective.title.length < 3) p.fields.title = 'Indique un titre d’au moins 3 caractères.';
  const blocking = submit ? p.fields : { title: p.fields.title, sourceUrl: p.fields.sourceUrl, support: p.fields.support };
  const errors = Object.values(blocking).filter(Boolean);
  if (errors.length) throw new Error(`ChaosBooru : ${errors.join(' ')}`);

  step(0.1, 'Création du brouillon');
  if (!v) {
    if (!transfer.createId) checkpoint({ createId: crypto.randomUUID() });
    v = await remote(`${API}/ressources`, { method: 'POST', body: { requestId: transfer.createId } });
    checkpoint({ versionId: v.id });
    remember(v.id);
  }

  if (!v.file_id) {
    step(0.15, 'Envoi du fichier');
    let task;
    if (transfer.taskId) task = await remote(`${API}/taches/${transfer.taskId}`);
    else {
      const file = fs.readFileSync(entry.path);
      const digest = crypto.createHash('sha256').update(file).digest('hex');
      if (transfer.digest && digest !== transfer.digest) throw new Error('Le fichier a changé. Prépare une nouvelle sortie.');
      if (!transfer.uploadId) checkpoint({ uploadId: crypto.randomUUID(), digest });
      const form = new FormData();
      form.append('requestId', transfer.uploadId);
      form.append('image', new Blob([file]), path.basename(entry.path));
      task = await remote(`${API}/versions/${v.id}/fichier`, { method: 'POST', form });
      checkpoint({ taskId: task.id });
    }
    step(0.5, 'Décodage par ChaosBooru');
    const until = Date.now() + 5 * 60000;
    while (!['ready', 'failed'].includes(task.status)) {
      if (Date.now() > until) throw new Error('ChaosBooru met trop de temps à traiter le fichier : retrouve le brouillon sur le site');
      await new Promise((r) => setTimeout(r, 1000));
      step(0.6, 'Décodage par ChaosBooru');
      task = await remote(`${API}/taches/${task.id}`);
    }
    if (task.status === 'failed') {
      checkpoint({ taskId: null, uploadId: null });
      throw new Error(`ChaosBooru a refusé le fichier : ${task.error || task.error_code}`);
    }
    v = await remoteVersion();
  }

  // Même enregistrement que l'import du site : état « effectif » de l'analyse, étiquettes et assistance.
  step(0.8, 'Titre et étiquettes');
  const e = p.effective;
  v = await remote(`${API}/versions/${v.id}`, {
    method: 'PUT',
    body: {
      title: e.title, description: e.description, origin: e.origin, support: e.support, sourceUrl: e.sourceUrl, sourceUnknown: e.sourceUnknown,
      credit: e.credit, spoiler: e.spoiler, spoilerReason: e.spoilerReason, entities: [...p.entities], assistance: p.assistance, expectedVersion: v.lock_version,
    },
  });

  if (submit) {
    step(0.9, 'Soumission');
    v = await remote(`${API}/versions/${v.id}/soumettre`, { method: 'POST', body: { expectedVersion: v.lock_version } });
  }
  const result = resultFor(v);
  checkpoint({ result, lockVersion: v.lock_version });
  return result;
}

module.exports = { status, setToken, catalogues, preview, icon, send, portable, publication, BASE, FORMATS };
