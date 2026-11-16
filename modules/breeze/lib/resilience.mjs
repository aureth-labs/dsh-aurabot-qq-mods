import { setTimeout as sleep } from 'node:timers/promises'

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null
  const raw = String(value).trim()
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

// 排队只占用本模块的并发名额。超过等候预算或调用方断开，就跳过，避免迟到的计费请求。
export function createSynthQueue({ waitMs = 45000 } = {}) {
  let tail = Promise.resolve()
  return async (work, signal) => {
    const queued = AbortSignal.any([AbortSignal.timeout(waitMs), ...(signal ? [signal] : [])])
    let started = false
    const job = tail.then(() => { queued.throwIfAborted(); started = true; return work(signal) })
    tail = job.catch(() => {})
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = () => { if (!started) reject(queued.reason) }; queued.addEventListener('abort', rejectAbort, { once: true }); if (queued.aborted) rejectAbort() })
    try { return await Promise.race([job, aborted]) }
    finally { queued.removeEventListener('abort', rejectAbort) }
  }
}

/** 只重试明确拒绝生成的 429；超时可能已被上游执行，不重复提交。 */
export async function fetchBreeze(url, init, { fetchImpl = fetch, signal, wait = sleep, now = Date.now, budgetMs = 60000, log } = {}) {
  const until = now() + budgetMs
  const timeout = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(signal ? [signal] : [])])
  for (let attempt = 0; ; attempt++) {
    timeout.throwIfAborted()
    const res = await fetchImpl(url, { ...init, signal: timeout })
    if (res.ok) return res
    const body = await res.text().catch(() => '')
    const failure = new Error(`Breeze HTTP ${res.status}：${body.slice(0, 160)}`)
    if (res.status !== 429 || attempt >= 2) throw failure
    const header = res.headers.get('retry-after')
    const delay = retryAfterMs(header, now()) ?? 2000 * (attempt + 1)
    // 不把上游要求的长等待截短后硬撞；预算不够直接让调用方回退。
    if (delay + 1000 >= until - now()) throw failure
    log?.warn(`Breeze 429：Retry-After=${header || '未提供'}，等待 ${delay}ms 后重试 ${attempt + 1}/2`)
    await wait(delay, undefined, { signal: timeout })
  }
}
