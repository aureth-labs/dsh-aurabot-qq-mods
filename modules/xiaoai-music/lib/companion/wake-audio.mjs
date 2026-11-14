import { randomBytes } from 'node:crypto';

const retire = entry => {
  entry.retired = true;
  if (!entry.users) return entry.audio.cleanup();
};

export function createWakeAudio({ getText, signature, prepare, failure }) {
  let current;
  let pending;
  let failed;
  let closed = false;
  const keyOf = text => JSON.stringify([text, signature()]);
  const isCurrent = key => !closed && key === keyOf(getText());
  const discard = entry => { if (entry) void Promise.resolve(retire(entry)).catch(() => {}); };

  function generate(text) {
    if (closed) return Promise.reject(new Error('称呼应答已关闭。'));
    const key = keyOf(text);
    if (!isCurrent(key)) return Promise.reject(new Error('称呼应答已变更。'));
    if (current?.key === key && !pending) return Promise.resolve(current);
    if (pending?.key === key) return pending.promise;
    const job = { key };
    failed = undefined;
    pending = job;
    job.promise = (async () => {
      try {
        const audio = await prepare(text);
        if (pending !== job || !isCurrent(key)) {
          await audio.cleanup();
          throw new Error('称呼应答已变更。');
        }
        const old = current;
        current = { key, id: randomBytes(32).toString('hex'), audio, users: 0 };
        discard(old);
        return current;
      } catch (error) {
        if (pending === job && isCurrent(key)) failed = { key, message: failure(error) };
        throw error;
      } finally {
        if (pending === job) pending = undefined;
      }
    })();
    return job.promise;
  }

  return {
    generate,
    state(text) {
      const key = keyOf(text);
      if (pending?.key === key) return { phase: 'generating' };
      if (current?.key === key) return { phase: 'ready', id: current.id };
      if (failed?.key === key) return { phase: 'failed', message: failed.message };
      return { phase: 'idle' };
    },
    async acquire(text) {
      const entry = await generate(text);
      const usable = () => !entry.retired && isCurrent(entry.key);
      if (!usable()) throw new Error('称呼应答已变更。');
      entry.users++;
      return { ...entry.audio, isCurrent: usable, async cleanup() {
        if (--entry.users === 0 && entry.retired) await entry.audio.cleanup();
      } };
    },
    preview(text, id) {
      if (current?.key === keyOf(text) && current.id === id) return { absoluteFile: current.audio.file };
      throw new Error('称呼应答尚未生成。');
    },
    async close() {
      closed = true;
      const entry = current;
      current = undefined;
      if (entry) await retire(entry);
    },
  };
}
