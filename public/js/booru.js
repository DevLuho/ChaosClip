// Envoi d'un export vers Chaos Tools › ChaosBooru : formulaire, recherche d'étiquettes, connexion.
import { $, api, fail, toast, native, openDialog, waitJob } from './util.js';
import { t } from './i18n.js';

const FORMATS = ['gif', 'webp', 'png'];


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

// ---------- fenêtre d'envoi ----------

// La fenêtre affiche booru.html : la page d'édition du site, isolée dans un cadre pour garder exactement ses styles.
export function openBooru(e) {
  if (!e) return;
  if (!FORMATS.includes(e.format)) return toast(t('ChaosBooru accepte les GIF, WebP et PNG : exporte dans un de ces formats'), 'error');
  const close = () => $('booruDlg').close();
  window.booruHost = {
    entry: e,
    close,
    openSettings: () => { close(); openDialog('settingsDlg'); },
    // Rejette en cas d'erreur : la page l'affiche à côté du formulaire.
    async send(body) {
      const r = await api(`/api/history/${e.id}/booru`, body);
      const res = await waitJob(r.job, 'ChaosBooru');
      close();
      toast(res.state === 'pending' ? t('Envoyé sur ChaosBooru : en attente de modération') : res.state === 'approved' ? t('Publié sur ChaosBooru') : t('Brouillon créé sur ChaosBooru'), 'ok', 6000);
      window.open(res.url, '_blank', 'noopener');
    },
  };
  $('booruFrame').src = `booru.html?v=${Date.now()}`;
  openDialog('booruDlg');
}
$('booruDlg').addEventListener('close', () => { $('booruFrame').src = 'about:blank'; });
