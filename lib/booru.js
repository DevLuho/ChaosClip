// Envoi d'un export vers Chaos Tools › ChaosBooru, avec le jeton de connexion du membre.
// Le jeton reste dans data/booru.json (sur ce PC seulement), jamais dans les réglages renvoyés à la page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
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

// Cause lisible d'une erreur réseau, pour le journal : fetch la range dans `cause` (ECONNRESET, certificat refusé…).
const why = (e) => e?.cause?.code || e?.code || (e?.name === 'TimeoutError' ? 'délai dépassé' : e?.cause?.message || e?.message || String(e));

// `type` : en-tête d'un corps déjà encodé ; `plain` : message du site tel quel, sans le préfixe « ChaosBooru : ».
async function call(url, { method = 'GET', body, form, type, plain = false, tok = token() } = {}) {
  if (!tok) throw Object.assign(new Error('Connecte-toi à Chaos Tools dans les Réglages'), { status: 401 });
  const headers = { Authorization: `Bearer ${tok}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (type) headers['Content-Type'] = type;
  let r;
  try {
    r = await fetch(url, { method, headers, body: form || (body && JSON.stringify(body)), signal: AbortSignal.timeout(120000) });
  } catch (e) { throw new Error('Chaos Tools ne répond pas : vérifie ta connexion', { cause: e }); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error('Connexion à Chaos Tools expirée : reconnecte-toi dans les Réglages'), { status: 401 });
  if (!r.ok) {
    const fields = data.fields ? ` (${Object.values(data.fields).join(' ')})` : '';
    throw Object.assign(new Error(plain ? data.error || `Erreur ${r.status}` : `ChaosBooru : ${data.error || `erreur ${r.status}`}${fields}`), { status: r.status, code: data.code });
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

// Le profil tel que le site le donne à ses propres pages (identifiant, rôles) : la page « Importer un lot » du site,
// chargée dans ChaosClip, en a besoin pour savoir si le membre publie directement.
async function me() {
  const profile = await call(`${BASE}/api/auth/me`);
  return profile.user || profile;
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

// Connexion dans le navigateur du membre (appli Windows) : le parcours de l'appli Android de Chaos Tools, PKCE et code
// à usage unique de deux minutes. Le site renvoie le code par le lien fr.chaosreborn.tools://auth?code=…, que ChaosClip
// reçoit, et seul celui qui détient le vérifieur peut l'échanger contre le jeton.
function browserLogin() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return {
    url: `${BASE}/api/auth/discord?app=android&challenge=${challenge}`,
    async finish(link) {
      let code = null;
      try { code = new URL(link).searchParams.get('code'); } catch { /* lien illisible : refusé ci-dessous */ }
      if (!code) throw new Error('Lien de connexion invalide : relance la connexion');
      let r;
      try {
        r = await fetch(`${BASE}/api/auth/app/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier }), signal: AbortSignal.timeout(30000) });
      } catch (e) { throw new Error('Chaos Tools ne répond pas : vérifie ta connexion', { cause: e }); }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || typeof data.token !== 'string') throw new Error(data.error || `Connexion à Chaos Tools impossible (erreur ${r.status})`);
      return data.token;
    },
  };
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

// ---------- ChaosBoo, l'assistant de classement du site ----------

// Sans `req` : son état (activé, analyses restantes). Avec `req` : l'analyse d'un export pas encore envoyé.
// La page envoie les images déjà réduites (multipart, comme l'import en lot du site), relayées telles quelles ;
// la réponse du site (message pour le membre, code) l'est aussi, le panneau du site les lit.
const NEXUS_BYTES = 16 * 1024 * 1024; // douze instants d'1 Mo au plus, et les champs
async function nexus(req) {
  if (!req) return call(`${API}/nexus`, { plain: true });
  const type = String(req.headers['content-type'] || ''), invalid = () => Object.assign(new Error('Images à analyser invalides.'), { status: 422 });
  if (!type.startsWith('multipart/form-data;')) throw invalid();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > NEXUS_BYTES) throw invalid();
    chunks.push(chunk);
  }
  return call(`${API}/nexus/apercu`, { method: 'POST', form: Buffer.concat(chunks), type, plain: true });
}

// ---------- relais de l'API ChaosBooru ----------

// La page « Importer un lot » est celle du site, chargée telle quelle (public/js/booru-lot.js) : ses appels à
// /api/chaosbooru passent par ici, avec le jeton que ChaosClip garde pour lui. Le corps est relayé sans être lu en
// entier (un fichier peut peser 100 Mo) et la réponse du site est rendue telle quelle (statut, type, contenu).
// renderOf(nom de fichier) : la sortie de série qui porte ce nom ; ce que le site en fait est noté à côté d'elle,
// comme après un envoi par ChaosClip, pour que la série affiche son brouillon ou sa soumission.
const lotVersions = new Map(); // brouillon du site → sortie de série
async function relay(req, res, renderOf = () => null) {
  const tok = token();
  if (!tok) return res.status(401).json({ error: 'Connecte-toi à Chaos Tools dans les Réglages' });
  const endpoint = req.originalUrl.slice('/api/chaosbooru'.length);
  const type = String(req.headers['content-type'] || '');
  const headers = { Authorization: `Bearer ${tok}` };
  if (type) headers['Content-Type'] = type;
  const options = { method: req.method, headers, signal: AbortSignal.timeout(10 * 60000) };
  let head = ''; // début du corps d'un envoi de fichier : son nom s'y trouve
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (type.startsWith('application/json')) options.body = JSON.stringify(req.body);
    else {
      options.body = Readable.toWeb(req.pipe(new Transform({ transform(chunk, _encoding, done) {
        if (head.length < 4096) head += chunk.toString('latin1', 0, 4096 - head.length);
        done(null, chunk);
      } })));
      options.duplex = 'half';
    }
  }
  let r;
  try { r = await fetch(API + endpoint, options); } catch (e) {
    require('./log').warn(`ChaosBooru ${req.method} ${endpoint} : Chaos Tools injoignable (${why(e)})`);
    return res.status(502).json({ error: 'Chaos Tools ne répond pas : vérifie ta connexion' });
  }
  const data = Buffer.from(await r.arrayBuffer());
  const version = endpoint.match(/^\/versions\/(\d+)(\/fichier|\/soumettre)?(?:\?|$)/);
  if (r.ok && version && req.method !== 'GET') {
    try {
      const file = version[2] === '/fichier' && head.match(/filename="([^"]*)"/);
      const renderId = file ? renderOf(Buffer.from(file[1], 'latin1').toString('utf8')) : lotVersions.get(version[1]);
      if (renderId) {
        lotVersions.set(version[1], renderId);
        const key = 'booru-' + renderId, account = store.read('booru', {}).account;
        const result = file ? { versionId: Number(version[1]), state: 'draft', url: `${BASE}/engine/chaosbooru/contributions/${version[1]}` } : resultFor(JSON.parse(data));
        store.write(key, { ...(file ? {} : store.read(key, {})), account, versionId: result.versionId, result });
      }
    } catch { /* le suivi dans la série est un plus : la réponse du site passe quoi qu'il arrive */ }
  }
  res.status(r.status).set('Content-Type', r.headers.get('content-type') || 'application/json').send(data);
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
// lot : identifiant commun aux envois d'un même lot (les extraits d'une série), comme l'import en lot du site :
// le staff reçoit une seule notification pour tout le lot au lieu d'une par image.
async function send(job, entry, body, remember = () => {}, persist = () => {}, lot) {
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
    v = await remote(`${API}/versions/${v.id}/soumettre`, { method: 'POST', body: { expectedVersion: v.lock_version, ...(lot && { notificationBatchId: lot }) } });
  }
  const result = resultFor(v);
  checkpoint({ result, lockVersion: v.lock_version });
  return result;
}

module.exports = { why, status, me, setToken, browserLogin, catalogues, preview, icon, nexus, relay, send, portable, publication, BASE, FORMATS };
