import { test } from 'node:test'
import assert from 'node:assert/strict'
import mod, { statusCard, uptimeText } from '../index.mjs'

function makeEnv(settingsPatch = {}, bare = false) {
  let own = bare ? {} : {
    enabled: true,
    triggers: '#sl',
    version: '2.4.2',
    platformPreset: 'MS-DOS',
    platformCustom: '',
    ...settingsPatch,
  }
  const replies = []
  const listeners = new Map()
  const api = {
    settings: () => own,
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
  mod.setup(api)
  const emit = (name, payload) => Promise.all((listeners.get(name) || []).map((fn) => fn(payload)))
  return { emit, replies, settings: () => own }
}

const message = (patch = {}) => ({ kind: 'group', chatId: 'group:1', userId: '10000001', text: '#sl', ...patch })

test('默认 #sl 回状态卡', async () => {
  const env = makeEnv()
  const result = await env.emit('message', message())
  assert.deepEqual(result, [true])
  assert.equal(env.replies.length, 1)
  assert.match(
    env.replies[0].text,
    /^SnowLuma 状态\n版本: 2\.4\.2\n平台: MS-DOS\n运行时长: \d+(秒|分\d+秒|小时\d+分|天\d+小时)$/,
  )
})

test('平台可以自定义', async () => {
  const env = makeEnv({ platformPreset: 'custom', platformCustom: 'MS-DOS 6.22' })
  await env.emit('message', message())
  assert.match(env.replies[0].text, /\n平台: MS-DOS 6\.22\n/)
})

test('平台选自定义但留空时按 MS-DOS', async () => {
  const env = makeEnv({ platformPreset: 'custom', platformCustom: '  ' })
  await env.emit('message', message())
  assert.match(env.replies[0].text, /\n平台: MS-DOS\n/)
})

test('触发词可以改，多个也能用', async () => {
  const env = makeEnv({ triggers: '/状态, #st' })
  await env.emit('message', message({ text: '/状态' }))
  await env.emit('message', message({ text: '#ST' }))
  await env.emit('message', message({ text: '#sl' }))
  assert.equal(env.replies.length, 2)
})

test('全角 ＃ 也算', async () => {
  const env = makeEnv()
  await env.emit('message', message({ text: '＃sl' }))
  assert.equal(env.replies.length, 1)
})

test('只认完全一致，带内容不接管', async () => {
  const env = makeEnv()
  const result = await env.emit('message', message({ text: '#sl 你好' }))
  assert.deepEqual(result, [false])
  assert.equal(env.replies.length, 0)
})

test('关掉后不回', async () => {
  const env = makeEnv({ enabled: false })
  await env.emit('message', message())
  assert.equal(env.replies.length, 0)
})

test('system / bot 消息忽略', async () => {
  const env = makeEnv()
  await env.emit('message', message({ kind: 'system' }))
  await env.emit('message', message({ kind: 'bot' }))
  assert.equal(env.replies.length, 0)
})

test('没有保存过设置时用默认值', async () => {
  const env = makeEnv({}, true)
  await env.emit('message', message())
  assert.match(env.replies[0].text, /^SnowLuma 状态\n版本: 2\.4\.2\n平台: MS-DOS\n/)
})

test('运行时长格式', () => {
  assert.equal(uptimeText(0), '0秒')
  assert.equal(uptimeText(56), '56秒')
  assert.equal(uptimeText(60), '1分0秒')
  assert.equal(uptimeText(3661), '1小时1分')
  assert.equal(uptimeText(90061), '1天1小时')
})

test('状态卡四行固定格式', () => {
  const card = statusCard({ version: '2.4.2', platformPreset: 'Windows 98' }, 56)
  assert.equal(card, 'SnowLuma 状态\n版本: 2.4.2\n平台: Windows 98\n运行时长: 56秒')
})
