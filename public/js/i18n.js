// Traduction : le texte français sert de clé. Les textes de la page sont traduits au
// chargement en parcourant le DOM ; le code appelle t() pour les textes dynamiques.
import EN from './i18n-en.js';

let lang = 'fr';
try { lang = localStorage.getItem('chaosclip.lang') || 'fr'; } catch { /* stockage indisponible */ }

export const getLang = () => lang;

export function t(fr, vars) {
  let s = lang === 'en' ? EN[fr] || fr : fr;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    // « {n} export(s) » : le « (s) » suit le nombre. En français 0 et 1 restent au singulier, en anglais seul 1.
    if ('n' in vars) s = s.replace(/\((s|x)\)/g, (m, mark) => ((lang === 'en' ? Number(vars.n) !== 1 : Number(vars.n) > 1) ? mark : ''));
  }
  return s;
}

const ATTRS = ['title', 'placeholder', 'aria-label'];

export function translateDom(root = document.body) {
  if (lang !== 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const key = raw.trim();
    if (key && EN[key]) n.nodeValue = raw.replace(key, EN[key]);
  }
  root.querySelectorAll('*').forEach((el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && EN[v.trim()]) el.setAttribute(a, EN[v.trim()]);
    }
  });
  document.documentElement.lang = 'en';
}

export function setLang(l) {
  try { localStorage.setItem('chaosclip.lang', l); } catch { /* ignoré */ }
  location.reload();
}
