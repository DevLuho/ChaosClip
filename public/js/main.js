// Point d'entrée : relie les modules, les actions et les raccourcis.
import { $, esc, toast, native, android, openDialog, api, debounce } from './util.js';
import { t, translateDom } from './i18n.js';
import { ctx, emit, listen } from './ctx.js';
import { state, on, update, undo, redo, resetDoc, replaceDoc, bindInputs } from './state.js';
import * as player from './player.js';
import * as timeline from './timeline.js';
import * as overlay from './overlay.js';
import * as panels from './panels.js';
import { actionFor } from './keys.js';
import { acceptsShortcut } from './action-lock.mjs';
import * as exp from './exportui.js';
import * as sources from './sources.js';
import * as settings from './settingsui.js';
import * as series from './series.js';

translateDom();
bindInputs();

// ---------- rendu à chaque modification ----------

on((why) => {
  panels.renderAll();
  overlay.renderCropFields();
  overlay.render();
  player.renderSelection();
  timeline.render();
  timeline.renderMarkers();
  if (why !== 'load') emit('docchange');
});

// ---------- chargement d'une source ----------

// ---------- onglets : un chantier par onglet (source, réglages, position, annulations) ----------

const tabs = [];
let active = -1;
let nextTabId = 1;
const newTab = () => ({ id: nextTabId++ });

const compact = matchMedia('(max-width: 1000px)');
let inspectorOpen = false;
function renderInspector() {
  const toggle = $('inspectorToggle');
  const hideInspector = compact.matches && !inspectorOpen;
  toggle.hidden = !compact.matches;
  toggle.setAttribute('aria-expanded', String(!hideInspector));
  if (hideInspector && $('clipInspector').contains(document.activeElement)) toggle.focus();
  $('clipInspector').hidden = hideInspector;
}
$('inspectorToggle').addEventListener('click', () => {
  inspectorOpen = !inspectorOpen;
  renderInspector();
});
compact.addEventListener('change', renderInspector);
renderInspector();

function showWorkspace(open) {
  document.body.classList.toggle('home', !open);
  $('settings').hidden = !open;
  const destination = $(open ? 'editorSource' : 'homeSource');
  if ($('loadForm').parentElement !== destination) destination.append($('loadForm'));
}

function keepTab() {
  const tb = tabs[active];
  if (tb && ctx.source) Object.assign(tb, { source: ctx.source, doc: structuredClone(state.doc), undo: state.undoStack, redo: state.redoStack, frame: player.shownFrame(), also: [...document.querySelectorAll('.alsoFmt:checked')].map((input) => input.value), name: $('exportName').value });
}
function renderTabs() {
  $('tabs').hidden = !tabs.length;
  $('tabList').innerHTML = tabs.map((tb, i) => `<span class="tab${i === active ? ' active' : ''}"><button type="button" data-tab="${i}" title="${esc(tb.source?.name || '')}"${i === active ? ' aria-current="true"' : ''}>${esc(tb.source?.name || t('Nouvel onglet'))}</button><button type="button" data-tab-close="${i}" aria-label="${esc(t('Fermer l’onglet'))}">✕</button></span>`).join('');
}
function showEmpty() {
  ctx.source = null;
  ctx.tabId = tabs[active]?.id;
  showWorkspace(false);
  emit('source', null);
  sources.renderRecent();
  player.video.pause();
  player.video.removeAttribute('src');
  player.video.load();
  $('stage').hidden = true;
  $('empty').hidden = false;
  exp.restoreResults(ctx.tabId);
  $('preview').hidden = true;
  $('unplayable').hidden = true;
  exp.setEnabled(false);
  document.title = 'ChaosClip';
}
function goTab(i) {
  keepTab();
  active = i;
  const tb = tabs[i];
  renderTabs();
  if (!tb?.source) return showEmpty();
  showSource(tb.source, () => {
    replaceDoc(tb.doc);
    state.undoStack = tb.undo;
    state.redoStack = tb.redo;
    $('exportName').value = tb.name;
    document.querySelectorAll('.alsoFmt').forEach((input) => { input.checked = tb.also?.includes(input.value) ?? false; });
  }, true, tb.frame);
}
$('tabs').addEventListener('click', async (e) => {
  const close = e.target.closest('[data-tab-close]');
  const tab = e.target.closest('[data-tab]');
  if (e.target.closest('#tabNew')) { newTabAction(); return; }
  if (tab && Number(tab.dataset.tab) !== active) { goTab(Number(tab.dataset.tab)); focusActiveTab(); return; }
  if (close) closeTab(Number(close.dataset.tabClose));
});

// Onglets fermés : Ctrl+Maj+T les rouvre (les 10 derniers).
const closedTabs = [];
function closeTab(i) {
  if (!tabs[i]) return;
  if (i === active) keepTab();
  const [closing] = tabs.splice(i, 1);
  exp.forgetResults(closing.id);
  if (closing.source) {
    closedTabs.push(closing);
    if (closedTabs.length > 10) closedTabs.shift();
    toast(t('Onglet fermé · Ctrl+Maj+T pour le rouvrir'), '', 4000);
  }
  if (i < active) active--;
  else if (i === active) { active = -1; if (tabs.length) { goTab(Math.min(i, tabs.length - 1)); focusActiveTab(); saveSession(); return; } showEmpty(); }
  renderTabs();
  focusActiveTab();
  saveSession();
}
function reopenTab() {
  const tb = closedTabs.pop();
  if (!tb) return;
  keepTab();
  tabs.push(tb);
  goTab(tabs.length - 1);
}
function newTabAction() { goTab(tabs.push(newTab()) - 1); $('sourceInput').focus(); }
function cycleTab(dir) { if (tabs.length > 1) { goTab((active + dir + tabs.length) % tabs.length); focusActiveTab(); } }

// ---------- session : les onglets ouverts reviennent au prochain lancement ----------

const SESSION = 'chaosclip.session';
function saveSession() {
  keepTab();
  const list = tabs.filter((tb) => tb.source?.path).map((tb) => ({ path: tb.source.path, doc: tb.doc, frame: tb.frame, name: tb.name, active: tb === tabs[active] }));
  try { localStorage.setItem(SESSION, JSON.stringify(list)); } catch { /* stockage plein : pas de reprise */ }
}
const saveSoon = debounce(saveSession, 1000);
listen('docchange', saveSoon);
window.addEventListener('pagehide', saveSession);

async function restoreSession() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(SESSION) || '[]'); } catch { /* session illisible */ }
  if (!Array.isArray(saved) || !saved.length) return;
  let missing = 0;
  let focus = -1;
  for (const tb of saved) {
    try {
      const { source } = await api('/api/source', { input: tb.path });
      await onSource(source, () => { replaceDoc(tb.doc); state.undoStack = []; $('exportName').value = tb.name || ''; }, { quiet: true, frame: tb.frame });
      if (tb.active) focus = active;
    } catch { missing++; }
  }
  if (focus >= 0 && focus !== active) goTab(focus);
  const opened = saved.length - missing;
  if (opened) toast(t('{n} onglet(s) rouvert(s)', { n: opened }), 'ok', 3000);
  if (missing) toast(t('{n} vidéo(s) de la dernière session introuvable(s)', { n: missing }), '', 6000);
}

function focusActiveTab() {
  (document.querySelector(`[data-tab="${active}"]`) || $('sourceInput')).focus();
}
$('tabList').addEventListener('keydown', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const i = Number(tab.dataset.tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (i + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
  if (active !== next) goTab(next);
  focusActiveTab();
});

// Une nouvelle source s'ouvre dans son propre onglet (ou remplit l'onglet vide affiché).
function onSource(src, after, { quiet = false, frame } = {}) {
  if (!src.info.width && src.info.vcodec === 'webp') return sources.openAnimatedWebp(src, after);
  keepTab();
  if (!tabs[active] || tabs[active].source) { tabs.push(newTab()); active = tabs.length - 1; }
  tabs[active].source = src;
  showSource(src, after, quiet, frame);
  renderTabs();
  saveSoon();
  if (!document.querySelector('dialog[open]')) $('timeline').focus({ preventScroll: true });
}

function showSource(src, after, quiet, frame) {
  ctx.source = src;
  ctx.tabId = tabs[active].id;
  showWorkspace(true);
  $('urlCard').hidden = true;
  $('exportName').value = '';
  document.querySelectorAll('.alsoFmt').forEach((input) => { input.checked = false; });
  resetDoc(true);
  const f0 = 0;
  update((d) => { d.sel = { start: f0, end: ctx.frameAt(3) }; }, { undoable: false, why: 'load' });
  player.loadVideo(src, frame);
  panels.renderAudioTracks();
  emit('source', src);
  exp.setEnabled(true);
  $('result').hidden = true;
  $('preview').hidden = true;
  document.title = `${src.name} · ChaosClip`;
  if (after) after();
  exp.restoreResults(ctx.tabId);
  panels.renderAll();
  timeline.render();
  if (!quiet) toast(t('Chargé : {name}', { name: src.name }), 'ok', 3000);
}
listen('sourceUpdate', ({ tabId, source }) => {
  const tab = tabs.find((item) => item.id === tabId);
  if (tab) tab.source = source;
});
sources.setOnSource(onSource);
series.connectEditor(onSource);

// « Refaire » depuis l'historique : recharge la vidéo et les réglages de l'export.
exp.setApplySettings(async (entry) => {
  const s = entry.settings;
  await sources.loadInput(entry.source.path, () => {
    replaceDoc({
      sel: { start: s.segments[0].start, end: s.segments[s.segments.length - 1].end },
      segments: s.segments,
      crop: s.crop, cropKeys: s.cropKeys || [], blurZones: s.blurZones || [], texts: s.texts || [],
      subs: s.subs ? { kind: s.subs.kind, index: s.subs.index } : null,
      transparent: s.transparent ? s.transparent.color : null,
      logo: s.logo ? { file: s.logo.file, animated: s.logo.animated, name: s.logo.file } : null,
      opts: {
        ...state.doc.opts, format: s.format, width: s.width, fps: s.fps, speed: s.speed, loop: s.loop, pingpong: s.pingpong,
        reverse: s.reverse, crossfade: s.crossfade, zoom: s.zoom, filters: s.filters, rotate: s.rotate, flipH: s.flipH, flipV: s.flipV,
        colors: s.colors, dither: s.dither, bayerScale: s.bayerScale, lossy: s.lossy, quality: s.quality, audio: s.audio,
        audioTrack: s.audioTrack, hw: s.hw, sheet: s.sheet, subsOffset: s.subs?.offset ?? 0,
        logoPosition: s.logo?.position ?? 'br', logoSize: s.logo?.size ?? 15, logoOpacity: s.logo?.opacity ?? 100,
        transparentSimilarity: s.transparent?.similarity ?? 0.15, sacrificeFirst: s.sacrifice?.[0] ?? 'width',
        maxPreset: s.maxSizeMB ? 'custom' : '0', maxSizeMB: s.maxSizeMB || 10,
      },
    });
    player.gotoFrame(s.segments[0].start);
  }, entry.id);
});

// ---------- actions (boutons data-act et raccourcis) ----------

const A = {
  play: player.togglePlay,
  stepBack: () => player.step(-player.stepSize()),
  stepFwd: () => player.step(player.stepSize()),
  stepBack10: () => player.step(-10),
  stepFwd10: () => player.step(10),
  setIn: () => player.setIn(),
  setOut: () => player.setOut(),
  nudgeInBack: () => player.nudge('in', -1),
  nudgeInFwd: () => player.nudge('in', 1),
  nudgeOutBack: () => player.nudge('out', -1),
  nudgeOutFwd: () => player.nudge('out', 1),
  playSel: () => { const [a, b] = player.selRange(); player.playRange(a, b); },
  playTail: () => { const [a, b] = player.selRange(); player.playRange(Math.max(a, b - Math.round(ctx.fps * 2)), b); },
  goIn: () => { player.video.pause(); player.gotoFrame(player.selRange()[0]); },
  goOut: () => { player.video.pause(); player.gotoFrame(player.selRange()[1]); },
  prevCut: () => timeline.jumpCut(-1),
  nextCut: () => timeline.jumpCut(1),
  marker: () => timeline.addMarker(),
  addSegment: panels.addSegment,
  addClip: series.addSelection,
  still: exp.saveStill,
  goto: player.gotoPrompt,
  fit: timeline.fitSelection,
  mute: player.toggleMute,
  fullscreen: player.toggleFullscreen,
  preview: exp.previewFrame,
  estimate: exp.estimate,
  export: exp.exportNow,
  copyFrame: exp.copyFrame,
  undo,
  redo,
  help: () => openDialog('helpDlg'),
  newTab: newTabAction,
  closeTab: () => closeTab(active),
  reopenTab,
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
};
const ANYTIME = ['undo', 'redo', 'help', 'newTab', 'closeTab', 'reopenTab', 'nextTab', 'prevTab'];
const TAB_ACTIONS = ANYTIME.slice(3);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && A[b.dataset.act] && ctx.source) A[b.dataset.act]();
});
// Menu du clic droit sur la frise et la vidéo (ses boutons passent par data-act).
const menu = $('ctxMenu');
const closeMenu = () => { menu.hidden = true; };
for (const el of [$('timeline'), $('viewport')]) {
  el.addEventListener('contextmenu', (e) => {
    if (!ctx.source) return;
    e.preventDefault();
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8))}px`;
    menu.querySelector('button').focus();
  });
}
document.addEventListener('click', closeMenu);
window.addEventListener('blur', closeMenu);
document.addEventListener('scroll', closeMenu, true);
menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(); $('timeline').focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return;
  const action = actionFor(event);
  if (!action || !acceptsShortcut(event, action)) return;
  if (event.target.closest('input, textarea, select, [contenteditable]') && action !== 'export' && !TAB_ACTIONS.includes(action)) return;
  if (event.target.closest('button, summary, a, [role="slider"]') && [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && action !== 'export') return;
  if (!ctx.source && !ANYTIME.includes(action)) return;
  event.preventDefault();
  if (action === 'export' && event.target.matches('#startFrame, #endFrame')) event.target.dispatchEvent(new Event('change'));
  A[action]();
});

// Déplacement de la vue zoomée : bouton du milieu, ou Espace + glisser.
let panning = null;
let spaceDown = false;
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.target.closest('button, input, textarea, select, [role="slider"]')) spaceDown = true; });
document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
$('viewport').addEventListener('pointerdown', (e) => {
  if (player.getZoom() > 1 && (e.button === 1 || (spaceDown && e.button === 0))) {
    e.preventDefault();
    e.stopPropagation();
    panning = { x: e.clientX, y: e.clientY };
    $('viewport').setPointerCapture(e.pointerId);
  }
}, true);
$('viewport').addEventListener('pointermove', (e) => {
  if (!panning) return;
  player.panBy(e.clientX - panning.x, e.clientY - panning.y);
  panning = { x: e.clientX, y: e.clientY };
});
$('viewport').addEventListener('pointerup', () => { panning = null; });

listen('frame', () => player.renderSelection());

// ---------- démarrage ----------

(async () => {
  await settings.loadSettings();
  await Promise.all([panels.loadPresets(), panels.loadFonts()]);
  panels.renderAll();
  sources.renderRecent();
  sources.renderRecentProjects();
  exp.refreshQueue();
  settings.checkHealth().then(settings.welcome);
  setTimeout(() => settings.checkUpdate(false), 3000);
  await restoreSession();
  // Appli Electron : fichier passé en argument ou « Ouvrir avec ChaosClip ».
  if (native) native.onOpen((p) => sources.loadInput(p));
  // Appli Android : lien ou vidéo partagés vers ChaosClip depuis une autre appli, au lancement ou plus tard.
  if (android) {
    const take = () => {
      const url = android.takeShared();
      if (!url) return;
      if (/^https?:/.test(url)) $('sourceInput').value = url; // une vidéo reçue arrive en chemin de fichier, sans intérêt à l'écran
      sources.loadInput(url);
    };
    window.addEventListener('chaosclip-share', take);
    take();
    // Bouton Retour du téléphone (MainActivity.onBackPressed) : ferme ce qui est ouvert, sinon rend false.
    window.chaosclipBack = () => {
      const dialog = [...document.querySelectorAll('dialog[open]')].pop();
      if (dialog) dialog.close();
      else if (document.querySelector('.menu-list:not([hidden])')) document.body.click(); // les menus se ferment déjà au clic ailleurs
      else if (!$('urlCard').hidden) $('urlCancel').click();
      else return false;
      return true;
    };
  }
})();

window.addEventListener('beforeunload', (e) => {
  if (!native && ctx.source && state.undoStack.length) e.preventDefault();
});
