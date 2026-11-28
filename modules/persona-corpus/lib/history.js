/**
 * 最近消息的小环形缓冲。
 *
 * 用途只有一个：群里有人说「就是刚才那句」，她不用整句抄，
 * 给一个 messageId（或者干脆说「最近那条」）就能把原文取回来。
 * 只活在内存里，不落盘 —— 素材库记的是素材，不是聊天流水。
 */

export function makeRing({ limit = 15 } = {}) {
  const keep = Math.max(1, Math.min(50, Number(limit) || 15))
  const chats = new Map()

  const bucket = (chatId) => {
    const key = String(chatId ?? '')
    if (!key) return null
    let list = chats.get(key)
    if (!list) {
      list = []
      chats.set(key, list)
    }
    return list
  }

  return {
    /** 记一条：{ who: 'in'|'out', text, messageId?, userId?, nickname? } */
    push(chatId, item) {
      const list = bucket(chatId)
      if (!list || !item) return
      const text = String(item.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) return
      list.push({
        who: item.who === 'out' ? 'out' : 'in',
        text: text.length > 500 ? text.slice(0, 500) : text,
        messageId: item.messageId === undefined || item.messageId === null ? null : String(item.messageId),
        userId: item.userId ? String(item.userId) : '',
        nickname: item.nickname ? String(item.nickname) : '',
      })
      if (list.length > keep) list.splice(0, list.length - keep)
    },

    /** 这个聊天里最后一条（谁说的都算） */
    lastOf(chatId) {
      const list = chats.get(String(chatId ?? ''))
      return list && list.length ? list[list.length - 1] : null
    },

    /** 按 messageId 找。找不到返回 null，让调用方去问她「原话是什么」 */
    findByMessageId(chatId, messageId) {
      const want = String(messageId ?? '').trim()
      if (!want) return null
      const list = chats.get(String(chatId ?? '')) || []
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].messageId === want) return list[i]
      }
      return null
    },

    /** 某个聊天最近第 n 条（n=0 是最后一条）；越界返回 null */
    at(chatId, n = 0, { who } = {}) {
      const list = chats.get(String(chatId ?? '')) || []
      const filtered = who ? list.filter((i) => i.who === who) : list
      const idx = filtered.length - 1 - Math.max(0, Number(n) || 0)
      return idx >= 0 && idx < filtered.length ? filtered[idx] : null
    },

    size(chatId) {
      const list = chats.get(String(chatId ?? ''))
      return list ? list.length : 0
    },

    clear(chatId) {
      if (chatId === undefined) chats.clear()
      else chats.delete(String(chatId ?? ''))
    },
  }
}
