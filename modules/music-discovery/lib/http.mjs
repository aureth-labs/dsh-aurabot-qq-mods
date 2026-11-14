// 只允许访问固定音乐平台域名的 JSON 请求层。
// 超时、有限重试、429 退避都在这里；抛出的错误里不会出现 Authorization / Key / Cookie。
// 不跟随任意用户 URL：调用方只能传本文件白名单里的平台地址。

export const ALLOWED_HOSTS = Object.freeze(['music.163.com', 'a.y.qq.com'])

/** 网络/协议层错误：code 是给上层做分支用的，message 是可以直接给用户看的短句。 */
export class MusicError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'MusicError'
    this.code = code
    this.status = detail.status || 0
    this.retryAfterMs = detail.retryAfterMs || 0
  }
}

const RETRYABLE = new Set(['network', 'rate-limited', 'server'])

const defaultFetch = (url, init) => globalThis.fetch(url, init)

export function assertAllowedUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new MusicError('bad-url', '地址格式不对')
  }
  if (url.protocol !== 'https:') throw new MusicError('bad-url', '只允许 https 地址')
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new MusicError('bad-url', `不允许访问这个域名：${url.hostname}`)
  }
  return url
}

function parseRetryAfter(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, 10_000)
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 10_000)) : 0
}

function shortReason(error) {
  const code = error?.cause?.code || error?.code
  if (code) return String(code)
  const name = error?.name || 'FetchError'
  return name === 'TypeError' ? '网络不可达' : String(name)
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MusicError('aborted', '请求已取消'))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new MusicError('aborted', '请求已取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

const MAX_REDIRECTS = 2

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * 手动跟跳转：每一跳都重新过白名单，且只允许同 origin。
 * 不用 redirect:'follow'——那会让自动跳转的目标绕过域名校验。
 *
 * 为什么必须同 origin：请求头里的 Authorization 属于发起请求的那个平台。
 * 两个音乐平台都在白名单，不代表凭据可以互传——QQ 的 Bearer 绝不能跟着
 * 302 跳到 music.163.com。跨 origin 一律拒绝，不尝试「过滤敏感头后跟随」。
 */
async function fetchWithCheckedRedirects(startUrl, { method, headers, body, doFetch, signal }) {
  let current = startUrl
  let currentMethod = method
  let currentBody = body
  for (let hop = 0; ; hop += 1) {
    const res = await doFetch(current.href, {
      method: currentMethod,
      headers,
      body: currentBody,
      signal,
      redirect: 'manual',
    })
    if (!isRedirect(res.status)) return res

    const location = res.headers?.get?.('location')
    if (!location) throw new MusicError('redirect-blocked', '平台要求跳转，但没给目标地址')
    if (hop >= MAX_REDIRECTS) throw new MusicError('redirect-blocked', '平台跳转次数过多，已停止')

    let next
    try {
      next = new URL(String(location), current)
    } catch {
      throw new MusicError('redirect-blocked', '平台跳转的目标地址不合法')
    }
    // 逐跳复核：不在固定音乐平台域名里就根本不发下一个请求
    if (!ALLOWED_HOSTS.includes(next.hostname) || next.protocol !== 'https:') {
      throw new MusicError('redirect-blocked', `平台跳转到了不允许的地址（${next.protocol}//${next.hostname}），已停在这里`)
    }
    // 再核一层：跨 origin 也不跟，避免把原平台的 Authorization/Cookie 带过去
    if (next.origin !== current.origin) {
      throw new MusicError('redirect-blocked', `平台跳转跨到了别的站点（${next.origin}），为避免把凭据带过去，已停在这里`)
    }
    if (res.status === 303) {
      currentMethod = 'GET'
      currentBody = undefined
    }
    current = next
  }
}

async function once(url, { method, headers, body, timeoutMs, signal, doFetch }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new MusicError('aborted', '请求已取消')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    let res
    try {
      res = await fetchWithCheckedRedirects(url, { method, headers, body, doFetch, signal: controller.signal })
    } catch (error) {
      if (error instanceof MusicError) throw error
      if (signal?.aborted) throw new MusicError('aborted', '请求已取消')
      if (timedOut) throw new MusicError('timeout', `平台没在 ${timeoutMs}ms 内回应`)
      throw new MusicError('network', `连不上音乐平台（${shortReason(error)}）`)
    }
    if (res.status === 401 || res.status === 403) {
      throw new MusicError('auth-failed', `平台拒绝了鉴权（HTTP ${res.status}）`, { status: res.status })
    }
    if (res.status === 429) {
      throw new MusicError('rate-limited', '平台限流了（HTTP 429）', {
        status: 429,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
      })
    }
    if (res.status >= 500) {
      throw new MusicError('server', `音乐平台出错（HTTP ${res.status}）`, { status: res.status })
    }
    if (!res.ok) throw new MusicError('http', `请求失败（HTTP ${res.status}）`, { status: res.status })

    let text
    try {
      text = await res.text()
    } catch (error) {
      if (signal?.aborted) throw new MusicError('aborted', '请求已取消')
      if (timedOut) throw new MusicError('timeout', `平台没在 ${timeoutMs}ms 内回应`)
      throw new MusicError('network', `读取响应失败（${shortReason(error)}）`)
    }
    try {
      return JSON.parse(text)
    } catch {
      // 不把响应体拼进错误：风控页/配置片段不该进日志
      throw new MusicError('parse', `平台返回的不是 JSON（${text.length} 字节，可能是风控页）`)
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 请求一个平台 JSON 接口。
 * @param {string} rawUrl 必须在白名单域名内
 * @param {object} options
 * @param {number} [options.timeoutMs] 单次请求超时
 * @param {number} [options.retries] 只对网络错误 / 429 / 5xx 重试
 * @param {AbortSignal} [options.signal] 模块卸载或换轮时取消
 * @param {Function} [options.fetchImpl] 测试注入
 */
export async function requestJson(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 8000,
    retries = 1,
    signal,
    fetchImpl,
    retryDelayMs = 400,
    maxRetryAfterMs = 2500,
  } = options
  const url = assertAllowedUrl(rawUrl)
  const doFetch = fetchImpl || defaultFetch
  let attempt = 0

  while (true) {
    try {
      return await once(url, { method, headers, body, timeoutMs, signal, doFetch })
    } catch (error) {
      const retryable = error instanceof MusicError && RETRYABLE.has(error.code)
      if (!retryable || attempt >= retries || signal?.aborted) throw error
      const wait = error.code === 'rate-limited'
        ? Math.max(error.retryAfterMs || 0, retryDelayMs)
        : retryDelayMs
      await sleep(Math.min(wait, maxRetryAfterMs), signal)
      attempt += 1
    }
  }
}

/**
 * 请求一个 SSE 流（text/event-stream）。
 * 走和 requestJson 相同的白名单 + 同 origin 跳转约束；返回的 chunks 是异步可迭代的字符串块。
 * 注意：必须消费 chunks（或在 break 时让生成器收尾），否则超时定时器会一直挂着。
 *
 * @param {string} rawUrl 必须在白名单域名内
 * @param {object} options
 * @param {number} [options.timeoutMs] 整个流的超时（不是首字节）
 * @param {AbortSignal} [options.signal] 模块卸载 / 开关关闭 / 身份变化时取消
 * @param {Function} [options.fetchImpl] 测试注入
 */
export async function requestSse(rawUrl, options = {}) {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 30_000,
    signal,
    fetchImpl,
  } = options
  const url = assertAllowedUrl(rawUrl)
  const doFetch = fetchImpl || defaultFetch
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new MusicError('aborted', '请求已取消')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  const cleanup = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  let res
  try {
    res = await fetchWithCheckedRedirects(url, {
      method,
      headers,
      body,
      doFetch,
      signal: controller.signal,
    })
  } catch (error) {
    cleanup()
    if (error instanceof MusicError) throw error
    if (signal?.aborted) throw new MusicError('aborted', '请求已取消')
    if (timedOut) throw new MusicError('timeout', `平台没在 ${timeoutMs}ms 内回应`)
    throw new MusicError('network', `连不上音乐平台（${shortReason(error)}）`)
  }

  if (res.status === 401 || res.status === 403) {
    cleanup()
    throw new MusicError('auth-failed', `平台拒绝了鉴权（HTTP ${res.status}）`, { status: res.status })
  }
  if (res.status === 429) {
    cleanup()
    throw new MusicError('rate-limited', '平台限流了（HTTP 429）', {
      status: 429,
      retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
    })
  }
  if (res.status >= 500) {
    cleanup()
    throw new MusicError('server', `音乐平台出错（HTTP ${res.status}）`, { status: res.status })
  }
  if (!res.ok) {
    cleanup()
    throw new MusicError('http', `请求失败（HTTP ${res.status}）`, { status: res.status })
  }

  const reader = res.body?.getReader?.()
  if (!reader) {
    cleanup()
    throw new MusicError('parse', '平台没有返回可读取的流')
  }

  const contentType = String(res.headers?.get?.('content-type') || '')

  async function* readChunks() {
    const decoder = new TextDecoder('utf-8')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) yield decoder.decode(value, { stream: true })
      }
      const tail = decoder.decode()
      if (tail) yield tail
    } catch (error) {
      if (signal?.aborted) throw new MusicError('aborted', '请求已取消')
      if (timedOut) throw new MusicError('timeout', `平台没在 ${timeoutMs}ms 内回应`)
      throw new MusicError('network', `读取响应流失败（${shortReason(error)}）`)
    } finally {
      cleanup()
      try {
        await reader.cancel()
      } catch {
        /* 已经结束，忽略 */
      }
    }
  }

  return { status: res.status, contentType, chunks: readChunks() }
}

/** 给日志用的短句：只留错误码和状态码，不带 URL 查询串或请求头。 */
export function describeError(error) {
  if (!(error instanceof MusicError)) return '出错了'
  const map = {
    'bad-url': '地址不在允许的平台域名内',
    network: '连不上音乐平台',
    timeout: '平台响应超时',
    aborted: '请求被取消',
    'rate-limited': '平台限流',
    'auth-failed': '平台拒绝了鉴权',
    server: '音乐平台出错',
    http: '平台返回了失败状态',
    parse: '平台返回的内容没法解析',
    'redirect-blocked': '平台跳转到了不允许的地址',
  }
  return map[error.code] || error.message
}
