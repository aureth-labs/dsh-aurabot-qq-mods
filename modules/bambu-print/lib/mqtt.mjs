// lib/mqtt.mjs —— 最小 MQTT 3.1.1 客户端（只依赖 node:tls / node:net / node:crypto / node:events）
// 用于 Bambu 局域网：host=打印机 IP，8883，用户名 bblp，密码=访问码，TLS 自签名。
//
// 自签名证书的处理（TOFU，首次自动学习后再校验）：
//   · 打印机用的是它自己生成的自签名证书，CN 是序列号不是 IP，公共 CA 链不存在；
//   · opts.ca（PEM 数组）给定时用它当信任锚点，rejectUnauthorized 自动打开 —— 这才是真的在校验；
//   · 没有 ca 且没有 pin 时（第一次连），连接会「只读到对端证书」就完成握手：
//     learnOnly=true 时立刻断开并触发 'peer-cert' 事件，把证书（PEM + 指纹）交给上层落盘；
//   · 上层下次把该证书放进 opts.ca，指纹放进 opts.tlsFingerprint，就变成双向确认的严格校验。
// 绝不会「跳过校验还继续用」：不校验的连接只活到拿到证书那一刻。
// 云端（无锚点）则相反：靠公共 CA + 主机名校验，绝不覆盖 checkServerIdentity。
// 兜底 fail-closed：opts 带 username/password、又没有锚点、且 rejectUnauthorized 不是明确的 true，
// 直接在 connect() 前抛 INSECURE_CREDENTIALS，一个字节的 CONNECT 都不发（learnOnly 不受影响）。
// 只实现 CONNECT / CONNACK / SUBSCRIBE / PUBLISH / PINGREQ / PINGRESP / DISCONNECT。
// 所有编解码都是纯函数，客户端可注入 connect() 返回 Duplex 以便测试。
// 安全：密码/访问码只在 CONNECT 报文里出现，绝不进日志或错误文本。

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import tls from 'node:tls'
import { createHash } from 'node:crypto'
import { derToPem } from './tls-cert.mjs'
import net from 'node:net'

/** 单个 MQTT 报文上限：4MB */
export const MAX_PACKET_BYTES = 4 * 1024 * 1024

export const PACKET = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
}

const CONNACK_TEXT = {
  0: '连接已接受',
  1: '不支持的协议版本',
  2: '客户端标识被拒绝',
  3: '服务端不可用',
  4: '用户名或访问码错误',
  5: '未授权',
}

/** 把 0..268435455 编码成 MQTT remaining length（1..4 字节，每字节 7 位 + 续位） */
export function encodeRemainingLength(n) {
  const value = Number(n)
  if (!Number.isInteger(value) || value < 0 || value > 268435455) {
    throw new RangeError('remaining length 必须是 0..268435455 的整数')
  }
  const bytes = []
  let rest = value
  do {
    let byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest > 0) byte |= 0x80
    bytes.push(byte)
  } while (rest > 0)
  return Buffer.from(bytes)
}

/**
 * 解析 remaining length。
 * @returns {{length:number,size:number}|null} 数据不完整或非法返回 null
 */
export function decodeRemainingLength(buf, offset = 0) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let multiplier = 1
  let value = 0
  for (let i = 0; i < 4; i++) {
    const index = offset + i
    if (index >= view.length) return null
    const byte = view[index]
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) return { length: value, size: i + 1 }
    multiplier *= 128
  }
  // 第 4 个字节仍带续位 -> 非法
  return null
}

function encodeString(text) {
  const buf = Buffer.from(String(text), 'utf8')
  if (buf.length > 65535) throw new RangeError('MQTT 字符串超过 65535 字节')
  const head = Buffer.allocUnsafe(2)
  head.writeUInt16BE(buf.length, 0)
  return Buffer.concat([head, buf])
}

function packet(type, flags, body) {
  const head = Buffer.from([(type << 4) | (flags & 0x0f)])
  return Buffer.concat([head, encodeRemainingLength(body.length), body])
}

/** CONNECT（cleanSession=true，可选 will 不支持） */
export function encodeConnect({ clientId = '', username, password, keepalive = 60 } = {}) {
  const protocolName = encodeString('MQTT')
  const flags = Buffer.allocUnsafe(1)
  let connectFlags = 0x02 // clean session
  const parts = [encodeString(clientId ?? '')]
  if (username !== undefined && username !== null && username !== '') {
    connectFlags |= 0x80
    parts.push(encodeString(username))
  }
  if (password !== undefined && password !== null && password !== '') {
    connectFlags |= 0x40
    parts.push(encodeString(password))
  }
  flags[0] = connectFlags
  const level = Buffer.from([0x04])
  const keep = Buffer.allocUnsafe(2)
  const ka = Number.isFinite(Number(keepalive)) ? Math.max(0, Math.min(65535, Math.floor(Number(keepalive)))) : 60
  keep.writeUInt16BE(ka, 0)
  const body = Buffer.concat([protocolName, level, flags, keep, ...parts])
  return packet(PACKET.CONNECT, 0, body)
}

/** SUBSCRIBE（单主题，QoS 0/1） */
export function encodeSubscribe(packetId, topic, qos = 0) {
  const id = Buffer.allocUnsafe(2)
  id.writeUInt16BE(packetId & 0xffff, 0)
  const qosByte = Buffer.from([qos === 1 ? 0x01 : 0x00])
  const body = Buffer.concat([id, encodeString(topic), qosByte])
  return packet(PACKET.SUBSCRIBE, 0x02, body)
}

/** PUBLISH（QoS0 默认；QoS1 带 packetId） */
export function encodePublish(topic, payload, { qos = 0, packetId = 0, retain = false } = {}) {
  const q = qos === 1 ? 1 : 0
  const flags = ((q & 0x03) << 1) | (retain ? 0x01 : 0x00)
  const chunks = [encodeString(topic)]
  if (q > 0) {
    const id = Buffer.allocUnsafe(2)
    id.writeUInt16BE(packetId & 0xffff, 0)
    chunks.push(id)
  }
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null), 'utf8')
  chunks.push(data)
  return packet(PACKET.PUBLISH, flags, Buffer.concat(chunks))
}

export function encodePuback(packetId) {
  const body = Buffer.allocUnsafe(2)
  body.writeUInt16BE(packetId & 0xffff, 0)
  return packet(PACKET.PUBACK, 0, body)
}

export function encodePingreq() {
  return Buffer.from([PACKET.PINGREQ << 4, 0x00])
}

export function encodeDisconnect() {
  return Buffer.from([PACKET.DISCONNECT << 4, 0x00])
}

/**
 * 从一段字节里取出一个完整报文。
 * @returns {{type:number, flags:number, body:Buffer, consumed:number}|null} 不完整返回 null
 */
export function decodePacket(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return null
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.length < 2) return null
  const type = view[0] >> 4
  const flags = view[0] & 0x0f
  const rl = decodeRemainingLength(view, 1)
  if (!rl) return null
  const start = 1 + rl.size
  const end = start + rl.length
  if (view.length < end) return null
  return { type, flags, body: view.subarray(start, end), consumed: end }
}

/** 解析 PUBLISH body：topic +（QoS>0 时的 packetId）+ payload */
export function parsePublish(body, qos = 0) {
  const view = Buffer.isBuffer(body) ? body : Buffer.from(body ?? [])
  if (view.length < 2) return { topic: '', payload: Buffer.alloc(0), packetId: null, qos }
  const topicLen = view.readUInt16BE(0)
  if (view.length < 2 + topicLen) return { topic: '', payload: Buffer.alloc(0), packetId: null, qos }
  const topic = view.subarray(2, 2 + topicLen).toString('utf8')
  let offset = 2 + topicLen
  let packetId = null
  if (qos > 0 && view.length >= offset + 2) {
    packetId = view.readUInt16BE(offset)
    offset += 2
  }
  return { topic, payload: view.subarray(offset), packetId, qos }
}

/** 解析 CONNACK body -> { sessionPresent, returnCode } */
export function decodeConnack(body) {
  const view = Buffer.isBuffer(body) ? body : Buffer.from(body ?? [])
  if (view.length < 2) return null
  return { sessionPresent: (view[0] & 0x01) === 1, returnCode: view[1] }
}

/** CONNACK 返回码 -> 中文说明（不含任何凭据） */
export function connackText(code) {
  return CONNACK_TEXT[code] || '未知原因'
}

function fingerprintOf(socket) {
  try {
    const cert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null
    if (!cert || !cert.fingerprint256) return ''
    return String(cert.fingerprint256).replace(/:/g, '').toLowerCase()
  } catch {
    return ''
  }
}

/** 把 socket 上的对端证书整理成 {pem, fingerprint256, subject, notAfter}；取不到返回 null */
export function peerCertInfo(socket) {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null
  let cert = null
  try {
    cert = socket.getPeerCertificate(true)
  } catch {
    return null
  }
  if (!cert || typeof cert !== 'object') return null
  const raw = Buffer.isBuffer(cert.raw)
    ? cert.raw
    : (cert.raw && typeof cert.raw === 'object' && cert.raw.data ? Buffer.from(cert.raw.data) : null)
  const fingerprint = String(cert.fingerprint256 || '').replace(/:/g, '').toLowerCase()
  if (!raw && !fingerprint) return null
  const pem = raw ? derToPem(raw) : ''
  return {
    pem,
    fingerprint256: fingerprint || (raw ? createHash('sha256').update(raw).digest('hex') : ''),
    subject: cert.subject ? String(cert.subject.CN || '') : '',
    issuer: cert.issuer ? String(cert.issuer.CN || '') : '',
    selfSigned: Boolean(cert.issuer && cert.subject && cert.issuer.CN === cert.subject.CN),
    notAfter: cert.valid_to ? new Date(cert.valid_to).getTime() : 0,
  }
}

/**
 * 构造交给 tls.connect 的参数（纯函数，便于单测）。
 *
 * 两种身份保证，绝不混用：
 * · 云端（无锚点、rejectUnauthorized=true）：靠**公共 CA + 主机名**。启用系统根证书链验证，
 *   并且**不覆盖 checkServerIdentity** —— 用 Node 默认的主机名校验。
 * · 局域网（有自签锚点 learnedCa）：打印机的 CN 是序列号、连的又是 IP，默认主机名校验必然失败；
 *   这里不校主机名，身份改由「ca 锚点 + 证书 sha256 指纹固定」保证。
 *
 * @param {{host?:string, port?:number, rejectUnauthorized?:boolean, ca?:string[], checkServerIdentity?:Function}} input
 */
export function tlsOptionsFor({ host = '', port = 8883, rejectUnauthorized = true, ca = [], checkServerIdentity = undefined } = {}) {
  const caList = (Array.isArray(ca) ? ca : ca ? [ca] : []).map((x) => String(x || '')).filter(Boolean)
  const learnedCa = caList.length > 0
  const opts = {
    host,
    port,
    rejectUnauthorized: learnedCa ? true : rejectUnauthorized === true,
    minVersion: 'TLSv1.2',
  }
  if (learnedCa) opts.ca = caList
  if (learnedCa) {
    // 局域网：证书 CN 是序列号又连 IP，主机名没法对；真正的保证是锚点 + 指纹。
    opts.checkServerIdentity = () => undefined
  } else if (typeof checkServerIdentity === 'function') {
    // 云端：不覆盖默认实现（只有测试会注入）
    opts.checkServerIdentity = checkServerIdentity
  }
  return opts
}

/**
 * 创建 MQTT 客户端。
 * @param {object} opts
 * @param {string} opts.host 打印机 IP 或 mqtt 主机
 * @param {number} [opts.port=8883]
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 * @param {string} [opts.clientId]
 * @param {number} [opts.keepalive=60] 秒；每 keepalive/2 发 PINGREQ
 * @param {boolean} [opts.rejectUnauthorized=false] 自签名证书默认不校验（要配合 ca/pin 才校验）
 * @param {string[]} [opts.ca=[]] 信任锚点（打印机自签名证书 PEM）；给了就一定会校验
 * @param {boolean} [opts.learnOnly=false] 只学习证书：握手完即断开并 emit 'peer-cert'
 * @param {string} [opts.tlsFingerprint=''] 固定证书 sha256（十六进制，不含冒号，大小写不敏感）
 * @param {number} [opts.connectTimeoutMs=8000]
 * @param {object} [opts.log=console]
 * @param {Function|null} [opts.connect=null] 测试注入：返回 Duplex
 * @param {Function|undefined} [opts.checkServerIdentity] 只在有 ca 锚点时被忽略；云端不传就用 Node 默认（只给测试注入）
 * @param {boolean} [opts.allowInsecureCredentialsForTest=false] 只给测试：允许不校验还带凭据
 * @param {boolean} [opts.tls=true] false 时用 net.connect（只给测试用）
 */
export function createMqttClient(opts = {}) {
  const host = String(opts.host || '')
  const port = Number(opts.port) || 8883
  const username = opts.username
  const password = opts.password
  const clientId = opts.clientId || 'aurabot_' + randomBytes(6).toString('hex')
  const keepalive = Number.isFinite(Number(opts.keepalive)) ? Number(opts.keepalive) : 60
  // 有 ca 锚点就必须校验（这是自签名场景下真正安全的做法）；不校验的连接只允许用来读证书
  const caList = (Array.isArray(opts.ca) ? opts.ca : opts.ca ? [opts.ca] : []).map((x) => String(x || '')).filter(Boolean)
  const learnedCa = caList.length > 0
  const rejectUnauthorized = learnedCa ? true : opts.rejectUnauthorized === true
  const pinned = String(opts.tlsFingerprint || '').replace(/:/g, '').toLowerCase()
  // 只有上层明确说要「学证书」时才走 learnOnly；默认行为保持原样（云端仍用系统 CA）
  const learnOnly = opts.learnOnly === true
  const connectTimeoutMs = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : 8000
  const log = opts.log || console
  const injected = typeof opts.connect === 'function' ? opts.connect : null
  const useTls = opts.tls !== false
  // 只给测试用：允许「不校验 TLS 还带凭据」的连接。生产路径永远不会打开它。
  const allowInsecureForTest = opts.allowInsecureCredentialsForTest === true
  const hasCredentials = (username !== undefined && username !== null && username !== '') ||
    (password !== undefined && password !== null && password !== '')
  // fail-closed：即使用注入的 connect（测试桩），只要「不校验 + 带凭据」就一个字节都不发。
  // 例外：pinned（已固定证书指纹）时身份在写 CONNECT 之前就已核对过（不匹配直接断），
  // 所以那也属于「有锚点」，放行但仍然是 fail-closed 的。
  const credentialsGateError = !learnOnly && hasCredentials && !learnedCa && !pinned &&
    rejectUnauthorized !== true && !allowInsecureForTest
    ? Object.assign(
      new Error('拒绝在未校验 TLS 的连接上发送凭据：请先固定证书锚点，或明确开启校验'),
      { code: 'INSECURE_CREDENTIALS' },
    )
    : null
  if (credentialsGateError) debug('[mqtt] 已拒绝：不校验 TLS 却要发送凭据，未建立任何连接')

  const emitter = new EventEmitter()
  const state = {
    socket: null,
    buffer: Buffer.alloc(0),
    connected: false,
    handshake: null,
    pending: new Set(),
    pingTimer: null,
    packetId: 0,
    closing: false,
    closeEmitted: false,
  }

  function debug(...args) {
    try {
      log.debug?.(...args)
    } catch {
      /* 日志失败不影响协议 */
    }
  }

  /** 一次连接生命周期只发一次 close，避免上层重复触发重连 */
  function emitClose(err) {
    if (state.closeEmitted) return
    state.closeEmitted = true
    emitter.emit('close', err)
  }

  function emitError(err) {
    if (emitter.listenerCount('error') > 0) emitter.emit('error', err)
    else debug('[mqtt] ' + (err && err.message ? err.message : String(err)))
  }

  function isOpen() {
    const s = state.socket
    return Boolean(state.connected && s && !s.destroyed && !state.closing)
  }

  function nextPacketId() {
    state.packetId = (state.packetId % 65535) + 1
    return state.packetId
  }

  function failAll(err) {
    const pending = [...state.pending]
    state.pending.clear()
    for (const entry of pending) {
      try {
        entry.reject(err)
      } catch {
        /* ignore */
      }
    }
    const handshake = state.handshake
    if (handshake) {
      state.handshake = null
      handshake(err)
    }
  }

  function stopPing() {
    if (state.pingTimer) {
      clearInterval(state.pingTimer)
      state.pingTimer = null
    }
  }

  function startPing() {
    stopPing()
    if (!(keepalive > 0)) return
    const every = Math.max(1, Math.floor(keepalive / 2)) * 1000
    const timer = setInterval(() => {
      if (!isOpen()) return
      try {
        state.socket.write(encodePingreq())
      } catch (err) {
        emitError(err)
      }
    }, every)
    if (typeof timer.unref === 'function') timer.unref()
    state.pingTimer = timer
  }

  function teardown(err) {
    stopPing()
    state.connected = false
    const socket = state.socket
    state.socket = null
    state.buffer = Buffer.alloc(0)
    if (socket && !socket.destroyed) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    if (err) failAll(err)
  }

  function fatal(message) {
    const err = message instanceof Error ? message : Object.assign(new Error(message), { code: 'MQTT_PROTOCOL' })
    emitError(err)
    teardown(err)
    emitClose(err)
  }

  function handlePacket(pkt) {
    if (pkt.type === PACKET.CONNACK) {
      const connack = decodeConnack(pkt.body)
      const handshake = state.handshake
      state.handshake = null
      if (!connack) {
        const err = Object.assign(new Error('MQTT CONNACK 报文无效'), { code: 'BAD_CONNACK' })
        if (handshake) handshake(err)
        fatal(err)
        return
      }
      if (connack.returnCode !== 0) {
        const err = Object.assign(
          new Error('MQTT 连接被拒绝：' + connackText(connack.returnCode) + '（返回码 ' + connack.returnCode + '）'),
          { code: 'CONNACK_REFUSED', returnCode: connack.returnCode },
        )
        if (handshake) handshake(err)
        teardown(err)
        emitClose(err)
        return
      }
      state.connected = true
      startPing()
      debug('[mqtt] 已连接 ' + host + ':' + port)
      if (handshake) handshake(null)
      emitter.emit('connect')
      return
    }
    if (pkt.type === PACKET.PUBLISH) {
      const qos = (pkt.flags >> 1) & 0x03
      const parsed = parsePublish(pkt.body, qos)
      if (qos === 1 && parsed.packetId) {
        try {
          state.socket?.write(encodePuback(parsed.packetId))
        } catch {
          /* ignore */
        }
      }
      emitter.emit('message', parsed.topic, parsed.payload)
      return
    }
    if (pkt.type === PACKET.SUBACK) {
      const body = pkt.body
      const packetId = body.length >= 2 ? body.readUInt16BE(0) : 0
      const codes = [...body.subarray(2)]
      emitter.emit('suback', packetId, codes)
      return
    }
    if (pkt.type === PACKET.PUBACK) {
      emitter.emit('puback', pkt.body.length >= 2 ? pkt.body.readUInt16BE(0) : 0)
      return
    }
    // PINGRESP 及其它报文直接忽略
  }

  function onData(chunk) {
    if (!chunk || chunk.length === 0) return
    state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : Buffer.from(chunk)
    if (state.buffer.length > MAX_PACKET_BYTES + 16) {
      fatal('MQTT 报文超过 4MB 上限（' + state.buffer.length + ' 字节）')
      return
    }
    while (state.buffer.length) {
      const rl = decodeRemainingLength(state.buffer, 1)
      if (!rl) {
        if (state.buffer.length >= 5) fatal('MQTT remaining length 非法')
        return
      }
      if (rl.length > MAX_PACKET_BYTES) {
        fatal('MQTT 报文超过 4MB 上限（' + rl.length + ' 字节）')
        return
      }
      const pkt = decodePacket(state.buffer)
      if (!pkt) return
      state.buffer = state.buffer.subarray(pkt.consumed)
      handlePacket(pkt)
      if (!state.socket) return
    }
  }

  function onSocketError(err) {
    const wrapped = err instanceof Error ? err : new Error(String(err))
    emitError(wrapped)
    teardown(wrapped)
    emitClose(wrapped)
  }

  function onSocketClose() {
    const wasConnected = state.connected
    stopPing()
    state.connected = false
    state.buffer = Buffer.alloc(0)
    const err = wasConnected ? null : Object.assign(new Error('MQTT 连接已断开'), { code: 'MQTT_CLOSED' })
    failAll(err || Object.assign(new Error('MQTT 连接已断开'), { code: 'MQTT_CLOSED' }))
    if (state.socket) state.socket = null
    emitClose(err)
  }

  function openSocket() {
    if (credentialsGateError) throw credentialsGateError
    if (injected) {
      const socket = injected({ host, port, tls: useTls, rejectUnauthorized })
      if (!socket || typeof socket.on !== 'function' || typeof socket.write !== 'function') {
        throw new Error('注入的 connect 没有返回可用 Duplex')
      }
      return socket
    }
    if (!host) throw new Error('缺少 MQTT 主机地址')
    if (useTls) {
      return tls.connect(tlsOptionsFor({
        host,
        port,
        rejectUnauthorized,
        ca: caList,
        checkServerIdentity: opts.checkServerIdentity,
      }))
    }
    return net.connect({ host, port })
  }

  function connect() {
    if (isOpen()) return Promise.resolve()
    if (credentialsGateError) return Promise.reject(credentialsGateError)
    state.closing = false
    state.closeEmitted = false
    return new Promise((resolve, reject) => {
      let done = false
      let socket
      // 不 unref：建连时若没有别的句柄撑着事件循环（注入的假 socket、或对端完全没响应），
      // Node 会在超时到点前直接退出，这个 Promise 永远不 settle（CI 上是 cancelledByParent）。
      // finish() 里会 clearTimeout，不会拖住进程。
      const timer = setTimeout(() => {
        if (done) return
        finish(Object.assign(new Error('MQTT 连接超时（' + connectTimeoutMs + 'ms）'), { code: 'TIMEOUT' }))
      }, connectTimeoutMs)

      function finish(err) {
        if (done) return
        done = true
        clearTimeout(timer)
        state.handshake = null
        if (err) {
          teardown(err)
          reject(err)
          return
        }
        resolve()
      }

      try {
        socket = openSocket()
      } catch (err) {
        finish(err)
        return
      }
      state.socket = socket
      state.buffer = Buffer.alloc(0)

      const ready = () => {
        if (done) return
        // 学证书模式：握手完成 → 把对端证书交出去 → 立刻断开，一个字节的 MQTT 都不发
        if (learnOnly) {
          const info = peerCertInfo(socket)
          if (!info) {
            finish(Object.assign(new Error('打印机没有出示 TLS 证书'), { code: 'TLS_NO_CERT' }))
            return
          }
          state.learned = info
          emitter.emit('peer-cert', info)
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
          finish(null)
          return
        }
        if (pinned) {
          const actual = fingerprintOf(socket)
          if (!actual) {
            finish(Object.assign(new Error('无法读取 TLS 证书指纹'), { code: 'TLS_FINGERPRINT_MISSING' }))
            return
          }
          if (actual !== pinned) {
            finish(Object.assign(new Error('TLS 证书指纹不匹配，已拒绝连接'), { code: 'TLS_FINGERPRINT_MISMATCH' }))
            return
          }
        }
        state.handshake = finish
        try {
          socket.write(
            encodeConnect({ clientId, username, password, keepalive }),
            (err) => {
              if (err) finish(err)
            },
          )
        } catch (err) {
          finish(err)
        }
      }

      let signalled = false
      const signalReady = () => {
        if (signalled) return
        signalled = true
        ready()
      }

      socket.on('data', onData)
      socket.on('error', onSocketError)
      socket.on('close', onSocketClose)
      if (injected) {
        socket.once('connect', signalReady)
        socket.once('secureConnect', signalReady)
        setImmediate(signalReady)
      } else if (useTls) {
        socket.once('secureConnect', signalReady)
      } else {
        socket.once('connect', signalReady)
      }
    })
  }

  /**
   * 订阅。写入成功即 resolve（SUBACK 通过 'suback' 事件异步通知），
   * 这样打印机偶尔不回 SUBACK 也不会让调用方卡住。
   */
  function subscribe(topic, qos = 0) {
    return new Promise((resolve, reject) => {
      if (!isOpen()) {
        reject(Object.assign(new Error('MQTT 未连接'), { code: 'MQTT_CLOSED' }))
        return
      }
      const packetId = nextPacketId()
      const entry = { reject }
      state.pending.add(entry)
      try {
        state.socket.write(encodeSubscribe(packetId, topic, qos), (err) => {
          state.pending.delete(entry)
          if (err) reject(err)
          else resolve({ ok: true, packetId })
        })
      } catch (err) {
        state.pending.delete(entry)
        reject(err)
      }
    })
  }

  function publish(topic, payload, options = {}) {
    return new Promise((resolve, reject) => {
      if (!isOpen()) {
        reject(Object.assign(new Error('MQTT 未连接'), { code: 'MQTT_CLOSED' }))
        return
      }
      const qos = options.qos === 1 ? 1 : 0
      const retain = options.retain === true
      const packetId = qos > 0 ? nextPacketId() : 0
      const entry = { reject }
      state.pending.add(entry)
      try {
        state.socket.write(encodePublish(topic, payload, { qos, packetId, retain }), (err) => {
          state.pending.delete(entry)
          if (err) reject(err)
          else resolve({ ok: true, packetId })
        })
      } catch (err) {
        state.pending.delete(entry)
        reject(err)
      }
    })
  }

  function close() {
    if (state.closing) return
    state.closing = true
    stopPing()
    const socket = state.socket
    state.socket = null
    state.connected = false
    state.buffer = Buffer.alloc(0)
    failAll(Object.assign(new Error('MQTT 连接已关闭'), { code: 'MQTT_CLOSED' }))
    if (socket && !socket.destroyed) {
      try {
        socket.write(encodeDisconnect())
      } catch {
        /* ignore */
      }
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    emitClose(null)
  }

  emitter.connect = connect
  emitter.subscribe = subscribe
  emitter.publish = publish
  emitter.close = close
  emitter.isOpen = isOpen
  emitter.host = host
  emitter.port = port
  emitter.keepalive = keepalive
  return emitter
}
