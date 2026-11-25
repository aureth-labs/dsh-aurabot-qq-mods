// 自动回赞模块的离线测试：假 api、假 onebot，不连 QQ、不写文件。
// 跑法：AURABOT_PLUGIN_DIR=<插件源码> node --import ./scripts/plugin-env.mjs --test modules/autolike/test/autolike.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import plugin from '../index.mjs'

const MANIFEST = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
const OWNER = '3474662639'
const BOT = '3902393983'

function fakeApi({ settings = {} } = {}) {
  const calls = []
  const hooks = []
  const commands = []
  const logs = []
  const state = { enabled: true, times: 10, maxPerDay: 200, cooldownMin: 30, onlyOwner: false, ...settings }
  const api = {
    settings: () => ({ ...state }),
    saveSettings: (patch) => Object.assign(state, patch),
    config: () => ({ botQQ: BOT, ownerQQ: OWNER }),
    onebot: async (action, params) => { calls.push({ action, params }); return {} },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    on: (ev, fn) => hooks.push({ ev, fn }),
    command: (c) => commands.push(c),
  }
  return { api, calls, hooks, commands, logs, state }
}

const likeEvent = (uid, target = BOT) => ({ post_type: 'notice', notice_type: 'notify', sub_type: 'like', user_id: Number(uid), target_id: Number(target) })
const hookOf = (hooks, ev) => hooks.find((h) => h.ev === ev)

test('module.json 和模块本身对得上', () => {
  assert.equal(plugin.id, 'autolike')
  assert.equal(MANIFEST.id, 'autolike')
  assert.equal(plugin.version, MANIFEST.version, 'module.json 的版本要和 index.mjs 一致')
  assert.equal(plugin.api, MANIFEST.api)
  assert.equal(MANIFEST.category, 'social')
  assert.ok(plugin.settings.some((s) => s.key === 'times'))
  assert.ok(plugin.settings.some((s) => s.key === 'cooldownMin'))
})

test('有人赞我：悄悄回赞，发的下数按设置走', async () => {
  const { api, calls, hooks } = fakeApi({ settings: { times: 20 } })
  plugin.setup(api)
  await hookOf(hooks, 'onebot').fn(likeEvent('10000001'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'send_like')
  assert.equal(calls[0].params.user_id, 10000001)
  assert.equal(calls[0].params.times, 20)
})

test('赞的不是我：一句话都不动', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  await hookOf(hooks, 'onebot').fn(likeEvent('10000002', '123456'))
  assert.equal(calls.length, 0)
})

test('不是点赞的 notice 不处理', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  const hook = hookOf(hooks, 'onebot')
  await hook.fn({ post_type: 'notice', notice_type: 'group_increase', user_id: 10000003 })
  await hook.fn({ post_type: 'message', user_id: 10000003 })
  assert.equal(calls.length, 0)
})

test('同一个人冷却期内不重复回赞', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  const hook = hookOf(hooks, 'onebot')
  await hook.fn(likeEvent('10000004'))
  await hook.fn(likeEvent('10000004'))
  assert.equal(calls.length, 1, '第二次应该被冷却挡住')
})

test('关掉开关就什么都不做', async () => {
  const { api, calls, hooks } = fakeApi({ settings: { enabled: false } })
  plugin.setup(api)
  await hookOf(hooks, 'onebot').fn(likeEvent('10000005'))
  assert.equal(calls.length, 0)
})

test('只回爸爸的赞：别人的赞不理', async () => {
  const { api, calls, hooks } = fakeApi({ settings: { onlyOwner: true } })
  plugin.setup(api)
  const hook = hookOf(hooks, 'onebot')
  await hook.fn(likeEvent('10000006'))
  assert.equal(calls.length, 0)
  await hook.fn(likeEvent(OWNER))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.user_id, Number(OWNER))
})

test('说「赞我」就给他点，不接管消息', async () => {
  const { api, calls, hooks } = fakeApi({ settings: { times: 5 } })
  plugin.setup(api)
  const ret = await hookOf(hooks, 'message').fn({ userId: 10000007, text: '赞我' })
  assert.equal(ret, false, '照常回话')
  assert.equal(calls[0].action, 'send_like')
  assert.equal(calls[0].params.times, 5)
})

test('「别贪心」：今天已经回过赞的人再要，就不点了', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  await hookOf(hooks, 'onebot').fn(likeEvent('10000008'))
  const before = calls.length
  const ret = await hookOf(hooks, 'message').fn({ userId: 10000008, text: '赞我' })
  assert.equal(ret, '别贪心哦 已经给你点过赞了')
  assert.equal(calls.length, before, '不该再调 send_like')
})

test('不是「赞我」的话一律不管', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  const hook = hookOf(hooks, 'message')
  for (const text of ['你好', '赞我一下呗', '点个赞吧', '']) {
    const ret = await hook.fn({ userId: 10000009, text })
    assert.equal(ret, false)
  }
  assert.equal(calls.length, 0)
})

test('/赞我 指令点完如实回话', async () => {
  const { api, calls, commands } = fakeApi({ settings: { times: 10 } })
  plugin.setup(api)
  const cmd = commands.find((c) => c.name === '赞我')
  assert.ok(cmd, '要有 /赞我')
  const text = await cmd.run('', { userId: 10000010 })
  assert.equal(text, '给你点了 10 下')
  assert.equal(calls[0].params.times, 10)
})

test('/回赞 能看状态、也能改次数', async () => {
  const { api, commands, state } = fakeApi()
  plugin.setup(api)
  const cmd = commands.find((c) => c.name === '回赞')
  assert.ok(cmd, '要有 /回赞')
  assert.ok(String(cmd.run('')).includes('开着'))
  const text = cmd.run('30')
  assert.equal(state.times, 30)
  assert.ok(text.includes('30'))
})

test('一次超过 20 下：按 20 一批发', async () => {
  const { api, calls, hooks } = fakeApi({ settings: { times: 50 } })
  plugin.setup(api)
  await hookOf(hooks, 'onebot').fn(likeEvent('10000011'))
  assert.deepEqual(calls.map((c) => c.params.times), [20, 20, 10])
})

test('QQ 那边拒收：不抛错，只是停下', async () => {
  const { api, calls, hooks } = fakeApi()
  api.onebot = async (action, params) => { calls.push({ action, params }); throw new Error('点赞数无效') }
  plugin.setup(api)
  await hookOf(hooks, 'onebot').fn(likeEvent('10000012'))
  assert.equal(calls.length, 1, '第一批失败就别继续刷')
})
