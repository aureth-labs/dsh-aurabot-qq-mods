// 萌娘百科（Moegirlpedia）知识库外接 —— 查 ACG 角色 / 作品 / 梗
//
// 主人在 2026-11-10 的要求：「做一个知识库外接插件 外接萌娘百科搜索」
//
// 能用的接口（实测 zh.moegirl.org.cn）：
//   · generator=search + prop=extracts&exintro  搜关键词，一次带回标题和开头一段（唯一好用的搜索路子）
//   · prop=extracts&explaintext                 按标题拿整条正文
//   · action=opensearch                         标题联想（备用）
// 官方把 list=search / list=prefixsearch 关了（action-notallowed），HTML 搜索页直接 403，
// 所以搜索一律走 generator=search。
//
// 还有：本机 FlClash 可能把域名解析成 fake-ip（198.18.x.x），直连会失败。
// 所以留了个 proxy 设置项，填 http://127.0.0.1:7890 就走 CONNECT 隧道。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { URL } from 'node:url'

const UA = 'Aurabot-Moegirl/1.0 (+https://github.com/aureth-labs/dsh-aurabot-qq-mods)'
const CACHE_MAX = 400

// ---------- HTTP（支持 HTTP 代理 CONNECT 隧道） ----------
function httpGet(urlStr, { proxy = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return reject(e) }
    const isHttps = u.protocol === 'https:'
    const port = u.port || (isHttps ? 443 : 80)
    const host = u.hostname
    const reqPath = u.pathname + u.search
    const headers = {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'identity',
    }
    const collect = (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    }
    const fire = (extra = {}) => {
      const mod = isHttps ? https : http
      const req = mod.request({ host, port, path: reqPath, method: 'GET', headers, ...extra }, collect)
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
      req.end()
    }

    if (!proxy) return fire()

    // 走代理：先 CONNECT 建隧道，再在隧道上开 TLS
    let pu
    try { pu = new URL(proxy) } catch (e) { return reject(new Error('代理地址不对：' + proxy)) }
    const cReq = http.request({
      host: pu.hostname,
      port: pu.port || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    })
    cReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('代理拒绝 CONNECT：' + res.statusCode)) }
      if (!isHttps) {
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('请求超时')))
        return fire({ createConnection: () => socket, agent: false })
      }
      const tlsSock = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] }, () => {
        fire({ createConnection: () => tlsSock, agent: false })
      })
      tlsSock.on('error', reject)
      tlsSock.setTimeout(timeoutMs, () => tlsSock.destroy(new Error('请求超时')))
    })
    cReq.on('error', reject)
    cReq.end()
  })
}

const cleanText = (s) =>
  String(s || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

export default {
  id: 'moegirl',
  name: '萌娘百科',
  version: '1.0.0',
  api: 1,
  description: '接萌娘百科：遇到不认识的 ACG 角色、作品、梗，能搜出来并读条目正文（带缓存）。',
  defaults: {
    enabled: true,
    apiBase: 'https://zh.moegirl.org.cn/api.php',
    proxy: '',
    searchLimit: 5,
    maxChars: 1200,
    cacheMinutes: 1440,
    useInGroup: true,
  },
  settings: [
    { key: 'enabled', label: '打开', type: 'switch' },
    { key: 'apiBase', label: 'API 地址', type: 'text', hint: '默认 https://zh.moegirl.org.cn/api.php' },
    { key: 'proxy', label: 'HTTP 代理', type: 'text', placeholder: 'http://127.0.0.1:7890', hint: '直连能通就留空；解析成 fake-ip 时填这个' },
    { key: 'searchLimit', label: '一次搜几条', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'maxChars', label: '正文最多回多少字', type: 'number', min: 200, max: 6000, step: 100 },
    { key: 'cacheMinutes', label: '缓存多久（分钟）', type: 'number', min: 0, max: 10080, step: 10, hint: '0 = 不缓存' },
    { key: 'useInGroup', label: '群里也能查', type: 'switch' },
  ],

  setup(api) {
    const S = () => ({ ...api.defaults, ...api.settings() })
    const log = (m) => { try { api.log.info(m) } catch {} }
    const warn = (m) => { try { api.log.warn(m) } catch {} }

    const dataDir = () => {
      try { return api.dataDir() } catch { return api.dir }
    }
    const cachePath = () => path.join(dataDir(), 'cache.json')

    let cache = {}
    try { cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) || {} } catch { cache = {} }
    let saveTimer = null
    const saveCache = () => {
      if (saveTimer) return
      saveTimer = setTimeout(() => {
        saveTimer = null
        try {
          const keys = Object.keys(cache)
          if (keys.length > CACHE_MAX) {
            keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
            for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k]
          }
          fs.mkdirSync(dataDir(), { recursive: true })
          fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf8')
        } catch (e) { warn('缓存写盘失败：' + e.message) }
      }, 800)
    }

    const cacheGet = (key) => {
      const ttl = Number(S().cacheMinutes || 0) * 60000
      if (!ttl) return null
      const hit = cache[key]
      if (!hit) return null
      if (Date.now() - (hit.at || 0) > ttl) { delete cache[key]; return null }
      return hit.data
    }
    const cacheSet = (key, data) => {
      if (!(Number(S().cacheMinutes || 0) > 0)) return
      cache[key] = { at: Date.now(), data }
      saveCache()
    }

    async function callApi(params) {
      const s = S()
      const qs = new URLSearchParams({ format: 'json', utf8: '1', ...params })
      const url = `${s.apiBase}${s.apiBase.includes('?') ? '&' : '?'}${qs.toString()}`
      const r = await httpGet(url, { proxy: String(s.proxy || '').trim() })
      if (r.status !== 200) throw new Error(`萌娘百科返回 HTTP ${r.status}`)
      let j
      try { j = JSON.parse(r.body) } catch { throw new Error('萌娘百科返回的不是 JSON（可能被拦了）') }
      if (j.error) throw new Error(`萌娘百科接口报错：${j.error.code} ${j.error.info || ''}`.trim())
      return j
    }

    const pageUrl = (title) => `https://zh.moegirl.org.cn/${encodeURIComponent(String(title).replace(/ /g, '_'))}`

    // ---------- 搜索 ----------
    async function search(rawQuery) {
      const s = S()
      const q = String(rawQuery || '').trim()
      if (!q) return { ok: false, message: '要给个词才搜得了' }
      const key = 'search:' + q.toLowerCase()
      const cached = cacheGet(key)
      if (cached) return { ok: true, ...cached, cached: true }

      const j = await callApi({
        action: 'query',
        generator: 'search',
        gsrsearch: q,
        gsrlimit: String(Math.max(1, Math.min(10, Number(s.searchLimit) || 5))),
        prop: 'extracts',
        exintro: '1',
        explaintext: '1',
        exlimit: 'max',
        redirects: '1',
      })
      const pages = j.query?.pages ? Object.values(j.query.pages) : []
      const items = pages
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((p) => ({
          title: p.title,
          pageid: p.pageid,
          snippet: cleanText(p.extract || '').slice(0, 260),
          url: pageUrl(p.title),
        }))
      const data = { query: q, items }
      cacheSet(key, data)
      return { ok: true, ...data }
    }

    // ---------- 读正文 ----------
    async function page(rawTitle, chars) {
      const s = S()
      const title = String(rawTitle || '').trim()
      if (!title) return { ok: false, message: '要给个条目名' }
      const limit = Math.max(200, Math.min(6000, Number(chars) || Number(s.maxChars) || 1200))
      const key = 'page:' + title.toLowerCase()
      let cached = cacheGet(key)
      if (!cached) {
        const j = await callApi({
          action: 'query',
          prop: 'extracts',
          explaintext: '1',
          redirects: '1',
          titles: title,
        })
        const pages = j.query?.pages ? Object.values(j.query.pages) : []
        const p = pages[0]
        if (!p) return { ok: false, message: '没找到这个条目' }
        if (p.missing !== undefined) return { ok: false, message: `萌娘百科没有「${title}」这个条目` }
        cached = { title: p.title, pageid: p.pageid, text: cleanText(p.extract || ''), url: pageUrl(p.title) }
        cacheSet(key, cached)
      }
      const text = cached.text || ''
      return {
        ok: true,
        title: cached.title,
        url: cached.url,
        total: text.length,
        text: text.slice(0, limit),
        truncated: text.length > limit,
      }
    }

    const fmtSearch = (r) => {
      if (!r.ok) return r.message
      if (!r.items.length) return `萌娘百科没搜到「${r.query}」`
      const lines = [`萌娘百科 · 搜「${r.query}」`]
      r.items.forEach((it, i) => {
        lines.push(`${i + 1}. ${it.title}`)
        if (it.snippet) lines.push('   ' + it.snippet.replace(/\n+/g, ' '))
      })
      return lines.join('\n')
    }

    const fmtPage = (r) => {
      if (!r.ok) return r.message
      const tail = r.truncated ? `\n…（还有 ${r.total - r.text.length} 字，要看完整的说一声）` : ''
      return `${r.title}｜${r.url}\n\n${r.text}${tail}`
    }

    // ---------- 工具 ----------
    api.tool(() => {
      const s = S()
      if (!s.enabled) return []
      return [
        api.defineTool({
          name: 'moegirl_search',
          description: '在萌娘百科搜 ACG 相关的东西：动漫游戏角色、作品、声优、梗、公司。遇到不认识的二次元名词就用它查，拿到条目名之后再用 moegirl_page 读正文。',
          properties: {
            query: { type: 'string', description: '要搜的词，比如「初音未来」「东方Project」「草」' },
          },
          required: ['query'],
          execute: async ({ query }) => {
            try {
              const r = await search(query)
              return { ok: r.ok, message: fmtSearch(r) }
            } catch (e) {
              return { ok: false, message: '萌娘百科搜不了：' + e.message }
            }
          },
        }),
        api.defineTool({
          name: 'moegirl_page',
          description: '读萌娘百科某个条目的正文（开头部分）。先 moegirl_search 拿到准确条目名，再读；正文太长时只回开头，需要更多可以说「再给我一些」。',
          properties: {
            title: { type: 'string', description: '条目名，要准确，比如「初音未来」' },
            chars: { type: 'number', description: '想读多少字，默认按设置（约 1200）' },
          },
          required: ['title'],
          execute: async ({ title, chars }) => {
            try {
              const r = await page(title, chars)
              return { ok: r.ok, message: fmtPage(r) }
            } catch (e) {
              return { ok: false, message: '萌娘百科读不了：' + e.message }
            }
          },
        }),
      ]
    })

    // ---------- 命令 ----------
    api.command({
      name: '萌娘',
      aliases: ['萌百', 'moegirl'],
      desc: '查萌娘百科：/萌娘 初音未来（给两个词就搜，给准确条目名就读正文）',
      run: async (arg) => {
        const q = String(arg || '').trim()
        if (!q) return '用法：/萌娘 初音未来'
        try {
          const p = await page(q)
          if (p.ok && p.text) return fmtPage(p)
          const r = await search(q)
          return fmtSearch(r)
        } catch (e) {
          return '萌娘百科查询失败：' + e.message
        }
      },
    })

    api.rule((kind) => {
      const s = S()
      if (!s.enabled) return ''
      if (kind === 'social' && !s.useInGroup) return ''
      return '遇到不认识或不熟的动漫游戏角色、作品、梗，可以查萌娘百科：先用 moegirl_search 搜条目名，再用 moegirl_page 读正文。只查真实存在的东西，别编。'
    })

    // ---------- 给面板用的接口 ----------
    api.route('/state', async () => {
      const s = S()
      return {
        ok: true,
        enabled: s.enabled,
        apiBase: s.apiBase,
        proxy: s.proxy || '',
        cacheEntries: Object.keys(cache).length,
        settings: { searchLimit: s.searchLimit, maxChars: s.maxChars, cacheMinutes: s.cacheMinutes, useInGroup: s.useInGroup },
      }
    })
    // req 是 Node 的 IncomingMessage，参数要自己从 url 里解
    const qsOf = (req) => {
      try { return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams } catch { return new URLSearchParams() }
    }
    api.route('/search', async (req) => {
      const sp = qsOf(req)
      const q = sp.get('q') || sp.get('query') || ''
      try { const r = await search(q); return { ok: r.ok, result: r, text: fmtSearch(r), message: r.message || '' } } catch (e) { return { ok: false, message: e.message } }
    })
    api.route('/page', async (req) => {
      const sp = qsOf(req)
      const t = sp.get('title') || sp.get('t') || ''
      try { const r = await page(t); return { ok: r.ok, result: r, text: fmtPage(r), message: r.message || '' } } catch (e) { return { ok: false, message: e.message } }
    })
    api.route('/test', async () => {
      try {
        const r = await search('初音未来')
        return { ok: r.ok, count: r.items?.length || 0, first: r.items?.[0]?.title || '', sample: fmtSearch(r).slice(0, 400) }
      } catch (e) {
        return { ok: false, message: e.message }
      }
    })
    api.route('/clearcache', async () => {
      cache = {}
      try { fs.unlinkSync(cachePath()) } catch {}
      return { ok: true }
    })

    log('萌娘百科已就绪')
    return {}
  },
}
