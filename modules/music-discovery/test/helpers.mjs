// 测试用的 mock 宿主：只捕获发送，不真发 QQ；fetch 全注入，不打真网络。

import module from '../index.mjs'

export const OWNER_PRIVATE = { chat: { chatId: 'private:1001', kind: 'private', userId: '1001' }, level: 'full', sessionId: 's-owner' }
export const GROUP = { chat: { chatId: 'group:2002', kind: 'group', groupId: '2002' }, level: 'social', sessionId: 's-group' }
export const OTHER_PRIVATE = { chat: { chatId: 'private:3003', kind: 'private', userId: '3003' }, level: 'social', sessionId: 's-other' }

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text,
  }
}

/** 假 SSE 回包：chunks 是字符串或 Uint8Array，用来测跨 chunk / UTF-8 切分。 */
export function sseResponse(chunks, { status = 200, contentType = 'text/event-stream', headers = {} } = {}) {
  const lower = Object.fromEntries(
    Object.entries({ 'content-type': contentType, ...headers }).map(([key, value]) => [key.toLowerCase(), String(value)]),
  )
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close()
      const chunk = chunks[i]
      i += 1
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
    },
  })
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    body,
    text: async () => chunks.map((chunk) => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))).join(''),
  }
}

/** 一直不结束的 SSE 流，只有在 signal abort 时才报错。 */
export function sseHangUntilAbort() {
  return (url, init) => new Promise((resolve) => {
    const signal = init?.signal
    if (signal?.aborted) throw abortError()
    const body = new ReadableStream({
      start(controller) {
        signal?.addEventListener?.('abort', () => {
          try {
            controller.error(abortError())
          } catch {
            /* 已经关闭 */
          }
        }, { once: true })
      },
    })
    resolve({
      status: 200,
      ok: true,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body,
    })
  })
}

export function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/**
 * 按顺序匹配 URL 的假 fetch。
 * routes: [{ url: 'api/cloudsearch', reply: response | (url, init) => response | Promise }]
 */
export function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init })
    if (init.signal?.aborted) throw abortError()
    for (const route of routes) {
      const hit = typeof route.match === 'function' ? route.match(url, init) : String(url).includes(route.match)
      if (!hit) continue
      const reply = typeof route.reply === 'function' ? route.reply(url, init) : route.reply
      return await reply
    }
    throw new Error(`测试里没配这个地址的假回包：${url}`)
  }
  impl.calls = calls
  return impl
}

export function hangUntilAbort() {
  return (url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    if (signal.aborted) return reject(abortError())
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

export function createHarness({ settings = {}, owner = true, fetch, now, send } = {}) {
  const state = {
    settings: {
      platform: 'netease',
      limit: 3,
      shareForm: 'link',
      ownerOnly: true,
      qqKey: '',
      recommendEnabled: true,
      searchEnabled: true,
      chartsEnabled: true,
      playlistEnabled: true,
      reportEnabled: false,
      interpretEnabled: false,
      ...settings,
    },
    owner,
    ownerChecks: 0,
    sends: [],
    logs: [],
    disposers: [],
    commands: new Map(),
    rules: [],
    builder: null,
    listeners: new Map(),
    // 发送回执按真实宿主契约装：默认成功要带 message_id；
    // 'null' = 治理拒绝/未发，'simulate' = 面板模拟截获，'throw' = 抛异常。
    sendBehavior: send?.behavior || 'ok',
    sendError: send?.error || '',
  }

  const record = (level) => (...args) => state.logs.push({ level, text: args.map(String).join(' ') })

  /** 宿主发送的真实返回：成功带 message_id；null = 没发；sim- 前缀 = 面板模拟。 */
  function reply() {
    if (state.sendBehavior === 'null') return null
    if (state.sendBehavior === 'throw') throw new Error(state.sendError || 'send failed')
    const id = state.sendBehavior === 'simulate' ? `sim-${state.sends.length}` : `mock-${state.sends.length}`
    return { message_id: id }
  }

  const api = {
    id: 'music-discovery',
    source: 'user',
    version: '1.3.0-beta.1',
    apiVersion: 1,
    dir: 'mock/music-discovery',
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    settings: () => ({ ...state.settings }),
    saveSettings: (patch) => Object.assign(state.settings, patch),
    config: () => {
      throw new Error('模块不该读整份插件配置')
    },
    sendText: async (chatId, text) => {
      state.sends.push({ kind: 'text', chatId, text })
      return reply()
    },
    sendSegments: async (chatId, segments, note) => {
      state.sends.push({ kind: 'segments', chatId, segments, note })
      return reply()
    },
    isOwner: () => state.owner,
    tool: (builder) => {
      state.builder = builder
      return () => {}
    },
    defineTool: (spec) => spec,
    rule: (fn) => {
      state.rules.push(fn)
      return () => {}
    },
    command: (command) => {
      state.commands.set(command.name, command)
      return () => {}
    },
    on: (event, fn) => {
      if (!state.listeners.has(event)) state.listeners.set(event, [])
      state.listeners.get(event).push(fn)
      return () => {}
    },
    onDispose: (fn) => {
      state.disposers.push(fn)
      return () => {}
    },
    core: {
      hub: {
        turnSendersAllOwner: () => {
          state.ownerChecks += 1
          return state.owner
        },
      },
    },
    __musicDiscoveryTestHooks: { fetch, now },
  }

  const harness = {
    api,
    state,
    exports: null,
    mount() {
      harness.exports = module.setup(api)
      return harness.exports
    },
    where(base = OWNER_PRIVATE) {
      return base
    },
    tools(where = OWNER_PRIVATE) {
      const built = state.builder(where)
      if (!built) return []
      return Array.isArray(built) ? built : [built]
    },
    tool(name, where = OWNER_PRIVATE) {
      const found = harness.tools(where).find((item) => item.name === name)
      if (!found) throw new Error(`没挂上工具 ${name}`)
      return found
    },
    async call(name, args, where = OWNER_PRIVATE) {
      const tool = harness.tool(name, where)
      return tool.execute(args, { sessionId: where.sessionId })
    },
    /** 直接调 setup 导出的实现，能拿到候选数组（工具只回 { ok, message }，这是宿主契约） */
    raw: {
      search: (args = {}) => harness.exports.search({ chatId: OWNER_PRIVATE.chat.chatId, ...args }),
      recommend: (args = {}) => harness.exports.recommend({
        chatId: OWNER_PRIVATE.chat.chatId,
        sessionId: OWNER_PRIVATE.sessionId,
        chat: OWNER_PRIVATE.chat,
        ...args,
      }),
      share: (args = {}) => harness.exports.share({
        sessionId: OWNER_PRIVATE.sessionId,
        chat: OWNER_PRIVATE.chat,
        ...args,
      }),
      charts: (args = {}) => harness.exports.charts({ chatId: OWNER_PRIVATE.chat.chatId, ...args }),
      playlist: (args = {}) => harness.exports.playlist({
        chatId: OWNER_PRIVATE.chat.chatId,
        sessionId: OWNER_PRIVATE.sessionId,
        chat: OWNER_PRIVATE.chat,
        ...args,
      }),
      report: (args = {}) => harness.exports.report({
        chat: OWNER_PRIVATE.chat,
        sessionId: OWNER_PRIVATE.sessionId,
        ...args,
      }),
      interpret: (args = {}) => harness.exports.interpret({
        chat: OWNER_PRIVATE.chat,
        sessionId: OWNER_PRIVATE.sessionId,
        ...args,
      }),
    },
    rules() {
      return state.rules.flatMap((fn) => {
        const value = fn('private', state.settings)
        if (value === undefined || value === null) return []
        return Array.isArray(value) ? value : [value]
      })
    },
    async command(name, arg, msg = { chatId: 'private:1001', kind: 'private', userId: '1001' }) {
      const found = state.commands.get(name)
      if (!found) throw new Error(`没挂上命令 ${name}`)
      return found.run(arg, msg)
    },
    async dispose() {
      for (const fn of state.disposers) await fn()
    },
    /** 模拟宿主在面板保存设置后发 config 事件（真实宿主：host.js mods.emit('config', cfg, before)）。 */
    emitConfig(cfg = {}, before = {}) {
      for (const fn of state.listeners.get('config') || []) fn(cfg, before)
    },
    get sends() {
      return state.sends
    },
  }

  return harness
}
