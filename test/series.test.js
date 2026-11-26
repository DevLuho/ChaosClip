const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosclip-series-'));
process.env.CHAOSCLIP_DATA = tmp;
const file = path.join(tmp, 'episode.mp4');
const generated = spawnSync(require('ffmpeg-static'), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc2=size=160x90:rate=24:duration=4', '-vf', "select='if(lt(t,2),not(mod(n,2)),1)'",
  '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
assert.equal(generated.status, 0, generated.stderr.toString());

let child;
async function start() {
  child = spawn(process.execPath, ['-e', "require('./server').start(0,{open:false})"], {
    env: { ...process.env, CHAOSCLIP_DATA: tmp, YTDLP_PATH: process.execPath },
    cwd: path.join(__dirname, '..'),
  });
  const url = await new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const match = stdout.match(/http:\/\/localhost:\d+/);
      if (match) resolve(match[0]);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('Server exited: ' + code)));
  });
  return async (route, body, method) => {
    const response = await fetch(url + route, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', 'X-ChaosClip': '1' },
      body: body && JSON.stringify(body),
    });
    assert.ok(response.ok, route + ': ' + response.status + ' ' + (response.ok ? '' : await response.text()));
    return /^\/(out|api\/frame)\//.test(route) ? response.arrayBuffer() : response.json();
  };
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await closed;
}

test.after(async () => {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function until(read, condition) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (condition(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('La série ne converge pas : ' + JSON.stringify(await read()));
}

test('Série persistante, reprise, révision et sorties par extrait', { timeout: 45000 }, async () => {
  let api = await start();
  const { source } = await api('/api/source', { input: file });
  assert.equal(source.info.frameTimes[24], 2);
  assert.equal(source.info.frameTimes.length, 72);
  const expected = path.join(tmp, 'expected.png');
  const actual = path.join(tmp, 'actual.png');
  const frame = spawnSync(require('ffmpeg-static'), ['-y', '-loglevel', 'error', '-i', file, '-vf', 'select=eq(n\\,24)', '-frames:v', '1', expected]);
  assert.equal(frame.status, 0, frame.stderr.toString());
  fs.writeFileSync(actual, Buffer.from(await api('/api/frame/' + source.id + '?f=24')));
  const pixels = (input) => spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', input, '-pix_fmt', 'rgb24', '-f', 'md5', '-']).stdout.toString();
  assert.match(pixels(expected), /^MD5=/);
  assert.equal(pixels(actual), pixels(expected));
  const { id } = await api('/api/series/' + source.id, { title: 'Épisode' });
  const route = '/api/series/' + id;
  let series = await api(route);
  const edit = async (action) => {
    series = await api(route, { ...action, revision: series.revision }, 'PATCH');
    return series;
  };
  for (const [start, end] of [[19, 26], [38, 46], [50, 57]]) {
    const doc = { sel: { start, end }, opts: { width: 120, format: 'gif', fps: 15 } };
    await edit({ action: 'add', doc, sourceId: source.id, settings: { width: 120, fps: 15, segments: [doc.sel] } });
  }
  const [a, b, c] = series.clips;
  await edit({ action: 'move', clip: c.id, offset: -1 });
  assert.deepEqual(series.clips.map((clip) => clip.id), [a.id, c.id, b.id]);
  series = await api(route + '/prepare', {});
  assert.equal(series.clips.flatMap((clip) => Object.values(clip.outputs)).length, 6);
  const first = await until(() => api(route), (value) => value.clips[0].outputs.gif.status === 'done');
  const gif = first.clips[0].outputs.gif.entry;
  await stop();
  api = await start();
  series = await until(() => api(route), (value) => value.clips.every((clip) => Object.values(clip.outputs).every((out) => out.status === 'done')));
  assert.equal(series.clips[0].outputs.gif.entry.id, gif.id);
  assert.equal(series.selected, c.id);
  assert.equal((await api(gif.url)).byteLength, gif.bytes);
  const webp = series.clips[0].outputs.webp.entry;
  // Envoi sur ChaosBooru : les sorties d'une même série partagent un identifiant de lot, gardé d'une fois sur l'autre.
  const { lot } = require('../lib/series');
  assert.match(lot(webp.id), /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(lot(series.clips[1].outputs.webp.entry.id), lot(webp.id));
  assert.equal(lot('0123456789ab'), undefined);
  await edit({ action: 'validate', clip: a.id });
  assert.equal(series.clips[0].validated, true);
  await edit({ action: 'draft', clip: a.id, draft: { credit: 'Crédit' } });
  assert.equal(series.clips[0].validated, false);
  assert.equal(series.clips[0].outputs.webp.entry.id, webp.id);
  await edit({ action: 'profile', clip: a.id, format: 'gif', profile: { width: 100 } });
  assert.equal(series.clips[0].outputs.gif.status, 'new');
  assert.equal(series.clips[0].outputs.webp.entry.id, webp.id);
  await api(route + '/prepare', { clip: a.id, format: 'gif' });
  series = await until(() => api(route), (value) => value.clips[0].outputs.gif.status === 'done');
  assert.notEqual(series.clips[0].outputs.gif.entry.id, gif.id);
  assert.equal(series.clips[0].outputs.gif.entry.size.w, 100);
  // Réglages image de la fenêtre : communs aux deux fichiers, ils remplacent la largeur propre au GIF.
  await edit({ action: 'image', clip: a.id, image: { width: 80, speed: 2, crop: { x: 10, y: 0, w: 80, h: 90 } } });
  assert.deepEqual([series.clips[0].doc.opts.width, series.clips[0].doc.opts.speed, series.clips[0].doc.crop.x], [80, 2, 10]);
  assert.equal(series.clips[0].profiles.gif.width, undefined);
  assert.deepEqual([series.clips[0].outputs.gif.status, series.clips[0].outputs.webp.status], ['new', 'new']);
  await edit({ action: 'image', clip: a.id, image: { crop: null } });
  assert.equal(series.clips[0].doc.crop, null);
  // Lecteur de la fenêtre : début et fin du passage réglés à l'image, réglages pour tous, poids estimé, glisser-déposer.
  await edit({ action: 'bounds', clip: a.id, start: 20, end: 25 });
  assert.deepEqual([series.clips[0].bounds, series.clips[0].doc.sel], [[[20, 25]], { start: 20, end: 25 }]);
  await edit({ action: 'image', clip: a.id, all: true, image: { fps: 10 } });
  assert.ok(series.clips.every((clip) => clip.doc.opts.fps === 10));
  const { job } = await api(route + '/estimate', { clip: a.id, format: 'gif' });
  const estimate = await until(() => api('/api/job/' + job), (value) => value.status === 'done');
  assert.ok(estimate.result.bytes > 0);
  await edit({ action: 'move', clip: a.id, to: 2 });
  assert.equal(series.clips[2].id, a.id);
  await edit({ action: 'move', clip: a.id, to: 0 });
  // « GIF seulement » : un extrait n'attend plus de WebP, ni pour être préparé ni pour être validé.
  await edit({ action: 'formats', gifOnly: true });
  assert.equal(series.gifOnly, true);
  const solo = { sel: { start: 60, end: 66 }, opts: { width: 120, format: 'gif', fps: 15 } };
  await edit({ action: 'add', doc: solo, sourceId: source.id, settings: { width: 120, fps: 15, segments: [solo.sel] } });
  await api(route + '/prepare', {});
  series = await until(() => api(route), (value) => value.clips.at(-1).outputs.gif.status === 'done');
  assert.equal(series.clips.at(-1).outputs.webp.status, 'new');
  await edit({ action: 'validate', clip: series.clips.at(-1).id });
  assert.equal(series.clips.at(-1).validated, true);
  // Les sorties d'une série demeurent disponibles si l'historique général ne les contient plus.
  fs.writeFileSync(path.join(tmp, 'data', 'history.json'), '[]');
  assert.equal((await api(webp.url)).byteLength, webp.bytes);
});

test('Le webhook attend un reçu Discord et respecte le délai de reprise', async (t) => {
  const { send } = require('../lib/discord');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(new URL(url).searchParams.get('wait'));
    return urls.length === 1
      ? Response.json({ retry_after: 0.01 }, { status: 429 })
      : Response.json({ id: '42', channel_id: '93', guild_id: '54' });
  });
  const receipt = await send('https://discord.com/api/webhooks/123/test-fixture', file);
  assert.deepEqual(urls, ['true', 'true']);
  assert.deepEqual(receipt, { id: '42', channelId: '93', guildId: '54' });
});
