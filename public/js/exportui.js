// Export : estimation (manuelle ou en direct), aperçus, comparaison, file d'attente, historique, envoi.
import { $, $$, api, waitJob, runAction, fail, toast, fmtBytes, esc, debounce, beep, native, openDialog, etaText, confirmAsk } from './util.js';
import { t } from './i18n.js';
import { ctx, listen } from './ctx.js';
import { state, toServer, maxSizeMB, replaceDoc, QUALITY_DEFAULT } from './state.js';
import { shownFrame } from './player.js';

const discordLimit = () => Number(ctx.appSettings.discordLimit) || 20;
const supportsBooru = (format) => ['gif', 'webp', 'png'].includes(format);

function sizeVerdict(bytes, max = maxSizeMB(), estimated = false) {
  const lim = discordLimit();
  const mb = bytes / 1048576;
  if (max && mb > max) return { cls: 'over', note: t(estimated ? 'au-dessus du poids max : l’export réduira automatiquement' : 'au-dessus du poids cible') };
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

let estimateRevision = 0;
let previewRevision = 0;
let autoJob = null;
let manualEstimates = 0;
const output = () => $('outputActivity');
const clearEstimate = () => {
  $('estimate').className = 'estimate muted';
  $('estimate').textContent = '—';
};
const cancelJob = (id) => api(`/api/job/${id}/cancel`, {}).catch(() => {});
function invalidateEstimates() {
  ++estimateRevision;
  ++previewRevision;
  clearEstimate();
  if (autoJob) cancelJob(autoJob);
  autoJob = null;
}

async function runEstimate({ auto = false } = {}) {
  if (!ctx.source || (auto && (!$('liveEstimate').checked || manualEstimates))) return;
  const sourceId = ctx.source.id;
  const tabId = ctx.tabId;
  const settings = toServer();
  const key = JSON.stringify(['estimate', tabId, settings]);
  const run = async (activity) => {
    const rev = ++estimateRevision;
    const preview = auto ? null : ++previewRevision;
    const current = () => rev === estimateRevision && tabId === ctx.tabId;
    if (autoJob) cancelJob(autoJob);
    autoJob = null;
    $('estimate').className = 'estimate muted';
    $('estimate').textContent = t('Calcul…');
    try {
      const { job } = await api(`/api/estimate/${sourceId}`, { settings });
      if (auto && !current()) return await cancelJob(job);
      if (auto) autoJob = job;
      const res = await waitJob(job, t('Aperçu et poids'), { activity, silent: auto });
      if (!current()) return;
      const v = sizeVerdict(res.bytes, settings.maxSizeMB, true);
      $('estimate').className = `estimate ${v.cls}`;
      $('estimate').textContent = `${res.estimate ? '≈ ' : ''}${fmtBytes(res.bytes)} · ${res.size.w}×${res.size.h} · ${res.duration.toFixed(2)} s · ${v.note}`;
      if (preview === previewRevision) showPreview(t(res.estimate ? 'Aperçu d’un échantillon' : 'Aperçu du rendu complet'), mediaTag(res.sample, res.format), fmtBytes(res.sampleBytes));
    } catch (error) {
      if (current()) {
        clearEstimate();
        if (auto && !error.cancelled) $('estimate').textContent = `⚠ ${error.message.slice(0, 120)}`;
      }
      if (!auto) throw error;
    } finally {
      if (auto && current()) autoJob = null;
    }
  };
  if (auto) return run();
  return runAction(key, t('Calcul de l’aperçu…'), async (activity) => {
    ++manualEstimates;
    try { await run(activity); }
    finally { --manualEstimates; }
  }, { host: output() });
}
$('estimateBtn').addEventListener('click', () => runEstimate());
export const estimate = () => runEstimate();

const live = debounce(() => runEstimate({ auto: true }), 900);
listen('docchange', () => { invalidateEstimates(); if ($('liveEstimate').checked && ctx.source) live(); });
listen('source', () => { invalidateEstimates(); if ($('liveEstimate').checked && ctx.source) live(); });
$('liveEstimate').addEventListener('change', (e) => {
  try { localStorage.setItem('chaosclip.live', e.target.checked ? '1' : ''); } catch { /* ignoré */ }
  if (e.target.checked) live();
  else if (autoJob) { cancelJob(autoJob); autoJob = null; clearEstimate(); }
});
try { $('liveEstimate').checked = localStorage.getItem('chaosclip.live') === '1'; } catch { /* ignoré */ }

// ---------- aperçu d’une image ----------

function showPreview(title, html, info) {
  $('preview').hidden = false;
  $('previewTitle').textContent = title;
  $('previewMedia').innerHTML = html;
  $('previewMedia').classList.add('checker');
  $('previewInfo').textContent = info || '';
}
$('previewClose').addEventListener('click', () => {
  ++previewRevision;
  $('previewBtn').focus();
  $('preview').hidden = true;
  $('previewMedia').replaceChildren();
});

export function previewFrame() {
  if (!ctx.source) return;
  const { id } = ctx.source;
  const tabId = ctx.tabId;
  const frame = Math.max(0, shownFrame());
  const settings = toServer();
  return runAction(JSON.stringify(['preview', tabId, frame, settings]), t('Rendu de l’image…'), async (activity) => {
    const request = ++previewRevision;
    const { job } = await api(`/api/preview/${id}`, { settings, frame });
    const res = await activity.wait(job);
    if (ctx.tabId === tabId && request === previewRevision) {
      const title = t('Rendu exact de l’image {n}', { n: frame });
      showPreview(title, `<img src="${esc(res.url)}" alt="${esc(title)}">`);
    }
  }, { host: output() });
}
$('previewBtn').addEventListener('click', previewFrame);

// ---------- comparaison A / B ----------

let compareA = null;
listen('source', () => { compareA = null; $('cmpA').replaceChildren(); $('cmpB').replaceChildren(); });
$('compareBtn').addEventListener('click', () => {
  if (!compareA) compareA = JSON.parse(JSON.stringify(state.doc));
  openDialog('compareDlg');
});
$('cmpKeepA').addEventListener('click', () => { if ($('cmpRun').getAttribute('aria-busy') === 'true') return; compareA = structuredClone(state.doc); toast(t('Réglages A gardés')); });
$('cmpUseA').addEventListener('click', () => { if ($('cmpRun').getAttribute('aria-busy') === 'true') return; if (compareA) replaceDoc(compareA); $('compareDlg').close(); });
$('cmpRun').addEventListener('click', () => runAction('compare', t('Comparaison en cours…'), async () => {
  if (!compareA) compareA = JSON.parse(JSON.stringify(state.doc));
  const id = ctx.source.id;
  const tabId = ctx.tabId;
  const one = async (doc, el, info, label) => {
    $(el).innerHTML = `<p class="muted">${t('Calcul…')}</p>`;
    $(info).textContent = label;
    const r = await api(`/api/estimate/${id}`, { settings: toServer(doc) });
    const res = await waitJob(r.job, label, { silent: true });
    if (ctx.tabId !== tabId || !$('compareDlg').open) return;
    $(el).innerHTML = mediaTag(res.sample, res.format);
    const o = doc.opts;
    $(info).textContent = `${label} : ≈ ${fmtBytes(res.bytes)} · ${o.format.toUpperCase()} ${res.size.w}×${res.size.h} · ${o.fps || t('fps d’origine')} i/s${o.format === 'gif' ? ` · ${o.colors} ${t('couleurs')} · ${o.dither}${o.lossy ? ` · lossy ${o.lossy}` : ''}` : ` · q ${o.quality}`}`;
  };
  const attempts = await Promise.allSettled([one(compareA, 'cmpA', 'cmpAInfo', 'A'), one(state.doc, 'cmpB', 'cmpBInfo', 'B')]);
  if (ctx.tabId !== tabId || !$('compareDlg').open) return;
  for (const [i, attempt] of attempts.entries()) {
    if (attempt.status === 'rejected') {
      const side = i === 0 ? 'cmpA' : 'cmpB';
      $(side).replaceChildren();
      $(`${side}Info`).textContent = attempt.reason.message;
    }
  }
  const failure = attempts.find((attempt) => attempt.status === 'rejected');
  if (failure) throw failure.reason;
}, { host: $('compareActivity'), controls: [$('cmpRun'), $('cmpKeepA'), $('cmpUseA')] }));

// ---------- export et file d'attente ----------

const alsoFormats = () => $$('.alsoFmt:checked').map((c) => c.value).filter((f) => f !== state.doc.opts.format);

function exportBatch({ still = false } = {}) {
  if (!ctx.source) return;
  const { id: sourceId, name: sourceName } = ctx.source;
  const tabId = ctx.tabId;
  const doc = structuredClone(state.doc);
  const frame = Math.max(0, shownFrame());
  const name = still ? '' : $('exportName').value.trim();
  const formats = still ? ['png'] : [doc.opts.format, ...alsoFormats()];
  const requests = formats.map((format) => {
    if (still) return toServer(doc, { format, segments: [{ start: frame, end: frame }], maxSizeMB: 0, width: 0 });
    const quality = format === doc.opts.format ? doc.opts.quality : (doc.opts.qualityByFormat?.[format] ?? QUALITY_DEFAULT[format] ?? 75);
    return toServer(doc, { format, quality });
  });
  const key = JSON.stringify(['export', sourceId, name, [...requests].sort((a, b) => a.format.localeCompare(b.format))]);
  return { sourceId, sourceName, tabId, name, requests, key };
}

function runExport(batch, { queued = false, retry = false } = {}) {
  if (!batch) return;
  return runAction(batch.key, t(queued ? 'Ajout à la file…' : 'Préparation de l’export…'), async (activity) => {
    const started = Date.now();
    const sequence = Symbol();
    latestExports.set(batch.tabId, sequence);
    const jobs = [];
    const failures = [];
    let cancellation;
    const results = retry ? [...(resultsByTab.get(batch.tabId)?.entries ?? [])] : [];
    for (const settings of batch.requests) {
      try {
        const { job } = await api(`/api/export/${batch.sourceId}`, { settings, name: batch.name });
        jobs.push({ job, settings });
      } catch (error) { failures.push({ settings, error }); }
    }
    if (jobs.length) {
      watchQueue();
      if (queued) toast(t('{n} export(s) ajouté(s) à la file', { n: jobs.length }), 'ok');
    }
    for (const { job, settings } of jobs) {
      try {
        const result = await activity.wait(job, `${t('Encodage {format}', { format: settings.format.toUpperCase() })} · ${batch.sourceName}`);
        results.push(result);
      } catch (error) {
        if (!error.cancelled) failures.push({ settings, error });
        else cancellation = error;
      }
    }
    if ((results.length || failures.length) && latestExports.get(batch.tabId) === sequence) {
      resultsByTab.set(batch.tabId, { entries: results, failures, batch });
      if (ctx.tabId === batch.tabId && !$('queueDlg').open) restoreResults(batch.tabId);
    }
    if (results.length) {
      if (!failures.length) toast(t('{n} exports terminés', { n: results.length }), 'ok');
      notifyDone(results.at(-1), Date.now() - started);
      // Copie automatique (réglage) : le fichier du format principal, prêt pour Ctrl+V dans Discord.
      if (ctx.appSettings.autoCopy && !queued) copyResult(results[0]);
    }
    if (cancellation && !results.length && !failures.length) throw cancellation;
    if (failures.length) throw new Error(t('Échec de {formats}', { formats: failures.map(({ settings }) => settings.format.toUpperCase()).join(', ') }));
  }, { host: output(), returnFocus: $(queued ? 'queueBtn' : 'exportBtn') });
}
$('exportBtn').addEventListener('click', (event) => { if (event.detail < 2) exportNow(); });
$('queueBtn').addEventListener('click', (event) => { if (event.detail < 2) runExport(exportBatch(), { queued: true }); });
export const exportNow = () => runExport(exportBatch());
export const saveStill = () => runExport(exportBatch({ still: true }));

// Image affichée (vidéo d'origine, sans les réglages) dans le presse-papiers.
export function copyFrame() {
  if (!ctx.source) return;
  const { id } = ctx.source;
  const f = Math.max(0, shownFrame());
  return runAction('copy-frame', t('Copie de l’image…'), async () => {
    try {
      const r = await fetch(`/api/frame/${id}?f=${f}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await r.blob() })]);
    } catch (error) {
      if (error.name !== 'NotAllowedError') throw error;
      await api(`/api/frame/${id}/copy`, { f });
    }
    toast(t('Image copiée : Ctrl+V pour la coller'), 'ok');
  }, { host: output() });
}

function notifyDone(res, ms) {
  if (!res || !ctx.appSettings.notify || ms < 8000) return;
  beep();
  const body = `${res.file} · ${fmtBytes(res.bytes)}`;
  if (native) native.notify('ChaosClip', body);
  else if ('Notification' in window && Notification.permission === 'granted') new Notification(t('Export terminé'), { body, icon: 'icon.svg' });
}

// ---------- résultat ----------

let current = null;
const latestExports = new Map();
const resultsByTab = new Map();
export function forgetResults(tabId) {
  latestExports.delete(tabId);
  resultsByTab.delete(tabId);
}
const resultCard = $('result');
const resultHome = resultCard.parentElement;
export function restoreResults(tabId) {
  resultCard.hidden = true;
  $('exportFailure').hidden = true;
  current = null;
  const saved = resultsByTab.get(tabId);
  if (!saved) return;
  const { entries, failures, batch } = saved;
  if (entries.length) showResult(entries.find((entry) => entry.id === saved.selectedId) || entries[0], entries);
  if (failures.length) {
    $('exportFailure').hidden = false;
    $('exportFailureText').textContent = failures.map(({ settings, error }) => `${settings.format.toUpperCase()} · ${error.message}`).join(' / ');
    $('exportRetry').onclick = () => runExport({ ...batch, requests: failures.map(({ settings }) => settings) }, { retry: true });
  }
}

export function showResult(res, entries = [res]) {
  current = res;
  $('result').hidden = false;
  $('resultMedia').innerHTML = mediaTag(`${res.url}?v=${res.date}`, res.format);
  const last = res.attempts[res.attempts.length - 1];
  const v = sizeVerdict(res.bytes, res.settings?.maxSizeMB);
  let info = `${res.file} · ${fmtBytes(res.bytes)} · ${res.size.w}×${res.size.h}`;
  if (res.attempts.length > 1) info += ` · ${t('ajusté en {n} essais', { n: res.attempts.length })} (${last.width}px, ${Math.round(last.fps)} i/s${last.bitrateKbps ? `, ${last.bitrateKbps} kb/s` : ''}${last.lossy ? `, lossy ${last.lossy}` : ''})`;
  if (!res.fitsMax) info += ` · ⚠ ${t('toujours au-dessus du poids max : raccourcis la sélection ou baisse la taille')}`;
  $('resultInfo').innerHTML = `${esc(info)}<br><span class="${v.cls === 'over' ? 'error' : 'ok'}">● ${esc(v.note)}</span>`;
  $('resultLink').href = res.url;
  $('resultLink').download = res.file;
  $('webhookBtn').hidden = !(ctx.appSettings.webhooks || []).length;
  $('dragBtn').hidden = !native;
  $('booruBtn').hidden = !supportsBooru(res.format);
  $('resultVariants').replaceChildren(...entries.map((entry, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${entry.format.toUpperCase()} · ${fmtBytes(entry.bytes)}`;
    button.setAttribute('aria-pressed', String(entry.id === res.id));
    button.onclick = () => {
      const saved = resultsByTab.get(ctx.tabId);
      if (resultCard.parentElement === resultHome && saved?.entries === entries) saved.selectedId = entry.id;
      showResult(entry, entries);
      $('resultVariants').children[index].focus();
    };
    return button;
  }));
  $('resultVariants').hidden = entries.length < 2;
}
$('copyBtn').addEventListener('click', () => copyResult(current));
$('openTabBtn').addEventListener('click', async () => {
  const path = current?.path;
  if (!path) return;
  if ($('queueDlg').open) $('queueDlg').close();
  const { loadInput } = await import('./sources.js');
  await loadInput(path);
});
$('revealBtn').addEventListener('click', () => current && api(`/api/history/${current.id}/reveal`, {}).catch(fail));
$('webhookBtn').addEventListener('click', () => current && sendWebhook(current));
$('dragBtn').addEventListener('dragstart', (e) => {
  if (!current || !native) return;
  e.preventDefault();
  native.startDrag(current.path);
});

function shareFeedback(control) {
  const dialog = control?.closest('dialog');
  return $(dialog ? { historyDlg: 'historyActivity', queueDlg: 'queueActivity', seriesDlg: 'seriesActivity' }[dialog.id] : 'outputActivity');
}
export function copyResult(entry, control = $('copyBtn')) {
  if (!entry) return;
  return runAction(`copy:${entry.id}`, t('Copie du fichier…'), async () => {
    if (native?.copyFile) await native.copyFile(entry.path);
    else await api(`/api/history/${entry.id}/copy`, {});
    toast(t('Copié : colle-le dans Discord avec Ctrl+V'), 'ok');
    return true;
  }, { host: shareFeedback(control), controls: [control] });
}

function sendWebhook(entry, control = $('webhookBtn')) {
  return runAction(`discord:${entry.id}`, t('Envoi vers Discord…'), () => deliverWebhook(entry), {
    host: shareFeedback(control),
    controls: [control],
  });
}

async function deliverWebhook(entry) {
  const hooks = ctx.appSettings.webhooks || [];
  if (!hooks.length) return toast(t('Ajoute un webhook Discord dans les Réglages'), 'error');
  const choice = await pickHook(hooks);
  if (!choice) throw Object.assign(new Error(t('Annulé')), { cancelled: true });
  const hook = hooks.find((h) => h.id === choice.hookId);
  await api(`/api/history/${entry.id}/webhook`, choice);
  toast(t('Envoyé dans {name}', { name: hook.name }), 'ok');
}

// Salon (le dernier utilisé est proposé) et message facultatif.
function pickHook(hooks) {
  return new Promise((resolve) => {
    const d = $('hookDlg');
    let last = null;
    try { last = localStorage.getItem('chaosclip.hook'); } catch { /* ignoré */ }
    $('hookPick').innerHTML = hooks.map((h) => `<option value="${esc(h.id)}"${h.id === last ? ' selected' : ''}>${esc(h.name)}</option>`).join('');
    $('hookMsg').value = '';
    d.returnValue = '';
    openDialog('hookDlg');
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return resolve(null);
      const hookId = $('hookPick').value;
      try { localStorage.setItem('chaosclip.hook', hookId); } catch { /* ignoré */ }
      resolve({ hookId, message: $('hookMsg').value.trim() });
    }, { once: true });
  });
}

// ---------- fenêtre de la file ----------

let queueTimer = null;
export async function refreshQueue() {
  try {
    const { items } = await api('/api/queue');
    const active = items.filter((j) => ['running', 'queued'].includes(j.status));
    $('queueBadge').hidden = !active.length;
    $('queueBadge').textContent = active.length;
    const focused = document.activeElement;
    const jobControl = focused?.dataset.qcancel || focused?.dataset.qshow;
    $('queueList').innerHTML = items.length ? items.map((j) => `<li>
      <span class="grow">${j.kind === 'download' ? '⬇' : '⚙'} ${esc(j.label || j.kind)}</span>
      <span class="small ${j.status === 'error' ? 'error' : 'muted'}">${esc({ queued: t('en attente'), running: j.progress > 0 ? [`${Math.round(j.progress * 100)} %`, etaText(j)].filter(Boolean).join(' · ') : t('En cours'), done: t('terminé'), error: t('erreur'), cancelled: t('annulé') }[j.status])}${j.status === 'error' ? ` : ${esc(String(j.error ?? '').slice(0, 120))}` : ''}</span>
      ${['running', 'queued'].includes(j.status) ? `<button type="button" class="ghost small" data-qcancel="${j.id}">${t('Annuler')}</button>` : ''}
      ${j.status === 'done' && j.kind === 'export' ? `<button type="button" class="ghost small" data-qshow="${j.id}">${t('Voir')}</button>` : ''}
    </li>`).join('') : `<li class="muted">${t('Rien en cours')}</li>`;
    if (jobControl) ($('queueList').querySelector(`[data-qcancel="${jobControl}"], [data-qshow="${jobControl}"]`) || $('queueDlg').querySelector('[data-close]'))?.focus();
    return active.length;
  } catch { return null; }
}
function watchQueue() {
  if (queueTimer !== null) return;
  const tick = async () => {
    const active = await refreshQueue();
    queueTimer = active === 0 && !$('queueDlg').open ? null : setTimeout(tick, 900);
  };
  queueTimer = setTimeout(tick, 0);
}
$('queueDlg').addEventListener('opened', watchQueue);
$('queueDlg').addEventListener('close', () => {
  if (resultCard.parentElement !== resultHome) resultHome.append(resultCard);
  restoreResults(ctx.tabId);
});
$('queueList').addEventListener('click', async (e) => {
  const c = e.target.closest('[data-qcancel]');
  const s = e.target.closest('[data-qshow]');
  try {
    if (c) {
      await runAction(`cancel:${c.dataset.qcancel}`, t('Annulation…'), () => api(`/api/job/${c.dataset.qcancel}/cancel`, {}), { host: $('queueActivity'), controls: [c] });
      watchQueue();
    }
    if (s) {
      const j = await api(`/api/job/${s.dataset.qshow}`);
      if (!$('queueDlg').open || !j.result) return;
      $('queueResult').append(resultCard);
      showResult(j.result);
      $('copyBtn').focus();
    }
  } catch (error) { fail(error); }
});

// ---------- historique ----------

let applySettings = null; // fourni par main.js : recharge la source et les réglages d'un export
export const setApplySettings = (fn) => { applySettings = fn; };

async function renderHistory() {
  try { historyItems = (await api('/api/history')).items; } catch (e) { return fail(e); }
  const formats = [...new Set(historyItems.map((e) => e.format))].sort();
  const chosen = $('historyFormat').value;
  $('historyFormat').innerHTML = `<option value="">${t('Tous les formats')}</option>${formats.map((f) => `<option value="${esc(f)}"${f === chosen ? ' selected' : ''}>${esc(f.toUpperCase())}</option>`).join('')}`;
  drawHistory();
}
function drawHistory() {
  const q = $('historySearch').value.trim().toLowerCase();
  const format = $('historyFormat').value;
  const items = historyItems.filter((e) => (!format || e.format === format) && (!q || `${e.file} ${e.source?.name || ''}`.toLowerCase().includes(q)));
  $('historyCount').textContent = items.length === historyItems.length ? t('{n} export(s)', { n: items.length }) : `${items.length} / ${historyItems.length}`;
  $('historyList').innerHTML = items.length ? items.map((e) => `<div class="hist" data-h="${e.id}">
      <div class="thumb checker">${e.exists ? (['mp4', 'webm'].includes(e.format) ? `<video src="${e.url}" muted loop preload="metadata"></video>` : e.format === 'mp3' ? '♪' : `<img src="${e.url}" loading="lazy" alt="">`) : `<span class="muted">${t('fichier supprimé')}</span>`}</div>
      <div title="${esc(e.path)}"><strong>${esc(e.file)}</strong></div>
      <div class="muted">${fmtBytes(e.bytes)} · ${e.size.w}×${e.size.h} · ${new Date(e.date).toLocaleString()}</div>
      <div class="actions wrap">
        <input type="checkbox" data-hsel aria-label="${t('Sélectionner')}">
        <button type="button" data-hact="redo" title="${t('Recharger la vidéo avec ces réglages')}">${t('Refaire')}</button>
        ${e.exists ? `<button type="button" data-hact="copy">${t('Copier')}</button><button type="button" data-hact="reveal">${t('Dossier')}</button>` : ''}
        ${e.exists && (ctx.appSettings.webhooks || []).length ? `<button type="button" data-hact="hook">Discord</button>` : ''}
        ${e.exists && supportsBooru(e.format) ? `<button type="button" data-hact="booru">Booru</button>` : ''}
        <button type="button" data-hact="del" title="${t('Retirer de l’historique (Maj : supprimer aussi le fichier)')}">✕</button>
      </div></div>`).join('') : `<p class="muted">${t(historyItems.length ? 'Aucun export ne correspond.' : 'Aucun export pour l’instant.')}</p>`;
  $$('#historyList video').forEach((v) => {
    v.addEventListener('mouseenter', () => v.play().catch(() => {}));
    v.addEventListener('mouseleave', () => v.pause());
  });
  countSelected();
}
let historyItems = [];
$('historyDlg').addEventListener('opened', renderHistory);
$('historySearch').addEventListener('input', drawHistory);
$('historyFormat').addEventListener('change', drawHistory);
const selectedHistory = () => $$('#historyList [data-hsel]:checked').map((c) => c.closest('[data-h]').dataset.h);
function countSelected() {
  const n = selectedHistory().length;
  $('historyDelSel').hidden = !n;
  $('historyDelSel').textContent = t('Retirer la sélection ({n})', { n });
}
$('historyList').addEventListener('change', (e) => { if (e.target.matches('[data-hsel]')) countSelected(); });
$('historyDelSel').addEventListener('click', async (e) => {
  const ids = selectedHistory();
  const deleteFile = e.shiftKey;
  if (deleteFile && !(await confirmAsk(t('Supprimer aussi les {n} fichier(s) du disque ?', { n: ids.length }), t('Supprimer')))) return;
  try {
    for (const id of ids) await api(`/api/history/${id}`, { deleteFile }, 'DELETE');
  } catch (err) { fail(err); }
  renderHistory();
});
$('historyList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-hact]');
  if (!b) return;
  const entry = historyItems.find((x) => x.id === b.closest('[data-h]').dataset.h);
  const act = b.dataset.hact;
  try {
    if (act === 'redo') { $('historyDlg').close(); await applySettings(entry); }
    if (act === 'copy') await copyResult(entry, b);
    if (act === 'reveal') await api(`/api/history/${entry.id}/reveal`, {});
    if (act === 'hook') await sendWebhook(entry, b);
    if (act === 'booru') { const m = await import('./booru.js'); m.openBooru(entry); }
    if (act === 'del') { await api(`/api/history/${entry.id}`, { deleteFile: e.shiftKey }, 'DELETE'); renderHistory(); }
  } catch (err) { fail(err); }
});
$('booruBtn').addEventListener('click', async () => {
  if (!current) return;
  const entry = current;
  const m = await import('./booru.js');
  m.openBooru(entry);
});

export const currentResult = () => current;
