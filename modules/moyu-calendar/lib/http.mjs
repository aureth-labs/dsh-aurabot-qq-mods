// 带超时、大小上限和域名约束的读取。调用方只把允许的地址传进来。

// 微信和搜狗对非浏览器请求经常不返回正常页面，实测这个浏览器标识能拿到结果。
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export function shortError(error) {
  const name = error?.name || ''
  const message = String(error?.message || error || '')
  if (name === 'AbortError' || /abort|超时/i.test(message)) return '超时或已停止'
  return message.slice(0, 160)
}

/** 只接受 https，且主机名必须在给定列表里。返回去掉 hash 的地址，不合法返回空串。 */
export function pinnedUrl(value, hosts) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { return '' }
  if (url.protocol !== 'https:' || url.username || url.password) return ''
  if (!hosts.includes(url.hostname)) return ''
  url.hash = ''
  return url.href
}

export function signalWithTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

/** 等到指定毫秒；signal 中止时拒绝，避免模块卸载后还在轮询。 */
export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError() {
  const error = new Error('摸鱼日历模块已停止')
  error.name = 'AbortError'
  return error
}

/** 把本次响应的 Set-Cookie 记在内存里，只留这一轮搜索用，不落盘。 */
export function rememberCookies(jar, response) {
  const lines = typeof response?.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const line of lines) {
    const pair = String(line).split(';')[0]
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name || /[\s;\r\n]/.test(name) || /[\r\n]/.test(value)) continue
    jar.set(name, value)
  }
}

export function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** 读完响应体，超过 maxBytes 就中止。兼容没有流式 body 的测试替身。 */
export async function readBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('内容超过大小限制')
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw new Error('内容超过大小限制')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks)
  }
  if (typeof response.arrayBuffer !== 'function') throw new Error('响应没有正文')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error('内容超过大小限制')
  return bytes
}

/**
 * 读完响应，只保留末尾 maxBytes，超限不报错。truncated 为 true 表示开头被丢掉了。
 * 累计读到 totalMax 还没完就不再读，这时留下的是已读部分的末尾。
 */
export async function readBodyTail(response, maxBytes, totalMax = maxBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    let total = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        chunks.push(chunk)
        size += chunk.byteLength
        total += chunk.byteLength
        // 从最前面丢起；最前面那块只留后半截。
        while (size > maxBytes && chunks.length) {
          const over = size - maxBytes
          if (chunks[0].byteLength > over) {
            chunks[0] = chunks[0].subarray(over)
            size = maxBytes
          } else {
            size -= chunks[0].byteLength
            chunks.shift()
          }
        }
        if (total >= totalMax) break
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return { bytes: Buffer.concat(chunks), truncated: total > maxBytes }
  }
  if (typeof response.arrayBuffer !== 'function') throw new Error('响应没有正文')
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes: bytes.subarray(Math.max(0, bytes.length - maxBytes)), truncated: bytes.length > maxBytes }
}
