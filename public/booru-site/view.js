// Rendu de l'éditeur de contribution ChaosBooru.
// Copié de Chaos Tools (public/js/views/chaosbooru.view.js) pour que la fenêtre soit la même page que sur le site :
// ne pas retoucher à la main, recopier depuis le site quand il change. Seul le panneau « média » diffère (le fichier vient de ChaosClip).
import { esc } from './esc.js';

// Logos et icônes du catalogue : relayés par ChaosClip (le site refuse leur affichage depuis une autre origine).
const API = '/api/booru/site';
export const SUPPORTS = { manga: 'Manga', anime: 'Anime', game: 'Jeu vidéo', illustration: 'Illustration', live_action: 'Prise de vue réelle', other: 'Autre', unknown: 'Inconnu' };
export const STATES = { draft: 'Brouillon' };
const PATHS = {
  arrow: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  filters: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  preferences: '<path d="M3 5h4m4 0h10M3 12h10m4 0h4M3 19h4m4 0h10"/><circle cx="9" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="19" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  pause: '<path d="M7 5h3v14H7zm7 0h3v14h-3z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  'batch-upload': '<rect x="3" y="7" width="13" height="14" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M9.5 17v-6m-3 3 3-3 3 3"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  edit: '<path d="M4 20h4L18 10l-4-4L4 16v4zm10-14 4 4"/>',
  trash: '<path d="M4 7h16m-10 4v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1zm0 0v15"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zm0 0h18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  saga: '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M15 3v5h5M8 12h8M8 16h6"/>',
  source: '<path d="m10 13 4-4M8 15l-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 8a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  star: '<path d="M12 3.2 14.7 9l6.3.9-4.5 4.4 1.1 6.3L12 17.6 6.4 20.6l1.1-6.3L3 9.9 9.3 9z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  paperclip: '<path d="m21 11-8.6 8.6a6 6 0 0 1-8.5-8.5L13 2a4 4 0 0 1 5.7 5.7l-9.1 9.1a2 2 0 0 1-2.8-2.8L15 5.8"/>',
  collection: '<rect x="7" y="7" width="14" height="14" rx="3"/><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2m7-6v6m-3-3h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  bookmark: '<path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4z"/>',
  settings: '<path d="m9 3-.6 2.2-1.8 1L4.4 6 2 10l1.6 1.6v.8L2 14l2.4 4 2.2-.2 1.8 1L9 21h6l.6-2.2 1.8-1 2.2.2 2.4-4-1.6-1.6v-.8L22 10l-2.4-4-2.2.2-1.8-1L15 3z"/><circle cx="12" cy="12" r="3"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H5a2 2 0 0 0 0 4h2M17 6h2a2 2 0 0 1 0 4h-2"/>',
};

export function booruIcon(name) {
  return `<svg class="booru-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || PATHS.image}</svg>`;
}

export function renderTagGroups(items, renderItem, options = {}) {
  const className = typeof options === 'string' ? options : (options.className || '');
  const collapsible = typeof options === 'object' && Boolean(options.collapsible);
  const groups = new Map();
  for (const item of items) {
    const key = item.family || '';
    if (!groups.has(key)) groups.set(key, { name: item.category_name || 'Sans catégorie', position: item.category_position ?? 999, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr')).map(group => {
    const body = `<div class="booru-tag-group-items">${group.items.map(renderItem).join('')}</div>`;
    if (!collapsible) {
      return `<section class="booru-tag-group ${className}" data-tag-group><h5>${esc(group.name)} <span>${group.items.length}</span></h5>${body}</section>`;
    }
    return `<details class="booru-tag-group booru-tag-group--panel ${className}" data-tag-group>
      <summary class="booru-tag-group-heading">
        <h5 class="booru-tag-group-title">${esc(group.name)}</h5>
        <span class="booru-tag-group-count">${group.items.length}</span>
        ${booruIcon('chevron')}
      </summary>
      ${body}
    </details>`;
  }).join('');
}

export function renderWorkLogo(entity, { eager = false } = {}) {
  return entity.icon_id ? `<img class="booru-work-logo" data-work-logo src="${API}/oeuvres/${entity.id}/icone?variant=original" alt="${esc(entity.name)}" loading="${eager ? 'eager' : 'lazy'}">` : `<span class="booru-work-placeholder">${booruIcon('book')}<span>Logo à ajouter</span><span class="booru-sr-only">${esc(entity.name)}</span></span>`;
}

/** Icône d’une entrée catalogue (saga, personnage…) — chemin API selon le kind. */
export function renderEntityIcon(entity, kind, { eager = false, className = 'booru-entity-icon' } = {}) {
  if (!entity?.icon_id) return '';
  if (kind === 'sagas') return `<span class="${esc(className)} booru-mini-media"><img data-entity-icon src="${API}/${kind}/${entity.id}/icone" alt="" loading="${eager ? 'eager' : 'lazy'}"></span>`;
  return `<img class="${esc(className)}" data-entity-icon src="${API}/${kind}/${entity.id}/icone" alt="" loading="${eager ? 'eager' : 'lazy'}">`;
}

export function renderBooruEditorFields({ version, catalogues, supports }) {
  const charactersComingSoon = false, batch = false, renderBooruCharactersNotice = () => '';
  const checks = (kind, items) => {
    if (kind === 'personnages' && charactersComingSoon) {
      const selected = version.entities.filter(entity => entity.kind === 'personnages');
      return renderBooruCharactersNotice() + '<div hidden data-characters-preserved>' + selected.map(entity => `<input type="checkbox" name="entity" value="${entity.id}" checked>`).join('') + '</div>';
    }
    const checkbox = e => {
      const aliases = (e.aliases || []).filter(alias => alias !== e.name);
      const search = [e.name, ...aliases].join(' ').toLocaleLowerCase('fr');
      return '<label' + (e.works?.length ? ' data-works="' + e.works.join(',') + '"' : '') + ' data-entity-search="' + esc(search) + '"><input type="checkbox" name="entity" aria-label="' + esc(e.name) + '" value="' + e.id + '" ' + (version.entities.some(x => x.id === e.id) ? 'checked' : '') + '>' + (kind === 'oeuvres' ? renderWorkLogo(e) : renderEntityIcon(e, kind, { className: 'booru-picker-entity-icon' })) + '<span>' + esc(e.name) + '</span>' + (aliases.length ? '<small class="booru-help">' + esc(aliases.join(', ')) + '</small>' : '') + '</label>';
    };
    const content = kind === 'tags' ? renderTagGroups(items, checkbox) : items.map(checkbox).join('');
    const help = kind === 'sagas' ? '<p class="booru-help">Optionnel — précise une saga de l’œuvre sélectionnée (ex. Saga Freezer).</p>' : '';
    const empty = kind === 'sagas'
      ? '<p class="booru-help" data-work-dependent-empty hidden>Sélectionne une œuvre pour voir ses sagas.</p>'
      : kind === 'personnages'
        ? '<p class="booru-help" data-work-dependent-empty hidden>Aucun personnage ne correspond à cette recherche.</p>'
        : '';
    return '<fieldset data-error-field="' + ({ oeuvres: 'works', sagas: 'sagas', personnages: 'characters', tags: 'tags' }[kind]) + '" class="booru-editor-picker"' + (kind === 'sagas' || kind === 'personnages' ? ' data-work-dependent="' + kind + '"' : '') + '><legend>' + esc({ oeuvres: 'Œuvres', sagas: 'Sagas', personnages: 'Personnages', tags: 'Tags' }[kind]) + '</legend>' + help + '<input class="booru-picker-search" type="search" data-editor-search aria-label="Rechercher dans les ' + kind + '" placeholder="Recherches séparées par une virgule…"><div class="booru-picker ' + (kind === 'tags' ? 'booru-picker--grouped' : kind === 'oeuvres' ? 'booru-work-picker' : '') + '">' + (content || '<p class="booru-help">Le catalogue est encore vide.</p>') + empty + '</div></fieldset>';
  };
  const valueAction = (key, label) => batch ? `<button type="button" class="booru-batch-inherit" data-batch-value-action="${key}">${label}</button><small class="booru-help" data-batch-value-state="${key}"></small>` : '';
  return `<section class="booru-form-section"><h4>${booruIcon('image')} Informations</h4><label>Titre<input name="title" minlength="3" maxlength="120" value="${esc(version.title || '')}" placeholder="Ex. Coup de pied de Gogeta" required></label>${valueAction('title', 'Reprendre les informations du fichier')}<label>Description<textarea name="description" maxlength="2000" placeholder="Décris la scène ou précise son contexte…">${esc(version.description || '')}</textarea></label>${valueAction('description', 'Reprendre les informations du fichier')}</section>
    <section class="booru-form-section"><h4>${booruIcon('tag')} Classement</h4><div class="booru-field-pair"><label>Origine<select name="origin"><option value="identified">Œuvre identifiée</option><option value="original">Création originale</option><option value="unknown">Œuvre inconnue</option></select>${valueAction('origin', 'Reprendre la valeur du lot')}</label><label>Support<select name="support">${Object.entries(supports).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select><small class="booru-help" data-support-forced hidden></small>${valueAction('support', 'Reprendre la valeur du lot')}</label></div>${['oeuvres', 'sagas', 'personnages', 'tags'].map((kind, index) => checks(kind, catalogues[index].items)).join('')}<p class="booru-help" data-classification-status role="status" aria-live="polite" aria-atomic="true"></p></section>
    <section class="booru-form-section"><h4>${booruIcon('source')} Source et crédit</h4><label>URL de la source<input type="url" name="sourceUrl" value="${esc(version.source_url || '')}" maxlength="2000" placeholder="Lien vers la publication d’origine"></label><label><input type="checkbox" name="sourceUnknown" ${version.source_unknown ? 'checked' : ''}> Source inconnue</label>${valueAction('sourceUrl', 'Reprendre la valeur du lot')}<label>Crédit<input name="credit" maxlength="160" value="${esc(version.credit || '')}" placeholder="Auteur ou créateur du média"></label>${valueAction('credit', 'Reprendre la valeur du lot')}<label><input type="checkbox" name="spoiler" ${version.spoiler ? 'checked' : ''}> Cette image contient un spoiler</label>${valueAction('spoiler', 'Reprendre les informations du fichier')}<label>Précision du spoiler<input name="spoilerReason" maxlength="160" value="${esc(version.spoiler_reason || '')}" placeholder="Ex. Fin de l’arc…"></label>${valueAction('spoilerReason', 'Reprendre les informations du fichier')}</section>`;
}

export function renderBooruEditor({ version, catalogues, supports, media }) {
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
