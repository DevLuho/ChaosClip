// Frise : miniatures, zoom, poignées de sélection, marqueurs, plans, segments, passages retirés, clés de suivi.
import { $, api, runAction, toast, debounce, esc, fmtTime, confirmAsk } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, update } from './state.js';
import { gotoFrame, video, selRange, setSel, shownFrame, typedFrame, frameText, stepFrameField, playRange } from './player.js';

const tl = $('timeline');
let stripRevision = 0;
let stripDelay;
let requestedStrip = '';
let view = [0, 1]; // plage visible, en images
let cutFrom = null; // passage à retirer : sa première image est posée, en attente de la dernière

const total = () => ctx.lastFrame + 1;
const span = () => Math.max(1, view[1] - view[0]);
const xOf = (f) => ((f - view[0]) / span()) * 100;
const clampFrame = (f) => Math.max(0, Math.min(ctx.lastFrame, f));
const posAt = (clientX) => {
  const r = tl.getBoundingClientRect();
  return view[0] + ((clientX - r.left) / r.width) * span();
};
// L'image dont la case est sous le pointeur, et la limite entre deux images la plus proche (bords de la sélection).
const frameAt = (clientX) => clampFrame(Math.floor(posAt(clientX)));
const edgeAt = (clientX) => Math.round(posAt(clientX));

// Vignettes qui tiennent dans la frise. Au zoom maximal, chacune est une image.
const STRIP_H = 59;
const cells = () => Math.max(1, Math.min(100, Math.round(tl.clientWidth / (STRIP_H * ctx.source.info.width / ctx.source.info.height))));
const clampLen = (len) => Math.min(total(), Math.max(cells(), len));
// Vue serrée (8 images par vignette ou moins) : chaque vignette couvre un nombre entier d'images et montre
// exactement la première. 0 hors de ce cas.
const perCell = () => (span() <= cells() * 8 && span() % cells() === 0 ? span() / cells() : 0);

function setView(a, b, fromSlider = false) {
  const n = cells();
  let len = Math.round(clampLen(b - a));
  if (len < total() && len <= n * 8) len = Math.min(total(), n * Math.ceil(len / n));
  a = Math.round(Math.max(0, Math.min(total() - len, a))); // vue en images entières : les vignettes et la règle tombent juste
  view = [a, a + len];
  // Curseur de zoom en échelle logarithmique : du film entier (0) à une image par vignette (100).
  if (!fromSlider) $('tlZoom').value = 100 * Math.log(len / total()) / Math.log(Math.min(1, n / total())) || 0;
  render();
  loadStrip();
}

// Miniatures de la plage visible (rechargées après un temps de repos) : une image par case, demandées quatre
// à la fois pour laisser des connexions à la vidéo. Elles s'affichent au fur et à mesure, et chaque case garde
// l'ancienne image jusqu'à l'arrivée de la nouvelle.
const loadStrip = debounce(() => {
  if (!ctx.source || !tl.clientWidth) return;
  const strip = $('tlStrip');
  const h = STRIP_H;
  const n = cells();
  const every = perCell();
  const from = ctx.frameTime(view[0]);
  const cell = (ctx.frameTime(view[1]) - from) / n;
  // Cases de 2 s ou plus : l'image clé la plus proche suffit, et le serveur la sort bien plus vite.
  // En dessous, la rangée est demandée à l'image près (une seule passe côté serveur).
  // Vue serrée : la rangée est demandée en images exactes.
  const wide = !every && cell >= 2;
  const px = Math.min(160, Math.round(h * devicePixelRatio)); // nettes sur un écran dense (téléphone, 4K) ; 160 : plafond du serveur
  const base = `/api/thumbs/${ctx.source.id}?h=${px}` + (every ? `&f=${view[0]}&k=${every}&n=${n}&i=` : wide ? '&t=' : `&from=${from.toFixed(3)}&cell=${cell.toFixed(4)}&n=${n}&i=`);
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
  // Au doigt : la pastille qui déplace toute la sélection, cachée quand elle recouvrirait les poignées.
  tl.querySelector('.selmove').hidden = ((b + 1 - a) / span()) * tl.clientWidth < 120;
  for (const handle of tl.querySelectorAll('.grip')) {
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
    `<div class="tlseg" style="left:${xOf(g.start)}%;width:${Math.max(0.3, xOf(g.end + 1) - xOf(g.start))}%" title="${t('Segment')} ${i + 1}"></div>`).join('') +
    d.cuts.map((c, i) => `<div class="tlcut" style="left:${xOf(c.start)}%;width:${Math.max(0.3, xOf(c.end + 1) - xOf(c.start))}%">` +
      `<span class="cutgrip start" data-cut="${i}:start"></span><span class="cutgrip end" data-cut="${i}:end"></span></div>`).join('') +
    (cutFrom === null ? '' : `<div class="tlcut from" style="left:${xOf(cutFrom)}%"></div>`);
  const marks = [
    ...ctx.scenes.map((f) => `<div class="tlmark scene" style="left:${xOf(f)}%"></div>`),
    ...d.cropKeys.map((k) => `<div class="tlmark key" style="left:${xOf(k.frame)}%" title="${t('Clé de suivi')}"></div>`),
    ...d.markers.map((m) => `<div class="tlmark" style="left:${xOf(m.frame)}%" title="${esc(m.label || '')}"></div>`),
  ];
  $('tlMarks').innerHTML = marks.join('');
  const every = perCell();
  $('tlInfo').textContent = view[0] > 0 || view[1] < total()
    ? `${t('vue')} ${view[0]}–${view[1] - 1}${every ? ` · ${t('{n} image(s) par vignette', { n: every })}` : ''}` : '';
}

let rulerKey;
function renderRuler() {
  const width = tl.clientWidth;
  const key = `${ctx.source.id}:${view}:${width}`;
  if (rulerKey === key) return;
  rulerKey = key;
  const ticks = [];
  const tick = (left, text) => {
    const el = document.createElement('span');
    el.style.left = `${left}%`;
    el.textContent = text;
    ticks.push(el);
  };
  // Vue serrée : une graduation par vignette, au numéro de l'image qu'elle montre, suivi de son temps.
  const every = perCell();
  for (let f = view[0]; every && f < view[1]; f += every) tick(xOf(f), `${f} · ${fmtTime(ctx.frameTime(f))}`);
  const start = ctx.frameTime(view[0]);
  const end = ctx.frameTime(view[1]);
  const desired = Math.max((end - start) / Math.max(1, Math.floor(width / 88)), 1 / ctx.fps);
  const unit = 10 ** Math.floor(Math.log10(desired));
  const step = [1, 2, 5, 10].find((m) => m * unit >= desired) * unit;
  for (let seconds = Math.ceil(start / step) * step; !every && seconds <= end; seconds += step) {
    const left = ((seconds - start) / (end - start)) * 100;
    if (!Number.isFinite(left) || left > 100 - 62 / Math.max(width, 1) * 100) break;
    tick(left, fmtTime(seconds).replace(/\.000$/, ''));
  }
  $('tlRuler').replaceChildren(...ticks);
  // Vignettes trop étroites pour le temps : le numéro d'image seul.
  if (every && ticks.some((el) => el.offsetWidth > width / cells())) for (const el of ticks) el.textContent = el.textContent.split(' ')[0];
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

// Poignées : début et fin. Ctrl + glisser dans la sélection (ou la pastille, au doigt) : la déplacer. Maj + glisser : nouvelle sélection.
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
  const f = frameAt(e.clientX);
  const [a, b] = selRange();
  if (grip === 'move' || (e.ctrlKey && f >= a && f <= b)) drag = { mode: 'move', from: f, a, b };
  else if (grip) {
    // Le bord garde son écart avec le pointeur : attraper une poignée ne le fait pas sauter. Poignée ramenée dans
    // la vue alors que son bord est plus loin : le bord vient sous le pointeur, comme avant.
    const r = tl.getBoundingClientRect();
    const dx = e.clientX - (r.left + (xOf(grip === 'in' ? a : b + 1) / 100) * r.width);
    drag = { mode: grip, dx: Math.abs(dx) <= 40 ? dx : 0 };
  }
  else if (e.target.dataset.cut) {
    // Bord d'un passage retiré : il garde lui aussi son écart avec le pointeur.
    const [i, k] = e.target.dataset.cut.split(':');
    const c = state.doc.cuts[i];
    const r = tl.getBoundingClientRect();
    drag = { mode: 'cut', i: Number(i), k, dx: e.clientX - (r.left + (xOf(k === 'start' ? c.start : c.end + 1) / 100) * r.width) };
  }
  else if (e.shiftKey) drag = { mode: 'create', from: snap(f, e) };
  else drag = { mode: 'seek', was: shownFrame() };
  video.pause();
  if (drag.mode === 'seek' || drag.mode === 'create') gotoFrame(drag.from ?? f);
});
tl.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, e.clientX);
  if (pinch && touches.size === 2) {
    const { at, gap } = fingers();
    const len = clampLen(pinch.span * pinch.gap / gap);
    setView(pinch.frame - at * len, pinch.frame - at * len + len); // l'image sous les doigts au départ y reste
    return;
  }
  if (!drag) return;
  const f = frameAt(e.clientX);
  const [a, b] = selRange();
  if (drag.mode === 'seek') gotoFrame(f);
  // Un bord se pose sur la limite entre deux images : le début est l'image à sa droite, la fin celle à sa gauche.
  else if (drag.mode === 'in') { const g = snap(clampFrame(edgeAt(e.clientX - drag.dx)), e); setSel(Math.min(g, b), b, 'grip'); gotoFrame(g); }
  else if (drag.mode === 'out') { const g = snap(clampFrame(edgeAt(e.clientX - drag.dx) - 1), e, true); setSel(a, Math.max(g, a), 'grip'); gotoFrame(g); }
  else if (drag.mode === 'cut') {
    // Un bord ne dépasse pas l'autre : le passage retiré garde au moins une image.
    const c = state.doc.cuts[drag.i];
    const edge = clampFrame(edgeAt(e.clientX - drag.dx) - (drag.k === 'end' ? 1 : 0));
    const g = drag.k === 'start' ? Math.min(edge, c.end) : Math.max(edge, c.start);
    if (g !== c[drag.k]) update((d) => { d.cuts[drag.i][drag.k] = g; }, { coalesce: 'cutgrip' });
    gotoFrame(g);
  }
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
  gotoFrame(frameAt(e.clientX));
});

// Souris : le temps et l'image sous le pointeur, sans avoir à cliquer. L'image arrive après un court repos.
const hover = $('tlHover');
const hoverImage = debounce((source, f) => { hover.firstChild.src = `/api/frame/${source}?f=${f}&w=160`; }, 150);
tl.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !ctx.source || drag) { hover.hidden = true; return; }
  const f = frameAt(e.clientX);
  hover.lastChild.textContent = `${fmtTime(ctx.frameTime(f))} · ${t('image')} ${f}`;
  hover.style.left = `${Math.max(90, Math.min(innerWidth - 90, e.clientX))}px`;
  hover.style.top = `${tl.getBoundingClientRect().top - 6}px`;
  hover.hidden = false;
  hoverImage(ctx.source.id, f);
});
tl.addEventListener('pointerleave', () => { hover.hidden = true; });
listen('source', () => { hover.hidden = true; hover.firstChild.removeAttribute('src'); });

// Molette : défilement ; Ctrl + molette : zoom autour du pointeur.
tl.addEventListener('wheel', (e) => {
  if (!ctx.source) return;
  e.preventDefault();
  if (e.ctrlKey) {
    const f = posAt(e.clientX);
    // Vue serrée : un cran = une image de plus ou de moins par vignette.
    const len = clampLen(perCell() ? span() + Math.sign(e.deltaY) * cells() : span() * (e.deltaY < 0 ? 0.8 : 1.25));
    const ratio = (f - view[0]) / span();
    setView(f - ratio * len, f - ratio * len + len);
  } else {
    const d = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
    setView(view[0] + d * span() * 0.15, view[1] + d * span() * 0.15);
  }
}, { passive: false });

$('tlZoom').addEventListener('input', (e) => {
  const len = total() * Math.min(1, cells() / total()) ** (Number(e.target.value) / 100);
  const c = shownFrame() >= 0 ? shownFrame() : (view[0] + view[1]) / 2;
  setView(c - len / 2, c + len / 2, true);
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
  if (f < view[0] || f >= view[1]) setView(f - span() * 0.1, f - span() * 0.1 + span());
  else $('tlHead').style.left = `${xOf(f + 0.5)}%`;
});

listen('source', () => {
  cutFrom = null;
  ++stripRevision;
  clearTimeout(stripDelay);
  $('tlLoading').hidden = true;
  requestedStrip = '';
  rulerKey = null;
  ctx.scenes = scenesByTab.get(ctx.tabId) || [];
  if (!ctx.source) return;
  view = [0, total()];
  $('tlZoom').value = 0;
  $('tlStrip').replaceChildren();
  render();
  loadStrip();
});
new ResizeObserver(() => { if (ctx.source) setView(view[0], view[1]); }).observe(tl); // le nombre de vignettes a changé

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

// ---------- passages retirés : un moment gênant au milieu du clip, enlevé sans faire deux fichiers ----------

const cutDone = () => { cutFrom = null; renderCuts(); render(); };
export async function cutHole() {
  const f = shownFrame();
  if (cutFrom === null) {
    cutFrom = f;
    renderCuts();
    render();
    return toast(t('Va sur la dernière image à enlever, puis « …jusqu’ici ».'));
  }
  const c = { start: Math.min(cutFrom, f), end: Math.max(cutFrom, f) };
  const [a, b] = selRange();
  if (c.start <= a && c.end >= b) { cutDone(); return toast(t('Ce passage couvre toute la sélection : il ne resterait rien.'), 'error'); }
  // Refusé : le début reste posé, pour choisir une autre fin ou annuler.
  const seconds = (ctx.frameTime(c.end + 1) - ctx.frameTime(c.start)).toFixed(2);
  if (!(await confirmAsk(t('Enlever les images {a} à {b} du clip ({s} s) ?', { a: c.start, b: c.end, s: seconds }), t('Enlever')))) return;
  cutFrom = null;
  update((d) => { d.cuts.push(c); d.cuts.sort((x, y) => x.start - y.start); });
  toast(t('Passage retiré : « Lire la sélection » montre le résultat.'), 'ok');
}
$('cutCancel').addEventListener('click', cutDone);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cutFrom !== null && !document.querySelector('dialog[open], [data-menu][aria-expanded=true]')) cutDone();
});

export function renderCuts() {
  const field = (k, f, label) => `<input type="text" inputmode="decimal" data-k="${k}" data-frame value="${frameText(f)}" aria-label="${t(label)}">`;
  $('cutList').innerHTML = state.doc.cuts.map((c, i) => `<li data-cut="${i}">${t('Retiré :')}
    ${field('start', c.start, 'Première image retirée')} → ${field('end', c.end, 'Dernière image retirée')}
    <button type="button" class="ghost small" data-cutplay title="${t('Lire le raccord : une seconde avant, une seconde après')}" aria-label="${t('Lire le raccord : une seconde avant, une seconde après')}">▶</button>
    <button type="button" class="ghost small" data-cutdel title="${t('Remettre ce passage')}" aria-label="${t('Remettre ce passage')}">✕</button></li>`).join('');
  for (const b of document.querySelectorAll('[data-act="cutHole"]')) {
    b.lastChild.nodeValue = t(cutFrom === null ? 'Enlever un passage : d’ici…' : '…jusqu’ici');
    b.classList.toggle('primary', cutFrom !== null && !b.closest('#ctxMenu'));
  }
  $('cutCancel').hidden = cutFrom === null;
}
$('cutList').addEventListener('change', (e) => {
  const i = Number(e.target.closest('[data-cut]').dataset.cut);
  const { k } = e.target.dataset;
  const f = typedFrame(e.target.value);
  if (f === null) return renderCuts(); // saisie illisible : on remet la valeur
  const next = { ...state.doc.cuts[i], [k]: clampFrame(f) };
  if (next.start > next.end) next[k === 'start' ? 'end' : 'start'] = next[k]; // un bord tapé au-delà de l'autre le pousse
  update((d) => { d.cuts[i] = next; });
  video.pause();
  gotoFrame(next[k]);
});
$('cutList').addEventListener('keydown', (e) => {
  const li = e.target.closest('[data-cut]');
  if (!li || !('frame' in e.target.dataset)) return;
  const { cut } = li.dataset, { k } = e.target.dataset;
  stepFrameField(e, state.doc.cuts[Number(cut)][k]);
  // La liste vient d'être redessinée : le curseur reste dans le même champ pour enchaîner les flèches.
  if (e.defaultPrevented) $('cutList').querySelector(`[data-cut="${cut}"] [data-k="${k}"]`)?.focus();
});
$('cutList').addEventListener('click', (e) => {
  if (!e.target.closest('[data-cutdel], [data-cutplay]')) return;
  const i = Number(e.target.closest('[data-cut]').dataset.cut);
  const c = state.doc.cuts[i];
  const second = Math.round(ctx.fps);
  // La lecture d'un passage saute ce qui est retiré (player.js) : on entend et on voit le raccord tel qu'il sera exporté.
  if (e.target.closest('[data-cutplay]')) playRange(Math.max(0, c.start - second), Math.min(ctx.lastFrame, c.end + second));
  else update((d) => { d.cuts.splice(i, 1); });
});
