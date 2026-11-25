// 模块本体（index.mjs）的集成测试：行为都走真的 axios 之外的逻辑 ——
// 用一个最小的假 api 把 setup() 跑起来，验证讨饭冷却、记账审批链路、道谢、印象卡片联动。
// 不联网、不上 QQ、不依赖 impression-card 的代码（联动只认它的 adjust 导出）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

const OWNER = '10000001'
const STRANGER = '90000009'
const GROUP = '700001'

/** 一个够用的假 Aurabot api：设置、命令、事件、工具、路由、发送都记在数组里。 */
function makeApi (opts = {}) {
  const sent = []
  const commands = new Map()
  const listeners = new Map()
  const routes = new Map()
  const tools = []
  const dir = opts.dir || mkdtempSync(join(tmpdir(), 'beg-module-'))
  const settings = { ...(plugin.defaults), ...(opts.settings || {}) }
  const ext = opts.ext || {}
  // 宿主全局配置：测试里可以改（试运行 / 总开关）。
  const config = { ownerQQ: OWNER, enabled: true, dryRun: false, ...(opts.config || {}) }
  const api = {
    id: 'beg-for-money',
    dir,
    log: { debug () {}, info () {}, warn () {}, error () {} },
    config: () => ({ ...config }),
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    dataDir: (...parts) => {
      const base = join(dir, 'data')
      mkdirSync(base, { recursive: true })
      return join(base, ...parts)
    },
    use: (id) => (id === 'impression-card' ? (ext['impression-card'] || null) : null),
    command: (c) => { commands.set(c.name, c); for (const a of c.aliases || []) commands.set(a, c); return () => {} },
    on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); return () => {} },
    tool: (fn) => { tools.push(fn); return () => {} },
    // 宿主提供的工具构造函数：这里原样返回，行为由 execute 自己保证
    defineTool: (spec) => ({ ...spec }),
    rule: () => () => {},
    route: (path, handler) => { routes.set(path, handler); return () => {} },
    onDispose: () => () => {},
    isOwner: (uid) => String(uid) === OWNER,
    sendText: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 'm' + sent.length } },
    sendImage: async (chatId, file) => { sent.push({ chatId, image: file }); return { message_id: 'i' + sent.length } },
    reply: async (msg, text) => { sent.push({ chatId: msg.chatId, text, replyTo: msg.userId }); return { message_id: 'r' + sent.length } },
    // 道谢现在走 api.ask（不建会话）；think 留着，用来断言我们没再用它
    ask: async () => '谢谢老板，收到了～',
    think: async () => { throw new Error('道谢不该用 api.think：那会在 DSH 里新建会话') },
    core: {
      // 路由测试：把请求体 / query 挂在假 req 上，模拟 api.core.http.body / query。
      http: { body: async (req) => (req && req.__body) || {}, query: (req) => (req && req.__query) || {} },
      personas: { current: () => '你是大肥鱼。' },
    },
  }
  return { api, sent, commands, listeners, routes, tools, dir, config }
}

function emit (listeners, name, ...args) {
  return Promise.all((listeners.get(name) || []).map((fn) => fn(...args)))
}

function messages (msg) {
  return {
    chatId: 'group:' + GROUP,
    groupId: GROUP,
    userId: STRANGER,
    nickname: '路人甲',
    messageId: 'm1',
    ...msg,
  }
}

async function until (fn, ms = 3000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('等不到条件成立')
}

/** 管理员私聊确认最近一条待确认（走导出的 resolveApproval，等价于 /确认）。 */
async function commandsConfirm (mod) {
  return mod.resolveApproval('', true)
}

test('不写宿主不认的 group / __panelGroup；落点由宿主导航决定（系统组）', () => {
  // 宿主 client 的 navGroupOf 只认 tab id 和名字里的平台关键词，不读 def.group / defaults.__panelGroup；
  // 本模块会落到「系统」组。不要为了让 README 好看而声明没人读的字段。
  assert.equal(plugin.group, undefined)
  assert.equal(plugin.defaults.__panelGroup, undefined)
  assert.equal(plugin.tab, undefined)
})

test('setup 注册命令、工具、事件和接口', async () => {
  const { api, commands, tools, listeners, routes, dir } = makeApi()
  try {
    const mod = await plugin.setup(api, {})
    for (const name of ['讨饭', '已打钱', '打赏', '收款', '待确认', '确认', '不记']) assert.ok(commands.has(name), name)
    assert.ok(listeners.has('message'))
    assert.ok(listeners.has('activity'))
    assert.ok(routes.has('/state'))
    assert.ok(routes.has('/approve'))
    assert.equal(typeof mod.recordPayment, 'function')
    assert.equal(mod.status().accounts, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没配收款码时 /讨饭 直接说明发不了，不发图', async () => {
  const { api, commands, sent, dir } = makeApi({ settings: { qrImagePath: '' } })
  try {
    await plugin.setup(api, {})
    const text = await commands.get('讨饭').run('', messages({}))
    assert.match(text, /还没配置收款码/)
    assert.equal(sent.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('绝对路径（含空格、带引号）也能用', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'beg-abs-'))
  const file = join(outside, 'my qr.png')
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  for (const qrImagePath of [file, '"' + file + '"', '  ' + file + '  ']) {
    const { api, commands, sent, dir } = makeApi({ settings: { qrImagePath } })
    try {
      await plugin.setup(api, {})
      const text = await commands.get('讨饭').run('', messages({}))
      assert.match(text, /收款码发出去了/, '路径 ' + JSON.stringify(qrImagePath) + ' 应该能用')
      assert.equal(sent.filter((s) => s.image)[0].image, file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  rmSync(outside, { recursive: true, force: true })
})

test('多张收款码：一行一个，按顺序轮着发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-multi-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(dir, 'assets', 'wechat.png'), png)
  writeFileSync(join(dir, 'assets', 'alipay.png'), png)
  const { api, commands, sent } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/wechat.png\nassets/alipay.png', cooldownSeconds: 0, dailyLimit: 0 },
  })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    for (let i = 0; i < 4; i++) await commands.get('讨饭').run('', messages({}))
    const images = sent.filter((s) => s.image).map((s) => s.image.split(/[\\/]/).pop())
    assert.deepEqual(images, ['wechat.png', 'alipay.png', 'wechat.png', 'alipay.png'], '两张轮着发')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多张里坏了一张：好的照样发，并说明有几张找不到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-partial-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'ok.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent, routes } = makeApi({ dir, settings: { qrImagePath: 'assets/ok.png\nassets/missing.png' } })
  try {
    await plugin.setup(api, {})
    const text = await commands.get('讨饭').run('', messages({}))
    assert.match(text, /收款码发出去了/)
    assert.match(text, /另有 1 张找不到/)
    assert.equal(sent.filter((s) => s.image).length, 1)
    const state = await routes.get('/state')()
    assert.equal(state.qr.count, 1)
    assert.equal(state.qr.missing.length, 1)
    assert.match(state.qr.missing[0], /missing\.png/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全部收款码都找不到 / 只填了空行：明确失败，不发图', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-none-'))
  for (const qrImagePath of ['assets/nope.png', '', '\n  \n']) {
    const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath } })
    await plugin.setup(api, {})
    const text = await commands.get('讨饭').run('', messages({}))
    assert.match(text, /还没配置收款码|收款码图片找不到/)
    assert.equal(sent.filter((s) => s.image).length, 0)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('收款码可用时发图并开道谢窗口；冷却期内第二次不再发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-qr-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(dir, 'assets', 'qr.png'), png)
  const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', cooldownSeconds: 600 } })
  try {
    await plugin.setup(api, {})
    const first = await commands.get('讨饭').run('', messages({}))
    assert.match(first, /收款码发出去了/)
    assert.equal(sent.filter((s) => s.image).length, 1)
    assert.ok(sent[0].image.endsWith('qr.png'))

    const second = await commands.get('讨饭').run('', messages({}))
    assert.match(second, /刚伸过手了/)
    assert.equal(sent.filter((s) => s.image).length, 1, '冷却期内不该再发')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('群友 /打赏：挂成待确认 + 私聊管理员；验证后确认才落账、道谢、加「慷慨」', async () => {
  const adjustCalls = []
  const card = {
    adjust: async (personId, dimension, delta, opts) => {
      adjustCalls.push({ personId, dimension, delta, opts })
      return { ok: true, label: '慷慨', delta, oldValue: 5, newValue: 5 + delta }
    },
  }
  const nowValue = { t: 1_700_000_000_000 }
  const dir = mkdtempSync(join(tmpdir(), 'beg-flow-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, adminQQ: '20000002' },
    ext: { 'impression-card': card },
  })
  try {
    const mod = await plugin.setup(api, { now: () => nowValue.t })
    // 开道谢窗口
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0

    const reply = await commands.get('打赏').run('15 谢谢款待', messages({}))
    assert.match(reply, /已经报给管理员了/)
    assert.match(reply, /编号 1/)
    assert.equal(mod.status().accounts, 0, '还没确认，账本里不该有')

    // 管理员私聊收到确认请求
    const dm = sent.filter((s) => s.chatId === 'private:20000002')
    assert.equal(dm.length, 1)
    assert.match(dm[0].text, /记账确认 #1/)
    assert.match(dm[0].text, /说打了 15\.00元/)
    assert.match(dm[0].text, /\/确认 1/)
    assert.doesNotMatch(dm[0].text, /\/拒绝/, 'QQ 会把「拒绝」转成表情')

    // 管理员确认
    const ok = await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(ok, /记上了 #1/)
    assert.match(ok, /已在群里道谢/)
    assert.match(ok, /印象卡片「慷慨」\+1/)
    assert.equal(mod.status().accounts, 1)
    // 道谢发回原群，不是管理员私聊
    const thanks = sent.filter((s) => s.chatId === 'group:' + GROUP && /谢谢老板/.test(s.text || ''))
    assert.equal(thanks.length, 1)
    // 联动给打赏的人加「慷慨」
    assert.equal(adjustCalls.length, 1)
    assert.equal(adjustCalls[0].personId, 'qq:' + STRANGER)
    assert.equal(adjustCalls[0].dimension, 'generosity')
    assert.equal(adjustCalls[0].delta, 1)
    assert.equal(adjustCalls[0].opts.notify, false)
    // 待确认清空
    assert.equal(mod.pending().length, 0)
    // 再确认一次就找不到了
    const again = await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(again, /找不到编号 1/)
    assert.equal(mod.status().accounts, 1, '不能重复记账')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('印象卡片没装：确认记账照常，只是不加分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-nocard-'))
  const { api, commands, sent } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('9', messages({}))
    sent.length = 0
    const ok = await commands.get('确认').run('', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(ok, /记上了 #1/)
    assert.doesNotMatch(ok, /慷慨/)
    assert.equal(mod.status().accounts, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('印象卡片的 adjust 抛错：记账不失败', async () => {
  const card = { adjust: async () => { throw new Error('印象卡片内部炸了') } }
  const dir = mkdtempSync(join(tmpdir(), 'beg-carderr-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' }, ext: { 'impression-card': card } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('9', messages({}))
    const ok = await commands.get('确认').run('', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(ok, /记上了 #1/)
    assert.equal(mod.status().accounts, 1, '联动失败不能让记账回滚')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/不记 丢弃这笔，不落账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-reject-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('12', messages({}))
    const text = await commands.get('不记').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(text, /不记了/)
    assert.equal(mod.status().accounts, 0)
    assert.equal(mod.pending().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('管理员自己记账直接生效，不走审批', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-admin-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    const text = await commands.get('打赏').run('30', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(text, /记下了 30\.00元/)
    assert.equal(mod.status().accounts, 1)
    assert.equal(mod.pending().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('金额非法：负数 / NaN / 超上限 都拒绝，不写账本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-amount-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    const owner = { chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }
    assert.match(await commands.get('打赏').run('-5', messages(owner)), /金额要写成数字/)
    assert.match(await commands.get('打赏').run('abc', messages(owner)), /金额要写成数字/)
    assert.match(await commands.get('打赏').run('0', messages(owner)), /大于 0/)
    assert.match(await commands.get('打赏').run('999999', messages(owner)), /金额太大了/)
    assert.equal(mod.status().accounts, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一聊天报批节流：30 秒内只报一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-throttle-'))
  const { api, commands, sent } = makeApi({ dir, settings: { adminQQ: '20000002', approvalThrottleSeconds: 30 } })
  try {
    const clock = { t: 1_700_000_000_000 }
    const mod = await plugin.setup(api, { now: () => clock.t })
    const first = await commands.get('打赏').run('5', messages({}))
    assert.match(first, /已经报给管理员了/)
    const second = await commands.get('打赏').run('6', messages({}))
    assert.match(second, /刚报过一笔/)
    clock.t += 31_000
    const third = await commands.get('打赏').run('7', messages({}))
    assert.match(third, /已经报给管理员了/)
    assert.equal(mod.pending().length, 2)
    assert.equal(sent.filter((s) => s.chatId === 'private:20000002').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('待确认记录过期后 /确认 找不到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-expire-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002', approvalTimeoutSeconds: 600 } })
  try {
    const clock = { t: 1_700_000_000_000 }
    const mod = await plugin.setup(api, { now: () => clock.t })
    await commands.get('打赏').run('5', messages({}))
    clock.t += 601_000
    const text = await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(text, /找不到编号 1/)
    assert.equal(mod.status().accounts, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/待确认 只在私聊给管理员看', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-pending-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('5', messages({}))
    const inGroup = await commands.get('待确认').run('', messages({ chatId: 'group:' + GROUP, userId: OWNER, groupId: GROUP }))
    assert.match(inGroup, /私聊查/)
    const byStranger = await commands.get('待确认').run('', messages({ chatId: 'private:' + STRANGER, userId: STRANGER, groupId: '' }))
    assert.match(byStranger, /只有管理员/)
    const list = await commands.get('待确认').run('', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(list, /#1/)
    assert.match(list, /路人甲/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('群友发 /打卡 不当成命令；/讨饭 会被接管并回一句', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-claim-'))
  const { api, listeners, sent } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    const notOurs = await emit(listeners, 'message', messages({ text: '/打卡' }))
    assert.equal(notOurs[0], false, '不相关的 / 命令不接管')
    const plain = await emit(listeners, 'message', messages({ text: '今天天气不错' }))
    assert.equal(plain[0], false)
    const ours = await emit(listeners, 'message', messages({ text: '/讨饭' }))
    assert.equal(ours[0], true, '讨饭命令要接管')
    assert.ok(sent.some((s) => /收款码/.test(s.text || '')), '回一句说明')
    // 主人的命令同样被吞掉，避免她对命令本身回话
    const ownerCmd = await emit(listeners, 'message', messages({ text: '/打赏 5', userId: OWNER, chatId: 'private:' + OWNER, groupId: '' }))
    assert.equal(ownerCmd[0], true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('道谢不会把 <img src="emoj表情:偷乐"/> 原样发出去', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-emoji-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  // 模型真的会写出这种 HTML（用户实测）
  const spits = [
    '谢啦，钱收到了，还挺会挑时候 <img src="emoj表情:偷乐"/>',
    '收到啦<img src="emoj表情：偷笑">谢谢你',
    '谢谢老板 <img src="emoj:偷乐"/>',
  ]
  const expected = [
    '谢啦，钱收到了，还挺会挑时候 <face:偷乐>',
    '收到啦 <face:偷笑>谢谢你',
    '谢谢老板 <face:偷乐>',
  ]
  for (let i = 0; i < spits.length; i++) {
    const { api, commands, sent } = makeApi({
      dir,
      settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 0, adminQQ: '20000002' },
    })
    try {
      await plugin.setup(api, { now: () => 1_700_000_000_000 + i })
      await commands.get('打赏').run('10', messages({}))
      sent.length = 0
      // 直接确认：确认后的道谢走生成
      api.ask = async () => spits[i]
      await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
      const said = sent.filter((s) => s.chatId === 'group:' + GROUP && s.text).map((s) => s.text)
      assert.ok(said.length, '应该有道谢')
      assert.equal(said[0], expected[i])
      assert.doesNotMatch(said[0], /<img|emoj/, '不能把 HTML 标签原样发出去')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('道谢清理：其它 HTML / markdown 图片 / 用不了的格式标签都去掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-clean-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('10', messages({}))
    sent.length = 0
    api.ask = async () => '<b>谢谢</b> ![偷乐](http://x/y.png) <sticker:开心> <poke> 老板 <face:偷笑>'
    await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    const said = sent.find((s) => s.chatId === 'group:' + GROUP && s.text).text
    // HTML 标签去掉、markdown 图片去掉、<sticker:> 和 <poke> 去掉（sendText 不解析它们），
    // <face:> 留着（中枢会换成 QQ 小黄脸）
    assert.equal(said, '谢谢 老板 <face:偷笑>')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('道谢不建新会话：走 api.ask，不碰 api.think', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-nosession-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  let asked = 0
  const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', adminQQ: '20000002' } })
  const realAsk = api.ask
  api.ask = async (opts) => { asked++; api.lastAsk = opts; return realAsk(opts) }
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('10', messages({}))
    sent.length = 0
    await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.equal(asked, 1, '道谢应该问一次 api.ask')
    assert.match(api.lastAsk.system, /大肥鱼/, '人格要带进 system')
    assert.ok(sent.some((s) => s.chatId === 'group:' + GROUP), '道谢照常发到群里')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('道谢窗口内有人说了「转了」：自动道谢一次，不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-thanks-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent, listeners } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, text: '我转了' })
    await until(() => sent.some((s) => /谢谢老板/.test(s.text || '')))
    const count = sent.filter((s) => /谢谢老板/.test(s.text || '')).length
    assert.equal(count, 1)
    // 第二条「打了」不会再来一遍
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, text: '打了打了' })
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(sent.filter((s) => /谢谢老板/.test(s.text || '')).length, 1, '窗口只该触发一次')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('窗口内的「转了」也走 message 检查，但这条消息不被接管', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-msgthanks-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='.replace('ERWeA', 'ERWeA'), 'base64'))
  const { api, commands, sent, listeners } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0
    const claimed = await emit(listeners, 'message', messages({ text: '我转了15' }))
    assert.equal(claimed[0], false, '这句要留给她正常回话，不能吞掉')
    await until(() => sent.some((s) => /谢谢老板/.test(s.text || '')))
    assert.equal(sent.filter((s) => /谢谢老板/.test(s.text || '')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('道谢问模型时把场景说清楚，不发「写一句吧」这种空指令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-prompt-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', adminQQ: '20000002' } })
  const calls = []
  api.ask = async (opts) => { calls.push(opts); return '谢谢老板，收到了～' }
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('15', messages({}))
    sent.length = 0
    await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.equal(calls.length, 1)
    const { system, text } = calls[0]
    // 模型必须知道「发生了什么」：谁、多少钱
    assert.match(text, /路人甲/, '用户消息里要有人名')
    assert.match(text, /15\.00元/, '用户消息里要有金额')
    assert.match(text, /谢谢|道谢/, '用户消息要说清楚是来道谢的')
    // 不能是那句让模型反问「写啥啊」的空指令
    assert.doesNotMatch(text, /^写一句吧。?$/)
    assert.match(system, /不要反问/, 'system 里明确禁止反问')
    assert.match(system, /大肥鱼/, '人格要带进去')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('模型反问了（写啥啊，你倒是给个题）：改用兜底文案，不把反问发出去', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-nonanswer-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const bad = ['写啥啊，你倒是给个题。', '写什么啊，今儿天凉了，我刚把窗关上', '你想让我说什么？', '给个题吧', '不知道该说什么好']
  for (let i = 0; i < bad.length; i++) {
    const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', adminQQ: '20000002', thankFallbackText: '谢谢你呀，收到了。' } })
    try {
      await plugin.setup(api, { now: () => 1_700_000_000_000 + i })
      await commands.get('打赏').run('5', messages({}))
      sent.length = 0
      api.ask = async () => bad[i]
      await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
      const said = sent.find((s) => s.chatId === 'group:' + GROUP && s.text).text
      assert.equal(said, '谢谢你呀，收到了。', '「' + bad[i] + '」不该发到群里')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('真的道谢照样发出去（别把正常的一句「谢谢」误当成反问）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-goodthanks-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const good = ['谢啦，钱收到了，还挺会挑时候', '谢谢老板～', '哎哟，你倒是挺大方，谢啦']
  for (let i = 0; i < good.length; i++) {
    const { api, commands, sent } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', adminQQ: '20000002' } })
    try {
      await plugin.setup(api, { now: () => 1_700_000_000_000 + i })
      await commands.get('打赏').run('5', messages({}))
      sent.length = 0
      api.ask = async () => good[i]
      await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
      const said = sent.find((s) => s.chatId === 'group:' + GROUP && s.text).text
      assert.equal(said, good[i])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('否定句不会触发道谢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-nothanks-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent, listeners } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, text: '我没打，别瞎说' })
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(sent.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('道谢窗口关闭时不自动道谢，/已打钱 明确说关着', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-windowoff-'))
  const { api, commands, sent, listeners } = makeApi({ dir, settings: { thanksWindowSeconds: 0, adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, text: '我转了' })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(sent.length, 0)
    const text = await commands.get('已打钱').run('', messages({}))
    assert.match(text, /自动道谢关着/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/收款 汇总 + 今日；管理员私聊里能看到明细', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-view-'))
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    const owner = { chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }
    await commands.get('打赏').run('15 早饭', messages(owner))
    await commands.get('打赏').run('7.5', messages(owner))
    const today = await commands.get('收款').run('今天', messages(owner))
    assert.match(today, /2 笔，共 22\.50元/)
    assert.match(today, /早饭/)
    const all = await commands.get('收款').run('全部', messages(owner))
    assert.match(all, /累计 22\.50元/)
    const bad = await commands.get('收款').run('胡说', messages(owner))
    assert.match(bad, /看不懂/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adminOnly 开着：群里查账只让私聊，群友用命令被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-adminonly-'))
  const { api, commands, listeners, sent } = makeApi({ dir, settings: { adminQQ: '20000002', adminOnly: true } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    // 主人在群里查账：回「私聊查」
    const inGroup = await commands.get('收款').run('今天', messages({ chatId: 'group:' + GROUP, userId: OWNER, groupId: GROUP }))
    assert.match(inGroup, /私聊查/)
    // 群友 /讨饭：被拒
    sent.length = 0
    await emit(listeners, 'message', messages({ text: '/讨饭' }))
    assert.ok(sent.some((s) => /只有管理员/.test(s.text || '')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具：record_payment 在群里按非管理员走审批；check_ledger 只在主人私聊出现', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-tools-'))
  const { api, tools, sent } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const clock = { t: 1_700_000_000_000 }
    const mod = await plugin.setup(api, { now: () => clock.t })
    const groupTools = tools[0]({ chat: { chatId: 'group:' + GROUP, kind: 'group', groupId: GROUP }, level: 'social', sessionId: 's' })
    assert.deepEqual(groupTools.map((t) => t.name).sort(), ['beg_for_money', 'record_payment'])
    const rec = groupTools.find((t) => t.name === 'record_payment')
    const out = await rec.execute({ amount: 8 }, {})
    assert.equal(out.ok, true)
    assert.match(out.message, /等管理员确认|已经报给管理员了/)
    assert.equal(mod.status().accounts, 0)
    assert.equal(sent.filter((s) => s.chatId === 'private:20000002').length, 1)
    // 模型塞进来的身份字段一律不看：工具只认宿主给的会话
    clock.t += 60_000
    const forged = await rec.execute({ amount: 9, user_id: OWNER, nickname: '主人' }, {})
    assert.equal(forged.ok, true)
    assert.equal(mod.status().accounts, 0, '伪造身份不能绕过审批')

    const ownerTools = tools[0]({ chat: { chatId: 'private:' + OWNER, kind: 'private', userId: OWNER }, level: 'full', sessionId: 's' })
    assert.ok(ownerTools.some((t) => t.name === 'check_ledger'))
    const check = ownerTools.find((t) => t.name === 'check_ledger')
    const view = await check.execute({ scope: '全部' }, {})
    assert.equal(view.ok, true)
    assert.match(view.message, /账本还是空的/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('关掉总开关后工具不再挂，命令回「已关闭」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-off-'))
  const { api, commands, tools } = makeApi({ dir, settings: { enabled: false, adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    assert.deepEqual(tools[0]({ chat: { chatId: 'group:1', kind: 'group', groupId: '1' }, level: 'social', sessionId: 's' }), [])
    const text = await commands.get('讨饭').run('', messages({}))
    assert.match(text, /已关闭/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具：群聊里记「打赏人」用最近说话的人（来自 activity，不采信模型参数）', async () => {
  const adjustCalls = []
  const card = { adjust: async (personId, dimension, delta) => { adjustCalls.push({ personId, dimension, delta }); return { ok: true, label: '慷慨', delta } } }
  const dir = mkdtempSync(join(tmpdir(), 'beg-payer-'))
  const { api, tools, listeners } = makeApi({ dir, settings: { adminQQ: '20000002' }, ext: { 'impression-card': card } })
  try {
    const clock = { t: 1_700_000_000_000 }
    const mod = await plugin.setup(api, { now: () => clock.t })
    // 群里有个人刚说过话
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, nickname: '路人甲', text: '大家好' })
    const groupTools = tools[0]({ chat: { chatId: 'group:' + GROUP, kind: 'group', groupId: GROUP }, level: 'social', sessionId: 's' })
    const rec = groupTools.find((t) => t.name === 'record_payment')
    // 模型胡编一个别人的 QQ，不该被采用
    await rec.execute({ amount: 20, user_id: '11111111', nickname: '别人' }, {})
    const pending = mod.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].payer, STRANGER, '打赏人要是刚说话那个人，不是模型编的')
    assert.equal(pending[0].payerName, '路人甲')

    await commandsConfirm(mod)
    assert.equal(adjustCalls.length, 1)
    assert.equal(adjustCalls[0].personId, 'qq:' + STRANGER, '「慷慨」加到真正说话的人头上')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/state 接口：数字、二维码状态、待确认、账本行都对得上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-state-'))
  const { api, commands, routes } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    const owner = { chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }
    await commands.get('打赏').run('15 早饭', messages(owner))
    const state = await routes.get('/state')()
    assert.equal(state.ok, true)
    assert.equal(state.accounts, 1)
    assert.equal(state.grandTotal, 15)
    assert.equal(state.today.count, 1)
    assert.equal(state.qr.available, false)
    assert.equal(state.rows.length, 1)
    assert.equal(state.rows[0].note, '早饭')
    assert.equal(state.linkImpressionCard, true)
    assert.equal(state.impressionCard, false)

    // 空账本状态必须是 0 而不是 NaN
    const emptyDir = mkdtempSync(join(tmpdir(), 'beg-state2-'))
    const second = makeApi({ dir: emptyDir, settings: {} })
    await plugin.setup(second.api, { now: () => 1_700_000_000_000 })
    const empty = await second.routes.get('/state')()
    assert.equal(empty.grandTotal, 0)
    assert.equal(empty.today.total, 0)
    assert.equal(empty.rows.length, 0)
    assert.deepEqual(empty.approvals, [])
    rmSync(emptyDir, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 面板路由的假请求：默认同源 + 本机回环。 */
const SAME_HEADERS = { host: '127.0.0.1:5099', origin: 'http://127.0.0.1:5099', 'sec-fetch-site': 'same-origin' }
function panelReq (method, body, extra = {}) {
  return {
    method,
    __body: body || {},
    __query: extra.query || {},
    headers: { ...SAME_HEADERS, ...(extra.headers || {}) },
    socket: { remoteAddress: extra.remoteAddress || '127.0.0.1' },
  }
}

test('面板写接口只收 POST；/approve 必须显式 id 和 true/false；跨站 / 非本机一律拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-route-'))
  const { api, commands, routes } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('15', messages({}))
    assert.equal(mod.pending().length, 1)
    const approve = routes.get('/approve')
    const beg = routes.get('/beg')
    const stateRoute = routes.get('/state')

    const getApprove = await approve(panelReq('GET', { id: '1', approve: true }))
    assert.equal(getApprove.ok, false)
    assert.match(getApprove.message, /POST/)
    assert.equal(mod.pending().length, 1, 'GET 不能动待确认')

    const noId = await approve(panelReq('POST', { approve: true }))
    assert.equal(noId.ok, false)
    assert.match(noId.message, /编号/)
    assert.equal(mod.pending().length, 1, '不填编号不能确认最近一条')

    const noFlag = await approve(panelReq('POST', { id: '1' }))
    assert.equal(noFlag.ok, false)
    assert.match(noFlag.message, /true|false/)
    assert.equal(mod.pending().length, 1, '少传 approve 不能当批准')

    const stringFlag = await approve(panelReq('POST', { id: '1', approve: 'true' }))
    assert.equal(stringFlag.ok, false)
    assert.equal(mod.pending().length, 1, '字符串 "true" 不是合法布尔')

    const getBeg = await beg(panelReq('GET', {}))
    assert.equal(getBeg.ok, false)
    assert.match(getBeg.message, /POST/)

    const crossState = await stateRoute(panelReq('GET', {}, { headers: { 'sec-fetch-site': 'cross-site' } }))
    assert.equal(crossState.ok, false)
    assert.match(crossState.message, /跨站/)
    const crossBeg = await beg(panelReq('POST', {}, { headers: { 'sec-fetch-site': 'cross-site' } }))
    assert.equal(crossBeg.ok, false)
    const badOrigin = await stateRoute(panelReq('GET', {}, { headers: { origin: 'http://evil.example' } }))
    assert.equal(badOrigin.ok, false)
    assert.match(badOrigin.message, /跨站/)
    const remote = await stateRoute(panelReq('GET', {}, { remoteAddress: '10.0.0.5' }))
    assert.equal(remote.ok, false)
    assert.match(remote.message, /本机/)
    // DNS rebinding：Origin 与 Host 相同，但 Host 是攻击者域名，必须被 Host 白名单拒绝
    const rebind = await stateRoute(panelReq('GET', {}, { headers: { host: 'evil.example', origin: 'http://evil.example' } }))
    assert.equal(rebind.ok, false)
    assert.match(rebind.message, /rebinding|Host/)
    const rebindLedger = await routes.get('/ledger')(panelReq('POST', { scope: '今天' }, { headers: { host: 'evil.example', origin: 'http://evil.example' } }))
    assert.equal(rebindLedger.ok, false)

    const state = await stateRoute(panelReq('GET'))
    assert.equal(state.ok, true)
    const rejected = await approve(panelReq('POST', { id: '1', approve: false }))
    assert.equal(rejected.ok, true)
    assert.equal(mod.pending().length, 0)
    assert.equal(mod.status().accounts, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/state 和 /ledger 不返回管理员 QQ、原始打赏人 QQ、绝对路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-mask-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, routes } = makeApi({ dir, settings: { qrImagePath: 'assets/qr.png', adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('15', messages({}))
    const direct = await mod.recordPayment({ amount: 5, note: '无昵称', chatId: 'group:' + GROUP, groupId: GROUP, payer: '30000003', payerName: '', source: '测试', byAdmin: true })
    assert.equal(direct.ok, true)
    const beg = await routes.get('/beg')(panelReq('POST', {}))
    assert.equal(beg.ok, true, beg.message)

    const state = await routes.get('/state')(panelReq('GET'))
    assert.ok(state.admins.length >= 2)
    for (const admin of state.admins) {
      assert.equal(/^\d+$/.test(admin), false, '管理员 QQ 不能原样返回')
      assert.match(admin, /^\*{4}\d{4}$/)
    }
    assert.ok(!state.admins.includes('20000002'))
    assert.ok(!state.admins.includes(OWNER))
    assert.equal(state.ledgerFile, 'ledger.json')
    assert.equal(state.approvalsFile, 'approvals.json')
    assert.ok(!state.ledgerFile.includes('/') && !state.ledgerFile.includes('\\'))
    assert.equal(state.qr.items.length, 1)
    assert.equal(state.qr.items[0].path, 'assets/qr.png')
    assert.equal(state.qr.items[0].file, undefined, '解析出的绝对路径不能进响应')
    const pending = state.approvals.find((a) => a.id === '1')
    assert.equal(pending.payer, '****0009')
    assert.doesNotMatch(JSON.stringify(state.approvals), /90000009|30000003/, '待确认里的 requester / payer 不能出现原始 QQ')
    assert.ok(state.pendingThanks.length >= 1)
    for (const key of state.pendingThanks) assert.doesNotMatch(key, /private:\d{5,12}$/, 'pendingThanks 的私聊 QQ 必须脱敏')
    const row = state.rows.find((r) => r.amount === 5)
    assert.equal(row.payer, '****0003')

    // summarizeLedger 的「全部」视图不带明细行，用这一笔自己的日期查明细
    const ledger = await routes.get('/ledger')(panelReq('POST', { scope: row.date }))
    assert.equal(ledger.ok, true)
    const lrow = ledger.view.rows.find((r) => r.amount === 5)
    assert.equal(lrow.payer, '****0003')
    assert.doesNotMatch(JSON.stringify(ledger.view), /30000003|90000009/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approvals.json 损坏：改名留档、禁止写回、明确报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-badappr-'))
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'approvals.json')
  writeFileSync(file, '{"seq":7,"items":{"7":{"amount":8,"created":1700000000000}}', 'utf8')
  const { api, commands, routes } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    assert.equal(mod.status().pending, 0)
    assert.equal(mod.status().approvalsBroken, true)
    assert.equal(existsSync(file), false, '坏文件要改名，不能留在原位置等被覆盖')
    assert.ok(readdirSync(dataDir).some((name) => name.startsWith('approvals.json.corrupt-')))
    const state = await routes.get('/state')(panelReq('GET'))
    assert.equal(state.approvalsBroken, true)
    const out = await commands.get('打赏').run('5', messages({}))
    assert.match(out, /待确认文件损坏/)
    assert.equal(mod.status().pending, 0)
    assert.equal(existsSync(file), false, '损坏后禁止在原文件名重建')
    assert.equal(await commands.get('确认').run('7', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' })), '找不到编号 7 的待确认记录。')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approvals.json 正常时仍能加载并确认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-goodappr-'))
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  const created = 1_700_000_000_000
  writeFileSync(join(dataDir, 'approvals.json'), JSON.stringify({
    seq: 7,
    items: {
      7: {
        id: '7', amount: 8, chatId: 'group:' + GROUP, groupId: GROUP, groupName: '群 ' + GROUP,
        payer: STRANGER, payerName: '路人甲', requester: '路人甲', created,
      },
    },
  }), 'utf8')
  const { api, commands } = makeApi({ dir, settings: { adminQQ: '20000002' } })
  try {
    const mod = await plugin.setup(api, { now: () => created })
    assert.equal(mod.pending().length, 1)
    assert.equal(mod.status().approvalsBroken, false)
    const text = await commands.get('确认').run('7', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(text, /记上了 #7/)
    assert.equal(mod.status().accounts, 1)
    assert.equal(mod.pending().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一条「我转了」走 message + activity 也只道谢一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-dedupe-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent, listeners } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, cooldownSeconds: 0, dailyLimit: 0, adminQQ: '20000002' },
  })
  let asked = 0
  api.ask = async () => { asked++; return '谢谢老板～' }
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0
    const claim = messages({ text: '我转了15', messageId: 'm-100' })
    await Promise.all([
      emit(listeners, 'message', claim),
      emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, nickname: '路人甲', text: '我转了15' }),
    ])
    await until(() => sent.some((s) => /谢谢老板/.test(s.text || '')))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(asked, 1, '两条通道只该问一次模型')
    assert.equal(sent.filter((s) => /谢谢老板/.test(s.text || '')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('道谢失败不自动重试；连点 /已打钱 只问一次模型，30 秒后可手动重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-thanksfail-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const clock = { t: 1_700_000_000_000 }
  const { api, commands, sent, listeners } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, cooldownSeconds: 0, dailyLimit: 0, adminQQ: '20000002' },
  })
  let asked = 0
  api.ask = async () => { asked++; return '谢谢老板～' }
  api.sendText = async () => null // 道谢发送失败；api.reply 走另一个函数，回复照样记下来
  try {
    await plugin.setup(api, { now: () => clock.t })
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, text: '我转了' })
    await until(() => asked === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(asked, 1)
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, text: '打了' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(asked, 1, '窗口内失败也不自动重试')
    assert.equal(sent.filter((s) => /谢谢老板/.test(s.text || '')).length, 0)

    clock.t += 31_000
    for (let i = 0; i < 8; i++) await emit(listeners, 'message', messages({ text: '/已打钱' }))
    assert.equal(asked, 2, '8 次手动重试只该问一次模型（其余在冷却内）')
    assert.ok(sent.filter((s) => /道谢没发出去/.test(s.text || '')).length >= 1)
    assert.ok(sent.filter((s) => /刚试过/.test(s.text || '')).length >= 7)

    // 手动失败仍留着窗口：30 秒后还能再试
    clock.t += 31_000
    await emit(listeners, 'message', messages({ text: '/已打钱' }))
    assert.equal(asked, 3, '冷却过后手动仍可重试')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('api.ask 超时：改用 thankFallbackText 兜底，不把聊天卡死', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-asktimeout-'))
  const { api, commands, sent } = makeApi({ dir, settings: { adminQQ: '20000002', thankFallbackText: '谢谢你呀，收到了。' } })
  try {
    await plugin.setup(api, { now: () => 1_700_000_000_000, askTimeoutMs: 30 })
    await commands.get('打赏').run('10', messages({}))
    sent.length = 0
    api.ask = () => new Promise(() => {})
    const text = await commands.get('确认').run('1', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(text, /已在群里道谢/)
    const said = sent.find((s) => s.chatId === 'group:' + GROUP && s.text)
    assert.equal(said.text, '谢谢你呀，收到了。')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非主人管理员私聊能 /待确认 /确认 /不记；非管理员和群聊仍然不行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-adminmsg-'))
  const { api, commands, sent, listeners } = makeApi({ dir, settings: { adminQQ: '20000002', approvalThrottleSeconds: 0 } })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    await commands.get('打赏').run('15', messages({}))
    sent.length = 0
    const adminDm = { chatId: 'private:20000002', userId: '20000002', groupId: '', nickname: '副管理员' }
    const adminGroup = { chatId: 'group:' + GROUP, userId: '20000002', groupId: GROUP, nickname: '副管理员' }

    const list = await emit(listeners, 'message', { ...adminDm, text: '/待确认' })
    assert.equal(list[0], true, '非主人管理员的命令要接管')
    assert.ok(sent.some((s) => /#1/.test(s.text || '')))

    const groupConfirm = await emit(listeners, 'message', { ...adminGroup, text: '/确认 1' })
    assert.equal(groupConfirm[0], true)
    assert.ok(sent.some((s) => /私聊/.test(s.text || '')))
    assert.equal(mod.pending().length, 1)

    const strangerConfirm = await emit(listeners, 'message', { chatId: 'private:' + STRANGER, userId: STRANGER, groupId: '', text: '/确认 1' })
    assert.equal(strangerConfirm[0], true)
    assert.ok(sent.some((s) => /只有管理员/.test(s.text || '')))
    assert.equal(mod.pending().length, 1)

    const ok = await emit(listeners, 'message', { ...adminDm, text: '/确认 1' })
    assert.equal(ok[0], true)
    assert.equal(mod.pending().length, 0)
    assert.equal(mod.status().accounts, 1)
    assert.ok(sent.some((s) => s.chatId === 'group:' + GROUP && /谢谢老板/.test(s.text || '')))

    // 第二笔：非主人管理员 /不记
    await commands.get('打赏').run('6', messages({}))
    assert.equal(mod.pending().length, 1)
    const rejected = await emit(listeners, 'message', { ...adminDm, text: '/不记 2' })
    assert.equal(rejected[0], true)
    assert.equal(mod.pending().length, 0)
    assert.equal(mod.status().accounts, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dryRun：账本照记、回执写试运行、不谎称已在群里道谢；/讨饭 不回滚额度', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-dryrun-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/qr.png', cooldownSeconds: 600, adminQQ: '20000002' },
    config: { dryRun: true },
  })
  api.sendImage = async (chatId, file) => { sent.push({ chatId, image: file }); return null }
  api.sendText = async (chatId, text) => { sent.push({ chatId, text }); return null }
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    const said = await commands.get('打赏').run('10', messages({ chatId: 'private:' + OWNER, userId: OWNER, groupId: '' }))
    assert.match(said, /记下了 10\.00元/, 'dryRun 下账本照常写本地')
    assert.match(said, /试运行/)
    assert.doesNotMatch(said, /已在群里道谢/)
    assert.equal(mod.status().accounts, 1)
    assert.equal(sent.filter((s) => /谢谢|收到/.test(s.text || '')).length, 0, 'dryRun 不真发消息')

    const first = await commands.get('讨饭').run('', messages({}))
    assert.match(first, /试运行/)
    assert.match(first, /收款码没有真发出去/)
    assert.equal(sent.filter((s) => s.image).length, 0, 'dryRun 不真发图')
    const manual = await commands.get('已打钱').run('', messages({}))
    assert.match(manual, /试运行/, '手动道谢在 dryRun 下也不能谎称已发出')
    assert.equal(sent.filter((s) => s.chatId === 'group:' + GROUP && /谢谢|收到/.test(s.text || '')).length, 0)
    const second = await commands.get('讨饭').run('', messages({}))
    assert.match(second, /刚伸过手了/, 'dryRun 的成功也要占冷却，不能回滚')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('qrCursor 6 小时后清理：旧聊天重新讨饭从第一张开始', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-qrprune-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(dir, 'assets', 'wechat.png'), png)
  writeFileSync(join(dir, 'assets', 'alipay.png'), png)
  const clock = { t: 1_700_000_000_000 }
  const { api, commands, sent } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/wechat.png\nassets/alipay.png', cooldownSeconds: 0, dailyLimit: 0, thanksWindowSeconds: 0 },
  })
  try {
    await plugin.setup(api, { now: () => clock.t })
    const chatA = messages({})
    await commands.get('讨饭').run('', chatA)
    clock.t += 7 * 3600 * 1000
    await commands.get('讨饭').run('', messages({ chatId: 'group:700002', groupId: '700002' }))
    await commands.get('讨饭').run('', chatA)
    const images = sent.filter((s) => s.image).map((s) => s.image.split(/[\\/]/).pop())
    assert.deepEqual(images, ['wechat.png', 'wechat.png', 'wechat.png'], 'A 的收款码游标应在 6 小时后被 pruneState 清掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('新讨饭窗口不会被上一笔失败的记账道谢标记堵住', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beg-new-window-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'qr.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const { api, commands, sent, listeners } = makeApi({
    dir,
    settings: { qrImagePath: 'assets/qr.png', thanksWindowSeconds: 600, cooldownSeconds: 0, dailyLimit: 0, adminQQ: '20000002' },
  })
  try {
    const mod = await plugin.setup(api, { now: () => 1_700_000_000_000 })
    // 记账后的道谢发送失败：给这个聊天留下 thanksTried，但此时还没有讨饭窗口
    api.sendText = async () => null
    const recorded = await mod.recordPayment({
      amount: 5, chatId: 'group:' + GROUP, groupId: GROUP, payer: STRANGER, payerName: '路人甲', source: '测试', byAdmin: true,
    })
    assert.equal(recorded.ok, true)
    // 新窗口 + 发送恢复：上一笔的失败标记不能把这次自动道谢堵住
    let asked = 0
    api.ask = async () => { asked++; return '谢谢老板～' }
    api.sendText = async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 'ok' } }
    await commands.get('讨饭').run('', messages({}))
    sent.length = 0
    await emit(listeners, 'activity', { kind: 'in', chatId: 'group:' + GROUP, userId: STRANGER, nickname: '路人甲', text: '我转了' })
    await until(() => sent.some((s) => /谢谢老板/.test(s.text || '')))
    assert.equal(asked, 1, '新窗口应该重新允许自动道谢')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本号 1.0.1 在 module.json / 入口 / package.json / package-lock 一致', async () => {
  const base = new URL('../', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('module.json', base), 'utf8'))
  const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', base), 'utf8'))
  assert.equal(manifest.version, '1.0.1')
  assert.equal(plugin.version, '1.0.1')
  assert.equal(pkg.version, '1.0.1')
  assert.equal(lock.version, '1.0.1')
  assert.equal(lock.packages[''].version, '1.0.1')
})
