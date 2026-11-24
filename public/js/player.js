// Lecteur : navigation image par image, lecture, sélection, zoom, plein écran, volume.
import { $, api, fmtTime, parseTime, toast, fail, openDialog, runAction } from './util.js';
import { t } from './i18n.js';
import { ctx, emit, listen } from './ctx.js';
import { state, update } from './state.js';
import { keptRanges } from './cuts.mjs';

export const video = $('video');
let loopActive = false;
let playRangeEnd = null; // lecture d'un passage précis (▶ Sélection, ▶ 2 dernières s)

// ---------- chargement ----------

let loadEvents;
export function loadVideo(src, frame = null) {
  loadEvents?.abort();
  loadEvents = new AbortController();
  $('empty').hidden = true;
  $('stage').hidden = false;
  $('unplayable').hidden = !src.needsProxy;
  video.src = `/api/media/${src.id}?v=${Date.now()}`;
  const i = src.info;
  $('startFrame').max = $('endFrame').max = ctx.lastFrame;
  $('sourceInfo').textContent = `${src.name} · ${i.width}×${i.height} · ${i.fps.toFixed(3)} i/s · ${fmtTime(i.duration)} · ${i.vcodec}${src.proxied ? ` · ${t('aperçu converti')}` : ''}`;
  video.addEventListener('loadedmetadata', () => {
    const resume = frame ?? resumePosition(src);
    gotoFrame(resume ?? state.doc.sel.start);
    emit('layout');
  }, { once: true, signal: loadEvents.signal });
}

video.addEventListener('error', () => { if (ctx.source) $('unplayable').hidden = false; });
video.addEventListener('loadedmetadata', () => {
  if (ctx.source && !video.videoWidth) $('unplayable').hidden = false;
});
let buffering;
function stopBuffering() {
  clearTimeout(buffering);
  $('videoLoading').hidden = true;
}
function buffer() {
  stopBuffering();
  if (!ctx.source || ctx.source.needsProxy) return;
  buffering = setTimeout(() => { $('videoLoading').hidden = false; }, 200);
}
for (const type of ['loadstart', 'waiting', 'stalled']) video.addEventListener(type, buffer);
for (const type of ['loadeddata', 'canplay', 'playing', 'seeked', 'error', 'emptied']) video.addEventListener(type, stopBuffering);

$('proxyBtn').addEventListener('click', () => {
  if (!ctx.source) return;
  const sourceId = ctx.source.id;
  const tabId = ctx.tabId;
  const frame = currentFrame();
  return runAction(`proxy:${sourceId}`, t('Conversion'), async (activity) => {
    const { job } = await api(`/api/proxy/${sourceId}`, {});
    const source = await activity.wait(job);
    emit('sourceUpdate', { tabId, source });
    if (ctx.tabId !== tabId) return;
    ctx.source = source;
    loadVideo(source, frame);
  }, { host: $('playerActivity') });
});

// ---------- position ----------

const fps = () => ctx.fps;
// currentTime au milieu de l'image : le navigateur affiche alors exactement cette image.
export const currentFrame = () => ctx.frameAt(video.currentTime);

export function gotoFrame(f) {
  if (!ctx.source) return;
  f = Math.max(0, Math.min(ctx.lastFrame, Math.round(f)));
  video.currentTime = (ctx.frameTime(f) + ctx.frameTime(f + 1)) / 2;
  showFrame(f);
}

let shown = -1;
function showFrame(f) {
  shown = f;
  $('timecode').textContent = `${t('image')} ${f} / ${ctx.lastFrame} · ${fmtTime(ctx.frameTime(f))}`;
  emit('frame', f);
  saveResume(f);
}
export const shownFrame = () => shown;

export function stepSize() {
  const v = $('stepSize').value;
  return v === 'sec' ? Math.round(fps()) : Number(v);
}

export function step(n) {
  video.pause();
  gotoFrame(currentFrame() + n);
}

// ---------- lecture ----------

export function togglePlay() {
  if (!ctx.source) return;
  if (!video.paused) { video.pause(); return; }
  playRangeEnd = null;
  // La lecture part toujours de la position du curseur ; la boucle ne s'applique
  // que si on démarre avant la fin de la sélection.
  loopActive = currentFrame() < selRange()[1];
  if (currentFrame() >= ctx.lastFrame) gotoFrame(0);
  startPlayback();
}

let rangeLoop = null;
export function playRange(a, b, loop = false) {
  if (!ctx.source) return;
  gotoFrame(a);
  playRangeEnd = b;
  rangeLoop = loop ? a : null;
  loopActive = false;
  startPlayback();
}

function startPlayback() {
  video.playbackRate = Number($('previewRate').value) * state.doc.opts.speed;
  video.play().catch(() => {});
}

video.addEventListener('play', () => { $('playBtn').classList.add('playing'); watchPlayback(); });
video.addEventListener('pause', () => { $('playBtn').classList.remove('playing'); showFrame(currentFrame()); });
video.addEventListener('seeked', () => { if (video.paused) showFrame(currentFrame()); });
video.addEventListener('ended', () => {
  if (playRangeEnd !== null && rangeLoop !== null) {
    gotoFrame(rangeLoop);
    startPlayback();
  }
});

// Suivi précis pendant la lecture (à chaque image affichée quand le navigateur le permet).
function watchPlayback() {
  const tick = (now, meta) => {
    if (video.paused) return;
    const tm = meta ? meta.mediaTime : video.currentTime;
    const f = ctx.frameAt(tm);
    const [a, b] = selRange();
    if (playRangeEnd !== null && (f > playRangeEnd || tm >= ctx.frameTime(playRangeEnd + 1))) {
      if (rangeLoop !== null) {
        gotoFrame(rangeLoop);
        schedule();
        return;
      }
      video.pause();
      gotoFrame(playRangeEnd);
      playRangeEnd = null;
      return;
    }
    // Lecture de la sélection ou d'un passage : elle saute ce qui est retiré du clip, comme l'export.
    const looping = $('loopSel').checked && loopActive;
    const cut = (looping || playRangeEnd !== null) && state.doc.cuts.find((c) => f >= c.start && f <= c.end && c.end < ctx.lastFrame);
    if (looping && f > b) gotoFrame(a);
    else if (cut) gotoFrame(cut.end + 1);
    else showFrame(Math.min(f, ctx.lastFrame));
    schedule();
  };
  const schedule = () => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick()));
  schedule();
}

$('previewRate').addEventListener('change', () => { video.playbackRate = Number($('previewRate').value) * state.doc.opts.speed; });

// ---------- sélection ----------

export const selRange = () => {
  const { start, end } = state.doc.sel;
  return [Math.min(start, end), Math.max(start, end)];
};

const fixedFrames = () => Math.max(1, Math.round(Number($('fixedDur').value) * fps()));

export function setSel(start, end, coalesce = 'sel') {
  const last = ctx.lastFrame;
  start = Math.max(0, Math.min(last, Math.round(start)));
  end = Math.max(0, Math.min(last, Math.round(end)));
  if ($('fixedOn').checked) end = Math.min(last, start + fixedFrames() - 1);
  update((d) => { d.sel = { start, end }; }, { coalesce });
}

export function setIn(f = currentFrame()) {
  const [, b] = selRange();
  setSel(f, Math.max(f, b));
}
export function setOut(f = currentFrame()) {
  const [a] = selRange();
  if ($('fixedOn').checked) { setSel(Math.max(0, f - fixedFrames() + 1), f); return; }
  setSel(Math.min(a, f), f);
}
// Ajuste début ou fin d'une image sans bouger la tête de lecture.
export function nudge(which, n) {
  const [a, b] = selRange();
  if (which === 'in') setSel(Math.min(a + n, b), b, 'nudge');
  else setSel(a, Math.max(a, b + n), 'nudge');
}

// Début / Fin : l'unité se choisit à côté des champs. En images, un nombre est un numéro d'image (8065,5 → image la
// plus proche) ; en temps, des secondes (55,2 → l'image affichée à 55,2 s). Dans les deux cas un temps s'écrit aussi
// comme le compteur (5:36,5 ou 1:05:36) ou avec un s (55,2s). Mêmes règles pour les passages (panels.js).
const unit = $('selUnit');
try { unit.value = localStorage.getItem('chaosclip.selUnit') || 'frame'; } catch { /* ignoré */ }
// Un temps affiché est arrondi à la milliseconde : retapé tel quel, il doit redonner son image et non la précédente.
export const timedFrame = (seconds) => ctx.frameAt(seconds + 5e-4);
export const typedFrame = (text) => {
  const v = String(text).trim().replace(',', '.');
  const n = v.match(/^(\d+(?:\.\d*)?)(s?)$/i);
  if (n) return n[2] || unit.value === 'time' ? timedFrame(Number(n[1])) : Math.round(Number(n[1]));
  const m = v.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d*)?)$/);
  return m ? timedFrame((Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
};
// Ce qu'un champ Début / Fin affiche pour une image, dans l'unité choisie.
export const frameText = (f) => (unit.value === 'time' ? fmtTime(ctx.frameTime(f)) : String(f));
// Flèches haut / bas : une image de plus ou de moins (Maj : 10), puis « change » comme l'ancien champ numérique.
export function stepFrameField(e, fallback) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const f = typedFrame(e.target.value) ?? fallback;
  e.target.value = frameText(Math.max(0, Math.min(ctx.lastFrame, f + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))));
  e.target.dispatchEvent(new Event('change', { bubbles: true }));
}
// Un début tapé après la fin pousse la fin (et l'inverse), comme « Début ici » : les deux bords ne s'échangent pas.
for (const [id, set] of [['startFrame', setIn], ['endFrame', setOut]]) {
  const shown = () => selRange()[id === 'startFrame' ? 0 : 1];
  $(id).addEventListener('change', (e) => {
    const f = typedFrame(e.target.value);
    if (f !== null) { set(f); video.pause(); gotoFrame(f); }
    e.target.value = frameText(shown()); // le champ affiche l'image retenue (ou reprend sa valeur si illisible)
  });
  $(id).addEventListener('keydown', (e) => stepFrameField(e, shown()));
}
$('fixedOn').addEventListener('change', () => { if ($('fixedOn').checked) setSel(selRange()[0], 0); });
$('fixedDur').addEventListener('change', () => { if ($('fixedOn').checked) setSel(selRange()[0], 0); });

export function renderSelection() {
  if (!ctx.source) return;
  const [a, b] = selRange();
  if (document.activeElement !== $('startFrame')) $('startFrame').value = frameText(a);
  if (document.activeElement !== $('endFrame')) $('endFrame').value = frameText(b);
  const o = state.doc.opts;
  const { segments: segs, cuts } = state.doc;
  const kept = keptRanges(state.doc);
  const frames = kept.reduce((s, g) => s + g.end - g.start + 1, 0);
  const hold = kept.reduce((s, g) => s + (Number(g.hold) || 0), 0);
  let dur = kept.reduce((s, g) => s + (ctx.frameTime(g.end + 1) - ctx.frameTime(g.start)) / ((Number(g.speed) || 1) * o.speed) + (Number(g.hold) || 0), 0);
  if (o.pingpong) dur *= 2;
  if (o.crossfade && o.crossfade * 2 < dur) dur -= o.crossfade;
  $('selInfo').textContent = `${frames} ${t('images')} · ${dur.toFixed(2)} s ${t('en sortie')}${segs.length ? ` · ${segs.length} ${t('segments')}` : ''}${cuts.length ? ` · ${t('{n} passage(s) retiré(s)', { n: cuts.length })}` : ''}${hold ? ` · ${hold}s ${t('figées')}` : ''}`;
}

// ---------- aller à ----------

export function gotoPrompt() {
  const d = openDialog('gotoDlg');
  d.returnValue = ''; // sinon le « ok » de la fois précédente compte pour une fenêtre annulée
  $('gotoInput').value = '';
  $('gotoInput').focus();
  d.addEventListener('close', () => {
    if (d.returnValue !== 'ok') return;
    const v = $('gotoInput').value.trim();
    // « 1234 » = numéro d'image ; « 12:34.5 » ou « 75.5s » = temps.
    let f = null;
    if (/^\d+$/.test(v)) f = Number(v);
    else {
      const s = parseTime(v.replace(/s$/i, ''));
      if (s !== null) f = timedFrame(s);
    }
    if (f === null) toast(t('Position illisible'), 'error');
    else { video.pause(); gotoFrame(f); }
  }, { once: true });
}
$('timecode').addEventListener('click', gotoPrompt);

// ---------- volume ----------

function applyVolume() {
  video.volume = Number($('volume').value);
  $('muteBtn').classList.toggle('muted', video.muted || video.volume === 0);
}
$('volume').addEventListener('input', () => { video.muted = false; applyVolume(); try { localStorage.setItem('chaosclip.volume', $('volume').value); } catch { /* ignoré */ } });
export function toggleMute() { video.muted = !video.muted; applyVolume(); }
$('muteBtn').addEventListener('click', toggleMute);
try { $('volume').value = localStorage.getItem('chaosclip.volume') ?? 0.6; } catch { /* ignoré */ }
applyVolume();

// ---------- zoom de l'aperçu ----------

let zoom = 1;
let pan = { x: 0, y: 0 };
export const getZoom = () => zoom;
export function setZoom(z, cx, cy) {
  const wrap = $('videoWrap');
  const old = zoom;
  zoom = Math.max(1, Math.min(8, z));
  if (zoom === 1) pan = { x: 0, y: 0 };
  else if (cx !== undefined) {
    // Zoom centré sur le pointeur.
    pan.x = cx - ((cx - pan.x) * zoom) / old;
    pan.y = cy - ((cy - pan.y) * zoom) / old;
  }
  clampPan();
  wrap.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  $('zoomLevel').textContent = `${Math.round(zoom * 100)} %`;
  emit('layout');
}
function clampPan() {
  const w = $('videoWrap').offsetWidth; const h = $('videoWrap').offsetHeight;
  pan.x = Math.min(0, Math.max(w - w * zoom, pan.x));
  pan.y = Math.min(0, Math.max(h - h * zoom, pan.y));
}
export function panBy(dx, dy) {
  pan.x += dx; pan.y += dy;
  clampPan();
  $('videoWrap').style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
}
$('zoomIn').addEventListener('click', () => setZoom(zoom * 1.25));
$('zoomOut').addEventListener('click', () => setZoom(zoom / 1.25));

// Petit écran : les réglages sont plus bas dans la page, vidéo hors de vue. Une fois la frise sortie par le haut,
// la vidéo se réduit dans un coin et reste visible ; --mini-gap garde sa place dans la page pour que rien ne saute.
new IntersectionObserver(([frise]) => {
  const stage = $('stage');
  const mini = innerWidth <= 720 && !!ctx.source && !frise.isIntersecting && frise.boundingClientRect.bottom < 0;
  if (mini && !stage.classList.contains('mini')) stage.style.setProperty('--mini-gap', `${$('viewport').offsetHeight}px`);
  stage.classList.toggle('mini', mini);
}).observe($('timeline'));

// Au doigt : pincer la vidéo zoome autour des deux doigts, les glisser ensemble déplace l'image zoomée.
// Écouteurs en phase de capture : le calque de recadrage, au-dessus, ne doit pas suivre ces doigts-là.
const fingers = new Map();
let pinch = null;
function twoFingers() {
  const [a, b] = [...fingers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, gap: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)) };
}
// Sans cela, le navigateur prend le geste à deux doigts pour un défilement de la page.
$('viewport').addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
$('viewport').addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (fingers.size === 2) { pinch = { ...twoFingers(), zoom }; e.stopPropagation(); }
}, true);
$('viewport').addEventListener('pointermove', (e) => {
  if (!fingers.has(e.pointerId)) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || fingers.size !== 2) return;
  e.stopPropagation();
  const now = twoFingers();
  const r = $('videoWrap').getBoundingClientRect();
  setZoom((pinch.zoom * now.gap) / pinch.gap, (now.x - r.left) + pan.x, (now.y - r.top) + pan.y);
  panBy(now.x - pinch.x, now.y - pinch.y);
  Object.assign(pinch, { x: now.x, y: now.y, zoom, gap: now.gap });
}, true);
for (const type of ['pointerup', 'pointercancel']) {
  $('viewport').addEventListener(type, (e) => { fingers.delete(e.pointerId); pinch = null; }, true);
}

// Molette : image par image ; Ctrl + molette : zoom.
$('viewport').addEventListener('wheel', (e) => {
  if (!ctx.source) return;
  e.preventDefault();
  if (e.ctrlKey) {
    const r = $('videoWrap').getBoundingClientRect();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), (e.clientX - r.left) + pan.x, (e.clientY - r.top) + pan.y);
  } else step((e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
}, { passive: false });

// ---------- plein écran, taille du lecteur ----------

export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('viewport').requestFullscreen().catch(() => {});
}
$('fullBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => setTimeout(() => emit('layout'), 50));
new ResizeObserver(() => {
  // La poignée du lecteur (resize CSS) fixe aussi la hauteur maximale de la vidéo.
  const h = $('viewport').offsetHeight;
  if (h) document.documentElement.style.setProperty('--player-h', `${h}px`);
  emit('layout');
}).observe($('viewport'));

// ---------- reprise de la dernière position ----------

const resumeKey = (src) => `chaosclip.pos.${src.path || src.name}`;
let lastSaved = 0;
function saveResume(f) {
  if (!ctx.source || Date.now() - lastSaved < 1000) return;
  lastSaved = Date.now();
  try { localStorage.setItem(resumeKey(ctx.source), String(f)); } catch { /* ignoré */ }
}
function resumePosition(src) {
  try {
    const v = localStorage.getItem(resumeKey(src));
    return v === null ? null : Number(v);
  } catch { return null; }
}

listen('source', () => { shown = -1; });
