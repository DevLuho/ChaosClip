// Calque sur la vidéo : recadrage (poignées), zones floues, pipette, textes déplaçables.
import { $, esc, api, runAction, toast } from './util.js';
import { t } from './i18n.js';
import { ctx, listen, emit } from './ctx.js';
import { state, update } from './state.js';
import { video, shownFrame, selRange } from './player.js';

const overlay = $('overlay');
const box = $('cropBox');
let mode = 'crop';
export const setMode = (m) => { mode = m; $('drawMode').value = m; overlay.classList.toggle('pick', m === 'pick'); };
$('drawMode').addEventListener('change', (e) => setMode(e.target.value));

// Échelles : px source par px affiché (sans zoom) et par px écran (avec zoom).
const kLayout = () => ctx.source.info.width / overlay.offsetWidth;
const kScreen = () => ctx.source.info.width / overlay.getBoundingClientRect().width;
const W = () => ctx.source.info.width;
const H = () => ctx.source.info.height;
const toSrc = (e) => {
  const r = overlay.getBoundingClientRect();
  const k = kScreen();
  return { x: Math.max(0, Math.min(W(), (e.clientX - r.left) * k)), y: Math.max(0, Math.min(H(), (e.clientY - r.top) * k)) };
};
const aspect = () => Number($('aspect').value) || 0;

// Position du cadre à l'image f quand il suit des clés (interpolation linéaire).
export function cropAt(f) {
  const c = state.doc.crop;
  const keys = state.doc.cropKeys;
  if (!c || !keys.length) return c;
  if (f <= keys[0].frame) return { ...c, x: keys[0].x, y: keys[0].y };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]; const b = keys[i + 1];
    if (f < b.frame) {
      const r = (f - a.frame) / (b.frame - a.frame);
      return { ...c, x: Math.round(a.x + (b.x - a.x) * r), y: Math.round(a.y + (b.y - a.y) * r) };
    }
  }
  const z = keys[keys.length - 1];
  return { ...c, x: z.x, y: z.y };
}

export function render() {
  if (!ctx.source || !overlay.offsetWidth) return;
  const k = kLayout();
  const c = cropAt(shownFrame());
  box.hidden = !c;
  if (c) {
    Object.assign(box.style, { left: `${c.x / k}px`, top: `${c.y / k}px`, width: `${c.w / k}px`, height: `${c.h / k}px` });
    $('cropSize').textContent = `${c.w}×${c.h}${state.doc.cropKeys.length ? ` · ${t('suivi')}` : ''}`;
  }
  $('blurBoxes').innerHTML = state.doc.blurZones.map((z, i) =>
    `<div class="blurbox" style="left:${z.x / k}px;top:${z.y / k}px;width:${z.w / k}px;height:${z.h / k}px"><button type="button" data-blurdel="${i}" title="${t('Supprimer')}">✕</button></div>`).join('');
  renderTexts(c, k);
}

// ---------- textes ----------

export let selectedText = -1;
export const selectText = (i) => { selectedText = i; emit('textsel', i); render(); };

function outputTime() {
  // Approximation (sans segments) : temps de sortie de l'image affichée.
  const [a] = selRange();
  return (ctx.frameTime(Math.max(0, shownFrame())) - ctx.frameTime(a)) / (state.doc.opts.speed || 1);
}

function renderTexts(c, k) {
  const layer = $('textLayer');
  const area = c || { x: 0, y: 0, w: W(), h: H() };
  Object.assign(layer.style, { left: `${area.x / k}px`, top: `${area.y / k}px`, width: `${area.w / k}px`, height: `${area.h / k}px` });
  const hpx = area.h / k;
  const now = outputTime();
  layer.innerHTML = state.doc.texts.map((tx, i) => {
    const fs = (tx.size / 100) * hpx;
    const ow = Math.max(1, (fs * tx.outline) / 100);
    const visible = now >= tx.start && (!(tx.end > tx.start) || now <= tx.end);
    return `<div class="tx${i === selectedText ? ' sel' : ''}${visible ? '' : ' off'}" data-tx="${i}" style="left:${tx.x}%;top:${tx.y}%;` +
      `font-family:'${esc(tx.font || 'Impact')}',Impact,Arial,sans-serif;font-size:${fs}px;color:${tx.color};` +
      `font-weight:${tx.bold ? 700 : 400};font-style:${tx.italic ? 'italic' : 'normal'};` +
      `-webkit-text-stroke:${ow * 2}px ${tx.outlineColor};paint-order:stroke fill">${esc(tx.content)}</div>`;
  }).join('');
}

// ---------- souris ----------

let drag = null;
overlay.addEventListener('pointerdown', (e) => {
  if (!ctx.source || e.button !== 0) return;
  const del = e.target.closest('[data-blurdel]');
  if (del) { update((d) => { d.blurZones.splice(Number(del.dataset.blurdel), 1); }); return; }
  overlay.setPointerCapture(e.pointerId);
  const p = toSrc(e);
  const txEl = e.target.closest('[data-tx]');
  if (txEl) {
    const i = Number(txEl.dataset.tx);
    selectText(i);
    drag = { mode: 'text', i };
    return;
  }
  if (mode === 'pick') { pickColor(e); return; }
  if (mode === 'blur') { drag = { mode: 'blur', start: p }; return; }
  const h = e.target.dataset.h;
  const c = cropAt(shownFrame());
  if (h && c) drag = { mode: 'resize', h, orig: { ...c }, start: p };
  else if (c && e.target.closest('#cropBox')) drag = { mode: 'move', start: p, orig: { ...c } };
  else drag = { mode: 'draw', start: p };
});

overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = toSrc(e);
  if (drag.mode === 'text') {
    const c = cropAt(shownFrame()) || { x: 0, y: 0, w: W(), h: H() };
    const x = Math.max(0, Math.min(100, ((p.x - c.x) / c.w) * 100));
    const y = Math.max(0, Math.min(100, ((p.y - c.y) / c.h) * 100));
    update((d) => { Object.assign(d.texts[drag.i], { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }); }, { coalesce: `tx${drag.i}` });
    return;
  }
  if (drag.mode === 'move') {
    const o = drag.orig;
    const x = Math.round(Math.max(0, Math.min(W() - o.w, o.x + p.x - drag.start.x)));
    const y = Math.round(Math.max(0, Math.min(H() - o.h, o.y + p.y - drag.start.y)));
    moveCrop(x, y);
    return;
  }
  if (drag.mode === 'resize') { resizeCrop(drag, p); return; }
  const r = rectFrom(drag.start, p, drag.mode === 'draw' ? aspect() : 0);
  if (drag.mode === 'draw') update((d) => { d.crop = r; d.cropKeys = []; }, { coalesce: 'cropdraw' });
  else drag.rect = r, drawGhost(r);
});

overlay.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.mode === 'draw' && state.doc.crop && (state.doc.crop.w < 8 || state.doc.crop.h < 8)) update((d) => { d.crop = null; }, { undoable: false });
  if (drag.mode === 'blur' && drag.rect && drag.rect.w >= 6 && drag.rect.h >= 6) {
    const r = drag.rect;
    update((d) => { d.blurZones.push(r); });
  }
  $('blurGhost')?.remove();
  drag = null;
});

function rectFrom(a, b, ar) {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (ar) { if (w / h > ar) w = h * ar; else h = w / ar; }
  let x = b.x < a.x ? a.x - w : a.x;
  let y = b.y < a.y ? a.y - h : a.y;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(w, W() - x); h = Math.min(h, H() - y);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function drawGhost(r) {
  let g = $('blurGhost');
  if (!g) { g = document.createElement('div'); g.id = 'blurGhost'; g.className = 'blurbox'; $('blurBoxes').after(g); }
  const k = kLayout();
  Object.assign(g.style, { left: `${r.x / k}px`, top: `${r.y / k}px`, width: `${r.w / k}px`, height: `${r.h / k}px` });
}

// Avec des clés de suivi, déplacer le cadre modifie (ou crée) la clé de l'image affichée.
function moveCrop(x, y) {
  const f = shownFrame();
  update((d) => {
    if (d.cropKeys.length) {
      const k = d.cropKeys.find((kk) => kk.frame === f);
      if (k) Object.assign(k, { x, y });
      else { d.cropKeys.push({ frame: f, x, y }); d.cropKeys.sort((a, b) => a.frame - b.frame); }
    } else Object.assign(d.crop, { x, y });
  }, { coalesce: 'cropmove' });
}

function resizeCrop(dr, p) {
  const o = dr.orig;
  let x1 = o.x; let y1 = o.y; let x2 = o.x + o.w; let y2 = o.y + o.h;
  if (dr.h.includes('w')) x1 = Math.min(x2 - 8, p.x);
  if (dr.h.includes('e')) x2 = Math.max(x1 + 8, p.x);
  if (dr.h.includes('n')) y1 = Math.min(y2 - 8, p.y);
  if (dr.h.includes('s')) y2 = Math.max(y1 + 8, p.y);
  let w = x2 - x1; let h = y2 - y1;
  const ar = aspect();
  if (ar) {
    // Ratio imposé : la dimension tirée commande l'autre.
    if (dr.h === 'n' || dr.h === 's') w = h * ar; else h = w / ar;
    if (dr.h.includes('w')) x1 = x2 - w;
    if (dr.h.includes('n')) y1 = y2 - h;
  }
  x1 = Math.max(0, x1); y1 = Math.max(0, y1);
  w = Math.min(w, W() - x1); h = Math.min(h, H() - y1);
  const r = { x: Math.round(x1), y: Math.round(y1), w: Math.round(w), h: Math.round(h) };
  update((d) => {
    d.crop = r;
    // La taille est commune à toutes les clés : on garde leurs positions dans l'image.
    d.cropKeys.forEach((k) => { k.x = Math.min(k.x, W() - r.w); k.y = Math.min(k.y, H() - r.h); });
  }, { coalesce: 'cropresize' });
}

// ---------- pipette ----------

function pickColor(e) {
  const r = overlay.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, 0, 0);
  const x = Math.floor(((e.clientX - r.left) / r.width) * canvas.width);
  const y = Math.floor(((e.clientY - r.top) / r.height) * canvas.height);
  const [R, G, B] = g.getImageData(x, y, 1, 1).data;
  const hex = `#${[R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  update((d) => { d.transparent = hex; });
  setMode('crop');
}

// ---------- champs et boutons du recadrage ----------

['cx', 'cy', 'cw', 'ch'].forEach((k) => $(k).addEventListener('change', () => {
  const v = ['cx', 'cy', 'cw', 'ch'].map((i) => Number($(i).value) || 0);
  update((d) => { d.crop = v[2] > 0 && v[3] > 0 ? { x: v[0], y: v[1], w: Math.min(v[2], W() - v[0]), h: Math.min(v[3], H() - v[1]) } : null; });
}));
export function renderCropFields() {
  const c = state.doc.crop;
  ['cx', 'cy', 'cw', 'ch'].forEach((k, i) => { if (document.activeElement !== $(k)) $(k).value = c ? [c.x, c.y, c.w, c.h][i] : ''; });
  $('cropKeyInfo').textContent = state.doc.cropKeys.length ? t('{n} clés', { n: state.doc.cropKeys.length }) : '';
}
$('cropAuto').addEventListener('click', () => {
  if (!ctx.source) return;
  const tabId = ctx.tabId;
  const id = ctx.source.id;
  const frame = Math.max(0, shownFrame());
  const doc = state.doc;
  return runAction(`crop:${tabId}`, t('Recherche des bandes noires…'), async () => {
    const { crop } = await api(`/api/cropdetect/${id}`, { frame });
    if (ctx.tabId !== tabId || state.doc !== doc) return;
    if (!crop) return toast(t('Aucune bande noire détectée.'));
    update((d) => { d.crop = crop; d.cropKeys = []; });
  }, { host: $('playerActivity'), controls: [$('cropAuto')] });
});
$('cropReset').addEventListener('click', () => update((d) => { d.crop = null; d.cropKeys = []; }));
$('cropCenter').addEventListener('click', () => {
  const ar = aspect();
  update((d) => {
    let c = d.crop;
    if (!c) {
      // Pas de cadre : le plus grand cadre au ratio choisi.
      let w = W(); let h = H();
      if (ar) { if (w / h > ar) w = Math.round(h * ar); else h = Math.round(w / ar); }
      c = { w, h };
    }
    d.crop = { w: c.w, h: c.h, x: Math.round((W() - c.w) / 2), y: Math.round((H() - c.h) / 2) };
    d.cropKeys = [];
  });
});
$('aspect').addEventListener('change', () => {
  const ar = aspect();
  const c = state.doc.crop;
  if (!ar || !c) return;
  let w = c.w; let h = c.h;
  if (w / h > ar) w = Math.round(h * ar); else h = Math.round(w / ar);
  update((d) => { d.crop = { x: c.x + Math.round((c.w - w) / 2), y: c.y + Math.round((c.h - h) / 2), w, h }; });
});
$('cropKeyAdd').addEventListener('click', () => {
  const c = cropAt(shownFrame());
  if (!c) return;
  const f = shownFrame();
  update((d) => {
    if (!d.cropKeys.length && f !== selRange()[0]) d.cropKeys.push({ frame: selRange()[0], x: c.x, y: c.y });
    d.cropKeys = d.cropKeys.filter((k) => k.frame !== f);
    d.cropKeys.push({ frame: f, x: c.x, y: c.y });
    d.cropKeys.sort((a, b) => a.frame - b.frame);
  });
});
$('cropKeyClear').addEventListener('click', () => update((d) => { d.cropKeys = []; }));
$('gridBtn').addEventListener('click', () => { $('grid').hidden = !$('grid').hidden; });
$('blurAdd').addEventListener('click', () => setMode('blur'));
$('blurClear').addEventListener('click', () => update((d) => { d.blurZones = []; }));
$('transPick').addEventListener('click', () => setMode('pick'));

listen('frame', () => render());
listen('layout', () => render());
