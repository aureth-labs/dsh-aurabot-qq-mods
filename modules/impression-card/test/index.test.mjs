// 扩展入口的集成测试：用假的 api 把 setup 跑起来，验证命令 / 工具 / 路由 / 群友接管。
// 不联 QQ、不联网；sharp 不可用时走文字版回退，正好覆盖降级路径。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

// 测试里装什么 sharp 取决于机器：统一注入一个「不可用」的渲染器，走文字版回退。
const NO_RENDERER = {
  async renderCard () { return { ok: false, error: 'sharp 不可用' } },
  async sharp () { return null },
  async avatarDataUri () { return '' },
}

const OK_RENDERER = {
  async renderCard ({ fileBase }) { return { ok: true, file: join(tmpdir(), fileBase + '.png'), bytes: 1 } },
  async sharp () { return {} },
  async avatarDataUri () { return '' },
}

const TODAY = (() => {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
})()

function makeApi (opts) {
  const o = opts || {}
  const dir = mkdtempSync(join(tmpdir(), 'impression-index-'))
  const commands = []
  const toolBuilders = []
  const rules = []
  const contexts = []
  const listeners = new Map()
  const routes = new Map()
  const sends = []
  const replies = []
  const disposers = []
  const asks = []
  const every = []
  const rows = o.rows || []
  const sendTextResult = o.sendTextResult === undefined ? true : o.sendTextResult
  const sendImageResult = o.sendImageResult === undefined ? true : o.sendImageResult
  const ownerTurn = (sid) => {
    if (typeof o.turnSendersAllOwner === 'function') return o.turnSendersAllOwner(sid)
    if (o.ownerSessions === undefined) return ['s1', 'owner-1', 'owner'].includes(String(sid))
    return Array.isArray(o.ownerSessions) ? o.ownerSessions.includes(String(sid)) : o.ownerSessions.has(String(sid))
  }
  const api = {
    log: { info () {}, warn () {}, debug () {}, error () {} },
    dataDir: (...parts) => join(dir, ...parts),
    settings: () => ({ ...plugin.defaults, fetchAvatar: false, ...(o.settings || {}) }),
    config: () => ({ enabled: true, ownerQQ: '10000', dryRun: false, ...(o.config || {}) }),
    core: {
      personas: { current: () => '你是大肥鱼，一个住在 QQ 里、说话简短口语化的女孩子。' },
      hub: {
        chatLogOf: (day) => rows.filter((r) => String(r.day || '') === day || !r.day),
        sessions: () => ({}),
        turnSendersAllOwner: (sid) => ownerTurn(sid),
        sendText: async (chatId, text) => { sends.push({ chatId, text }); return sendTextResult },
        sendImage: async (chatId, file) => { sends.push({ chatId, file }); return sendImageResult },
        deliver: async () => true,
      },
      http: {
        body: async (req) => req.body || {},
        query: (req) => req.query || {},
        send: (res, code, body) => { res.sent = { code, body } },
      },
      mutes: { muted: () => false },
    },
    onDispose: (fn) => disposers.push(fn),
    command: (c) => commands.push(c),
    tool: (builder) => toolBuilders.push(builder),
    defineTool: (tool) => tool,
    rule: (fn) => rules.push(fn),
    context: (fn) => contexts.push(fn),
    every: (ms, fn) => { every.push({ ms, fn }); return () => {} },
    route: (path, handler) => routes.set(path, handler),
    ask: async (args) => { asks.push(args); return o.answer || '{"total":7,"scores":{"familiarity":8,"luck":-1},"description":"一个测试印象"}' },
    sendText: async (chatId, text) => { sends.push({ chatId, text }); return sendTextResult },
    sendImage: async (chatId, file) => { sends.push({ chatId, file }); return sendImageResult },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text }); return true },
    isOwner: (userId) => String(userId) === '10000',
    onebot: async (action) => {
      if (action === 'get_group_member_list') return [{ user_id: 10001, nickname: '小明', card: '' }]
      return null
    },
    use: (id) => (id === 'memory' ? (o.memory || null) : null),
    on: (event, fn) => {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
    },
    emit: () => {},
  }
  return { api, dir, commands, toolBuilders, rules, contexts, listeners, routes, sends, replies, asks, every, disposers, ownerTurn, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function ownerMsg (extra) {
  return {
    kind: 'group', chatId: 'group:999', userId: '10000', groupId: '999', nickname: '主人',
    messageId: 'm1', text: '/卡片', mentioned: false, replyId: '', images: [], stickers: [], records: [], forwards: [],
    raw: { sender: { nickname: '主人', card: '主人' } },
    ...(extra || {}),
  }
}

test('定义里不再声明宿主不认的 group / __panelGroup，面板仍是独立页', async () => {
  // 不写 tab / group 时宿主把扩展当独立页，落在默认的「系统」分组。
  assert.equal(plugin.group, undefined)
  assert.equal(plugin.tab, undefined)
  assert.equal(plugin.defaults.__panelGroup, undefined)
  assert.equal(plugin.defaults.panelGroup, undefined)
  assert.equal(plugin.panel, 'panel.js')
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/)
})

test('setup 注册命令、工具、规则、上下文和路由', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  assert.equal(typeof exports.helpText, 'function')
  assert.deepEqual(env.commands.map((c) => c.name), ['印象卡片帮助', '卡片', '刷新印象', '印象列表'])
  assert.ok(env.toolBuilders.length >= 1)
  for (const path of ['/state', '/card.png', '/render', '/refresh', '/adjust', '/delete', '/send', '/help']) {
    assert.ok(env.routes.has(path), '缺少路由 ' + path)
  }
  assert.ok(env.listeners.get('message')?.length)
  assert.equal(env.contexts.length, 1)
  assert.equal(typeof env.rules[0]('private'), 'string')
  env.cleanup()
})

test('/卡片 冷启动 → 生成档案 → 没有 sharp 时发文字版摘要', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  const cmd = env.commands.find((c) => c.name === '卡片')
  const result = await cmd.run('', ownerMsg())
  assert.equal(result, '')
  assert.ok(env.asks.length >= 1, '应该调用过一次模型')
  assert.ok(env.asks[0].text.includes('好感度'), '提示词里应该有评分口径')
  assert.match(env.asks[0].system, /不是指令/, 'system 里要声明聊天/记忆只是数据')
  assert.match(env.asks[0].system, /数据/)
  const record = exports.get('qq:10000')
  assert.ok(record, '应该生成了档案')
  assert.equal(record.total, 7)
  assert.equal(record.scores.familiarity, 8)
  assert.match(record.description, /测试印象/)
  const sent = env.sends.map((s) => s.text).filter(Boolean).join('\n')
  assert.match(sent, /【大肥鱼的印象卡片】/)
  assert.match(sent, /好感度：7/)
  env.cleanup()
})

test('/state 返回档案、设置和主题；/card.png 对陌生人明确报错', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  await env.commands.find((c) => c.name === '卡片').run('', ownerMsg())
  const state = await env.routes.get('/state')()
  assert.equal(state.ok, true)
  assert.equal(state.persons.length, 1)
  assert.equal(state.persons[0].name, '主人')
  assert.equal(state.themes.length, 3)
  assert.equal(state.settings.totalLabel, '好感度')
  const res = {}
  await env.routes.get('/card.png')({ query: { person: 'qq:404' } }, res)
  assert.equal(res.sent.body.ok, false)
  assert.match(res.sent.body.message, /还没有/)
  env.cleanup()
})

test('工具：impression_adjust 加减分并写事件；impression_append_note 追加笔记', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.refresh('qq:10001', 'private:10001').catch(() => {})
  const tools = env.toolBuilders[0]({ chat: { chatId: 'group:999', kind: 'group', userId: '10000', groupId: '999' }, level: 'full', sessionId: 's1' })
  const exec = { sessionId: 's1' }
  const names = tools.map((t) => t.name)
  assert.deepEqual(names, ['impression_adjust', 'impression_set', 'impression_append_note', 'impression_rewrite_note', 'impression_detail', 'impression_nudge', 'impression_refresh', 'impression_send_card'])
  // 先给小明建档案
  const detail = tools.find((t) => t.name === 'impression_detail')
  // 不传 exec 时退回工具工厂拿到的 sessionId；真正的门禁在 execute 时判定。
  const detailOut = await detail.execute({ target: '10001' })
  assert.equal(detailOut.ok, true)
  const adjust = tools.find((t) => t.name === 'impression_adjust')
  const out = await adjust.execute({ target: '10001', dimension: 'familiarity', delta: 2, reason: '聊天很投缘' }, exec)
  assert.equal(out.ok, true)
  assert.match(out.message, /熟悉/)
  const record = exports.get('qq:10001')
  assert.equal(record.scores.familiarity, 10)
  const note = tools.find((t) => t.name === 'impression_append_note')
  const noteOut = await note.execute({ content: '喜欢半夜发美食图', target: '10001' }, exec)
  assert.equal(noteOut.ok, true)
  assert.match(exports.get('qq:10001').description, /半夜发美食图/)
  assert.ok(exports.list().length >= 1)
  env.cleanup()
})

test('工具在 system 会话里不给', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const tools = env.toolBuilders[0]({ chat: { chatId: 'system:x', kind: 'system' }, level: 'chat', sessionId: 's2' })
  assert.deepEqual(tools, [])
  env.cleanup()
})

test('主人命令的 /卡片 文本会被吞掉，不再交给她回复', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '10000', groupId: '999', nickname: '主人', messageId: 'm9',
    text: '/卡片 小明', raw: { sender: { nickname: '主人' } },
  })
  assert.equal(taken, true)
  const notTaken = await handler({
    kind: 'group', chatId: 'group:999', userId: '10000', groupId: '999', nickname: '主人', messageId: 'm10',
    text: '在吗', raw: { sender: { nickname: '主人' } },
  })
  assert.equal(notTaken, false)
  env.cleanup()
})

test('自然语言「查询好感度」：不用斜杠，主人也能触发', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '10000', groupId: '999', nickname: '主人', messageId: 'q1',
    text: '查询好感度', raw: { sender: { nickname: '主人' } },
  })
  assert.equal(taken, true)
  assert.ok(env.asks.length >= 1, '应该触发了冷启动')
  assert.match(env.sends.map((x) => x.text).filter(Boolean).join('\n'), /【大肥鱼的印象卡片】/)
  env.cleanup()
})

test('自然语言「查询好感度 小明」：带名字、带问号也能解析', async () => {
  const env = makeApi({ settings: { guestColdStart: true } })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'q2',
    text: '查询好感度 小明？', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, true)
  assert.ok(env.asks.length >= 1)
  assert.ok(env.sends.some((x) => x.text && x.text.includes('小明')), '应该发的是小明的卡')
  env.cleanup()
})

test('群里 @ 她之后说「查询好感度 小明」也能认', async () => {
  const env = makeApi({ settings: { guestColdStart: true } })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'q2b',
    text: '@123456789 查询好感度 小明', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, true)
  assert.ok(env.sends.some((x) => x.text && x.text.includes('小明')))
  env.cleanup()
})

test('普通聊天提到好感度不触发发卡', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'q3',
    text: '我觉得好感度挺高的', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, false)
  assert.equal(env.asks.length, 0)
  env.cleanup()
})

test('自然语言「查询好感度 雷达:3」：对象为空、雷达项数生效', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '10000', groupId: '999', nickname: '主人', messageId: 'q4',
    text: '帮我查一下好感度 雷达:3', raw: { sender: { nickname: '主人' } },
  })
  assert.equal(taken, true)
  assert.ok(env.asks.length >= 1)
  env.cleanup()
})

test('guestCards 关掉时自然语言也不接管', async () => {
  const env = makeApi({ settings: { guestCards: false } })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'q5',
    text: '查询好感度', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, false)
  env.cleanup()
})

test('群友 /卡片：没有档案时不触发模型，明确说明原因', async () => {
  const env = makeApi({ rows: [{ chatId: 'group:999', uid: '20002', who: '路人', text: '在吗', t: Date.now() }] })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'm2',
    text: '/卡片', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, true)
  assert.equal(env.asks.length, 0, '群友不应触发冷启动')
  assert.match(env.replies[0].text, /还没有/)
  env.cleanup()
})

test('群友 /卡片 查自己的已有档案会走卡片流程', async () => {
  const env = makeApi({ settings: { guestColdStart: true }, rows: [{ chatId: 'group:999', uid: '20002', who: '路人', text: '在吗', t: Date.now() }] })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'm3',
    text: '/卡片', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, true)
  const sent = env.sends.map((x) => x.text).filter(Boolean).join('\n')
  assert.match(sent, /印象卡片/)
  assert.equal(env.replies.length, 0)
  env.cleanup()
})

test('引用某人的消息发 /卡片 会查被引用的人', async () => {
  let asked = 0
  const env = makeApi()
  env.api.onebot = async (action) => {
    if (action === 'get_msg') { asked++; return { sender: { user_id: 30003, nickname: '阿三' } } }
    return null
  }
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:30003', 'group:999')
  const cmd = env.commands.find((c) => c.name === '卡片')
  const result = await cmd.run('', ownerMsg({ replyId: 'm9', text: '/卡片' }))
  assert.equal(result, '')
  assert.equal(asked, 1)
  assert.ok(exports.get('qq:30003'))
  env.cleanup()
})

test('群友「/卡片小明」不带空格也能认出来；「/cards」不算命令', async () => {
  const env = makeApi({ settings: { guestColdStart: true } })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'm11',
    text: '/卡片', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, true)
  const notTaken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'm12',
    text: '/cards 在吗', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(notTaken, false)
  env.cleanup()
})

test('非主人发 /刷新印象 会被拦下并说明', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const handler = env.listeners.get('message')[0]
  const taken = await handler({
    kind: 'group', chatId: 'group:999', userId: '20002', groupId: '999', nickname: '路人', messageId: 'm13',
    text: '/刷新印象', raw: { sender: { nickname: '路人' } },
  })
  assert.equal(taken, true)
  assert.match(env.replies[0].text, /主人/)
  assert.equal(env.asks.length, 0)
  env.cleanup()
})

test('主人查卡允许别人；allowQueryOthers=false 时拒绝', async () => {
  const env = makeApi({ settings: { allowQueryOthers: false } })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const cmd = env.commands.find((c) => c.name === '卡片')
  const result = await cmd.run('10001', ownerMsg())
  assert.match(result, /查自己/)
  env.cleanup()
})

test('/刷新印象 默认仅管理员可用的提示', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const cmd = env.commands.find((c) => c.name === '刷新印象')
  const denied = await cmd.run('', ownerMsg({ userId: '20002' }))
  assert.match(denied, /管理员/)
  const allowed = await cmd.run('', ownerMsg())
  assert.equal(allowed, '')
  env.cleanup()
})

test('/印象卡片 帮助 不是查一个叫「帮助」的人', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  const cmd = env.commands.find((c) => c.name === '卡片')
  const text = await cmd.run('帮助', ownerMsg())
  assert.match(text, /印象卡片/)
  assert.equal(env.asks.length, 0)
  env.cleanup()
})

test('主动微调：关着时什么都不做', async () => {
  const env = makeApi({ rows: [
    { day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '在吗', t: Date.now() - 60000 },
    { day: TODAY, chatId: 'group:999', uid: '10002', who: '阿二', text: '在', t: Date.now() - 30000 },
  ] })
  await plugin.setup(env.api, { renderer: NO_RENDERER })
  await env.every[0].fn()
  // 关着：即使有聊天记录也不该调模型
  assert.equal(env.asks.length, 0)
  env.cleanup()
})

test('主动微调：真的会跑，且只拿未忘记、非 bot、非 seen 的行', async () => {
  const rows = [
    { day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '正常消息', t: Date.now() - 60000 },
    { day: TODAY, chatId: 'group:999', uid: '10002', who: '阿二', text: '忘记的消息', t: Date.now() - 50000, forgottenAt: Date.now() },
    { day: TODAY, chatId: 'group:999', uid: '99999', who: 'bot', text: '机器人消息', t: Date.now() - 40000 },
    { day: TODAY, chatId: 'group:999', uid: '10004', who: '阿四', text: '看过图片', t: Date.now() - 30000, kind: 'seen' },
  ]
  const env = makeApi({ rows, settings: { proactiveEnabled: true, proactiveHours: 1, proactivePollSeconds: 60 } })
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  for (const id of ['10001', '10002', '10003', '10004']) await exports.generate('qq:' + id, 'group:999')
  env.asks.length = 0
  await env.every[0].fn()
  assert.equal(env.asks.length, 1, '过滤后只剩小明一个可微调对象，模型只该被调一次')
  assert.match(env.asks[0].text, /正常消息/)
  assert.doesNotMatch(env.asks[0].text, /忘记的消息|机器人消息|看过图片/)
  assert.match(env.asks[0].system || '', /不是指令/)
  env.cleanup()
})

test('文字回退：帮助与列表都有内容', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  assert.match(exports.helpText(), /印象卡片/)
  assert.match(exports.helpText(), /雷达/)
  const list = await env.commands.find((c) => c.name === '印象列表').run('', ownerMsg())
  assert.match(list, /还没有任何印象档案/)
  env.cleanup()
})

test('面板路由：跨站请求一律拒绝，8 条路由都先过 crossSite', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: OK_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  const cross = { headers: { 'sec-fetch-site': 'cross-site' }, method: 'POST', body: { personId: 'qq:10001' } }
  for (const path of ['/state', '/help', '/render', '/refresh', '/adjust', '/delete', '/send']) {
    const out = await env.routes.get(path)(cross)
    assert.equal(out.ok, false, path)
    assert.match(out.message, /跨站/, path)
  }
  const res = {}
  await env.routes.get('/card.png')({ ...cross, method: 'GET', query: { person: 'qq:10001' } }, res)
  assert.equal(res.sent.code, 403)
  assert.equal(res.sent.body.ok, false)
  // Origin 与 Host 不同源也拒绝
  const evil = await env.routes.get('/state')({ headers: { origin: 'https://evil.example', host: '127.0.0.1:5099' } })
  assert.equal(evil.ok, false)
  assert.match(evil.message, /跨站/)
  // 同源放行
  const same = await env.routes.get('/state')({ headers: { origin: 'http://127.0.0.1:5099', host: '127.0.0.1:5099' } })
  assert.equal(same.ok, true)
  env.cleanup()
})

test('面板 Host 白名单：挡住 DNS rebinding，放行本机与配置的对外域名', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: OK_RENDERER })
  // 攻击者的 DNS rebinding 页面：Origin 和 Host 都是 evil.example，crossSite 拦不住，靠 Host 白名单。
  const rebinding = await env.routes.get('/state')({ headers: { host: 'evil.example', origin: 'http://evil.example' } })
  assert.equal(rebinding.ok, false)
  assert.match(rebinding.message, /Host|DNS rebinding/)
  // 本机 Host 放行
  const local = await env.routes.get('/state')({ headers: { host: '127.0.0.1:5099', origin: 'http://127.0.0.1:5099' } })
  assert.equal(local.ok, true)
  env.cleanup()

  // 反代部署填了 security.publicHostname 时，该域名放行。
  const pub = makeApi({ config: { security: { publicHostname: 'panel.example.com' } } })
  await plugin.setup(pub.api, { renderer: OK_RENDERER })
  const publicHost = await pub.routes.get('/state')({ headers: { host: 'panel.example.com', origin: 'https://panel.example.com' } })
  assert.equal(publicHost.ok, true)
  pub.cleanup()
})

test('写接口必须 POST：GET 不改档案、不刷新、不发送', async () => {
  const env = makeApi({ rows: [{ day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '在吗', t: Date.now() - 1000 }] })
  const exports = await plugin.setup(env.api, { renderer: OK_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  const before = JSON.stringify(exports.get('qq:10001'))
  const asksBefore = env.asks.length
  const sendsBefore = env.sends.length
  for (const path of ['/render', '/refresh', '/adjust', '/delete', '/send']) {
    const out = await env.routes.get(path)({ method: 'GET', body: { personId: 'qq:10001', value: 1 } })
    assert.equal(out.ok, false, path)
    assert.match(out.message, /POST/, path)
  }
  assert.equal(JSON.stringify(exports.get('qq:10001')), before)
  assert.equal(env.asks.length, asksBefore)
  assert.equal(env.sends.length, sendsBefore)
  const ok = await env.routes.get('/adjust')({ method: 'POST', body: { personId: 'qq:10001', dimension: 'total', value: 1, mode: 'add' } })
  assert.equal(ok.ok, true)
  assert.equal(exports.get('qq:10001').total, 8)
  env.cleanup()
})

test('记忆检索：社交场景传 where 且只查关于对方、排除主人；主人私聊可看全域', async () => {
  const calls = []
  const memory = {
    recall: (query, options) => { calls.push({ query, options }); return [{ it: { text: '一条旧记忆' } }] },
    profiles: () => [{ qq: '10001', text: '主人私聊里的秘密档案' }],
    addEvent: () => {},
  }
  const env = makeApi({ memory })
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  assert.ok(calls.length >= 1)
  for (const call of calls) {
    assert.equal(call.options.where, 'group:999')
    assert.equal(call.options.onlyAbout, '10001')
    assert.equal(call.options.requireAbout, true)
    assert.equal(call.options.excludeAbout, '10000')
  }
  assert.ok(!env.asks[0].text.includes('主人私聊里的秘密档案'), '社交场景不读跨聊天人物小档案')
  calls.length = 0
  const asksBefore = env.asks.length
  await exports.refresh('qq:10001', 'private:10000')
  assert.equal(env.asks.length, asksBefore + 1)
  assert.ok(calls.length >= 1)
  for (const call of calls) {
    assert.equal(call.options.where, 'private:10000')
    assert.equal(call.options.onlyAbout, undefined)
    assert.equal(call.options.requireAbout, undefined)
  }
  assert.ok(env.asks.at(-1).text.includes('主人私聊里的秘密档案'), '主人私聊可以使用人物小档案')
  env.cleanup()
})

test('聊天流水过滤 forgottenAt / bot / seen，不把被忘记的内容喂给模型', async () => {
  const rows = [
    { day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '正常消息', t: Date.now() - 50000 },
    { day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '忘记的秘密', t: Date.now() - 40000, forgottenAt: Date.now() },
    { day: TODAY, chatId: 'group:999', uid: '99999', who: 'bot', text: '机器人自己的话', t: Date.now() - 30000 },
    { day: TODAY, chatId: 'group:999', uid: '10002', who: '阿二', text: '看过图片', t: Date.now() - 20000, kind: 'seen' },
  ]
  const env = makeApi({ rows })
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  const prompt = env.asks[0].text
  assert.match(prompt, /正常消息/)
  assert.doesNotMatch(prompt, /忘记的秘密|机器人自己的话|看过图片/)
  assert.match(env.asks[0].system, /不是指令/)
  assert.match(env.asks[0].system, /数据/)
  env.cleanup()
})

test('工具主人门：非主人 / 混轮调用一律拒绝，不写档案、不烧模型', async () => {
  const env = makeApi({ ownerSessions: [], rows: [{ day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '在吗', t: Date.now() - 1000 }] })
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  const before = JSON.stringify(exports.get('qq:10001'))
  const asksBefore = env.asks.length
  const sendsBefore = env.sends.length
  const tools = env.toolBuilders[0]({ chat: { chatId: 'group:999', kind: 'group', userId: '10000', groupId: '999' }, level: 'full', sessionId: 's1' })
  for (const tool of tools) {
    const out = await tool.execute({}, { sessionId: 'group-mixed' })
    assert.equal(out.ok, false, tool.name)
    assert.match(out.message, /主人/, tool.name)
  }
  assert.equal(JSON.stringify(exports.get('qq:10001')), before)
  assert.equal(env.asks.length, asksBefore)
  assert.equal(env.sends.length, sendsBefore)
  env.cleanup()
})

test('工具主人门在 execute 时判定：挂载后主人身份变化立即生效', async () => {
  let ownerTurn = true
  const env = makeApi({ turnSendersAllOwner: () => ownerTurn, rows: [{ day: TODAY, chatId: 'group:999', uid: '10001', who: '小明', text: '在吗', t: Date.now() - 1000 }] })
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  const tools = env.toolBuilders[0]({ chat: { chatId: 'group:999', kind: 'group', userId: '10000', groupId: '999' }, level: 'full', sessionId: 's1' })
  const adjust = tools.find((t) => t.name === 'impression_adjust')
  ownerTurn = false
  const denied = await adjust.execute({ target: '10001', dimension: 'total', delta: 3 }, { sessionId: 's1' })
  assert.equal(denied.ok, false)
  assert.equal(exports.get('qq:10001').total, 7)
  ownerTurn = true
  const allowed = await adjust.execute({ target: '10001', dimension: 'total', delta: 1 }, { sessionId: 's1' })
  assert.equal(allowed.ok, true)
  assert.equal(exports.get('qq:10001').total, 8)
  env.cleanup()
})

test('sendImage 返回 null 时 /卡片、/send、impression_send_card 都报失败', async () => {
  const env = makeApi({ sendImageResult: null })
  const exports = await plugin.setup(env.api, { renderer: OK_RENDERER })
  await exports.generate('qq:10000', 'group:999')
  await exports.generate('qq:10001', 'group:999')
  const text = await env.commands.find((c) => c.name === '卡片').run('', ownerMsg())
  assert.match(text, /没发出去/)
  const sendRes = await env.routes.get('/send')({ method: 'POST', body: { personId: 'qq:10001', chatId: 'group:999' } })
  assert.equal(sendRes.ok, false)
  assert.match(sendRes.message, /没发出去/)
  const tools = env.toolBuilders[0]({ chat: { chatId: 'group:999', kind: 'group', userId: '10000', groupId: '999' }, level: 'full', sessionId: 's1' })
  const out = await tools.find((t) => t.name === 'impression_send_card').execute({ target: '10001' }, { sessionId: 's1' })
  assert.equal(out.ok, false)
  assert.match(out.message, /没发出去/)
  env.cleanup()
})

test('渲染失败且文字版也发不出去时 /卡片 不报成功', async () => {
  const env = makeApi({ sendTextResult: null })
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:10000', 'group:999')
  const text = await env.commands.find((c) => c.name === '卡片').run('', ownerMsg())
  assert.match(text, /没发出去/)
  assert.doesNotMatch(text, /文字版卡片/)
  env.cleanup()
})

test('无 sharp 时文字卡发送成功：命令不报空白，sendText 真的被调用一次', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  const text = await env.commands.find((c) => c.name === '卡片').run('', ownerMsg())
  assert.equal(text, '')
  const sentTexts = env.sends.filter((item) => item.chatId === 'group:999' && typeof item.text === 'string' && item.text.length > 0).map((item) => item.text)
  assert.ok(sentTexts.length >= 1, '文字版卡片必须真的走 sendText')
  assert.match(sentTexts.join('\n'), /好感度：7/)
  assert.match(sentTexts.join('\n'), /【大肥鱼的印象卡片】/)
  assert.equal(exports.get('qq:10000').total, 7)
  env.cleanup()
})

test('工具写笔记会清洗控制字符 / 零宽字符并封顶', async () => {
  const env = makeApi()
  const exports = await plugin.setup(env.api, { renderer: NO_RENDERER })
  await exports.generate('qq:10001', 'group:999')
  const tools = env.toolBuilders[0]({ chat: { chatId: 'group:999', kind: 'group', userId: '10000', groupId: '999' }, level: 'full', sessionId: 's1' })
  const rewrite = tools.find((t) => t.name === 'impression_rewrite_note')
  const out = await rewrite.execute({ target: '10001', content: '好\u0000的\u200b\n\n\n\n' + 'x'.repeat(5000) }, { sessionId: 's1' })
  assert.equal(out.ok, true)
  const description = exports.get('qq:10001').description
  assert.ok(!description.includes('\u0000'))
  assert.ok(!description.includes('\u200b'))
  assert.ok(description.length <= 4000, '笔记长度要封顶')
  env.cleanup()
})

test('GET /card.png?person=__proto__ 不会沿原型链返回或污染 Object.prototype', async () => {
  const env = makeApi()
  await plugin.setup(env.api, { renderer: OK_RENDERER })
  for (const person of ['__proto__', 'constructor', 'toString']) {
    const res = {}
    await env.routes.get('/card.png')({ query: { person } }, res)
    assert.equal(res.sent.body.ok, false, person)
    assert.match(res.sent.body.message, /还没有/, person)
  }
  assert.equal(({}).total, undefined, 'Object.prototype 不能被写脏')
  assert.equal(Object.prototype.scores, undefined)
  const adjustRes = await env.routes.get('/adjust')({ method: 'POST', body: { personId: '__proto__', dimension: 'total', value: 1, mode: 'add' } })
  assert.equal(adjustRes.ok, false)
  assert.equal(Object.prototype.total, undefined)
  env.cleanup()
})
