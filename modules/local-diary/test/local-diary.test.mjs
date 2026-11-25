// 私人日记（local-diary）测试。
// 覆盖三块：日记落盘与同日编号、index/state 读写、面板路由与目录配置。
// 全部用最小的假 api 驱动 setup()，不连 QQ、不打网络，只写系统临时目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const DAY = dayKey()
const BODY = '今天在公园看锦鲤，红的一片挤过来。'

/** 建一个临时根目录，用例结束自动删。 */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'local-diary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** 够 setup() 跑起来的假宿主；跑的其实就是真实代码路径。 */
function fakeApi(root, { think, preset, rows, ownerQQ = '1' } = {}) {
  const routes = {}
  const cfg = { ...mod.defaults, ...(preset || {}) }
  const api = {
    routes,
    cfg,
    posted: {},
    query: {},
    toolSelector: null,
    dataDir: () => join(root, 'data'),
    settings: () => cfg,
    config: () => ({ ownerQQ }),
    log: { info() {}, warn() {}, error() {} },
    every: () => {},
    command: () => {},
    context: (fn) => { api.contextFn = fn },   // 捕获注入钩子，只给主人私聊那条用例用
    rule: () => {},
    tool: (fn) => { api.toolSelector = fn },
    defineTool: (tool) => tool,
    lazy: (name) => {
      if (name === 'memory') return { add() {}, timeline: () => [] }
      if (name === 'mood') return { label: () => '心情不错', contextLine: () => '（你现在心情不错…）' }
      return null
    },
    think: think || (async () => BODY),
    route: (path, handler) => { routes[path] = handler },
    core: {
      hub: {
        chatLogOf: () => rows || [
          { t: Date.parse('2026-11-15T09:12:00'), chatId: 'private:1', who: 'user', text: '早' },
          { t: Date.parse('2026-11-15T09:13:00'), chatId: 'private:1', who: 'bot', text: '早呀' },
          { t: Date.parse('2026-11-15T12:00:00'), chatId: 'group:888', who: 'user', text: '在吗' },
        ],
      },
      http: {
        body: async () => api.posted,
        query: () => api.query,
      },
    },
  }
  return api
}

/** 起一份实例，返回 api 与模块自报的句柄。 */
function boot(root, opts) {
  const api = fakeApi(root, opts)
  const inst = mod.setup(api)
  return { api, inst }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

test('第一次写落一份 md，同一天再写往后编号，旧的不覆盖', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root)
  const dir = inst.folder()

  const first = await api.routes['/run']()
  assert.equal(first.ok, true, first.message)
  const day1 = join(dir, `${DAY}.md`)
  assert.equal(first.file, day1)
  assert.equal(existsSync(day1), true)

  const text = readFileSync(day1, 'utf8')
  assert.match(text, new RegExp(`^---\ndate: ${DAY}\n`))
  assert.match(text, /mood: "心情不错"/)
  assert.match(text, /chats: 3/)
  assert.ok(text.includes(BODY), '正文应该原样落进文件')

  const second = await api.routes['/run']()
  assert.equal(second.ok, true, second.message)
  assert.equal(second.file, join(dir, `${DAY}-2.md`))
  assert.equal(existsSync(day1), true, '第一篇不能被覆盖')

  const third = await api.routes['/run']()
  assert.equal(third.file, join(dir, `${DAY}-3.md`))
})

test('她一个字都没写时不落文件，也不动索引', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root, { think: async () => '   ' })

  const res = await api.routes['/run']()
  assert.equal(res.ok, false)
  assert.match(res.message, /什么都没写/)
  assert.equal(existsSync(join(inst.folder(), `${DAY}.md`)), false)
  assert.equal(inst.list().length, 0)
})

test('索引逐篇记下，state 只存 last，不把运行标志写进磁盘', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  const base = join(root, 'data')

  await api.routes['/run']()
  await api.routes['/run']()

  const index = readJson(join(base, 'index.json'))
  assert.equal(index.length, 2)
  for (const item of index) {
    assert.equal(item.day, DAY)
    assert.ok(item.file.endsWith('.md'))
    assert.equal(item.chars, BODY.length)
    assert.equal(item.mood, '心情不错')
    assert.ok(item.summary.length > 0)
  }

  const state = readJson(join(base, 'state.json'))
  assert.deepEqual(state, { last: DAY }, 'state 只该存 last')
  assert.equal('running' in state, false, 'running 只能是内存里的，写盘会卡死定时')
})

test('磁盘上残留 running=true 也不会把定时器卡住', async (t) => {
  const root = tempRoot(t)
  const base = join(root, 'data')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'state.json'), JSON.stringify({ last: '', running: true }), 'utf8')

  const { api } = boot(root)
  const status = await api.routes['/status']()
  assert.equal(status.running, false)

  const res = await api.routes['/run']()
  assert.equal(res.ok, true, '不该回「上一篇还在写」')
})

test('索引丢了会从文件夹重扫回来，心情和字数都对得上', async (t) => {
  const root = tempRoot(t)
  const base = join(root, 'data')
  const first = boot(root)
  await first.api.routes['/run']()

  rmSync(join(base, 'index.json'))
  const again = boot(root)
  const list = again.inst.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].day, DAY)
  assert.equal(list[0].mood, '心情不错')
  assert.equal(list[0].chars, BODY.length)
})

test('面板按 POST 里的 file 读正文，读不到就说没有这篇', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  const saved = await api.routes['/run']()

  api.posted = { file: saved.file }
  const read = await api.routes['/read']({})
  assert.equal(read.ok, true)
  assert.equal(read.day, DAY)
  assert.equal(read.body, BODY, '正文要剥掉 frontmatter')
  assert.equal(read.meta.chats, '3')

  // 网址参数那条路也要通
  api.posted = {}
  api.query = { file: saved.file }
  assert.equal((await api.routes['/read']({})).ok, true)

  // 不在索引里的路径一律不放行
  api.query = {}
  for (const file of ['', join(root, 'data', 'diary', 'nope.md'), '/etc/passwd', '../../secret.md']) {
    api.posted = { file }
    const miss = await api.routes['/read']({})
    assert.equal(miss.ok, false, `不该读到 ${file}`)
    assert.match(miss.message, /没有这篇/)
  }
})

test('日记文件夹按设置走，开镜像时同步一份进备份区', async (t) => {
  const root = tempRoot(t)
  const outside = join(root, '外面')
  const { api, inst } = boot(root, { preset: { dir: outside, mirror: true } })

  const res = await api.routes['/run']()
  assert.equal(res.ok, true, res.message)
  assert.equal(inst.folder(), outside)
  const file = join(outside, `${DAY}.md`)
  assert.equal(existsSync(file), true)
  assert.equal(existsSync(join(root, 'data', 'archive', `${DAY}.md`)), true, '外部文件夹要镜像进备份区')

  // 关掉镜像就不再复制
  api.cfg.mirror = false
  await api.routes['/run']()
  assert.equal(existsSync(join(root, 'data', 'archive', `${DAY}-2.md`)), false)
})

test('没放字体文件时明说，面板不至于 500', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  const res = await api.routes['/hand.ttf']({}, {})
  // 仓库里不带字体（授权问题），所以这里走的是缺失分支
  assert.equal(res.ok, false)
  assert.match(res.message, /assets\/hand\.ttf/)
})

test('diary_read 只给主人私聊，别人和系统会话都拿不到', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  await api.routes['/run']()

  // 宿主两种接法都认：给单个工具，或者给空数组
  const pick = (args) => {
    const got = api.toolSelector(args)
    if (Array.isArray(got)) return got
    return got ? [got] : []
  }

  assert.deepEqual(pick({ level: 'social', chat: { kind: 'group' } }), [])
  assert.deepEqual(pick({ level: 'full', chat: { kind: 'system' } }), [])

  const tools = pick({ level: 'full', chat: { kind: 'private' } })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'diary_read')

  const hit = await tools[0].execute({})
  assert.equal(hit.ok, true)
  assert.ok(hit.message.includes(BODY))

  const byDay = await tools[0].execute({ day: DAY })
  assert.ok(byDay.message.includes(BODY))

  const miss = await tools[0].execute({ query: '完全不存在的东西' })
  assert.match(miss.message, /没找到对应的日记/)
})

test('/status 报的路径、篇数与翻了页的顺序对得上', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root)
  await api.routes['/run']()
  await api.routes['/run']()

  const status = await api.routes['/status']()
  assert.equal(status.ok, true)
  assert.equal(status.folder, inst.folder())
  assert.equal(status.count, 2)
  assert.equal(status.items.length, 2)
  assert.ok(status.items[0].file.endsWith(`${DAY}-2.md`), '最新的排最前面')
  assert.equal(typeof status.next, 'string')
  assert.ok(status.next.length > 0)
})

test('她要想许愿就落进 frontmatter 和索引，不想写也不硬塞', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root, {
    think: async () => '今天在公园看锦鲤，红的一片挤过来。\n\n愿望：想和他去看一次海。',
  })

  const res = await api.routes['/run']()
  assert.equal(res.ok, true, res.message)
  const text = readFileSync(join(inst.folder(), `${DAY}.md`), 'utf8')
  assert.match(text, /wish: "想和他去看一次海。"/)

  const status = await api.routes['/status']()
  assert.equal(status.items[0].wish, '想和他去看一次海。')

  const tools = (() => {
    const got = api.toolSelector({ level: 'full', chat: { kind: 'private' } })
    return Array.isArray(got) ? got : [got]
  })()
  const read = await tools[0].execute({ day: DAY })
  assert.ok(read.message.includes('愿望：想和他去看一次海。'))
})

test('没写愿望的那天，正文里不出现 wish 字段', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root, { think: async () => '今天没什么好说的。' })

  await api.routes['/run']()
  const text = readFileSync(join(inst.folder(), `${DAY}.md`), 'utf8')
  assert.equal(/^wish:/m.test(text), false)
  const status = await api.routes['/status']()
  assert.equal(status.items[0].wish, '')
})

test('愿望写法宽松：带 # 标题、用「心愿」，写了几个就收几个', async (t) => {
  const root = tempRoot(t)
  const dir = join(root, '手写')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${DAY}.md`)
  writeFileSync(file, [
    '---',
    `date: ${DAY}`,
    'mood: "平平常常"',
    '---',
    '',
    '## 愿望：想早点睡。',
    '后来改主意了。',
    '心愿：还是想多看一会儿星星。',
    '',
  ].join('\n'), 'utf8')

  const { inst } = boot(root, { preset: { dir } })
  const item = inst.list().find((x) => x.day === DAY)
  assert.ok(item, '应该重扫到这篇')
  assert.deepEqual(item.wishes, ['想早点睡。', '还是想多看一会儿星星。'])
  assert.equal(item.wish, '想早点睡。；还是想多看一会儿星星。')
})

const at = (day, hh, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`)

test('早上补写昨天：只补昨天，不会因为 state.last 倒回去又重写今天', async (t) => {
  const root = tempRoot(t)
  const { inst } = boot(root, { preset: { at: '07:00' } })
  const today = DAY
  const yesterday = dayKey(new Date(at(today, 12).getTime() - 86400000))

  await inst.tick(at(today, 7, 30))   // 昨天没写 → 先补昨天
  assert.deepEqual(inst.list().map((x) => x.day), [yesterday])
  await inst.tick(at(today, 7, 31))   // 昨天有了 → 写今天
  await inst.tick(at(today, 7, 32))   // 今天也有了 → 什么都不做
  await inst.tick(at(today, 7, 33))
  const days = inst.list().map((x) => x.day).sort()
  assert.deepEqual(days, [yesterday, today].sort(), '每天恰好一篇，不重复')
})

test('默认 23:30 的配置下，早上 7–9 点也能补昨天', async (t) => {
  const root = tempRoot(t)
  const { inst } = boot(root)
  await inst.tick(at(DAY, 8, 0))
  assert.equal(inst.list().length, 1)
  assert.notEqual(inst.list()[0].day, DAY)
  await inst.tick(at(DAY, 8, 1))
  assert.equal(inst.list().length, 1, '还没到 23:30，不写今天')
})

test('写失败不会每分钟重试：同一天最多 3 次，间隔 10 分钟', async (t) => {
  const root = tempRoot(t)
  let calls = 0
  const { inst } = boot(root, { think: async () => { calls++; throw new Error('boom') }, preset: { at: '00:00', catchUp: false } })
  const now = Date.now()
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  for (let i = 0; i < 40; i++) {
    Date.now = () => now + i * 60_000
    await inst.tick(at(DAY, 12, 0))
  }
  assert.equal(calls, 3)
})

test('/status 返回全部篇目，不只最近 20 篇', async (t) => {
  const root = tempRoot(t)
  const dir = join(root, '多')
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= 25; i++) {
    const d = `2026-10-${String(i).padStart(2, '0')}`
    writeFileSync(join(dir, `${d}.md`), `---\ndate: ${d}\nmood: "心情不错"\n---\n\n第 ${i} 天\n`, 'utf8')
  }
  const { api } = boot(root, { preset: { dir } })
  const status = await api.routes['/status']()
  assert.equal(status.count, 25)
  assert.equal(status.items.length, 25)
  assert.equal(status.items[0].day, '2026-10-25')
  assert.equal(status.items[24].day, '2026-10-01')
})

test('镜像判断不被同名前缀骗到：data2 不算在 data 里面', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root, { preset: { dir: join(root, 'data2'), mirror: true } })
  const res = await api.routes['/run']()
  assert.equal(res.ok, true, res.message)
  assert.equal(existsSync(join(root, 'data', 'archive', `${DAY}.md`)), true)
})

test('昨天补写试够了不会把今天也挡住', async (t) => {
  const root = tempRoot(t)
  const yesterday = dayKey(new Date(at(DAY, 12).getTime() - 86400000))
  const { inst } = boot(root, {
    preset: { at: '07:00' },
    think: async (prompt) => { if (prompt.includes('补上')) throw new Error('boom'); return BODY },
  })
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  const base = realNow()
  for (let i = 0; i < 5; i++) {
    Date.now = () => base + i * 11 * 60_000
    await inst.tick(at(DAY, 8, i))
  }
  const days = inst.list().map((x) => x.day)
  assert.equal(days.includes(yesterday), false)
  assert.equal(days.includes(DAY), true, '昨天写不出来，今天照写')
})

test('想许几个就许几个：全部进文件头、索引、记忆，重复的只记一次', async (t) => {
  const root = tempRoot(t)
  const added = []
  const { api, inst } = boot(root, {
    think: async () => '今天很满。\n\n愿望：想去看海。\n愿望：想学会弹那首《梦》。\n心愿：想去看海。\n心愿：想一起吃草莓蛋糕。',
  })
  const realLazy = api.lazy
  api.lazy = (name) => (name === 'memory' ? { add: (x) => added.push(x), timeline: () => [] } : realLazy(name))

  const res = await api.routes['/run']()
  assert.equal(res.ok, true, res.message)
  const text = readFileSync(join(inst.folder(), `${DAY}.md`), 'utf8')
  assert.match(text, /^wishes: \["想去看海。","想学会弹那首《梦》。","想一起吃草莓蛋糕。"\]$/m)

  const status = await api.routes['/status']()
  assert.deepEqual(status.items[0].wishes, ['想去看海。', '想学会弹那首《梦》。', '想一起吃草莓蛋糕。'])

  assert.equal(added.length, 1)
  assert.ok(added[0].text.includes('想去看海。；想学会弹那首《梦》。；想一起吃草莓蛋糕。'))
  assert.ok(added[0].tags.includes('愿望'))
})

test('旧日记只有单个 wish: 也能读成一个愿望', async (t) => {
  const root = tempRoot(t)
  const dir = join(root, '旧')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${DAY}.md`), `---\ndate: ${DAY}\nmood: "心情不错"\nwish: "想和他去看一次海。"\n---\n\n今天。\n`, 'utf8')
  const { inst } = boot(root, { preset: { dir } })
  const item = inst.list().find((x) => x.day === DAY)
  assert.deepEqual(item.wishes, ['想和他去看一次海。'])
  assert.equal(item.wish, '想和他去看一次海。')
})

// ---- 1.2.0 新增：按时段采样、主群/主人私聊优先、日记只注入主人私聊 ----

test('采样按时段铺开，不会只剩当天最后几条', async (t) => {
  const root = tempRoot(t)
  // 早上 6 点、中午 12 点、深夜 23 点各 50 条；纯取尾部的话早上和中午会全丢
  const rows = []
  for (const [h, tag] of [[6, '清晨'], [12, '中午'], [23, '深夜']]) {
    for (let i = 0; i < 50; i += 1) {
      rows.push({ t: new Date(2026, 10, 15, h, i % 60).getTime(), chatId: 'group:888', who: 'user', text: `${tag}${i}` })
    }
  }
  const { api } = boot(root, { rows, preset: { maxRows: 30 } })
  const prompts = []
  await api.routes['/run']()
  // 从落盘文件反推不了素材，直接看聊天条数上限被遵守即可
  const status = await api.routes['/status']()
  assert.equal(status.ok, true)

  // 换个角度验证：maxRows 小时，采样结果里三个时段都还留有痕迹
  const seen = []
  const { api: api2 } = boot(root, { rows, preset: { maxRows: 30 }, think: async (p) => { seen.push(p); return BODY } })
  await api2.routes['/run']()
  assert.equal(seen.length, 1)
  for (const tag of ['清晨', '中午', '深夜']) {
    assert.ok(seen[0].includes(tag), `喂给模型的素材里应该有${tag}的聊天，实际没有`)
  }
})

test('主人私聊和主群优先：其他群刷屏再多也抢不走额度', async (t) => {
  const root = tempRoot(t)
  const rows = []
  // 主人私聊 5 条（都在中午）
  for (let i = 0; i < 5; i += 1) rows.push({ t: new Date(2026, 10, 15, 12, i).getTime(), chatId: 'private:1', who: 'user', text: `主人说的第${i}句` })
  // 别的群 300 条刷屏
  for (let i = 0; i < 300; i += 1) rows.push({ t: new Date(2026, 10, 15, 22, i % 60).getTime(), chatId: 'group:999', who: 'user', text: `群友刷屏${i}` })
  const seen = []
  const { api } = boot(root, { rows, preset: { maxRows: 40 }, think: async (p) => { seen.push(p); return BODY } })
  await api.routes['/run']()
  assert.equal(seen.length, 1)
  // 五条主人私聊应当全部进素材（主人私聊只有 5 条，远小于七成额度）
  for (let i = 0; i < 5; i += 1) assert.ok(seen[0].includes(`主人说的第${i}句`), `主人私聊第 ${i} 句不该被刷屏挤掉`)
})

test('主群群号可以在面板里配，不填就全按时间截断', async (t) => {
  const root = tempRoot(t)
  const rows = []
  for (let i = 0; i < 5; i += 1) rows.push({ t: new Date(2026, 10, 15, 12, i).getTime(), chatId: 'group:608034610', who: 'user', text: `主群第${i}句` })
  for (let i = 0; i < 200; i += 1) rows.push({ t: new Date(2026, 10, 15, 22, i % 60).getTime(), chatId: 'group:999', who: 'user', text: `别的群${i}` })

  const seen = []
  const { api } = boot(root, { rows, preset: { maxRows: 30, mainGroup: '608034610' }, think: async (p) => { seen.push(p); return BODY } })
  await api.routes['/run']()
  assert.equal(seen.length, 1)
  for (let i = 0; i < 5; i += 1) assert.ok(seen[0].includes(`主群第${i}句`), `配了主群后，主群第 ${i} 句应该保住`)
})

test('日记线索只注入主人私聊，群聊和陌生人不带', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root, { ownerQQ: '1' })
  await api.routes['/run']()   // 先写一篇，index 里才有东西

  assert.equal(typeof api.contextFn, 'function', '模块应该注册了上下文钩子')

  // 主人私聊：注入
  const ownerText = api.contextFn({ chat: { kind: 'private', userId: '1' } })
  assert.match(ownerText, /你写过这些私人日记/)

  // 陌生人的私聊：不注入（原来会漏，等于把私聊内容带到别人那）
  assert.equal(api.contextFn({ chat: { kind: 'private', userId: '999' } }), '')

  // 群聊：不注入（原来会漏，等于把私聊内容带到群里）
  assert.equal(api.contextFn({ chat: { kind: 'group', groupId: '888' } }), '')

  // 没有 chat（系统轮）也不该崩
  assert.equal(api.contextFn({}), '')
})
