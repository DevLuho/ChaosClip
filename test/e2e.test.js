// Test de bout en bout : génère une vidéo, la charge et l'exporte via l'API.
// Lancer : npm test
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosclip-'));
process.env.CHAOSCLIP_DATA = path.join(tmp, 'data');
process.env.NO_OPEN = '1';
process.env.YTDLP_PATH = path.join(tmp, 'absent-yt-dlp');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { start } = require('../server');

// Vidéo de test : 5 s, 24 i/s, son, sous-titres texte, bandes noires en haut et en bas.
const src = path.join(tmp, 'source test.mkv');
fs.writeFileSync(path.join(tmp, 's.srt'), '1\n00:00:00,000 --> 00:00:05,000\nSous-titre de test\n');
spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
  '-f', 'lavfi', '-i', 'sine=duration=5', '-i', path.join(tmp, 's.srt'),
  '-map', '0', '-map', '1', '-map', '2', '-vf', 'pad=640:480:0:60:black',
  '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'ass', src]);
const logo = path.join(tmp, 'logo.png');
spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', logo]);

let base;
let server;
test.before(async () => { ({ server, url: base } = await start(0, { open: false })); });
test.after(() => server.close());

const H = { 'Content-Type': 'application/json', 'X-ChaosClip': '1' };
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: H, body: body && JSON.stringify(body) });
  const j = await r.json();
  assert.ok(r.ok, `${url} : ${j.error}`);
  return j;
}
const post = (u, b) => call('POST', u, b || {});
async function job(idOrResp) {
  const id = idOrResp.job || idOrResp;
  for (;;) {
    const j = await (await fetch(`${base}/api/job/${id}`)).json();
    if (j.status === 'done') return j.result;
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const probe = (file, entries = 'stream=nb_read_frames,width,height') => spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', entries, '-of', 'json', file]).stdout.toString();
const frames = (file) => Number(JSON.parse(probe(file)).streams[0].nb_read_frames);
const dims = (file) => { const s = JSON.parse(probe(file)).streams[0]; return [s.width, s.height]; };
// Empreinte des pixels de chaque image d'un fichier.
const pixels = (file, ...filter) => spawnSync(ffmpeg, ['-v', 'error', '-i', file, ...filter, '-pix_fmt', 'rgb24', '-f', 'framemd5', '-'])
  .stdout.toString().split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').pop().trim());
let received = 0;
const fetched = async (url) => {
  const file = path.join(tmp, `recu-${received++}`);
  fs.writeFileSync(file, Buffer.from(await (await fetch(base + url)).arrayBuffer()));
  return file;
};

test('écritures refusées sans en-tête maison', async () => {
  const r = await fetch(`${base}/api/source`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403);
});

test('export de bout en bout', async (t) => {
  const { source } = await post('/api/source', { input: `"${src}"` });
  assert.strictEqual(Math.round(source.info.fps), 24);
  assert.strictEqual(source.info.subtitles.length, 1);
  const run = async (settings) => job(await post(`/api/export/${source.id}`, { settings }));

  await t.test('précision à l’image (images 10 à 33 = 24 images)', async () => {
    const r = await run({ format: 'gif', startFrame: 10, endFrame: 33, width: 320, fps: 0, colors: 128, dither: 'bayer' });
    assert.strictEqual(frames(r.path), 24);
  });

  await t.test('aller-retour, texte, sous-titres, recadrage', async () => {
    const r = await run({
      format: 'gif', startFrame: 0, endFrame: 11, pingpong: true, subs: { kind: 'stream', index: 0 },
      crop: { x: 100, y: 110, w: 300, h: 200 }, texts: [{ content: 'Chaos', y: 85 }, { content: 'Haut', y: 10, start: 0, end: 0.2 }],
    });
    assert.strictEqual(frames(r.path), 24);
    assert.deepStrictEqual(dims(r.path), [300, 200]);
  });

  await t.test('segments, vitesse par segment et arrêt sur image', async () => {
    const r = await run({
      format: 'mp4', fps: 24, width: 320, audio: true,
      segments: [{ start: 0, end: 23 }, { start: 48, end: 71, speed: 2, hold: 0.5 }],
    });
    // 24 images + 12 (vitesse ×2) + 12 (0,5 s figée).
    assert.ok(Math.abs(frames(r.path) - 48) <= 1, `${frames(r.path)} images`);
  });

  await t.test('piste audio choisie sur une autre vidéo : ramenée à celles de cette source', async () => {
    const r = await run({ format: 'mp4', startFrame: 0, endFrame: 23, width: 160, audio: true, audioTrack: 3 });
    assert.ok(r.bytes > 0);
  });

  await t.test('effets : rotation, miroir, filtres, flou, logo, zoom, fondus, inversé', async () => {
    const { file } = await (await fetch(`${base}/api/logo?name=logo.png`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-ChaosClip': '1' }, body: fs.readFileSync(logo),
    })).json();
    const r = await run({
      format: 'webp', startFrame: 0, endFrame: 23, width: 200, rotate: 90, flipH: true, reverse: true, zoom: 1.5,
      filters: { brightness: 0.1, contrast: 1.2, saturation: 1.3, sharpen: 1, denoise: 3, grayscale: true, fadeIn: 0.2, fadeOut: 0.2, deinterlace: true },
      blurZones: [{ x: 10, y: 70, w: 100, h: 80 }], logo: { file, position: 'tl', size: 20, opacity: 70 },
      crop: { x: 0, y: 60, w: 640, h: 360 },
    });
    assert.ok(r.bytes > 0);
  });

  await t.test('recadrage animé, transparence, fondu en boucle', async () => {
    const r = await run({
      format: 'gif', startFrame: 0, endFrame: 47, fps: 12, crossfade: 0.5,
      crop: { x: 0, y: 60, w: 200, h: 200 }, cropKeys: [{ frame: 0, x: 0, y: 60 }, { frame: 47, x: 400, y: 200 }],
      transparent: { color: '#000000', similarity: 0.1 },
    });
    assert.deepStrictEqual(dims(r.path), [200, 200]);
    // 2 s à 12 i/s moins 0,5 s de fondu.
    assert.ok(Math.abs(frames(r.path) - 18) <= 1, `${frames(r.path)} images`);
  });

  await t.test('formats : apng, avif, webm, mp3, planche, png', async () => {
    for (const format of ['apng', 'avif', 'webm', 'mp3', 'sheet', 'png']) {
      const r = await run({ format, startFrame: 0, endFrame: 23, width: 160, audio: true, sheet: { cols: 4, rows: 2 } });
      assert.ok(r.bytes > 0, format);
      if (format === 'sheet') assert.deepStrictEqual(dims(r.path), [4 * 160 + 4 * 5, 2 * 120 + 4 * 3]);
    }
  });

  await t.test('poids max (GIF avec gifsicle, MP4 au débit)', async () => {
    const gif = await run({ format: 'gif', startFrame: 0, endFrame: 119, width: 640, fps: 24, maxSizeMB: 0.4 });
    assert.ok(gif.fitsMax, JSON.stringify(gif.attempts));
    const mp4 = await run({ format: 'mp4', startFrame: 0, endFrame: 119, audio: true, maxSizeMB: 0.3 });
    assert.ok(mp4.fitsMax, JSON.stringify(mp4.attempts));
  });

  await t.test('estimation, aperçu, miniatures, plans, bandes noires', async () => {
    const est = await job(await post(`/api/estimate/${source.id}`, { settings: { format: 'gif', startFrame: 0, endFrame: 119 } }));
    assert.ok(est.bytes > 0 && est.sample);
    const prev = await job(await post(`/api/preview/${source.id}`, { settings: { format: 'gif', fps: 15, speed: 2, texts: [{ content: 'X' }] }, frame: 30 }));
    assert.ok((await fetch(base + prev.url)).ok);
    for (const view of ['t=2.5', 'from=1&cell=0.5&n=4&i=3']) { // vue large (image clé), puis frise zoomée (rangée à l'image près)
      const th = await fetch(`${base}/api/thumbs/${source.id}?h=40&${view}`);
      assert.strictEqual(th.headers.get('content-type'), 'image/jpeg');
      assert.ok((await th.arrayBuffer()).byteLength > 200);
    }
    // Frise au plus près : chaque vignette est une image exacte, la même quelle que soit la rangée qui la contient.
    // L'image 35 est effacée avant chaque demande : sinon elle reviendrait de la première, sans être redécodée.
    const { DIRS } = require('../lib/env');
    const frame35 = path.join(DIRS.work, 'thumbs', `${require('../lib/media').sources.get(source.id).key}-F35-40.jpg`);
    const exact = async (q) => {
      fs.rmSync(frame35, { force: true });
      return Buffer.from(await (await fetch(`${base}/api/thumbs/${source.id}?h=40&${q}`)).arrayBuffer());
    };
    const image35 = await exact('f=35&k=1&n=2&i=0');
    assert.ok(image35.equals(await exact('f=30&k=1&n=6&i=5')) && image35.equals(await exact('f=5&k=10&n=4&i=3')));
    assert.ok(!image35.equals(await exact('f=34&k=1&n=2&i=0')));
    const scenes = await job(await post(`/api/scenes/${source.id}`, {}));
    assert.ok(Array.isArray(scenes));
    const { crop } = await post(`/api/cropdetect/${source.id}`, { frame: 24 });
    assert.deepStrictEqual(crop && [crop.y, crop.h], [60, 360]);
  });

  await t.test('aperçu d’une image : toujours une image de l’export, la plus proche', async () => {
    const preview = async (settings, frame) => pixels(await fetched((await job(await post(`/api/preview/${source.id}`, { settings, frame }))).url))[0];
    // 24 i/s ramenées à 15 : l'image 11 n'est pas gardée. Le texte ne dure que 0,5 s. L'image 2 est hors de la sélection.
    const settings = { format: 'gif', startFrame: 10, endFrame: 57, width: 320, fps: 15, texts: [{ content: 'Début', start: 0, end: 0.5 }] };
    const exported = pixels((await run(settings)).path);
    assert.strictEqual(exported.length, 30);
    for (const [frame, rank] of [[2, 0], [10, 0], [11, 1], [31, 13], [57, 29]]) {
      assert.strictEqual(exported.indexOf(await preview(settings, frame)), rank, `image ${frame}`);
    }
    // Vitesse par segment, inversé, aller-retour, fondu en boucle : l'aperçu suit la même chaîne.
    const mixed = { format: 'apng', width: 160, fps: 12, reverse: true, pingpong: true, crossfade: 0.25, segments: [{ start: 0, end: 23 }, { start: 48, end: 71, speed: 2 }] };
    const all = pixels((await run(mixed)).path);
    for (const frame of [0, 13, 23, 40, 49, 71]) assert.ok(all.includes(await preview(mixed, frame)), `image ${frame}`);
  });

  await t.test('annulation', async () => {
    const r = await post(`/api/export/${source.id}`, { settings: { format: 'avif', startFrame: 0, endFrame: 119, width: 640 } });
    await post(`/api/job/${r.job}/cancel`);
    await assert.rejects(job(r), /Annulé/);
  });

  await t.test('historique', async () => {
    const h = await call('GET', '/api/history');
    assert.ok(h.items.length >= 10 && h.items.every((e) => e.exists));
  });
});

test('image fixe : aperçu prêt d’office, export depuis l’original', async () => {
  const { source } = await post('/api/source', { input: logo });
  assert.ok(source.proxied);
  const r = await job(await post(`/api/export/${source.id}`, { settings: { format: 'png', segments: [{ start: 0, end: 0 }], width: 0, fps: 5 } }));
  assert.deepStrictEqual(dims(r.path), [64, 64]);
});

test('cadence annoncée un peu fausse : lecteur, image et export tombent sur les vraies images', async () => {
  // 30 i/s annoncées, images réellement à 29,9 i/s (cas des WebM de YouTube) : l'écart atteint presque une image à la fin.
  // Fabriquée en deux temps pour que l'annonce ne dépende pas de la plateforme : vidéo à 30 i/s fixes, puis
  // horodatages étirés sans réencoder (le conteneur garde ses 30 i/s annoncées).
  const fixed = path.join(tmp, 'fixe.mkv');
  const drift = path.join(tmp, 'derive.mkv');
  spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=10', '-c:v', 'libx264', fixed]);
  spawnSync(ffmpeg, ['-y', '-itsscale', String(30 / 29.9), '-i', fixed, '-c', 'copy', drift]);
  const { source } = await post('/api/source', { input: drift });
  assert.strictEqual(source.info.fps, 30);
  // L'index lu dans les paquets est celui des images décodées.
  const decoded = JSON.parse(probe(drift, 'frame=best_effort_timestamp_time')).frames.map((frame) => Number(frame.best_effort_timestamp_time));
  assert.deepStrictEqual(source.info.frameTimes, decoded);
  const real = pixels(drift, '-vf', 'select=between(n\\,270\\,280)', '-fps_mode', 'passthrough');
  assert.strictEqual(pixels(await fetched(`/api/frame/${source.id}?f=280`))[0], real[10]);
  // Sélection de 11 images : 11 images exportées, pas une de plus à la fin.
  const r = await job(await post(`/api/export/${source.id}`, { settings: { format: 'gif', startFrame: 270, endFrame: 280, fps: 0 } }));
  assert.strictEqual(frames(r.path), 11);
});

test('copie d’aperçu reprise quand on rouvre le même fichier', async () => {
  const { DIRS } = require('../lib/env');
  const proxies = () => fs.readdirSync(DIRS.work).filter((f) => f.startsWith('proxy-'));
  const before = proxies();
  const { source } = await post('/api/source', { input: logo });
  assert.ok(source.proxied);
  assert.deepStrictEqual(proxies(), before);
});

test('vidéo téléchargée rouverte par son chemin : lien et sous-titres retrouvés', async () => {
  const video = path.join(tmp, 'telechargee.mkv');
  fs.copyFileSync(src, video);
  // Ce que le téléchargement retient (yt-dlp n'est pas lancé dans les tests).
  require('../lib/store').write('downloads', { [path.resolve(video)]: {
    origin: { kind: 'url', url: 'https://exemple.test/v' }, externalSubs: [{ path: path.join(tmp, 's.srt'), label: 'fr', offset: 0 }],
  } });
  const { source } = await post('/api/source', { input: video });
  assert.strictEqual(source.origin.url, 'https://exemple.test/v');
  assert.deepStrictEqual(source.externalSubs.map((s) => s.label), ['fr']);
});

test('« Vider les temporaires » garde les logos du montage', async () => {
  const { source } = await post('/api/source', { input: `"${src}"` });
  const { file } = await (await fetch(`${base}/api/logo?name=logo.png`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-ChaosClip': '1' }, body: fs.readFileSync(logo),
  })).json();
  await post('/api/cleanup', { kind: 'work' });
  const r = await job(await post(`/api/export/${source.id}`, { settings: { format: 'gif', startFrame: 0, endFrame: 5, width: 160, logo: { file, position: 'tl', size: 20, opacity: 70 } } }));
  assert.ok(r.bytes > 0);
});

test('vidéo rouverte : miniatures et plans repris sans nouveau passage de ffmpeg', async () => {
  const { DIRS } = require('../lib/env');
  const thumbs = () => fs.readdirSync(path.join(DIRS.work, 'thumbs')).length;
  const first = (await post('/api/source', { input: src })).source;
  const second = (await post('/api/source', { input: src })).source;
  assert.notStrictEqual(first.id, second.id);
  // Dernière vignette de la rangée : sa réponse attend la fin de la passe, le compte des fichiers est alors stable.
  const view = 'h=40&from=0.5&cell=0.25&n=4&i=3';
  const a = Buffer.from(await (await fetch(`${base}/api/thumbs/${first.id}?${view}`)).arrayBuffer());
  const count = thumbs();
  const b = Buffer.from(await (await fetch(`${base}/api/thumbs/${second.id}?${view}`)).arrayBuffer());
  assert.ok(a.length > 200 && a.equals(b));
  assert.strictEqual(thumbs(), count);
  const scenes = await job(await post(`/api/scenes/${first.id}`, {}));
  assert.deepStrictEqual(await job(await post(`/api/scenes/${second.id}`, {})), scenes);
  assert.ok(fs.readdirSync(DIRS.work).some((f) => f.startsWith('scenes-')));
});

test('rangée de miniatures remplacée par une autre vue : arrêtée, aucune vignette coupée gardée', async () => {
  // Assez d'images pour que la première rangée tourne encore quand la seconde est demandée.
  const long = path.join(tmp, 'longue.mp4');
  spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', long]);
  const { source } = await post('/api/source', { input: long });
  const row = (f, i) => fetch(`${base}/api/thumbs/${source.id}?h=40&f=${f}&k=15&n=100&i=${i}`);
  assert.ok((await row(0, 0)).ok); // la première passe a commencé
  assert.ok((await row(5, 99)).ok); // autre vue, jusqu'à sa dernière vignette : la première est arrêtée depuis
  const { DIRS } = require('../lib/env');
  const { key } = require('../lib/media').sources.get(source.id);
  const all = fs.readdirSync(path.join(DIRS.work, 'thumbs'));
  const names = all.filter((f) => f.startsWith(`${key}-F`) && Number(f.split('-F')[1].split('-')[0]) % 15 === 0);
  assert.ok(names.length < 100, `${names.length} vignettes : la première passe ne s'est pas arrêtée`);
  for (const name of names) {
    const jpeg = fs.readFileSync(path.join(DIRS.work, 'thumbs', name));
    assert.ok(jpeg.length > 2 && jpeg.readUInt16BE(jpeg.length - 2) === 0xffd9, `${name} complète`);
  }
  assert.deepStrictEqual(all.filter((f) => f.startsWith('passe-')), [], 'fichiers de passe restés');
});

test('frise au plus près qu’on fait défiler : les images voisines sont prêtes, les déjà faites ne sont pas refaites', async () => {
  const { source } = await post('/api/source', { input: src });
  const { DIRS } = require('../lib/env');
  const { key } = require('../lib/media').sources.get(source.id);
  const file = (f) => path.join(DIRS.work, 'thumbs', `${key}-F${f}-30.jpg`);
  const row = async (f) => assert.ok((await fetch(`${base}/api/thumbs/${source.id}?h=30&f=${f}&k=2&n=10&i=9`)).ok);
  await row(40); // vue 40, 42… 58
  // Dix cases (une seconde à 24 i/s) de chaque côté : la passe de la vue continue jusqu'à 78, une autre fait 20… 38.
  for (let k = 0; k < 200 && !(fs.existsSync(file(78)) && fs.existsSync(file(20))); k++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(file(20)) && fs.existsSync(file(78)), 'images voisines préparées');
  const kept = [50, 60, 78];
  const before = kept.map((f) => fs.statSync(file(f)).mtimeMs);
  await row(70); // vue 70… 88 : seules 80 et au-delà manquaient
  assert.deepStrictEqual(kept.map((f) => fs.statSync(file(f)).mtimeMs), before, 'vignettes déjà faites réécrites');
  assert.ok(fs.existsSync(file(88)));
});

test('nettoyage au démarrage : les vieilles miniatures partent, le dossier et les récentes restent', () => {
  const { DIRS } = require('../lib/env');
  const dir = path.join(DIRS.work, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vieille.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'recente.jpg'), 'x');
  const old = new Date(Date.now() - 10 * 86400e3);
  fs.utimesSync(path.join(dir, 'vieille.jpg'), old, old);
  require('../lib/cleanup').sweep(7);
  assert.ok(!fs.existsSync(path.join(dir, 'vieille.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'recente.jpg')));
});
