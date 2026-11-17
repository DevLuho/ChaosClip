/** Contrat XMP v1 de ChaosTools, distribué sous licence MIT. */
export const BOORU_XMP_NAMESPACE = 'urn:chaosbooru:metadata:1';
export const MAX_XMP_BYTES = 65536;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const supports = ['manga', 'anime', 'game', 'illustration', 'live_action', 'other', 'unknown'];
const kinds = ['oeuvres', 'sagas', 'personnages', 'tags'];
const invalid = message => Object.assign(new Error(`Classement du fichier invalide : ${message}`), { code: 'INVALID_METADATA' });
const invalidMedia = message => Object.assign(new Error(`Conteneur WebP invalide : ${message}`), { code: 'INVALID_MEDIA' });
const ascii = bytes => String.fromCharCode(...bytes);
const uint32 = (bytes, offset = 0) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
function string(value, max, label, optional = false) {
  if (optional && value === undefined) return '';
  // eslint-disable-next-line no-control-regex -- refus des contrôles dans les champs portables
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid(label);
  return value.trim().normalize('NFC');
}
export function validateBooruMetadata(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.version !== 1) throw invalid('version non reconnue.');
  const allowed = ['version', 'title', 'description', 'support', 'entities', 'sourceUrl', 'credit'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid('champ non reconnu.');
  const title = string(value.title, 120, 'titre');
  if (title.length < 3) throw invalid('titre trop court.');
  const support = value.support ?? 'unknown';
  if (!supports.includes(support)) throw invalid('support');
  if (!Array.isArray(value.entities)) throw invalid('étiquettes');
  const counts = {}, seen = new Set(), entities = [];
  for (const ref of value.entities) {
    if (!ref || Array.isArray(ref) || typeof ref !== 'object' || Object.keys(ref).some(key => !['kind', 'name', 'work'].includes(key)) || !kinds.includes(ref.kind)) throw invalid('référence de catalogue');
    const name = string(ref.name, 120, 'nom'), work = string(ref.work, 120, 'œuvre', true);
    if (!name || (work && !['sagas', 'personnages'].includes(ref.kind))) throw invalid('référence de catalogue');
    const key = `${ref.kind}:${name}:${work}`;
    if (seen.has(key)) continue;
    seen.add(key); counts[ref.kind] = (counts[ref.kind] || 0) + 1;
    if (counts[ref.kind] > (ref.kind === 'tags' ? 30 : ref.kind === 'personnages' ? 10 : Infinity)) throw invalid('trop d’étiquettes');
    entities.push({ kind: ref.kind, name, ...(work ? { work } : {}) });
  }
  const sourceUrl = string(value.sourceUrl, 2000, 'source', true);
  if (sourceUrl) {
    let url; try { url = new URL(sourceUrl); } catch { throw invalid('source'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw invalid('source HTTPS requise.');
  }
  return { version: 1, title, description: string(value.description, 2000, 'description', true), support, entities, sourceUrl, credit: string(value.credit, 160, 'crédit', true) };
}
export function parseBooruXmp(bytes) {
  if (bytes.length > MAX_XMP_BYTES) throw invalid('métadonnées trop volumineuses.');
  let xml; try { xml = decoder.decode(bytes); } catch { throw invalid('encodage XMP'); }
  if (!xml.includes(BOORU_XMP_NAMESPACE)) return null;
  // Aucun parseur XML : pas de DTD, d’entités externes ni de code interprété.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('déclarations XML interdites.');
  const namespace = /xmlns:([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(["'])urn:chaosbooru:metadata:1\2/g;
  const declarations = [...xml.matchAll(namespace)];
  if (declarations.length !== 1) throw invalid('espace de noms ambigu.');
  const prefix = declarations[0][1], payloads = [...xml.matchAll(new RegExp(`<${prefix}:classification>\\s*([A-Za-z0-9+/=\\s]+)\\s*</${prefix}:classification>`, 'g'))];
  if (payloads.length !== 1) throw invalid('classement manquant ou répété.');
  const base64 = payloads[0][1].replace(/\s/g, '');
  let data;
  try { data = JSON.parse(decoder.decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0)))); } catch { throw invalid('classement illisible.'); }
  return validateBooruMetadata(data);
}
export function encodeBooruXmp(value) {
  const data = encoder.encode(JSON.stringify(validateBooruMetadata(value)));
  const base64 = btoa(String.fromCharCode(...data));
  return encoder.encode(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:cb="${BOORU_XMP_NAMESPACE}"><cb:classification>${base64}</cb:classification></rdf:Description></rdf:RDF></x:xmpmeta>`);
}
/** Lecture bornée : les blocs d’animation sont sautés, jamais chargés pour lire XMP. */
export async function inspectWebpMetadata(read, size) {
  if (size < 12) return null;
  const header = await read(0, 12);
  if (ascii(header.subarray(0, 4)) !== 'RIFF' || ascii(header.subarray(8, 12)) !== 'WEBP') return null;
  if (uint32(header, 4) + 8 !== size) throw invalidMedia('taille du conteneur WebP');
  const chunks = []; let offset = 12, classification = null, metadataChunk = null;
  while (offset < size) {
    if (chunks.length >= 10000 || offset + 8 > size) throw invalidMedia('conteneur WebP tronqué');
    const head = await read(offset, 8), kind = ascii(head.subarray(0, 4)), length = uint32(head, 4), total = 8 + length + (length % 2);
    if (offset + total > size) throw invalidMedia('bloc WebP tronqué');
    const chunk = { kind, offset, length, total };
    chunks.push(chunk);
    if (kind === 'XMP ') {
      if (chunks.filter(item => item.kind === 'XMP ').length > 1) throw invalid('plusieurs blocs XMP');
      if (length > MAX_XMP_BYTES) {
        const prefix = await read(offset + 8, MAX_XMP_BYTES);
        if (new TextDecoder().decode(prefix).includes(BOORU_XMP_NAMESPACE)) throw invalid('métadonnées trop volumineuses.');
      } else classification = parseBooruXmp(await read(offset + 8, length));
      if (classification) metadataChunk = chunk;
    }
    offset += total;
  }
  return { classification, metadataChunk, chunks };
}
export async function readBooruFileMetadata(file) {
  const info = await inspectWebpMetadata(async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), file.size);
  return info?.classification || null;
}
/** Remuxe uniquement XMP ; les octets VP8/VP8L/ANMF et les délais sont conservés. */
export async function embedBooruWebp(buffer, value, dimensions) {
  const info = await inspectWebpMetadata(async (offset, length) => buffer.subarray(offset, offset + length), buffer.length);
  if (!info) throw invalid('un fichier WebP est nécessaire.');
  if (info.chunks.some(chunk => chunk.kind === 'XMP ') && !info.metadataChunk) throw invalid('un autre XMP existe déjà ; sa conservation nécessite une fusion explicite.');
  const xmp = encodeBooruXmp(value), xmpBlock = new Uint8Array(8 + xmp.length + xmp.length % 2);
  xmpBlock.set(encoder.encode('XMP ')); new DataView(xmpBlock.buffer).setUint32(4, xmp.length, true); xmpBlock.set(xmp, 8);
  const parts = [];
  if (!info.chunks.some(chunk => chunk.kind === 'VP8X')) {
    if (!dimensions?.width || !dimensions?.height || dimensions.width > 16777216 || dimensions.height > 16777216) throw invalid('dimensions requises pour ce WebP');
    const extended = new Uint8Array(18);extended.set(encoder.encode('VP8X'));new DataView(extended.buffer).setUint32(4, 10, true);extended[8] = 4 | (dimensions.hasAlpha ? 16 : 0);
    for (let i = 0; i < 3; i++) { extended[12 + i] = (dimensions.width - 1) >>> (8 * i) & 255; extended[15 + i] = (dimensions.height - 1) >>> (8 * i) & 255; }
    parts.push(extended);
  }
  for (const chunk of info.chunks) {
    if (chunk === info.metadataChunk) continue;
    const bytes = new Uint8Array(buffer.subarray(chunk.offset, chunk.offset + chunk.total));
    if (chunk.kind === 'VP8X') { if (chunk.length !== 10) throw invalid('bloc VP8X'); bytes[8] |= 4; }
    parts.push(bytes);
  }
  parts.push(xmpBlock);
  const output = new Uint8Array(12 + parts.reduce((sum, part) => sum + part.length, 0));
  output.set(buffer.subarray(0, 12)); new DataView(output.buffer).setUint32(4, output.length - 8, true);
  let offset = 12; for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
