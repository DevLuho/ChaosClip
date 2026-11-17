// Contexte partagé entre les modules : source ouverte et état de lecture.
export const ctx = {
  source: null, // { id, name, path, info: { width, height, fps, duration, … }, … }
  scenes: [],
  appSettings: {},
  get fps() { return this.source ? this.source.info.fps : 24; },
  get lastFrame() { return this.source ? Math.max(0, Math.round(this.source.info.duration * this.source.info.fps) - 1) : 0; },
};

// Petit bus d'évènements entre modules (source chargée, image affichée…).
const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const listen = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
