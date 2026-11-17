// Export : estimation (manuelle ou en direct), aperçus, comparaison, file d'attente, historique, envoi.
import { $, $$, api, waitJob, fail, toast, fmtBytes, esc, debounce, beep, native, openDialog } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, toServer, maxSizeMB, replaceDoc } from './state.js';
import { shownFrame } from './player.js';

const discordLimit = () => Number(ctx.appSettings.discordLimit) || 10;

function sizeVerdict(bytes) {
  const max = maxSizeMB();
  const lim = discordLimit();
  const mb = bytes / 1048576;
  if (max && mb > max) return { cls: 'over', note: t('au-dessus du poids max : l’export réduira automatiquement') };
  if (mb > lim) return { cls: 'over', note: t('trop lourd pour Discord ({n} Mo)', { n: lim }) };
  return { cls: 'under', note: t('OK pour Discord ({n} Mo)', { n: lim }) };
}

function mediaTag(url, format) {
  if (['mp4', 'webm'].includes(format)) return `<video src="${url}" controls loop autoplay muted playsinline></video>`;
  if (format === 'mp3') return `<audio src="${url}" controls></audio>`;
  return `<img src="${url}" alt="">`;
}

export function setEnabled(on) {
  ['exportBtn', 'estimateBtn', 'previewBtn', 'compareBtn', 'queueBtn'].forEach((id) => { $(id).disabled = !on; });
}

// ---------- estimation ----------

let estimateJob = null;
async function runEstimate({ silent = false, show = true } = {}) {
  if (!ctx.source) return null;
  if (estimateJob) api(`/api/job/${estimateJob}/cancel`, {}).catch(() => {});
  $('estimate').className = 'estimate muted';
  $('estimate').textContent = t('Calcul…');
  try {
    const r = await api(`/api/estimate/${ctx.source.id}`, { settings: toServer() });
    estimateJob = r.job;
    const res = await waitJob(r.job, t('Aperçu'), { silent });
    estimateJob = null;
    const v = sizeVerdict(res.bytes);
    $('estimate').className = `estimate ${v.cls}`;
    $('estimate').textContent = `≈ ${fmtBytes(res.bytes)} · ${res.size.w}×${res.size.h} · ${res.duration.toFixed(2)} s · ${v.note}`;
    if (show) showPreview(t('Aperçu des 2 premières secondes'), mediaTag(res.sample, res.format), `${fmtBytes(res.sampleBytes)} ${t('pour l’extrait')}`);
    return res;
  } catch (e) {
    if (e.cancelled) return null;
    $('estimate').textContent = '—';
    if (!silent) fail(e); else $('estimate').textContent = `⚠ ${e.message.slice(0, 120)}`;
    return null;
  }
}
$('estimateBtn').addEventListener('click', () => runEstimate());
export const estimate = () => runEstimate();

const live = debounce(() => runEstimate({ silent: true, show: false }), 900);
listen('docchange', () => { if ($('liveEstimate').checked && ctx.source) live(); });
$('liveEstimate').addEventListener('change', (e) => {
  try { localStorage.setItem('chaosclip.live', e.target.checked ? '1' : ''); } catch { /* ignoré */ }
  if (e.target.checked) live();
});
try { $('liveEstimate').checked = localStorage.getItem('chaosclip.live') === '1'; } catch { /* ignoré */ }

// ---------- aperçu d'une image ----------

function showPreview(title, html, info) {
  $('preview').hidden = false;
  $('previewTitle').textContent = title;
  $('previewMedia').innerHTML = html;
  $('previewMedia').classList.add('checker');
  $('previewInfo').textContent = info || '';
}
$('previewClose').addEventListener('click', () => { $('preview').hidden = true; $('previewMedia').innerHTML = ''; });

export async function previewFrame() {
  if (!ctx.source) return;
  try {
    const r = await api(`/api/preview/${ctx.source.id}`, { settings: toServer(), frame: shownFrame() });
    const res = await waitJob(r.job, t('Aperçu'));
    showPreview(t('Rendu exact de l’image {n}', { n: shownFrame() }), `<img src="${res.url}" alt="">`);
  } catch (e) { fail(e); }
}
$('previewBtn').addEventListener('click', previewFrame);

// ---------- comparaison A / B ----------

let compareA = null;
$('compareBtn').addEventListener('click', () => {
  if (!compareA) compareA = JSON.parse(JSON.stringify(state.doc));
  openDialog('compareDlg');
});
$('cmpKeepA').addEventListener('click', () => { compareA = JSON.parse(JSON.stringify(state.doc)); toast(t('Réglages A gardés')); });
$('cmpUseA').addEventListener('click', () => { if (compareA) replaceDoc(compareA); $('compareDlg').close(); });
$('cmpRun').addEventListener('click', async () => {
  if (!compareA) compareA = JSON.parse(JSON.stringify(state.doc));
  const one = async (doc, el, info, label) => {
    $(el).innerHTML = `<p class="muted">${t('Calcul…')}</p>`;
    const r = await api(`/api/estimate/${ctx.source.id}`, { settings: toServer(doc) });
    const res = await waitJob(r.job, label, { silent: true });
    $(el).innerHTML = mediaTag(res.sample, res.format);
    const o = doc.opts;
    $(info).textContent = `${label} : ≈ ${fmtBytes(res.bytes)} · ${o.format.toUpperCase()} ${res.size.w}×${res.size.h} · ${o.fps || t('fps d’origine')} i/s${o.format === 'gif' ? ` · ${o.colors} ${t('couleurs')} · ${o.dither}${o.lossy ? ` · lossy ${o.lossy}` : ''}` : ` · q ${o.quality}`}`;
  };
  try {
    await Promise.all([one(compareA, 'cmpA', 'cmpAInfo', 'A'), one(state.doc, 'cmpB', 'cmpBInfo', 'B')]);
  } catch (e) { fail(e); }
});

// ---------- export et file d'attente ----------

const alsoFormats = () => $$('.alsoFmt:checked').map((c) => c.value).filter((f) => f !== state.doc.opts.format);

async function enqueue() {
  const jobs = [];
  for (const format of [state.doc.opts.format, ...alsoFormats()]) {
    const r = await api(`/api/export/${ctx.source.id}`, { settings: toServer(state.doc, { format }) });
    jobs.push(r.job);
  }
  refreshQueue();
  return jobs;
}

$('exportBtn').addEventListener('click', async () => {
  if (!ctx.source) return;
  try {
    const started = Date.now();
    const jobs = await enqueue();
    let last = null;
    for (const j of jobs) last = await waitJob(j, t('Export'));
    if (last) showResult(last);
    if (jobs.length > 1) toast(t('{n} exports terminés', { n: jobs.length }), 'ok');
    notifyDone(last, Date.now() - started);
  } catch (e) { fail(e); }
  refreshQueue();
});
$('queueBtn').addEventListener('click', async () => {
  if (!ctx.source) return;
  try {
    const jobs = await enqueue();
    toast(t('{n} export(s) ajouté(s) à la file', { n: jobs.length }), 'ok');
    watchQueue();
  } catch (e) { fail(e); }
});
export const exportNow = () => $('exportBtn').click();

function notifyDone(res, ms) {
  if (!res || !ctx.appSettings.notify || ms < 8000) return;
  beep();
  const body = `${res.file} · ${fmtBytes(res.bytes)}`;
  if (native) native.notify('ChaosClip', body);
  else if ('Notification' in window && Notification.permission === 'granted') new Notification(t('Export terminé'), { body, icon: 'icon.svg' });
}

// ---------- résultat ----------

let current = null;
export function showResult(res) {
  current = res;
  $('result').hidden = false;
  $('resultMedia').innerHTML = mediaTag(`${res.url}?v=${res.date}`, res.format);
  const last = res.attempts[res.attempts.length - 1];
  const v = sizeVerdict(res.bytes);
  let info = `${res.file} · ${fmtBytes(res.bytes)} · ${res.size.w}×${res.size.h}`;
  if (res.attempts.length > 1) info += ` · ${t('ajusté en {n} essais', { n: res.attempts.length })} (${last.width}px, ${Math.round(last.fps)} i/s${last.bitrateKbps ? `, ${last.bitrateKbps} kb/s` : ''}${last.lossy ? `, lossy ${last.lossy}` : ''})`;
  if (!res.fitsMax) info += ` · ⚠ ${t('toujours au-dessus du poids max : raccourcis la sélection ou baisse la taille')}`;
  $('resultInfo').innerHTML = `${esc(info)}<br><span class="${v.cls === 'over' ? 'error' : 'ok'}">● ${esc(v.note)}</span>`;
  $('resultLink').href = res.url;
  $('resultLink').download = res.file;
  $('webhookBtn').hidden = !(ctx.appSettings.webhooks || []).length;
  $('dragBtn').hidden = !native;
}
$('copyBtn').addEventListener('click', () => copyResult(current));
$('revealBtn').addEventListener('click', () => current && api(`/api/history/${current.id}/reveal`, {}).catch(fail));
$('webhookBtn').addEventListener('click', () => current && sendWebhook(current));
$('dragBtn').addEventListener('dragstart', (e) => {
  if (!current || !native) return;
  e.preventDefault();
  native.startDrag(current.path);
});

export async function copyResult(entry) {
  if (!entry) return;
  try {
    if (native?.copyFile) await native.copyFile(entry.path);
    else await api(`/api/history/${entry.id}/copy`, {});
    toast(t('Copié : colle-le dans Discord avec Ctrl+V'), 'ok');
  } catch (e) {
    // Repli : copie de l'image (fonctionne pour un PNG dans le navigateur).
    fail(e);
  }
}

export async function sendWebhook(entry) {
  const hooks = ctx.appSettings.webhooks || [];
  if (!hooks.length) return toast(t('Ajoute un webhook Discord dans les Réglages'), 'error');
  let index = 0;
  if (hooks.length > 1) {
    const { ask } = await import('./util.js');
    const names = hooks.map((h, i) => `${i + 1}. ${h.name}`).join('  ');
    const v = await ask(`${t('Salon')} : ${names}`, '1');
    if (v === null) return;
    index = Math.max(0, Math.min(hooks.length - 1, Number(v) - 1));
  }
  try {
    toast(t('Envoi vers Discord…'));
    await api(`/api/history/${entry.id}/webhook`, { index });
    toast(t('Envoyé dans {name}', { name: hooks[index].name }), 'ok');
  } catch (e) { fail(e); }
}

// ---------- fenêtre de la file ----------

let queueTimer = null;
export async function refreshQueue() {
  try {
    const { items } = await api('/api/queue');
    const active = items.filter((j) => ['running', 'queued'].includes(j.status));
    $('queueBadge').hidden = !active.length;
    $('queueBadge').textContent = active.length;
    $('queueList').innerHTML = items.length ? items.map((j) => `<li>
      <span class="grow">${j.kind === 'download' ? '⬇' : '⚙'} ${esc(j.label || j.kind)}</span>
      <span class="small ${j.status === 'error' ? 'error' : 'muted'}">${esc({ queued: t('en attente'), running: `${Math.round(j.progress * 100)} %`, done: t('terminé'), error: t('erreur'), cancelled: t('annulé') }[j.status])}${j.status === 'error' ? ` : ${esc(j.error.slice(0, 120))}` : ''}</span>
      ${['running', 'queued'].includes(j.status) ? `<button type="button" class="ghost small" data-qcancel="${j.id}">${t('Annuler')}</button>` : ''}
      ${j.status === 'done' && j.kind === 'export' ? `<button type="button" class="ghost small" data-qshow="${j.id}">${t('Voir')}</button>` : ''}
    </li>`).join('') : `<li class="muted">${t('Rien en cours')}</li>`;
    return active.length;
  } catch { return 0; }
}
function watchQueue() {
  clearInterval(queueTimer);
  queueTimer = setInterval(async () => { if (!(await refreshQueue())) clearInterval(queueTimer); }, 1000);
}
$('queueDlg').addEventListener('opened', () => { refreshQueue(); watchQueue(); });
$('queueList').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-qcancel]');
  const s = e.target.closest('[data-qshow]');
  if (c) { await api(`/api/job/${c.dataset.qcancel}/cancel`, {}); refreshQueue(); }
  if (s) {
    const j = await api(`/api/job/${s.dataset.qshow}`);
    showResult(j.result);
    $('queueDlg').close();
  }
});

// ---------- historique ----------

let applySettings = null; // fourni par main.js : recharge la source et les réglages d'un export
export const setApplySettings = (fn) => { applySettings = fn; };

async function renderHistory() {
  try {
    const { items } = await api('/api/history');
    $('historyList').innerHTML = items.length ? items.map((e) => `<div class="hist" data-h="${e.id}">
      <div class="thumb checker">${e.exists ? (['mp4', 'webm'].includes(e.format) ? `<video src="${e.url}" muted loop preload="metadata"></video>` : e.format === 'mp3' ? '♪' : `<img src="${e.url}" loading="lazy" alt="">`) : `<span class="muted">${t('fichier supprimé')}</span>`}</div>
      <div title="${esc(e.path)}"><strong>${esc(e.file)}</strong></div>
      <div class="muted">${fmtBytes(e.bytes)} · ${e.size.w}×${e.size.h} · ${new Date(e.date).toLocaleString()}</div>
      <div class="actions wrap">
        <button type="button" data-hact="redo" title="${t('Recharger la vidéo avec ces réglages')}">${t('Refaire')}</button>
        ${e.exists ? `<button type="button" data-hact="copy">${t('Copier')}</button><button type="button" data-hact="reveal">${t('Dossier')}</button>` : ''}
        ${e.exists && (ctx.appSettings.webhooks || []).length ? `<button type="button" data-hact="hook">Discord</button>` : ''}
        ${e.exists ? `<button type="button" data-hact="booru">Booru</button>` : ''}
        <button type="button" data-hact="del" title="${t('Retirer de l’historique (Maj : supprimer aussi le fichier)')}">✕</button>
      </div></div>`).join('') : `<p class="muted">${t('Aucun export pour l’instant.')}</p>`;
    $$('#historyList video').forEach((v) => {
      v.addEventListener('mouseenter', () => v.play().catch(() => {}));
      v.addEventListener('mouseleave', () => v.pause());
    });
    historyItems = items;
  } catch (e) { fail(e); }
}
let historyItems = [];
$('historyDlg').addEventListener('opened', renderHistory);
$('historyList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-hact]');
  if (!b) return;
  const entry = historyItems.find((x) => x.id === b.closest('[data-h]').dataset.h);
  const act = b.dataset.hact;
  try {
    if (act === 'redo') { $('historyDlg').close(); await applySettings(entry); }
    if (act === 'copy') await copyResult(entry);
    if (act === 'reveal') await api(`/api/history/${entry.id}/reveal`, {});
    if (act === 'hook') await sendWebhook(entry);
    if (act === 'booru') { const m = await import('./booru.js'); m.openBooru(entry); }
    if (act === 'del') { await api(`/api/history/${entry.id}`, { deleteFile: e.shiftKey }, 'DELETE'); renderHistory(); }
  } catch (err) { fail(err); }
});
$('booruBtn').addEventListener('click', async () => {
  if (!current) return;
  const m = await import('./booru.js');
  m.openBooru(current);
});

export const currentResult = () => current;
