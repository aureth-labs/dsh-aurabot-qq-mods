import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod from '../modules/roost-bridge/index.mjs'
import * as roost from '../modules/roost-bridge/lib/roost.mjs'
import * as state from '../modules/roost-bridge/lib/state.mjs'
import { createGatewayRestore } from '../modules/roost-bridge/lib/gateway-restore.mjs'

const manifest = JSON.parse(readFileSync(new URL('../modules/roost-bridge/module.json', import.meta.url), 'utf8'))

test('模块清单与入口一致', () => {
  assert.equal(mod.id, manifest.id)
  assert.equal(mod.version, manifest.version)
  assert.equal(mod.api, manifest.api)
  assert.equal(mod.category, manifest.category)
  assert.deepEqual(manifest.capabilities, [
    'network',
    'filesystem',
    'process',
    'plugin-config',
    'dynamic-code',
    'plugin-internals',
  ])
})

test('panel.js 能被宿主 new Function 解析', () => {
  const source = readFileSync(new URL('../modules/roost-bridge/panel.js', import.meta.url), 'utf8')
  assert.doesNotThrow(() => new Function(source))
})

test('内置依赖放在 bundled/ 且能准备到 ROOST_HOME', () => {
  const vendorDir = fileURLToPath(new URL('../modules/roost-bridge/lib/vendor/roost', import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'roost-bridge-deps-'))
  try {
    const result = roost.prepareDeps({ vendorDir, homeDir: home, log() {} })
    assert.equal(result.ok, true)
    const target = join(home, 'data', 'deps', 'ext', 'node_modules')
    for (const name of ['ws', 'silk-wasm']) {
      assert.ok(existsSync(join(target, name, 'package.json')), `缺 ${name}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('接入时关空间能力，恢复时还原', () => {
  const patch = roost.aurabotPatch({ port: 6707, token: 't'.repeat(24), selfUin: '4015248048' })
  assert.equal(patch.gateway, 'onebot')
  assert.equal(patch.botQQ, '4015248048')
  assert.equal(patch.snowluma.wsUrl, 'ws://127.0.0.1:6707')
  assert.equal(patch.diary.enabled, false)
  assert.equal(patch.qzoneSocial.enabled, false)

  const restore = roost.restoreGatewayPatch({ botQQ: '2854204853', diary: true, qzoneSocial: true })
  assert.equal(restore.gateway, 'snowluma')
  assert.equal(restore.botQQ, '2854204853')
  assert.equal(restore.diary.enabled, true)
  assert.equal(restore.qzoneSocial.enabled, true)
})

test('落盘端口为 0 时仍能读出 token；lastBridgePort 可作为快照', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-bridge-port-'))
  try {
    mkdirSync(join(home, 'config', 'bots'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'bots', 'main.json'),
      JSON.stringify({ onebot: { enabled: true, port: 0, token: 'stored-token', selfUin: '4015248048' } }),
    )
    const disk = roost.readBridgeSettings(home, 'main')
    assert.equal(disk.port, 0)
    assert.equal(disk.token, 'stored-token')

    state.set({ lastBridgePort: 6707 })
    assert.equal(state.get().lastBridgePort, 6707)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('启动时把 roost 自动更新锁成 false', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-bridge-autoapply-'))
  try {
    mkdirSync(join(home, 'config'), { recursive: true })
    const file = join(home, 'config', 'bot.json')
    writeFileSync(file, JSON.stringify({ update: { autoApply: true, autoCheck: true } }))
    const result = roost.lockAutoApply(home)
    assert.equal(result.ok, true)
    assert.equal(result.changed, true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.update.autoApply, false)
    assert.equal(saved.update.autoCheck, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('随包 roost 有来源锁定，且模块整体为 AGPL', () => {
  const moduleDir = fileURLToPath(new URL('../modules/roost-bridge/', import.meta.url))
  const vendor = fileURLToPath(new URL('../modules/roost-bridge/lib/vendor/roost/', import.meta.url))
  // 入口用的就是这个 helper：它指错地方等于「模块自带的 roost 找不到」，必须在单测里钉住
  assert.ok(existsSync(join(roost.inplaceDir(moduleDir), 'src', 'main.js')), 'inplaceDir() 没指向随包母本')
  for (const name of ['LICENSE', 'SOURCE.md', 'SOURCE.sha256']) {
    assert.ok(existsSync(join(vendor, name)), `缺 ${name}`)
  }
  assert.ok(!existsSync(join(vendor, 'LICENSE-EXCEPTION.md')), '不应再保留许可证例外文件')
  const manifest = JSON.parse(readFileSync(join(moduleDir, 'module.json'), 'utf8'))
  assert.equal(manifest.license, 'AGPL-3.0-only')
  assert.match(readFileSync(join(moduleDir, 'LICENSE'), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/)
  const lines = readFileSync(join(vendor, 'SOURCE.sha256'), 'utf8').trim().split('\n')
  assert.ok(lines.length >= 140, `校验和条目太少：${lines.length}`)
  assert.ok(lines.every((line) => /^[a-f0-9]{64}  \S+$/.test(line)))
})

/* ---------------------------------- 停用 / 卸载后的网关恢复 ---------------------------------- */
// 这段时序是最容易被「看起来对」骗过去的地方：热重载也走 onDispose，恢复早了就把网关切走。
// 用独立的 env 对象模拟跨实例标记，宽限期压到毫秒级，不依赖真宿主。

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** 造一个干净的恢复调度器：独立的 env，收集写配置调用 */
function makeRestore({ env = {}, graceMs = 10, setConfig, log } = {}) {
  const calls = []
  const logs = []
  const restore = createGatewayRestore({
    state,
    setConfig: setConfig || ((patch) => calls.push(patch)),
    restorePatch: roost.restoreGatewayPatch,
    graceMs,
    env,
    log: log || ((m) => logs.push(m)),
  })
  return { restore, calls, logs, env }
}

test('接入过再停用：宽限期到点写回原网关，且 linked 归位', async () => {
  state.set({ linked: true, prevBotQQ: '2854204853', prevDiaryEnabled: true, prevQzoneSocialEnabled: false })
  const { restore, calls } = makeRestore()
  assert.equal(restore.schedule(), true)
  assert.equal(calls.length, 0, '宽限期内不该动网关')
  await sleep(40)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].gateway, 'snowluma')
  assert.equal(calls[0].botQQ, '2854204853')
  assert.equal(calls[0].diary.enabled, true)
  assert.equal(calls[0].qzoneSocial.enabled, false)
  assert.equal(state.get().linked, false, '恢复后要回到「未接入」')
})

test('热重载：新实例 setup 取消旧实例的待恢复任务，网关不动', async () => {
  state.set({ linked: true, prevBotQQ: '1' })
  const env = {}
  const { restore: old, calls } = makeRestore({ env })
  old.schedule()
  // 模拟宽限期内热重载换上新实例
  const fresh = createGatewayRestore({
    state, setConfig: (patch) => calls.push(patch), restorePatch: roost.restoreGatewayPatch, graceMs: 10, env, log() {},
  })
  assert.ok(fresh.generation > old.generation)
  await sleep(40)
  assert.equal(calls.length, 0, '热重载不该把网关切回去')
  assert.equal(state.get().linked, true)
})

test('旧实例被顶掉后再触发 dispose 不会安排恢复', async () => {
  state.set({ linked: true, prevBotQQ: '1' })
  const env = {}
  const { restore: old, calls } = makeRestore({ env })
  makeRestore({ env }) // 新实例已接管
  assert.equal(old.schedule(), false)
  await sleep(40)
  assert.equal(calls.length, 0)
})

test('没接入过的模块停用时不写网关', async () => {
  state.set({ linked: false })
  const { restore, calls } = makeRestore()
  restore.schedule()
  await sleep(40)
  assert.equal(calls.length, 0)
})

test('恢复写配置抛错时只记日志，不把停用流程炸掉', async () => {
  state.set({ linked: true, prevBotQQ: '1' })
  const { restore, logs } = makeRestore({
    setConfig: () => { throw new Error('boom') },
  })
  restore.schedule()
  await sleep(40)
  assert.ok(logs.some((m) => /停用后自动恢复网关失败/.test(m)), logs.join(' | '))
})

test('重复 schedule 只留最后一次任务，宽限期到点也只写一次', async () => {
  state.set({ linked: true, prevBotQQ: '1' })
  const { restore, calls } = makeRestore({ graceMs: 20 })
  restore.schedule()
  await sleep(5)
  restore.schedule()
  await sleep(80)
  assert.equal(calls.length, 1)
})
