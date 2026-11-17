// Copié tel quel de Chaos Tools (public/js/controllers/chaosbooru-classification.controller.js).
import { matchesBooruSearch } from './search.js';

/** Règles de sélection partagées par l’éditeur individuel et l’éditeur du lot. */
export function bindBooruClassification({ form, catalogues, entityName = 'entity', supportName = 'support', originName = 'origin', onDependentRemoval = () => {} }) {
  const entities = catalogues.flatMap(catalogue => catalogue.items);
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const entitySelector = `[name="${entityName}"]`;
  const selectedWorks = () => new Set([...form.querySelectorAll(`[data-error-field=works] ${entitySelector}:checked`)].map(input => Number(input.value)));
  const getSupportConstraint = () => {
    const works = (catalogues[0]?.items || []).filter(work => selectedWorks().has(work.id));
    const forced = [...new Set(works.map(work => work.support).filter(Boolean))];
    return { forced, exclusive: works.length > 0 && works.every(work => work.support), selectedWorks: works };
  };
  const syncForcedSupport = () => {
    const select = supportName ? form.querySelector(`[name="${supportName}"]`) : null, help = form.querySelector('[data-support-forced]');
    if (!select) return false;
    const { forced, exclusive, selectedWorks: works } = getSupportConstraint(), previous = select.value;
    if (!exclusive || !forced.length) {
      select.disabled = false;
      for (const option of select.options) option.hidden = false;
      if (help) { help.hidden = true;help.textContent = ''; }
    } else if (forced.length === 1) {
      select.value = forced[0];select.disabled = true;
      for (const option of select.options) option.hidden = false;
      const names = works.filter(work => work.support === forced[0]).map(work => work.name);
      if (help) { help.hidden = false;help.textContent = names.length === 1 ? `Support imposé par l’œuvre « ${names[0]} ».` : 'Support imposé par les œuvres sélectionnées.'; }
    } else {
      select.disabled = false;
      for (const option of select.options) option.hidden = !forced.includes(option.value);
      if (!forced.includes(select.value)) select.value = forced[0];
      if (help) { help.hidden = false;help.textContent = 'Choisis parmi les supports des œuvres sélectionnées.'; }
    }
    return select.value !== previous;
  };
  const syncWorkDependent = () => {
    const works = selectedWorks();
    const removed = { sagas: 0, personnages: 0 };
    const removeDependent = input => {
      const entity = byId.get(Number(input.value));
      if (entity && Object.hasOwn(removed, entity.kind)) removed[entity.kind]++;
      input.checked = false;
      onDependentRemoval(Number(input.value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    form.querySelectorAll('[data-work-dependent]').forEach(fieldset => {
      const search = fieldset.querySelector('[data-editor-search]')?.value || '';
      let visible = 0;
      fieldset.querySelectorAll('.booru-picker > label[data-works]').forEach(label => {
        const ids = label.dataset.works.split(',').map(Number), input = label.querySelector(entitySelector);
        const matchesWork = fieldset.dataset.workDependent === 'personnages' || works.size > 0 && ids.some(id => works.has(id));
        const matchesSearch = matchesBooruSearch(label.dataset.entitySearch || label.textContent, search);
        if (!matchesWork && input.checked) removeDependent(input);
        label.hidden = !matchesWork || !matchesSearch;
        if (matchesWork && matchesSearch) visible += 1;
      });
      const empty = fieldset.querySelector('[data-work-dependent-empty]');
      if (empty) {
        empty.hidden = visible > 0 || fieldset.querySelectorAll('.booru-picker > label[data-works]').length === 0;
        empty.textContent = fieldset.dataset.workDependent === 'personnages' ? 'Aucun personnage ne correspond à cette recherche.' : works.size
          ? fieldset.dataset.workDependent === 'sagas' ? 'Aucune saga pour les œuvres sélectionnées.' : 'Aucun personnage pour les œuvres sélectionnées.'
          : fieldset.dataset.workDependent === 'sagas' ? 'Sélectionne une œuvre pour voir ses sagas.' : 'Sélectionne une œuvre pour voir ses personnages.';
      }
    });
    const status = form.querySelector('[data-classification-status]');
    if (status && (removed.sagas || removed.personnages)) {
      const labels = [removed.sagas && `${removed.sagas} saga${removed.sagas === 1 ? '' : 's'}`, removed.personnages && `${removed.personnages} personnage${removed.personnages === 1 ? '' : 's'}`].filter(Boolean).join(' et ');
      status.textContent = `${labels} retiré${removed.sagas + removed.personnages === 1 ? '' : 's'} car ${removed.sagas + removed.personnages === 1 ? 'il ne correspond plus' : 'ils ne correspondent plus'} aux œuvres sélectionnées.`;
    }
  };
  const searchPicker = input => {
    const fieldset = input.closest('fieldset');
    if (fieldset.matches('[data-work-dependent]')) { syncWorkDependent();return; }
    const value = input.value;
    fieldset.querySelectorAll('.booru-picker label').forEach(label => { label.hidden = !matchesBooruSearch(label.dataset.entitySearch || label.textContent, value); });
    fieldset.querySelectorAll('[data-tag-group]').forEach(group => {
      group.hidden = ![...group.querySelectorAll('label')].some(label => !label.hidden);
      if (value && !group.hidden) group.open = true;
    });
  };
  const onInput = event => {
    if (event.target.matches?.('[data-editor-search]')) { searchPicker(event.target);return; }
    if (!event.target.matches?.(entitySelector)) return;
    const id = Number(event.target.value), entity = byId.get(id);
    const origin = originName ? form.querySelector(`[name="${originName}"]`) : null;
    if (event.target.checked && entity?.kind === 'oeuvres' && origin) origin.value = 'identified';
    syncForcedSupport();syncWorkDependent();
  };
  form.addEventListener('input', onInput, true);
  syncForcedSupport();syncWorkDependent();
  return { getSupportConstraint, syncForcedSupport, syncWorkDependent, dispose: () => form.removeEventListener('input', onInput, true) };
}
