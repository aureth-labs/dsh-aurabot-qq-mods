// 分裂表里的号码串 → chatId。
// 面板上让人直接填 QQ 号，所以这里负责「这个号是群还是私聊」：
// 带了 group:/private: 前缀的听前缀；光一个号就查已知群号，是群就算群，否则算私聊。
const PREFIX_RE = /^(group|群|g|private|私聊|p|user|qq)\s*[:：]?\s*(\d{3,})$/i
const NUM_RE = /^\d{3,}$/
const SPLIT_RE = /[\s,，;；、|/]+/

/** 号码串 → { chatIds: string[], unknown: string[] } */
export function parseSplitIds(text, groupIds = new Set()) {
  const chatIds = []
  const unknown = []
  for (const raw of String(text || '').split(SPLIT_RE)) {
    const tok = raw.trim()
    if (!tok) continue
    const m = PREFIX_RE.exec(tok)
    if (m) {
      const kind = /^(group|群|g)$/i.test(m[1]) ? 'group' : 'private'
      chatIds.push(`${kind}:${m[2]}`)
      continue
    }
    if (NUM_RE.test(tok)) {
      const kind = groupIds.has(tok) ? 'group' : 'private'
      chatIds.push(`${kind}:${tok}`)
      continue
    }
    unknown.push(tok)
  }
  return { chatIds: [...new Set(chatIds)], unknown }
}

/** 分裂表 → { map: Map<chatId, persona>, detail: [{ ids, persona, chatIds, unknown }] } */
export function splitMapOf(rows, groupIds = new Set()) {
  const map = new Map()
  const detail = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const ids = String(row?.ids || '').trim()
    const persona = String(row?.persona || '').trim()
    const { chatIds, unknown } = parseSplitIds(ids, groupIds)
    detail.push({ ids, persona, chatIds, unknown })
    if (!persona) continue
    for (const chatId of chatIds) map.set(chatId, persona) // 后面的组覆盖前面的
  }
  return { map, detail }
}
