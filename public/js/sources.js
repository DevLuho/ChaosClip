// Sources : URL (analyse, qualité, passage, playlist), fichiers, bibliothèque, projets, images, capture.
import { $, api, runAction, fail, toast, esc, fmtBytes, fmtTime, parseTime, uploadRaw, native, android, openDialog, confirmAsk } from './util.js';
import { t, getLang } from './i18n.js';
import { ctx } from './ctx.js';
import { state, replaceDoc } from './state.js';
import { urlTime } from './url-time.mjs';

let onSource = null; // fourni par main.js
export const setOnSource = (fn) => { onSource = fn; };

const isUrl = (s) => /^https?:\/\//i.test(s);

// ---------- saisie ----------

const sourceInput = $('sourceInput');
if (android) sourceInput.placeholder = t('Colle un lien'); // pas de chemins de fichier à taper sur un téléphone
const sourceControls = [$('loadBtn'), $('browseBtn'), $('urlGo')];
const importSource = (label, run) => runAction('source-import', label, run, { controls: sourceControls });

// Téléphone : champ vide, le bouton devient « Coller » et charge le presse-papiers (coller demande sinon un appui long).
const loadLabel = () => { if (android) $('loadBtn').textContent = t(sourceInput.value.trim() ? 'Charger' : 'Coller'); };
sourceInput.addEventListener('input', loadLabel);
loadLabel();
$('loadForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (android && !sourceInput.value.trim()) {
    const links = android.paste().match(/https?:\/\/\S+/g); // un texte quelconque n'est pas une source
    if (!links) return toast(t('Aucun lien dans le presse-papiers'));
    sourceInput.value = links.join('\n');
    loadLabel();
  }
  loadInput(sourceInput.value);
});
sourceInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  if (!event.repeat) $('loadForm').requestSubmit();
});

export async function loadInput(raw, after, historyId) {
  const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (!lines.length) return;
  if (lines.length > 1 && lines.every(isUrl)) {
    return importSource(t('Ajout des téléchargements…'), () => batch(lines.map((url) => ({ url }))));
  }
  const input = lines[0];
  if (isUrl(input)) return importSource(t('Analyse du lien…'), (activity) => analyze(input, activity));
  return importSource(t('Ouverture de la source…'), async () => {
    const { source } = await api('/api/source', { input, historyId });
    await onSource(source, after);
  });
}

// ---------- analyse d'URL ----------

let analysis = null;
let analyzedUrl = '';
async function analyze(url, activity) {
  try {
    const { job } = await api('/api/analyze', { url });
    analysis = await activity.wait(job);
    analyzedUrl = url;
    showCard();
    $('urlGo').focus();
  } catch (e) {
    if (e.cancelled || /pris en charge|DRM/.test(e.message)) throw e;
    toast(`${t('Analyse impossible, téléchargement direct…')} (${e.message.slice(0, 120)})`);
    await download(url, {}, activity);
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
  const at = urlTime(analyzedUrl);
  $('urlFrom').value = at ? fmtTime(at).replace(/\.000$/, '') : '';
  $('urlTo').value = '';
  $('urlGo').textContent = t('Télécharger');
}
$('urlSection').addEventListener('change', (e) => { $('urlSectionFields').hidden = !e.target.checked; });
$('urlCancel').addEventListener('click', () => { $('urlCard').hidden = true; sourceInput.focus(); });
$('plAll').addEventListener('change', (e) => { $('plList').querySelectorAll('input').forEach((c) => { c.checked = e.target.checked; }); });

$('urlGo').addEventListener('click', () => {
  const a = analysis;
  if (!a) return;
  if (a.playlist) {
    const items = [...$('plList').querySelectorAll('input:checked')].map((c) => a.entries[Number(c.dataset.pl)]);
    if (!items.length) return;
    return importSource(t('Ajout des téléchargements…'), () => batch(items));
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
  importSource(t('Téléchargement'), (activity) => download(analyzedUrl, o, activity));
});

async function download(url, options, activity) {
  activity.text(t('Téléchargement'));
  const { job } = await api('/api/source', { input: url, options });
  const src = await activity.wait(job, t('Téléchargement'));
  // Lien avec un temps (?t=90) : le curseur s'y place, sauf si seul ce passage a été téléchargé.
  const at = options.section ? 0 : urlTime(url);
  await onSource(src, undefined, at ? { frame: Math.round(at * src.info.fps) } : undefined);
  renderRecent();
}

async function batch(items) {
  const r = await api('/api/source/batch', { items, options: { height: Number(ctx.appSettings.defaultHeight) || 0 } });
  $('urlCard').hidden = true;
  toast(t('{n} téléchargement(s) en file : ouvre « Vidéos téléchargées » quand c’est fini', { n: r.jobs.length }), 'ok', 8000);
  openDialog('queueDlg');
}

// ---------- fichiers ----------

let choosingFile = false;
$('browseBtn').addEventListener('click', async () => {
  if (choosingFile || $('browseBtn').getAttribute('aria-disabled') === 'true') return;
  if (!native) return $('fileInput').click();
  choosingFile = true;
  try {
    const path = await native.openFile();
    if (path) await loadInput(path);
  } catch (error) { fail(error); }
  finally { choosingFile = false; }
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
  return importSource(t('Copie de {name}…', { name: file.name }), async () => {
    const { source } = await uploadRaw('/api/upload', file, file.name);
    await onSource(source);
  });
}

// Un fichier survole la fenêtre : le cadre de l'accueil s'allume, ou un voile sur le montage quand une vidéo est ouverte.
// « dragover » revient en continu tant que le fichier est là : un court délai sans lui vaut sortie, sans clignoter.
document.body.dataset.drop = t('Dépose le fichier pour l’ouvrir');
let dragEnd;
const dragging = (on) => { $('empty').classList.toggle('drag', on); document.body.classList.toggle('dragging', on); };
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  dragging(true);
  clearTimeout(dragEnd);
  dragEnd = setTimeout(() => dragging(false), 200);
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragging(false);
  const files = [...e.dataTransfer.files];
  if (files.length > 1 && files.every((f) => f.type.startsWith('image/') && !/gif|webp/.test(f.type))) return openImages(files);
  if (files.length) return openFiles(files);
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) loadInput(text);
});

// Plusieurs fichiers : un onglet chacun, les sous-titres en dernier (ils vont sur la vidéo ouverte).
async function openFiles(files) {
  const subs = (f) => /\.(srt|ass|ssa|vtt)$/i.test(f.name);
  for (const f of [...files].sort((a, b) => subs(a) - subs(b))) await openFile(f);
}

// Ctrl+V n'importe où (hors champ de saisie) : URL, chemin ou fichier copié.
document.addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea, [contenteditable], dialog')) return;
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
    $('libraryList').innerHTML = items.length ? items.map((x, i) => `<li data-libname="${esc(x.name.toLowerCase())}">
      <img class="libthumb" src="/api/library/thumb?path=${encodeURIComponent(x.path)}" alt="" loading="lazy">
      <span class="grow" title="${esc(x.path)}">${esc(x.name)}</span>
      <span class="muted small">${fmtBytes(x.bytes)} · ${new Date(x.date).toLocaleDateString(getLang())}</span>
      <button type="button" class="primary small" data-lib="${i}">${t('Ouvrir')}</button>
      <button type="button" class="ghost small" data-libreveal="${i}">${t('Dossier')}</button>
      <button type="button" class="ghost small" data-libdel="${i}" title="${t('Supprimer le fichier')}">✕</button></li>`).join('') : `<li class="muted">${t('Aucune vidéo téléchargée.')}</li>`;
    libItems = items;
    filterLibrary();
  } catch (e) { fail(e); }
}
function filterLibrary() {
  const q = $('librarySearch').value.trim().toLowerCase();
  for (const li of $('libraryList').querySelectorAll('[data-libname]')) li.hidden = !!q && !li.dataset.libname.includes(q);
}
$('librarySearch').addEventListener('input', filterLibrary);
$('libraryList').addEventListener('error', (e) => { if (e.target.matches('.libthumb')) e.target.hidden = true; }, true);
$('libraryPurge').addEventListener('click', async () => {
  if (!(await confirmAsk(t('Supprimer les vidéos téléchargées il y a plus de 30 jours ? Celles d’une série ou ouvertes sont gardées.'), t('Supprimer')))) return;
  try {
    const r = await api('/api/library/purge', { days: 30 });
    toast(t('{n} vidéo(s) supprimée(s) · {s} libérés', { n: r.count, s: fmtBytes(r.freed) }), 'ok');
    renderLibrary();
    renderRecent();
  } catch (e) { fail(e); }
});
let libItems = [];
$('libraryDlg').addEventListener('opened', renderLibrary);
$('libraryList').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-lib]');
  const d = e.target.closest('[data-libdel]');
  const r = e.target.closest('[data-libreveal]');
  if (o) { $('libraryDlg').close(); loadInput(libItems[Number(o.dataset.lib)].path); }
  if (r) api('/api/library/reveal', { path: libItems[Number(r.dataset.libreveal)].path }).catch(fail);
  if (d) {
    try { await api('/api/library', { path: libItems[Number(d.dataset.libdel)].path }, 'DELETE'); renderLibrary(); } catch (err) { fail(err); }
  }
});

// Vidéos récentes sur l'écran d'accueil.
export async function renderRecent() {
  try {
    const { items } = await api('/api/library');
    $('recentSection').hidden = !items.length;
    $('recent').innerHTML = items.slice(0, 5).map((x, i) => `<button type="button" class="ghost small" data-recent="${i}" title="${esc(x.path)}">${esc(x.name)}</button>`).join('');
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
    <button type="button" class="ghost small" aria-label="${t('Supprimer le projet')}" data-projdel="${esc(n)}">✕</button></li>`).join('') : `<li class="muted">${t('Aucun projet.')}</li>`;
  if (ctx.source && !$('projectName').value) $('projectName').value = ctx.source.name.replace(/\.[^.]+$/, '');
}
// Fichiers ouverts par leur chemin (pas les téléchargements, listés à part) : gardés sur cet appareil.
const recentFiles = () => { try { return JSON.parse(localStorage.getItem('chaosclip.recentFiles')) || []; } catch { return []; } };
export function rememberFile(src) {
  if (android || src.origin?.kind !== 'file') return; // téléphone : ce sont des copies temporaires, qui disparaissent
  const list = [{ name: src.name, path: src.path }, ...recentFiles().filter((x) => x.path !== src.path)].slice(0, 6);
  try { localStorage.setItem('chaosclip.recentFiles', JSON.stringify(list)); } catch { /* stockage indisponible */ }
  renderRecentFiles();
}
function renderRecentFiles() {
  const list = recentFiles();
  $('recentFilesSection').hidden = !list.length;
  $('recentFiles').innerHTML = list.map((x, i) => `<button type="button" class="ghost small" data-recent-file="${i}" title="${esc(x.path)}">${esc(x.name)}</button>`).join('');
}
$('recentFiles').addEventListener('click', (e) => {
  const b = e.target.closest('[data-recent-file]');
  if (b) loadInput(recentFiles()[Number(b.dataset.recentFile)].path);
});
renderRecentFiles();

export async function renderRecentProjects() {
  try {
    const entries = Object.entries(await api('/api/projects')).sort(([, a], [, b]) => b.date - a.date).slice(0, 5);
    $('recentProjects').innerHTML = entries.map(([name], i) => `<button class="ghost small" type="button" data-recent-project="${i}">${esc(name)}</button>`).join('');
    $('recentProjects').onclick = (event) => {
      const choice = event.target.closest('[data-recent-project]');
      if (!choice) return;
      const [, project] = entries[Number(choice.dataset.recentProject)];
      loadInput(project.source, () => replaceDoc(project.doc));
    };
  } catch { /* La fenêtre Projets reste accessible. */ }
}
$('projectsDlg').addEventListener('opened', renderProjects);
$('projectSave').addEventListener('click', async () => {
  if (!ctx.source) return toast(t('Ouvre d’abord une vidéo'), 'error');
  const name = $('projectName').value.trim();
  if (!name) return;
  if (!ctx.source.path || ctx.source.origin?.kind === 'upload') toast(t('Vidéo envoyée depuis le navigateur : le projet pointera vers une copie temporaire.'));
  projects[name] = { date: Date.now(), source: ctx.source.path, sourceName: ctx.source.name, doc: state.doc };
  try { await api('/api/projects', projects, 'PUT'); toast(t('Projet enregistré'), 'ok'); renderProjects(); renderRecentProjects(); } catch (e) { fail(e); }
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
    loadInput(p.source, () => replaceDoc(p.doc));
  }
  if (d) {
    delete projects[d.dataset.projdel];
    try { await api('/api/projects', projects, 'PUT'); renderProjects(); renderRecentProjects(); } catch (err) { fail(err); }
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
$('imgBuild').addEventListener('click', () => {
  if (!images.length) return;
  const files = [...images];
  const fps = Number($('imgFps').value);
  return runAction('image-sequence', t('Assemblage'), async (activity) => {
    const group = Math.random().toString(36).slice(2, 10);
    const names = [];
    for (const [i, file] of files.entries()) {
      activity.text(t('Envoi des images {i}/{n}', { i: i + 1, n: files.length }));
      names.push((await uploadRaw(`/api/images/${group}`, file, `${String(i).padStart(5, '0')}-${file.name}`)).file);
    }
    const { job } = await api(`/api/images/${group}/build`, { files: names, fps });
    const source = await activity.wait(job);
    $('imagesDlg').close();
    await onSource(source);
  }, { host: $('imagesActivity'), controls: [$('imgBuild')] });
});

// ffmpeg ne décode pas le WebP animé : le navigateur le fait, image par image, puis on assemble.
// shortcut: cadence moyenne pour tout le fichier, à revoir si un WebP à durées d'image très inégales pose souci.
export function openAnimatedWebp(src, after) {
  return runAction(`webp:${src.id}`, t('Assemblage'), async (activity) => {
    if (!window.ImageDecoder) throw new Error(t('Ce WebP animé ne peut pas être ouvert ici.'));
    const dec = new ImageDecoder({ data: (await fetch(`/api/media/${src.id}`)).body, type: 'image/webp' });
    await dec.completed;
    const n = dec.tracks.selectedTrack.frameCount;
    const group = Math.random().toString(36).slice(2, 10);
    const canvas = document.createElement('canvas');
    const names = [];
    let us = 0;
    for (let i = 0; i < n; i++) {
      activity.text(t('Lecture du WebP {i}/{n}', { i: i + 1, n }));
      const { image } = await dec.decode({ frameIndex: i });
      us += image.duration || 0;
      canvas.width = image.displayWidth;
      canvas.height = image.displayHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      image.close();
      const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      names.push((await uploadRaw(`/api/images/${group}`, png, `${String(i).padStart(5, '0')}.png`)).file);
    }
    const r = await api(`/api/images/${group}/build`, { files: names, fps: us ? n / (us / 1e6) : 10, name: src.name });
    await onSource(await activity.wait(r.job), after);
  });
}

// ---------- capture d'écran ----------

let recorder = null;
let chunks = [];
let capTimer = null;
let choosingScreen = false;
$('captureBtn').addEventListener('click', () => openDialog('captureDlg'));
$('capStart').addEventListener('click', async () => {
  if (choosingScreen || recorder?.state === 'recording' || $('capStart').getAttribute('aria-disabled') === 'true') return;
  choosingScreen = true;
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
      runAction('capture-upload', t('Capture'), async (activity) => {
        const r = await uploadRaw(`/api/record?fps=${fps}`, blob, 'capture.webm');
        const source = await activity.wait(r.job);
        $('captureDlg').close();
        await onSource(source);
      }, { host: $('captureActivity'), controls: [$('capStart')] });
    };
    // L'utilisateur peut aussi arrêter le partage depuis la barre du navigateur.
    stream.getVideoTracks()[0].addEventListener('ended', () => recorder && recorder.state === 'recording' && recorder.stop());
    recorder.start(1000);
    const t0 = Date.now();
    capTimer = setInterval(() => { $('capTime').textContent = fmtTime((Date.now() - t0) / 1000).replace(/\.\d+$/, ''); }, 500);
    $('capStart').hidden = true;
    $('capStop').hidden = false;
  } catch (e) { if (e.name !== 'NotAllowedError') fail(e); }
  finally { choosingScreen = false; }
});
$('capStop').addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });
