import { test } from 'node:test'
import assert from 'node:assert/strict'
import mod from '../index.mjs'

const OWNER = '10000001'
const BOT = '20000002'
const OTHER = '30000003'
const STRANGER_GROUP = '44444444'

function makeEnv(patch = {}, settingsPatch = {}, bare = false) {
  let config = {
    ownerQQ: OWNER,
    botQQ: BOT,
    dryRun: false,
    allow: { private: [], groups: [] },
    ...patch,
  }
  let own = bare ? {} : {
    enabled: true,
    autoFriend: true,
    autoGroupInvite: true,
    autoGroupAdd: true,
    writeWhitelist: true,
    onlyBotInvite: true,
    slDefault: '在的，找你。',
    ...settingsPatch,
  }
  const calls = []
  const sent = []
  const replies = []
  const listeners = new Map()
  const api = {
    config: () => config,
    settings: () => own,
    saveSettings: (update) => { own = { ...own, ...update } },
    setConfig: (update) => {
      config = typeof update === 'function' ? update(config) : { ...config, ...update }
    },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    onebot: async (action, params) => {
      calls.push({ action, params })
      return {}
    },
    isOwner: (id) => String(id) === String(config.ownerQQ),
    send: async (chatId, text) => { sent.push({ chatId, text }) },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
  mod.setup(api)
  const emit = (name, payload) => Promise.all((listeners.get(name) || []).map((fn) => fn(payload)))
  return { emit, calls, sent, replies, settings: () => own, get config() { return config } }
}

const friendEvent = (flag = 'friend:1', userId = OTHER) => ({
  post_type: 'request', request_type: 'friend', flag, user_id: Number(userId), comment: '你好',
})

const groupEvent = (patch = {}) => ({
  post_type: 'request', request_type: 'group', sub_type: 'invite', flag: 'invite:1',
  user_id: Number(OTHER), group_id: Number(STRANGER_GROUP), invited_id: Number(BOT), ...patch,
})

const message = (patch = {}) => ({
  kind: 'private', chatId: `private:${OWNER}`, userId: OWNER, groupId: '', role: '',
  text: '', messageId: '1', nickname: '主人', ...patch,
})

test('好友申请自动通过并加入私聊白名单', async () => {
  const env = makeEnv()
  await env.emit('onebot', friendEvent())
  assert.deepEqual(env.calls, [{ action: 'set_friend_add_request', params: { flag: 'friend:1', approve: true } }])
  assert.deepEqual(env.config.allow.private, [OTHER])
  await env.emit('onebot', friendEvent())
  assert.equal(env.calls.length, 1, '同一个 flag 不重复处理')
})

test('群邀请自动通过并加入群白名单，但不处理别人收到的邀请', async () => {
  const env = makeEnv()
  await env.emit('onebot', groupEvent())
  assert.deepEqual(env.calls, [{ action: 'set_group_add_request', params: { flag: 'invite:1', sub_type: 'invite', approve: true } }])
  assert.deepEqual(env.config.allow.groups, [STRANGER_GROUP])

  await env.emit('onebot', groupEvent({ flag: 'invite:2', invited_id: Number(OTHER), group_id: 55555555 }))
  assert.equal(env.calls.length, 1, '邀请别人时不处理')
})

test('加群申请自动通过并加入群白名单', async () => {
  const env = makeEnv()
  await env.emit('onebot', groupEvent({ sub_type: 'add', flag: 'add:1', invited_id: undefined }))
  assert.deepEqual(env.calls, [{ action: 'set_group_add_request', params: { flag: 'add:1', sub_type: 'add', approve: true } }])
  assert.deepEqual(env.config.allow.groups, [STRANGER_GROUP])
})

test('试运行不调用网关、不改白名单', async () => {
  const env = makeEnv({ dryRun: true })
  await env.emit('onebot', friendEvent())
  await env.emit('onebot', groupEvent())
  assert.equal(env.calls.length, 0)
  assert.deepEqual(env.config.allow, { private: [], groups: [] })
})

test('#sl 只有主人能触发', async () => {
  const env = makeEnv({ allow: { private: [OWNER, OTHER], groups: [] } })
  const takeover = await env.emit('message', message({ kind: 'group', chatId: 'group:1', userId: OTHER, groupId: '1', text: '#sl 你好' }))
  assert.equal(takeover[0], true)
  assert.equal(env.sent.length, 0)
  assert.match(env.replies[0].text, /只有主人/)
})

test('主人 #sl 可以私聊白名单里的人', async () => {
  const env = makeEnv({ allow: { private: [OWNER, OTHER], groups: [] } })
  const takeover = await env.emit('message', message({ text: `#sl ${OTHER} 在吗` }))
  assert.equal(takeover[0], true)
  assert.deepEqual(env.sent, [{ chatId: `private:${OTHER}`, text: '在吗' }])
})

test('主人 #sl 不带号码时私聊自己', async () => {
  const env = makeEnv()
  await env.emit('message', message({ text: '#sl 你好' }))
  assert.deepEqual(env.sent, [{ chatId: `private:${OWNER}`, text: '你好' }])
})

test('不在白名单的目标不发送', async () => {
  const env = makeEnv()
  await env.emit('message', message({ text: `#sl ${OTHER} 你好` }))
  assert.equal(env.sent.length, 0)
  assert.match(env.replies[0].text, /不在私聊白名单/)
})

test('普通消息不接管', async () => {
  const env = makeEnv()
  const takeover = await env.emit('message', message({ text: '今天天气不错' }))
  assert.equal(takeover[0], false)
  assert.equal(env.sent.length, 0)
  assert.equal(env.replies.length, 0)
})

test('设置页开关：关掉好友自动通过', async () => {
  const env = makeEnv({}, { autoFriend: false })
  await env.emit('onebot', friendEvent())
  assert.equal(env.calls.length, 0)
  assert.deepEqual(env.config.allow.private, [])
})

test('设置页开关：关掉群邀请自动通过', async () => {
  const env = makeEnv({}, { autoGroupInvite: false })
  await env.emit('onebot', groupEvent())
  assert.equal(env.calls.length, 0)
  assert.deepEqual(env.config.allow.groups, [])
})

test('设置页开关：群邀请与别人的加群申请分开控制', async () => {
  const env = makeEnv({}, { autoGroupAdd: false })
  await env.emit('onebot', groupEvent({ sub_type: 'add', flag: 'add:1', invited_id: undefined }))
  assert.equal(env.calls.length, 0, '加群申请关着就不处理')

  await env.emit('onebot', groupEvent())
  assert.equal(env.calls.length, 1, '群邀请仍然按自己的开关处理')
  assert.deepEqual(env.calls[0].params, { flag: 'invite:1', sub_type: 'invite', approve: true })
})

test('设置页开关：不写白名单时只通过申请', async () => {
  const env = makeEnv({}, { writeWhitelist: false })
  await env.emit('onebot', friendEvent())
  await env.emit('onebot', groupEvent())
  assert.equal(env.calls.length, 2)
  assert.deepEqual(env.config.allow, { private: [], groups: [] })
})

test('设置页开关：允许处理别人被邀请的群', async () => {
  const env = makeEnv({}, { onlyBotInvite: false })
  await env.emit('onebot', groupEvent({ flag: 'invite:9', invited_id: Number(OTHER), group_id: 55555555 }))
  assert.deepEqual(env.calls, [{ action: 'set_group_add_request', params: { flag: 'invite:9', sub_type: 'invite', approve: true } }])
  assert.deepEqual(env.config.allow.groups, ['55555555'])
})

test('设置页开关：整体关掉后申请和 #sl 都不响应', async () => {
  const env = makeEnv({}, { enabled: false })
  await env.emit('onebot', friendEvent())
  await env.emit('onebot', groupEvent())
  const takeover = await env.emit('message', message({ text: '#sl 你好' }))
  assert.equal(env.calls.length, 0)
  assert.equal(env.sent.length, 0)
  assert.equal(takeover[0], false)
})

test('设置页：自定义 #sl 默认内容', async () => {
  const env = makeEnv({}, { slDefault: '听到啦' })
  await env.emit('message', message({ text: '#sl' }))
  assert.deepEqual(env.sent, [{ chatId: `private:${OWNER}`, text: '听到啦' }])
})

test('默认安装后不自动通过任何申请', async () => {
  const env = makeEnv({}, {}, true)
  assert.equal(env.settings().enabled, false)
  assert.equal(env.settings().autoFriend, false)
  assert.equal(env.settings().autoGroupInvite, false)
  assert.equal(env.settings().autoGroupAdd, false)
  assert.equal(env.settings().writeWhitelist, false)
  await env.emit('onebot', friendEvent())
  await env.emit('onebot', groupEvent())
  await env.emit('onebot', groupEvent({ sub_type: 'add', flag: 'add:1', invited_id: undefined }))
  assert.equal(env.calls.length, 0)
  assert.deepEqual(env.config.allow, { private: [], groups: [] })
})
