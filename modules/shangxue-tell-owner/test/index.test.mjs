// 转告主人反馈（shangxue-tell-owner）单元测试
// 用假的 api 驱动两个工具的 execute，验证：工单记录、每日限额、私聊开关、送达主人、resolve 回群引用、多媒体。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

const OWNER = '1919892171'
const BOT = '1787850032'
const OTHER = '30000003'
const OTHER2 = '30000004'
const GROUP = '44444444'

/** 造一个假 api：捕获 tool / rule 注册，能按「当前 chat / level」拿到工具。 */
function makeEnv(settingsPatch = {}, opts = {}) {
  let settings = {}
  const dir = mkdtempSync(join(tmpdir(), 'stx-tell-owner-'))
  const delivered = [] // hub.deliver 记录
  const sentSegments = [] // sendSegments 记录（回群 / 发附件）
  const sentImages = []
  const sentFiles = [] // sendFile 记录
  const toolBuilders = []
  const rules = []
  const onebotCalls = []
  const eventHandlers = new Map()
  const routes = new Map()
  let routeBody = {}

  const api = {
    id: 'shangxue-tell-owner',
    dir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: () => ({ ownerQQ: OWNER, botQQ: BOT }),
    settings: () => settings,
    saveSettings: (p) => { settings = { ...settings, ...p }; return settings },
    dataDir: (...parts) => join(dir, ...parts),
    isOwner: (uid) => String(uid) === OWNER,
    send: async () => true,
    sendText: async () => true,
    reply: async () => true,
    sendImage: async (chatId, src) => { sentImages.push({ chatId, src }); return true },
    sendFile: async (chatId, file, name) => { sentFiles.push({ chatId, file, name }); return opts.fileFail ? null : { message_id: 'f1' } },
    sendSegments: async (chatId, segs) => { sentSegments.push({ chatId, segs }); return true },
    onebot: async (action, params) => {
      onebotCalls.push({ action, params })
      if (action === 'get_msg') return opts.msg || null
      return {}
    },
    on: (event, fn) => { eventHandlers.set(event, fn); return () => {} },
    tool: (builder) => { toolBuilders.push(builder); return () => {} },
    defineTool: (spec) => spec,
    rule: (fn) => { rules.push(fn); return () => {} },
    route: (path, handler) => { routes.set(path, handler); return () => {} },
    use: () => null,
    core: {
      hub: {
        deliver: async (chatId, text) => {
          if (opts.deliverFail) return { failed: 1, errors: ['boom'] }
          delivered.push({ chatId, text })
          return { ok: true, sent: 1 }
        },
        // 插件现在用 hub.sendSegments(…, {force:true}) 发 summary 文字/图片给主人（绕过真人化/interception）
        sendSegments: async (chatId, segs, note, o) => {
          if (opts.deliverFail) return null
          const force = o && o.force
          const img = (segs || []).filter((s) => s.type === 'image').map((s) => s.data && s.data.file)
          if (img.length) {
            for (const f of img) sentImages.push({ chatId, src: f, force })
          }
          const text = (segs || [])
            .filter((s) => s.type === 'text')
            .map((s) => s.data && s.data.text)
            .join('')
          if (text) delivered.push({ chatId, text, force })
          return { message_id: 'm1' }
        },
      },
      http: {
        body: async () => routeBody,
      },
    },
  }

  // 真插件会把模块的 defaults 并进 settings，这里照做
  settings = { ...(mod.defaults || {}) }
  const exported = mod.setup(api)
  settings = { ...settings, ...settingsPatch }

  /** 拿某个 chat / level 下的工具（返回 tool 规格数组）。 */
  function toolsFor(chat, level = 'social') {
    const out = []
    for (const b of toolBuilders) {
      const r = b({ chat, level })
      if (Array.isArray(r)) out.push(...r)
      else if (r) out.push(r)
    }
    return out
  }
  function toolNamed(chat, level, name) {
    return toolsFor(chat, level).find((t) => t.name === name)
  }

  /** 往 message 事件里灌一条「当前消息」，供工具取 messageId / 昵称 / 原始多媒体。 */
  function setCurrentMessage(msg) {
    const fn = eventHandlers.get('message')
    if (fn) fn(msg)
  }

  return {
    dir,
    api,
    exported,
    delivered,
    sentSegments,
    sentImages,
    sentFiles,
    onebotCalls,
    rules,
    settings: () => settings,
    toolsFor,
    toolNamed,
    setCurrentMessage,
    routes,
    setRouteBody: (b) => { routeBody = b },
    store: exported && exported._store,
  }
}

const groupChat = (patch = {}) => ({
  kind: 'group',
  chatId: `group:${GROUP}`,
  userId: OTHER,
  groupId: GROUP,
  nickname: '小明',
  messageId: '1001',
  ...patch,
})
const privateChat = (patch = {}) => ({
  kind: 'private',
  chatId: `private:${OTHER}`,
  userId: OTHER,
  groupId: '',
  nickname: '小红',
  messageId: '2002',
  ...patch,
})

// ---------- 配置 / 工具可见性 ----------

test('默认配置：每天 2 条，私聊开启，主人私聊关闭，自然转述+来源署名', () => {
  const env = makeEnv()
  const s = env.settings()
  assert.equal(s.perUserPerDay, 2)
  assert.equal(s.privateEnabled, true)
  assert.equal(s.ownerPrivateEnabled, false)
  assert.equal(s.forwardMode, 'natural-sign')
})

test('总开关关掉后两个工具都不给', () => {
  const env = makeEnv({ enabled: false })
  assert.deepEqual(env.toolsFor(groupChat()), [])
})

test('群里能看到 tell 工具、看不到 owner 工单工具', () => {
  const env = makeEnv()
  assert.ok(env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner'))
  assert.equal(env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner_tickets_list'), undefined)
})

test('别人私聊：privateEnabled 时可用', () => {
  const env = makeEnv({ privateEnabled: true })
  assert.ok(env.toolNamed(privateChat(), 'social', 'shangxue_tell_owner'))
})

test('别人私聊：privateEnabled 关闭时不可用', () => {
  const env = makeEnv({ privateEnabled: false })
  assert.equal(env.toolNamed(privateChat(), 'social', 'shangxue_tell_owner'), undefined)
})

test('主人私聊：默认不给 tell 工具，但给 owner 工单工具', () => {
  const env = makeEnv({ ownerPrivateEnabled: false })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}`, nickname: '主人' })
  assert.equal(env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner'), undefined)
  assert.ok(env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_tickets_list'))
})

test('主人私聊：ownerPrivateEnabled 开启后也能见到 tell 工具', () => {
  const env = makeEnv({ ownerPrivateEnabled: true })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}`, nickname: '主人' })
  assert.ok(env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner'))
})

// ---------- 提交工单 + 送达主人 ----------

test('群里托话：记工单并送达主人私聊（自然转述原文）', async () => {
  const env = makeEnv()
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1001', raw: { message: [] } })
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: false, summary: '小明的语音模块坏了，发不出语音，想让主人看看', submitterNickname: '小明', originalText: '你的语音模块坏掉了' })
  assert.equal(r.ok, true)
  assert.equal(r.ticketId, '1')
  // 送达主人
  assert.equal(env.delivered.length, 1)
  assert.equal(env.delivered[0].chatId, `private:${OWNER}`)
  assert.match(env.delivered[0].text, /语音模块坏了/)
  // 工单落库
  const t = env.store.get('1')
  assert.equal(t.chatKind, 'group')
  assert.equal(t.groupId, GROUP)
  assert.equal(t.userId, OTHER)
  assert.equal(t.messageId, '1001')
  assert.equal(t.status, 'open')
})

test('natural-sign 模式：追加来源署名', async () => {
  const env = makeEnv({ forwardMode: 'natural-sign' })
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tool.execute({ hasMedia: false, summary: '有反馈', originalText: '原话' })
  assert.equal(env.delivered.length, 1)
  assert.match(env.delivered[0].text, /来自群 44444444/)
})

test('summary 文字确实发到主人私聊（带 force，绕开会拦文字的人性化模块）', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: false, summary: '语音模块坏了，麻烦主人看一下' })
  assert.equal(r.ok, true)
  assert.equal(env.delivered.length, 1, '发了一条文字给主人')
  assert.equal(env.delivered[0].chatId, `private:${OWNER}`)
  assert.match(env.delivered[0].text, /语音模块坏了/)
  assert.equal(env.delivered[0].force, true, '文字走 force，不被睡眠/暂离拦下')
})

test('文字没发出去（返回 null）：工单回滚为 closed，不占限额', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  env.api.core.hub.sendSegments = async () => null // 模拟全部被拦 / 网关失败
  const r = await tool.execute({ hasMedia: false, summary: '发不出去的反馈' })
  assert.equal(r.ok, false)
  assert.match(r.message, /没发出去/)
  assert.equal(env.store.get('1').status, 'closed', '失败不保留 open 工单')
})

test('文件附件：hasMedia=true + mediaPaths 走 sendFile 发给主人', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, mediaPaths: ['base64://aGVsbG8='], summary: '附了日志文件' })
  assert.equal(r.ok, true)
  assert.ok(env.sentFiles.length >= 1, '文件走 sendFile 发给主人')
  assert.equal(env.sentFiles[0].chatId, `private:${OWNER}`)
})

test('文件附件：sendFile 受限时裸上传兜底（绕白名单）', async () => {
  const env = makeEnv({}, { fileFail: true })
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, mediaPaths: ['base64://aGVsbG8='], summary: '附了日志文件' })
  assert.equal(r.ok, true)
  // 兜底走了裸上传 upload_private_file
  const up = env.onebotCalls.find((c) => c.action === 'upload_private_file')
  assert.ok(up, '受限时改走 upload_private_file')
  assert.equal(String(up.params.user_id), OWNER)
})

test('没设主人 QQ 时提交失败', async () => {
  const env = makeEnv()
  env.api.config = () => ({ ownerQQ: '' })
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: false, summary: 'x' })
  assert.equal(r.ok, false)
})

test('送达失败时工单被关闭，不占限额', async () => {
  const env = makeEnv({}, { deliverFail: true })
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: false, summary: 'x' })
  assert.equal(r.ok, false)
  assert.equal(env.store.get('1').status, 'closed')
})

// ---------- 每日限额（按用户，跨群）----------

test('每个用户每天默认 2 条，第 3 条被拒；换群也累计', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  assert.equal((await tool.execute({ hasMedia: false, summary: 'a' })).ok, true)
  // 同一个人的另一个群
  const tool2 = env.toolNamed(groupChat({ groupId: '55555555', chatId: 'group:55555555' }), 'social', 'shangxue_tell_owner')
  assert.equal((await tool2.execute({ hasMedia: false, summary: 'b' })).ok, true)
  // 第 3 条被拒
  const r3 = await tool.execute({ hasMedia: false, summary: 'c' })
  assert.equal(r3.ok, false)
  assert.match(r3.message, /上限/)
})

test('不同用户各自独立计数', async () => {
  const env = makeEnv()
  const t1 = env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
  const t2 = env.toolNamed(groupChat({ userId: OTHER2 }), 'social', 'shangxue_tell_owner')
  await t1.execute({ hasMedia: false, summary: 'a' })
  await t1.execute({ hasMedia: false, summary: 'b' })
  assert.equal((await t1.execute({ hasMedia: false, summary: 'c' })).ok, false)
  assert.equal((await t2.execute({ hasMedia: false, summary: 'x' })).ok, true, '另一个人不受影响')
})

test('主人提交不受每日限额约束', async () => {
  const env = makeEnv({ ownerPrivateEnabled: true })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const tool = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner')
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await tool.execute({ hasMedia: false, summary: 't' + i })).ok, true)
  }
})

// ---------- 主人工单闭环 ----------

test('主人 list 看到未完成工单', async () => {
  const env = makeEnv()
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: '语音坏了', submitterNickname: '小明' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const ticketsTool = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_tickets_list')
  const r = await ticketsTool.execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /#1/)
  assert.match(r.message, /语音坏了/)
  assert.match(r.message, /群 44444444/)
})

test('back：只给 replyText，自动引用原消息 @ 发送者并标记完成', async () => {
  const env = makeEnv()
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1001', raw: { message: [] } })
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: '生图坏了', submitterNickname: '小明' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const back = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_back')
  // AI 只给 replyText，不传任何 id / 群号
  const r = await back.execute({ replyText: '主人说生图已经修好了，你可以再试试' })
  assert.equal(r.ok, true)
  // 回群：sendSegments 到建单时记下的原群，引用原消息 id、@ 原发送者
  assert.equal(env.sentSegments.length, 1)
  const seg = env.sentSegments[0]
  assert.equal(seg.chatId, `group:${GROUP}`)
  const types = seg.segs.map((s) => s.type)
  assert.ok(types.includes('reply'), '引用原消息')
  assert.equal(seg.segs[0].data.id, '1001')
  assert.ok(types.includes('at'), '@ 原发送者')
  assert.equal(seg.segs.find((s) => s.type === 'at').data.qq, OTHER)
  assert.match(JSON.stringify(seg.segs), /修好了/)
  // 工单自动完成
  assert.equal(env.store.get('1').status, 'done')
})

test('back：多张工单时传 ticketId 指定回哪张', async () => {
  const env = makeEnv()
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1001', raw: { message: [] } })
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: '第一件事', submitterNickname: '小明' })
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1002', raw: { message: [] } })
  await tell.execute({ hasMedia: false, summary: '第二件事', submitterNickname: '小明' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const back = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_back')
  const r = await back.execute({ replyText: '回第一件', ticketId: '1' })
  assert.equal(r.ok, true)
  assert.equal(env.store.get('1').status, 'done')
  assert.equal(env.store.get('2').status, 'open')
  assert.equal(env.sentSegments[0].segs[0].data.id, '1001')
})

test('back：不传 ticketId 时自动挑最新一张 open', async () => {
  const env = makeEnv()
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1001', raw: { message: [] } })
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: '旧事' })
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1002', raw: { message: [] } })
  await tell.execute({ hasMedia: false, summary: '新事' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const back = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_back')
  const r = await back.execute({ replyText: '回最新的' })
  assert.equal(r.ok, true)
  assert.equal(env.store.get('2').status, 'done', '最新一张被处理')
  assert.equal(env.store.get('1').status, 'open')
})

test('back：没有待处理工单时失败', async () => {
  const env = makeEnv()
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const back = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_back')
  const r = await back.execute({ replyText: 'x' })
  assert.equal(r.ok, false)
})

test('back 缺 replyText 被拒', async () => {
  const env = makeEnv()
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'x' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const back = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_back')
  const r = await back.execute({ replyText: '' })
  assert.equal(r.ok, false)
  assert.equal(env.store.get('1').status, 'open', '仍待处理')
})

test('back：回话失败时工单不标记完成', async () => {
  const env = makeEnv()
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1001', raw: { message: [] } })
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'x' })
  // 让 sendSegments 抛错
  env.api.sendSegments = async () => { throw new Error('网关炸了') }
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const back = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_back')
  const r = await back.execute({ replyText: '试着回' })
  assert.equal(r.ok, false)
  assert.equal(env.store.get('1').status, 'open', '失败不标记完成')
})

// ---------- 存储 / md 镜像 ----------

test('工单写成 tickets.md（人可读表格）', async () => {
  const env = makeEnv()
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: '视频生成问题', submitterNickname: '小明' })
  const { readFileSync } = await import('node:fs')
  const md = readFileSync(join(env.dir, 'tickets.md'), 'utf8')
  assert.match(md, /工单列表/)
  assert.match(md, /#1/)
  assert.match(md, /视频生成问题/)
  assert.match(md, /群 44444444/)
})

test('hasMedia=true + 图片 mediaPaths 保存到 media/ 并发主人', async () => {
  const { writeFileSync } = await import('node:fs')
  const env = makeEnv()
  const src = join(env.dir, 'shot.png')
  writeFileSync(src, Buffer.from('fakeimg'))
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, mediaPaths: [src], summary: '发图报错，截图在这' })
  assert.equal(r.ok, true)
  const t = env.store.get('1')
  assert.equal(t.media.length, 1)
  assert.equal(t.media[0].kind, 'image')
  assert.ok(t.media[0].file, '图片已保存到 media')
  // 图片走（带 force 的）发图通道发给主人
  assert.ok(env.sentImages.length >= 1, '图片发给主人')
  assert.equal(env.sentImages[0].force, true, '图片带 force，不被睡眠/暂离拦下')
})

test('成功返回文案：已记成工单，无需再次提及', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: false, summary: 'x' })
  assert.equal(r.ok, true)
  assert.match(r.message, /已记成工单 #1/)
  assert.match(r.message, /无需再次提及/)
})

test('hasMedia=true：按 mediaPaths 逐个保存并发主人', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({
    hasMedia: true,
    summary: '附了两张图',
    mediaPaths: ['base64://aGVsbG8=', 'base64://d29ybGQ='],
  })
  assert.equal(r.ok, true)
  const t = env.store.get('1')
  assert.equal(t.media.length, 2, '两张都在')
  assert.ok(t.media.every((m) => m.file), '两条都保存到 media')
  // 两条都是 base64 无扩展名 → 按文件发（kind=file），不走 sendImage
  assert.ok(t.media.every((m) => m.kind === 'file'), '无扩展名按文件发')
  assert.ok(env.sentFiles.length >= 2, '两条都发给主人（按文件）')
})

test('hasMedia=false：不发附件（即使消息里有图）', async () => {
  const env = makeEnv()
  env.setCurrentMessage({
    kind: 'group',
    chatId: `group:${GROUP}`,
    userId: OTHER,
    groupId: GROUP,
    nickname: '小明',
    messageId: '1001',
    raw: { message: [{ type: 'image', data: { url: 'base64://b3JpZ2luYWw=' } }] },
  })
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: false, summary: '只是文字' })
  assert.equal(r.ok, true)
  assert.equal(env.store.get('1').media.length, 0, '不自动抓原消息附件')
  assert.equal(env.sentImages.length, 0)
  assert.equal(env.sentFiles.length, 0)
})

test('hasMedia=true 但 mediaPaths 为空被拒', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, summary: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.message, /mediaPaths/)
})

test('缺 hasMedia 被拒（必填）', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ summary: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.message, /hasMedia/)
})

test('mediaPaths 支持本机绝对路径（复制进 media）', async () => {
  const { writeFileSync } = await import('node:fs')
  const env = makeEnv()
  const src = join(env.dir, 'local-shot.png')
  writeFileSync(src, Buffer.from('fakeimg'))
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, summary: '本机截图', mediaPaths: [src] })
  assert.equal(r.ok, true)
  const t = env.store.get('1')
  assert.equal(t.media.length, 1)
  assert.equal(t.media[0].kind, 'image', '按扩展名识别为图片')
  assert.ok(t.media[0].file, '复制进 media 成功')
})

test('mediaPaths 无扩展名的本机文件：插件自动嗅探补 .png 并收单', async () => {
  const { writeFileSync } = await import('node:fs')
  const env = makeEnv()
  // 模拟对象存储哈希名：没有扩展名，内容是真 PNG 头——插件应自己识别成图片、补 .png
  const src = join(env.dir, '1b056a63742fbf3000a3d7cecbabee4e174b03d1061345')
  writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, summary: '无后缀截图', mediaPaths: [src] })
  assert.equal(r.ok, true, '不再因没后缀报错')
  const t = env.store.get('1')
  assert.equal(t.media[0].kind, 'image', '嗅探出是图片')
  assert.match(t.media[0].file, /\.png$/, '存盘文件名补上了 .png')
  assert.ok(env.sentImages.length >= 1, '按图片发给主人走 sendImage')
})

test('mediaPaths 无扩展名的本机文件：PDF 自动补 .pdf 并收单', async () => {
  const { writeFileSync } = await import('node:fs')
  const env = makeEnv()
  const src = join(env.dir, 'blob-without-ext')
  writeFileSync(src, Buffer.from('%PDF-1.7\n...'))
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, summary: '无后缀文档', mediaPaths: [src] })
  assert.equal(r.ok, true, '不再因没后缀报错')
  const t = env.store.get('1')
  assert.equal(t.media[0].kind, 'file')
  assert.match(t.media[0].file, /\.pdf$/, '存盘文件名补上了 .pdf')
})

test('mediaPaths 只给文件名（无路径）：按文件名在目录里找到实际文件', async () => {
  const { writeFileSync } = await import('node:fs')
  const env = makeEnv()
  // 真实文件在 cwd（测试 cwd = 模块目录），名字无后缀
  const name = 'shangxue-test-blob-' + Date.now()
  const real = join(process.cwd(), name + '.png')
  writeFileSync(real, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
  try {
    const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
    // 模型只给文件名（甚至故意给了错误的 .jpg 后缀），插件应能找到真实 .png
    const r = await tool.execute({ hasMedia: true, summary: '只给文件名', mediaPaths: [name + '.jpg'] })
    assert.equal(r.ok, true)
    const t = env.store.get('1')
    assert.ok(t.media[0].file, '找到并复制进 media')
    assert.match(t.media[0].file, /\.png$/, '按真实内容补成 .png')
    assert.equal(t.media[0].kind, 'image')
  } finally {
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(real) } catch (e) { /* ignore */ }
  }
})

test('mediaPaths 本机文件找不到：不阻断整单，但该条附件为空', async () => {
  const env = makeEnv()
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, summary: '文件丢了', mediaPaths: ['根本不存在的文件-abc'] })
  assert.equal(r.ok, true, '仍收单')
  const t = env.store.get('1')
  assert.equal(t.media.length, 1)
  assert.equal(t.media[0].file, '', '找不到就不存文件')
})


test('mediaPaths 带后缀的本机 PDF：正常收单', async () => {
  const { writeFileSync } = await import('node:fs')
  const env = makeEnv()
  const src = join(env.dir, 'doc.pdf')
  writeFileSync(src, Buffer.from('%PDF-1.7\n...'))
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({ hasMedia: true, summary: '带后缀的文档', mediaPaths: [src] })
  assert.equal(r.ok, true)
  assert.equal(env.store.get('1').media[0].kind, 'file')
})

test('mediaPaths 网络 URL 无后缀：允许（不报错）', async () => {
  const env = makeEnv()
  // 用一个明显无效的域名，fetch 会失败但要允许通过校验、先建单
  const tool = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  const r = await tool.execute({
    hasMedia: true,
    summary: '网图',
    mediaPaths: ['https://example.com/image/abc123'],
  })
  assert.equal(r.ok, true)
  assert.equal(env.store.get('1').media.length, 1)
})

// ---------- 删除工单 ----------
test('delete：按 ids 数组删一张或多张', async () => {
  const env = makeEnv({ perUserPerDay: 0 })
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'a' })
  await tell.execute({ hasMedia: false, summary: 'b' })
  await tell.execute({ hasMedia: false, summary: 'c' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const del = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_delete')
  const r = await del.execute({ ids: ['1', '3'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.deleted, ['1', '3'])
  assert.equal(env.store.get('1'), undefined)
  assert.equal(env.store.get('3'), undefined)
  assert.ok(env.store.get('2'), '未删的还在')
})

test('delete：拒绝空 ids（不能全部清空）', async () => {
  const env = makeEnv()
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'a' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const del = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_delete')
  const r = await del.execute({ ids: [] })
  assert.equal(r.ok, false)
  assert.ok(env.store.get('1'), '没删东西')
})

test('delete：删不存在的编号时报告 missing', async () => {
  const env = makeEnv()
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'a' })
  const ownerChat = privateChat({ userId: OWNER, chatId: `private:${OWNER}` })
  const del = env.toolNamed(ownerChat, 'full', 'shangxue_tell_owner_delete')
  const r = await del.execute({ ids: ['1', '99'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.deleted, ['1'])
  assert.deepEqual(r.missing, ['99'])
})

test('delete：群里没发起过工单的普通用户看不到删除工具', async () => {
  const env = makeEnv()
  assert.equal(env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner_delete'), undefined)
})

test('delete：发起人（本人）能看到并能删自己的工单', async () => {
  const env = makeEnv({ perUserPerDay: 0 })
  const tell = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'a' })
  await tell.execute({ hasMedia: false, summary: 'b' })
  // 同一个群里的发起人 OTHER，应能看到删除工具
  const del = env.toolNamed(groupChat(), 'social', 'shangxue_tell_owner_delete')
  assert.ok(del, '发起人看得到删除工具')
  const r = await del.execute({ ids: ['1'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.deleted, ['1'])
  assert.equal(env.store.get('1'), undefined)
})

test('delete：发起人只能删自己的，删别人的被拒', async () => {
  const env = makeEnv({ perUserPerDay: 0 })
  // OTHER 发了一张
  const tellOther = env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
  await tellOther.execute({ hasMedia: false, summary: 'OTHER的事' })
  // OTHER2 发了一张
  const tellOther2 = env.toolNamed(groupChat({ userId: OTHER2 }), 'social', 'shangxue_tell_owner')
  await tellOther2.execute({ hasMedia: false, summary: 'OTHER2的事' })
  // OTHER2 来删，试图删 OTHER 的 #1 和自己的 #2
  const del = env.toolNamed(groupChat({ userId: OTHER2 }), 'social', 'shangxue_tell_owner_delete')
  assert.ok(del, 'OTHER2 发过工单，看得到工具')
  const r = await del.execute({ ids: ['1', '2'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.deleted, ['2'])
  assert.deepEqual(r.forbidden, ['1'])
  assert.ok(env.store.get('1'), '别人的 #1 没被删')
  assert.equal(env.store.get('2'), undefined, '自己的 #2 删掉了')
})

test('delete：发起人只删别人的工单时整体被拒', async () => {
  const env = makeEnv({ perUserPerDay: 0 })
  // OTHER 发一张
  await env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner').execute({ hasMedia: false, summary: 'x' })
  // OTHER2 发一张（让自己能看到工具）
  await env.toolNamed(groupChat({ userId: OTHER2 }), 'social', 'shangxue_tell_owner').execute({ hasMedia: false, summary: 'y' })
  const del = env.toolNamed(groupChat({ userId: OTHER2 }), 'social', 'shangxue_tell_owner_delete')
  const r = await del.execute({ ids: ['1'] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.forbidden, ['1'])
  assert.ok(env.store.get('1'), '别人的工单没被删')
})

// ---------- 面板看板路由 ----------

test('面板 /board：按发起人聚合，含今日次数', async () => {
  const env = makeEnv({ perUserPerDay: 0 })
  env.setCurrentMessage({ kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, nickname: '小明', messageId: '1001' })
  await env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
    .execute({ hasMedia: false, summary: '语音模块坏了' })
  await env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
    .execute({ hasMedia: false, summary: '还有一个bug' })
  const board = env.routes.get('/board')
  assert.ok(board, '/board 已注册')
  const r = await board({})
  assert.equal(r.ok, true)
  assert.equal(r.rows.length, 1, '只有一位发起者')
  const row = r.rows[0]
  assert.equal(row.userId, OTHER)
  assert.equal(row.nickname, '小明')
  assert.equal(row.todayCount, 2)
  assert.equal(row.totalCount, 2)
  assert.match(row.groups, new RegExp(GROUP))
  assert.match(row.topics, /语音模块/)
})

test('面板 /reset：重置后今日次数归零（累计不变）', async () => {
  const env = makeEnv({ perUserPerDay: 0 })
  const tell = env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
  await tell.execute({ hasMedia: false, summary: 'a' })
  await tell.execute({ hasMedia: false, summary: 'b' })
  assert.equal((await env.routes.get('/board')({})).rows[0].todayCount, 2)

  env.setRouteBody({ userId: OTHER })
  const rr = await env.routes.get('/reset')({})
  assert.equal(rr.ok, true)

  const after = (await env.routes.get('/board')({})).rows[0]
  assert.equal(after.todayCount, 0, '重置后今日归零')
  assert.equal(after.totalCount, 2, '累计仍保留')
})

test('面板 /reset：缺 userId 报错', async () => {
  const env = makeEnv()
  env.setRouteBody({})
  const r = await env.routes.get('/reset')({})
  assert.equal(r.ok, false)
})

test('重置后每日限额也确实被放开', async () => {
  const env = makeEnv() // 默认每天 2 条
  const tell = env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
  assert.equal((await tell.execute({ hasMedia: false, summary: 'a' })).ok, true)
  assert.equal((await tell.execute({ hasMedia: false, summary: 'b' })).ok, true)
  assert.equal((await tell.execute({ hasMedia: false, summary: 'c' })).ok, false, '第 3 条被限额拦')
  // 重置后又能发
  env.setRouteBody({ userId: OTHER })
  await env.routes.get('/reset')({})
  assert.equal((await tell.execute({ hasMedia: false, summary: 'd' })).ok, true, '重置后放开限额')
})

test('面板 /set-limit：保存每天条数并夹在 1~10', async () => {
  const env = makeEnv()
  const setLimit = env.routes.get('/set-limit')
  assert.ok(setLimit, '/set-limit 已注册')

  env.setRouteBody({ perUserPerDay: 5 })
  const r5 = await setLimit({})
  assert.equal(r5.ok, true)
  assert.equal(r5.perUserPerDay, 5)
  assert.equal((await env.routes.get('/board')({})).perUserPerDay, 5, '看板读得到新值')

  env.setRouteBody({ perUserPerDay: 99 })
  assert.equal((await setLimit({})).perUserPerDay, 10, '上限夹到 10')

  env.setRouteBody({ perUserPerDay: 0 })
  assert.equal((await setLimit({})).perUserPerDay, 1, '下限夹到 1')

  env.setRouteBody({ perUserPerDay: 'abc' })
  const bad = await setLimit({})
  assert.equal(bad.ok, false, '非数字报错')
})

test('面板 /set-limit：调大限额后当场生效', async () => {
  const env = makeEnv({ perUserPerDay: 1 })
  const tell = env.toolNamed(groupChat({ userId: OTHER }), 'social', 'shangxue_tell_owner')
  assert.equal((await tell.execute({ hasMedia: false, summary: 'a' })).ok, true)
  assert.equal((await tell.execute({ hasMedia: false, summary: 'b' })).ok, false, '默认 1 条，第二条被拦')
  env.setRouteBody({ perUserPerDay: 3 })
  await env.routes.get('/set-limit')({})
  assert.equal((await tell.execute({ hasMedia: false, summary: 'c' })).ok, true, '调大后能继续发')
})
