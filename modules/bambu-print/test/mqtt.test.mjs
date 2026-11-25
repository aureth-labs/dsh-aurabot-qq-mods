// test/mqtt.test.mjs —— MQTT 3.1.1 编解码 + 客户端（假 Duplex，不连真打印机）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'

import {
  encodeRemainingLength, decodeRemainingLength, encodeConnect, encodeSubscribe, encodePublish,
  encodePingreq, encodeDisconnect, decodePacket, parsePublish, decodeConnack, connackText,
  createMqttClient, peerCertInfo, tlsOptionsFor, MAX_PACKET_BYTES, PACKET,
} from '../lib/mqtt.mjs'

const TEST_PASSWORD = 'TEST-SECRET-ACCESS-CODE-4242'

/**
 * 既有协议用例只测编解码/状态机：它们注入假 Duplex，不涉及真实 TLS。
 * 凭据门会拒绝「不校验 TLS 还带访问码」的连接，所以这里统一打开只给测试的开关。
 */
function insecureClient(opts) {
  return createMqttClient({ ...opts, allowInsecureCredentialsForTest: true })
}

/** 假打印机：按需回 CONNACK / PUBLISH，记录写入的字节 */
function fakeSocket({ connackRc = 0, autoConnack = true } = {}) {
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      socket.written.push(Buffer.from(chunk))
      if (autoConnack && chunk[0] === PACKET.CONNECT << 4) {
        setImmediate(() => socket.push(Buffer.from([0x20, 0x02, 0x00, connackRc])))
      }
      cb()
    },
  })
  socket.written = []
  socket.pushBack = (buf) => socket.push(Buffer.from(buf))
  return socket
}

function packetsOf(socket) {
  const out = []
  let buf = Buffer.concat(socket.written)
  for (;;) {
    const pkt = decodePacket(buf)
    if (!pkt) break
    out.push(pkt)
    buf = buf.subarray(pkt.consumed)
  }
  return out
}

describe('remaining length varint', () => {
  test('边界值往返', () => {
    for (const n of [0, 1, 127, 128, 300, 16383, 16384, 2097151, 2097152, 268435455]) {
      const enc = encodeRemainingLength(n)
      assert.deepEqual(decodeRemainingLength(enc, 0), { length: n, size: enc.length })
    }
  })

  test('128 用两字节分位', () => {
    assert.deepEqual([...encodeRemainingLength(128)], [0x80, 0x01])
    assert.deepEqual([...encodeRemainingLength(321)], [0xc1, 0x02])
  })

  test('负数和越界抛错', () => {
    assert.throws(() => encodeRemainingLength(-1), RangeError)
    assert.throws(() => encodeRemainingLength(268435456), RangeError)
    assert.throws(() => encodeRemainingLength(1.5), RangeError)
  })

  test('不完整或非法返回 null', () => {
    assert.equal(decodeRemainingLength(Buffer.from([]), 0), null)
    assert.equal(decodeRemainingLength(Buffer.from([0x80]), 0), null)
    assert.equal(decodeRemainingLength(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x01]), 0), null)
  })
})

describe('packet encoders', () => {
  test('CONNECT 头部与字段', () => {
    const buf = encodeConnect({ clientId: 'aurabot_test', username: 'bblp', password: TEST_PASSWORD, keepalive: 60 })
    assert.equal(buf[0], 0x10)
    const pkt = decodePacket(buf)
    assert.equal(pkt.type, PACKET.CONNECT)
    assert.equal(pkt.consumed, buf.length)
    const body = pkt.body
    const protoLen = body.readUInt16BE(0)
    assert.equal(body.subarray(2, 2 + protoLen).toString(), 'MQTT')
    assert.equal(body[2 + protoLen], 4) // 协议级别 3.1.1
    const flags = body[2 + protoLen + 1]
    assert.equal(flags & 0x02, 0x02, 'clean session')
    assert.equal(flags & 0x80, 0x80, 'username 标志')
    assert.equal(flags & 0x40, 0x40, 'password 标志')
    assert.equal(body.readUInt16BE(2 + protoLen + 2), 60)
    assert.ok(body.includes(Buffer.from('bblp')), '包含用户名')
  })

  test('CONNECT 无用户名时不置位', () => {
    const pkt = decodePacket(encodeConnect({ clientId: 'x' }))
    const body = pkt.body
    const protoLen = body.readUInt16BE(0)
    assert.equal(body[2 + protoLen + 1] & 0xc0, 0)
  })

  test('SUBSCRIBE 固定头 0x82 且带 packetId + qos', () => {
    const buf = encodeSubscribe(7, 'device/01S/report', 0)
    const pkt = decodePacket(buf)
    assert.equal(pkt.type, PACKET.SUBSCRIBE)
    assert.equal(pkt.flags, 0x02)
    assert.equal(pkt.body.readUInt16BE(0), 7)
    assert.equal(pkt.body[pkt.body.length - 1], 0)
  })

  test('PUBLISH QoS0 无 packetId，QoS1 有', () => {
    const q0 = decodePacket(encodePublish('device/x/request', '{"print":{}}'))
    assert.equal(q0.type, PACKET.PUBLISH)
    assert.equal((q0.flags >> 1) & 0x03, 0)
    const parsed0 = parsePublish(q0.body, 0)
    assert.equal(parsed0.topic, 'device/x/request')
    assert.equal(parsed0.payload.toString(), '{"print":{}}')
    assert.equal(parsed0.packetId, null)

    const q1 = decodePacket(encodePublish('t/1', 'hi', { qos: 1, packetId: 42 }))
    const parsed1 = parsePublish(q1.body, 1)
    assert.equal(parsed1.packetId, 42)
    assert.equal(parsed1.payload.toString(), 'hi')
  })

  test('PUBLISH retain 位', () => {
    const pkt = decodePacket(encodePublish('t', 'x', { retain: true }))
    assert.equal(pkt.flags & 0x01, 0x01)
  })

  test('PINGREQ / DISCONNECT 单字节负载', () => {
    assert.deepEqual([...encodePingreq()], [0xc0, 0x00])
    assert.deepEqual([...encodeDisconnect()], [0xe0, 0x00])
  })

  test('二进制 payload 原样', () => {
    const bin = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01])
    const pkt = decodePacket(encodePublish('t', bin))
    assert.deepEqual([...parsePublish(pkt.body).payload], [...bin])
  })
})

describe('decodePacket', () => {
  test('不完整报文返回 null', () => {
    const full = encodePublish('topic', 'payload')
    assert.equal(decodePacket(full.subarray(0, 3)), null)
    assert.equal(decodePacket(Buffer.alloc(0)), null)
  })

  test('粘包时按 consumed 切分', () => {
    const both = Buffer.concat([encodePingreq(), encodeDisconnect()])
    const first = decodePacket(both)
    assert.equal(first.consumed, 2)
    const second = decodePacket(both.subarray(first.consumed))
    assert.equal(second.type, PACKET.DISCONNECT)
  })

  test('CONNACK 解析与返回码文案', () => {
    assert.deepEqual(decodeConnack(Buffer.from([0x01, 0x00])), { sessionPresent: true, returnCode: 0 })
    assert.deepEqual(decodeConnack(Buffer.from([0x00, 0x05])), { sessionPresent: false, returnCode: 5 })
    assert.equal(decodeConnack(Buffer.from([0x00])), null)
    assert.match(connackText(4), /访问码/)
    assert.match(connackText(99), /未知/)
  })
})

describe('createMqttClient', () => {
  test('连接成功后可发布，PINGREQ 定时器 unref', async () => {
    const socket = fakeSocket()
    const client = insecureClient({
      host: '192.0.2.10', username: 'bblp', password: TEST_PASSWORD,
      keepalive: 2, connect: () => socket, log: { debug() {} },
    })
    await client.connect()
    assert.equal(client.isOpen(), true)
    await client.publish('device/01S/request', '{"print":{"command":"pause"}}')
    const sent = packetsOf(socket)
    assert.equal(sent[0].type, PACKET.CONNECT)
    assert.equal(sent[1].type, PACKET.PUBLISH)
    assert.equal(parsePublish(sent[1].body).topic, 'device/01S/request')
    client.close()
    assert.equal(client.isOpen(), false)
  })

  test('CONNACK 拒绝码带中文说明', async () => {
    const socket = fakeSocket({ connackRc: 4 })
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await assert.rejects(() => client.connect(), (err) => {
      assert.equal(err.code, 'CONNACK_REFUSED')
      assert.equal(err.returnCode, 4)
      assert.match(err.message, /访问码/)
      assert.ok(!err.message.includes(TEST_PASSWORD))
      return true
    })
    client.close()
  })

  test('CONNACK 返回码 5 也不泄漏密码', async () => {
    const socket = fakeSocket({ connackRc: 5 })
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await assert.rejects(() => client.connect(), (err) => !err.message.includes(TEST_PASSWORD) && !JSON.stringify(err).includes(TEST_PASSWORD))
    client.close()
  })

  test('收到 report PUBLISH 触发 message 事件', async () => {
    const socket = fakeSocket()
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await client.connect()
    const got = new Promise((resolve) => client.once('message', (topic, payload) => resolve({ topic, payload })))
    const body = Buffer.concat([
      Buffer.from([0x00, 'device/01S/report'.length]),
      Buffer.from('device/01S/report'),
      Buffer.from('{"print":{"gcode_state":"RUNNING"}}'),
    ])
    socket.pushBack(Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]))
    const msg = await got
    assert.equal(msg.topic, 'device/01S/report')
    assert.equal(JSON.parse(msg.payload.toString()).print.gcode_state, 'RUNNING')
    client.close()
  })

  test('超过 4MB 的包被拒绝并关闭', async () => {
    const socket = fakeSocket()
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await client.connect()
    const errP = new Promise((resolve) => client.once('close', resolve))
    // 声称 5MB 的报文
    const head = Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(5 * 1024 * 1024)])
    socket.pushBack(head)
    const err = await errP
    assert.ok(err && String(err.message).includes('4MB'), '应报告超过 4MB 上限')
    assert.ok(MAX_PACKET_BYTES === 4 * 1024 * 1024)
    client.close()
  })

  test('未连接时 publish/subscribe 拒绝；close 拒绝未决 promise', async () => {
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => fakeSocket(), log: { debug() {} } })
    await assert.rejects(() => client.publish('t', 'x'), (err) => err.code === 'MQTT_CLOSED')
    await assert.rejects(() => client.subscribe('t'), (err) => err.code === 'MQTT_CLOSED')

    const socket = fakeSocket()
    const live = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await live.connect()
    live.close()
    await assert.rejects(() => live.publish('t', 'x'), (err) => err.code === 'MQTT_CLOSED')
  })

  test('连接超时', async () => {
    const socket = fakeSocket({ autoConnack: false })
    const client = insecureClient({
      host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket,
      connectTimeoutMs: 60, log: { debug() {} },
    })
    await assert.rejects(() => client.connect(), (err) => err.code === 'TIMEOUT')
  })

  test('socket 错误不会泄漏密码', async () => {
    const socket = fakeSocket()
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    const closeP = new Promise((resolve) => client.once('close', resolve))
    await client.connect()
    socket.emit('error', new Error('ECONNRESET'))
    const err = await closeP
    assert.ok(err)
    assert.ok(!String(err.message).includes(TEST_PASSWORD))
  })

  test('close 只触发一次（断线后不重复）', async () => {
    const socket = fakeSocket()
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await client.connect()
    let closes = 0
    client.on('close', () => { closes++ })
    socket.destroy()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(closes, 1, '一次断开只发一次 close 事件')
  })

  test('CONNACK 拒绝后 close 也只发一次，日志不含密码', async () => {
    const logs = []
    const socket = fakeSocket({ connackRc: 4 })
    const client = insecureClient({
      host: 'h', username: 'bblp', password: TEST_PASSWORD,
      connect: () => socket, log: { debug: (...a) => logs.push(a.join(' ')) },
    })
    let closes = 0
    client.on('close', () => { closes++ })
    await assert.rejects(() => client.connect())
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(closes, 1)
    assert.ok(!logs.join('\n').includes(TEST_PASSWORD), '日志不得含密码')
    // CONNECT 报文本身按协议带密码，但它不会被回显到日志/错误里
    const connectPacket = socket.written[0]
    assert.ok(connectPacket.includes(Buffer.from(TEST_PASSWORD)), 'CONNECT 内按协议携带密码')
    assert.ok(!client.host.includes(TEST_PASSWORD) && !String(connackText(4)).includes(TEST_PASSWORD))
  })

  test('subscribe 写入 SUBSCRIBE 包', async () => {
    const socket = fakeSocket()
    const client = insecureClient({ host: 'h', username: 'bblp', password: TEST_PASSWORD, connect: () => socket, log: { debug() {} } })
    await client.connect()
    await client.subscribe('device/01S/report', 0)
    const sent = packetsOf(socket)
    const sub = sent.find((p) => p.type === PACKET.SUBSCRIBE)
    assert.ok(sub, '应发出 SUBSCRIBE')
    assert.match(sub.body.toString(), /device\/01S\/report/)
    client.close()
  })
})

test('给了 ca 锚点就一定开启校验，并把 ca 交给 tls.connect', async () => {
  const seen = []
  const socket = fakeSocket()
  const client = createMqttClient({
    host: '192.168.1.50',
    port: 8883,
    username: 'bblp',
    password: TEST_PASSWORD,
    ca: ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'],
    connect: (opts) => {
      seen.push(opts)
      return socket
    },
  })
  await client.connect()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].rejectUnauthorized, true, '有锚点就必须校验')
  client.close()
})

test('learnOnly：只学到证书就断开，绝不发 CONNECT（访问码不出门）', async () => {
  const { generateSelfSignedCert, pemToDer } = await import('../lib/tls-cert.mjs')
  const cert = generateSelfSignedCert({ commonName: '01S00A123' })
  const socket = fakeSocket()
  socket.getPeerCertificate = () => ({
    raw: pemToDer(cert.certPem),
    fingerprint256: cert.fingerprint256,
    subject: { CN: '01S00A123' },
    issuer: { CN: '01S00A123' },
    valid_to: new Date(cert.notAfter).toUTCString(),
  })
  const learned = []
  const client = createMqttClient({
    host: '192.168.1.50',
    port: 8883,
    username: 'bblp',
    password: TEST_PASSWORD,
    learnOnly: true,
    connect: () => socket,
  })
  client.on('peer-cert', (info) => learned.push(info))
  await client.connect()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(learned.length, 1, '应当 emit 一次 peer-cert')
  assert.equal(learned[0].fingerprint256, cert.fingerprint256)
  assert.equal(learned[0].pem, cert.certPem)
  assert.equal(socket.written.length, 0, '学习模式一个字节都不该发')
  assert.equal(socket.written.some((buf) => buf.includes(Buffer.from(TEST_PASSWORD))), false, '访问码绝不能出门')
  client.close()
})

test('learnOnly：对端不出示证书时报 TLS_NO_CERT，而不是静默成功', async () => {
  const socket = fakeSocket()
  const client = createMqttClient({ host: '192.168.1.50', password: TEST_PASSWORD, learnOnly: true, connect: () => socket })
  await assert.rejects(() => client.connect(), (err) => err.code === 'TLS_NO_CERT')
})

test('peerCertInfo：把对端证书整理成 {pem, fingerprint256, selfSigned}', async () => {
  const { generateSelfSignedCert, pemToDer } = await import('../lib/tls-cert.mjs')
  const cert = generateSelfSignedCert({ commonName: '01S00A123' })
  const socket = {
    getPeerCertificate: () => ({
      raw: pemToDer(cert.certPem), fingerprint256: cert.fingerprint256,
      subject: { CN: '01S00A123' }, issuer: { CN: '01S00A123' },
    }),
  }
  const info = peerCertInfo(socket)
  assert.equal(info.pem, cert.certPem)
  assert.equal(info.fingerprint256, cert.fingerprint256)
  assert.equal(info.selfSigned, true)
  assert.equal(peerCertInfo(null), null)
})

describe('TLS 身份校验（P1-2 云端必须验 broker）', () => {
  test('云端：系统 CA + 主机名，不覆盖 checkServerIdentity', () => {
    const opts = tlsOptionsFor({ host: 'us.mqtt.bambulab.com', port: 8883, rejectUnauthorized: true, ca: [] })
    assert.equal(opts.rejectUnauthorized, true, '云端必须校验 broker 身份')
    assert.equal(opts.ca, undefined, '云端用系统根证书，不给 ca')
    assert.equal(opts.minVersion, 'TLSv1.2')
    assert.equal('checkServerIdentity' in opts, false, '云端绝不能覆盖主机名校验')
    assert.equal(opts.checkServerIdentity, undefined)
  })

  test('局域网有锚点：不校主机名（CN 是序列号），靠锚点 + 指纹', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'
    const opts = tlsOptionsFor({ host: '192.168.1.50', port: 8883, rejectUnauthorized: false, ca: [pem] })
    assert.equal(opts.rejectUnauthorized, true, '有锚点必须校验')
    assert.deepEqual(opts.ca, [pem])
    assert.equal(typeof opts.checkServerIdentity, 'function')
    assert.equal(opts.checkServerIdentity('192.168.1.50', {}), undefined, '局域网不校主机名')
  })

  test('不校验且无锚点时，checkServerIdentity 也不是恒真（除非测试注入）', () => {
    const opts = tlsOptionsFor({ host: 'h', port: 8883, rejectUnauthorized: false, ca: [] })
    assert.equal('checkServerIdentity' in opts, false, '默认交给 Node 的默认实现')
    const injected = () => new Error('bad cert')
    const withInjected = tlsOptionsFor({ host: 'h', port: 8883, rejectUnauthorized: true, ca: [], checkServerIdentity: injected })
    assert.equal(withInjected.checkServerIdentity, injected)
  })
})

describe('凭据门 fail-closed（P1-3）', () => {
  test('无锚点 + 有访问码 + 未明确开启校验 → 抛 INSECURE_CREDENTIALS，且不建连', async () => {
    let connectCalls = 0
    const client = createMqttClient({
      host: '192.168.1.50',
      port: 8883,
      username: 'bblp',
      password: TEST_PASSWORD,
      connect: () => {
        connectCalls++
        return fakeSocket()
      },
    })
    await assert.rejects(() => client.connect(), (err) => {
      assert.equal(err.code, 'INSECURE_CREDENTIALS')
      assert.ok(!err.message.includes(TEST_PASSWORD), '错误里不得出现访问码')
      return true
    })
    assert.equal(connectCalls, 0, '一个字节都不该写出去')
  })

  test('构造期就拒绝：既不注入 connect 也不连真 TLS', async () => {
    let connectCalls = 0
    const client = createMqttClient({
      host: '192.168.1.50',
      password: TEST_PASSWORD,
      connect: () => { connectCalls++; return fakeSocket() },
    })
    await assert.rejects(() => client.connect(), (err) => err.code === 'INSECURE_CREDENTIALS')
    assert.equal(connectCalls, 0)
  })

  test('云端（rejectUnauthorized:true，无 ca）带 token 可以正常建连', async () => {
    const seen = []
    const socket = fakeSocket()
    const client = createMqttClient({
      host: 'us.mqtt.bambulab.com',
      port: 8883,
      username: 'u_123456',
      password: TEST_PASSWORD,
      rejectUnauthorized: true,
      connect: (opts) => { seen.push(opts); return socket },
      log: { debug() {} },
    })
    await client.connect()
    assert.equal(seen.length, 1)
    assert.equal(seen[0].rejectUnauthorized, true)
    client.close()
  })

  test('learnOnly 且不发凭据仍然可用（回归）', async () => {
    const { generateSelfSignedCert, pemToDer } = await import('../lib/tls-cert.mjs')
    const cert = generateSelfSignedCert({ commonName: '01S00A123' })
    const socket = fakeSocket()
    socket.getPeerCertificate = () => ({
      raw: pemToDer(cert.certPem),
      fingerprint256: cert.fingerprint256,
      subject: { CN: '01S00A123' },
      issuer: { CN: '01S00A123' },
      valid_to: new Date(cert.notAfter).toUTCString(),
    })
    const learned = []
    // 只读证书、不带任何凭据：即使不校验也不该被凭据门挡住
    const client = createMqttClient({ host: '192.168.1.50', port: 8883, learnOnly: true, connect: () => socket })
    client.on('peer-cert', (info) => learned.push(info))
    await client.connect()
    assert.equal(learned.length, 1)
    assert.equal(socket.written.length, 0, '学习模式一个字节都不发')
    client.close()
  })

  test('只有指纹 pin（无 ca）也放行：身份在写 CONNECT 之前已核对', async () => {
    const socket = fakeSocket()
    socket.getPeerCertificate = () => ({ fingerprint256: 'AA:BB', raw: Buffer.from([1, 2, 3]) })
    const client = createMqttClient({
      host: '192.168.1.50',
      username: 'bblp',
      password: TEST_PASSWORD,
      tlsFingerprint: 'aabb',
      connect: () => socket,
      log: { debug() {} },
    })
    await client.connect()
    assert.equal(client.isOpen(), true)
    client.close()
  })

  test('有锚点时凭据门放行（局域网正常路径）', async () => {
    const socket = fakeSocket()
    const client = createMqttClient({
      host: '192.168.1.50',
      username: 'bblp',
      password: TEST_PASSWORD,
      ca: ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'],
      connect: () => socket,
      log: { debug() {} },
    })
    await client.connect()
    assert.equal(client.isOpen(), true)
    client.close()
  })
})