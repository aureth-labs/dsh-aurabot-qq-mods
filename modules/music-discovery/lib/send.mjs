// 发送回执判定：按 Aurabot 宿主的真实契约把「真发出 / 面板模拟 / 没发 / 不明」分开。
//
// 宿主 src/chat/hub.js 的 sendSegments：超时、断线会按 uncertain 结算，
// 但仍可能返回 null 或 {queued:true}；null 也可能是总开关关着、试运行、
// 目标无效、被 send 钩子拦下。模块无法从 null 反推「一定没投递」，
// 所以 null/undefined/false/缺 message_id 一律按「不明」处理：
// 不报成功、不补发、进入同聊天同曲的短期防重发。
//
// 只有调用前的确定性拒绝（权限/卸载）才是「确定没调用出口」，由上层单独标记 blocked。

export const SEND_STATUS = Object.freeze({
  delivered: 'delivered',
  simulated: 'simulated',
  notSent: 'not-sent',
  unknown: 'unknown',
  cardUnsupported: 'card-unsupported',
})

/** 宿主回执 → 状态。缺凭证一律 unknown，绝不猜成已发或未发。 */
export function classifySendResult(raw) {
  if (raw === null || raw === undefined || raw === false) {
    return { status: SEND_STATUS.unknown, reason: 'no-receipt', messageId: '' }
  }
  if (typeof raw !== 'object') {
    return { status: SEND_STATUS.unknown, reason: 'no-receipt', messageId: '' }
  }
  const id = raw.message_id ?? raw.messageId
  if (id === null || id === undefined || String(id).trim() === '') {
    return { status: SEND_STATUS.unknown, reason: 'no-receipt', messageId: '' }
  }
  const text = String(id)
  if (text.startsWith('sim-')) return { status: SEND_STATUS.simulated, messageId: text }
  return { status: SEND_STATUS.delivered, messageId: text }
}

// 只有「消息段/卡片类型本身不被接受」这种明确错误才允许退链接。
// 用白名单而不是模糊词：泛称「无法发送」「发送失败」「failed」都不能证明卡片没被接受。
// 中文/英文的超时、断线、结果不明由 AMBIGUOUS 再兜一层，命中即按不明处理。
const CARD_UNSUPPORTED = [
  /\bunsupported\s+(?:message\s+)?segment\b/i,
  /\b(?:message\s+)?segment\s+(?:type\s+)?(?:is\s+)?(?:not\s+supported|unsupported)\b/i,
  /\binvalid\s+(?:message\s+)?segment\b/i,
  /(?:消息段|消息类型|卡片类型)[^，。；,;.\n]{0,8}(?:不支持|无法识别|无效|不认识)/,
  /不支持[^，。；,;.\n]{0,8}(?:消息段|消息类型|卡片类型)/,
]

const AMBIGUOUS = /timeout|timed\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket\s*hang\s*up|aborted|network|disconnect|closed|reset|delivery|uncertain|超时|断线|断开|连接|网络|结果不明|未确认|不确定|无法确认|无法发送|发送失败|失败/i

/** 发送异常 → 状态。默认是最保守的 unknown。 */
export function classifySendError(error) {
  const text = String(error?.message || error || '')
  const unsupported = CARD_UNSUPPORTED.some((re) => re.test(text))
  if (unsupported && !AMBIGUOUS.test(text)) {
    return { status: SEND_STATUS.cardUnsupported, reason: 'segment-unsupported', messageId: '', error: text.slice(0, 120) }
  }
  return { status: SEND_STATUS.unknown, reason: 'error', messageId: '', error: text.slice(0, 120) }
}

/** 只有这两类可以在报告里说成「成功」——模拟要单独说清楚没真发。 */
export function isConfirmed(status) {
  return status === SEND_STATUS.delivered || status === SEND_STATUS.simulated
}
