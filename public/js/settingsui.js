// Réglages de l'appli, thème, langue, état des outils, journal, nettoyage, mises à jour.
import { $, api, fail, toast, esc, fmtBytes, native, android, openDialog, waitJob, confirmAsk } from './util.js';
import { t, setLang, getLang } from './i18n.js';
import { ctx } from './ctx.js';

export async function loadSettings() {
  try { ctx.appSettings = await api('/api/settings'); } catch { ctx.appSettings = {}; }
  applyTheme();
  return ctx.appSettings;
}

async function save(patch) {
  try {
    ctx.appSettings = await api('/api/settings', patch, 'PUT');
  } catch (e) { fail(e); }
}

// ---------- thème ----------

function applyTheme() {
  let th = ctx.appSettings.theme || 'chaos';
  if (th === 'auto') th = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'chaos';
  document.documentElement.dataset.theme = th;
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

// ---------- fenêtre des réglages ----------

const FIELDS = {
  setOutputDir: 'outputDir', setNameTemplate: 'nameTemplate', setDiscordLimit: 'discordLimit', setNotify: 'notify', setAutoCopy: 'autoCopy', setAutoSave: 'autoSave',
  setCookies: 'cookiesBrowser', setRateLimit: 'rateLimit', setDefaultHeight: 'defaultHeight', setTheme: 'theme',
};

function renderSettings() {
  const s = ctx.appSettings;
  for (const [id, k] of Object.entries(FIELDS)) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k] ?? (el.tagName === 'SELECT' ? el.options[0].value : '');
  }
  $('setLang').value = getLang();
  $('setOutputPick').hidden = !native;
  renderHooks();
  renderHealth();
  renderDisk();
  import('./booru.js').then((m) => m.renderBooruStatus && m.renderBooruStatus());
}
$('settingsDlg').addEventListener('opened', renderSettings);

for (const [id, k] of Object.entries(FIELDS)) {
  $(id).addEventListener('change', async (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
    await save({ [k]: v });
    if (k === 'theme') applyTheme();
    if (k === 'notify' && v && !native && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  });
}
$('setLang').addEventListener('change', (e) => setLang(e.target.value));
$('setOutputPick').addEventListener('click', async () => {
  const dir = await native.openFolder();
  if (dir) { $('setOutputDir').value = dir; save({ outputDir: dir }); }
});

// ---------- webhooks Discord ----------

function renderHooks() {
  const hooks = ctx.appSettings.webhooks || [];
  $('hookList').innerHTML = hooks.map((h) => `<li><span class="grow">${esc(h.name)}</span><button type="button" class="ghost small" data-hookdel="${esc(h.id)}">✕</button></li>`).join('');
}
$('hookAdd').addEventListener('click', async () => {
  const url = $('hookUrl').value.trim();
  const name = $('hookName').value.trim() || t('Salon {n}', { n: (ctx.appSettings.webhooks || []).length + 1 });
  if (!/^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) return toast(t('Adresse de webhook invalide'), 'error');
  try {
    ctx.appSettings = await api('/api/settings/webhooks', { name, url });
    $('hookUrl').value = ''; $('hookName').value = '';
    renderHooks();
  } catch (error) { fail(error); }
});
$('hookList').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-hookdel]');
  if (!d) return;
  try {
    ctx.appSettings = await api('/api/settings/webhooks/' + encodeURIComponent(d.dataset.hookdel), {}, 'DELETE');
    renderHooks();
  } catch (error) { fail(error); }
});

// ---------- outils, disque ----------

let health = null;
export async function checkHealth() {
  try {
    health = await api('/api/health');
    const issues = [];
    if (!health.ffmpeg) issues.push(t('ffmpeg introuvable : relance « npm install »'));
    if (!health.ytdlp) issues.push(t('yt-dlp pas encore installé (connexion internet nécessaire pour les URL)'));
    if (!health.font) issues.push(t('Aucune police trouvée : le texte incrusté ne marchera pas'));
    if (health.disk && health.disk.free < 2 * 1024 ** 3) issues.push(t('Moins de 2 Go libres sur le disque'));
    $('healthBar').hidden = !issues.length;
    $('healthBar').textContent = issues.map((i) => `⚠ ${i}`).join('  ·  ');
  } catch { /* le serveur répondra plus tard */ }
  return health;
}
function renderHealth() {
  if (!health) return;
  const h = health;
  $('healthInfo').innerHTML = [
    `ChaosClip ${esc(h.version)}`,
    `ffmpeg : ${esc((h.ffmpeg || '✗').replace(/^ffmpeg version /, '').split(' ')[0])}`,
    `yt-dlp : ${esc(h.ytdlp || '✗')}`,
    `gifsicle : ${h.gifsicle ? '✓' : '✗'}`,
    `${t('Polices')} : ${h.fontCount} (${esc(h.font || '✗')})`,
    `${t('Accélération')} : ${esc(h.hw.join(', ') || t('aucune'))}`,
    h.disk ? `${t('Disque libre')} : ${fmtBytes(h.disk.free)}` : '',
  ].filter(Boolean).join('<br>');
}
async function renderDisk() {
  try {
    const u = await api('/api/disk');
    $('diskInfo').textContent = `${t('Temporaires')} ${fmtBytes(u.work)} · ${t('Téléchargements')} ${fmtBytes(u.downloads)} · ${t('Exports')} ${fmtBytes(u.exports)}`;
  } catch { /* ignoré */ }
}
$('cleanWork').addEventListener('click', async () => {
  try { const r = await api('/api/cleanup', { kind: 'work' }); toast(t('{s} libérés', { s: fmtBytes(r.freed) }), 'ok'); renderDisk(); } catch (e) { fail(e); }
});
$('cleanDownloads').addEventListener('click', async () => {
  try { const r = await api('/api/cleanup', { kind: 'downloads' }); toast(t('{s} libérés', { s: fmtBytes(r.freed) }), 'ok'); renderDisk(); } catch (e) { fail(e); }
});
$('ytUpdate').addEventListener('click', async () => {
  try { toast(t('Mise à jour de yt-dlp…')); const r = await api('/api/ytdlp/update', {}); toast(`yt-dlp ${r.version} · ${r.message}`, 'ok'); checkHealth().then(renderHealth); } catch (e) { fail(e); }
});

// ---------- journal ----------

$('logBtn').addEventListener('click', async () => {
  const text = await (await fetch('/api/log')).text();
  const h = health || {};
  $('logText').textContent = `ChaosClip ${h.version || ''} · ${navigator.userAgent}\nffmpeg: ${h.ffmpeg || '?'}\nyt-dlp: ${h.ytdlp || '?'}\n\n${text || t('(journal vide)')}`;
  openDialog('logDlg');
});
$('logCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('logText').textContent); toast(t('Rapport copié'), 'ok'); } catch (e) { fail(e); }
});

// ---------- mises à jour ----------

const UP_ICON = '<svg class="ic" aria-hidden="true"><use href="#i-down"/></svg>';
function updateBar(title, detail, actions = '') {
  const bar = $('updateBar');
  bar.hidden = false;
  bar.innerHTML = `<span class="update-mark">${UP_ICON}</span><span class="update-text"><strong>${title}</strong>${detail ? `<span>${detail}</span>` : ''}</span><span class="update-actions">${actions}<button type="button" id="updateLater" class="ghost">${t('Plus tard')}</button></span>`;
  $('updateLater').addEventListener('click', () => { bar.hidden = true; updateHidden = true; });
}

// Une mise à jour relance l'appli : les exports et téléchargements en cours seraient coupés.
async function busyOk() {
  const { items } = await api('/api/queue').catch(() => ({ items: [] }));
  const n = items.filter((j) => ['running', 'queued'].includes(j.status)).length;
  return !n || confirmAsk(t('{n} export(s) ou téléchargement(s) en cours seront interrompus. Mettre à jour quand même ?', { n }), t('Mettre à jour'));
}

// Appli installée : avancement du téléchargement, puis bouton pour installer tout de suite.
let lastUpdate = null;
let updateHidden = false; // « Plus tard » : l'avancement ne rouvre pas le bandeau, la version prête si.
function renderUpdate(u) {
  lastUpdate = u;
  const v = u.version ? ` ${esc(u.version)}` : '';
  if (u.state === 'error') {
    const shown = !$('updateBar').hidden;
    $('updateBar').hidden = true;
    if (shown) toast(`${t('Mise à jour impossible')} : ${u.message || ''}`, 'error', 9000);
    return;
  }
  if (u.state === 'downloading') {
    if (updateHidden) return;
    updateBar(`${t('Mise à jour')}${v}`, `${t('Téléchargement en cours…')} ${u.percent || 0} %<span class="update-progress"><span style="width:${u.percent || 0}%"></span></span>`);
    return;
  }
  const notes = u.version ? `<a class="btn ghost" href="https://github.com/DevLuho/ChaosClip/releases/tag/v${encodeURIComponent(u.version)}" target="_blank" rel="noopener">${t('Nouveautés')}</a>` : '';
  updateBar(`${t('ChaosClip')}${v} ${t('est prête')}`, t('L’appli se relance sur la nouvelle version en quelques secondes.'), `${notes}<button type="button" id="updateGo" class="primary">${UP_ICON}${t('Mettre à jour')}</button>`);
  $('updateGo').addEventListener('click', async () => { if (await busyOk()) native.installUpdate(); });
  if (!document.hasFocus()) native.notify('ChaosClip', `${t('Mise à jour')}${v} ${t('prête : clique sur « Mettre à jour » en haut.')}`);
}
native?.onUpdate?.(renderUpdate);

// Premier lancement : petit guide. Après une mise à jour : lien vers les nouveautés.
export async function welcome(h) {
  if (!h?.version) return;
  let seen = null;
  try { seen = localStorage.getItem('chaosclip.version'); localStorage.setItem('chaosclip.version', h.version); } catch { return; }
  if (seen === h.version) return;
  if (seen) {
    updateBar(t('ChaosClip est passée en {v}', { v: esc(h.version) }), '', `<a class="btn ghost" href="https://github.com/DevLuho/ChaosClip/releases/tag/v${encodeURIComponent(h.version)}" target="_blank" rel="noopener">${t('Nouveautés')}</a>`);
    return;
  }
  const { items } = await api('/api/history').catch(() => ({ items: [] }));
  if (!items.length && !document.querySelector('dialog[open]')) openDialog('welcomeDlg');
}

export async function checkUpdate(manual = false) {
  try {
    const u = await api('/api/update');
    if (u.mode === 'installer' && native?.checkUpdate) {
      // Electron cherche seul (au démarrage puis toutes les 4 h) sur la release GitHub ; renderUpdate() suit l'avancement.
      if (!manual) return;
      const r = await native.checkUpdate();
      if (r?.error) throw new Error(`${t('Mise à jour impossible')} : ${r.error}`);
      if (!r?.available) { toast(t('ChaosClip est à jour ({v})', { v: u.current }), 'ok'); return; }
      updateHidden = false;
      if (lastUpdate && lastUpdate.state !== 'error') renderUpdate(lastUpdate);
      else renderUpdate({ state: 'downloading', version: r.version, percent: 0 });
      return;
    }
    if (!u.available) { if (manual) toast(t('ChaosClip est à jour ({v})', { v: u.current }), 'ok'); return; }
    const what = u.latest && u.latest !== u.current ? `${u.current} → ${u.latest}` : t('{n} nouveauté(s)', { n: u.commits || 1 });
    if (u.mode === 'installer') {
      updateBar(`${t('Mise à jour disponible')} (${esc(what)})`, t('Elle s’installera au prochain démarrage.'));
      return;
    }
    updateBar(`${t('Mise à jour disponible')} (${esc(what)})`, '', u.mode === 'git' || u.mode === 'apk'
      ? `<button type="button" id="updateGo" class="primary">${UP_ICON}${t('Mettre à jour')}</button>`
      : `<a class="btn primary" href="https://github.com/DevLuho/ChaosClip/releases/latest" target="_blank" rel="noopener">${UP_ICON}${t('Télécharger sur GitHub')}</a>`);
    $('updateGo')?.addEventListener('click', async () => {
      try {
        if (!await busyOk()) return;
        const r = await api('/api/update', {});
        const res = await waitJob(r.job, t('Mise à jour'));
        updateBar(esc(res.message), '');
        if (native) native.relaunch();
        if (res.install) android.install(); // appli Android : l'APK est téléchargé, le téléphone demande de confirmer
      } catch (e) { fail(e); }
    });
  } catch (e) { if (manual) fail(e); }
}
$('appUpdate').addEventListener('click', () => checkUpdate(true));
