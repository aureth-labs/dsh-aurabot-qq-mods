// 把两家平台五花八门的回包统一成同一份候选结构，并判断「原唱 / 翻唱 / 现场 / 伴奏」。
// 只做数据归一化，不发请求、不读配置。

export const VERSION_LABEL = {
  original: '原唱',
  live: '现场',
  cover: '翻唱',
  instrumental: '伴奏/纯音乐',
  remix: '混音',
  derivative: '改编版',
  unknown: '版本未标注',
}

// 歌名/别名里能直接读出来的版本标记。顺序有意义：先判伴奏，再判混音、现场、翻唱、改编。
const VERSION_RULES = [
  { code: 'instrumental', re: /伴奏|纯音乐|instrumental|off\s*vocal|karaoke|消音/i },
  { code: 'remix', re: /remix|混音|dj版|\bdj\b|重制版|bootleg|mashup/i },
  { code: 'live', re: /现场|live|演唱会|concert|音乐节|unplugged/i },
  { code: 'cover', re: /翻唱|cover|致敬|tribute/i },
  {
    code: 'derivative',
    re: /女声版|男声版|童声|钢琴版|吉他版|古筝|二胡|弦乐版|加速版|降调版|片段|铃声|抖音版|合唱版|清唱|acoustic|8d/i,
  },
]

// 「(原唱: 周杰伦)」这类标注：写的是被翻唱的那个人，不是当前这条的演唱者。
const ORIGINAL_REF = /原唱\s*[:：]?\s*([^)）\]】|]+)/

const LINK_HOSTS = Object.freeze(['music.163.com', 'y.qq.com', 'i2.y.qq.com', 'y.music.163.com'])

export function compact(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s·・.\-—_'"!！?？,，。:：;；、/\\()（）[\]【】]/g, '')
}

/** 去掉歌名里的括号补充（版本说明通常在那里） */
export function bareTitle(title) {
  let text = String(title || '')
  let prev
  do {
    prev = text
    text = text.replace(/[（(\[【{][^（()）[\]【】{}]*[)）\]】}]/g, '')
  } while (text !== prev)
  return text.replace(/\s+/g, ' ').trim()
}

/** 歌手名可能是 "周杰伦/费玉清"、"A、B" 这种拼接，拆开去空。 */
export function splitArtists(raw) {
  const list = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const item of list) {
    const name = typeof item === 'string' ? item : item?.name
    if (!name) continue
    for (const piece of String(name).split(/[/、,，&]/)) {
      const value = piece.trim()
      if (value && !out.includes(value)) out.push(value)
    }
  }
  return out
}

function sameArtist(a, b) {
  const x = compact(a)
  const y = compact(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

export function artistsInclude(artists, name) {
  return (artists || []).some((artist) => sameArtist(artist, name))
}

/**
 * 版本判定。priority：
 *   1. 歌名/别名里的明确标记（现场、伴奏、翻唱…）
 *   2. 平台自带 originCoverType（1 原唱 / 2 翻唱 / 3 其它版本，实测推断，非官方文档）
 *   3. 「原唱 X」标注与当前歌手不一致 → 翻唱
 *   4. 都没有 → 版本未标注（不冒充原唱）
 */
export function classifyVersion({ title, alias, artists, coverType } = {}) {
  const text = [title, ...(Array.isArray(alias) ? alias : [])].join(' ')

  const ref = text.match(ORIGINAL_REF)
  const refName = ref ? ref[1].trim() : ''

  for (const rule of VERSION_RULES) {
    const hit = text.match(rule.re)
    if (hit) return { code: rule.code, label: VERSION_LABEL[rule.code], evidence: `歌名标注「${hit[0]}」` }
  }

  if (refName && !artistsInclude(artists, refName)) {
    return { code: 'cover', label: VERSION_LABEL.cover, evidence: `标注原唱是 ${refName}，本条演唱者不是` }
  }

  const type = Number(coverType)
  if (type === 2) return { code: 'cover', label: VERSION_LABEL.cover, evidence: '平台标记为翻唱' }
  if (type === 1) return { code: 'original', label: VERSION_LABEL.original, evidence: '平台标记为原唱' }
  if (type === 3) return { code: 'derivative', label: VERSION_LABEL.derivative, evidence: '平台标记为其他版本' }

  return { code: 'unknown', label: VERSION_LABEL.unknown, evidence: '平台没给版本信息' }
}

/** 只放行已知平台域名的 https 链接；其它一律当没有（绝不自己编）。 */
export function safeShareUrl(raw) {
  if (!raw) return ''
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return ''
  }
  if (url.protocol !== 'https:') return ''
  if (!LINK_HOSTS.includes(url.hostname)) return ''
  return url.href
}

/** 网易云歌曲页（数字 id 才拼）。 */
export function neteaseSongUrl(id) {
  const text = String(id || '')
  return /^\d{1,12}$/.test(text) ? `https://music.163.com/song?id=${text}` : ''
}

export function neteasePlaylistUrl(id) {
  const text = String(id || '')
  return /^\d{1,12}$/.test(text) ? `https://music.163.com/playlist?id=${text}` : ''
}

/** QQ 只有 songMid；官方规则 https://i2.y.qq.com/a/song/{songMid}，mid 不像话就不拼。 */
export function qqSongUrl(mid) {
  const text = String(mid || '')
  return /^[0-9A-Za-z]{8,20}$/.test(text) ? `https://i2.y.qq.com/a/song/${text}` : ''
}

function toMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  // 网易云 playlist 详情里的 duration 是毫秒，QQ 不返回时长
  return Math.round(n)
}

/**
 * 统一候选结构。
 * @returns {{platform:string,id:string,mid:string|null,title:string,artists:string[],album:string,
 *   durationMs:number|null,version:string,versionLabel:string,versionEvidence:string,
 *   assumedOriginal:boolean,shareUrl:string,source:object}}
 */
export function makeCandidate(input = {}) {
  const platform = input.platform === 'qq' ? 'qq' : 'netease'
  const artists = splitArtists(input.artists)
  const version = classifyVersion({
    title: input.title,
    alias: input.alias,
    artists,
    coverType: input.coverType,
  })
  const id = input.id === undefined || input.id === null ? '' : String(input.id)
  const mid = input.mid ? String(input.mid) : null
  const shareUrl = safeShareUrl(input.shareUrl)
    || (platform === 'qq' ? qqSongUrl(mid || id) : neteaseSongUrl(id))

  return {
    platform,
    id,
    mid,
    title: String(input.title || '').trim(),
    artists,
    album: String(input.album || '').trim(),
    durationMs: toMs(input.durationMs),
    version: version.code,
    versionLabel: version.label,
    versionEvidence: version.evidence,
    shareUrl,
    source: input.source || { kind: 'unknown' },
  }
}

/** 网易云 cloudsearch（新格式 ar/al/dt/alia）与 playlist 详情（旧格式 artists/album/duration）都能吃。 */
export function fromNeteaseSong(song, source) {
  if (!song || song.id === undefined) return null
  let artists = song.ar || song.artists
  if ((!Array.isArray(artists) || !artists.length) && song.album?.artist?.name) artists = [song.album.artist]
  return makeCandidate({
    platform: 'netease',
    id: song.id,
    title: song.name,
    artists: artists || [],
    alias: song.alia || song.alias || [],
    album: song.al?.name || song.album?.name || '',
    durationMs: song.dt || song.duration,
    coverType: song.originCoverType,
    shareUrl: neteaseSongUrl(song.id),
    source,
  })
}

export function fromQqSong(song, source) {
  if (!song || (!song.songMid && !song.songName)) return null
  return makeCandidate({
    platform: 'qq',
    id: song.songMid || '',
    mid: song.songMid || '',
    title: song.songName,
    artists: song.singerName,
    album: song.albumName || '',
    durationMs: song.durationMs,
    shareUrl: song.songH5Url,
    source,
    // QQ 搜索回包没有版本字段；只能靠歌名标注判断
    coverType: undefined,
  })
}

export const VERSION_FILTERS = Object.freeze(['any', 'original', 'live', 'cover'])

function matchScore(candidate, { query, artist }) {
  const q = compact(query)
  const a = compact(artist)
  const title = compact(bareTitle(candidate.title))
  const fullTitle = compact(candidate.title)
  let score = 0

  if (q) {
    // 歌名相关性是主信号：没沾上歌名的结果先压下去（多词查询里常混进无关歌）
    if (title === q || fullTitle === q) score += 100
    else if (title.startsWith(q)) score += 60
    else if (title.includes(q) || fullTitle.includes(q)) score += 40
    else score -= 60
    if ((candidate.artists || []).some((name) => compact(name) === q)) score += 70
  }
  if (a) {
    if ((candidate.artists || []).some((name) => compact(name) === a)) score += 80
    else if (artistsInclude(candidate.artists, artist)) score += 45
    else score -= 40 // 指定了歌手却没对上：别让别人的同名歌排在前面
  }
  if (candidate.version === 'original') score += 12
  if (!candidate.shareUrl) score -= 5
  return score
}

/**
 * 去重、排序、按版本筛选。
 * 返回 { items, dropped }，dropped 里记着被筛掉多少、为什么，用来如实解释。
 */
export function rankCandidates(list, { query = '', artist = '', version = 'any' } = {}) {
  const seen = new Set()
  const unique = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.id && !item.mid) continue
    const key = `${item.platform}:${item.id || item.mid}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }

  const scored = unique
    .map((item, index) => ({ item, index, score: matchScore(item, { query, artist }) }))
    .sort((x, y) => (y.score - x.score) || (x.index - y.index))
    .map((row) => row.item)

  const dropped = { total: 0, byVersion: {} }
  if (version === 'any') return { items: scored, dropped }

  const items = []
  for (const item of scored) {
    if (item.version === version) items.push(item)
    else {
      dropped.total += 1
      const label = item.versionLabel || item.version
      dropped.byVersion[label] = (dropped.byVersion[label] || 0) + 1
    }
  }
  return { items, dropped }
}

export function countByVersion(list) {
  const out = {}
  for (const item of list) out[item.version] = (out[item.version] || 0) + 1
  return out
}
