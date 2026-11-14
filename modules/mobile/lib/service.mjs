import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createSecureContext } from 'node:tls'
import { networkInterfaces } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { createAuth, failure, isLan, networkAllowed } from './auth.mjs'
import { createTransport, jsonBody, sendBody } from './transport.mjs'
import { qrSvg } from './qr.mjs'
import { voiceWav, audioFormat } from './audio.mjs'

export const botIdOf = (chatId) => 'c_' + Buffer.from(chatId).toString('base64url')
const DEFAULTS = { enabled: false, port: 32180, remoteAccess: false, publicUrl: '', tlsCert: '', tlsKey: '' }
// Only expose a port, never the TTS URL (which may contain credentials).
export function mobileTtsPort(config) {
  const v = config.voice || {}
  if (v.enabled === false) return null
  const address = { cosyvoice: v.cosyvoice?.url, gptsovits: v.gptsovits?.url, http: v.http?.urlTemplate }[v.engine]
  if (!address) return null
  try {
    const u = new URL(address)
    return ['http:', 'https:'].includes(u.protocol) ? Number(u.port || (u.protocol === 'https:' ? 443 : 80)) : null
  } catch { return null }
}
export function mobileUploadDir(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || value.length > 160 || !value.split('/').every((p) => /^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,63}$/u.test(p) && !p.endsWith('.') && !p.endsWith(' ') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw failure(400, 'invalid_upload_dir', '上传目录请填 downloads 下的相对文件夹，例如 phone/images；不能包含盘符、反斜杠或 ..')
  }
  return value
}
function tlsOptions(options) {
  if (!options.tlsCert && !options.tlsKey) return undefined
  if (!options.tlsCert || !options.tlsKey) throw failure(400, 'tls_incomplete', 'TLS 证书和私钥需要同时配置')
  try {
    const tls = { cert: readFileSync(options.tlsCert), key: readFileSync(options.tlsKey), minVersion: 'TLSv1.2' }
    createSecureContext(tls)
    return tls
  } catch { throw failure(400, 'invalid_tls', '无法读取或使用证书和私钥，请检查路径、PEM 格式与证书是否匹配') }
}
export function createMobileService({ hub, media, version, config, use, dir, log = {}, now = Date.now }) {
  const file = join(dir, 'devices.json')
  const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {} // corrupt credentials must fail closed
  const state = { ownerQQ: stored.ownerQQ || '', options: { ...DEFAULTS, ...stored.options }, devices: Array.isArray(stored.devices) ? stored.devices : [] }
  const save = () => {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  }
  const auth = createAuth({ state, save, now })
  const mimeOf = (bytes) => media.mimeOf(bytes)
  // Cache the page and generated PWA assets once per service instance.
  const web = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: readFileSync(new URL('../assets/web/index.html', import.meta.url)) }],
    ['/mobile.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('../assets/web/mobile.js', import.meta.url)) }],
    ['/sw.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('../assets/web/sw.js', import.meta.url)) }],
    ['/manifest.webmanifest', { type: 'application/manifest+json; charset=utf-8', body: JSON.stringify({ name: 'Aurabot', short_name: 'Aurabot', display: 'standalone', start_url: '/', theme_color: '#e86f4c', background_color: '#f6f4f1', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }) }],
    ['/icon.svg', { type: 'image/svg+xml; charset=utf-8', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="brand" x2="1" y2="1"><stop stop-color="#e86f4c"/><stop offset="1" stop-color="#f3b07c"/></linearGradient></defs><rect width="64" height="64" rx="20" fill="url(#brand)"/><svg x="15" y="15" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M4 12c3-5 13-5 16 0-3 5-13 5-16 0Z"/><circle cx="15" cy="11.5" r="1.2" fill="white"/></svg></svg>' }],
  ])
  let transport = null, starting = null, disposed = false, lastError = ''
  const inflight = new Set()
  function identity() {
    const owner = String(config().ownerQQ || '')
    if (owner !== state.ownerQQ) {
      state.ownerQQ = owner; state.devices = []; auth.clear(); save(); transport?.recheck()
    }
  }
  function chats() {
    return Object.entries(hub.sessions()).filter(([id, value]) => /^(private|group):\d+$/.test(id) && value?.sessionId)
  }
  function target(botId) {
    const found = chats().find(([id]) => botIdOf(id) === botId)
    if (!found) throw failure(404, 'chat_not_found', '会话不存在，请刷新聊天列表')
    return found
  }
  function visibleRow(row) {
    const text = String(row.text || '').trim()
    return !row.forgottenAt && !['seen', 'memory', 'system'].includes(row.kind) && !['系统', 'system'].includes(row.who) && Boolean(text) &&
      !/^(?:【(?:系统|记忆)|（(?:你记得这些事|这个聊天里之前的原话|以下只是印象|这个群的印象|你对.{0,30}的印象|和.{0,30}相处的经验|说话方式：|你最近做过的事|刚才聊到的|下面是你最近在几个群里))/.test(text)
  }
  function history() {
    const days = hub.chatLogDays().slice(-7)
    return days.flatMap((day) => hub.chatLogOf(day).slice(-2000)).filter(visibleRow).sort((a, b) => a.t - b.t).slice(-2000)
  }
  function eventOf(row) {
    const text = String(row.text || '')
    const label = text.match(/^\[表情(?:[：:]([^\]]+))?\](?:\s*(.+))?$/)
    const name = (label?.[1] || label?.[2] || '').trim()
    const items = name ? (use('stickers')?.library?.().items || []) : []
    const matches = items.filter((i) => i.name === name || i.md5 === name || (name.length === 8 && i.md5?.startsWith(name)))
    const url = matches.length === 1 ? '/api/mobile/sticker/' + encodeURIComponent(matches[0].md5) : null
    // Journals keep media placeholders, not original image/audio bytes or paths.
    // Only restore media that can be resolved through an existing protected route.
    return { type: 'message', id: createHash('sha256').update(JSON.stringify([row.t, row.chatId, row.uid, row.who, row.text])).digest('hex').slice(0, 24), botId: botIdOf(row.chatId), kind: url ? 'sticker' : 'text', text, imageUrl: url, url, durationMs: 0, mine: row.who !== 'bot' && Boolean(row.uid && String(row.uid) === String(config().ownerQQ)), at: Number.isFinite(Number(row.t)) ? Number(row.t) : now() }
  }
  function journal(row) {
    if (!transport || !visibleRow(row) || !chats().some(([id]) => id === row.chatId)) return
    transport.publish(eventOf(row), row.via === 'mobile' ? row.originId : undefined)
  }
  function checkAccess(req) {
    identity()
    if (disposed || !state.options.enabled) throw failure(503, 'mobile_disabled', '手机端已关闭')
    if (!networkAllowed(req, state.options.remoteAccess)) throw failure(403, 'remote_disabled', '默认只允许局域网；远程访问需主人在面板开启')
    const origin = req.headers.origin
    const expected = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`
    const publicOrigin = state.options.remoteAccess && state.options.publicUrl ? new URL(state.options.publicUrl).origin : ''
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expected && origin !== publicOrigin)) throw failure(403, 'browser_rejected', '手机接口不接受浏览器跨站请求')
  }
  function authorize(req, websocket = false) {
    checkAccess(req)
    const protocols = websocket ? String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()) : []
    const tokens = [req.headers['x-aurabot-token'], ...protocols.filter((s) => s.startsWith('aurabot.')).map((s) => s.slice(8))]
    for (const token of tokens) {
      try { return auth.authenticate(token) } catch (error) { if (error.status !== 401) throw error }
    }
    throw failure(401, 'unauthorized', '请重新扫码配对')
  }
  function permitted(peer) {
    try { return authorize(peer.req, true).id === peer.device.id } catch { return false }
  }
  async function handle(req) {
    const url = new URL(req.url, 'http://mobile'), path = url.pathname, method = req.method
    if (web.has(path)) {
      checkAccess(req)
      if (method !== 'GET') throw failure(405, 'method_not_allowed', '请使用 GET')
      return web.get(path)
    }
    if (path === '/api/mobile/pair') {
      checkAccess(req)
      if (method !== 'POST') throw failure(405, 'method_not_allowed', '请使用 POST')
      if (!config().ownerQQ) throw failure(503, 'not_ready', '请先设置主人 QQ')
      auth.limit('pair-body:' + req.socket.remoteAddress, 20)
      const body = await jsonBody(req)
      if (!networkAllowed(req, state.options.remoteAccess)) throw failure(403, 'remote_disabled', '远程访问已关闭')
      return { body: auth.pair(body.code, req.socket.remoteAddress) }
    }
    const device = authorize(req)
    if (path === '/api/mobile/logout') {
      if (method !== 'POST') throw failure(405, 'method_not_allowed', '请使用 POST')
      auth.revoke(device.id); transport?.recheck()
      return { body: { ok: true } }
    }
    if (path === '/api/mobile/send') {
      if (!config().enabled || !config().ownerQQ) throw failure(503, 'not_ready', '请先启用 Aurabot 并配置主人 QQ')
      if (method !== 'POST') throw failure(405, 'method_not_allowed', '请使用 POST')
      auth.limit('send:' + device.id, 30)
      if (inflight.has(device.id) || inflight.size >= 4) throw failure(429, 'send_busy', '上一条消息还在处理，请稍后重试')
      inflight.add(device.id)
      try {
        const body = await sendBody(req)
        authorize(req)
        const [chatId] = target(body.botId)
        const kind = body.kind
        const uploadDir = mobileUploadDir(body.dir)
        let text = '', image, voice
        if (kind === 'text') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) throw failure(400, 'invalid_text', '文字为空或过长')
          text = body.text
        } else if (kind === 'sticker') {
          if (typeof body.sticker !== 'string') throw failure(400, 'invalid_sticker', '缺少表情名字')
          const items = use('stickers')?.library?.().items || []
          const item = items.find((i) => (i.name || i.md5) === body.sticker)
          if (!item) throw failure(404, 'sticker_not_found', '原表情库中没有这张表情')
          const picture = media.sticker(item.md5)
          if (!picture) throw failure(404, 'sticker_not_found', '原表情文件不存在')
          image = picture.bytes; text = `[表情：${item.name || item.md5}]`
        } else if (kind === 'image' || kind === 'voice') {
          if (!Buffer.isBuffer(body.bytes)) throw failure(400, 'missing_file', '请用 multipart 上传 file')
          if (kind === 'image') image = body.bytes
          else {
            const duration = Number(body.durationMs)
            if (!Number.isInteger(duration) || duration < 0 || duration > 120000) throw failure(400, 'invalid_duration', '语音最长 120 秒')
            voice = body.bytes
          }
        } else throw failure(400, 'invalid_kind', '不支持这种消息类型')
        if (image && !mimeOf(image).startsWith('image/')) throw failure(415, 'invalid_image', '无法读取这张图片')
        authorize(req)
        if (body.bytes) {
          // Directory names are relative to this module's downloads; filenames are generated.
          const downloads = join(dir, 'downloads', uploadDir)
          mkdirSync(downloads, { recursive: true })
          const extension = image ? ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeOf(image)] || 'img') : voice.subarray(0, 4).toString() === 'RIFF' ? 'wav' : ({ mov: 'm4a', matroska: 'webm', ogg: 'ogg' })[audioFormat(voice)]
          writeFileSync(join(downloads, `${now()}-${randomBytes(8).toString('hex')}.${extension}`), body.bytes, { flag: 'wx', mode: 0o600 })
        }
        // App 的 readTimeout 只有 20 秒；转换/识别及入队异步完成，立即返回 202。
        // 只保留至多 4 个在途输入；失败通过现有事件连接明确告知，不自动重发。
        const jobRequest = { headers: { ...req.headers }, socket: { remoteAddress: req.socket.remoteAddress, encrypted: req.socket.encrypted } }
        Promise.resolve().then(async () => {
          let wav
          if (voice) {
            const uploads = join(dir, 'uploads'); mkdirSync(uploads, { recursive: true })
            wav = await voiceWav(voice, media, uploads)
          }
          authorize(jobRequest)
          await hub.receiveOwnerMessage(chatId, { text, image, wav, via: 'mobile', originId: device.id, assertAuthorized: () => authorize(jobRequest) })
        }).catch((error) => {
          log.warn?.('手机消息处理失败：', error.message)
          transport?.publish({ ...eventOf({ chatId, t: now(), text: '手机消息发送失败：' + (error.status ? error.message : '电脑端处理失败，请查看日志') }), kind: 'system' })
        }).finally(() => inflight.delete(device.id))
        return { status: 202, body: { ok: true } }
      } catch (error) { inflight.delete(device.id); throw error }
    }
    if (method !== 'GET') throw failure(405, 'method_not_allowed', '请使用 GET')
    if (path === '/api/mobile/messages') {
      const [chatId] = target(url.searchParams.get('botId'))
      const value = url.searchParams.get('before')
      const before = value === null ? Infinity : Number(value)
      if (value !== null && (!value.trim() || !Number.isSafeInteger(before) || before < 0)) throw failure(400, 'invalid_before', 'before 需要毫秒时间戳')
      // Read every log day: recent replay limits must not truncate older pages.
      const rows = hub.chatLogDays().flatMap((day) => hub.chatLogOf(day))
        .filter((row) => row.chatId === chatId && visibleRow(row) && Number.isFinite(Number(row.t)) && Number(row.t) < before)
        .sort((a, b) => a.t - b.t).slice(-30)
      return { body: { messages: rows.map(eventOf) } }
    }
    if (path === '/api/mobile/bots') {
      const rows = history(), latest = new Map()
      for (const r of rows) latest.set(r.chatId, r)
      return { body: { bots: chats().map(([id, s]) => {
        const last = latest.get(id), botId = botIdOf(id)
        const port = mobileTtsPort(config())
        return { id: botId, name: s.title || id, avatar: '/api/mobile/avatar/' + botId, ...(port ? { ttsPort: port } : {}), lastText: last ? String(last.text || '') : null, lastAt: last?.t ? new Date(last.t).toISOString() : null, unread: 0 }
      }) } }
    }
    if (path === '/api/mobile/sessions') return { body: { sessions: chats().map(([id, s]) => ({ id: s.sessionId, title: s.title || id, subtitle: id })) } }
    if (path === '/api/mobile/settings') return { body: { wakeWord: (config().group?.wakeWords || []).join('、'), ttsPort: mobileTtsPort(config()) ?? '未配置', version } }
    if (path === '/api/mobile/stickers') return { body: { stickers: (use('stickers')?.library?.().items || []).map((i) => ({ name: i.name || i.md5, url: '/api/mobile/sticker/' + encodeURIComponent(i.md5) })) } }
    if (path.startsWith('/api/mobile/sticker/')) {
      const md5 = decodeURIComponent(path.slice('/api/mobile/sticker/'.length))
      const picture = media.sticker(md5)
      if (!picture) throw failure(404, 'sticker_not_found', '表情不存在')
      return { body: picture.bytes, type: picture.type }
    }
    if (path.startsWith('/api/mobile/avatar/')) {
      target(decodeURIComponent(path.slice('/api/mobile/avatar/'.length)))
      const picture = media.avatar()
      if (!picture) throw failure(404, 'image_not_found', '图片不存在')
      return { body: picture.bytes, type: picture.type }
    }
    if (path === '/api/mobile/events') throw failure(426, 'upgrade_required', 'events 需要 WebSocket Upgrade')
    throw failure(404, 'not_found', '没有这个手机接口')
  }
  async function start() {
    if (disposed) throw failure(503, 'mobile_disabled', '模块已停止')
    if (transport) return
    if (starting) return starting
    starting = (async () => {
      const o = state.options
      const tls = tlsOptions(o)
      const next = createTransport({ tls, handle, authorize: (req) => {
        const d = authorize(req, true)
        if (new URL(req.url, 'http://mobile').pathname !== '/api/mobile/events') throw failure(404, 'not_found', '没有这个事件接口')
        return d
      }, replay: () => {
        const visible = new Set(chats().map(([id]) => id))
        return history().filter((r) => visible.has(r.chatId)).slice(-64).map((r) => eventOf(r))
      }, permitted, onError: (e) => log.warn?.('手机接口处理失败：', e.message) })
      try {
        await new Promise((resolve, reject) => {
          const failed = (e) => { next.server.off('listening', ready); reject(e) }
          const ready = () => { next.server.off('error', failed); resolve() }
          next.server.once('error', failed); next.server.once('listening', ready)
          next.server.listen(Number(o.port), '0.0.0.0')
        })
        next.server.on('error', (e) => { lastError = e.message; log.warn?.('手机端监听错误：', e.message) })
        if (disposed) { await next.close(); return }
        transport = next; lastError = ''
      } catch (error) { await next.close(); lastError = error.message; throw error }
    })()
    try { await starting } catch (error) { lastError = error.message; throw error } finally { starting = null }
  }
  async function stop() {
    if (starting) await starting.catch(() => {})
    const old = transport; transport = null
    await old?.close()
  }
  function status() {
    identity()
    const scheme = state.options.tlsCert ? 'https' : 'http'
    // 多网卡时优先 Wi-Fi 和有线网卡；热点（192.168.137.x）、虚拟网卡、VPN 往后排，不然二维码可能指向手机连不到的地址
    const rank = (name, ip) => (/^192\.168\.137\./.test(ip) ? 3 : 0) + (/vethernet|vmware|virtualbox|hyper-v|wsl|docker|tailscale|zerotier|meta|clash|mihomo|tap|tun|wireguard|本地连接\*/i.test(name) ? 2 : 0) + (/wlan|wi-?fi|无线|以太网|ethernet|^en|^eth|^wl/i.test(name) ? -1 : 0)
    const addresses = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list || []).map((i) => ({ name, ...i })))
      .filter((i) => i.family === 'IPv4' && !i.internal && isLan(i.address))
      .sort((a, b) => rank(a.name, a.address) - rank(b.name, b.address))
      .map((i) => `${scheme}://${i.address}:${state.options.port}`)
    return { ok: true, running: Boolean(transport), error: lastError, options: { ...state.options }, addresses: [...new Set(addresses)], devices: state.devices.map(({ tokenHash, ...d }) => d), chats: chats().length }
  }
  async function issue() {
    identity()
    if (!config().ownerQQ) throw failure(503, 'not_ready', '请先在权限页配置主人 QQ')
    state.options.enabled = true; save()
    await start()
    const base = state.options.publicUrl || status().addresses[0]
    if (!base) throw failure(400, 'no_lan_address', '找不到局域网地址，请连接 Wi-Fi 或填写手机可达地址')
    const pair = auth.issue(), link = new URL('/', base)
    link.searchParams.set('code', pair.code)
    const payload = link.href
    const svg = qrSvg(payload)
    return { ok: true, ...pair, url: base, payload, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }
  }
  async function configure(body) {
    const next = { ...state.options }
    if (typeof body.remoteAccess === 'boolean') {
      if (body.remoteAccess && body.confirmRisk !== true) throw failure(400, 'risk_confirmation', '手机身份等同主人，开启远程须确认风险')
      next.remoteAccess = body.remoteAccess
    }
    if (body.port != null) {
      if (!Number.isInteger(Number(body.port)) || Number(body.port) < 1024 || Number(body.port) > 65535) throw failure(400, 'invalid_port', '端口范围 1024–65535')
      next.port = Number(body.port)
    }
    if (body.publicUrl != null) {
      const raw = String(body.publicUrl).trim().replace(/\/+$/, '')
      if (raw) {
        let u
        try { u = new URL(raw) } catch { throw failure(400, 'invalid_url', '请填写 http(s)://地址:端口') }
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw failure(400, 'invalid_url', '地址只能包含协议、主机和端口')
      }
      next.publicUrl = raw
    }
    for (const key of ['tlsCert', 'tlsKey']) if (body[key] != null) next[key] = String(body[key]).trim()
    if (next.remoteAccess && (!next.publicUrl.startsWith('https://'))) throw failure(400, 'https_required', '远程访问请填写可信 HTTPS 对外地址')
    // Validate before persisting or shutting down the working listener.
    tlsOptions(next)
    const restart = ['port', 'tlsCert', 'tlsKey'].some((key) => next[key] !== state.options[key]) || Boolean(next.tlsCert && body.tlsCert != null)
    state.options = next; auth.clear(); save(); transport?.recheck()
    if (restart) { await stop(); if (next.enabled) await start() }
    return status()
  }
  async function disable() { state.options.enabled = false; auth.clear(); save(); await stop(); return status() }
  return {
    status, issue, configure, disable, start, journal, identity, handle,
    enabled: () => state.options.enabled,
    revoke(id) { auth.revoke(String(id)); transport?.recheck(); return status() },
    async dispose() { disposed = true; auth.clear(); await stop() },
  }
}
