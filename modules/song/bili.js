// B 站音源（翻唱用）：搜索 → 锁分 P → playurl 取 DASH 音频流 → ffmpeg 转 mp3。
//
// 为什么走 B 站：网易云没会员时很多歌下不了 / 只有翻唱版；B 站上官方 MV、搬运、
// 动态歌词版都齐全，登录 Cookie 下还能拿到 192k 音轨。这里只取音频流（几 MB），
// 不像豆包 video-extract 那样先下一整个 mp4 再抽音轨。
//
// WBI 签名算法抄的 57Darling02/astrbot_plugin_bili_player 的 core/bilibili.py：
//   nav 拿 img_key/sub_key → 按固定 64 位置换 → 取前 32 位 → 参数排序后
//   md5(query + mixin) 得到 w_rid。参数值里的 !'()* 要滤掉。

import { createHash } from 'node:crypto'
import { statSync, writeFileSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'

const API = 'https://api.bilibili.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 62, 6, 63, 57, 20, 34, 52, 59, 11, 36, 44,
]

// 「翻唱里当音源」最怕这几类：鬼畜/合集/直播切片/现场/伴奏，分出来全是脏的
const BAD = /(翻唱|cover|鬼畜|remix|dj|合集|串烧|联唱|直播|切片|剪辑|混剪|解说|reaction|钢琴|纯音乐|伴奏|instrumental|karaoke|现场|演唱会|\blive\b|片段|竖屏|竖版|教学|教程|盘点|top\s*\d|排行榜|花絮|预告|配音|配音剧|广播剧)/i
const GOOD = /(官方|原唱|mv|music\s*video|高清|4k|1080|无损|hires|完整版|歌词|lyrics|正片|单曲)/i

const jar = new Map()
let wbiCache = { at: 0, key: '' }

/** 从 Set-Cookie 里捡 buvid3 这类风控 Cookie，后面的请求一起带上。 */
function absorb(res) {
  let list = []
  try { list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [] } catch (error) {}
  if (!list.length) {
    const raw = res.headers.get('set-cookie')
    if (raw) list = [raw]
  }
  for (const line of list) {
    const pair = String(line).split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

function cookieHeader(base) {
  const parts = []
  const seen = new Set()
  for (const [k, v] of jar) { parts.push(`${k}=${v}`); seen.add(k) }
  for (const seg of String(base || '').split(';')) {
    const s = seg.trim()
    if (!s) continue
    const k = s.split('=')[0].trim()
    if (!seen.has(k)) parts.push(s)
  }
  return parts.join('; ')
}

async function get(url, { cookie = '', referer = 'https://www.bilibili.com/', timeout = 20_000 } = {}) {
  const headers = {
    'user-agent': UA,
    referer,
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
  }
  const ck = cookieHeader(cookie)
  if (ck) headers.cookie = ck
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  absorb(res)
  return res
}

function enc(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (m) => '%' + m.charCodeAt(0).toString(16).toUpperCase())
}

function signWbi(params, mixin) {
  const filtered = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    filtered[k] = String(v).replace(/[!'()*]/g, '')
  }
  filtered.wts = String(Math.floor(Date.now() / 1000))
  const keys = Object.keys(filtered).sort()
  const query = keys.map((k) => `${enc(k)}=${enc(filtered[k])}`).join('&')
  const wRid = createHash('md5').update(query + mixin).digest('hex')
  return query + '&w_rid=' + wRid
}

/** 没有 buvid3/4 时 search/playurl 会只返回 v_voucher（风控）；先从 finger/spi 领一对。 */
async function ensureBuvid(cookie) {
  if (jar.has('buvid3') || /(?:^|;\s*)buvid3=/i.test(String(cookie || ''))) return
  try {
    const res = await fetch(`${API}/x/frontend/finger/spi`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(10_000),
    })
    const j = await res.json()
    if (j?.data?.b_3) jar.set('buvid3', String(j.data.b_3))
    if (j?.data?.b_4) jar.set('buvid4', String(j.data.b_4))
  } catch (error) { /* 领不到就照旧试，失败会走错误分支 */ }
}

/** nav 拿 WBI key（10 分钟缓存；-403/-352 时由调用方重试一次）。 */
async function wbiKey(cookie, force = false) {
  if (!force && wbiCache.key && Date.now() - wbiCache.at < 10 * 60_000) return wbiCache.key
  await ensureBuvid(cookie)
  const res = await get(`${API}/x/web-interface/nav`, { cookie })
  const j = await res.json()
  const img = String(j?.data?.wbi_img?.img_url || '')
  const sub = String(j?.data?.wbi_img?.sub_url || '')
  if (!img || !sub) throw new Error(`拿不到 B 站签名 key（${j?.code} ${j?.message || ''}）`)
  const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0]
  const mixed = MIXIN.map((i) => raw[i]).filter((c) => c !== undefined).join('')
  if (mixed.length < 32) throw new Error('B 站返回的签名 key 不合法')
  wbiCache = { at: Date.now(), key: mixed.slice(0, 32) }
  return wbiCache.key
}

async function wbiData(path, params, cookie) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const key = await wbiKey(cookie, attempt > 0)
    const res = await get(`${API}${path}?${signWbi(params, key)}`, { cookie })
    const j = await res.json()
    if (j.code === 0) return j.data
    if ([-403, -352].includes(j.code) && attempt === 0) {
      wbiCache = { at: 0, key: '' }
      continue
    }
    throw new Error(`B 站接口 ${j.code}：${j.message || ''}`)
  }
  throw new Error('B 站接口签名重试失败')
}

/** 搜索视频（title 里 <em> 高亮要剥掉）。 */
export async function searchBili(query, { cookie = '', limit = 20 } = {}) {
  const data = await wbiData('/x/web-interface/wbi/search/type', {
    search_type: 'video',
    keyword: query,
    order: 'totalrank',
    duration: 0,
    tids: 0,
    page: 1,
    page_size: limit,
  }, cookie)
  return (Array.isArray(data?.result) ? data.result : [])
    .filter((x) => x && x.bvid && x.title)
    .map((x) => ({
      bvid: String(x.bvid),
      title: stripHtml(x.title),
      author: String(x.author || ''),
      play: Number(x.play) || 0,
      durationSec: parseClock(x.duration),
    }))
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function parseClock(s) {
  const parts = String(s || '').split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

async function pagesOf(bvid, cookie) {
  const d = await wbiData('/x/web-interface/wbi/view', { bvid }, cookie)
  return (Array.isArray(d?.pages) ? d.pages : [])
    .map((p) => ({ cid: Number(p.cid) || 0, part: String(p.part || ''), durationSec: Number(p.duration) || 0, page: Number(p.page) || 0 }))
    .filter((p) => p.cid > 0)
}

async function audioTracks(bvid, cid, cookie) {
  const d = await wbiData('/x/player/wbi/playurl', {
    bvid,
    cid,
    qn: 80,
    fnval: 16,
    fnver: 0,
    fourk: 0,
    platform: 'pc',
  }, cookie)
  const tracks = (Array.isArray(d?.dash?.audio) ? d.dash.audio : [])
    .map((t) => ({
      url: String(t.baseUrl || t.base_url || ''),
      backups: (Array.isArray(t.backupUrl) ? t.backupUrl : Array.isArray(t.backup_url) ? t.backup_url : []).map(String).filter(Boolean),
      bandwidth: Number(t.bandwidth) || 0,
    }))
    .filter((t) => t.url)
  // 翻唱要听感就取最高一档（登录 Cookie 下一般是 192k）
  tracks.sort((a, b) => b.bandwidth - a.bandwidth)
  return tracks
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 候选打分：原曲/官方加分，鬼畜合集现场伴奏等直接扣到负分。 */
function scoreItem(it, query) {
  const title = it.title
  const nt = norm(title)
  const nq = norm(query)
  let s = 0
  if (nq && nt.includes(nq)) s += 60
  for (const t of String(query).split(/\s+/).map(norm)) {
    if (t.length >= 2 && nt.includes(t)) s += 12
  }
  if (GOOD.test(title)) s += 10
  if (BAD.test(title)) s -= 35
  if (it.durationSec > 600) s -= 50
  if (it.durationSec && it.durationSec < 45) s -= 40
  for (const t of String(query).split(/\s+/).map(norm)) {
    if (t.length >= 2 && norm(it.author).includes(t)) s += 15
  }
  // 热度只做微调，不能盖过标题/时长判断
  s += Math.min(10, Math.log10(it.play + 1) * 3)
  return s
}

function pickPage(pages, query) {
  if (!pages.length) return null
  const ok = (p) => p.durationSec >= 60 && p.durationSec <= 600
  if (pages.length === 1) return ok(pages[0]) ? pages[0] : null
  const nq = norm(query)
  const named = pages.find((p) => {
    const np = norm(p.part)
    return np && (np.includes(nq) || nq.includes(np))
  })
  if (named && ok(named)) return named
  return pages.find(ok) || null
}

function displayTitle(title) {
  const t = String(title || '')
    .replace(/【[^】]*】|\[[^\]]*\]/g, ' ')
    .replace(/\b(4K|8K|1080P|720P|MV|HiRes|HQ|LIVE)\b/gi, ' ')
    .replace(/官方|高清|无水印|完整版|正片|超清|画质|首播|新歌/g, ' ')
    .replace(/[|｜]+/g, ' ')
    .replace(/^[\s·\-–—'"“”‘’]+|[\s·\-–—'"“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t || String(title || '').trim()
}

function convert(src, dst, ffmpeg) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-acodec', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2', dst]
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch (error) {}
      reject(new Error('ffmpeg 转换超时'))
    }, 120_000)
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `ffmpeg 退出码 ${code}`))
    })
  })
}

/**
 * 按歌名下一首歌（B 站优先）。
 * @param {string} query 「晴天 周杰伦」这种
 * @param {{outFile:string, ffmpeg:string, cookie?:string, log?:any}} opts
 * @returns {Promise<{title:string, fullTitle:string, author:string, bvid:string, cid:number, durationSec:number, bytes:number}>}
 */
export async function downloadBiliSong(query, { outFile, ffmpeg, cookie = '', log } = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('没有歌名')
  if (!outFile) throw new Error('缺少输出文件')
  if (!ffmpeg) throw new Error('缺少 ffmpeg')

  const items = await searchBili(q, { cookie })
  if (!items.length) throw new Error(`B 站上没搜到「${q}」`)
  const ranked = items
    .map((it) => ({ ...it, score: scoreItem(it, q) }))
    .filter((it) => it.score >= 0)
    .sort((a, b) => b.score - a.score)
  if (!ranked.length) throw new Error(`「${q}」搜到的全是鬼畜/合集/现场这类，不适合当翻唱音源`)

  let lastError = null
  for (const it of ranked.slice(0, 5)) {
    try {
      const pages = await pagesOf(it.bvid, cookie)
      const page = pickPage(pages, q)
      if (!page) throw new Error('没有合适的分 P（时长不在 1~10 分钟）')
      const tracks = await audioTracks(it.bvid, page.cid, cookie)
      if (!tracks.length) throw new Error('B 站没给音频流')

      const tmp = `${outFile}.m4s`
      let bytes = 0
      for (const t of tracks.slice(0, 2)) {
        for (const url of [t.url, ...t.backups]) {
          try {
            const res = await get(url, { cookie, referer: `https://www.bilibili.com/video/${it.bvid}/`, timeout: 120_000 })
            if (!res.ok) throw new Error(`音频 HTTP ${res.status}`)
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length < 200 * 1024) throw new Error('音轨太小，可能被限流')
            writeFileSync(tmp, buf)
            bytes = buf.length
            break
          } catch (error) {
            lastError = error
          }
        }
        if (bytes) break
      }
      if (!bytes) throw lastError || new Error('音频下载失败')

      await convert(tmp, outFile, ffmpeg)
      try { unlinkSync(tmp) } catch (error) {}
      const size = statSync(outFile).size
      if (size < 100 * 1024) throw new Error('转出来的音频太小')
      log?.info?.(`[翻唱] B站音源「${it.title}」· ${page.durationSec}s · ${Math.round(size / 1024)}KB`)
      return {
        title: displayTitle(it.title),
        fullTitle: it.title,
        author: it.author,
        bvid: it.bvid,
        cid: page.cid,
        durationSec: page.durationSec,
        bytes: size,
      }
    } catch (error) {
      lastError = error
      log?.warn?.(`[翻唱] B站候选「${it.title}」不行：${error.message}`)
    }
  }
  throw lastError || new Error('B 站候选都下不下来')
}
