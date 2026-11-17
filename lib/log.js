// Journal en mémoire, consultable depuis l'interface (« copier le rapport »).
const lines = [];
const push = (level, msg) => {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  lines.push(line);
  if (lines.length > 500) lines.shift();
  (level === 'ERR' ? console.error : console.log)(line);
};
module.exports = {
  info: (m) => push('INF', m),
  warn: (m) => push('WRN', m),
  error: (m) => push('ERR', m),
  text: () => lines.join('\n'),
};
