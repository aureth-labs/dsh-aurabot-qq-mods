// 网易云音乐 provider：自己按公开平台协议实现，不依赖翻唱模块，也不读它的 Cookie。
// 只打 https://music.163.com 的匿名接口：搜索、分类歌单、歌单/榜单详情。
// 匿名公开数据，不登录、不下载音频、不收藏/关注/签到、不上报听歌。

import { MusicError, requestJson } from './http.mjs'
import { fromNeteaseSong, neteasePlaylistUrl } from './normalize.mjs'

const BASE = 'https://music.163.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const FORM_HEADERS = Object.freeze({
  'User-Agent': UA,
  Referer: `${BASE}/`,
  'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
  Accept: 'application/json',
})

function post(url, body, { fetchImpl, signal, timeoutMs }) {
  return requestJson(url, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: body ? body.toString() : '',
    fetchImpl,
    signal,
    timeoutMs,
  })
}

function playlistOf(json) {
  const result = json?.result || json?.playlist || null
  if (!result || !Array.isArray(result.tracks)) return null
  return result
}

export function createNetease({ fetchImpl, signal, timeoutMs = 8000 } = {}) {
  const common = { fetchImpl, signal, timeoutMs }

  return {
    platform: 'netease',
    /** 在线搜索：/api/cloudsearch/pc（协议参考 materials/netease-cloudsearch.js） */
    async search({ query, limit = 20 }) {
      const text = String(query || '').trim()
      if (!text) return []
      const body = new URLSearchParams({
        s: text,
        type: '1', // 1 = 单曲
        limit: String(Math.min(Math.max(Number(limit) || 20, 1), 30)),
        offset: '0',
        total: 'true',
      })
      const json = await post(`${BASE}/api/cloudsearch/pc`, body, common)
      const songs = json?.result?.songs
      if (!Array.isArray(songs)) {
        if (json?.code && json.code !== 200) {
          throw new MusicError('http', `网易云返回错误码 ${json.code}`)
        }
        return []
      }
      return songs
        .map((song) => fromNeteaseSong(song, { kind: 'search', platform: 'netease', query: text }))
        .filter(Boolean)
    },

    /** 分类歌单：/api/playlist/list（协议参考 materials/netease-top-playlist.js） */
    async playlists({ cat, limit = 6, order = 'hot' }) {
      const body = new URLSearchParams()
      const url = `${BASE}/api/playlist/list?cat=${encodeURIComponent(String(cat || '全部'))}`
        + `&order=${encodeURIComponent(order)}&limit=${Math.min(Math.max(Number(limit) || 6, 1), 10)}&offset=0&total=true`
      const json = await post(url, body, common)
      const list = json?.playlists
      if (!Array.isArray(list)) return []
      return list
        .filter((item) => item && item.id)
        .map((item) => ({
          platform: 'netease',
          id: String(item.id),
          name: String(item.name || ''),
          trackCount: Number(item.trackCount) || 0,
          playCount: Number(item.playCount) || 0,
          shareUrl: neteasePlaylistUrl(item.id),
        }))
    },

    /** 歌单 / 榜单详情：/api/v6/playlist/detail（协议参考 materials/netease-playlist-detail.js） */
    async playlistTracks({ id, limit = 30 }) {
      const text = String(id || '')
      if (!/^\d{1,12}$/.test(text)) throw new MusicError('bad-url', '歌单 id 不对')
      const body = new URLSearchParams({ id: text, n: '120', s: '8' })
      const json = await post(`${BASE}/api/v6/playlist/detail`, body, common)
      const result = playlistOf(json)
      if (!result) throw new MusicError('parse', '歌单详情里没有曲目列表')
      const source = {
        kind: 'playlist',
        platform: 'netease',
        id: String(result.id || text),
        name: String(result.name || ''),
      }
      const tracks = result.tracks
        .slice(0, Math.min(Math.max(Number(limit) || 30, 1), 120))
        .map((track) => fromNeteaseSong(track, source))
        .filter(Boolean)
      return { id: source.id, name: source.name, tracks, source }
    },
  }
}
