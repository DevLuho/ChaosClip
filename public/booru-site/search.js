// Copié de Chaos Tools (public/js/utils/chaosbooru-search.js).
/** Fonctions pures partagées par les recherches et les sélecteurs. */
export const foldBooru = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[_\s-]+/g, ' ').trim();
export const booruSearchTerms = query => String(query || '').split(',').map(foldBooru).filter(Boolean);
/** Les expressions séparées par une virgule sont des alternatives. */
export function matchesBooruSearch(text, query) {
  const terms = booruSearchTerms(query), value = foldBooru(text);
  return !terms.length || terms.some(term => value.includes(term));
}
