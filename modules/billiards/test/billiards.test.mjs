// modules/billiards/test/billiards.test.mjs —— 模块侧单测（不碰真 Electron、不联网）
// 覆盖：定义与 module.json 对齐、客户端模板齐全、球面皮肤（素材包 → file:/// 地址表）、
//       Electron 定位与环境变量、开桌面球桌 / 已开着不重复起 / 关掉的进程账目、面板可解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod, { DEFAULTS } from '../index.mjs'
import { buildAnims, packNames, pickAnims, pickPack, webmFiles, MAX_BALL_SKINS } from '../lib/anims.mjs'
import {
  DEFAULT_MIRROR, ELECTRON_VERSION, cleanElectronEnv, electronCandidates, electronRelExe, mirrorUrl, npmCliCandidates,
} from '../lib/electron.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(DIR, 'module.json'), 'utf8'))

// file:/// 地址永远用正斜杠，中文名会被转义——比尾巴前统一解出来再归一
const urlTail = (href) => decodeURIComponent(href).replace(/\\/g, '/')

test('定义与 module.json 一致，市场页才不会显示两个版本号', () => {
  for (const key of ['id', 'name', 'version', 'description', 'api']) assert.equal(mod[key], manifest[key], key)
  assert.equal(mod.panel, 'panel.js')
  assert.deepEqual(manifest.capabilities, ['filesystem', 'process'])
  assert.deepEqual(manifest.requires, [])
})

test('客户端模板齐全：入口 CLIENT_FILES 列了谁，lib/client/ 就得有什么', () => {
  const listed = readFileSync(join(DIR, 'index.mjs'), 'utf8').match(/const CLIENT_FILES = \[([\s\S]*?)\]/)[1]
  const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 4, 'CLIENT_FILES 解析失败')
  for (const name of names) assert.ok(existsSync(join(DIR, 'lib', 'client', name)), `缺 ${name}`)
})

test('panel.js 能按插件的方式解析（整文件即函数体）', () => {
  const source = readFileSync(join(DIR, 'panel.js'), 'utf8')
  assert.doesNotThrow(() => new Function('React', 'h', 'ui', 'call', source))
  for (const path of ['/status', '/open-arena', '/close', '/electron-install']) {
    assert.ok(source.includes(`'${path}'`), `面板少了 ${path}`)
  }
})

// ---------- 球面皮肤（纯函数） ----------
test('包名 / 文件名的扫描规则', () => {
  assert.deepEqual(packNames(['default-animation', 'cat-animation', 'house', 'x-config.json', '-animation']), ['cat', 'default'])
  assert.equal(pickPack(['cat', 'default'], 'cat'), 'cat')
  assert.equal(pickPack(['cat', 'default'], 'nope'), 'default')
  assert.equal(pickPack(['cat'], ''), 'cat')
  assert.equal(pickPack([], 'nope'), '')
  assert.deepEqual(webmFiles(['a.webm', 'A.WEBM', 'b.png', '坏 名@#.webm']), ['a.webm', 'A.WEBM'])
})

test('idle 池优先，池子为空回落整目录', () => {
  const files = ['idle-1.webm', 'idle-2.webm', 'other.webm']
  assert.deepEqual(pickAnims(files, ['idle-1', 'idle-2']), ['idle-1.webm', 'idle-2.webm'])
  assert.deepEqual(pickAnims(files, ['不存在']), files, '池子里的名字对不上目录就用整目录')
  assert.deepEqual(pickAnims(files, []), files)
})

test('buildAnims 给的是 file:/// 本地地址，且数量有限', () => {
  const a = buildAnims({ pack: 'default', dir: '/packs/default-animation', files: ['a.webm', 'b.webm'] })
  assert.equal(a.pack, 'default')
  assert.equal(a.urls.length, 2)
  assert.ok(a.urls[0].startsWith('file:///'), a.urls[0])
  assert.ok(urlTail(a.urls[0]).endsWith('default-animation/a.webm'))
  assert.deepEqual(buildAnims({ pack: 'x', dir: '', files: ['a.webm'] }), { pack: '', urls: [] }, '没有目录就不该编地址')
  assert.deepEqual(buildAnims({ pack: 'x', dir: '/d', files: [] }), { pack: '', urls: [] })
  const many = buildAnims({ pack: 'x', dir: '/d', files: Array.from({ length: 40 }, (_, i) => `a${i}.webm`) })
  assert.equal(many.urls.length, MAX_BALL_SKINS)
})

// ---------- 运行时（纯函数） ----------
test('镜像地址：留空回落默认，末尾补斜杠', () => {
  assert.equal(mirrorUrl(''), DEFAULT_MIRROR)
  assert.equal(mirrorUrl('   '), DEFAULT_MIRROR)
  assert.equal(mirrorUrl('不是 URL'), DEFAULT_MIRROR)
  assert.equal(mirrorUrl('https://mirror.example/electron'), 'https://mirror.example/electron/')
  assert.equal(mirrorUrl('https://mirror.example/electron/'), 'https://mirror.example/electron/')
})

test('各平台的 electron 二进制相对路径', () => {
  assert.deepEqual(electronRelExe('win32'), ['dist', 'electron.exe'])
  assert.deepEqual(electronRelExe('darwin'), ['dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'])
  assert.deepEqual(electronRelExe('linux'), ['dist', 'electron'])
})

test('候选运行时：先自己的，再桌宠那份；没桌宠就不列', () => {
  const both = electronCandidates({ appDir: '/data/app', petDir: '/data/pet' })
  assert.equal(both.length, 2)
  assert.equal(both[0].source, 'billiards')
  assert.equal(both[1].dir, join('/data/pet', 'app', 'node_modules', 'electron'))
  assert.equal(electronCandidates({ appDir: '/data/app', petDir: '' }).length, 1)
})

test('启动 Electron 前必须摘掉 ELECTRON_RUN_AS_NODE（否则 electron.exe 变成 node，永远不开窗）', () => {
  const env = cleanElectronEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: '/bin' })
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in env, false)
  assert.equal(env.PATH, '/bin')
  assert.equal(cleanElectronEnv({ A: '1' }).A, '1', '只该改副本，不能动调用方的 process.env')
})

test('npm-cli.js 的候选位置跟着当前 Node 走', () => {
  const c = npmCliCandidates(join('/opt/node', 'bin', 'node'))
  assert.equal(c[0], join('/opt/node', 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  assert.ok(c[1].includes('lib'))
})

// ---------- 路由：拿真临时目录当数据目录，假 spawn/kill 当进程 ----------
function world({ pet = null, skins = true, withElectron = false, alivePids = [], npmCli = '', npmExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-billiards-'))
  const dataRoot = join(root, 'modules-data')
  const api = {
    dir: DIR,
    // 真实 api.dataDir() 会带上模块 id，并把 modules-data/billiards/ 自动建好；
    // 传子路径只是拼路径（所以 dataDir('process.json') 是文件，不是目录）。
    dataDir: (...parts) => {
      mkdirSync(dataRoot, { recursive: true })
      mkdirSync(join(dataRoot, 'billiards'), { recursive: true })
      return join(dataRoot, 'billiards', ...parts)
    },
    settings: () => ({ ...DEFAULTS, ballSkin: skins ? 'pack' : 'plain' }),
    saveSettings: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    use: (id) => (id === 'pet' ? pet : null),
    route: (path, handler) => { api.routes.set(path, handler) },
    routes: new Map(),
    __billiardsTestHooks: {
      npmCli,
      spawn: (exe, args, opts) => {
        api.spawns.push({ exe, args, opts })
        const child = {
          pid: 4242,
          on: (event, cb) => { if (event === 'close') setTimeout(() => cb(npmExit), 0) },
          unref: () => {},
        }
        return child
      },
      kill: (pid) => { api.kills.push(pid); if (!alivePids.includes(pid)) { const e = new Error('no such'); e.code = 'ESRCH'; throw e } },
      alive: (pid) => alivePids.includes(pid),
    },
  }
  api.spawns = []
  api.kills = []
  mod.setup(api)
  if (withElectron) {
    const dist = join(api.dataDir('app'), 'node_modules', 'electron', ...electronRelExe().slice(0, -1))
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, electronRelExe().at(-1)), '')
  }
  return { api, root, dataRoot, app: join(dataRoot, 'billiards', 'app'), petRoot: join(dataRoot, 'pet') }
}

test('路由挂齐，setup 就把客户端铺到数据目录（模板在模块目录里只读）', () => {
  const w = world()
  try {
    for (const path of ['/status', '/open-arena', '/close', '/electron-install']) {
      assert.ok(w.api.routes.has(path), `缺路由 ${path}`)
    }
    for (const name of ['main.js', 'arena.html', 'billiards-rules.js', 'arena-preload.js']) {
      assert.ok(existsSync(join(w.app, name)), `app/ 里缺 ${name}`)
    }
    assert.equal(JSON.parse(readFileSync(join(w.app, 'package.json'), 'utf8')).type, undefined, 'app/package.json 不能写 type')
    const st = w.api.routes.get('/status')()
    assert.equal(st.client.ready, true)
    assert.equal(st.electron, null)
    assert.equal(st.running, false)
    assert.match(st.message, /安装 Electron/)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('没运行时不开进程：/open-arena 只回提示', () => {
  const w = world()
  try {
    const r = w.api.routes.get('/open-arena')()
    assert.equal(r.ok, false)
    assert.match(r.message, /还没装 Electron/)
    assert.equal(w.api.spawns.length, 0)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('开桌面球桌：进程账目、cwd 和摘掉的 ELECTRON_RUN_AS_NODE', () => {
  process.env.ELECTRON_RUN_AS_NODE = '1'
  const w = world({ withElectron: true, alivePids: [4242] })
  try {
    const r = w.api.routes.get('/open-arena')()
    assert.equal(r.ok, true, r.message)
    assert.equal(r.pid, 4242)
    assert.equal(w.api.spawns.length, 1)
    const spawn = w.api.spawns[0]
    assert.deepEqual(spawn.args, ['main.js'])
    assert.equal(spawn.opts.cwd, w.app)
    assert.equal(spawn.opts.detached, true)
    assert.equal(spawn.opts.windowsHide, true)
    assert.equal('ELECTRON_RUN_AS_NODE' in spawn.opts.env, false)
    const rec = JSON.parse(readFileSync(join(w.dataRoot, 'billiards', 'process.json'), 'utf8'))
    assert.equal(rec.pid, 4242)
    assert.equal(w.api.routes.get('/status')().running, true)
    // 已经开着再点一次：不重复起进程（第二个 Electron 抢不到单实例锁，会自杀在窗口后面）
    const again = w.api.routes.get('/open-arena')()
    assert.equal(again.alreadyRunning, true)
    assert.equal(w.api.spawns.length, 1)
    assert.equal(w.api.routes.get('/close')().ok, true)
    assert.equal(existsSync(join(w.dataRoot, 'billiards', 'process.json')), false, '关掉后要清掉进程记录')
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE
    rmSync(w.root, { recursive: true, force: true })
  }
})

test('记录里的进程已经没了：当没在跑，并清掉这条记录', () => {
  const w = world({ withElectron: true, alivePids: [4242] })
  try {
    w.api.routes.get('/open-arena')()
    // 直接把记录改成「进程不在了」：/close 应该说没在运行，而不是报错
    writeFileSync(join(w.dataRoot, 'billiards', 'process.json'), JSON.stringify({ pid: 999999, startedAt: 1 }))
    const closed = w.api.routes.get('/close')()
    assert.equal(closed.ok, false)
    assert.match(closed.message, /没在运行/)
    assert.equal(existsSync(join(w.dataRoot, 'billiards', 'process.json')), false)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('借桌宠素材包：anims.json 落成 file:/// 地址，idle 池优先', () => {
  const pet = { activePack: () => 'default', packView: () => ({ animations: { idle: ['游', '睡'] } }) }
  const w = world({ pet })
  try {
    const packDir = join(w.petRoot, 'packs', 'default-animation')
    mkdirSync(packDir, { recursive: true })
    for (const name of ['游', '睡', '说话']) writeFileSync(join(packDir, `${name}.webm`), '')
    const st = w.api.routes.get('/status')()
    assert.equal(st.anims.pack, 'default')
    assert.equal(st.anims.count, 2, '只该拿到 idle 池里那两段')
    const anims = JSON.parse(readFileSync(join(w.app, 'anims.json'), 'utf8'))
    assert.equal(anims.pack, 'default')
    assert.equal(anims.urls.length, 2)
    assert.ok(anims.urls.every((u) => u.startsWith('file:///')))
    assert.ok(urlTail(anims.urls[0]).endsWith('default-animation/游.webm'))
    // 普通球面：urls 空，页面回落色球
    const plain = world({ pet, skins: false })
    try {
      mkdirSync(join(plain.petRoot, 'packs', 'default-animation'), { recursive: true })
      writeFileSync(join(plain.petRoot, 'packs', 'default-animation', '游.webm'), '')
      assert.deepEqual(plain.api.routes.get('/status')().anims, { pack: '', count: 0 })
    } finally { rmSync(plain.root, { recursive: true, force: true }) }
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('没装桌宠也能玩：anims 空、状态说普通球面', () => {
  const w = world({ pet: null })
  try {
    assert.deepEqual(w.api.routes.get('/status')().anims, { pack: '', count: 0 })
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('app/ 里的客户端被手改坏 / 缺文件：开台前按模板补回来', () => {
  const w = world({ withElectron: true, alivePids: [4242] })
  try {
    const rule = join(w.app, 'billiards-rules.js')
    writeFileSync(rule, '坏掉了')
    rmSync(join(w.app, 'arena.html'))
    const st = w.api.routes.get('/status')()
    assert.equal(st.client.ready, false, '缺文件要在状态里看得见，不能静默')
    assert.deepEqual(st.client.missing, ['arena.html'])
    w.api.routes.get('/open-arena')()
    assert.ok(readFileSync(rule, 'utf8').includes('BilliardsRules'), '该用模板覆盖被改坏的副本')
    assert.ok(existsSync(join(w.app, 'arena.html')))
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('安装 Electron：已经有运行时就不动 npm', async () => {
  const w = world({ withElectron: true })
  try {
    const r = await w.api.routes.get('/electron-install')()
    assert.equal(r.ok, true)
    assert.equal(r.alreadyInstalled, true)
    assert.equal(w.api.spawns.length, 0, '不该起 npm 子进程')
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('安装 Electron：本机没有 npm 时给出手动命令，而不是硬跑一次', async () => {
  const w = world({ npmCli: '' })
  try {
    const r = await w.api.routes.get('/electron-install')()
    assert.equal(r.ok, false)
    assert.match(r.message, /npm install -D electron@/)
    assert.match(r.message, new RegExp(String(ELECTRON_VERSION).replace('.', '\\.')))
    assert.ok(r.message.includes(w.app), '得把该在哪个目录跑说出来')
    assert.equal(w.api.spawns.length, 0)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('安装 Electron：命令行参数（本机 npm + 钉版本 + 镜像 + 不碰别处）', async () => {
  const w = world({ npmCli: '/fake/npm-cli.js' })
  try {
    const r = await w.api.routes.get('/electron-install')()
    assert.equal(w.api.spawns.length, 1, '该起一次 npm')
    const spawn = w.api.spawns[0]
    assert.equal(spawn.exe, process.execPath, '用当前 Node 跑 npm-cli.js，不经 shell')
    assert.deepEqual(spawn.args, ['/fake/npm-cli.js', 'install', '-D', `electron@${ELECTRON_VERSION}`])
    assert.equal(spawn.opts.cwd, w.app)
    assert.equal(spawn.opts.env.ELECTRON_MIRROR, DEFAULT_MIRROR)
    // 假 npm「装成功」但磁盘上没有二进制 → 诚实报没装上，不能谎报 ok
    assert.equal(r.ok, false)
    assert.match(r.message, /没装上/)
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})

test('安装 Electron：镜像设置里填了什么就用什么', async () => {
  const w = world({ npmCli: '/fake/npm-cli.js' })
  try {
    w.api.settings = () => ({ ...DEFAULTS, electronMirror: 'https://mirror.example/electron' })
    await w.api.routes.get('/electron-install')()
    assert.equal(w.api.spawns[0].opts.env.ELECTRON_MIRROR, 'https://mirror.example/electron/')
  } finally { rmSync(w.root, { recursive: true, force: true }) }
})
