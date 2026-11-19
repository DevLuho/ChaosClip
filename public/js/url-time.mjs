// Temps de départ d'un lien (YouTube ?t=90 ou &t=1m30s, Twitch ?t=1h2m3s, #t=…), en secondes ; 0 si absent.
export function urlTime(url) {
  let u;
  try { u = new URL(url); } catch { return 0; }
  const v = u.searchParams.get('t') || u.searchParams.get('start') || new URLSearchParams(u.hash.slice(1)).get('t');
  if (!v) return 0;
  if (/^\d+(\.\d+)?s?$/.test(v)) return parseFloat(v);
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m) return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  const parts = v.split(':').map(Number);
  return parts.every(Number.isFinite) ? parts.reduce((a, p) => a * 60 + p, 0) : 0;
}
