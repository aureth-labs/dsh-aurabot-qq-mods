// 睡前道别语：不存完整句子，只存「零件」，每次现拼：开头 + 动作 + 尾巴。
// 不用大模型（省钱），但留了口子：farewellUseLlm 打开就走模型。

const OPENERS = ['', '那我', '那我先', '行了', '好了', '不聊了', '得了', '那啥', '诶', '嗯', '好啦']

const NIGHT_ACTS = [
  '去睡了', '睡了', '回被窝了', '下线了', '先撤了', '困死了去睡',
  '躺下了', '眼皮打架了', '撑不住了', '得睡了', '关灯了',
]

// 状态描述型动作前面不加「那我」这类承接词，否则读不通
const STATE_ACTS = ['困死了去睡', '眼皮打架了', '撑不住了', '得睡了']

const NOON_ACTS = ['眯一会儿', '睡个午觉', '躺会儿', '打个盹', '补个觉', '午睡去']

const TAILS = ['', '你也早点', '晚安', '别熬太晚', '你也歇着', '明天见', '睡了啊', '别太晚', '有空再聊', '你也睡吧', '就这样', '醒来再说', '好梦']

const NOON_TAILS = ['', '午安', '一会儿见', '你也歇会儿', '马上回来', '等我醒了说']

const FALLBACK = ['睡了', '先睡啦', '晚安', '困了', '下线啦', '去睡了']

const COMMA_OPENERS = new Set(['嗯', '诶', '好啦', '行了', '得了', '不聊了'])

const pick = (list) => list[Math.floor(Math.random() * list.length)]

export function createLullaby() {
  const recent = new Map()

  function assemble(kind) {
    const noon = kind === 'noon'
    let act = pick(noon ? NOON_ACTS : NIGHT_ACTS)
    let tail = pick(noon ? NOON_TAILS : TAILS)
    let opener = pick(OPENERS)

    // 开头偶尔省略，避免每条都「那我」
    if (opener && Math.random() < 0.35) opener = ''
    // 状态型动作前面不加承接词
    if (opener && STATE_ACTS.some((s) => act.startsWith(s))) opener = ''

    let body
    if (!opener) body = act
    else if (COMMA_OPENERS.has(opener)) body = `${opener}，${act}`
    else body = `${opener}${act}`

    let text = tail ? `${body}，${tail}` : body
    text = text.trim()
    // 收尾不带句号（跟人格的规矩一致）
    while (text && '。｡'.includes(text[text.length - 1])) text = text.slice(0, -1)
    return text
  }

  function compose({ kind = 'night', sessionId = '' } = {}) {
    const key = sessionId || '__all__'
    const list = recent.get(key) || []
    for (let i = 0; i < 8; i += 1) {
      const text = assemble(kind)
      if (text && !list.includes(text)) {
        list.push(text)
        if (list.length > 12) list.splice(0, list.length - 12)
        recent.set(key, list)
        return text
      }
    }
    return pick(FALLBACK)
  }

  /** 给多个会话各拼一句：统一 / 各说各的 / 强制不同。 */
  function composeMany(sessionIds, { kind = 'night', same = false, random = true } = {}) {
    if (!sessionIds.length) return {}
    let unify = same
    if (!same && random) unify = Math.random() < 0.5
    if (unify) {
      const one = compose({ kind, sessionId: '__unified__' })
      return Object.fromEntries(sessionIds.map((id) => [id, one]))
    }
    if (!random && !same) {
      const pool = []
      for (let i = 0; i < sessionIds.length * 4; i += 1) {
        const text = assemble(kind)
        if (text && !pool.includes(text)) pool.push(text)
        if (pool.length >= sessionIds.length) break
      }
      while (pool.length < sessionIds.length) pool.push(pick(FALLBACK))
      return Object.fromEntries(sessionIds.map((id, i) => [id, pool[i]]))
    }
    return Object.fromEntries(sessionIds.map((id) => [id, compose({ kind, sessionId: id })]))
  }

  return { compose, composeMany }
}

export const isFarewell = (text) =>
  ['晚安', '睡了', '先撤', '下线', '眯一会', '午安', '困'].some((m) => String(text || '').includes(m))
