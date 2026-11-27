// webdig —— 把一个网站的「数据」挖出来，不用一张张点开。
//
// 用法：
//   node webdig.mjs <网址> [--out 目录] [--max 20] [--delay 800] [--deep]
//   node webdig.mjs https://example.com --out D:\tmp\dig
//
// 做四件事：
//   0. 先看 robots.txt，明确禁止的路径直接跳过（不硬闯）
//   1. 抓首页 HTML，取出内嵌数据（ld+json / __NEXT_DATA__ / __INITIAL_STATE__）
//   2. 顺着脚本再扫一层，把 fetch('...json')、api 路径这类找出来
//   3. 把找到的 json / 数据地址都抓一遍，落盘 + 汇总成一份 summary.json
//
// 默认每次请求之间停 800ms，不连着砸人服务器。
// 只用 Node 自带能力，不需要装包，不走浏览器。
// 遇到需要登录、需要跑 JS 才出内容的站，抓不到东西时会如实说抓不到，不编。

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--'))
if (!url) {
  console.error('用法：node webdig.mjs <网址> [--out 目录] [--max 20] [--delay 800] [--deep]')
  process.exit(1)
}
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const OUT = opt('out', join(process.cwd(), 'webdig-out'))
const MAX = Number(opt('max', 20))
const DELAY = Math.max(0, Number(opt('delay', 800)))
const DEEP = args.includes('--deep')

mkdirSync(OUT, { recursive: true })

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// robots.txt：明确 Disallow 的路径不抓
const robots = { rules: [], exists: false, ttl: 0 }
async function loadRobots(base) {
  const u = new URL('/robots.txt', base).href
  const r = await get(u, { timeout: 15000 })
  if (!r.ok || !r.text) return
  robots.exists = true
  const lines = r.text.split(/\r?\n/)
  let applies = false
  for (const line of lines) {
    const t = line.replace(/#.*/, '').trim()
    if (!t) continue
    const m = t.match(/^([a-z-]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'user-agent') applies = /^\*$/.test(val) || /webdig|bot|spider|crawler/i.test(val) || val === '*'
    else if (applies && key === 'disallow' && val) robots.rules.push(val)
    else if (applies && key === 'crawl-delay' && /^\d+$/.test(val)) robots.ttl = Number(val) * 1000
  }
}
function robotsBlocked(u) {
  if (!robots.exists || !robots.rules.length) return false
  let path = '/'
  try { const o = new URL(u); path = o.pathname + o.search } catch { return false }
  return robots.rules.some((rule) => path.startsWith(rule))
}

async function get(u, { timeout = 30000, as = 'text' } = {}) {
  if (robotsBlocked(u)) return { ok: false, blocked: true, error: 'robots.txt 里明确禁止抓这个路径' }
  if (DELAY) await sleep(robots.ttl || DELAY)
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: new URL(u).origin },
      signal: ctl.signal,
      redirect: 'follow',
    })
    const buf = Buffer.from(await r.arrayBuffer())
    if (as === 'buffer') return { ok: true, status: r.status, type: r.headers.get('content-type') || '', buf }
    return { ok: true, status: r.status, type: r.headers.get('content-type') || '', text: buf.toString('utf8'), len: buf.length }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  } finally {
    clearTimeout(t)
  }
}

const abs = (u, base) => {
  try { return new URL(u, base).href } catch { return '' }
}
const sameOrigin = (u, base) => {
  try { return new URL(u).origin === new URL(base).origin } catch { return false }
}

// 从一段 JS 里挖出可能的接口地址。
// 坑：fetch('data.json') 的相对路径是按「页面地址」算的，不是按「脚本地址」算的。
// 所以两种 base 都要试，只按脚本 base 会多拼一层目录（assets/data.json → 404）。
function digJs(src, base, pageBase = null) {
  const out = new Set()
  const page = pageBase || base
  const bases = [page, base].filter((b, i, a) => b && a.indexOf(b) === i)
  const push = (s) => {
    // 带目录的相对路径（比如 'assets/data.json'）按脚本地址算更准；
    // 纯文件名（比如 'data.json'）优先按「页面地址」算——脚本地址那版通常多拼一层 assets/（404）。
    const bare = !s.includes('/')
    for (const b of bases) {
      const a = abs(s, b)
      if (a && sameOrigin(a, b)) out.add(a)
      if (bare) break
    }
  }

  // fetch('x'), fetch("x"), fetch(`x`)
  for (const m of src.matchAll(/fetch\(\s*[`'"]([^`'"]{2,200})[`'"]/g)) push(m[1])
  // axios / $.get / http.get
  for (const m of src.matchAll(/(?:axios\.get|\.\.\.?get|request)\(\s*[`'"]([^`'"]{2,200})[`'"]/g)) push(m[1])
  // 字符串里明显是 json / api / data 的路径
  for (const m of src.matchAll(/[`'"]([\w\-./]{2,120}\.(?:json|jsonp|txt|csv))[`'"]/g)) push(m[1])
  for (const m of src.matchAll(/[`'"]([/a-z0-9\-_.]{1,60}\/(?:api|data|list|query|search)[/a-z0-9\-_.?=&]{0,80})[`'"]/gi)) push(m[1])
  return [...out]
}

// 从 HTML 里挖脚本和链接
function digHtml(html, base) {
  const scripts = new Set()
  const links = new Set()
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) { const a = abs(m[1], base); if (a) scripts.add(a) }
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.(?:css|json))["']/gi)) { const a = abs(m[1], base); if (a) links.add(a) }
  for (const m of html.matchAll(/["']([^"']+\/(?:data|api)[^"']*\.(?:json|jsonp))["']/gi)) { const a = abs(m[1], base); if (a && sameOrigin(a, base)) scripts.add(a) }
  // inline 脚本里也可能直接写着数据地址
  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]{0,200000}?)<\/script>/gi)].map((m) => m[1]).join('\n')
  const fromInline = digJs(inline, base)
  return { scripts: [...scripts, ...fromInline], links: [...links] }
}

// 页面里内嵌的结构化数据：ld+json、__NEXT_DATA__、__INITIAL_STATE__、window.__NUXT__
// 这类东西不用猜接口，页面自己就带着整份内容，命中率比扫接口高得多。
function embeddedData(html, base) {
  const out = []
  const tryParse = (raw, label) => {
    const s = String(raw || '').trim()
    if (!s || s[0] !== '{' && s[0] !== '[') return
    try { out.push({ label, data: JSON.parse(s) }) } catch {}
  }
  // ld+json
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) tryParse(m[1], 'ld+json')
  // next.js
  const nd = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (nd) tryParse(nd[1], '__NEXT_DATA__')
  // nuxt / 各类 __INITIAL_STATE__
  for (const m of html.matchAll(/window\.(__INITIAL_STATE__|__NUXT__|__DATA__|__PRELOADED_STATE__)\s*=\s*([\s\S]{0,300000}?)<\/script>/gi)) {
    let s = m[2].trim().replace(/;$/, '')
    // 有些是把函数包进去的，取不到就不硬来
    tryParse(s, 'window.' + m[1])
  }
  return out
}

function looksLikeJson(text) {
  const s = String(text || '').trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null
  try { return JSON.parse(s) } catch { return null }
}

// 从 json 里挑出「像内容」的字段，帮后续读的时候不用瞎猜
function skimJson(obj, depth = 0, path = '') {
  const hits = []
  if (depth > 4 || obj === null || typeof obj !== 'object') return hits
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === 'object') hits.push({ path: path || '(root)', kind: 'array', count: obj.length, keys: Object.keys(obj[0]).slice(0, 20) })
    return hits
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      hits.push({ path: p, kind: 'array', count: v.length, keys: Object.keys(v[0]).slice(0, 20) })
    } else if (v && typeof v === 'object') hits.push(...skimJson(v, depth + 1, p))
  }
  return hits
}

const summary = { url, at: new Date().toISOString(), origin: '', pages: [], jsonFiles: [], textFiles: [], arrays: [], notes: [] }

log('▸ 抓首页：' + url)
await loadRobots(new URL(url).origin)
summary.robots = { exists: robots.exists, disallow: robots.rules }
log(`  robots.txt：${robots.exists ? '有，禁止 ' + robots.rules.length + ' 条路径' : '没有（404）'}`)
const home = await get(url)
if (!home.ok) {
  console.error('首页抓不到：' + home.error)
  process.exit(2)
}
summary.origin = new URL(url).origin
summary.status = home.status
summary.homeBytes = home.len || 0
writeFileSync(join(OUT, 'index.html'), home.text || '')

const { scripts, links } = digHtml(home.text || '', url)
log(`  首页 ${summary.homeBytes} 字节，发现脚本 ${scripts.length} 个、样式/链接 ${links.length} 个`)

// 先看页面自己带不带数据（命中率最高的那条路）
const embedded = embeddedData(home.text || '', url)
for (const e of embedded) {
  const file = join(OUT, 'embedded-' + e.label.replace(/[^\w.\-]/g, '_') + '.json')
  writeFileSync(file, JSON.stringify(e.data, null, 2))
  summary.jsonFiles.push({ url: url + ' (内嵌 ' + e.label + ')', file, bytes: JSON.stringify(e.data).length, arrays: skimJson(e.data) })
  for (const a of skimJson(e.data)) summary.arrays.push({ from: '内嵌 ' + e.label, ...a })
  log(`  ✓ 内嵌数据 ${e.label}（${JSON.stringify(e.data).length} 字节）`)
}

// 抓脚本并二次挖掘
const candidates = new Set(scripts.filter((s) => s.endsWith('.js') || s.includes('?')))
const found = new Set()
for (const s of [...candidates].slice(0, 30)) {
  const r = await get(s)
  if (!r.ok || !r.text) continue
  const name = s.split('/').pop().split('?')[0] || 'script.js'
  writeFileSync(join(OUT, 'js-' + name.replace(/[^\w.\-]/g, '_')), r.text)
  summary.pages.push({ url: s, bytes: r.text.length })
  const more = digJs(r.text, s, url)
  for (const u of more) found.add(u)
  if (DEEP) {
    // 再深一层：把新发现的 js 也扒
    for (const u of more.filter((x) => x.endsWith('.js')).slice(0, 10)) candidates.add(u)
  }
}

// 脚本之外，HTML 里直接写的数据地址也算
for (const u of digHtml(home.text || '', url).scripts) found.add(u)

log(`  从脚本里挖到 ${found.size} 个数据地址`)

// 逐个抓数据地址
const picked = [...found].filter((u) => !u.endsWith('.css')).slice(0, MAX)
for (const u of picked) {
  const r = await get(u)
  if (!r.ok) { summary.notes.push(`抓不到 ${u}：${r.error}`); continue }
  const isJson = /\bjson\b/i.test(r.type) || u.includes('.json')
  const parsed = isJson ? looksLikeJson(r.text || '') : null
  const name = u.split('/').pop().split('?')[0] || 'data'
  if (parsed) {
    const file = join(OUT, 'data-' + name.replace(/[^\w.\-]/g, '_'))
    writeFileSync(file, JSON.stringify(parsed, null, 2))
    summary.jsonFiles.push({ url: u, file, bytes: (r.text || '').length, arrays: skimJson(parsed) })
    log(`  ✓ JSON ${u}（${(r.text || '').length} 字节）`)
    for (const a of skimJson(parsed)) summary.arrays.push({ from: u, ...a })
  } else if (isJson) {
    summary.notes.push(`看起来是 json 但解析不了：${u}`)
  } else {
    const file = join(OUT, 'raw-' + name.replace(/[^\w.\-]/g, '_'))
    writeFileSync(file, r.text || '')
    summary.textFiles.push({ url: u, file, bytes: (r.text || '').length })
    log(`  · 其他 ${u}（${(r.text || '').length} 字节）`)
  }
}

if (!summary.jsonFiles.length) {
  summary.notes.push('没直接抓到 JSON：这个站可能要跑 JS 才出内容，或者数据藏在接口后面需要登录。')
}
// 页面太小、或者出现典型拦截字样，基本是被挡了，别让人误以为页面本身没内容
const body = (home.text || '').toLowerCase()
if ((summary.homeBytes || 0) < 6000) summary.notes.push(`首页只有 ${summary.homeBytes} 字节，很可能是被反爬拦了（返回了拦截页而不是正文）`)
if (/captcha|验证码|安全验证|访问过于频繁|access denied|forbidden|人机验证/.test(body)) summary.notes.push('首页里出现验证码/拦截字样，这个站挡得太狠，直连抓不到')

writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
log('')
log('▸ 落盘：' + OUT)
log(`  JSON ${summary.jsonFiles.length} 个、其他 ${summary.textFiles.length} 个`)
for (const a of summary.arrays.slice(0, 12)) log(`  内容线索 ${a.from.split('/').pop()} → ${a.path}（${a.count} 条，字段：${a.keys.join(', ')}）`)
if (summary.notes.length) for (const n of summary.notes) log('  ! ' + n)
