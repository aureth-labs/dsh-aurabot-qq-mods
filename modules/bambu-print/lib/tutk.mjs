// lib/tutk.mjs —— 拓竹「云端实时画面」的凭据层：ttcode 铸取 + bambu:///tutk URL 组装。
//
// 背景（详见 docs/TUTK.md 与 open-bamboo-networking research/06.07-tutk.md）：
//   Bambu 云端画面走 ThroughTek Kalay（IOTC/AV）P2P：云 REST 铸一个 ttcode，云端向打印机推
//   liveview.prepare，打印机打开 TUTK 服务端，客户端再用 DTLS-PSK + AV 会话取 H.264。
//   DTLS 不是 Node 的 TLS 能做的东西，H.264 也需要解码器，所以纯 JS 不可能实现。
//
// 分工：
//   本文件（Node）只负责「拿凭据」：用用户自己的云端 token 调 ttcode 接口，
//   拼出 bambu:///tutk?uid=…&authkey=…&passwd=…&region=…。
//   真正的抓帧交给 lib/tutk-bridge.mjs + 模块自带的 C 桥（它动态加载 OBN 的 BambuSource）。
//
// 安全：
//   * access token / ttcode / authkey / passwd 永不写日志、不进错误文本、不进 argv；
//   * URL 只从 0600 临时文件的路径传给桥，进程列表里看不到秘密。

import { REGIONS, regionOf } from './cloud.mjs'

export const TUTK_DEFAULT_TIMEOUT_MS = 20000
export const TUTK_MAX_TIMEOUT_MS = 60000
/** TUTK 服务端窗口：铸码后约 9 分钟关闭，缓存不要超过 8 分钟。 */
export const TUTK_MAX_CACHE_MINUTES = 8
export const TUTK_URL_PREFIX = 'bambu:///tutk'

/** 把错误文本里的秘密擦掉（token 可能被底层库回显）。 */
function scrubSecrets (message, secrets) {
  let out = String(message == null ? '' : message)
  for (const secret of secrets) {
    const s = typeof secret === 'string' ? secret : ''
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join('••••')
  }
  return out
}

// 和切片器一致的客户端标识：云端 mint 会按 Client-Name/Type 识别调用方。
const CLIENT_HEADERS = {
  'X-BBL-Client-Name': 'BambuStudio',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '02.09.01.55',
  'X-BBL-Agent-Version': '02.09.01.55',
  'X-BBL-Language': 'zh-CN',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-Executable-info': '{}',
}

function text (value, max = 200) {
  if (value == null) return ''
  const s = String(value).trim()
  return s.length > max ? s.slice(0, max) : s
}

/** ttcode 的 uid 是 20 字符的 TUTK UID；这里只做宽松校验，避免误伤新格式。 */
export function looksLikeTutkUid (uid) {
  return /^[A-Za-z0-9_-]{16,40}$/.test(text(uid, 40))
}

export function buildTutkUrl ({ uid, authkey, passwd, region } = {}) {
  const u = text(uid, 64)
  if (!u) throw new Error('缺少 TUTK uid')
  const params = new URLSearchParams()
  params.set('uid', u)
  if (authkey) params.set('authkey', text(authkey, 64))
  if (passwd) params.set('passwd', text(passwd, 64))
  params.set('region', regionOf(region).key)
  return TUTK_URL_PREFIX + '?' + params.toString()
}

/** 解析 bambu:///tutk?…（也接受完整 URL 字符串），用于自检与桥接前校验。 */
export function parseTutkUrl (value) {
  const raw = text(value, 2048)
  if (!raw.startsWith(TUTK_URL_PREFIX + '?')) throw new Error('不是 TUTK 画面地址')
  const params = new URLSearchParams(raw.slice((TUTK_URL_PREFIX + '?').length))
  const uid = params.get('uid') || ''
  if (!uid) throw new Error('TUTK 地址里没有 uid')
  return {
    uid,
    authkey: params.get('authkey') || '',
    passwd: params.get('passwd') || '',
    region: regionOf(params.get('region') || 'us').key,
  }
}

/** 云端 mint 失败的说明：只报状态码/固定文案，绝不回显 token。 */
function describeHttp (status) {
  if (status === 401 || status === 403) return '云端令牌无效或没有云画面权限（HTTP ' + status + '）'
  if (status === 404) return '云端没有 TUTK 铸码接口（HTTP 404）'
  if (status === 429) return '云端限流了（HTTP 429），过一会儿再试'
  if (status >= 500) return '云端服务暂时不可用（HTTP ' + status + '）'
  return '云端铸码失败（HTTP ' + status + '）'
}

/**
 * 铸一个 TUTK 会话（POST /v1/iot-service/api/user/ttcode）。
 * @param {{accessToken:string, uid?:string, region?:string, serial:string, devVersion?:string,
 *   protocols?:string[], fetchImpl?:Function, timeoutMs?:number, apiBase?:string}} opts
 * @returns {Promise<{ok:true, uid:string, authkey:string, passwd:string, region:string, url:string}
 *   | {ok:false, code:string, error:string}>}
 */
export async function mintTutcode (opts = {}) {
  const accessToken = typeof opts.accessToken === 'string' ? opts.accessToken.trim() : ''
  const serial = text(opts.serial, 64)
  if (!accessToken) return { ok: false, code: 'NO_TOKEN', error: '缺少云端访问令牌，铸不了云画面凭据' }
  if (!serial) return { ok: false, code: 'NO_SERIAL', error: '缺少打印机序列号' }
  const region = regionOf(opts.region)
  const apiBase = text(opts.apiBase, 200) || region.api
  const url = apiBase + '/v1/iot-service/api/user/ttcode'
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, code: 'NO_FETCH', error: '当前环境没有 fetch' }
  const timeoutMs = Math.min(TUTK_MAX_TIMEOUT_MS, Math.max(3000, Number(opts.timeoutMs) || 12000))
  const protocols = Array.isArray(opts.protocols) && opts.protocols.length ? opts.protocols.map((p) => text(p, 20)).filter(Boolean) : ['tutk']

  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...CLIENT_HEADERS,
      },
      body: JSON.stringify({ dev_id: serial, dev_version: text(opts.devVersion, 40), protocols }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const name = err && err.name ? String(err.name) : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, code: 'TIMEOUT', error: '云端铸码超时（' + timeoutMs + 'ms）' }
    return { ok: false, code: 'NETWORK', error: '云端铸码请求失败：' + scrubSecrets(String((err && err.message) || err), [accessToken]) }
  }

  let bodyText = ''
  try { bodyText = typeof res.text === 'function' ? await res.text() : '' } catch { bodyText = '' }
  if (!res || typeof res.status !== 'number' || !(res.status >= 200 && res.status < 300)) {
    return { ok: false, code: 'HTTP', error: describeHttp(res && res.status) }
  }
  let data
  try { data = JSON.parse(bodyText || 'null') } catch { return { ok: false, code: 'BAD_JSON', error: '云端铸码返回了无法解析的数据' } }
  // 不同固件/ABI 版本会把字段放在顶层或 data 里，两处都看。
  const inner = data && typeof data === 'object' && data.data && typeof data.data === 'object' ? data.data : data || {}
  const uid = text(inner.ttcode || inner.uid || inner.uid_str, 64)
  const authkey = text(inner.authkey || inner.auth_key, 64)
  const passwd = text(inner.passwd || inner.password || inner.pass, 64)
  if (!uid) return { ok: false, code: 'NO_UID', error: '云端没有返回 TUTK uid（这台打印机可能不支持云画面，或账号没有权限）' }
  if (!authkey || !passwd) return { ok: false, code: 'NO_SECRETS', error: '云端返回的 TUTK 凭据不完整（缺 authkey/passwd）' }
  let built
  try { built = buildTutkUrl({ uid, authkey, passwd, region: inner.region || region.key }) } catch (err) {
    return { ok: false, code: 'BAD_RESPONSE', error: '云端返回的 TUTK 地址拼不出来：' + String((err && err.message) || err) }
  }
  return { ok: true, uid, authkey, passwd, region: regionOf(inner.region || region.key).key, url: built }
}

export { REGIONS }
