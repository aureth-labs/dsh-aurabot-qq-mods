// 工作群的纯逻辑测试：判定规则、白名单解析、扫描间隔下限。
// 全部离线——不连 QQ、不写文件、不装任何依赖。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import mod, { digits, parseWhitelist, isWorkGroupMembers, scanInterval } from '../index.mjs'

const OWNER = '10001'
const BOT = '20002'

// 和 setup 里构造 allowed 的方式一致
const allowedOf = (...extra) => new Set([...extra.map(digits), OWNER, BOT].filter(Boolean))

test('清单字段和宿主入口对得上', () => {
  assert.equal(mod.id, 'workgroup')
  assert.equal(mod.api, 1)
  assert.match(mod.version, /^\d+\.\d+\.\d+$/)
  assert.equal(typeof mod.setup, 'function')
})

test('源码里没有任何 QQ 号硬编码', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  // 白名单默认值必须是空的，不能带真实号码
  assert.equal(mod.defaults.whitelist, '')
  // 5 位以上的连续数字串 = 疑似 QQ 号
  const hits = src.match(/(?<!\d)\d{6,11}(?!\d)/g) || []
  // 只允许出现在注释外的技术常量（这里一个都不该有）
  assert.deepEqual(hits, [], `源码里出现了疑似 QQ 号：${hits.join(', ')}`)
})

test('digits 只留数字', () => {
  assert.equal(digits(' 123-456 '), '123456')
  assert.equal(digits(123456), '123456')
  assert.equal(digits(null), '')
  assert.equal(digits(undefined), '')
})

test('白名单：多种分隔符、去重、太短的丢掉', () => {
  assert.deepEqual(parseWhitelist('10001\n20002'), ['10001', '20002'])
  assert.deepEqual(parseWhitelist('10001,20002，30003;40004；50005'), ['10001', '20002', '30003', '40004', '50005'])
  assert.deepEqual(parseWhitelist('10001 10001  20002'), ['10001', '20002'])
  // 长度 < 5 的不是 QQ 号
  assert.deepEqual(parseWhitelist('1234\n10001'), ['10001'])
  assert.deepEqual(parseWhitelist(''), [])
  assert.deepEqual(parseWhitelist(null), [])
})

test('全员自己人的群才判成工作群', () => {
  const allowed = allowedOf('30003', '40004')
  // 主人 + 两个白名单成员 + 机器人自己
  assert.equal(isWorkGroupMembers(['10001', '30003', '40004', '20002'], allowed, OWNER), true)
  // 混进一个名单外的人
  assert.equal(isWorkGroupMembers(['10001', '30003', '99999'], allowed, OWNER), false)
  // 主人不在群里
  assert.equal(isWorkGroupMembers(['30003', '40004'], allowed, OWNER), false)
  // 读不到成员
  assert.equal(isWorkGroupMembers([], allowed, OWNER), false)
  assert.equal(isWorkGroupMembers(null, allowed, OWNER), false)
  // ownerQQ 没配置
  assert.equal(isWorkGroupMembers(['10001', '30003'], allowed, ''), false)
})

test('只有主人一个人的群也算工作群', () => {
  const allowed = allowedOf()
  assert.equal(isWorkGroupMembers(['10001', '20002'], allowed, OWNER), true)
})

test('机器人自己的号不需要写进白名单', () => {
  const allowed = allowedOf('30003')
  assert.equal(isWorkGroupMembers(['10001', '20002', '30003'], allowed, OWNER), true)
})

test('成员表里有脏数据时按数字比较', () => {
  const allowed = allowedOf('30003')
  assert.equal(isWorkGroupMembers(['10001', ' 30003 ', '', null], allowed, OWNER), true)
  assert.equal(isWorkGroupMembers([10001, 30003], allowed, OWNER), true)
})

test('扫描间隔有下限，非法值回默认', () => {
  assert.equal(scanInterval(120), 120)
  assert.equal(scanInterval(5), 30) // 太小会频繁打网关
  assert.equal(scanInterval(0), 120) // 0 当没填
  assert.equal(scanInterval(''), 120)
  assert.equal(scanInterval(null), 120)
  assert.equal(scanInterval('60'), 60)
})

test('默认值是安全的：不开工具、跟随全局模型', () => {
  assert.equal(mod.defaults.enabled, true)
  assert.equal(mod.defaults.grantOwnerTools, true)
  assert.equal(mod.defaults.syncWorkGroups, true)
  assert.equal(mod.defaults.provider, '')
  assert.equal(mod.defaults.model, '')
  assert.equal(mod.defaults.reasoningEffort, '')
})

test('setup 是幂等可挂载的：只依赖 api 上文档里有的方法', async () => {
  const calls = { every: [], on: [], rule: [], context: [], command: [], config: [], setConfig: [] }
  const api = {
    config: () => {
      calls.config.push(1)
      return { ownerQQ: OWNER, botQQ: BOT, group: {}, allow: { groups: [] } }
    },
    setConfig: async (patch) => void calls.setConfig.push(patch),
    settings: () => ({ ...mod.defaults }),
    dataDir: 'x',
    log: { info() {}, warn() {}, error() {} },
    every: (ms, fn, name) => void calls.every.push({ ms, name }),
    on: (name, fn) => void calls.on.push(name),
    rule: (fn) => void calls.rule.push(fn),
    context: (fn) => void calls.context.push(fn),
    command: (c) => void calls.command.push(c.name),
    emit() {},
    core: {
      onebot: {
        state: 'disconnected', // 断线时不扫，测试因此不会真的发请求
        call: async () => {
          throw new Error('测试里不该真的调网关')
        },
      },
    },
  }
  const handle = await mod.setup(api)
  assert.equal(typeof handle.list, 'function')
  assert.equal(typeof handle.rescan, 'function')
  assert.deepEqual(handle.list(), [])

  // 挂上的东西得是这几样
  assert.deepEqual(calls.every.map((e) => e.name), ['workgroup-scan'])
  assert.equal(calls.every[0].ms, 20_000)
  assert.deepEqual([...new Set(calls.on)].sort(), ['group/decide', 'model', 'reply', 'reply/items', 'send'])
  assert.equal(calls.rule.length, 1)
  assert.equal(calls.context.length, 1)
  assert.deepEqual(calls.command, ['工作群'])

  // 断线时启动那次扫描应该什么都不做
  assert.deepEqual(calls.setConfig, [])
})

test('规则只在需要时才吐内容', async () => {
  const rules = []
  const api = {
    config: () => ({ ownerQQ: OWNER, botQQ: BOT, group: {}, allow: { groups: [] } }),
    setConfig: async () => {},
    settings: () => ({ ...mod.defaults }),
    log: { info() {}, warn() {}, error() {} },
    every() {},
    on() {},
    rule: (fn) => rules.push(fn),
    context() {},
    command() {},
    emit() {},
    core: { onebot: { state: 'disconnected', call: async () => ({}) } },
  }
  await mod.setup(api)
  // 还没扫出任何群：任何档都不吐规则
  assert.equal(rules[0]('social', {}), '')
  assert.equal(rules[0]('group-owner', {}), '')
  assert.equal(rules[0]('workgroup', {}), '')
})

// 判出一个工作群需要网关配合：这里用假的群列表 + 成员表顶替，全程离线
const WORK_GID = '50001'
const OTHER_GID = '50002'
function apiWithGroups({ setConfig = [], handlers = {} } = {}) {
  const state = { workGroups: [] }
  const api = {
    config: () => ({ ownerQQ: OWNER, botQQ: BOT, group: { workGroups: state.workGroups }, allow: { groups: [] } }),
    setConfig: async (patch) => {
      setConfig.push(patch)
      if (patch?.group?.workGroups) state.workGroups = patch.group.workGroups
    },
    settings: () => ({ ...mod.defaults, whitelist: '30003' }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    every() {},
    on: (name, fn) => void (handlers[name] = fn),
    rule() {},
    context() {},
    command() {},
    emit() {},
    core: {
      onebot: {
        state: 'connected',
        call: async (action, params) => {
          if (action === 'get_group_list') return [{ group_id: WORK_GID }, { group_id: OTHER_GID }]
          if (action === 'get_group_member_list') {
            // OTHER_GID 混了一个名单外的人，所以它不该被判成工作群
            const extra = String(params?.group_id) === OTHER_GID ? [{ user_id: 99999 }] : []
            return [{ user_id: OWNER }, { user_id: 30003 }, { user_id: BOT }, ...extra]
          }
          return {}
        },
      },
    },
  }
  return api
}

test('判定结果会同步进 group.workGroups', async () => {
  const setConfig = []
  const api = apiWithGroups({ setConfig })
  const handle = await mod.setup(api)
  // 只有成员全在自己人里的那个群算工作群；混了外人的不算
  assert.deepEqual(handle.list(), [WORK_GID])
  const wg = setConfig.find((p) => p?.group?.workGroups)
  assert.ok(wg, '应该写了一次 group.workGroups')
  assert.deepEqual(wg.group.workGroups, [WORK_GID])
})

test('工作群里表情被摘掉，别的群一个字不动', async () => {
  const handlers = {}
  const api = apiWithGroups({ handlers })
  await mod.setup(api)
  const items = [
    { kind: 'text', value: '做完了' },
    { kind: 'sticker', value: '某张表情' },
  ]
  // 工作群：表情段被摘掉，文字留下
  const kept = handlers['reply/items'](items, { chatId: `group:${WORK_GID}`, text: '做完了' })
  assert.deepEqual(kept, [{ kind: 'text', value: '做完了' }])
  // 没有表情时返回 undefined（等于不改，别白白复制一遍）
  assert.equal(handlers['reply/items']([{ kind: 'text', value: '嗯' }], { chatId: `group:${WORK_GID}` }), undefined)
  // 不在名单里的群 / 私聊：原样放过去
  assert.equal(handlers['reply/items'](items, { chatId: `group:${OTHER_GID}` }), undefined)
  assert.equal(handlers['reply/items'](items, { chatId: `private:${OWNER}` }), undefined)
  // 全被摘光：返回空数组，这一轮不发（不拿表情凑数）
  assert.deepEqual(handlers['reply/items']([{ kind: 'sticker', value: 'x' }], { chatId: `group:${WORK_GID}` }), [])
})

test('最终出口也拦表情：本地图 sub_type=1、商城表情 emoji_id，真图片不碰', async () => {
  const handlers = {}
  const api = apiWithGroups({ handlers })
  await mod.setup(api)
  const localSticker = { type: 'image', data: { file: 'base64://x', sub_type: 1, summary: '[表情]' } }
  const marketSticker = { type: 'image', data: { emoji_id: 'abc', summary: '[表情]' } }
  const realPhoto = { type: 'image', data: { file: 'base64://y' } }
  const text = { type: 'text', data: { text: '干活' } }
  const out = handlers['send']([text, localSticker, marketSticker, realPhoto], { chatId: `group:${WORK_GID}` })
  assert.deepEqual(out, [text, realPhoto], '只留下文字和真图片')
  // 只剩表情：返回 null（整条不发）
  assert.equal(handlers['send']([localSticker], { chatId: `group:${WORK_GID}` }), null)
  // 别的群不动
  assert.equal(handlers['send']([text, localSticker], { chatId: `group:${OTHER_GID}` }), undefined)
})