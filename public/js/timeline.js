// Frise : miniatures, zoom, poignées de sélection, marqueurs, plans, segments, clés de suivi.
import { $, api, waitJob, fail, toast, debounce, esc } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, update } from './state.js';
import { gotoFrame, video, selRange, setSel, shownFrame } from './player.js';

const tl = $('timeline');
let view = [0, 1]; // plage visible, en images

const total = () => Math.max(1, ctx.lastFrame);
const span = () => Math.max(1, view[1] - view[0]);
const xOf = (f) => ((f - view[0]) / span()) * 100;
const frameAt = (clientX) => {
  const r = tl.getBoundingClientRect();
  return Math.round(view[0] + ((clientX - r.left) / r.width) * span());
};

function setView(a, b) {
  const len = Math.max(Math.min(total(), 24), b - a);
  a = Math.max(0, Math.min(total() - len, a));
  view = [a, a + len];
  $('tlZoom').value = Math.round(total() / len);
  render();
  loadStrip();
}

// Miniatures de la plage visible (rechargées après un temps de repos).
const loadStrip = debounce(() => {
  if (!ctx.source) return;
  const w = tl.clientWidth;
  const h = 54;
  const ar = ctx.source.info.width / ctx.source.info.height;
  const n = Math.max(1, Math.min(100, Math.round(w / (h * ar))));
  const from = view[0] / ctx.fps;
  const to = (view[1] + 1) / ctx.fps;
  const url = `/api/thumbs/${ctx.source.id}?from=${from.toFixed(3)}&to=${to.toFixed(3)}&n=${n}&h=${h}`;
  const img = new Image();
  img.onload = () => { $('tlStrip').style.backgroundImage = `url("${url}")`; };
  img.src = url;
}, 250);

export function render() {
  if (!ctx.source) return;
  const [a, b] = selRange();
  const sel = $('tlSel');
  sel.style.left = `${xOf(a)}%`;
  sel.style.width = `${Math.max(0.2, xOf(b + 1) - xOf(a))}%`;
  $('tlHead').style.left = `${xOf(shownFrame() + 0.5)}%`;
  const d = state.doc;
  $('tlSegments').innerHTML = d.segments.map((g, i) =>
    `<div class="tlseg" style="left:${xOf(g.start)}%;width:${Math.max(0.3, xOf(g.end + 1) - xOf(g.start))}%" title="${t('Segment')} ${i + 1}"></div>`).join('');
  const marks = [
    ...ctx.scenes.map((f) => `<div class="tlmark scene" style="left:${xOf(f)}%"></div>`),
    ...d.cropKeys.map((k) => `<div class="tlmark key" style="left:${xOf(k.frame)}%" title="${t('Clé de suivi')}"></div>`),
    ...d.markers.map((m) => `<div class="tlmark" style="left:${xOf(m.frame)}%" title="${esc(m.label || '')}"></div>`),
  ];
  $('tlMarks').innerHTML = marks.join('');
  $('tlInfo').textContent = view[0] > 0 || view[1] < total() ? `${t('vue')} ${view[0]}–${view[1]}` : '';
}

// ---------- souris ----------

let drag = null;
tl.addEventListener('pointerdown', (e) => {
  if (!ctx.source || e.button !== 0) return;
  tl.setPointerCapture(e.pointerId);
  const grip = e.target.dataset.grip;
  drag = grip ? { mode: grip } : { mode: 'seek' };
  if (!grip) { video.pause(); gotoFrame(frameAt(e.clientX)); }
});
tl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const f = Math.max(0, Math.min(ctx.lastFrame, frameAt(e.clientX)));
  const [a, b] = selRange();
  if (drag.mode === 'seek') gotoFrame(f);
  else if (drag.mode === 'in') { setSel(Math.min(f, b), b, 'grip'); gotoFrame(f); }
  else if (drag.mode === 'out') { setSel(a, Math.max(f, a), 'grip'); gotoFrame(f); }
});
tl.addEventListener('pointerup', () => { drag = null; });

// Molette : défilement ; Ctrl + molette : zoom autour du pointeur.
tl.addEventListener('wheel', (e) => {
  if (!ctx.source) return;
  e.preventDefault();
  if (e.ctrlKey) {
    const f = frameAt(e.clientX);
    const k = e.deltaY < 0 ? 0.8 : 1.25;
    const len = Math.min(total(), Math.max(24, span() * k));
    const ratio = (f - view[0]) / span();
    setView(f - ratio * len, f - ratio * len + len);
  } else {
    const d = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
    setView(view[0] + d * span() * 0.15, view[1] + d * span() * 0.15);
  }
}, { passive: false });

$('tlZoom').addEventListener('input', (e) => {
  const len = total() / Number(e.target.value);
  const c = shownFrame() >= 0 ? shownFrame() : (view[0] + view[1]) / 2;
  setView(c - len / 2, c + len / 2);
});

export function fitSelection() {
  const [a, b] = selRange();
  const pad = Math.max(12, (b - a) * 0.15);
  setView(a - pad, b + pad);
}
$('tlFit').addEventListener('click', fitSelection);

// La tête de lecture qui sort de la vue fait défiler la frise.
listen('frame', (f) => {
  if (!ctx.source) return;
  if (f < view[0] || f > view[1]) setView(f - span() * 0.1, f - span() * 0.1 + span());
  else $('tlHead').style.left = `${xOf(f + 0.5)}%`;
});

listen('source', () => {
  ctx.scenes = [];
  view = [0, total()];
  $('tlZoom').value = 1;
  $('tlStrip').style.backgroundImage = '';
  render();
  loadStrip();
});
new ResizeObserver(() => { if (ctx.source) loadStrip(); }).observe(tl);

// ---------- changements de plan ----------

$('scenesBtn').addEventListener('click', async () => {
  try {
    const r = await api(`/api/scenes/${ctx.source.id}`, {});
    ctx.scenes = await waitJob(r.job, t('Changements de plan'));
    toast(t('{n} changements de plan trouvés : Pg↑ / Pg↓ pour sauter de l’un à l’autre', { n: ctx.scenes.length }), 'ok');
    render();
  } catch (e) { fail(e); }
});

// Saut au plan (ou au marqueur) suivant / précédent.
export function jumpCut(dir) {
  const pts = [...ctx.scenes, ...state.doc.markers.map((m) => m.frame), 0, ctx.lastFrame].sort((a, b) => a - b);
  const f = shownFrame();
  const next = dir > 0 ? pts.find((p) => p > f) : [...pts].reverse().find((p) => p < f);
  if (next !== undefined) { video.pause(); gotoFrame(next); }
}

// ---------- marqueurs ----------

export function addMarker(frame = shownFrame()) {
  if (state.doc.markers.some((m) => m.frame === frame)) return;
  update((d) => { d.markers.push({ frame, label: '' }); d.markers.sort((x, y) => x.frame - y.frame); });
}

export function renderMarkers() {
  $('markerList').innerHTML = state.doc.markers.map((m, i) =>
    `<span class="chip"><a href="#" data-mk="${i}">◆ ${m.frame}${m.label ? ` · ${esc(m.label)}` : ''}</a><button type="button" data-mkdel="${i}" aria-label="${t('Supprimer')}">✕</button></span>`).join('');
}
$('markerList').addEventListener('click', (e) => {
  const go = e.target.closest('[data-mk]');
  const del = e.target.closest('[data-mkdel]');
  if (go) { e.preventDefault(); video.pause(); gotoFrame(state.doc.markers[Number(go.dataset.mk)].frame); }
  if (del) update((d) => { d.markers.splice(Number(del.dataset.mkdel), 1); });
});
$('markerList').addEventListener('dblclick', async (e) => {
  const go = e.target.closest('[data-mk]');
  if (!go) return;
  const { ask } = await import('./util.js');
  const i = Number(go.dataset.mk);
  const label = await ask(t('Nom du marqueur'), state.doc.markers[i].label);
  if (label !== null) update((d) => { d.markers[i].label = label; });
});
