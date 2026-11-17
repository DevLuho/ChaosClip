// Copié tel quel de Chaos Tools (public/js/controllers/chaosbooru-assistance.controller.js).
import { esc } from './esc.js';

/** Le serveur possède les règles ; le formulaire ne gère que les décisions humaines. */
export function bindBooruAssistance({ controller, form, catalogues, versionId, getVersion, editable, changed, syncClassification, analyzeRequest, analysisFields, onManualKeep = () => {}, onAnalysis = () => {}, onAnalysisError = () => {} }) {
  const all = catalogues.flatMap(catalogue => catalogue.items);
  const byId = new Map(all.map(entity => [entity.id, entity]));
  const charactersComingSoon = Boolean(controller.charactersComingSoon?.());
  const section = document.createElement('section');
  section.className = 'booru-assistance';
  section.innerHTML = '<h4>Assistance au classement</h4><label><input type="checkbox" data-assistance-enabled> Ajouter automatiquement les tags évidents</label><p class="booru-help">Les tags du titre peuvent être ajoutés automatiquement. Les autres propositions restent à ton choix.</p><div data-assistance-results></div><p class="booru-help" data-assistance-announcement role="status" aria-atomic="true"></p><p class="booru-help" data-assistance-status role="status"></p><button type="button" data-assistance-retry hidden>Réessayer l’analyse</button>';
  form.querySelector('.booru-form-section:nth-child(2) [data-error-field]')?.before(section);
  const results = section.querySelector('[data-assistance-results]'), status = section.querySelector('[data-assistance-status]');
  const toggle = section.querySelector('[data-assistance-enabled]'), retry = section.querySelector('[data-assistance-retry]');
  const announcement = section.querySelector('[data-assistance-announcement]');
  const workChoices = new Map();
  let renderedMarkup;
  let state = structuredClone(getVersion().assistance), latest = { suggestions: [], reasons: {} }, timer, generation = 0, disposed = false, flushing = null;
  const requests = new Set();
  const fieldsToAnalyze = new Set(analysisFields || ['title', 'description', 'support', 'entity']);
  const selected = () => [...form.querySelectorAll('[name=entity]:checked')].map(input => Number(input.value));
  const checkbox = id => form.querySelector(`[name=entity][value="${id}"]`);
  const snapshot = () => ({ title: form.elements.title.value, description: form.elements.description.value, origin: form.elements.origin?.value, support: form.elements.support.value, sourceUrl: form.elements.sourceUrl?.value || '', sourceUnknown: form.elements.sourceUnknown?.checked ?? true, credit: form.elements.credit?.value || '', spoiler: form.elements.spoiler?.checked ?? false, spoilerReason: form.elements.spoilerReason?.value || '', entities: selected(), assistance: structuredClone(state) });
  const schedule = () => { generation++; clearTimeout(timer); timer = setTimeout(() => analyze(), 300); };
  const manual = (id, checked) => {
    state.automaticTagIds = state.automaticTagIds.filter(value => value !== id);
    state.manualEntityIds = state.manualEntityIds.filter(value => value !== id);
    state.excludedEntityIds = state.excludedEntityIds.filter(value => value !== id);
    if (checked) state.manualEntityIds.push(id);
    else state.excludedEntityIds.push(id);
  };
  const choose = id => {
    const input = checkbox(id);
    if (!input) return;
    input.checked = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const render = () => {
    toggle.checked = state.enabled;
    for (const input of results.querySelectorAll('[data-suggestion-work]')) workChoices.set(input.dataset.suggestionWork, input.value);
    const focused = results.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.hasAttribute('data-suggestion-work') ? `[data-suggestion-work="${focused.dataset.suggestionWork}"]`
      : focused?.hasAttribute('data-assistance-action') ? `[data-assistance-action="${focused.dataset.assistanceAction}"]`
        : focused?.matches('[data-assistance-excluded] summary') ? '[data-assistance-excluded] summary' : null;
    const chips = selected().filter(id => byId.get(id)?.kind === 'tags').map(id => {
      const automatic = state.automaticTagIds.includes(id), entity = byId.get(id);
      const reason = (latest.reasons[id] || []).join(' · ');
      return `<span class="booru-assistance-chip" title="${esc(reason)}"><span>${esc(entity.name)}${automatic ? ' <small>Auto</small>' : ''}</span>${automatic ? `<button type="button" data-keep="${id}" data-assistance-action="keep-${id}" aria-label="Garder le tag ${esc(entity.name)}">Garder</button>` : ''}<button type="button" data-remove="${id}" data-assistance-action="remove-${id}" aria-label="Retirer le tag ${esc(entity.name)}">×</button>${automatic && reason ? `<small class="booru-assistance-reason">${esc(reason)}</small>` : ''}</span>`;
    }).join('');
    const suggestions = latest.suggestions.filter(item => !selected().includes(item.entityId) && !state.excludedEntityIds.includes(item.entityId));
    const groups = [['tags', 'Tags proposés'], ['personnages', 'Personnages proposés'], ['oeuvres', 'Œuvres proposées'], ['sagas', 'Sagas proposées']].map(([kind, label]) => {
      if (kind === 'personnages' && charactersComingSoon) return '';
      const items = suggestions.filter(item => item.kind === kind);
      if (!items.length) return '';
      return `<div class="booru-assistance-group"><h5>${label}</h5>${items.map(item => {
        const works = (item.works || []).map(id => byId.get(id)).filter(work => work?.state === 'active');
        const compatible = works.some(work => selected().includes(work.id));
        const needsWork = ['personnages', 'sagas'].includes(kind) && !compatible;
        const choices = needsWork && works.length > 1 ? `<label>Œuvre pour ${esc(item.name)}<select data-suggestion-work="${item.entityId}"><option value="">Choisir une œuvre…</option>${works.map(work => `<option value="${work.id}">${esc(work.name)}</option>`).join('')}</select></label>` : '';
        const characterOnly = kind === 'personnages' && needsWork ? `<button type="button" data-add-character="${item.entityId}" data-assistance-action="character-${item.entityId}">Ajouter le personnage seul</button>` : '';
        return `<div class="booru-assistance-suggestion"><div><strong>${esc(item.name)}</strong><small>${esc(item.reason)}${item.limitReached ? ' · Limite de 30 tags atteinte.' : ''}</small>${choices}</div><div class="booru-assistance-actions"><button type="button" data-add="${item.entityId}" data-assistance-action="add-${item.entityId}" ${item.limitReached || (needsWork && !works.length) ? 'disabled' : ''}>${needsWork ? 'Ajouter avec son œuvre' : 'Ajouter'}</button>${characterOnly}</div></div>`;
      }).join('')}</div>`;
    }).join('');
    const excluded = state.excludedEntityIds.map(id => byId.get(id)).filter(entity => entity && !(charactersComingSoon && entity.kind === 'personnages'));
    const open = results.querySelector('[data-assistance-excluded]')?.open;
    const excludedRows = excluded.map(entity => {
      const works = (entity.works || []).map(id => byId.get(id)).filter(work => work?.state === 'active');
      const choice = entity.kind === 'sagas' && works.length > 1 && !works.some(work => selected().includes(work.id)) ? `<label>Œuvre pour ${esc(entity.name)}<select data-suggestion-work="${entity.id}"><option value="">Choisir une œuvre…</option>${works.map(work => `<option value="${work.id}">${esc(work.name)}</option>`).join('')}</select></label>` : '';
      return `<div class="booru-assistance-suggestion"><div><span>${esc(entity.name)}</span>${choice}</div><button type="button" data-restore="${entity.id}" data-assistance-action="restore-${entity.id}">Rétablir</button></div>`;
    }).join('');
    const markup = `<h5>Tags sélectionnés (${selected().filter(id => byId.get(id)?.kind === 'tags').length}/30)</h5><div class="booru-assistance-chips">${chips || '<span class="booru-help">Aucun tag sélectionné.</span>'}</div>${groups}${excluded.length ? `<details data-assistance-excluded><summary>Choix écartés (${excluded.length})</summary>${excludedRows}</details>` : ''}`;
    // Une réponse identique garde les nœuds, notamment une liste native ouverte.
    if (markup === renderedMarkup) return;
    const scrollPositions = [];
    for (let parent = results; parent; parent = parent.parentElement) scrollPositions.push([parent, parent.scrollLeft, parent.scrollTop]);
    const pagePosition = [window.scrollX, window.scrollY];
    results.innerHTML = markup;
    renderedMarkup = markup;
    const excludedDetails = results.querySelector('[data-assistance-excluded]');
    if (excludedDetails) excludedDetails.open = Boolean(open);
    for (const input of results.querySelectorAll('[data-suggestion-work]')) {
      const value = workChoices.get(input.dataset.suggestionWork);
      if ([...input.options].some(option => option.value === value)) input.value = value;
    }
    if (focused) {
      const actionId = focused.dataset.suggestionWork || focused.dataset.assistanceAction?.split('-').pop();
      const fallback = actionId && results.querySelector(`[data-remove="${actionId}"], [data-restore="${actionId}"], [data-add="${actionId}"]`);
      (focusKey && results.querySelector(focusKey) || fallback || toggle).focus({ preventScroll: true });
    }
    for (const [parent, left, top] of scrollPositions) { parent.scrollLeft = left; parent.scrollTop = top; }
    window.scrollTo({ left: pagePosition[0], top: pagePosition[1], behavior: 'instant' });
  };
  const analyze = async () => {
    clearTimeout(timer);
    const ticket = ++generation, input = snapshot();
    const request = new AbortController();
    requests.add(request);
    // L’analyse injectable du lot gère son délai après l’attente d’une place.
    const timeout = analyzeRequest ? null : setTimeout(() => request.abort(), 8000);
    try {
      let result;
      if (analyzeRequest) result = await analyzeRequest(input, { signal: request.signal });
      else {
        const id = typeof versionId === 'function' ? await versionId() : versionId;
        if (!id || disposed) return true;
        result = await controller.api(`/versions/${id}/analyser`, 'POST', input, { signal: request.signal });
      }
      if (disposed || ticket !== generation || JSON.stringify(snapshot()) !== JSON.stringify(input)) return false;
      const before = JSON.stringify(input);
      latest = result;
      onAnalysis(result);
      if (editable) {
        state = result.assistance;
        for (const input of form.querySelectorAll('[name=entity]')) input.checked = result.entities.includes(Number(input.value));
        syncClassification();
      }
      retry.hidden = true; status.textContent = '';
      render();
      const added = (result.changes?.added || []).filter(id => result.assistance.automaticTagIds.includes(id));
      if (editable && added.length) announcement.textContent = `${added.length} tag${added.length > 1 ? 's' : ''} ajouté${added.length > 1 ? 's' : ''} automatiquement : ${added.map(id => byId.get(id)?.name).filter(Boolean).join(', ')}.`;
      if (JSON.stringify(snapshot()) !== before && editable) changed();
      return true;
    } catch {
      if (disposed || ticket !== generation) return false;
      onAnalysisError();
      status.textContent = 'Analyse indisponible. Tu peux continuer à classer manuellement.';
      retry.hidden = false;
      return true;
    } finally {
      clearTimeout(timeout); requests.delete(request);
    }
  };
  const flush = () => {
    if (!flushing) flushing = (async () => {
      // Une frappe invalide la réponse ; les sauvegardes simultanées partagent cette attente.
      while (!disposed && !(await analyze())) { /* attendre le texte courant */ }
    })().finally(() => { flushing = null; });
    return flushing;
  };
  const inputHandler = event => {
    if (!editable || event.target.matches?.('[data-editor-search]') || section.contains(event.target)) return;
    if (event.target.name === 'title') { if (!state.initialized) { state.enabled = true; state.initialized = true; } }
    if (event.target.name === 'entity') manual(Number(event.target.value), event.target.checked);
    generation++;
    if (fieldsToAnalyze.has(event.target.name)) schedule();
    render();
  };
  form.addEventListener('input', inputHandler);
  toggle.onchange = () => {
    state.enabled = toggle.checked; state.initialized = true;
    if (!state.enabled) { state.automaticTagIds.forEach(id => onManualKeep(id));state.manualEntityIds = [...new Set([...state.manualEntityIds, ...selected()])]; state.automaticTagIds = []; }
    changed(); schedule(); render();
  };
  retry.onclick = () => analyze();
  results.onclick = event => {
    const button = event.target.closest('button');
    if (!button || !editable) return;
    const id = Number(button.dataset.remove || button.dataset.keep || button.dataset.add || button.dataset.addCharacter || button.dataset.restore);
    if (button.dataset.remove) { const input = checkbox(id); input.checked = false; input.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (button.dataset.keep) { manual(id, true); onManualKeep(id); changed(); schedule(); }
    else {
      const entity = byId.get(id);
      if (entity.kind === 'tags' && selected().filter(id => byId.get(id)?.kind === 'tags').length >= 30) { status.textContent = 'Limite de 30 tags atteinte. Retire un tag avant cet ajout.'; return; }
      const limit = entity.kind === 'personnages' ? 10 : Infinity;
      if (entity.kind !== 'tags' && selected().filter(id => byId.get(id)?.kind === entity.kind).length >= limit) { status.textContent = `Limite de ${limit} entrées atteinte pour ce catalogue.`; return; }
      const works = (entity.works || []).filter(id => byId.get(id)?.state === 'active');
      const addWork = entity.kind === 'sagas' || entity.kind === 'personnages' && Boolean(button.dataset.add);
      if (addWork && !works.some(id => selected().includes(id))) {
        const workId = works.length === 1 ? works[0] : Number(results.querySelector(`[data-suggestion-work="${id}"]`)?.value);
        if (!workId) { status.textContent = 'Choisis une œuvre compatible avant cet ajout.'; return; }
        choose(workId);
      }
      choose(id);
      status.textContent = '';
    }
    render();
  };
  render();
  analyze();
  return { state: () => structuredClone(state), flush, schedule,
    applyManualSelection(entityIds) {
      if (charactersComingSoon) entityIds = [...new Set([...entityIds.filter(id => byId.get(id)?.kind !== 'personnages'), ...selected().filter(id => byId.get(id)?.kind === 'personnages')])];
      state = { ...state, initialized: true, manualEntityIds: [...entityIds], automaticTagIds: [], excludedEntityIds: [] };
      for (const input of form.querySelectorAll('[name=entity]')) input.checked = entityIds.includes(Number(input.value));
      syncClassification(); changed(); schedule(); render();
    },
    acceptSaved(result) {
      state = structuredClone(result.assistance);
      for (const input of form.querySelectorAll('[name=entity]')) input.checked = result.entities.some(entity => entity.id === Number(input.value));
      syncClassification(); render();
    },
    dispose() { disposed = true; generation++; clearTimeout(timer); requests.forEach(request => request.abort()); form.removeEventListener('input', inputHandler); } };
}
