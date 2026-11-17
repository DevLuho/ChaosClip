// Lecteur : navigation image par image, lecture, sélection, zoom, plein écran, volume.
import { $, api, fmtTime, parseTime, toast, fail, openDialog, waitJob } from './util.js';
import { t } from './i18n.js';
import { ctx, emit, listen } from './ctx.js';
import { state, update } from './state.js';

export const video = $('video');
let loopActive = false;
let playRangeEnd = null; // lecture d'un passage précis (▶ Sélection, ▶ 2 dernières s)

// ---------- chargement ----------

export function loadVideo(src) {
  $('empty').hidden = true;
  $('stage').hidden = false;
  $('unplayable').hidden = !src.needsProxy;
  video.src = `/api/media/${src.id}?v=${Date.now()}`;
  const i = src.info;
  $('startFrame').max = $('endFrame').max = ctx.lastFrame;
  $('sourceInfo').textContent = `${src.name} · ${i.width}×${i.height} · ${i.fps.toFixed(3)} i/s · ${fmtTime(i.duration)} · ${i.vcodec}${src.proxied ? ` · ${t('aperçu converti')}` : ''}`;
  video.addEventListener('loadedmetadata', () => {
    const resume = resumePosition(src);
    gotoFrame(resume ?? state.doc.sel.start);
    emit('layout');
  }, { once: true });
}

video.addEventListener('error', () => { if (ctx.source) $('unplayable').hidden = false; });
video.addEventListener('loadedmetadata', () => {
  if (ctx.source && !video.videoWidth) $('unplayable').hidden = false;
});
$('proxyBtn').addEventListener('click', async () => {
  try {
    const f = currentFrame();
    const r = await api(`/api/proxy/${ctx.source.id}`, {});
    const src = await waitJob(r.job, t('Conversion'));
    ctx.source = src;
    loadVideo(src);
    video.addEventListener('loadedmetadata', () => gotoFrame(f), { once: true });
  } catch (e) { fail(e); }
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
    if ($('loopSel').checked && loopActive && f > b) gotoFrame(a);
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

$('startFrame').addEventListener('change', (e) => { setSel(Number(e.target.value), selRange()[1]); video.pause(); gotoFrame(Number(e.target.value)); });
$('endFrame').addEventListener('change', (e) => { setSel(selRange()[0], Number(e.target.value)); video.pause(); gotoFrame(Number(e.target.value)); });
$('fixedOn').addEventListener('change', () => { if ($('fixedOn').checked) setSel(selRange()[0], 0); });
$('fixedDur').addEventListener('change', () => { if ($('fixedOn').checked) setSel(selRange()[0], 0); });

export function renderSelection() {
  if (!ctx.source) return;
  const [a, b] = selRange();
  if (document.activeElement !== $('startFrame')) $('startFrame').value = a;
  if (document.activeElement !== $('endFrame')) $('endFrame').value = b;
  const o = state.doc.opts;
  const segs = state.doc.segments;
  const frames = segs.length ? segs.reduce((s, g) => s + g.end - g.start + 1, 0) : b - a + 1;
  const hold = segs.reduce((s, g) => s + (Number(g.hold) || 0), 0);
  let dur = segs.length
    ? segs.reduce((s, g) => s + (ctx.frameTime(g.end + 1) - ctx.frameTime(g.start)) / ((Number(g.speed) || 1) * o.speed) + (Number(g.hold) || 0), 0)
    : (ctx.frameTime(b + 1) - ctx.frameTime(a)) / o.speed;
  if (o.pingpong) dur *= 2;
  if (o.crossfade && o.crossfade * 2 < dur) dur -= o.crossfade;
  $('selInfo').textContent = `${frames} ${t('images')} · ${dur.toFixed(2)} s ${t('en sortie')}${segs.length ? ` · ${segs.length} ${t('segments')}` : ''}${hold ? ` · ${hold}s ${t('figées')}` : ''}`;
}

// ---------- aller à ----------

export function gotoPrompt() {
  const d = openDialog('gotoDlg');
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
      if (s !== null) f = ctx.frameAt(s);
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
