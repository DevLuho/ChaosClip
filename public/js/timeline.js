// Frise : miniatures, zoom, poignées de sélection, marqueurs, plans, segments, clés de suivi.
import { $, api, runAction, toast, debounce, esc, fmtTime } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, update } from './state.js';
import { gotoFrame, video, selRange, setSel, shownFrame } from './player.js';

const tl = $('timeline');
let stripRevision = 0;
let stripDelay;
let requestedStrip = '';
let view = [0, 1]; // plage visible, en images

const total = () => ctx.lastFrame + 1;
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

// Miniatures de la plage visible (rechargées après un temps de repos) : une image par case, demandées quatre
// à la fois pour laisser des connexions à la vidéo. Elles s'affichent au fur et à mesure, et chaque case garde
// l'ancienne image jusqu'à l'arrivée de la nouvelle.
const loadStrip = debounce(() => {
  if (!ctx.source || !tl.clientWidth) return;
  const strip = $('tlStrip');
  const h = 59;
  const ar = ctx.source.info.width / ctx.source.info.height;
  const n = Math.max(1, Math.min(100, Math.round(tl.clientWidth / (h * ar))));
  const from = ctx.frameTime(view[0]);
  const cell = (ctx.frameTime(view[1]) - from) / n;
  // Cases de 2 s ou plus : l'image clé la plus proche suffit, et le serveur la sort bien plus vite.
  // En dessous, la rangée est demandée à l'image près (une seule passe côté serveur).
  const wide = cell >= 2;
  const base = `/api/thumbs/${ctx.source.id}?h=${h}` + (wide ? '&t=' : `&from=${from.toFixed(3)}&cell=${cell.toFixed(4)}&n=${n}&i=`);
  const key = `${base}${from.toFixed(3)}:${cell.toFixed(4)}:${n}`;
  if (key === requestedStrip) return;
  requestedStrip = key;
  const revision = ++stripRevision;
  while (strip.children.length > n) strip.lastChild.remove();
  while (strip.children.length < n) strip.append(new Image());
  clearTimeout(stripDelay);
  stripDelay = setTimeout(() => { $('tlLoading').hidden = false; }, 200);
  let next = 0;
  const pump = () => {
    if (revision !== stripRevision || next >= n) return;
    const i = next++;
    const img = new Image();
    img.onload = img.onerror = (e) => {
      if (revision !== stripRevision) return;
      clearTimeout(stripDelay);
      $('tlLoading').hidden = true;
      if (e.type === 'load') strip.children[i].replaceWith(img);
      else requestedStrip = ''; // case manquée : la prochaine demande réessaie
      pump();
    };
    img.src = base + (wide ? (from + (i + 0.5) * cell).toFixed(3) : i);
  };
  for (let k = 0; k < 4; k++) pump();
}, 250);

export function render() {
  if (!ctx.source) return;
  const [a, b] = selRange();
  const sel = $('tlSel');
  sel.style.left = `${xOf(a)}%`;
  sel.style.width = `${Math.max(0.2, xOf(b + 1) - xOf(a))}%`;
  $('tlHead').style.left = `${xOf(shownFrame() + 0.5)}%`;
  renderRuler();
  for (const handle of tl.querySelectorAll('[data-grip]')) {
    const first = handle.dataset.grip === 'in';
    const value = first ? a : b;
    handle.setAttribute('aria-valuemin', first ? 0 : a);
    handle.setAttribute('aria-valuemax', first ? b : ctx.lastFrame);
    handle.setAttribute('aria-valuenow', value);
    handle.setAttribute('aria-valuetext', t('Image {n} · {time}', { n: value, time: fmtTime(ctx.frameTime(value)) }));
    const position = first ? xOf(a) : xOf(b + 1);
    handle.tabIndex = position < 0 || position > 100 ? -1 : 0;
    const edge = (position / 100) * tl.clientWidth;
    const overlap = ((b + 1 - a) / span()) * tl.clientWidth < 48;
    const desired = first ? edge + (overlap ? -24 : 0) : edge + (overlap ? 0 : -24);
    const placed = Math.max(0, Math.min(tl.clientWidth - 24, desired));
    const offset = placed - (first ? edge : edge - 24);
    handle.style.setProperty(first ? '--in-offset' : '--out-offset', `${offset}px`);
  }
  const d = state.doc;
  $('tlSegments').innerHTML = d.segments.map((g, i) =>
    `<div class="tlseg" style="left:${xOf(g.start)}%;width:${Math.max(0.3, xOf(g.end + 1) - xOf(g.start))}%" title="${t('Segment')} ${i + 1}"></div>`).join('');
  const marks = [
    ...ctx.scenes.map((f) => `<div class="tlmark scene" style="left:${xOf(f)}%"></div>`),
    ...d.cropKeys.map((k) => `<div class="tlmark key" style="left:${xOf(k.frame)}%" title="${t('Clé de suivi')}"></div>`),
    ...d.markers.map((m) => `<div class="tlmark" style="left:${xOf(m.frame)}%" title="${esc(m.label || '')}"></div>`),
  ];
  $('tlMarks').innerHTML = marks.join('');
  $('tlInfo').textContent = view[0] > 0 || view[1] < total() ? `${t('vue')} ${Math.round(view[0])}–${Math.round(view[1])}` : '';
}

let rulerKey;
function renderRuler() {
  const width = tl.clientWidth;
  const key = `${ctx.source.id}:${view}:${width}`;
  if (rulerKey === key) return;
  rulerKey = key;
  const start = ctx.frameTime(Math.round(view[0]));
  const end = ctx.frameTime(Math.round(view[1]));
  const desired = Math.max((end - start) / Math.max(1, Math.floor(width / 88)), 1 / ctx.fps);
  const unit = 10 ** Math.floor(Math.log10(desired));
  const step = [1, 2, 5, 10].find((m) => m * unit >= desired) * unit;
  const ticks = [];
  for (let seconds = Math.ceil(start / step) * step; seconds <= end; seconds += step) {
    const left = ((seconds - start) / (end - start)) * 100;
    if (!Number.isFinite(left) || left > 100 - 62 / Math.max(width, 1) * 100) break;
    const tick = document.createElement('span');
    tick.style.left = `${left}%`;
    tick.textContent = fmtTime(seconds).replace(/\.000$/, '');
    ticks.push(tick);
  }
  $('tlRuler').replaceChildren(...ticks);
}

tl.addEventListener('keydown', (event) => {
  const edge = event.target.dataset.grip;
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!edge || !keys.includes(event.key)) return;
  event.preventDefault();
  const [a, b] = selRange();
  const first = edge === 'in';
  const min = first ? 0 : a;
  const max = first ? b : ctx.lastFrame;
  const value = first ? a : b;
  const step = event.shiftKey ? 10 : 1;
  const frame = event.key === 'Home' ? min : event.key === 'End' ? max
    : Math.min(max, Math.max(min, value + (['ArrowRight', 'ArrowUp'].includes(event.key) ? step : -step)));
  video.pause();
  setSel(first ? frame : a, first ? b : frame, 'grip-key');
  gotoFrame(frame);
});

// ---------- souris ----------

// Aimant : plan ou marqueur à moins de 6 px (Alt pour l'éviter). Une fin se colle à l'image avant le plan.
function snap(f, e, end = false) {
  if (e.altKey) return f;
  let best = f;
  let dist = (6 / Math.max(1, tl.clientWidth)) * span();
  for (const p of [...ctx.scenes.map((s) => (end ? s - 1 : s)), ...state.doc.markers.map((m) => m.frame)]) {
    if (Math.abs(p - f) <= dist) { best = p; dist = Math.abs(p - f); }
  }
  return Math.max(0, Math.min(ctx.lastFrame, best));
}

// Poignées : début et fin. Ctrl + glisser dans la sélection : la déplacer. Maj + glisser : nouvelle sélection.
// Au doigt : pincer zoome autour des deux doigts, les glisser ensemble fait défiler la frise.
let drag = null;
let pinch = null;
const touches = new Map(); // doigts posés sur la frise → position horizontale
function fingers() {
  const [p, q] = [...touches.values()];
  const r = tl.getBoundingClientRect();
  return { at: ((p + q) / 2 - r.left) / r.width, gap: Math.max(24, Math.abs(p - q)) };
}
tl.addEventListener('pointerdown', (e) => {
  if (!ctx.source || e.button !== 0) return;
  tl.setPointerCapture(e.pointerId);
  if (e.pointerType === 'touch') touches.set(e.pointerId, e.clientX);
  if (touches.size === 2) {
    const { at, gap } = fingers();
    pinch = { frame: view[0] + at * span(), gap, span: span() };
    if (drag?.mode === 'seek') gotoFrame(drag.was); // le premier doigt a déplacé la tête de lecture : on la remet
    drag = null;
    return;
  }
  const grip = e.target.dataset.grip;
  const f = Math.max(0, Math.min(ctx.lastFrame, frameAt(e.clientX)));
  const [a, b] = selRange();
  if (grip) drag = { mode: grip };
  else if (e.ctrlKey && f >= a && f <= b) drag = { mode: 'move', from: f, a, b };
  else if (e.shiftKey) drag = { mode: 'create', from: snap(f, e) };
  else drag = { mode: 'seek', was: shownFrame() };
  video.pause();
  if (drag.mode === 'seek' || drag.mode === 'create') gotoFrame(drag.from ?? f);
});
tl.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, e.clientX);
  if (pinch && touches.size === 2) {
    const { at, gap } = fingers();
    const len = Math.min(total(), Math.max(24, pinch.span * pinch.gap / gap));
    setView(pinch.frame - at * len, pinch.frame - at * len + len); // l'image sous les doigts au départ y reste
    return;
  }
  if (!drag) return;
  const f = Math.max(0, Math.min(ctx.lastFrame, frameAt(e.clientX)));
  const [a, b] = selRange();
  if (drag.mode === 'seek') gotoFrame(f);
  else if (drag.mode === 'in') { const g = snap(f, e); setSel(Math.min(g, b), b, 'grip'); gotoFrame(g); }
  else if (drag.mode === 'out') { const g = snap(f, e, true); setSel(a, Math.max(g, a), 'grip'); gotoFrame(g); }
  else if (drag.mode === 'create') {
    const g = snap(f, e, f > drag.from);
    setSel(Math.min(g, drag.from), Math.max(g, drag.from), 'grip');
    gotoFrame(g);
  } else if (drag.mode === 'move') {
    const len = drag.b - drag.a;
    const start = Math.max(0, Math.min(ctx.lastFrame - len, snap(drag.a + f - drag.from, e)));
    setSel(start, start + len, 'grip');
    gotoFrame(start);
  }
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) tl.addEventListener(type, (e) => { drag = pinch = null; touches.delete(e.pointerId); });
// Clic droit : se placer là d'abord (main.js ouvre ensuite le menu).
tl.addEventListener('contextmenu', (e) => {
  if (!ctx.source) return;
  video.pause();
  gotoFrame(Math.max(0, Math.min(ctx.lastFrame, frameAt(e.clientX))));
});

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
  ++stripRevision;
  clearTimeout(stripDelay);
  $('tlLoading').hidden = true;
  requestedStrip = '';
  rulerKey = null;
  ctx.scenes = scenesByTab.get(ctx.tabId) || [];
  if (!ctx.source) return;
  view = [0, total()];
  $('tlZoom').value = 1;
  $('tlStrip').replaceChildren();
  render();
  loadStrip();
});
new ResizeObserver(() => { if (ctx.source) { render(); loadStrip(); } }).observe(tl);

// ---------- changements de plan ----------

const scenesByTab = new Map();
$('scenesBtn').addEventListener('click', () => {
  if (!ctx.source) return;
  const source = ctx.source.id;
  const tab = ctx.tabId;
  return runAction(`scenes:${tab}`, t('Changements de plan'), async (activity) => {
    const r = await api(`/api/scenes/${source}`, {});
    const scenes = await activity.wait(r.job);
    scenesByTab.set(tab, scenes);
    toast(t('{n} changements de plan trouvés : Pg↑ / Pg↓ pour sauter de l’un à l’autre', { n: scenes.length }), 'ok');
    if (ctx.tabId === tab) {
      ctx.scenes = scenes;
      render();
    }
  }, { host: $('timelineActivity') });
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
