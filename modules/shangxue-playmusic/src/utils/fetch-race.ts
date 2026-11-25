// 直连 + 代理并行竞速的 fetch：一个文件、零依赖，可整文件复制到别的插件。
//   const res = await fetchRace('https://api.example.com/x')
// 默认代理是 apifox 的 POST 包装（api-u 放目标地址）；非 apifox 地址按前缀代理拼。
// 只有「2xx + 内容非空 + validate 通过」才算成功，另一条通道随即中止。

/** apifox 的 Web 代理入口（POST 包装）。 */
export const APIFOX_PROXY = 'https://web-proxy.apifox.cn/api/v1/request'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

const OFF_WORDS = new Set(['direct', 'off', 'none', 'no', '关闭', '关'])

export type Channel = 'direct' | 'proxy'

/** 「内容为空 / 校验没通过」这类失败：换一条通道可能就好了。 */
export class EmptyResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyResponseError'
  }
}

export interface ProxyConfig {
  channels: Channel[]
  kind: 'apifox' | 'prefix'
  endpoint: string
}

/** 把「代理配置字符串」翻译成实际要走的通道。 */
export function resolveProxy(proxy?: string): ProxyConfig {
  const raw = String(proxy == null ? '' : proxy).trim()
  if (raw && OFF_WORDS.has(raw.toLowerCase())) {
    return { channels: ['direct'], kind: 'apifox', endpoint: APIFOX_PROXY }
  }
  if (!raw) return { channels: ['direct', 'proxy'], kind: 'apifox', endpoint: APIFOX_PROXY }
  if (/web-proxy\.apifox\.cn/i.test(raw)) {
    return { channels: ['direct', 'proxy'], kind: 'apifox', endpoint: raw }
  }
  return { channels: ['direct', 'proxy'], kind: 'prefix', endpoint: raw }
}

export interface RaceOptions {
  /** 代理地址。留空 = 内置 apifox；'direct'/'off' = 只直连；其它地址 = 自定义代理。 */
  proxy?: string
  /** 单通道超时（毫秒），默认 8000。 */
  timeoutMs?: number
  /** 只跑指定通道，默认按 proxy 配置决定（一般是两条都跑）。 */
  channels?: Channel[]
  /** 业务级校验：返回 false 表示这条响应不可用，继续等另一条。会强制读取响应体。 */
  validate?: (response: Response) => boolean | Promise<boolean>
  /** 是否把响应体读进内存（默认 true）。置 false 时只保证 2xx，交由调用方自己读。 */
  readBody?: boolean
  /** 调试日志（可选）。 */
  debug?: (message: string, detail?: unknown) => void
}

/**
 * 直连 / 代理并行竞速，返回第一个「可用」的响应。
 * 拿到的是标准 Response，可以照常 .text() / .json() / .arrayBuffer()。
 */
export async function fetchRace(
  url: string | URL,
  init: RequestInit = {},
  options: RaceOptions = {},
): Promise<Response> {
  const target = String(url)
  const config = resolveProxy(options.proxy)
  const channels = options.channels && options.channels.length ? options.channels : config.channels
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 8000)
  const readBody = options.readBody !== false || Boolean(options.validate)
  const controllers = channels.map(() => new AbortController())
  const failures: string[] = []
  let emptyCount = 0
  let winner = -1

  try {
    return await new Promise<Response>((resolve, reject) => {
      let pending = channels.length
      channels.forEach((channel, index) => {
        requestChannel(target, init, channel, config, timeoutMs, controllers[index].signal, options, readBody)
          .then((response) => {
            if (winner >= 0) return
            winner = index
            controllers.forEach((controller, i) => {
              if (i !== index) controller.abort()
            })
            options.debug?.('命中', channel)
            resolve(response)
          })
          .catch((error) => {
            if (winner >= 0) return
            if (error instanceof EmptyResponseError) emptyCount += 1
            failures.push(`${channelLabel(channel, config)}：${describe(error)}`)
            options.debug?.('失败', { channel, error: describe(error) })
            pending -= 1
            if (pending === 0 && winner < 0) {
              const message = `所有通道都失败（${failures.join('；')}）`
              reject(emptyCount === channels.length ? new EmptyResponseError(message) : new Error(message))
            }
          })
      })
    })
  } finally {
    if (winner < 0) controllers.forEach((controller) => controller.abort())
  }
}

/**
 * 同时跑多个异步任务，返回第一个「被 accept 判定为可用」的结果。
 * - accept 默认：不为 null/undefined；数组非空；字符串非空白。
 * - 单个任务抛错不会中断其它任务；全部失败时抛最后一个错误。
 */
export async function raceFirst<T>(
  tasks: Array<() => Promise<T>>,
  accept?: (value: T) => boolean,
): Promise<T> {
  if (!tasks.length) throw new Error('raceFirst：没有可执行的任务')
  const ok = accept || defaultAccept
  if (tasks.length === 1) {
    const value = await tasks[0]()
    if (!ok(value)) throw new Error('raceFirst：唯一任务的结果不可用')
    return value
  }
  return new Promise<T>((resolve, reject) => {
    let pending = tasks.length
    let lastError: unknown
    let settled = false
    for (const task of tasks) {
      Promise.resolve()
        .then(() => task())
        .then((value) => {
          if (settled) return
          if (ok(value)) {
            settled = true
            resolve(value)
          } else {
            pending -= 1
            if (pending === 0) reject(lastError || new Error('raceFirst：所有任务的结果都不可用'))
          }
        })
        .catch((error) => {
          lastError = error
          pending -= 1
          if (pending === 0 && !settled) reject(lastError)
        })
    }
  })
}

/** 透明前缀代理：<proxy>/<原始完整 URL>。proxy 留空时返回原地址。 */
export function prefixUrl(proxy: string | undefined, originalUrl: string): string {
  const value = String(proxy || '').trim()
  if (!value) return originalUrl
  return value.replace(/\/+$/, '') + '/' + originalUrl
}

async function requestChannel(
  target: string,
  init: RequestInit,
  channel: Channel,
  config: ProxyConfig,
  timeoutMs: number,
  outerSignal: AbortSignal,
  options: RaceOptions,
  readBody: boolean,
): Promise<Response> {
  const signal = combineSignals(outerSignal, timeoutMs)
  let response: Response

  if (channel === 'proxy' && config.kind === 'apifox') {
    response = await fetch(config.endpoint, {
      method: 'POST',
      signal,
      headers: {
        'api-u': target,
        'api-o0': `method=GET, timings=true, timeout=${Math.round(timeoutMs)}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
  } else {
    const headers = new Headers(init.headers as any)
    if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_UA)
    const finalUrl = channel === 'proxy' ? prefixUrl(config.endpoint, target) : target
    response = await fetch(finalUrl, { ...init, method: init.method || 'GET', headers, signal })
  }

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  if (!readBody) return response

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength) throw new EmptyResponseError('空响应（0 字节）')

  const contentType = String(response.headers.get('content-type') || '')
  if (isTextual(contentType) && !new TextDecoder().decode(bytes).trim()) {
    throw new EmptyResponseError('空响应（只有空白字符）')
  }

  const rebuilt = new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: contentType ? { 'content-type': contentType } : undefined,
  })

  if (options.validate) {
    let accepted = false
    try {
      accepted = await options.validate(rebuilt.clone())
    } catch {
      accepted = false
    }
    if (!accepted) throw new EmptyResponseError('响应内容不可用（校验未通过）')
  }
  return rebuilt
}

function combineSignals(outer: AbortSignal, timeoutMs: number): AbortSignal {
  if (outer.aborted) return outer
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
  }
  return outer
}

function channelLabel(channel: Channel, config: ProxyConfig): string {
  if (channel === 'direct') return '直连'
  return config.kind === 'apifox' ? 'apifox 代理' : '代理'
}

function describe(error: unknown): string {
  if (error instanceof EmptyResponseError) return error.message
  if (error && typeof error === 'object') {
    const e = error as { name?: string; message?: string }
    if (e.name === 'TimeoutError') return '请求超时'
    if (e.name === 'AbortError') return '请求被取消'
    if (e.message) return e.message
  }
  return String(error)
}

function isTextual(contentType: string): boolean {
  return /json|text|xml|javascript|ecmascript|x-www-form-urlencoded|html/i.test(contentType)
}

function defaultAccept(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

export default fetchRace
