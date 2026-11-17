// Sources : URL (analyse, qualité, passage, playlist), fichiers, bibliothèque, projets, images, capture.
import { $, api, waitJob, fail, toast, esc, fmtBytes, fmtTime, parseTime, uploadRaw, native, openDialog } from './util.js';
import { t } from './i18n.js';
import { ctx } from './ctx.js';
import { state, replaceDoc } from './state.js';

let onSource = null; // fourni par main.js
export const setOnSource = (fn) => { onSource = fn; };

const isUrl = (s) => /^https?:\/\//i.test(s);

// ---------- saisie ----------

$('loadForm').addEventListener('submit', (e) => {
  e.preventDefault();
  loadInput($('sourceInput').value);
});

export async function loadInput(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (!lines.length) return;
  if (lines.length > 1 && lines.every(isUrl)) return batch(lines.map((url) => ({ url })));
  const input = lines[0];
  if (isUrl(input)) return analyze(input);
  try {
    const r = await api('/api/source', { input });
    onSource(r.source);
  } catch (e) { fail(e); }
}

// ---------- analyse d'URL ----------

let analysis = null;
let analyzedUrl = '';
async function analyze(url) {
  analyzedUrl = url;
  try {
    const r = await api('/api/analyze', { url });
    analysis = await waitJob(r.job, t('Analyse de la vidéo'));
    showCard();
  } catch (e) {
    // Analyse impossible (site exotique) : on tente quand même le téléchargement direct.
    if (/pris en charge|DRM/.test(e.message)) return fail(e);
    toast(`${t('Analyse impossible, téléchargement direct…')} (${e.message.slice(0, 120)})`);
    download(url, {});
  }
}

function showCard() {
  const a = analysis;
  $('urlCard').hidden = false;
  $('urlPlatform').textContent = a.platform || t('Vidéo');
  $('urlTitle').textContent = a.title || analyzedUrl;
  $('urlUploader').textContent = a.uploader || '';
  $('urlThumb').src = a.thumbnail || '';
  $('urlThumb').hidden = !a.thumbnail;
  $('urlSingle').hidden = a.playlist;
  $('urlPlaylist').hidden = !a.playlist;
  if (a.playlist) {
    $('urlMeta').textContent = t('Playlist · {n} vidéos', { n: a.count });
    $('plList').innerHTML = a.entries.map((x, i) => `<li><label><input type="checkbox" data-pl="${i}" checked> ${esc(x.title || x.url)} <span class="muted small">${x.duration ? fmtTime(x.duration).replace(/\.\d+$/, '') : ''}</span></label></li>`).join('');
    $('urlGo').textContent = t('Télécharger la sélection');
    return;
  }
  $('urlMeta').textContent = [a.duration ? fmtTime(a.duration).replace(/\.\d+$/, '') : '', a.fps ? `${a.fps} i/s` : '', a.heights.length ? `${t('jusqu’à')} ${a.heights[0]}p` : ''].filter(Boolean).join(' · ');
  const def = Number(ctx.appSettings.defaultHeight) || 0;
  $('urlHeight').innerHTML = `<option value="0">${t('Meilleure')}${a.heights[0] ? ` (${a.heights[0]}p)` : ''}</option>` +
    a.heights.map((h) => `<option value="${h}"${h === def ? ' selected' : ''}>${h}p</option>`).join('');
  $('urlLangWrap').hidden = a.audioLangs.length < 2;
  $('urlLang').innerHTML = `<option value="">${t('Par défaut')}</option>` + a.audioLangs.map((l) => `<option>${esc(l)}</option>`).join('');
  const subs = [...a.subtitles, ...a.autoSubtitles.filter((s) => !a.subtitles.includes(s)).map((s) => `${s} (auto)`)];
  $('urlSubsWrap').hidden = !subs.length;
  $('urlSubs').innerHTML = subs.map((s) => `<option value="${esc(s.replace(' (auto)', ''))}">${esc(s)}</option>`).join('');
  $('urlSubs').size = Math.min(4, Math.max(1, subs.length));
  $('urlSection').checked = false;
  $('urlSectionFields').hidden = true;
  $('urlFrom').value = '';
  $('urlTo').value = '';
  $('urlGo').textContent = t('Télécharger');
}
$('urlSection').addEventListener('change', (e) => { $('urlSectionFields').hidden = !e.target.checked; });
$('urlCancel').addEventListener('click', () => { $('urlCard').hidden = true; });
$('plAll').addEventListener('change', (e) => { $('plList').querySelectorAll('input').forEach((c) => { c.checked = e.target.checked; }); });

$('urlGo').addEventListener('click', () => {
  const a = analysis;
  if (a.playlist) {
    const items = [...$('plList').querySelectorAll('input:checked')].map((c) => a.entries[Number(c.dataset.pl)]);
    if (!items.length) return;
    $('urlCard').hidden = true;
    return batch(items);
  }
  const o = { height: Number($('urlHeight').value) || 0, audioLang: $('urlLang').value || null, title: a.title };
  const subs = [...$('urlSubs').selectedOptions].map((x) => x.value);
  if (subs.length) o.subLangs = subs;
  if ($('urlSection').checked) {
    const from = parseTime($('urlFrom').value) ?? 0;
    const to = parseTime($('urlTo').value);
    if (to === null || to <= from) return toast(t('Passage invalide : indique un début et une fin (ex. 1:20 à 1:35)'), 'error');
    o.section = { start: from, end: to };
  }
  $('urlCard').hidden = true;
  download(analyzedUrl, o);
});

async function download(url, options) {
  try {
    const r = await api('/api/source', { input: url, options });
    onSource(await waitJob(r.job, t('Téléchargement')));
  } catch (e) { fail(e); }
}

async function batch(items) {
  try {
    const r = await api('/api/source/batch', { items, options: { height: Number(ctx.appSettings.defaultHeight) || 0 } });
    toast(t('{n} téléchargement(s) en file : ouvre « Vidéos téléchargées » quand c’est fini', { n: r.jobs.length }), 'ok', 8000);
    const { refreshQueue } = await import('./exportui.js');
    refreshQueue();
    openDialog('queueDlg');
  } catch (e) { fail(e); }
}

// ---------- fichiers ----------

$('browseBtn').addEventListener('click', async () => {
  if (native) {
    const p = await native.openFile();
    if (p) loadInput(p);
  } else $('fileInput').click();
});
$('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });

export async function openFile(file) {
  // Sous-titres glissés sur une vidéo ouverte.
  if (/\.(srt|ass|ssa|vtt)$/i.test(file.name) && ctx.source) {
    const dt = new DataTransfer();
    dt.items.add(file);
    $('subsFile').files = dt.files;
    $('subsFile').dispatchEvent(new Event('change'));
    return;
  }
  // Dans l'appli Electron, le vrai chemin évite de recopier le fichier.
  const p = native && native.pathFor(file);
  if (p) return loadInput(p);
  try {
    status(t('Copie de {name}…', { name: file.name }));
    const r = await uploadRaw('/api/upload', file, file.name);
    status('');
    onSource(r.source);
  } catch (e) { status(''); fail(e); }
}
const status = (txt) => { $('status').hidden = !txt; $('statusText').textContent = txt; };

document.addEventListener('dragover', (e) => { e.preventDefault(); $('empty').classList.add('drag'); });
document.addEventListener('dragleave', () => $('empty').classList.remove('drag'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  $('empty').classList.remove('drag');
  const files = [...e.dataTransfer.files];
  if (files.length > 1 && files.every((f) => f.type.startsWith('image/') && !/gif|webp/.test(f.type))) return openImages(files);
  if (files[0]) return openFile(files[0]);
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) loadInput(text);
});

// Ctrl+V n'importe où (hors champ de saisie) : URL, chemin ou fichier copié.
document.addEventListener('paste', (e) => {
  if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const f = e.clipboardData.files[0];
  if (f) { e.preventDefault(); openFile(f); return; }
  const text = e.clipboardData.getData('text').trim();
  if (text && (isUrl(text) || /^"?([a-z]:\\|\/|\\\\)/i.test(text))) {
    e.preventDefault();
    $('sourceInput').value = text;
    loadInput(text);
  }
});

// ---------- bibliothèque ----------

async function renderLibrary() {
  try {
    const { items, dir } = await api('/api/library');
    $('libraryInfo').textContent = `${dir} · ${items.length} ${t('vidéos')} · ${fmtBytes(items.reduce((s, x) => s + x.bytes, 0))}`;
    $('libraryList').innerHTML = items.length ? items.map((x, i) => `<li>
      <span class="grow" title="${esc(x.path)}">${esc(x.name)}</span>
      <span class="muted small">${fmtBytes(x.bytes)} · ${new Date(x.date).toLocaleDateString()}</span>
      <button type="button" class="primary small" data-lib="${i}">${t('Ouvrir')}</button>
      <button type="button" class="ghost small" data-libdel="${i}" title="${t('Supprimer le fichier')}">✕</button></li>`).join('') : `<li class="muted">${t('Aucune vidéo téléchargée.')}</li>`;
    libItems = items;
  } catch (e) { fail(e); }
}
let libItems = [];
$('libraryDlg').addEventListener('opened', renderLibrary);
$('libraryList').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-lib]');
  const d = e.target.closest('[data-libdel]');
  if (o) { $('libraryDlg').close(); loadInput(libItems[Number(o.dataset.lib)].path); }
  if (d) {
    try { await api('/api/library', { path: libItems[Number(d.dataset.libdel)].path }, 'DELETE'); renderLibrary(); } catch (err) { fail(err); }
  }
});

// Vidéos récentes sur l'écran d'accueil.
export async function renderRecent() {
  try {
    const { items } = await api('/api/library');
    $('recent').innerHTML = items.slice(0, 6).map((x, i) => `<button type="button" class="ghost small" data-recent="${i}" title="${esc(x.path)}">${esc(x.name)}</button>`).join('');
    $('recent').onclick = (e) => { const b = e.target.closest('[data-recent]'); if (b) loadInput(items[Number(b.dataset.recent)].path); };
  } catch { /* pas grave */ }
}

// ---------- projets ----------

let projects = {};
async function renderProjects() {
  try { projects = await api('/api/projects'); } catch { projects = {}; }
  const names = Object.keys(projects).sort((a, b) => projects[b].date - projects[a].date);
  $('projectList').innerHTML = names.length ? names.map((n) => `<li>
    <span class="grow">${esc(n)}</span><span class="muted small" title="${esc(projects[n].source)}">${esc(projects[n].sourceName || '')} · ${new Date(projects[n].date).toLocaleDateString()}</span>
    <button type="button" class="primary small" data-proj="${esc(n)}">${t('Ouvrir')}</button>
    <button type="button" class="ghost small" data-projseries="${esc(n)}">${t('Créer une série')}</button>
    <button type="button" class="ghost small" data-projdel="${esc(n)}">✕</button></li>`).join('') : `<li class="muted">${t('Aucun projet.')}</li>`;
  if (ctx.source && !$('projectName').value) $('projectName').value = ctx.source.name.replace(/\.[^.]+$/, '');
}
$('projectsDlg').addEventListener('opened', renderProjects);
$('projectSave').addEventListener('click', async () => {
  if (!ctx.source) return toast(t('Ouvre d’abord une vidéo'), 'error');
  const name = $('projectName').value.trim();
  if (!name) return;
  if (!ctx.source.path || ctx.source.origin?.kind === 'upload') toast(t('Vidéo envoyée depuis le navigateur : le projet pointera vers une copie temporaire.'));
  projects[name] = { date: Date.now(), source: ctx.source.path, sourceName: ctx.source.name, doc: state.doc };
  try { await api('/api/projects', projects, 'PUT'); toast(t('Projet enregistré'), 'ok'); renderProjects(); } catch (e) { fail(e); }
});
$('projectList').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-proj]');
  const d = e.target.closest('[data-projdel]');
  const convert = e.target.closest('[data-projseries]');
  if (convert) {
    const name = convert.dataset.projseries;
    $('projectSeriesTitle').textContent = name;
    const conversion = $('projectSeriesDlg');
    conversion.returnValue = '';
    conversion.querySelector('[value="split"]').disabled = !projects[name].doc.segments?.length;
    conversion.addEventListener('close', async () => {
      const choice = conversion.returnValue;
      if (!['split', 'assembled'].includes(choice)) return;
      $('projectsDlg').close();
      try { await (await import('./series.js')).importProject(projects[name], name, choice === 'split'); }
      catch (error) { fail(error); }
    }, { once: true });
    conversion.showModal();
    return;
  }
  if (o) {
    const p = projects[o.dataset.proj];
    $('projectsDlg').close();
    try {
      const r = await api('/api/source', { input: p.source });
      onSource(r.source, () => replaceDoc(p.doc));
    } catch (err) { fail(err); }
  }
  if (d) {
    delete projects[d.dataset.projdel];
    try { await api('/api/projects', projects, 'PUT'); renderProjects(); } catch (err) { fail(err); }
  }
});

// ---------- images → GIF ----------

let images = [];
$('imagesBtn').addEventListener('click', () => openDialog('imagesDlg'));
$('imgPick').addEventListener('click', () => $('imgFiles').click());
$('imgFiles').addEventListener('change', (e) => { openImages([...e.target.files]); e.target.value = ''; });
function openImages(files) {
  images = files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  openDialog('imagesDlg');
  renderImages();
}
function renderImages() {
  $('imgList').innerHTML = images.map((f, i) => `<li draggable="true" data-img="${i}"><img src="${URL.createObjectURL(f)}" alt="">${esc(f.name)}</li>`).join('');
  $('imgBuild').disabled = !images.length;
}
let dragImg = null;
$('imgList').addEventListener('dragstart', (e) => { dragImg = Number(e.target.closest('[data-img]')?.dataset.img); e.stopPropagation(); });
$('imgList').addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
$('imgList').addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const to = Number(e.target.closest('[data-img]')?.dataset.img);
  if (dragImg === null || Number.isNaN(to)) return;
  const [m] = images.splice(dragImg, 1);
  images.splice(to, 0, m);
  dragImg = null;
  renderImages();
});
$('imgBuild').addEventListener('click', async () => {
  const group = Math.random().toString(36).slice(2, 10);
  try {
    const names = [];
    for (let i = 0; i < images.length; i++) {
      $('statusText').textContent = '';
      status(t('Envoi des images {i}/{n}', { i: i + 1, n: images.length }));
      names.push((await uploadRaw(`/api/images/${group}`, images[i], `${String(i).padStart(5, '0')}-${images[i].name}`)).file);
    }
    status('');
    const r = await api(`/api/images/${group}/build`, { files: names, fps: Number($('imgFps').value) });
    $('imagesDlg').close();
    onSource(await waitJob(r.job, t('Assemblage')));
  } catch (e) { status(''); fail(e); }
});

// ffmpeg ne décode pas le WebP animé : le navigateur le fait, image par image, puis on assemble.
// shortcut: cadence moyenne pour tout le fichier, à revoir si un WebP à durées d'image très inégales pose souci.
export async function openAnimatedWebp(src) {
  try {
    if (!window.ImageDecoder) throw new Error(t('Ce WebP animé ne peut pas être ouvert ici.'));
    const dec = new ImageDecoder({ data: (await fetch(`/api/media/${src.id}`)).body, type: 'image/webp' });
    await dec.completed;
    const n = dec.tracks.selectedTrack.frameCount;
    const group = Math.random().toString(36).slice(2, 10);
    const canvas = document.createElement('canvas');
    const names = [];
    let us = 0;
    for (let i = 0; i < n; i++) {
      status(t('Lecture du WebP {i}/{n}', { i: i + 1, n }));
      const { image } = await dec.decode({ frameIndex: i });
      us += image.duration || 0;
      canvas.width = image.displayWidth;
      canvas.height = image.displayHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      image.close();
      const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      names.push((await uploadRaw(`/api/images/${group}`, png, `${String(i).padStart(5, '0')}.png`)).file);
    }
    status('');
    const r = await api(`/api/images/${group}/build`, { files: names, fps: us ? n / (us / 1e6) : 10, name: src.name });
    onSource(await waitJob(r.job, t('Assemblage')));
  } catch (e) { status(''); fail(e); }
}

// ---------- capture d'écran ----------

let recorder = null;
let chunks = [];
let capTimer = null;
$('captureBtn').addEventListener('click', () => openDialog('captureDlg'));
$('capStart').addEventListener('click', async () => {
  try {
    const fps = Number($('capFps').value);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: $('capAudio').checked });
    $('capPreview').srcObject = stream;
    $('capPreview').hidden = false;
    $('capPreview').play();
    chunks = [];
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      clearInterval(capTimer);
      $('capPreview').hidden = true;
      $('capStart').hidden = false;
      $('capStop').hidden = true;
      const blob = new Blob(chunks, { type: 'video/webm' });
      $('captureDlg').close();
      try {
        const r = await uploadRaw(`/api/record?fps=${fps}`, blob, 'capture.webm');
        onSource(await waitJob(r.job, t('Capture')));
      } catch (err) { fail(err); }
    };
    // L'utilisateur peut aussi arrêter le partage depuis la barre du navigateur.
    stream.getVideoTracks()[0].addEventListener('ended', () => recorder && recorder.state === 'recording' && recorder.stop());
    recorder.start(1000);
    const t0 = Date.now();
    capTimer = setInterval(() => { $('capTime').textContent = fmtTime((Date.now() - t0) / 1000).replace(/\.\d+$/, ''); }, 500);
    $('capStart').hidden = true;
    $('capStop').hidden = false;
  } catch (e) { if (e.name !== 'NotAllowedError') fail(e); }
});
$('capStop').addEventListener('click', () => recorder && recorder.stop());
