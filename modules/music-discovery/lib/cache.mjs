// 会话内有界 TTL 缓存：支持「第三首」「刚才那首」，绝不串到别的聊天。
// 只在内存里，不落盘、不扫盘；模块卸载时 clear() 一并丢掉。

const DEFAULT_TTL_MS = 10 * 60 * 1000
const UNKNOWN_SEND_TTL_MS = 90 * 1000

export function createChatCache({
  ttlMs = DEFAULT_TTL_MS,
  unknownSendTtlMs = UNKNOWN_SEND_TTL_MS,
  maxChats = 200,
  maxSetsPerChat = 3,
  now = Date.now,
} = {}) {
  /** chatId -> { sets: [{ kind, query, candidates, note, at }], unknown: Map<key, ts> } */
  const chats = new Map()

  function touch(chatId) {
    const entry = chats.get(chatId)
    if (!entry) return null
    chats.delete(chatId)
    chats.set(chatId, entry)
    return entry
  }

  function trim(entry) {
    const stamp = now()
    entry.sets = entry.sets.filter((set) => stamp - set.at < ttlMs).slice(-maxSetsPerChat)
    for (const [key, at] of entry.unknown) {
      if (stamp - at >= unknownSendTtlMs) entry.unknown.delete(key)
    }
  }

  function ensure(chatId) {
    let entry = touch(chatId)
    if (!entry) entry = { sets: [], unknown: new Map() }
    trim(entry)
    chats.set(chatId, entry)
    while (chats.size > maxChats) chats.delete(chats.keys().next().value)
    return entry
  }

  return {
    /**
     * 记下一次结果（同一聊天只留最近几组）。
     * - song=false：歌单/榜单/歌手等非歌曲列表，不能直接按序号分享。
     * - features：这组结果由哪些能力产出（含依赖）。分享前必须按当前设置逐个复核，
     *   这样「查完再关开关」也不会拿旧候选继续发。
     * - private：账号私人数据（每日推荐/猜你喜欢/AI 歌单）。只允许当前主人在私聊里分享，
     *   不受 ownerOnly=false 放开。被拒绝的结果不会走到这里（调用方先复核再记）。
     */
    remember(chatId, {
      kind,
      query = '',
      platform = '',
      candidates = [],
      note = '',
      choiceRequired = false,
      song = true,
      features = ['search'],
      private: isPrivate = false,
    } = {}) {
      if (!chatId) return null
      const list = Array.isArray(candidates) ? candidates.slice(0, 5) : []
      if (!list.length) return null
      const entry = ensure(chatId)
      entry.sets.push({
        kind: kind || 'search',
        query,
        platform,
        candidates: list,
        note,
        song: song !== false,
        choiceRequired: Boolean(choiceRequired),
        features: Array.isArray(features) && features.length ? [...new Set(features)] : ['search'],
        private: isPrivate === true,
        at: now(),
      })
      entry.sets = entry.sets.slice(-maxSetsPerChat)
      return entry.sets[entry.sets.length - 1]
    },

    /** 最近一组的结果被判定为「必须由用户选序号」时打标（关键词分享的 needs-choice 用）。 */
    markChoiceRequired(chatId) {
      const latest = this.latest(chatId)
      if (!latest) return false
      latest.choiceRequired = true
      return true
    },

    /** 最近一组还没过期的结果；没有就返回 null。 */
    latest(chatId) {
      if (!chatId) return null
      const entry = touch(chatId)
      if (!entry) return null
      trim(entry)
      const last = entry.sets[entry.sets.length - 1]
      return last && now() - last.at < ttlMs ? last : null
    },

    /** 序号取候选（1 开始）；越界返回 { error }。 */
    pick(chatId, index = 1) {
      const latest = this.latest(chatId)
      if (!latest) return { error: 'empty' }
      const n = Math.trunc(Number(index))
      if (!Number.isFinite(n) || n < 1) return { error: 'bad-index' }
      const candidate = latest.candidates[n - 1]
      if (!candidate) return { error: 'out-of-range', size: latest.candidates.length }
      return { candidate, latest }
    },

    /** 按关键词在缓存里找（歌名或歌手包含）。 */
    find(chatId, keyword) {
      const latest = this.latest(chatId)
      if (!latest) return null
      const text = String(keyword || '').trim().toLowerCase()
      if (!text) return null
      const hit = latest.candidates.find((item) => {
        const title = String(item.title || '').toLowerCase()
        const artists = (item.artists || []).join('/').toLowerCase()
        return title.includes(text) || artists.includes(text)
      })
      return hit ? { candidate: hit, latest } : null
    },

    /** 「发送结果不明」的保护：短时间内不许对同一首重发。 */
    noteUnknownSend(chatId, key) {
      if (!chatId || !key) return
      ensure(chatId).unknown.set(key, now())
    },

    unknownSend(chatId, key) {
      if (!chatId || !key) return false
      const entry = touch(chatId)
      if (!entry) return false
      trim(entry)
      const at = entry.unknown.get(key)
      return Boolean(at && now() - at < unknownSendTtlMs)
    },

    clearUnknownSend(chatId, key) {
      const entry = chats.get(chatId)
      if (entry) entry.unknown.delete(key)
    },

    clear() {
      for (const entry of chats.values()) entry.unknown.clear()
      chats.clear()
    },

    get size() {
      return chats.size
    },
  }
}
