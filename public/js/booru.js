// Envoi d'un export vers Chaos Tools › ChaosBooru : formulaire, recherche d'étiquettes, connexion.
import { $, api, esc, fail, fmtBytes, toast, debounce, native, openDialog, waitJob } from './util.js';
import { t } from './i18n.js';

const FORMATS = ['gif', 'webp', 'png'];
const SUPPORTS = [['anime', 'Anime'], ['manga', 'Manga'], ['game', 'Jeu vidéo'], ['illustration', 'Illustration'], ['live_action', 'Film / série'], ['other', 'Autre'], ['unknown', 'Inconnu']];
const KIND = { tags: 'Tag', personnages: 'Personnage', oeuvres: 'Œuvre', sagas: 'Saga' };

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
  check = null;
  const s = await api('/api/booru/status').catch(() => ({ connected: false }));
  $('booruForm').innerHTML = s.connected ? form(e) : `<p>${esc(t('Connecte-toi à Chaos Tools pour envoyer tes exports sur ChaosBooru.'))}</p>
    <div class="booru-editor-footer"><span></span><button type="button" class="booru-primary" data-dialog="settingsDlg">${esc(t('Ouvrir les réglages'))}</button></div>`;
  openDialog('booruDlg');
  if (s.connected) { renderPicked(); search(''); analyse(); $('booruTitle').focus(); }
}

// Même structure que l'éditeur de contribution du site : média à gauche, classement à droite, pied avec les actions.
function form(e) {
  // Comme le site : titre tiré du nom du fichier exporté (sans les numéros d'images du modèle par défaut).
  const title = e.file.replace(/\.[^.]+$/, '').replace(/-\d+-\d+$/, '').replace(/_/g, ' ').trim().slice(0, 120);
  return `<div class="booru-editor">
    <div class="booru-upload-panel">
      <img class="booru-preview" src="/out/${esc(e.id)}?v=${esc(e.date)}" alt="">
      <p class="booru-help">${esc(e.file)}${e.bytes ? ` · ${fmtBytes(e.bytes)}` : ''}</p>
      <div id="booruCheck"></div>
    </div>
    <div class="booru-form">
      <label>${esc(t('Titre'))} <input id="booruTitle" maxlength="120" value="${esc(title)}"></label>
      <label>${esc(t('Description'))} <textarea id="booruDesc" maxlength="2000"></textarea></label>
      <label>${esc(t('Support'))} <select id="booruSupport">${SUPPORTS.map(([v, l]) => `<option value="${v}">${esc(t(l))}</option>`).join('')}</select></label>
      <label>${esc(t('Tags, personnages, œuvres, sagas'))} <input id="booruSearch" placeholder="${esc(t('Rechercher…'))}" autocomplete="off"></label>
      <div id="booruResults" class="booru-picker"></div>
      <section class="booru-assistance">
        <h5 id="booruPickedTitle"></h5>
        <div id="booruPicked" class="booru-assistance-chips"></div>
        <div id="booruSuggest"></div>
      </section>
      <label><input type="checkbox" id="booruSpoiler"> ${esc(t('Spoiler'))}</label>
    </div>
  </div>
  <div class="booru-editor-footer">
    <span class="booru-help">${esc(t('Une contribution soumise passe par la modération de ChaosBooru.'))}</span>
    <div>
      <button type="button" id="booruDraft">${esc(t('Enregistrer le brouillon'))}</button>
      <button type="button" id="booruSend" class="booru-primary">${esc(t('Soumettre à la modération'))}</button>
    </div>
  </div>`;
}

const kindLabel = (c) => (c.kind === 'tags' ? '' : ` <small>${esc(t(KIND[c.kind]))}</small>`);
function renderPicked() {
  const auto = (check?.automatic || []).filter((c) => !picked.has(c.id));
  const tags = [...picked.values(), ...auto].filter((c) => c.kind === 'tags').length;
  $('booruPickedTitle').textContent = t('Tags sélectionnés ({n}/30)', { n: tags });
  $('booruPicked').innerHTML = [
    ...[...picked.values()].map((c) => `<span class="booru-assistance-chip"><span>${esc(c.name)}${kindLabel(c)}</span><button type="button" data-drop="${c.id}" aria-label="${esc(t('Retirer'))} ${esc(c.name)}">×</button></span>`),
    ...auto.map((c) => `<span class="booru-assistance-chip" title="${esc(t('Ajouté automatiquement par ChaosBooru'))}"><span>${esc(c.name)} <small>Auto</small></span></span>`),
  ].join('') || `<span class="booru-help">${esc(t('Aucun tag sélectionné.'))}</span>`;
}

let results = [];
async function search(q) {
  try {
    results = (await api(`/api/booru/catalogue?q=${encodeURIComponent(q)}`)).items;
    $('booruResults').innerHTML = results.filter((c) => !picked.has(c.id)).slice(0, 24).map((c) => `<button type="button" data-add="${c.id}"${c.group ? ` title="${esc(c.group)}"` : ''}>${esc(c.name)}${kindLabel(c)}</button>`).join('')
      || `<span class="booru-help">${esc(t('Aucun résultat.'))}</span>`;
  } catch (e) { $('booruResults').innerHTML = `<span class="booru-field-error">${esc(e.message)}</span>`; }
}

// Analyse du site (/classement/apercu) : tags ajoutés d'office, suggestions, ce qui manque.
let check = null;
let checkSeq = 0;
const formBody = () => ({
  title: $('booruTitle').value.trim(), description: $('booruDesc').value.trim(), support: $('booruSupport').value,
  spoiler: $('booruSpoiler').checked, entities: [...picked.keys()],
});
async function analyse() {
  const seq = ++checkSeq;
  try {
    const p = await api(`/api/history/${entry.id}/booru/preview`, formBody());
    if (seq !== checkSeq || !$('booruCheck')) return;
    check = p;
    renderPicked();
    const suggestions = p.suggestions.filter((c) => !picked.has(c.id));
    $('booruSuggest').innerHTML = suggestions.length ? `<h5>${esc(t('Suggestions'))}</h5>${suggestions.map((c) => `<div class="booru-assistance-suggestion"><div><strong>${esc(c.name)}</strong><small>${esc(t(KIND[c.kind]))}</small></div><button type="button" data-add="${c.id}">${esc(t('Ajouter'))}</button></div>`).join('')}` : '';
    const errors = Object.values(p.fields);
    $('booruCheck').innerHTML = [
      errors.length ? `<span class="booru-status booru-status--danger">${errors.map(esc).join('<br>')}</span>` : `<span class="booru-status booru-status--success">${esc(t('Prêt à soumettre'))}</span>`,
      p.imposedSupport && p.imposedSupport !== $('booruSupport').value ? `<p class="booru-help">${esc(t('Support imposé par l’œuvre : {s}', { s: t((SUPPORTS.find(([v]) => v === p.imposedSupport) || [, p.imposedSupport])[1]) }))}</p>` : '',
    ].join('');
  } catch (e) { if (seq === checkSeq && $('booruCheck')) $('booruCheck').innerHTML = `<span class="booru-status booru-status--danger">${esc(e.message)}</span>`; }
}
const analyseSoon = debounce(analyse, 400);

$('booruForm').addEventListener('input', debounce((e) => { if (e.target.id === 'booruSearch') search(e.target.value); }, 250));
$('booruForm').addEventListener('input', (e) => { if (e.target.id !== 'booruSearch') analyseSoon(); });
$('booruForm').addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') analyseSoon(); });
$('booruForm').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]');
  const drop = e.target.closest('[data-drop]');
  if (add) { const c = [...results, ...(check?.suggestions || [])].find((x) => x.id === Number(add.dataset.add)); if (c) picked.set(c.id, c); }
  if (drop) picked.delete(Number(drop.dataset.drop));
  if (add || drop) { renderPicked(); search($('booruSearch').value); analyseSoon(); return; }
  if (e.target.id === 'booruSend') send(true);
  if (e.target.id === 'booruDraft') send(false);
});

async function send(submit) {
  const body = { ...formBody(), submit };
  if (body.title.length < 3) return toast(t('Indique un titre d’au moins 3 caractères'), 'error');
  // Le serveur refait l'analyse : on bloque seulement ce qu'elle a déjà refusé.
  if (body.submit && check && Object.keys(check.fields).length) return toast(Object.values(check.fields).join(' '), 'error');
  for (const id of ['booruSend', 'booruDraft']) $(id).disabled = true;
  try {
    const r = await api(`/api/history/${entry.id}/booru`, body);
    const res = await waitJob(r.job, 'ChaosBooru');
    $('booruDlg').close();
    toast(res.state === 'pending' ? t('Envoyé sur ChaosBooru : en attente de modération') : res.state === 'approved' ? t('Publié sur ChaosBooru') : t('Brouillon créé sur ChaosBooru'), 'ok', 6000);
    window.open(res.url, '_blank', 'noopener');
  } catch (e) { fail(e); } finally { for (const id of ['booruSend', 'booruDraft']) if ($(id)) $(id).disabled = false; }
}
