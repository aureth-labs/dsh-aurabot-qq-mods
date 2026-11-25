// 昵称记忆的自查测试：mock api，不联网、不需要插件环境。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'
import { MAX_NAME_LEN, normalizeName, emptyStore, learnName, forgetName } from '../lib/store.mjs'

const OWNER = '3153882572'
const FRIEND = '792517684'
const GROUP = '170625223'
const STRANGER = '111222333'

function makeApi(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nickname-test-'))
  const tools = []
  const routes = new Map()
  // 这里显式把 socialLearn 打开，模拟主人自己在面板里打开后的行为；
  // 默认值是 false，由下面的「默认值」用例单独断言。
  let settings = { ...mod.defaults, socialLearn: true }
  const api = {
    dataDir: () => dir,
    config: () => ({ ownerQQ: OWNER, security: { trustedProxy: '' } }),
    settings: () => settings,
    saveSettings() {},
    log: { info() {}, warn() {}, error() {} },
    tool: (fn) => tools.push(fn),
    defineTool: (p) => p,
    rule() {},
    context() {},
    command() {},
    on() {},
    route: (path, fn, options) => routes.set(path, { fn, options }),
    onebot: async (action) => {
      if (action !== 'get_group_member_list') return []
      return [
        { user_id: Number(FRIEND), card: '王总', nickname: 'wang' },
        { user_id: Number(STRANGER), card: '小李', nickname: 'li' },
      ]
    },
    core: { hub: { turnSenders: () => [], sessions: () => ({}) }, http: { body: async () => ({}) } },
  }
  const { module: _m, ...rest } = { module: true, ...overrides }
  Object.assign(api, rest)
  mod.setup(api)
  const toolsFor = (chat, sessionId = 's1') => tools[0]({ chat, sessionId })
  const toolOf = (list, name) => list.find((t) => t.name === name)
  return { api, dir, toolsFor, toolOf, routes, setSettings: (next) => (settings = { ...settings, ...next }), getSettings: () => settings }
}

const ownerChat = { chatId: `private:${OWNER}`, kind: 'private', userId: OWNER }
const friendChat = { chatId: `private:${FRIEND}`, kind: 'private', userId: FRIEND }
const groupChat = { chatId: `group:${GROUP}`, kind: 'group', groupId: GROUP }

test('名字清洗：零宽、括号、换行、超长都处理掉', () => {
  assert.equal(normalizeName('  老\u200b张\n'), '老张')
  assert.equal(normalizeName('「老王」'), '老王')
  assert.equal(normalizeName('ａｂｃ'), 'abc')
  assert.equal(normalizeName('x'.repeat(100)).length, MAX_NAME_LEN)
  assert.equal(normalizeName(''), '')
})

test('同一个人的新叫法顶掉旧的，删掉当前叫法退回上一个', () => {
  const store = emptyStore()
  learnName(store, { qq: FRIEND, name: '老张', now: 1 })
  learnName(store, { qq: FRIEND, name: '张哥', now: 2 })
  assert.equal(store.people[FRIEND].current, '张哥')
  assert.deepEqual(store.people[FRIEND].names.map((n) => n.name), ['老张', '张哥'])
  forgetName(store, FRIEND, '张哥')
  assert.equal(store.people[FRIEND].current, '老张')
})

test('主人私聊：能看到整本，带 QQ 号和旧叫法', async () => {
  const h = makeApi()
  await h.toolOf(h.toolsFor(ownerChat), 'nickname_learn').execute({ person: FRIEND, nickname: '老张' })
  const r = await h.toolOf(h.toolsFor(ownerChat), 'nickname_who').execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /老张/)
  assert.match(r.message, new RegExp(FRIEND))
})

test('群里：只看得到这个群里记过的，且不带 QQ 号', async () => {
  const h = makeApi()
  // 主人私聊里记一个只在私聊出现的叫法
  await h.toolOf(h.toolsFor(ownerChat), 'nickname_learn').execute({ person: '123456', nickname: '私聊里的小明' })
  // 群里记一个
  await h.toolOf(h.toolsFor(groupChat), 'nickname_learn').execute({ person: FRIEND, nickname: '王总' })

  const r = await h.toolOf(h.toolsFor(groupChat), 'nickname_who').execute({})
  assert.equal(r.ok, true)
  assert.match(r.message, /王总/)
  assert.doesNotMatch(r.message, /私聊里的小明/, '不该看到别的聊天记的叫法')
  assert.doesNotMatch(r.message, new RegExp(FRIEND), '群里不该暴露 QQ 号')
})

test('群友不能给主人起外号', async () => {
  const h = makeApi()
  const learn = h.toolOf(h.toolsFor(groupChat), 'nickname_learn')
  const r = await learn.execute({ person: OWNER, nickname: '大冤种' })
  assert.equal(r.ok, false)
  assert.match(r.message, /主人/)
})

test('群友只能记这个群里的人', async () => {
  const h = makeApi()
  const learn = h.toolOf(h.toolsFor(groupChat), 'nickname_learn')
  const ok = await learn.execute({ person: FRIEND, nickname: '王总' })
  assert.equal(ok.ok, true)
  const bad = await learn.execute({ person: '999888777', nickname: '外人' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /这个群里/)
})

test('关掉「允许群友教她叫法」后，群里改不了本子', async () => {
  const h = makeApi()
  h.setSettings({ socialLearn: false })
  const r = await h.toolOf(h.toolsFor(groupChat), 'nickname_learn').execute({ person: FRIEND, nickname: '王总' })
  assert.equal(r.ok, false)
  assert.match(r.message, /关掉了/)
  // 主人私聊不受影响
  const owner = await h.toolOf(h.toolsFor(ownerChat), 'nickname_learn').execute({ person: FRIEND, nickname: '王总' })
  assert.equal(owner.ok, true)
})

test('别人的私聊里改不了称呼本', async () => {
  const h = makeApi()
  const r = await h.toolOf(h.toolsFor(friendChat), 'nickname_learn').execute({ person: FRIEND, nickname: '王总' })
  assert.equal(r.ok, false)
  assert.match(r.message, /只有主人/)
})

test('同一个聊天里改得太勤会被拦', async () => {
  const h = makeApi()
  const learn = h.toolOf(h.toolsFor(groupChat), 'nickname_learn')
  let last
  for (let i = 0; i < 13; i += 1) last = await learn.execute({ person: FRIEND, nickname: `叫法${i}` })
  assert.equal(last.ok, false)
  assert.match(last.message, /太勤/)
})

test('面板接口默认只认本机，打开设置才放远程', async () => {
  const h = makeApi()
  const remote = { socket: { remoteAddress: '192.168.1.9' }, headers: {} }
  const local = { socket: { remoteAddress: '127.0.0.1' }, headers: {} }

  const denied = await h.routes.get('/list').fn(remote)
  assert.equal(denied.ok, false)
  assert.match(denied.message, /本机/)

  const allowed = await h.routes.get('/list').fn(local)
  assert.equal(allowed.ok, true)

  h.setSettings({ panelRemote: true })
  const remoteOk = await h.routes.get('/list').fn(remote)
  assert.equal(remoteOk.ok, true)
})

test('四条面板路由都声明成 panel，交给宿主的闸先拦', () => {
  const h = makeApi()
  for (const path of ['/list', '/set', '/remove', '/forget']) {
    assert.ok(h.routes.has(path), `缺路由 ${path}`)
    assert.deepEqual(h.routes.get(path).options, { access: 'panel' }, `${path} 没带 access: panel`)
  }
})

test('默认值：群友写称呼本默认关、能力里没有 network', () => {
  assert.equal(mod.defaults.socialLearn, false)
  assert.equal(mod.defaults.panelRemote, false)
})

test('面板写接口同样受本机限制', async () => {
  const h = makeApi()
  const remote = { socket: { remoteAddress: '10.0.0.8' }, headers: {} }
  const r = await h.routes.get('/set').fn(remote)
  assert.equal(r.ok, false)
})

test('老数据里的原话（evidence）读一次就被洗掉', async () => {
  const h = makeApi()
  const file = join(h.dir, 'nicknames.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    people: {
      [FRIEND]: {
        qq: FRIEND,
        current: '王总',
        names: [{ name: '王总', at: 1, chatId: `group:${GROUP}`, evidence: 'void：我是王总' }],
        firstSeen: 1,
        updated: 1,
      },
    },
  }), 'utf8')

  const r = await h.routes.get('/list').fn({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })
  assert.equal(r.ok, true)
  const saved = readFileSync(file, 'utf8')
  assert.doesNotMatch(saved, /evidence/)
  assert.doesNotMatch(saved, /我是王总/)
})
