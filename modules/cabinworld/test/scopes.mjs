// 权限边界：主人私聊挂全部工具；群聊默认一个不挂；打开 allowSocial 只挂两个只读且要全是主人。
// 用法：node test/scopes.mjs

import mod from '../index.mjs'
import { GAME_DIR, BRIDGE_JSON, expectedCoreNames } from './_dirs.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

function build({ allowSocial, level, chatKind, allOwners }) {
  const built = []
  const api = {
    id: mod.id, version: '1.2.1', apiVersion: 1, source: 'user', dir: process.cwd(),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    settings: () => ({ bridgeJson: BRIDGE_JSON, gameDir: GAME_DIR, waitMs: 30000, allowSocial, injectState: false, writeMemory: false }),
    defineTool: (spec) => ({ ...spec }),
    tool: (builder) => {
      const where = { chat: { kind: chatKind, chatId: chatKind === 'group' ? 'group:1' : 'private:1', userId: '1' }, level, sessionId: 's' }
      for (const t of [].concat(builder(where) || [])) built.push(t)
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
    core: { hub: { turnSendersAllOwner: () => allOwners } },
    dataDir: () => process.env.TEMP || '.',
  }
  mod.setup(api)
  return built
}

const full = build({ allowSocial: false, level: 'full', chatKind: 'private', allOwners: true })
const wantCore = expectedCoreNames()
const fullNames = full.map(t => t.name)
ok(wantCore.length > 0 && fullNames.length === wantCore.length && wantCore.every(n => fullNames.indexOf(n) >= 0),
  '主人私聊：挂上 CORE∩桥清单', fullNames.join(', '))

const socialOff = build({ allowSocial: false, level: 'social', chatKind: 'group', allOwners: true })
ok(socialOff.length === 0, '群聊默认：0 个工具', String(socialOff.length))

const socialOn = build({ allowSocial: true, level: 'social', chatKind: 'group', allOwners: true })
ok(socialOn.length === 2 && socialOn.every(t => t.name === 'cabin_status' || t.name === 'cabin_look'), '群聊只读：2 个工具', socialOn.map(t => t.name).join(', '))

const socialDenied = build({ allowSocial: true, level: 'social', chatKind: 'group', allOwners: false })
const denied = socialDenied[0] ? await socialDenied[0].execute({}) : null
ok(denied && denied.ok === false && String(denied.message).includes('主人'), '非全主人：拒绝执行', denied ? String(denied.message).slice(0, 40) : '没有工具')

const sys = build({ allowSocial: false, level: 'chat', chatKind: 'system', allOwners: true })
ok(sys.length === 0, 'system 会话：0 个工具', String(sys.length))
