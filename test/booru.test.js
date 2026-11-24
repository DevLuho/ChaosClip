// Envoi vers ChaosBooru contre un faux Chaos Tools (mêmes routes et mêmes champs que le vrai).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosclip-booru-'));
process.env.CHAOSCLIP_DATA = path.join(tmp, 'data');

const TOKEN = 'aaa.bbb.ccc';
const seen = { put: null, submitted: false, bytes: 0, created: 0, previews: [], uploads: 0 };
const fake = express();
fake.use(express.json());
// Fichier de page public (sans connexion) : servi une fois, puis en panne, pour le miroir de lib/site.js.
let pageHits = 0;
fake.get('/js/views/page.js', (req, res) => (pageHits++ ? res.status(503).end() : res.type('js').send('export const v = 1;')));
fake.get('/assets/images/chaos-nexus-etoiles-anime.webp', (req, res) => res.type('image/webp').send(Buffer.from('RIFF....WEBP')));
fake.use((req, res, next) => (req.headers.authorization === `Bearer ${TOKEN}` ? next() : res.status(401).json({ error: 'Non connecté' })));
fake.get('/api/auth/me', (req, res) => res.json({ username: 'Meluho' }));
fake.get('/api/chaosbooru/tags', (req, res) => res.json({ items: [{ id: 1, name: 'Combat', aliases: ['baston'], category_name: 'Contenu' }, { id: 9, name: "Capture d'anime", aliases: [] }] }));
fake.get('/api/chaosbooru/personnages', (req, res) => res.json({ items: [{ id: 2, name: 'Gojō Satoru', aliases: [] }] }));
fake.get('/api/chaosbooru/oeuvres', (req, res) => res.json({ items: [{ id: 3, name: 'Jujutsu Kaisen', aliases: ['JJK'] }] }));
fake.get('/api/chaosbooru/sagas', (req, res) => res.json({ items: [] }));
// Analyse du site : le support « anime » ajoute le tag 9 ; sans tag ni support, il manque des tags.
fake.post('/api/chaosbooru/classement/apercu', (req, res) => {
  const b = req.body;
  seen.previews.push(b);
  const entities = b.support === 'anime' ? [...b.entities, 9] : b.entities;
  const fields = entities.some((id) => [1, 9].includes(id)) ? {} : { tags: 'Choisis entre 1 et 30 tags.' };
  res.json({ valid: !Object.keys(fields).length, fields, entities, assistance: { enabled: true, initialized: true, manualEntityIds: b.entities, automaticTagIds: [9], excludedEntityIds: [] },
    automaticTags: b.support === 'anime' ? [{ entityId: 9 }] : [], suggestions: [{ entityId: 2, negated: false }],
    effective: { title: b.title, description: b.description, origin: b.origin, support: b.support, sourceUrl: b.sourceUrl, sourceUnknown: b.sourceUnknown, credit: b.credit, spoiler: b.spoiler, spoilerReason: b.spoilerReason },
    supportConstraint: { imposed: null } });
});
// ChaosBoo : état, puis analyse d'images envoyées en multipart (quota atteint à la deuxième).
const nexusSeen = [];
fake.get('/api/chaosbooru/nexus', (req, res) => res.json({ enabled: true, daily: 30, remaining: 4 }));
fake.post('/api/chaosbooru/nexus/apercu', (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    nexusSeen.push({ type: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') });
    if (nexusSeen.length > 1) return res.status(429).json({ error: 'ChaosBoo a déjà regardé 30 images pour toi aujourd’hui. Reviens demain.', code: 'NEXUS_QUOTA' });
    res.json({ title: 'Gojo entre en scène', tags: [{ id: 1, name: 'Combat' }], cached: false, remaining: 3 });
  });
});
let version = { id: 10, resource_id: 5, lock_version: 1, state: 'draft' };
let polls = 0;
const requests = new Set();
fake.post('/api/chaosbooru/ressources', (req, res) => {
  assert.ok(req.body.requestId);
  if (!requests.has(req.body.requestId)) {
    requests.add(req.body.requestId);
    seen.created++;
    return res.destroy(); // la création a réussi, mais le client n'a reçu aucun identifiant de version
  }
  res.status(201).json(version);
});
fake.post('/api/chaosbooru/versions/10/fichier', (req, res) => {
  assert.match(req.headers['content-type'], /multipart\/form-data/);
  req.on('data', (c) => { seen.bytes += c.length; });
  req.on('end', () => { if (++seen.uploads === 1) return res.status(202).json({ id: 'bad', status: 'failed', error: 'Décodage impossible.' }); version = { ...version, file_id: 'f', lock_version: 2 }; res.status(202).json({ id: 'task1', status: 'queued' }); });
});
fake.get('/api/chaosbooru/taches/task1', (req, res) => res.json({ id: 'task1', status: ++polls < 2 ? 'processing' : 'ready' }));
fake.get('/api/chaosbooru/versions/10', (req, res) => res.json(version));
fake.put('/api/chaosbooru/versions/10', (req, res) => {
  if (req.body.expectedVersion !== version.lock_version) return res.status(409).json({ error: 'conflit' });
  seen.put = req.body; version = { ...version, lock_version: 3 }; res.json(version);
});
fake.post('/api/chaosbooru/versions/10/soumettre', (req, res) => {
  assert.strictEqual(req.body.expectedVersion, 3);
  seen.submitted = true;
  seen.lot = req.body.notificationBatchId;
  version = { ...version, state: 'pending' };
  res.json(version);
});

let srv;
let booru;
test.before(async () => {
  srv = await new Promise((r) => { const s = fake.listen(0, '127.0.0.1', () => r(s)); });
  process.env.CHAOSTOOLS_URL = `http://127.0.0.1:${srv.address().port}`;
  booru = require('../lib/booru');
});
test.after(() => srv.close());

test('ChaosBooru : connexion, recherche et envoi complet', { timeout: 30000 }, async () => {
  assert.deepStrictEqual(await booru.status(), { connected: false, site: process.env.CHAOSTOOLS_URL });
  await assert.rejects(booru.setToken('pas un jeton'), /Jeton invalide/);
  await assert.rejects(booru.setToken('xxx.yyy.zzz'), /expirée/);
  assert.strictEqual((await booru.setToken(`Bearer ${TOKEN}`)).user, 'Meluho');
  // Le jeton n'est pas dans les réglages renvoyés à la page.
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'data', 'settings.json')));

  // Les quatre catalogues du site, dans l'ordre de son éditeur : œuvres, sagas, personnages, tags.
  assert.deepStrictEqual((await booru.catalogues()).map((l) => l.items.map((c) => c.id)), [[3], [], [2], [1, 9]]);

  const file = path.join(tmp, 'clip.gif');
  fs.writeFileSync(file, Buffer.alloc(5000, 1));
  const entry = { format: 'gif', path: file, source: { origin: 'https://youtu.be/x' } };
  await assert.rejects(booru.send({}, { ...entry, format: 'mp4' }, { title: 'abc' }), /GIF, WebP et PNG/);
  // L'analyse du site refuse avant toute création de brouillon.
  await assert.rejects(booru.send({}, entry, { title: 'Sans tag', support: 'other', entities: [] }), /Choisis entre 1 et 30 tags/);
  assert.strictEqual(seen.created, 0);
  const pv = await booru.preview({ title: 'abc', entities: [3], origin: 'identified', support: 'anime' });
  assert.deepStrictEqual(pv.automaticTags, [{ entityId: 9 }]);
  assert.deepStrictEqual(pv.suggestions.map((c) => c.entityId), [2]);
  assert.strictEqual(seen.previews.at(-1).origin, 'identified');
  assert.strictEqual(seen.previews.at(-1).sourceUnknown, true);

  // Réponse de création perdue, puis fichier refusé. Les reprises gardent le même brouillon.
  const remembered = [];
  const body = { title: 'Gojo entre en scène', entities: [1, 2, 3], spoiler: false, origin: 'identified', support: 'anime', sourceUrl: 'https://youtu.be/x', sourceUnknown: false };
  let transfer;
  const lot = '3f2c1a9e-7b4d-4e61-9a2f-5c8d0e1b6a47'; // les extraits d'une série partent dans le même lot
  const send = () => booru.send({}, { ...entry, booru: transfer }, body, (id) => remembered.push(id), (value) => { transfer = { ...value }; }, lot);
  await assert.rejects(send(), /ne répond pas/);
  assert.ok(transfer.createId);
  assert.equal(transfer.versionId, undefined);
  await assert.rejects(send(), /Décodage impossible/);
  assert.deepStrictEqual(remembered, [10]);
  const r = await send();
  assert.strictEqual(seen.created, 1);
  assert.ok(seen.bytes > 5000);
  assert.strictEqual(seen.put.origin, 'identified');
  assert.strictEqual(seen.put.support, 'anime');
  assert.strictEqual(seen.put.sourceUrl, 'https://youtu.be/x');
  assert.strictEqual(seen.put.sourceUnknown, false);
  assert.deepStrictEqual(seen.put.entities, [1, 2, 3, 9]);
  assert.deepStrictEqual(seen.put.assistance.automaticTagIds, [9]);
  assert.ok(seen.submitted);
  assert.strictEqual(seen.lot, lot);
  assert.strictEqual(r.state, 'pending');
  assert.match(r.url, /\/engine\/chaosbooru\/contributions\/10$/);
  assert.deepEqual(await send(), r);
  assert.equal(seen.created, 1);
  assert.equal(seen.uploads, 2);
});

test('ChaosBoo : état et analyse relayés avec la connexion du membre, réponse et code du site intacts', async () => {
  const { Readable } = require('node:stream');
  const request = (body, type = 'multipart/form-data; boundary=x') => Object.assign(Readable.from([Buffer.from(body, 'latin1')]), { headers: { 'content-type': type } });
  assert.deepStrictEqual(await booru.nexus(), { enabled: true, daily: 30, remaining: 4 });
  const multipart = '--x\r\nContent-Disposition: form-data; name="sha256"\r\n\r\nabc\r\n--x--\r\n';
  assert.strictEqual((await booru.nexus(request(multipart))).title, 'Gojo entre en scène');
  assert.deepStrictEqual(nexusSeen[0], { type: 'multipart/form-data; boundary=x', body: multipart });
  // Message écrit pour le membre, sans préfixe, et code lu par le panneau (visage endormi).
  await assert.rejects(booru.nexus(request(multipart)), (e) => e.status === 429 && e.code === 'NEXUS_QUOTA' && e.message.startsWith('ChaosBoo a déjà'));
  // Refusé avant tout appel : autre chose que du multipart, ou trop lourd.
  await assert.rejects(booru.nexus(request('{}', 'application/json')), { status: 422 });
  await assert.rejects(booru.nexus(request('x'.repeat(16 * 1024 * 1024 + 1))), { status: 422 });
  assert.strictEqual(nexusSeen.length, 2);
});

test('Miroir du site : fichier servi, gardé quand le site tombe, chemins bornés', async () => {
  const site = require('../lib/site');
  const file = await site.file('/js/views/page.js');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'export const v = 1;');
  fs.utimesSync(file, new Date(0), new Date(0)); // copie périmée : le site est réinterrogé, et répond 503
  assert.strictEqual(fs.readFileSync(await site.file('/js/views/page.js'), 'utf8'), 'export const v = 1;');
  assert.strictEqual(pageHits, 2);
  await assert.rejects(site.file('/js/absent.js'), /ne répond pas/);
  await assert.rejects(site.file('/api/auth/me'), /hors du miroir/);
  await assert.rejects(site.file('/js/../../secrets.js'), /hors du miroir/);
  // Les expressions de ChaosBoo, et aucune autre image du site.
  assert.ok(fs.readFileSync(await site.file('/assets/images/chaos-nexus-etoiles-anime.webp')).toString().startsWith('RIFF'));
  await assert.rejects(site.file('/assets/images/logo.webp'), /hors du miroir/);
  await assert.rejects(site.file('/assets/images/chaos-nexus.png'), /hors du miroir/);
});

test('Classement intégré lisible par un Node sans ICU (appli Android), UTF-8 invalide toujours refusé', () => {
  const { spawnSync } = require('node:child_process');
  // Comme nodejs-mobile : l'option `fatal` de TextDecoder lève une erreur.
  const code = `
    const Native = globalThis.TextDecoder;
    globalThis.TextDecoder = class extends Native { constructor(label, options = {}) { if (options.fatal) throw new TypeError('"fatal" option is not supported on Node.js compiled without ICU'); super(label, options); } };
    const { encodeBooruXmp, parseBooruXmp } = await import(${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'lib', 'booru-file-metadata.mjs')).href)});
    const xmp = encodeBooruXmp({ version: 1, title: 'Gojō à l’écran', support: 'anime', entities: [{ kind: 'tags', name: 'Combat' }] });
    const bad = Uint8Array.from(xmp); bad[10] = 0xff;
    let refused = false; try { parseBooruXmp(bad); } catch (e) { refused = /encodage XMP/.test(e.message); }
    console.log(JSON.stringify({ title: parseBooruXmp(xmp).title, refused }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), { title: 'Gojō à l’écran', refused: true });
});

test('Message affiché : celui écrit pour l’utilisateur, jamais celui d’une erreur de programmation', () => {
  const { shownError } = require('../lib/proc');
  assert.strictEqual(shownError(new Error('ChaosBooru limite les fichiers à 100 Mo')), 'ChaosBooru limite les fichiers à 100 Mo');
  assert.doesNotMatch(shownError(new TypeError('"fatal" option is not supported on Node.js compiled without ICU')), /fatal|ICU/);
  assert.doesNotMatch(shownError(new ReferenceError('x is not defined')), /defined/);
});

test('WebP avec classement portable conserve les blocs et délais de l’animation', async () => {
  const { spawnSync } = require('node:child_process');
  const file = path.join(tmp, 'portable.webp');
  const encode = spawnSync(require('ffmpeg-static'), ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=96x54:rate=12:duration=0.5', '-c:v', 'libwebp_anim', '-loop', '0', file]);
  assert.equal(encode.status, 0, encode.stderr.toString());
  const original = fs.readFileSync(file);
  const data = await booru.portable({ path: file, format: 'webp', size: { w: 96, h: 54 }, settings: {} }, {
    title: 'Titre portable', support: 'anime', entities: [3], sourceUrl: 'https://example.org/source', credit: 'Crédit',
  });
  const { inspectWebpMetadata } = await import('../lib/booru-file-metadata.mjs');
  const info = (bytes) => inspectWebpMetadata((start, len) => bytes.subarray(start, start + len), bytes.length);
  const chunks = (bytes, inspected) => inspected.chunks.filter((chunk) => ['ANIM', 'ANMF'].includes(chunk.kind))
    .map((chunk) => bytes.subarray(chunk.offset, chunk.offset + chunk.total));
  const result = await info(data);
  assert.equal(result.classification.title, 'Titre portable');
  assert.equal(result.classification.credit, 'Crédit');
  assert.deepEqual(chunks(data, result), chunks(original, await info(original)));
});
