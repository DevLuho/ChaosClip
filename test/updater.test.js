// Mise à jour de l'appli Android : une release ne compte que si elle est plus récente ET porte l'APK attendu.
const test = require('node:test');
const assert = require('node:assert');
const { checkApk, apkName } = require('../lib/updater');

test('Android : mise à jour proposée seulement si la release porte l’APK', async (t) => {
  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  const release = (tag, assets) => { global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: tag, assets: assets.map((name) => ({ name })) }) }); };
  const check = () => checkApk({ current: '1.5.0', latest: null, available: false });

  release('v1.6.0', [apkName('1.6.0'), 'ChaosClip-Setup-1.6.0.exe']);
  assert.deepStrictEqual(await check(), { current: '1.5.0', latest: '1.6.0', available: true, mode: 'apk' });

  release('v1.6.0', ['ChaosClip-Setup-1.6.0.exe']); // installateur Windows publié, APK pas encore envoyé
  assert.strictEqual((await check()).available, false);

  release('v1.5.0', [apkName('1.5.0')]); // déjà à jour
  assert.strictEqual((await check()).available, false);

  global.fetch = async () => { throw new Error('hors ligne'); };
  assert.strictEqual((await check()).available, false);
});
