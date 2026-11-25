// 说话让路（say queue）—— 纯逻辑，不碰 fs / 定时器 / Electron，全部可注入。
//
// 设计出处：Astra Pet 0.2.3 的「宠物说话会让路」+ agent-hooks §4.4 的 SayLater。
// 我们本来就有零散的「忙的时候先攒着」，但是散在 whisper / behavior / todo 三处各写了一遍，
// 而且口径不一样（碎碎念攒 3 分钟、行为直接丢、待办照发）。这里收成一处：
//
//   · 主人正在用她（对话框开着 / 她正在回话 / 刚聊完 90 秒内）→ **所有非紧急的话都让路**。
//   · 气泡还挂在屏幕上 → 让路（不然两条气泡会互相盖掉，看起来像闪烁）。
//   · 攒着的话有优先级：
//        high   手动「试一下」、用户刚操作触发的反应 —— 永远立刻说，永不攒（人家点了按钮不该没反应）
//        normal 待办到点、干活干完、对话回复 —— 攒，但攒不久（默认 10 分钟过期）
//        low    碎碎念、说梦话、主动搭话 —— 攒，且**聊完天之后也接着说**（这是最该学的一条：
//               她去忙了 20 分钟回来，那几句碎碎念不该消失，应该在气泡空出来的一句一句补上）
//   · 攒的话有上限，超了丢最旧的**低优先级**；high 不占额度。
//
// 注意：这里只管「什么时候说」，不管「说什么」、也不管载体（QQ / 气泡）——那是 index.mjs 的 dispatch。

export const PRIORITY = { high: 3, normal: 2, low: 1 }

/** 时间戳取有效值：0 是合法的（纪元起点），不能用 `||` 兜底。
 *  踩过：测试注入 now:0，被当成「没传」，所有时间被换成 Date.now()，过期逻辑全错。 */
const ts = (v, fallback = Date.now()) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

const label = (p) => (p >= PRIORITY.high ? 'high' : p >= PRIORITY.normal ? 'normal' : 'low')

/**
 * @param {object} o
 * @param {number} o.maxHold   攒的话最多留几条（不含 high）
 * @param {number} o.ttlMs     攒的话多久过期
 * @param {number} o.remindTtlMs  定时提醒攒得更久（提醒错过就白设了）
 */
export function createSayQueue({ maxHold = 12, ttlMs = 10 * 60_000, remindTtlMs = 60 * 60_000 } = {}) {
  /** @type {Array<{id:number,text:string,purpose:string,priority:number,at:number,ttl:number,slot:any,anim:string,tag:string,meta:object}>} */
  let items = []
  let seq = 0
  const stats = { said: 0, held: 0, dropped: 0, expired: 0 }

  /** 到期就清掉；返回被清掉的条数。 */
  function sweep(now = Date.now()) {
    const before = items.length
    items = items.filter((it) => now - it.at < it.ttl)
    const gone = before - items.length
    stats.expired += gone
    return gone
  }

  /**
   * 现在能不能说话？返回 null = 能说；返回字符串 = 该让路的原因（写日志/调试用）。
   * 全部条件都由调用方算好传进来（纯函数，不读时钟也不读设置）。
   */
  function blockedBy(ctx = {}) {
    const {
      busy = false,            // 她正在回话 / 决策回合进行中
      chatOpen = false,        // 对话框开着
      lastChatAt = 0,          // 最近一次对话（发或收）
      now = Date.now(),
      chatCooldownMs = 90_000,
      bubbleUntil = 0,         // 当前气泡什么时候收起
      quiet = false,           // 静默时段
      focus = false,           // 专注模式
    } = ctx
    if (focus) return 'focus'
    if (quiet) return 'quiet'
    if (busy) return 'busy'
    if (chatOpen) return 'chat-open'
    if (lastChatAt && now - lastChatAt < chatCooldownMs) return 'just-chatted'
    if (bubbleUntil && now < bubbleUntil) return 'bubble'
    return null
  }

  /**
   * 想说话。能说就直接返回 { speak:true, item }；要攒就进池子返回 { speak:false, reason }。
   * high 优先级永远 speak:true（除非调用方自己已经判断过并传 forceWhere）。
   */
  function want({ text, purpose = '', priority = PRIORITY.low, slot = null, anim = '', tag = '', meta = null } = {}, ctx = {}) {
    const t = String(text || '').trim()
    if (!t) return { speak: false, reason: 'empty' }
    const now = ts(ctx.now)
    sweep(now)
    const p = typeof priority === 'number' ? priority : (PRIORITY[priority] || PRIORITY.low)
    const item = {
      id: ++seq, text: t, purpose: String(purpose || ''), priority: p,
      at: now, ttl: purpose === 'todo' ? remindTtlMs : ttlMs,
      slot, anim, tag, meta,
    }
    if (p >= PRIORITY.high) { stats.said++; return { speak: true, item, reason: null } }
    const why = blockedBy(ctx)
    if (!why) { stats.said++; return { speak: true, item, reason: null } }
    items.push(item)
    // 超额度：丢最旧的 low，其次 normal；high 不占额度也不被丢
    while (items.length > maxHold) {
      let idx = items.findIndex((x) => x.priority <= PRIORITY.low)
      if (idx < 0) idx = items.findIndex((x) => x.priority <= PRIORITY.normal)
      if (idx < 0) idx = 0
      items.splice(idx, 1)
      stats.dropped++
    }
    stats.held++
    return { speak: false, reason: why, item }
  }

  /**
   * 取出下一句该说的（优先级高的先、同优先级早的先）。ctx 里 blockedBy 说不能就返回 null。
   * 注意：**一次只取一句**——调用方说完之后隔一会再来取，别一口气全倒出来。
   */
  function next(ctx = {}) {
    const now = ts(ctx.now)
    sweep(now)
    if (!items.length) return null
    if (blockedBy(ctx)) return null
    // 按优先级降序，同优先级按时间升序
    let best = 0
    for (let i = 1; i < items.length; i++) {
      const a = items[i]
      const b = items[best]
      if (a.priority > b.priority || (a.priority === b.priority && a.at < b.at)) best = i
    }
    const [item] = items.splice(best, 1)
    stats.said++
    return item
  }

  /** 当前攒着几句（调试 / 状态回显用）。 */
  function pending(now = Date.now()) {
    sweep(now)
    return items.length
  }

  /** 攒着的话一览（面板显示「她被攒下来的几句」）。 */
  function list(now = Date.now()) {
    sweep(now)
    return items.map((it) => ({ id: it.id, text: it.text, purpose: it.purpose, priority: label(it.priority), ageMs: now - it.at }))
  }

  /** 清空（关掉桌宠 / 换宠物时）。 */
  function clear() { items = []; }

  function snapshot(now = Date.now()) {
    return { pending: pending(now), ...stats, list: list(now) }
  }

  return { want, next, pending, list, clear, sweep, blockedBy, snapshot, get stats() { return { ...stats } } }
}
