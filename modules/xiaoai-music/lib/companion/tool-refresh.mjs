const names = new Set(['xiaoai_music', 'xiaoai_reminder']);
const sessionKey = value => typeof value === 'string' ? value.replace(/^session-/, '') : '';

export function refreshFamilyToolBindings(api, builder) {
  const patches = new Map();
  let disposed = false;
  const agents = () => api.dsh?.agents?.list?.() || [];
  function refresh(agent) {
    if (disposed) return;
    try {
      const sessionId = agent?.session?.id;
      if (!sessionKey(sessionId)) return;
      const chatId = api.core.hub?.chatOfSession?.(sessionId);
      const match = /^(private|group):.+$/.exec(typeof chatId === 'string' ? chatId : '');
      const registry = agent?.ctx?.tools;
      if (!match || typeof registry?.get !== 'function') return;
      const current = [].concat(builder({ chat: { kind: match[1] }, level: 'full', sessionId }) || []);
      for (const definition of current) {
        if (!names.has(definition?.name) || typeof definition.execute !== 'function') continue;
        const target = registry.get(definition.name, agent);
        if (!target || target === registry.get(definition.name) || patches.has(target) || typeof target.execute !== 'function') continue;
        const previous = target.execute;
        target.execute = definition.execute;
        patches.set(target, { previous, installed: definition.execute });
      }
    } catch {}
  }
  for (const agent of agents()) refresh(agent);
  const off = api.dsh?.on?.('session/event', (session, event) => {
    if (disposed || event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return;
    const id = sessionKey(session?.id);
    if (!id) return;
    const agent = agents().find(value => sessionKey(value?.session?.id) === id);
    if (agent) refresh(agent);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof off === 'function') off();
    for (const [target, { previous, installed }] of patches) {
      if (target.execute === installed) target.execute = previous;
    }
    patches.clear();
  };
}
