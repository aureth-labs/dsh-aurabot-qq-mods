// 补回错过的 @ —— 电脑不会 24 小时开机，重启后把「有人 @ 我但我没回」的补上
//
// 主人 2026-11-10 的要求：「看看之前有人艾特你，但是没回复，也可以补上，
// 毕竟我电脑不可能 24 小时开机，你也不可能 24 小时在线」
//
// 做法：
//   1) 上线时（以及之后每次网关重连）去白名单群拉最近的消息
//   2) 找出「@ 了我、但我没回过」的那几条
//   3) 攒成一份待补清单，攒够一批就补一句（不是逐条复读，那样很吵）
//   4) 只补「还在时效内」的（默认 24 小时），更老的就不翻出来了
//
// 用 OneBot 的 get_group_msg_history 拿历史；拿不到就跳过（不硬凑）。

const DEFAULT_MAX_AGE_MIN = 24 * 60      // 只补 24 小时以内的
const DEFAULT_BATCH_MIN = 8              // 至少攒到 8 分钟前的才算「错过的」
const SEEN_KEEP = 400                    // 记多少条已处理的 msg id

export default {
  id: 'mentions-catchup',
  name: '补回错过的@',
  version: '1.0.0',
  api: 1,
  description: '开机 / 重连后，把没回的 @ 补上；别让断线期间的问题一直凉在那儿',
  defaults: {
    enabled: true,
    groups: '',                 // 留空 = 白名单里所有群
    maxAgeMinutes: DEFAULT_MAX_AGE_MIN,
    minGapMinutes: DEFAULT_BATCH_MIN,
    lookbackCount: 80,          // 每个群往回拉多少条
    maxPerRun: 3,               // 一次最多补几处（免得一开机刷屏）
    sayPrefix: true,            // 补的时候先说一句「刚上线」
    onlyWhitelist: true,
  },
  settings: [
    { key: 'enabled', label: '打开', type: 'switch' },
    { key: 'groups', label: '只在哪些群补（留空 = 白名单全部）', type: 'textarea', hint: '一行一个群号' },
    { key: 'maxAgeMinutes', label: '只补多久以内的（分钟）', type: 'number', min: 10, max: 2880, step: 10 },
    { key: 'minGapMinutes', label: '至少隔多久才算错过（分钟）', type: 'number', min: 1, max: 120, step: 1, hint: '太新的那条她可能正在回，别抢' },
    { key: 'lookbackCount', label: '每个群往回拉多少条', type: 'number', min: 20, max: 200, step: 10 },
    { key: 'maxPerRun', label: '一次最多补几处', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'sayPrefix', label: '补之前先说一句', type: 'switch' },
  ],
  panel: 'panel.js',

  setup(api) {
    const S = () => ({ ...api.defaults, ...api.settings() })
    const log = (m) => { try { api.log.info(m) } catch {} }
    const warn = (m) => { try { api.log.warn(m) } catch {} }

    let busy = false
    const handled = new Set()     // 已经处理过的 msgId
    const handledOrder = []
    let lastRunAt = 0

    const markHandled = (id) => {
      if (!id) return
      handled.add(String(id))
      handledOrder.push(String(id))
      while (handledOrder.length > SEEN_KEEP) {
        const old = handledOrder.shift()
        handled.delete(old)
      }
    }

    function targetGroups() {
      const cfg = api.config()
      const allow = (cfg?.allow?.groups || []).map(String)
      const listed = String(S().groups || '').split(/[\s,，\n]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean)
      const want = listed.length ? listed : allow
      return S().onlyWhitelist ? want.filter((g) => allow.includes(g)) : want
    }

    // @ 我 = 消息段里有 at 且 qq 等于机器人号
    function mentionedMe(raw, botQQ) {
      const segs = raw?.message
      if (Array.isArray(segs)) {
        return segs.some((s) => (s?.type === 'at' || s?.type === 'mention') && String(s?.data?.qq ?? s?.data?.user_id ?? '') === String(botQQ))
      }
      const txt = String(raw?.raw_message || raw?.message || '')
      return botQQ ? txt.includes(`[CQ:at,qq=${botQQ}]`) || txt.includes(`@${botQQ}`) : false
    }

    // 我回过没有：往后看有没有我自己发的消息
    function repliedAfter(list, idx, botQQ) {
      for (let i = idx + 1; i < list.length; i++) {
        if (String(list[i]?.sender?.user_id ?? '') === String(botQQ)) return true
      }
      // 本身就在末尾、后面没人说话 → 也可能是她回了但历史里还没刷新，交给 minGap 兜
      return false
    }

    async function scanGroup(groupId) {
      const s = S()
      const botQQ = api.config()?.botQQ
      if (!botQQ) return []
      let data = null
      try {
        data = await api.onebot('get_group_msg_history', { group_id: Number(groupId), count: Math.max(20, Number(s.lookbackCount) || 80) })
      } catch (e) {
        warn(`拉群 ${groupId} 历史失败：` + String(e?.message || e))
        return []
      }
      const list = (data?.messages || data?.data?.messages || []).slice().sort((a, b) => (a?.time || 0) - (b?.time || 0))
      if (!list.length) return []

      const now = Date.now() / 1000
      const maxAge = (Number(s.maxAgeMinutes) || DEFAULT_MAX_AGE_MIN) * 60
      const minGap = (Number(s.minGapMinutes) || DEFAULT_BATCH_MIN) * 60
      const out = []

      for (let i = 0; i < list.length; i++) {
        const m = list[i]
        const id = m?.message_id
        if (!id || handled.has(String(id))) continue
        const t = Number(m?.time || 0)
        if (!t) continue
        const age = now - t
        if (age > maxAge) { markHandled(id); continue }      // 太老，不再翻
        if (age < minGap) continue                             // 太新，可能在回，先不管
        if (!mentionedMe(m, botQQ)) { markHandled(id); continue }
        if (String(m?.sender?.user_id ?? '') === String(botQQ)) { markHandled(id); continue }
        if (repliedAfter(list, i, botQQ)) { markHandled(id); continue }
        out.push({
          groupId: String(groupId),
          messageId: id,
          time: t,
          ageMinutes: Math.round(age / 60),
          userId: String(m?.sender?.user_id ?? ''),
          name: String(m?.sender?.card || m?.sender?.nickname || ''),
          text: String(m?.raw_message || '').replace(/\[CQ:[^\]]+\]/g, '').trim().slice(0, 200),
        })
      }
      return out
    }

    async function runOnce({ reason = '开机补' } = {}) {
      const s = S()
      if (!s.enabled) return { ok: false, message: '模块关着' }
      if (busy) return { ok: false, message: '上一轮还在跑' }
      if (lastRunAt && Date.now() - lastRunAt < 60_000) return { ok: false, message: '刚跑过，等一分钟' }
      busy = true
      lastRunAt = Date.now()
      try {
        const groups = targetGroups()
        if (!groups.length) return { ok: false, message: '没有可补的群（白名单为空？）' }
        const all = []
        for (const g of groups) {
          const items = await scanGroup(g)
          all.push(...items)
          await new Promise((r) => setTimeout(r, 400))
        }
        if (!all.length) {
          log('检查完毕：没有漏掉的 @')
          return { ok: true, message: '没有漏掉的 @', count: 0 }
        }
        all.sort((a, b) => a.time - b.time)
        const pick = all.slice(0, Math.max(1, Number(s.maxPerRun) || 3))

        let sent = 0
        for (const it of pick) {
          const chatId = `group:${it.groupId}`
          const who = it.name || it.userId
          const ago = it.ageMinutes >= 60 ? `${Math.round(it.ageMinutes / 60)} 小时前` : `${it.ageMinutes} 分钟前`
          const prefix = s.sayPrefix ? `（刚看到——${ago} @ 我了，之前电脑没开，补一句）\n` : ''
          const body = it.text ? `${who}：${it.text}` : `${who} 点了我的名字`
          try {
            await api.send(chatId, `${prefix}${body}\n这个我刚补上，还接着说吗`)
            sent++
            markHandled(it.messageId)
            await new Promise((r) => setTimeout(r, 2000))   // 群里慢慢来，别刷
          } catch (e) {
            warn(`补 ${chatId} 失败：` + String(e?.message || e))
          }
        }
        log(`补回错过的 @：找到 ${all.length} 处，补了 ${sent} 处（${reason}）`)
        return { ok: true, message: `找到 ${all.length} 处漏掉的 @，补了 ${sent} 处`, count: all.length, sent }
      } catch (e) {
        warn('补 @ 出错：' + String(e?.message || e))
        return { ok: false, message: String(e?.message || e) }
      } finally {
        busy = false
      }
    }

    // 网关重连 = 刚上线，补一次
    api.on('onebot/state', (st) => {
      if (st !== 'connected') return
      setTimeout(() => { runOnce({ reason: '网关重连' }).catch(() => {}) }, 8000)
    })

    // 模块刚加载时也补一次（插件重启 / DSH 重启）
    api.later(20_000, () => { runOnce({ reason: '启动后' }).catch(() => {}) })

    // 兜底：每 30 分钟看一眼（万一 state 事件没来）
    api.every(30 * 60_000, () => { runOnce({ reason: '定时' }).catch(() => {}) }, '补回错过的@')

    // 主人手动触发
    api.command({
      name: '补',
      aliases: ['补漏', 'catchup'],
      desc: '/补 —— 立刻检查有没有漏掉的 @ 并补上',
      run: (arg, msg) => {
        runOnce({ reason: '主人让补' }).then((r) => {
          if (msg?.chatId) api.sendText(msg.chatId, r.message || '看完了')
        }).catch(() => {})
        return '好，我去看看谁 @ 我了'
      },
    })

    api.route('/state', async () => {
      const s = S()
      return {
        ok: true,
        enabled: !!s.enabled,
        groups: targetGroups(),
        maxAgeMinutes: Number(s.maxAgeMinutes),
        minGapMinutes: Number(s.minGapMinutes),
        maxPerRun: Number(s.maxPerRun),
        busy,
        handled: handled.size,
        lastRunAt,
      }
    })

    api.route('/scan', async () => {
      const out = []
      for (const g of targetGroups()) {
        try { out.push(...(await scanGroup(g))) } catch (e) { warn(String(e?.message || e)) }
        await new Promise((r) => setTimeout(r, 300))
      }
      return { ok: true, count: out.length, items: out }
    })

    api.route('/now', async () => {
      const r = await runOnce({ reason: '面板点的' })
      return { ok: !!r.ok, message: r.message || '', count: r.count || 0, sent: r.sent || 0 }
    })

    log(`补回错过的@ 就位：${targetGroups().length} 个群，只补 ${S().maxAgeMinutes} 分钟以内的`)
    return { runOnce, scan: () => Promise.all(targetGroups().map((g) => scanGroup(g))) }
  },
}
