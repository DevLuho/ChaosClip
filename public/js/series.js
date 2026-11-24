import { $, api, ask, confirmAsk, esc, fail, fmtBytes, native, openDialog, toast, runAction, trackProgress } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, replaceDoc, toServer } from './state.js';
import { gotoFrame, playRange, video } from './player.js';
import { copyResult } from './exportui.js';
import { openBooru } from './booru.js';

const dialog = $('seriesDlg');
const picker = $('seriesPicker');
const list = $('seriesClips');
const review = $('seriesReview');
const metadata = $('seriesMetadata');
const base = '/api/series';
let active;
let openEditor;
let editing;
let pendingEdit;
let editTimer;
let writes = Promise.resolve();
let additions = Promise.resolve();
let poll;
let reviewKey;
let catalogue = [];
const byPath = new Map();
const labels = {
  new: 'À préparer', queued: 'En attente', running: 'Encodage', done: 'Prêt',
  error: 'À corriger', missing: 'Fichier manquant', cancelled: 'Annulé',
};
const remoteLabels = {
  draft: 'Brouillon sur ChaosBooru', pending: 'En attente de modération',
  approved: 'Publié sur ChaosBooru', changes_requested: 'Corrections demandées', rejected: 'Refusé',
};
const variants = ['gif', 'webp'];

export function connectEditor(handler) { openEditor = handler; }

function selected() { return active?.clips.find((clip) => clip.id === active.selected); }
function isReady(clip) { return variants.every((format) => clip.outputs[format].status === 'done'); }

// Rendus en cours : ils alimentent l'avancement global (barre des tâches du PC, notification et arrière-plan sur Android).
const pending = (series) => series.clips.flatMap((clip) => Object.values(clip.outputs)).filter((output) => ['queued', 'running'].includes(output.status));

// Sous la frise : le nombre de passages gardés pour la vidéo ouverte, et l'accès à leur liste.
function renderCount(count) {
  $('seriesOpen').hidden = !count;
  $('seriesOpen').textContent = count === 1 ? t('Voir le passage ajouté') : t('Voir les {n} passages', { n: count });
}

function setActive(series) {
  active = series;
  if (series.source.path === ctx.source?.path) renderCount(series.clips.length);
  const busy = pending(series);
  trackProgress('series', busy.length ? busy.reduce((sum, output) => sum + (output.progress || 0), 0) / busy.length : null, t('Rendus de la série'));
  byPath.set(series.source.path, series.id);
  try { localStorage.setItem('chaosclip.series', series.id); } catch { /* stockage indisponible */ }
  if (dialog.open) render();
}

function serialize(fn) {
  const next = writes.then(fn);
  writes = next.catch(() => {});
  return next;
}

function mutate(seriesId, change) {
  return serialize(async () => {
    const current = active?.id === seriesId ? active : await api(base + '/' + seriesId);
    const updated = await api(base + '/' + seriesId, { ...change, revision: current.revision }, 'PATCH');
    if (active?.id === seriesId) setActive(updated);
    return updated;
  });
}

function flushEdit() {
  clearTimeout(editTimer);
  const change = pendingEdit;
  pendingEdit = null;
  return change ? mutate(change.id, change.body) : Promise.resolve();
}

function stopEditing() {
  const saving = flushEdit();
  editing = null;
  $('seriesEditing').hidden = true;
  return saving;
}

listen('source', async () => {
  if (editing && editing.sourceId !== ctx.source?.id) stopEditing().catch(fail);
  renderCount(0);
  const path = ctx.source?.path;
  if (!path) return;
  const item = (await api(base).catch(() => [])).find((entry) => entry.path === path);
  if (!item || ctx.source?.path !== path) return;
  byPath.set(path, item.id);
  renderCount(item.count);
});
// Le nom d'un passage est facultatif : son champ ne s'affiche que si on le demande, et ce choix est gardé.
function showName(on) {
  $('clipName').hidden = !on;
  $('clipNameToggle').setAttribute('aria-pressed', String(on));
}
try { showName(localStorage.getItem('chaosclip.clipName') === '1'); } catch { /* stockage indisponible : champ caché */ }
$('clipNameToggle').addEventListener('click', () => {
  const on = $('clipName').hidden;
  showName(on);
  try { localStorage.setItem('chaosclip.clipName', on ? '1' : ''); } catch { /* ignoré */ }
  if (on) $('clipName').focus();
});
$('clipName').addEventListener('keydown', (event) => { if (event.key === 'Enter' && ctx.source) addSelection(); });
$('seriesOpen').addEventListener('click', async () => {
  try {
    await loadSeries(byPath.get(ctx.source.path));
    openDialog('seriesDlg');
  } catch (error) { fail(error); }
});

listen('docchange', () => {
  if (editing?.sourceId !== ctx.source?.id || !editing) return;
  pendingEdit = { id: editing.id, body: {
    action: 'edit', clip: editing.clip, sourceId: ctx.source.id,
    doc: structuredClone(state.doc), settings: structuredClone(toServer()),
  } };
  clearTimeout(editTimer);
  editTimer = setTimeout(() => flushEdit().catch(fail), 180);
});

async function loadPicker() {
  const items = await api(base);
  picker.replaceChildren(new Option(t('Choisir une série…'), ''));
  for (const item of items.sort((a, b) => b.updated - a.updated)) {
    picker.add(new Option(item.title + ' · ' + item.count, item.id));
    byPath.set(item.path, item.id);
  }
  if (active) picker.value = active.id;
}

async function loadSeries(id) {
  setActive(await api(base + '/' + id));
  loadMetadata();
}

async function forSource(source, title) {
  let seriesId = byPath.get(source.path);
  if (!seriesId) {
    const series = await api(base + '/' + source.id, { title });
    seriesId = series.id;
    byPath.set(source.path, seriesId);
  }
  if (active?.id !== seriesId) await loadSeries(seriesId);
  return seriesId;
}

export function addSelection() {
  if (!ctx.source) return;
  const source = ctx.source;
  const doc = structuredClone(state.doc);
  doc.segments = [];
  const settings = toServer(doc);
  const title = $('clipName').hidden ? '' : $('clipName').value.trim();
  return runAction(JSON.stringify(['series-add', source.id, settings]), t('Ajout de l’extrait…'), () => {
    const adding = additions.then(async () => {
      if (editing) await stopEditing();
      if (!byPath.has(source.path)) await loadPicker();
      const id = await forSource(source);
      const { clips } = await mutate(id, { action: 'add', sourceId: source.id, doc, settings, title });
      if ($('clipName').value.trim() === title) $('clipName').value = ''; // le nom a servi : le passage suivant aura le sien
      toast(t('Passage {n} ajouté. Choisis le suivant, puis « Voir les passages » pour tout préparer.', { n: clips.length }), 'ok');
    });
    additions = adding.catch(() => {});
    return adding;
  }, { host: $('timelineActivity') });
}

export async function importProject(project, title, split) {
  const loaded = await api('/api/source', { input: project.source });
  const created = await api(base + '/' + loaded.source.id, { title });
  setActive(created);
  const documents = split && project.doc.segments?.length
    ? project.doc.segments.map((segment) => ({ ...project.doc, sel: { start: segment.start, end: segment.end }, segments: [segment] }))
    : [project.doc];
  for (const doc of documents) await mutate(created.id, { action: 'add', doc, settings: toServer(doc), sourceId: loaded.source.id });
  openDialog('seriesDlg');
}

function loadMetadata() {
  metadata.elements.title.value = active.title;
  metadata.elements.sourceUrl.value = active.metadata.sourceUrl ?? active.source.url ?? '';
  metadata.elements.credit.value = active.metadata.credit || '';
  metadata.elements.support.value = active.metadata.support || 'anime';
  renderCatalogue();
}

function renderCatalogue() {
  const chosen = new Set(active.metadata.entities || []);
  const select = metadata.elements.entities;
  const opts = new Map(catalogue.map((item) => [item.id, item.name]));
  for (const id of chosen) if (!opts.has(id)) opts.set(id, '#' + id);
  select.replaceChildren(...[...opts].map(([id, name]) => new Option(name, id, chosen.has(id), chosen.has(id))));
}

const button = (action, label, extra = '') => '<button type="button" data-series-action="' + action + '" ' + extra + '>' + esc(t(label)) + '</button>';
function outputStatus(output) {
  const text = t(labels[output.status] || 'À préparer');
  return output.status === 'running' ? text + ' · ' + Math.round((output.progress || 0) * 100) + ' %' : text;
}

function renderList(clip) {
  const filter = $('seriesFilter').value;
  const visible = active.clips.filter((item) => {
    if (filter === 'review') return isReady(item) && !item.validated;
    if (filter === 'pending') return item.outputs.webp.publication?.state === 'pending';
    if (filter === 'error') return variants.some((format) => ['error', 'missing', 'cancelled'].includes(item.outputs[format].status) || item.outputs[format].entry?.fitsMax === false);
    return true;
  });
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.clip : null;
  const markup = visible.map((item) => {
    const thumb = item.outputs.gif.entry || item.outputs.webp.entry;
    const image = thumb?.url ?? (ctx.source?.path === active.source.path && !active.source.missing
      ? '/api/frame/' + ctx.source.id + '?f=' + item.bounds[0][0] + '&w=96' : '');
    return '<li><button type="button" class="series-item" data-clip="' + item.id + '" aria-current="' + (item.id === clip?.id) + '">' +
      (image ? '<img src="' + esc(image) + '" alt="" loading="lazy">' : '') +
      '<span><strong>' + esc(item.title) + '</strong><small>' + esc(item.bounds.map((b) => b.join('–')).join(' · ')) +
      ' · GIF ' + esc(outputStatus(item.outputs.gif)) + ' · WebP ' + esc(outputStatus(item.outputs.webp)) + '</small></span></button></li>';
  }).join('');
  if (list.dataset.markup === markup) return;
  list.dataset.markup = markup;
  list.innerHTML = markup;
  if (focused) list.querySelector('[data-clip="' + CSS.escape(focused) + '"]')?.focus({ preventScroll: true });
}

function render() {
  $('seriesBody').hidden = !active;
  $('seriesCreate').disabled = !ctx.source;
  if (!active) return;
  const clip = selected();
  const outputs = active.clips.flatMap((item) => Object.values(item.outputs));
  const done = outputs.filter((output) => output.status === 'done').length;
  const complete = active.clips.filter((item) => item.validated).length;
  const summary = (active.source.missing ? t('Épisode introuvable.') + ' ' : '') +
    t('{n}/{total} fichiers prêts · {reviewed}/{clips} extraits validés', { n: done, total: outputs.length, reviewed: complete, clips: active.clips.length });
  if ($('seriesStatus').textContent !== summary) $('seriesStatus').textContent = summary;
  $('seriesPrepare').disabled = active.source.missing || !active.clips.length;
  $('seriesSource').disabled = active.source.missing;
  $('seriesScenes').disabled = active.source.missing;
  $('seriesRelink').hidden = !active.source.missing || !ctx.source;
  renderList(clip);
  const key = JSON.stringify([active.id, clip && {
    ...clip, outputs: variants.map((f) => ({ ...clip.outputs[f], progress: undefined })),
  }, active.clips.map((item) => item.id)]);
  if (key === reviewKey || review.contains(document.activeElement) && document.activeElement.matches('input, select')) {
    for (const format of variants) {
      const progress = review.querySelector('[data-progress="' + format + '"]');
      if (progress && clip) progress.textContent = outputStatus(clip.outputs[format]);
    }
    return;
  }
  reviewKey = key;
  const focusAction = review.contains(document.activeElement) && document.activeElement.dataset.seriesAction;
  review.innerHTML = clip ? renderReview(clip) : '<p class="muted">' + esc(t('Marque un passage dans l’épisode, puis ajoute-le à la série.')) + '</p>';
  if (focusAction) review.querySelector('[data-series-action="' + CSS.escape(focusAction) + '"]:not(:disabled)')?.focus({ preventScroll: true });
}

function renderReview(clip) {
  const { gif, webp } = clip.outputs;
  const index = active.clips.indexOf(clip);
  const publication = webp.publication;
  const preview = gif.entry || webp.entry;
  const controls = '<div class="row wrap">' + button('previous', 'Précédent', index === 0 ? 'disabled' : '') +
    button('next', 'Suivant', index === active.clips.length - 1 ? 'disabled' : '') + button('play', 'Lire le passage') +
    button('edit', 'Ajuster dans l’éditeur') + button('rename', 'Renommer') + button('duplicate', 'Dupliquer') +
    button('up', 'Monter', index === 0 ? 'disabled' : '') + button('down', 'Descendre', index === active.clips.length - 1 ? 'disabled' : '') +
    button('remove', 'Retirer') + '</div>';
  const approval = clip.validated
    ? '<p class="ok">' + esc(t('Extrait validé')) + '</p><div class="row wrap">' +
      button('copy', clip.copied ? 'GIF copié · Recopier' : 'Copier le GIF') +
      (native ? button('drag', 'Glisser le GIF', 'draggable="true"') : '') +
      button('shared', clip.shared ? 'Partagé sur Discord' : 'Marquer partagé sur Discord', clip.shared ? 'disabled' : '') + '</div>'
    : '<div class="row">' + button('validate', 'Valider cet extrait', 'class="primary" ' + (isReady(clip) ? '' : 'disabled')) + '</div>';
  return '<h3>' + esc(clip.title) + '</h3><p class="small muted">' + esc(clip.name) + ' · ' +
    esc(clip.bounds.map((bounds) => bounds.join('–')).join(' · ')) + '</p>' + controls +
    (preview ? '<div class="series-preview checker"><img id="seriesPreview" src="' + esc(preview.url) + '" alt="' + esc(clip.title) + '"></div>' : '') +
    '<div class="series-variants">' + card(clip, 'gif') + card(clip, 'webp') + '</div>' +
    approval + (isReady(clip) ? '<div class="row wrap">' + button('booru', 'Ouvrir la contribution ChaosBooru') +
      (clip.validated ? button('portable', 'Télécharger le WebP avec classement') : '') + '</div>' : '') +
    (publication ? '<p class="row wrap"><a href="' + esc(publication.url) + '" target="_blank" rel="noopener">' + esc(t(remoteLabels[publication.state] || publication.state)) + '</a>' + button('status', 'Actualiser l’état') + '</p>' : '') +
    (clip.previousPublications.length ? '<details><summary>' + esc(t('Contributions des révisions précédentes')) + '</summary><ul>' +
      clip.previousPublications.map((item) => '<li><a href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(t(remoteLabels[item.state] || item.state)) + ' · #' + Number(item.versionId) + '</a></li>').join('') + '</ul></details>' : '');
}

function card(clip, format) {
  const output = clip.outputs[format];
  const entry = output.entry;
  const profile = clip.profiles?.[format] || {};
  const name = format === 'gif' ? 'GIF Discord' : 'WebP ChaosBooru';
  const extra = 'data-format="' + format + '"';
  const pending = ['queued', 'running'].includes(output.status);
  const width = profile.width ?? clip.doc.opts.width;
  const fps = profile.fps ?? clip.doc.opts.fps;
  const num = (label, key, value, max, step = 1) => '<label>' + esc(t(label)) +
    ' <input name="' + key + '" type="number" min="0" max="' + max + '" step="' + step + '" value="' + esc(value) + '"></label>';
  return '<article><strong>' + name + '</strong><p class="small muted" data-progress="' + format + '">' +
    esc(outputStatus(output)) + '</p>' +
    (entry ? '<div class="small">' + esc(entry.file) + '</div><div class="small">' + esc(fmtBytes(entry.bytes)) + ' · ' + entry.size.w + '×' + entry.size.h +
      ' · ' + Number(entry.attempts.at(-1)?.fps || 0).toFixed(1) + ' i/s</div><div class="row wrap">' +
      button('preview', 'Voir ce rendu', extra) + '<a href="' + esc(entry.url) + '" download="' + esc(entry.file) + '">' + esc(t('Télécharger')) + '</a></div>' : '') +
    (output.error ? '<p class="error small">' + esc(output.error) + '</p>' : '') +
    (entry?.fitsMax === false ? '<p class="error small">' + esc(t('Au-dessus du poids cible. Réduis la largeur, la cadence ou le passage.')) + '</p>' : '') +
    (pending ? button('cancel', 'Annuler', extra) : entry ? '' : button('prepare', 'Préparer ce fichier', extra)) +
    '<details><summary>' + esc(t('Réglages du fichier')) + '</summary><form class="series-profile" data-profile="' + format + '">' +
    num('Largeur', 'width', width, 7680) + num('Images par seconde', 'fps', fps, 120, 0.01) +
    num('Poids cible (Mo)', 'maxSizeMB', profile.maxSizeMB ?? (format === 'gif' ? 20 : 100), 1000, 0.01) +
    (format === 'webp' ? num('Qualité', 'quality', profile.quality ?? (clip.doc.opts.format === 'webp' ? clip.doc.opts.quality : 75), 100) :
      '<label>' + esc(t('Tramage')) + '<select name="dither">' + ['sierra2_4a', 'bayer', 'floyd_steinberg', 'sierra2', 'sierra3', 'burkes', 'atkinson', 'none'].map((name) =>
        '<option' + (name === (profile.dither || clip.doc.opts.dither) ? ' selected' : '') + '>' + name + '</option>').join('') + '</select></label>') +
    '<button type="submit">' + esc(t('Appliquer au fichier')) + '</button></form></details></article>';
}

async function chooseClip(id, seriesId = active.id) {
  if (!id) return;
  await stopEditing();
  await mutate(seriesId, { action: 'select', clip: id });
}

async function openSource(clip, play = false) {
  const id = active.id;
  const source = ctx.source?.path === active.source.path ? ctx.source : (await api(base + '/' + id + '/source', {})).source;
  dialog.close();
  if (!clip) return openEditor(source);
  const load = () => {
    replaceDoc(clip.doc);
    const bounds = clip.bounds[0];
    const position = () => play ? playRange(...bounds, true) : gotoFrame(bounds[0]);
    if (video.readyState >= 1) position();
    else video.addEventListener('loadedmetadata', () => { if (ctx.source?.id === source.id) position(); }, { once: true });
    if (play) return;
    editing = { id, clip: clip.id, sourceId: source.id };
    $('seriesEditingLabel').textContent = clip.title;
    $('seriesEditing').hidden = false;
  };
  if (ctx.source?.id === source.id) load();
  else openEditor(source, load);
}

const prepare = (id, clip, format) => runAction(JSON.stringify(['series-prepare', id, clip, format]), t('Préparation des rendus…'),
  () => serialize(async () => {
    const next = await api(base + '/' + id + '/prepare', { clip, format });
    if (active?.id === id) setActive(next);
  }), { host: $('seriesActivity') });

async function tick() {
  const id = active?.id;
  if (!id) return;
  if (!dialog.open && !pending(active).length) { clearInterval(poll); return; } // fenêtre fermée : on ne suit plus que des rendus en cours
  const current = await api(base + '/' + id);
  if (active?.id === id && current.revision >= active.revision) setActive(current);
}

const handle = (fn) => async (event) => { try { await fn(event); } catch (error) { fail(error); } };

dialog.addEventListener('opened', handle(async () => {
  await stopEditing();
  await loadPicker();
  let remembered;
  try { remembered = localStorage.getItem('chaosclip.series'); } catch { /* stockage indisponible */ }
  const id = active?.id || byPath.get(ctx.source?.path) || remembered || picker.options[1]?.value;
  if (id && Array.from(picker.options).some((opt) => opt.value === id)) {
    await loadSeries(id);
    picker.value = id;
  }
  render();
  clearInterval(poll);
  poll = setInterval(() => tick().catch(() => {}), 800);
}));
dialog.addEventListener('close', () => { if (!active || !pending(active).length) clearInterval(poll); });
picker.addEventListener('change', handle(() => picker.value && loadSeries(picker.value)));
$('seriesCreate').addEventListener('click', handle(async () => {
  if (!ctx.source) return;
  const created = await api(base + '/' + ctx.source.id, {});
  setActive(created);
  loadMetadata();
  await loadPicker();
}));
$('seriesPrepare').addEventListener('click', handle(() => prepare(active.id)));
$('seriesSource').addEventListener('click', handle(() => openSource()));
$('seriesRelink').addEventListener('click', handle(async () => {
  if (!ctx.source) return;
  const next = await api(base + '/' + active.id + '/source', { sourceId: ctx.source.id, revision: active.revision }, 'PUT');
  setActive(next);
  loadMetadata();
}));
$('seriesDoneEditing').addEventListener('click', handle(async () => { await stopEditing(); openDialog('seriesDlg'); }));
$('seriesFilter').addEventListener('change', () => render());
$('seriesSettings').addEventListener('toggle', async () => {
  if (!$('seriesSettings').open) return;
  try {
    const lists = await api('/api/booru/catalogues');
    catalogue = lists.slice(0, 2).flatMap((item) => item.items);
    if (active) renderCatalogue();
  } catch { /* Les sélections enregistrées restent accessibles hors ligne. */ }
});
async function saveMetadata(showError) {
  const fields = new FormData(metadata);
  const sourceUrl = fields.get('sourceUrl').trim();
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) {
    if (showError) fail(new Error(t('Renseigne une source HTTPS.')));
    return;
  }
  if (!fields.get('title').trim()) return;
  await mutate(active.id, { action: 'metadata', title: fields.get('title'), metadata: {
    sourceUrl, credit: fields.get('credit'), support: fields.get('support'), entities: fields.getAll('entities').map(Number),
  } });
}
metadata.addEventListener('change', handle(() => saveMetadata(false)));
metadata.addEventListener('submit', handle(async (event) => {
  event.preventDefault();
  await saveMetadata(true);
}));
list.addEventListener('click', handle((e) => chooseClip(e.target.closest('[data-clip]')?.dataset.clip)));

function editBooru(seriesId, clip) {
  const entry = clip.outputs.webp.entry;
  const defaults = clip.publicationDraft;
  let savedDraft = clip.draft || {};
  return openBooru(entry, {
    defaults,
    async saveDraft(values) {
      const draft = { ...savedDraft, ...values };
      if (JSON.stringify(draft) === JSON.stringify(savedDraft)) return;
      await mutate(seriesId, { action: 'draft', clip: clip.id, draft });
      savedDraft = draft;
    },
    async beforeSend() {
      const latest = await api(base + '/' + seriesId);
      const current = latest.clips.find((item) => item.id === clip.id);
      if (!clip.validated || current?.outputs.webp.entry?.id !== entry.id || current?.outputs.gif.entry?.id !== clip.outputs.gif.entry?.id) {
        throw new Error(t('Relis et valide à nouveau cet extrait avant de l’envoyer.'));
      }
      if (!current.validated) await mutate(seriesId, { action: 'validate', clip: clip.id });
    },
    onResult: () => tick().catch(fail),
  });
}

review.addEventListener('click', handle(async (event) => {
  const control = event.target.closest('[data-series-action]');
  const clip = selected();
  if (!control || !clip) return;
  const id = active.id;
  const { seriesAction: action, format } = control.dataset;
  const change = { action, clip: clip.id };
  const index = active.clips.indexOf(clip);
  switch (action) {
    case 'previous': return chooseClip(active.clips[index - 1]?.id);
    case 'next': return chooseClip(active.clips[index + 1]?.id);
    case 'play': return openSource(clip, true);
    case 'edit': return openSource(clip);
    case 'rename': {
      const title = await ask(t('Titre de l’extrait'), clip.title);
      if (title?.trim()) await mutate(id, { ...change, title });
      return;
    }
    case 'remove':
      if (await confirmAsk(t('Retirer cet extrait de la série ?'), t('Retirer'))) await mutate(id, change);
      return;
    case 'up':
    case 'down': return mutate(id, { ...change, action: 'move', offset: action === 'up' ? -1 : 1 });
    case 'copy':
      if (await copyResult(clip.outputs.gif.entry, control)) await mutate(id, { ...change, action: 'copied' });
      return;
    case 'drag': return;
    case 'preview': $('seriesPreview').src = clip.outputs[format].entry.url; return;
    case 'prepare': return prepare(id, clip.id, format);
    case 'cancel':
      await api('/api/job/' + clip.outputs[format].job + '/cancel', {});
      return tick();
    case 'booru': return editBooru(id, clip);
    case 'status':
      await api('/api/history/' + clip.outputs.webp.entry.id + '/booru/status', {});
      return tick();
    case 'portable': {
      const response = await fetch(base + '/' + id + '/portable', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ChaosClip': '1' }, body: JSON.stringify({ clip: clip.id }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = clip.outputs.webp.entry.file.replace(/\.webp$/i, '-classe.webp');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    default: return mutate(id, change);
  }
}));
review.addEventListener('dragstart', (event) => {
  if (!event.target.closest('[data-series-action=drag]')) return;
  const clip = selected();
  if (native && clip?.validated && clip.outputs.gif.entry) {
    event.preventDefault();
    native.startDrag(clip.outputs.gif.entry.path);
  }
});
review.addEventListener('submit', handle(async (event) => {
  const form = event.target.closest('[data-profile]');
  if (!form) return;
  event.preventDefault();
  const profile = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, key === 'dither' ? value : Number(value)]));
  await mutate(active.id, { action: 'profile', clip: selected().id, format: form.dataset.profile, profile });
  event.submitter?.blur();
  render();
}));

$('seriesScenes').addEventListener('click', () => runAction(`series-scenes:${active.id}`, t('Détection des plans'), async (activity) => {
  const id = active.id;
  const { source } = await api(base + '/' + id + '/source', {});
  const { job } = await api('/api/scenes/' + source.id, {});
  const cuts = await activity.wait(job);
  if (!dialog.open || active?.id !== id) return;
  const last = Math.max(0, (source.info.frameTimes?.length ?? Math.round(source.info.duration * source.info.fps)) - 1);
  const edges = [0, ...new Set(cuts.filter((frame) => frame > 0 && frame <= last)), last + 1];
  const sceneDialog = $('seriesScenesDlg');
  const template = structuredClone(ctx.source?.id === source.id ? state.doc : selected()?.doc || state.doc);
  const fieldset = $('seriesSceneChoices');
  fieldset.innerHTML = edges.slice(0, -1).map((frame, index) => '<label><input type="checkbox" value="' + index + '"> ' +
    esc(t('Images {a} à {b}', { a: frame, b: edges[index + 1] - 1 })) + '</label>').join('');
  $('seriesAddScenes').onclick = handle(async () => {
    const chosen = [...fieldset.querySelectorAll('input:checked')];
    sceneDialog.close();
    for (const choice of chosen) {
      const i = Number(choice.value);
      const doc = { ...template, sel: { start: edges[i], end: edges[i + 1] - 1 }, segments: [] };
      await mutate(id, { action: 'add', doc, settings: toServer(doc), sourceId: source.id });
    }
  });
  sceneDialog.showModal();
}, { host: $('seriesActivity'), controls: [$('seriesScenes')] }));
