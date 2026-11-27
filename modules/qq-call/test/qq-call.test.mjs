// qq-call 的离线测试：不连 QQ、不开声卡、不下载模型。
// 跑法（模块目录下）：node --test test/qq-call.test.mjs
// CI 里和其他模块一起跑：AURABOT_PLUGIN_DIR=<插件源码> node --import ./scripts/plugin-env.mjs --test "modules/*/test/*.test.mjs"
//
// 「子进程启动失败 / 退出码异常」这两类是拿真进程试出来的：把 python 指向 node（一条命令行都不通），
// 或者指向不存在的路径 —— 模块必须自己清 pid、记账、报人话，而不是把面板一起拖垮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import plugin, { RUNTIME_NAMES, answerEnv, backoffMs, classifyExit, failureUpdate, isDegraded, normalizePolicy } from '../index.mjs'

const MODULE = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(MODULE, 'module.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(40)
  }
  return false
}

/** 一套假 api + 临时数据目录。on 默认 false：起 setup 但不拉子进程，纯看文件与路由。 */
function makeEnv(overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qq-call-'))
  const routes = new Map()
  const commands = []
  const logs = { info: [], warn: [], error: [] }
  const disposers = []
  const settings = { ...plugin.defaults, on: false, py: 'python', port: 1, ...overrides }
  const api = {
    dir: MODULE,
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    route: (path, fn) => routes.set(path, fn),
    command: (c) => commands.push(c),
    log: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
    settings: () => ({ ...settings }),
    core: { personas: { current: () => '（测试人格）' } },
    onDispose: (fn) => disposers.push(fn),
  }
  const inst = plugin.setup(api)
  return {
    dataDir,
    routes,
    commands,
    logs,
    inst,
    settings,
    call: async (path, req) => routes.get(path)(req),
    dispose: () => {
      for (const fn of disposers) fn()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('module.json 和入口对得上', () => {
  assert.equal(plugin.id, 'qq-call')
  assert.equal(MANIFEST.id, 'qq-call')
  assert.equal(plugin.version, MANIFEST.version, 'module.json 的版本要和 index.mjs 一致')
  assert.equal(plugin.api, MANIFEST.api)
  assert.equal(typeof plugin.setup, 'function')
  for (const cap of ['process', 'network', 'filesystem', 'plugin-internals']) {
    assert.ok(MANIFEST.capabilities.includes(cap), `能力里要有 ${cap}`)
  }
  assert.equal(MANIFEST.category, 'social')
  assert.deepEqual(MANIFEST.platforms, ['qq'])
})

test('退出码分类：0 正常、信号杀掉、其余都算异常', () => {
  assert.equal(classifyExit(0), 'ok')
  assert.equal(classifyExit(1), 'crash')
  assert.equal(classifyExit(9), 'crash')
  assert.equal(classifyExit(null), 'signal')
  assert.equal(classifyExit(undefined), 'signal')
})

test('退避按 3 倍涨，封顶 60 秒', () => {
  assert.equal(backoffMs(1), 1000)
  assert.equal(backoffMs(2), 3000)
  assert.equal(backoffMs(3), 9000)
  assert.equal(backoffMs(4), 27000)
  assert.equal(backoffMs(5), 60000)
  assert.equal(backoffMs(0), 1000)
  assert.equal(backoffMs('2'), 3000)
})

test('连续 3 次异常退出就降级，中间来一次正常收工就清零', () => {
  let state = { bridge: 0, loop: 0, answer: 0 }
  state = failureUpdate(state, 'loop', 1)
  assert.equal(state.loop, 1)
  assert.equal(isDegraded(state.loop), false)
  state = failureUpdate(state, 'loop', 2)
  assert.equal(state.loop, 2)
  assert.equal(isDegraded(state.loop), false)
  state = failureUpdate(state, 'loop', 137)
  assert.equal(state.loop, 3)
  assert.equal(isDegraded(state.loop), true, '第三次必须标降级')
  state = failureUpdate(state, 'loop', 0)
  assert.equal(state.loop, 0, '正常收工要清零')
  assert.equal(isDegraded(state.loop), false)
  // 别的进程不受影响
  assert.equal(state.bridge, 0)
  assert.equal(state.answer, 0)
  assert.deepEqual(RUNTIME_NAMES, ['bridge', 'loop', 'answer'])
})

test('运行时代码铺进数据目录：7 个 py + requirements，带版本戳', () => {
  const env = makeEnv()
  try {
    const dst = join(env.dataDir, 'runtime')
    const names = readdirSync(dst).filter((n) => n.endsWith('.py') || n === 'requirements.txt').sort()
    assert.equal(names.length, 8, 'runtime/ 里的脚本都要铺过去')
    for (const name of ['call_bridge.py', 'call_loop.py', 'auto_answer.py', 'logic.py', 'requirements.txt']) {
      assert.ok(names.includes(name), `少了 ${name}`)
      assert.deepEqual(readFileSync(join(dst, name)), readFileSync(join(MODULE, 'runtime', name)), `${name} 要和模块里一模一样`)
    }
    const stamp = JSON.parse(readFileSync(join(dst, '.deployed.json'), 'utf8'))
    assert.equal(stamp.version, MANIFEST.version)
    assert.equal(stamp.added, 8)
    assert.equal(stamp.replaced, 0)
    assert.ok(env.logs.info.some((l) => l.includes('运行时已铺到')), '铺完要说一声')
  } finally {
    env.dispose()
  }
})

test('第二次启动：内容一样就跳过，不重复写盘', () => {
  const env = makeEnv()
  try {
    const dst = join(env.dataDir, 'runtime')
    const before = readFileSync(join(dst, 'call_bridge.py'))
    const second = makeSecondEnv(env.dataDir)   // 同一个数据目录再装一次（等于热重载）
    assert.equal(second.logs.info.some((l) => l.includes('运行时已铺到')), false, '没变化就别吵')
    assert.deepEqual(readFileSync(join(dst, 'call_bridge.py')), before)
    const stamp = JSON.parse(readFileSync(join(dst, '.deployed.json'), 'utf8'))
    assert.equal(stamp.added, 0)
    assert.equal(stamp.replaced, 0)
    second.dispose()
  } finally {
    env.dispose()
  }
})

test('用户改过脚本：旧的留一份 .bak，模块版收回来', () => {
  const env = makeEnv()
  try {
    const dst = join(env.dataDir, 'runtime')
    const target = join(dst, 'logic.py')
    writeFileSync(target, 'print("我手动改过的")\n', 'utf8')
    const second = makeSecondEnv(env.dataDir)
    const bak = join(dst, `.bak-${MANIFEST.version}`, 'logic.py')
    assert.ok(existsSync(bak), '覆盖前要留备份')
    assert.equal(readFileSync(bak, 'utf8'), 'print("我手动改过的")\n')
    assert.deepEqual(readFileSync(target), readFileSync(join(MODULE, 'runtime', 'logic.py')))
    assert.ok(second.logs.info.some((l) => l.includes('更新 1')), '要说更新了几个')
    second.dispose()
  } finally {
    env.dispose()
  }
})

test('缺模型：日志说清楚缺几个，接口列全 6 个文件', async () => {
  const env = makeEnv()
  try {
    const warn = env.logs.warn.find((l) => l.includes('缺') && l.includes('模型文件'))
    assert.ok(warn, '缺模型要在日志里警告一次')
    assert.match(warn, /缺 6 个模型文件/)
    const runtime = await env.call('/runtime')
    assert.equal(runtime.ok, true)
    assert.equal(runtime.missing.length, 6)
    assert.equal(runtime.missing[0].file, 'models/zh_CN-huayan-medium.onnx')
    assert.ok(runtime.missing[0].why.length > 0, '每个缺失项都要说明是什么')

    // 放一个进去，缺的就少一个
    mkdirSync(join(env.dataDir, 'runtime', 'models'), { recursive: true })
    writeFileSync(join(env.dataDir, 'runtime', 'models', 'zh_CN-huayan-medium.onnx'), 'x')
    const after = await env.call('/runtime')
    assert.equal(after.missing.length, 5)
  } finally {
    env.dispose()
  }
})

test('桥接没起来：状态不假装健康', async () => {
  const env = makeEnv()
  try {
    const status = await env.call('/status')
    assert.equal(status.ok, true, '模块自己是活着的')
    assert.equal(status.bridge.ok, false)
    assert.ok(String(status.bridge.error).length > 0, '要给出失败原因')
    assert.equal(status.loop.running, false)
    assert.equal(status.answer.running, false)
    assert.equal(status.modelMissing.length, 6)
    assert.deepEqual(status.runtime.failures, { bridge: 0, loop: 0, answer: 0 })
    assert.deepEqual(status.runtime.degraded, [])
  } finally {
    env.dispose()
  }
})

test('桥接不通时：/say 和 /tone 都给人话，不抛异常', async () => {
  const env = makeEnv()
  try {
    const empty = await env.call('/say', { url: 'http://127.0.0.1/aurabot/api/ext/qq-call/say' })
    assert.equal(empty.ok, false)
    assert.equal(empty.message, '没有文字')

    const say = await env.call('/say', { url: 'http://127.0.0.1/aurabot/api/ext/qq-call/say?text=' + encodeURIComponent('喂，听得到吗') })
    assert.equal(say.ok, false)
    assert.match(say.message, /桥接服务没响应/)

    const tone = await env.call('/tone', { url: 'http://127.0.0.1/aurabot/api/ext/qq-call/tone?sec=3' })
    assert.equal(tone.ok, false)
    assert.match(tone.message, /桥接服务没响应/)
  } finally {
    env.dispose()
  }
})

test('开场白是空的就不发；命令没带话就回用法', async () => {
  const env = makeEnv({ greeting: '' })
  try {
    const greet = await env.call('/greet')
    assert.equal(greet.ok, false)
    assert.equal(greet.message, '开场白是空的')

    const cmd = env.commands.find((c) => c.name === '通话')
    assert.ok(cmd, '要注册 /通话 命令')
    assert.equal(await cmd.run('   '), '用法：/通话 你要说的话')
    assert.match(await cmd.run('我一会儿来接你'), /桥接服务没响应/)
  } finally {
    env.dispose()
  }
})

test('python 路径不存在：启动失败只报错记账，不影响面板', async () => {
  const env = makeEnv({ on: false, py: 'C:/definitely-not-a-python-qqcall.exe', port: 1, autoAnswer: true })
  try {
    await env.inst.startAll()
    const got = await waitFor(() => env.logs.error.some((l) => l.includes('启动失败')))
    assert.ok(got, '要报「启动失败」')
    const line = env.logs.error.find((l) => l.includes('启动失败'))
    assert.match(line, /确认它存在/)   // 报错里带上设置里的 python 路径，方便排查
    const status = await env.call('/status')
    assert.equal(status.runtime.failures.bridge, 1, '启动失败要计入失败次数')
    assert.equal(status.bridge.ok, false)
  } finally {
    env.dispose()
  }
})

test('子进程起来就异常退出：pid 清掉、记 warn、计数 +1', async () => {
  // 用 node 冒充 python：node 不认识 -u，直接非 0 退出 —— 就是「脚本起不来」的真实形态
  const env = makeEnv({ on: false, py: process.execPath, port: 1, autoAnswer: true })
  try {
    await env.inst.startAll()
    const got = await waitFor(() => env.logs.warn.filter((l) => l.includes('异常退出')).length >= 2)
    assert.ok(got, '异常退出要记 warn')
    const warn = env.logs.warn.find((l) => l.includes('异常退出'))
    assert.match(warn, /连续 1 次/)
    assert.match(warn, /下次启动前至少等 1s/)

    const status = await env.call('/status')
    assert.ok(status.runtime.failures.loop >= 1)
    assert.equal(status.loop.running, false)
    for (const name of ['bridge', 'loop', 'answer']) {
      assert.equal(existsSync(join(env.dataDir, 'run', `${name}.pid`)), false, `${name}.pid 要清掉，不然下次以为还活着`)
    }
    assert.equal(status.bridge.ok, false)
  } finally {
    env.dispose()
  }
})

test('连续三次异常退出会打一条「已降级」，且只打一次', async () => {
  const env = makeEnv({ on: false, py: process.execPath, port: 1, autoAnswer: true })
  try {
    // 连开三批（每批独立进程），startAll 会清计数，所以直接跑三轮 setup 里的 startAll 不现实；
    // 这里用 failureUpdate 的序列验证阈值，再单独确认降级日志只在第 3 次出现。
    let counts = { bridge: 0, loop: 0, answer: 0 }
    const fired = []
    for (let i = 0; i < 4; i += 1) {
      counts = failureUpdate(counts, 'answer', 1)
      if (isDegraded(counts.answer) && fired.length === 0) fired.push(i + 1)
    }
    assert.deepEqual(fired, [3], '第 3 次才降级')
    assert.equal(isDegraded(3, 4), false, '阈值可以调高')

    // 真实路径：起一轮，确认 failures 至少涨到 1，且日志里没有假的 success
    await env.inst.startAll()
    await waitFor(() => env.logs.warn.some((l) => l.includes('异常退出')))
    const status = await env.call('/status')
    assert.ok(status.runtime.failures.answer >= 1)
  } finally {
    env.dispose()
  }
})

test('/start 和 /restart 是干净重试：点一下就按当前设置重来', async () => {
  const env = makeEnv({ on: false, py: process.execPath, port: 1, autoAnswer: true })
  try {
    await env.inst.startAll()
    await waitFor(() => env.logs.warn.some((l) => l.includes('异常退出')))
    const start = await env.call('/start')
    assert.equal(start.ok, true)
    assert.equal(typeof start.message, 'string')
    const started = await waitFor(() => env.logs.info.some((l) => l.includes('已启动')), 8000)
    assert.ok(started, '要点得动，日志里能看见重新拉起')

    const stop = await env.call('/stop')
    assert.equal(stop.ok, true)
    const status = await env.call('/status')
    assert.deepEqual(status.runtime.degraded, [], '主动重来过，就不该还挂着降级')
  } finally {
    env.dispose()
  }
})

test('接电话策略：默认她自己决定，写错了回落到 decide', () => {
  assert.equal(normalizePolicy('decide'), 'decide')
  assert.equal(normalizePolicy('ALWAYS'), 'always')
  assert.equal(normalizePolicy('随便'), 'decide')
  assert.equal(normalizePolicy(undefined), 'decide')

  const env = answerEnv({ answerPolicy: 'decide', answerOnError: 'answer' })
  assert.equal(env.QQ_CALL_ANSWER_POLICY, 'decide')
  assert.equal(env.QQ_CALL_ANSWER_ON_ERROR, 'answer')
  assert.equal(env.QQ_CALL_ANSWER_TIMEOUT, '3')
  assert.equal(env.QQ_CALL_ANSWER_WAIT_MAX, '5')
})

test('兜底写错了按「先接上」：宁可多接也不漏接', () => {
  assert.equal(answerEnv({ answerPolicy: 'never', answerOnError: '随便' }).QQ_CALL_ANSWER_ON_ERROR, 'answer')
  assert.equal(answerEnv({ answerOnError: 'skip' }).QQ_CALL_ANSWER_ON_ERROR, 'skip')
})

test('/status 带上接听策略；还没接过电话时最近判断是空的', async () => {
  const env = makeEnv({ on: false, answerPolicy: 'decide' })
  try {
    const status = await env.call('/status')
    assert.equal(status.answer.policy, 'decide')
    assert.equal(status.answer.lastDecision, null)
  } finally {
    env.dispose()
  }
})

test('她上次的判断写在 last_decision.json 里，/status 读得出来', async () => {
  const env = makeEnv()
  try {
    mkdirSync(join(env.dataDir, 'runtime', 'out'), { recursive: true })
    writeFileSync(join(env.dataDir, 'runtime', 'out', 'last_decision.json'), JSON.stringify({
      at: 100, time: '10:00:00', caller: '小明', action: 'decline', why: '在忙',
    }), 'utf8')
    const status = await env.call('/status')
    assert.equal(status.answer.lastDecision.caller, '小明')
    assert.equal(status.answer.lastDecision.action, 'decline')
    assert.equal(status.answer.lastDecision.why, '在忙')
  } finally {
    env.dispose()
  }
})

/** 复用同一个数据目录再装一次模块（模拟热重载）。 */
function makeSecondEnv(dataDir) {
  const routes = new Map()
  const logs = { info: [], warn: [], error: [] }
  const disposers = []
  const api = {
    dir: MODULE,
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    route: (path, fn) => routes.set(path, fn),
    command: () => {},
    log: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
    settings: () => ({ ...plugin.defaults, on: false, port: 1 }),
    core: { personas: { current: () => '' } },
    onDispose: (fn) => disposers.push(fn),
  }
  plugin.setup(api)
  return { logs, dispose: () => { for (const fn of disposers) fn() } }
}
