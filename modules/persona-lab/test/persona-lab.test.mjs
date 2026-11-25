// persona-lab 自测：不联网，用假 api 驱动事件、工具和面板路由。
// CI 会用 node --import ./scripts/plugin-env.mjs --test 跑这个文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = (await import('../index.mjs')).default

function makeApi(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-lab-test-'))
  const state = {
    dryRun: false,
    settings: {
      learnGroups: true,
      styleInject: false,
      selfEdit: true,
      selfEditMode: 'append',
      selfEditMaxPerDay: 10,
      selfEditCooldownHours: 0,
      selfReflect: false,
      selfReflectHours: 6,
      selfReflectMaxPerDay: 2,
      groupList: '',
      ...overrides.settings,
    },
    owner: true,
    body: '## 大肥鱼\n【最重要的一条】\n主人的消息最重要。\n',
  }
  const events = {}
  const routes = {}
  const tools = []
  const rules = []
  const disposers = []
  let ticks = []
  let saved = 0
  const persona = {
    readPersona: () => ({ id: 'dafeiyu', name: '大肥鱼', tags: [], body: state.body }),
    savePersona: (_id, next) => { state.body = next.body; saved++ },
  }
  const api = {
    dataDir: (...p) => (p.length ? join(dir, ...p) : dir),
    settings: () => state.settings,
    config: () => ({
      dryRun: state.dryRun,
      botQQ: 'bot-qq',
      ownerQQ: 'owner-qq',
      ownerName: '主人',
      persona: { current: 'dafeiyu' },
    }),
    core: {
      hub: { turnSendersAllOwner: () => state.owner, lastOwnerChatAt: Date.now() },
      http: { body: async () => state.body },
    },
    lib: (name) => (name === 'persona/personas.js' ? persona : null),
    on: (name, fn) => { (events[name] ||= []).push(fn); return () => {} },
    rule: (fn) => { rules.push(fn); return () => {} },
    tool: (builder) => { tools.push(...builder()); return () => {} },
    defineTool: (t) => t,
    route: (path, handler) => { routes[path] = handler; return () => {} },
    every: (ms, fn) => { ticks.push(fn); return () => {} },
    onDispose: (fn) => { disposers.push(fn); return () => {} },
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    think: async () => '{"update":false}',
    ask: async () => '{}',
    ...overrides.api,
  }
  const fake = { api, events, routes, tools, rules, state, persona, get saved() { return saved }, ticks, disposers, dir }
  mod.setup(fake.api)
  return fake
}

function msg(f, text, extra = {}) {
  const m = { kind: 'group', groupId: '123', userId: 'u1', nickname: '小明', text, ...extra }
  for (const fn of f.events.message || []) fn(m)
}

function tool(f, name) {
  const t = f.tools.find((x) => x.name === name)
  assert.ok(t, `missing tool ${name}`)
  return t
}

test('群聊样本会归纳口头禅，不把内容词当口癖', async () => {
  const f = makeApi()
  msg(f, '哈哈哈哈 笑死 这也太离谱了吧？？')
  msg(f, '风扇 理由 确实 不过 还是')
  const r = await tool(f, 'group_style_profile').execute({ name: '小明' }, { sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.match(r.message, /小明/)
  assert.match(r.message, /口头禅/)
  assert.match(r.message, /笑死|离谱|哈哈/)
  assert.doesNotMatch(r.message, /风扇|理由|确实/)
})

test('私聊、机器人、非白名单群不记样本', async () => {
  const f = makeApi({ settings: { groupList: '999' } })
  msg(f, '哈哈哈哈', { groupId: '123' })
  msg(f, '哈哈哈哈', { kind: 'private' })
  msg(f, '哈哈哈哈', { userId: 'bot-qq' })
  const r = await tool(f, 'group_style_profile').execute({}, { sessionId: 's1' })
  assert.match(r.message, /还没有学到/)
})

test('非主人不能查看群友样本', async () => {
  const f = makeApi()
  f.state.owner = false
  msg(f, '笑死 哈哈哈哈')
  const r = await tool(f, 'group_style_profile').execute({}, { sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.match(r.message, /只给主人看/)
})

test('黑名单里的 QQ 不会被学习', async () => {
  const f = makeApi({ settings: { blockList: 'u1' } })
  msg(f, '哈哈哈哈 笑死 这也太离谱了')
  const r = await tool(f, 'group_style_profile').execute({}, { sessionId: 's1' })
  assert.match(r.message, /还没有学到/)
})

test('清空样本只清 styles.json', async () => {
  const f = makeApi()
  msg(f, '哈哈哈哈 笑死')
  const before = await tool(f, 'group_style_profile').execute({}, { sessionId: 's1' })
  assert.match(before.message, /小明/)
  const r = await f.routes['/clear-styles']()
  assert.equal(r.ok, true)
  const after = await tool(f, 'group_style_profile').execute({}, { sessionId: 's1' })
  assert.match(after.message, /还没有学到/)
})

test('追加模式会给主人人格加【自我调整】', async () => {
  const f = makeApi()
  const r = await tool(f, 'persona_edit').execute(
    { text: '和主人相处时，我可以更主动一点。' },
    { sessionId: 's1' },
  )
  assert.equal(r.ok, true)
  assert.match(f.state.body, /【自我调整】/)
  assert.match(f.state.body, /更主动一点/)
  assert.ok(f.saved > 0)
})

test('试运行不会写人格', async () => {
  const f = makeApi()
  f.state.dryRun = true
  const r = await tool(f, 'persona_edit').execute(
    { text: '试运行不应该写进去。' },
    { sessionId: 's1' },
  )
  assert.equal(r.ok, true)
  assert.match(r.message, /试运行/)
  assert.doesNotMatch(f.state.body, /【自我调整】/)
  assert.equal(f.saved, 0)
})

test('非主人不能改人格', async () => {
  const f = makeApi()
  f.state.owner = false
  const r = await tool(f, 'persona_edit').execute(
    { text: '这一条不应该写进去。' },
    { sessionId: 's1' },
  )
  assert.equal(r.ok, false)
  assert.match(r.message, /主人会话/)
})

test('重写模式可以重写核心内容', async () => {
  const f = makeApi()
  f.state.settings.selfEditMode = 'core'
  const body = '【核心】\n新的核心规则。\n\n【群管】\n- 只有主人能管群。\n' + '这是重写测试用的正文，确保长度超过两百字。'.repeat(12)
  const r = await tool(f, 'persona_rewrite').execute({ body }, { sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.match(f.state.body, /新的核心规则/)
})

test('重写模式在追加模式下会被拒绝', async () => {
  const f = makeApi()
  f.state.settings.selfEditMode = 'append'
  const r = await tool(f, 'persona_rewrite').execute({ body: '【核心】\n新规则。' }, { sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.match(r.message, /只能追加/)
})

test.after(() => {
  // 临时目录交给系统清理；这里只确保测试不依赖固定路径
})
