// 毒舌模式模块测试：不打网络、不写模块源码目录（数据进临时目录）。
// 覆盖：语料解析（注释/空行）、抽词防重复、关键字开关（主人门禁）、
// 全接管、冷却（按聊天隔离）、语料文件上限（1MB/500 字/5000 行）、读文本文件语料。
// 跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/roast-mode/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod, { parseCorpus, pickLine } from '../index.mjs'

// ── 纯函数 ────────────────────────────────────────────────

test('parseCorpus：每行一句，注释与空行忽略', () => {
  const lines = parseCorpus('# 注释行\n\n第一句\r\n  第二句带空格  \n#\n第三句\n')
  assert.deepEqual(lines, ['第一句', '第二句带空格', '第三句'])
  assert.equal(parseCorpus('').length, 0)
  assert.equal(parseCorpus(null).length, 0)
})

test('pickLine：不在空列表上炸；非空时避开上一句', () => {
  assert.equal(pickLine([], null), null)
  const one = ['唯一一句']
  assert.equal(pickLine(one, '唯一一句'), '唯一一句') // 只有一句时允许重复
  for (let i = 0; i < 20; i++) {
    const got = pickLine(['甲', '乙', '丙'], '甲')
    assert.notEqual(got, '甲')
  }
})

// ── fake api（对齐面板数据目录行为，数据进临时目录） ────────

function fakeApi({ owner = true, dir = mkdtempSync(join(tmpdir(), 'roast-mode-test-')) } = {}) {
  const dataDir = dir
  const handlers = {}
  const replies = []
  const sends = []
  const settingsMap = {}
  const api = {
    id: 'roast-mode',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    settings: () => ({ ...mod.defaults, ...settingsMap }),
    isOwner: (id) => owner && id === '10000',
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn) },
    route: (path, fn) => { (handlers.route ||= {})[path] = fn },
    onDispose: (fn) => { (handlers.dispose ||= []).push(fn) },
    rule: (fn) => { (handlers.rules ||= []).push(fn) },
    tool: (fn) => { (handlers.tools ||= []).push(fn) },
    defineTool: (t) => t,
    core: { hub: { turnSendersAllOwner: () => true } },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text }) },
    send: async (chatId, text) => { sends.push({ chatId, text }) },
    __test: { dataDir, handlers, replies, sends, settingsMap },
  }
  return api
}

const msg = (text, { chatId = 'group:123', userId = '10000', mentioned = false } = {}) =>
  ({ text, chatId, userId, mentioned, kind: chatId.startsWith('group') ? 'group' : 'private' })

const fire = (api, m) => api.__test.handlers.message[0](m)

// ── 行为 ─────────────────────────────────────────────────

test('setup 落语料模板；默认关着时普通消息不接管', async () => {
  const api = fakeApi()
  const exp = mod.setup(api)
  assert.ok(exp.corpusPath.endsWith('corpus.txt'))
  assert.equal(exp.status().chats.length, 0)
  // 没开：普通消息与关键字都不该由本模块吞掉语义（关键字没开也接管开关本身——见下一用例说明）
  const r = await fire(api, msg('随便聊聊'))
  assert.equal(r, false)
  assert.equal(api.__test.replies.length, 0)
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('开启/关闭关键字按聊天生效；非主人默认开不了', async () => {
  const api = fakeApi() // ownerOnly 默认 true
  mod.setup(api)
  // 别人发关键字：不接管、不开
  let r = await fire(api, msg('毒舌开启', { userId: '666' }))
  assert.equal(r, false)
  assert.equal(api.__test.replies.length, 0)
  // 主人开：接管 + 确认
  r = await fire(api, msg('毒舌开启'))
  assert.equal(r, true)
  assert.equal(api.__test.replies.at(-1).text.includes('已开启'), true)
  // 开着之后：每条消息都接管回毒舌（开着=全接管）
  r = await fire(api, msg('来啊', { mentioned: true }))
  assert.equal(r, true)
  assert.ok(api.__test.replies.at(-1).text.length > 0)
  // 只对开了的聊天生效
  r = await fire(api, msg('来啊', { chatId: 'group:999', mentioned: true }))
  assert.equal(r, false)
  // 主人关掉
  r = await fire(api, msg('毒舌关闭'))
  assert.equal(r, true)
  assert.equal(api.__test.replies.at(-1).text.includes('已关闭'), true)
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('开着=整段接管：每条都回毒舌；冷却期内吞掉不回也不给鱼鱼', async () => {
  const api = fakeApi()
  api.__test.settingsMap.cooldownSec = 600
  mod.setup(api)
  await fire(api, msg('毒舌开启'))
  const r1 = await fire(api, msg('第一条'))
  assert.equal(r1, true)
  const count = api.__test.replies.length
  // 冷却期内：依然接管（返回 true），但不回复——绝不漏给鱼鱼
  const r2 = await fire(api, msg('第二条'))
  assert.equal(r2, true)
  assert.equal(api.__test.replies.length, count)
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('useFile 开关：改读文本文件语料（每行一句）', async () => {
  const api = fakeApi()
  api.__test.settingsMap.cooldownSec = 0
  const exp = mod.setup(api)
  await fire(api, msg('毒舌开启'))
  const corpusFile = join(api.__test.dataDir, 'corpus.txt')
  writeFileSync(corpusFile, '# 注释\n只此一句独家的\n', 'utf8')
  api.__test.settingsMap.useFile = true
  assert.equal(exp.status().useFile, true)
  const r = await fire(api, msg('说一句'))
  assert.equal(r, true)
  assert.equal(api.__test.replies.at(-1).text, '只此一句独家的')
  // 关掉开关回到内置预设
  api.__test.settingsMap.useFile = false
  await fire(api, msg('再说一句'))
  assert.notEqual(api.__test.replies.at(-1).text, '只此一句独家的')
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('多聊天隔离：冷却与防重复只影响当前聊天', async () => {
  const api = fakeApi()
  api.__test.settingsMap.cooldownSec = 600 // 长冷却：谁先毒舌，只静音谁自己
  mod.setup(api)
  await fire(api, msg('毒舌开启', { chatId: 'group:A' }))
  await fire(api, msg('毒舌开启', { chatId: 'group:B' }))
  await fire(api, msg('毒舌开启', { chatId: 'group:C' }))
  // A 先毒舌一句（A 进入自己的冷却）；此时已回复 = 三次「已开启」确认 + A 的毒舌
  await fire(api, msg('冲', { chatId: 'group:A' }))
  const total = api.__test.replies.length
  // A 冷却期内再发：吞掉不回
  await fire(api, msg('还冲', { chatId: 'group:A' }))
  assert.equal(api.__test.replies.length, total)
  // B 不受 A 的冷却影响：正常回毒舌
  await fire(api, msg('冲二', { chatId: 'group:B' }))
  assert.equal(api.__test.replies.length, total + 1)
  // C 也不受影响
  await fire(api, msg('冲三', { chatId: 'group:C' }))
  assert.equal(api.__test.replies.length, total + 2)
  // 防重复也按聊天分开：B 冷却清零后再说，应避开 B 自己的上一句
  const bFirst = api.__test.replies.filter((r) => r.chatId === 'group:B').at(-1).text
  api.__test.settingsMap.cooldownSec = 0
  await fire(api, msg('新回合', { chatId: 'group:B' }))
  const bSecond = api.__test.replies.filter((r) => r.chatId === 'group:B').at(-1).text
  assert.notEqual(bSecond, bFirst)
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('语料文件上限：超 1MB 拒绝读入回落内置预设；超长行截断到 500 字', async () => {
  const api = fakeApi()
  api.__test.settingsMap.cooldownSec = 0
  mod.setup(api)
  await fire(api, msg('毒舌开启'))
  const corpusFile = join(api.__test.dataDir, 'corpus.txt')
  // 超 1MB：独占句被拒，改回内置预设
  writeFileSync(corpusFile, ('x'.repeat(100) + '\n').repeat(11 * 1024) + '超限独占句\n', 'utf8')
  api.__test.settingsMap.useFile = true
  await fire(api, msg('大文件说一句'))
  assert.notEqual(api.__test.replies.at(-1).text, '超限独占句')
  assert.ok(api.__test.replies.at(-1).text.length > 0)
  // 超长行：截断到 500 字以内
  writeFileSync(corpusFile, '# 注释\n' + '长'.repeat(600) + '\n', 'utf8')
  await fire(api, msg('长行说一句'))
  const long = api.__test.replies.at(-1).text
  assert.ok(long.length <= 500)
  assert.ok(long.startsWith('长'))
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('面板接口：corpus-info 报路径；open-corpus-folder 可调用', async () => {
  const api = fakeApi()
  const exp = mod.setup(api)
  const routes = api.__test.handlers.route || {}
  const info = await routes['/corpus-info']()
  assert.equal(info.ok, true)
  assert.equal(info.path, exp.corpusPath)
  assert.equal(info.exists, true)
  assert.equal(info.dir, api.__test.dataDir)
  // 打开文件夹：注入假 spawn（不打真进程），验证调用参数
  const spawns = []
  const a2 = fakeApi()
  a2.__roastTestHooks = { spawn: (cmd, args) => { spawns.push({ cmd, args }); return { unref() {} } } }
  mod.setup(a2)
  const r2 = await a2.__test.handlers.route['/open-corpus-folder']()
  assert.equal(r2.ok, true)
  assert.equal(spawns.at(-1).cmd, 'explorer')
  assert.equal(spawns.at(-1).args[0], a2.__test.dataDir)
  rmSync(a2.__test.dataDir, { recursive: true, force: true })
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('给鱼鱼的感知：有规则说明 + roast_mode_toggle 工具可拨开关', async () => {
  const api = fakeApi()
  mod.setup(api)
  // 规则注入：鱼鱼的系统提示词里能看到毒舌模式
  assert.ok((api.__test.handlers.rules || []).length >= 1)
  // 工具：生成 → 开 → 查询 → 关 → 查询（工具路径走 send 兜底）
  const makeTool = api.__test.handlers.tools[0]
  const tool = makeTool({ chat: { kind: 'group', chatId: 'group:777', userId: '10000' }, sessionId: 's1' })
  assert.equal(tool.name, 'roast_mode_toggle')
  const rOn = await tool.execute({ action: 'on' })
  assert.equal(rOn.ok, true)
  const lastOut = api.__test.replies.at(-1) || api.__test.sends.at(-1)
  assert.equal(lastOut.chatId, 'group:777')
  const rStatusOn = await tool.execute({ action: 'status' })
  assert.match(rStatusOn.message, /开着/)
  const rOff = await tool.execute({ action: 'off' })
  assert.equal(rOff.ok, true)
  const rStatusOff = await tool.execute({ action: 'status' })
  assert.match(rStatusOff.message, /没开/)
  rmSync(api.__test.dataDir, { recursive: true, force: true })
})

test('开关状态持久化：重开模块后还记着哪些聊天开着', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roast-mode-test-'))
  const api1 = fakeApi({ dir })
  mod.setup(api1)
  await fire(api1, msg('毒舌开启', { chatId: 'private:10000' }))
  // 新的 api 实例模拟模块重载（同一个数据目录）
  const api2 = fakeApi({ dir })
  const exp = mod.setup(api2)
  assert.deepEqual(exp.status().chats, ['private:10000'])
  rmSync(dir, { recursive: true, force: true })
})
