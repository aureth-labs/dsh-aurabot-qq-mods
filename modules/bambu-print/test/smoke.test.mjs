// test/smoke.test.mjs —— 用假宿主完整装配一次，确认所有 route 都能调、返回体不含秘密。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import mod from '../index.mjs'

const FAST_KDF = { N: 1024, r: 8, p: 1 }

test('装配后所有 route 可调用，且响应/落盘都不含秘密', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-smoke-'))
  try {
    const handlers = []
    const routes = new Map()
    const settings = {
      enabled: true, users: '200002', groups: '700001', groupMode: 'status',
      groupPhoto: true, allowGroupName: false, unlockDays: 7, maxBindings: 5,
      requestTimeoutMs: 2000, selectedTtlMinutes: 10, defaultInterface: 'cloud',
      ownerInterface: '', ownerLocalAllowed: true, tutkBridgePath: '', tutkLibPath: '', tutkTimeoutMs: 8000,
    }
    const replies = []
    const api = {
      id: 'bambu-print', dir: path.join(dir, 'module'), settings: () => settings, saveSettings: (p) => Object.assign(settings, p),
      dataDir: (...p) => path.join(dir, ...p), config: () => ({ ownerQQ: '100001' }),
      isOwner: (qq) => String(qq) === '100001',
      log: { info () {}, warn () {}, error () {}, debug () {} },
      reply: async (m, t) => { replies.push(String(t)) },
      sendImage: async () => {}, onebot: async () => ({}),
      command: () => {}, route: (p, fn) => routes.set(p, fn), tool: () => {}, rule: () => {}, context: () => {},
      on: (e, fn) => handlers.push({ e, fn }), onDispose: () => {}, defineTool: (t) => t,
      core: { http: { body: async (req) => req.__body || {}, query: (req) => req.__query || {} } },
      __bambuTestHooks: {
        kdf: FAST_KDF,
        printerManager: { targetKey: (t) => t.serial, closeAll () {}, status: async () => ({ ok: false, error: 'x' }), command: async () => ({ ok: true }) },
        captureFrame: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
        listDevices: async () => ({ ok: true, devices: [] }),
        createCloudLogin: () => ({ login: async () => ({ ok: true, accessToken: 'TOKEN-XYZ', uid: '1', region: 'us' }), requestCode: async () => ({ ok: true, channel: 'email' }), submitCode: async () => ({ ok: true, accessToken: 'TOKEN-XYZ', uid: '1', region: 'us' }), submitTfa: async () => ({ ok: true, accessToken: 'TOKEN-XYZ', uid: '1', region: 'us' }) }),
        mintTutcode: async () => ({ ok: false, code: 'NO_UID', error: 'no uid' }),
        captureTutkFrame: async () => ({ ok: false, code: 'X', error: 'x' }),
      },
    }
    mod.setup(api)
    // 注册了什么
    assert.ok(routes.has('/overview'))
    for (const p of ['/overview', '/unlock', '/lock', '/interface', '/groupperm', '/bindings', '/bind', '/unbind', '/status', '/control', '/photo', '/grant', '/revoke', '/audit', '/login', '/login/code', '/login/tfa', '/logout', '/tutk/status', '/tutk/mint']) {
      assert.ok(routes.has(p), '缺路由 ' + p)
    }
    const call = (p, body) => routes.get(p)({ __body: body || {}, __query: body || {} })
    const ov = await call('/overview')
    assert.equal(ov.ok, true)
    assert.equal(JSON.stringify(ov).includes('TOKEN-XYZ'), false)
    // 未解锁时的各个入口都应给出明确 code，而不是抛异常
    const status = await call('/status', { qq: '200002' })
    assert.equal(status.ok, false)
    assert.equal(status.code, 'NO_USER', '没建号的用户查状态要被拒（不是 LOCKED —— 没有安全码了）')
    const bind = await call('/bind', { qq: '200002', mode: 'lan', accessCode: 'X', printers: [] })
    assert.equal(bind.ok, false)
    const loginLocked = await call('/login', { qq: '200002', account: 'a@b.c', password: 'x' })
    assert.equal(loginLocked.ok, false)
    assert.equal(JSON.stringify(loginLocked).includes('a@b.c'), false, '账号不能回显')
    const tutk = await call('/tutk/status')
    assert.equal(tutk.ok, true)
    assert.equal(JSON.stringify(tutk).includes('TOKEN-XYZ'), false)
    // 桥不可用（模块目录里没有编译产物）也要给明确状态，不抛异常
    assert.equal(tutk.bridge.ok, false)
    assert.equal(tutk.bridge.builtin, true, '默认指向模块自带桥')
    assert.equal(tutk.lib.ok, false)
    assert.match(tutk.lib.download, /open-bamboo-networking/)
    await call('/unlock', { qq: '200002', code: 'x' }).catch(() => {})
    // 落盘文件：不含 secret 字样。除 vault/grants/审计外，还有登录信封的私钥与已用记录。
    const files = await readdir(dir)
    assert.deepEqual(files.sort(), ['audit.jsonl', 'bbx-key.json', 'grants.json', 'vault.json'])
    for (const f of files) {
      const raw = await readFile(path.join(dir, f), 'utf8')
      assert.equal(raw.includes('TOKEN-XYZ'), false, f + ' 不能有明文 token')
    }
    // 信封私钥文件里绝不能出现任何明文秘密
    const keyRaw = await readFile(path.join(dir, 'bbx-key.json'), 'utf8')
    assert.match(keyRaw, /privateJwk/)
    assert.equal(keyRaw.includes('a@b.c'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('TUTK 组件自检：桥和 BambuSource 都在时应报 ok', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-smoke2-'))
  try {
    const modDir = path.join(dir, 'module')
    const bridgeDir = path.join(modDir, 'assets', 'tutk-bridge')
    await mkdir(bridgeDir, { recursive: true })
    const exeName = process.platform === 'win32' ? 'bambu-tutk-bridge.exe' : 'bambu-tutk-bridge-linux-x64'
    const libName = process.platform === 'win32' ? 'BambuSource.dll' : 'libBambuSource.so'
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(path.join(bridgeDir, exeName), Buffer.alloc(2048, 1))
    await chmod(path.join(bridgeDir, exeName), 0o755)
    await writeFile(path.join(bridgeDir, libName), Buffer.alloc(128 * 1024, 2))

    const routes = new Map()
    const settings = {
      enabled: true, users: '200002', groups: '700001', groupMode: 'status',
      groupPhoto: true, allowGroupName: false, unlockDays: 7, maxBindings: 5,
      requestTimeoutMs: 2000, selectedTtlMinutes: 10, defaultInterface: 'cloud',
      ownerInterface: '', ownerLocalAllowed: true, tutkBridgePath: '', tutkLibPath: '', tutkTimeoutMs: 8000,
    }
    const api = {
      id: 'bambu-print', dir: modDir, settings: () => settings, saveSettings: (p) => Object.assign(settings, p),
      dataDir: (...p) => path.join(dir, ...p), config: () => ({ ownerQQ: '100001' }),
      isOwner: (qq) => String(qq) === '100001',
      log: { info () {}, warn () {}, error () {}, debug () {} },
      reply: async () => {}, sendImage: async () => {}, onebot: async () => ({}),
      command: () => {}, route: (p, fn) => routes.set(p, fn), tool: () => {}, rule: () => {}, context: () => {},
      on: () => {}, onDispose: () => {}, defineTool: (t) => t,
      core: { http: { body: async (req) => req.__body || {}, query: (req) => req.__query || {} } },
      __bambuTestHooks: { kdf: FAST_KDF },
    }
    mod.setup(api)
    const tutk = await routes.get('/tutk/status')({ __body: {}, __query: {} })
    assert.equal(tutk.ok, true)
    assert.equal(tutk.bridge.ok, true, '桥应被识别')
    assert.equal(tutk.bridge.builtin, true, '默认就是自带桥')
    assert.equal(tutk.lib.ok, true, '同目录的库应被识别')
    assert.match(tutk.lib.path, new RegExp(libName.replace('.', '\\.')))
    assert.match(tutk.lib.download, /open-bamboo-networking/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
