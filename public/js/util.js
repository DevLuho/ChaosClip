// Outils communs : requêtes, tâches, messages, petites fenêtres.
import { t } from './i18n.js';

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`);
export const fmtTime = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
// « 1:02:03.5 », « 12:34 », « 75.5 » → secondes (null si illisible).
export function parseTime(str) {
  const s = String(str || '').trim().replace(',', '.');
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((a, p) => a * 60 + p, 0);
}

export async function api(url, body, method) {
  const opts = { headers: {} };
  if (body !== undefined || (method && method !== 'GET')) {
    opts.method = method || 'POST';
    opts.headers = { 'Content-Type': 'application/json', 'X-ChaosClip': '1' };
    opts.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

export async function uploadRaw(url, blob, name) {
  const sep = url.includes('?') ? '&' : '?';
  const r = await fetch(`${url}${sep}name=${encodeURIComponent(name || blob.name || 'fichier')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-ChaosClip': '1' }, body: blob,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

// ---------- barre d'état ----------

let statusJob = null;
export function status(text, progress, jobId) {
  $('status').hidden = !text;
  $('statusText').textContent = text || '';
  $('statusBar').style.width = `${Math.round((progress || 0) * 100)}%`;
  statusJob = jobId || null;
  $('statusCancel').hidden = !statusJob;
}
$('statusCancel').addEventListener('click', () => statusJob && api(`/api/job/${statusJob}/cancel`, {}));

// Attend la fin d'une tâche. silent : pas de barre d'état (aperçus en direct).
export async function waitJob(jobId, label, { silent = false, onProgress } = {}) {
  for (;;) {
    const j = await api(`/api/job/${jobId}`);
    if (!silent) status(`${label}${j.message ? ` · ${j.message}` : ''}`, j.progress, j.status === 'running' || j.status === 'queued' ? jobId : null);
    if (onProgress) onProgress(j);
    if (j.status === 'done') { if (!silent) status(''); return j.result; }
    if (j.status === 'error' || j.status === 'cancelled') {
      if (!silent) status('');
      const e = new Error(j.status === 'cancelled' ? t('Annulé') : j.error);
      e.cancelled = j.status === 'cancelled';
      throw e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------- messages ----------

export function toast(msg, kind = '', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

export function fail(e) {
  if (e && e.cancelled) return toast(t('Annulé'));
  console.error(e);
  toast(e.message || String(e), 'error', 9000);
}

// ---------- fenêtres ----------

export function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
  d.dispatchEvent(new Event('opened'));
  return d;
}
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-dialog]');
  if (opener) { openDialog(opener.dataset.dialog); return; }
  const closer = e.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close();
  // Clic sur le fond : ferme.
  if (e.target.tagName === 'DIALOG' && e.target.classList.contains('dlg')) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
  }
});

export function ask(label, value = '') {
  return new Promise((resolve) => {
    const d = $('promptDlg');
    $('promptLabel').textContent = label;
    $('promptInput').value = value;
    d.returnValue = '';
    d.showModal();
    $('promptInput').select();
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? $('promptInput').value : null), { once: true });
  });
}

export function confirmAsk(text, okLabel) {
  return new Promise((resolve) => {
    const d = $('confirmDlg');
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okLabel;
    d.returnValue = '';
    d.showModal();
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
  });
}

// Menus déroulants simples.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-menu]');
  $$('.menu-list').forEach((m) => { if (!b || m.id !== b.dataset.menu) m.hidden = true; });
  if (b) $(b.dataset.menu).hidden = !$(b.dataset.menu).hidden;
});

// Petit son de fin (sans fichier).
export function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch { /* pas de son disponible */ }
}

export const debounce = (fn, ms) => {
  let t0;
  return (...a) => { clearTimeout(t0); t0 = setTimeout(() => fn(...a), ms); };
};

// Pont vers l'appli Electron (absent dans un navigateur).
export const native = window.chaosclip || null;
