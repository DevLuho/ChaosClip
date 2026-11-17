// Test de bout en bout : génère une vidéo, l'exporte dans chaque format via l'API.
// Lancer : npm test
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NO_OPEN = '1';
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { app } = require('../server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosclip-'));
const src = path.join(tmp, 'source test.mkv');
fs.writeFileSync(path.join(tmp, 's.srt'), '1\n00:00:00,000 --> 00:00:05,000\nSous-titre de test\n');
spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
  '-f', 'lavfi', '-i', 'sine=duration=5', '-i', path.join(tmp, 's.srt'),
  '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'ass', src]);

let base;
const server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function post(url, body) {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  assert.ok(r.ok, j.error);
  return j;
}
async function job(id) {
  for (;;) {
    const j = await (await fetch(`${base}/api/job/${id}`)).json();
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const frames = (file) => Number(spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).stdout.toString().trim());

test('export de bout en bout', async () => {
  await new Promise((r) => setTimeout(r, 100));
  const { source } = await post('/api/source', { input: `"${src}"` });
  assert.strictEqual(Math.round(source.info.fps), 24);
  assert.strictEqual(source.info.subtitles.length, 1);
  const exportsDir = path.join(__dirname, '..', 'exports');
  const run = async (settings, estimate) => job((await post(`/api/export/${source.id}`, { settings, estimate })).job);

  // Précision à l'image : images 10 à 33 = 24 images.
  const gif = await run({ format: 'gif', startFrame: 10, endFrame: 33, width: 320, fps: 0, colors: 128, dither: 'bayer' });
  assert.strictEqual(frames(path.join(exportsDir, gif.file)), 24);

  const ping = await run({ format: 'gif', startFrame: 0, endFrame: 11, pingpong: true, text: { content: 'Chaos' }, subStream: 0, crop: { x: 100, y: 50, w: 300, h: 200 } });
  assert.strictEqual(frames(path.join(exportsDir, ping.file)), 24);

  for (const format of ['webp', 'mp4', 'webm']) {
    const r = await run({ format, startFrame: 0, endFrame: 47, width: 320, audio: true, speed: 2 });
    assert.ok(r.bytes > 0, format);
  }

  const est = await run({ format: 'gif', startFrame: 0, endFrame: 119, width: 640 }, true);
  assert.ok(est.estimate && est.bytes > 0);

  // Poids max : doit réduire jusqu'à passer sous 0.5 Mo.
  const small = await run({ format: 'gif', startFrame: 0, endFrame: 119, width: 640, fps: 24, maxSizeMB: 0.5 });
  assert.ok(small.fitsMax, JSON.stringify(small.attempts));
  const smallMp4 = await run({ format: 'mp4', startFrame: 0, endFrame: 119, audio: true, maxSizeMB: 0.3 });
  assert.ok(smallMp4.fitsMax, JSON.stringify(smallMp4.attempts));

  for (const r of [gif, ping, small, smallMp4]) fs.rmSync(path.join(exportsDir, r.file));
});
