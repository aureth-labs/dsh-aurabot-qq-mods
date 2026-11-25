// 候选 → 聊天里能看的文字 / 分享卡片段。只渲染，不再发请求。

export function platformLabel(platform) {
  if (platform === 'qq') return 'QQ音乐'
  if (platform === 'netease') return '网易云'
  return '未知平台'
}

export function formatDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const total = Math.round(n / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function candidateLine(index, candidate) {
  const parts = [`${index}. ${candidate.title || '（无标题）'} — ${(candidate.artists || []).join('/') || '未知歌手'}`]
  if (candidate.version && candidate.version !== 'unknown') parts.push(candidate.versionLabel)
  if (candidate.album) parts.push(`《${candidate.album}》`)
  const duration = formatDuration(candidate.durationMs)
  if (duration) parts.push(duration)
  const head = parts.join(' · ')
  const tail = candidate.shareUrl
    ? `\n   ${candidate.shareUrl}`
    : '\n   （平台没给网页链接，这里就不编了）'
  return head + tail
}

export function sourceLine(candidate) {
  const source = candidate.source || {}
  if (source.kind === 'playlist' || source.kind === 'chart') {
    const name = source.name || '平台歌单'
    return `${platformLabel(candidate.platform)}「${name}」${source.id ? `（${source.id}）` : ''}`
  }
  if (source.kind === 'daily-mix') return 'QQ音乐「每日30首」（账号个性化）'
  if (source.kind === 'radio') return 'QQ音乐「猜你喜欢」电台（账号个性化）'
  if (source.kind === 'search') return `${platformLabel(candidate.platform)}搜索`
  if (source.kind === 'chart-tracks') return `QQ音乐榜单（topId ${source.id || '?'}）`
  if (source.kind === 'playlist-tracks') return `QQ音乐歌单（dissId ${source.id || '?'}）`
  return ''
}

/**
 * 搜索结果列表文本（工具 / 命令共用）。
 * @param {object} opts
 * @param {string} opts.platform 主平台
 * @param {string} opts.query 用户给的查询
 * @param {Array} opts.candidates 已排序候选
 * @param {string[]} [opts.notes] 额外说明（筛掉了什么、回退了什么）
 */
export function renderSearch({ platform, query, candidates, notes = [] }) {
  const head = `${platformLabel(platform)} · 搜「${query}」：${candidates.length} 条`
  const lines = candidates.map((candidate, index) => candidateLine(index + 1, candidate))
  const tail = []
  const sources = [...new Set(candidates.map(sourceLine).filter(Boolean))]
  if (sources.length) tail.push(`来源：${sources.join('、')}`)
  const hasUnknownVersion = candidates.some((candidate) => candidate.version === 'unknown')
  if (hasUnknownVersion) tail.push('注：标「版本未标注」的是平台没给版本信息，不当作原唱。')
  tail.push(...notes)
  tail.push(`要分享哪条就说第几首（${candidates.length} 条都还能再取）。`)
  return [head, ...lines, '', ...tail].join('\n')
}

export function renderRecommend({ label, platform, candidates, notes = [] }) {
  const head = `${platformLabel(platform)} · 「${label}」挑了 ${candidates.length} 首`
  const lines = candidates.map((candidate, index) => candidateLine(index + 1, candidate))
  const sources = [...new Set(candidates.map(sourceLine).filter(Boolean))]
  const tail = []
  if (sources.length) tail.push(`来源：${sources.join('、')}`)
  tail.push(...notes)
  tail.push('这些是平台歌单/榜单里的真实曲目，合不合适你自己判断着说。')
  return [head, ...lines, '', ...tail].join('\n')
}

/** 分享成功后的短句（给她回话用，不再重复整张列表）。 */
export function shareSummary(candidate, form) {
  const how = form === 'card' ? '音乐卡片' : '链接'
  return `已发到当前聊天：${platformLabel(candidate.platform)}《${candidate.title}》— ${(candidate.artists || []).join('/') || '未知歌手'}（${how}）`
}

// ---------- 非歌曲列表 / 榜单 / 歌单 ----------

export const SEARCH_TYPE_LABEL = Object.freeze({
  song: '歌曲',
  album: '专辑',
  playlist: '歌单',
  mv: 'MV',
  radio: '电台',
  singer: '歌手',
})

export function formatCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`
  return String(Math.floor(n))
}

function itemMeta(item) {
  const meta = item?.meta || {}
  const parts = []
  if (meta.publicTime) parts.push(meta.publicTime)
  if (meta.category) parts.push(meta.category)
  if (meta.listenNum) parts.push(`收听 ${formatCount(meta.listenNum)}`)
  if (meta.playCount) parts.push(`播放 ${formatCount(meta.playCount)}`)
  if (meta.songNum) parts.push(`歌曲 ${meta.songNum} 首`)
  if (meta.albumNum) parts.push(`专辑 ${meta.albumNum} 张`)
  return parts.join(' · ')
}

function itemBlock(index, item) {
  const head = `${index}. ${item.title || '（无标题）'}${item.subtitle ? ` — ${item.subtitle}` : ''}`
  const lines = [head]
  const meta = itemMeta(item)
  if (meta) lines.push(`   ${meta}`)
  if (item.desc) lines.push(`   ${item.desc}`)
  if (item.id) lines.push(`   ${item.kind === 'playlist' ? 'dissId' : item.kind === 'singer' || item.kind === 'album' || item.kind === 'mv' || item.kind === 'radio' ? 'mid' : 'ID'}：${item.id}`)
  if (item.url) lines.push(`   ${item.url}`)
  return lines.join('\n')
}

/** 按类型的搜索结果（专辑/歌单/MV/电台/歌手）。 */
export function renderTypedSearch({ query, type, items, page = 0, hasMore = false, notes = [] }) {
  const label = SEARCH_TYPE_LABEL[type] || '结果'
  const head = `QQ音乐 · 搜${label}「${query}」：${items.length} 条${page > 0 ? `（第 ${page + 1} 页）` : ''}`
  const lines = items.map((item, index) => itemBlock(index + 1, item))
  const tail = [...notes]
  if (page >= 20 && hasMore) tail.push('还有更多，但已经到分页上限（20），不再继续翻。')
  else tail.push(hasMore ? `还有更多：用同一关键词把 page 设成 ${page + 1} 继续（最多 20）。` : '没有更多了（hasMore=false）。')
  tail.push('要看某个歌单里的曲目，用 music_playlist action=detail 加它的 dissId。')
  return [head, ...lines, '', ...tail].join('\n')
}

/** /charts 分组列表（有显示上限，避免一次刷屏）。 */
export function renderCharts({ groups, notes = [] }) {
  const MAX_GROUPS = 10
  const MAX_ITEMS = 10
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const shownGroups = groups.slice(0, MAX_GROUPS)
  const lines = [`QQ音乐 · 排行榜：${groups.length} 个分组 / ${total} 个榜单`]
  let hiddenItems = 0
  for (const group of shownGroups) {
    lines.push('', `【${group.name}】`)
    const shown = group.items.slice(0, MAX_ITEMS)
    hiddenItems += group.items.length - shown.length
    shown.forEach((top, index) => {
      const meta = [top.listenNum ? `收听 ${formatCount(top.listenNum)}` : '', top.totalNum ? `共 ${top.totalNum} 首` : '']
        .filter(Boolean)
        .join(' · ')
      lines.push(`  ${index + 1}. ${top.name}${meta ? ` · ${meta}` : ''}（topId：${top.topId}）`)
      if (top.songs.length) {
        lines.push(`     前 ${top.songs.length}：${top.songs.map((song) => `${song.rank ? `${song.rank}. ` : ''}${song.title}${song.artist ? ` - ${song.artist}` : ''}`).join('；')}`)
      }
      if (top.url) lines.push(`     ${top.url}`)
    })
  }
  if (groups.length > shownGroups.length || hiddenItems > 0) {
    lines.push('', `（分组只显示前 ${shownGroups.length} 个，每个分组最多 ${MAX_ITEMS} 个榜单；需要更多请用 topId 直接查详情）`)
  }
  lines.push('', ...notes)
  lines.push('要看某个榜单的完整曲目，用 music_charts action=detail 加 topId；支持 page 翻页。')
  return lines.join('\n')
}

/** /charts/detail。 */
export function renderChartDetail({ data, notes = [] }) {
  const head = `QQ音乐 · 榜单「${data.name || data.topId || '未命名'}」${data.topId ? `（topId：${data.topId}）` : ''}`
  const meta = [
    data.updateTime ? `更新 ${data.updateTime}` : '',
    data.listenNum ? `收听 ${formatCount(data.listenNum)}` : '',
    data.totalNum ? `共 ${data.totalNum} 首` : '',
  ].filter(Boolean).join(' · ')
  const lines = [head]
  if (meta) lines.push(meta)
  if (data.desc) lines.push(data.desc)
  lines.push(`本页 ${data.tracks.length} 首${data.page > 0 ? `（第 ${data.page + 1} 页）` : ''}：`)
  data.tracks.forEach((track, index) => {
    lines.push(`  ${index + 1}. ${track.title} — ${(track.artists || []).join('/') || '未知歌手'}${track.shareUrl ? `\n     ${track.shareUrl}` : ''}`)
  })
  lines.push('', ...notes)
  if (data.page >= 20 && data.hasMore) lines.push('还有更多，但已经到分页上限（20），不再继续翻。')
  else lines.push(data.hasMore ? `还有更多：page 设成 ${data.page + 1} 继续（最多 20）。` : '这一页就是全部了（hasMore=false）。')
  lines.push('要分享其中哪首，先说第几首让 music_share 取当前这组曲目。')
  return lines.join('\n')
}

/** 歌单列表（AI 歌单 / 搜索 type=2 都用）。 */
export function renderPlaylistList({ items, label = '歌单', notes = [] }) {
  const lines = [`QQ音乐 · ${label}：${items.length} 个`]
  items.forEach((item, index) => {
    lines.push(itemBlock(index + 1, item))
  })
  lines.push('', ...notes)
  lines.push('要看某个歌单里的曲目，用 music_playlist action=detail 加它的 dissId。')
  return lines.join('\n')
}

/** /playlists/detail。 */
export function renderPlaylistDetail({ data, notes = [] }) {
  const head = `QQ音乐 · 歌单「${data.name || data.dissId || '未命名'}」${data.dissId ? `（dissId：${data.dissId}）` : ''}`
  const meta = [data.totalNum ? `共 ${data.totalNum} 首` : '', data.picUrl ? '有封面' : ''].filter(Boolean).join(' · ')
  const lines = [head]
  if (meta) lines.push(meta)
  if (data.desc) lines.push(data.desc)
  lines.push(`本页 ${data.tracks.length} 首${data.page > 0 ? `（第 ${data.page + 1} 页）` : ''}：`)
  data.tracks.forEach((track, index) => {
    lines.push(`  ${index + 1}. ${track.title} — ${(track.artists || []).join('/') || '未知歌手'}${track.shareUrl ? `\n     ${track.shareUrl}` : ''}`)
  })
  lines.push('', ...notes)
  if (data.page >= 20 && data.hasMore) lines.push('还有更多，但已经到分页上限（20），不再继续翻。')
  else lines.push(data.hasMore ? `还有更多：page 设成 ${data.page + 1} 继续（最多 20）。` : '这一页就是全部了（hasMore=false）。')
  lines.push('要分享其中哪首，先说第几首让 music_share 取当前这组曲目。')
  return lines.join('\n')
}

/** 链接形式的分享正文。 */
export function linkText(candidate) {
  const version = candidate.version && candidate.version !== 'unknown' ? `（${candidate.versionLabel}）` : ''
  const head = `♪ ${candidate.title} — ${(candidate.artists || []).join('/') || '未知歌手'}${version}`
  if (!candidate.shareUrl) return head
  return `${head}\n${candidate.shareUrl}`
}

/**
 * 平台原生音乐卡片。只有拿到平台自己的数字 ID 才拼；
 * QQ 只有 songMid、没有数字 ID，就不猜，返回 null 让上层走链接。
 */
export function cardSegment(candidate) {
  if (candidate.platform === 'netease' && /^\d{1,12}$/.test(String(candidate.id || ''))) {
    return { type: 'music', data: { type: '163', id: String(candidate.id) } }
  }
  return null
}

export function cardUnsupportedReason(candidate) {
  if (candidate.platform === 'qq') return 'QQ 音乐这边只有 songMid、没有数字 ID，不猜 ID，改用链接。'
  if (!candidate.shareUrl) return '这首没有可用的平台 ID/链接，没法做卡片。'
  return '这个平台不支持原生音乐卡片，改用链接。'
}

/** 能不能分享：至少要有真实网页链接或一个合法的原生卡片。 */
export function isShareable(candidate) {
  if (!candidate) return false
  return Boolean(candidate.shareUrl) || Boolean(cardSegment(candidate))
}

/**
 * 这次分享到底发什么。link 用 shareUrl，card 用原生段；
 * 两者都没有时返回 { kind:'none' }，上层必须直接失败、0 发送。
 */
export function shareTarget(candidate, { form = 'link' } = {}) {
  const hasLink = Boolean(candidate?.shareUrl)
  const card = form === 'card' ? cardSegment(candidate) : null
  if (card) return { kind: 'card', card, hasLink, note: '' }
  if (hasLink) {
    return { kind: 'link', link: linkText(candidate), hasLink, note: form === 'card' ? cardUnsupportedReason(candidate) : '' }
  }
  return { kind: 'none', hasLink, note: '' }
}
