// lib/cloud.mjs —— Bambu 云端设备列表（GET /v1/iot-service/api/user/bind）
// 只依赖全局 fetch（可注入）；错误信息只报状态码/HTTP 错误，绝不回显 token。

export const REGIONS = {
  us: { key: 'us', api: 'https://api.bambulab.com', web: 'https://bambulab.com', mqtt: 'us.mqtt.bambulab.com' },
  eu: { key: 'eu', api: 'https://api.bambulab.com', web: 'https://bambulab.com', mqtt: 'eu.mqtt.bambulab.com' },
  cn: { key: 'cn', api: 'https://api.bambulab.cn', web: 'https://bambulab.cn', mqtt: 'cn.mqtt.bambulab.com' },
}

const DEFAULT_REGION = 'us'
const BIND_PATH = '/v1/iot-service/api/user/bind'
const MQTT_PORT = 8883

/** 区域名 -> { key, api, mqtt }；未知区域回落到 us。 */
export function regionOf(name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(REGIONS, key)) return REGIONS[key]
  return REGIONS[DEFAULT_REGION]
}

function text(value, maxLength = 200) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function maskToken(token) {
  const s = String(token ?? '')
  if (s.length <= 6) return '••••'
  return '••••' + s.slice(-4)
}

/** 内部：确保错误文本里不出现 token 任何片段 */
function scrub(message, accessToken) {
  let out = String(message ?? '未知错误')
  const token = typeof accessToken === 'string' ? accessToken : ''
  if (token.length >= 4 && out.includes(token)) out = out.split(token).join(maskToken(token))
  return out
}

function describeHttpError(status, bodyText) {
  // 只回状态码 + 从响应里挑固定的、不含秘密的提示
  let hint = ''
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText)
      const code = parsed && (parsed.code ?? parsed.error)
      if (typeof code === 'number' || typeof code === 'string') hint = '（code ' + String(code).slice(0, 40) + '）'
    } catch {
      /* 非 JSON 就不看内容 */
    }
  }
  if (status === 401 || status === 403) return '云端令牌无效或已过期（HTTP ' + status + '）'
  if (status === 404) return '云端接口不存在（HTTP 404）'
  if (status >= 500) return '云端服务暂时不可用（HTTP ' + status + '）'
  return '云端请求失败（HTTP ' + status + '）' + hint
}

/**
 * 列出账号下的打印机。
 * @param {{accessToken:string, uid?:string, region?:string, fetchImpl?:Function, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true,devices:Array}|{ok:false,error:string,code?:string,status?:number}>}
 */
export async function listDevices(opts = {}) {
  const accessToken = typeof opts.accessToken === 'string' ? opts.accessToken.trim() : ''
  if (!accessToken) return { ok: false, error: '缺少云端访问令牌', code: 'NO_TOKEN' }
  const region = regionOf(opts.region)
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境没有 fetch', code: 'NO_FETCH' }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 12000
  const url = region.api + BIND_PATH

  let res
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const name = err && err.name ? String(err.name) : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: '云端请求超时（' + timeoutMs + 'ms）', code: 'TIMEOUT' }
    }
    const message = err && err.message ? String(err.message) : '网络错误'
    return { ok: false, error: scrub('云端请求失败：' + message, accessToken), code: 'NETWORK' }
  }

  let bodyText = ''
  try {
    bodyText = typeof res.text === 'function' ? await res.text() : ''
  } catch {
    bodyText = ''
  }
  if (!res || typeof res.status !== 'number' || !(res.status >= 200 && res.status < 300)) {
    const status = res && typeof res.status === 'number' ? res.status : 0
    return { ok: false, error: scrub(describeHttpError(status, bodyText), accessToken), code: 'HTTP', status }
  }

  let data
  try {
    data = JSON.parse(bodyText || 'null')
  } catch {
    return { ok: false, error: '云端返回了无法解析的数据', code: 'BAD_JSON' }
  }
  const rawDevices = data && Array.isArray(data.devices) ? data.devices : []
  const devices = []
  for (const item of rawDevices) {
    if (!item || typeof item !== 'object') continue
    const serial = text(item.dev_id, 64) || text(item.serial, 64)
    if (!serial) continue
    const name = text(item.name, 80)
    if (!name) continue
    const device = {
      serial,
      name,
      model: text(item.dev_model_name, 60) || text(item.dev_product_name, 60) || '未知型号',
      ip: text(item.dev_ip, 64),
    }
    const code = text(item.dev_access_code, 64)
    if (code) device.accessCode = code
    devices.push(device)
  }
  return { ok: true, devices, region: region.key }
}

/**
 * 组装 printerManager 能直接用的云端 target。
 * host 由 index 从 region.mqtt 传入；这里给出默认 host 作为兜底。
 */
export function cloudTarget({ accessToken, uid, region, device } = {}) {
  const r = regionOf(region)
  const dev = device && typeof device === 'object' ? device : {}
  return {
    mode: 'cloud',
    host: text(dev.mqttHost, 128) || r.mqtt,
    port: MQTT_PORT,
    serial: text(dev.serial, 64) || '',
    name: text(dev.name, 80) || '',
    model: text(dev.model, 60) || '',
    accessToken: typeof accessToken === 'string' ? accessToken : '',
    uid: typeof uid === 'string' ? uid : '',
    region: r.key,
  }
}

/** 云端 target -> 设备列表里对应的 printerRef（给 vault 用） */
export function devicesToPrinters(devices) {
  const list = Array.isArray(devices) ? devices : []
  return list
    .map((dev) => {
      const item = {
        serial: text(dev && dev.serial, 64) || '',
        name: text(dev && dev.name, 80) || '',
        model: text(dev && dev.model, 60) || '',
      }
      // 云端设备如果带了局域网地址和访问码，一并留给 vault 加密保存：
      // 机器人就在同一网段时，状态/控制/拍照都可以直接走局域网，比 TUTK 稳。
      const ip = text(dev && dev.ip, 64)
      if (ip) item.ip = ip
      const code = text(dev && dev.accessCode, 64)
      if (code) item.accessCode = code
      return item
    })
    .filter((dev) => dev.serial && dev.name)
}
