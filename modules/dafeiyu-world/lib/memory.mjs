/**
 * 记忆是可选依赖（module.json 里 requires: ["memory"] 但是软依赖）：
 * 没装、被关掉、addEvent 自己抛错，都不能影响世界里的事。
 *
 *   remember(memory, event, onError) -> true 写进去了 / false 没写（不抛）
 */

export function remember(memory, event, onError) {
  if (!memory || typeof memory.addEvent !== 'function') return false;
  try {
    memory.addEvent(event);
    return true;
  } catch (e) {
    if (typeof onError === 'function') {
      try { onError(e); } catch { /* 忽略 */ }
    }
    return false;
  }
}
