const $ = (id) => document.getElementById(id);
const video = $('video');
let source = null; // { id, name, info: { width, height, fps, duration, hasAudio, subtitles } }
let crop = null; // en pixels de la source

// ---------- utilitaires ----------

const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} Mo` : `${Math.round(b / 1024)} Ko`);
const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};

async function api(url, body) {
  const r = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ChaosClip': '1' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

function status(text, progress) {
  $('status').hidden = !text;
  $('statusText').textContent = text || '';
  $('statusBar').style.width = `${Math.round((progress || 0) * 100)}%`;
}

async function waitJob(jobId, label) {
  for (;;) {
    const j = await api(`/api/job/${jobId}`);
    status(`${label} ${j.message ? '· ' + j.message : ''}`, j.progress);
    if (j.status === 'done') { status(''); return j.result; }
    if (j.status === 'error') { status(''); throw new Error(j.error); }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function fail(e) {
  status('');
  alertBox(e.message);
}

function alertBox(msg) {
  const p = $('estimate');
  p.textContent = msg;
  p.className = 'error';
}

// ---------- chargement ----------

$('loadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('sourceInput').value.trim();
  if (!input) return;
  try {
    status('Chargement…', 0);
    const r = await api('/api/source', { input });
    setSource(r.source || await waitJob(r.job, 'Téléchargement'));
  } catch (err) { fail(err); }
});

async function upload(file) {
  try {
    status(`Copie de ${file.name}…`, 0);
    const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-ChaosClip': '1' }, body: file,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    status('');
    setSource(data.source);
  } catch (err) { fail(err); }
}

$('fileInput').addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) upload(f);
});

function setSource(s) {
  source = s;
  const { info } = s;
  $('empty').hidden = true;
  $('stage').hidden = false;
  $('unplayable').hidden = true;
  video.src = `/api/media/${s.id}?v=${Date.now()}`;
  const last = Math.max(0, Math.round(info.duration * info.fps) - 1);
  $('seek').max = last;
  $('startFrame').max = $('endFrame').max = last;
  $('startFrame').value = 0;
  $('endFrame').value = Math.min(last, Math.round(info.fps * 3));
  $('sourceInfo').textContent = `${s.name} · ${info.width}×${info.height} · ${info.fps.toFixed(3)} i/s · ${fmtTime(info.duration)} · ${info.vcodec}${s.proxied ? ' · aperçu converti' : ''}`;
  const subs = $('subs');
  subs.innerHTML = '<option value="">Aucun</option>' + info.subtitles.map((t) =>
    `<option value="${t.index}">${t.label || 'Piste ' + (t.index + 1)}${t.image ? ' (image)' : ''}</option>`).join('');
  setCrop(null);
  $('exportBtn').disabled = $('estimateBtn').disabled = false;
  updateSelection();
}

video.addEventListener('error', () => { if (source) $('unplayable').hidden = false; });
// Certains codecs se chargent sans erreur mais sans image.
video.addEventListener('loadedmetadata', () => {
  if (source && !video.videoWidth) $('unplayable').hidden = false;
  layoutCrop();
});
$('proxyBtn').addEventListener('click', async () => {
  try {
    const r = await api(`/api/proxy/${source.id}`, {});
    const frame = currentFrame();
    setSourceKeepSel(await waitJob(r.job, 'Conversion'), frame);
  } catch (err) { fail(err); }
});

function setSourceKeepSel(s, frame) {
  const a = $('startFrame').value; const b = $('endFrame').value; const c = crop;
  setSource(s);
  $('startFrame').value = a; $('endFrame').value = b; setCrop(c);
  gotoFrame(frame);
  updateSelection();
}

// ---------- navigation image par image ----------

const fps = () => source.info.fps;
const lastFrame = () => Number($('seek').max);
// currentTime au milieu de l'image : le navigateur affiche alors exactement cette image.
const currentFrame = () => Math.min(lastFrame(), Math.floor(video.currentTime * fps() + 1e-4));

function gotoFrame(f) {
  f = Math.max(0, Math.min(lastFrame(), Math.round(f)));
  video.currentTime = (f + 0.5) / fps();
  showFrame(f);
}

function showFrame(f) {
  $('seek').value = f;
  $('timecode').textContent = `image ${f} / ${lastFrame()} · ${fmtTime(f / fps())}`;
}

function step(n) {
  video.pause();
  gotoFrame(currentFrame() + n);
}

document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => step(Number(b.dataset.step))));
$('seek').addEventListener('input', (e) => { video.pause(); gotoFrame(Number(e.target.value)); });
$('playBtn').addEventListener('click', togglePlay);

let loopActive = false;
function togglePlay() {
  if (!source) return;
  if (video.paused) {
    // La lecture part toujours de la position du curseur ; la boucle ne s'applique
    // que si on démarre avant la fin de la sélection.
    loopActive = currentFrame() < sel()[1];
    if (currentFrame() >= lastFrame()) gotoFrame(0);
    video.playbackRate = Number($('speed').value);
    video.play();
  } else video.pause();
}
video.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; watchPlayback(); });
video.addEventListener('pause', () => { $('playBtn').textContent = 'Lecture'; showFrame(currentFrame()); });
video.addEventListener('seeked', () => showFrame(currentFrame()));

// Suivi précis pendant la lecture (à chaque image affichée quand le navigateur le permet).
function watchPlayback() {
  const tick = (now, meta) => {
    if (video.paused) return;
    const t = meta ? meta.mediaTime : video.currentTime;
    const f = Math.floor(t * fps() + 1e-4);
    const [a, b] = sel();
    if ($('loopSel').checked && loopActive && f > b) { gotoFrame(a); }
    else showFrame(Math.min(f, lastFrame()));
    schedule();
  };
  const schedule = () => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick()));
  schedule();
}

const sel = () => {
  const a = Number($('startFrame').value) || 0;
  const b = Number($('endFrame').value) || 0;
  return [Math.min(a, b), Math.max(a, b)];
};

function updateSelection() {
  if (!source) return;
  const [a, b] = sel();
  const n = b - a + 1;
  const speed = Number($('speed').value);
  const dur = n / fps() / speed * ($('pingpong').checked ? 2 : 1);
  $('selInfo').textContent = `${n} images · ${dur.toFixed(2)} s en sortie`;
  const L = lastFrame() || 1;
  $('rangeFill').style.left = `${(a / L) * 100}%`;
  $('rangeFill').style.width = `${((b - a) / L) * 100}%`;
}

$('setIn').addEventListener('click', () => {
  const f = currentFrame();
  $('startFrame').value = f;
  if (Number($('endFrame').value) < f) $('endFrame').value = f;
  updateSelection();
});
$('setOut').addEventListener('click', () => {
  const f = currentFrame();
  $('endFrame').value = f;
  if (Number($('startFrame').value) > f) $('startFrame').value = f;
  updateSelection();
});
$('goIn').addEventListener('click', () => { video.pause(); gotoFrame(sel()[0]); });
['startFrame', 'endFrame'].forEach((k) => $(k).addEventListener('change', (e) => {
  updateSelection();
  video.pause();
  gotoFrame(Number(e.target.value));
}));
['speed', 'pingpong'].forEach((k) => $(k).addEventListener('change', () => {
  video.playbackRate = Number($('speed').value);
  updateSelection();
}));

document.addEventListener('keydown', (e) => {
  if (!source || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); step((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)); }
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'i' || k === 'I') $('setIn').click();
  else if (k === 'o' || k === 'O') $('setOut').click();
});

// ---------- recadrage ----------

const overlay = $('cropOverlay');
const box = $('cropBox');
const scale = () => source.info.width / video.clientWidth; // px source par px affiché

function setCrop(c) {
  crop = c;
  ['cx', 'cy', 'cw', 'ch'].forEach((k, i) => { $(k).value = c ? [c.x, c.y, c.w, c.h][i] : ''; });
  layoutCrop();
}

function layoutCrop() {
  if (!crop || !source || !video.clientWidth) { box.hidden = true; return; }
  const k = scale();
  box.hidden = false;
  Object.assign(box.style, {
    left: `${crop.x / k}px`, top: `${crop.y / k}px`, width: `${crop.w / k}px`, height: `${crop.h / k}px`,
  });
}
window.addEventListener('resize', layoutCrop);

let drag = null;
overlay.addEventListener('pointerdown', (e) => {
  if (!source) return;
  const r = overlay.getBoundingClientRect();
  const k = scale();
  const p = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  // Clic dans le cadre : déplacement ; ailleurs : nouveau cadre.
  if (crop && p.x > crop.x && p.x < crop.x + crop.w && p.y > crop.y && p.y < crop.y + crop.h) {
    drag = { mode: 'move', start: p, orig: { ...crop } };
  } else drag = { mode: 'draw', start: p };
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = overlay.getBoundingClientRect();
  const k = scale();
  const W = source.info.width; const H = source.info.height;
  const p = { x: Math.max(0, Math.min(W, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(H, (e.clientY - r.top) * k)) };
  if (drag.mode === 'move') {
    const o = drag.orig;
    setCrop({
      ...o,
      x: Math.round(Math.max(0, Math.min(W - o.w, o.x + p.x - drag.start.x))),
      y: Math.round(Math.max(0, Math.min(H - o.h, o.y + p.y - drag.start.y))),
    });
    return;
  }
  let w = Math.abs(p.x - drag.start.x);
  let h = Math.abs(p.y - drag.start.y);
  const ar = Number($('aspect').value);
  if (ar) { if (w / h > ar) w = h * ar; else h = w / ar; }
  let x = p.x < drag.start.x ? drag.start.x - w : drag.start.x;
  let y = p.y < drag.start.y ? drag.start.y - h : drag.start.y;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(w, W - x); h = Math.min(h, H - y);
  setCrop({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
});
overlay.addEventListener('pointerup', () => {
  if (drag && crop && (crop.w < 8 || crop.h < 8)) setCrop(null);
  drag = null;
});
$('cropReset').addEventListener('click', () => setCrop(null));
['cx', 'cy', 'cw', 'ch'].forEach((k) => $(k).addEventListener('change', () => {
  const v = ['cx', 'cy', 'cw', 'ch'].map((i) => Number($(i).value) || 0);
  setCrop(v[2] > 0 && v[3] > 0 ? { x: v[0], y: v[1], w: v[2], h: v[3] } : null);
}));

// ---------- réglages ----------

const format = () => document.querySelector('input[name=format]:checked').value;

function updateForm() {
  const f = format();
  const isVideo = f === 'mp4' || f === 'webm';
  document.querySelectorAll('.onlyGif').forEach((el) => { el.hidden = f !== 'gif'; });
  document.querySelectorAll('.notGif').forEach((el) => { el.hidden = f === 'gif'; });
  document.querySelectorAll('.onlyVideo').forEach((el) => { el.hidden = !isVideo; });
  document.querySelectorAll('.bayerOnly').forEach((el) => { el.hidden = $('dither').value !== 'bayer'; });
  const q = $('quality');
  if (f === 'webp') { q.min = 0; q.max = 100; $('qualityLabel').textContent = 'Qualité'; }
  else { q.min = 15; q.max = 45; $('qualityLabel').textContent = 'CRF (bas = meilleur)'; }
  if (q.dataset.format !== f) { q.value = f === 'webp' ? 75 : f === 'mp4' ? 20 : 30; q.dataset.format = f; }
  $('qualityVal').textContent = q.value;
  const custom = $('maxPreset').value === 'custom';
  $('maxSize').hidden = $('maxUnit').hidden = !custom;
}
document.querySelectorAll('#settings input, #settings select').forEach((el) => el.addEventListener('input', updateForm));
updateForm();

function settings() {
  const [a, b] = sel();
  const preset = $('maxPreset').value;
  const sub = $('subs').value;
  return {
    startFrame: a, endFrame: b, format: format(), crop,
    width: Number($('width').value), fps: Number($('fps').value), speed: Number($('speed').value),
    loop: Number($('loop').value), pingpong: $('pingpong').checked, audio: $('audio').checked,
    colors: Number($('colors').value), dither: $('dither').value, bayerScale: Number($('bayerScale').value),
    quality: Number($('quality').value),
    maxSizeMB: preset === 'custom' ? Number($('maxSize').value) : Number(preset),
    subs: sub === '' ? null : { kind: 'stream', index: Number(sub) },
    text: { content: $('text').value, position: $('textPos').value, size: Number($('textSize').value), color: $('textColor').value },
  };
}

function busy(on) {
  $('exportBtn').disabled = $('estimateBtn').disabled = on || !source;
}

$('estimateBtn').addEventListener('click', async () => {
  busy(true);
  $('estimate').className = 'muted';
  try {
    const r = await api(`/api/estimate/${source.id}`, { settings: settings() });
    const res = await waitJob(r.job, 'Estimation');
    const s = settings();
    const over = s.maxSizeMB && res.bytes > s.maxSizeMB * 1048576;
    $('estimate').textContent = `≈ ${fmtBytes(res.bytes)} pour ${res.duration.toFixed(2)} s${over ? ' · au-dessus du poids max, l’export réduira automatiquement' : ''}`;
  } catch (err) { fail(err); }
  busy(false);
});

$('exportBtn').addEventListener('click', async () => {
  busy(true);
  $('estimate').className = 'muted';
  $('estimate').textContent = '';
  try {
    const r = await api(`/api/export/${source.id}`, { settings: settings() });
    const res = await waitJob(r.job, 'Export');
    showResult(res);
  } catch (err) { fail(err); }
  busy(false);
});

function showResult(res) {
  $('result').hidden = false;
  const media = $('resultMedia');
  media.innerHTML = '';
  const el = document.createElement(res.format === 'mp4' || res.format === 'webm' ? 'video' : 'img');
  el.src = res.url;
  if (el.tagName === 'VIDEO') Object.assign(el, { controls: true, loop: true, autoplay: true, muted: true });
  media.appendChild(el);
  const last = res.attempts[res.attempts.length - 1];
  let info = `${res.file} · ${fmtBytes(res.bytes)}`;
  lastExport = res;
  if (res.attempts.length > 1) info += ` · ajusté en ${res.attempts.length} essais (${last.width}px, ${Math.round(last.fps)} i/s${last.bitrateKbps ? `, ${last.bitrateKbps} kb/s` : ''})`;
  if (!res.fitsMax) info += ' · ⚠ toujours au-dessus du poids max : raccourcis la sélection ou baisse la taille';
  $('resultInfo').textContent = info;
  $('resultLink').href = res.url;
  $('resultLink').download = res.file;
}

let lastExport = null;
$('openFolder').addEventListener('click', () => (lastExport ? api(`/api/history/${lastExport.id}/reveal`, {}) : api('/api/open-exports', {})));
