// Outils communs : requêtes, tâches, messages, petites fenêtres.
import { t } from './i18n.js';
import { onceWhileActive } from './action-lock.mjs';

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
  if (!r.ok) throw Object.assign(new Error(data.error || `Erreur ${r.status}`), { status: r.status });
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

// « encore ~40 s » d'après l'avancement et le temps écoulé (rien tant que l'estimation est peu fiable).
export function etaText(job) {
  const p = job.progress;
  const elapsed = (Date.now() - job.started) / 1000;
  if (job.status !== 'running' || !(p >= 0.03 && p < 1) || !(elapsed > 2)) return '';
  const left = Math.round((elapsed * (1 - p)) / p);
  return t('encore ~{d}', { d: left < 60 ? `${Math.max(1, left)} s` : `${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')}` });
}

// Avancement global (moyenne des tâches en cours) : titre de la fenêtre et barre des tâches Windows.
const running = new Map();
const baseTitle = () => document.title.replace(/^\d+ % · /, '');
function reportProgress() {
  const values = [...running.values()];
  const p = values.length ? values.reduce((a, b) => a + b, 0) / values.length : -1;
  document.title = p >= 0 ? `${Math.round(p * 100)} % · ${baseTitle()}` : baseTitle();
  native?.progress?.(p >= 0 ? Math.max(0.01, p) : -1);
}

// ---------- barre d'état ----------

const dialogAnnouncements = new WeakMap();
let activityCount = 0;
function activityAnnouncer(host) {
  const dialog = host.closest('dialog');
  if (!dialog) return $('activityAnnouncements');
  if (!dialogAnnouncements.has(dialog)) {
    const region = document.createElement('div');
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-atomic', 'true');
    dialog.append(region);
    dialogAnnouncements.set(dialog, region);
  }
  return dialogAnnouncements.get(dialog);
}

export function beginActivity(label, host = $('status')) {
  const announcements = activityAnnouncer(host);
  const row = document.createElement('div');
  row.className = 'activity';
  row.innerHTML = '<span class="spinner" aria-hidden="true" hidden></span><span class="activity-label"></span><small hidden></small><progress max="1" hidden></progress><button type="button" class="ghost small" hidden></button>';
  const [spinner, title, step, progress, cancel] = row.children;
  cancel.textContent = t('Annuler');
  title.textContent = label;
  title.id = `activity-${++activityCount}`;
  cancel.setAttribute('aria-describedby', title.id);
  progress.setAttribute('aria-label', label);
  let jobId = null;
  let phase = '';
  let measured = false;
  let delayed = false;
  let cancelling = false;

  function announce(text) {
    if (announcements) announcements.textContent = text;
  }

  const timer = setTimeout(() => {
    delayed = true;
    spinner.hidden = measured || phase === 'queued';
  }, 200);
  host.hidden = false;
  host.append(row);
  announce(label);

  cancel.addEventListener('click', async () => {
    if (!jobId || cancelling) return;
    cancelling = true;
    cancel.setAttribute('aria-disabled', 'true');
    try { await api(`/api/job/${jobId}/cancel`, {}); }
    catch (error) { cancelling = false; cancel.removeAttribute('aria-disabled'); fail(error); }
  });

  return {
    update(job, nextLabel = label) {
      if (jobId !== job.id) {
        cancelling = false;
        cancel.removeAttribute('aria-disabled');
      }
      jobId = job.id;
      const current = job.status;
      const active = current === 'queued' || current === 'running';
      title.textContent = job.message ? `${nextLabel} · ${job.message}` : nextLabel;
      if (active && phase !== current) announce(`${nextLabel} · ${t(current === 'queued' ? 'En attente' : 'En cours')}`);
      phase = current;
      measured = current === 'running' && Number.isFinite(job.progress) && job.progress > 0;
      spinner.hidden = !delayed || !active || measured || current === 'queued';
      progress.hidden = !measured;
      progress.value = measured ? job.progress : 0;
      progress.setAttribute('aria-label', nextLabel);
      step.textContent = measured ? [`${Math.round(job.progress * 100)} %`, etaText(job)].filter(Boolean).join(' · ') : current === 'queued' ? t('En attente') : '';
      step.hidden = !step.textContent;
      cancel.hidden = !active;
      if (active) running.set(row, measured ? job.progress : 0);
      else running.delete(row);
      reportProgress();
    },
    text(text) { title.textContent = text; },
    wait(id, nextLabel = label) { return waitJob(id, nextLabel, { activity: this }); },
    finish(error, fallback) {
      clearTimeout(timer);
      if (running.delete(row)) reportProgress();
      announce(error ? `${label} · ${error.cancelled ? t('Annulé') : error.message || t('Erreur')}` : `${label} · ${t('Terminé')}`);
      const focus = row.contains(document.activeElement);
      if (focus) (fallback || host.closest('dialog')?.querySelector('[data-close]') || $('loadBtn'))?.focus();
      const remove = () => {
        row.remove();
        host.hidden = !host.children.length;
      };
      if (error && !error.cancelled && host.closest('dialog')) {
        title.textContent = error.message;
        row.classList.add('error');
        spinner.hidden = step.hidden = progress.hidden = cancel.hidden = true;
        setTimeout(remove, 6000);
      } else remove();
    },
  };
}

const runExclusive = onceWhileActive();

export function runAction(key, label, run, { host, controls = [], returnFocus = controls[0] } = {}) {
  return runExclusive(key, async () => {
    const activity = beginActivity(label, host);
    for (const control of controls) {
      control.setAttribute('aria-disabled', 'true');
      control.setAttribute('aria-busy', 'true');
    }
    let failure;
    try { return await run(activity); }
    catch (error) {
      failure = error;
      fail(error);
    } finally {
      for (const control of controls) {
        control.removeAttribute('aria-disabled');
        control.removeAttribute('aria-busy');
      }
      activity.finish(failure, returnFocus);
    }
  });
}

export async function waitJob(jobId, label, { silent = false, onProgress, activity } = {}) {
  const own = !activity && !silent ? beginActivity(label) : null;
  let failure;
  let attempts = 0;
  try {
    for (;;) {
      let j;
      try {
        j = await api(`/api/job/${jobId}`);
        attempts = 0;
      } catch (error) {
        if ((error.status && error.status < 500) || ++attempts >= 3) throw error;
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      (activity || own)?.update(j, label);
      if (onProgress) onProgress(j);
      if (j.status === 'done') return j.result;
      if (j.status === 'error' || j.status === 'cancelled') {
        const error = new Error(j.status === 'cancelled' ? t('Annulé') : j.error);
        error.cancelled = j.status === 'cancelled';
        throw error;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (error) { failure = error; throw error; }
  finally { own?.finish(failure); }
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
  if (d.open) return d;
  const opener = document.activeElement;
  d.showModal();
  d.addEventListener('close', () => {
    if (opener?.isConnected && !opener.closest('[hidden]') && document.activeElement === document.body) opener.focus();
  }, { once: true });
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

function setMenu(trigger, open) {
  trigger.setAttribute('aria-expanded', String(open));
  $(trigger.dataset.menu).hidden = !open;
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-menu]');
  for (const button of $$('[data-menu]')) {
    const open = button.getAttribute('aria-expanded') === 'true';
    setMenu(button, button === trigger && !open);
    if (open && $(button.dataset.menu).contains(event.target) && !document.querySelector('dialog[open]')) button.focus();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  const trigger = document.querySelector('[data-menu][aria-expanded=true]');
  if (!trigger) return;
  event.preventDefault();
  setMenu(trigger, false);
  trigger.focus();
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
