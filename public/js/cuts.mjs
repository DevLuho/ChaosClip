// Passages gardés à l'export : la sélection (ou les segments) moins les passages retirés. Pur, pour être testé.
export function keptRanges({ sel, segments, cuts = [] }) {
  const base = segments.length ? segments : [{ start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) }];
  let kept = base;
  for (const c of cuts) {
    kept = kept.flatMap((g) => {
      if (c.end < g.start || c.start > g.end) return [g];
      const parts = [];
      if (c.start > g.start) parts.push({ ...g, end: c.start - 1 });
      if (c.end < g.end) parts.push({ ...g, start: c.end + 1 });
      if (parts.length === 2 && g.hold) parts[0].hold = 0; // l'arrêt sur image reste à la fin du segment
      return parts;
    });
  }
  return kept.length ? kept : base; // tout serait retiré : l'export garde le passage entier plutôt que rien
}
