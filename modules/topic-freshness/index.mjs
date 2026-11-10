// 群聊话题时效 —— 超过 10 分钟的老话题不要再捡回来
//
// 主人 2026-11-10 的要求：「一个话题如果超过了 10 分钟 就不要再聊那个了…
// 大皇堡都是之前的话题，就不要在后面再说一遍，这样有点累赘」
//
// 做法分两层：
//  1) 判断层：config.group.activeWindowSec 决定「多算在聊」，把它压到 10 分钟（600 秒），
//     超过这个窗口的消息就不再参与「群里在聊什么」的相关度计算 → 不会因为老话题被触发插话。
//  2) 表达层：往她的规则里塞一条「话题时效」，让她自己知道别回头捡老话题；
//     并把每个群最近 10 分钟的话题词带进上下文，让她看得到「现在聊的是什么」。
//
// 只动群聊（social），主人私聊完全不受影响。

const TEN_MIN = 600

export default {
  id: 'topic-freshness',
  name: '话题时效',
  version: '1.0.0',
  api: 1,
  description: '群聊里只在最近 10 分钟的话题上接话，老话题不再回头提，免得累赘',
  defaults: {
    enabled: true,
    minutes: 10,          // 话题有效期（分钟）
    strictness: 'normal', // normal = 提示 + 压窗口 / hard = 只认这窗口内的消息
    hintTopics: true,     // 把当前话题词塞进上下文
  },
  settings: [
    { key: 'enabled', label: '打开', type: 'switch', hint: '关掉就完全不起作用' },
    { key: 'minutes', label: '话题有效期（分钟）', type: 'number', min: 3, max: 60, step: 1, hint: '超过这个时间的老话题不再接' },
    { key: 'strictness', label: '力度', type: 'select', options: [
      { value: 'normal', label: '正常：压窗口 + 提醒她别捡老的' },
      { value: 'hard', label: '严格：只认窗口内的消息算「在聊」' },
    ] },
    { key: 'hintTopics', label: '告诉她现在聊的是什么', type: 'switch', hint: '把最近窗口内的话题词放进上下文' },
  ],
  panel: 'panel.js',

  setup(api) {
    const S = () => ({ ...api.defaults, ...api.settings() })
    const log = (m) => { try { api.log.info(m) } catch {} }
    const warn = (m) => { try { api.log.warn(m) } catch {} }

    const MIN_MS = 60_000
    const winMs = () => Math.max(3, Number(S().minutes) || 10) * MIN_MS

    // 各群最近的消息（自己留一份，用于抽话题词）
    const buf = new Map()   // groupId → [{ t, text, who }]
    const MAX_BUF = 80

    function remember(msg) {
      const gid = String(msg.groupId || '')
      if (!gid) return
      const arr = buf.get(gid) || []
      const text = String(msg.text || '').trim()
      if (text) arr.push({ t: Date.now(), text, who: msg.nickname || '' })
      while (arr.length > MAX_BUF) arr.shift()
      buf.set(gid, arr)
    }

    function freshLines(gid) {
      const now = Date.now()
      const arr = (buf.get(gid) || []).filter((x) => now - x.t < winMs())
      return arr
    }

    // 粗暴提词：去掉 @、标点、语气词，留下 2 字以上的词；取出现次数多的当话题
    const STOP = new Set(['哈哈', '哈', '哈哈哈哈哈', '什么', '这个', '那个', '就是', '不是', '可以', '没有', '我们', '你们', '他们', '怎么', '然后', '现在', '感觉', '真的', '好像', '一个', '这样', '那样', '知道', '还是', '因为', '所以', '但是', '已经', '自己', '时候', '东西', '一直', '有点', '可能'])
    function topicWords(lines, top = 6) {
      const cnt = new Map()
      for (const l of lines) {
        const t = String(l.text || '')
          .replace(/@\S+/g, ' ')
          .replace(/\[[^\]]+\]/g, ' ')
          .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ')
        for (const w of t.split(/\s+/)) {
          if (w.length < 2 || w.length > 12) continue
          if (STOP.has(w)) continue
          if (/^(的|了|吗|呢|吧|啊|呀|哦|嗯|我|你|他|她|它|是|在|有|和|就|都|也|还|要|不)$/.test(w)) continue
          cnt.set(w, (cnt.get(w) || 0) + 1)
        }
      }
      return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([w]) => w)
    }

    // ---------- 1) 压「在聊」的判定窗口 ----------
    function tunePolicy() {
      const s = S()
      if (!s.enabled) return
      try {
        const cfg = api.config()
        const want = Math.round(winMs() / 1000)
        const cur = Number(cfg?.group?.activeWindowSec ?? 0)
        if (cur === want) return
        // 走 setConfig 深合并，只改这一个字段
        api.setConfig({ group: { activeWindowSec: want } })
        log(`群聊「在聊」窗口：${cur || '默认'} → ${want} 秒（${s.minutes} 分钟）`)
      } catch (e) {
        warn('改 activeWindowSec 失败：' + String(e?.message || e))
      }
    }

    // ---------- 2) 收消息 ----------
    api.on('message', (msg) => {
      try { if (msg?.kind === 'group') remember(msg) } catch {}
      return false   // 只记录，不接管
    })

    // ---------- 3) 规则：只在新鲜话题上接话 ----------
    api.rule((kind) => {
      const s = S()
      if (!s.enabled || kind !== 'social') return ''
      const m = Number(s.minutes) || 10
      const hard = s.strictness === 'hard'
      return [
        `【群聊话题时效】只在最近 ${m} 分钟内还在聊的话题上说话。`,
        `- 超过 ${m} 分钟没人提的话题，就是过去了。别自己回头把它捡起来，别补一句「刚才那个…」，也别把已经聊完的梗再复述一遍。`,
        `- 别人明确 @ 你、或者直接问起旧事，才回应；否则就跟着现在的话题走。`,
        `- 不知道现在聊什么，就安静待着，不用硬找话说。`,
        hard ? `- 这一条是硬约束：旧话题一律当没看见。` : '',
      ].filter(Boolean).join('\n')
    })

    // ---------- 4) 上下文：告诉她当下聊的是什么 ----------
    api.on('prompt', (content, { chat, senderId } = {}) => {
      const s = S()
      if (!s.enabled || !s.hintTopics) return
      if (chat?.kind !== 'group') return
      const gid = String(chat.groupId || '')
      if (!gid) return
      const lines = freshLines(gid)
      if (!lines.length) return
      const words = topicWords(lines)
      if (!words.length) return
      const m = Number(s.minutes) || 10
      const line = `【现在群里聊的】（最近 ${m} 分钟）：${words.join('、')}。别的老话题不用接。`
      if (Array.isArray(content)) return [{ type: 'text', text: line }, ...content]
      return String(content || '') + '\n\n' + line
    })

    // ---------- 5) 面板接口 ----------
    api.route('/state', async () => {
      const s = S()
      const cfg = api.config()
      const gids = [...buf.keys()]
      return {
        ok: true,
        enabled: !!s.enabled,
        minutes: Number(s.minutes) || 10,
        strictness: s.strictness,
        hintTopics: !!s.hintTopics,
        activeWindowSec: Number(cfg?.group?.activeWindowSec ?? 0),
        groups: gids.map((g) => {
          const lines = freshLines(g)
          return { groupId: g, fresh: lines.length, topics: topicWords(lines, 5) }
        }),
      }
    })

    api.route('/apply', async () => { tunePolicy(); return { ok: true } })

    api.command({
      name: '话题',
      aliases: ['topics'],
      desc: '看这个群现在在聊什么、窗口内还有几条',
      run: (arg, msg) => {
        const gid = String(msg?.groupId || arg || '').trim()
        if (!gid) return '要在群里用，或者 /话题 群号'
        const lines = freshLines(gid)
        if (!lines.length) return `群 ${gid} 最近 ${S().minutes} 分钟没有新消息`
        const w = topicWords(lines, 8)
        return `群 ${gid}｜最近 ${S().minutes} 分钟 ${lines.length} 条｜话题词：${w.join('、') || '（提不出来）'}`
      },
    })

    // 启动时先把窗口压好（改配置后的下一轮生效）
    api.later(3000, () => tunePolicy())
    log(`话题时效就位：${S().minutes} 分钟一过就不接老话题`)

    return { state: () => ({ minutes: S().minutes, windowMs: winMs() }) }
  },
}
