// lib/gate.mjs —— 「半自动」的待确认闸门：一次只放一个动作，有有效期，只能用一次。
// 纯状态机（时间函数注入），不碰网络、不碰 DOM、不自己起定时器（过期由模块那边扫）。

export function createGate({ ttlMs = 90000, now = () => Date.now() } = {}) {
  let cur = null
  let seq = 0

  return {
    ttlMs,
    /** 改有效期（面板里那个「等你多少秒」）。 */
    setTtl(ms) {
      const n = Number(ms)
      if (Number.isFinite(n) && n > 0) this.ttlMs = n
      return this.ttlMs
    },
    /** 开一个待确认动作；已经有一个没结掉时直接拒绝（不排队、不覆盖）。 */
    open(action) {
      const live = this.peek()
      if (live) return { ok: false, reason: '还有一个在等你确认：' + live.label }
      const id = 'a' + (++seq) + '-' + now().toString(36).slice(-4)
      cur = Object.assign({}, action, { id, at: now(), deadline: now() + this.ttlMs })
      return { ok: true, action: cur }
    },
    /** 当前待确认；过期就当没有（返回 null，同时能拿到 lastExpired）。 */
    peek() {
      if (!cur) return null
      if (now() > cur.deadline) {
        this.lastExpired = cur
        cur = null
        return null
      }
      return cur
    },
    /** 取走并作废（确认 / 取消都走这里，保证只用一次）。 */
    take(id) {
      const live = this.peek()
      if (!live) return null
      if (id && String(id) !== live.id) return null
      cur = null
      return live
    },
    /** 扫一次过期：给模块的定时器用，返回刚过期的那个（没有就 null）。 */
    sweep() {
      this.lastExpired = null
      this.peek() // peek 发现过期时会写进 lastExpired
      const gone = this.lastExpired || null
      this.lastExpired = null
      return gone
    },
    clear() { cur = null; this.lastExpired = null },
    dispose() { cur = null; this.lastExpired = null },
    state() {
      const live = this.peek()
      return live
        ? { id: live.id, kind: live.kind, label: live.label, at: live.at, deadline: live.deadline, leftMs: Math.max(0, live.deadline - now()) }
        : null
    },
  }
}
