// 网易云：公开搜索接口 + Meting 直链，全程不需要 Cookie。

import { EmptyResponseError, fetchRace, raceFirst } from '../utils/fetch-race.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** 已用 VIP 歌曲验证过能返回完整音源的 Meting 后端（与 music-voice 保持一致）。 */
const FULL_METING_APIS = [
  'https://music.duanjinglin.com/api',
  'https://api.qijieya.cn/meting/',
  'https://meting.naihee.com/api',
]

export interface NeteaseCandidate {
  id: number
  name: string
  alias: string
  artists: string
  durationSec: number
  vip: boolean
}

/** 搜歌：公开搜索接口，不带 Cookie。空结果返回 []（不算错误）。 */
export async function searchNetease(
  keyword: string,
  { limit = 5, proxy }: { limit?: number; proxy?: string } = {},
): Promise<NeteaseCandidate[]> {
  const url =
    'https://music.163.com/api/search/get/web' +
    `?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(String(keyword))}` +
    `&type=1&offset=0&total=true&limit=${limit}`

  let text: string
  try {
    const res = await fetchRace(
      url,
      { headers: { 'user-agent': UA, referer: 'https://music.163.com/', accept: 'application/json' } },
      {
        proxy,
        timeoutMs: 8000,
        validate: async (response) => {
          try {
            const json: any = await response.json()
            const songs = json && json.result && json.result.songs
            return Array.isArray(songs) && songs.length > 0
          } catch {
            return false
          }
        },
      },
    )
    text = await res.text()
  } catch (error) {
    if (error instanceof EmptyResponseError) return []
    throw error
  }

  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('网易云搜索返回了非 JSON 内容')
  }
  if (json && json.code && Number(json.code) !== 200) {
    throw new Error(`网易云搜索返回 ${json.code}${json.msg ? '：' + json.msg : ''}`)
  }

  const songs = (json && json.result && json.result.songs) || []
  return songs.map((song: any) => ({
    id: Number(song.id),
    name: String(song.name || ''),
    alias: (song.alias || song.alia || []).join(' '),
    artists: (song.artists || song.ar || []).map((artist: any) => artist.name).filter(Boolean).join(' / '),
    durationSec: Math.round(Number(song.duration || song.dt || 0) / 1000),
    vip: song.fee === 1 || song.fee === 4,
  }))
}

/** 从 Meting 的响应里取直链：可能是纯 URL 文本，也可能是 {"url": "..."}。 */
function parseUrlText(text: string): string {
  const trimmed = String(text || '').trim()
  if (!trimmed) return ''
  try {
    const direct = new URL(trimmed)
    if (direct.protocol === 'http:' || direct.protocol === 'https:') return trimmed
  } catch {
    // 继续尝试 JSON
  }
  try {
    const json = JSON.parse(trimmed)
    const raw = typeof json === 'string' ? json : json && json.url
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = new URL(raw.trim())
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw.trim()
    }
  } catch {
    // ignore
  }
  return ''
}

/**
 * 请求一个 Meting 后端：返回直链就返回；直接回音频流时用请求地址本身当直链。
 * 只走直连 —— apifox 是文本包装，会把音频流读坏。
 */
async function askMeting(api: string, id: number | string): Promise<string> {
  const base = String(api || '').trim().replace(/\/+$/, '')
  const target = `${base}?server=netease&type=url&id=${encodeURIComponent(String(id))}`
  const res = await fetchRace(
    target,
    { headers: { 'user-agent': UA } },
    { channels: ['direct'], timeoutMs: 6000, readBody: false },
  )
  const contentType = String(res.headers.get('content-type') || '').toLowerCase()
  if (contentType.startsWith('audio/') || contentType.includes('application/octet-stream')) {
    await res.body?.cancel()
    return target
  }
  const parsed = parseUrlText(await res.text())
  if (!parsed) throw new Error('没有拿到直链')
  return parsed
}

function extOf(url: string): string {
  const match = String(url).match(/\.(mp3|m4a|aac|flac|wav|ogg)(?:$|\?)/i)
  return match ? match[1].toLowerCase() : 'mp3'
}

/** 拿下载直链：并行竞速 3 个完整音源后端，谁先给出直链用谁。 */
export async function songUrlNetease(id: number | string): Promise<{ url: string; type: string }> {
  try {
    const url = await raceFirst(
      FULL_METING_APIS.map((api) => () => askMeting(api, id)),
      (value) => Boolean(value),
    )
    return { url, type: extOf(url) }
  } catch {
    return { url: '', type: 'mp3' }
  }
}
