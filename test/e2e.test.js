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
    const prev = await job(await post(`/api/preview/${source.id}`, { settings: { format: 'gif', texts: [{ content: 'X' }] }, frame: 30 }));
    assert.ok((await fetch(base + prev.url)).ok);
    const th = await fetch(`${base}/api/thumbs/${source.id}?n=10&h=40`);
    assert.strictEqual(th.headers.get('content-type'), 'image/jpeg');
    const scenes = await job(await post(`/api/scenes/${source.id}`, {}));
    assert.ok(Array.isArray(scenes));
    const { crop } = await post(`/api/cropdetect/${source.id}`, { frame: 24 });
    assert.deepStrictEqual(crop && [crop.y, crop.h], [60, 360]);
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
