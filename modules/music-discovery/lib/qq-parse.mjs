// QQ 音乐回包解析：只读官方文档列出的字段，不猜字段名。
// 文档：materials/QQ官方-20261113/{discover,charts,playlists,me,assistant}.md
//
// 统一「条目」结构（非歌曲列表用）：
//   { kind, id, title, subtitle, desc, url, meta: { publicTime, category, listenNum, playCount, songNum, albumNum } }
// 歌曲列表仍交给 normalize.fromQqSong，保持 music_share 的候选结构不变。

import { fromQqSong } from './normalize.mjs'

const QQ_HOSTS = Object.freeze(['i2.y.qq.com', 'y.qq.com'])
const MID_RE = /^[0-9A-Za-z]{6,32}$/
const NUMERIC_ID_RE = /^\d{1,20}$/
const TOP_ID_RE = /^\d{1,10}$/

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 只用回包里的 QQ 域名链接；不合规就当没有，由调用方按官方规则拼。 */
export function safeQqUrl(raw) {
  if (!raw) return ''
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return ''
  }
  if (url.protocol !== 'https:') return ''
  if (!QQ_HOSTS.includes(url.hostname)) return ''
  return url.href
}

/** 官方 SKILL.md「H5 链接拼接」规则。id 不像话就不拼。 */
export function qqH5Url(kind, id) {
  const text = String(id ?? '')
  if (kind === 'song') return /^[0-9A-Za-z]{8,20}$/.test(text) ? `https://i2.y.qq.com/a/song/${text}` : ''
  if (kind === 'album' || kind === 'radio') return MID_RE.test(text) ? `https://i2.y.qq.com/a/album/${text}` : ''
  if (kind === 'singer') return MID_RE.test(text) ? `https://i2.y.qq.com/a/singer/${text}` : ''
  if (kind === 'mv') return MID_RE.test(text) ? `https://i2.y.qq.com/a/mv/${text}` : ''
  if (kind === 'playlist') return NUMERIC_ID_RE.test(text) ? `https://i2.y.qq.com/a/playlist/${text}` : ''
  if (kind === 'toplist') return TOP_ID_RE.test(text) ? `https://i2.y.qq.com/a/toplist/${text}` : ''
  return ''
}

function item(kind, id, title, extra = {}) {
  const link = safeQqUrl(extra.rawUrl) || qqH5Url(kind, id)
  return {
    kind,
    id,
    title: clean(title, 100) || '（无标题）',
    subtitle: clean(extra.subtitle, 80),
    desc: clean(extra.desc, 140),
    url: link,
    meta: {
      publicTime: clean(extra.publicTime, 30),
      category: clean(extra.category, 30),
      listenNum: num(extra.listenNum),
      playCount: num(extra.playCount),
      songNum: num(extra.songNum),
      albumNum: num(extra.albumNum),
    },
  }
}

/** type=0 歌曲；返回候选结构，供 music_share 使用。 */
export function parseSearchSongs(json, { query = '', page = 0 } = {}) {
  const list = Array.isArray(json?.songs) ? json.songs : []
  return list
    .map((song) => fromQqSong(song, { kind: 'search', platform: 'qq', query, page }))
    .filter(Boolean)
}

/** 按 type 解析非歌曲列表。 */
export function parseTypedSearch(json, type) {
  if (type === 'album') {
    return (Array.isArray(json?.albums) ? json.albums : [])
      .map((album) => {
        const id = String(album?.albumMid ?? '')
        if (!MID_RE.test(id)) return null
        return item('album', id, album.albumName, {
          subtitle: album.singerName,
          desc: album.albumDesc,
          publicTime: album.publicTime,
          category: album.category,
          listenNum: album.listenNum,
        })
      })
      .filter(Boolean)
  }
  if (type === 'playlist') {
    return parsePlaylistItems(json?.playlists)
  }
  if (type === 'mv') {
    return (Array.isArray(json?.mvs) ? json.mvs : [])
      .map((mv) => {
        const id = String(mv?.mvVid ?? '')
        if (!MID_RE.test(id)) return null
        return item('mv', id, mv.mvName, {
          subtitle: mv.singerName,
          rawUrl: mv.mvUrl,
          playCount: mv.playCount,
          publicTime: mv.publicTime,
        })
      })
      .filter(Boolean)
  }
  if (type === 'radio') {
    return (Array.isArray(json?.radios) ? json.radios : [])
      .map((radio) => {
        const id = String(radio?.albumMid ?? '')
        if (!MID_RE.test(id)) return null
        return item('radio', id, radio.albumName, {
          subtitle: radio.singerName,
          desc: radio.albumDesc,
          listenNum: radio.listenNum,
        })
      })
      .filter(Boolean)
  }
  if (type === 'singer') {
    return (Array.isArray(json?.singers) ? json.singers : [])
      .map((singer) => {
        const id = String(singer?.singerMid ?? '')
        if (!MID_RE.test(id)) return null
        return item('singer', id, singer.singerName, {
          songNum: singer.songNum,
          albumNum: singer.albumNum,
        })
      })
      .filter(Boolean)
  }
  return []
}

/** 歌单条目（搜索 type=2 与 AI 歌单共用）。 */
export function parsePlaylistItems(list) {
  return (Array.isArray(list) ? list : [])
    .map((pl) => {
      const id = String(pl?.dissId ?? '')
      if (!NUMERIC_ID_RE.test(id)) return null
      return item('playlist', id, pl.dissName, {
        subtitle: pl.creatorName,
        desc: pl.dissDesc,
      })
    })
    .filter(Boolean)
}

/** /charts：分组 + 每组榜单摘要。 */
export function parseCharts(json) {
  const groups = Array.isArray(json?.groupList) ? json.groupList : []
  return groups
    .map((group) => {
      const items = (Array.isArray(group?.groupTopList) ? group.groupTopList : [])
        .map((top) => {
          const topId = String(top?.topId ?? '')
          if (!TOP_ID_RE.test(topId)) return null
          const songs = (Array.isArray(top?.songList) ? top.songList : [])
            .slice(0, 3)
            .map((song) => ({
              rank: num(song?.rank),
              title: clean(song?.songName, 80),
              artist: clean(song?.singerName, 60),
            }))
            .filter((song) => song.title)
          return {
            topId,
            name: clean(top?.topName, 60) || `榜单 ${topId}`,
            listenNum: num(top?.listenNum),
            totalNum: num(top?.totalNum),
            songs,
            url: qqH5Url('toplist', topId),
          }
        })
        .filter(Boolean)
      return { name: clean(group?.groupName, 60) || '未命名分组', items }
    })
    .filter((group) => group.items.length)
}

/** /charts/detail：榜单详情 + 曲目。 */
export function parseChartDetail(json, { page = 0 } = {}) {
  const topId = String(json?.topId ?? '')
  const tracks = (Array.isArray(json?.trackList) ? json.trackList : [])
    .map((song) => fromQqSong(song, { kind: 'chart-tracks', platform: 'qq', id: topId, page }))
    .filter(Boolean)
  return {
    topId: TOP_ID_RE.test(topId) ? topId : '',
    name: clean(json?.topName, 80),
    desc: clean(json?.topDesc, 200),
    listenNum: num(json?.listenNum),
    totalNum: num(json?.totalNum),
    updateTime: clean(json?.updateTime, 40),
    hasMore: json?.hasMore === true,
    page,
    tracks,
    url: qqH5Url('toplist', topId),
  }
}

/** /playlists/detail：歌单详情 + 曲目。 */
export function parsePlaylistDetail(json, { page = 0 } = {}) {
  const dissId = String(json?.dissId ?? '')
  const tracks = (Array.isArray(json?.trackList) ? json.trackList : [])
    .map((song) => fromQqSong(song, { kind: 'playlist-tracks', platform: 'qq', id: dissId, page }))
    .filter(Boolean)
  return {
    dissId: NUMERIC_ID_RE.test(dissId) ? dissId : '',
    name: clean(json?.dissName, 80),
    desc: clean(json?.desc, 200),
    picUrl: safeQqUrl(json?.picUrl),
    totalNum: num(json?.totalNum),
    hasMore: json?.hasMore === true,
    page,
    tracks,
    url: qqH5Url('playlist', dissId),
  }
}

// 报告只做结构校验，渲染交给 lib/report.mjs；不在这里改字段名。
export function parseReport(json) {
  if (!json || typeof json !== 'object') return null
  return {
    dayData: json.dayData && typeof json.dayData === 'object' ? json.dayData : null,
    weekData: json.weekData && typeof json.weekData === 'object' ? json.weekData : null,
    monthData: json.monthData && typeof json.monthData === 'object' ? json.monthData : null,
  }
}
