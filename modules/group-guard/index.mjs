// 群聊特别处理：给指定的群补背景，并给「必回」加硬上限。
//
// 为什么要有这个：有些群是别人的机器人扎堆的地方（各种机器人开着同一套插件互相聊天）。
// 那种群里光靠插话概率拦不住——她回一句，别的 AI 就 @ 她、引用她回一句，而 @ 和引用
// 都属于「必回」，必回不受插话概率、冷却、每小时上限、连发刹车任何限制，
// 于是两边能一路互相 @ 互相引用停不下来（实测 20 分钟 58 条）。
//
// 这里做两件事：
//   ① 背景说明：告诉她这个群是什么情况（每轮塞进上下文）
//   ② 必回限流：同一个群里，最近 N 分钟内最多「必回」M 次，超了就当没看见。
//      这是唯一能在机器人互刷时真正刹住车的闸——因为它管的是 must 那条路。
//
// 设置一行一条：群号 | 说明 | 选项
//   123456789 | 这个群里基本都是别的 AI 机器人 | 必回 5 分钟 2 次
// 说明和选项都可省略；不写选项就用默认（5 分钟 2 次）。
// 还可以写「只认@」：连 @ 之外的其他必回（引用、叫名字）也不认。

const HEAD = '【这个群的情况，她需要知道的背景】'

/** 解析「必回 5 分钟 2 次」这种选项。 */
export function parseLimit(text) {
  const t = String(text || '')
  const m = t.match(/必回\s*(\d+)\s*分钟\s*(\d+)\s*次/)
  const onlyAt = /只认 *@|只认at|onlyat/i.test(t)
  return {
    windowMin: m ? Math.max(1, Math.min(720, Number(m[1]))) : 5,
    max: m ? Math.max(0, Math.min(50, Number(m[2]))) : 2,
    onlyAt,
    explicit: Boolean(m) || onlyAt,
  }
}

/** 解析设置：{ 群号: { note, ...limit } }。 */
export function parseNotes(raw) {
  const out = new Map()
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^(\d{5,12})\s*[|｜=＝:：]\s*([\s\S]*)$/)
    if (!m) continue
    const parts = m[2].split(/\s*[|｜]\s*/)
    const note = (parts[0] || '').trim()
    const limit = parseLimit(parts.slice(1).join(' '))
    if (note || limit.explicit) out.set(m[1], { note, ...limit })
  }
  return out
}

/** 这个 chat 的群配置（群聊才有）。 */
export function ruleFor(chatId, kind, raw) {
  if (kind !== 'group') return null
  const m = /^group:(\d+)$/.exec(String(chatId || ''))
  return m ? (parseNotes(raw).get(m[1]) || null) : null
}

/** 上下文那一段；没配说明就是空串。 */
export function noteText(chatId, kind, raw) {
  const r = ruleFor(chatId, kind, raw)
  return r?.note ? `${HEAD}\n${r.note}` : ''
}

/**
 * 决定这次必回要不要放行。纯函数，便于测试。
 * @param {{mode:string, mentioned:boolean, reason?:string}} decision
 * @param {{tight:boolean, windowMin:number, max:number}} rule
 * @param {number[]} times 这个群最近几次必回的时间戳（毫秒）
 * @param {number} now
 * @returns {null|{reply:false, mode:'none', reason:string}} 返回 null = 放行
 */
export function limitDecision(decision, rule, times, now) {
  if (!decision?.reply) return null
  // 只管必须说话（must）和正聊得起劲（engaged）这两条路。
  // engaged 一定要算上：它明确「不受冷却和每小时上限限制」，机器人互刷时真正在说话的
  // 就是这条路——@ 只是点火，烧起来靠 engaged 一句接一句。只拦 must 等于没拦。
  const counted = decision.mode === 'must' || decision.mode === 'engaged'
  if (!counted) return null
  // 「只认@」只管 must：engaged 是她自己接着聊，没有「被叫到」这回事，拿它去卡会误伤
  if (rule.onlyAt && decision.mode === 'must' && !decision.mentioned) {
    return { reply: false, mode: 'none', reason: `这个群只认 @（${decision.reason || '被叫到'}不算）` }
  }
  const win = rule.windowMin * 60_000
  const recent = (times || []).filter((t) => now - t < win).length
  if (recent >= rule.max) {
    const what = decision.mode === 'engaged' ? '说话' : '必回'
    return { reply: false, mode: 'none', reason: `${what}太频繁（${rule.windowMin} 分钟内已 ${recent} 次，上限 ${rule.max}）` }
  }
  return null
}

export default {
  id: 'group-guard',
  name: '群聊特别处理',
  version: '1.0.0',
  api: 1,
  description: '给指定的群加背景说明，并给「她会不会开口」加硬上限——必回和「正聊得起劲」都算，防止在机器人扎堆的群里一句接一句刷屏。',
  // 默认不预置任何群：每个人的群不一样，预置别人的群号只会误导。按需自己填。
  defaults: {
    enabled: true,
    notes: '',
  },
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    {
      key: 'notes',
      label: '各群的特别处理',
      type: 'textarea',
      hint: '一行一个群：群号 | 说明 | 必回 5 分钟 2 次。说明和选项都可以省略（不写选项 = 5 分钟最多 2 次）；写「只认@」的群，只有被 @ 才算必回。行首加 # 是注释。',
      placeholder: '123456789 | 这个群里基本都是别的 AI 机器人 | 必回 5 分钟 2 次',
    },
  ],

  setup(api) {
    // 群号 → 最近几次「必回」的时间戳
    const mustTimes = new Map()

    // ① 背景说明：每轮聊天前塞进上下文。api.settings() 每次读最新值，改了不用重载模块。
    api.context(({ chat }) => {
      const st = api.settings()
      if (!st?.enabled) return ''
      return noteText(chat?.chatId, chat?.kind, st.notes)
    })

    // ② 必回限流：在「回不回」定下来之后、交给她之前改
    api.on('group/decide', (decision, info) => {
      const st = api.settings()
      if (!st?.enabled) return
      const gid = String(info?.msg?.groupId || '')
      const rule = ruleFor(info?.msg?.chatId, 'group', st.notes)
      if (!gid || !rule) return
      const now = Date.now()
      const times = (mustTimes.get(gid) || []).filter((t) => now - t < 24 * 3600_000)
      mustTimes.set(gid, times)
      const blocked = limitDecision({ ...decision, mentioned: Boolean(info?.msg?.mentioned) }, rule, times, now)
      if (blocked) return blocked
      // 放行了：must 和 engaged 都记一笔，后面的消息才看得见这次占用
      if (decision?.reply && (decision.mode === 'must' || decision.mode === 'engaged')) {
        times.push(now)
        mustTimes.set(gid, times)
      }
      return undefined
    })
  },
}
