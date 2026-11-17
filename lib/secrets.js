// Electron utilise le magasin chiffré de l'utilisateur. Le serveur autonome
// garde la compatibilité avec ses réglages JSON existants.
function storage() {
  return process.versions.electron ? require('electron').safeStorage : null;
}

function seal(value) {
  const vault = storage();
  return vault?.isEncryptionAvailable() ? { encrypted: vault.encryptString(value).toString('base64') } : value;
}

function open(value) {
  if (typeof value === 'string') return value;
  if (!value?.encrypted) return null;
  const vault = storage();
  if (!vault?.isEncryptionAvailable()) throw new Error('Le stockage sécurisé de ChaosClip est indisponible.');
  return vault.decryptString(Buffer.from(value.encrypted, 'base64'));
}

module.exports = { seal, open };
