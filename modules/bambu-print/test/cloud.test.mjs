// test/cloud.test.mjs —— 云端设备列表（假 fetch，不打真网络）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { REGIONS, regionOf, listDevices, cloudTarget, devicesToPrinters } from '../lib/cloud.mjs'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.CLOUD-SECRET-TOKEN-5566'
const ACCESS_CODE = 'PRINTER-ACCESS-CODE-7788'

function fakeFetch(handler) {
  const calls = []
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init })
    const result = typeof handler === 'function' ? handler(String(url), init, calls.length) : handler
    if (result instanceof Error) throw result
    return new Response(result.body === undefined ? '' : typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function devicePayload() {
  return {
    devices: [
      { dev_id: '01S00A0001', name: '车间 A1', dev_model_name: 'A1', dev_ip: '192.168.1.50', dev_access_code: ACCESS_CODE },
      { dev_id: '01S00A0002', name: 'X1C', dev_model_name: 'X1 Carbon', dev_ip: '' },
      { dev_id: '01S00A0003', name: '', dev_model_name: 'P1S' },
      { dev_id: '', name: '无序列号', dev_model_name: 'A1' },
      { dev_id: '01S00A0005', name: 'P1P 无型号' },
      { dev_id: '01S00A0006', name: 'P1S', dev_model_name: 'P1S' },
      null,
      'string-device',
    ],
  }
}

describe('regionOf / REGIONS', () => {
  test('三区域常量', () => {
    assert.equal(REGIONS.us.api, 'https://api.bambulab.com')
    assert.equal(REGIONS.eu.api, 'https://api.bambulab.com')
    assert.equal(REGIONS.cn.api, 'https://api.bambulab.cn')
    assert.equal(REGIONS.us.mqtt, 'us.mqtt.bambulab.com')
    assert.equal(REGIONS.cn.mqtt, 'cn.mqtt.bambulab.com')
  })

  test('regionOf 大小写容忍 + 未知回落 us', () => {
    assert.equal(regionOf('CN').key, 'cn')
    assert.equal(regionOf(' eu ').key, 'eu')
    assert.equal(regionOf('').key, 'us')
    assert.equal(regionOf(undefined).key, 'us')
    assert.equal(regionOf('mars').key, 'us')
    assert.equal(regionOf('cn').api, 'https://api.bambulab.cn')
  })
})

describe('listDevices', () => {
  test('正常解析，含 dev_access_code', async () => {
    const fetchImpl = fakeFetch({ body: devicePayload() })
    const res = await listDevices({ accessToken: TOKEN, uid: '123', region: 'us', fetchImpl })
    assert.equal(res.ok, true)
    assert.equal(res.devices.length, 4, '名字缺失/序列号缺失的跳过')
    const first = res.devices[0]
    assert.equal(first.serial, '01S00A0001')
    assert.equal(first.name, '车间 A1')
    assert.equal(first.model, 'A1')
    assert.equal(first.ip, '192.168.1.50')
    assert.equal(first.accessCode, ACCESS_CODE)
    assert.equal(res.devices[1].accessCode, undefined, '没有就是不出现该字段')
    assert.equal(res.devices[1].model, 'X1 Carbon')
    assert.equal(res.devices[2].model, '未知型号')
    assert.equal(res.region, 'us')
  })

  test('请求 URL / 方法与 Bearer 头', async () => {
    const fetchImpl = fakeFetch({ body: { devices: [] } })
    await listDevices({ accessToken: TOKEN, region: 'cn', fetchImpl })
    const call = fetchImpl.calls[0]
    assert.equal(call.url, 'https://api.bambulab.cn/v1/iot-service/api/user/bind')
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.headers.Authorization, 'Bearer ' + TOKEN)
    assert.ok(call.init.signal, '应带 AbortSignal.timeout')
  })

  test('空 devices 返回空列表（不是错误）', async () => {
    const res = await listDevices({ accessToken: TOKEN, fetchImpl: fakeFetch({ body: {} }) })
    assert.equal(res.ok, true)
    assert.deepEqual(res.devices, [])
  })

  test('401 只报状态码，不回显 token', async () => {
    const res = await listDevices({
      accessToken: TOKEN,
      fetchImpl: fakeFetch({ status: 401, body: { code: 8, error: 'token expired ' + TOKEN } }),
    })
    assert.equal(res.ok, false)
    assert.equal(res.status, 401)
    assert.match(res.error, /HTTP 401/)
    assert.ok(!res.error.includes(TOKEN), '错误不得含 token')
    assert.ok(!JSON.stringify(res).includes(TOKEN))
  })

  test('500 与其他状态码', async () => {
    const s500 = await listDevices({ accessToken: TOKEN, fetchImpl: fakeFetch({ status: 500, body: 'boom' }) })
    assert.equal(s500.ok, false)
    assert.match(s500.error, /HTTP 500/)
    assert.ok(!s500.error.includes(TOKEN))
    const s418 = await listDevices({ accessToken: TOKEN, fetchImpl: fakeFetch({ status: 418, body: 'teapot' }) })
    assert.equal(s418.ok, false)
    assert.match(s418.error, /HTTP 418/)
  })

  test('网络错误清洗 token', async () => {
    const res = await listDevices({
      accessToken: TOKEN,
      fetchImpl: fakeFetch(() => new Error('connect ECONNREFUSED（' + TOKEN + '）')),
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NETWORK')
    assert.ok(!res.error.includes(TOKEN), '错误不得含 token')
    assert.ok(res.error.includes('••••'))
  })

  test('超时错误', async () => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    const res = await listDevices({ accessToken: TOKEN, fetchImpl: fakeFetch(() => err), timeoutMs: 50 })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'TIMEOUT')
    assert.ok(!res.error.includes(TOKEN))
  })

  test('缺 token / 缺 fetch', async () => {
    assert.equal((await listDevices({ fetchImpl: fakeFetch({ body: {} }) })).code, 'NO_TOKEN')
    assert.equal((await listDevices({ accessToken: '   ', fetchImpl: fakeFetch({ body: {} }) })).code, 'NO_TOKEN')
    // 运行环境没有 fetch 时给出明确错误，而不是打真网络
    const realFetch = globalThis.fetch
    try {
      globalThis.fetch = undefined
      const res = await listDevices({ accessToken: TOKEN, region: 'us' })
      assert.equal(res.ok, false)
      assert.equal(res.code, 'NO_FETCH')
      assert.ok(!res.error.includes(TOKEN))
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('坏 JSON 报错', async () => {
    const res = await listDevices({ accessToken: TOKEN, fetchImpl: fakeFetch({ body: 'not json' }) })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'BAD_JSON')
    assert.ok(!res.error.includes(TOKEN))
  })
})

describe('cloudTarget / devicesToPrinters', () => {
  test('cloudTarget 组装 target（host 来自 region）', () => {
    const target = cloudTarget({
      accessToken: TOKEN, uid: '123456', region: 'eu',
      device: { serial: '01S00A0001', name: 'X1C', model: 'X1 Carbon' },
    })
    assert.equal(target.mode, 'cloud')
    assert.equal(target.host, 'eu.mqtt.bambulab.com')
    assert.equal(target.port, 8883)
    assert.equal(target.serial, '01S00A0001')
    assert.equal(target.accessToken, TOKEN)
    assert.equal(target.uid, '123456')
    assert.equal(target.region, 'eu')
  })

  test('device.mqttHost 覆盖 region 主机', () => {
    const target = cloudTarget({ accessToken: TOKEN, uid: '1', region: 'us', device: { serial: 'S', mqttHost: 'custom.example.com' } })
    assert.equal(target.host, 'custom.example.com')
  })

  test('cloudTarget 缺参数安全', () => {
    const target = cloudTarget({})
    assert.equal(target.mode, 'cloud')
    assert.equal(target.serial, '')
    assert.equal(target.accessToken, '')
    assert.equal(target.port, 8883)
    assert.equal(target.region, 'us')
  })

  test('devicesToPrinters 保留 ip/accessCode 供局域网兜底', () => {
    const printers = devicesToPrinters([
      { serial: 'S1', name: 'A1', model: 'A1', ip: '192.168.1.50', accessCode: ACCESS_CODE },
      { serial: '', name: '坏', model: 'A1' },
      { serial: 'S2', name: '', model: 'A1' },
      { serial: 'S3', name: '仅云端', model: 'P1S' },
      null,
    ])
    assert.equal(printers.length, 2, '没有序列号/名字的被过滤')
    assert.deepEqual(printers[0], {
      serial: 'S1', name: 'A1', model: 'A1', ip: '192.168.1.50', accessCode: ACCESS_CODE,
    })
    assert.equal(printers[1].serial, 'S3')
    assert.equal(printers[1].ip, undefined, '没有局域网地址就不出现该字段')
    assert.equal(printers[1].accessCode, undefined)
  })
})
