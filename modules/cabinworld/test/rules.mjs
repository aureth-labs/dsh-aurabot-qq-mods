// 提示词裁剪：桥补丁在时应该提 cabin_sleep / cabin_toolpose，
// 补丁缺失（工具没挂载）时不该提，免得模型去调不存在的工具。
// 但「没挂 sleep」不等于「整行都删」：同一行里还写着仍然可用的工具时，那些说明必须留下来。
// 用法：node test/rules.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mod from '../index.mjs'
import { GAME_DIR } from './_dirs.mjs'

process.env.CABIN_TEST = '1'

const api = {
  id: mod.id,
  version: '1.2.1',
  apiVersion: 1,
  source: 'user',
  dir: process.cwd(),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  settings: () => ({ gameDir: process.env.CABIN_GAME_DIR || GAME_DIR, waitMs: 30000, writeMemory: false }),
  defineTool: (spec) => ({ ...spec }),
  tool: (builder) => { try { builder({ chat: { kind: 'private', chatId: 'private:1', userId: '1' }, level: 'full', sessionId: 's' }) } catch (e) {} return () => {} },
  rule: () => () => {},
  context: () => () => {},
  every: () => () => {},
  on: () => () => {},
  command: () => () => {},
  route: () => () => {},
  use: () => null,
  send: async () => {},
  sendText: async () => {},
  core: { hub: { turnSendersAllOwner: () => true }, http: { send: () => {}, body: async () => ({}) } },
  dataDir: () => process.env.TEMP || '.',
}

const ret = await mod.setup(api)
const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

ok(ret && ret._test && typeof ret._test.ruleText === 'function', 'setup 暴露了 _test.ruleText')
if (!ret || !ret._test) { console.error('\n没有 _test，后面的用例跳过'); process.exit(1) }

// ---- 场景 A：补丁在（真实游戏目录，桥清单里有 cabin_sleep / cabin_toolpose）----
ret._test.resetSpecs()
const withSleep = String(ret._test.ruleText() || '')
ok(withSleep.length > 0, 'A 补丁在：ruleText 非空', withSleep.length + ' 字符')
ok(withSleep.indexOf('cabin_status') >= 0, 'A 补丁在：提到 cabin_status')
ok(withSleep.indexOf('cabin_sleep') >= 0, 'A 补丁在：提到 cabin_sleep')
ok(withSleep.indexOf('cabin_toolpose') >= 0, 'A 补丁在：提到 cabin_toolpose')
ok(withSleep.indexOf('cabin_restaurant') >= 0, 'A 补丁在：提到 cabin_restaurant')

// ---- 场景 B：补丁不在（空的游戏目录 → 读不到桥清单 → 回落到内置 TOOL_SPECS）----
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-rules-'))
fs.mkdirSync(path.join(emptyDir, 'bridge'), { recursive: true })
// 必须有个 exe，否则 gameDir() 认不出这个目录，会回落到 api.dataDir()——那样测的就不是「空游戏目录」。
fs.writeFileSync(path.join(emptyDir, 'CabinWorld.exe'), '')
const keep = process.env.CABIN_GAME_DIR
process.env.CABIN_GAME_DIR = emptyDir
ret._test.resetSpecs()
const noSleep = String(ret._test.ruleText() || '')
process.env.CABIN_GAME_DIR = keep
ret._test.resetSpecs()
try { fs.rmSync(emptyDir, { recursive: true, force: true }) } catch (e) {}

ok(noSleep.length > 0, 'B 无补丁：ruleText 非空', noSleep.length + ' 字符')
ok(noSleep.indexOf('cabin_sleep') < 0, 'B 无补丁：不再提 cabin_sleep')
ok(noSleep.indexOf('cabin_toolpose') < 0, 'B 无补丁：不再提 cabin_toolpose')
ok(noSleep.indexOf('whale_bed') < 0, 'B 无补丁：不再提 whale_bed nap 代替方案')
// 下面这几条是这次修的 bug：睡不了不代表餐厅和电玩城不能去
ok(noSleep.indexOf('cabin_restaurant') >= 0, 'B 无补丁：仍然提 cabin_restaurant（不许被连带删掉）')
ok(noSleep.indexOf('电玩城用 cabin_use') >= 0, 'B 无补丁：仍然提电玩城用 cabin_use')
ok(noSleep.indexOf('cabin_status') >= 0, 'B 无补丁：仍然提 cabin_status')
ok(noSleep.indexOf('cabin_go') >= 0, 'B 无补丁：仍然提 cabin_go')

if (!process.exitCode) console.log('\n全部通过')
