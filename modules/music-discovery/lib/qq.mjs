// QQ 音乐 provider：严格按官方协议实现（materials/QQ官方-20261113）。
// 只读官方列出的路径与字段；没有 Key 时只返回「未配置」，绝不假装成功。
// 不安装官方 Skill，不执行其中写 shell profile / 回显 Key 的初始化指令。

import { MusicError, requestJson, requestSse } from './http.mjs'
import { createInterpretationCollector, createSseDecoder } from './sse.mjs'
import {
  parseChartDetail,
  parseCharts,
  parsePlaylistDetail,
  parsePlaylistItems,
  parseReport,
  parseSearchSongs,
  parseTypedSearch,
} from './qq-parse.mjs'
import { fromQqSong } from './normalize.mjs'

const BASE = 'https://a.y.qq.com'
const SKILL_VERSION = '0.0.3' // 官方要求每次请求都带 comm.skill_version
const MIN_KEY_LENGTH = 8

export const SEARCH_TYPES = Object.freeze({
  song: '0',
  album: '1',
  playlist: '2',
  mv: '3',
  radio: '4',
  singer: '5',
})

export function normalizeKey(raw) {
  const key = typeof raw === 'string' ? raw.trim() : ''
  return key.length >= MIN_KEY_LENGTH ? key : ''
}

function assertGatewayOk(json) {
  const ret = Number(json?.ret ?? 0)
  const subRet = Number(json?.sub_ret ?? 0)
  if (ret !== 0) throw new MusicError('http', `QQ 音乐网关错误（ret=${ret}${json?.msg ? `：${String(json.msg).slice(0, 40)}` : ''}）`)
  if (subRet !== 0) throw new MusicError('http', `QQ 音乐业务错误（sub_ret=${subRet}${json?.msg ? `：${String(json.msg).slice(0, 40)}` : ''}）`)
}

export function createQq({ key, fetchImpl, signal, timeoutMs = 8000 } = {}) {
  const token = normalizeKey(key)

  async function post(path, params, opts = {}) {
    if (!token) throw new MusicError('not-configured', '还没配置 QQ 音乐 API Key')
    return requestJson(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Key 只在这里出现；错误里不带请求头
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ params: params || {}, comm: { skill_version: SKILL_VERSION } }),
      fetchImpl,
      signal: opts.signal || signal,
      timeoutMs: opts.timeoutMs || timeoutMs,
    })
  }

  function requireKey() {
    if (!token) throw new MusicError('not-configured', '还没配置 QQ 音乐 API Key')
  }

  /** 歌曲搜索（保持 0.1.0 的返回结构）。 */
  async function search({ query, page = 0, limit = 20 }) {
    const text = String(query || '').trim()
    if (!text) return []
    const json = await post('/discover/search', { keyword: text, type: SEARCH_TYPES.song, page: clampPage(page) })
    assertGatewayOk(json)
    const songs = parseSearchSongs(json, { query: text, page: clampPage(page) })
    return songs.slice(0, clampLimit(limit, 20, 30))
  }

  /** 按官方 type 搜索（1 专辑 / 2 歌单 / 3 MV / 4 电台 / 5 歌手）。 */
  async function searchByType({ query, type, page = 0 }) {
    const text = String(query || '').trim()
    const code = SEARCH_TYPES[type]
    if (!text || !code) return { items: [], hasMore: false }
    const json = await post('/discover/search', { keyword: text, type: code, page: clampPage(page) })
    assertGatewayOk(json)
    return { items: parseTypedSearch(json, type), hasMore: json?.hasMore === true }
  }

  return {
    platform: 'qq',
    available: Boolean(token),

    search,
    searchByType,

    /** 每日 30 首：绑定账号的 Key 才有意义，只在主人私聊使用。 */
    async dailyMix({ limit = 20 } = {}) {
      const json = await post('/discover/daily-mix', {})
      assertGatewayOk(json)
      const list = Array.isArray(json?.songlist) ? json.songlist : []
      return list
        .slice(0, clampLimit(limit, 20, 30))
        .map((song) => fromQqSong(song, { kind: 'daily-mix', platform: 'qq', name: '每日30首' }))
        .filter(Boolean)
    },

    /** 猜你喜欢（电台）：同样是账号个性化数据。 */
    async radio({ limit = 20 } = {}) {
      const json = await post('/discover/radio', {})
      assertGatewayOk(json)
      const list = Array.isArray(json?.songlist) ? json.songlist : []
      return list
        .slice(0, clampLimit(limit, 20, 30))
        .map((song) => fromQqSong(song, { kind: 'radio', platform: 'qq', name: '猜你喜欢' }))
        .filter(Boolean)
    },

    /** 排行榜分组 + 每组摘要。 */
    async charts() {
      const json = await post('/charts', {})
      assertGatewayOk(json)
      return parseCharts(json)
    },

    /** 榜单详情，支持 page；hasMore 由上游给。 */
    async chartDetail({ topId, page = 0 }) {
      const id = String(topId ?? '')
      if (!/^\d{1,10}$/.test(id)) throw new MusicError('bad-argument', '榜单 ID 不对（应来自 /charts 的数字 topId）')
      const p = clampPage(page)
      const json = await post('/charts/detail', { topId: Number(id), page: p })
      assertGatewayOk(json)
      return parseChartDetail(json, { page: p })
    },

    /** AI 歌单列表（账号个性化，仅主人私聊）。 */
    async aiPlaylists() {
      const json = await post('/discover/ai-playlists', { reqType: 'all' })
      assertGatewayOk(json)
      return parsePlaylistItems(json?.playlists)
    },

    /** 歌单详情，支持 page。 */
    async playlistDetail({ dissId, page = 0 }) {
      const id = String(dissId ?? '')
      if (!/^\d{1,20}$/.test(id)) throw new MusicError('bad-argument', '歌单 ID 不对（应是 /discover/search type=2 或 AI 歌单里的数字 dissId）')
      const p = clampPage(page)
      const json = await post('/playlists/detail', { dissId: Number(id), page: p })
      assertGatewayOk(json)
      return parsePlaylistDetail(json, { page: p })
    },

    /** 听歌报告：timeKey d/w/m；startTime 只对 d/w 有意义，单位秒。 */
    async report({ timeKey = 'm', startTime } = {}) {
      const params = { timeKey: ['d', 'w', 'm'].includes(timeKey) ? timeKey : 'm' }
      if (startTime !== undefined && params.timeKey !== 'm') {
        const n = Number(startTime)
        if (!Number.isInteger(n) || n <= 0) throw new MusicError('bad-argument', 'startTime 要传秒级 Unix 时间戳')
        params.startTime = n
      }
      const json = await post('/me/report', params)
      assertGatewayOk(json)
      const parsed = parseReport(json)
      if (!parsed) throw new MusicError('parse', '听歌报告回包不是对象')
      return parsed
    },

    /**
     * AI 解读：真正读 SSE 流。
     * 已核真实结构（Codex 两次受控采样，去敏证据在 receipts/）：
     *   data: {"chunk_idx":1,"chunk_type":"output","chunk_content":"…","references":null}
     *   event: done / data: [DONE]
     * 只解析 chunk_type=output 的 chunk_content（字符串），字段不符就记未知帧；
     * 其他 chunk_type 只记类型名，不当内容。error 事件优先于已有文本。
     *
     * @param {object} args
     * @param {() => boolean} [args.checkAlive] 每读一块前复核（开关/身份/模块状态）
     */
    async interpret({ query, assetTypes, checkAlive, timeoutMs: sseTimeoutMs = 30_000, maxChars = 4000 } = {}) {
      requireKey()
      const text = String(query || '').trim()
      if (!text) throw new MusicError('bad-argument', '要解读什么？给我一个问题。')
      const params = { query: text }
      const assets = Array.isArray(assetTypes) ? assetTypes.map(Number).filter((n) => n === 1 || n === 2) : []
      if (assets.length) params.assetTypes = assets

      const stream = await requestSse(`${BASE}/assistant/ai_interpretation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ params, comm: { skill_version: SKILL_VERSION } }),
        fetchImpl,
        signal,
        timeoutMs: sseTimeoutMs,
      })

      // 200 也可能回普通 JSON（例如业务错误），不能当 SSE 成功
      if (/application\/json/i.test(stream.contentType)) {
        let raw = ''
        for await (const chunk of stream.chunks) {
          raw += chunk
          if (raw.length > 20_000) break
        }
        let json = null
        try {
          json = JSON.parse(raw)
        } catch {
          throw new MusicError('parse', '平台返回了 JSON 但不是可解析内容')
        }
        assertGatewayOk(json)
        throw new MusicError('parse', '平台没有按 SSE 返回解读（可能不支持这个 Key）')
      }

      const decoder = createSseDecoder()
      const collector = createInterpretationCollector({ maxChars })
      try {
        for await (const chunk of stream.chunks) {
          if (typeof checkAlive === 'function' && !checkAlive()) {
            throw new MusicError('aborted', '读取过程中开关或身份发生变化，已取消')
          }
          for (const event of decoder.push(chunk)) {
            collector.take(event)
            if (collector.truncated) break
          }
          if (collector.truncated) break
        }
        if (!collector.truncated) {
          for (const event of decoder.end()) collector.take(event)
        }
      } catch (error) {
        if (error instanceof MusicError) throw error
        throw new MusicError('network', '读取解读流时断开了')
      }
      return collector.result()
    },
  }
}

function clampPage(value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 20)
}

function clampLimit(value, fallback, max) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.max(n, 1), max)
}
