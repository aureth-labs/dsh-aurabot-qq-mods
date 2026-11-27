// 集成：动作完成后写记忆、开 injectState 时上下文里带真实状态。
// 用法：node test/integration.mjs   （需要桥和游戏在跑）

import mod from '../index.mjs'
import { GAME_DIR, BRIDGE_JSON, expectedCoreNames } from './_dirs.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

const events = []
const contextFns = []
const everyFns = []
let built = []

const settings = {
  gameDir: GAME_DIR,
  bridgeJson: BRIDGE_JSON,
  waitMs: 30000,
  writeMemory: true,
  allowSocial: false,
  injectState: true,
}

const api = {
  id: mod.id, version: '1.2.1', apiVersion: 1, source: 'user', dir: process.cwd(),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  settings: () => settings,
  defineTool: (spec) => ({ ...spec }),
  tool: (builder) => {
    built = [].concat(builder({ chat: { kind: 'private', chatId: 'private:1', userId: '1' }, level: 'full', sessionId: 's' }) || [])
    return () => {}
  },
  rule: () => () => {},
  context: (fn) => { contextFns.push(fn); return () => {} },
  every: (ms, fn) => { everyFns.push(fn); return () => {} },
  on: () => () => {},
  command: () => () => {},
  route: () => () => {},
  use: (id) => (id === 'memory' ? { addEvent: (e) => events.push(e) } : null),
  send: async () => {},
  core: { hub: { turnSendersAllOwner: () => true } },
  dataDir: () => process.env.TEMP || '.',
}

mod.setup(api)
// 挂上的 = CORE 与桥清单的交集；定时器有两个（状态刷新 + 自动生活），上下文本体只有一个
const wantCore = expectedCoreNames()
const builtNames = built.map(t => t.name)
ok(wantCore.length > 0 && builtNames.length === wantCore.length && wantCore.every(n => builtNames.indexOf(n) >= 0),
  '工具已挂（CORE∩桥清单）', String(built.length))
ok(everyFns.length === 2 && contextFns.length === 1, '开了 injectState：注册了状态刷新、自动生活定时与上下文', everyFns.length + '/' + contextFns.length)

await everyFns[0]()
const ctx = contextFns[0]({ chat: { kind: 'private', chatId: 'private:1' }, sessionId: 's' })
ok(typeof ctx === 'string' && ctx.includes('小屋世界'), '上下文带状态', String(ctx).slice(0, 80))
const ctxGroup = contextFns[0]({ chat: { kind: 'group', chatId: 'group:1' }, sessionId: 's' })
ok(ctxGroup === '', '群聊不注入状态', JSON.stringify(ctxGroup))

const go = built.find(t => t.name === 'cabin_go')
const res = await go.execute({ place: 'park' })
ok(res && res.ok === true, 'cabin_go 成功', String(res.message).split('\n')[0])

await new Promise(r => setTimeout(r, 600))
ok(events.length >= 1, '动作写进了记忆', events.length + ' 条：' + (events[0] ? events[0].text.slice(0, 60) : ''))
if (events[0]) {
  ok(Array.isArray(events[0].tags) && events[0].tags.includes('小屋世界'), '记忆带标签', JSON.stringify(events[0].tags))
  ok(!/^undefined/.test(events[0].text), '记忆文本不以 undefined 开头', events[0].text.slice(0, 30))
}
