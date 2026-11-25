// 群聊日报：每天到点把当天的聊天压成几条要点，私聊推给主人。
//
// 它专门盯人做不到的事：谁在发愁什么、哪句话被岔开没接住、什么事定了却没落地。
// 数据来源和巡查模块一样，读的是聊天流水（chatlog/YYYY-MM-DD.jsonl）。
//
// 配置在 config.json → ext.digest：
//   enabled / atHour / atMinute / maxMessages / includePrivate

import { readFileSync, writeFileSync } from 'node:fs'

// 消息条数由代码算好塞进提示词。原来写的是「今天<N>条消息」让模型自己填，
// 模型看不见总数只能瞎猜（晚报的「5月7日」就是这么来的，2026-11-08 一并修）。
export const systemPrompt = (total) => `你在给主人写今天的聊天日报。看完下面一整天的聊天记录，挑出真正值得她知道的事。

输出格式（严格照这个来，不要多写）：
今天${total}条消息，<一句话概括今天的气氛或主题>

· 要点一
· 要点二
· 要点三

挑要点的优先级，从高到低：
1. 有人在为具体的事发愁、卡住、做不完（说清是什么事、卡在哪）
2. 某句话被岔开了、没人正面回答，事情悬着没解决
3. 什么事说定了但没落地（约了打球没说地点、说要发东西没发）
4. 谁能帮上谁（A 问的问题正好是 B 熟的）
5. 情绪或关系上的变化（谁不高兴了、谁和谁聊得来）

规则：
- 最多 5 条要点，每条一行，不超过 40 字，用真人名字，不要写"某用户"
- 寒暄、表情、晚安早安、"哈哈哈"这类一律不写
- 不要复述原话，写清楚"谁 + 在做什么 + 卡在哪"
- 不要 markdown：不要 **加粗**、不要 # 标题、不要代码块
- 如果今天确实没什么值得说的，只输出一行：今天没什么事
- 不要编造记录里没有的事
- 直接开始写正文，不要写思考过程、不要写"好的"`

// 语音记账文件（可选）：自建 TTS 中间层会在这个 JSON 里记当天的语音条数和积分。
// 路径由用户自己在面板里填，留空就不带这一行——不能把某台机器的绝对路径写死在模块里。
function voiceStats(today, statePath) {
  try {
    const p = String(statePath || '').trim()
    if (!p) return ''
    const s = JSON.parse(readFileSync(p, 'utf8'))
    if (!s || s.date !== today) return ''
    const n = Number(s.count) || 0
    const used = Number(s.used) || 0
    if (!n) return ''
    return `另外，今天她发了 ${n} 条语音，花了 ${used.toFixed(1)} 积分。`
  } catch (error) {
    return ''
  }
}

export const dayKey = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const cut = (s, n) => {
  const t = String(s || '').replace(/[\r\n]+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
// 没什么信息量的消息，别浪费字数
export const NOISE = /^(\[图片\]|\[表情\]|\[语音\]|\[文件\]|\[视频\]|嗯+|哦+|啊+|好+|哈+|收到|在吗|晚安|早安|早|睡了|1+)$/

/**
 * 把一天的聊天流水整理成喂给模型的分段文本。
 * chatLog: [{ t, chatId, who, uid, text }]
 * nameOf(群号) 只在需要显示群名时调用，方便测试时注入。
 * 返回 { parts, total, per } —— parts 为空说明今天没什么可写的。
 */
export function buildInput(chatLog, { ownerQQ = '', budget = 400, includePrivate = true, nameOf = () => '' } = {}) {
  const groups = new Map()
  let total = 0
  for (const e of chatLog || []) {
    if (!e || !e.text) continue
    const text = String(e.text).trim()
    if (!text || NOISE.test(text)) continue
    const isGroup = String(e.chatId || '').startsWith('group:')
    if (!isGroup && includePrivate === false) continue
    if (!groups.has(e.chatId)) groups.set(e.chatId, [])
    groups.get(e.chatId).push(e)
    if (e.who !== 'bot') total += 1
  }
  // 条数预算按聊天数平摊，每个聊天至少留 30 条，免得小群被大群挤没
  const per = Math.max(30, Math.floor(Math.max(50, Number(budget) || 400) / Math.max(1, groups.size)))
  const parts = []
  for (const [chatId, rows] of groups) {
    if (String(chatId) === `private:${ownerQQ}`) continue // 主人自己的私聊不进日报
    const isGroup = String(chatId).startsWith('group:')
    const gid = isGroup ? String(chatId).slice(6) : ''
    const where = isGroup ? `群「${nameOf(gid) || gid}」` : '私聊'
    const lines = rows.slice(-per).map((e) => {
      const who = e.who === 'bot' ? '她自己' : e.who || e.uid || '某人'
      return `${who}: ${cut(e.text, 120)}`
    })
    if (lines.length) parts.push(`【${where}】\n${lines.join('\n')}`)
  }
  return { parts, total, per }
}

export default {
  id: 'digest',
  name: '群聊日报',
  version: '1.0.0',
  description: '每天到点把当天群聊压成几条要点私聊推给主人：谁在发愁、哪句话被岔开、什么事说定了没落地',
  api: 1,
  defaults: {
    enabled: true,
    atHour: 22,
    atMinute: 30,
    maxMessages: 400,
    includePrivate: true,
    voiceStatePath: '',
  },
  settings: [
    { key: 'enabled', label: '每天定时推', type: 'switch', hint: '关掉只停定时；/日报 随时能手动生成一份' },
    { key: 'atHour', label: '几点（小时）', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'atMinute', label: '几分', type: 'number', min: 0, max: 59, step: 5 },
    { key: 'maxMessages', label: '总字数预算（条）', type: 'number', min: 50, max: 1000, step: 50, hint: '喂给模型的聊天条数上限，按活跃度自动摊到各个聊天' },
    { key: 'includePrivate', label: '私聊也算进日报', type: 'switch', hint: '关掉就只看群；和主人的私聊永远不算' },
    { key: 'voiceStatePath', label: '语音记账文件（可选）', type: 'text', placeholder: '例如 D:\\tts\\state.json', hint: '留空就不在日报末尾加语音消耗那一行；填了就按 {date, count, used} 三个字段读' },
  ],
  setup(api) {
    const readJson = (name, fallback) => {
      try {
        return JSON.parse(readFileSync(api.dataDir(name), 'utf8'))
      } catch (error) {
        return fallback
      }
    }
    const writeJson = (name, data) => {
      try {
        writeFileSync(api.dataDir(name), JSON.stringify(data, null, 2), 'utf8')
      } catch (error) {
        api.log.warn('[digest] 写文件失败：', error.message)
      }
    }

    const state = readJson('state.json', { lastDay: '' })
    let running = false

    async function build(force = false) {
      if (running) return { ok: false, message: '上一份还在生成' }
      const s = api.settings()
      if (!s.enabled && !force) return { ok: true, skipped: true }
      running = true
      try {
        const hub = api.core.hub
        const cfg = api.config()
        const ownerQQ = String(cfg.ownerQQ || '')
        const today = dayKey()

        let log = []
        try { log = hub.chatLogOf?.(today) || [] } catch (error) { log = [] }
        if (!log.length) return { ok: false, message: '今天还没有聊天记录' }

        // 按聊天分组（群 / 私聊分开），过滤没营养的消息；群名从这里注入，逻辑本身是纯的
        const { parts, total } = buildInput(log, {
          ownerQQ,
          budget: s.maxMessages,
          includePrivate: s.includePrivate !== false,
          nameOf: (gid) => {
            try {
              return hub.groupName?.(gid) || ''
            } catch (error) {
              return ''
            }
          },
        })
        if (!total) return { ok: false, message: '今天没有值得统计的消息' }
        if (!parts.length) return { ok: false, message: '今天没有可供整理的内容' }

        let answer = ''
        try {
          answer = await api.ask({ system: systemPrompt(total), text: parts.join('\n\n'), maxTokens: 800 })
        } catch (error) {
          api.log.warn('[digest] 生成失败：', error.message)
          return { ok: false, message: '生成失败：' + error.message }
        }
        let body0 = String(answer || '').trim()
        // 空响应（模型把预算花在思考上，或者内容被上游过滤）时降级重试一次：
        // 砍掉一半输入、明确要求直接出正文。今晚就是空响应，静默重试了六次都没人知道。
        if (!body0) {
          const half = parts.map((p) => p.split('\n').slice(0, Math.max(5, Math.ceil(p.split('\n').length / 2))).join('\n'))
          api.log.warn(`[digest] 模型返回空（输入 ${parts.join('\n\n').length} 字），砍半重试一次`)
          try {
            answer = await api.ask({
              system: `${systemPrompt(total)}\n（这次只给你部分记录，挑得出来的就写，挑不出来就回「今天没什么事」）`,
              text: half.join('\n\n'),
              maxTokens: 1200,
            })
            body0 = String(answer || '').trim()
          } catch (error) {
            api.log.warn('[digest] 重试也失败：', error.message)
          }
        }
        if (!body0) return { ok: false, message: '模型没写出东西（空响应，可能是输入触发过滤或推理占满预算）' }

        // 附上今天的语音消耗（数据由 Breeze 中间层记账）
        const vs = voiceStats(today, s.voiceStatePath)
        const body = vs ? `${body0}\n\n${vs}` : body0

        if (ownerQQ) {
          try { await api.sendText(`private:${ownerQQ}`, body) } catch (error) {
            api.log.warn('[digest] 发送失败：', error.message)
            return { ok: false, message: '发送失败：' + error.message }
          }
        }

        if (!force) {
          state.lastDay = today
          writeJson('state.json', state)
        }
        api.log.info(`[digest] 日报已生成（今天 ${total} 条），已发给主人`)
        return { ok: true, text: body, total }
      } catch (error) {
        api.log.error('[digest] 出错：', error.message)
        return { ok: false, message: error.message }
      } finally {
        running = false
      }
    }

    // 每 5 分钟看一次到点没有；今天已经发过就不再发
    //
    // 2026-11-08 修：原来只看「到点了吗」，失败不计数也不记日志，结果失败一次就每 5 分钟
    // 重试一整晚（今晚 22:33 起就在无声重试，谁也不知道为什么没发出去）。
    // 现在：失败写明原因、连续 3 次放弃、只在到点后 3 小时内尝试。
    let failCount = 0
    api.every(5 * 60 * 1000, async () => {
      const s = api.settings()
      if (!s.enabled) return
      if (failCount >= 3) return
      const now = new Date()
      if (state.lastDay === dayKey(now.getTime())) return
      const due = (Number(s.atHour) || 22) * 60 + (Number(s.atMinute) || 30)
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (nowMin < due) return
      if (nowMin > due + 180) return // 过了窗口就别补发，免得半夜一直抢模型
      const r = await build(false)
      if (r.ok) failCount = 0
      else {
        failCount += 1
        api.log.warn(`[digest] 第 ${failCount} 次没成功：${r.message || '未知原因'}`)
      }
    }, '群聊日报')

    api.command({
      name: '日报',
      aliases: ['digest'],
      desc: '立即生成今天的聊天日报（推到你的私聊）',
      run: async () => {
        const r = await build(true)
        return r.ok ? '生成好了，已经发到你私聊。' : (r.message || '生成失败')
      },
    })

    api.log.info(`[digest] 群聊日报已启动，每天 ${api.settings().atHour}:${String(api.settings().atMinute).padStart(2, '0')} 推给主人`)
    return { build, status: () => ({ ...state }) }
  },
}
