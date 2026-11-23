// Raccourcis clavier personnalisables.
import { $, esc } from './util.js';
import { t } from './i18n.js';

export const ACTIONS = {
  play: ['Lecture / pause', ['Space', 'k']],
  stepBack: ['Image précédente (selon le pas)', ['ArrowLeft', 'j']],
  stepFwd: ['Image suivante (selon le pas)', ['ArrowRight', 'l']],
  stepBack10: ['10 images en arrière', ['Shift+ArrowLeft']],
  stepFwd10: ['10 images en avant', ['Shift+ArrowRight']],
  setIn: ['Début de la sélection ici', ['i']],
  setOut: ['Fin de la sélection ici', ['o']],
  nudgeInBack: ['Début −1 image', ['Alt+ArrowLeft']],
  nudgeInFwd: ['Début +1 image', ['Alt+ArrowRight']],
  nudgeOutBack: ['Fin −1 image', ['Ctrl+ArrowLeft']],
  nudgeOutFwd: ['Fin +1 image', ['Ctrl+ArrowRight']],
  playSel: ['Lire la sélection', ['p']],
  goIn: ['Aller au début de la sélection', ['Home']],
  goOut: ['Aller à la fin de la sélection', ['End']],
  prevCut: ['Plan ou marqueur précédent', ['PageUp']],
  nextCut: ['Plan ou marqueur suivant', ['PageDown']],
  marker: ['Ajouter un marqueur', ['m']],
  addSegment: ['Ajouter la sélection aux segments', ['n']],
  addClip: ['Ajouter un extrait', ['Shift+Enter']],
  still: ['Enregistrer l’image en PNG', ['s']],
  copyFrame: ['Copier l’image dans le presse-papiers', ['c']],
  copyResult: ['Copier le dernier export', ['Ctrl+Shift+c']],
  goto: ['Aller à une image ou un temps', ['g']],
  fit: ['Cadrer la frise sur la sélection', ['z']],
  mute: ['Couper le son', ['u']],
  fullscreen: ['Plein écran', ['f']],
  preview: ['Aperçu de l’image', ['a']],
  estimate: ['Aperçu et poids', ['e']],
  export: ['Exporter', ['Ctrl+Enter']],
  undo: ['Annuler la dernière action', ['Ctrl+z']],
  redo: ['Rétablir', ['Ctrl+y', 'Ctrl+Shift+z']],
  help: ['Aide-mémoire', ['?']],
  newTab: ['Nouvel onglet', ['Ctrl+t']],
  closeTab: ['Fermer l’onglet', ['Ctrl+w']],
  reopenTab: ['Rouvrir l’onglet fermé', ['Ctrl+Shift+t']],
  nextTab: ['Onglet suivant', ['Ctrl+Tab']],
  prevTab: ['Onglet précédent', ['Ctrl+Shift+Tab']],
};

let map = {};
function load() {
  map = Object.fromEntries(Object.entries(ACTIONS).map(([k, [, def]]) => [k, [...def]]));
  try {
    const saved = JSON.parse(localStorage.getItem('chaosclip.keys') || '{}');
    for (const [k, v] of Object.entries(saved)) if (map[k] && Array.isArray(v)) map[k] = v;
  } catch { /* ignoré */ }
}
load();
const save = () => { try { localStorage.setItem('chaosclip.keys', JSON.stringify(map)); } catch { /* ignoré */ } };

export function combo(e) {
  let key = e.key === ' ' ? 'Space' : e.key;
  const printable = key.length === 1;
  if (printable) key = key.toLowerCase();
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && (!printable || e.ctrlKey || e.metaKey)) mods.push('Shift');
  return [...mods, key].join('+');
}

export function actionFor(e) {
  const c = combo(e);
  return Object.keys(map).find((k) => map[k].includes(c)) || null;
}

const pretty = (c) => c.split('+').map((k) => `<kbd>${esc({ ArrowLeft: '←', ArrowRight: '→', Space: t('Espace'), PageUp: 'Pg↑', PageDown: 'Pg↓', Home: t('Début'), End: t('Fin'), Enter: '↵' }[k] || k.toUpperCase())}</kbd>`).join('+');

export function renderHelp() {
  $('helpTable').innerHTML = Object.entries(ACTIONS).map(([k, [label]]) => `<tr><td>${esc(t(label))}</td><td>${map[k].map(pretty).join(' ')}</td></tr>`).join('');
}

// Fenêtre d'édition : clic sur une touche puis appui sur la nouvelle combinaison.
let waiting = null;
export function renderKeys() {
  $('keysTable').innerHTML = Object.entries(ACTIONS).map(([k, [label]]) =>
    `<tr><td>${esc(t(label))}</td><td><button type="button" data-key="${k}">${waiting === k ? t('Appuie…') : map[k].map(pretty).join(' ') || '—'}</button></td></tr>`).join('');
}
$('keysTable').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (!b) return;
  waiting = b.dataset.key;
  renderKeys();
});
document.addEventListener('keydown', (e) => {
  if (!waiting) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key !== 'Escape' && !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    const c = combo(e);
    // Une combinaison ne sert qu'à une action.
    for (const k of Object.keys(map)) map[k] = map[k].filter((x) => x !== c);
    map[waiting] = [c];
    save();
  }
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) { waiting = null; renderKeys(); renderHelp(); }
}, true);
$('keysReset').addEventListener('click', () => {
  try { localStorage.removeItem('chaosclip.keys'); } catch { /* ignoré */ }
  load();
  renderKeys();
  renderHelp();
});
$('keysDlg').addEventListener('opened', renderKeys);
// Fenêtre fermée pendant « Appuie… » : la touche suivante ne doit pas être prise pour un nouveau raccourci.
$('keysDlg').addEventListener('close', () => { waiting = null; });
$('helpDlg').addEventListener('opened', renderHelp);
