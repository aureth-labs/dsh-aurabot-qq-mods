// qq-confirm.mjs —— QQ 原生共享/协助「发起前截图确认」的纯词法层
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 只做两件不碰 IO 的事：生成短确认码、解析主人在私聊里的回复。
// 状态机（pending、超时、批准/拒绝）留在 index.mjs，因为它要碰 api 与 safety。

/** 待确认有效期：5 分钟。截图可能包含敏感内容，不要让它长期挂着。 */
export const QQ_CONFIRM_TTL_MS = 5 * 60_000

/** 生成 4 位大写字母/数字确认码；同一时间只允许一条待确认。 */
export function makeQqConfirmId(random = Math.random) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混的 I/O/0/1
  let out = ''
  for (let i = 0; i < 4; i++) {
    const r = Number(random())
    const idx = Number.isFinite(r) ? Math.min(alphabet.length - 1, Math.max(0, Math.floor(r * alphabet.length))) : 0
    out += alphabet[idx]
  }
  return out
}

/**
 * 解析主人回复。只接受整句，不做「包含」匹配，避免「不确认」「确认一下」被误判。
 * 返回 { action: 'confirm'|'cancel', id: string } 或 null。
 * 例：确认 / 确认 AB12 / 同意 / 开始；取消 / 放弃 / 不发
 */
export function parseQqConfirmReply(text) {
  const raw = String(text || '').trim()
  const m = raw.match(/^(确认|同意|开始|取消|放弃|不发)(?:\s+([A-Za-z0-9]{4}))?$/)
  if (!m) return null
  const cancel = /^(取消|放弃|不发)$/.test(m[1])
  return { action: cancel ? 'cancel' : 'confirm', id: String(m[2] || '').toUpperCase() }
}
