// lib/cloud-auth.mjs —— Bambu 云账号登录（账号密码 → accessToken），按 ha-bambulab 的流程：
//   1) POST /v1/user-service/user/login {account, password, apiError}
//      → 直接给 accessToken；或 loginType=verifyCode（邮箱/短信验证码）；或 loginType=tfa（两步验证）
//   2) verifyCode：先 POST /v1/user-service/user/sendemail/code（邮箱）或 /sendsmscode（手机），
//      再 POST login {account, code}
//   3) tfa：GET /api/csrf 拿 bbl_csrf_token，再 POST /api/sign-in/tfa {tfaKey, tfaCode}，
//      token 在 Set-Cookie 的 token 里
//
// 「OAuth 注册的账号」在 ha-bambulab 文档里的做法是：先在 Bambu 手机 App 里设置密码
// （Account Security → Change Password），之后就能用账号 + 密码登录。本模块沿用这条路径，
// 不做第三方 OAuth 跳转（那需要浏览器回调和厂商 client_id，不适合 QQ 机器人）。
//
// 安全：密码/验证码/accessToken 只在本文件局部变量里出现；不写日志、不进错误文本，
// 只在成功时把 accessToken 交回调用方（由 vault 立即加密保存）。

import { regionOf } from './cloud.mjs'

const PATHS = {
  login: '/v1/user-service/user/login',
  emailCode: '/v1/user-service/user/sendemail/code',
  // 短信验证码只在**中国站**提供，而且路径多一层 /api：
  //   https://api.bambulab.cn/api/v1/user-service/user/sendsmscode
  // 走国际站（api.bambulab.com，且不带 /api）会直接 400 —— 这是之前「发送短信验证码失败（HTTP 400）」的原因。
  // 邮箱验证码两个站都有，仍按账号所在 region 走。
  smsCode: '/api/v1/user-service/user/sendsmscode',
  preference: '/v1/design-user-service/my/preference',
  bind: '/v1/iot-service/api/user/bind',
  csrf: '/api/csrf',
  tfa: '/api/sign-in/tfa',
}

const LOGIN_HEADERS = {
  'X-BBL-Client-Name': 'BambuStudio',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '02.09.01.55',
  'X-BBL-Agent-Version': '02.09.01.55',
  'X-BBL-Language': 'zh-CN',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-Executable-info': '{}',
  Accept: 'application/json',
}

export class CloudAuthError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'CloudAuthError'
    this.code = code
  }
}

const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max))

function scrub (message, secrets) {
  let out = String(message == null ? '' : message)
  for (const secret of secrets) {
    const s = typeof secret === 'string' ? secret : ''
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join('••••')
  }
  return out
}

/** 从 JWT 里取 username（u_<uid>）；不是 JWT 就返回空串。 */
export function uidFromToken (accessToken) {
  const token = str(accessToken, 4096)
  const parts = token.split('.')
  if (parts.length !== 3) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const name = str(payload && payload.username, 64)
    const m = /^u_(\d+)$/.exec(name)
    return m ? m[1] : (payload && payload.uid ? str(payload.uid, 32) : '')
  } catch {
    return ''
  }
}

function cookiesFrom (res, wanted) {
  const out = {}
  let list = []
  try { list = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [] } catch { list = [] }
  for (const line of list) {
    const first = String(line).split(';')[0] || ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!wanted || wanted.includes(name)) out[name] = value
  }
  return out
}

async function readJson (res) {
  let bodyText = ''
  try { bodyText = typeof res.text === 'function' ? await res.text() : '' } catch { bodyText = '' }
  try { return JSON.parse(bodyText || 'null') } catch { return null }
}

function httpError (res, action) {
  const status = res && typeof res.status === 'number' ? res.status : 0
  if (status === 401 || status === 403) return new CloudAuthError('AUTH_FAILED', action + '失败：账号或密码不对（HTTP ' + status + '）')
  if (status === 429) return new CloudAuthError('RATE_LIMITED', action + '太频繁了（HTTP 429），过一会儿再试')
  if (status >= 500) return new CloudAuthError('CLOUD_DOWN', action + '失败：Bambu 云端暂时不可用（HTTP ' + status + '）')
  return new CloudAuthError('HTTP', action + '失败（HTTP ' + status + '）')
}

/**
 * 建一个「登录会话」：同一个账号的 verifyCode / 2FA 步骤要接着用同一个 region 和账号。
 * @param {{account:string, password?:string, region?:string, fetchImpl?:Function, timeoutMs?:number}} opts
 */
export function createCloudLogin (opts = {}) {
  const account = str(opts.account, 200)
  const password = typeof opts.password === 'string' ? opts.password : ''
  // 手机号账号属于中国站：它的发码接口只在 api.bambulab.cn 存在，
  // 换 token / 后续 iot 接口也必须同站，否则会 400 或拿不到设备。
  // 所以这里按账号形态把 region 钉正，而不是只改发码那一步。
  const looksLikePhone = !account.includes('@') && /^\+?[\d\s-]{6,20}$/.test(account)
  const region = looksLikePhone ? regionOf('cn') : regionOf(opts.region)
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  const timeoutMs = Math.min(30000, Math.max(3000, Number(opts.timeoutMs) || 15000))
  let tfaKey = ''
  let csrfCookie = ''

  const secrets = () => [password, tfaKey, csrfCookie]

  async function call (method, url, { json, headers } = {}) {
    if (typeof fetchImpl !== 'function') throw new CloudAuthError('NO_FETCH', '当前环境没有 fetch')
    const requestHeaders = { ...LOGIN_HEADERS, ...(headers || {}) }
    if (json !== undefined) requestHeaders['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      })
    } catch (err) {
      const name = err && err.name ? String(err.name) : ''
      if (name === 'TimeoutError' || name === 'AbortError') throw new CloudAuthError('TIMEOUT', '连接 Bambu 云端超时（' + timeoutMs + 'ms）')
      throw new CloudAuthError('NETWORK', '连接 Bambu 云端失败：' + scrub((err && err.message) || err, secrets()))
    }
    return res
  }

  /** 第一步：账号 + 密码。返回 { ok, accessToken, uid } 或 { ok:false, need:'code'|'tfa', tfaKey? } */
  async function login () {
    if (!account) throw new CloudAuthError('NO_ACCOUNT', '缺少 Bambu 账号（邮箱或手机号）')
    if (!password) throw new CloudAuthError('NO_PASSWORD', '缺少密码（OAuth 注册的账号请先在 Bambu 手机 App 里设置密码）')
    const res = await call('POST', region.api + PATHS.login, { json: { account, password, apiError: '' } })
    if (!(res.status >= 200 && res.status < 300)) {
      const body = await readJson(res)
      // 400 + code:1 表示需要验证码；ha-bambulab 用 loginType 判断，这里两种都认
      const type = body && (body.loginType || (body.code === 1 ? 'verifyCode' : ''))
      if (type === 'verifyCode') return { ok: false, need: 'code' }
      if (type === 'tfa') {
        tfaKey = str(body.tfaKey, 200)
        return { ok: false, need: 'tfa', tfaKey: '' }
      }
      throw httpError(res, '登录')
    }
    const body = await readJson(res)
    const token = str(body && (body.accessToken || body.access_token), 4096)
    if (!token) {
      const type = body && body.loginType
      if (type === 'verifyCode') return { ok: false, need: 'code' }
      if (type === 'tfa') {
        tfaKey = str(body.tfaKey, 200)
        return { ok: false, need: 'tfa' }
      }
      throw new CloudAuthError('NO_TOKEN', '登录成功但云端没有返回 token（接口可能变了）')
    }
    const uid = uidFromToken(token) || await fetchUid(token)
    return { ok: true, accessToken: token, uid, region: region.key }
  }

  /**
   * 让云端发验证码（邮箱或短信，按账号里有没有 @ 判断）。
   *
   * 域名不是随便挑的：
   *   · 邮箱验证码：api.bambulab.com / api.bambulab.cn 都认，按账号所在 region 走；
   *   · 短信验证码：**只有 api.bambulab.cn 提供**（手机号本身就是中国站账号），
   *     而且路径要带 /api。以前拿 region.api + /v1/...sendsmscode 去请求，
   *     国际站没这个接口，于是稳定 400。
   * ha-bambulab 的 BAMBU_URL 里也是这么分的，这里对齐。
   */
  async function requestCode () {
    const isEmail = account.includes('@')
    // 手机号账号的 region 已经在建会话时钉成 cn，所以这里直接用 region.api 即可。
    const url = region.api + (isEmail ? PATHS.emailCode : PATHS.smsCode)
    const payload = isEmail ? { email: account, type: 'codeLogin' } : { phone: account, type: 'codeLogin' }
    const res = await call('POST', url, { json: payload })
    if (!(res.status >= 200 && res.status < 300)) throw httpError(res, isEmail ? '发送邮箱验证码' : '发送短信验证码')
    return { ok: true, channel: isEmail ? 'email' : 'sms' }
  }

  /** 第二步（verifyCode）：提交验证码换 token。 */
  async function submitCode (code) {
    const value = str(code, 20).replace(/\s+/g, '')
    if (!value) throw new CloudAuthError('NO_CODE', '缺少验证码')
    const res = await call('POST', region.api + PATHS.login, { json: { account, code: value } })
    if (res.status === 400) {
      const body = await readJson(res)
      const c = body && body.code
      if (c === 1) throw new CloudAuthError('CODE_EXPIRED', '验证码过期了，重新发一次')
      if (c === 2) throw new CloudAuthError('CODE_INCORRECT', '验证码不对')
      throw new CloudAuthError('CODE_FAILED', '验证码登录失败（HTTP 400）')
    }
    if (!(res.status >= 200 && res.status < 300)) throw httpError(res, '验证码登录')
    const body = await readJson(res)
    const token = str(body && (body.accessToken || body.access_token), 4096)
    if (!token) throw new CloudAuthError('NO_TOKEN', '验证码登录成功但没有拿到 token')
    const uid = uidFromToken(token) || await fetchUid(token)
    return { ok: true, accessToken: token, uid, region: region.key }
  }

  /** 第二步（tfa）：CSRF + tfaKey + tfaCode，token 在 Set-Cookie 里。 */
  async function submitTfa (code) {
    const value = str(code, 12).replace(/\s+/g, '')
    if (!value) throw new CloudAuthError('NO_CODE', '缺少两步验证码')
    if (!tfaKey) throw new CloudAuthError('NO_TFA_KEY', '没有两步验证上下文，请重新用账号密码登录')
    if (!csrfCookie) {
      const csrfRes = await call('GET', region.web + PATHS.csrf, { headers: { Accept: '*/*' } })
      const jar = cookiesFrom(csrfRes, ['bbl_csrf_token'])
      csrfCookie = jar.bbl_csrf_token || ''
      if (!csrfCookie) throw new CloudAuthError('CSRF_FAILED', '拿不到 CSRF token，两步验证做不了（可以改用验证码登录）')
    }
    const res = await call('POST', region.web + PATHS.tfa, {
      json: { tfaKey, tfaCode: value },
      headers: { 'x-bbl-csrf-token': csrfCookie, Cookie: 'bbl_csrf_token=' + csrfCookie },
    })
    if (res.status === 400) throw new CloudAuthError('CODE_INCORRECT', '两步验证码不对')
    if (!(res.status >= 200 && res.status < 300)) throw httpError(res, '两步验证')
    const jar = cookiesFrom(res, ['token'])
    const token = jar.token || ''
    if (!token) throw new CloudAuthError('NO_TOKEN', '两步验证通过但没拿到 token')
    const uid = uidFromToken(token) || await fetchUid(token)
    return { ok: true, accessToken: token, uid, region: region.key }
  }

  async function fetchUid (token) {
    try {
      const res = await call('GET', region.api + PATHS.preference, { headers: { Authorization: 'Bearer ' + token } })
      if (!(res.status >= 200 && res.status < 300)) return ''
      const body = await readJson(res)
      return str(body && body.uid, 32)
    } catch {
      return ''
    }
  }

  return { login, requestCode, submitCode, submitTfa, region: region.key, account }
}

/**
 * 用 accessToken 拉设备列表，验证 token 是否还能用。
 * @returns {Promise<{ok:true, devices:Array}|{ok:false, code:string, error:string}>}
 */
export async function verifyCloudToken ({ accessToken, region, fetchImpl, timeoutMs = 12000 } = {}) {
  const token = str(accessToken, 4096)
  if (!token) return { ok: false, code: 'NO_TOKEN', error: '没有云端 token' }
  const r = regionOf(region)
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof impl !== 'function') return { ok: false, code: 'NO_FETCH', error: '当前环境没有 fetch' }
  let res
  try {
    res = await impl(r.api + PATHS.bind, {
      headers: { ...LOGIN_HEADERS, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const name = err && err.name ? String(err.name) : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, code: 'TIMEOUT', error: '校验 token 超时' }
    return { ok: false, code: 'NETWORK', error: '校验 token 失败：' + scrub((err && err.message) || err, [token]) }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'TOKEN_EXPIRED', error: '云端 token 已失效，需要重新登录' }
  if (!(res.status >= 200 && res.status < 300)) return { ok: false, code: 'HTTP', error: '校验 token 失败（HTTP ' + res.status + '）' }
  const body = await readJson(res)
  const devices = body && Array.isArray(body.devices) ? body.devices : []
  return { ok: true, devices }
}
