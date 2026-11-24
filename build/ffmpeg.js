// ffmpeg livré avec l'appli Windows : l'édition complète de Gyan, pour son décodeur AV1 dav1d (environ 4 fois plus
// rapide que libaom, seul décodeur AV1 de ffmpeg-static, sur les vidéos AV1 de YouTube : frise, aperçus, exports).
// Version figée par son empreinte. Lancé par electron-builder avant l'empaquetage (beforePack) et par la CI avant les
// tests ; sans effet hors de Windows ou quand vendor/ffmpeg est déjà à cette version.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const VERSION = '9.1';
const NAME = `ffmpeg-${VERSION}-full_build-shared`;
const URL = `https://github.com/GyanD/codexffmpeg/releases/download/${VERSION}/${NAME}.zip`;
const SHA256 = 'd010a19b78d5eae62dca8d4c7f195acd56dae8ed6fb85f72821edd9437da2898';
const DIR = path.join(__dirname, '..', 'vendor', 'ffmpeg');

async function fetchFfmpeg() {
  if (process.platform !== 'win32') return;
  const stamp = path.join(DIR, 'version.txt');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === NAME) return;
  fs.mkdirSync(path.dirname(DIR), { recursive: true });
  const zip = path.join(path.dirname(DIR), `${NAME}.zip`);
  console.log(`ffmpeg : téléchargement de ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`ffmpeg : téléchargement impossible (${res.status})`);
  const hash = crypto.createHash('sha256');
  await pipeline(Readable.fromWeb(res.body), async function* (chunks) {
    for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
  }, fs.createWriteStream(zip));
  if (hash.digest('hex') !== SHA256) {
    fs.rmSync(zip, { force: true });
    throw new Error('ffmpeg : empreinte inattendue, archive refusée');
  }
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  // tar de Windows (bsdtar) : il lit le zip, celui de Git Bash non. Le lecteur ffplay ne sert pas à ChaosClip.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zip, '-C', DIR, '--strip-components', '2', `${NAME}/bin`]);
  execFileSync(tar, ['-xf', zip, '-C', DIR, '--strip-components', '1', `${NAME}/LICENSE`]);
  fs.rmSync(path.join(DIR, 'ffplay.exe'), { force: true });
  fs.rmSync(zip, { force: true });
  fs.writeFileSync(stamp, NAME);
}

module.exports = fetchFfmpeg;
if (require.main === module) fetchFfmpeg().catch((error) => { console.error(error.message); process.exit(1); });
