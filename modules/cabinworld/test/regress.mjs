// 回归测试：两个已修 bug 的纯逻辑。
// 1) goToVerdict —— 桥返回 done + result.ok:false 时不能说成成功，更不能写记忆。
// 2) autoSkipReason —— 上一轮 running 明显超时（5 分钟）必须放行，否则自动生活永久卡死。
// 用法：node test/regress.mjs
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
  tool: () => () => {},
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

const t = ret && ret._test
ok(!!t && typeof t.goToVerdict === 'function', 'setup 暴露了 _test.goToVerdict')
ok(!!t && typeof t.autoSkipReason === 'function', 'setup 暴露了 _test.autoSkipReason')

if (t && typeof t.goToVerdict === 'function') {
  // 核心回归：done + result.ok:false 必须是非空字符串（即被当成失败）
  const v1 = t.goToVerdict({ status: 'done', result: { ok: false, outcome: '门锁着' } }, false)
  ok(typeof v1 === 'string' && v1.length > 0, 'done+ok:false 返回非空', JSON.stringify(v1))
  ok(v1.indexOf('门锁着') >= 0, '失败原因带出来', JSON.stringify(v1))
  ok(v1.indexOf('没走成') >= 0, '文案是「没走成…」', JSON.stringify(v1))

  const v2 = t.goToVerdict({ status: 'done', result: { ok: false } }, false)
  ok(typeof v2 === 'string' && v2.length > 0, 'done+ok:false 无原因也返回非空', JSON.stringify(v2))

  // 真成功必须返回空串，调用方才会 remember
  const v3 = t.goToVerdict({ status: 'done', result: { ok: true, happened: ['走到了'] } }, false)
  ok(v3 === '', 'done+ok:true 返回空串（表示成功）', JSON.stringify(v3))

  const v4 = t.goToVerdict({ status: 'failed', error: '被挡住' }, false)
  ok(typeof v4 === 'string' && v4.indexOf('被挡住') >= 0, 'failed 带出错误', JSON.stringify(v4))
}

if (t && typeof t.autoSkipReason === 'function') {
  const now = 1795000000000
  ok(t.autoSkipReason({ running: false }, now) === '', '没在跑 → 放行')
  ok(t.autoSkipReason({ running: true, lastAt: now - 60000 }, now) === '上一轮还在跑', '跑了 1 分钟 → 跳过')
  // 核心回归：超过 120 秒必须放行
  ok(t.autoSkipReason({ running: true, lastAt: now - 290000 }, now) === '上一轮还在跑', '跑了 4 分 50 秒 → 仍在阈值内，继续跳过')
  ok(t.autoSkipReason({ running: true, lastAt: now - 310000 }, now) === '', '过了 5 分钟 → 放行（自愈）')
  ok(t.autoSkipReason({ running: true, lastAt: 0 }, now) === '', 'lastAt 为 0 → 放行')
}

console.log(process.exitCode ? '有断言失败' : '全部通过')
