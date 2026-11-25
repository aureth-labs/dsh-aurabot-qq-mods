// 余额查询的实现部分：触发词匹配、结果格式化、请求与缓存。
// 不依赖插件 API，fetch 和时钟都可以注入，方便测试。

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
export const TIMEOUT_MS = 8000
export const CACHE_MS = 30_000

export const NO_KEY_TEXT = '还没配置 DeepSeek API Key：面板「已安装」页找到本模块，填好 Key 再保存。'
export const DENY_TEXT = '这个只有主人能查哦～'

// 触发词可以写多个，用逗号或空格分开
export function triggerList(settings) {
  return String((settings && settings.trigger) || '余额')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function matchesTrigger(settings, text) {
  const target = String(text || '').trim().toLowerCase()
  if (!target) return false
  return triggerList(settings).some((word) => word.toLowerCase() === target)
}

// 接口返回的是字符串金额，统一显示成两位小数
export function money(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

export function formatBalance(data) {
  const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
  const parts = []
  for (const info of infos) {
    if (!info) continue
    const symbol = info.currency === 'USD' ? '$' : '¥'
    parts.push(`${symbol}${money(info.total_balance)}`)
    const granted = Number(info.granted_balance)
    const topped = Number(info.topped_up_balance)
    if ((granted > 0) || (topped > 0)) {
      parts.push(`（赠送 ${money(info.granted_balance)} / 充值 ${money(info.topped_up_balance)}）`)
    }
  }
  if (!parts.length) return '查到了，但账户里没有余额信息。'
  const head = data && data.is_available === false ? '余额不足，API 调用会被拒绝：' : 'DeepSeek 余额：'
  return head + parts.join(' ')
}

// 去掉末尾斜杠；空值回退到默认地址
export function resolveBase(settings) {
  const raw = String((settings && settings.baseUrl) || '').trim()
  return raw.replace(/\/+$/, '') || DEFAULT_BASE_URL
}

function requestBalance(base, key, { fetchImpl, timeoutMs }) {
  const url = `${base}/user/balance`
  const init = {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  }
  // 运行时用全局 fetch（每次调用时取，随时可用最新的）；测试里注入 fetchImpl 顶替它
  return fetchImpl ? fetchImpl(url, init) : fetch(url, init)
}

export async function queryBalance(settings, { fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const key = String((settings && settings.apiKey) || '').trim()
  if (!key) return { ok: false, message: NO_KEY_TEXT }

  const base = resolveBase(settings)

  let res
  try {
    res = await requestBalance(base, key, { fetchImpl, timeoutMs })
    // 官方余额接口在根路径，不在 /v1 下；填了 /v1 又撞到 404 时自动退回根路径再试一次
    if ((res.status === 404 || res.status === 405) && /\/v1$/i.test(base)) {
      res = await requestBalance(base.replace(/\/v1$/i, ''), key, { fetchImpl, timeoutMs })
    }
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, message: `查询超时（${timeoutMs / 1000} 秒），等会儿再试？` }
    }
    return { ok: false, message: `连不上 ${base}：${(err && err.message) || err}` }
  }

  const raw = await res.text().catch(() => '')
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }

  if (res.status === 401) return { ok: false, status: 401, message: 'API Key 无效或已过期，去 platform.deepseek.com 重新生成一个。' }
  if (res.status === 403) return { ok: false, status: 403, message: '这个 Key 没有查询余额的权限（403）。' }
  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || (raw ? raw.slice(0, 120) : '')
    return { ok: false, status: res.status, message: `查询失败（HTTP ${res.status}）${detail ? '：' + detail : ''}` }
  }
  if (!data) return { ok: false, status: res.status, message: '接口返回的内容不是 JSON，可能被网关改写了。' }

  return { ok: true, status: res.status, message: formatBalance(data) }
}

// 带缓存的查询：成功的结果在 cacheMs 内复用；开关从关到开时清缓存
export function createBalanceQuery({ fetchImpl, now = () => Date.now(), cacheMs = CACHE_MS, timeoutMs = TIMEOUT_MS } = {}) {
  let cache = null
  let lastEnabled = false
  return {
    reset() { cache = null },
    get cached() { return cache ? cache.text : '' },
    // 开关从关到开时清缓存，避免刚打开就看到关掉之前的旧数字
    syncEnabled(enabled) {
      if (!enabled) { lastEnabled = false; cache = null; return }
      if (!lastEnabled) cache = null
      lastEnabled = true
    },
    async run(settings) {
      const at = now()
      if (cache && at - cache.at < cacheMs) return { ok: true, message: cache.text, fromCache: true }
      // 不注入 fetchImpl 时，queryBalance 会走全局 fetch（调用那一刻再取）
      const result = await queryBalance(settings, { fetchImpl, timeoutMs })
      if (result.ok) cache = { at, text: result.message }
      return result
    },
  }
}
