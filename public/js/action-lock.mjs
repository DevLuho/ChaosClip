export const onceWhileActive = () => {
  const active = new Set();
  return async (key, run) => {
    if (active.has(key)) return;
    active.add(key);
    try { return await run(); }
    finally { active.delete(key); }
  };
};

const repeatable = new Set([
  'stepBack', 'stepFwd', 'stepBack10', 'stepFwd10',
  'nudgeInBack', 'nudgeInFwd', 'nudgeOutBack', 'nudgeOutFwd',
]);

export function acceptsShortcut(event, action) {
  return !event.defaultPrevented && !event.isComposing && (!event.repeat || repeatable.has(action));
}
