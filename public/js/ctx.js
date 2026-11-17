// Contexte partagé entre les modules : source ouverte et état de lecture.
export const ctx = {
  source: null, // { id, name, path, info: { width, height, fps, duration, … }, … }
  scenes: [],
  appSettings: {},
  get fps() { return this.source ? this.source.info.fps : 24; },
  get lastFrame() { return this.source ? Math.max(0, (this.source.info.frameTimes?.length ?? Math.round(this.source.info.duration * this.fps)) - 1) : 0; },
  frameTime(index) {
    const info = this.source?.info;
    if (!info?.frameTimes) return index / this.fps;
    return info.frameTimes[index] ?? Math.max(info.duration, info.frameTimes.at(-1) + 1 / this.fps);
  },
  frameAt(seconds) {
    const frames = this.source?.info.frameTimes;
    if (!frames) return Math.max(0, Math.min(this.lastFrame, Math.floor(seconds * this.fps + 1e-4)));
    let low = 0;
    let high = frames.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (frames[mid] <= seconds + 1e-5) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  },
};

// Petit bus d'évènements entre modules (source chargée, image affichée…).
const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const listen = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
