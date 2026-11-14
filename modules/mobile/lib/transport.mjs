import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createHash } from 'node:crypto'
import { failure } from './auth.mjs'

export async function readRequest(req, maxBytes) {
  const size = Number(req.headers['content-length'])
  if (Number.isFinite(size) && size > maxBytes) throw failure(413, 'too_large', '请求太大')
  const chunks = []; let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw failure(413, 'too_large', '请求太大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
export async function jsonBody(req, maxBytes = 8192) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'content_type', '需要 application/json')
  try {
    const value = JSON.parse((await readRequest(req, maxBytes)).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch (error) { if (error.status) throw error; throw failure(400, 'invalid_json', 'JSON 不合法') }
}
export async function sendBody(req) {
  const type = req.headers['content-type'] || ''
  if (/^application\/json(?:;|$)/i.test(type)) return jsonBody(req, 64 * 1024)
  if (!/^multipart\/form-data;/i.test(type)) throw failure(415, 'content_type', '需要 JSON 或 multipart/form-data')
  const raw = await readRequest(req, 12 * 1024 * 1024)
  let form
  try { form = await new Response(raw, { headers: { 'content-type': type } }).formData() } catch { throw failure(400, 'invalid_multipart', 'multipart 不合法') }
  const entries = [...form.entries()]
  if (entries.length > 6 || new Set(entries.map(([k]) => k)).size !== entries.length) throw failure(400, 'invalid_multipart', '上传字段重复或过多')
  const value = {}
  for (const key of ['botId', 'kind', 'durationMs', 'dir']) {
    const part = form.get(key)
    if (part != null && (typeof part !== 'string' || part.length > 1024)) throw failure(400, 'invalid_field', '上传字段不合法')
    if (part != null) value[key] = part
  }
  const file = form.get('file')
  if (!file || typeof file.arrayBuffer !== 'function') throw failure(400, 'missing_file', '缺少 file 文件')
  if (!file.size || file.size > 10 * 1024 * 1024) throw failure(413, 'too_large', '文件为空或超过 10MB')
  value.bytes = Buffer.from(await file.arrayBuffer())
  return value // dir and the supplied filename never become a filesystem path
}
export function respond(res, status, body, type = 'application/json; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" })
  res.end(payload)
}
const errorBody = (error) => ({ ok: false, error: error.status ? error.code : 'internal_error', message: error.status ? error.message : '电脑端处理失败，请查看日志' })
function frame(op, payload = Buffer.alloc(0)) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const h = payload.length < 126 ? Buffer.from([0x80 | op, payload.length]) : Buffer.from([0x80 | op, 126, payload.length >>> 8, payload.length & 255])
  return Buffer.concat([h, payload])
}

// A push-only RFC 6455 endpoint: no extensions or incoming application messages.
// It accepts masked close/ping/pong control frames, including split/coalesced TCP reads.
export function createTransport({ tls, handle, authorize, replay, permitted, onError = () => {} }) {
  const peers = new Set()
  const server = tls ? httpsServer(tls) : httpServer()
  let closed = false
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 50
  server.on('request', (req, res) => {
    Promise.resolve().then(() => handle(req)).then((r) => respond(res, r.status || 200, r.body, r.type)).catch((error) => {
      if (!error.status) onError(error)
      respond(res, error.status || 500, errorBody(error))
    })
  })
  const drop = (peer, code = 1008) => {
    peers.delete(peer)
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code)
    if (!peer.socket.destroyed) { peer.socket.end(frame(8, payload)); const t = setTimeout(() => peer.socket.destroy(), 500); t.unref() }
  }
  function write(peer, event) {
    if (!permitted(peer)) { drop(peer, 4401); return }
    if (peer.socket.writableLength > 1024 * 1024) { drop(peer, 1013); return }
    const payload = Buffer.from(JSON.stringify(event))
    if (payload.length > 65535) return
    peer.socket.write(frame(1, payload))
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    try {
      const device = authorize(req)
      const key = String(req.headers['sec-websocket-key'] || '')
      if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !String(req.headers.connection).toLowerCase().split(/\s*,\s*/).includes('upgrade') || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) throw failure(400, 'bad_upgrade', 'WebSocket 握手不合法')
      if (peers.size >= 32 || [...peers].filter((p) => p.device.id === device.id).length >= 4) throw failure(429, 'connection_limit', '事件连接过多')
      const backlog = replay() // Prepare before writing 101; errors must remain HTTP errors.
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
      const protocol = protocols.includes('aurabot') || protocols.some((s) => s.startsWith('aurabot.')) ? 'Sec-WebSocket-Protocol: aurabot\r\n' : ''
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol}\r\n`)
      const peer = { socket, device, req, alive: true, buffer: Buffer.alloc(0) }
      peers.add(peer); socket.setTimeout(0); socket.setNoDelay(true)
      socket.on('close', () => peers.delete(peer))
      const receive = (chunk) => {
        peer.buffer = Buffer.concat([peer.buffer, chunk])
        if (peer.buffer.length > 4096) { drop(peer, 1009); return }
        while (peer.buffer.length >= 2) {
          const b = peer.buffer, op = b[0] & 15, len = b[1] & 127
          if ((b[0] & 0xf0) !== 0x80 || !(b[1] & 128) || len > 125 || ![8, 9, 10].includes(op)) { drop(peer, 1002); return }
          if (b.length < 6 + len) return
          const payload = Buffer.from(b.subarray(6, 6 + len))
          for (let i = 0; i < len; i++) payload[i] ^= b[2 + i % 4]
          peer.buffer = b.subarray(6 + len)
          if (op === 8) { drop(peer, 1000); return }
          if (op === 9) socket.write(frame(10, payload))
          if (op === 10) peer.alive = true
        }
      }
      socket.on('data', receive)
      if (head.length) receive(head)
      for (const event of backlog) { if (!peers.has(peer)) break; write(peer, event) }
    } catch (error) {
      const status = error.status || 500
      const body = JSON.stringify(errorBody(error))
      socket.end(`HTTP/1.1 ${status} Error\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }
  })
  const timer = setInterval(() => {
    for (const p of peers) {
      if (!permitted(p)) { drop(p, 4401); continue }
      if (!p.alive) { drop(p); continue }
      p.alive = false; p.socket.write(frame(9))
    }
  }, 15_000)
  timer.unref()
  return {
    server,
    publish(event, exceptDevice) { for (const p of peers) if (p.device.id !== exceptDevice) write(p, event) },
    recheck() { for (const p of peers) if (!permitted(p)) drop(p, 4401) },
    close() {
      if (closed) return Promise.resolve()
      closed = true; clearInterval(timer)
      for (const p of peers) { p.socket.destroy(); peers.delete(p) }
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    },
  }
}
