// 高级协议（餐厅/睡觉/工具姿势）的模块测试：用假的 api 跑 setup，真实连本机桥。
// 电玩城不在这里：上游 1.1 没有 cabin_arcade 工具，玩机台走 cabin_use（object 取 cabin_look 里的机台 id）。
// 用法：node test/advanced.mjs           只读：菜单、作息、床上状态、局面
//       CABIN_ADVANCED_LIVE=1 node test/advanced.mjs   真的开一局再收手（会动游戏里的角色，几十秒）
// 不会发 QQ 消息，不会改插件配置。

import mod from '../index.mjs'
import { GAME_DIR, BRIDGE_JSON, expectedCoreNames } from './_dirs.mjs'

const calls = { log: [], tools: [] }
const settings = {
  gameDir: GAME_DIR,
  bridgeJson: BRIDGE_JSON,
  waitMs: 60000,
  writeMemory: false,
  allowSocial: false,
  injectState: false,
}

const api = {
  id: mod.id,
  version: '1.2.1',
  apiVersion: 1,
  source: 'user',
  dir: process.cwd(),
  log: { info: (...a) => calls.log.push(['info', ...a]), warn: (...a) => calls.log.push(['warn', ...a]), error: (...a) => calls.log.push(['error', ...a]), debug: () => {} },
  settings: () => settings,
  defineTool: (spec) => ({ ...spec }),
  tool: (builder) => {
    const where = { chat: { kind: 'private', chatId: 'private:1', userId: '1' }, level: 'full', sessionId: 'test-session' }
    for (const t of [].concat(builder(where) || [])) calls.tools.push(t)
    return () => {}
  },
  rule: () => () => {},
  context: () => () => {},
  every: () => () => {},
  on: () => () => {},
  command: () => () => {},
  route: () => () => {},
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
const byName = (n) => calls.tools.find(t => t.name === n)
const firstLine = (s) => String(s || '').split('\n')[0]
const ADVANCED = ['cabin_toolpose', 'cabin_restaurant', 'cabin_sleep']

// 13 = CORE 里挑出来的 13 个常用（status/look/catalog/go/use/buy/eat/stop/restaurant/sleep/toolpose/task/process），
// 实际挂上的 = CORE 与桥清单的交集：桥降级成未打补丁的官方桥时会少 sleep/toolpose，那是产品行为，测试不该红。
const wantCore = expectedCoreNames()
const gotNames = calls.tools.map(t => t.name)
ok(wantCore.length > 0 && gotNames.length === wantCore.length && wantCore.every(n => gotNames.indexOf(n) >= 0),
  '私聊挂上的就是 CORE∩桥清单', gotNames.length + ' 个：' + gotNames.join(','))
for (const name of ADVANCED) {
  const t = byName(name)
  ok(Boolean(t), '挂上 ' + name, t ? firstLine(t.description) : '没有这个工具')
  ok(Boolean(t) && !String(t.description).includes('\n'), name + ' 描述只有一行', t ? String(t.description).length + ' 字' : '')
}

// 回归：原有的只读工具不受影响
const status = byName('cabin_status') && await byName('cabin_status').execute({})
ok(status && status.ok === true, 'cabin_status 仍然可用', firstLine(status && status.message))

// 餐厅菜单（只读）
const menu = byName('cabin_restaurant') && await byName('cabin_restaurant').execute({ action: 'menu' })
ok(menu && menu.ok === true, 'cabin_restaurant menu', firstLine(menu && menu.message))
ok(menu && /restaurant-/.test(String(menu.message)), '菜单里有菜', String(menu && menu.message).slice(0, 120))

// 睡觉：只问不做
const plan = byName('cabin_sleep') && await byName('cabin_sleep').execute({ action: 'plan' })
ok(plan && plan.ok === true && /按作息/.test(String(plan.message)), 'cabin_sleep plan', firstLine(plan && plan.message))
const bed = byName('cabin_sleep') && await byName('cabin_sleep').execute({ action: 'state' })
ok(bed && bed.ok === true && /床上/.test(String(bed.message)), 'cabin_sleep state', firstLine(bed && bed.message))

// 工具姿势：住户资料里有规则就能拿到姿势，没有就明确说没有
const pose = byName('cabin_toolpose') && await byName('cabin_toolpose').execute({ tool: 'typing' })
ok(pose && (pose.ok === true || /没有配置/.test(String(pose.message))), 'cabin_toolpose typing', firstLine(pose && pose.message))

// 电玩城：1.1 由官方桥自带，玩机台走 cabin_use（不再有 cabin_arcade 工具）。
// 想真开一局的话：先 cabin_look 看机台 id，再 cabin_use({ object: '<机台>', use: 'play' })。
console.log('SKIP 电玩城：1.1 走 cabin_use，没有 cabin_arcade 工具')

console.log('')
console.log('日志：')
for (const row of calls.log.slice(0, 12)) console.log('  ' + row.join(' '))
