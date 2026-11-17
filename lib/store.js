// Petits fichiers JSON dans data/ : réglages, préréglages, historique, projets.
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./env');

const file = (name) => path.join(DIRS.data, `${name}.json`);

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

// Écriture atomique : un plantage en pleine écriture ne corrompt pas le fichier.
function write(name, value) {
  const tmp = `${file(name)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
  return value;
}

module.exports = { read, write };
