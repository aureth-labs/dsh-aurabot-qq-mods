// 表情进阶：按知识库检索表情。
//
// 表情的「知识」不是文件名，是每张图的内容：
//   画面描述 / 梗出处 / 使用场合 / 情绪 / 方向 / 图上文字
// 所以她说「找个委屈的」「找那个鲸鱼吃饭的梗」「有没有适合被夸了不好意思的」都能搜到。
//
// 表情库本身由 stickers（表情包）模块维护，本模块只读它、按语义检索。
// 检索算法在 lib/lib-search.mjs（从 dsh-nekowhale-stickers 移植，见 NOTICE）。

import { search, emotionCounts, line } from './lib/lib-search.mjs'

export default {
  id: 'sticker-kit',
  name: '表情进阶',
  version: '1.0.0',
  api: 1,
  description: '按画面/梗/场合/情绪检索表情（知识库来自 stickers 模块的表情库）',
  requires: ['stickers'],

  setup (api) {
    const log = api.log

    // ---------------------------------------------------------------- 表情库
    // 优先问 stickers 模块（它内存里有最新一份），拿不到就退回全量。
    let cache = { at: 0, items: [] }

    function loadItems () {
      const now = Date.now()
      if (now - cache.at < 3000 && cache.items.length) return cache.items
      let items = []
      try {
        const mod = api.use('stickers')
        const lib = mod?.library?.()
        if (lib && Array.isArray(lib.items) && lib.items.length) items = lib.items
      } catch (error) {
        log.debug('表情包模块没拿到：', error.message)
      }
      cache = { at: now, items }
      return items
    }

    /** 能用的那部分：stickers 模块有 usable() 就听它的（黑名单 / 停用都在里面）。 */
    function loadUsable () {
      try {
        const mod = api.use('stickers')
        const list = mod?.usable?.()
        if (Array.isArray(list)) return list
      } catch (error) {
        log.debug('取可用表情失败：', error.message)
      }
      return loadItems()
    }

    // ---------------------------------------------------------------- 工具
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'sticker_find',
          description: '按画面 / 梗 / 使用场合 / 情绪 / 图上文字检索表情库。她说「找个委屈的」「找那个鲸鱼吃饭的梗」「有没有适合被夸了不好意思的」时用。返回最匹配的几张，带名字和匹配理由。',
          properties: {
            query: { type: 'string', description: '想找什么样的表情：情绪（委屈/开心/无语）、画面（鲸鱼吃饭）、梗（那个说话的鱼）、场合（被夸了不好意思）' },
            limit: { type: 'integer', description: '最多返回几张，默认 8，最多 30' },
          },
          required: ['query'],
          async execute (args) {
            const q = String(args.query || '').trim()
            if (!q) return { ok: false, message: '要搜什么？比如「委屈」「鲸鱼吃饭」' }
            const items = loadUsable()
            if (!items.length) {
              return { ok: false, message: '表情库是空的。先装 stickers（表情包）模块，或者让她收几张表情' }
            }
            const limit = Math.max(1, Math.min(30, Number(args.limit) || 8))
            const hits = search(items, q, { limit })
            if (!hits.length) {
              return { ok: true, count: 0, message: `表情库里没找到跟「${q}」相关的。库里有 ${items.length} 张，换个说法试试。` }
            }
            const lines = hits.map((h) => {
              const name = h.item.name || h.item.file || '未命名'
              const why = h.why ? `（${h.why}）` : ''
              return `${name}${why}`
            })
            return {
              ok: true,
              count: hits.length,
              total: items.length,
              message: `找到 ${hits.length} 张：${lines.join('、')}`,
              items: hits.map((h) => ({
                name: h.item.name || '',
                file: h.item.file || '',
                emotion: h.item.emotion || '',
                use: h.item.use || '',
                why: h.why || '',
              })),
            }
          },
        }),

        api.defineTool({
          name: 'sticker_stats',
          description: '看表情库统计：一共几张、能用几张、各情绪各几张。她说「有多少表情」「都有什么情绪的」时用。',
          properties: {},
          async execute () {
            const all = loadItems()
            const usable = loadUsable()
            const emo = emotionCounts(usable)
            const top = Object.entries(emo).sort((a, b) => b[1] - a[1]).slice(0, 12)
            const parts = []
            parts.push(`一共 ${all.length} 张，能用 ${usable.length} 张`)
            if (top.length) parts.push(`情绪分布：${top.map(([k, v]) => `${k} ${v}`).join('、')}`)
            return {
              ok: true,
              total: all.length,
              usable: usable.length,
              emotions: emo,
              message: parts.join('；'),
            }
          },
        }),
      ]
    })

    log.info(`表情进阶已就绪：表情库 ${loadItems().length} 张`)
  },
}
