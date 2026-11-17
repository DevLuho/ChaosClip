// Réglages de l'appli, thème, langue, état des outils, journal, nettoyage, mises à jour.
import { $, api, fail, toast, esc, fmtBytes, native, openDialog, waitJob } from './util.js';
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
  setOutputDir: 'outputDir', setNameTemplate: 'nameTemplate', setDiscordLimit: 'discordLimit', setNotify: 'notify',
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
  $('hookList').innerHTML = hooks.map((h, i) => `<li><span class="grow">${esc(h.name)}</span><span class="muted small">…${esc(h.url.slice(-8))}</span><button type="button" class="ghost small" data-hookdel="${i}">✕</button></li>`).join('');
}
$('hookAdd').addEventListener('click', async () => {
  const url = $('hookUrl').value.trim();
  const name = $('hookName').value.trim() || t('Salon {n}', { n: (ctx.appSettings.webhooks || []).length + 1 });
  if (!/^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url)) return toast(t('Adresse de webhook invalide'), 'error');
  await save({ webhooks: [...(ctx.appSettings.webhooks || []), { name, url }] });
  $('hookUrl').value = ''; $('hookName').value = '';
  renderHooks();
});
$('hookList').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-hookdel]');
  if (!d) return;
  const hooks = [...(ctx.appSettings.webhooks || [])];
  hooks.splice(Number(d.dataset.hookdel), 1);
  await save({ webhooks: hooks });
  renderHooks();
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

export async function checkUpdate(manual = false) {
  try {
    const u = await api('/api/update');
    if (!u.available) { if (manual) toast(t('ChaosClip est à jour ({v})', { v: u.current }), 'ok'); return; }
    const bar = $('updateBar');
    bar.hidden = false;
    const what = u.latest && u.latest !== u.current ? `${u.current} → ${u.latest}` : t('{n} nouveauté(s)', { n: u.commits || 1 });
    if (u.mode === 'installer') {
      bar.innerHTML = `${t('Mise à jour disponible')} (${esc(what)}) : ${t('elle s’installera au prochain démarrage.')}`;
      return;
    }
    bar.innerHTML = `${t('Mise à jour disponible')} (${esc(what)}). ${u.mode === 'git'
      ? `<button type="button" id="updateGo" class="primary small">${t('Installer')}</button>`
      : `<a href="https://github.com/DevLuho/ChaosClip" target="_blank" rel="noopener">${t('Télécharger sur GitHub')}</a>`}`;
    $('updateGo')?.addEventListener('click', async () => {
      try {
        const r = await api('/api/update', {});
        const res = await waitJob(r.job, t('Mise à jour'));
        bar.textContent = res.message;
        if (native) native.relaunch();
      } catch (e) { fail(e); }
    });
  } catch (e) { if (manual) fail(e); }
}
$('appUpdate').addEventListener('click', () => checkUpdate(true));
