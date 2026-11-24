// Page « Importer un lot » de ChaosBooru dans la fenêtre de ChaosClip. Rien n'est refait ici : la page, son classement
// commun, ChaosBoo, ses vérifications et son envoi sont le code du site, chargé par le miroir /site (lib/site.js).
// Ce fichier la branche (connexion, appels relayés par ChaosClip) et lui remet les extraits de la série.
const host = window.parent.booruLotHost; // fourni par js/booru.js : { files, common, close, openSettings }
const root = document.getElementById('root');
const page = (content) => `<section class="booru">
  <header class="booru-header"><div class="booru-brand"><button class="booru-back" type="button" data-back aria-label="Retour à ChaosClip" title="Retour à ChaosClip">←</button><div><h2>ChaosBooru</h2><p>Bibliothèque d’images et de GIF</p></div></div></header>
  <div class="booru-content">${content}</div>
</section>`;
root.addEventListener('click', (event) => {
  if (event.target.closest('[data-back]')) host.close();
  if (event.target.closest('[data-settings]')) host.openSettings();
});

// Les appels du site visent /api/chaosbooru, sur l'origine de la page : ici, ChaosClip, qui les relaie avec la connexion
// du membre (lib/booru.js). Son serveur exige son en-tête maison sur toute écriture.
const request = window.fetch.bind(window);
window.fetch = (input, init = {}) => (typeof input === 'string' && input.startsWith('/api/chaosbooru')
  ? request(input, { ...init, headers: { ...init.headers, 'X-ChaosClip': '1' } }) : request(input, init));
const json = async (url, body) => {
  const response = await request(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ChaosClip': '1' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Erreur ${response.status}`);
  return response;
};

async function open() {
  root.innerHTML = page('<p class="booru-help" role="status">Chargement de la page du site…</p>');
  const status = await (await json('/api/booru/status')).json();
  if (!status.connected) {
    root.innerHTML = page('<div class="booru-page-heading"><div><h3>Connexion nécessaire</h3><p class="booru-help">Connecte-toi à Chaos Tools pour importer tes extraits sur ChaosBooru.</p></div></div><div class="booru-actions"><button type="button" class="booru-primary" data-settings>Ouvrir les réglages</button></div>');
    return;
  }
  // Le site lit le membre connecté dans son appli et dans le stockage de la page. Le vrai jeton reste dans ChaosClip :
  // celui posé ici n'est qu'un témoin de connexion, le relais met le sien.
  const user = await (await json('/api/booru/me')).json();
  window.app = { getCurrentUser: () => user };
  localStorage.setItem('chaos_user', JSON.stringify({ userId: user.userId }));
  localStorage.setItem('chaos_token', 'chaosclip');

  const [{ default: ChaosBooru }, { renderBooruBatchImport }] = await Promise.all([
    import('/site/js/controllers/chaosbooru.controller.js'),
    import('/site/js/controllers/chaosbooru-batch-import.controller.js'),
  ]);
  const site = new ChaosBooru('root'); // le contrôleur du site : ses appels, ses droits et ses règles de titre
  root.innerHTML = page('<main></main>');
  site.main = root.querySelector('main');
  // Un extrait garde le titre qu'il a dans la série, plutôt que celui tiré du nom de son fichier.
  const titles = new Map(host.files.map((file) => [file.name, file.title]));
  const fromName = site.titleFromImportName.bind(site);
  site.titleFromImportName = (name) => titles.get(name) || fromName(name);
  await renderBooruBatchImport(site);
  const lot = site.main;
  // Les liens de la page mènent au site : ils s'y ouvrent, hors de ChaosClip.
  root.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-booru-link]');
    if (!link) return;
    event.preventDefault();
    window.open(status.site + link.getAttribute('href'), '_blank', 'noopener');
  });

  // Classement commun : les informations de l'épisode saisies dans la série (source, crédit, support, œuvres et sagas),
  // posées dans le formulaire du site comme si le membre les y avait tapées. Il reste libre de les changer.
  const set = (name, apply) => {
    const field = lot.querySelector(`[name=${name}]`);
    if (!field) return;
    apply(field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const { sourceUrl, credit, support, entities = [] } = host.common || {};
  if (sourceUrl) set('batchSource', (field) => { field.value = sourceUrl; });
  if (credit) set('batchCredit', (field) => { field.value = credit; });
  if (support) set('batchSupport', (field) => { if ([...field.options].some((option) => option.value === support)) field.value = support; });
  for (const field of lot.querySelectorAll('[name=batchEntity]')) {
    if (!entities.includes(Number(field.value)) || field.checked) continue;
    field.checked = true;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Les extraits, remis au champ « Choisir les fichiers » de la page. Le WebP « avec classement » porte la fiche déjà
  // remplie dans ChaosClip, que la page du site relit d'elle-même ; fiche incomplète : le fichier tel quel.
  const files = await Promise.all(host.files.map(async (file) => {
    const classed = await json(file.portable.url, file.portable.body).catch(() => null);
    const blob = await (classed || await json(file.url)).blob();
    return new File([blob], file.name, { type: 'image/webp' });
  }));
  const input = lot.querySelector('[name=batchImages]');
  const picked = new DataTransfer();
  for (const file of files) picked.items.add(file);
  input.files = picked.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) host.close(); });
open().catch((error) => {
  root.innerHTML = page('<p class="booru-message booru-message--error"></p><div class="booru-actions"><button type="button" data-back>Fermer</button></div>');
  root.querySelector('.booru-message').textContent = error instanceof TypeError ? 'Chaos Tools ne répond pas : la page d’import en lot n’a pas pu être chargée. Vérifie ta connexion, puis rouvre cette fenêtre.' : error.message;
});
