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
