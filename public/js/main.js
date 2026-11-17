// Point d'entrée : relie les modules, les actions et les raccourcis.
import { $, api, esc, fail, toast, native, openDialog, confirmAsk } from './util.js';
import { t, translateDom } from './i18n.js';
import { ctx, emit, listen } from './ctx.js';
import { state, on, update, undo, redo, resetDoc, replaceDoc, bindInputs } from './state.js';
import * as player from './player.js';
import * as timeline from './timeline.js';
import * as overlay from './overlay.js';
import * as panels from './panels.js';
import { actionFor } from './keys.js';
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

function keepTab() {
  const tb = tabs[active];
  if (tb && ctx.source) Object.assign(tb, { source: ctx.source, doc: structuredClone(state.doc), undo: state.undoStack, redo: state.redoStack, frame: player.shownFrame(), name: $('exportName').value });
}
function renderTabs() {
  $('tabs').hidden = !tabs.length;
  $('tabList').innerHTML = tabs.map((tb, i) => `<span class="tab${i === active ? ' active' : ''}"><button type="button" data-tab="${i}" title="${esc(tb.source?.name || '')}"${i === active ? ' aria-current="true"' : ''}>${esc(tb.source?.name || t('Nouvel onglet'))}</button><button type="button" data-tab-close="${i}" aria-label="${esc(t('Fermer l’onglet'))}">✕</button></span>`).join('');
}
function showEmpty() {
  ctx.source = null;
  player.video.pause();
  player.video.removeAttribute('src');
  player.video.load();
  $('stage').hidden = true;
  $('empty').hidden = false;
  $('result').hidden = true;
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
    player.video.addEventListener('loadedmetadata', () => player.gotoFrame(tb.frame), { once: true });
  }, true);
}
$('tabs').addEventListener('click', async (e) => {
  const close = e.target.closest('[data-tab-close]');
  const tab = e.target.closest('[data-tab]');
  if (e.target.closest('#tabNew')) return goTab(tabs.push({}) - 1);
  if (tab && Number(tab.dataset.tab) !== active) return goTab(Number(tab.dataset.tab));
  if (!close) return;
  const closing = tabs[Number(close.dataset.tabClose)];
  if (closing.source && !(await confirmAsk(t('Fermer « {name} » ? Les réglages de cet onglet seront perdus.', { name: closing.source.name }), t('Fermer l’onglet')))) return;
  const i = tabs.indexOf(closing);
  tabs.splice(i, 1);
  if (i < active) active--;
  else if (i === active) { active = -1; if (tabs.length) return goTab(Math.min(i, tabs.length - 1)); showEmpty(); }
  renderTabs();
});

// Une nouvelle source s'ouvre dans son propre onglet (ou remplit l'onglet vide affiché).
function onSource(src, after) {
  if (!src.info.width && src.info.vcodec === 'webp') return sources.openAnimatedWebp(src);
  keepTab();
  if (!tabs[active] || tabs[active].source) { tabs.push({}); active = tabs.length - 1; }
  tabs[active].source = src;
  showSource(src, after);
  renderTabs();
}

function showSource(src, after, quiet) {
  ctx.source = src;
  $('urlCard').hidden = true;
  $('exportName').value = '';
  resetDoc(true);
  const f0 = 0;
  update((d) => { d.sel = { start: f0, end: ctx.frameAt(3) }; }, { undoable: false, why: 'load' });
  player.loadVideo(src);
  panels.renderAudioTracks();
  emit('source', src);
  exp.setEnabled(true);
  $('result').hidden = true;
  $('preview').hidden = true;
  document.title = `${src.name} · ChaosClip`;
  if (after) after();
  exp.restoreResults(src.id);
  panels.renderAll();
  timeline.render();
  if (!quiet) toast(t('Chargé : {name}', { name: src.name }), 'ok', 3000);
}
sources.setOnSource(onSource);
series.connectEditor(onSource);

// « Refaire » depuis l'historique : recharge la vidéo et les réglages de l'export.
exp.setApplySettings(async (entry) => {
  const r = await api('/api/source', { input: entry.source.path, historyId: entry.id });
  const s = entry.settings;
  onSource(r.source, () => {
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
  });
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
  still: saveStill,
  goto: player.gotoPrompt,
  fit: timeline.fitSelection,
  mute: player.toggleMute,
  fullscreen: player.toggleFullscreen,
  preview: exp.previewFrame,
  estimate: exp.estimate,
  export: exp.exportNow,
  undo,
  redo,
  help: () => openDialog('helpDlg'),
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && A[b.dataset.act] && ctx.source) A[b.dataset.act]();
});
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio';
  const act = actionFor(e);
  if (!act) return;
  // Annuler / rétablir restent ceux du champ pendant la saisie.
  if (typing && !['export'].includes(act)) return;
  if (!ctx.source && !['undo', 'redo', 'help'].includes(act)) return;
  e.preventDefault();
  A[act]();
});

// Image PNG en pleine résolution, avec recadrage et effets.
async function saveStill() {
  try {
    const { toServer } = await import('./state.js');
    const f = player.shownFrame();
    const r = await api(`/api/export/${ctx.source.id}`, { settings: toServer(state.doc, { format: 'png', segments: [{ start: f, end: f }], maxSizeMB: 0, width: 0 }) });
    const { waitJob } = await import('./util.js');
    exp.showResult(await waitJob(r.job, t('Image')));
  } catch (e) { fail(e); }
}

// Déplacement de la vue zoomée : bouton du milieu, ou Espace + glisser.
let panning = null;
let spaceDown = false;
document.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceDown = true; });
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
  exp.refreshQueue();
  settings.checkHealth();
  setTimeout(() => settings.checkUpdate(false), 3000);
  // Appli Electron : fichier passé en argument ou « Ouvrir avec ChaosClip ».
  if (native) native.onOpen((p) => sources.loadInput(p));
  $('empty').focus();
})();

window.addEventListener('beforeunload', (e) => {
  if (!native && ctx.source && state.undoStack.length) e.preventDefault();
});
