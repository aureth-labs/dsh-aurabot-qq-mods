// 热榜巡游（tophub）：每天定时带鱼逛全网热榜，看完私聊分享给主人；同时是基础控件——
// 其他模块可 api.use('tophub') 拿 { hot, search, nodes }，直接取今日热点数据。
// 数据链路见 lib/fetch.mjs（tophub 直连 → 60s 接口兜底 → 缓存限速）；逛循环见 lib/browse.mjs。

import { createFetcher } from './lib/fetch.mjs'
import { createBrowse } from './lib/browse.mjs'

export default {
  id: 'tophub',
  name: '刷热榜',
  version: '0.3.1',
  api: 1,
  description: '热榜巡游：每天定时逛全网热榜，看完写记忆、挑有意思的私聊分享给主人；对外提供 hot()/search() 热点控件',
  panel: 'panel.js',
  defaults: {
    enabled: true,
    tourTimes: '09:30,21:00',        // 每天这些时刻各逛一场（到点后的下一个 tick 触发）
    nodes: ['微博热搜', '抖音热点', '60秒读懂世界', '知乎热榜', 'B站热门', '今日头条'],
    nodesPerTour: 2,                 // 每场逛几个榜（60s 接口怕高频，别贪多）
    itemsPerNode: 15,                // 每个榜喂给她前几条
    shareLimit: 2,                   // 每场最多私聊分享几条，0 = 不分享只逛
  },
  settings: [
    { key: 'enabled', label: '定时逛热榜', type: 'switch' },
    { key: 'tourTimes', label: '每天巡游时刻', type: 'text', hint: '逗号分隔，如 09:30,21:00；到点后的 1 分钟内开逛' },
    { key: 'nodes', label: '要逛的榜', type: 'textarea', hint: '每行一个。内置：微博热搜 / 知乎热榜 / 抖音热点 / 今日头条 / B站热门 / 60秒读懂世界；也可以填 tophub.today 节点 id（如 K7GdaMgdQy）' },
    { key: 'nodesPerTour', label: '每场逛几个榜', type: 'number', min: 1, max: 6, hint: '接口有频率限制，建议 2~3 个' },
    { key: 'itemsPerNode', label: '每个榜看几条', type: 'number', min: 5, max: 30 },
    { key: 'shareLimit', label: '每场最多分享几条', type: 'number', min: 0, max: 10, hint: '0 = 只看不分享。分享只会发给主人私聊' },
  ],

  setup(api) {
    const hooks = api.__tophubTestHooks || {}
    const fetcher = createFetcher({
      cacheDir: api.dataDir('cache'),
      log: api.log,
      fetchImpl: hooks.fetch,
      fs: hooks.fs,
    })

    const browse = createBrowse({
      api,
      fetcher,
      memory: api.lazy('memory'),
      ownerQQ: api.config().ownerQQ,
      think: (prompt, opts) => api.think(prompt, opts),
      sendText: (chatId, text) => api.sendText(chatId, text),
      now: hooks.now,
    })

    // 每分钟看一眼到点没（browse.tick 里自己判断场次，没到点直接返回，不空转）
    api.every(60_000, () => browse.tick(), '逛热榜')

    // ---- 给鱼的工具（纯读，看榜/搜热点不需要门禁）----
    api.tool(({ chat }) => {
      const cfg = api.settings()
      if (!cfg.enabled || chat?.kind === 'system') return []
      return [
        api.defineTool({
          name: 'tophub_hot',
          description: '看看现在全网热榜上有什么（微博热搜、抖音热点等）。node 填榜名（如「微博热搜」），不填就自动挑一个。看完可以和大家聊。',
          properties: { node: { type: 'string', description: '榜名或 tophub 节点 id，可选' } },
          required: [],
          execute: async ({ node }) => {
            const name = String(node || '').trim() || pickDefault(cfg)
            const r = await fetcher.hot(name)
            if (!r.ok) return { ok: false, message: `「${name}」取不到：${r.error}` }
            return { ok: true, node: name, source: r.source, top: r.items.slice(0, 20).map((it, i) => ({ i: i + 1, title: it.title, hot: it.hot || '' })) }
          },
        }),
        api.defineTool({
          name: 'tophub_search',
          description: '在全网热榜里搜某个话题今天热不热、上了哪些榜。keyword 填关键词。',
          properties: { keyword: { type: 'string', description: '关键词' } },
          required: ['keyword'],
          execute: async ({ keyword }) => {
            const r = await fetcher.search(String(keyword || ''), { names: cfg.nodes, liveNodes: 2 })
            if (!r.ok) return r
            if (!r.hits.length) return { ok: true, hits: [], message: '今天的热榜上没搜到相关条目' }
            return r
          },
        }),
      ]
    })

    const pickDefault = (cfg) => (Array.isArray(cfg.nodes) && cfg.nodes[0]) || '微博热搜'

    // ---- 面板路由（模块相对路径，最终挂在 /aurabot/api/ext/tophub/ 下）----
    api.route('/state', async () => ({ ok: true, ...browse.status() }))
    api.route('/run', async () => browse.tour({ fresh: true }))
    api.route('/history', async () => ({ ok: true, items: browse.history() }))
    api.route('/hot', async (req) => {
      let node = ''
      try { node = String(new URL(req.url, 'http://x').searchParams.get('node') || '').trim() } catch { node = '' }
      return fetcher.hot(node || pickDefault(api.settings()))
    })

    // ---- 基础控件面：其他模块 api.use('tophub') 拿这些（只暴露这层，别碰爬取细节）----
    return {
      /** 拉一个榜：hot('微博热搜') → { ok, source, items:[{title,url,hot}] } */
      hot: (name, o) => fetcher.hot(name, o),
      /** 全榜搜关键词：search('xxx') → { ok, hits:[{node,title,url}] } */
      search: (kw, o) => fetcher.search(kw, o),
      /** 内置榜单目录 */
      nodes: () => fetcher.nodes(),
      /** 手动逛一轮（面板 /run 同款） */
      tour: (o) => browse.tour(o),
      /** 巡游历史（面板「记录」区） */
      history: () => browse.history(),
      /** 巡游状态 */
      status: () => browse.status(),
    }
  },
}
