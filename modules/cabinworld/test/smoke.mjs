// 模块冒烟测试：用假的 api 跑一遍 setup，真实连本机桥，验证工具/命令/面板接口。
// 用法：node test/smoke.mjs
// 不会发 QQ 消息，不会改插件配置。

import mod from '../index.mjs'
import { GAME_DIR, BRIDGE_JSON, expectedCoreNames } from './_dirs.mjs'

const calls = { log: [], routes: new Map(), commands: new Map(), rules: [], tools: [] }

const settings = {
  gameDir: GAME_DIR,
  bridgeJson: BRIDGE_JSON,
  waitMs: 30000,
  writeMemory: false,
  allowSocial: false,
  injectState: false,
  autoLife: true,
}

const api = {
  id: mod.id,
  version: '1.2.1',
  apiVersion: 1,
  source: 'user',
  dir: process.cwd(),
  log: {
    info: (...a) => calls.log.push(['info', ...a]),
    warn: (...a) => calls.log.push(['warn', ...a]),
    error: (...a) => calls.log.push(['error', ...a]),
    debug: () => {},
  },
  settings: () => settings,
  defineTool: (spec) => ({ ...spec }),
  tool: (builder) => {
    calls.toolBuilder = builder
    const where = { chat: { kind: 'private', chatId: 'private:1', userId: '1' }, level: 'full', sessionId: 'test-session' }
    const out = builder(where)
    for (const t of [].concat(out || [])) calls.tools.push(t)
    return () => {}
  },
  rule: (fn) => { calls.rules.push(typeof fn === 'function' ? fn('private', {}) : fn); return () => {} },
  context: () => () => {},
  every: () => () => {},
  on: () => () => {},
  command: (c) => { calls.commands.set(c.name, c); return () => {} },
  route: (p, h) => { calls.routes.set(p, h); return () => {} },
  use: () => null,
  send: async () => {},
  core: { hub: { turnSendersAllOwner: () => true }, http: { send: () => {}, body: async () => ({}) } },
  dataDir: () => process.env.TEMP || '.',
}

await mod.setup(api)
const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}
const firstLine = (s) => String(s || '').split('\n')[0]

// 挂上的 = CORE 与桥清单的交集（桥没打补丁时自然少 sleep/toolpose），不写死数字
const wantCore = expectedCoreNames()
const mountedNames = calls.tools.map(t => t.name)
ok(wantCore.length > 0 && mountedNames.length === wantCore.length && wantCore.every(n => mountedNames.indexOf(n) >= 0),
  '挂上工具（CORE∩桥清单）', mountedNames.join(', '))
ok(calls.commands.has('小屋'), '注册了 /小屋 命令')
ok(calls.rules.length > 0 && String(calls.rules[0]).includes('小屋世界'), '注入了规则')

const byName = (n) => calls.tools.find(t => t.name === n)

// 工具没挂上要算失败：以前这里只用 if 包着，缺工具时整块跳过、进程照样退 0。
const statusTool = byName('cabin_status')
ok(!!statusTool, '挂上了 cabin_status')
if (statusTool) {
  const res = await statusTool.execute({})
  ok(res && res.ok === true, 'cabin_status 返回 ok', firstLine(res && res.message))
  console.log('  ' + String((res && res.message) || '').split('\n').slice(0, 7).join('\n  '))
}

const lookTool = byName('cabin_look')
ok(!!lookTool, '挂上了 cabin_look')
if (lookTool) {
  const res = await lookTool.execute({})
  ok(res && res.ok === true, 'cabin_look 返回 ok', firstLine(res && res.message))
}

const goTool = byName('cabin_go')
ok(!!goTool, '挂上了 cabin_go')
if (goTool) {
  const res = await goTool.execute({ place: 'park' })
  ok(res && res.ok === true, 'cabin_go park', firstLine(res && res.message))
}

const routeHealth = calls.routes.get('/health')
ok(!!routeHealth, '注册了 /health 路由')
const fakeReq = { socket: { remoteAddress: '127.0.0.1' }, headers: {}, method: 'GET' }
if (routeHealth) {
  const h = await routeHealth(fakeReq, {})
  ok(h && h.ok === true && h.game === true, '面板 /health', JSON.stringify({ ok: h.ok, game: h.game, installed: h.installed }))
}

const cmd = calls.commands.get('小屋')
if (cmd) {
  // 必须带 kind:'private'，否则命令在第一步就返回「这个命令只能私聊用」，
  // 断言照样通过，等于从来没测过正常路径。
  const text = await cmd.run('', { kind: 'private', chatId: 'private:1' })
  ok(typeof text === 'string' && text.length > 0 && text.indexOf('只能私聊') < 0, '/小屋 有回复', firstLine(text))
}

// 自动生活会话挂的工具：必须和私聊同一份 CORE 清单，且覆盖提示词里点名的每一个。
// 这条就是为了防「提示词写了 cabin_sleep，白名单里没有」那种事故再发生。
if (calls.toolBuilder) {
  const autoWhere = { chat: { kind: 'system', chatId: 'system:cabin-life' }, level: 'chat', sessionId: 'auto-session' }
  const autoTools = [].concat(calls.toolBuilder(autoWhere) || []).map(t => t.name)
  ok(autoTools.length === wantCore.length && wantCore.every(n => autoTools.indexOf(n) >= 0),
    '自动生活会话和私聊挂同一份工具', String(autoTools.length) + ' 个：' + autoTools.join(','))
  const need = ['cabin_go', 'cabin_use', 'cabin_buy', 'cabin_eat', 'cabin_catalog', 'cabin_process', 'cabin_sleep', 'cabin_restaurant', 'cabin_task']
  const missing = need.filter(n => autoTools.indexOf(n) < 0)
  ok(missing.length === 0, '自动生活含提示词点名的工具', missing.length ? '缺 ' + missing.join(',') : '齐全')
}

console.log('')
console.log('日志：')
for (const row of calls.log) console.log('  ' + row.join(' '))
