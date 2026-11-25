// 游戏内时间：把 `time query daytime` 的 ticks 翻译成「白天 / 夜晚」这类人话。
// 聊天里说到「白天、晚上、天黑了」时用它，别拿现实时间去猜游戏里的天。

const DAY = 24000

/** 0~24000 ticks → 清晨 / 白天 / 黄昏 / 夜晚 / 深夜。 */
export function dayPhase (ticks) {
  const t = ((Number(ticks) % DAY) + DAY) % DAY
  if (t < 1000) return '清晨'
  if (t < 12000) return '白天'
  if (t < 13800) return '黄昏'
  if (t < 22200) return '夜晚'
  return '深夜'
}

/** 从 `The time is 7173` / `当前时间是 7173` 里取 ticks；取不到返回 null。 */
export function parseTimeReply (text) {
  const m = String(text || '').match(/(?:time is|时间是)\s*(\d+)/i)
  return m ? Number(m[1]) : null
}
