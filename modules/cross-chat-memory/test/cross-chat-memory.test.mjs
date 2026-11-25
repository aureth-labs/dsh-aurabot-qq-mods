// 跨聊天近况模块测试：不打网络、不碰真流水，全部用注入的假 api。
// 覆盖评审要求的四点：跨聊天隔离 / 权限边界 / 默认关闭 / 面板路由。
// 另外补了数据层（过滤、缓存、异步群名）和工具查询。
//
// 跑法：node --test "modules/cross-chat-memory/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { createNearby } from '../lib/nearby.mjs'
import defaultExport from '../index.mjs'

const OWNER = '1215734464'
const NOW = Date.now()
const DAY = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

// 假流水：每一行都是为了验证某个具体规则而放的
const LOG = [
  // 主人私聊里说的私事 —— 任何外人都不能看到
  { chatId: `private:${OWNER}`, who: 'user', uid: OWNER, t: NOW - 60_000, text: '我今天心情不好，别跟人说' },
  // 七海椿的私聊（别人）
  { chatId: 'private:2793067525', who: 'user', uid: '2793067525', t: NOW - 120_000, text: '我今天生日，有点开心' },
  { chatId: 'private:2793067525', who: 'bot', uid: '', t: NOW - 110_000, text: '喔，生日快乐，记得吃面' },
  // 群里的闲聊
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 180_000, text: '谢谢啦，我真的不行了' },
  // 主人本人在群里说的话 —— 也不该进外人上下文
  { chatId: 'group:564730311', who: 'user', uid: OWNER, t: NOW - 170_000, text: '换个浏览器就行，别在那死磕' },
  // 下面几条应该在 collect 阶段就被滤掉
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 160_000, text: '嗯' },
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 150_000, text: '【系统】某某加入了群聊' },
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 140_000, text: '/天气 北京' },
  // 非聊天 id（qzone 之类）
  { chatId: 'qzone:1215734464', who: 'user', uid: OWNER, t: NOW - 130_000, text: '给你说说点了个赞' },
  // 已撤回的
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 125_000, text: '这条被撤回了', forgottenAt: NOW },
]

const DEFAULTS = {
  enabled: true,
  hours: 24,
  quota: 3,
  maxChars: 420,
  minChars: 4,
  ownerSeesPrivate: true,
  shareGroupToGroup: false,
  othersSeeCrossChat: false,
  keepOwnerSecret: true,
}

/** 造一个假 api；settings 可以按测试改。 */
function makeApi(overrides = {}) {
  const settings = { ...DEFAULTS, ...overrides }
  const routes = new Map()
  return {
    config: () => ({ ownerQQ: OWNER }),
    settings: () => ({ ...settings }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    use: (id) => (id === 'memory' ? {
      profiles: () => [{ qq: '2793067525', alias: '七海椿' }, { qq: OWNER, alias: '主人' }],
      personaPerson: async () => ({ alias: '' }),
    } : null),
    core: {
      hub: {
        chatLogOf: (day) => (day === DAY ? LOG : []),
        // 故意返回 Promise，验证异步名字不会被渲染成 [object Promise]
        groupName: async (gid) => (gid === '564730311' ? '螃蟹猪猪养殖场' : ''),
      },
    },
    _settings: settings,
    _routes: routes,
  }
}

const ownerChat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
const friendChat = { kind: 'private', userId: '2793067525', chatId: 'private:2793067525' }
const groupChat = { kind: 'group', groupId: '564730311', chatId: 'group:564730311' }

// ——————————————————————————————————————
// 一、数据层：过滤与渲染
// ——————————————————————————————————————

test('collect 阶段滤掉太短、系统消息、命令、已撤回的', () => {
  const it = createNearby({ api: makeApi() })
  const p = it.preview()
  // 原始 10 条 → collect 滤掉「嗯」「【系统】」「/天气」「已撤回」4 条 → 剩 6 条；
  // 其中 qzone 那条再被 preview 的真实聊天过滤挡掉 → total 5
  assert.equal(p.rawTotal, 6)
  assert.equal(p.total, 5)
  assert.equal(p.chatCount, 3)
  const ids = p.chats.map((c) => c.chatId).sort()
  assert.deepEqual(ids, [`group:564730311`, `private:${OWNER}`, 'private:2793067525'].sort())
})

test('主人私聊：看得到别人的私聊和群，不渲染自己这个聊天', () => {
  const it = createNearby({ api: makeApi() })
  const out = it.build(ownerChat)
  assert.ok(out.length > 0, '应该有输出')
  assert.match(out, /七海椿/, '应该有七海椿')
  assert.match(out, /螃蟹猪猪养殖场|群564730311/, '应该带群')
  assert.ok(!out.includes('我今天心情不好'), '不该渲染自己这个聊天的流水')
  assert.ok(!out.includes('[object Promise]'), '异步群名不能漏出来')
  assert.ok(!out.includes('点赞'), 'qzone 不该进上下文')
  assert.ok(!out.includes('这条被撤回了'), '已撤回了不该进上下文')
  assert.ok(!out.includes('/天气'), '命令不该进上下文')
})

test('模块关掉时 build 返回空串、工具拒绝', () => {
  const it = createNearby({ api: makeApi({ enabled: false }) })
  assert.equal(it.build(ownerChat), '')
  const res = it.recall(ownerChat)
  assert.equal(res.ok, false)
  assert.match(res.message, /关着/)
})

test('别人聊天不自动注入（默认 othersSeeCrossChat=false）', () => {
  const it = createNearby({ api: makeApi() })
  // 别人私聊
  assert.equal(it.build(friendChat), '', '别人私聊不该有输出')
  // 群：也不该有输出（默认不给外人）
  assert.equal(it.build(groupChat), '', '群不该有输出')
})

// ——————————————————————————————————————
// 二、跨聊天隔离：群与群不串
// ——————————————————————————————————————

test('打开 othersSeeCrossChat 后，群里也看不到另一个群的事（shareGroupToGroup 默认关）', () => {
  const api = makeApi({ othersSeeCrossChat: true })
  // 再造一个群，让「一个群看另一个群」成为可观察的场景
  const LOG2 = [...LOG, { chatId: 'group:999888777', who: 'user', uid: '123456', t: NOW - 100_000, text: '另一个群在聊完全无关的事' }]
  api.core.hub.chatLogOf = (day) => (day === DAY ? LOG2 : [])
  const it = createNearby({ api })
  const out = it.build(groupChat)
  assert.ok(!out.includes('另一个群'), '群与群默认不串')
})

test('打开 shareGroupToGroup 后，群与群才互通', () => {
  const api = makeApi({ othersSeeCrossChat: true, shareGroupToGroup: true })
  const LOG2 = [...LOG, { chatId: 'group:999888777', who: 'user', uid: '123456', t: NOW - 100_000, text: '另一个群在聊完全无关的事' }]
  api.core.hub.chatLogOf = (day) => (day === DAY ? LOG2 : [])
  const it = createNearby({ api })
  const out = it.build(groupChat)
  assert.ok(out.includes('另一个群'), '打开后应该能看到')
})

// ——————————————————————————————————————
// 三、权限边界：主人的私事不外传
// ——————————————————————————————————————

test('打开 othersSeeCrossChat 后，别人的私聊看得到群和别人的私聊，但看不到主人的私事', () => {
  const it = createNearby({ api: makeApi({ othersSeeCrossChat: true }) })
  const out = it.build(friendChat)
  assert.ok(out.length > 0, '打开后应该有输出')
  // 主人的两处发言都必须被挡住
  assert.ok(!out.includes('我今天心情不好'), '主人的私聊内容不该出去')
  assert.ok(!out.includes('换个浏览器就行'), '主人本人在群里说的话也不该出去')
  // 别人的内容可以给
  assert.match(out, /我真的不行了|螃蟹猪猪养殖场|群564730311/, '别人的内容应该能看到')
})

test('keepOwnerSecret 关掉时才放开主人的私事', () => {
  const it = createNearby({ api: makeApi({ othersSeeCrossChat: true, keepOwnerSecret: false }) })
  const out = it.build(friendChat)
  assert.ok(out.includes('我今天心情不好') || out.includes('换个浏览器就行'), '关掉保护后应该能看到')
})

test('手动查询：外人被当面问，查得到别人的内容，但主人的私事仍过滤', () => {
  const it = createNearby({ api: makeApi() })
  const res = it.recall(friendChat)
  assert.equal(res.ok, true)
  assert.match(res.message, /我真的不行了/, '别人在群里说的话能查到')
  assert.ok(!res.message.includes('我今天心情不好'), '主人的私聊仍挡住')
  assert.ok(!res.message.includes('换个浏览器就行'), '主人的发言仍挡住')
})

test('手动查询：主人能查到全部', () => {
  const it = createNearby({ api: makeApi() })
  const res = it.recall(ownerChat)
  assert.match(res.message, /七海椿|2793067525/)
  assert.match(res.message, /我真的不行了/)
})

// ——————————————————————————————————————
// 四、入口：默认值与面板路由
// ——————————————————————————————————————

test('入口默认值：权限相关的开关是安全的默认值', () => {
  const d = defaultExport.defaults
  assert.equal(d.enabled, true, '默认应该开')
  assert.equal(d.othersSeeCrossChat, false, '别人那边默认不自动注入')
  assert.equal(d.shareGroupToGroup, false, '群与群默认不串')
  assert.equal(d.keepOwnerSecret, true, '主人私事默认保护')
  assert.equal(d.hours, 24)
  assert.equal(d.quota, 3)
  assert.equal(d.maxChars, 420)
  assert.equal(d.minChars, 4)
})

test('入口 id / version / api 和 module.json 一致', () => {
  const m = defaultExport
  assert.equal(m.id, 'cross-chat-memory')
  assert.equal(m.api, 1)
  assert.equal(typeof m.setup, 'function')
  assert.equal(typeof m.version, 'string')
  assert.match(m.version, /^\d+\.\d+\.\d+$/)
})

test('面板路由：/preview 给出统计，/clear-cache 清缓存', async () => {
  const api = makeApi()
  const routes = new Map()
  const toolFns = []
  const contexts = []
  // 造一个最小 api：只实现 setup 会用到的那几项
  const full = {
    ...api,
    context: (fn) => contexts.push(fn),
    tool: (fn) => toolFns.push(fn),
    route: (path, fn) => routes.set(path, fn),
    later: (ms, fn) => { /* 测试里不真的等 */ },
    every: (ms, fn) => { /* 测试里不真的跑 */ },
    log: api.log,
    defineTool: (t) => t,
  }
  defaultExport.setup(full)

  assert.ok(routes.has('/preview'), '要有 /preview 路由')
  assert.ok(routes.has('/clear-cache'), '要有 /clear-cache 路由')

  const preview = await routes.get('/preview')()
  assert.equal(preview.ok, true)
  assert.ok(Array.isArray(preview.chats))
  assert.equal(preview.chatCount, 3)
  assert.ok(preview.settings, '要带当前设置')

  const cleared = await routes.get('/clear-cache')()
  assert.equal(cleared.ok, true)

  assert.equal(contexts.length, 1, '要注册一个 context')
  assert.equal(toolFns.length, 1, '要注册一个 tool')
})

test('工具 cross_chat_recall 有正确名字与参数', () => {
  const api = makeApi()
  const toolFns = []
  const full = {
    ...api,
    context: () => {},
    tool: (fn) => toolFns.push(fn),
    route: () => {},
    later: () => {},
    every: () => {},
    defineTool: (t) => t,
  }
  defaultExport.setup(full)
  const tool = toolFns[0]({ chat: ownerChat })
  assert.equal(tool.name, 'cross_chat_recall')
  assert.ok(tool.properties.hours)
  assert.ok(tool.properties.chat)
  assert.equal(typeof tool.execute, 'function')
})

// ——————————————————————————————————————
// 五、异步名字：不能渲染出 [object Promise]
// ——————————————————————————————————————

test('第一轮可能还是群号，等一拍后换成真名', async () => {
  const it = createNearby({ api: makeApi() })
  it.clearCache()
  it.build(ownerChat) // 触发异步拉名字
  await new Promise((r) => setTimeout(r, 80))
  const out2 = it.build(ownerChat)
  assert.match(out2, /螃蟹猪猪养殖场/, '群名应该换成了真名')
  assert.match(out2, /七海椿/, '人名应该换成了真名')
})

// ——————————————————————————————————————
// 六、缓存与截断
// ——————————————————————————————————————

test('60 秒内重复调用不重复读盘', () => {
  let calls = 0
  const api = makeApi()
  const raw = api.core.hub.chatLogOf
  api.core.hub.chatLogOf = (d) => { calls++; return raw(d) }
  const it = createNearby({ api })
  it.build(ownerChat)
  const after1 = calls
  it.build(ownerChat)
  it.build(ownerChat)
  assert.equal(calls, after1, '缓存期内不该再读盘')
})

test('maxChars 截断生效', () => {
  const it = createNearby({ api: makeApi({ maxChars: 80 }) })
  const out = it.build(ownerChat)
  // 头部说明本身就有几十个字，正文再被截到 80 以内，整体不会太长
  assert.ok(out.length < 300, `截断后不该太长，实际 ${out.length}`)
})
