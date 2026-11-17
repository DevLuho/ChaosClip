// État du montage (sélection, recadrage, textes, réglages), annuler/rétablir et liaison des champs.
import { $$ } from './util.js';

export const DEFAULT_OPTS = {
  format: 'gif', width: 480, fps: 15, speed: 1, loop: 0, pingpong: false, reverse: false, crossfade: 0,
  audio: false, audioTrack: 0, rotate: 0, flipH: false, flipV: false, zoom: 1,
  filters: {
    brightness: 0, contrast: 1, saturation: 1, gamma: 1, sharpen: 0, denoise: 0,
    grayscale: false, sepia: false, deinterlace: false, fadeIn: 0, fadeOut: 0, interpolate: false,
  },
  colors: 256, dither: 'sierra2_4a', bayerScale: 3, lossy: 0, quality: 75, hw: true,
  maxPreset: '0', maxSizeMB: 10, sacrificeFirst: 'width', sheet: { cols: 5, rows: 0 },
  subsOffset: 0, logoPosition: 'br', logoSize: 15, logoOpacity: 100, transparentSimilarity: 0.15,
};
export const QUALITY_DEFAULT = { webp: 75, avif: 35, mp4: 20, webm: 30, apng: 75, gif: 75 };

const clone = (o) => JSON.parse(JSON.stringify(o));

function freshDoc() {
  let opts = clone(DEFAULT_OPTS);
  try {
    const saved = JSON.parse(localStorage.getItem('chaosclip.opts') || 'null');
    if (saved) opts = deepMerge(opts, saved);
  } catch { /* réglages illisibles : défaut */ }
  return {
    sel: { start: 0, end: 0 }, segments: [], crop: null, cropKeys: [], blurZones: [],
    texts: [], markers: [], subs: null, logo: null, transparent: null, opts,
  };
}

export function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

export const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export function setPath(o, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  const target = ks.reduce((a, k) => (a[k] ??= {}), o);
  target[last] = v;
}

export const state = {
  doc: freshDoc(),
  undoStack: [],
  redoStack: [],
  listeners: new Set(),
  lastKey: null,
  lastTime: 0,
};

export const on = (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn); };
const emit = (why) => state.listeners.forEach((fn) => fn(why));

// Modifie l'état. coalesce : les modifications rapprochées d'un même champ ne font qu'une étape d'annulation.
export function update(mutator, { coalesce = null, undoable = true, why = 'change' } = {}) {
  const now = Date.now();
  if (undoable && !(coalesce && coalesce === state.lastKey && now - state.lastTime < 800)) {
    state.undoStack.push(JSON.stringify(state.doc));
    if (state.undoStack.length > 200) state.undoStack.shift();
    state.redoStack = [];
  }
  state.lastKey = coalesce;
  state.lastTime = now;
  mutator(state.doc);
  persist();
  emit(why);
}

export function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.undoStack.pop());
  state.lastKey = null;
  persist();
  emit('undo');
}
export function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.redoStack.pop());
  state.lastKey = null;
  persist();
  emit('undo');
}

// Nouvelle vidéo : on garde les réglages, on oublie le montage.
export function resetDoc(keepOpts = true) {
  const opts = keepOpts ? state.doc.opts : clone(DEFAULT_OPTS);
  state.doc = { ...freshDoc(), opts };
  state.undoStack = [];
  state.redoStack = [];
  emit('load');
}

export function replaceDoc(doc) {
  state.undoStack.push(JSON.stringify(state.doc));
  state.doc = deepMerge(freshDoc(), doc);
  persist();
  emit('load');
}

function persist() {
  try { localStorage.setItem('chaosclip.opts', JSON.stringify(state.doc.opts)); } catch { /* ignoré */ }
}

// ---------- liaison des champs data-bind="opts.width" ----------

function readInput(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'radio') return el.value;
  if (el.type === 'number' || el.type === 'range' || el.dataset.type === 'number') {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : 0;
  }
  return el.value;
}

export function bindInputs(root = document) {
  $$('[data-bind]', root).forEach((el) => {
    const evt = el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (el.type === 'radio' && !el.checked) return;
      const p = el.dataset.bind;
      update((d) => {
        const value = readInput(el);
        if (p === 'opts.format' && value !== d.opts.format) {
          d.opts.qualityByFormat ||= {};
          d.opts.qualityByFormat[d.opts.format] = d.opts.quality;
          d.opts.quality = d.opts.qualityByFormat[value] ?? QUALITY_DEFAULT[value] ?? 75;
        }
        setPath(d, p, value);
      }, { coalesce: p });
    });
  });
}

export function renderInputs(root = document) {
  $$('[data-bind]', root).forEach((el) => {
    const v = getPath(state.doc, el.dataset.bind);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (document.activeElement !== el || el.tagName === 'SELECT') el.value = v ?? '';
  });
  $$('[data-show]', root).forEach((el) => {
    const v = getPath(state.doc, el.dataset.show);
    el.textContent = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v;
  });
}

// ---------- conversion vers le format attendu par le serveur ----------

export function maxSizeMB(o = state.doc.opts) {
  return o.maxPreset === 'custom' ? Number(o.maxSizeMB) || 0 : Number(o.maxPreset) || 0;
}

export function toServer(doc = state.doc, overrides = {}) {
  const o = doc.opts;
  const sel = doc.sel;
  const order = [o.sacrificeFirst, ...['width', 'fps', 'quality'].filter((k) => k !== o.sacrificeFirst)];
  return {
    format: o.format,
    segments: doc.segments.length ? doc.segments : [{ start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) }],
    crop: doc.crop,
    cropKeys: doc.cropKeys,
    blurZones: doc.blurZones,
    rotate: o.rotate, flipH: o.flipH, flipV: o.flipV,
    width: o.width, fps: o.fps, speed: o.speed, loop: o.loop, pingpong: o.pingpong, reverse: o.reverse,
    crossfade: o.crossfade, zoom: o.zoom, filters: o.filters,
    texts: doc.texts,
    subs: doc.subs ? { ...doc.subs, offset: o.subsOffset } : null,
    logo: doc.logo ? { file: doc.logo.file, animated: doc.logo.animated, position: o.logoPosition, size: o.logoSize, opacity: o.logoOpacity } : null,
    transparent: doc.transparent ? { color: doc.transparent, similarity: o.transparentSimilarity } : null,
    colors: o.colors, dither: o.dither, bayerScale: o.bayerScale, lossy: o.lossy, quality: o.quality,
    audio: o.audio, audioTrack: o.audioTrack, hw: o.hw, sheet: o.sheet,
    maxSizeMB: maxSizeMB(o), sacrifice: order,
    ...overrides,
  };
}
