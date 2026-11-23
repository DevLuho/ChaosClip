// Page d'édition ChaosBooru (dans la fenêtre de ChaosClip) : même rendu et mêmes règles que l'éditeur du site.
const host = window.parent.booruHost; // fourni par js/booru.js : { entry, send, close, openSettings }
const entry = host.entry;
const root = document.getElementById('root');

// Le rendu des champs et leurs règles sont le code du site lui-même, servi par le miroir /site (lib/site.js) :
// un changement de l'éditeur sur Chaos Tools arrive ici sans nouvelle version de ChaosClip.
// Seul le panneau « média » (renderEditor, plus bas) est propre à ChaosClip : le fichier vient de l'export.
const SITE = '/site/js';
const [{ renderBooruEditorFields, booruIcon, SUPPORTS }, { bindBooruClassification }, { bindBooruAssistance }, { esc }, nexusModule, framesModule] = await Promise.all([
  import(`${SITE}/views/chaosbooru.view.js`),
  import(`${SITE}/controllers/chaosbooru-classification.controller.js`),
  import(`${SITE}/controllers/chaosbooru-assistance.controller.js`),
  import(`${SITE}/utils/escape-html.js`),
  // ChaosBoo, l'assistant du site : facultatif, l'éditeur fonctionne sans lui.
  import(`${SITE}/controllers/chaosbooru-nexus.controller.js`).catch(() => null),
  import(`${SITE}/utils/booru-nexus-frames.mjs`).catch(() => null),
]).catch((error) => {
  root.innerHTML = '<p style="padding:1rem">Chaos Tools ne répond pas : la page ChaosBooru n’a pas pu être chargée. Vérifie ta connexion, puis rouvre cette fenêtre.</p><button type="button" style="margin:0 1rem">Fermer</button>';
  root.querySelector('button').addEventListener('click', () => host.close());
  throw error;
});

function renderEditor({ version, catalogues, supports, media }) {
  return `<div class="booru-page-heading"><div><h3>${esc(version.title || 'Nouvelle ressource')}</h3><p class="booru-help">Ajoute ton média, puis les informations qui permettront de le retrouver.</p></div><span class="booru-status booru-status--draft">Brouillon</span></div>
    <p class="booru-review-state" role="note">${booruIcon('image')}<span>Avant d’importer, vérifie que cette image n’existe pas déjà dans ChaosBooru — les doublons seront refusés à la publication.</span></p>
    <div class="booru-editor">
      <section class="booru-upload-panel" data-error-field="media" aria-label="Média"><h4>${booruIcon('image')} Image ou GIF</h4>
        <div class="booru-upload-preview"><img class="booru-preview" src="${esc(media.url)}" alt="Aperçu privé"></div>
        <div class="booru-file-row"><span class="booru-file-status">${esc(media.label)}</span></div>
        <p class="booru-help">Le fichier exporté par ChaosClip est envoyé à l’enregistrement du brouillon ou à la soumission.</p>
        <p class="booru-help">Le média reste privé jusqu’à sa validation par la modération.</p>
      </section>
      <form data-edit><fieldset>
        ${renderBooruEditorFields({ version, catalogues, supports })}
        <div class="booru-actions"><button type="submit">Enregistrer le brouillon</button><span class="booru-help">Le brouillon est créé sur ChaosBooru, où tu peux le reprendre.</span></div>
      </fieldset></form>
    </div>
    <div class="booru-editor-footer"><p class="booru-help">Vérifie le fichier et son classement avant de l’envoyer.</p><div class="booru-actions"><button type="button" class="booru-primary" data-submit>Soumettre à la modération</button></div></div>`;
}

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

// Appel à ChaosBoo par ChaosClip, qui garde la connexion au site : même forme de réponse et d'erreur que l'api() du site.
async function nexusApi(body) {
  const r = await fetch('/api/booru/nexus', body ? { method: 'POST', headers: { 'X-ChaosClip': '1' }, body } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Erreur ${r.status}`), { status: r.status, code: data.code });
  return data;
}

// Le panneau du site lui-même. Le fichier n'est pas encore sur ChaosBooru : comme l'import en lot du site,
// la page réduit l'export (ou les instants marquants d'une animation) et en donne l'empreinte, qui permet
// au site de reprendre cette analyse sans la repayer une fois le fichier envoyé.
function mountChaosBoo(form, catalogues) {
  const exported = async () => {
    const blob = await (await fetch(`/out/${encodeURIComponent(entry.id)}?v=${entry.date}`)).blob();
    return new File([blob], entry.file, { type: blob.type });
  };
  nexusModule.bindChaosNexus({
    controller: { api: () => nexusApi() }, form, catalogues, editable: true, hasMedia: () => true, host: root.querySelector('.booru'),
    analyse: async () => {
      const file = await exported(), body = new FormData();
      for (const [position, image] of (await framesModule.nexusFrames(file)).entries()) body.append('images', image, `${position}.webp`);
      body.append('sha256', await framesModule.fileSha256(file));
      body.append('title', form.elements.title.value);
      body.append('filename', entry.file);
      return nexusApi(body);
    },
  }).catch(() => {});
}

async function open() {
  root.innerHTML = shell('<p class="booru-help">Chargement…</p>');
  const status = await api('/api/booru/status');
  if (!status.connected && !host.saveDraft) {
    root.innerHTML = shell('<div class="booru-page-heading"><div><h3>Connexion nécessaire</h3><p class="booru-help">Connecte-toi à Chaos Tools pour envoyer tes exports sur ChaosBooru.</p></div></div><div class="booru-actions"><button type="button" class="booru-primary" data-settings>Ouvrir les réglages</button></div>');
    return;
  }
  const catalogues = status.connected ? await api('/api/booru/catalogues') : Array.from({ length: 4 }, () => ({ items: [] }));
  const source = entry.source?.origin;
  const sourceUrl = typeof source === 'string' ? source : source?.url;
  const origin = /^https:\/\//i.test(sourceUrl || '') ? sourceUrl : '';
  // Comme le site : titre tiré du nom du fichier (sans les numéros d'images du modèle par défaut).
  const title = entry.file.replace(/\.[^.]+$/, '').replace(/-\d+-\d+$/, '').replace(/_/g, ' ').trim().slice(0, 120);
  const initial = host.defaults || {};
  const entities = catalogues.flatMap((list) => list.items).filter((item) => initial.entities?.includes(item.id));
  const url = initial.sourceUrl ?? origin;
  const version = { state: 'draft', resource_state: 'private', title: initial.title ?? title, description: initial.description || '',
    origin: initial.origin || (entities.some((item) => item.kind === 'oeuvres') ? 'identified' : 'unknown'), support: initial.support || 'anime',
    source_url: url, source_unknown: initial.sourceUnknown ?? !url, credit: initial.credit || '', spoiler: initial.spoiler || false,
    spoiler_reason: initial.spoilerReason || '', entities,
    assistance: { enabled: true, initialized: true, manualEntityIds: [], automaticTagIds: [], excludedEntityIds: [] } };
  if (initial.assistance) version.assistance = initial.assistance;
  else version.assistance.manualEntityIds = initial.entities || [];
  const kb = entry.bytes ? ` · ${entry.bytes >= 1048576 ? `${(entry.bytes / 1048576).toFixed(1)} Mo` : `${Math.round(entry.bytes / 1024)} Ko`}` : '';
  root.innerHTML = shell(renderEditor({ version, catalogues, supports: SUPPORTS, media: { url: `/out/${encodeURIComponent(entry.id)}?v=${entry.date}`, label: `${entry.file}${kb}` } }));
  if (!status.connected) {
    const login = document.createElement('button');
    login.type = 'button';
    login.dataset.settings = '';
    login.textContent = 'Se connecter pour transmettre la contribution';
    root.querySelector('.booru-header').append(login);
  }

  const form = root.querySelector('[data-edit]');
  form.elements.origin.value = version.origin; form.elements.support.value = version.support;
  let assistance;
  const payload = () => ({ title: form.elements.title.value, description: form.elements.description.value, origin: form.elements.origin.value, support: form.elements.support.value, entities: [...form.querySelectorAll('[name=entity]:checked')].map((e) => Number(e.value)), sourceUrl: form.elements.sourceUrl.value, sourceUnknown: form.elements.sourceUnknown.checked, credit: form.elements.credit.value, spoiler: form.elements.spoiler.checked, spoilerReason: form.elements.spoilerReason.value, assistance: assistance.state() });
  let lastValues;
  let saves = Promise.resolve();
  function saveDraft() {
    if (!host.saveDraft || !lastValues) return saves;
    const values = payload();
    if (!status.connected) {
      values.entities = lastValues.entities;
      values.assistance = lastValues.assistance;
    }
    if (form.elements.sourceUrl.value !== lastValues.sourceUrl) {
      form.elements.sourceUnknown.checked = values.sourceUnknown = !values.sourceUrl;
    }
    const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(lastValues[key])));
    if (!Object.keys(changes).length) return saves;
    lastValues = values;
    saves = saves.catch(() => {}).then(() => host.saveDraft(changes));
    saves.catch((error) => message(error.message, true));
    return saves;
  }
  const classification = bindBooruClassification({ form, catalogues });
  assistance = bindBooruAssistance({
    controller: { charactersComingSoon: () => false }, form, catalogues, getVersion: () => version, editable: true, changed: () => saveDraft(),
    syncClassification: () => { classification.syncForcedSupport(); classification.syncWorkDependent(); },
    analyzeRequest: async (input) => status.connected
      ? ({ suggestions: [], reasons: {}, ...(await api('/api/booru/preview', input)) })
      : ({ suggestions: [], reasons: {}, assistance: version.assistance }),
  });
  classification.syncWorkDependent();
  lastValues = payload();
  if (status.connected && nexusModule && framesModule) mountChaosBoo(form, catalogues);
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);

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
  const feedback = document.createElement('div');
  feedback.className = 'booru-send-feedback';
  feedback.innerHTML = '<span class="booru-send-spinner" aria-hidden="true" hidden></span><span role="status" aria-atomic="true"></span><progress max="1" aria-label="Envoi sur ChaosBooru" hidden></progress>';
  buttons.at(-1).parentElement.append(feedback);
  const [spinner, statusText, progress] = feedback.children;
  let sending = false;
  const send = async (submit) => {
    if (sending) return;
    sending = true;
    buttons.forEach((b) => b.setAttribute('aria-disabled', 'true'));
    statusText.textContent = submit ? 'Envoi sur ChaosBooru…' : 'Enregistrement du brouillon…';
    let measured = false;
    let queued = false;
    let delayed = false;
    const timer = setTimeout(() => { delayed = true; spinner.hidden = measured || queued; }, 200);
    try {
      message('');
      await assistance.flush();
      await saveDraft();
      if (!status.connected) return message('Brouillon conservé sur cet appareil. Connecte-toi pour le transmettre.');
      const values = payload();
      const fields = check(values, submit);
      showFieldErrors(fields);
      if (Object.keys(fields).length) return message(submit ? 'Corrige les champs indiqués avant de soumettre la ressource.' : 'Corrige les champs indiqués avant d’enregistrer le brouillon.', true);
      await host.send({ ...values, submit }, (job) => {
        queued = job.status === 'queued';
        measured = job.status === 'running' && job.progress > 0;
        progress.hidden = !measured;
        progress.value = measured ? job.progress : 0;
        spinner.hidden = !delayed || measured || queued;
        statusText.textContent = queued ? 'En attente…' : measured ? `Envoi sur ChaosBooru · ${Math.round(job.progress * 100)} %` : 'Envoi sur ChaosBooru…';
      });
    } catch (e) { message(e.message, true); }
    finally {
      clearTimeout(timer);
      spinner.hidden = progress.hidden = true;
      statusText.textContent = '';
      buttons.forEach((b) => b.removeAttribute('aria-disabled'));
      sending = false;
    }
  };
  if (host.opensPage) {
    const KEY = 'chaosclip.booruOpenPage';
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" data-open-page> Ouvrir la page ChaosBooru après l’envoi';
    const box = label.firstChild;
    try { box.checked = localStorage.getItem(KEY) !== '0'; } catch { box.checked = true; }
    box.addEventListener('change', () => { try { localStorage.setItem(KEY, box.checked ? '1' : '0'); } catch { /* ignoré */ } });
    root.querySelector('[data-submit]').before(label);
  }
  form.onsubmit = (e) => { e.preventDefault(); send(false); };
  root.querySelector('[data-submit]').onclick = () => send(true);
  form.elements.title.focus();
}

root.innerHTML = shell('<p role="status">Chargement du formulaire…</p>');
open().catch((e) => { root.innerHTML = shell(`<p class="booru-message booru-message--error">${esc(e.message)}</p>`); });
