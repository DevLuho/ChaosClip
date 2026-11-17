// Envoi d'un export vers Chaos Tools › ChaosBooru : formulaire, recherche d'étiquettes, connexion.
import { $, api, esc, fail, toast, debounce, native, openDialog, waitJob } from './util.js';
import { t } from './i18n.js';

const FORMATS = ['gif', 'webp', 'png'];
const SUPPORTS = [['anime', 'Anime'], ['manga', 'Manga'], ['game', 'Jeu vidéo'], ['illustration', 'Illustration'], ['live_action', 'Film / série'], ['other', 'Autre'], ['unknown', 'Inconnu']];
const KIND = { tags: 'Tag', personnages: 'Personnage', oeuvres: 'Œuvre', sagas: 'Saga' };
const ICON = { tags: '#', personnages: '👤 ', oeuvres: '📺 ', sagas: '📚 ' };

let entry = null;
let picked = new Map();

// ---------- connexion (fenêtre Réglages) ----------

export async function renderBooruStatus() {
  $('booruLogin').hidden = !native?.booruLogin;
  try {
    const s = await api('/api/booru/status');
    $('booruStatus').textContent = s.connected ? t('Connecté à Chaos Tools en tant que {u}', { u: s.user || '?' })
      : s.expired ? t('Connexion expirée : reconnecte-toi.') : s.error || t('Pas connecté. Le jeton reste sur ce PC.');
    $('booruLogout').hidden = !s.connected;
    return s;
  } catch (e) { $('booruStatus').textContent = e.message; return { connected: false }; }
}

async function saveToken(token) {
  try {
    await api('/api/booru/token', { token }, 'PUT');
    $('booruToken').value = '';
    const s = await renderBooruStatus();
    if (s.connected) toast(t('Connecté à Chaos Tools'), 'ok');
  } catch (e) { fail(e); }
}
$('booruTokenSave').addEventListener('click', () => saveToken($('booruToken').value));
$('booruLogout').addEventListener('click', () => saveToken(''));
$('booruLogin').addEventListener('click', async () => {
  const token = await native.booruLogin();
  if (token) saveToken(token);
});

// ---------- formulaire d'envoi ----------

export async function openBooru(e) {
  if (!e) return;
  if (!FORMATS.includes(e.format)) return toast(t('ChaosBooru accepte les GIF, WebP et PNG : exporte dans un de ces formats'), 'error');
  entry = e;
  picked = new Map();
  const s = await api('/api/booru/status').catch(() => ({ connected: false }));
  $('booruForm').innerHTML = s.connected ? form(e) : `<div>
    <p>${esc(t('Connecte-toi à Chaos Tools pour envoyer tes exports sur ChaosBooru.'))}</p>
    <div class="row"><button type="button" class="primary" data-dialog="settingsDlg">${esc(t('Ouvrir les réglages'))}</button></div></div>`;
  openDialog('booruDlg');
  if (s.connected) { renderPicked(); search(''); analyse(); $('booruTitle').focus(); }
}

function form(e) {
  // Comme le site : titre tiré du nom du fichier exporté (sans les numéros d'images du modèle par défaut).
  const title = e.file.replace(/\.[^.]+$/, '').replace(/-\d+-\d+$/, '').replace(/_/g, ' ').trim().slice(0, 120);
  return `<div class="stack">
    <p class="muted small">${esc(e.file)}</p>
    <label>${esc(t('Titre'))} <input id="booruTitle" maxlength="120" value="${esc(title)}"></label>
    <label>${esc(t('Description'))} <textarea id="booruDesc" rows="2" maxlength="2000"></textarea></label>
    <label>${esc(t('Support'))} <select id="booruSupport">${SUPPORTS.map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`).join('')}</select></label>
    <label>${esc(t('Tags, personnages, œuvres, sagas'))} <input id="booruSearch" placeholder="${esc(t('Rechercher…'))}" autocomplete="off"></label>
    <div id="booruResults" class="chips booru-results"></div>
    <div id="booruPicked" class="chips"></div>
    <label class="check"><input type="checkbox" id="booruSpoiler"> ${esc(t('Spoiler'))}</label>
    <label class="check"><input type="checkbox" id="booruSubmit" checked> ${esc(t('Soumettre à la modération (sinon : brouillon)'))}</label>
    <div id="booruCheck" class="small"></div>
    <div class="row"><button type="button" id="booruSend" class="primary">${esc(t('Envoyer'))}</button></div>
  </div>`;
}

function chip(c, act) {
  return `<span class="chip" title="${esc(t(KIND[c.kind]))}${c.group ? ` · ${esc(c.group)}` : ''}">${ICON[c.kind] || ''}${esc(c.name)}<button type="button" data-${act}="${c.id}">${act === 'add' ? '＋' : '✕'}</button></span>`;
}
function renderPicked() {
  $('booruPicked').innerHTML = [...picked.values()].map((c) => chip(c, 'drop')).join('') || `<span class="muted small">${esc(t('Aucune étiquette choisie'))}</span>`;
}

let results = [];
async function search(q) {
  try {
    results = (await api(`/api/booru/catalogue?q=${encodeURIComponent(q)}`)).items;
    $('booruResults').innerHTML = results.filter((c) => !picked.has(c.id)).slice(0, 24).map((c) => chip(c, 'add')).join('');
  } catch (e) { $('booruResults').textContent = e.message; }
}

// Analyse du site (/classement/apercu) : tags ajoutés d'office, suggestions, ce qui manque.
let check = null;
let checkSeq = 0;
const formBody = () => ({
  title: $('booruTitle').value.trim(), description: $('booruDesc').value.trim(), support: $('booruSupport').value,
  spoiler: $('booruSpoiler').checked, submit: $('booruSubmit').checked, entities: [...picked.keys()],
});
async function analyse() {
  const seq = ++checkSeq;
  try {
    const p = await api(`/api/history/${entry.id}/booru/preview`, formBody());
    if (seq !== checkSeq || !$('booruCheck')) return;
    check = p;
    const errors = Object.values(p.fields);
    $('booruCheck').innerHTML = [
      p.automatic.length ? `<p>${esc(t('Ajoutés automatiquement par ChaosBooru :'))} ${p.automatic.map((c) => `<span class="chip">${ICON[c.kind]}${esc(c.name)}</span>`).join(' ')}</p>` : '',
      p.imposedSupport && p.imposedSupport !== $('booruSupport').value ? `<p class="muted">${esc(t('Support imposé par l’œuvre : {s}', { s: t((SUPPORTS.find(([v]) => v === p.imposedSupport) || [, p.imposedSupport])[1]) }))}</p>` : '',
      p.suggestions.length ? `<p>${esc(t('Suggestions :'))} <span class="chips">${p.suggestions.filter((c) => !picked.has(c.id)).map((c) => chip(c, 'add')).join('')}</span></p>` : '',
      errors.length ? `<p class="error">${errors.map(esc).join('<br>')}</p>` : `<p class="ok">● ${esc(t('Prêt pour ChaosBooru'))}</p>`,
    ].join('');
  } catch (e) { if (seq === checkSeq && $('booruCheck')) $('booruCheck').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
const analyseSoon = debounce(analyse, 400);

$('booruForm').addEventListener('input', debounce((e) => { if (e.target.id === 'booruSearch') search(e.target.value); }, 250));
$('booruForm').addEventListener('input', (e) => { if (e.target.id !== 'booruSearch') analyseSoon(); });
$('booruForm').addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') analyseSoon(); });
$('booruForm').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]');
  const drop = e.target.closest('[data-drop]');
  if (add) { const c = [...results, ...(check?.suggestions || [])].find((x) => x.id === Number(add.dataset.add)); if (c) picked.set(c.id, c); }
  if (drop) picked.delete(Number(drop.dataset.drop));
  if (add || drop) { renderPicked(); search($('booruSearch').value); analyseSoon(); return; }
  if (e.target.id === 'booruSend') send();
});

async function send() {
  const body = formBody();
  if (body.title.length < 3) return toast(t('Indique un titre d’au moins 3 caractères'), 'error');
  // Le serveur refait l'analyse : on bloque seulement ce qu'elle a déjà refusé.
  if (body.submit && check && Object.keys(check.fields).length) return toast(Object.values(check.fields).join(' '), 'error');
  $('booruSend').disabled = true;
  try {
    const r = await api(`/api/history/${entry.id}/booru`, body);
    const res = await waitJob(r.job, 'ChaosBooru');
    $('booruDlg').close();
    toast(res.state === 'pending' ? t('Envoyé sur ChaosBooru : en attente de modération') : res.state === 'approved' ? t('Publié sur ChaosBooru') : t('Brouillon créé sur ChaosBooru'), 'ok', 6000);
    window.open(res.url, '_blank', 'noopener');
  } catch (e) { fail(e); } finally { const b = $('booruSend'); if (b) b.disabled = false; }
}
