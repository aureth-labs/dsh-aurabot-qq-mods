// 记忆流水账与去重：这两处 0.4.4 都改过，但当时完全没有测试。
//   1) logMemory 改成 tmp + rename 原子写：写完文件必须仍是合法 JSON，且不留 .tmp-*。
//   2) remember 按「label + 文本」60 秒去重：重试不该写两遍，换一件事必须照写。
// 用法：node test/memory-log.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mod from '../index.mjs'

process.env.CABIN_TEST = '1'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-mem-'))
fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true })
fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
fs.writeFileSync(path.join(dir, 'CabinWorld.exe'), '')
fs.writeFileSync(path.join(dir, 'bridge', 'bridge.config.json'), JSON.stringify({ dataDir: '../data', gameExe: '../CabinWorld.exe' }), 'utf8')

const events = []
const noop = () => {}
const api = {
  id: mod.id,
  version: '1.2.1',
  apiVersion: 1,
  source: 'user',
  dir: dir,
  log: { info: noop, warn: noop, error: noop, debug: noop },
  settings: () => ({ gameDir: dir, waitMs: 30000, writeMemory: true }),
  defineTool: (spec) => ({ ...spec }),
  tool: () => noop, rule: () => noop, context: () => noop, every: () => noop,
  on: () => noop, command: () => noop, route: () => noop,
  use: (name) => (name === 'memory' ? { addEvent: (row) => { events.push(row) } } : null),
  send: async () => {}, sendText: async () => {},
  core: { hub: { turnSendersAllOwner: () => true }, http: { send: noop, body: async () => ({}) } },
  dataDir: () => dir,
}

try {
  const ret = await mod.setup(api)
  const t = ret && ret._test
  ok(!!t && typeof t.remember === 'function', 'setup 暴露了 _test.remember')
  ok(!!t && typeof t.logMemory === 'function', 'setup 暴露了 _test.logMemory')
  if (!t || typeof t.remember !== 'function') process.exit(1)

  const logFile = path.join(dir, 'data', 'memory-log.json')
  ok(t.memoryLogFile() === logFile, '流水账写在 <游戏目录>/data/memory-log.json', t.memoryLogFile())

  // ---- 1) logMemory：连续写三次，文件始终是合法 JSON，且不留 tmp ----
  t.logMemory('在小屋世界荡了会儿秋千', '荡秋千')
  t.logMemory('在小屋世界钓到一条鱼', '钓鱼')
  t.logMemory('在小屋世界睡了一觉', '睡觉')
  let rows = null
  try { rows = JSON.parse(fs.readFileSync(logFile, 'utf8')) } catch (e) { rows = null }
  ok(Array.isArray(rows), 'logMemory 写完是可解析的 JSON')
  ok(Array.isArray(rows) && rows.length === 3, '三条都在', Array.isArray(rows) ? String(rows.length) : 'null')
  const leftovers = fs.readdirSync(path.join(dir, 'data')).filter((n) => n.indexOf('.tmp-') >= 0)
  ok(leftovers.length === 0, '原子写不留 .tmp- 残留', leftovers.join(',') || '干净')

  // ---- 2) remember 去重：同一件事 60 秒内只写一次 ----
  const swing = { status: 'done', label: '荡秋千', result: { ok: true, happened: ['荡了会儿秋千'] } }
  t.remember(swing, {})
  t.remember(swing, {})
  ok(events.length === 1, '同一件事连调两次只写一条记忆', String(events.length))
  const fish = { status: 'done', label: '钓鱼', result: { ok: true, happened: ['钓到一条鱼'] } }
  t.remember(fish, {})
  ok(events.length === 2, '换一件事照写', String(events.length))
  // 同 label、不同回执也算不同的事（比如「吃」了两次不同的东西）
  const eat1 = { status: 'done', label: '吃', result: { ok: true, happened: ['吃了面包'] } }
  const eat2 = { status: 'done', label: '吃', result: { ok: true, happened: ['喝了汽水'] } }
  t.remember(eat1, {})
  t.remember(eat2, {})
  ok(events.length === 4, '同 label 但回执不同 → 都写', String(events.length))
  // 失败的 done 不该写记忆（goToVerdict 那条的前置约束）
  const failed = { status: 'done', label: '荡秋千', result: { ok: false, outcome: '被挡住' } }
  t.remember(failed, {})
  // remember 自己也兜了这一层（index.mjs 里 status==='done' 且 result.ok===false 时提前 return），
  // 不只是靠两个调用点各自拦。
  ok(events.length === 4, 'done+ok:false 不进记忆', String(events.length))
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* 清不掉就算了 */ }
}

console.log(process.exitCode ? '有断言失败' : '全部通过')
