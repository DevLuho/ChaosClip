// Messages montrés au membre quand yt-dlp ou ffmpeg échoue.
const test = require('node:test');
const assert = require('node:assert');
const { isStale } = require('../lib/ytdlp');

test('yt-dlp : une erreur d’extraction déclenche la mise à jour, pas une vidéo privée', () => {
  assert.ok(isStale('ERROR: [youtube] abc: Unable to extract uploader id'));
  assert.ok(isStale('ERROR: unable to download video data: HTTP Error 403: Forbidden'));
  assert.ok(!isStale('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access'));
  assert.ok(!isStale(''));
});

test('Export : un échec courant de ffmpeg est dit en une phrase', () => {
  const { ffmpegError } = require('../lib/exporter');
  assert.match(ffmpegError('av_interleaved_write_frame(): No space left on device'), /^Disque plein/);
  assert.match(ffmpegError('x.mp4: Invalid data found when processing input'), /illisible/);
  assert.match(ffmpegError('Unknown encoder foo'), /^ffmpeg a échoué : Unknown encoder foo$/);
});
