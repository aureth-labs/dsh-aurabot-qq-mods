// 热榜取数链路：直连 tophub 节点页（一级）→ 60s 聚合接口（二级兜底）→ 结果缓存 + 限速。
// 设计要点（2026-11-02 实测）：
// - tophub.today 对脚本直连普遍 403（WAF 按 TLS 指纹拦，换 UA 没用），所以直连失败是常态，
//   必须优雅跳过，绝不能让一轮巡游因为单点失败而中断；
// - 60s 聚合接口（vikiboss/60s，viki 镜像）实测稳定可用，但高频会 429，
//   所以全局限速 + 每节点失败冷却，一次巡游只碰 2~3 个节点；
// - 所有取数经 fetchImpl 注入（生产 = globalThis.fetch，测试 = 假实现），不打死网络。

import { readFileSync as _readFile, writeFileSync as _writeFile, mkdirSync } from 'node:fs'

export const SIXTY_BASE = 'https://60s-api.viki.moe/v2'

/** 内置榜单目录：name 用于面板/工具按名选；sixty 是 60s 接口端点；tophub 是直连节点 id（尽力而为） */
export const BUILTIN_NODES = [
  { name: '微博热搜', sixty: 'weibo', tophub: 'K7GdaMgdQy' },
  { name: '知乎热榜', sixty: 'zhihu', tophub: 'K7Gd48zONV' },
  { name: '抖音热点', sixty: 'douyin', tophub: 'Y2KeDGQdNP' },
  { name: '今日头条', sixty: 'toutiao' },
  { name: 'B站热门', sixty: 'bili' },
  { name: '60秒读懂世界', sixty: '60s' },
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TTL_MS = 30 * 60_000          // 缓存有效期：同一个榜半小时内复用
const GAP_MS = 2_500                // 两次真实网络请求的最小间隔（60s 接口怕 429）
const COOL_MS = 10 * 60_000         // 单节点失败后的冷却时间

/** 解析 tophub 节点页 HTML，抽出榜单条目（结构变化时返回空数组，交由上层走兜底） */
export function parseTophub(html) {
  const out = []
  const rows = String(html || '').match(/<tr[\s>][\s\S]*?<\/tr>/g) || []
  for (const row of rows) {
    const a = row.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{1,120})<\/a>/)
    if (!a) continue
    const title = a[2].replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
    if (!title) continue
    const hot = (row.match(/class="item2"[^>]*>([^<]*)</) || [])[1] || ''
    out.push({ title, url: a[1], hot: hot.trim() })
  }
  return out.slice(0, 30)
}

/** 一条条目够不够格进榜单（标题非空、长度合理） */
function sane(it) {
  const t = String(it?.title || '').trim()
  return t.length >= 2 && t.length <= 120
}

/**
 * 创建取数器。
 * @param {object} o
 * @param {string} o.cacheDir    缓存目录（放 api.dataDir('cache')，禁写模块源码目录）
 * @param {object} [o.log]      api.log（可缺）
 * @param {Function} [o.fetchImpl]  注入的 fetch（测试用）
 * @param {object} [o.fs]       注入的 node:fs（测试用），缺省真读真写
 */
export function createFetcher({ cacheDir, log, fetchImpl, fs, gapMs = GAP_MS, coolMs = COOL_MS } = {}) {
  const f = fetchImpl || ((...args) => globalThis.fetch(...args))
  const store = fs || { readFile: _readFile, writeFile: _writeFile }
  const read = (p) => { try { return store.readFile(p, 'utf8') } catch { return '' } }
  const write = (p, s) => { try { mkdirSync(cacheDir, { recursive: true }); store.writeFile(p, s) } catch { /* 缓存写失败不影响取数 */ } }
  const cachePath = (key) => `${cacheDir}/${encodeURIComponent(String(key))}.json`

  let lastHit = 0
  const cooldown = new Map() // nodeKey → 冷却到的时间戳
  const memCache = new Map() // nodeKey → { ts, items, source }（内存层，测试不落盘也快）

  /** 限速等待：距离上次真实请求不足 GAP_MS 就等够 */
  async function pace() {
    const wait = lastHit + gapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastHit = Date.now()
  }

  async function getJson(url) {
    await pace()
    const r = await f(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(12_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    const data = j?.data
    // 两种结构都要认：榜单端点给数组 [{title,hot_value,link}]；
    // 「60秒读懂世界」这类日报端点给 { date, news:[…] } 或纯字符串数组。
    if (Array.isArray(data)) {
      return data.map((x) => (typeof x === 'string' ? { title: x } : x))
    }
    if (data && Array.isArray(data.news)) {
      return data.news.map((x) => (typeof x === 'string' ? { title: x } : { title: x?.title || x?.text || '', url: x?.link || '' }))
    }
    throw new Error('60s 返回格式不对')
  }

  /** 统一条目形状：榜单端点用 hot_value/link，日报用 title/news，全部归一成 { title, url, hot } */
  function normalize(raw) {
    const title = String(raw?.title || raw?.name || raw?.word || '').trim()
    return {
      title,
      url: String(raw?.url || raw?.link || ''),
      hot: raw?.hot_value != null ? String(raw.hot_value) : (raw?.hot != null ? String(raw.hot) : ''),
    }
  }

  async function getTophub(nodeId) {
    await pace()
    const r = await f(`https://tophub.today/n/${nodeId}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Referer': 'https://tophub.today/' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const items = parseTophub(await r.text())
    if (!items.length) throw new Error('页面里没解析出条目（可能被 WAF 挡了）')
    return items
  }

  /** 从缓存读（内存层优先，再落盘层）；fresh=true 只要没过期的 */
  function cacheGet(key, fresh) {
    const mem = memCache.get(key)
    if (mem && (!fresh || Date.now() - mem.ts < TTL_MS)) return mem
    const raw = read(cachePath(key))
    if (!raw) return null
    try {
      const rec = JSON.parse(raw)
      if (!Array.isArray(rec.items) || !rec.items.length) return null
      if (fresh && Date.now() - rec.ts >= TTL_MS) return null
      memCache.set(key, rec)
      return rec
    } catch { return null }
  }

  function cachePut(key, rec) {
    memCache.set(key, rec)
    write(cachePath(key), JSON.stringify(rec))
  }

  /** 名字或端点名 → 榜单目录项；未知名字先查目录，再当作 tophub 节点 id 尝试 */
  function resolve(name) {
    const n = String(name || '').trim()
    const hit = BUILTIN_NODES.find((x) => x.name === n || x.sixty === n)
    if (hit) return hit
    if (/^[\w-]{6,20}$/.test(n)) return { name: n, tophub: n } // 形如节点 id 的自定义条目
    return null
  }

  /**
   * 拉一个榜。成功返回 { ok:true, source, items }；失败返回 { ok:false, error }（不抛异常，巡游循环好写）。
   * @param {string} nameOrId  榜名（内置目录）或 tophub 节点 id
   * @param {object} [o] { fresh: 强制绕缓存 }
   */
  async function hot(nameOrId, o = {}) {
    const node = resolve(nameOrId)
    if (!node) return { ok: false, error: `不认识这个榜：${nameOrId}` }
    const key = node.name

    const cached = o.fresh ? null : cacheGet(key, true)
    if (cached) return { ok: true, source: cached.source, cached: true, items: cached.items }

    if ((cooldown.get(key) || 0) > Date.now()) {
      const stale = cacheGet(key, false)
      if (stale) return { ok: true, source: stale.source, cached: true, stale: true, items: stale.items }
      return { ok: false, error: '刚失败过，冷却中' }
    }

    const tryOrder = []
    if (node.tophub) tryOrder.push(['tophub', () => getTophub(node.tophub)])
    if (node.sixty) tryOrder.push(['60s', () => getJson(`${SIXTY_BASE}/${node.sixty}`)])

    const errors = []
    for (const [source, fn] of tryOrder) {
      try {
        const items = (await fn()).map(normalize).filter(sane).slice(0, 30)
        if (!items.length) throw new Error('取到 0 条')
        const rec = { ts: Date.now(), source, items }
        cachePut(key, rec)
        cooldown.delete(key)
        return { ok: true, source, items }
      } catch (e) {
        errors.push(`${source}: ${e.message}`)
      }
    }
    cooldown.set(key, Date.now() + coolMs)
    const stale = cacheGet(key, false)
    if (stale) return { ok: true, source: stale.source, cached: true, stale: true, items: stale.items }
    log?.warn?.(`热榜「${node.name}」取数失败：${errors.join('；')}`)
    return { ok: false, error: errors.join('；') }
  }

  /**
   * 基础控件搜索：最多翻 maxNodes 个榜（优先已缓存的），标题含关键词就算命中。
   * 返回 { ok, hits: [{ node, title, url }], error? }
   */
  async function search(keyword, o = {}) {
    const kw = String(keyword || '').trim()
    if (!kw) return { ok: false, error: '关键词是空的' }
    const names = (o.names || BUILTIN_NODES.map((x) => x.name)).slice(0, o.maxNodes || 4)
    const hits = []
    for (const name of names) {
      // 先看缓存（不发请求），没有缓存的榜最多再真拉两个
      const node = resolve(name)
      if (!node) continue
      const key = node.name
      let rec = cacheGet(key, true)
      if (!rec) {
        if ((o._liveLeft ??= (o.liveNodes ?? 2)) <= 0) continue
        o._liveLeft--
        const r = await hot(name)
        if (!r.ok) continue
        rec = { ts: Date.now(), source: r.source, items: r.items }
      }
      for (const it of rec.items) {
        if (it.title.includes(kw)) hits.push({ node: key, title: it.title, url: it.url || '' })
        if (hits.length >= (o.limit || 10)) return { ok: true, hits }
      }
    }
    return { ok: true, hits }
  }

  return { hot, search, resolve, nodes: () => BUILTIN_NODES }
}
