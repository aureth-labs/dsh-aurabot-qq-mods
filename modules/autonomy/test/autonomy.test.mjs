// 自己找事做（autonomy）回归测试
//
// 模块语义：主人不在的空档里自己开一轮，一天有次数上限，夜里不闹。
// 重点锁住的约束：
//   · 次数计数按「本地日期」重置，跨天不串账
//   · 到上限后 /fire 绝不能再动（不能多花主人的 token）
//   · /tune 只认几个数字字段，越界值必须夹到面板允许的范围内
//   · /reset-tune 清空自己调的参数，回落到面板/配置/默认值
//   · 空配置、坏 JSON 一律走 defaults，不崩
//   · 参数优先级：tune > 面板(ext) > 手写配置 > defaults
//
// 写测试时发现并修掉的 bug：
//   1. setTune() 没夹到面板声明的范围。原本只做 Math.max(0, ...) 和
//      maxPerDay 至少 1，面板里点不出来的越界值写文件却照样生效：
//      maxPerDay: 999 就真的一天跑 999 次（烧主人的 token 和积分），
//      quietFrom: 99 让安静时段整段失效。修法：按 settings 里的 min/max
//      逐字段 clamp（everyMin/idleMin 5–1440，maxPerDay 1–24，quiet* 0–23）。
//   2. /tune 把数组当成合法参数吞掉。`typeof [] === 'object'` 让 [1,2] 通过校验、
//      返回 ok:true 但什么都没改，客户端会以为调成功了。修法：显式排掉 Array.isArray。
//      （对应用例：/tune 参数夹取 → 越界值夹取、/tune 路由 body 校验）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

const { default: mod } = await import(new URL('../index.mjs', import.meta.url).href)

const tmpDir = () => mkdtempSync(join(tmpdir(), 'aurabot-autonomy-'))
const HOUR = new Date().getHours()

/** 当前点一定在安静时段里（支持跨午夜那种写法）。 */
const quietNow = () => ({ quietFrom: HOUR, quietTo: (HOUR + 1) % 24 })
/** 当前点一定不在安静时段里。 */
const notQuietNow = () => ({ quietFrom: (HOUR + 1) % 24, quietTo: (HOUR + 2) % 24 })

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 造一个够用的 module api；数据集在临时目录里，不碰真实用户目录。 */
function makeApi({ config = {}, settings = {}, ownerChatAt = 0 } = {}) {
  const dir = tmpDir()
  const routes = new Map()
  const timers = []
  const pushes = []
  const api = {
    id: 'autonomy',
    dir: MOD,
    version: 'test',
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...p) => (p.length ? join(dir, ...p) : dir),
    config: () => config,
    settings: () => settings,
    saveSettings: () => ({}),
    route: (p, h) => routes.set(p, h),
    tool: () => {},
    defineTool: (d) => d,
    onDispose: () => {},
    every: (ms, fn, name) => {
      timers.push({ ms, fn, name })
      return () => {}
    },
    later: () => () => {},
    dsh: null,
    core: {
      hub: {
        lastOwnerChatAt: ownerChatAt,
        async pushToSession(session, blocks) {
          pushes.push({ session, blocks })
          return { ok: true }
        },
      },
      http: {
        send: () => {},
        query: () => ({}),
        body: async (req) => (req && typeof req === 'object' && 'body' in req ? req.body : {}),
      },
    },
  }
  return { api, dir, routes, timers, pushes }
}

/** 起一个模块实例，参数都写在 config.ext.autonomy 里（等于面板设置）。 */
function boot(over = {}) {
  const ctx = makeApi(over)
  const handle = mod.setup(ctx.api)
  return { ...ctx, handle, statePath: join(ctx.dir, 'state.json'), tunePath: join(ctx.dir, 'tune.json') }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v), 'utf8')

describe('默认值与参数优先级', () => {
  test('空配置走 defaults：默认关、45 分钟一次、一天 3 次、23→8 安静', () => {
    const { handle } = boot()
    const c = handle.cfg()
    assert.equal(c.enabled, false)
    assert.equal(c.everyMin, 45)
    assert.equal(c.idleMin, 40)
    assert.equal(c.maxPerDay, 3)
    assert.equal(c.quietFrom, 23)
    assert.equal(c.quietTo, 8)
  })

  test('优先级：tune > 面板(ext) > 手写配置 > defaults', () => {
    const { handle } = boot({ config: { autonomy: { maxPerDay: 5, idleMin: 10 }, ext: { autonomy: { maxPerDay: 7 } } } })
    assert.equal(handle.cfg().maxPerDay, 7, '面板设置要盖过手写配置')
    assert.equal(handle.cfg().idleMin, 10, '面板没给的键仍用手写配置')
    assert.equal(handle.cfg().everyMin, 45, '都没给的用 defaults')

    handle.setTune({ maxPerDay: 9 })
    assert.equal(handle.cfg().maxPerDay, 9, '自己调的参数优先级最高')
  })

  test('缺省配置不会把 enabled 误判成开', () => {
    const { handle } = boot({ config: {} })
    assert.equal(handle.cfg().enabled, false)
    assert.equal(handle.shouldAct().go, false)
    assert.equal(handle.shouldAct().why, '开关没开')
  })

  test('state.json / tune.json 是坏 JSON 时按空处理，不崩', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, ...notQuietNow() } } } })
    writeFileSync(ctx.statePath, '{坏的', 'utf8')
    writeFileSync(ctx.tunePath, '不是 json', 'utf8')
    assert.deepEqual(handleTune(ctx.tunePath), {}, '坏 tune.json 当作没调过')
    const status = await ctx.routes.get('/status')({})
    assert.deepEqual(status.state, { day: '', count: 0, lastAt: 0 }, '坏 state.json 当作今天还没动')
    assert.equal(status.go, true, '坏文件只当没有记录，不该一直不动')
  })
})

// tune 的读取走模块内部逻辑，这里只在测试侧按同样的规则读一下用于断言。
const handleTune = (p) => (existsSync(p) ? (() => { try { return JSON.parse(readFileSync(p, 'utf8')) || {} } catch { return {} } })() : {})

describe('每日次数上限与跨天重置', () => {
  test('今天没动过时 /fire 会动，计数变 1，推一条私聊', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, ...notQuietNow() } } } })
    const res = await ctx.handle.act('手动')
    assert.equal(res.ok, true)
    assert.equal(res.message, '动了')
    const state = readJson(ctx.statePath)
    assert.equal(state.count, 1)
    assert.equal(state.day, todayStr())
    assert.equal(ctx.pushes.length, 1)
    assert.equal(ctx.pushes[0].session.chatId, 'private:undefined')
    assert.match(ctx.pushes[0].blocks[0].text, /空闲时间/)
  })

  test('到上限后 /fire 不动，也不重复记账', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, maxPerDay: 2, ...notQuietNow() } } } })
    writeJson(ctx.statePath, { day: todayStr(), count: 2, lastAt: Date.now() })
    const before = readFileSync(ctx.statePath, 'utf8')
    const res = await ctx.handle.act('手动')
    assert.equal(res.ok, false)
    assert.match(res.message, /到上限了/)
    assert.equal(readFileSync(ctx.statePath, 'utf8'), before, '被拦住时状态文件一个字节都不该动')
    assert.equal(ctx.pushes.length, 0, '没到该动的时候绝不能推消息')
  })

  test('达到上限的边界是 >=：count 等于 maxPerDay 就停', () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, maxPerDay: 3, ...notQuietNow() } } } })
    writeJson(ctx.statePath, { day: todayStr(), count: 3, lastAt: 0 })
    assert.equal(ctx.handle.shouldAct().go, false)
    ctx.handle.setTune({ maxPerDay: 4 })
    assert.equal(ctx.handle.shouldAct().go, true, '自己把上限调到 4 就该放行')
  })

  test('跨天自动清零：昨天的 99 次不影响今天', () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, ...notQuietNow() } } } })
    writeJson(ctx.statePath, { day: '2026-01-01', count: 99, lastAt: 0 })
    const verdict = ctx.handle.shouldAct()
    assert.equal(verdict.go, true)
    assert.equal(verdict.count, 0, '换天了计数要从 0 数')
  })

  test('跨天第一次动手时把 day 改成今天、count 置 1', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, ...notQuietNow() } } } })
    writeJson(ctx.statePath, { day: '2026-01-01', count: 99, lastAt: 123456 })
    await ctx.handle.act('手动')
    const state = readJson(ctx.statePath)
    assert.equal(state.day, todayStr())
    assert.equal(state.count, 1)
    assert.ok(state.lastAt > 123456)
  })

  test('/status 返回判定结果 + cfg + tune + state 四块', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, maxPerDay: 5, ...notQuietNow() } } } })
    writeJson(ctx.statePath, { day: todayStr(), count: 1, lastAt: 0 })
    const res = await ctx.routes.get('/status')({})
    assert.equal(res.go, true)
    assert.equal(res.count, 1)
    assert.equal(res.cfg.maxPerDay, 5)
    assert.deepEqual(res.tune, {})
    assert.equal(res.state.count, 1)
  })
})

describe('空闲判定', () => {
  test('主人刚说过话就不动，并报出距现在几分钟', () => {
    const ctx = boot({
      config: { ext: { autonomy: { enabled: true, idleMin: 40, ...notQuietNow() } } },
      ownerChatAt: Date.now() - 10 * 60_000,
    })
    const verdict = ctx.handle.shouldAct()
    assert.equal(verdict.go, false)
    assert.match(verdict.why, /主人 10 分钟前还在说话/)
  })

  test('超过 idleMin 就算不在，可以动', () => {
    const ctx = boot({
      config: { ext: { autonomy: { enabled: true, idleMin: 40, ...notQuietNow() } } },
      ownerChatAt: Date.now() - 90 * 60_000,
    })
    const verdict = ctx.handle.shouldAct()
    assert.equal(verdict.go, true)
    assert.ok(verdict.idle >= 89 && verdict.idle <= 91, `实际 ${verdict.idle} 分钟`)
  })

  test('从没说过话（lastOwnerChatAt=0）当成不在，idle 记 0', () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, ...notQuietNow() } } } })
    const verdict = ctx.handle.shouldAct()
    assert.equal(verdict.go, true)
    assert.equal(verdict.idle, 0)
  })

  test('hub.lastOwnerChatAt 是函数时也能读（白名单副本的两种形态都容错）', () => {
    const ctx = makeApi()
    ctx.api.core.hub.lastOwnerChatAt = () => Date.now() - 5 * 60_000
    const handle = mod.setup(ctx.api)
    handle.setTune({ enabled: true })
    writeJson(join(ctx.dir, 'state.json'), { day: todayStr(), count: 0, lastAt: 0 })
    // 通过面板配置打开开关
    ctx.api.config = () => ({ ext: { autonomy: { enabled: true, idleMin: 40, ...notQuietNow() } } })
    const verdict = handle.shouldAct()
    assert.equal(verdict.go, false)
    assert.match(verdict.why, /分钟前还在说话/)
  })

  test('安静时段：现在就在窗口里就不动', () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, ...quietNow() } } } })
    const verdict = ctx.handle.shouldAct()
    assert.equal(verdict.go, false)
    assert.equal(verdict.why, '这个点该安静')
  })

  test('安静时段支持跨午夜（23→8）与「不设窗口」', () => {
    const cross = boot({ config: { ext: { autonomy: { enabled: false, quietFrom: 23, quietTo: 8 } } } })
    assert.equal(cross.handle.shouldAct().why, '开关没开', '开关判断优先于安静时段')

    // quietFrom === quietTo 表示没有安静窗口，任何点都不算安静
    const none = boot({ config: { ext: { autonomy: { enabled: true, quietFrom: HOUR, quietTo: HOUR } } } })
    assert.equal(none.handle.shouldAct().go, true)
  })

  test('定时器按 everyMin 自己算，没到点不推', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, everyMin: 45, ...notQuietNow() } } } })
    assert.equal(ctx.timers.length, 1)
    assert.equal(ctx.timers[0].ms, 60_000, '定时器一分钟一跳，间隔由 shouldAct 自己算')

    writeJson(ctx.statePath, { day: todayStr(), count: 0, lastAt: Date.now() })
    await ctx.timers[0].fn()
    assert.equal(ctx.pushes.length, 0, '离上次不到 45 分钟，不推')

    writeJson(ctx.statePath, { day: todayStr(), count: 0, lastAt: Date.now() - 60 * 60_000 })
    await ctx.timers[0].fn()
    assert.equal(ctx.pushes.length, 1, '隔了一小时该动了')
    assert.equal(readJson(ctx.statePath).count, 1)
  })
})

describe('/tune 参数夹取', () => {
  test('越界值夹到面板允许的范围内', () => {
    const ctx = boot()
    const res = ctx.handle.setTune({ quietFrom: 99, quietTo: -5, everyMin: 99999, idleMin: 1, maxPerDay: 999 })
    assert.equal(res.ok, true)
    assert.equal(res.tune.quietFrom, 23, 'quietFrom 上限 23')
    assert.equal(res.tune.quietTo, 0, 'quietTo 下限 0')
    assert.equal(res.tune.everyMin, 1440, 'everyMin 上限 1440')
    assert.equal(res.tune.idleMin, 5, 'idleMin 下限 5')
    assert.equal(res.tune.maxPerDay, 24, 'maxPerDay 上限 24')
  })

  test('次数上限至少 1，别把自己调到不动', () => {
    const ctx = boot()
    assert.equal(ctx.handle.setTune({ maxPerDay: 0 }).tune.maxPerDay, 1)
    assert.equal(ctx.handle.setTune({ maxPerDay: -8 }).tune.maxPerDay, 1)
  })

  test('小数四舍五入，非数字与非白名单字段直接忽略', () => {
    const ctx = boot()
    const res = ctx.handle.setTune({ maxPerDay: 4.6, everyMin: 'abc', ownerQQ: '123', enabled: true })
    assert.equal(res.tune.maxPerDay, 5)
    assert.equal(res.tune.everyMin, undefined, '转不成有限数字就整条丢掉，不写进去')
    assert.equal(res.tune.ownerQQ, undefined, '白名单外的字段不能写进 tune.json')
    assert.equal(res.tune.enabled, undefined, '总开关由主人控，自己不许改')
  })

  test('部分更新是合并，不会把之前调的参数冲掉', () => {
    const ctx = boot()
    ctx.handle.setTune({ maxPerDay: 8 })
    ctx.handle.setTune({ idleMin: 20 })
    const tune = readJson(ctx.tunePath)
    assert.equal(tune.maxPerDay, 8)
    assert.equal(tune.idleMin, 20)
  })

  test('/tune 路由：body 是字符串时先 JSON.parse，不是对象就报错', async () => {
    const ctx = boot()
    const handler = ctx.routes.get('/tune')
    const ok = await handler({ body: '{"maxPerDay":6}' })
    assert.equal(ok.ok, true)
    assert.equal(ok.tune.maxPerDay, 6)

    const bad = await handler({ body: '不是 json' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /要传一组参数/)

    const empty = await handler({ body: null })
    assert.equal(empty.ok, false)

    const arr = await handler({ body: '[1,2]' })
    assert.equal(arr.ok, false)
  })

  test('/reset-tune 清空自己调的参数，回落到面板/默认值', async () => {
    const ctx = boot({ config: { ext: { autonomy: { maxPerDay: 5 } } } })
    ctx.handle.setTune({ maxPerDay: 12, idleMin: 5 })
    assert.equal(ctx.handle.cfg().maxPerDay, 12)

    const res = await ctx.routes.get('/reset-tune')({})
    assert.equal(res.ok, true)
    assert.deepEqual(res.tune, {})
    assert.equal(readFileSync(ctx.tunePath, 'utf8'), '{}')
    assert.equal(ctx.handle.cfg().maxPerDay, 5, '回到面板设置')
    assert.equal(ctx.handle.cfg().idleMin, 40, '面板没给的键回到 defaults')
  })

  test('resetTune 在 tune.json 不存在时也不崩', () => {
    const ctx = boot()
    assert.equal(existsSync(ctx.tunePath), false)
    const res = ctx.handle.resetTune()
    assert.equal(res.ok, true)
    assert.deepEqual(res.tune, {})
  })
})

describe('路由与模块装配', () => {
  test('入口与 module.json 的 id / version / api 一致', () => {
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.id, mod.id)
    assert.equal(m.version, mod.version)
    assert.equal(m.api, mod.api)
    assert.equal(typeof mod.setup, 'function')
  })

  test('注册 /fire /status /tune /reset-tune，路径不带模块前缀', () => {
    const ctx = boot()
    for (const p of ['/fire', '/status', '/tune', '/reset-tune']) {
      assert.ok(ctx.routes.has(p), `${p} 没注册上`)
      assert.ok(!p.startsWith('/autonomy'), 'api.route 会自动加 /ext/<id>，再写前缀就双层了')
    }
  })

  test('/fire 在开关关着时返回 ok:false 且说明原因', async () => {
    const ctx = boot()
    const res = await ctx.routes.get('/fire')({})
    assert.equal(res.ok, false)
    assert.equal(res.message, '开关没开')
    assert.equal(ctx.pushes.length, 0)
  })

  test('/fire 成功时推的是私聊会话，正文带次数与省钱提醒', async () => {
    const ctx = boot({ config: { ext: { autonomy: { enabled: true, maxPerDay: 5, ...notQuietNow() } }, ownerName: '主人', ownerQQ: '10000001' } })
    const res = await ctx.routes.get('/fire')({})
    assert.equal(res.ok, true)
    const { session, blocks } = ctx.pushes[0]
    assert.equal(session.kind, 'private')
    assert.equal(session.chatId, 'private:10000001')
    assert.equal(session.nickname, '主人')
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /今天你已经自己动过 0 次/)
    assert.match(blocks[0].text, /\[沉默\]/)
  })
})
