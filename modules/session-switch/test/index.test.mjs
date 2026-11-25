// 会话切换的自查测试：不联网、不需要插件环境，用 mock api 把权限门和两条投递路径钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'
import { MARK } from '../lib/relay.mjs'

const OWNER = '3153882572'
const FRIEND = '792517684'
const GROUP = '170625223'

const dir = mkdtempSync(join(tmpdir(), 'session-switch-test-'))
const pushes = []
const delivers = []
const sentTexts = []
const toolFns = []
let lastText = ''
let settings = {}

const baseSettings = () => ({ allowOthers: false, cooldownSec: 0, maxPerHour: 200 })

const hub = {
  sessions: () => ({
    [`private:${OWNER}`]: { sessionId: 's-owner', createdAt: 3 },
    [`private:${FRIEND}`]: { sessionId: 's-friend', createdAt: 2 },
    [`group:${GROUP}`]: { sessionId: 's-group', createdAt: 1 },
  }),
  // 只有主人私聊这一轮算「全主人」
  turnSendersAllOwner: (sid) => sid === 's-owner',
  turnSenders: () => [OWNER],
  lastTextOf: () => lastText,
  groupName: async (gid) => (String(gid) === GROUP ? '大肥鱼' : ''),
  deliver: async (chatId, text, opts) => {
    delivers.push({ chatId, text, opts })
    return { message_id: 'm-deliver' }
  },
  pushToSession: async (chat, content, senderId, opts) => {
    pushes.push({ chat, content, senderId, opts })
  },
  sendText: async (chatId, text) => {
    sentTexts.push({ chatId, text })
    return { message_id: 'm-send' }
  },
}

const api = {
  dataDir: () => dir,
  config: () => ({ ownerQQ: OWNER, allow: { private: [FRIEND], groups: [GROUP] } }),
  settings: () => settings,
  saveSettings() {},
  log: { info() {}, warn() {}, error() {} },
  tool: (fn) => toolFns.push(fn),
  defineTool: (p) => p,
  rule() {},
  lesson() {},
  command() {},
  on() {},
  onebot: async () => [],
  use: (name) =>
    name === 'memory'
      ? {
          chats: () => [
            { chatId: `group:${GROUP}`, vibe: '很热闹，常半夜聊天', topics: '游戏、外卖', impression: '一群人互相接梗' },
          ],
          profiles: () => [{ qq: FRIEND, name: '王总', text: '做建材生意的，话不多', style: '说话很简短' }],
          gists: () => [],
        }
      : null,
  core: { hub },
}

mod.setup(api)

const chatOf = (chatId) =>
  chatId.startsWith('group:')
    ? { chatId, kind: 'group', groupId: chatId.slice(6) }
    : { chatId, kind: 'private', userId: chatId.slice(8) }

const toolsFor = (chatId, sessionId) => toolFns[0]({ chat: chatOf(chatId), sessionId })
const toolOf = (list, name) => list.find((t) => t.name === name)

test.after(() => rmSync(dir, { recursive: true, force: true }))

test.beforeEach(() => {
  pushes.length = 0
  delivers.length = 0
  sentTexts.length = 0
  lastText = ''
  settings = baseSettings()
})

test('主人私聊：清单带印象、带 QQ 号；工具齐全', async () => {
  const tools = toolsFor(`private:${OWNER}`, 's-owner')
  assert.deepEqual(tools.map((t) => t.name).sort(), ['session_switch_list', 'session_switch_remember', 'session_switch_tell'])

  const r = await toolOf(tools, 'session_switch_list').execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /小档案/)
  assert.match(r.message, /气氛/)
  assert.match(r.message, /private:/)
})

test('非主人（群里别人说话）：没有印象、没有 QQ 号，也记不了称呼', async () => {
  settings = { ...baseSettings(), allowOthers: true }
  const tools = toolsFor(`group:${GROUP}`, 's-group-other')
  assert.ok(!toolOf(tools, 'session_switch_remember'), '非主人不该挂 remember')
  const r = await toolOf(tools, 'session_switch_list').execute({})
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.message, /小档案|气氛|说话很简短/, '非主人不该看到对别人的印象')
  assert.doesNotMatch(r.message, /private:\d+/, '非主人不该看到私聊的 QQ 号')
})

test('allowOthers 默认关：别人这一轮干脆没有工具', () => {
  const tools = toolsFor(`group:${GROUP}`, 's-group-other')
  assert.deepEqual(tools, [])
})

test('别人 compose 进主人私聊：拒绝，并要求改 direct', async () => {
  settings = { ...baseSettings(), allowOthers: true }
  const tools = toolsFor(`group:${GROUP}`, 's-group-other')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: 'owner', content: '明天那个会我不去了', mode: 'compose' })
  assert.equal(r.ok, false)
  assert.match(r.message, /direct/)
  assert.equal(pushes.length, 0, '不该叫醒主人私聊')
  assert.equal(delivers.length, 0, '也不该偷偷直发')
})

test('别人 direct 进主人私聊：走 hub.deliver（受治理路径），own:false', async () => {
  settings = { ...baseSettings(), allowOthers: true }
  const tools = toolsFor(`group:${GROUP}`, 's-group-other')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: 'owner', content: '明天那个会我不去了', mode: 'direct' })
  assert.equal(r.ok, true)
  assert.equal(delivers.length, 1)
  assert.equal(delivers[0].chatId, `private:${OWNER}`)
  assert.equal(delivers[0].opts.own, false)
  assert.equal(pushes.length, 0)
})

test('compose 进主人私聊一律拒绝：只能 direct 过出站策略', async () => {
  // 这一轮是主人在群里开口（isOwner），但目标仍是主人私聊 → 不许叫醒那边
  const tools = toolsFor(`group:${GROUP}`, 's-owner')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: 'owner', content: '提醒我明天带伞', mode: 'compose' })
  assert.equal(r.ok, false)
  assert.match(r.message, /direct/)
  assert.equal(pushes.length, 0)
  assert.equal(delivers.length, 0)
})

test('主人 direct 进主人私聊：走 hub.deliver', async () => {
  const tools = toolsFor(`group:${GROUP}`, 's-owner')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: 'owner', content: '提醒我明天带伞', mode: 'direct' })
  assert.equal(r.ok, true)
  assert.equal(delivers.length, 1)
  assert.equal(delivers[0].chatId, `private:${OWNER}`)
})

test('主人私聊 compose 到别的私聊：允许叫醒那边会话', async () => {
  const tools = toolsFor(`private:${OWNER}`, 's-owner')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: `private:${FRIEND}`, content: '跟他说周末去钓鱼', mode: 'compose' })
  assert.equal(r.ok, true)
  assert.equal(pushes.length, 1)
  assert.match(pushes[0].opts.queryText, new RegExp(MARK))
})

test('防接力：这一轮本身是从别处带过来的，就不再往外带', async () => {
  lastText = `${MARK} · 来自群「大肥鱼」】…`
  const tools = toolsFor(`private:${OWNER}`, 's-owner')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: `private:${FRIEND}`, content: '再说一遍', mode: 'compose' })
  assert.equal(r.ok, false)
  assert.match(r.message, /别往外再带/)
  assert.equal(pushes.length, 0)
  assert.equal(delivers.length, 0)
})

test('认不出时把清单发到聊天里，不直接往外带', async () => {
  settings = { ...baseSettings(), allowOthers: true }
  const tools = toolsFor(`group:${GROUP}`, 's-group-other')
  const r = await toolOf(tools, 'session_switch_tell').execute({ target: '张总', content: '明天的会改到三点', mode: 'compose' })
  assert.equal(r.ok, true)
  assert.equal(sentTexts.length, 1, '清单要用 sendText 整条发到聊天里')
  assert.match(sentTexts[0].text, /回个序号/)
  assert.equal(pushes.length, 0)
})
