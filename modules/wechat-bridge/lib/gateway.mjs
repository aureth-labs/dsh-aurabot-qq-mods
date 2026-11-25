import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const part = encodeURIComponent
const validMessageId = (id) => typeof id === 'string' && /^[\w-]{1,256}$/.test(id)
const TERMINAL_SEND_STATES = new Set(['failed', 'cancelled', 'canceled', 'rejected', 'blocked', 'needs_review', 'uncertain', 'partial'])
const ACCEPTED_SEND_STATES = new Set(['accepted', 'sent', 'completed', 'succeeded'])

export function privateId(value) {
  const id = String(value ?? '').trim()
  return /^[\w][\w@.-]{0,127}$/.test(id) && id !== 'filehelper' && !id.endsWith('@chatroom') ? id : ''
}

export function gatewaySettings(settings) {
  try {
    const url = new URL(String(settings.url ?? '').trim())
    const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (!local || url.protocol !== 'http:' || !['/', '/v1', '/v1/'].includes(url.pathname) ||
      url.username || url.password || url.search || url.hash) return null
    const account = String(settings.account ?? '').trim()
    const tokenFile = String(settings.tokenFile ?? '').trim()
    if (!/^[\w][\w.-]{0,127}$/.test(account) || !isAbsolute(tokenFile) || /^[\\/]{2}/.test(tokenFile)) return null
    return { url: url.origin, account, tokenFile }
  } catch {
    return null
  }
}

export function incomingThread(event) {
  return event?.kind === 'message.committed' && event.data?.direction === 'incoming' &&
    validMessageId(event.data.messageId) ? privateId(event.data.threadId) : ''
}

export function eventCursor(value) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && /^[!-~]{1,1024}$/.test(String(value))
    ? String(value) : ''
}

// Agent WeChat sends Server-Sent Events. A frame can span multiple HTTP chunks.
export async function* readEvents(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      if (boundary.index > 512 * 1024) throw new Error('Agent WeChat 事件过大')
      const frame = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      if (event && typeof event === 'object' && !Array.isArray(event)) yield event
    }
    if (buffer.length > 512 * 1024) throw new Error('Agent WeChat 事件过大')
  }
}

export async function openGateway(config, signal) {
  config = config && gatewaySettings(config)
  if (!config) throw new Error('请填写本机网关地址、档案 ID 和 API 密钥文件绝对路径')
  let token
  try {
    const info = await stat(config.tokenFile)
    if (!info.isFile() || info.size > 4096) throw new Error('invalid token file')
    token = (await readFile(config.tokenFile, 'utf8')).trim()
    if (!/^[!-~]{1,4096}$/.test(token)) throw new Error('invalid token')
  } catch {
    throw new Error('无法读取 Agent WeChat API 密钥文件')
  }
  const base = config.url + '/v1/accounts/' + part(config.account)

  async function request(path, { body, key, stream = false } = {}) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 8000)
    const headers = { Authorization: 'Bearer ' + token }
    if (key) headers['Idempotency-Key'] = key
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      let response
      try {
        response = await fetch(base + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([signal, timeout.signal]),
        })
      } catch {
        throw new Error(body === undefined ? '连不上本机 Agent WeChat' : '微信投递结果待核对')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        const error = new Error('Agent WeChat 返回 HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      if (stream) return response
      try { return await response.json() } catch { throw new Error('Agent WeChat 返回了无效的响应') }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async verify(expected) {
      const status = await request('')
      const bot = privateId(status?.ownUsername)
      if (!bot || status.authenticated !== true || status.connection !== 'online') {
        throw new Error('微信档案未上线，请先在 Agent WeChat 登录')
      }
      if (expected && expected !== bot) throw new Error('Agent WeChat 当前登录的账号已变更')
      return bot
    },
    async head() {
      const page = await request('/threads?limit=1')
      const cursor = eventCursor(page?.asOfEventCursor)
      if (!cursor) throw new Error('Agent WeChat 未返回事件游标')
      return cursor
    },
    stream: (cursor) => request('/events/stream?after=' + part(cursor), { stream: true }),
    async incoming(event) {
      const thread = incomingThread(event)
      if (!thread) return null
      let message
      try {
        message = await request('/messages/' + part(event.data.messageId))
      } catch (error) {
        if (error.status === 404 || error.status === 410) return null
        throw error
      }
      if (message?.id !== event.data.messageId || message.accountId !== config.account || message.threadId !== thread ||
        message.senderId !== thread || message.direction !== 'incoming' || message.recall || message.type !== 1) return null
      const text = typeof message.body === 'string' ? message.body.trim().slice(0, 2000) : ''
      return text ? {
        id: event.data.messageId, thread, text, quoted: Boolean(message.quote),
        at: Date.parse(message.createdAt),
      } : null
    },
    async sendText(thread, text, key) {
      let send = await request('/sends', { body: { threadId: thread, kind: 'text', text }, key })
      const deadline = Date.now() + 45_000
      while (!ACCEPTED_SEND_STATES.has(send?.state)) {
        if (TERMINAL_SEND_STATES.has(send?.state) || !validMessageId(send?.id) || Date.now() >= deadline) {
          throw new Error('微信投递未获确认，请在微信里核对')
        }
        await delay(400, undefined, { signal })
        send = await request('/sends/' + part(send.id))
      }
    },
  }
}
