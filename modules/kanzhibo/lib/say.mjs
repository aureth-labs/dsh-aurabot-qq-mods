// lib/say.mjs —— 弹幕/评论的冷却、日志、引号剥离、主人私聊判定（纯逻辑，不含页面点击）。
export function createSay({ ctx, saveState, dayKey, ownerChat }) {
    const SAY_GAP_MS = 10_000
    // 2026-11-10：冷却时间戳落盘 —— 原来只在内存，模块一重载冷却就没了，
    //   重载后立刻连发两条会碰抖音风控。真发出去了才写盘。
    const sayWaitSec = () => {
      const left = SAY_GAP_MS - (Date.now() - ctx.lastSayAt)
      return left > 0 ? Math.ceil(left / 1000) : 0
    }
    const markSaySent = () => { ctx.lastSayAt = Date.now(); saveState({ lastSayAt: ctx.lastSayAt}) }

    // 2026-11-10 加：今天的弹幕记录（F4）—— 自检/面板能看，出错好回查。
    // 只存今天：{ day, items: [{ at, text }] }，跨天清空。
    const pushSayLog = (text) => {
      if (ctx.sayLog.day !== dayKey()) ctx.sayLog = { day: dayKey(), items: [] }
      ctx.sayLog.items.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text: String(text).slice(0, 60) })
      if (ctx.sayLog.items.length > 50) ctx.sayLog.items = ctx.sayLog.items.slice(-50)
      saveState({ sayLog: ctx.sayLog})
    }

    // 私信弹幕长度上限：抖音评论框本身就短（长了页面会截断 / 拒发），
    // 50 个字够说一句完整的话，也能挡住误粘贴一大段。
    const SAY_MAX_CHARS = 50

    // 命令里给内容剥一层成对引号：「主播加油」/ “主播加油” → 主播加油（只剥最外层一层）
    const stripQuotes = (s) => {
      const t = String(s || '').trim()
      const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]]
      for (const [a, b] of pairs) {
        if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) return t.slice(1, -1).trim()
      }
      return t
    }

    // 这条命令是不是主人本人的私聊里发来的。
    //   框架的 api.command 本来就只认主人，但主人也可能在**群里**敲这条命令 ——
    //   那时候 msg.chatId 是 group:…，照拒；必须是 private:<主人QQ> 才放行。
    const fromOwnerDm = (msg) => {
      const dm = ownerChat()
      return Boolean(dm) && String((msg && msg.chatId) || '') === dm
    }


  return { SAY_GAP_MS, SAY_MAX_CHARS, sayWaitSec, markSaySent, pushSayLog, stripQuotes, fromOwnerDm }
}
