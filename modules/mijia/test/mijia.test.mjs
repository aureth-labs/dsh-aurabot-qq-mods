// test/mijia.test.mjs —— mijia 模块单测（假 fetch，不打真网络）
// 覆盖：扫码登录流程（领码 → 长轮询 → 换 serviceToken）、passToken 静默续期、
//       RC4 加密请求组装与应答解密、设备列表解析（新网关分页）、miot 指令组装、
//       令牌失效续期重试、指令解析（模糊匹配）、权限门、设备列表排版、控制节流。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMiCloud, encParamsWithNonce, decryptBodyWithNonce, genNonce, rc4,
} from '../lib/cloud.js'
import { parseIntent, matchDevice, canControl, formatDevices, classifyDevice, normName } from '../lib/parse.js'

/** 假 fetch：按 URL 前缀分发；记录全部调用供断言 */
function fakeFetch(routes) {
  const calls = []
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init })
    const hit = routes.find((r) => String(url).startsWith(r.prefix))
    if (!hit) throw new Error('假 fetch 没有命中路由：' + url)
    const raw = typeof hit.body === 'function' ? hit.body(calls.length, init) : hit.body
    const text = raw && typeof raw === 'object' && '__raw' in raw ? raw.__raw : raw
    const headers = {}
    const setCookie = (raw && typeof raw === 'object' && raw.setCookie) || hit.setCookie
    if (setCookie) headers['set-cookie'] = setCookie
    return new Response(typeof text === 'string' ? text : JSON.stringify(text), { status: hit.status || 200, headers })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const PASS_PREFIX = 'https://account.xiaomi.com/pass/'
const QRLOGIN_PREFIX = 'https://account.xiaomi.com/longPolling/loginUrl'
const LP_PREFIX = 'https://account.xiaomi.com/longPolling/lp'
const API_PREFIX = 'https://api.mijia.tech/app'
const SPEC_PREFIX = 'https://miot-spec.org/miot-spec-v2'

// 一个 16 字节的 ssecurity（base64），加密测试要原样用它
const SSECR = Buffer.alloc(16, 7).toString('base64')
const LOCATION = 'https://login-stub.example/loc?x=1'
// serviceLogin 首跳的「领码票据」：location 只带 query，客户端原样透传给 loginUrl
const CHALLENGE_LOCATION = 'https://account.xiaomi.com/fe/service/login?sid=mijia&sign=abc&_sign=s1'

/** 从加密请求体里解出业务 JSON（表单里 _nonce/ssecurity 是明文，密钥可推） */
function decodeApiBody(init) {
  const form = new URLSearchParams(init.body)
  return decryptBodyWithNonce(form.get('ssecurity'), form.get('_nonce'), form.get('data'))
}

function qrRoutes() {
  return [
    {
      prefix: PASS_PREFIX + 'serviceLogin?',
      body: '&&&START&&&' + JSON.stringify({ code: 1, location: CHALLENGE_LOCATION, qs: 'q1', sid: 'mijia' }),
    },
    {
      prefix: QRLOGIN_PREFIX,
      body: { code: 0, loginUrl: 'https://qr-stub.example/x1', qr: 'https://qr-stub.example/x1.png', lp: LP_PREFIX + '/wait1' },
    },
    {
      prefix: LP_PREFIX,
      body: {
        __raw:
          '&&&START&&&' +
          JSON.stringify({
            code: 0, userId: '10086', cUserId: '10086', passToken: 'pt-abc',
            ssecurity: SSECR, location: LOCATION,
          }),
      },
    },
    { prefix: LOCATION, body: 'ok', setCookie: ['serviceToken=st-123; Path=/'] },
  ]
}

async function tmpDataDir() {
  return mkdtemp(join(tmpdir(), 'mijia-test-'))
}

async function loggedInCloud(routes, dataDir) {
  const fetchImpl = fakeFetch(routes)
  const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000 })
  await cloud.qrStart()
  await cloud.qrPoll()
  return { cloud, calls: fetchImpl.calls }
}

describe('扫码登录流程', () => {
  test('serviceLogin → 领二维码 → 长轮询收票 → 回调换 serviceToken，令牌落盘', async () => {
    const dataDir = await tmpDataDir()
    const { cloud, calls } = await loggedInCloud(qrRoutes(), dataDir)

    // 第一步：serviceLogin（sid=mijia），Cookie 带 deviceId/pass_o
    const first = calls[0]
    assert.equal(first.url, PASS_BASE_URL())
    assert.match(first.init.headers.Cookie, /deviceId=/)
    assert.match(first.init.headers.Cookie, /pass_o=/)
    assert.match(first.init.headers.Cookie, /passToken=/)

    // 第二步：loginUrl 领二维码，票据参数原样透传
    const second = calls[1]
    assert.ok(second.url.startsWith(QRLOGIN_PREFIX))
    assert.match(second.url, /sign=abc/)
    assert.match(second.url, /_qrsize=240/)

    // 第三步：长轮询 lp，挂 GET 等扫码
    const third = calls[2]
    assert.ok(third.url.startsWith(LP_PREFIX))

    // 第四步：location 回调，收 serviceToken cookie
    const fourth = calls[3]
    assert.ok(fourth.url.startsWith(LOCATION))

    // 令牌落盘：userId/passToken/ssecurity/serviceToken 齐全，票据已清
    const saved = JSON.parse(await readFile(join(dataDir, 'token.json'), 'utf8'))
    assert.equal(saved.userId, '10086')
    assert.equal(saved.passToken, 'pt-abc')
    assert.equal(saved.ssecurity, SSECR)
    assert.equal(saved.serviceToken, 'st-123')
    assert.equal(saved.qr, undefined)
    assert.ok(await cloud.hasLogin())
  })

  test('passToken 仍有效时 qrStart 直接静默续期，无需扫码', async () => {
    const dataDir = await tmpDataDir()
    const fetchImpl = fakeFetch([
      {
        prefix: PASS_PREFIX + 'serviceLogin?',
        body: '&&&START&&&' + JSON.stringify({ code: 0, location: LOCATION, ssecurity: SSECR, userId: '10086', passToken: 'pt-new' }),
      },
      { prefix: LOCATION, body: 'ok', setCookie: ['serviceToken=st-new; Path=/'] },
    ])
    const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000 })
    const r = await cloud.qrStart()
    assert.equal(r.refreshed, true)
    const saved = JSON.parse(await readFile(join(dataDir, 'token.json'), 'utf8'))
    assert.equal(saved.serviceToken, 'st-new')
    assert.equal(saved.ssecurity, SSECR)
  })

  test('扫码超时（code≠0）：票据清空并报可重试错误', async () => {
    const dataDir = await tmpDataDir()
    const fetchImpl = fakeFetch([
      ...qrRoutes().slice(0, 2),
      { prefix: LP_PREFIX, body: { __raw: '&&&START&&&' + JSON.stringify({ code: 20003, description: 'timeout' }) } },
    ])
    const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000 })
    await cloud.qrStart()
    await assert.rejects(() => cloud.qrPoll(), /20003/)
    const saved = JSON.parse(await readFile(join(dataDir, 'token.json'), 'utf8'))
    assert.equal(saved.qr, undefined)
  })

  test('未领码直接 poll：明确报错不发请求', async () => {
    const dataDir = await tmpDataDir()
    const fetchImpl = fakeFetch([])
    const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000 })
    await assert.rejects(() => cloud.qrPoll(), /扫码登录/)
    assert.equal(fetchImpl.calls.length, 0)
  })
})

function PASS_BASE_URL() {
  return PASS_PREFIX + 'serviceLogin?_json=true&sid=mijia&_locale=zh_CN'
}

describe('RC4 加密请求', () => {
  test('往返：加密的 data 经 decryptBodyWithNonce 解回原 JSON（rc4_hash__ 也加密在表单里）', () => {
    const nonce = Buffer.from('nonce-fixed-12').toString('base64')
    const payload = JSON.stringify({ hello: '米家', n: 1 })
    const form = encParamsWithNonce('/x', payload, SSECR, nonce)
    assert.notEqual(form.data, payload, 'data 应是密文')
    assert.equal(form._nonce, nonce)
    assert.equal(form.ssecurity, SSECR)
    assert.ok(form.rc4_hash__, '表单必须带 rc4_hash__（缺了服务端回 auth error）')
    assert.notEqual(form.rc4_hash__, form.signature, 'rc4_hash__ 与 signature 是两回事')
    // rc4_hash__ 解回明文 = 对明文参数算的 sha1 签名（值是 base64 串不是 JSON，用 rc4 直接解）
    const snonce = createHash('sha256')
      .update(Buffer.concat([Buffer.from(SSECR, 'base64'), Buffer.from(nonce, 'base64')]))
      .digest('base64')
    const expectedHash = createHash('sha1')
      .update(['POST', '/x', 'data=' + payload, snonce].join('&'), 'utf8')
      .digest('base64')
    const hashPlain = rc4(Buffer.from(snonce, 'base64'), Buffer.from(form.rc4_hash__, 'base64')).toString('utf8')
    assert.equal(hashPlain, expectedHash)
    assert.deepEqual(decryptBodyWithNonce(SSECR, nonce, form.data), { hello: '米家', n: 1 })
  })

  test('生产 nonce：8 随机字节 + 分钟级时间最少大端字节，能还原分钟值', () => {
    const now = Date.now()
    const raw = Buffer.from(genNonce(now), 'base64')
    assert.ok(raw.length >= 9, 'nonce 至少 8 随机字节 + 1 字节分钟')
    const minutes = BigInt('0x' + raw.subarray(8).toString('hex'))
    assert.equal(Number(minutes), Math.floor(now / 60000))
    // 两秒内生成两次：随机段独立，分钟段一致
    const a = Buffer.from(genNonce(now), 'base64')
    const b = Buffer.from(genNonce(now), 'base64')
    assert.deepEqual(a.subarray(8), b.subarray(8))
  })

  test('RC4 应答双形态：JSON 直通；RC4+gzip 密文也接得住', async () => {
    const { gzipSync } = await import('node:zlib')
    const nonce = Buffer.from('n2').toString('base64')
    const snonce = createHash('sha256')
      .update(Buffer.concat([Buffer.from(SSECR, 'base64'), Buffer.from(nonce, 'base64')]))
      .digest('base64')
    // 形态一：明文 JSON 直通
    assert.deepEqual(decryptBodyWithNonce(SSECR, nonce, JSON.stringify({ code: 0 })), { code: 0 })
    // 形态二：JSON → gzip → RC4（密钥=signed_nonce）→ base64，模拟米家 GZIP+ENCRYPT-RC4 应答
    const plain = Buffer.from(JSON.stringify({ code: 0, result: { ok: true } }), 'utf8')
    const gz = gzipSync(plain)
    const { rc4 } = await import('../lib/cloud.js')
    const cipher = rc4(Buffer.from(snonce, 'base64'), gz).toString('base64')
    assert.deepEqual(decryptBodyWithNonce(SSECR, nonce, cipher), { code: 0, result: { ok: true } })
  })
})

describe('设备列表与 miot 指令（新网关）', () => {
  const HOMES = {
    code: 0,
    result: { homelist: [{ id: '1', uid: 10086, name: '我的家', roomlist: [{ id: 'r1', name: '客厅', dids: [111] }] }] },
  }
  const DEVICES = {
    code: 0,
    result: { device_info: [
      { did: 111, name: '客厅灯', model: 'yeelink.light.lamp1', isOnline: 1 },
      { did: 222, name: '卧室插座', model: 'chuangmi.plug.m1', isOnline: 0 },
    ], has_more: false },
  }
  const SPEC = [
    {
      prefix: SPEC_PREFIX + '/instances',
      body: { instances: [{ model: 'yeelink.light.lamp1', type: 'urn:miot-spec:light-1' }] },
    },
    {
      prefix: SPEC_PREFIX + '/instance',
      body: {
        services: [
          { iid: 1, properties: [] },
          {
            iid: 2,
            properties: [
              { iid: 1, description: '开关', format: 'bool', access: ['read', 'write'], name: 'on' },
              { iid: 2, description: '亮度', format: 'uint8', access: ['read', 'write'], name: 'brightness', 'value-range': [1, 100, 1] },
            ],
          },
        ],
      },
    },
  ]

  test('deviceList 按家庭分页拉全并解析，走缓存；请求体是 RC4 加密表单', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/v2/homeroom/gethome_merged', body: HOMES },
      { prefix: API_PREFIX + '/home/home_device_list', body: DEVICES },
    ]
    const { cloud, calls } = await loggedInCloud(routes, dataDir)
    const items = await cloud.deviceList()
    assert.deepEqual(items, [
      { did: '111', name: '客厅灯', model: 'yeelink.light.lamp1', isOnline: true, roomId: null, roomName: '客厅', homeId: '1', homeName: '我的家' },
      { did: '222', name: '卧室插座', model: 'chuangmi.plug.m1', isOnline: false, roomId: null, roomName: '我的家·未分配', homeId: '1', homeName: '我的家' },
    ])
    const n = calls.length
    await cloud.deviceList() // 缓存生效：不再发请求
    assert.equal(calls.length, n)
    await cloud.deviceList(true) // 强制刷新：再发家庭+设备两组请求
    assert.ok(calls.length > n)
    // 请求体是加密表单：能借 _nonce 解回业务参数
    const devCall = calls.find((c) => c.url === API_PREFIX + '/home/home_device_list')
    assert.ok(devCall, '应发出设备列表请求')
    const form = new URLSearchParams(devCall.init.body)
    const payload = decodeApiBody(devCall.init)
    assert.equal(payload.home_id, 1)
    assert.equal(payload.home_owner, 10086)
    assert.equal(typeof form.get('signature'), 'string')
    assert.match(devCall.init.headers.Cookie, /serviceToken=st-123/)
    assert.match(devCall.init.headers.Cookie, /PassportDeviceId=/)
    assert.equal(devCall.init.headers['miot-encrypt-algorithm'], 'ENCRYPT-RC4')
  })

  test('共享家庭用 home.uid 作 home_owner（共享家庭的房主不是自己）', async () => {
    const dataDir = await tmpDataDir()
    const homes = {
      code: 0,
      result: { homelist: [
        { id: '1', uid: 10086, name: '我的家', roomlist: [{ id: 'r1', name: '客厅', dids: [111] }] },
        { id: '2', uid: 555, name: '朋友家', shareflag: 1, roomlist: [{ id: 'r2', name: '书房', dids: [333] }] },
      ] },
    }
    // 设备接口按 home_owner 回不同设备：只有房主 uid 才对得上
    const deviceRoute = {
      prefix: API_PREFIX + '/home/home_device_list',
      body: (n, init) => {
        const req = decodeApiBody(init)
        if (Number(req.home_owner) === 555) {
          return { code: 0, result: { device_info: [{ did: 333, name: '书房台灯', model: 'yeelink.light.lamp1', isOnline: 1 }], has_more: false } }
        }
        if (Number(req.home_owner) === 10086) {
          return { code: 0, result: { device_info: [{ did: 111, name: '客厅灯', model: 'yeelink.light.lamp1', isOnline: 1 }], has_more: false } }
        }
        return { code: -1, message: 'no permit' }
      },
    }
    const { cloud, calls } = await loggedInCloud([
      ...qrRoutes(),
      { prefix: API_PREFIX + '/v2/homeroom/gethome_merged', body: homes },
      deviceRoute,
    ], dataDir)
    const items = await cloud.deviceList(true)
    assert.deepEqual(items.map((d) => d.did), ['111', '333'])
    const owners = calls
      .filter((c) => c.url === API_PREFIX + '/home/home_device_list')
      .map((c) => Number(decodeApiBody(c.init).home_owner))
    assert.deepEqual(owners.sort((a, b) => a - b), [555, 10086], 'home_owner 应取各家庭的 uid')
  })

  test('单个家庭无权限不影响其它家庭：跳过并记日志，列表照常返回', async () => {
    const dataDir = await tmpDataDir()
    const homes = {
      code: 0,
      result: { homelist: [
        { id: '2', uid: 555, name: '朋友家', shareflag: 1, roomlist: [{ id: 'r2', name: '书房', dids: [333] }] },
        { id: '1', uid: 10086, name: '我的家', roomlist: [{ id: 'r1', name: '客厅', dids: [111] }] },
      ] },
    }
    const deviceRoute = {
      prefix: API_PREFIX + '/home/home_device_list',
      body: (n, init) => {
        const req = decodeApiBody(init)
        if (Number(req.home_owner) === 555) return { code: -1, message: 'no permit' }
        return { code: 0, result: { device_info: [{ did: 111, name: '客厅灯', model: 'yeelink.light.lamp1', isOnline: 1 }], has_more: false } }
      },
    }
    const logs = []
    const fetchImpl = fakeFetch([
      ...qrRoutes(),
      { prefix: API_PREFIX + '/v2/homeroom/gethome_merged', body: homes },
      deviceRoute,
    ])
    const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000, log: (m) => logs.push(m) })
    await cloud.qrStart()
    await cloud.qrPoll()
    const items = await cloud.deviceList(true)
    assert.deepEqual(items.map((d) => d.did), ['111'], '无权家庭跳过，自家的设备仍要出来')
    assert.ok(logs.some((m) => /朋友家/.test(m) && /no permit/.test(m)), '应记录被跳过的家庭')
  })

  test('homesList 列出家庭并标出共享的（房主不是自己）', async () => {
    const dataDir = await tmpDataDir()
    const homes = {
      code: 0,
      result: { homelist: [
        { id: '1', uid: 10086, name: '我的家', roomlist: [{ id: 'r1', name: '客厅', dids: [111] }] },
        { id: '2', uid: 555, name: '朋友家', shareflag: 1, roomlist: [{ id: 'r2', name: '书房', dids: [333] }] },
      ] },
    }
    const { cloud, calls } = await loggedInCloud([
      ...qrRoutes(),
      { prefix: API_PREFIX + '/v2/homeroom/gethome_merged', body: homes },
    ], dataDir)
    const list = await cloud.homesList(true)
    assert.deepEqual(list, [
      { id: '1', name: '我的家', uid: 10086, shared: false, roomCount: 1 },
      { id: '2', name: '朋友家', uid: 555, shared: true, roomCount: 1 },
    ])
    // 带缓存：再取不重复打云端
    const n = calls.length
    await cloud.homesList()
    assert.equal(calls.length, n)
  })

  test('deviceList 可按家庭筛选：传 id、名称子串都只返回该家设备', async () => {
    const dataDir = await tmpDataDir()
    const homes = {
      code: 0,
      result: { homelist: [
        { id: '1', uid: 10086, name: '我的家', roomlist: [{ id: 'r1', name: '客厅', dids: [111] }] },
        { id: '2', uid: 555, name: '朋友家', shareflag: 1, roomlist: [{ id: 'r2', name: '书房', dids: [333] }] },
      ] },
    }
    const deviceRoute = {
      prefix: API_PREFIX + '/home/home_device_list',
      body: (n, init) => {
        const req = decodeApiBody(init)
        if (Number(req.home_owner) === 555) {
          return { code: 0, result: { device_info: [{ did: 333, name: '书房台灯', model: 'yeelink.light.lamp1', isOnline: 1 }], has_more: false } }
        }
        return { code: 0, result: { device_info: [
          { did: 111, name: '客厅灯', model: 'yeelink.light.lamp1', isOnline: 1 },
          { did: 112, name: '客厅插座', model: 'chuangmi.plug.m1', isOnline: 1 },
        ], has_more: false } }
      },
    }
    const { cloud } = await loggedInCloud([
      ...qrRoutes(),
      { prefix: API_PREFIX + '/v2/homeroom/gethome_merged', body: homes },
      deviceRoute,
    ], dataDir)
    const all = await cloud.deviceList(true)
    assert.equal(all.length, 3, '不传 home 就是全部家庭')
    // 按家庭 id 筛
    const byId = await cloud.deviceList(false, 60000, { home: '2' })
    assert.deepEqual(byId.map((d) => d.did), ['333'])
    // 按家庭名称子串筛（走缓存，不再打云端）
    const byName = await cloud.deviceList(false, 60000, { home: '我的家' })
    assert.deepEqual(byName.map((d) => d.did), ['111', '112'])
    // 不存在的家庭：返回空，不报错
    const none = await cloud.deviceList(false, 60000, { home: '不存在' })
    assert.deepEqual(none, [])
  })

  test('setOnOff 按规格库找到 siid/piid 并经加密通道下发 prop/set', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/miotspec/prop/set', body: { code: 0, result: [{ code: 0 }] } },
      ...SPEC,
    ]
    const { cloud, calls } = await loggedInCloud(routes, dataDir)
    await cloud.setOnOff({ did: '111', name: '客厅灯', model: 'yeelink.light.lamp1' }, true)
    const setCall = calls.find((c) => c.url === API_PREFIX + '/miotspec/prop/set')
    assert.ok(setCall, '应发出 prop/set 请求')
    const payload = decodeApiBody(setCall.init)
    assert.deepEqual(payload.params, [{ did: '111', siid: 2, piid: 1, value: true }])
    // 规格缓存落盘，第二次不再查 miot-spec.org
    const specCalls = calls.filter((c) => c.url.startsWith(SPEC_PREFIX)).length
    await cloud.onOffProp('yeelink.light.lamp1')
    assert.equal(calls.filter((c) => c.url.startsWith(SPEC_PREFIX)).length, specCalls)
  })

  test('auth 失效：先 passToken 静默续期再重试一次后成功', async () => {
    const dataDir = await tmpDataDir()
    let apiCalls = 0
    const routes = [
      // 登录态：首次扫码（code=1 领码），续期时（code=0）顺 location 收新票
      {
        prefix: PASS_PREFIX + 'serviceLogin?',
        body: (n) => {
          const inner =
            n === 1
              ? { code: 1, location: CHALLENGE_LOCATION, qs: 'q1', sid: 'mijia' }
              : { code: 0, location: LOCATION, ssecurity: SSECR, userId: '10086' }
          return '&&&START&&&' + JSON.stringify(inner)
        },
      },
      ...qrRoutes().slice(1), // 领码 + lp + location 回调
      // 业务请求：第一次 auth 失败；续期后成功
      {
        prefix: API_PREFIX,
        body: () => {
          apiCalls++
          return apiCalls === 1
            ? { code: 1, message: 'Invalid serviceToken auth' }
            : apiCalls === 2 ? HOMES : DEVICES
        },
      },
    ]
    const fetchImpl = fakeFetch(routes)
    const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000 })
    await cloud.qrStart()
    await cloud.qrPoll()
    const items = await cloud.deviceList(true)
    assert.deepEqual(items.map((d) => d.did), ['111', '222'])
    assert.equal(items[0].roomName, '客厅')
    // 出现过续期：serviceLogin 至少调了 2 次（登录 1 + 续期 1）
    const logins = fetchImpl.calls.filter((c) => c.url.startsWith(PASS_PREFIX + 'serviceLogin?')).length
    assert.equal(logins, 2)
  })

  test('续期也失败：清令牌并抛 needQr，引导重新扫码', async () => {
    const dataDir = await tmpDataDir()
    let apiCalls = 0
    const routes = [
      ...qrRoutes(),
      {
        prefix: API_PREFIX,
        body: () => {
          apiCalls++
          return { code: 1, message: 'Invalid serviceToken auth' }
        },
      },
      // 续期仍然 code≠0（passToken 死了）→ 没有 location 可用
      {
        prefix: PASS_PREFIX + 'serviceLogin?',
        body: () =>
          apiCalls >= 1
            ? '&&&START&&&' + JSON.stringify({ code: 1, location: CHALLENGE_LOCATION })
            : '&&&START&&&' + JSON.stringify({ code: 1, location: CHALLENGE_LOCATION }),
      },
      { prefix: QRLOGIN_PREFIX, body: { code: 0, loginUrl: 'https://qr-stub.example/x2', qr: '', lp: LP_PREFIX + '/wait2' } },
    ]
    const fetchImpl = fakeFetch(routes)
    const cloud = createMiCloud({ dataDir, fetchImpl, timeoutMs: 5000 })
    await cloud.qrStart()
    await cloud.qrPoll()
    apiCalls = 0
    await assert.rejects(
      () => cloud.deviceList(true),
      (e) => e.needQr === true && /重新扫码/.test(e.message),
    )
    assert.equal(await cloud.hasLogin(), false)
  })

  test('setOnOff：code=0 与 code=1 都算生效（米家 code=1 = 已执行，不再误报失败）', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/miotspec/prop/set', body: { code: 0, result: [{ code: 1 }] } },
      ...SPEC,
    ]
    const { cloud } = await loggedInCloud(routes, dataDir)
    const dev = { did: '111', name: '客厅灯', model: 'yeelink.light.lamp1' }
    const r = await cloud.setOnOff(dev, true)
    assert.equal(r.code, 1, 'code=1 应被认定为成功')
  })

  test('specProps 找出开关/亮度/色温三件套，setProp 泛化下发', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/miotspec/prop/set', body: { code: 0, result: [{ code: 0 }] } },
      ...SPEC,
    ]
    const { cloud, calls } = await loggedInCloud(routes, dataDir)
    const props = await cloud.specProps('yeelink.light.lamp1')
    assert.deepEqual(props.onOff, { siid: 2, piid: 1 })
    assert.deepEqual(props.brightness, { siid: 2, piid: 2 })
    assert.equal(props.colorTemp, null) // 规格里没定义色温
    await cloud.setProp({ did: '111', name: '客厅灯' }, props.brightness, 60)
    const setCall = calls.find((c) => c.url === API_PREFIX + '/miotspec/prop/set')
    assert.deepEqual(decodeApiBody(setCall.init).params[0], { did: '111', siid: 2, piid: 2, value: 60 })
  })

  test('getStates 批量查当前状态（按规格 controls 的 key 记值）', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      {
        prefix: API_PREFIX + '/miotspec/prop/get',
        body: {
          code: 0,
          result: [
            { did: '111', siid: 2, piid: 1, value: true, code: 0 },
            { did: '111', siid: 2, piid: 2, value: 60, code: 0 },
          ],
        },
      },
      ...SPEC,
    ]
    const { cloud } = await loggedInCloud(routes, dataDir)
    const states = await cloud.getStates([{ did: '111', name: '客厅灯', model: 'yeelink.light.lamp1' }])
    assert.deepEqual(states['111'], { p2_1: true, p2_2: 60 })
  })

  test('specProps 规格驱动：bool→开关、value-range→滑条、value-list→下拉，全类型通吃', async () => {
    const dataDir = await tmpDataDir()
    const FAN_SPEC = [
      { prefix: SPEC_PREFIX + '/instances', body: { instances: [{ model: 'x.fan.a', type: 'urn:miot-spec:fan-1' }] } },
      {
        prefix: SPEC_PREFIX + '/instance',
        body: {
          services: [
            { iid: 2, properties: [
              { iid: 1, description: '开关', format: 'bool', access: ['read', 'write'], name: 'on' },
              { iid: 2, description: '风速', format: 'uint8', access: ['read', 'write'], name: 'fan-level', 'value-list': [{ value: 1, description: '低风' }, { value: 2, description: '高风' }] },
              { iid: 3, description: '摆头', format: 'bool', access: ['read', 'write'], name: 'horizontal-swing' },
              { iid: 4, description: '亮度', format: 'uint8', access: ['read', 'write'], name: 'brightness', 'value-range': [1, 100, 1] },
              { iid: 5, description: '绝对亮度', format: 'float', access: ['write'], name: 'raw-brightness' }, // 无量程：应跳过
            ] },
          ],
        },
      },
    ]
    const routes = [...qrRoutes(), ...FAN_SPEC]
    const { cloud } = await loggedInCloud(routes, dataDir)
    const props = await cloud.specProps('x.fan.a')
    assert.equal(props.version, 3)
    const kinds = props.controls.map((c) => `${c.key}:${c.kind}`)
    assert.deepEqual(kinds, ['p2_1:toggle', 'p2_2:select', 'p2_3:toggle', 'p2_4:slider'], '无量程数值应被跳过')
    assert.deepEqual(props.controls[1].options, [{ value: 1, label: '低风' }, { value: 2, label: '高风' }])
    assert.deepEqual(props.controls[3].min, 1)
    // 中文标签与核心标记：风速=核心、摆头=非核心
    assert.equal(props.controls[1].zh, '风速')
    assert.equal(props.controls[1].core, true)
    assert.equal(props.controls[2].zh, '摆头')
    assert.equal(props.controls[2].core, false)
  })

  test('旧格式规格缓存（只有开关一项）判废重查，不吞掉亮度/色温', async () => {
    const dataDir = await tmpDataDir()
    await writeFile(
      join(dataDir, 'miot-spec-cache.json'),
      JSON.stringify({ 'yeelink.light.lamp1': { siid: 2, piid: 1 } }), // v1.0 旧格式
      'utf8',
    )
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/miotspec/prop/set', body: { code: 0, result: [{ code: 0 }] } },
      ...SPEC,
    ]
    const { cloud, calls } = await loggedInCloud(routes, dataDir)
    const props = await cloud.specProps('yeelink.light.lamp1')
    assert.ok(props.brightness, '旧缓存应被重查，亮度必须找回来')
    assert.ok(calls.some((c) => c.url.startsWith(SPEC_PREFIX)), '应真实访问过规格库')
  })

  test('色温属性新命名：color_temperature（下划线）也能认出', async () => {
    const dataDir = await tmpDataDir()
    const SPEC2 = [
      { prefix: SPEC_PREFIX + '/instances', body: { instances: [{ model: 'x.light.a', type: 'urn:miot-spec:light-9' }] } },
      {
        prefix: SPEC_PREFIX + '/instance',
        body: {
          services: [
            { iid: 2, properties: [
              { iid: 1, description: '开关', format: 'bool', access: ['read', 'write'], name: 'on' },
              { iid: 2, description: '亮度', format: 'uint8', access: ['read', 'write'], name: 'brightness' },
              { iid: 3, description: '色温', format: 'uint32', access: ['read', 'write'], name: 'color_temperature', 'value-range': [2700, 6500, 1] },
            ] },
          ],
        },
      },
    ]
    const routes = [...qrRoutes(), ...SPEC2]
    const { cloud } = await loggedInCloud(routes, dataDir)
    const props = await cloud.specProps('x.light.a')
    assert.deepEqual(props.colorTemp, { siid: 2, piid: 3 })
  })

  test('logout 清空凭证与列表缓存，后续请求引导重新扫码', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/v2/homeroom/gethome_merged', body: HOMES },
      { prefix: API_PREFIX + '/home/home_device_list', body: DEVICES },
    ]
    const { cloud, calls } = await loggedInCloud(routes, dataDir)
    assert.equal(await cloud.hasLogin(), true)
    const r = await cloud.logout()
    assert.equal(r.had, true)
    assert.equal(await cloud.hasLogin(), false)
    const saved = await readFile(join(dataDir, 'token.json'), 'utf8')
    assert.equal(saved.trim(), '', 'token.json 应清空')
    // 退出后拉设备：不发请求，直接报 needQr
    const before = calls.length
    await assert.rejects(() => cloud.deviceList(true), (e) => e.needQr === true)
    assert.equal(calls.length, before)
  })

  test('节流：同一设备连续两次指令间隔不小于 1.2 秒', async () => {
    const dataDir = await tmpDataDir()
    const routes = [
      ...qrRoutes(),
      { prefix: API_PREFIX + '/miotspec/prop/set', body: { code: 0, result: [{ code: 0 }] } },
      ...SPEC,
    ]
    const { cloud } = await loggedInCloud(routes, dataDir)
    const dev = { did: '111', name: '客厅灯', model: 'yeelink.light.lamp1' }
    await cloud.setOnOff(dev, true)
    const t0 = Date.now()
    await cloud.setOnOff(dev, false)
    // setTimeout 只有 1~2ms 的计时精度，实测间隔会落在 1198~1199ms，用 1200 卡死
    // 会在 CI 上随机红。留 20ms 容差，节流本身还是 CMD_GAP_MS=1200。
    const gap = Date.now() - t0
    assert.ok(gap >= 1200 - 20, '第二次指令应被节流到至少 1.2 秒后，实际 ' + gap + 'ms')
  })
})

describe('指令解析 parseIntent', () => {
  const cases = [
    ['米家设备', { intent: 'list' }],
    ['设备列表', { intent: 'list' }],
    ['米家帮助', { intent: 'help' }],
    ['开 客厅灯', { intent: 'on', name: '客厅灯' }],
    ['打开客厅灯', { intent: 'on', name: '客厅灯' }],
    ['关掉 插座', { intent: 'off', name: '插座' }],
    ['关闭：卧室灯', { intent: 'off', name: '卧室灯' }],
    ['小米家 开一下 空气净化器', { intent: 'on', name: '空气净化器' }],
    ['今天天气真好', null],
    ['', null],
  ]
  for (const [input, expected] of cases) {
    test(`「${input}」→ ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(parseIntent(input), expected)
    })
  }
})

describe('模糊匹配与权限门', () => {
  const list = [
    { did: '1', name: '客厅灯', model: 'a', isOnline: true },
    { did: '2', name: '客厅灯带', model: 'b', isOnline: true },
    { did: '3', name: '卧室插座', model: 'c', isOnline: false },
  ]
  test('唯一命中', () => {
    const { device } = matchDevice(list, '插座')
    assert.equal(device.did, '3')
  })
  test('多个命中返回候选', () => {
    const { device, candidates } = matchDevice(list, '客厅')
    assert.equal(device, null)
    assert.equal(candidates.length, 2)
  })
  test('没命中', () => {
    const { device, candidates } = matchDevice(list, '空调')
    assert.equal(device, null)
    assert.equal(candidates.length, 0)
  })
  test('normName 去空白转小写', () => {
    assert.equal(normName('  Mi LED Lamp '), 'miledlamp')
  })
  test('权限门：主人永远放行（私聊）', () => {
    assert.deepEqual(canControl({ userId: '1', kind: 'private' }, { isOwner: true, whitelist: [], privateOnly: true }), {
      ok: true,
      reason: '',
    })
  })
  test('权限门：名单内放行、名单外拒绝', () => {
    const gate = { isOwner: false, whitelist: ['20002'], privateOnly: true }
    assert.equal(canControl({ userId: '20002', kind: 'private' }, gate).ok, true)
    const deny = canControl({ userId: '30003', kind: 'private' }, gate)
    assert.equal(deny.ok, false)
    assert.match(deny.reason, /授权名单/)
  })
  test('权限门：仅私聊时群聊拒绝，关掉后名单内群聊放行', () => {
    const gate = { isOwner: false, whitelist: ['20002'], privateOnly: true }
    assert.equal(canControl({ userId: '20002', kind: 'group' }, gate).ok, false)
    assert.equal(canControl({ userId: '20002', kind: 'group' }, { ...gate, privateOnly: false }).ok, true)
  })
})

describe('classifyDevice 型号分类', () => {
  const cases = [
    ['yeelink.light.lamp1', 'light', '灯', true],
    ['miot.plug.090615', 'switch', '插座/开关', true],
    ['lumi.curtain.v1', 'curtain', '窗帘', true],
    ['xiaomi.fan.p9', 'fan', '风扇', true],
    ['lumi.sensor_motion.v2', 'sensor', '传感器', false],
    ['chuangmi.camera.1080p', 'hub', '网关/摄像头', false],
    ['unknown.brand.thing', 'other', '其他', true],
  ]
  for (const [model, type, label, controllable] of cases) {
    test(`${model} → ${type}`, () => {
      assert.deepEqual(classifyDevice(model), { type, label, controllable })
    })
  }
  test('型号认不出时按设备名兜底（灯带/插座等）', () => {
    assert.deepEqual(classifyDevice('foo.model.xyz', '01客厅灯带'), { type: 'light', label: '灯', controllable: true })
    assert.deepEqual(classifyDevice('foo.model.xyz', '墙边插座'), { type: 'switch', label: '插座/开关', controllable: true })
    assert.deepEqual(classifyDevice('foo.model.xyz', '窗帘机'), { type: 'curtain', label: '窗帘', controllable: true })
  })
})

describe('formatDevices', () => {
  test('排版：在线状态 + 名称 + 型号；空列表有兜底文案', () => {
    const text = formatDevices([
      { name: '客厅灯', model: 'a', isOnline: true },
      { name: '卧室插座', model: 'b', isOnline: false },
    ])
    assert.match(text, /●在线 客厅灯（a）/)
    assert.match(text, /○离线 卧室插座（b）/)
    assert.equal(formatDevices([]), '米家里没找到设备。')
  })
})
