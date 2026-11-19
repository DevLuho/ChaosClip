// Secret de l'appli Android (CHAOSCLIP_TOKEN) : sans le cookie, le serveur refuse tout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CHAOSCLIP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosclip-token-'));
process.env.CHAOSCLIP_TOKEN = 'secret';
process.env.YTDLP_PATH = path.join(process.env.CHAOSCLIP_DATA, 'absent-yt-dlp');
const { start } = require('../server');

test('le serveur exige le cookie quand un secret est défini', async () => {
  const { server, url } = await start(0, { open: false });
  try {
    const status = async (cookie) => (await fetch(`${url}/api/queue`, { headers: cookie ? { Cookie: cookie } : {} })).status;
    assert.strictEqual(await status(), 403);
    assert.strictEqual(await status('cc=faux'), 403);
    assert.strictEqual(await status('cc=secretX'), 403);
    assert.strictEqual(await status('autre=1; cc=secret'), 200);
  } finally {
    server.close();
  }
});
