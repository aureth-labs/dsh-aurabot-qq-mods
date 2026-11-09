// slop（去套话）回归测试
//
// 模块语义：同一句套话在她自己说过的历史里出现第 2 次就换个说法。
// 重点锁住的约束：
//   · 只改「发给模型看的历史」，不改落盘会话和主人看到的正文
//   · 代码块 / 行内代码里的内容绝不能被改写
//   · 改写要稳定：同样的输入 + 同样的上下文给同样的结果（否则每轮都在漂）
//   · 阈值以下不动：第一次出现是自然的，重复才是套话
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

const F = await import(new URL('../lib/filter.js', import.meta.url).href)
const { default: mod } = await import(new URL('../index.mjs', import.meta.url).href)

/** 真实规则表：模块自带的那份 */
const RAW = JSON.parse(readFileSync(join(MOD, 'assets', 'slop-zh.json'), 'utf8'))

/** 改写时必填的上下文（和 index.mjs 里传给 filter 的一致） */
const baseOpts = (over = {}) => ({
  repeatThreshold: 2,
  rulesetVersion: 1,
  lang: 'zh',
  messageIndex: 0,
  partIndex: 0,
  ...over,
})

describe('受保护区域：代码不能被改写', () => {
  test('fencedCodeSpans 圈出 ``` 代码块', () => {
    const src = '前面\n```js\nconst a = 1\n```\n后面'
    const spans = F.fencedCodeSpans(src)
    assert.ok(spans.length >= 1, '至少要圈出一个代码块')
    const seg = spans[0]
    const [s, e] = Array.isArray(seg) ? [seg[0], seg[1]] : [seg.start, seg.end]
    assert.ok(src.slice(s, e).includes('const a = 1'), '代码块内容要落在受保护区间')
  })

  test('inlineCodeSpans 圈出 `行内代码`', () => {
    const src = '看看 `npm test` 这个命令'
    const spans = F.inlineCodeSpans(src, F.fencedCodeSpans(src))
    assert.ok(spans.length >= 1, '至少要圈出一个行内代码')
  })

  test('protectedSpans 同时覆盖两种代码', () => {
    const src = '```\nblock\n```\n中间 `inline` 结尾'
    const spans = F.protectedSpans(src)
    assert.ok(spans.length >= 2, `代码块和行内代码都要算，实际 ${spans.length} 段`)
  })

  test('真实改写时，代码块里的内容原样保留', () => {
    const loaded = F.loadRules(RAW)
    const text = '```js\nconst x = 1\n```'
    const out = F.rewriteText(text, loaded.prepared, baseOpts({ repeatThreshold: 1 }))
    assert.ok(out.includes('const x = 1'), '代码块内容必须原样保留')
  })
})

describe('规则表', () => {
  test('模块自带的规则表能加载出来且非空', () => {
    const loaded = F.loadRules(RAW)
    assert.ok(loaded.prepared, 'loadRules 要返回 prepared')
    const n = F.countRules(loaded.prepared)
    assert.ok(n > 0, `规则表不能为空，实际 ${n} 条`)
    assert.equal(typeof loaded.repeatThreshold, 'number', '要带 repeatThreshold')
  })

  test('空规则表时 loadRules 不炸', () => {
    const loaded = F.loadRules({})
    assert.equal(F.countRules(loaded.prepared), 0)
  })

  test('rulesetVersion 缺失时回落到 1', () => {
    const loaded = F.loadRules({})
    assert.equal(loaded.rulesetVersion, 1)
  })

  test('convertTemplate 能把中文模板转成可用正则', () => {
    const s = F.convertTemplate('你还有什么想问的吗')
    assert.ok(s, '要能转出东西')
    const re = new RegExp(s)
    assert.ok(re.test('你还有什么想问的吗'), '转出来的正则要能匹配原文')
  })
})

describe('改写语义', () => {
  test('空规则表时原样返回（不做任何改动）', () => {
    const loaded = F.loadRules({})
    const text = '今天天气不错'
    assert.equal(F.rewriteText(text, loaded.prepared, baseOpts()), text)
  })

  test('空文本 / 非字符串原样返回，不抛', () => {
    const loaded = F.loadRules(RAW)
    assert.equal(F.rewriteText('', loaded.prepared, baseOpts()), '')
    assert.equal(F.rewriteText(null, loaded.prepared, baseOpts()), null)
    assert.equal(F.rewriteText(undefined, loaded.prepared, baseOpts()), undefined)
  })

  test('阈值以下不改：同一句只出现 1 次时原样返回', () => {
    const loaded = F.loadRules(RAW)
    const text = '今天天气不错'
    const out = F.rewriteText(text, loaded.prepared, baseOpts({ repeatThreshold: 2 }))
    assert.equal(out, text, '没到重复阈值就不该动')
  })

  test('同样输入 + 同样上下文，重复改写结果一致（不漂）', () => {
    const loaded = F.loadRules(RAW)
    // 找一条真实规则去命中，保证真的走到了改写分支
    const rule = loaded.prepared[0]
    assert.ok(rule, '至少要有一条规则')
    rule.compiled.lastIndex = 0
    const sample = '你还有什么想问的吗'.repeat(3)
    const opts = baseOpts({ repeatThreshold: 1 })
    const a = F.rewriteText(sample, loaded.prepared, opts, {}, {})
    const b = F.rewriteText(sample, loaded.prepared, opts, {}, {})
    assert.equal(a, b, '同样的输入不能每次给不同结果')
  })
})

describe('stablePoolChoice：稳定 + 分散', () => {
  test('同一个 key 永远选同一个候选', () => {
    const pool = ['说法一', '说法二', '说法三', '说法四']
    const a = F.stablePoolChoice(pool, { ruleId: 'r1', occurrence: 1, start: 5 })
    const b = F.stablePoolChoice(pool, { ruleId: 'r1', occurrence: 1, start: 5 })
    assert.equal(a, b)
    assert.ok(pool.includes(a), '选出来的必须在池子里')
  })

  test('不同 key 能分散到多个候选', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const picked = new Set()
    for (let i = 0; i < 60; i++) picked.add(F.stablePoolChoice(pool, { ruleId: 'r', occurrence: i, start: i * 7 }))
    assert.ok(picked.size > 1, `不同 key 应该分散，实际只有 ${picked.size} 种`)
  })

  test('空池子返回空串而不是崩', () => {
    const r = F.stablePoolChoice([], { ruleId: 'r' })
    assert.equal(r, '', '空池子要给空串')
  })
})

describe('模块装配', () => {
  test('入口与 module.json 三处版本 / id / api 一致', () => {
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.id, mod.id)
    assert.equal(m.version, mod.version)
    assert.equal(m.api, mod.api)
    assert.equal(typeof mod.setup, 'function')
  })

  test('setup 能起来并注册 /status 路由', async () => {
    const routes = new Map()
    const api = {
      id: 'slop', dir: MOD, version: 'test',
      log: { info() {}, warn() {}, debug() {}, error() {} },
      dataDir: (...p) => join(process.env.TMP || '/tmp', 'aurabot-slop-test', ...p),
      config: () => ({}), settings: () => ({ ...(mod.defaults || {}) }), saveSettings: () => ({}),
      route: (p, h) => routes.set(p, h),
      tool: () => {}, defineTool: (d) => d, onDispose: () => {},
      every: () => () => {}, later: () => () => {},
      dsh: null,
      core: { http: { send: (res, c, b) => { res.statusCode = c; res.body = JSON.stringify(b) }, query: () => ({}), body: async () => ({}) } },
    }
    mod.setup(api)
    assert.ok(routes.has('/status'), '/status 要注册上')
  })
})
