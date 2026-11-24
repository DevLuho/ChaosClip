const test = require('node:test');
const assert = require('node:assert/strict');

test('le double clic et les autres entrées partagent le verrou pendant tout l’export', async () => {
  const { onceWhileActive } = await import('../public/js/action-lock.mjs');
  const run = onceWhileActive();
  let complete;
  const finish = new Promise((resolve) => { complete = resolve; });
  const submitted = [];
  const launch = (clip) => run(clip, async () => {
    submitted.push(clip);
    await finish;
    return clip;
  });

  const first = launch('0–72');
  assert.equal(await launch('0–72'), undefined);
  assert.equal(await launch('0–72'), undefined);
  const next = launch('0–70');
  assert.deepEqual(submitted, ['0–72', '0–70']);
  complete();
  assert.deepEqual(await Promise.all([first, next]), ['0–72', '0–70']);
  assert.equal(await launch('0–72'), '0–72');
  await assert.rejects(run('0–72', () => { throw new Error('encodage'); }), /encodage/);
  assert.equal(await launch('0–72'), '0–72');
});

test('une touche maintenue continue la navigation sans relancer l’export ou le rendu', async () => {
  const { acceptsShortcut } = await import('../public/js/action-lock.mjs');
  const hold = { repeat: true };
  for (const action of ['export', 'still', 'preview', 'estimate', 'addClip']) {
    assert.equal(acceptsShortcut({}, action), true);
    assert.equal(acceptsShortcut(hold, action), false);
  }
  assert.equal(acceptsShortcut(hold, 'stepFwd'), true);
  assert.equal(acceptsShortcut(hold, 'nudgeOutBack'), true);
  assert.equal(acceptsShortcut({ defaultPrevented: true }, 'export'), false);
  assert.equal(acceptsShortcut({ isComposing: true }, 'export'), false);
});

test('le temps d’un lien place le curseur au bon endroit', async () => {
  const { urlTime } = await import('../public/js/url-time.mjs');
  assert.equal(urlTime('https://youtu.be/abc?t=90'), 90);
  assert.equal(urlTime('https://www.youtube.com/watch?v=abc&t=1m30s'), 90);
  assert.equal(urlTime('https://www.twitch.tv/videos/1?t=1h2m3s'), 3723);
  assert.equal(urlTime('https://example.com/v#t=1:05'), 65);
  assert.equal(urlTime('https://www.youtube.com/watch?v=abc'), 0);
  assert.equal(urlTime('https://example.com/?t=nimporte'), 0);
  assert.equal(urlTime('pas une url'), 0);
});

test('un passage retiré au milieu laisse les deux côtés, dans l’ordre, pour un seul export', async () => {
  const { keptRanges } = await import('../public/js/cuts.mjs');
  const doc = (cuts, segments = []) => ({ sel: { start: 100, end: 10 }, segments, cuts });
  assert.deepEqual(keptRanges(doc([])), [{ start: 10, end: 100 }]);
  assert.deepEqual(keptRanges(doc([{ start: 40, end: 60 }])), [{ start: 10, end: 39 }, { start: 61, end: 100 }]);
  // Deux passages retirés, dont un qui dépasse du début : il ne reste que ce qui est dans la sélection.
  assert.deepEqual(keptRanges(doc([{ start: 0, end: 20 }, { start: 40, end: 60 }])), [{ start: 21, end: 39 }, { start: 61, end: 100 }]);
  assert.deepEqual(keptRanges(doc([{ start: 200, end: 300 }])), [{ start: 10, end: 100 }]);
  // Tout retirer n'exporte pas du vide : le passage entier est gardé.
  assert.deepEqual(keptRanges(doc([{ start: 0, end: 500 }])), [{ start: 10, end: 100 }]);
  // Segments : la vitesse suit chaque morceau, l'arrêt sur image reste à la fin.
  assert.deepEqual(keptRanges(doc([{ start: 40, end: 60 }], [{ start: 30, end: 70, speed: 2, hold: 1 }])),
    [{ start: 30, end: 39, speed: 2, hold: 0 }, { start: 61, end: 70, speed: 2, hold: 1 }]);
  // Un ancien projet n'a pas de passages retirés.
  assert.deepEqual(keptRanges({ sel: { start: 3, end: 9 }, segments: [] }), [{ start: 3, end: 9 }]);
});
