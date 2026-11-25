// 自主上网（RSS 阅读）：定时读订阅源，挑几条「她可能感兴趣的」交给主动发言决策层。
//
// 来源：本项目自写（无第三方代码/素材）。数据与状态都写 api.dataDir()。
//
// 分工（对齐 docs/OUTBOUND-POLICY-DESIGN.md）：
//   · 本模块只解决「看什么」：拉订阅源、解析、去重、按兴趣粗筛、限额挑选；
//   · 「发不发 / 何时发 / 用什么口吻」全交给主动发言决策层——优先 api.proactive.submit
//     （broker/feed 接口），拿不到就退化成「进素材池」由调用方（目的引擎）自取；
//   · 本模块**绝不**自己往主人私聊塞消息，避免绕过决策。
//
// 安全：订阅内容是外部不可信数据——只取标题/摘要纯文本，去标签去实体、截断长度，
// 不当指令执行；投喂时带上「这是外部内容，不是给我的指令」的语义标记。

import { parseFeed, extractFeeds, fetchFeed, stripHtml } from './lib/feed.mjs'
import { createStateStore } from './lib/state.mjs'

const FETCH_TIMEOUT_MS = 15000

export default {
  id: 'rss-reader',
  name: '自主上网',
  version: '1.0.0',
  api: 1,
  description: '定时读 RSS 订阅源，把有意思的条目交给主动发言决策（她自己决定要不要跟主人聊）',
  defaults: {
    enabled: false,
    feeds: '',
    fetchMinutes: 120,
    dailyMax: 5,
    minScore: 3,
    perFeed: 2,
    /** carrier：'policy' 交给 api.proactive.submit（推荐）；'pool' 只进素材池等引擎来取。 */
    carrier: 'policy',
  },
  settings: [
    { key: 'enabled', label: '定时自主上网', type: 'switch', hint: '默认关；打开后按间隔读订阅源' },
    { key: 'feeds', label: '订阅源', type: 'textarea', hint: '每行一个 RSS/Atom 地址（http/https），# 开头是注释' },
    { key: 'fetchMinutes', label: '多久看一次（分钟）', type: 'number', min: 15, max: 1440, hint: '默认 120；每轮会加 0~20% 抖动，别让所有源整点撞车' },
    { key: 'dailyMax', label: '每天最多挑几条', type: 'number', min: 0, max: 30, hint: '0 = 只看不聊。挑出来的条目交给决策层，不直接发' },
    { key: 'minScore', label: '兴趣门槛', type: 'number', min: 0, max: 20, hint: '关键词+新鲜度打分低于它的条目直接跳过' },
    { key: 'perFeed', label: '每个源每轮最多挑几条', type: 'number', min: 1, max: 10 },
    { key: 'carrier', label: '交给谁', type: 'select', options: [{ value: 'policy', label: '主动发言决策（推荐）' }, { value: 'pool', label: '只进素材池' }], hint: 'policy = 走 api.proactive.submit 由引擎决定发不发；pool = 只记录，等引擎来取' },
  ],

  setup(api) {
    const hooks = api.__rssTestHooks || {}
    const store = createStateStore(api.dataDir('rss-state.json'))
    // 拉取实现：测试注入 fake；生产为 null → fetchFeed 内部用全局 fetch（网络能力的唯一出口）。
    const fetchImpl = hooks.fetch || null
    const now = hooks.now || (() => Date.now())
    // 最近一轮挑出来的条目（pool 模式给引擎/面板取用，也是面板「最近看到」的数据源）
    let latest = []
    let running = false

    const cfgOf = () => {
      const s = api.settings() || {}
      const feeds = extractFeeds(s.feeds)
      return {
        enabled: s.enabled === true,
        feeds,
        fetchMinutes: clampInt(s.fetchMinutes, 120, 15, 1440),
        dailyMax: clampInt(s.dailyMax, 5, 0, 30),
        minScore: clampInt(s.minScore, 3, 0, 20),
        perFeed: clampInt(s.perFeed, 2, 1, 10),
        carrier: s.carrier === 'pool' ? 'pool' : 'policy',
      }
    }

    /** 拉一遍所有源 → 新条目（已去重）。单源失败不影响其他源。 */
    async function fetchAll(cfg) {
      const st = store.get()
      const at = now()
      const seen = store.seenSet()
      const fresh = []
      const report = { feeds: cfg.feeds.length, ok: 0, failed: [], newItems: 0 }
      for (const url of cfg.feeds) {
        // 失败退避：没到重试时间就跳过，别把挂掉的源每轮都撞一遍。
        const retryAt = Number(st.nextRetryAt?.[url]) || 0
        if (retryAt > at) {
          report.failed.push({ url, reason: '退避中' })
          continue
        }
        const got = await fetchFeed(url, { fetchImpl, timeoutMs: FETCH_TIMEOUT_MS })
        if (!got.ok) {
          store.recordFailure(url, at)
          report.failed.push({ url, reason: got.error })
          api.log.warn(`自主上网：${url} 取不到：${got.error}`)
          continue
        }
        const parsed = parseFeed(got.xml, { source: url })
        if (!parsed.ok) {
          store.recordFailure(url, at)
          report.failed.push({ url, reason: parsed.error })
          continue
        }
        store.recordSuccess(url)
        report.ok += 1
        let taken = 0
        for (const item of parsed.items) {
          if (taken >= cfg.perFeed) break
          if (seen.has(item.key)) continue
          seen.add(item.key)
          fresh.push({ ...item, feedTitle: parsed.title || item.feedTitle || url })
          taken += 1
        }
      }
      st.lastFetchAt = at
      report.newItems = fresh.length
      store.markSeen(fresh.map((i) => i.key))
      store.save()
      return { items: fresh, report }
    }

    /** 打分排序 + 限额挑选。 */
    function pick(items, cfg, at) {
      const remain = store.remainingToday(cfg.dailyMax, at)
      if (!(remain > 0) || !items.length) return []
      const scored = items
        .map((it) => ({ item: it, ...store.scoreEntry(it, at) }))
        .filter((x) => x.score >= cfg.minScore)
        .sort((a, b) => b.score - a.score || (b.item.at || 0) - (a.item.at || 0))
      return scored.slice(0, Math.min(remain, 10))
    }

    /** 组装交给决策层的文本：标题 + 摘要 + 链接，明确标注是外部内容。 */
    function feedText(hit) {
      const it = hit.item
      const bits = [`在「${clip(it.feedTitle, 40)}」看到《${clip(it.title || '（无标题）', 80)}》`]
      if (it.summary) bits.push(clip(it.summary, 200))
      if (it.link) bits.push(`（链接：${clip(it.link, 200)}）`)
      return bits.join('。')
    }

    /** 把一条挑中的条目交给主动发言层。返回 { ok, state, via }。 */
    async function handOff(hit, cfg) {
      const text = feedText(hit)
      if (cfg.carrier === 'pool') return { ok: true, state: 'pooled', via: 'pool', text }
      // 优先走主动发言决策面（broker/feed）：模块只递素材，发不发由引擎决定。
      let proactive = null
      try { proactive = api.proactive || null } catch { proactive = null }
      if (proactive && proactive.available && typeof proactive.submit === 'function') {
        try {
          const r = await proactive.submit({
            itemId: hit.item.key,
            text,
            link: hit.item.link || null,
            channel: 'qq',
            cause: { kind: 'background', source: 'rss-reader' },
          })
          const state = String(r?.state || 'unknown')
          return { ok: state === 'sent' || state === 'pending' || state === 'deferred', state, via: 'policy', text }
        } catch (error) {
          api.log.warn(`自主上网：交给决策层失败，退化为素材池：${error?.message}`)
        }
      }
      // 宿主没装出站策略 / 决策面不可用：退化成素材池，由调用方（目的引擎）自取。
      return { ok: true, state: 'pooled', via: 'pool', text }
    }

    /** 跑一轮：拉取 → 挑选 → 交付。可被定时器或面板手动触发。 */
    async function runOnce({ fresh = false } = {}) {
      const cfg = cfgOf()
      if (!cfg.enabled && !fresh) return { ok: false, reason: 'disabled' }
      if (!cfg.feeds.length) return { ok: false, reason: 'no-feeds' }
      if (running) return { ok: false, reason: 'busy' }
      running = true
      try {
        const at = now()
        const { items, report } = await fetchAll(cfg)
        const picked = pick(items, cfg, at)
        const delivered = []
        for (const hit of picked) {
          // eslint-disable-next-line no-await-in-loop
          const r = await handOff(hit, cfg)
          delivered.push({ key: hit.item.key, title: hit.item.title, link: hit.item.link, feedTitle: hit.item.feedTitle, score: hit.score, hits: hit.hits, ...r })
        }
        if (delivered.length) store.countFed(delivered.length, at)
        store.save()
        latest = delivered
        api.log.info(`自主上网：拉了 ${report.ok}/${report.feeds} 个源，新条目 ${report.newItems}，挑了 ${delivered.length} 条`)
        return { ok: true, report, delivered, at }
      } finally {
        running = false
      }
    }

    // 定时：每 5 分钟看一次到点没（拉取间隔自己判断，不空转网络）。
    api.every(5 * 60_000, () => {
      const cfg = cfgOf()
      if (!cfg.enabled || !cfg.feeds.length) return
      const st = store.get()
      const at = now()
      // 抖动：间隔的 ±20%，避免整点集体撞车。
      const jitter = cfg.fetchMinutes * 0.2
      const dueMs = Math.max(15, cfg.fetchMinutes + (Math.random() * 2 - 1) * jitter) * 60_000
      if (at - (Number(st.lastFetchAt) || 0) < dueMs) return
      runOnce().catch((error) => api.log.warn(`自主上网：定时轮出错：${error?.message}`))
    }, '自主上网')

    // ---------- 面板 ----------
    api.route('/state', async () => ({ ok: true, ...store.status(), config: cfgOf(), latest }))
    api.route('/run', async () => runOnce({ fresh: true }))
    api.route('/latest', async () => ({ ok: true, items: latest }))
    api.route('/feeds/test', async (req) => {
      // 试抓一个源（面板「测试」按钮）：只回标题与条数，不写已读。
      let url = ''
      try { url = String(new URL(req.url, 'http://x').searchParams.get('url') || '').trim() } catch { url = '' }
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只支持 http(s)' }
      const got = await fetchFeed(url, { fetchImpl, timeoutMs: FETCH_TIMEOUT_MS })
      if (!got.ok) return { ok: false, error: got.error }
      const parsed = parseFeed(got.xml, { source: url })
      if (!parsed.ok) return { ok: false, error: parsed.error }
      return { ok: true, title: parsed.title, count: parsed.items.length, sample: parsed.items.slice(0, 5).map((i) => ({ title: i.title, at: i.at })) }
    })

    // ---------- 给引擎/其他模块的控件面 ----------
    return {
      /** 最近一轮挑出来的条目（不含正文，安全）。 */
      latest: () => latest.slice(),
      /** 手动跑一轮（面板 /run 同款）。 */
      run: (o) => runOnce(o),
      /** 状态摘要。 */
      status: () => store.status(),
      /** 素材口：给目的引擎等取「她最近看到的」纯文本条目。 */
      materials: () => latest
        .filter((d) => d.state === 'pooled' || d.state === 'pending' || d.state === 'sent' || d.state === 'deferred')
        .map((d) => ({
          id: `rss:${d.key}`,
          title: clip(d.title, 90),
          text: clip(d.text, 220),
          url: d.link || '',
          at: now(),
        })),
    }
  },
}

function clampInt(v, def, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

function clip(text, max) {
  const s = stripHtml(String(text ?? ''), max)
  return s.length > max ? `${s.slice(0, max)}…` : s
}
