// Polices installées : lecture du nom de famille dans la table « name » des fichiers
// TTF/OTF/TTC, pour que libass (texte incrusté) et l'aperçu du navigateur utilisent la même.
const fs = require('fs');
const os = require('os');
const path = require('path');

function fontDirs() {
  const h = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
      path.join(process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'android') return ['/system/fonts'];
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(h, 'Library', 'Fonts')];
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(h, '.fonts'), path.join(h, '.local', 'share', 'fonts')];
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}

// Renvoie { family, style } ou null. Ne lit que l'en-tête et la table des noms.
function readNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let base = 0;
    let head = readAt(fd, 0, 12);
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      base = readAt(fd, 12, 4).readUInt32BE(0);
      head = readAt(fd, base, 12);
    }
    const numTables = head.readUInt16BE(4);
    if (numTables > 200) return null;
    const dir = readAt(fd, base + 12, numTables * 16);
    let nameOff = -1;
    let nameLen = 0;
    for (let i = 0; i < numTables; i++) {
      if (dir.toString('latin1', i * 16, i * 16 + 4) === 'name') {
        nameOff = dir.readUInt32BE(i * 16 + 8);
        nameLen = dir.readUInt32BE(i * 16 + 12);
      }
    }
    if (nameOff < 0 || nameLen > 1 << 20) return null;
    const t = readAt(fd, nameOff, nameLen);
    const count = t.readUInt16BE(2);
    const strOff = t.readUInt16BE(4);
    const found = {};
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      if (r + 12 > t.length) break;
      const platform = t.readUInt16BE(r);
      const lang = t.readUInt16BE(r + 4);
      const nameId = t.readUInt16BE(r + 6);
      const len = t.readUInt16BE(r + 8);
      const off = strOff + t.readUInt16BE(r + 10);
      if (![1, 2].includes(nameId) || off + len > t.length) continue;
      let s;
      if (platform === 3 || platform === 0) {
        s = '';
        for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(t.readUInt16BE(off + k));
      } else if (platform === 1) s = t.toString('latin1', off, off + len);
      else continue;
      // Préférence : Windows anglais, puis le premier trouvé.
      const score = platform === 3 && lang === 0x409 ? 2 : 1;
      if (!found[nameId] || found[nameId].score < score) found[nameId] = { s, score };
    }
    if (!found[1]) return null;
    return { family: found[1].s.trim(), style: (found[2]?.s || 'Regular').trim() };
  } finally {
    fs.closeSync(fd);
  }
}

let cache = null;

function scan() {
  const families = new Map();
  const walk = (dir, depth = 0) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (/\.(ttf|otf|ttc)$/i.test(e.name)) {
        try {
          const n = readNames(p);
          if (!n || !n.family || n.family.startsWith('.')) continue;
          if (!families.has(n.family)) families.set(n.family, { family: n.family, files: [] });
          families.get(n.family).files.push({ file: p, style: n.style });
        } catch { /* police illisible : ignorée */ }
      }
    }
  };
  fontDirs().forEach((d) => walk(d));
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function list() {
  if (!cache) cache = scan();
  return cache;
}

const PREFERRED = ['Impact', 'Arial', 'Helvetica', 'Roboto', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans']; // Roboto : Android, où le premier par ordre alphabétique est « AndroidClock »

function find(family) {
  return list().find((f) => f.family.toLowerCase() === String(family || '').toLowerCase()) || null;
}

function defaultFont() {
  for (const name of PREFERRED) {
    const f = find(name);
    if (f) return f;
  }
  return list()[0] || null;
}

// Copie les fichiers des familles utilisées dans le dossier fontsdir de libass.
function copyFamilies(families, destDir) {
  const used = new Set();
  for (const name of families) {
    const f = find(name) || defaultFont();
    if (!f || used.has(f.family)) continue;
    used.add(f.family);
    for (const { file } of f.files) {
      try { fs.copyFileSync(file, path.join(destDir, path.basename(file))); } catch { /* ignorée */ }
    }
  }
}

module.exports = { list, find, defaultFont, copyFamilies, readNames };
