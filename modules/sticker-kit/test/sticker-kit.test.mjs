// 表情进阶（sticker-kit）测试：检索打分、两个工具的行为、依赖 stickers 缺失时的降级。
//
// 全程 fake api：不打网络、不读写磁盘、不碰真表情库。
// 跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/sticker-kit/test/*.test.mjs"

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mod from '../index.mjs'
import { terms, fields, scoreFields, search, emotionCounts, line } from '../lib/lib-search.mjs'

const MOD_DIR = fileURLToPath(new URL('../', import.meta.url))
const meta = JSON.parse(readFileSync(join(MOD_DIR, 'module.json'), 'utf8'))

// ── 假表情库：字段跟 stickers 模块的 index.json 条目对齐 ───────────────────

const LIB = [
  { name: '委屈巴巴的小猫', file: 'a.gif', emotion: '委屈', tags: ['卖萌'], use: '被说了有点难过', desc: '一只小猫垂着耳朵', text: '' },
  { name: '鲸鱼吃饭', file: 'b.gif', emotion: '开心', tags: ['干饭'], use: '喊人去吃饭', desc: '蓝鲸张着大嘴吃小鱼', text: '' },
  { name: '无语的鱼', file: 'c.gif', emotion: '无语', tags: [], use: '', desc: '一条翻白眼的鱼', text: '……' },
  { name: '叉腰得意', file: 'd.gif', emotion: '开心', tags: ['嘲讽'], use: '被夸了不好意思但又想得意', desc: '', text: 'V我50' },
  { name: '偷偷看你', file: 'e.gif', emotion: '卖萌', tags: [], use: '', desc: '眼睛从角落露出来', text: '' },
]

// ── 假 api：对齐 src/core/modules.js 暴露给模块的那一小面 ──────────────────

function fakeApi({ stickers = null, kind = 'private' } = {}) {
  const tools = []
  const calls = { use: [] }
  const api = {
    id: 'sticker-kit',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    use: (id) => {
      calls.use.push(id)
      return id === 'stickers' ? stickers : null
    },
    defineTool: (def) => def,
    tool: (factory) => {
      const list = factory({ chat: { kind, chatId: 'private:1' } })
      if (Array.isArray(list)) tools.push(...list)
      else tools.push(list)
    },
  }
  mod.setup(api)
  const byName = new Map(tools.map((t) => [t.name, t]))
  return { api, tools, byName, calls }
}

/** stickers 模块的导出面：library() 给全量，usable() 给过滤后的。 */
const stickersMod = (items = LIB, usable = items) => ({
  library: () => ({ items }),
  usable: () => usable,
})

const run = (tool, args) => tool.execute(args || {}, {})

// ── module.json / 元信息 ─────────────────────────────────────────────────

test('module.json 与入口的 id/version/api 一致', () => {
  assert.equal(meta.id, mod.id)
  assert.equal(meta.id, 'sticker-kit')
  assert.equal(meta.version, mod.version)
  assert.equal(meta.api, mod.api)
  assert.equal(typeof mod.setup, 'function')
})

test('依赖声明 stickers（表情库由它维护），能力只声明 plugin-internals', () => {
  assert.deepEqual(meta.requires, ['stickers'])
  assert.deepEqual(mod.requires, ['stickers'])
  assert.deepEqual(meta.capabilities, ['plugin-internals'])
})

// ── 检索纯函数 ───────────────────────────────────────────────────────────

test('terms：按空白和中英标点切词，全小写', () => {
  assert.deepEqual(terms('委屈 开心'), ['委屈', '开心'])
  assert.deepEqual(terms('鲸鱼，吃饭。'), ['鲸鱼', '吃饭'])
  assert.deepEqual(terms('  '), [])
  assert.deepEqual(terms(null), [])
  assert.deepEqual(terms('Hello WORLD'), ['hello', 'world'])
})

test('fields：把一条记录摊平，缺字段不炸', () => {
  const f = fields(LIB[0])
  assert.equal(f.name, '委屈巴巴的小猫')
  assert.equal(f.emotion, '委屈')
  assert.equal(f.tagsJoined, '卖萌')
  assert.equal(f.use, '被说了有点难过')
  assert.deepEqual(fields({}), { name: '', tagsJoined: '', emotion: '', meme: '', use: '', text: '', dir: '', desc: '', en: '' })
  // 「用途」两种写法都认
  assert.equal(fields({ summary: '被夸了' }).use, '被夸了')
})

test('scoreFields：名字 / 标签比画面描述权重高', () => {
  const qs = terms('委屈')
  const byName = scoreFields(fields({ name: '委屈' }), qs)
  const byDesc = scoreFields(fields({ desc: '委屈的小鱼' }), qs)
  assert.ok(byName > byDesc, `${byName} 应该大于 ${byDesc}`)
  // 完全等于某个字段时给 1.5 倍
  assert.ok(scoreFields(fields({ name: '委屈' }), qs) > scoreFields(fields({ name: '很委屈啊' }), qs))
  // 一个词都没命中就是 0
  assert.equal(scoreFields(fields({ name: '开心' }), qs), 0)
})

test('scoreFields：多个词命中越多分越高（单条高分压不过两词命中）', () => {
  const qs = terms('鲸鱼 吃饭')
  const both = scoreFields(fields({ name: '鲸鱼', tags: ['吃饭'] }), qs)
  const one = scoreFields(fields({ name: '鲸鱼' }), qs)
  assert.ok(both > one)
})

test('scoreFields：长查询按二元组兜底（只对上半个词也给分）；两字词只做整串匹配', () => {
  const f = fields({ desc: '躺在沙发上不想动' })
  // 「躺在沙发」≥3 字才会切二元组：整串没对上，但「躺在」「沙发」都命中 → 有分
  assert.ok(scoreFields(f, terms('躺在沙发')) > 0, '长词应该走二元组兜底')
  // 两字词只做整串包含：找不到就是 0，不会靠二元组硬蹭
  assert.equal(scoreFields(f, terms('躺平')), 0)
})

test('search：按情绪词找到对应的那张，并带上分数', () => {
  const hits = search(LIB, '委屈')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].item.name, '委屈巴巴的小猫')
  assert.ok(hits[0].score > 0)
})

test('search：场景描述能搜到（「被夸了不好意思」）', () => {
  const hits = search(LIB, '被夸了不好意思')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].item.name, '叉腰得意')
})

test('search：limit 生效并夹在 1~20', () => {
  assert.equal(search(LIB, '开心', { limit: 1 }).length, 1)
  // 0 / 负数都是假值或越界：退回默认 5，不会返回空、也不会把整库倒出来
  assert.ok(search(LIB, '开心', { limit: 0 }).length >= 1)
  assert.ok(search(LIB, '开心', { limit: -3 }).length >= 1)
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `开心${i}` }))
  assert.equal(search(many, '开心').length, 5, '默认 5 张')
  assert.equal(search(many, '开心', { limit: 999 }).length, 20, '最多 20 张')
})

test('search：空查询返回随机几张（不报错）', () => {
  const hits = search(LIB, '   ', { limit: 3 })
  assert.equal(hits.length, 3)
  assert.ok(hits.every((h) => h.score === 0))
  assert.equal(search([], '', { limit: 3 }).length, 0)
})

test('search：emotion 过滤只在该情绪里挑', () => {
  const hits = search(LIB, '鱼', { emotion: '无语' })
  assert.ok(hits.every((h) => h.item.emotion === '无语'))
})

test('search：全都不命中时给空数组（宁缺毋滥），loose=false 时不走兜底', () => {
  assert.deepEqual(search(LIB, '量子力学', { loose: false }), [])
  assert.deepEqual(search([], '委屈'), [])
})

test('emotionCounts：按情绪计数、多的在前、空的丢掉', () => {
  const counts = emotionCounts(LIB)
  assert.deepEqual(counts[0], ['开心', 2])
  assert.ok(counts.every(([, n]) => n > 0))
  assert.deepEqual(emotionCounts([{ emotion: '' }, {}]), [])
})

test('line：默认一行带标签，detail=full 带用途 / 方向 / 梗', () => {
  assert.equal(line({ name: '小鱼', emotion: '开心', tags: ['a', 'b'] }), '小鱼｜开心｜a/b')
  assert.equal(line({}), '未命名')
  const full = line({ name: '小鱼', emotion: '开心', use: '打招呼', dir: '左', meme: '那个说话的鱼' }, 'full')
  assert.match(full, /打招呼/)
  assert.match(full, /左/)
  assert.match(full, /梗：那个说话的鱼/)
})

// ── 工具 ─────────────────────────────────────────────────────────────────

test('setup 注册了两个工具：sticker_find / sticker_stats', () => {
  const { byName } = fakeApi({ stickers: stickersMod() })
  assert.deepEqual([...byName.keys()].sort(), ['sticker_find', 'sticker_stats'])
})

test('系统会话里不挂工具', () => {
  const { tools } = fakeApi({ stickers: stickersMod(), kind: 'system' })
  assert.equal(tools.length, 0)
})

test('sticker_find：搜到就把名字和匹配理由一起返回', async () => {
  const { byName } = fakeApi({ stickers: stickersMod() })
  const r = await run(byName.get('sticker_find'), { query: '委屈' })
  assert.equal(r.ok, true)
  assert.ok(r.count >= 1)
  assert.match(r.message, /委屈巴巴的小猫/)
  assert.equal(r.items[0].name, '委屈巴巴的小猫')
  assert.equal(r.items[0].file, 'a.gif')
  assert.equal(typeof r.total, 'number')
})

test('sticker_find：空查询给出可读提示，不是抛错', async () => {
  const { byName } = fakeApi({ stickers: stickersMod() })
  const r = await run(byName.get('sticker_find'), { query: '   ' })
  assert.equal(r.ok, false)
  assert.match(r.message, /要搜什么/)
})

test('sticker_find：找不到时说清楚库里有多少张', async () => {
  const { byName } = fakeApi({ stickers: stickersMod() })
  // 用一串库里不可能出现的英文：绕开中文二元组兜底
  const r = await run(byName.get('sticker_find'), { query: 'zzzzzz' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 0)
  assert.match(r.message, /没找到/)
  assert.match(r.message, new RegExp(`${LIB.length} 张`))
})

test('sticker_find：limit 默认 8，最多 30（不是把整库倒出来）', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `开心${i}`, file: `${i}.gif`, emotion: '开心' }))
  const { byName } = fakeApi({ stickers: stickersMod(many) })
  const r = await run(byName.get('sticker_find'), { query: '开心' })
  assert.ok(r.count <= 8)
  const big = await run(byName.get('sticker_find'), { query: '开心', limit: 999 })
  assert.ok(big.count <= 30)
})

test('sticker_find：只用 usable()（黑名单 / 停用的不会被搜出来）', async () => {
  const allowed = [LIB[0]]
  const { byName } = fakeApi({ stickers: stickersMod(LIB, allowed) })
  // 「鲸鱼吃饭」那张被过滤掉了：不管走不走兜底，结果里都不能出现它
  const loose = await run(byName.get('sticker_find'), { query: '鲸鱼 吃饭' })
  assert.ok((loose.items || []).every((i) => i.name !== '鲸鱼吃饭'), '被过滤掉的那张不该被搜到')
  const ok = await run(byName.get('sticker_find'), { query: '委屈' })
  assert.equal(ok.ok, true)
  assert.equal(ok.total, 1, 'total 报的是能用的张数')
  assert.equal(ok.items[0].name, '委屈巴巴的小猫')
})

test('stickers 模块没装 / 拿不到：两个工具都给可读提示，不抛错', async () => {
  const { byName } = fakeApi({ stickers: null })
  const find = await run(byName.get('sticker_find'), { query: '委屈' })
  assert.equal(find.ok, false)
  assert.match(find.message, /表情库是空的/)
  assert.match(find.message, /stickers/)
  const stats = await run(byName.get('sticker_stats'))
  assert.equal(stats.ok, true)
  assert.equal(stats.total, 0)
  assert.equal(stats.usable, 0)
})

test('stickers 模块抛错（在跑但坏了）时也降级，不把异常抛给模型', async () => {
  const broken = {
    library: () => { throw new Error('boom') },
    usable: () => { throw new Error('boom') },
  }
  const { byName } = fakeApi({ stickers: broken })
  const r = await run(byName.get('sticker_find'), { query: '委屈' })
  assert.equal(r.ok, false)
  assert.match(r.message, /表情库是空的/)
})

test('stickers 只实现 usable()（没有 library()）时照样能搜', async () => {
  const { byName } = fakeApi({ stickers: { usable: () => LIB } })
  const r = await run(byName.get('sticker_find'), { query: '委屈' })
  assert.equal(r.ok, true)
  assert.equal(r.items[0].name, '委屈巴巴的小猫')
})

test('sticker_stats：报总数 / 可用数 / 情绪分布', async () => {
  // 5 张里只有 3 张能用；能用的那 3 张里「开心」占 2 张，排第一
  const allowed = [LIB[0], LIB[1], LIB[3]]
  const { byName } = fakeApi({ stickers: stickersMod(LIB, allowed) })
  const r = await run(byName.get('sticker_stats'), {})
  assert.equal(r.ok, true)
  assert.equal(r.total, LIB.length)
  assert.equal(r.usable, allowed.length)
  assert.match(r.message, new RegExp(`一共 ${LIB.length} 张`))
  assert.match(r.message, /能用 3 张/)
  assert.match(r.message, /情绪分布/)
  assert.equal(r.emotions[0][0], '开心')
  assert.equal(r.emotions[0][1], 2)
})

test('结果里不含图片字节：只给名字 / 文件 / 情绪 / 用途', async () => {
  const { byName } = fakeApi({ stickers: stickersMod() })
  const r = await run(byName.get('sticker_find'), { query: '委屈', limit: 1 })
  const keys = Object.keys(r.items[0]).sort()
  assert.deepEqual(keys, ['emotion', 'file', 'name', 'use', 'why'])
})
