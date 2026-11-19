// Panneau de réglages : format, préréglages, segments, textes, sous-titres, logo, transparence.
import { $, $$, api, esc, toast, fail, ask, uploadRaw } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, update, renderInputs, deepMerge, DEFAULT_OPTS } from './state.js';
import { selRange, shownFrame, gotoFrame, video, playRange } from './player.js';
import { selectText, selectedText } from './overlay.js';

// ---------- visibilité selon le format ----------

export function renderFormat() {
  const o = state.doc.opts;
  const f = o.format;
  const isVideo = f === 'mp4' || f === 'webm';
  const show = (sel, on) => $$(sel).forEach((el) => { el.hidden = !on; });
  show('.onlyGif', f === 'gif');
  show('.withQuality', ['webp', 'avif', 'mp4', 'webm'].includes(f));
  show('.onlyVideo', isVideo);
  show('.onlyAudio', isVideo || f === 'mp3');
  show('.sheetOnly', f === 'sheet');
  show('.bayerOnly', o.dither === 'bayer');
  show('.maxCustom', o.maxPreset === 'custom');
  const q = document.querySelector('[data-bind="opts.quality"]');
  if (isVideo) { q.min = 15; q.max = f === 'mp4' ? 40 : 50; $('qualityLabel').textContent = t('CRF (bas = meilleur)'); }
  else { q.min = 1; q.max = 100; $('qualityLabel').textContent = t('Qualité'); }
}

// ---------- préréglages ----------

const BUILTIN = [
  { name: 'GIF Discord standard (20 Mo)', opts: { format: 'gif', width: 480, fps: 15, maxPreset: '20', lossy: 40 } },
  { name: 'GIF Discord léger (10 Mo)', opts: { format: 'gif', width: 480, fps: 15, maxPreset: '10', lossy: 40 } },
  { name: 'WebP Discord léger', opts: { format: 'webp', width: 540, fps: 20, quality: 70, maxPreset: '10' } },
  { name: 'MP4 Discord standard (20 Mo)', opts: { format: 'mp4', width: 1280, fps: 0, audio: true, quality: 20, maxPreset: '20' } },
  { name: 'Emoji Discord (256 Ko, 128 px)', opts: { format: 'gif', width: 128, fps: 15, maxPreset: 'custom', maxSizeMB: 0.25, lossy: 60 }, aspect: '1' },
  { name: 'Sticker Discord (APNG 320 px, 512 Ko)', opts: { format: 'apng', width: 320, fps: 15, maxPreset: 'custom', maxSizeMB: 0.5 }, aspect: '1' },
  { name: 'Avatar animé (GIF 512 px)', opts: { format: 'gif', width: 512, fps: 20, maxPreset: '10' }, aspect: '1' },
  { name: 'Bannière de profil (GIF 680×240)', opts: { format: 'gif', width: 680, fps: 15, maxPreset: '10' }, aspect: '2.8333' },
];
let presets = [];

export async function loadPresets() {
  try { presets = await api('/api/presets'); } catch { presets = []; }
  renderPresets();
}
function renderPresets() {
  const sel = $('presetSelect');
  sel.innerHTML = `<option value="">—</option><optgroup label="${t('Discord')}">${BUILTIN.map((p, i) => `<option value="b${i}">${esc(t(p.name))}</option>`).join('')}</optgroup>` +
    (presets.length ? `<optgroup label="${t('Mes préréglages')}">${presets.map((p, i) => `<option value="u${i}">${esc(p.name)}</option>`).join('')}</optgroup>` : '');
}
$('presetSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  const p = v[0] === 'b' ? BUILTIN[Number(v.slice(1))] : presets[Number(v.slice(1))];
  update((d) => { d.opts = deepMerge(deepMerge(DEFAULT_OPTS, d.opts), p.opts); });
  if (p.aspect) { $('aspect').value = p.aspect; $('aspect').dispatchEvent(new Event('change')); }
  toast(t('Préréglage appliqué : {name}', { name: t(p.name) }));
});
$('presetSave').addEventListener('click', async () => {
  const name = await ask(t('Nom du préréglage'));
  if (!name) return;
  presets = presets.filter((p) => p.name !== name);
  presets.push({ name, opts: JSON.parse(JSON.stringify(state.doc.opts)) });
  try { await api('/api/presets', presets, 'PUT'); renderPresets(); toast(t('Préréglage enregistré'), 'ok'); } catch (e) { fail(e); }
});
$('presetDelete').addEventListener('click', async () => {
  const v = $('presetSelect').value;
  if (!v || v[0] !== 'u') return toast(t('Choisis un de tes préréglages'));
  presets.splice(Number(v.slice(1)), 1);
  try { await api('/api/presets', presets, 'PUT'); renderPresets(); } catch (e) { fail(e); }
});

// ---------- segments ----------

export function addSegment() {
  const [a, b] = selRange();
  update((d) => { d.segments.push({ start: a, end: b, speed: 1, hold: 0 }); });
  toast(t('Segment ajouté ({n} au total)', { n: state.doc.segments.length }));
}

export function renderSegments() {
  const segs = state.doc.segments;
  $('segCount').textContent = segs.length ? `(${segs.length})` : '';
  $('segList').innerHTML = segs.map((g, i) => `<li data-seg="${i}">
    <strong>${i + 1}.</strong>
    <input type="number" data-k="start" value="${g.start}" min="0" title="${t('Début')}"> → <input type="number" data-k="end" value="${g.end}" min="0" title="${t('Fin')}">
    ×<input type="number" data-k="speed" value="${g.speed}" step="0.25" min="0.1" max="10" title="${t('Vitesse')}">
    ${t('arrêt')} <input type="number" data-k="hold" value="${g.hold}" step="0.5" min="0" max="30" title="${t('Image figée à la fin (secondes)')}">s
    <button type="button" class="ghost small" data-segact="play" title="${t('Lire')}">▶</button>
    <button type="button" class="ghost small" data-segact="up" title="${t('Monter')}">↑</button>
    <button type="button" class="ghost small" data-segact="del" title="${t('Supprimer')}">✕</button></li>`).join('');
}
$('segList').addEventListener('change', (e) => {
  const li = e.target.closest('[data-seg]');
  if (!li || !e.target.dataset.k) return;
  const i = Number(li.dataset.seg);
  update((d) => { d.segments[i][e.target.dataset.k] = Number(e.target.value); });
});
$('segList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-segact]');
  if (!b) return;
  const i = Number(b.closest('[data-seg]').dataset.seg);
  const g = state.doc.segments[i];
  if (b.dataset.segact === 'play') playRange(g.start, g.end);
  if (b.dataset.segact === 'del') update((d) => { d.segments.splice(i, 1); });
  if (b.dataset.segact === 'up' && i > 0) update((d) => { [d.segments[i - 1], d.segments[i]] = [d.segments[i], d.segments[i - 1]]; });
});
$('segClear').addEventListener('click', () => update((d) => { d.segments = []; }));
// Coupe la sélection (ou le segment sous la tête) en deux : pour retirer ou figer des images.
$('segSplit').addEventListener('click', () => {
  const f = shownFrame();
  update((d) => {
    if (!d.segments.length) {
      const [a, b] = selRange();
      d.segments = [{ start: a, end: b, speed: 1, hold: 0 }];
    }
    const i = d.segments.findIndex((g) => f > g.start && f <= g.end);
    if (i < 0) return;
    const g = d.segments[i];
    d.segments.splice(i, 1, { ...g, end: f - 1, hold: 0 }, { ...g, start: f });
  });
  toast(t('Coupé : modifie ou supprime un des morceaux, ou ajoute un arrêt sur image.'));
});

// ---------- textes ----------

let fontList = [];
export async function loadFonts() {
  try {
    const r = await api('/api/fonts');
    fontList = r.fonts;
    if (r.default) DEFAULT_TEXT.font = r.default;
  } catch { fontList = []; }
}
const DEFAULT_TEXT = { content: '', start: 0, end: 0, x: 50, y: 88, font: 'Impact', size: 9, color: '#ffffff', outlineColor: '#000000', outline: 8, bold: true, italic: false };

// Style enregistré par « Style par défaut » : repris par chaque nouveau texte.
const STYLE_KEYS = ['font', 'size', 'color', 'outlineColor', 'outline', 'bold', 'italic'];
function savedTextStyle() {
  try { return JSON.parse(localStorage.getItem('chaosclip.textStyle') || '{}'); } catch { return {}; }
}
$('textAdd').addEventListener('click', () => {
  update((d) => { d.texts.push({ ...DEFAULT_TEXT, ...savedTextStyle(), content: t('Texte'), y: d.texts.length ? 12 : 88 }); });
  selectText(state.doc.texts.length - 1);
  setTimeout(() => $('textList').querySelector(`[data-ti="${state.doc.texts.length - 1}"] textarea`)?.select(), 0);
});

let renderingTexts = false;
export function renderTexts() {
  // Remplacer la liste fait perdre le focus, ce qui déclenche « change » puis un nouveau rendu.
  if (renderingTexts) return;
  renderingTexts = true;
  try { renderTextsInner(); } finally { renderingTexts = false; }
}
function renderTextsInner() {
  const list = $('textList');
  $('textCount').textContent = state.doc.texts.length ? `(${state.doc.texts.length})` : '';
  // On ne reconstruit pas pendant la saisie (sinon le curseur saute).
  if (list.contains(document.activeElement) && list.children.length === state.doc.texts.length) return;
  const opts = (sel) => fontList.map((f) => `<option${f === sel ? ' selected' : ''}>${esc(f)}</option>`).join('');
  list.innerHTML = state.doc.texts.map((tx, i) => `<div class="textitem${i === selectedText ? ' sel' : ''}" data-ti="${i}">
    <textarea rows="2" data-tk="content">${esc(tx.content)}</textarea>
    <div class="row wrap">
      <select data-tk="font" title="${t('Police')}">${fontList.includes(tx.font) ? '' : `<option selected>${esc(tx.font)}</option>`}${opts(tx.font)}</select>
      <input type="number" data-tk="size" value="${tx.size}" min="1" max="40" step="0.5" class="tiny" title="${t('Taille (% de la hauteur)')}">%
      <input type="color" data-tk="color" value="${tx.color}" title="${t('Couleur')}">
      <input type="color" data-tk="outlineColor" value="${tx.outlineColor}" title="${t('Contour')}">
      <input type="number" data-tk="outline" value="${tx.outline}" min="0" max="40" class="tiny" title="${t('Épaisseur du contour')}">
      <label class="small"><input type="checkbox" data-tk="bold"${tx.bold ? ' checked' : ''}> ${t('Gras')}</label>
      <label class="small"><input type="checkbox" data-tk="italic"${tx.italic ? ' checked' : ''}> ${t('Italique')}</label>
    </div>
    <div class="row wrap small">
      ${t('de')} <input type="number" data-tk="start" value="${tx.start}" min="0" step="0.1" class="tiny"> ${t('à')} <input type="number" data-tk="end" value="${tx.end}" min="0" step="0.1" class="tiny"> s
      <button type="button" class="ghost small" data-tact="startHere" title="${t('Apparaît à l’image actuelle')}">⇤ ${t('ici')}</button>
      <button type="button" class="ghost small" data-tact="endHere" title="${t('Disparaît à l’image actuelle')}">${t('ici')} ⇥</button>
      <span class="muted">(${t('fin 0 = jusqu’au bout')})</span>
    </div>
    <div class="row wrap small">
      <button type="button" class="ghost small" data-tact="top">${t('Haut')}</button>
      <button type="button" class="ghost small" data-tact="mid">${t('Milieu')}</button>
      <button type="button" class="ghost small" data-tact="bottom">${t('Bas')}</button>
      <button type="button" class="ghost small" data-tact="dup">${t('Dupliquer')}</button>
      <button type="button" class="ghost small" data-tact="style" title="${t('Les nouveaux textes prendront cette police, cette taille et ces couleurs')}">${t('Style par défaut')}</button>
      <button type="button" class="ghost small" data-tact="del">${t('Supprimer')}</button>
    </div></div>`).join('');
}
const outTime = () => {
  const [a] = selRange();
  return Math.max(0, Math.round(((ctx.frameTime(Math.max(0, shownFrame())) - ctx.frameTime(a)) / state.doc.opts.speed) * 10) / 10);
};
$('textList').addEventListener('input', (e) => {
  const item = e.target.closest('[data-ti]');
  const k = e.target.dataset.tk;
  if (!item || !k) return;
  const i = Number(item.dataset.ti);
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
  update((d) => { d.texts[i][k] = v; }, { coalesce: `text${i}${k}` });
});
$('textList').addEventListener('focusin', (e) => {
  const item = e.target.closest('[data-ti]');
  if (item && Number(item.dataset.ti) !== selectedText) selectText(Number(item.dataset.ti));
});
$('textList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tact]');
  if (!b) return;
  const i = Number(b.closest('[data-ti]').dataset.ti);
  const act = b.dataset.tact;
  if (act === 'style') {
    const tx = state.doc.texts[i];
    try { localStorage.setItem('chaosclip.textStyle', JSON.stringify(Object.fromEntries(STYLE_KEYS.map((k) => [k, tx[k]])))); } catch { /* ignoré */ }
    toast(t('Style enregistré pour les prochains textes'), 'ok');
    return;
  }
  update((d) => {
    const tx = d.texts[i];
    if (act === 'del') d.texts.splice(i, 1);
    if (act === 'dup') d.texts.splice(i + 1, 0, { ...tx, y: Math.min(95, tx.y + 10) });
    if (act === 'top') Object.assign(tx, { x: 50, y: 10 });
    if (act === 'mid') Object.assign(tx, { x: 50, y: 50 });
    if (act === 'bottom') Object.assign(tx, { x: 50, y: 88 });
    if (act === 'startHere') tx.start = outTime();
    if (act === 'endHere') tx.end = outTime();
  });
  $('textList').blur();
  renderTextsForce();
});
function renderTextsForce() { document.activeElement?.blur(); renderTexts(); }
listen('textsel', () => renderTextsForce());

// ---------- sous-titres ----------

export function renderSubs() {
  const src = ctx.source;
  const sel = $('subsSelect');
  if (!src) return;
  const cur = state.doc.subs ? `${state.doc.subs.kind}:${state.doc.subs.index}` : '';
  sel.innerHTML = `<option value="">${t('Aucun')}</option>` +
    src.info.subtitles.map((s) => `<option value="stream:${s.index}">${esc(s.label || `${t('Piste')} ${s.index + 1}`)}${s.image ? ` (${t('image')})` : ''}</option>`).join('') +
    src.externalSubs.map((s) => `<option value="external:${s.index}">${esc(s.label)} (${t('fichier')})</option>`).join('');
  sel.value = cur;
}
$('subsSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  update((d) => { d.subs = v ? { kind: v.split(':')[0], index: Number(v.split(':')[1]) } : null; });
});
$('subsLoad').addEventListener('click', () => $('subsFile').click());
$('subsFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !ctx.source) return;
  try {
    const r = await uploadRaw(`/api/subs/${ctx.source.id}`, f, f.name);
    ctx.source = r.source;
    update((d) => { d.subs = { kind: 'external', index: r.source.externalSubs.length - 1 }; });
    renderSubs();
    toast(t('Sous-titres chargés'), 'ok');
  } catch (err) { fail(err); }
  e.target.value = '';
});

// ---------- pistes audio ----------

export function renderAudioTracks() {
  const src = ctx.source;
  if (!src) return;
  $('audioTrack').innerHTML = src.info.audioTracks.map((a) => `<option value="${a.index}">${esc(a.label || `${t('Piste')} ${a.index + 1}`)}</option>`).join('');
  $('audioTrack').value = state.doc.opts.audioTrack;
}

// ---------- logo ----------

$('logoLoad').addEventListener('click', () => $('logoFile').click());
$('logoFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await uploadRaw('/api/logo', f, f.name);
    update((d) => { d.logo = { file: r.file, animated: r.animated, name: f.name }; });
  } catch (err) { fail(err); }
  e.target.value = '';
});
$('logoClear').addEventListener('click', () => update((d) => { d.logo = null; }));
export function renderLogo() {
  $('logoName').textContent = state.doc.logo ? state.doc.logo.name : '';
  $('logoClear').hidden = !state.doc.logo;
}

// ---------- transparence ----------

$('transOn').addEventListener('change', (e) => update((d) => { d.transparent = e.target.checked ? $('transColor').value : null; }));
$('transColor').addEventListener('input', (e) => update((d) => { d.transparent = e.target.value; }, { coalesce: 'transColor' }));
export function renderTransparent() {
  $('transOn').checked = !!state.doc.transparent;
  if (state.doc.transparent) $('transColor').value = state.doc.transparent;
  $('blurCount').textContent = state.doc.blurZones.length ? `(${state.doc.blurZones.length})` : '';
}

// ---------- mode simple / avancé ----------

$$('input[name=uimode]').forEach((r) => r.addEventListener('change', () => {
  document.body.classList.toggle('simple', r.value === 'simple' && r.checked);
  try { localStorage.setItem('chaosclip.mode', r.value); } catch { /* ignoré */ }
}));
try {
  if (localStorage.getItem('chaosclip.mode') === 'adv') {
    document.querySelector('input[name=uimode][value=adv]').checked = true;
    document.body.classList.remove('simple');
  }
} catch { /* ignoré */ }

// Sections repliées mémorisées.
$$('#settings details').forEach((d, i) => {
  try {
    const v = localStorage.getItem(`chaosclip.details.${i}`);
    if (v !== null) d.open = v === '1';
  } catch { /* ignoré */ }
  d.addEventListener('toggle', () => { try { localStorage.setItem(`chaosclip.details.${i}`, d.open ? '1' : '0'); } catch { /* ignoré */ } });
});

export function renderAll() {
  renderInputs();
  renderFormat();
  renderSegments();
  renderTexts();
  renderSubs();
  renderLogo();
  renderTransparent();
  $('undoBtn').disabled = !state.undoStack.length;
  $('redoBtn').disabled = !state.redoStack.length;
}

export { video, gotoFrame };
