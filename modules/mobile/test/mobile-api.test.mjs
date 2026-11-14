// 从 feat/mobile-app 的 mobile-api.test.js 迁移：作为社区模块实际装载，管理路由走 /ext/mobile。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { createAuth, networkAllowed, isLan } from '../lib/auth.mjs'
import { botIdOf } from '../lib/service.mjs'
import { qrSvg } from '../lib/qr.mjs'
import { audioFormat } from '../lib/audio.mjs'
import { hostTest, createMobileService, createFakeDsh, startMockOneBot, buildWav, pluginSource, version, pause, until } from './helpers.mjs'

const OWNER = '10000001', BOT = '20000002', CHAT = `private:${OWNER}`
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
// Restart checks must reach the new listener, without reusing global fetch sockets.
function freshGetStatus(url, token) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { agent: false, headers: { 'X-Aurabot-Token': token } }, (res) => {
      res.on('error', reject); res.on('end', () => resolve(res.statusCode)); res.resume()
    })
    req.on('error', reject); req.end()
  })
}
// Real HTTP Upgrade with native App headers or browser subprotocol credentials.
function connectEvents(base, token, options = {}) {
  return new Promise((resolve, reject) => {
    const events = [], closeCodes = [], url = new URL(options.path || '/api/mobile/events', base)
    const req = httpRequest(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(token ? { 'X-Aurabot-Token': token } : {}), ...(options.protocols ? { 'Sec-WebSocket-Protocol': options.protocols.join(', ') } : {}), ...options.headers } })
    req.on('error', reject)
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, events, close() {} }) })
    req.on('upgrade', (res, socket, head) => {
      let buffer = Buffer.alloc(0)
      const closed = new Promise((r) => socket.once('close', r))
      socket.on('error', () => {})
      const read = (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 2) {
          const op = buffer[0] & 15; let len = buffer[1] & 127, start = 2
          if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); start = 4 }
          assert.notEqual(len, 127, '手机消息帧应有大小上限')
          if (buffer.length < start + len) return
          const payload = buffer.subarray(start, start + len)
          buffer = buffer.subarray(start + len)
          if (op === 1) events.push(JSON.parse(payload.toString()))
          if (op === 9) {
            const mask = Buffer.from([1, 2, 3, 4]), data = Buffer.from(payload)
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
            socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | data.length]), mask, data]))
          }
          if (op === 8) { if (payload.length >= 2) closeCodes.push(payload.readUInt16BE(0)); socket.end() }
        }
      }
      socket.on('data', read); if (head.length) read(head)
      resolve({ status: res.statusCode, protocol: res.headers['sec-websocket-protocol'], events, closeCodes, closed, close: () => socket.destroy() })
    })
    req.end()
  })
}

test('一次性配对：正确码、过期、重放、刷新、限流、撤销及落盘恢复', () => {
  let time = 100000, saves = 0
  const state = { devices: [] }, save = () => saves++
  const auth = createAuth({ state, save, now: () => time })
  const first = auth.issue()
  assert.match(first.code, /^[a-f0-9]{24}$/)
  assert.equal(first.expiresAt, time + 300000)
  assert.throws(() => auth.pair('wrong', '192.168.1.2'), { status: 403, code: 'pair_rejected' })
  const paired = auth.pair(first.code, '192.168.1.2')
  assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(state.devices.length, 1)
  assert.ok(!JSON.stringify(state).includes(paired.token))
  assert.throws(() => auth.pair(first.code, '192.168.1.2'), { status: 403 })
  for (const token of ['Bearer ' + paired.token, first.code, '']) assert.throws(() => auth.authenticate(token), { status: 401 })
  const restored = createAuth({ state: JSON.parse(JSON.stringify(state)), save, now: () => time })
  const device = restored.authenticate(paired.token)
  assert.equal(device.id, state.devices[0].id)
  restored.revoke(device.id)
  assert.throws(() => restored.authenticate(paired.token), { status: 401 })
  const expired = auth.issue(); time = expired.expiresAt
  assert.throws(() => auth.pair(expired.code, '192.168.1.3'), { status: 403 })
  const old = auth.issue(), current = auth.issue()
  assert.throws(() => auth.pair(old.code, '192.168.1.4'), { status: 403 })
  assert.ok(auth.pair(current.code, '192.168.1.4').token)
  for (let i = 0; i < 10; i++) assert.throws(() => auth.pair('bad', '192.168.1.99'), { status: 403 })
  assert.throws(() => auth.pair('bad', '192.168.1.99'), { status: 429 })
  assert.ok(saves >= 3)
})

test('远程默认关：实际 socket、IPv4/IPv6、伪造转发头、显式开启', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.5', '10.0.0.2', '172.16.2.3', '172.31.1.1', '192.168.0.1', 'fd12::1', 'fe80::1%eth0']) assert.ok(isLan(ip), ip)
  for (const ip of ['', '192.168.evil', '172.32.1.1', '8.8.8.8', '100.64.1.2', '2001:db8::1']) assert.equal(isLan(ip), false, ip)
  const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers })
  assert.equal(networkAllowed(req('203.0.113.8'), false), false)
  assert.equal(networkAllowed(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.2' }), false), false)
  assert.equal(networkAllowed(req('127.0.0.1', { forwarded: 'for=203.0.113.8' }), false), false)
  assert.equal(networkAllowed(req('203.0.113.8'), true), true)
})

hostTest('网页版静态资源与跨天历史：类型、安全头、网络边界、分页和聊天隔离', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mobile-web-'))
  const port = await freePort(), base = `http://127.0.0.1:${port}`
  const md5 = '1234567890abcdef1234567890abcdef'
  const rows = Array.from({ length: 65 }, (_, i) => ({ t: Date.UTC(2020, 0, 1 + Math.floor(i / 7), 12, 0, i % 7), chatId: CHAT, who: i % 2 ? 'bot' : '主人', uid: i % 2 ? BOT : OWNER, text: `历史 ${i + 1}` }))
  rows[60].text = '[表情：开心]'; rows[61].text = '[表情] ' + md5.slice(0, 8)
  rows[62].text = '[图片]'; rows[63].text = '[语音] 转写文字'; rows[64].text = '[表情：不存在]'
  rows[59].who = 'bot'; rows[59].uid = OWNER
  const other = 'group:555', hidden = 'private:99999999', at = rows.at(-1).t + 1
  const extra = [
    { t: at, chatId: other, who: 'bot', text: '其他聊天' },
    { t: at, chatId: hidden, who: 'bot', text: '没有会话的流水' },
    { t: at, chatId: CHAT, who: '主人', uid: OWNER, text: '已忘记', forgottenAt: at },
    { t: at, chatId: CHAT, who: '系统', text: '系统通知' },
    { t: at, chatId: CHAT, who: 'bot', text: '【系统】提醒' },
    { t: at, chatId: CHAT, who: 'bot', text: '（你记得这些事：不要展示）' },
    { t: at, chatId: CHAT, who: 'bot', kind: 'memory', text: '记忆提示' },
    { t: at, chatId: CHAT, who: 'bot', kind: 'seen', text: '看过的资料' },
  ]
  const byDay = new Map()
  for (const row of [...rows, ...extra]) {
    const day = new Date(row.t).toISOString().slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).unshift(row)
  }
  const hub = { sessions: () => ({ [CHAT]: { sessionId: 'own' }, [other]: { sessionId: 'group' } }), chatLogDays: () => [...byDay.keys()].sort(), chatLogOf: (day) => byDay.get(day) }
  const service = createMobileService({ hub, config: () => ({ ownerQQ: OWNER }), use: () => ({ library: () => ({ items: [{ md5, name: '开心' }] }) }), dir })
  try {
    await service.configure({ port, publicUrl: base })
    const pairing = await service.issue()
    assert.equal(pairing.payload, `${base}/?code=${pairing.code}`)
    const expectedCsp = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    for (const [path, type] of [['/', 'text/html'], ['/mobile.js', 'text/javascript'], ['/sw.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon.svg', 'image/svg+xml']]) {
      const res = await fetch(base + path)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type').split(';')[0], type)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('content-security-policy'), expectedCsp)
      const body = await res.text()
      if (path === '/') assert.equal(body, readFileSync(new URL('../assets/web/index.html', import.meta.url), 'utf8'))
      if (path === '/mobile.js' || path === '/sw.js') assert.equal(body, readFileSync(new URL('../assets/web' + path, import.meta.url), 'utf8'))
      if (path === '/manifest.webmanifest') assert.deepEqual(JSON.parse(body), { name: 'Aurabot', short_name: 'Aurabot', display: 'standalone', start_url: '/', theme_color: '#e86f4c', background_color: '#f6f4f1', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] })
      if (path === '/icon.svg') { assert.match(body, /<svg/); assert.match(body, /rx="20"/); assert.match(body, /#e86f4c/); assert.match(body, /#f3b07c/); assert.match(body, /M4 12c3-5 13-5 16 0-3 5-13 5-16 0Z/) }
      assert.equal((await fetch(base + path, { headers: { 'X-Forwarded-For': '203.0.113.8' } })).status, 403)
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 405)
      assert.equal((await fetch(base + path, { headers: { Origin: 'https://evil.example' } })).status, 403)
      await assert.rejects(service.handle({ url: path, method: 'GET', headers: { host: `127.0.0.1:${port}` }, socket: { remoteAddress: '203.0.113.8' } }), { status: 403 })
    }
    const pairRes = await fetch(base + '/api/mobile/pair', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) })
    assert.equal(pairRes.status, 200)
    const { token } = await pairRes.json()
    const get = (query, credential = token, headers = {}) => fetch(base + '/api/mobile/messages?' + query, { headers: { ...(credential ? { 'X-Aurabot-Token': credential } : {}), ...headers } })
    const query = 'botId=' + botIdOf(CHAT)
    assert.equal((await get(query, null)).status, 401); assert.equal((await get(query, 'wrong')).status, 401)
    assert.equal((await get(query + '&token=' + token, null)).status, 401)
    assert.equal((await get(query, null, { 'Sec-WebSocket-Protocol': 'aurabot, aurabot.' + token })).status, 401)
    assert.equal((await get('', token)).status, 404)
    for (const id of [hidden, 'system:owner', '../../devices.json']) assert.equal((await get('botId=' + botIdOf(id))).status, 404)
    assert.equal((await get('botId=private%3A' + OWNER)).status, 404)
    for (const before of ['', 'bad', '-1', '1.5', 'Infinity']) assert.equal((await get(query + '&before=' + before)).status, 400)
    const latest = await (await get(query)).json()
    assert.deepEqual(Object.keys(latest), ['messages']); assert.equal(latest.messages.length, 30)
    assert.deepEqual(latest.messages.map((m) => m.at), rows.slice(-30).map((r) => r.t))
    for (const m of latest.messages) {
      assert.deepEqual(Object.keys(m).sort(), ['type', 'id', 'botId', 'kind', 'text', 'imageUrl', 'url', 'durationMs', 'mine', 'at'].sort())
      assert.match(m.id, /^[a-f0-9]{24}$/); assert.equal(m.botId, botIdOf(CHAT)); assert.equal(m.type, 'message')
      assert.equal(typeof m.at, 'number'); assert.equal(typeof m.durationMs, 'number'); assert.equal(typeof m.text, 'string'); assert.equal(typeof m.mine, 'boolean')
      const row = rows.find((r) => r.t === m.at)
      assert.equal(m.mine, row.who !== 'bot' && row.uid === OWNER)
    }
    for (const index of [60, 61]) { const media = latest.messages.find((m) => m.at === rows[index].t); assert.equal(media.kind, 'sticker'); assert.equal(media.url, '/api/mobile/sticker/' + md5); assert.equal(media.imageUrl, media.url) }
    for (const index of [62, 63, 64]) { const fallback = latest.messages.find((m) => m.at === rows[index].t); assert.equal(fallback.kind, 'text'); assert.equal(fallback.url, null) }
    const earlier = (await (await get(query + '&before=' + latest.messages[0].at)).json()).messages
    assert.deepEqual(earlier.map((m) => m.at), rows.slice(5, 35).map((r) => r.t)); assert.ok(!earlier.some((m) => latest.messages.some((r) => r.id === m.id)))
    const oldest = (await (await get(query + '&before=' + earlier[0].at)).json()).messages
    assert.deepEqual(oldest.map((m) => m.at), rows.slice(0, 5).map((r) => r.t))
    assert.deepEqual((await (await get(query + '&before=' + rows[0].t)).json()).messages, [])
    assert.deepEqual((await (await get('botId=' + botIdOf(other))).json()).messages.map((m) => m.text), ['其他聊天'])
    const replay = await connectEvents(base, token)
    try {
      assert.equal(replay.status, 101); await until(() => replay.events.some((e) => e.at === rows[60].t))
      assert.deepEqual(replay.events.find((e) => e.at === rows[60].t), latest.messages.find((m) => m.at === rows[60].t))
      assert.ok(!replay.events.some((e) => ['系统通知', '已忘记', '记忆提示', '没有会话的流水'].includes(e.text)))
    } finally { replay.close() }
  } finally { await service.dispose(); rmSync(dir, { recursive: true, force: true }) }
})

hostTest('社区模块通过真实 HTTP/WS 进入原 hub 会话，面板可撤销', { timeout: 45000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mobile-'))
  process.env.AURABOT_DATA_DIR = dir; process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  const port = await freePort(), base = `http://127.0.0.1:${port}`
  const mock = await startMockOneBot({ selfId: BOT })
  const fake = createFakeDsh({ brain: async ({ text, images }) => images.length ? '手机图片看到了' : text.includes('手机') ? '手机消息收到了' : '原会话准备好了' })
  const sockets = []; let app, mobile
  const panel = (path, body, headers, socket) => fake.call('/ext/mobile/' + path, body, headers, socket)
  try {
    mkdirSync(join(dir, 'modules'), { recursive: true })
    cpSync(new URL('../', import.meta.url), join(dir, 'modules', 'mobile'), { recursive: true, filter: (src) => !/[\\/]test(?:[\\/]|$)/.test(String(src)) })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
      ownerName: '主人', allow: { private: [OWNER], groups: ['555'] },
      conversationContext: { enabled: true }, group: { wakeWords: ['大肥鱼', '肥鱼'] },
      voice: { enabled: false, asr: true, autoChance: 0 }, stickers: { autoChance: 0 },
      merge: { waitSec: 0.1, maxSec: 1 },
      snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dir, 'no-snowluma') },
    }))
    app = (await import(new URL('host.js', pluginSource))).apply(fake.ctx)
    await app.ready
    mobile = app.modules.use('mobile'); assert.ok(mobile, '社区模块必须实际注册')
    assert.equal(app.modules.running('mobile'), 'user')
    await fake.call('/onebot/reconnect'); await until(() => mock.connected() > 0)
    await app.hub.onMessage({ self_id: BOT, message_type: 'private', sub_type: 'friend', user_id: Number(OWNER), sender: { nickname: '主人' }, message_id: 101, message: [{ type: 'text', data: { text: '原会话准备' } }] })
    await until(() => fake.turns.length > 0)
    await until(() => app.hub.chatLogDays().some((day) => app.hub.chatLogOf(day).some((r) => r.who === 'bot')))
    const originalSession = app.hub.sessions()[CHAT].sessionId
    assert.equal((await panel('configure', { port, publicUrl: base })).status, 200)
    const pairing = (await panel('pairing', {})).json()
    assert.equal(pairing.ok, true); assert.equal(pairing.payload, `${base}/?code=${pairing.code}`)
    assert.ok(Buffer.from(pairing.qr.split(',')[1], 'base64').toString().startsWith('<svg'))
    const request = (path, token, body, extra = {}) => fetch(base + '/api/mobile/' + path, {
      method: body == null ? 'GET' : 'POST', headers: { ...(token ? { 'X-Aurabot-Token': token } : {}), ...(body != null && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body != null ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    })
    let token, token2
    await t.test('未授权、错误码与成功配对', async () => {
      for (const path of ['bots', 'messages?botId=' + botIdOf(CHAT), 'sessions', 'settings', 'stickers', 'avatar/' + botIdOf(CHAT), 'events', 'sticker/not-found']) assert.equal((await request(path)).status, 401, path)
      assert.equal((await request('send', undefined, { botId: botIdOf(CHAT), kind: 'text', text: '未授权' })).status, 401)
      assert.equal((await request('pair', null, { code: 'bad' })).status, 403); assert.equal((await request('pair', null, {})).status, 400)
      assert.equal((await request('pair', null, { code: pairing.code }, { origin: 'https://evil.example' })).status, 403)
      const paired = await request('pair', null, { code: pairing.code })
      assert.equal(paired.status, 200); token = (await paired.json()).token; assert.match(token, /^[A-Za-z0-9_-]{43}$/)
      assert.equal((await request('pair', null, { code: pairing.code })).status, 403)
      const second = (await panel('pairing', {})).json()
      token2 = (await (await request('pair', null, { code: second.code })).json()).token
      assert.notEqual(token2, token)
      assert.equal((await request('bots', 'wrong')).status, 401); assert.equal((await request('events', token)).status, 426)
      assert.equal((await request('unknown', token)).status, 404); assert.equal((await request('bots', token, {})).status, 405)
      assert.equal((await request('send', token, { botId: 'missing', kind: 'text', text: 'x' })).status, 404)
      assert.equal((await request('send', token, { botId: botIdOf(CHAT), kind: 'unknown' })).status, 400)
      assert.equal((await request('send', token, { botId: botIdOf(CHAT), kind: 'text', text: '' })).status, 400)
      assert.equal((await request('settings', token, {})).status, 405)
      assert.equal((await fetch(base + '/api/mobile/send', { method: 'POST', headers: { 'X-Aurabot-Token': token, 'Content-Type': 'application/json' }, body: '{broken' })).status, 400)
      assert.equal((await fetch(base + '/api/mobile/send', { method: 'POST', headers: { 'X-Aurabot-Token': token, 'Content-Type': 'text/plain' }, body: 'hello' })).status, 415)
      assert.equal((await connectEvents(base, null)).status, 401)
      const disk = readFileSync(join(dir, 'modules-data', 'mobile', 'devices.json'), 'utf8')
      assert.ok(!disk.includes(token) && !disk.includes(token2))
    })
    await t.test('JSON 模型字段、头像和原表情库', async () => {
      const bots = (await (await request('bots', token)).json()).bots, bot = bots.find((b) => b.id === botIdOf(CHAT))
      assert.ok(bot); assert.deepEqual(Object.keys(bot).sort(), ['id', 'name', 'avatar', 'lastText', 'lastAt', 'unread'].sort())
      assert.equal(typeof bot.lastAt, 'string'); assert.equal(typeof bot.unread, 'number')
      const sessions = (await (await request('sessions', token)).json()).sessions
      assert.deepEqual(sessions.find((s) => s.id === originalSession), { id: originalSession, title: app.hub.sessions()[CHAT].title, subtitle: CHAT })
      assert.deepEqual(await (await request('settings', token)).json(), { wakeWord: '大肥鱼、肥鱼', ttsPort: '未配置', version })
      const avatar = await request('avatar/' + botIdOf(CHAT), token)
      assert.equal(avatar.status, 200); assert.match(avatar.headers.get('content-type'), /^image\//); assert.ok((await avatar.arrayBuffer()).byteLength > 0)
      assert.equal((await request('avatar/no-such-bot', token)).status, 404)
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
      await app.stickers.addFromBuffer(png, { name: '手机表情', tags: ['开心'], from: 'test' })
      const st = (await (await request('stickers', token)).json()).stickers.find((s) => s.name === '手机表情')
      assert.ok(st); assert.deepEqual(Object.keys(st).sort(), ['name', 'url'])
      const image = await fetch(base + st.url, { headers: { 'X-Aurabot-Token': token } })
      assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /^image\//)
    })
    await t.test('WebSocket 回放、原会话消息、主人身份、回复推送与设备间同步', async () => {
      const first = await connectEvents(base, token), second = await connectEvents(base, token2)
      sockets.push(first, second); assert.equal(first.status, 101)
      await until(() => first.events.some((e) => e.text.includes('原会话')))
      const sent = await request('send', token, { botId: botIdOf(CHAT), kind: 'text', text: '手机发来一句话' }, { origin: base })
      assert.equal(sent.status, 202); assert.deepEqual(await sent.json(), { ok: true })
      const turn = await until(() => fake.turns.find((r) => r.userText.includes('手机发来一句话')))
      assert.equal(turn.sessionId, originalSession); assert.equal(turn.source.speaker.role, 'owner'); assert.equal(Object.keys(app.hub.sessions()).length, 1)
      assert.equal((await until(() => second.events.find((e) => e.text === '手机发来一句话'))).mine, true)
      assert.ok(!first.events.some((e) => e.text === '手机发来一句话'))
      const reply = await until(() => first.events.find((e) => e.text === '手机消息收到了'))
      assert.deepEqual(Object.keys(reply).sort(), ['type', 'id', 'botId', 'kind', 'text', 'imageUrl', 'url', 'durationMs', 'mine', 'at'].sort())
      assert.equal(reply.type, 'message'); assert.equal(reply.kind, 'text'); assert.equal(reply.mine, false); assert.equal(reply.botId, botIdOf(CHAT)); assert.equal(typeof reply.at, 'number')
      const journal = app.hub.chatLogDays().flatMap((d) => app.hub.chatLogOf(d)).find((r) => r.text === '手机发来一句话')
      assert.equal(journal.uid, OWNER); assert.equal(journal.via, 'mobile'); assert.ok(!('originId' in journal))
      assert.ok(app.hub.recentMessagesOf(CHAT).some((r) => r.text.includes('手机发来一句话')))
    })
    await t.test('浏览器子协议凭据、同源限制、错误凭据和 query token', async () => {
      const browser = await connectEvents(base, null, { protocols: ['aurabot', 'aurabot.' + token], headers: { Origin: base } })
      sockets.push(browser); assert.equal(browser.status, 101); assert.equal(browser.protocol, 'aurabot')
      await until(() => browser.events.some((e) => e.text.includes('原会话')))
      assert.equal((await connectEvents(base, null, { protocols: ['aurabot', 'aurabot.wrong'], headers: { Origin: base } })).status, 401)
      assert.equal((await connectEvents(base, null, { protocols: ['aurabot'] })).status, 401)
      assert.equal((await connectEvents(base, null, { path: '/api/mobile/events?token=' + token })).status, 401)
      assert.equal((await connectEvents(base, null, { path: '/api/mobile/events?token=' + token, protocols: ['aurabot', 'aurabot.wrong'] })).status, 401)
      assert.equal((await connectEvents(base, null, { protocols: ['aurabot', 'aurabot.' + token], headers: { Origin: 'https://evil.example' } })).status, 403)
      assert.equal((await request('bots', token, null, { origin: base })).status, 200)
      assert.equal((await request('bots', token, null, { origin: 'http://localhost:' + port })).status, 403)
      assert.equal((await request('bots', token, null, { 'sec-fetch-site': 'cross-site' })).status, 403)
      assert.equal((await request('bots?token=' + token)).status, 401)
    })
    await t.test('群聊选择对应原会话，主人身份仍保留群聊权限级别', async () => {
      await app.hub.pushToSession({ chatId: 'group:555', kind: 'group', groupId: '555', userId: OWNER }, [{ type: 'text', text: '群原会话准备' }], OWNER)
      const groupSession = app.hub.sessions()['group:555'].sessionId
      assert.equal((await request('send', token, { botId: botIdOf('group:555'), kind: 'text', text: '手机在群会话说话' })).status, 202)
      const turn = await until(() => fake.turns.find((r) => r.userText.includes('手机在群会话说话')))
      assert.equal(turn.sessionId, groupSession); assert.equal(turn.source.speaker.role, 'owner'); assert.equal(turn.source.speaker.chat, 'group'); assert.equal(turn.preset, 'aurabot-social')
      assert.equal(app.hub.sessions()[CHAT].sessionId, originalSession)
      await until(() => sockets[1].events.some((e) => e.botId === botIdOf('group:555') && e.text === '手机在群会话说话'))
    })
    await t.test('手机明确要求记住的事进入本体现有记忆库', async () => {
      assert.equal((await request('send', token, { botId: botIdOf(CHAT), kind: 'text', text: '记住：我喜欢手机海蓝色' })).status, 202)
      const memory = await until(() => app.memory.list('').find((m) => m.text.includes('手机海蓝色')))
      assert.equal(String(memory.about), OWNER)
      await until(() => fake.turns.some((r) => r.userText.includes('我喜欢手机海蓝色')))
      assert.deepEqual(readdirSync(join(dir, 'modules-data', 'mobile')).filter((f) => f.endsWith('.json')), ['devices.json'])
    })
    await t.test('multipart 图片/语音和表情进入原会话，上传 dir 限定在 downloads', async () => {
      const form = new FormData()
      form.set('botId', botIdOf(CHAT)); form.set('kind', 'image'); form.set('dir', '../../escape-mobile')
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
      form.set('file', new Blob([png], { type: 'image/*' }), '../../outside.jpg')
      const before = fake.turns.length
      assert.equal((await request('send', token, form)).status, 400)
      form.set('dir', 'phone/images'); assert.equal((await request('send', token, form)).status, 202)
      const uploaded = join(dir, 'modules-data', 'mobile', 'downloads', 'phone', 'images')
      assert.equal(readdirSync(uploaded).length, 1); assert.deepEqual(readFileSync(join(uploaded, readdirSync(uploaded)[0])), png)
      await until(() => fake.turns.length > before)
      assert.equal(fake.turns.at(-1).sessionId, originalSession); assert.equal(fake.turns.at(-1).images, 1)
      let audioSeen = false
      fake.ctx.services.speechToText = { resolve: ({ audio }) => { audioSeen = audio instanceof Uint8Array; return {} }, transcribe: async () => '手机语音内容' }
      const voice = new FormData(); voice.set('botId', botIdOf(CHAT)); voice.set('kind', 'voice'); voice.set('durationMs', '1000')
      voice.set('file', new Blob([buildWav(new Int16Array(16000), 16000)], { type: 'audio/*' }), 'voice.m4a')
      await until(() => sockets[0].events.some((e) => e.text === '手机图片看到了'))
      let result
      for (let i = 0; i < 20; i++) { result = await request('send', token, voice); if (result.status !== 429) break; await pause(20) }
      assert.equal(result.status, 202); await until(() => fake.turns.some((r) => r.userText.includes('手机语音内容'))); assert.ok(audioSeen)
      await pause(20)
      assert.equal((await request('send', token, { botId: botIdOf(CHAT), kind: 'sticker', sticker: '手机表情' })).status, 202)
      await until(() => fake.turns.some((r) => r.userText.includes('手机表情') && r.images === 1))
      assert.ok(!readdirSync(dir).includes('escape-mobile'))
      const noFile = new FormData(); noFile.set('botId', botIdOf(CHAT)); noFile.set('kind', 'image')
      await pause(20); assert.equal((await request('send', token, noFile)).status, 400)
      const huge = new FormData(); huge.set('botId', botIdOf(CHAT)); huge.set('kind', 'image'); huge.set('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]), 'big.jpg')
      assert.equal((await request('send', token, huge)).status, 413)
    })
    await t.test('语音识别期间撤销权限，不能把迟到输入交给模型', async () => {
      let release, entered
      const gate = new Promise((resolve) => { release = resolve }), waiting = new Promise((resolve) => { entered = resolve })
      fake.ctx.services.speechToText = { resolve: () => ({}), transcribe: () => { entered(); return gate } }
      let valid = true
      const pending = app.hub.receiveOwnerMessage(CHAT, { wav: buildWav(new Int16Array(160), 16000), via: 'mobile', assertAuthorized: () => { if (!valid) throw Object.assign(new Error('设备被撤销'), { status: 401 }) } })
      await waiting; valid = false; release('撤销后迟到的手机语音')
      await assert.rejects(pending, { status: 401 }); assert.ok(!fake.turns.some((r) => r.userText.includes('撤销后迟到')))
    })
    await t.test('设备主动退出配对只撤销自己，并立即关闭该设备事件连接', async () => {
      const pairing = (await panel('pairing', {})).json()
      const thirdToken = (await (await request('pair', null, { code: pairing.code })).json()).token
      const events = await connectEvents(base, thirdToken); sockets.push(events); assert.equal(events.status, 101)
      assert.equal((await request('logout', undefined, {})).status, 401); assert.equal((await request('logout', thirdToken)).status, 405)
      const response = await request('logout', thirdToken, {})
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true })
      await Promise.race([events.closed, pause(1500).then(() => { throw new Error('退出配对未断开 WS') })]); assert.ok(events.closeCodes.includes(4401))
      assert.equal((await request('bots', thirdToken)).status, 401); assert.equal((await request('bots', token)).status, 200); assert.equal((await request('bots', token2)).status, 200)
      assert.equal((await panel('status')).json().devices.length, 2)
    })
    await t.test('管理闸、远程确认、代理来源默认拒绝、撤销立即断 WS', async () => {
      assert.equal((await panel('status', undefined, {}, '203.0.113.5')).status, 403)
      assert.equal((await panel('pairing', {}, { host: 'evil.example' }, '127.0.0.1')).status, 403)
      assert.equal((await panel('pairing', {}, { origin: 'https://evil.example' }, '127.0.0.1')).status, 403)
      assert.equal((await request('bots', token, null, { 'x-forwarded-for': '203.0.113.5' })).status, 403)
      assert.equal((await panel('configure', { remoteAccess: true })).status, 400)
      assert.equal((await panel('configure', { remoteAccess: true, confirmRisk: true, publicUrl: 'https://mobile.example.com' })).status, 200)
      assert.equal((await request('bots', token, null, { 'x-forwarded-for': '203.0.113.5' })).status, 200)
      await panel('configure', { remoteAccess: false, publicUrl: base })
      const status = (await panel('status')).json()
      assert.equal(status.options.remoteAccess, false); assert.equal(status.devices.length, 2); assert.ok(!JSON.stringify(status).includes('tokenHash'))
      assert.equal((await panel('revoke', { id: status.devices[0].id })).status, 200)
      assert.equal((await request('bots', token)).status, 401)
      await Promise.race([sockets[0].closed, pause(1500).then(() => { throw new Error('撤销未断开事件连接') })])
      assert.equal((await request('bots', token2)).status, 200)
      await Promise.race([sockets[2].closed, pause(1500).then(() => { throw new Error('撤销未断开浏览器事件连接') })])
      assert.ok(sockets[0].closeCodes.includes(4401)); assert.ok(sockets[2].closeCodes.includes(4401))
    })
    await t.test('模块重启恢复设备凭据，换主人后 HTTP 和 WS 都撤销', async () => {
      await mobile.dispose()
      const restored = createMobileService({ hub: app.hub, config: app.getConfig, use: (id) => app.modules.use(id), dir: join(dir, 'modules-data', 'mobile') })
      mobile = restored; await restored.start()
      assert.equal(await freshGetStatus(base + '/api/mobile/bots', token2), 200)
      assert.equal(await freshGetStatus(base + '/api/mobile/bots', token), 401)
      const events = await connectEvents(base, token2); sockets.push(events); assert.equal(events.status, 101)
      app.setConfig({ ...app.getConfig(), ownerQQ: '10000009' })
      assert.equal(await freshGetStatus(base + '/api/mobile/bots', token2), 401)
      await Promise.race([events.closed, pause(1500).then(() => { throw new Error('换主人未断开事件连接') })])
      assert.equal(restored.status().devices.length, 0); await restored.disable(); assert.equal(restored.status().running, false)
    })
    await t.test('社区模块热重载保留网页目录与原始资源，卸载能释放监听', async () => {
      await mobile.dispose()
      await app.modules.reload('mobile')
      const module = app.modules.use('mobile'); assert.ok(module); assert.notEqual(module, mobile); mobile = module
      assert.equal(app.modules.running('mobile'), 'user')
      for (const file of ['index.html', 'mobile.js', 'sw.js']) assert.equal(readFileSync(join(dir, 'modules', 'mobile', 'assets', 'web', file), 'utf8'), readFileSync(new URL('../assets/web/' + file, import.meta.url), 'utf8'))
      assert.equal((await panel('status')).json().ok, true)
      await module.dispose(); assert.equal(module.status().running, false)
    })
  } finally {
    for (const socket of sockets) socket.close()
    await mobile?.dispose(); fake.dispose(); await mock.close(); await pause(50)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('手机录音按文件头选择 M4A、WebM 或 Ogg 解码，拒绝其他输入', () => {
  assert.equal(audioFormat(Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypM4A ')])), 'mov')
  assert.equal(audioFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80])), 'matroska'); assert.equal(audioFormat(Buffer.from('OggS\0\0')), 'ogg')
  for (const bytes of [Buffer.alloc(0), Buffer.from('https://example.com/audio'), Buffer.from('#EXTM3U\nhttp://example.com')]) assert.throws(() => audioFormat(bytes), { status: 400, code: 'invalid_audio' })
})

test('二维码在本地生成且地址有界，不加载第三方脚本', () => {
  const payload = 'http://192.168.1.10:32180/?code=0123456789abcdef01234567', svg = qrSvg(payload)
  assert.match(svg, /viewBox="0 0 49 49"/); assert.ok(!svg.includes('<script') && !svg.includes('href=')); assert.throws(() => qrSvg('x'.repeat(135)), /过长/)
  // Independently decode data and verify RS syndromes, not just SVG shape.
  const grid = Array.from({ length: 41 }, () => Array(41).fill(0))
  for (const hit of svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) grid[Number(hit[2]) - 4][Number(hit[1]) - 4] = 1
  const reserved = (x, y) => x === 6 || y === 6 || (x <= 8 && y <= 8) || (x >= 33 && y <= 8) || (x <= 8 && y >= 33) || (x >= 32 && x <= 36 && y >= 32 && y <= 36)
  const bits = []; let up = true
  for (let right = 40; right > 0; right -= 2) {
    if (right === 6) right--
    for (let row = 0; row < 41; row++) { const y = up ? 40 - row : row; for (const x of [right, right - 1]) if (!reserved(x, y)) bits.push(grid[y][x] ^ ((x + y) % 2 === 0 ? 1 : 0)) }
    up = !up
  }
  assert.equal(bits.length, 1383)
  const byte = (offset) => bits.slice(offset, offset + 8).reduce((n, b) => n * 2 + b, 0)
  const stream = Array.from({ length: 172 }, (_, i) => byte(i * 8)), blocks = [[], []]
  for (let i = 0; i < 136; i++) blocks[i % 2].push(stream[i])
  for (let i = 136; i < 172; i++) blocks[i % 2].push(stream[i])
  const exp = [], log = []; let power = 1
  for (let i = 0; i < 255; i++) { exp[i] = power; log[power] = i; power *= 2; if (power >= 256) power ^= 285 }
  const multiply = (a, b) => a && b ? exp[(log[a] + log[b]) % 255] : 0
  for (const block of blocks) for (let root = 0; root < 18; root++) assert.equal(block.reduce((value, coefficient) => multiply(value, exp[root]) ^ coefficient, 0), 0, 'QR Reed–Solomon syndrome')
  const data = [...blocks[0].slice(0, 68), ...blocks[1].slice(0, 68)]
  const dataBits = data.flatMap((n) => Array.from({ length: 8 }, (_, i) => (n >> (7 - i)) & 1))
  const number = (start, length) => dataBits.slice(start, start + length).reduce((v, b) => v * 2 + b, 0)
  assert.equal(number(0, 4), 4); assert.equal(number(4, 8), Buffer.byteLength(payload))
  assert.equal(Buffer.from(Array.from({ length: number(4, 8) }, (_, i) => number(12 + i * 8, 8))).toString('utf8'), payload)
  for (let x = 0; x < 7; x++) assert.equal(grid[0][x], 1)
})
