// Envoi d'un export vers Chaos Tools › ChaosBooru : formulaire, recherche d'étiquettes, connexion.
import { $, api, fail, toast, native, android, openDialog, waitJob } from './util.js';
import { t } from './i18n.js';

const FORMATS = ['gif', 'webp', 'png'];
const sending = new Set();
let connected = null; // null tant que le serveur n'a pas répondu : on ne bloque rien sur une inconnue
let pending = null; // l'envoi demandé avant d'être connecté, repris une fois la connexion faite


// ---------- connexion (fenêtre Réglages) ----------

export async function renderBooruStatus() {
  $('booruLogin').hidden = !native?.booruLogin && !android;
  try {
    const s = await api('/api/booru/status');
    $('booruStatus').textContent = s.connected ? t('Connecté à Chaos Tools en tant que {u}', { u: s.user || '?' })
      : s.expired ? t('Connexion expirée : reconnecte-toi.') : s.error || t('Pas connecté. Le jeton reste sur cet appareil.');
    $('booruLogout').hidden = !s.connected;
    // Pas connecté : la connexion se propose dès l'accueil, et son bouton ressort dans les Réglages.
    connected = !!s.connected;
    $('booruHome').hidden = connected;
    $('booruLogin').classList.toggle('primary', !connected);
    $('booruLogin').classList.toggle('ghost', connected);
    return s;
  } catch (e) { $('booruStatus').textContent = e.message; return { connected: false }; }
}

async function saveToken(token) {
  try {
    await api('/api/booru/token', { token }, 'PUT');
    $('booruToken').value = '';
    const s = await renderBooruStatus();
    if (s.connected) {
      toast(t('Connecté à Chaos Tools'), 'ok');
      pending?.();
    }
    pending = null;
  } catch (e) { fail(e); }
}

// Ouvre la connexion par le moyen de cette plateforme. Android : le jeton revient par l'événement « chaosclip-booru ».
export async function connect() {
  if (android) return android.booruLogin();
  if (!native?.booruLogin) return openDialog('settingsDlg'); // navigateur : le jeton se colle dans les Réglages
  const token = await native.booruLogin();
  if (token) await saveToken(token);
}
$('booruTokenSave').addEventListener('click', () => saveToken($('booruToken').value));
$('booruLogout').addEventListener('click', () => saveToken(''));
$('booruLogin').addEventListener('click', connect);
document.addEventListener('click', (e) => { if (e.target.closest('[data-booru-connect]')) connect(); });
window.addEventListener('chaosclip-booru', (e) => saveToken(e.detail));

// ---------- fenêtre d'envoi ----------

// Case « Ouvrir la page ChaosBooru après l'envoi » de booru.html (même origine, donc même stockage). Cochée par défaut.
const openPagePref = () => { try { return localStorage.getItem('chaosclip.booruOpenPage') !== '0'; } catch { return true; } };

// La fenêtre affiche booru.html : la page d'édition du site, isolée dans un cadre pour garder exactement ses styles.
export function openBooru(e, options = {}) {
  if (!e) return;
  if (!FORMATS.includes(e.format)) return toast(t('ChaosBooru accepte les GIF, WebP et PNG : exporte dans un de ces formats'), 'error');
  if (connected === false) {
    // On propose la connexion tout de suite, et l'envoi reprend de lui-même une fois connecté.
    pending = () => openBooru(e, options);
    toast(t('Connecte-toi à Chaos Tools pour envoyer sur ChaosBooru'));
    return connect();
  }
  const close = () => { if (window.booruHost === host && $('booruDlg').open) $('booruDlg').close(); };
  const host = {
    entry: e,
    defaults: options.defaults,
    saveDraft: options.saveDraft,
    opensPage: !options.onResult, // les séries gèrent la suite elles-mêmes : pas de page à ouvrir
    close,
    openSettings: () => { close(); openDialog('settingsDlg'); },
    // Rejette en cas d'erreur : la page l'affiche à côté du formulaire.
    async send(body, onProgress) {
      if (sending.has(e.id)) throw new Error(t('Un envoi est déjà en cours.'));
      sending.add(e.id);
      try {
        await options.beforeSend?.();
        const r = await api(`/api/history/${e.id}/booru`, body);
        const res = await waitJob(r.job, 'ChaosBooru', { silent: true, onProgress });
        close();
        toast(res.state === 'pending' ? t('Envoyé sur ChaosBooru : en attente de modération') : res.state === 'approved' ? t('Publié sur ChaosBooru') : t('Brouillon créé sur ChaosBooru'), 'ok', 6000);
        if (options.onResult) options.onResult(res);
        else if (openPagePref()) window.open(res.url, '_blank', 'noopener');
      } finally { sending.delete(e.id); }
    },
  };
  window.booruHost = host;
  $('booruFrame').src = `booru.html?v=${Date.now()}`;
  openDialog('booruDlg');
}
$('booruDlg').addEventListener('close', () => { if (!$('booruDlg').open) $('booruFrame').src = 'about:blank'; });
