import { test } from 'node:test'
import assert from 'node:assert/strict'
import mod from '../index.mjs'

const OWNER = '10000001'
const BOT = '20000002'
const OTHER = '30000003'
const GROUP = '44444444'

function makeEnv({ settings = {}, config = {}, answers = [] } = {}) {
  let current = {
    enabled: true,
    cooldownMinutes: 20,
    onlyOwner: false,
    emojis: '赞=128077\n笑哭=128514',
    ...settings,
  }
  const asked = []
  const calls = []
  const listeners = new Map()
  const queue = [...answers]
  const api = {
    settings: () => current,
    saveSettings: (patch) => { current = { ...current, ...patch } },
    config: () => ({ ownerQQ: OWNER, botQQ: BOT, dryRun: false, allow: { private: [OWNER], groups: [GROUP] }, ...config }),
    isOwner: (id) => String(id) === OWNER,
    ask: async (options) => {
      asked.push(options)
      return queue.length ? queue.shift() : '0'
    },
    onebot: async (action, params) => { calls.push({ action, params }) },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
  mod.setup(api)
  const emit = (payload) => Promise.all((listeners.get('message') || []).map((fn) => fn(payload)))
  return { emit, asked, calls, settings: () => current }
}

const message = (patch = {}) => ({
  kind: 'group', chatId: `group:${GROUP}`, userId: OTHER, groupId: GROUP, role: '',
  text: '早安，今天也要加油', messageId: '9001', nickname: '群友', ...patch,
})

test('早安这类消息交给模型判断，按编号贴表情', async () => {
  const env = makeEnv({ answers: ['2'] })
  await env.emit(message())
  assert.equal(env.asked.length, 1)
  assert.match(env.asked[0].system, /1\. 赞/)
  assert.match(env.asked[0].system, /早安/)
  assert.match(env.asked[0].text, /早安，今天也要加油/)
  assert.deepEqual(env.calls, [{ action: 'set_msg_emoji_like', params: { message_id: '9001', emoji_id: '128514' } }])
})

test('模型觉得不合适（0）就不贴，也不占用冷却', async () => {
  const env = makeEnv({ answers: ['0', '1'] })
  await env.emit(message({ text: '这个报错怎么解决' }))
  assert.equal(env.calls.length, 0)

  await env.emit(message({ text: '晚安', messageId: '9002' }))
  assert.equal(env.calls.length, 1, '上一条没贴成，下一条还能贴')
  assert.equal(env.calls[0].params.emoji_id, '128077')
})

test('模型输出乱码或越界时不贴', async () => {
  const env = makeEnv({ answers: ['我觉得挺好', '9', ''] })
  await env.emit(message())
  await env.emit(message({ messageId: '9002' }))
  await env.emit(message({ messageId: '9003' }))
  assert.equal(env.asked.length, 3, '每条都让模型看了')
  assert.equal(env.calls.length, 0)
})

test('命令、空消息、自己的消息都不处理', async () => {
  const env = makeEnv({ answers: ['1'] })
  await env.emit(message({ text: '#项目' }))
  await env.emit(message({ text: '   ' }))
  await env.emit(message({ userId: BOT }))
  assert.equal(env.asked.length, 0)
  assert.equal(env.calls.length, 0)
})

test('群不在白名单、私聊不在白名单都不看', async () => {
  const env = makeEnv({ answers: ['1'] })
  await env.emit(message({ groupId: '999', chatId: 'group:999' }))
  await env.emit(message({ kind: 'private', chatId: `private:${OTHER}`, groupId: '', userId: OTHER }))
  assert.equal(env.asked.length, 0)
})

test('主人私聊可以贴', async () => {
  const env = makeEnv({ answers: ['1'] })
  await env.emit(message({ kind: 'private', chatId: `private:${OWNER}`, groupId: '', userId: OWNER, messageId: '9100' }))
  assert.deepEqual(env.calls, [{ action: 'set_msg_emoji_like', params: { message_id: '9100', emoji_id: '128077' } }])
})

test('同一个群冷却期内直接跳过，不调模型', async () => {
  const env = makeEnv({ answers: ['1', '2'] })
  await env.emit(message({ messageId: '9201' }))
  await env.emit(message({ messageId: '9202', text: '晚安' }))
  assert.equal(env.calls.length, 1)
  assert.equal(env.asked.length, 1, '冷却期内连模型都不调')
})

test('只回应主人时群友不触发', async () => {
  const env = makeEnv({ settings: { onlyOwner: true }, answers: ['1'] })
  await env.emit(message())
  assert.equal(env.asked.length, 0)
})

test('试运行只记日志，不调用网关', async () => {
  const env = makeEnv({ config: { dryRun: true }, answers: ['1'] })
  await env.emit(message())
  assert.equal(env.asked.length, 1)
  assert.equal(env.calls.length, 0)
})

test('表情配置写坏了就不贴，也不调模型', async () => {
  const env = makeEnv({ settings: { emojis: '乱写\n=123\n赞=abc' }, answers: ['1'] })
  await env.emit(message())
  assert.equal(env.asked.length, 0)
  assert.equal(env.calls.length, 0)
})
