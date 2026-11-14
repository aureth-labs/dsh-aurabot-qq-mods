// lib/discover.mjs 的测试：只测「探测包形状 / 响应解析 / 去重 / 超时」，
// 不依赖真实网卡（socket 全部注入）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { discoveryProbe, parseDiscoveryResponse, discoverPrinters, DISCOVERY_HOST, DISCOVERY_PORT, DISCOVERY_ST_PORT } from '../lib/discover.mjs'

/** 一个形状和 dgram.Socket 一致的假 socket，能让测试手动喂响应。 */
function fakeSocket () {
  const handlers = {}
  const sent = []
  return {
    sent,
    closed: false,
    on (ev, fn) { handlers[ev] = fn },
    bind (port, cb) { this.port = port; setImmediate(cb) },
    setBroadcast () {},
    send (buf, off, len, port, addr, cb) { sent.push({ port, addr, text: String(buf) }); if (cb) cb() },
    close () { this.closed = true },
    emit (ev, ...args) { if (handlers[ev]) handlers[ev](...args) },
  }
}

test('探测包是标准 M-SEARCH，ST 指向拓竹打印机', async () => {
  const probe = discoveryProbe()
  assert.match(probe, /^M-SEARCH \* HTTP\/1\.1\r\n/)
  assert.match(probe, /HOST: 239\.255\.255\.250:1990/)
  assert.match(probe, /MAN: "ssdp:discover"/)
  assert.ok(probe.includes('ST: ' + DISCOVERY_ST_PORT))
  assert.ok(probe.endsWith('\r\n\r\n'), '以空行结尾')
  assert.equal(DISCOVERY_PORT, 2021)
  assert.equal(DISCOVERY_HOST, '239.255.255.250')
})

test('解析头部形式的响应：序列号 / 名字 / 型号 / 信号 / IP', async () => {
  const text = [
    'HTTP/1.1 200 OK',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: A1-mini-01',
    'DevSignal.bambu.com: -50',
    'DevSerial.bambu.com: 01S00A123456789',
  ].join('\r\n')
  const d = parseDiscoveryResponse(text, '192.168.1.50')
  assert.equal(d.serial, '01S00A123456789')
  assert.equal(d.name, 'A1-mini-01')
  assert.equal(d.model, 'C12')
  assert.equal(d.signal, '-50')
  assert.equal(d.ip, '192.168.1.50', '没有 Location 时用来源 IP')
})

test('解析 JSON 形式的响应（有些固件把设备信息放 body）', async () => {
  const text = 'HTTP/1.1 200 OK\r\n\r\n' + JSON.stringify({
    dev_serial: '02P00B987654321', dev_ip: '192.168.1.77', dev_name: 'P1S', dev_model: 'C11', dev_signal: '-60',
  })
  const d = parseDiscoveryResponse(text, '')
  assert.equal(d.serial, '02P00B987654321')
  assert.equal(d.ip, '192.168.1.77', 'body 里的 dev_ip 优先')
  assert.equal(d.name, 'P1S')
  assert.equal(d.model, 'C11')
  assert.equal(d.signal, '-60')
})

test('Location 里的 IP 会被取出来；空响应不编造字段', async () => {
  const d = parseDiscoveryResponse('HTTP/1.1 200 OK\r\nLocation: http://192.168.1.99:80/\r\n', '10.0.0.1')
  assert.equal(d.ip, '192.168.1.99')
  const empty = parseDiscoveryResponse('', '')
  assert.deepEqual(empty, { serial: '', ip: '', name: '', model: '', signal: '' })
})

test('一次扫描：组播 + 广播都发，按序列号去重，超时后返回', async () => {
  const sock = fakeSocket()
  setTimeout(() => {
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nDevSerial.bambu.com: 01S00A123456789\r\nDevName.bambu.com: A1\r\nDevModel.bambu.com: C12\r\n'), { address: '192.168.1.50' })
    // 同一台的重复广播（字段更少）：应当被合并，而不是变成两条
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nDevSerial.bambu.com: 01S00A123456789\r\nDevName.bambu.com: A1\r\n'), { address: '192.168.1.50' })
    sock.emit('message', Buffer.from('{"dev_serial":"02P00B987654321","dev_ip":"192.168.1.77","dev_name":"P1S"}'), { address: '192.168.1.77' })
  }, 40)

  const started = Date.now()
  const r = await discoverPrinters({ timeoutMs: 500, socketFactory: () => sock, broadcastList: ['192.168.1.255'] })
  const waited = Date.now() - started
  assert.equal(r.ok, true)
  assert.equal(r.devices.length, 2, '两台不同的打印机')
  const a1 = r.devices.find((d) => d.serial === '01S00A123456789')
  assert.equal(a1.model, 'C12', '去重时保留字段更全的那份')
  assert.equal(sock.closed, true, '结束时关 socket')
  assert.ok(waited >= 400 && waited < 2000, '应当在超时附近结束，实际 ' + waited + 'ms')
  // 组播一次 + 指定的广播一次（第二轮也会发，所以至少 2 条）
  assert.ok(sock.sent.length >= 2)
  assert.ok(sock.sent.some((x) => x.addr === DISCOVERY_HOST && x.port === 1990), '要发组播')
  assert.ok(sock.sent.some((x) => x.addr === '192.168.1.255'), '要发网段广播')
  assert.equal(JSON.stringify(r).includes('accessCode'), false, '发现结果里不可能有访问码')
})

test('socket 建不起来时如实报错，不假装搜到 0 台', async () => {
  const r = await discoverPrinters({ timeoutMs: 300, socketFactory: () => { throw new Error('no udp') } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SOCKET_FAILED')
  assert.deepEqual(r.devices, [])
})
