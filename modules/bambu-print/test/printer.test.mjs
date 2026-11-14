// test/printer.test.mjs —— printerManager（假客户端，不连真打印机）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPrinterManager, buildCommand, mergeReport, targetKey, requireLanTrust, buildConnectionOptions } from '../lib/printer.mjs'
import { createMqttClient } from '../lib/mqtt.mjs'

const SECRET = 'LAN-ACCESS-CODE-SECRET-9911'
const TOKEN = 'CLOUD-ACCESS-TOKEN-SECRET-8822'

const LAN_TARGET = { mode: 'lan', host: '192.0.2.50', port: 8883, serial: '01S00A999', accessCode: SECRET }
const CLOUD_TARGET = { mode: 'cloud', host: 'us.mqtt.bambulab.com', port: 8883, serial: '01S00C777', accessToken: TOKEN, uid: '123456' }

/** 打印机自签名证书（假的 PEM/指纹，只做锚点语义） */
const CERT = { pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', fingerprint256: 'a'.repeat(64) }

/** 假 certTrust：key 是 serial，值 { pem, fingerprint256 } */
function certTrustOf(map) {
  return {
    get: (target) => (map[target.serial] ? map[target.serial] : null),
    save: (target, info) => {
      map[target.serial] = { pem: info.pem, fingerprint256: info.fingerprint256 }
      return true
    },
  }
}

/** 已 pin 的局域网 target：index 会把保险库里的锚点直接塞进 target（tlsCa / tlsFingerprint） */
const PINNED_LAN_TARGET = { ...LAN_TARGET, tlsCa: CERT.pem, tlsFingerprint: CERT.fingerprint256 }
/** 假 MQTT 客户端：记录 publish，可脚本化回包 */
function fakeClientFactory(behaviours = {}) {
  const instances = []
  function factory(opts) {
    const client = new EventEmitter()
    client.opts = opts
    client.published = []
    client.subscribed = []
    client.closed = false
    client.connectCalls = 0
    client.connect = async () => {
      client.connectCalls++
      if (behaviours.connectError) throw behaviours.connectError
      return undefined
    }
    client.subscribe = async (topic) => {
      client.subscribed.push(topic)
      return { ok: true }
    }
    client.publish = async (topic, payload) => {
      if (behaviours.publishError) throw behaviours.publishError
      client.published.push({ topic, payload: String(payload) })
      const handler = behaviours.onPublish
      if (handler) handler(client, { topic, payload: String(payload) })
      return { ok: true }
    }
    client.isOpen = () => !client.closed
    client.close = () => {
      client.closed = true
      client.emit('close', null)
    }
    client.emitReport = (obj) => client.emit('message', 'device/' + (opts.serial || 'X') + '/report', Buffer.from(JSON.stringify(obj)))
    instances.push(client)
    return client
  }
  factory.instances = instances
  return factory
}

function pushReport(client, report) {
  client.emit('message', 'device/01S00A999/report', Buffer.from(JSON.stringify(report)))
}

describe('buildCommand', () => {
  test('pause/resume/stop 负载', () => {
    for (const action of ['pause', 'resume', 'stop']) {
      const built = buildCommand(action, {}, '5')
      assert.deepEqual(built.payload, { print: { command: action, sequence_id: '5' } })
      assert.equal(built.expect.sequenceId, '5')
    }
  })

  test('light 打开/关闭', () => {
    const on = buildCommand('light', { on: true }, '1').payload
    assert.equal(on.system.command, 'ledctrl')
    assert.equal(on.system.led_node, 'chamber_light')
    assert.equal(on.system.led_mode, 'on')
    assert.equal(on.system.led_on_time, 500)
    assert.equal(on.system.loop_times, 0)
    const off = buildCommand('light', { mode: 'off' }, '2').payload
    assert.equal(off.system.led_mode, 'off')
    assert.equal(off.system.sequence_id, '2')
  })

  test('speed 只接受 1..4', () => {
    assert.equal(buildCommand('speed', { level: 3 }, '1').payload.print.param, '3')
    assert.equal(buildCommand('speed', { level: 1 }, '1').payload.print.param, '1')
    for (const bad of [0, 5, -1, 'abc', null]) {
      const built = buildCommand('speed', { level: bad }, '1')
      assert.equal(built.payload, null)
      assert.match(built.error, /速度档位/)
    }
  })

  test('temperature 生成 M140/M104 gcode', () => {
    const both = buildCommand('temperature', { bed: 60, nozzle: 220 }, '1').payload
    assert.equal(both.print.command, 'gcode_line')
    assert.equal(both.print.param, 'M140 S60\nM104 S220\n')
    const bedOnly = buildCommand('temperature', { bed: 55 }, '1').payload
    assert.equal(bedOnly.print.param, 'M140 S55\n')
    const none = buildCommand('temperature', {}, '1')
    assert.equal(none.payload, null)
    assert.match(none.error, /温度/)
  })

  test('temperature 越界拒绝', () => {
    assert.equal(buildCommand('temperature', { bed: 500 }, '1').payload, null)
    assert.equal(buildCommand('temperature', { nozzle: 999 }, '1').payload, null)
  })

  test('gcode 总长上限 2000', () => {
    const ok = buildCommand('gcode', { lines: ['G1 X1', 'G1 Y2'] }, '1').payload
    assert.equal(ok.print.param, 'G1 X1\nG1 Y2\n')
    const long = buildCommand('gcode', { lines: ['G1 X' + '9'.repeat(2100)] }, '1')
    assert.equal(long.payload, null)
    assert.match(long.error, /过长/)
    assert.equal(buildCommand('gcode', { lines: [] }, '1').payload, null)
  })

  test('home 与 pushall', () => {
    assert.equal(buildCommand('home', {}, '1').payload.print.param, 'G28\n')
    const push = buildCommand('pushall', {}, '9').payload
    assert.deepEqual(push.pushing, { command: 'pushall', version: 1, push_target: 1, sequence_id: '9' })
  })

  test('raw / 未知动作', () => {
    const raw = buildCommand('raw', { payload: { print: { command: 'x' } } }, '7').payload
    assert.equal(raw.print.sequence_id, '7')
    const bad = buildCommand('unknown', {}, '1')
    assert.equal(bad.payload, null)
    assert.match(bad.error, /不支持/)
  })
})

describe('mergeReport / targetKey', () => {
  test('增量合并不丢旧字段', () => {
    const prev = { print: { gcode_state: 'RUNNING', mc_percent: 10, layer_num: 3 } }
    const next = mergeReport(prev, { print: { mc_percent: 20 } })
    assert.equal(next.print.mc_percent, 20)
    assert.equal(next.print.gcode_state, 'RUNNING')
    assert.equal(next.print.layer_num, 3)
  })

  test('AMS 单元按 id 合并、tray 按 id 合并', () => {
    const prev = { print: { ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA', remain: 80 }] }] } } }
    const next = mergeReport(prev, { print: { ams: { ams: [{ id: '0', tray: [{ id: '0', remain: 55 }] }] } } })
    const unit = next.print.ams.ams[0]
    assert.equal(unit.tray[0].remain, 55)
    assert.equal(unit.tray[0].tray_type, 'PLA')
  })

  test('不修改输入对象', () => {
    const prev = { print: { a: 1 } }
    const copy = JSON.stringify(prev)
    mergeReport(prev, { print: { b: 2 } })
    assert.equal(JSON.stringify(prev), copy)
  })

  test('非对象输入安全', () => {
    assert.deepEqual(mergeReport(null, { a: 1 }), { a: 1 })
    assert.deepEqual(mergeReport({ a: 1 }, null), { a: 1 })
    assert.deepEqual(mergeReport(null, null), {})
  })

  test('targetKey 不含秘密', () => {
    const lan = targetKey(LAN_TARGET)
    assert.equal(lan, 'lan:192.0.2.50:01S00A999')
    assert.ok(!lan.includes(SECRET))
    const cloud = targetKey(CLOUD_TARGET)
    assert.equal(cloud, 'cloud:uid:01S00C777')
    assert.ok(!cloud.includes(TOKEN))
    assert.equal(targetKey(null), '')
  })
})

describe('createPrinterManager.status', () => {
  test('收到 report 后返回 report+status，不含秘密', async () => {
    const factory = fakeClientFactory({
      onPublish(client) {
        pushReport(client, {
          print: { gcode_state: 'RUNNING', mc_percent: '42', mc_remaining_time: '98', layer_num: '56', total_layer_num: '132', nozzle_temper: '215.4', bed_temper: '60.1', file_name: 'Benchy.3mf' },
        })
      },
    })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.status(PINNED_LAN_TARGET)
    assert.equal(res.ok, true)
    assert.equal(res.status.state, 'RUNNING')
    assert.equal(res.status.percent, 42)
    assert.equal(res.status.remainingMin, 98)
    assert.equal(res.report.print.mc_percent, '42', 'report 是原始合并结果')
    assert.ok(typeof res.receivedAt === 'number')
    assert.equal(res.stale, false)
    const dumped = JSON.stringify(res)
    assert.ok(!dumped.includes(SECRET), '结果不得含访问码')
    // 连接参数里带密码，但不进返回
    assert.equal(factory.instances[0].opts.username, 'bblp')
    assert.equal(factory.instances[0].opts.password, SECRET)
    assert.equal(factory.instances[0].subscribed[0], 'device/01S00A999/report')
    mgr.closeAll()
  })

  test('短缓存命中，force 重新请求', async () => {
    let nowMs = 1_000_000
    let publishes = 0
    const factory = fakeClientFactory({
      onPublish(client) {
        publishes++
        pushReport(client, { print: { gcode_state: 'RUNNING', mc_percent: 10 + publishes } })
      },
    })
    const mgr = createPrinterManager({ clientFactory: factory, now: () => nowMs, statusTtlMs: 3000, log: { debug() {} } })
    const first = await mgr.status(PINNED_LAN_TARGET)
    assert.equal(first.status.percent, 11)
    const second = await mgr.status(PINNED_LAN_TARGET)
    assert.equal(second.cached, true)
    assert.equal(second.status.percent, 11)
    assert.equal(publishes, 1)
    const forced = await mgr.status(PINNED_LAN_TARGET, { force: true })
    assert.equal(forced.status.percent, 12)
    assert.equal(publishes, 2)
    nowMs += 5000
    const expired = await mgr.status(PINNED_LAN_TARGET)
    assert.equal(expired.cached, undefined)
    assert.equal(publishes, 3)
    mgr.closeAll()
  })

  test('连接复用同一客户端', async () => {
    const factory = fakeClientFactory({
      onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) },
    })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    await mgr.status(PINNED_LAN_TARGET)
    await mgr.status(PINNED_LAN_TARGET, { force: true })
    assert.equal(factory.instances.length, 1)
    assert.equal(factory.instances[0].connectCalls, 1, 'connect 只调一次')
    mgr.closeAll()
  })

  test('超时无回包返回错误，不编造状态', async () => {
    const factory = fakeClientFactory({})
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.status(PINNED_LAN_TARGET, { timeoutMs: 60 })
    assert.equal(res.ok, false)
    assert.match(res.error, /没有返回状态/)
    assert.equal(res.status, undefined)
    mgr.closeAll()
  })

  test('有旧缓存时超时返回 stale:true', async () => {
    let mode = 'ok'
    const factory = fakeClientFactory({
      onPublish(client) { if (mode === 'ok') pushReport(client, { print: { gcode_state: 'RUNNING', mc_percent: 50 } }) },
    })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const fresh = await mgr.status(PINNED_LAN_TARGET)
    assert.equal(fresh.ok, true)
    mode = 'silent'
    const res = await mgr.status(PINNED_LAN_TARGET, { force: true, timeoutMs: 60 })
    assert.equal(res.ok, true)
    assert.equal(res.stale, true)
    assert.equal(res.status.percent, 50)
    assert.ok(!JSON.stringify(res).includes(SECRET))
    mgr.closeAll()
  })

  test('缺少访问码/序列号报错且不含秘密', async () => {
    const mgr = createPrinterManager({ clientFactory: fakeClientFactory(), log: { debug() {} } })
    const noCode = await mgr.status({ mode: 'lan', host: 'h', serial: 'S1' })
    assert.equal(noCode.ok, false)
    assert.match(noCode.error, /访问码/)
    const noSerial = await mgr.status({ mode: 'lan', host: 'h', accessCode: SECRET })
    assert.equal(noSerial.ok, false)
    assert.match(noSerial.error, /序列号/)
    assert.ok(!JSON.stringify(noSerial).includes(SECRET))
    mgr.closeAll()
  })

  test('连接失败错误清洗：不泄漏秘密', async () => {
    const factory = fakeClientFactory({ connectError: new Error('TLS 失败（密码 ' + SECRET + '）') })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.status(PINNED_LAN_TARGET)
    assert.equal(res.ok, false)
    assert.ok(!res.error.includes(SECRET), '错误里不得出现访问码')
    assert.ok(res.error.includes('••••'))
    mgr.closeAll()
  })

  test('云端 target 用 uid 用户名与 token', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.status(CLOUD_TARGET)
    assert.equal(res.ok, true)
    const opts = factory.instances[0].opts
    assert.equal(opts.username, 'u_123456')
    assert.equal(opts.password, TOKEN)
    assert.equal(opts.host, 'us.mqtt.bambulab.com')
    assert.ok(!JSON.stringify(res).includes(TOKEN))
    mgr.closeAll()
  })

  test('target.host 优先于 region，port 默认 8883', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    await mgr.status({ mode: 'cloud', host: 'eu.mqtt.bambulab.com', serial: 'S9', accessToken: TOKEN, uid: '9' })
    assert.equal(factory.instances[0].opts.port, 8883)
    assert.equal(factory.instances[0].opts.host, 'eu.mqtt.bambulab.com')
    mgr.closeAll()
  })
})

describe('createPrinterManager.command', () => {
  test('pause 带自增序列号并等回执', async () => {
    const factory = fakeClientFactory({
      onPublish(client, { payload }) {
        const seq = JSON.parse(payload).print.sequence_id
        setTimeout(() => pushReport(client, { print: { command: 'pause', result: 'success', sequence_id: seq } }), 5)
      },
    })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.command(PINNED_LAN_TARGET, 'pause')
    assert.equal(res.ok, true)
    assert.equal(res.acked, true)
    assert.match(res.message, /暂停/)
    const sent = JSON.parse(factory.instances[0].published[0].payload)
    assert.equal(sent.print.command, 'pause')
    assert.ok(sent.print.sequence_id)
    const second = await mgr.command(PINNED_LAN_TARGET, 'resume')
    assert.equal(second.ok, true)
    const sent2 = JSON.parse(factory.instances[0].published[1].payload)
    assert.ok(Number(sent2.print.sequence_id) > Number(sent.print.sequence_id), '序列号自增')
    mgr.closeAll()
  })

  test('无回执超时返回 ok:true, acked:false', async () => {
    const factory = fakeClientFactory({})
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const started = Date.now()
    const res = await mgr.command(PINNED_LAN_TARGET, 'stop')
    assert.equal(res.ok, true)
    assert.equal(res.acked, false)
    assert.match(res.message, /未在 2.5 秒内回执/)
    assert.ok(Date.now() - started >= 2400, '应等满 2.5 秒')
    mgr.closeAll()
  })

  test('回执序列号不匹配时继续等待直到超时', async () => {
    const factory = fakeClientFactory({
      onPublish(client) { pushReport(client, { print: { sequence_id: '999999', result: 'success' } }) },
    })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.command(PINNED_LAN_TARGET, 'pause')
    assert.equal(res.ok, true)
    assert.equal(res.acked, false, '别人的回执不能算自己的')
    mgr.closeAll()
  })

  test('参数错误直接返回 ok:false，不发布', async () => {
    const factory = fakeClientFactory({})
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.command(PINNED_LAN_TARGET, 'speed', { level: 9 })
    assert.equal(res.ok, false)
    assert.match(res.error, /速度档位/)
    assert.equal(factory.instances.length, 0)
    mgr.closeAll()
  })

  test('发布失败返回错误且不含秘密', async () => {
    const factory = fakeClientFactory({ publishError: new Error('写入失败 token=' + SECRET) })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.command(PINNED_LAN_TARGET, 'pause')
    assert.equal(res.ok, false)
    assert.ok(!res.error.includes(SECRET))
    mgr.closeAll()
  })

  test('同一 target 串行（注入 lock）', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const factory = fakeClientFactory({
      onPublish(client, { payload }) {
        const seq = JSON.parse(payload).print.sequence_id
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        setTimeout(() => {
          concurrent--
          pushReport(client, { print: { sequence_id: seq, result: 'success' } })
        }, 10)
      },
    })
    const queues = new Map()
    const lock = (key) => {
      const prev = queues.get(key) || Promise.resolve()
      let release
      const gate = new Promise((r) => { release = r })
      queues.set(key, prev.then(() => gate))
      return prev.then(() => () => release())
    }
    const mgr = createPrinterManager({ clientFactory: factory, lock, log: { debug() {} } })
    const results = await Promise.all([
      mgr.command(PINNED_LAN_TARGET, 'pause'),
      mgr.command(PINNED_LAN_TARGET, 'resume'),
      mgr.command(PINNED_LAN_TARGET, 'stop'),
    ])
    assert.equal(results.every((r) => r.ok), true)
    assert.equal(maxConcurrent, 1, '同一 target 的命令必须串行')
    mgr.closeAll()
  })

  test('默认内部 lock 也串行化', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const factory = fakeClientFactory({
      onPublish(client, { payload }) {
        const seq = JSON.parse(payload).print.sequence_id
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        setTimeout(() => {
          concurrent--
          pushReport(client, { print: { sequence_id: seq, result: 'success' } })
        }, 10)
      },
    })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    await Promise.all([
      mgr.command(PINNED_LAN_TARGET, 'pause'),
      mgr.command(PINNED_LAN_TARGET, 'resume'),
    ])
    assert.equal(maxConcurrent, 1)
    mgr.closeAll()
  })

  test('idleCloseMs 后自动断开', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, idleCloseMs: 40, log: { debug() {} } })
    await mgr.status(PINNED_LAN_TARGET)
    assert.equal(factory.instances[0].closed, false)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(factory.instances[0].closed, true, '空闲后应断开')
    mgr.closeAll()
  })
})

describe('target 覆盖与区域回落', () => {
  test('每台打印机自带 accessCode 覆盖凭据级', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    await mgr.status({ ...PINNED_LAN_TARGET, accessCode: 'PRINTER-OWN-CODE-11', bindingAccessCode: SECRET })
    assert.equal(factory.instances[0].opts.password, 'PRINTER-OWN-CODE-11', 'target.accessCode 优先')
    mgr.closeAll()
  })

  test('target.secret.accessCode / accessToken 兜底', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    await mgr.status({ mode: 'lan', host: '192.0.2.60', serial: 'S1', secret: { accessCode: SECRET }, tlsCa: CERT.pem })
    assert.equal(factory.instances[0].opts.password, SECRET)
    await mgr.status({ mode: 'cloud', host: 'us.mqtt.bambulab.com', serial: 'S2', uid: '5', secret: { accessToken: TOKEN } })
    assert.equal(factory.instances[1].opts.password, TOKEN)
    assert.equal(factory.instances[1].opts.username, 'u_5')
    mgr.closeAll()
  })

  test('index 风格完整 target 字段组合', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE', mc_percent: '0' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.status({
      mode: 'lan', ip: '192.168.1.9', host: '', accessCode: SECRET,
      accessToken: '', uid: '', region: '', serial: '01S00Z1', tlsCa: CERT.pem,
    })
    assert.equal(res.ok, true)
    assert.equal(factory.instances[0].opts.host, '192.168.1.9', 'host 为空时回落到 ip')
    assert.equal(factory.instances[0].opts.username, 'bblp')
    mgr.closeAll()
  })

  test('云端只给 region 时回落到该区域 MQTT 主机', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const mgr = createPrinterManager({ clientFactory: factory, log: { debug() {} } })
    const res = await mgr.status({ mode: 'cloud', region: 'eu', serial: 'S1', accessToken: TOKEN, uid: '7' })
    assert.equal(res.ok, true)
    assert.equal(factory.instances[0].opts.host, 'eu.mqtt.bambulab.com')
    assert.ok(factory.instances[0].opts.port === 8883)
    mgr.closeAll()
  })

  test('既无 host 也无 region 报错且不含秘密', async () => {
    const mgr = createPrinterManager({ clientFactory: fakeClientFactory(), log: { debug() {} } })
    const res = await mgr.status({ mode: 'lan', serial: 'S1', accessCode: SECRET })
    assert.equal(res.ok, false)
    assert.match(res.error, /地址/)
    assert.ok(!res.error.includes(SECRET))
    mgr.closeAll()
  })

  test('日志字符串不含秘密', async () => {
    const logs = []
    const factory = fakeClientFactory({ connectError: new Error('plain failure') })
    const mgr = createPrinterManager({
      clientFactory: factory,
      log: { debug: (...a) => logs.push(a.join(' ')) },
    })
    await mgr.status(PINNED_LAN_TARGET)
    await mgr.command(PINNED_LAN_TARGET, 'pause')
    const all = logs.join('\n')
    assert.ok(logs.length > 0)
    assert.ok(!all.includes(SECRET), '日志不得含访问码')
    assert.ok(!all.includes(TOKEN), '日志不得含 token')
    mgr.closeAll()
  })
})

describe('createPrinterManager.snapshot', () => {
  test('云端直接拒绝', async () => {
    const mgr = createPrinterManager({ clientFactory: fakeClientFactory(), log: { debug() {} } })
    const res = await mgr.snapshot(CLOUD_TARGET)
    assert.equal(res.ok, false)
    assert.match(res.error, /云端模式暂不支持拍照/)
    mgr.closeAll()
  })

  test('LAN 返回 jpeg，错误清洗', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20), Buffer.from([0xff, 0xd9])])
    const calls = []
    const mgr = createPrinterManager({
      clientFactory: fakeClientFactory(),
      cameraCapture: async (opts) => { calls.push(opts); return jpeg },
      rtspsCapture: async () => { throw Object.assign(new Error('不该走 RTSPS'), { code: 'NO_FFMPEG' }) },
      log: { debug() {} },
    })
    const res = await mgr.snapshot({ ...LAN_TARGET, model: 'A1' })
    assert.equal(res.ok, true)
    assert.equal(res.plan, 'mjpeg')
    assert.deepEqual(res.jpeg, jpeg)
    assert.equal(calls[0].host, '192.0.2.50')
    assert.equal(calls[0].port, 6000)
    assert.equal(calls[0].accessCode, SECRET)

    const failing = createPrinterManager({
      clientFactory: fakeClientFactory(),
      cameraCapture: async () => { throw new Error('认证失败 ' + SECRET) },
      log: { debug() {} },
    })
    const bad = await failing.snapshot({ ...LAN_TARGET, model: 'A1' })
    assert.equal(bad.ok, false)
    assert.ok(!bad.error.includes(SECRET))
    mgr.closeAll()
    failing.closeAll()
  })

  test('X1 型号走 RTSPS/ffmpeg 路径', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10), Buffer.from([0xff, 0xd9])])
    const rtspsCalls = []
    const mgr = createPrinterManager({
      clientFactory: fakeClientFactory(),
      cameraCapture: async () => { throw new Error('X1 不该走 MJPEG') },
      rtspsCapture: async (opts) => { rtspsCalls.push(opts); return jpeg },
      log: { debug() {} },
    })
    const res = await mgr.snapshot({ ...LAN_TARGET, model: 'X1 Carbon' })
    assert.equal(res.ok, true)
    assert.equal(res.plan, 'rtsps')
    assert.equal(rtspsCalls.length, 1)
    assert.equal(rtspsCalls[0].host, '192.0.2.50')
    assert.equal(rtspsCalls[0].accessCode, SECRET)
    mgr.closeAll()
  })

  test('ffmpeg 缺失时给出清晰中文错误', async () => {
    const mgr = createPrinterManager({
      clientFactory: fakeClientFactory(),
      cameraCapture: async () => { throw new Error('mcp fail') },
      rtspsCapture: async () => { throw Object.assign(new Error('X1 系列需要本机 ffmpeg 才能截帧'), { code: 'NO_FFMPEG' }) },
      log: { debug() {} },
    })
    const res = await mgr.snapshot({ ...LAN_TARGET, model: 'X1C' })
    assert.equal(res.ok, false)
    assert.match(res.error, /ffmpeg/)
    mgr.closeAll()
  })

  test('型号未知时 MJPEG 失败回落 RTSPS', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10), Buffer.from([0xff, 0xd9])])
    const mgr = createPrinterManager({
      clientFactory: fakeClientFactory(),
      cameraCapture: async () => { throw new Error('no mjpeg') },
      rtspsCapture: async () => jpeg,
      log: { debug() {} },
    })
    const res = await mgr.snapshot(LAN_TARGET)
    assert.equal(res.ok, true)
    assert.equal(res.plan, 'rtsps')
    mgr.closeAll()
  })

  test('云端绑定带 lanSnapshot 时走局域网拍照', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10), Buffer.from([0xff, 0xd9])])
    const calls = []
    const mgr = createPrinterManager({
      clientFactory: fakeClientFactory(),
      cameraCapture: async (opts) => { calls.push(opts); return jpeg },
      log: { debug() {} },
    })
    const res = await mgr.snapshot({
      mode: 'cloud', serial: 'S1', name: 'X1C', model: 'A1',
      ip: '192.168.1.77', accessCode: 'CLOUD-DEVICE-CODE-55', lanSnapshot: true,
    })
    assert.equal(res.ok, true)
    assert.equal(calls[0].host, '192.168.1.77')
    assert.equal(calls[0].accessCode, 'CLOUD-DEVICE-CODE-55')
    assert.ok(!JSON.stringify(res).includes('CLOUD-DEVICE-CODE-55'))
    mgr.closeAll()
  })

  test('缺少 IP 报错', async () => {
    const mgr = createPrinterManager({ clientFactory: fakeClientFactory(), log: { debug() {} } })
    const res = await mgr.snapshot({ mode: 'lan', serial: 'S', accessCode: SECRET })
    assert.equal(res.ok, false)
    assert.match(res.error, /IP/)
    mgr.closeAll()
  })
})

describe('默认 clientFactory 是真 createMqttClient', () => {
  test('createPrinterManager 默认使用 createMqttClient（类型检查）', () => {
    assert.equal(typeof createMqttClient, 'function')
    const mgr = createPrinterManager({ log: { debug() {} } })
    assert.equal(typeof mgr.status, 'function')
    assert.equal(typeof mgr.command, 'function')
    assert.equal(typeof mgr.snapshot, 'function')
    assert.equal(typeof mgr.closeAll, 'function')
    mgr.closeAll()
  })
})

describe('打印机自签名证书（局域网 TLS / 云端系统 CA）', () => {
  test('局域网未 pin：manager.status 直接失败 CERT_UNPINNED，不建连、不发访问码', async () => {
    const factory = fakeClientFactory()
    const manager = createPrinterManager({ log: null, clientFactory: factory, certTrust: certTrustOf({}) })
    const res = await manager.status(LAN_TARGET, { timeoutMs: 1000 })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'CERT_UNPINNED')
    assert.match(res.error, /没固定证书/)
    assert.ok(!JSON.stringify(res).includes(SECRET), '失败原因里不得含访问码')
    assert.equal(factory.instances.length, 0, '建连之前就该挡住：一个客户端都不许建')
  })

  test('局域网未 pin：manager.command 同样 fail-closed', async () => {
    const factory = fakeClientFactory()
    const manager = createPrinterManager({ log: null, clientFactory: factory, certTrust: certTrustOf({}) })
    const res = await manager.command(LAN_TARGET, 'pause')
    assert.equal(res.ok, false)
    assert.equal(res.code, 'CERT_UNPINNED')
    assert.equal(factory.instances.length, 0)
  })

  test('局域网已 pin（tlsCa 直接来自 target）：正常连接并带 ca 锚点', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const manager = createPrinterManager({ log: null, clientFactory: factory, certTrust: certTrustOf({}) })
    const res = await manager.status(PINNED_LAN_TARGET)
    assert.equal(res.ok, true, '有锚点就该正常连')
    const opts = factory.instances[0].opts
    assert.equal(opts.rejectUnauthorized, true, '有锚点必须校验')
    assert.deepEqual(opts.ca, [CERT.pem], 'ca 锚点交给 TLS')
    assert.equal(opts.tlsFingerprint, CERT.fingerprint256)
    assert.equal(opts.username, 'bblp')
  })

  test('学到的锚点存在 certTrust 里：rejectUnauthorized=true + ca + 指纹一起固定', async () => {
    const factory = fakeClientFactory({ onPublish(client) { pushReport(client, { print: { gcode_state: 'IDLE' } }) } })
    const map = { '01S00A999': CERT }
    const manager = createPrinterManager({ log: null, clientFactory: factory, certTrust: certTrustOf(map) })
    await manager.status(LAN_TARGET, { timeoutMs: 1000 }).catch(() => {})
    const opts = factory.instances[0].opts
    assert.equal(opts.rejectUnauthorized, true, '有锚点就必须校验')
    assert.deepEqual(opts.ca, [CERT.pem])
    assert.equal(opts.tlsFingerprint, CERT.fingerprint256)
  })

  test('云端用系统 CA 与主机名校验', async () => {
    const factory = fakeClientFactory()
    const manager = createPrinterManager({ log: null, clientFactory: factory, certTrust: certTrustOf({ '01S00C777': CERT }) })
    await manager.status(CLOUD_TARGET, { timeoutMs: 1000 }).catch(() => {})
    const opts = factory.instances[0].opts
    assert.equal(opts.rejectUnauthorized, true, '云端必须校验 broker 身份')
    assert.equal(opts.ca, undefined, '云端走系统根证书，不传 ca')
    assert.equal('checkServerIdentity' in opts, false, '云端不得覆盖主机名校验')
    assert.equal(opts.tlsFingerprint, '', '云端不固定指纹')
    assert.equal(opts.username, 'u_123456')
  })

  test('云端 target 误带 tlsCa/tlsFingerprint：一律忽略，绝不降级成不校验', async () => {
    const factory = fakeClientFactory()
    const manager = createPrinterManager({ log: null, clientFactory: factory, certTrust: null })
    const poisoned = { ...CLOUD_TARGET, tlsCa: CERT.pem, tlsFingerprint: CERT.fingerprint256, ca: ['x'], rejectUnauthorized: false }
    await manager.status(poisoned, { timeoutMs: 1000 }).catch(() => {})
    const opts = factory.instances[0].opts
    assert.equal(opts.rejectUnauthorized, true, '不可信字段不能把云端降级')
    assert.equal(opts.ca, undefined, '不认 target 上的 ca')
    assert.equal(opts.tlsFingerprint, '', '不认 target 上的指纹')
    assert.equal('checkServerIdentity' in opts, false)
  })

  test('manager.requireLanTrust：和 getConn 用同一套判定', () => {
    const map = { '01S00A999': CERT }
    const manager = createPrinterManager({ log: null, clientFactory: fakeClientFactory(), certTrust: certTrustOf(map) })
    assert.equal(manager.requireLanTrust(CLOUD_TARGET).ok, true, '云端不受影响')
    assert.equal(manager.requireLanTrust(LAN_TARGET).ok, true, 'certTrust 里有锚点就算 pin')
    const bare = createPrinterManager({ log: null, clientFactory: fakeClientFactory(), certTrust: certTrustOf({}) })
    const blocked = bare.requireLanTrust(LAN_TARGET)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'CERT_UNPINNED')
    assert.match(blocked.error, /没固定证书/)
  })

  test('requireLanTrust：纯函数的判定语义', () => {
    assert.equal(requireLanTrust(CLOUD_TARGET).ok, true, '云端永远放行')
    assert.equal(requireLanTrust({ ...CLOUD_TARGET, tlsCa: 'x' }).ok, true)
    const unpinned = requireLanTrust(LAN_TARGET)
    assert.equal(unpinned.ok, false)
    assert.equal(unpinned.code, 'CERT_UNPINNED')
    assert.equal(requireLanTrust({ ...LAN_TARGET, tlsCa: CERT.pem }).ok, true)
    assert.equal(requireLanTrust({ ...LAN_TARGET, tlsFingerprint: CERT.fingerprint256 }).ok, true, '只有指纹也算 pin')
    assert.equal(requireLanTrust(null).ok, false)
  })

  test('buildConnectionOptions：云端/局域网两套语义', () => {
    const cloud = buildConnectionOptions({ mode: 'cloud', host: 'us.mqtt.bambulab.com', ca: [CERT.pem], fingerprint: CERT.fingerprint256 })
    assert.equal(cloud.rejectUnauthorized, true)
    assert.equal(cloud.ca, undefined)
    assert.equal(cloud.tlsFingerprint, '')
    const lan = buildConnectionOptions({ mode: 'lan', host: '192.0.2.50', ca: [CERT.pem], fingerprint: CERT.fingerprint256 })
    assert.equal(lan.rejectUnauthorized, true)
    assert.deepEqual(lan.ca, [CERT.pem])
    const bare = buildConnectionOptions({ mode: 'lan', host: '192.0.2.50' })
    assert.equal(bare.rejectUnauthorized, false, '未 pin 的局域网不校验（但会被 requireLanTrust 挡住）')
    assert.equal(bare.ca, undefined)
  })

  test('learnCert：只握手、拿证书、交给 certTrust.save，然后断开（不校验只留在 learnOnly）', async () => {
    const saved = []
    const factory = () => {
      const client = new EventEmitter()
      client.closed = false
      client.connect = async () => {
        setImmediate(() => client.emit('peer-cert', { pem: CERT.pem, fingerprint256: CERT.fingerprint256, subject: '01S00A999' }))
      }
      client.close = () => { client.closed = true }
      return client
    }
    let learnOpts = null
    const manager = createPrinterManager({
      log: null,
      clientFactory: (opts) => { learnOpts = opts; return factory() },
      certTrust: { get: () => null, save: (target, info) => { saved.push({ target, info }); return true } },
    })
    const r = await manager.learnCert(LAN_TARGET)
    assert.equal(r.ok, true)
    assert.equal(r.fingerprint256, CERT.fingerprint256)
    assert.equal(learnOpts.learnOnly, true)
    assert.equal(learnOpts.rejectUnauthorized, false)
    assert.equal(learnOpts.ca, undefined, '学证书时不该拿旧锚点当 ca')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].info.pem, CERT.pem)
  })

  test('learnCert：云端目标直接拒绝（不需要学）', async () => {
    const manager = createPrinterManager({ log: null, clientFactory: fakeClientFactory(), certTrust: null })
    const r = await manager.learnCert(CLOUD_TARGET)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'NOT_LAN')
  })
})