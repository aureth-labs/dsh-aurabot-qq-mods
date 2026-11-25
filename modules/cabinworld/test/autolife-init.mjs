// 自动生活状态的加载路径：data/auto-life.json 里留着 running:true 时，
// setup() 必须能正常完成。0.4.4 曾在这里踩到 AUTO_STALE_MS 的暂时性死区（声明在使用之后），
// 结果整个模块加载失败——13 个工具、/小屋 命令、面板路由全部消失。
// 触发场景很现实：一轮自动生活（可持续 2-3 分钟）进行中宿主重启，就把 running:true 留在磁盘上。
// 用法：node test/autolife-init.mjs
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

// 一个最小的游戏目录：bridge.config.json 指到 ../data，exe 有文件就算装好。
function makeGameDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-life-'))
  fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'CabinWorld.exe'), '')
  fs.writeFileSync(path.join(dir, 'start.cmd'), '')
  fs.writeFileSync(path.join(dir, 'bridge', 'bridge.config.json'), JSON.stringify({ dataDir: '../data', gameExe: '../CabinWorld.exe' }), 'utf8')
  return dir
}

function makeApi(dir) {
  const noop = () => {}
  return {
    id: mod.id,
    version: '1.2.1',
    apiVersion: 1,
    source: 'user',
    dir: dir,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    settings: () => ({ gameDir: dir, waitMs: 30000, writeMemory: false }),
    defineTool: (spec) => ({ ...spec }),
    tool: () => noop,
    rule: () => noop,
    context: () => noop,
    every: () => noop,
    on: () => noop,
    command: () => noop,
    route: () => noop,
    use: () => null,
    send: async () => {},
    sendText: async () => {},
    core: { hub: { turnSendersAllOwner: () => true }, http: { send: noop, body: async () => ({}) } },
    dataDir: () => dir,
  }
}

async function boot(dir) {
  try { return { ok: true, ret: await mod.setup(makeApi(dir)) } } catch (e) { return { ok: false, error: e } }
}

const dirs = []
try {
  // ---- A：第一次装，还没有状态文件 ----
  const a = makeGameDir(); dirs.push(a)
  const ra = await boot(a)
  ok(ra.ok, 'A 没有状态文件：setup 成功', ra.ok ? '' : String((ra.error && ra.error.message) || ra.error))
  ok(ra.ok && ra.ret && ra.ret._test && ra.ret._test.autoState.running === false, 'A running 是 false')

  // ---- B：running:true 且刚刷过心跳（就是「一轮正在进行」）----
  const b = makeGameDir(); dirs.push(b)
  fs.writeFileSync(path.join(b, 'data', 'auto-life.json'), JSON.stringify({ day: '2026-11-19', count: 2, lastAt: Date.now(), running: true, lastResult: '' }), 'utf8')
  const rb = await boot(b)
  ok(rb.ok, 'B 磁盘上 running:true（一轮正在进行）：setup 必须成功', rb.ok ? '' : String((rb.error && rb.error.message) || rb.error))
  ok(rb.ok && rb.ret && rb.ret._test && rb.ret._test.autoState.running === true, 'B 新鲜的 running:true 不该被复位')
  ok(rb.ok && rb.ret._test.autoSkipReason(rb.ret._test.autoState, Date.now()) === '上一轮还在跑', 'B 刚刷过心跳：autoSkipReason 判「上一轮还在跑」')

  // ---- C：running:true 但 lastAt 已经是 10 分钟前（进程死在半路）----
  const c = makeGameDir(); dirs.push(c)
  fs.writeFileSync(path.join(c, 'data', 'auto-life.json'), JSON.stringify({ day: '2026-11-19', count: 3, lastAt: Date.now() - 10 * 60000, running: true }), 'utf8')
  const rc = await boot(c)
  ok(rc.ok, 'C 残留的 running:true（10 分钟前）：setup 成功', rc.ok ? '' : String((rc.error && rc.error.message) || rc.error))
  ok(rc.ok && rc.ret && rc.ret._test && rc.ret._test.autoState.running === false, 'C 陈旧的 running 被复位成 false')
} finally {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { /* 清不掉就算了 */ } }
}

console.log(process.exitCode ? '有断言失败' : '全部通过')
