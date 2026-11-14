// env-remote.test.mjs —— B2-1/B2-2 测试：env.mjs 平台化（按平台钉版下载/哈希/chmod，可注入不打真网络）
// + 远程设备（ip:port 隧道）：getAdb 幂等自动 connect、/adb/connect 路由、/status 远程标识。
// 全程 fake 注入（hooks / __phoneTestHooks），不打真网络、不真 spawn adb、不碰真手机。
// 运行：mods-fork 仓库根 `node --test modules/phone/test/env-remote.test.mjs`

// PATH 隔离：ensureAdb 的 PATH 探测走真实系统（lib/env.mjs 未开注入口），
// 运行机 PATH 里有 adb（如预装 Android SDK 的 GitHub runner / 本机装过 platform-tools）
// 会抢在「自动下载」断言前命中真 adb（source='path'），测试翻车。
// 本文件全程 fake，不需要任何真实可执行文件；node --test 每个测试文件独立进程，互不影响。
process.env.PATH = ''

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAdb, platformToolsFor } from '../lib/env.mjs'
import phone from '../index.mjs'

// 测试基线：钉死版本与官方哈希（与 env.mjs PT_BY_PLATFORM 一致，改版时两边一起改）
const PT_VERSION = 'r34.0.5'
const WIN_SHA = '3f8320152704377de150418a3c4c9d07d16d80a6c0d0d8f7289c22c499e33571'
const LINUX_SHA = '362f8f6218af0f4c61e5aaafb8e255a426c7a0ee00127dfab7371775081d3124'

test('platformToolsFor：按平台给对应 zip 包名与钉死 sha256，未知平台给可读错误', () => {
  const w = platformToolsFor('win32')
  assert.equal(w.zip, `platform-tools_${PT_VERSION}-windows.zip`)
  assert.equal(w.sha256, WIN_SHA)
  assert.ok(w.mirrors.length >= 3, '三镜像（腾讯/Google 中国/Google 官方）')
  assert.ok(w.mirrors.every((u) => u.endsWith(w.zip)), '所有镜像指向同一个钉版文件名')

  const l = platformToolsFor('linux')
  assert.equal(l.zip, `platform-tools_${PT_VERSION}-linux.zip`)
  assert.equal(l.sha256, LINUX_SHA)

  assert.throws(() => platformToolsFor('darwin'), /不支持的平台/)
})

/** 组 hooks：fake 下载写一个假 zip、fake 解压在 dir/platform-tools/adb 放一个 mode=0o644 的文件。 */
function fakeInstallHooks({ platform = 'linux', sha = '', unzip } = {}) {
  const rec = { downloads: 0, chmods: [], unzipCalls: 0 }
  return {
    rec,
    hooks: {
      platform,
      download: async (url, dest) => {
        rec.downloads++
        rec.lastUrl = url
        writeFileSync(dest, 'fake-zip-bytes')
      },
      sha256File: async () => sha,
      exec: async (_cmd, args) => {
        rec.unzipCalls++
        if (unzip) return unzip(args)
        // 默认：模拟官方 zip 布局（platform-tools/ 一层），adb 文件故意不带可执行位
        const dir = args[args.length - 1]
        const inner = join(dir, 'platform-tools')
        mkdirSync(inner, { recursive: true })
        writeFileSync(join(inner, platform === 'win32' ? 'adb.exe' : 'adb'), 'fake-adb', { mode: 0o644 })
      },
      chmod: (p, mode) => { rec.chmods.push({ p, mode, before: statSync(p).mode }) },
      adbWorks: async () => true, // fake adb 没法真跑 version，直接判可用
    },
  }
}

test('ensureAdb linux 自动安装：走 linux 镜像名 + 钉死哈希校验，解压后补可执行位 0o755', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-env-'))
  const { rec, hooks } = fakeInstallHooks({ platform: 'linux', sha: LINUX_SHA })
  const r = await ensureAdb({ adbPath: '', dataDir: dir, hooks })
  assert.equal(r.source, 'auto')
  assert.equal(r.installed, true)
  assert.equal(rec.downloads, 1, '哈希一次命中，只下载一次')
  assert.ok(rec.lastUrl.includes(`platform-tools_${PT_VERSION}-linux.zip`), '按平台选 linux 包名：' + rec.lastUrl)
  assert.equal(rec.chmods.length, 1, 'unix 侧补 chmod 一次')
  assert.equal(rec.chmods[0].mode, 0o755)
  // fake 解压写的是 0o644（无执行位），chmod 后应变可执行
  assert.equal(rec.chmods[0].before & 0o111, 0, '进来的 adb 原本没有可执行位')
  // 临时 zip 已删：目录里只剩解压产物
  const left = readdirSync(dir).filter((n) => n.endsWith('.zip'))
  assert.deepEqual(left, [], '临时 zip 用完即删')
  rmSync(dir, { recursive: true, force: true })
})

test('ensureAdb win32：沿用 windows 镜像名，且不触发 chmod（Windows 无需可执行位）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-env-'))
  const { rec, hooks } = fakeInstallHooks({ platform: 'win32', sha: WIN_SHA })
  const r = await ensureAdb({ adbPath: '', dataDir: dir, hooks })
  assert.equal(r.source, 'auto')
  assert.ok(rec.lastUrl.includes(`platform-tools_${PT_VERSION}-windows.zip`))
  assert.deepEqual(rec.chmods, [], 'win32 不做 chmod')
  rmSync(dir, { recursive: true, force: true })
})

test('ensureAdb 哈希不匹配：换镜像重试三源后报 missing，坏包当场删掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-env-'))
  const { hooks } = fakeInstallHooks({ platform: 'linux', sha: 'deadbeef'.repeat(8) })
  const warns = []
  const r = await ensureAdb({ adbPath: '', dataDir: dir, log: (t, m) => { if (t === 'warn') warns.push(m) } , hooks })
  assert.equal(r.source, 'missing')
  assert.ok(/sha256 不匹配/.test(r.error || ''), '错误信息说清是哈希不匹配：' + (r.error || ''))
  const left = readdirSync(dir).filter((n) => n.endsWith('.zip'))
  assert.deepEqual(left, [], '坏包不残留')
  rmSync(dir, { recursive: true, force: true })
})

test('ensureAdb 全镜像下载失败：报 missing 且带各镜像错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-env-'))
  const { hooks } = fakeInstallHooks({ platform: 'linux' })
  hooks.download = async () => { throw new Error('网络不通') }
  const r = await ensureAdb({ adbPath: '', dataDir: dir, hooks })
  assert.equal(r.source, 'missing')
  assert.ok(/网络不通/.test(r.error || ''), '错误信息透传镜像失败原因')
  rmSync(dir, { recursive: true, force: true })
})

// ---------- B2-2：远程设备（隧道）----------

const DUMP_XML =
  '<hierarchy><node class="android.widget.Button" text="签到" clickable="true" bounds="[10,10][200,90]"/></hierarchy>'

/** fake api（deviceSerial 可配，adbConnect 可捕获） */
function fakeApi({ deviceSerial = '', adbConnect } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-remote-'))
  const rec = { thinkCalls: [], connectCalls: [], createdSerials: [] }
  const settings = {
    enabled: true, adbPath: 'C:/fake/adb.exe', deviceSerial,
    whitelist: 'com.a', maxSteps: 5, rateLimit: 30, confirmWrites: true,
    dryRun: false, closeAppsAfter: false, sessionTimeoutMs: 60000,
    writeEventMemory: true, decisionModel: '', autoBrowse: false, intervalHours: 4, maxRunsPerDay: 3,
  }
  const fakeAdb = {
    currentPackage: async () => 'com.a',
    dumpNodes: async () => DUMP_XML,
    screenshot: async () => Buffer.from('png'),
    tap: async () => {}, pressKey: async () => {}, swipe: async () => {}, key: async () => {},
    longPress: async () => {}, launchApp: async () => {}, forceStop: async () => {},
    inputText: async () => {}, clearText: async () => {},
    devices: async () => [deviceSerial],
    adb: async () => '',
  }
  const api = {
    __phoneTestHooks: {
      ensureAdb: async () => ({ adbPath: 'C:/fake/adb.exe', installed: false, source: 'config' }),
      createAdb: (o) => { rec.createdSerials.push(o.serial); return fakeAdb },
      ...(adbConnect ? { adbConnect: async (adbPath, serial) => { rec.connectCalls.push({ adbPath, serial }); return { stdout: 'connected to ' + serial } } } : {}),
    },
    dataDir: () => dir,
    settings: () => settings,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ask: async () => 'x',
    think: async (prompt, opts = {}) => { rec.thinkCalls.push({ key: opts.key }); return '{"action":"finish","ok":true,"summary":"ok"}' },
    config: () => ({ ownerQQ: '' }),
    sendText: async () => {},
    reply: async () => {},
    use: () => null,
    later: () => () => {},
    every: (_ms, fn) => { rec.sweep = fn; return () => {} },
    on: () => () => {},
    onDispose: () => {},
    tool: () => {},
    defineTool: (t) => t,
    command: () => {},
    route: (path, handler) => { rec.routes = rec.routes || new Map(); rec.routes.set(path, handler) },
    core: {
      getConfig: () => ({ ext: { phone: {} } }),
      setConfig: () => {},
      listModels: async () => [],
      http: { body: async (req) => req.__body || {} },
      hub: {},
    },
  }
  return { api, rec, dir }
}

test('getAdb：serial 是 ip:port 时先幂等 adb connect（隧道自动重连），普通 serial 不 connect', async () => {
  // 网络序列号：走一轮任务，断言 connect 被调一次且 serial 传对
  const a = fakeApi({ deviceSerial: '100.64.0.5:39051', adbConnect: true })
  const mod = phone.setup(a.api)
  const r = await mod.run({ goal: '签到' })
  assert.equal(r.ok, true)
  assert.equal(a.rec.connectCalls.length, 1, '网络序列号应触发一次幂等 connect')
  assert.deepEqual(a.rec.connectCalls[0].serial, '100.64.0.5:39051')
  assert.equal(a.rec.createdSerials[0], '100.64.0.5:39051', 'createAdb 仍按原 serial 建（adb -s ip:port）')

  // 普通序列号：不触发 connect
  const b = fakeApi({ deviceSerial: 'TESTSERIAL', adbConnect: true })
  phone.setup(b.api)
  await b.rec.routes.get('/status')({ url: 'http://x/status' })
  assert.equal(b.rec.connectCalls.length, 0, 'USB/模拟器序列号不做 connect')
  rmSync(a.dir, { recursive: true, force: true })
  rmSync(b.dir, { recursive: true, force: true })
})

test('getAdb：connect 失败不阻断（warn 后继续，让后续命令自然报可读错误）', async () => {
  const warns = []
  const { api, rec, dir } = fakeApi({ deviceSerial: '10.0.0.9:5555' })
  api.__phoneTestHooks.adbConnect = async () => { rec.connectCalls.push({}); throw new Error('connection refused') }
  api.log.warn = (m) => warns.push(m)
  const mod = phone.setup(api)
  const r = await mod.run({ goal: '签到' })
  assert.equal(r.ok, true, 'connect 失败不应让任务直接挂掉')
  assert.ok(warns.some((m) => /connect 失败/.test(m)))
  rmSync(dir, { recursive: true, force: true })
})

test('/adb/connect：合法 ip:port 连接成功；非法 serial 被拒；/status 带远程标识', async () => {
  const { api, rec, dir } = fakeApi({ deviceSerial: '100.64.0.5:39051', adbConnect: true })
  phone.setup(api)
  const post = (body) => rec.routes.get('/adb/connect')({ method: 'POST', url: 'http://x/adb/connect', __body: body })
  const ok = await post({ serial: '100.64.0.5:39051' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.serial, '100.64.0.5:39051')
  assert.ok(/connected/i.test(ok.message || ''))

  // 非法 serial：不是 ip:port 一律拒（防任意参数进 adb 命令行）
  for (const bad of ['TESTSERIAL', '../../etc', '100.64.0.5', '100.64.0.5:port', '']) {
    const r = await post({ serial: bad })
    assert.equal(r.ok, false, `非法 serial「${bad}」应被拒`)
    assert.ok(/ip:port/.test(r.error || ''))
  }
  // /status：远程标识 = serial 是网络序列号
  const st = await rec.routes.get('/status')({ url: 'http://x/status' })
  assert.equal(st.remote, true)
  rmSync(dir, { recursive: true, force: true })

  // 本地 serial 时 remote=false
  const b = fakeApi({ deviceSerial: 'TESTSERIAL' })
  phone.setup(b.api)
  const st2 = await b.rec.routes.get('/status')({ url: 'http://x/status' })
  assert.equal(st2.remote, false)
  rmSync(b.dir, { recursive: true, force: true })
})
