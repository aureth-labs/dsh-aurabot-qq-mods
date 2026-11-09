// 模块：token-budget（预算管家）
// 来源：本模块原创，代码移植自自家设计稿 docs/TOKEN-BUDGET-MODULE-DESIGN.md；许可 MIT。
// 作用：省 token 的四件事——注入内容预算封顶（默认 8.5k）、本地向量挑记忆只带 top-K（默认 16）、
//       估算记账、日花费熔断（默认 15 元：80% 软熔换便宜模型，100% 硬熔拦非必回轮次）。
// 契约：export default { id, name, version, api, defaults, settings, setup }；
//       数据只写 api.dataDir()；不打网络；记忆来源是内置 memory 模块（没在跑就跳过，不强依赖）。

import { estTokens, topK } from './lib/scorer.mjs'
import { createLedger } from './lib/ledger.mjs'

// 一张图按多少 token 记（视觉模型常见量级，只用于预算估算）
const IMAGE_TOKENS = 800
const fmt = (n) => (Math.round(n * 100) / 100).toString()

// 默认值提出来当模块级常量：setup 可能被解绑调用（const setup = def.setup），不能依赖 this
const DEFAULTS = {
  enabled: true,
  memoryTopK: 16,
  promptBudgetTokens: 8500,
  dailyBudgetYuan: 15,
  priceIn: 2, // 元 / 百万输入 token（DeepSeek 官方价档，可在面板改）
  priceOut: 8, // 元 / 百万输出 token
  softFusePct: 80,
  overheadFactor: 1.3, // 隐形消耗放大系数：system 轮 / 工具调用不经过记账，靠它补偿
  fallbackModel: '', // 软熔后非主人聊天换用的模型，写 provider/model，如 deepseek/deepseek-chat；留空不降级
  protectOwner: true,
}

export default {
  id: 'token-budget',
  name: '预算管家',
  version: '1.2.0',
  api: 1,
  description: '省 token：注入内容预算封顶、本地向量只带最相关的 16 条记忆、估算记账、日超预算自动熔断',
  category: 'manage',
  tags: ['省token', '预算', '熔断', '记忆'],
  panel: 'panel.js',

  defaults: DEFAULTS,

  settings: [
    { key: 'enabled', label: '启用预算管家', type: 'switch' },
    { key: 'memoryTopK', label: '每轮最多带几条记忆（0 = 不额外带）', type: 'number', min: 0, max: 64, step: 1 },
    { key: 'promptBudgetTokens', label: '单轮注入预算（token）', type: 'number', min: 1000, max: 60000, step: 100 },
    { key: 'dailyBudgetYuan', label: '日花费熔断线（元）', type: 'number', min: 0.5, max: 500, step: 0.5 },
    { key: 'priceIn', label: '输入单价（元/百万 token）', type: 'number', min: 0, max: 500, step: 0.5 },
    { key: 'priceOut', label: '输出单价（元/百万 token）', type: 'number', min: 0, max: 500, step: 0.5 },
    { key: 'softFusePct', label: '软熔百分比（降级模型）', type: 'number', min: 1, max: 99, step: 1 },
    { key: 'overheadFactor', label: '隐形消耗放大系数（仅估算记账与熔断线用，不影响真实口径）', type: 'number', min: 1, max: 5, step: 0.1 },
    { key: 'fallbackModel', label: '软熔后用的便宜模型（provider/model，留空不降级）', type: 'text' },
    { key: 'protectOwner', label: '主人私聊不受熔断影响', type: 'switch' },
  ],

  setup(api) {
    const s = () => ({ ...DEFAULTS, ...api.settings() })
    const ownerChatId = () => { const qq = String(api.config()?.ownerQQ || ''); return qq ? `private:${qq}` : '' }
    const isOwnerMsg = (msg) => Boolean(msg?.userId && api.isOwner?.(msg.userId))
    const ownerPrivate = (chat) => chat?.kind === 'private' && api.isOwner?.(chat.userId)

    const ledger = createLedger({
      dataDir: api.dataDir(),
      log: api.log,
      // 价格与熔断线每次现读设置，面板改完立刻生效
      get prices() { const c = s(); return { in: c.priceIn, out: c.priceOut, limit: c.dailyBudgetYuan } },
      get overheadFactor() { return s().overheadFactor },
      get softPct() { return s().softFusePct },
    })

    const memoryOf = () => { try { return api.use('memory') } catch { return null } }

    // 本地向量挑记忆：top-K 条相关旧事拼成一小段，交给她的内容末尾追加。
    // 记忆模块没在跑 / 没有话题 / 一条都不相关，都返回空串（不塞）。
    function memoryBlock(queryText, chatId) {
      const k = Number(s().memoryTopK) || 0
      if (!k || !String(queryText || '').trim()) return ''
      const mem = memoryOf()
      if (!mem?.list) return ''
      let items = []
      try { items = mem.list('') || [] } catch { return '' }
      const picked = topK(items, queryText, k, { chatId })
      if (!picked.length) return ''
      const lines = picked.map((it) => '• ' + String(it.text || '').slice(0, 120).replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2)
      return lines.length ? `（想起的相关旧事，只挑了最相关的 ${lines.length} 条）\n${lines.join('\n')}` : ''
    }

    // 预算封顶：从最后一块（最新、最像本轮用户消息）往前保，装不下就从前面整块丢；
    // 边界块按剩余预算截头留尾。人格、规则、会话历史不经过这条链，所以这里只管「交给她的内容」。
    function trimToBudget(content, budget) {
      const cost = (b) => (b?.type === 'image' ? IMAGE_TOKENS : estTokens(b?.text))
      const kept = []
      let used = 0
      for (let i = content.length - 1; i >= 0; i--) {
        const c = cost(content[i])
        if (used + c <= budget) { kept.unshift(content[i]); used += c; continue }
        if (content[i]?.type === 'text' && budget - used > 200) {
          const text = String(content[i].text || '')
          const ratio = (budget - used) / Math.max(1, c)
          kept.unshift({ type: 'text', text: text.slice(Math.floor(text.length * (1 - ratio))) })
        }
        break
      }
      return kept
    }

    // 改写「交给她的内容」：预算封顶 + 自己的 top-K 记忆块。熔断拦人交给 group/decide（那里分得出必回）。
    // 顺手记一笔「省了多少」：不挑记忆全量带的假设开销 + 原始内容的开销，减去实际送出去的开销。
    api.on('prompt', async (content, info) => {
      if (!s().enabled) return content
      if (!Array.isArray(content) || !content.length) return content
      const chat = info?.chat
      if (!chat || chat.kind === 'system') return content
      // 硬熔：主人私聊（可设置豁免）以外的轮次不交给她
      if (ledger.state() === 'hard' && !(s().protectOwner && ownerPrivate(chat))) return null
      const costOf = (blocks) => blocks.reduce((n, b) => n + (b?.type === 'image' ? IMAGE_TOKENS : estTokens(b?.text)), 0)
      const base = costOf(content)
      const queryText = info?.queryText || ''
      const block = memoryBlock(queryText, chat.chatId || '')
      // 假设不挑记忆、全量都带的成本（封顶 400 条，防超大记忆库把估算本身变成负担）
      let fullMemCost = 0
      const mem = memoryOf()
      if (block && mem?.list) {
        try { fullMemCost = estTokens((mem.list('') || []).slice(0, 400).map((it) => String(it.text || '')).join('\n')) } catch {}
      }
      const withMemory = block ? [...content, { type: 'text', text: block }] : content
      const budget = Number(s().promptBudgetTokens) || DEFAULTS.promptBudgetTokens
      const result = trimToBudget(withMemory, budget)
      const saved = Math.max(0, base + fullMemCost - costOf(result))
      if (saved > 0) ledger.addChat(chat.chatId, 'saved', 0, saved)
      return result
    })

    // 硬熔拦「回不回」：必回（mode must / 被 @）和主人永远放行——省钱不能变成装死。
    api.on('group/decide', (decision, { msg } = {}) => {
      if (!s().enabled || ledger.state() !== 'hard') return
      if (decision?.mode === 'must' || msg?.mentioned || isOwnerMsg(msg)) return
      if (s().protectOwner && ownerPrivate(msg)) return
      return { reply: false, reason: '日预算熔断' }
    })

    // 软熔降级：非主人聊天换便宜模型（同步钩子，不能 async）。
    api.on('model', (sel, chat) => {
      if (!s().enabled || ledger.state() === 'ok') return
      if (s().protectOwner && ownerPrivate(chat)) return
      const fb = String(s().fallbackModel || '').trim()
      if (!fb || !fb.includes('/')) return
      const [provider, ...rest] = fb.split('/')
      return { ...(sel || {}), provider: provider.trim(), model: rest.join('/').trim() }
    })

    // 记账：收到 / 发出的文字都估算 token 进账（system 会话是她自己想事情，不算 QQ 消息，跳过）。
    // 全局账 + 按会话的桶各记一份，面板卡片读的就是桶。
    api.on('activity', ({ kind, chatId, text } = {}) => {
      if (!s().enabled) return
      if (!chatId || String(chatId).startsWith('system:')) return
      const t = estTokens(text)
      const k = kind === 'out' ? 'out' : 'in'
      ledger.add(k, t)
      ledger.addChat(chatId, k, t)
      // 刚跨过熔断线：提醒主人（每日至多 2 条，记在账本里防重启刷屏）
      if (ledger.state() === 'hard' && ledger.takeNotifySlot() > 0) {
        const to = ownerChatId()
        const yuan = fmt(ledger.spentYuan())
        const limit = fmt(Number(s().dailyBudgetYuan))
        if (to) Promise.resolve(api.sendText(to, `（预算管家）今天已花约 ${yuan} 元，超过熔断线 ${limit} 元，非必回的消息我先不接了，明天自动恢复。发 /预算 解除 可当日豁免。`)).catch(() => {})
      }
    })

    // 跨日滚动：定时把「今天」实例化，顺带清旧账（账本自己管 30 天保留）。
    api.every(60_000, () => { try { ledger.today() } catch {} }, '预算管家跨日滚动')

    // 主人命令：/预算 查账；/预算 20 改当日上限；/预算 解除 当日豁免。
    api.command({
      name: '预算',
      desc: '查今天花了多少；带数字改熔断线；「解除」当日豁免',
      run(arg) {
        const a = String(arg || '').trim()
        if (a === '解除') {
          const key = ledger.setExempt(Date.now(), true)
          return `今天（${key}）豁免熔断，随便聊。明天恢复。`
        }
        const n = Number(a.replace(/[元块。.]/g, ''))
        if (Number.isFinite(n) && n > 0) {
          api.saveSettings({ dailyBudgetYuan: n })
          return `熔断线改成 ${n} 元了。`
        }
        const st = ledger.state()
        const yuan = fmt(ledger.spentYuan())
        const limit = fmt(Number(s().dailyBudgetYuan))
        const today = ledger.today()
        const stateText = { ok: '正常', soft: '软熔（可用便宜模型了）', hard: '硬熔（非必回不接）' }[st]
        return `今日约 ${fmt((today.day.inTok + today.day.outTok) / 1000)}k token，约 ${yuan} 元 / 熔断线 ${limit} 元（${stateText}）。\n近 7 天：${ledger.recent(7).map((d) => `${d.day.slice(5)} ${fmt(d.yuan)}元`).join('，')}`
      },
    })

    // 单价（元/百万 token）：每次现读设置，面板改完立刻生效
    const pin = () => Math.max(0, Number(s().priceIn) || 0)
    const pout = () => Math.max(0, Number(s().priceOut) || 0)

    function realUsageByChat(rep) {
      const out = {}
      for (const e of rep?.current?.byChat || []) if (e?.key) out[e.key] = e
      return out
    }

    // 面板接口：今日用量 + 熔断状态 + 近 7 天曲线 + 按会话聚合（卡片数据，近 7 天 top 12）。
    // 卡片的「消耗」优先用宿主 /usage 的真实用量（人格/历史/缓存全算在内，和宿主「本轮用量」一个口径）；
    // 宿主没记到（老版本 / 记不上 chat 的调用）才退回我们按消息文字的估算，并打上 estimate 标记。
    api.route('/status', async (req) => {
      const day = ledger.today()
      const yuan = ledger.spentYuan()
      const limit = Math.max(0.01, Number(s().dailyBudgetYuan) || 15)
      const ours = new Map(ledger.chatsByDay(7).map((c) => [c.chatId, c]))
      // 回环调宿主自己的 /usage（同进程同端口，req 头里带真实的 host:port）；2.5 秒超时，拿不到就算了
      let rep = null
      let loopErr = ''
      try {
        const host = req?.headers?.host || ''
        if (host) rep = await (await fetch(`http://${host}/aurabot/api/usage?range=7`, { signal: AbortSignal.timeout(2500) })).json()
      } catch (e) { loopErr = String(e?.message || e).slice(0, 120) }
      const real = realUsageByChat(rep)
      const ids = new Set([...Object.keys(real), ...ours.keys()])
      const chats = [...ids].map((id) => {
        const r = real[id]
        const o = ours.get(id) || { inTok: 0, outTok: 0, saved: 0, turns: 0 }
        const tokens = r ? r.totalTokens : o.inTok + o.outTok
        const cost = r ? (Number(r.cost) || 0) : +(((o.inTok * pin() + o.outTok * pout()) / 1_000_000)).toFixed(3)
        return {
          chatId: id,
          runs: r?.runs ?? o.turns,
          tokens,
          cost: +Number(cost).toFixed(3),
          cached: Math.round(r?.cachedTokens ?? 0),
          cacheHitRate: r ? Math.round((Number(r.cacheHitRate) || 0) * 100) : null,
          estimate: !r,
          saved: o.saved,
          savedYuan: +((o.saved * pin()) / 1_000_000).toFixed(3), // 省下的都是注入的输入 token
        }
      }).sort((a, b) => b.tokens - a.tokens).slice(0, 12)
      // 顶部「今日消耗」同样优先真实口径（宿主 ranges.today = 全部调用的真实总量，含人格/历史/后台会话）
      const rt = rep?.ranges?.today
      const todayReal = rt ? { tokens: Number(rt.totalTokens) || 0, cost: +(Number(rt.cost) || 0).toFixed(3), runs: Number(rt.runs) || 0 } : null
      return {
        ok: true,
        enabled: Boolean(s().enabled),
        state: ledger.state(),
        today: { inTok: Math.round(day.day.inTok), outTok: Math.round(day.day.outTok), yuan: +yuan.toFixed(3), limit, pct: Math.round((yuan / limit) * 100) },
        todayReal,
        recent: ledger.recent(7),
        chats,
        debug: { realChats: Object.keys(real).length, loopErr },
      }
    })

    // 测试钩子：对齐 pet 模块的模式，测试可注入，不打真网络
    api.__tbTestHooks = { ledger, memoryBlock, trimToBudget, estTokens }
    return { ledger, memoryBlock, trimToBudget }
  },
}
