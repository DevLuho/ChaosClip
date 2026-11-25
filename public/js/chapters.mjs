// Chapitre (titre) de la vidéo source qui couvre l'instant `time` (secondes) ; '' si aucun.
export function chapterAt(chapters, time) {
  if (!Array.isArray(chapters) || !Number.isFinite(time)) return '';
  const hit = chapters.find((c) => time >= c.start && (c.end == null || time < c.end));
  return hit ? String(hit.title || '').trim() : '';
}
