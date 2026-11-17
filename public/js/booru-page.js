// Page d'édition ChaosBooru (dans la fenêtre de ChaosClip) : même rendu et mêmes règles que l'éditeur du site.
import { renderBooruEditor, booruIcon, setBooruSite, SUPPORTS } from '../booru-site/view.js';
import { bindBooruClassification } from '../booru-site/classification.js';
import { bindBooruAssistance } from '../booru-site/assistance.js';
import { esc } from '../booru-site/esc.js';

const host = window.parent.booruHost; // fourni par js/booru.js : { entry, send, close, openSettings }
const entry = host.entry;
const root = document.getElementById('root');

async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ChaosClip': '1' }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

const shell = (content) => `<section class="booru">
  <header class="booru-header"><div class="booru-brand"><button class="booru-back" type="button" data-back aria-label="Retour à ChaosClip" title="Retour à ChaosClip">${booruIcon('arrow')}</button><div><h2>ChaosBooru</h2><p>Bibliothèque d’images et de GIF</p></div></div></header>
  <div class="booru-message" role="status" aria-live="polite"></div>
  <div class="booru-content">${content}</div>
</section>`;
const message = (text, isError = false) => { const el = root.querySelector('.booru-message'); el.textContent = text; el.classList.toggle('booru-message--error', isError); if (text) el.scrollIntoView({ block: 'nearest' }); };

root.addEventListener('click', (e) => {
  if (e.target.closest('[data-back]')) host.close();
  if (e.target.closest('[data-settings]')) host.openSettings();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') host.close(); });

// Comme showFieldErrors du site.
function showFieldErrors(fields) {
  root.querySelectorAll('.booru-field-error').forEach((el) => el.remove());
  root.querySelectorAll('.booru-field-invalid').forEach((el) => el.classList.remove('booru-field-invalid'));
  root.querySelectorAll('[aria-invalid]').forEach((el) => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
  let first;
  for (const [key, text] of Object.entries(fields)) {
    const input = root.querySelector(`[data-error-field="${CSS.escape(key)}"]`) || root.querySelector(`[name="${CSS.escape(key)}"]`);
    if (!input) continue;
    const wrapper = input.matches('fieldset,section') ? input : input.closest('label') || input.parentElement;
    wrapper.classList.add('booru-field-invalid'); input.setAttribute('aria-invalid', 'true');
    const error = document.createElement('p'); error.className = 'booru-field-error'; error.id = `booru-error-${key}`; error.textContent = text;
    wrapper.append(error); input.setAttribute('aria-describedby', error.id); first ||= wrapper;
  }
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function open() {
  root.innerHTML = shell('<p class="booru-help">Chargement…</p>');
  const status = await api('/api/booru/status');
  if (!status.connected) {
    root.innerHTML = shell('<div class="booru-page-heading"><div><h3>Connexion nécessaire</h3><p class="booru-help">Connecte-toi à Chaos Tools pour envoyer tes exports sur ChaosBooru.</p></div></div><div class="booru-actions"><button type="button" class="booru-primary" data-settings>Ouvrir les réglages</button></div>');
    return;
  }
  setBooruSite(status.site);
  const catalogues = await api('/api/booru/catalogues');
  const origin = typeof entry.source?.origin === 'string' && entry.source.origin.startsWith('https://') ? entry.source.origin : '';
  // Comme le site : titre tiré du nom du fichier (sans les numéros d'images du modèle par défaut).
  const title = entry.file.replace(/\.[^.]+$/, '').replace(/-\d+-\d+$/, '').replace(/_/g, ' ').trim().slice(0, 120);
  const version = { state: 'draft', resource_state: 'private', title, description: '', origin: 'unknown', support: 'anime', source_url: origin, source_unknown: origin ? 0 : 1, credit: '', spoiler: 0, spoiler_reason: '', entities: [],
    assistance: { enabled: true, initialized: true, manualEntityIds: [], automaticTagIds: [], excludedEntityIds: [] } };
  const kb = entry.bytes ? ` · ${entry.bytes >= 1048576 ? `${(entry.bytes / 1048576).toFixed(1)} Mo` : `${Math.round(entry.bytes / 1024)} Ko`}` : '';
  root.innerHTML = shell(renderBooruEditor({ version, catalogues, supports: SUPPORTS, media: { url: `/out/${encodeURIComponent(entry.id)}?v=${entry.date}`, label: `${entry.file}${kb}` } }));

  const form = root.querySelector('[data-edit]');
  form.elements.origin.value = version.origin; form.elements.support.value = version.support;
  let assistance;
  const payload = () => ({ title: form.elements.title.value, description: form.elements.description.value, origin: form.elements.origin.value, support: form.elements.support.value, entities: [...form.querySelectorAll('[name=entity]:checked')].map((e) => Number(e.value)), sourceUrl: form.elements.sourceUrl.value, sourceUnknown: form.elements.sourceUnknown.checked, credit: form.elements.credit.value, spoiler: form.elements.spoiler.checked, spoilerReason: form.elements.spoilerReason.value, assistance: assistance.state() });
  const classification = bindBooruClassification({ form, catalogues });
  assistance = bindBooruAssistance({
    controller: { charactersComingSoon: () => false }, form, catalogues, getVersion: () => version, editable: true, changed: () => {},
    syncClassification: () => { classification.syncForcedSupport(); classification.syncWorkDependent(); },
    analyzeRequest: async (input) => ({ suggestions: [], reasons: {}, ...(await api('/api/booru/preview', input)) }),
  });
  classification.syncWorkDependent();

  // Mêmes vérifications que le bouton « Soumettre » du site.
  const check = (values, submit) => {
    const fields = {};
    if (values.title.trim().length < 3) fields.title = 'Indique un titre d’au moins 3 caractères.';
    if (!submit) return fields;
    const selected = catalogues.flatMap((list) => list.items).filter((entity) => values.entities.includes(entity.id));
    const works = selected.filter((e) => e.kind === 'oeuvres'), tags = selected.filter((e) => e.kind === 'tags'), characters = selected.filter((e) => e.kind === 'personnages'), sagas = selected.filter((e) => e.kind === 'sagas');
    if (!tags.length || tags.length > 30) fields.tags = 'Choisis entre 1 et 30 tags.';
    if ((values.origin === 'identified' ? !works.length : works.length > 0)) fields.works = values.origin === 'identified' ? 'Choisis au moins une œuvre.' : 'Choisis « Œuvre identifiée » pour associer une œuvre.';
    if (characters.length > 10 || characters.some((character) => !works.some((work) => (character.works || []).includes(work.id)))) fields.characters = 'Chaque personnage doit appartenir à une œuvre sélectionnée (10 maximum).';
    if (sagas.some((saga) => !works.some((work) => (saga.works || []).includes(work.id)))) fields.sagas = 'Chaque saga doit appartenir à une œuvre sélectionnée (optionnel).';
    const { forced, exclusive } = classification.getSupportConstraint();
    if (exclusive && forced.length > 1 && !forced.includes(values.support)) fields.support = 'Choisis un support compatible avec les œuvres sélectionnées.';
    if (Boolean(values.sourceUrl.trim()) === values.sourceUnknown || !form.elements.sourceUrl.validity.valid || (values.sourceUrl && !values.sourceUrl.startsWith('https://'))) fields.sourceUrl = 'Renseigne une source HTTPS ou coche « Source inconnue ».';
    return fields;
  };
  const buttons = [...root.querySelectorAll('[data-submit], [data-edit] button[type=submit]')];
  const send = async (submit) => {
    message('');
    await assistance.flush();
    const values = payload();
    const fields = check(values, submit);
    showFieldErrors(fields);
    if (Object.keys(fields).length) return message(submit ? 'Corrige les champs indiqués avant de soumettre la ressource.' : 'Corrige les champs indiqués avant d’enregistrer le brouillon.', true);
    buttons.forEach((b) => { b.disabled = true; });
    message(submit ? 'Envoi sur ChaosBooru…' : 'Enregistrement du brouillon…');
    try { await host.send({ ...values, submit }); } catch (e) { message(e.message, true); } finally { buttons.forEach((b) => { b.disabled = false; }); }
  };
  form.onsubmit = (e) => { e.preventDefault(); send(false); };
  root.querySelector('[data-submit]').onclick = () => send(true);
  form.elements.title.focus();
}

open().catch((e) => { root.innerHTML = shell(`<p class="booru-message booru-message--error">${esc(e.message)}</p>`); });
