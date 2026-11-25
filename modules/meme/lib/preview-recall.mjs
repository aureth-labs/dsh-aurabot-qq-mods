// Only confirmed outgoing preview IDs are retained; never keep images or QQ events in timers.
export function createPreviewRecall(api) {
  const timers = new Set();
  let disposed = false;
  const warn = () => api.log.warn('预览图未能自动撤回，请在 QQ 中检查；这不会影响继续制作表情。');
  function schedule(id) {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (disposed) return;
      try { await api.onebot('delete_msg', { message_id: id }, { timeoutMs: 5000, retries: 0 }); }
      catch { warn(); }
    }, 3000);
    timer.unref?.();
    timers.add(timer);
  }
  return {
    add(receipt, simulated = false) {
      if (disposed || simulated) return;
      const id = receipt?.message_id;
      if ((typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'number' && !Number.isSafeInteger(id)) || !/^-?[1-9]\d{0,19}$/.test(String(id))) { warn(); return; }
      schedule(id);
    },
    dispose() { disposed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}
