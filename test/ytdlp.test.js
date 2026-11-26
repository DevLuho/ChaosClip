const test = require('node:test');
const assert = require('node:assert');
const { isStale } = require('../lib/ytdlp');

test('yt-dlp : une erreur d’extraction déclenche la mise à jour, pas une vidéo privée', () => {
  assert.ok(isStale('ERROR: [youtube] abc: Unable to extract uploader id'));
  assert.ok(isStale('ERROR: unable to download video data: HTTP Error 403: Forbidden'));
  assert.ok(!isStale('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access'));
  assert.ok(!isStale(''));
});
