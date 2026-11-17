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
const seen = { put: null, submitted: false, bytes: 0 };
const fake = express();
fake.use(express.json());
fake.use((req, res, next) => (req.headers.authorization === `Bearer ${TOKEN}` ? next() : res.status(401).json({ error: 'Non connecté' })));
fake.get('/api/auth/me', (req, res) => res.json({ username: 'Meluho' }));
fake.get('/api/chaosbooru/tags', (req, res) => res.json({ items: [{ id: 1, name: 'Combat', aliases: ['baston'], category_name: 'Contenu' }] }));
fake.get('/api/chaosbooru/personnages', (req, res) => res.json({ items: [{ id: 2, name: 'Gojō Satoru', aliases: [] }] }));
fake.get('/api/chaosbooru/oeuvres', (req, res) => res.json({ items: [{ id: 3, name: 'Jujutsu Kaisen', aliases: ['JJK'] }] }));
let version = { id: 10, resource_id: 5, lock_version: 1, state: 'draft' };
let polls = 0;
fake.post('/api/chaosbooru/ressources', (req, res) => { assert.ok(req.body.requestId); res.status(201).json(version); });
fake.post('/api/chaosbooru/versions/10/fichier', (req, res) => {
  assert.match(req.headers['content-type'], /multipart\/form-data/);
  req.on('data', (c) => { seen.bytes += c.length; });
  req.on('end', () => { version = { ...version, lock_version: 2 }; res.status(202).json({ id: 'task1', status: 'queued' }); });
});
fake.get('/api/chaosbooru/taches/task1', (req, res) => res.json({ id: 'task1', status: ++polls < 2 ? 'processing' : 'ready' }));
fake.get('/api/chaosbooru/versions/10', (req, res) => res.json(version));
fake.put('/api/chaosbooru/versions/10', (req, res) => {
  if (req.body.expectedVersion !== version.lock_version) return res.status(409).json({ error: 'conflit' });
  seen.put = req.body; version = { ...version, lock_version: 3 }; res.json(version);
});
fake.post('/api/chaosbooru/versions/10/soumettre', (req, res) => {
  assert.strictEqual(req.body.expectedVersion, 3);
  seen.submitted = true; res.json({ ...version, state: 'pending' });
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

  assert.deepStrictEqual((await booru.catalogue('jjk')).items.map((c) => c.id), [3]);
  assert.deepStrictEqual((await booru.catalogue('gojo')).items.map((c) => c.id), [2]);
  assert.deepStrictEqual((await booru.catalogue('')).items.map((c) => c.kind), ['tags']);

  const file = path.join(tmp, 'clip.gif');
  fs.writeFileSync(file, Buffer.alloc(5000, 1));
  const entry = { format: 'gif', path: file, source: { origin: 'https://youtu.be/x' } };
  await assert.rejects(booru.send({}, { ...entry, format: 'mp4' }, { title: 'abc' }), /GIF, WebP et PNG/);
  const job = {};
  const r = await booru.send(job, entry, { title: 'Gojo entre en scène', entities: [1, 2, 3], spoiler: false });
  assert.ok(seen.bytes > 5000);
  assert.strictEqual(seen.put.origin, 'identified');
  assert.strictEqual(seen.put.support, 'anime');
  assert.strictEqual(seen.put.sourceUrl, 'https://youtu.be/x');
  assert.strictEqual(seen.put.sourceUnknown, false);
  assert.deepStrictEqual(seen.put.entities, [1, 2, 3]);
  assert.ok(seen.submitted);
  assert.strictEqual(r.state, 'pending');
  assert.match(r.url, /\/engine\/chaosbooru\/contributions\/10$/);
});
