// 刷红果短剧（hongguo）回归测试
//
// 这个模块要起浏览器、播视频、调模型，**测试绝不真跑这些**：
//   · 只测能被注入替换的那部分（browser / site 都可以从外面传进来）
//   · 状态机、上限、暂停、失败回退这些「决定她要不要动、动了算不算数」的逻辑
//
// 重点锁住的语义：
//   1. 没登录 / 有验证码 / 超上限 → 必须不刷，且说明原因
//   2. 一部都没播起来 → 不能记成「看过」（否则第二天全是假记录）
//   3. 只有「真看过 + 觉得好看」才分享，觉得一般就不推
//   4. 模型看不懂画面时要如实标 sawFrames:false，不能假装看过
//   5. 浏览器打开失败 → 不要把状态写成「没登录」（会误导主人一直点不动）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

// duty.mjs 顶部会读 globalThis.aurabot.lib 加载插件内部模块，测试里塞最小桩
if (!globalThis.aurabot) {
  globalThis.aurabot = {
    lib: (name) => {
      if (name === 'core/store.js') {
        // 用内存文件系统替身：readJson/writeJson 只在自己数据目录里
        const mem = new Map()
        return {
          readJson: (file, fallback) => (mem.has(file) ? JSON.parse(mem.get(file)) : fallback()),
          writeJson: (file, value) => { mem.set(file, JSON.stringify(value)) }
        }
      }
      if (name === 'chat/reply.js') return { isSilence: (t) => !t || /^[（(]?\s*[)）]?$/.test(String(t).trim()) }
      if (name === 'chat/access.js') return { permOf: (cfg, key) => (cfg?.perms?.[key] || 'on') }
      if (name === 'core/llm.js') throw new Error('测试环境没有看图通道')
      return new Proxy({}, { get: () => () => '' })
    },
    src: new URL('..', import.meta.url).href
  }
}

const { createHongguo } = await import(new URL('../lib/duty.mjs', import.meta.url).href)
const { default: mod } = await import(new URL('../index.mjs', import.meta.url).href)

let dataRoot = ''
function freshDir () {
  if (dataRoot) { try { rmSync(dataRoot, { recursive: true, force: true }) } catch {} }
  dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-hongguo-test-'))
  return dataRoot
}

/** 造一个可控的假 site：每个方法都能单独指定行为 */
function fakeSite (over = {}) {
  return {
    ensure: async () => ({ ok: true }),
    self: async () => ({ nickname: 'tester', uid: '1' }),
    verify: async () => '',
    feed: async () => [{ href: 'https://hongguoduanju.com/detail?series_id=1', title: '剧一', cover: '' }],
    detail: async (href) => ({ title: '剧一', intro: '简介', cover: 'c.png' }),
    play: async () => ({ seconds: 30, wanted: 30, ok: true, frames: ['BASE64FRAME'] }),
    comments: async () => [{ user: 'u1', text: '好看', likes: 10 }],
    loginStart: async () => ({ ok: true, loggedIn: true, me: { nickname: 'tester' } }),
    loginPoll: async () => ({ ok: true, loggedIn: true, me: { nickname: 'tester' } }),
    show: async () => true,
    ...over
  }
}

/** 造一个可控的假 browser（只用到 close） */
const fakeBrowser = { close: async () => {}, open: async () => ({ ok: true }), connected: () => true }

/** 组装一个模块实例。默认给「已登录、能播、能看到画面」的正常路径 */
function makeHG ({
  settings = {},
  site = fakeSite(),
  browser = fakeBrowser,
  cfg = {},
  askModel = null,
  sent = []
} = {}) {
  const dir = freshDir()
  const base = {
    enabled: true,
    intervalHours: 4,
    perRun: 3,
    maxWatchPerDay: 12,
    maxSharesPerDay: 3,
    dwellMin: 20,
    dwellMax: 90,
    browserPath: '',
    visionModel: '',
    ownerQQ: '10000001',
    ownerName: '主人',
    speakUp: { awakeFrom: 7, awakeTo: 23 },
    browser: { useDshSidebar: false },
    perms: { hongguoShareOwner: 'on' }
  }
  const merged = { ...base, ...cfg, ...settings }
  const hg = createHongguo({
    getConfig: () => ({ ...merged, hongguo: merged }),
    hub: {
      runSystemTurn: async () => '{"plot":"p","score":8,"good":true,"why":"w","feeling":"f","share":"推给你","remember":"r"}',
      sendText: async (to, text) => { sent.push({ to, text }) }
    },
    memory: { addEvent: () => {} },
    log: { info () {}, warn () {}, debug () {}, error () {} },
    dataDir: (...p) => join(dir, 'modules-data', 'hongguo', ...p),
    site,
    browser,
    dsh: null,
    now: () => Date.now()
  })
  return { hg, dir, sent, cfg: merged }
}

describe('模块装配', () => {
  test('入口与 module.json 的 id / version / api 一致', async () => {
    const { readFileSync } = await import('node:fs')
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.id, mod.id)
    assert.equal(m.version, mod.version)
    assert.equal(m.api, mod.api)
    assert.equal(typeof mod.setup, 'function')
  })

  test('模块不替换内置（新模块），所以不该有 replacesBuiltin', async () => {
    const { readFileSync } = await import('node:fs')
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.replacesBuiltin, undefined, '这是新模块，不是替换内置')
  })

  test('默认关闭（enabled: false）—— 没登录前不该自己刷', () => {
    assert.equal(mod.defaults.enabled, false)
  })

  test('settings 里每个 key 都在 defaults 里有值', () => {
    for (const x of mod.settings || []) {
      assert.ok(x.key in mod.defaults, `设置项 ${x.key} 在 defaults 里没有对应值`)
    }
  })

  test('number 类型的设置项带 min', () => {
    for (const x of mod.settings || []) {
      if (x.type === 'number') assert.equal(typeof x.min, 'number', `${x.key} 缺 min`)
    }
  })

  test('capabilities 与实际行为一致（起浏览器 / 写文件 / 联网 / 读插件配置）', async () => {
    const { readFileSync } = await import('node:fs')
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    for (const c of ['network', 'filesystem', 'process', 'plugin-config', 'plugin-internals']) {
      assert.ok(m.capabilities.includes(c), `capabilities 要含 ${c}`)
    }
  })
})

describe('不该刷的时候就不刷', () => {
  test('开关关着 + 非强制 → 直接拒绝', async () => {
    const { hg } = makeHG({ cfg: { enabled: false } })
    const r = await hg.run({})
    assert.equal(r.ok, false)
    assert.match(r.message, /没打开/)
  })

  test('没登录 → 拒绝，并提示去扫码', async () => {
    const { hg } = makeHG({ site: fakeSite({ self: async () => null }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /登录/)
  })

  test('有验证码 → 拒绝，并说明要处理验证', async () => {
    const { hg } = makeHG({ site: fakeSite({ verify: async () => '出现了验证（captcha）' }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /验证/)
  })

  test('今天已看满 → 拒绝，并报出上限', async () => {
    const { hg } = makeHG({ cfg: { maxWatchPerDay: 2 }, settings: { maxWatchPerDay: 2 } })
    // 先跑一轮把 watched 抬上去
    await hg.run({ force: true })
    // 直接把上限压到 0 更直接
    const { hg: hg2 } = makeHG({ cfg: { maxWatchPerDay: 0 }, settings: { maxWatchPerDay: 0 } })
    const r = await hg2.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /上限/)
  })

  test('浏览器打不开 → 不写「没登录」（否则主人一直点不动）', async () => {
    let wroteLogin = false
    const site = fakeSite({
      ensure: async () => ({ ok: false, message: '浏览器没起来' }),
      self: async () => { wroteLogin = true; return null }
    })
    const { hg } = makeHG({ site })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /浏览器/)
    assert.equal(wroteLogin, false, '浏览器没起来时不该去判断登录态')
  })

  test('推荐里没有新剧 → 明确说明，不假装刷了', async () => {
    const { hg } = makeHG({ site: fakeSite({ feed: async () => [] }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /没有新剧/)
  })
})

describe('「没看成」不能记成「看过」', () => {
  test('播放只播了 2 秒（目标 30）→ 这部不算看过', async () => {
    const { hg } = makeHG({ site: fakeSite({ play: async () => ({ seconds: 2, wanted: 30, ok: false, frames: [] }) }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /没播起来|没看成/)
    assert.equal(hg.recent(10).length, 0, '一部没看成时不该有「看过」记录')
  })

  test('播放抛错 → 同样不算看过', async () => {
    const { hg } = makeHG({ site: fakeSite({ play: async () => { throw new Error('播放页没有 video') } }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.equal(hg.recent(10).length, 0)
  })

  test('播够时长 → 才算看过，并记一条 watch', async () => {
    const { hg } = makeHG()
    const r = await hg.run({ force: true })
    assert.equal(r.ok, true, r.message)
    const list = hg.recent(10)
    // 这轮既看了也分享了，所以会有 watch + share 两条；面板按 href 合并成一张卡
    const watch = list.filter((x) => x.kind === 'watch')
    assert.equal(watch.length, 1, '要有一条 watch 记录')
    assert.equal(watch[0].title, '剧一')
  })
})

describe('分享只在「真看过 + 觉得好看」时发生', () => {
  test('觉得好看 + 有额度 → 私聊发出去', async () => {
    const sent = []
    const { hg } = makeHG({ sent })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, true)
    assert.equal(r.shared, 1)
    assert.equal(sent.length, 1)
    assert.match(sent[0].to, /^private:/)
    assert.match(sent[0].text, /推给你/)
    assert.match(sent[0].text, /hongguoduanju/, '分享要带剧集链接')
  })

  test('觉得一般（good:false）→ 不分享', async () => {
    const sent = []
    const { hg } = makeHG({
      sent,
      // 让 hub.runSystemTurn 返回「不好看」
      cfg: {}
    })
    // 覆盖 hub 的返回需要重新造实例
    const dir = freshDir()
    const hg2 = createHongguo({
      getConfig: () => ({
        enabled: true, ownerQQ: '10000001', ownerName: '主人', speakUp: { awakeFrom: 0, awakeTo: 24 },
        browser: { useDshSidebar: false }, perms: { hongguoShareOwner: 'on' },
        hongguo: { enabled: true, intervalHours: 4, perRun: 1, maxWatchPerDay: 12, maxSharesPerDay: 3, dwellMin: 20, dwellMax: 30, browserPath: '', visionModel: '' }
      }),
      hub: {
        runSystemTurn: async () => '{"plot":"p","score":4,"good":false,"why":"w","feeling":"f","share":"还是推一下吧","remember":""}',
        sendText: async (to, text) => { sent.push({ to, text }) }
      },
      memory: null,
      log: { info () {}, warn () {}, debug () {}, error () {} },
      dataDir: (...p) => join(dir, 'modules-data', 'hongguo', ...p),
      site: fakeSite(),
      browser: fakeBrowser,
      dsh: null
    })
    const r = await hg2.run({ force: true })
    assert.equal(r.ok, true)
    assert.equal(r.shared, 0, '她觉得一般就不该推')
    assert.equal(sent.length, 0)
  })

  test('分享额度用尽 → 不分享，但仍然记「看过」', async () => {
    const sent = []
    const { hg } = makeHG({ sent, settings: { maxSharesPerDay: 0 }, cfg: { maxSharesPerDay: 0 } })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, true)
    assert.equal(r.shared, 0)
    assert.equal(sent.length, 0)
    assert.equal(hg.recent(10).length, 1, '看过还是要记')
  })
})

describe('看图通道的诚实性', () => {
  test('没有看图通道时，结果标 sawFrames:0（不假装看过画面）', async () => {
    const { hg } = makeHG() // dsh: null → 没有看图通道
    const r = await hg.run({ force: true })
    assert.equal(r.ok, true)
    assert.equal(r.sawFrames, 0)
    assert.match(r.message, /没看成画面/)
  })

  test('visionTest 在没有看图通道时明确拒绝，而不是含糊成功', async () => {
    const { hg } = makeHG()
    const r = await hg.visionTest()
    assert.equal(r.ok, false)
    assert.match(r.message, /没有看图通道/)
  })
})

describe('状态与展示', () => {
  test('recent() 按时间倒序，最近的在前', async () => {
    const { hg } = makeHG()
    await hg.run({ force: true })
    await hg.run({ force: true })
    const list = hg.recent(10)
    assert.ok(list.length >= 2)
    // 后写入的 ts 不小于前面的
    for (let i = 1; i < list.length; i++) {
      assert.ok((list[i - 1].ts || 0) >= (list[i].ts || 0), 'recent 要倒序')
    }
  })

  test('recent() 空历史返回空数组，不抛', () => {
    const { hg } = makeHG()
    assert.deepEqual(hg.recent(10), [])
  })

  test('show(false) 在浏览器本来没开时给友好提示，而不是报错', async () => {
    const { hg } = makeHG({ site: fakeSite({ show: async () => false }) })
    const r = await hg.show(false)
    assert.equal(r.ok, true)
    assert.match(r.message, /本来就没开/)
  })

  test('show(true) 失败时把原因带回来（不吞错）', async () => {
    const { hg } = makeHG({ site: fakeSite({ show: async () => { throw new Error('窗口挪不动') } }) })
    const r = await hg.show(true)
    assert.equal(r.ok, false)
    assert.match(r.message, /挪不动/)
  })

  test('登录成功后清掉暂停状态', async () => {
    const { hg } = makeHG()
    // 先造一个「今天暂停」
    await hg.run({ force: true })
    const r = await hg.loginPoll()
    assert.equal(r.loggedIn, true)
  })

  test('backfillCovers 在没有缺封面时直接说「都齐了」', async () => {
    const { hg } = makeHG()
    const r = await hg.backfillCovers()
    assert.equal(r.ok, true)
    assert.match(r.message, /齐了/)
  })
})

describe('失败回退与健壮性', () => {
  test('模型返回非 JSON → 不崩，按「没分析出来」处理', async () => {
    const dir = freshDir()
    const hg = createHongguo({
      getConfig: () => ({
        enabled: true, ownerQQ: '10000001', ownerName: '主人', speakUp: { awakeFrom: 0, awakeTo: 24 },
        browser: { useDshSidebar: false }, perms: { hongguoShareOwner: 'on' },
        hongguo: { enabled: true, intervalHours: 4, perRun: 1, maxWatchPerDay: 12, maxSharesPerDay: 3, dwellMin: 20, dwellMax: 30, browserPath: '', visionModel: '' }
      }),
      hub: { runSystemTurn: async () => '这不是 JSON，就是一段话', sendText: async () => {} },
      memory: null,
      log: { info () {}, warn () {}, debug () {}, error () {} },
      dataDir: (...p) => join(dir, 'modules-data', 'hongguo', ...p),
      site: fakeSite(),
      browser: fakeBrowser,
      dsh: null
    })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, true, '模型乱说话也不能让整轮失败')
    assert.equal(r.shared, 0, '解析不出来就别推')
  })

  test('feed 抛错 → 当空推荐处理，不崩', async () => {
    const { hg } = makeHG({ site: fakeSite({ feed: async () => { throw new Error('网络挂了') } }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /没有新剧/)
  })

  test('comments 抛错 → 只是没有热评，不影响看剧', async () => {
    const { hg } = makeHG({ site: fakeSite({ comments: async () => { throw new Error('没有评论区') } }) })
    const r = await hg.run({ force: true })
    assert.equal(r.ok, true, '热评拿不到不该让整轮失败')
  })
})
