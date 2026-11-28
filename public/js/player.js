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
  // Lue au dernier moment : le montage d'un onglet ou d'un projet est remis juste après cet appel.
  const resume = () => frame ?? resumePosition(src) ?? state.doc.sel.start;
  // Aperçu allégé : essayé avec le moteur Chromium seulement (l'appli, Chrome, Edge), les autres lisent le fichier tel quel.
  const light = src.light && !!window.MediaSource && /Chrome\//.test(navigator.userAgent);
  if (light) lightVideo(src, resume);
  else video.src = `/api/media/${src.id}?v=${Date.now()}`;
  const i = src.info;
  $('startFrame').max = $('endFrame').max = ctx.lastFrame;
  $('sourceInfo').textContent = `${src.name} · ${i.width}×${i.height} · ${i.fps.toFixed(3)} i/s · ${fmtTime(i.duration)} · ${i.vcodec}${src.proxied ? ` · ${t('aperçu converti')}` : ''}${light ? ` · ${t('aperçu allégé')}` : ''}`;
  video.addEventListener('loadedmetadata', () => {
    gotoFrame(resume());
    emit('layout');
  }, { once: true, signal: loadEvents.signal });
}

// ---------- aperçu allégé (vidéos lourdes) ----------

// Vidéo lourde (src.light : 4K à 60 i/s, 8K…) : lue telle quelle, chaque image demande plusieurs secondes. Le serveur
// en fabrique un aperçu réduit à la volée, à partir de l'image regardée, et le lecteur le reçoit par morceaux
// (MediaSource). La première image d'un endroit arrive le temps de décoder depuis l'image clé qui précède ; tout ce
// qui est reçu autour se parcourt ensuite sans attendre. L'export part toujours du fichier d'origine.
// shortcut: rien n'est gardé sur disque : un endroit quitté depuis longtemps, ou un onglet rouvert, est refait
// (1 à 3 s en 8K). Garder les fragments côté serveur si ça gêne.
const BACK = 0.5; // secondes préparées avant l'image demandée, pour reculer de quelques images sans attendre
// Secondes d'avance sur l'image affichée : la suite est demandée en dessous du premier nombre et s'arrête au second.
// Moins à l'arrêt qu'en lecture : tant que le serveur fabrique la suite, la carte graphique est prise et chaque pas
// d'une image met 0,1 à 0,2 s au lieu de 0,03.
const AHEAD = { paused: [4, 12], playing: [8, 25] };

function lightVideo(src, resume) {
  const ms = new MediaSource();
  const off = new AbortController();
  let sb = null;
  let stream = null; // flux reçu en ce moment : { abort, want, from, head, done }
  let stuck = null; // endroit qu'un flux n'a pas su rendre lisible : pas de relance en boucle
  let missing = null; // position affichée dont l'image n'est pas encore reçue
  let worked = false; // au moins un flux a apporté des images
  let lastStart = 0;
  let timer;

  // Plage reçue qui contient le temps t. Une plage qui commence dans le premier dixième de seconde vaut depuis zéro :
  // le son du tout début peut arriver quelques millisecondes après la première image, que le lecteur affiche quand même.
  const rangeAt = (time) => {
    const b = video.buffered;
    for (let k = 0; k < b.length; k++) if ((time >= b.start(k) || b.start(k) < 0.1) && time < b.end(k)) return [b.start(k), b.end(k)];
    return null;
  };
  // Le flux en cours apportera-t-il ce temps (pas encore reçu) ? Oui s'il n'est pas déjà passé dessus et n'en est
  // plus qu'à deux secondes : le laisser arriver coûte moins qu'en relancer un.
  const serving = (time) => !!stream && !stream.done && time >= stream.head - 0.25 / ctx.fps && time <= Math.max(stream.head, stream.want) + 2;
  const stop = () => { stream?.abort.abort(); stream = null; };
  const idle = () => (sb.updating ? new Promise((done) => sb.addEventListener('updateend', done, { once: true })) : null);

  async function append(data) {
    await idle();
    try { sb.appendBuffer(data); } catch (e) {
      if (e.name !== 'QuotaExceededError') throw e;
      // Mémoire du lecteur pleine : seuls les alentours de l'image affichée sont gardés.
      const p = video.currentTime;
      for (const [a, b] of [[0, p - 10], [p + 30, Infinity]]) if (a < b && a < ms.duration) { sb.remove(a, b); await idle(); }
      sb.appendBuffer(data);
    }
    await idle();
    if (video.error) throw new Error(video.error.message); // morceau refusé par le lecteur
  }

  // Ce qu'il faut préparer : d'abord l'image affichée, ensuite la suite de ce qui est reçu autour d'elle.
  function plan() {
    if (!sb || ms.readyState === 'closed') return;
    const p = video.currentTime;
    const r = rangeAt(p);
    // Image pas encore reçue : on le montre. En attendant, le lecteur affiche parfois celle d'à côté (il tient pour
    // reçues les deux images qui précèdent une plage) : dès qu'elle arrive, on s'y replace pour afficher la bonne.
    awaited = !r;
    $('videoLoading').hidden = !!r;
    if (r && missing === p && video.paused && !video.seeking) video.currentTime = p;
    missing = r ? null : p;
    // Dernière seconde de la vidéo : le flux qui y est va au bout de lui-même (feed prévient alors le lecteur qu'il
    // n'y a rien après), et aucune suite n'est à demander. ms.duration : la durée annoncée, puis la vraie fin.
    const tail = !!r && r[1] >= ms.duration - 1;
    if (tail && serving(r[1])) return;
    const ahead = AHEAD[video.paused ? 'paused' : 'playing'][serving(r?.[1]) ? 1 : 0];
    const want = !r ? p : !tail && r[1] - p < ahead ? r[1] : null;
    // Flux passé sur l'image sans la rendre lisible : inutile de le laisser filer jusqu'au bout de la vidéo.
    if (!r && stream && !stream.done && stream.want === p && stream.head > p + 1) stuck = p;
    else if (want !== stuck) stuck = null;
    if (want === null || want === stuck) return stop();
    if (serving(want)) return;
    clearTimeout(timer);
    // Glissé sur la frise : quatre départs par seconde au plus, chacun lance un ffmpeg.
    const wait = lastStart + 250 - performance.now();
    if (wait > 0) { timer = setTimeout(plan, wait); return; }
    lastStart = performance.now();
    feed(want, r ? 0 : BACK);
  }

  async function feed(want, back) {
    stop();
    const s = stream = { abort: new AbortController(), want, from: want - back, head: want - back, done: false };
    try {
      const r = await fetch(`/api/light/${src.id}?f=${ctx.frameAt(want + 0.25 / ctx.fps)}&back=${back}`, { signal: s.abort.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
      s.from = s.head = Number(r.headers.get('x-from'));
      const reader = r.body.getReader();
      await idle();
      if (stream !== s) return;
      if (ms.readyState === 'open') sb.abort(); // le flux précédent a pu être coupé au milieu d'un fragment
      // Rien n'entre avant la première image du flux : son amorce de son, un peu plus tôt, ferait croire au lecteur
      // qu'il a aussi l'image d'avant, et il montrerait celle-ci à sa place. Un quart d'image de marge : les temps
      // du fichier sont arrondis à la milliseconde.
      sb.appendWindowStart = Math.max(0, s.from - 0.25 / ctx.fps);
      for (;;) {
        const { done, value } = await reader.read();
        if (stream !== s) return;
        if (done) break;
        await append(value);
        if (stream !== s) return;
        s.head = rangeAt(s.from + 0.01)?.[1] ?? s.head;
        worked ||= video.buffered.length > 0;
        plan();
        if (stream !== s) return;
      }
      s.done = true;
      if (s.head <= want + 1e-3) stuck = want; // rien de plus après cet endroit : on n'insiste pas
      // Le serveur est allé au bout de la vidéo : le lecteur apprend qu'il n'y a rien après, il montre les dernières
      // images et s'arrête de lui-même en fin de lecture.
      if (ms.readyState === 'open') ms.endOfStream();
      plan();
    } catch (e) {
      if (stream !== s || e.name === 'AbortError' || ms.readyState === 'closed') return;
      console.warn(e);
      stream = null;
      // Flux en échec. Passage isolé (endroit abîmé, piste vidéo plus courte que le fichier) : il est laissé de côté.
      // Rien n'a jamais marché, ou le lecteur a refusé un morceau : le fichier est lu tel quel, comme avant.
      if (worked && !video.error) stuck = want;
      else loadVideo({ ...src, light: false }, shown >= 0 ? shown : null);
    }
  }

  ms.addEventListener('sourceopen', () => {
    URL.revokeObjectURL(video.src);
    ms.duration = src.info.duration;
    sb = ms.addSourceBuffer(`video/mp4; codecs="avc1.64002a${src.info.hasAudio ? ',mp4a.40.2' : ''}"`);
    sb.timestampOffset = -1; // les temps du flux sont décalés d'une seconde (lib/media.js)
    video.currentTime = frameMid(clampFrame(resume())); // avant toute donnée : la position de départ
    plan();
  }, { once: true });
  ms.addEventListener('sourceclose', () => { off.abort(); clearTimeout(timer); stop(); sb = null; awaited = false; });
  for (const type of ['seeking', 'seeked', 'timeupdate']) video.addEventListener(type, plan, { signal: off.signal });
  video.src = URL.createObjectURL(ms);
}

video.addEventListener('error', () => { if (ctx.source) $('unplayable').hidden = false; });
video.addEventListener('loadedmetadata', () => {
  if (ctx.source && !video.videoWidth) $('unplayable').hidden = false;
});
let buffering;
let awaited = false; // aperçu allégé : l'image affichée n'est pas encore reçue (lightVideo)
function stopBuffering() {
  clearTimeout(buffering);
  $('videoLoading').hidden = !awaited;
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

const clampFrame = (f) => Math.max(0, Math.min(ctx.lastFrame, Math.round(f)));
const frameMid = (f) => (ctx.frameTime(f) + ctx.frameTime(f + 1)) / 2;

export function gotoFrame(f) {
  if (!ctx.source) return;
  f = clampFrame(f);
  video.currentTime = frameMid(f);
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
    // Pendant un saut (passage retiré, boucle), les images encore affichées sont celles d'avant : redemander le saut
    // le relancerait à chaque image et la vidéo resterait figée. On attend qu'il aboutisse.
    if (video.seeking) { schedule(); return; }
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
    else if (cut && video.currentTime < ctx.frameTime(cut.end + 1)) gotoFrame(cut.end + 1);
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
