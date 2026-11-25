// test/tutk-bridge.test.mjs —— 模块自带 C 桥的调用与降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, stat, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureViaBridge, checkBridgeBinary, defaultBridgePath, platformAsset, verifyBridgeHash, BRIDGE_MAX_SECONDS } from '../lib/tutk-bridge.mjs'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9])
const URL = 'bambu:///tutk?uid=ABCDEFGHIJKLMNOPQRST&authkey=KEY&passwd=SECRET&region=us'

function fakeSpawn (plan) {
  const calls = []
  const impl = (cmd, args) => {
    calls.push({ cmd, args })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(async () => {
      try {
        const r = await plan(cmd, args)
        if (r && r.stderr) child.stderr.emit('data', Buffer.from(r.stderr))
        if (r && r.stdout != null) child.stdout.emit('data', r.stdout)
        child.emit('close', r && r.code != null ? r.code : 0)
      } catch (err) {
        child.stderr.emit('data', Buffer.from(String((err && err.message) || err)))
        child.emit('close', 1)
      }
    })
    return child
  }
  return { impl, calls }
}

test('默认桥路径按平台命名', () => {
  const p = defaultBridgePath('C:/mods/bambu-print')
  assert.match(p, /assets[\\/]tutk-bridge[\\/]bambu-tutk-bridge/)
  assert.equal(defaultBridgePath(''), '')
})

test('MJPEG 样本直接返回，URL 不进 argv', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const spawn = fakeSpawn(async (cmd, args) => {
      await writeFile(args[args.indexOf('--dump') + 1], JPEG)
      return { code: 0 }
    })
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/bambu-tutk-bridge', dir, spawnImpl: spawn.impl })
    assert.equal(r.ok, true)
    assert.equal(r.via, 'mjpeg')
    const argv = spawn.calls[0].args.join(' ')
    assert.equal(argv.includes('passwd'), false, 'argv 不能带凭据')
    assert.equal(argv.includes('--url-file'), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('H.264 样本交给 ffmpeg 转一帧', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const spawn = fakeSpawn(async (cmd, args) => {
      if (args.includes('--dump')) {
        await writeFile(args[args.indexOf('--dump') + 1], Buffer.from([0, 0, 0, 1, 0x67]))
        return { code: 0 }
      }
      await writeFile(args[args.length - 1], JPEG)
      return { code: 0 }
    })
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/bridge', dir, spawnImpl: spawn.impl })
    assert.equal(r.ok, true)
    assert.equal(r.via, 'h264')
    assert.match(spawn.calls[1].args.join(' '), /-f h264/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('桥失败 / 空样本 / 缺路径 / 缺 URL 的错误码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const fail = fakeSpawn(async () => ({ code: 5, stderr: 'Bambu_Open 失败' }))
    const r1 = await captureViaBridge({ url: URL, bridgePath: '/x/bridge', dir, spawnImpl: fail.impl })
    assert.equal(r1.code, 'BRIDGE_FAILED')
    assert.match(r1.error, /Bambu_Open/)

    const dir2 = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
    const empty = fakeSpawn(async (cmd, args) => { await writeFile(args[args.indexOf('--dump') + 1], Buffer.alloc(0)); return { code: 0 } })
    const r2 = await captureViaBridge({ url: URL, bridgePath: '/x/bridge', dir: dir2, spawnImpl: empty.impl })
    await rm(dir2, { recursive: true, force: true })
    assert.equal(r2.code, 'EMPTY_DUMP')

    assert.equal((await captureViaBridge({ url: URL })).code, 'NO_BRIDGE')
    assert.equal((await captureViaBridge({ bridgePath: '/x' })).code, 'NO_URL')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('错误文本脱敏 + checkBridgeBinary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const spawn = fakeSpawn(async () => ({ code: 1, stderr: 'bad url ' + URL }))
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/bridge', dir, spawnImpl: spawn.impl })
    assert.equal(r.error.includes('SECRET'), false)
    assert.equal((await checkBridgeBinary('')).code, 'NO_BRIDGE')
    assert.equal((await checkBridgeBinary('/definitely/not/here')).code, 'MISSING')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/* ---------------- review 修复的回归用例 ---------------- */

test('platformAsset / defaultBridgePath：按 platform+arch 选构件，其它平台明确不支持（P3-2）', () => {
  assert.equal(platformAsset('win32', 'x64').bridge, 'bambu-tutk-bridge.exe')
  assert.equal(platformAsset('linux', 'x64').bridge, 'bambu-tutk-bridge-linux-x64')
  for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'arm64']]) {
    const t = platformAsset(p, a)
    assert.equal(t.ok, false, p + '/' + a + ' 不能被当成 Linux x64')
    assert.equal(t.code, 'UNSUPPORTED_PLATFORM')
    assert.match(t.error, /Windows x64 与 Linux x64|自己编/)
    assert.equal(t.bridge, '', '不支持的平台不能给出一个错架构的可执行文件')
    // defaultBridgePath 也不该静默拼出 Linux x64 的路径
    assert.equal(defaultBridgePath('/mods/bambu-print', p, a), '')
  }
  assert.match(defaultBridgePath('/mods/bambu-print', 'linux', 'x64'), /bambu-tutk-bridge-linux-x64$/)
  assert.match(defaultBridgePath('/mods/bambu-print', 'win32', 'x64'), /bambu-tutk-bridge\.exe$/)
  assert.equal(defaultBridgePath(''), '')
})

test('seconds 不再被截断到 30s：45s / 60s 原样传给桥，上限仍是 60（P3-3）', async () => {
  const seen = []
  const spawn = fakeSpawn(async (cmd, args) => {
    seen.push(args[args.indexOf('--seconds') + 1])
    await writeFile(args[args.indexOf('--dump') + 1], JPEG)
    return { code: 0 }
  })
  // captureViaBridge 结束会删临时目录，每次用独立的 dir
  for (const s of [31, 45, 60, 90]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/bridge', dir, seconds: s, spawnImpl: spawn.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    await rm(dir, { recursive: true, force: true })
  }
  assert.deepEqual(seen, ['31', '45', '60', String(BRIDGE_MAX_SECONDS)], '31~60s 必须原样下传，超过 60 才夹住')
  assert.equal(BRIDGE_MAX_SECONDS, 60, '和面板 tutkTimeoutMs 上限 60000ms 对齐')
})

test('桥不认识新参数时回退到旧协议：stdin JSON → stdout JPEG（P2/P3-2）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const written = []
    const spawn = fakeSpawn(async (cmd, args) => {
      // 旧自定义桥：看到 --url-file 就报 usage 错误
      if (args.includes('--url-file')) return { code: 1, stderr: 'usage: bridge < stdin' }
      return { code: 0, stdout: JPEG }
    })
    const proc = spawn.impl
    // 记录写到 stdin 的内容：包一层，模拟真实子进程的 stdin
    const wrapped = (cmd, args, opts) => {
      const child = proc(cmd, args, opts)
      child.stdin = {
        write: (s) => { written.push(String(s)); return true },
        end: () => {},
        on: () => {},
      }
      return child
    }
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/custom-bridge', dir, spawnImpl: wrapped })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.via, 'mjpeg')
    assert.equal(r.protocol, 'legacy')
    assert.equal(spawn.calls.length, 2, '先试新协议，再用旧协议跑一次')
    assert.equal(spawn.calls[1].args.length, 0, '旧协议不带参数')
    assert.equal(written.length, 1)
    const payload = JSON.parse(written[0].trim())
    assert.equal(payload.url, URL, 'URL 走 stdin，不进 argv')
    assert.equal(payload.format, 'jpeg')
    // 凭据仍然不进 argv
    assert.equal(spawn.calls.flatMap((c) => c.args).join(' ').includes('SECRET'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('旧桥退出 0 但没写 --dump 文件 → 也回退旧协议（P2/P3-2）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const spawn = fakeSpawn(async (cmd, args) => {
      if (args.includes('--dump')) return { code: 0 } // 什么都不写
      return { code: 0, stdout: JPEG }
    })
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/custom-bridge', dir, spawnImpl: spawn.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.protocol, 'legacy')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('旧桥 stdout 不是 JPEG / 太大 → 明确报错（P2/P3-2）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  try {
    const junk = fakeSpawn(async () => ({ code: 0, stdout: Buffer.from('not a jpeg at all') }))
    const r = await captureViaBridge({ url: URL, bridgePath: '/x/custom-bridge', dir, spawnImpl: junk.impl })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'BAD_JPEG', JSON.stringify(r))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// 打包 zip 不保留文件模式的位（scripts/lib.mjs 的 makeZip 不写 external attributes），
// 所以用户装完模块后桥是 0644；不补执行位的话 Linux / macOS 上 spawn 直接 EACCES。
test('抓帧前给桥补执行位：从 0644 装进来的桥也能跑（zip 丢模式位）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  const oldPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    const bridge = path.join(dir, 'bambu-tutk-bridge')
    await writeFile(bridge, '#!/bin/sh\nexit 0\n')
    await chmod(bridge, 0o644)
    assert.equal(((await stat(bridge)).mode & 0o111), 0, '前置条件：装进来时没有执行位')

    // captureViaBridge 会把自己的临时目录整个删掉（这里连 bridge 一起），
    // 所以给它单独开一个目录，别把桥放进去——否则下面 stat 会 ENOENT。
    const work = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-work-'))
    const plan = fakeSpawn(async () => ({ code: 1, stderr: 'no samples' }))
    await captureViaBridge({ url: URL, bridgePath: bridge, dir: work, spawnImpl: plan.impl })
    // 平台不是 win32 才会去补；测试机若不是 Linux 就跳过这条断言
    if (process.platform !== 'win32') {
      assert.notEqual(((await stat(bridge)).mode & 0o111), 0, '抓帧前应该补上执行位')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    if (oldPlatform) Object.defineProperty(process, 'platform', oldPlatform)
  }
})

// 模块带的是预编译二进制，审核者 / 用户看不出它和 .c 的关系，所以用 SHA256SUMS 钉住；
// 对不上就一个字都不执行。
test('桥哈希校验：一致才放行，被改过就拒绝，清单缺失时跳过（老版本兼容）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-hash-'))
  try {
    const bridge = path.join(dir, 'bambu-tutk-bridge-linux-x64')
    const body = Buffer.from('假的可执行文件')
    await writeFile(bridge, body)
    const sums = path.join(dir, 'SHA256SUMS')
    const good = createHash('sha256').update(body).digest('hex')

    // 1) 清单缺失：跳过，不让老用户画面直接坏掉
    const none = await verifyBridgeHash(bridge)
    assert.equal(none.ok, true)
    assert.equal(none.skipped, true)

    // 2) 清单里没有这个文件名：跳过（用户自己换的桥）
    await writeFile(sums, good + '  something-else.exe\n')
    const other = await verifyBridgeHash(bridge)
    assert.equal(other.ok, true)
    assert.equal(other.skipped, true)

    // 3) 哈希一致：放行
    await writeFile(sums, good + '  bambu-tutk-bridge-linux-x64\n')
    const ok = await verifyBridgeHash(bridge)
    assert.equal(ok.ok, true)
    assert.equal(ok.expected, good)

    // 4) 文件被改过：拒绝，并说清楚期望值
    await writeFile(bridge, Buffer.from('被改过的'))
    const bad = await verifyBridgeHash(bridge)
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'BRIDGE_HASH_MISMATCH')
    assert.match(bad.message, /sha256/)
    assert.equal(bad.expected, good)

    // 5) 抓帧入口也要拦：不让它偷偷执行
    const plan = fakeSpawn(async () => ({ code: 0, stdout: JPEG }))
    const blocked = await captureViaBridge({ url: URL, bridgePath: bridge, dir, spawnImpl: plan.impl })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'BRIDGE_HASH_MISMATCH')
    assert.equal(plan.calls.length, 0, '哈希对不上时不应该 spawn')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('checkBridgeBinary：只配 BAMBU_SOURCE_LIB 时也算找到库，并说明来源（P3-1）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-bridge-test-'))
  const old = process.env.BAMBU_SOURCE_LIB
  try {
    const bridge = path.join(dir, 'bambu-tutk-bridge')
    await writeFile(bridge, 'x')
    await chmod(bridge, 0o755)
    const lib = path.join(dir, 'somewhere', 'libBambuSource.so')
    await mkdir(path.dirname(lib), { recursive: true })
    await writeFile(lib, Buffer.alloc(70 * 1024, 1))

    process.env.BAMBU_SOURCE_LIB = lib
    const viaEnv = await checkBridgeBinary(bridge)
    assert.equal(viaEnv.ok, true)
    assert.equal(viaEnv.libOk, true, '只在环境变量里配的库也要认')
    assert.equal(viaEnv.libSource, 'env')
    assert.equal(viaEnv.libPath, lib)

    // 配置项优先于环境变量
    const other = path.join(dir, 'other.so')
    await writeFile(other, Buffer.alloc(70 * 1024, 2))
    const viaCfg = await checkBridgeBinary(bridge, { libPath: other })
    assert.equal(viaCfg.libOk, true)
    assert.equal(viaCfg.libSource, 'configured')

    // 环境变量指向不存在的文件 → 回落到桥同目录
    process.env.BAMBU_SOURCE_LIB = path.join(dir, 'nope.so')
    const sibling = await checkBridgeBinary(bridge)
    assert.equal(sibling.libSource, 'sibling')
    assert.equal(sibling.libOk, false, '同目录没库时如实报缺')

    // 完全没有库 → libOk=false，消息里列出试过的地方
    delete process.env.BAMBU_SOURCE_LIB
    const none = await checkBridgeBinary(bridge)
    assert.equal(none.libOk, false)
    assert.match(none.libMessage, /同目录|BambuSource/)
  } finally {
    if (old === undefined) delete process.env.BAMBU_SOURCE_LIB
    else process.env.BAMBU_SOURCE_LIB = old
    await rm(dir, { recursive: true, force: true })
  }
})

