// lib/cloud.js —— 米家云客户端 v2（扫码登录 / RC4 加密请求 / passToken 续期 / 设备列表 / 开关指令）
// 来源：协议事实参考公开抓包笔记（https://imkero.net/posts/mihome-app-api/）与
//       Do1e/mijia-api（GPL-3.0，只作协议对照，未搬运其代码）与 micloud/miutils（MIT）；
//       全部为本模块独立 JS 实现，许可保持本模块原有 LICENSE 不受传染。
// 与 v1（miservice 明文通道）的关键差异：
//   登录：GET account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia →（code≠0 时）
//         用 location 的 query 拼 GET account.xiaomi.com/longPolling/loginUrl 拿二维码
//         →（米家 APP 扫码后）长轮询 lp 拿全票 → GET location 回调收 serviceToken。
//         全程无密码、无短信二次验证。
//   请求：POST https://api.mijia.tech/app<uri>，表单值整体 RC4 加密：
//         nonce = base64(8 随机字节 + 分钟级时间最少字节)；signed_nonce = base64(sha256(ssecurity‖nonce))
//         rc4_hash__/signature = base64(sha1("POST&<uri>&k=v…&signed_nonce"))；
//         应答可能是 JSON，也可能是 RC4（可再套 gzip）密文，都要接得住。
//   续期：令牌失效时用 passToken 静默换新（serviceLogin code=0 → GET location 回 'ok'），
//         续不动才要求重新扫码。
// 所有网络调用走注入的 fetch（生产=全局 fetch，测试=假 fetch），一律带超时。

import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { zhPropName, isCoreProp } from './parse.js'

const PASS_BASE = 'https://account.xiaomi.com/pass'
const QR_LOGIN_BASE = 'https://account.xiaomi.com/longPolling/loginUrl'
const API_BASE = 'https://api.mijia.tech/app'
const SPEC_BASE = 'https://miot-spec.org/miot-spec-v2'
// 控制指令最小间隔（毫秒）：防手滑连点触发风控
const CMD_GAP_MS = 1200
// 扫码长轮询：米家允许一次挂 120 秒，我们留点余量
const LP_TIMEOUT_MS = 125000

// ---- 基础密码学小件 ----

/** 16 位设备 id（字母数字混排，含 _-，照米家 PassportDeviceId 形态） */
function randomDeviceId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  let s = ''
  for (let i = 0; i < 16; i++) s += chars[randomBytes(1)[0] % chars.length]
  return s
}

function randomHex(len) {
  return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)
}

/** 仿 Android 米家 APP 的 UA（协议按这个识别通道；随机段模拟真机） */
function androidUa(cc = 'CN', passO = '') {
  const hex = (n) => randomHex(n).toUpperCase()
  return (
    `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${hex(40)}-${cc}-` +
    `${hex(32)}-${hex(32)}-SmartHome-MI_APP_STORE-${hex(40)}|${hex(40)}|${passO}-64`
  )
}

/** sign_nonce：base64( sha256( b64decode(ssecurity) ‖ b64decode(nonce) ) ) */
function signNonce(ssecurity, nonce) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64')]))
    .digest('base64')
}

/** nonce：base64( 8 随机字节 + 分钟级时间的最少大端字节 )；导出供测试断言形态 */
export function genNonce(ms = Date.now()) {
  const minutes = Math.floor(ms / 60000)
  const full = Buffer.alloc(8)
  full.writeBigUInt64BE(BigInt(minutes), 0)
  const bytes = Math.max(1, Math.ceil(minutes.toString(2).length / 8))
  return Buffer.concat([randomBytes(8), full.subarray(8 - bytes)]).toString('base64')
}

/** 加密签名：base64( sha1( [METHOD, uri, ...k=v, signed_nonce].join('&') ) ) */
function encSignature(method, uri, signedNonce, params) {
  const parts = [method.toUpperCase(), uri]
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`)
  parts.push(signedNonce)
  return createHash('sha1').update(parts.join('&'), 'utf8').digest('base64')
}

// ---- RC4（node:crypto 在 OpenSSL3 下不再提供 rc4，自实现；20 行老算法；导出供测试）----
export function rc4(keyBytes, payload) {
  // KSA
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  // PRGA（先丢 1024 字节再动真格——米家协议约定）
  let i = 0
  j = 0
  const out = Buffer.alloc(payload.length)
  const next = () => {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
    return s[(s[i] + s[j]) & 0xff]
  }
  for (let n = 0; n < 1024; n++) next()
  for (let n = 0; n < payload.length; n++) out[n] = payload[n] ^ next()
  return out
}

function rc4B64(keyB64, text) {
  return rc4(Buffer.from(keyB64, 'base64'), Buffer.from(text, 'utf8')).toString('base64')
}

/** 测试钩子：可注入 nonce 的加密表单组装（生产走下面 buildEncParams 的随机 nonce） */
export function encParamsWithNonce(uri, payload, ssecurity, nonce) {
  const snonce = signNonce(ssecurity, nonce)
  const plain = { data: payload }
  // rc4_hash__ = 对明文参数算的签名；随后它自身的值也要 RC4 加密进表单
  const rc4Hash = encSignature('POST', uri, snonce, plain)
  const enc = {
    data: rc4B64(snonce, payload),
    rc4_hash__: rc4B64(snonce, rc4Hash),
  }
  return {
    ...enc,
    // signature 对「加密后的全部参数」计算，再明文附带
    signature: encSignature('POST', uri, snonce, enc),
    ssecurity,
    _nonce: nonce,
    // 仅供测试断言（不进真实请求体）
    __snonce__: snonce,
  }
}

function buildEncParams(uri, data, ssecurity) {
  const nonce = genNonce()
  const p = encParamsWithNonce(uri, JSON.stringify(data), ssecurity, nonce)
  const { __rc4_hash__, __snonce__, ...form } = p
  return form
}

/** 解密应答：先按 JSON 试，失败则 RC4（密钥=signed_nonce）解密，还不行当 gzip 拆 */
export function decryptBodyWithNonce(ssecurity, nonce, text) {
  try {
    return JSON.parse(text)
  } catch { /* 走解密 */ }
  const snonce = signNonce(ssecurity, nonce)
  const raw = rc4(Buffer.from(snonce, 'base64'), Buffer.from(text, 'base64'))
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return JSON.parse(gunzipSync(raw).toString('utf8'))
  }
}

/** 从 Set-Cookie 里摘某个 cookie 的值 */
function cookieValue(setCookies, name) {
  for (const line of setCookies || []) {
    const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(line)
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

/**
 * 建一个米家云客户端（v2 扫码协议）。
 * opts: { dataDir, fetch?, timeoutMs?, log? }
 * 令牌持久化在 dataDir/token.json：{ ua, pass_o, deviceId, userId, cUserId, passToken, ssecurity, serviceToken }
 */
export function createMiCloud(opts) {
  const {
    dataDir,
    fetchImpl = null, // 默认用全局 fetch（走系统代理）；测试注入假 fetch
    timeoutMs = 15000,
    log = () => {},
  } = opts

  const tokenPath = join(dataDir, 'token.json')
  const specCachePath = join(dataDir, 'miot-spec-cache.json')
  let token = null
  let loginChain = Promise.resolve() // 登录/续期串行锁：并行调用排队，别把票据冲了
  const lastCmdAt = new Map() // did -> 上次控制指令时间戳（节流）
  const specCache = new Map() // model -> { siid, piid } 开关属性
  const listCache = { at: 0, items: null }
  const homeCache = { at: 0, items: null }

  // ---- 令牌存取 ----
  async function loadToken() {
    try {
      token = JSON.parse(await readFile(tokenPath, 'utf8'))
    } catch {
      token = null
    }
  }
  async function saveToken(t) {
    if (!t) return
    try {
      await mkdir(dataDir, { recursive: true })
      t.saveTime = Date.now()
      await writeFile(tokenPath, JSON.stringify(t), 'utf8')
    } catch (e) {
      log(`令牌保存失败：${e.message}`)
    }
  }
  async function clearToken() {
    token = null
    try {
      await writeFile(tokenPath, '', 'utf8')
    } catch { /* 尽力而为 */ }
  }

  function ensureSkeleton() {
    if (!token) token = {}
    if (!token.deviceId) token.deviceId = randomDeviceId()
    if (!token.pass_o) token.pass_o = randomHex(16)
    if (!token.ua) token.ua = androidUa('CN', token.pass_o)
  }

  // ---- HTTP 小工具 ----
  async function doFetch(url, init, timeout = timeoutMs) {
    const f = fetchImpl || ((u, i) => fetch(u, i)) // 生产走全局 fetch（走系统代理）；测试注入假 fetch
    const res = await f(url, { ...init, signal: AbortSignal.timeout(timeout) })
    const text = await res.text()
    return { status: res.status, text, url: res.url || String(url), setCookies: res.headers.getSetCookie?.() || [] }
  }

  /** account.xiaomi.com 的应答是「&&&START&&& + JSON」：剥掉前缀再解析 */
  function parsePassBody(text, status) {
    const start = text.indexOf('{')
    if (start < 0) throw new Error(`小米账号服务应答异常（${status}）`)
    return JSON.parse(text.slice(start))
  }

  /** 账号域（account.xiaomi.com）Cookie：deviceId/pass_o/passToken/userId/cUserId */
  function passCookieHeader() {
    ensureSkeleton()
    return [
      `deviceId=${token.deviceId}`,
      `pass_o=${token.pass_o}`,
      `passToken=${token.passToken || ''}`,
      `userId=${token.userId || ''}`,
      `cUserId=${token.cUserId || ''}`,
      `uLocale=zh_CN`,
    ].join('; ')
  }

  /** APP 网关域（api.mijia.tech）Cookie： serviceToken 一套 */
  function appCookieHeader() {
    ensureSkeleton()
    const tzOffset = -new Date().getTimezoneOffset()
    const sign = tzOffset >= 0 ? '+' : '-'
    const abs = Math.abs(tzOffset)
    const tz = `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    return [
      `cUserId=${token.cUserId || ''}`,
      `yetAnotherServiceToken=${token.serviceToken || ''}`,
      `serviceToken=${token.serviceToken || ''}`,
      `timezone_id=Asia/Shanghai`,
      `timezone=${tz}`,
      `is_daylight=0`,
      `dst_offset=0`,
      `channel=MI_APP_STORE`,
      `countryCode=CN`,
      `PassportDeviceId=${token.deviceId}`,
      `locale=zh_CN`,
    ].join('; ')
  }

  /** 把账号域 Set-Cookie 收进令牌（serviceToken/cUserId 等落盘字段从这里来） */
  function absorbCookies(setCookies) {
    for (const line of setCookies || []) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(line)
      if (!m) continue
      if (/expires=Thu, 01 Jan 1970/i.test(line) || m[2] === 'EXPIRED') continue
      if (m[1] === 'serviceToken') token.serviceToken = decodeURIComponent(m[2])
      if (m[1] === 'userId') token.userId = decodeURIComponent(m[2])
      if (m[1] === 'cUserId') token.cUserId = decodeURIComponent(m[2])
      if (m[1] === 'passToken') token.passToken = decodeURIComponent(m[2])
    }
  }

  /**
   * serviceLogin 一跳：code=0 说明 passToken 还活着（顺 location 跳一下即刷新成功）；
   * 否则 location 里带的是「领二维码」的票据参数。
   * 返回 { refreshed: true } 或领码参数对象。
   */
  async function serviceLogin() {
    ensureSkeleton()
    const r = await doFetch(`${PASS_BASE}/serviceLogin?_json=true&sid=mijia&_locale=zh_CN`, {
      method: 'GET',
      headers: { 'User-Agent': token.ua, Cookie: passCookieHeader(), Connection: 'keep-alive' },
    })
    const body = parsePassBody(r.text, r.status)
    if (body.code === 0 && body.location && body.ssecurity) {
      // passToken 有效：顺 location 跳转收新 serviceToken（应答正文是字面量 ok）
      const f = await doFetch(body.location, {
        method: 'GET',
        headers: { 'User-Agent': token.ua, Cookie: appCookieHeader(), Connection: 'keep-alive' },
      })
      if (f.status === 200 && f.text.trim() === 'ok') {
        absorbCookies(f.setCookies)
        token.ssecurity = body.ssecurity
        if (body.userId) token.userId = String(body.userId)
        if (body.passToken) token.passToken = body.passToken
        if (body.cUserId) token.cUserId = String(body.cUserId)
        await saveToken(token)
        return { refreshed: true }
      }
    }
    if (!body.location) throw new Error(`serviceLogin 应答缺 location：code=${body.code}`)
    // location 的 query 就是「领二维码」的参数（照协议原样透传）
    const q = {}
    for (const [k, v] of new URL(body.location).searchParams) q[k] = v
    return q
  }

  /**
   * 扫码登录第一步：拿二维码（不阻塞）。返回 { loginUrl, qr, lp }。
   * loginUrl=二维码内容；qr=二维码图片 URL（面板直接 <img>）；lp=长轮询地址。
   */
  async function qrStart() {
    const run = loginChain.catch(() => {})
    loginChain = run.then(() => {})
    await run
    await loadToken()
    ensureSkeleton()
    const loc = await serviceLogin()
    if (loc.refreshed) {
      log('passToken 仍有效，已静默续期，无需扫码')
      return { refreshed: true }
    }
    const qs = new URLSearchParams({
      ...loc,
      theme: '',
      bizDeviceType: '',
      _hasLogo: 'false',
      _qrsize: '240',
      _dc: String(Date.now()),
    }).toString()
    const r = await doFetch(`${QR_LOGIN_BASE}?${qs}`, {
      method: 'GET',
      headers: { 'User-Agent': token.ua, Cookie: passCookieHeader(), Connection: 'keep-alive' },
    })
    const body = parsePassBody(r.text, r.status)
    if (!body.loginUrl || !body.lp) throw new Error(`领二维码失败：${JSON.stringify(body).slice(0, 200)}`)
    // 二维码票据先落盘：中途重启也能接着轮询
    token.qr = { loginUrl: body.loginUrl, qr: body.qr || '', lp: body.lp }
    await saveToken(token)
    log('二维码已领取，等待米家 APP 扫码')
    return { loginUrl: body.loginUrl, qr: body.qr || '', lp: body.lp }
  }

  /**
   * 扫码登录第二步：长轮询等扫码（最长 ~120 秒），扫码后收全票落盘。
   * 超时抛出可重试的错误（面板再调 qrStart 领新码）。
   */
  async function qrPoll() {
    await loadToken()
    ensureSkeleton()
    if (!token.qr?.lp) throw new Error('还没有领取二维码，请先点「扫码登录」')
    const r = await doFetch(token.qr.lp, {
      method: 'GET',
      headers: { 'User-Agent': token.ua, Connection: 'keep-alive' },
    }, LP_TIMEOUT_MS)
    const body = parsePassBody(r.text, r.status)
    if (body.code !== 0 && body.code !== undefined) {
      // 20003=超时未扫 / 20004=取消 等：清掉票据让面板重新领码
      delete token.qr
      await saveToken(token)
      throw new Error(`扫码未完成（code=${body.code}）：请重新点「扫码登录」领取新二维码`)
    }
    for (const k of ['ssecurity', 'passToken', 'userId', 'cUserId']) {
      if (body[k] !== undefined) token[k] = String(body[k])
    }
    if (!token.ssecurity || !token.passToken) {
      throw new Error('扫码应答缺 ssecurity/passToken，登录没接上')
    }
    // 顺 location 回调收 serviceToken（正文 ok，凭证在 Set-Cookie 里）
    if (body.location) {
      const f = await doFetch(body.location, {
        method: 'GET',
        headers: { 'User-Agent': token.ua, Cookie: passCookieHeader(), Connection: 'keep-alive' },
      })
      absorbCookies(f.setCookies)
    }
    if (!token.serviceToken) throw new Error('扫码后没收到 serviceToken')
    delete token.qr
    await saveToken(token)
    log(`扫码登录成功（userId=${token.userId}）`)
    return { ok: true, userId: token.userId }
  }

  /** 用 passToken 静默续期；续不动抛错（面板需重新扫码） */
  async function refreshToken() {
    await loadToken()
    ensureSkeleton()
    const loc = await serviceLogin()
    if (!loc.refreshed) throw new Error('passToken 已失效，请重新扫码登录')
    return true
  }

  function needQrError(message) {
    const e = new Error(message || '还没有登录：请到面板点「扫码登录」，用米家 APP 扫一下二维码。')
    e.needQr = true
    return e
  }

  /** 退出登录：清掉本机所有登录凭证（token.json 清空），设备列表与规格缓存一并作废 */
  async function logout() {
    await loadToken()
    const had = !!(token?.ssecurity || token?.serviceToken || token?.passToken)
    await clearToken()
    listCache.at = 0
    listCache.items = null
    log('已退出登录，本机凭证已清除')
    return { ok: true, had }
  }

  async function ensureLogin() {
    if (!token) await loadToken()
    if (!token?.ssecurity || !token?.serviceToken) throw needQrError()
  }

  /**
   * 加密网关请求：RC4 表单 POST；返回完整应答 { code, result }。
   * auth 失效先静默续期重试一次，续不动则要求重新扫码。
   */
  async function request(uri, data, { relogin = true } = {}) {
    await ensureLogin()
    const form = buildEncParams(uri, data, token.ssecurity)
    const r = await doFetch(API_BASE + uri, {
      method: 'POST',
      headers: {
        'User-Agent': token.ua,
        'accept-encoding': 'identity',
        'Content-Type': 'application/x-www-form-urlencoded',
        'miot-accept-encoding': 'GZIP',
        'miot-encrypt-algorithm': 'ENCRYPT-RC4',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        Cookie: appCookieHeader(),
      },
      body: new URLSearchParams(form).toString(),
    })
    // _nonce 是明文回传的，解密密钥由它推出
    const resp = decryptBodyWithNonce(token.ssecurity, form._nonce, r.text)
    if (r.status === 200 && resp.code === 0) return resp
    const authFail = r.status === 401 || (typeof resp.message === 'string' && /auth|token|login/i.test(resp.message))
    if (authFail && relogin) {
      log('米家令牌失效，尝试 passToken 静默续期…')
      try {
        await refreshToken()
      } catch {
        await clearToken()
        throw needQrError('登录已过期且续期失败：请到面板重新扫码登录。')
      }
      return request(uri, data, { relogin: false })
    }
    throw new Error(`米家请求失败 ${uri} code=${resp.code}：${resp.message || r.status}`)
  }

  // ---- 家庭列表（面板让用户挑「只看哪个家」用；单独带缓存，和设备列表分开）----
  async function homesList(force = false, ttlMs = 60000) {
    if (!force && homeCache.items && Date.now() - homeCache.at < ttlMs) return homeCache.items
    const homesResp = await request('/v2/homeroom/gethome_merged', {
      fg: true, fetch_share: true, fetch_share_dev: true, fetch_cariot: true, limit: 300, app_ver: 7, plat_form: 0,
    })
    const homes = (homesResp.result?.homelist || []).map((h) => ({
      id: String(h.id),
      name: h.name || String(h.id),
      uid: Number(h.uid) || 0,
      // shareflag≠0 或房主不是自己 = 别人分享过来的家
      shared: !!h.shareflag || (Number(h.uid) && Number(h.uid) !== Number(token.userId)),
      roomCount: (h.roomlist || []).length,
    }))
    homeCache.at = Date.now()
    homeCache.items = homes
    return homes
  }

  /** 按家庭 id / 名称（精确或子串）过滤设备；空值=不筛，即全部家庭 */
  function filterByHome(items, home) {
    const want = String(home || '').trim()
    if (!want) return items
    const hit = (d) => d.homeId === want || d.homeName === want ||
      (d.homeName ? d.homeName.includes(want) : false)
    return items.filter(hit)
  }

  // ---- 设备列表（新网关：先家庭后设备，分页拉全；带房间归属；带缓存防风控）----
  // opts.home：只看某个家（家庭 id 或名称子串）；不传=全部家庭
  async function deviceList(force = false, ttlMs = 60000, opts = {}) {
    if (!force && listCache.items && Date.now() - listCache.at < ttlMs) {
      return filterByHome(listCache.items, opts.home)
    }
    const homesResp = await request('/v2/homeroom/gethome_merged', {
      fg: true, fetch_share: true, fetch_share_dev: true, fetch_cariot: true, limit: 300, app_ver: 7, plat_form: 0,
    })
    const homes = homesResp.result?.homelist || []
    // did → 房间名（以家庭房间表为准；房间表没提到的设备落到「未分配」）
    const roomOfDid = new Map()
    for (const home of homes) {
      for (const room of home.roomlist || []) {
        for (const did of room.dids || []) roomOfDid.set(String(did), room.name || '')
      }
    }
    const items = []
    for (const home of homes) {
      const homeId = String(home.id)
      const homeName = home.name || homeId
      // home_owner 必须是「这个家的房主 uid」：共享家庭里房主不是你，
      // 写死自己的 userId 会得到 code=-1 no permit。
      const owner = Number(home.uid) || Number(token.userId)
      let startDid = ''
      let hasMore = true
      try {
        while (hasMore) {
          const resp = await request('/home/home_device_list', {
            home_owner: owner,
            home_id: Number(home.id),
            limit: 200,
            start_did: startDid,
            get_split_device: true,
            support_smart_home: true,
            get_third_device: true,
          })
          const info = resp.result?.device_info || []
          for (const d of info) {
            items.push({
              did: String(d.did),
              name: d.name || '',
              model: d.model || '',
              isOnline: !!d.isOnline,
              roomId: d.roomid ?? d.room_id ?? null,
              roomName: roomOfDid.get(String(d.did)) || (home.name ? `${home.name}·未分配` : '未分配'),
              homeId,
              homeName,
            })
          }
          startDid = String(resp.result?.max_did || '')
          hasMore = !!resp.result?.has_more && startDid !== ''
        }
      } catch (e) {
        // 单个家庭取不到（无权/已退出分享）不该拖垮整张列表
        log(`家庭「${home.name || home.id}」设备列表跳过：${e.message}`)
      }
    }
    listCache.at = Date.now()
    listCache.items = items
    return filterByHome(items, opts.home)
  }

  // ---- 按型号查规格（siid/piid）：miot-spec.org 官方规格库，落盘缓存 ----
  // v1.1 泛化：不再只找「开关」，把灯类常用的 亮度/色温 一并找出来。
  async function loadSpecCache() {
    if (specCache.size) return
    try {
      const obj = JSON.parse(await readFile(specCachePath, 'utf8'))
      for (const [k, v] of Object.entries(obj || {})) specCache.set(k, v)
    } catch { /* 没有缓存就算了 */ }
  }
  async function saveSpecCache() {
    try {
      await mkdir(dataDir, { recursive: true })
      await writeFile(specCachePath, JSON.stringify(Object.fromEntries(specCache)), 'utf8')
    } catch { /* 尽力而为 */ }
  }

  /**
   * 查一个型号的全部可控制项（规格驱动，不分设备类型）。
   * 返回 { version:2, controls:[...] }，每个 control：
   *   { key, siid, piid, name, description, kind: 'toggle'|'slider'|'select',
   *     min?, max?, step?, unit?, options?: [{value, label}] }
   * bool 可写 → 开关；数值可写（有 value-range）→ 滑条；枚举可写（有 value-list）→ 下拉；
   * 其他可写（无界数值/字符串）跳过，避免造出没有意义的控件。
   * 兼容字段 onOff/brightness/colorTemp 从 controls 推出（旧调用方/测试用）。
   */
  async function specProps(model) {
    // 旧版缓存（v1.0 只存开关 / v1.1 无版本号 / v2 无 zh 字段）一律判废重查
    const cached = specCache.get(model)
    if (cached && cached.version === 3 && cached.controls?.[0]?.zh !== undefined) return cached
    const instR = await doFetch(`${SPEC_BASE}/instances?status=all`, { method: 'GET', headers: {} })
    const instances = JSON.parse(instR.text).instances || []
    const hit = instances.find((i) => i.model === model)
    if (!hit) throw new Error(`规格库里找不到型号 ${model}`)
    const specR = await doFetch(`${SPEC_BASE}/instance?type=${encodeURIComponent(hit.type)}`, { method: 'GET', headers: {} })
    const spec = JSON.parse(specR.text)
    const props = (spec.services || []).flatMap((s) =>
      (s.properties || []).map((p) => ({ siid: s.iid, piid: p.iid, ...p }))
    )
    const writable = props.filter((p) => (p.access || []).includes('write'))
    const controls = []
    let n = 0
    for (const p of writable) {
      const key = `p${p.siid}_${p.piid}`
      const name = p.description || p.name || key
      const zh = zhPropName(p.name, p.description)
      const base = {
        key, siid: p.siid, piid: p.piid,
        name,                     // 规格原文（兜底显示）
        zh,                       // 中文名（字典没收录为 null，显示时回退 name）
        description: p.description || '',
        core: isCoreProp(p.name, p.description), // 核心参数：状态列只报这些
      }
      if (p.format === 'bool') {
        controls.push({ ...base, kind: 'toggle', format: 'bool' })
      } else if (Array.isArray(p['value-list']) && p['value-list'].length) {
        controls.push({
          ...base, kind: 'select', format: p.format,
          options: p['value-list'].map((o) => ({ value: o.value, label: zhPropName('', o.description) || o.description || String(o.value) })),
        })
      } else if (Array.isArray(p['value-range']) && p['value-range'].length >= 3) {
        const [min, max, step] = p['value-range']
        controls.push({
          ...base, kind: 'slider', format: p.format,
          min, max, step: step || 1, unit: p.unit || '',
        })
      }
    }
    const result = {
      version: 3,
      controls,
      // 兼容旧调用方：开关 = 第一个 toggle；亮度/色温按命名挑（QQ 文字场景仍用）
      get onOff() { return firstOf('toggle') },
      get brightness() { return byName(/brightness|亮度/i) },
      get colorTemp() { return byName(/(colou?r[-._ ]?temp|color_temperature|^ct$|色温|temperature)/i) },
    }
    function firstOf(kind) {
      const c = controls.find((x) => x.kind === kind)
      return c ? { siid: c.siid, piid: c.piid } : { siid: 2, piid: 1 }
    }
    function byName(re) {
      const c = controls.find((x) => re.test(`${x.description} ${x.name}`) && x.kind !== 'toggle')
      return c ? { siid: c.siid, piid: c.piid } : null
    }
    specCache.set(model, result)
    await saveSpecCache()
    return result
  }

  /** 兼容旧名：只要开关属性 */
  async function onOffProp(model) {
    return (await specProps(model)).onOff
  }

  /** 通用属性下发（带每设备节流）。prop = { siid, piid } */
  async function setProp(device, prop, value) {
    const last = lastCmdAt.get(device.did) || 0
    const wait = CMD_GAP_MS - (Date.now() - last)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCmdAt.set(device.did, Date.now())
    const resp = await request('/miotspec/prop/set', {
      params: [{ did: device.did, siid: prop.siid, piid: prop.piid, value }],
    })
    const results = resp.result || []
    // 米家 code=0「成功」、code=1「已执行/进行中」都算生效（原典语义）
    const code = Array.isArray(results) && results[0] ? results[0].code : -1
    if (code !== 0 && code !== 1) throw new Error(`指令未生效（code=${code}）：${device.name}`)
    return { prop, code }
  }

  /** 开/关一个设备。device = deviceList 里的一项 */
  async function setOnOff(device, on) {
    return setProp(device, await onOffProp(device.model), !!on)
  }

  /**
   * 批量查设备当前状态（该型号全部 controls 的真实值）。
   * devices: deviceList 的项数组；返回 { did: { [key]: value } }（查不到的键省略）。
   */
  async function getStates(devices) {
    const out = {}
    for (const d of devices) {
      const props = await specProps(d.model)
      const controls = props.controls || []
      if (!controls.length) { out[d.did] = {}; continue }
      const resp = await request('/miotspec/prop/get', {
        params: controls.map((c) => ({ did: d.did, siid: c.siid, piid: c.piid })),
        datasource: 1,
      })
      const st = {}
      const rows = Array.isArray(resp.result) ? resp.result : []
      for (const c of controls) {
        const r = rows.find((x) => String(x.did) === String(d.did) && x.siid === c.siid && x.piid === c.piid)
        if (r && r.code === 0 && r.value !== undefined) st[c.key] = r.value
      }
      out[d.did] = st
    }
    return out
  }

  /** 清掉设备列表缓存（测试/手动刷新用） */
  function clearListCache() {
    listCache.at = 0
    listCache.items = null
    homeCache.at = 0
    homeCache.items = null
  }

  return {
    qrStart, qrPoll, ensureLogin, refreshToken, logout,
    request, deviceList, homesList, setOnOff, setProp, specProps, getStates, clearListCache, onOffProp,
    /** 测试/面板用：当前是否有可用登录态 */
    async hasLogin() {
      if (!token) await loadToken()
      return !!(token?.ssecurity && token?.serviceToken)
    },
  }
}
