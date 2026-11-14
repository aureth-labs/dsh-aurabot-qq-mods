// 星露谷模块的纯逻辑测试：不连游戏、不起进程、不写盘。
// 覆盖：SSE 解析、在不在存档里的判断（那个少写一个「有」字的坑）、模型瞎报的过滤、
// 超长文本截断、分钟数解析、路径越界防护、存档 mtime 取最新。
//
// 跑法（只需要 node，不依赖插件源码）：
//   node --test "modules/stardew/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSse,
  inSaveGame,
  looksLikeBadSelfReport,
  trim,
  parseMinutes,
  isInside,
  newestSaveMtime,
} from '../lib/logic.mjs'

// ── SSE 解析 ────────────────────────────────────────────────

test('parseSse 取出 data 行里的 JSON-RPC 回复', () => {
  const sse = [
    ': start',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}',
    '',
  ].join('\n')
  const msg = parseSse(sse)
  assert.equal(msg.result.content[0].text, 'hi')
})

test('parseSse 忽略 keep-alive 注释行，多块时取带 result 的那块', () => {
  const sse = [': keep-alive', '', ': keep-alive', '', 'data: {"jsonrpc":"2.0","id":2,"error":{"code":-1}}', ''].join('\n')
  const msg = parseSse(sse)
  assert.equal(msg.error.code, -1)
})

test('parseSse 没有结果就抛错（别把半边回复当成功）', () => {
  assert.throws(() => parseSse(': keep-alive\n'), /没有结果/)
  assert.throws(() => parseSse('data: {坏 JSON}\n'), /没有结果/)
  assert.throws(() => parseSse(''), /没有结果/)
})

test('parseSse 支持 data: 后没有空格，也支持多行 data 拼起来', () => {
  assert.equal(parseSse('data:{"jsonrpc":"2.0","result":{"a":1}}\n').result.a, 1)
  const multi = 'data: {"jsonrpc":"2.0",\ndata: "result":{"a":2}}\n'
  assert.equal(parseSse(multi).result.a, 2)
})

// ── 在不在存档里（关键回归） ─────────────────────────────────

test('inSaveGame：标题画面/加载中都算没进去（含曾经少写一个「有」字的原文）', () => {
  // 游戏实际返回的原话——历史上正则少一个「有」字，导致这里永远判成功
  assert.equal(inSaveGame('游戏还没有进入存档（在标题画面或正在加载）。请玩家先读取存档。'), false)
  assert.equal(inSaveGame('在标题画面'), false)
  assert.equal(inSaveGame('正在加载，还没进入存档'), false)
})

test('inSaveGame：真的在存档里就返回 true', () => {
  const real = '## 基本状态\n时间：第1年春5日 06:00（Fri），天气：晴\n金钱：260g 体力：270/270\n## 位置\n地点：Farm'
  assert.equal(inSaveGame(real), true)
})

test('inSaveGame：空文本不算进存档（连不上时不要误判成玩上了）', () => {
  assert.equal(inSaveGame(''), false)
  assert.equal(inSaveGame('   '), false)
  assert.equal(inSaveGame(null), false)
  assert.equal(inSaveGame(undefined), false)
})

// ── 模型自述过滤 ────────────────────────────────────────────

test('looksLikeBadSelfReport：提到没进去/连不上就判为瞎报', () => {
  assert.equal(looksLikeBadSelfReport('游戏还在标题画面，没进去'), true)
  assert.equal(looksLikeBadSelfReport('连不上游戏'), true)
  assert.equal(looksLikeBadSelfReport('开局失败'), true)
  assert.equal(looksLikeBadSelfReport('收了一批防风草，赚了 953g'), false)
  assert.equal(looksLikeBadSelfReport(''), false)
})

// ── 截断 ────────────────────────────────────────────────────

test('trim 短文本原样返回，长文本保头保尾', () => {
  assert.equal(trim('abc', 100), 'abc')
  const long = 'A'.repeat(20000) + 'TAIL'
  const out = trim(long, 12000)
  assert.ok(out.length < 13000)
  assert.ok(out.startsWith('AAA'))
  assert.ok(out.endsWith('TAIL'))
  assert.match(out, /中间省略/)
})

// ── 分钟数解析 ──────────────────────────────────────────────

test('parseMinutes 认数字、分钟、半小时、小时', () => {
  assert.equal(parseMinutes('5'), 5)
  assert.equal(parseMinutes('12分钟'), 12)
  assert.equal(parseMinutes('半个小时'), 30)
  assert.equal(parseMinutes('1小时'), 60)
  assert.equal(parseMinutes(' 20 '), 20)
})

test('parseMinutes 认不出来用默认值，并夹在 1~180', () => {
  assert.equal(parseMinutes(''), 30)
  assert.equal(parseMinutes(undefined), 30)
  assert.equal(parseMinutes('随便'), 30)
  assert.equal(parseMinutes('0'), 30)
  assert.equal(parseMinutes('999'), 180)
  assert.equal(parseMinutes('-5'), 30)
})

// ── 路径越界 ────────────────────────────────────────────────

test('isInside 挡住 ../ 跑出目录', () => {
  assert.equal(isInside('C:\\data\\stardew', 'C:\\data\\stardew\\a.json'), true)
  assert.equal(isInside('C:\\data\\stardew', 'C:\\data\\stardew'), true)
  assert.equal(isInside('C:\\data\\stardew', 'C:\\data\\stardew-evil\\a.json'), false)
  assert.equal(isInside('C:\\data\\stardew', 'C:\\data\\other\\a.json'), false)
  assert.equal(isInside('C:\\data\\stardew', ''), false)
})

// ── 存档 mtime ─────────────────────────────────────────────

test('newestSaveMtime 取最新的那一份，坏目录跳过', () => {
  const files = {
    '/saves/农场A/农场A': 1000,
    '/saves/农场B/农场B': 3000,
    '/saves/农场C/农场C': 2000,
  }
  const m = newestSaveMtime('/saves', (d) => ['农场A', '农场B', '农场C'], (p) => {
    if (!(p in files)) throw new Error('no such file')
    return files[p]
  })
  assert.equal(m, 3000)
})

test('newestSaveMtime 目录不存在/读不了就返回 0（不能抛）', () => {
  assert.equal(newestSaveMtime('/nope', () => { throw new Error('ENOENT') }, () => 1), 0)
  assert.equal(newestSaveMtime('/saves', () => ['空的'], () => { throw new Error('ENOENT') }), 0)
})

// 2026-11-09 新增：每轮那句"我玩了什么"要能带回去，且假自述要被过滤掉。
// 背景：以前只留最后一轮（lastSay 反复覆盖），而且一轮最后一步常常还在调工具，
// 正文是空的——报告里就只剩轮数。改成 voices[] 每轮记一句后，6 分钟能跑 8 轮且每轮都有话。
test('voices 过滤：把"没进存档/标题画面"这类假自述丢掉，正常感受留下', () => {
  const voices = [
    { round: 1, text: '把 12 株蓝莓一次收完了，一按就全收，挺痛快' },
    { round: 2, text: '游戏还在标题画面，没进去' },
    { round: 3, text: '背包只剩 3 格，一堆垃圾占地方，有点烦' },
    { round: 4, text: '连不上服务器' },
  ]
  const kept = voices.filter((v) => !looksLikeBadSelfReport(v.text))
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map((v) => v.round), [1, 3])
  assert.match(kept[0].text, /蓝莓/)
})

test('voices 渲染：每轮一条，格式是"第N轮：……"，空数组时不给尾巴', () => {
  const render = (voices) =>
    voices.length ? '\n\n' + voices.map((v) => `第${v.round}轮：${v.text}`).join('\n') : ''
  const out = render([{ round: 1, text: '浇完了' }, { round: 2, text: '去森林采了一圈' }])
  assert.equal(out, '\n\n第1轮：浇完了\n第2轮：去森林采了一圈')
  assert.equal(render([]), '')
})
