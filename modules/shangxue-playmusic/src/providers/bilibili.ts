// 哔哩哔哩：走星之阁第三方接口，不碰 B 站官方 API / wbi 签名。

import { EmptyResponseError, fetchRace } from '../utils/fetch-race.js'

const SEARCH_API = process.env.PLAYMUSIC_BILI_SEARCH_API || 'https://api.xingzhige.com/API/b_search/'
const PARSE_API = process.env.PLAYMUSIC_BILI_PARSE_API || 'https://api.xingzhige.com/API/b_parse/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 想往前排的关键词（录音棚、无损等优质音源）。 */
const PREFER = (
  process.env.PLAYMUSIC_KEYWORDS || '录音棚,无损,Hi-Res,HiRes,母带,原唱,官方,完整版,MV'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** 明显不是原唱 / 不适合当点歌的，直接排除。 */
export const DENY = [
  '翻唱', 'cover', '鬼畜', '伴奏', '纯音乐', '教学', '吉他弹唱', '钢琴曲',
  'DJ版', 'dj版', 'remix', '慢摇', '串烧', '消音', '升降调',
]
/** 扣分但不排除（合集 / 切片之类偶尔也能用）。 */
const PENALTY = ['剪辑', '片段', '直播', 'reaction', '混剪', '合辑', '歌单']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 从可能是 HTML 错误页的响应里抠出 JSON：找第一个 '{' 起再 parse。 */
function parseLoose(text: string): any {
  const start = text.indexOf('{')
  if (start < 0) throw new Error(`接口返回的不是 JSON：${text.slice(0, 80)}`)
  return JSON.parse(text.slice(start))
}

/**
 * 直连 + 代理并行取 JSON，失败重试退避。
 * requireData=true 时，把「code!=0 / data 为空」也当作失败，让另一条通道继续。
 */
export async function fetchJson(
  url: string,
  {
    timeoutMs = 20_000,
    retries = 3,
    proxy,
    requireData = false,
  }: { timeoutMs?: number; retries?: number; proxy?: string; requireData?: boolean } = {},
): Promise<any> {
  let last: any
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetchRace(
        url,
        { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } },
        {
          proxy,
          timeoutMs,
          validate: requireData
            ? async (response) => {
                try {
                  const json = parseLoose(await response.text())
                  if (Number(json?.code) !== 0) return false
                  return Array.isArray(json?.data) ? json.data.length > 0 : Boolean(json?.data)
                } catch {
                  return false
                }
              }
            : undefined,
        },
      )
      return parseLoose(await res.text())
    } catch (error) {
      last = error
      if (error instanceof EmptyResponseError) break
      if (i < retries - 1) await sleep(1200 * (i + 1))
    }
  }
  throw last
}

const norm = (s: any) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·・,，.。!！?？'"“”‘’()（）【】\[\]《》<>|/\\+~`]/g, '')

/** "04:12" / "12:03" / 252 → 秒（兼容两种 duration 格式）。 */
export function toSeconds(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)
  const parts = text.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

export interface BiliCandidate {
  bvid: string
  title: string
  duration: number
  author: string
  play: number
  score: number
}

export function scoreCandidate(item: { title: string; duration: number; play: number }, song: string): number {
  const title = String(item.title || '')
  const lower = title.toLowerCase()
  const dur = item.duration
  let score = 0
  if (song && norm(title).includes(norm(song.split(/\s+/)[0]))) score += 60
  for (const word of PREFER) if (lower.includes(word.toLowerCase())) score += 35
  for (const word of PENALTY) if (lower.includes(word)) score -= 30
  if (dur >= 120 && dur <= 420) score += 30
  else if (dur >= 60 && dur < 120) score += 10
  else if (dur > 420) score -= 20
  score += Math.min(30, Math.log10(Math.max(1, item.play)) * 12)
  score -= Math.abs(dur - 210) / 12
  return score
}

export interface SearchOptions {
  /** 最多返回多少条（默认 5） */
  limit?: number
  /** 代理地址；留空用内置 apifox，填 'direct' 只直连。 */
  proxy?: string
}

/** 搜原唱候选项，已按打分排序、去掉明显的翻唱/伴奏，且标题匹配歌名的优先。 */
export async function searchBili(song: string, opts: SearchOptions = {}): Promise<BiliCandidate[]> {
  const base = String(song || '').trim()
  if (!base) return []
  const limit = Math.max(1, opts.limit || 5)
  const proxy = opts.proxy
  const queries = [`${base} 原唱`, `${base.replace(/\s+/g, '')}原唱`, base]
  const seen = new Set<string>()
  const items: Array<{ bvid: string; title: string; duration: number; author: string; play: number }> = []
  for (const q of queries) {
    try {
      const url = `${SEARCH_API}?${new URLSearchParams({ msg: q, n: '20' })}`
      const data = await fetchJson(url, { proxy, requireData: true, retries: 2 })
      if (Number(data?.code ?? -1) !== 0) continue
      for (const row of data?.data || []) {
        const bvid = String(row?.bvid || '').trim()
        if (!bvid || seen.has(bvid)) continue
        const title = String(row?.video?.title || '').trim()
        const duration = toSeconds(row?.stat?.duration)
        if (!title || duration <= 0) continue
        seen.add(bvid)
        items.push({ bvid, title, duration, author: row?.owner?.name || '', play: Number(row?.stat?.video || 0) })
      }
      if (items.length) break
    } catch {
      /* 换下一个 query 再试 */
    }
  }
  const usable = items
    .filter((it) => !DENY.some((w) => it.title.toLowerCase().includes(w.toLowerCase())))
    .filter((it) => it.duration >= 30)
    .map((it) => ({ ...it, score: scoreCandidate(it, base) }))
    .sort((a, b) => b.score - a.score)
  const key = norm(base.split(/\s+/)[0] || '')
  const onTopic = key ? usable.filter((it) => norm(it.title).includes(key)) : usable
  const result = onTopic.length ? onTopic : usable
  return result.slice(0, limit)
}

/** 解析某 BV 号的直链。直链有时效，拿到要尽快下载。 */
export async function resolveBili(bvid: string, { proxy }: { proxy?: string } = {}): Promise<{ url: string; title: string }> {
  const url = `${PARSE_API}?${new URLSearchParams({ url: `https://www.bilibili.com/video/${bvid}` })}`
  const data = await fetchJson(url, { proxy })
  if (Number(data?.code ?? -1) !== 0) throw new Error(`解析失败 code=${data?.code} ${data?.msg || ''}`)
  const video = data?.data?.video || {}
  const directUrl = String(video.url || '').trim()
  if (!/^https?:\/\//i.test(directUrl)) throw new Error('解析没拿到可播放地址')
  return { url: directUrl, title: String(video.title || '').trim() }
}

/** 下载直链到 dest（本地文件路径）。文件下载一般直连即可，不走代理。 */
export async function downloadTo(url: string, dest: string): Promise<string> {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(300_000),
  })
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('下载到的文件是空的')
  if (buf.length > 400 * 1024 * 1024) throw new Error('视频太大了')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  return dest
}
