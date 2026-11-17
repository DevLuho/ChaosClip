// Envoi d'un export dans un salon Discord par webhook.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const store = require('./store');
const secrets = require('./secrets');

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

async function send(url, file, message = '') {
  if (!WEBHOOK.test(url)) throw new Error('Adresse de webhook Discord invalide');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: message.slice(0, 2000), allowed_mentions: { parse: [] } }));
  form.append('files[0]', new Blob([fs.readFileSync(file)]), path.basename(file));
  const endpoint = new URL(url);
  endpoint.searchParams.set('wait', 'true');
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(60000), redirect: 'error' });
    } catch { throw new Error('Envoi à vérifier dans Discord. La confirmation du salon est indisponible.'); }
    if (response.status === 413) throw new Error('Fichier trop lourd pour ce salon Discord (limite du serveur)');
    const payload = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After') ?? payload.retry_after);
      if (attempt < 2 && Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) {
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(seconds * 1000)));
        continue;
      }
      throw new Error(Number.isFinite(seconds) ? `Discord limite les envois. Réessaie dans ${Math.ceil(seconds)} s.` : 'Discord limite les envois. Réessaie dans un instant.');
    }
    if (!response.ok) throw new Error(`Discord a refusé l’envoi (${response.status}).`);
    if (!payload.id) throw new Error('Envoi à vérifier dans Discord. Le reçu est incomplet.');
    return { id: payload.id, channelId: payload.channel_id, guildId: payload.guild_id };
  }
}

function hooks() {
  const settings = store.read('settings', {});
  let changed = false;
  const webhooks = (settings.webhooks || []).map((hook) => {
    const url = typeof hook.url === 'string' ? secrets.seal(hook.url) : hook.url;
    if (hook.id && url === hook.url) return hook;
    changed = true;
    return { ...hook, id: hook.id || randomUUID(), url };
  });
  if (changed) store.write('settings', { ...settings, webhooks });
  return webhooks;
}

function publicSettings() {
  const webhooks = hooks().map(({ id, name }) => ({ id, name }));
  return { ...store.read('settings', {}), webhooks };
}

function addHook(name, url) {
  if (!WEBHOOK.test(url)) throw new Error('Adresse de webhook Discord invalide');
  const webhooks = hooks();
  webhooks.push({ id: randomUUID(), name, url: secrets.seal(url) });
  store.write('settings', { ...store.read('settings', {}), webhooks });
}

function removeHook(id) {
  const webhooks = hooks().filter((hook) => hook.id !== id);
  store.write('settings', { ...store.read('settings', {}), webhooks });
}

module.exports = { send, hooks, publicSettings, addHook, removeHook };
