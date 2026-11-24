// Séries locales : le document éditable et les sorties terminées survivent au processus.
const fs = require('node:fs');
const path = require('node:path');
const { DIRS } = require('./env');
const store = require('./store');
const media = require('./media');
const exporter = require('./exporter');
const build = require('./build');
const { id, jobs, startJob, Cancelled } = require('./proc');

const formats = ['gif', 'webp'];
// « GIF seulement » : la série ne prépare ni n'attend le WebP destiné à ChaosBooru.
const formatsOf = (series) => (series.gifOnly ? ['gif'] : formats);
const dir = path.join(DIRS.data, 'series');
const active = new Map();
const sourceCache = new Map();
const validId = (value) => /^[a-f0-9]{12}$/.test(value);
const storageKey = (value) => 'series/' + value;
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const exists = (file) => !!file && fs.existsSync(file);
const statFile = (file) => {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? stat : null;
};

function get(seriesId) {
  const series = validId(seriesId) && store.read(storageKey(seriesId), null);
  if (!series) throw problem('Série introuvable.', 404);
  return series;
}

function list() {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => validId(path.parse(name).name) && name.endsWith('.json'))
    .map((name) => store.read(storageKey(path.parse(name).name), null))
    .filter(Boolean);
}

function save(series) {
  fs.mkdirSync(dir, { recursive: true });
  return store.write(storageKey(series.id), series);
}

function sourceRef(source) {
  const stat = statFile(source.path);
  return {
    path: source.path, name: source.name, origin: source.origin,
    info: source.info, externalSubs: source.externalSubs || [],
    fingerprint: stat && [stat.size, stat.mtimeMs],
  };
}

function sourceIsCurrent(source) {
  const stat = statFile(source.path);
  return !!stat && (!source.fingerprint || source.fingerprint[0] === stat.size && source.fingerprint[1] === stat.mtimeMs);
}

function create(source, title) {
  const series = {
    version: 1, id: id(), revision: 0, sourceVersion: 0, updated: Date.now(),
    title: clean(title) || path.parse(source.name).name, source: sourceRef(source),
    metadata: {}, clips: [], renders: {}, selected: null,
  };
  sourceCache.set(series.id, source.id);
  return save(series);
}

const clipWithId = (series, clipId) => series.clips.find((clip) => clip.id === clipId);
const originUrl = (origin) => {
  const url = typeof origin === 'string' ? origin : origin?.url;
  return /^https:\/\//i.test(url || '') ? url : '';
};

function metadataOf(series, clip) {
  return {
    title: clip.title, support: 'anime',
    sourceUrl: originUrl(series.source.origin),
    ...series.metadata, ...clip.draft,
  };
}

function encodeSettings(clip, format) {
  const { colors, dither, bayerScale, lossy, ...common } = clip.settings;
  const settings = { ...common, format, audio: false };
  if (format === 'gif') Object.assign(settings, { colors, dither, bayerScale, lossy, quality: 75, maxSizeMB: 20 });
  else Object.assign(settings, { quality: clip.settings.format === 'webp' ? clip.settings.quality : 75, maxSizeMB: 100 });
  return { ...settings, ...clip.profiles?.[format] };
}

function keyFor(series, clip, format) {
  const normalized = build.normalize(encodeSettings(clip, format), series.source.info);
  return JSON.stringify([series.sourceVersion, normalized]);
}

function isComplete(render) {
  if (!render?.entry) return false;
  const stat = statFile(render.entry.path);
  return stat?.size === render.entry.bytes && (render.entry.mtimeMs === undefined || stat.mtimeMs === render.entry.mtimeMs);
}

function currentOutput(series, clip, format) {
  const render = series.renders[clip.outputs[format]];
  return render?.key === keyFor(series, clip, format) ? render : null;
}

function reviewKey(series, clip) {
  const { assistance, ...metadata } = metadataOf(series, clip);
  return JSON.stringify([formats.map((format) => currentOutput(series, clip, format)?.id), metadata]);
}

function assertReviewed(series, clip) {
  if (!formatsOf(series).every((format) => isComplete(currentOutput(series, clip, format))) || clip.validated !== reviewKey(series, clip)) {
    throw problem('Valide les fichiers de cet extrait avant de le partager.', 409);
  }
}

function view(series) {
  return {
    id: series.id, title: series.title, revision: series.revision, selected: series.selected,
    metadata: series.metadata, gifOnly: !!series.gifOnly,
    source: { name: series.source.name, path: series.source.path, url: originUrl(series.source.origin), missing: !sourceIsCurrent(series.source) },
    clips: series.clips.map((clip, index) => {
      const outputs = Object.fromEntries(formats.map((format) => {
        const render = currentOutput(series, clip, format);
        if (!render) return [format, { status: 'new' }];
        const job = jobs.get(active.get(render.id));
        const ready = isComplete(render);
        const { status, error } = job || render;
        return [format, {
          job: job?.id, progress: job?.progress, error,
          status: ready ? 'done' : status === 'done' ? 'missing' : status,
          entry: ready ? { ...render.entry, url: '/out/' + render.id } : null,
          publication: store.read('booru-' + render.id, null)?.result,
        }];
      }));
      return {
        id: clip.id, title: clip.title, doc: clip.doc, profiles: clip.profiles, outputs,
        name: outputName(series, clip, index),
        bounds: clip.settings.segments.map(({ start, end }) => [start, end]),
        draft: clip.draft, publicationDraft: metadataOf(series, clip),
        validated: formatsOf(series).every((format) => outputs[format].status === 'done') && clip.validated === reviewKey(series, clip),
        previousPublications: Object.values(series.renders).filter((render) =>
          render.clipId === clip.id && render.settings.format === 'webp' && render.id !== outputs.webp.entry?.id,
        ).map((render) => store.read('booru-' + render.id, null)?.result).filter(Boolean),
        copied: !!outputs.gif.entry && clip.copied === outputs.gif.entry.id,
        shared: !!outputs.gif.entry && clip.shared === outputs.gif.entry.id,
      };
    }),
  };
}

function outputName(series, clip, index) {
  return [clean(series.title, 54), String(index + 1).padStart(2, '0'), clean(clip.title, 54)]
    .join('_').replace(/[{}<>:"/\\|?*\x00-\x1f]/g, '_');
}

function applyEdit(series, body) {
  if (series.revision !== body.revision) throw problem('La série a changé. Recharge la fiche puis réessaie.', 409);
  const clip = clipWithId(series, body.clip);
  if (body.clip && !clip) throw problem('Extrait introuvable.', 404);
  switch (body.action) {
    case 'metadata':
      series.title = clean(body.title) || series.title;
      series.metadata = {
        support: clean(body.metadata?.support, 20) || 'anime',
        sourceUrl: clean(body.metadata?.sourceUrl, 2000),
        credit: clean(body.metadata?.credit, 160),
        entities: Array.isArray(body.metadata?.entities) ? body.metadata.entities.filter(Number.isSafeInteger) : [],
      };
      break;
    case 'formats':
      series.gifOnly = !!body.gifOnly;
      break;
    case 'select':
      series.selected = clip.id;
      break;
    case 'add':
    case 'duplicate': {
      const newClip = body.action === 'duplicate'
        ? { ...structuredClone(clip), title: clip.title + ' (copie)' }
        : { title: clean(body.title) || 'Extrait ' + String(series.clips.length + 1).padStart(2, '0'), doc: body.doc, settings: body.settings, draft: {} };
      if (!newClip.doc || !newClip.settings?.segments?.length) throw problem('Sélectionne un passage à ajouter.');
      if (newClip.settings.segments.length > 50) throw problem('Un montage assemblé accepte jusqu’à 50 segments.');
      const clipId = id();
      series.clips.push({ ...newClip, id: clipId, outputs: {}, validated: null, copied: null, shared: null });
      series.selected = clipId;
      if (body.externalSubs?.length) series.source.externalSubs = body.externalSubs;
      break;
    }
    case 'rename':
      clip.title = clean(body.title) || clip.title;
      break;
    case 'edit':
      if (!body.doc || !body.settings?.segments?.length || body.settings.segments.length > 50) throw problem('Montage invalide.');
      Object.assign(clip, { doc: body.doc, settings: body.settings });
      if (body.externalSubs?.length) series.source.externalSubs = body.externalSubs;
      break;
    case 'profile': {
      if (!formats.includes(body.format)) throw problem('Format inconnu.');
      const { width, fps, maxSizeMB, quality, dither } = body.profile || {};
      const current = encodeSettings(clip, body.format);
      clip.profiles ||= {};
      clip.profiles[body.format] = {
        width: Number.isFinite(width) ? width : current.width,
        fps: Number.isFinite(fps) ? fps : current.fps,
        maxSizeMB: Number.isFinite(maxSizeMB) ? maxSizeMB : current.maxSizeMB,
        ...(body.format === 'gif'
          ? { dither: dither || current.dither }
          : { quality: Number.isFinite(quality) ? quality : current.quality }),
      };
      break;
    }
    case 'move': {
      const index = series.clips.indexOf(clip);
      const next = index + Math.sign(body.offset);
      if (series.clips[next]) [series.clips[index], series.clips[next]] = [series.clips[next], series.clips[index]];
      break;
    }
    case 'remove': {
      const index = series.clips.indexOf(clip);
      series.clips.splice(index, 1);
      if (series.selected === clip.id) series.selected = series.clips[Math.min(index, series.clips.length - 1)]?.id || null;
      break;
    }
    case 'draft':
      clip.draft = { ...body.draft };
      break;
    case 'validate':
      if (!formatsOf(series).every((format) => isComplete(currentOutput(series, clip, format)))) throw problem('Prépare les deux fichiers avant la validation.', 409);
      clip.validated = reviewKey(series, clip);
      break;
    case 'copied':
    case 'shared':
      assertReviewed(series, clip);
      clip[body.action] = clip.outputs.gif;
      break;
    default:
      throw problem('Action de série inconnue.');
  }
  series.updated = Date.now();
  series.revision += 1;
  return save(series);
}

async function openSource(series) {
  if (!sourceIsCurrent(series.source)) throw problem('L’épisode a été déplacé ou modifié. Retrouve le fichier source.', 404);
  const previous = media.sources.get(sourceCache.get(series.id));
  if (previous?.path === series.source.path) return previous;
  if (!statFile(series.source.path)) throw problem('Épisode introuvable. Retrouve le fichier source.', 404);
  const { name, origin, externalSubs } = series.source;
  const source = await media.addSource(series.source.path, { name, origin, externalSubs });
  sourceCache.set(series.id, source.id);
  return source;
}

function relink(series, source, revision) {
  if (series.revision !== revision) throw problem('La série a changé. Recharge-la puis réessaie.', 409);
  if (!statFile(source.path)) throw problem('Épisode introuvable.', 404);
  const replacement = sourceRef(source);
  if (JSON.stringify(replacement.fingerprint) !== JSON.stringify(series.source.fingerprint)) series.sourceVersion += 1;
  series.source = { ...replacement, origin: series.source.origin, externalSubs: series.source.externalSubs };
  series.revision += 1;
  sourceCache.delete(series.id);
  return save(series);
}

function updateRender(seriesId, renderId, fields) {
  const series = get(seriesId);
  Object.assign(series.renders[renderId], fields);
  save(series);
}

function schedule(seriesId, renderId) {
  if (active.has(renderId)) return;
  const render = get(seriesId).renders[renderId];
  const job = startJob('export', async (job) => {
    const series = get(seriesId);
    const saved = series.renders[renderId];
    if (isComplete(saved)) {
      exporter.rememberExport(saved.entry);
      return { ...saved.entry, url: '/out/' + renderId };
    }
    if (saved.sourceVersion !== series.sourceVersion) throw problem('La source a changé. Prépare une nouvelle sortie.');
    const src = await openSource(series);
    if (job.cancelled) throw new Cancelled();
    if (saved.temporary) {
      for (const file of [saved.temporary, saved.temporary + '.tmp.gif']) {
        try { fs.rmSync(file, { force: true }); } catch { /* un processus interrompu le libérera */ }
      }
    }
    const outputPath = saved.entry?.path && !exists(saved.entry.path)
      ? saved.entry.path : exporter.reserveOutput(src, saved.settings, saved.name);
    return exporter.exportClip(job, src, saved.settings, {
      outputPath, exportId: renderId,
      onTemporary: (temporary) => updateRender(seriesId, renderId, { temporary }),
      beforePublish: (entry) => updateRender(seriesId, renderId, { entry }),
    });
  }, {
    lane: 'export', label: render.name + ' · ' + render.settings.format.toUpperCase(), created: Date.now(),
    onFinish: (finished) => {
      try { updateRender(seriesId, renderId, { status: finished.status, error: finished.error }); }
      finally { active.delete(renderId); }
    },
  });
  active.set(renderId, job.id);
}

function prepare(series, clipId, onlyFormat) {
  if (!sourceIsCurrent(series.source)) throw problem('L’épisode a été déplacé ou modifié. Retrouve le fichier source.', 404);
  if (onlyFormat && !formats.includes(onlyFormat)) throw problem('Format inconnu.');
  if (clipId && !clipWithId(series, clipId)) throw problem('Extrait introuvable.', 404);
  const scheduled = [];
  series.clips.forEach((clip, index) => {
    if (clipId && clip.id !== clipId) return;
    for (const format of onlyFormat ? [onlyFormat] : formatsOf(series)) {
      const key = keyFor(series, clip, format);
      const current = currentOutput(series, clip, format)
        || Object.values(series.renders).find((item) => item.clipId === clip.id && item.key === key);
      if (isComplete(current) || active.has(current?.id)) {
        clip.outputs[format] = current.id;
        continue;
      }
      const hasRemoteTransfer = current && store.read('booru-' + current.id, null);
      const render = current && !hasRemoteTransfer ? current : {
        id: id(), name: outputName(series, clip, index), clipId: clip.id, sourceVersion: series.sourceVersion,
        key, settings: encodeSettings(clip, format),
      };
      Object.assign(render, { status: 'queued', error: null });
      series.renders[render.id] = render;
      clip.outputs[format] = render.id;
      scheduled.push(render.id);
    }
  });
  save(series);
  for (const renderId of scheduled) schedule(series.id, renderId);
  return view(get(series.id));
}

function resume() {
  for (const series of list()) {
    for (const render of Object.values(series.renders)) {
      if (render.status === 'queued') schedule(series.id, render.id);
    }
  }
}

function findOutput(renderId, requireReady = true) {
  if (!validId(renderId)) return null;
  for (const series of list()) {
    const render = series.renders[renderId];
    if (render && (!requireReady || isComplete(render))) return { series, render, clip: clipWithId(series, render.clipId) };
  }
  return null;
}

function checkShare(renderId, format) {
  const found = findOutput(renderId, false);
  if (!found) return;
  const { series, clip, render } = found;
  if (!clip || currentOutput(series, clip, format)?.id !== render.id) throw problem('Cette sortie appartient à une ancienne révision.', 409);
  assertReviewed(series, clip);
}

function protectedFiles() {
  const keep = new Set();
  for (const { source, clips, renders } of list()) {
    keep.add(source.path);
    for (const item of source.externalSubs || []) keep.add(item.path);
    for (const settings of [...clips.map((clip) => clip.settings), ...Object.values(renders).map((render) => render.settings)]) {
      if (settings.logo?.file) keep.add(path.join(DIRS.work, 'logos', path.basename(settings.logo.file)));
    }
  }
  return keep;
}

module.exports = { get, list, create, view, applyEdit, openSource, relink, prepare, resume, findOutput, checkShare, protectedFiles };
