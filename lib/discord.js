// Envoi d'un export dans un salon Discord par webhook.
const fs = require('fs');
const path = require('path');

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

async function send(url, file, message = '') {
  if (!WEBHOOK.test(url)) throw new Error('Adresse de webhook Discord invalide');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: message.slice(0, 2000), allowed_mentions: { parse: [] } }));
  form.append('files[0]', new Blob([fs.readFileSync(file)]), path.basename(file));
  const r = await fetch(url, { method: 'POST', body: form });
  if (r.status === 413) throw new Error('Fichier trop lourd pour ce salon Discord (limite du serveur)');
  if (!r.ok) throw new Error(`Discord a refusé l’envoi (${r.status}) : ${(await r.text()).slice(0, 200)}`);
}

module.exports = { send, WEBHOOK };
