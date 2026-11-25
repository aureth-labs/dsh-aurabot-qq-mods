// 群管模块的离线测试：不连 QQ、不写文件、不起 PowerShell。
// 跑法：AURABOT_PLUGIN_DIR=<插件源码> node --import ./scripts/plugin-env.mjs --test modules/group-admin/test/group-admin.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import plugin, { CMD, matchCommand } from '../index.mjs'

const MANIFEST = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))

const OWNER = '3474662639'
const GROUP = '963692025'

/** 假 api：只记调用，不碰真实 QQ。 */
function fakeApi({ extraWhitelist = '', dryRun = false, role = 'admin' } = {}) {
  const calls = []
  const hooks = []
  const commands = []
  const routes = []
  const tools = []
  const settings = { extraWhitelist }
  const api = {
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    config: () => ({ ownerQQ: OWNER, allow: { groups: [GROUP] }, dryRun }),
    core: {
      hub: { groupName: async () => 'test', turnHasOwner: () => true, turnSenders: () => [OWNER] },
      onebot: { call: async (action, params) => { calls.push({ action, params }); return {} } },
      groupRoles: {
        peek: () => role,
        get: async () => role,
        canManage: (r) => r === 'owner' || r === 'admin',
        label: (r) => ({ owner: '群主', admin: '管理员', member: '成员' }[r] || r),
      },
    },
    context: () => {},
    on: (ev, fn) => hooks.push({ ev, fn }),
    command: (c) => commands.push(c),
    tool: (fn) => tools.push(fn),
    route: (path) => routes.push(path),
  }
  return { api, calls, hooks, commands, routes, tools, settings }
}

const groupMsg = (text, userId = OWNER) => ({ kind: 'group', groupId: GROUP, userId, text })

test('module.json 和模块本身对得上', () => {
  assert.equal(plugin.id, 'group-admin')
  assert.equal(MANIFEST.id, 'group-admin')
  assert.equal(plugin.version, MANIFEST.version, 'module.json 的版本要和 index.mjs 一致')
  assert.equal(plugin.api, MANIFEST.api)
  assert.equal(MANIFEST.category, 'manage')
  assert.ok(plugin.settings.some((s) => s.key === 'extraWhitelist'))
})

test('一句话指令：全体禁言和关全体禁言都认得', () => {
  assert.equal(matchCommand('全体禁言').action, 'wholeban')
  assert.equal(matchCommand('开启全体禁言').action, 'wholeban')
  assert.equal(matchCommand('全员禁言').action, 'wholeban')
  assert.equal(matchCommand('关闭全体禁言').action, 'wholeoff')
  assert.equal(matchCommand('解除全员禁言').action, 'wholeoff')
})

test('一句话指令：禁言 / 解禁 / 踢人 / 改头衔 / 发公告 / 白名单', () => {
  assert.equal(matchCommand('禁言 小明').action, 'ban')
  assert.equal(matchCommand('禁言 小明 30 分钟').m[2], '30')
  assert.equal(matchCommand('解禁 @小明').action, 'unban')
  // @ 目标：QQ 里 @ 会渲染成「@名字 」，名字本身也可能带空格（1.1.1）
  assert.equal(matchCommand('禁言 @小明 10').m[1], '@小明')
  assert.equal(matchCommand('禁言 @小明 10').m[2], '10')
  assert.equal(matchCommand('禁言 @小明 10分钟').m[2], '10')
  assert.equal(matchCommand('禁言 @小 明 30分钟').m[1], '@小 明')
  assert.equal(matchCommand('解禁 @小 明').m[2], '@小 明')
  assert.equal(matchCommand('踢人 @小明').m[2], '@小明')
  assert.equal(matchCommand('禁言 @小明').m[2], undefined)
  assert.equal(matchCommand('踢了 小明').action, 'kick')
  const title = matchCommand('改头衔 小明 摸鱼的')
  assert.equal(title.action, 'title')
  assert.equal(title.m[3], '摸鱼的')
  assert.equal(matchCommand('发公告 明天休息一天').m[2], '明天休息一天')
  assert.equal(matchCommand('添加白名单 123456').action, 'wladd')
  assert.equal(matchCommand('移除白名单 @小明').action, 'wldel')
  assert.equal(matchCommand('查看白名单').action, 'wllist')
})

test('不是指令的话一句都不认', () => {
  for (const text of ['你好呀', '今天吃什么', '禁言', '全体禁言吗', '', '   ']) {
    assert.equal(matchCommand(text), null, `「${text}」不该被当成指令`)
  }
  assert.equal(matchCommand('x'.repeat(80)), null, '太长的句子不认')
})

test('主人说全体禁言：真的调 set_group_whole_ban', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  assert.ok(hooks.some((h) => h.ev === 'message'), '要挂上消息钩子')
  const hook = hooks.find((h) => h.ev === 'message')
  const ret = await hook.fn(groupMsg('全体禁言'))
  assert.equal(ret, false, '不接管这条消息')
  const call = calls.find((c) => c.action === 'set_group_whole_ban')
  assert.ok(call, '要调用 set_group_whole_ban')
  assert.equal(call.params.group_id, Number(GROUP))
  assert.equal(call.params.enable, true)
  assert.ok(calls.some((c) => c.action === 'send_group_msg'), '要回一句')
})

test('关闭全体禁言：enable 是 false', async () => {
  const { api, calls, hooks } = fakeApi({ role: 'owner' })
  plugin.setup(api)
  await hooks.find((h) => h.ev === 'message').fn(groupMsg('关闭全体禁言'))
  const call = calls.find((c) => c.action === 'set_group_whole_ban')
  assert.equal(call.params.enable, false)
})

test('不在白名单里的人说指令：一句话都不动', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  const ret = await hooks.find((h) => h.ev === 'message').fn(groupMsg('全体禁言', '10000001'))
  assert.equal(ret, false)
  assert.equal(calls.length, 0, '不该有任何 OneBot 调用')
})

test('白名单里的人（非主人）也能发指令', async () => {
  const { api, calls, hooks } = fakeApi({ extraWhitelist: '10000002' })
  plugin.setup(api)
  await hooks.find((h) => h.ev === 'message').fn(groupMsg('全体禁言', '10000002'))
  assert.ok(calls.some((c) => c.action === 'set_group_whole_ban'))
})

test('对主人不能禁言、不能踢', async () => {
  const { api, calls, hooks } = fakeApi()
  plugin.setup(api)
  const hook = hooks.find((h) => h.ev === 'message')
  await hook.fn(groupMsg(`禁言 ${OWNER} 10`))
  await hook.fn(groupMsg(`踢人 ${OWNER}`))
  assert.equal(calls.filter((c) => c.action === 'set_group_ban').length, 0)
  assert.equal(calls.filter((c) => c.action === 'set_group_kick').length, 0)
})

test('试运行模式什么都别真做', async () => {
  const { api, calls, hooks } = fakeApi({ dryRun: true })
  plugin.setup(api)
  await hooks.find((h) => h.ev === 'message').fn(groupMsg('全体禁言'))
  assert.equal(calls.filter((c) => c.action === 'set_group_whole_ban').length, 0)
})

test('群管白名单指令：加人 / 移人 / 看名单', async () => {
  const { api, hooks, settings } = fakeApi()
  plugin.setup(api)
  const hook = hooks.find((h) => h.ev === 'message')
  await hook.fn(groupMsg('添加白名单 10000003'))
  assert.equal(settings.extraWhitelist.trim(), '10000003')
  await hook.fn(groupMsg('添加白名单 10000004'))
  assert.deepEqual(settings.extraWhitelist.split('\n').sort(), ['10000003', '10000004'])
  await hook.fn(groupMsg('移除白名单 10000003'))
  assert.equal(settings.extraWhitelist.trim(), '10000004')
})

test('/群管功能 列出全部指令', () => {
  const { api, commands } = fakeApi()
  plugin.setup(api)
  const cmd = commands.find((c) => c.name === '群管功能')
  assert.ok(cmd, '要有 /群管功能')
  const text = cmd.run()
  for (const word of ['全体禁言', '禁言', '解禁', '踢人', '改头衔', '发公告', '白名单']) {
    assert.ok(text.includes(word), `帮助里要提到${word}`)
  }
})

const toolFrom = (tools, where) => {
  const res = tools[0](where)
  if (!res) return []
  return Array.isArray(res) ? res : [res]
}

test('工具只在群里或主人私聊里出现，动作里有全体禁言', () => {
  const { api, tools } = fakeApi()
  plugin.setup(api)
  assert.equal(tools.length, 1, '要注册一个工具')
  assert.deepEqual(toolFrom(tools, { chat: { kind: 'private' }, level: 'mention' }), [], '别的私聊里不给工具')
  const list = toolFrom(tools, { chat: { kind: 'group', groupId: GROUP }, level: 'full', sessionId: 's1' })
  assert.equal(list.length, 1)
  const tool = list[0]
  assert.equal(tool.name, 'qq_group_admin')
  assert.ok(tool.parameters.properties.action.enum.includes('wholeban'))
  assert.ok(tool.parameters.properties.action.enum.includes('wholeoff'))
})

test('工具执行时也会挡住非主人', async () => {
  const { api, tools } = fakeApi()
  plugin.setup(api)
  api.core.hub.turnHasOwner = () => false
  api.core.hub.turnSenders = () => ['10000009']
  const tool = toolFrom(tools, { chat: { kind: 'group', groupId: GROUP }, level: 'group', sessionId: 's2' })[0]
  const r = await tool.execute({ action: 'wholeban' })
  assert.equal(r.ok, false)
})

test('群友和主人同一轮被合并：不能借主人的话调群管', async () => {
  const { api, tools, calls } = fakeApi()
  plugin.setup(api)
  api.core.hub.turnHasOwner = () => true // 这一轮确实有主人说过话
  api.core.hub.turnSenders = () => [OWNER, '10000010'] // 但还有群友
  const tool = toolFrom(tools, { chat: { kind: 'group', groupId: GROUP }, level: 'group', sessionId: 's3' })[0]
  const r = await tool.execute({ action: 'wholeban' })
  assert.equal(r.ok, false, '同一轮里有非白名单的人，就不能放行')
  assert.equal(calls.filter((c) => c.action === 'set_group_whole_ban').length, 0)
})

test('只有一个人说话、而且是白名单里的人：放行', async () => {
  const { api, tools, calls } = fakeApi({ extraWhitelist: '10000011' })
  plugin.setup(api)
  api.core.hub.turnHasOwner = () => false
  api.core.hub.turnSenders = () => ['10000011']
  const tool = toolFrom(tools, { chat: { kind: 'group', groupId: GROUP }, level: 'group', sessionId: 's4' })[0]
  const r = await tool.execute({ action: 'wholeban' })
  assert.equal(r.ok, true)
  assert.equal(calls.filter((c) => c.action === 'set_group_whole_ban').length, 1)
})

test('这一轮没人说话（空名单）：不放行', async () => {
  const { api, tools } = fakeApi()
  plugin.setup(api)
  api.core.hub.turnHasOwner = () => true
  api.core.hub.turnSenders = () => []
  const tool = toolFrom(tools, { chat: { kind: 'group', groupId: GROUP }, level: 'group', sessionId: 's5' })[0]
  const r = await tool.execute({ action: 'wholeban' })
  assert.equal(r.ok, false)
})

test('CMD 表里没有重复的动作写法', () => {
  const seen = new Set()
  for (const c of CMD) {
    const key = `${c.re.source}|${c.action}`
    assert.ok(!seen.has(key))
    seen.add(key)
  }
})
