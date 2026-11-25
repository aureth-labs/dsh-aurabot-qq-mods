// 星图（识海）：把 Aurabot 的记忆库渲染成可交互的星图。
// 页面随模块分发，数据来自 Aurabot 自己的 memory 模块；取数逻辑在 lib/graph.mjs，这里只做路由和缓存。
//
// 关于隐私：/graph 和 /node 会把记忆正文吐出来，所以默认是**关着的**，
// 必须在面板里显式打开才能看；打开后也只给同源页面读，且默认只返回主人自己的记忆。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGraph } from './lib/graph.mjs'

const TTL = 15000
let cache = { at: 0, data: null, scope: '' }

/** 面板里的开关。默认全关 —— 装好不等于已经公开。 */
export const DEFAULTS = {
  enabled: false,   // 数据接口总开关
  scope: 'owner',   // owner = 只主人相关；all = 全量
}

/** 清掉缓存（测试用；15 秒缓存对页面足够）。 */
export function resetCache() {
  cache = { at: 0, data: null, scope: '' }
}

/** 读设置。没装的旧配置、或者 mock 里没有 settings，都退到「关闭」。 */
export function settingsOf(api) {
  let raw = null
  try { raw = typeof api.settings === 'function' ? api.settings() : null } catch { raw = null }
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  return {
    enabled: s.enabled === true,
    scope: s.scope === 'all' ? 'all' : 'owner',
  }
}

/** 同源判定：回环 / 局域网 / 面板对外域名放行。 */
function hostAllowed(api, h) {
  const host = String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
  if (host.startsWith('127.')) return true
  if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return true
  try {
    const pub = String(api.config?.()?.security?.publicHostname || '').trim().toLowerCase()
    if (pub && host === pub) return true
  } catch {}
  return false
}

/**
 * 只要同源。DSH 的 csrfBlocked 只拦写方法，GET 是放行的，
 * 所以「打开一个链接就能读到全部记忆」这条路必须自己堵。
 * 非浏览器客户端（不带 Origin / Sec-Fetch-Site）放行 —— 它们不是 CSRF 载体。
 */
export function sameOriginOk(api, req) {
  const site = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
  const origin = String(req?.headers?.origin || '').trim()
  if (origin) {
    let oh = ''
    try { oh = new URL(origin).hostname } catch { return false }
    if (!hostAllowed(api, oh)) return false
  }
  return true
}

function ownerOf(api) {
  try { return String(api.config?.()?.ownerQQ || '').trim() } catch { return '' }
}

function graphOf(api, s) {
  // scope 变了要重建，不然切换后还是旧数据
  if (cache.data && cache.scope === s.scope && Date.now() - cache.at < TTL) return cache.data
  cache = {
    at: Date.now(),
    scope: s.scope,
    data: buildGraph(api.use('memory'), { owner: ownerOf(api), all: s.scope === 'all' }),
  }
  return cache.data
}

/** 数据接口的统一闸：关着 / 跨站，都直接拒。 */
function dataGuard(api, req) {
  const s = settingsOf(api)
  if (!s.enabled) {
    return { deny: { ok: false, closed: true, message: '星图的记忆数据默认关闭。请在面板「星图」里打开「显示记忆」后再看。' } }
  }
  if (!sameOriginOk(api, req)) {
    return { deny: { ok: false, denied: true, message: '只接受同源请求（防跨站读取记忆）' } }
  }
  return { s }
}

export default {
  id: 'starmap',
  name: '星图',
  version: '1.1.0',
  api: 1,
  description: '把 Aurabot 自己的记忆渲染成可交互的星图，两种看法：关系星图看结构，银河云图看时间。',
  panel: 'panel.js',
  setup(api) {
    // 三种页面，用 ?v= 区分：
    //   不带 v      → 外壳（首次打开的选择界面 + 右下角切换键）
    //   ?v=map      → 原来的力导向星图
    //   ?v=galaxy   → 银河云图（旋臂盘面）
    // 外壳用 iframe 装这两个引擎，两套渲染互不干扰。
    // 页面本身不含数据，所以不设总开关；数据由 /graph 那一道闸把关。
    api.route('/page', async (req, res) => {
      try {
        const q = String(req.url || '').split('?')[1] || ''
        const v = new URLSearchParams(q).get('v')
        const file = v === 'map' ? 'map.html' : v === 'galaxy' ? 'galaxy.html' : 'page.html'
        const html = readFileSync(join(api.dir, 'assets', file))
        api.core.http.send(res, 200, html, 'text/html; charset=utf-8')
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    api.route('/graph', async (req) => {
      const g = dataGuard(api, req)
      if (g.deny) return g.deny
      const data = graphOf(api, g.s)
      return { ok: true, nodes: data.nodes, links: data.links, count: data.nodes.length, scope: g.s.scope }
    })

    api.route('/node', async (req) => {
      const g = dataGuard(api, req)
      if (g.deny) return g.deny
      const q = String(req?.url || '').split('?')[1] || ''
      const id = new URLSearchParams(q).get('id') || ''
      if (!id) return { ok: false, error: 'missing id' }
      const data = graphOf(api, g.s)
      const text = data.texts.get(id)
      if (!text) return { ok: false, error: 'not found' }
      return { ok: true, id, name: text.label, text: text.text }
    })

    // 面板读写设置。写操作要求同源 —— 不然一个跨站请求就能把「显示记忆」打开。
    api.route('/settings', async (req) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (method === 'GET' || method === 'HEAD') {
        return { ok: true, ...settingsOf(api), defaults: DEFAULTS }
      }
      if (!sameOriginOk(api, req)) {
        return { ok: false, denied: true, message: '只接受同源请求（防跨站打开记忆）' }
      }
      try {
        let body = {}
        try { body = (await api.core.http.body(req)) || {} } catch { body = {} }
        const patch = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (body.scope === 'owner' || body.scope === 'all') patch.scope = body.scope
        if (!Object.keys(patch).length) return { ok: false, message: '没有收到设置字段' }
        if (typeof api.saveSettings === 'function') api.saveSettings(patch)
        resetCache()
        return { ok: true, saved: Object.keys(patch), ...settingsOf(api) }
      } catch (error) {
        return { ok: false, message: error?.message || String(error) }
      }
    })

    // 健康检查只回数量，不回内容，但同样受总开关约束（关着就说关着）
    api.route('/health', async (req) => {
      const s = settingsOf(api)
      if (!s.enabled) return { ok: true, enabled: false, source: 'aurabot-memory' }
      if (!sameOriginOk(api, req)) return { ok: false, denied: true, message: '只接受同源请求' }
      const data = graphOf(api, s)
      return { ok: true, enabled: true, scope: s.scope, source: 'aurabot-memory', nodes: data.nodes.length, links: data.links.length }
    })
  },
}
