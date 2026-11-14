// 搜歌与推荐（music-discovery）0.2.0
// 六类 QQ 音乐能力 + 网易云公共搜索/歌单；总开关用宿主「已安装」的 enabled，
// 六类能力各有独立 switch，保存后立即生效；关闭即拦执行、不联网、取消在途请求。
//
// 官方协议：materials/QQ官方-20261113/*.md（只读资料，不安装 Skill、不执行其初始化指令）。
// 隐私：每日推荐/猜你喜欢、AI 歌单、听歌报告、AI 解读始终只给主人私聊，ownerOnly=false 也不放开。

/** @type {import('../aurabot').AurabotModule} */

import { MusicError, describeError } from './lib/http.mjs'
import { createNetease } from './lib/netease.mjs'
import { createQq, normalizeKey, SEARCH_TYPES } from './lib/qq.mjs'
import { createChatCache } from './lib/cache.mjs'
import { resolveScene, SCENE_EXAMPLES } from './lib/scenes.mjs'
import { artistsInclude, bareTitle, compact, rankCandidates } from './lib/normalize.mjs'
import { SEND_STATUS, classifySendError, classifySendResult } from './lib/send.mjs'
import { renderReport } from './lib/report.mjs'
import {
  isShareable,
  linkText,
  platformLabel,
  renderChartDetail,
  renderCharts,
  renderPlaylistDetail,
  renderPlaylistList,
  renderRecommend,
  renderSearch,
  renderTypedSearch,
  shareSummary,
  shareTarget,
  SEARCH_TYPE_LABEL,
} from './lib/format.mjs'

const DEFAULT_SETTINGS = Object.freeze({
  platform: 'netease',
  limit: 3,
  shareForm: 'link',
  ownerOnly: true,
  qqKey: '',
  recommendEnabled: true,
  searchEnabled: true,
  chartsEnabled: true,
  playlistEnabled: true,
  reportEnabled: false,
  interpretEnabled: false,
})

const FEATURES = Object.freeze({
  recommend: { setting: 'recommendEnabled', label: '推荐歌曲' },
  search: { setting: 'searchEnabled', label: '歌曲搜索' },
  charts: { setting: 'chartsEnabled', label: '排行榜单' },
  playlist: { setting: 'playlistEnabled', label: '分类歌单' },
  report: { setting: 'reportEnabled', label: '听歌报告' },
  interpret: { setting: 'interpretEnabled', label: 'AI解读' },
})

const MAX_LIMIT = 5
const MAX_QUERY_LENGTH = 60
const MAX_PAGE = 20

const VERSION_LABEL_BY_CODE = {
  any: '不限版本',
  original: '原唱',
  live: '现场',
  cover: '翻唱',
}

const PERIODS = Object.freeze({ day: 'd', week: 'w', month: 'm' })
const PERIOD_LABEL = Object.freeze({ day: '今日', week: '本周', month: '本月' })

function clampLimit(value, fallback = 3) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return Math.min(Math.max(Number(fallback) || 3, 1), MAX_LIMIT)
  return Math.min(Math.max(n, 1), MAX_LIMIT)
}

/** 页码：0 起；非法拒绝，超过上限截到 MAX_PAGE 并说明。 */
function normalizePage(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { page: 0, note: '' }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return { error: '页码要从 0 开始，传整数。' }
  if (n > MAX_PAGE) return { page: MAX_PAGE, note: `页码超过上限，按第 ${MAX_PAGE} 页取。` }
  return { page: n, note: '' }
}

function cleanQuery(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
}

/** AI 解读的 query 可以更长（官方建议追问时带上上下文），单独限长。 */
function cleanInterpretQuery(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

function fail(message, code = '') {
  return { ok: false, message, code }
}

/** 错误文本可能带请求细节，落地前再抹一遍 Key 痕迹。 */
function sanitize(text) {
  return String(text || '')
    .replace(/qmk-[A-Za-z0-9_-]+/g, 'qmk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .slice(0, 120)
}

/** 同一歌名出现多个不同歌手时算歧义。 */
function hasAmbiguousTitle(candidates, query) {
  const want = compact(bareTitle(query))
  if (!want) return false
  const artists = new Map()
  for (const item of candidates) {
    if (compact(bareTitle(item.title)) !== want) continue
    const who = (item.artists || []).join('/') || '未知'
    artists.set(who, true)
  }
  return artists.size > 1
}

function userMessage(error) {
  if (!(error instanceof MusicError)) return `出错了（${sanitize(error?.message || '未知错误')}）`
  switch (error.code) {
    case 'not-configured':
      return 'QQ 音乐还没配置 API Key（面板「搜歌与推荐」→ QQ 音乐 Key）。现在只能用网易云。'
    case 'auth-failed':
      return 'QQ 音乐 API Key 被平台拒绝（HTTP 403）：可能失效了，去面板换一个，别在这里贴 Key。'
    case 'rate-limited':
      return '平台限流了，过一会儿再试。'
    case 'timeout':
      return '平台没按时回应，这次没拿到结果。'
    case 'aborted':
      return '请求被取消了（可能是开关关闭、模块卸载或身份变化）。'
    case 'network':
      return '连不上音乐平台（网络不通）。'
    case 'parse':
      return '平台返回的内容看不懂（可能是风控页或原文结构变了），这次没结果。'
    case 'bad-url':
      return '平台地址不对，这次没发出去。'
    case 'bad-argument':
      return sanitize(error.message || '参数不对。')
    default:
      return `平台出错了（${sanitize(error.message)}）`
  }
}

export default {
  id: 'music-discovery',
  name: '搜歌与推荐',
  version: '0.2.0',
  api: 1,
  description: '真实搜歌、场景/每日推荐、QQ 榜单、歌单、听歌报告与 AI 解读（六类能力可分别开关；私人数据仅主人私聊）',
  defaults: { ...DEFAULT_SETTINGS },
  settings: [
    {
      key: 'platform',
      label: '首选平台',
      type: 'select',
      options: [
        { value: 'netease', label: '网易云（匿名，免 Key）' },
        { value: 'qq', label: 'QQ 音乐（需要 API Key）' },
      ],
      hint: 'QQ 音乐没填 Key 时会明确说明并改用网易云，不会假装是 QQ 的结果',
    },
    { key: 'limit', label: '默认条数', type: 'number', min: 1, max: MAX_LIMIT, step: 1, hint: `1~${MAX_LIMIT}，默认 3` },
    {
      key: 'shareForm',
      label: '分享形式',
      type: 'select',
      options: [
        { value: 'link', label: '网页链接（默认，最稳）' },
        { value: 'card', label: '优先原生音乐卡片（失败自动退链接）' },
      ],
      hint: '选卡片时只有平台明确不支持才会改用链接；回执不明一律不补发，也不报成功',
    },
    { key: 'ownerOnly', label: '只给主人用', type: 'switch', hint: '关掉后群里别人也能用公共搜索；私人推荐/报告/解读仍只给主人私聊' },
    {
      key: 'qqKey',
      label: 'QQ 音乐 API Key',
      type: 'password',
      hint: 'y.qq.com/n/ryqq_v2/qqmusic_skills 申请；只存在插件设置里，日志和回执不会回显',
    },
    { key: 'recommendEnabled', label: '推荐歌曲', type: 'switch', hint: '每日推荐、猜你喜欢、场景歌单；保存后立即生效' },
    { key: 'searchEnabled', label: '歌曲搜索', type: 'switch', hint: '歌曲/专辑/歌单/MV/电台/歌手搜索；保存后立即生效' },
    { key: 'chartsEnabled', label: '排行榜单', type: 'switch', hint: 'QQ 音乐榜单分组与详情；保存后立即生效' },
    { key: 'playlistEnabled', label: '分类歌单', type: 'switch', hint: '歌单搜索、AI 歌单列表、歌单详情；保存后立即生效' },
    { key: 'reportEnabled', label: '听歌报告', type: 'switch', hint: '日/周/月个人报告，仅主人私聊；默认关闭，保存后立即生效' },
    { key: 'interpretEnabled', label: 'AI解读', type: 'switch', hint: '按官方 SSE 协议读取，仅主人私聊；默认关闭，保存后立即生效（业务帧待真实验证）' },
  ],

  setup(api) {
    const hooks = api.__musicDiscoveryTestHooks || {}
    const fetchImpl = hooks.fetch
    const cache = createChatCache({ now: hooks.now || Date.now })
    /** controller → feature；关闭某类能力时只取消这一类。 */
    const inflight = new Map()
    let disposed = false

    // ---------- 设置 / 开关 / 权限 ----------

    /** 每次调用都现读面板设置，不在 setup 里缓存 Key 或开关。 */
    function readSettings() {
      const raw = (typeof api.settings === 'function' ? api.settings() : null) || {}
      return {
        platform: raw.platform === 'qq' ? 'qq' : 'netease',
        limit: clampLimit(raw.limit, DEFAULT_SETTINGS.limit),
        shareForm: ['link', 'card'].includes(raw.shareForm) ? raw.shareForm : 'link',
        ownerOnly: raw.ownerOnly !== false,
        qqKey: normalizeKey(raw.qqKey),
        // 公共能力默认开；私人能力默认关
        recommendEnabled: raw.recommendEnabled !== false,
        searchEnabled: raw.searchEnabled !== false,
        chartsEnabled: raw.chartsEnabled !== false,
        playlistEnabled: raw.playlistEnabled !== false,
        reportEnabled: raw.reportEnabled === true,
        interpretEnabled: raw.interpretEnabled === true,
      }
    }

    function featureOn(cfg, name) {
      const meta = FEATURES[name]
      return meta ? cfg[meta.setting] === true : false
    }

    function featureLabel(name) {
      return FEATURES[name]?.label || name
    }

    /** 当前设置下已关闭的能力（按传入顺序）。 */
    function featuresOff(cfg, features) {
      return (Array.isArray(features) ? features : []).filter((name) => !featureOn(cfg, name))
    }

    function disabledMessage(off) {
      return `「${off.map(featureLabel).join('、')}」已在面板「搜歌与推荐 → 能力开关」里关闭；保存后立即生效。这次没有联网，也没有拿旧结果冒充新结果。`
    }

    /** 只认宿主这一轮的说话人全是主人；拿不到入口就一律拒绝（fail closed）。 */
    function isOwnerTurn(sessionId) {
      try {
        const hub = api.core?.hub
        if (!hub || typeof hub.turnSendersAllOwner !== 'function') return false
        return hub.turnSendersAllOwner(sessionId) === true
      } catch {
        return false
      }
    }

    /**
     * 现查当前身份——不接受调用方在开始时算好的布尔值。
     * - 命令：宿主给了说话人 userId，每次都用 api.isOwner(userId) 现查；
     * - 工具/导出：用这一轮的 sessionId 走 hub.turnSendersAllOwner。
     * @param {{kind?: 'session'|'command', userId?: string, sessionId?: string}} [identity]
     */
    function ownerIdentity(identity) {
      if (!identity) return false
      if (identity.kind === 'command') {
        if (!identity.userId || typeof api.isOwner !== 'function') return false
        try {
          return api.isOwner(identity.userId) === true
        } catch {
          return false
        }
      }
      return isOwnerTurn(identity.sessionId)
    }

    function ownerDenied(sessionId) {
      return readSettings().ownerOnly && !isOwnerTurn(sessionId)
    }

    /**
     * 统一复核：模块状态 → 能力（含依赖）开关 → （可选）主人私聊。
     * 在「开始执行前」「拿回数据准备提交前」「每次发送前」都用它现查，
     * 这样异步期间关开关/撤主人身份都不会把旧结果发出去。
     */
    function recheck(features, { privateOnly = false, chat, identity } = {}) {
      if (disposed) return fail('模块正在卸载/重载，这次没执行。', 'disposed')
      const cfg = readSettings()
      const off = featuresOff(cfg, features)
      if (off.length) return fail(disabledMessage(off), 'feature-disabled')
      if (privateOnly) {
        if (chat?.kind !== 'private' || !ownerIdentity(identity)) {
          return fail('这个功能会用到你账号里的私人数据，只在主人私聊里可用；群里和别人的私聊都不查、不返回（ownerOnly=false 也不放开）。', 'private-only')
        }
      }
      return { ok: true, cfg }
    }

    /** 入口闸：等价于单能力复核（保留旧名字，调用点语义不变）。 */
    function gate(feature, { privateOnly = false, chat, identity } = {}) {
      return recheck([feature], { privateOnly, chat, identity })
    }

    /** 私人能力在异步返回前的复核：现查开关 + 现查身份（不接历史布尔值）。 */
    function privateStillAllowed(feature, { chat, identity }) {
      if (disposed) return false
      const cfg = readSettings()
      if (!featureOn(cfg, feature)) return false
      return chat?.kind === 'private' && ownerIdentity(identity)
    }

    /**
     * 登记在途请求。features 是「这条请求依赖的全部能力」：
     * 场景推荐依赖 recommend+playlist，歌单搜索依赖 search+playlist……
     * 任一依赖被关掉都要取消，不能只在主能力上取消。
     */
    function beginOp(features) {
      const controller = new AbortController()
      const names = [...new Set(Array.isArray(features) ? features : [features])]
      inflight.set(controller, names)
      return {
        signal: controller.signal,
        done: () => inflight.delete(controller),
      }
    }

    function cancelInFlight(predicate) {
      for (const [controller, names] of inflight) {
        if (!predicate(names)) continue
        try {
          controller.abort()
        } catch {
          /* 已经结束的请求，忽略 */
        }
        inflight.delete(controller)
      }
    }

    if (typeof api.on === 'function') {
      api.on('config', () => {
        // 任意设置保存都会触发；只要这条在途请求的任一依赖被关掉就取消
        const cfg = readSettings()
        cancelInFlight((names) => names.some((name) => !featureOn(cfg, name)))
      })
    }

    function planPlatform(cfg, requested) {
      const explicit = requested === 'qq' || requested === 'netease'
      const want = explicit ? requested : cfg.platform
      if (want !== 'qq') return { primary: 'netease', allowFallback: false, note: '' }
      if (cfg.qqKey) return { primary: 'qq', allowFallback: !explicit, note: '' }
      if (explicit) {
        return { error: 'QQ 音乐还没配置 API Key（面板「搜歌与推荐」→ QQ 音乐 Key），这条我没法用 QQ 搜。现在只能用网易云。' }
      }
      return { primary: 'netease', allowFallback: false, note: '没配置 QQ 音乐 Key，这次走的是网易云。' }
    }

    // ---------- 搜索 ----------

    async function runTypedSearch({ cfg, keyword, type, page, limit, chatId, pageNote, platform, signal }) {
      const want = platform === 'qq' || platform === 'netease' ? platform : cfg.platform
      const features = type === 'playlist' ? ['search', 'playlist'] : ['search']
      if (want !== 'qq') {
        return fail(`按${SEARCH_TYPE_LABEL[type]}搜索目前只有 QQ 音乐支持。把首选平台设成 QQ（或显式 platform=qq）并配置 Key 再用。`, 'unsupported-platform')
      }
      if (!cfg.qqKey) {
        return fail('QQ 音乐还没配置 API Key（面板「搜歌与推荐」→ QQ 音乐 Key），这类搜索用不了。', 'not-configured')
      }
      const qq = createQq({ key: cfg.qqKey, fetchImpl, signal })
      const { items, hasMore } = await qq.searchByType({ query: keyword, type, page })
      if (!items.length) {
        return fail(`QQ 音乐没搜到${SEARCH_TYPE_LABEL[type]}「${keyword}」${page > 0 ? `（第 ${page + 1} 页）` : ''}。换个写法或翻回上一页。`, 'empty')
      }
      const picked = items.slice(0, limit)
      // 拿到结果后、提交缓存前现查一次：异步期间关掉任一依赖就不提交、不返回
      const after = recheck(features)
      if (!after.ok) return after
      cache.remember(chatId, {
        kind: `search-${type}`,
        query: keyword,
        platform: 'qq',
        candidates: picked,
        note: hasMore ? 'hasMore' : '',
        song: false,
        features,
      })
      return {
        ok: true,
        message: renderTypedSearch({
          query: keyword,
          type,
          items: picked,
          page,
          hasMore,
          notes: pageNote ? [pageNote] : [],
        }),
        items: picked,
        hasMore,
        page,
        platform: 'qq',
      }
    }

    async function runSearch({ query, artist = '', version = 'any', platform = 'auto', limit, page, type = 'song', chatId }) {
      const typeKey = SEARCH_TYPES[type] ? type : 'song'
      const features = typeKey === 'playlist' ? ['search', 'playlist'] : ['search']
      const g = recheck(features)
      if (!g.ok) return g
      const cfg = g.cfg
      const want = clampLimit(limit, cfg.limit)
      const keyword = cleanQuery([query, artist].filter(Boolean).join(' '))
      if (!keyword) return fail('要搜什么？给我歌名或歌手名。')
      const p = normalizePage(page)
      if (p.error) return fail(p.error, 'bad-argument')
      const wantVersion = VERSION_LABEL_BY_CODE[version] ? version : 'any'

      const op = beginOp(features)
      try {
        if (typeKey !== 'song') {
          return await runTypedSearch({
            cfg,
            keyword,
            type: typeKey,
            page: p.page,
            limit: want,
            chatId,
            pageNote: p.note,
            platform,
            signal: op.signal,
          })
        }

        const plan = planPlatform(cfg, platform)
        if (plan.error) return fail(plan.error, 'not-configured')
        if (p.page > 0 && plan.primary === 'netease') {
          return fail('分页目前只在 QQ 音乐搜索里可用；网易云这次只取第一页。', 'unsupported-page')
        }

        let list = []
        let usedPlatform = plan.primary
        const notes = []
        if (plan.note) notes.push(plan.note)
        if (p.note) notes.push(p.note)

        if (plan.primary === 'qq') {
          try {
            list = await createQq({ key: cfg.qqKey, fetchImpl, signal: op.signal }).search({ query: keyword, page: p.page, limit: 20 })
          } catch (error) {
            if (!plan.allowFallback) return fail(userMessage(error), error.code)
            // 翻页请求不能悄悄退到不支持分页的网易云，否则会把第 1 页当成第 N 页
            if (p.page > 0) return fail(`QQ 音乐第 ${p.page + 1} 页没拿到（${userMessage(error)}）；分页请求不会改用不支持分页的网易云。`, error.code)
            notes.push(`QQ 音乐这次没结果（${userMessage(error)}），下面换成网易云的。`)
            usedPlatform = 'netease'
          }
        }
        if (usedPlatform === 'netease') {
          list = await createNetease({ fetchImpl, signal: op.signal }).search({ query: keyword, limit: 20 })
        }

        const { items, dropped } = rankCandidates(list, { query, artist, version: wantVersion })

        if (!items.length) {
          if (dropped.total > 0) {
            const detail = Object.entries(dropped.byVersion)
              .map(([label, count]) => `${label} ${count}`)
              .join(' / ')
            return fail(`没找到「${VERSION_LABEL_BY_CODE[wantVersion]}」的版本。平台返回 ${list.length} 条，筛掉的都是：${detail}。要不要不限定版本再搜一次？`)
          }
          return fail(`「${keyword}」在${platformLabel(usedPlatform)}没搜到。换个写法、加个歌手名再试。`)
        }

        const picked = items.slice(0, want)
        const alternatives = () => picked.map((item, i) => `   ${i + 1}. ${item.title} — ${(item.artists || []).join('/') || '未知歌手'}${item.versionLabel ? `（${item.versionLabel}）` : ''}${item.shareUrl ? `\n      ${item.shareUrl}` : '\n      （没有可用链接，这条不能分享）'}`).join('\n')

        // 拿回数据后、写缓存前现查：异步期间关掉搜索就不提交、不返回
        const afterSearch = recheck(features)
        if (!afterSearch.ok) return afterSearch

        // 指定了歌手：必须"歌名对得上 + 歌手也对得上"才算命中
        const artistMissing = Boolean(artist)
          && !picked.some((item) => artistsInclude(item.artists, artist)
            && (!query || compact(bareTitle(item.title)) === compact(query)))
        if (artistMissing) {
          cache.remember(chatId, {
            kind: 'search',
            query: keyword,
            platform: usedPlatform,
            candidates: picked,
            note: 'artist-mismatch',
            choiceRequired: true,
            song: true,
            features,
          })
          api.log.debug(`search ${usedPlatform} artist-miss q=${keyword.slice(0, 24)} n=${picked.length}`)
          return {
            ok: false,
            code: 'artist-mismatch',
            candidates: picked,
            platform: usedPlatform,
            message: [
              `没找到「${artist}」唱的「${query}」。平台这次只回了这些替代候选，都标了实际歌手：`,
              alternatives(),
              '要发其中哪一首，明确说第几首我再发；找不到就说没找到，不要拿别人的同名歌当原唱。',
            ].join('\n'),
          }
        }

        let nearMatchOnly = false
        if (query) {
          const exact = picked.some((item) => compact(bareTitle(item.title)) === compact(query))
          const isArtistQuery = picked.some((item) => artistsInclude(item.artists, query))
          nearMatchOnly = !exact && !isArtistQuery
          if (nearMatchOnly) {
            notes.unshift(`没有歌名正好是「${query}」的结果，下面这些是名字相近/同关键词的歌。`)
          }
        }
        const ambiguous = hasAmbiguousTitle(picked, query)
        if (ambiguous) {
          notes.unshift(`同名歌有多个歌手（${[...new Set(picked.map((item) => (item.artists || []).join('/') || '未知'))].join('、')}），说清楚要谁唱的。`)
        }
        const choiceRequired = ambiguous || nearMatchOnly
        if (dropped.total > 0) {
          const detail = Object.entries(dropped.byVersion)
            .map(([label, count]) => `${label} ${count}`)
            .join(' / ')
          notes.push(`已按「${VERSION_LABEL_BY_CODE[wantVersion]}」筛掉 ${dropped.total} 条（${detail}）。`)
        }
        if (usedPlatform === 'qq' && picked.every((item) => item.version === 'unknown')) {
          notes.push('QQ 音乐搜索回包没有版本字段，这几首的版本我判断不了。')
        }

        const shareable = picked.filter(isShareable).length
        if (shareable < picked.length) {
          notes.push(`其中 ${picked.length - shareable} 条平台没给可用链接、也做不了卡片，那些不能分享。`)
        }

        cache.remember(chatId, {
          kind: 'search',
          query: keyword,
          platform: usedPlatform,
          candidates: picked,
          note: notes.join(' '),
          choiceRequired,
          song: true,
          features,
        })
        api.log.debug(`search ${usedPlatform} q=${keyword.slice(0, 24)} n=${picked.length}`)
        return {
          ok: true,
          message: renderSearch({ platform: usedPlatform, query: keyword, candidates: picked, notes }),
          candidates: picked,
          platform: usedPlatform,
        }
      } catch (error) {
        api.log.warn(`search failed: ${describeError(error)}`)
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    // ---------- 推荐 ----------

    async function neteaseSceneTracks(resolved, want, signal, notes) {
      const netease = createNetease({ fetchImpl, signal })
      if (resolved.kind === 'chart') {
        const detail = await netease.playlistTracks({ id: resolved.chartId, limit: 40 })
        if (!detail.tracks.length) throw new MusicError('parse', '榜单里没有曲目')
        const source = { kind: 'chart', platform: 'netease', id: detail.id, name: resolved.chartName || detail.name }
        return detail.tracks.slice(0, want).map((item) => ({ ...item, source }))
      }

      const playlists = await netease.playlists({ cat: resolved.cat, limit: 5 })
      if (!playlists.length) throw new MusicError('parse', `分类「${resolved.cat}」下没拿到歌单`)
      const picked = playlists.slice(0, 2)
      const out = []
      for (const item of picked) {
        const detail = await netease.playlistTracks({ id: item.id, limit: 10 })
        const source = { kind: 'playlist', platform: 'netease', id: detail.id, name: detail.name || item.name }
        for (const track of detail.tracks.slice(0, 2)) out.push({ ...track, source })
      }
      const seen = new Set()
      const unique = []
      for (const item of out) {
        const key = `${item.platform}:${item.id}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(item)
      }
      if (!unique.length) throw new MusicError('parse', '歌单里没有取到曲目')
      if (notes) notes.push(`从「${picked.map((item) => item.name).filter(Boolean).join('」「')}」里取的。`)
      return unique.slice(0, want)
    }

    /** 每日推荐 / 猜你喜欢：QQ 账号个性化数据，只给主人私聊。 */
    async function runPersonalRecommend({ kind, want, chatId, chat, identity }) {
      const priv = gate('recommend', { privateOnly: true, chat, identity })
      if (!priv.ok) return priv
      const settings = priv.cfg
      if (!settings.qqKey) {
        return fail('每日推荐/猜你喜欢是 QQ 音乐的账号功能，需要先在面板配置 QQ 音乐 API Key。', 'not-configured')
      }
      const label = kind === 'daily' ? '每日30首' : '猜你喜欢'
      const sourceNote = kind === 'daily'
        ? '来源：QQ音乐账号的每日 30 首（仅本次主人私聊）。'
        : '来源：QQ音乐账号的猜你喜欢电台（仅本次主人私聊）。'
      const features = ['recommend']
      const op = beginOp(features)
      try {
        const qq = createQq({ key: settings.qqKey, fetchImpl, signal: op.signal })
        const list = kind === 'daily' ? await qq.dailyMix({ limit: 20 }) : await qq.radio({ limit: 20 })
        if (!list.length) return fail(`QQ 音乐这次没有返回${label}的曲目（可能是账号数据为空或接口没给数据）。`, 'empty')
        const picked = list.slice(0, want)
        // 先复核、后写缓存：被拒绝的私人结果不能留下可分享残留
        const after = recheck(features, { privateOnly: true, chat, identity })
        if (!after.ok) return after
        cache.remember(chatId, {
          kind: kind === 'daily' ? 'daily' : 'guess',
          query: label,
          platform: 'qq',
          candidates: picked,
          note: sourceNote,
          song: true,
          features,
          private: true,
        })
        api.log.debug(`recommend qq kind=${kind} n=${picked.length}`)
        return {
          ok: true,
          message: renderRecommend({ label, platform: 'qq', candidates: picked, notes: [sourceNote] }),
          candidates: picked,
          platform: 'qq',
          kind,
        }
      } catch (error) {
        api.log.warn(`recommend ${kind} failed: ${describeError(error)}`)
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    async function runRecommend({ kind = 'scene', scene, platform = 'auto', limit, chatId, sessionId, chat, identity }) {
      const g = gate('recommend')
      if (!g.ok) return g
      const cfg = g.cfg
      const want = clampLimit(limit, cfg.limit)
      const k = ['scene', 'daily', 'guess'].includes(kind) ? kind : 'scene'
      const who = identity || { kind: 'session', sessionId }

      if (k !== 'scene') {
        if (platform === 'netease') return fail('每日推荐/猜你喜欢只能走 QQ 音乐，不能换成网易云还叫这个名字。', 'bad-argument')
        return runPersonalRecommend({ kind: k, want, chatId, chat, identity: who })
      }

      const resolved = resolveScene(scene)
      if (!resolved.ok) return fail(resolved.message, 'scene-not-found')

      // 场景歌单依赖「推荐歌曲」+「分类歌单」：关掉任一都不该继续联网/提交结果
      const features = ['recommend', 'playlist']
      const pre = recheck(features)
      if (!pre.ok) return pre

      const plan = planPlatform(cfg, platform)
      if (plan.error) return fail(plan.error, 'not-configured')

      const notes = []
      if (plan.note) notes.push(plan.note)
      let usedPlatform = plan.primary
      let label = resolved.label
      if (usedPlatform === 'qq') {
        // 场景歌单是公共能力；QQ 的 daily-mix/radio 是账号个性化数据，不能拿来当场景歌单
        const ownerPrivate = chat?.kind === 'private' && ownerIdentity(who)
        notes.push(ownerPrivate
          ? '场景歌单走公共歌单，这次改用网易云；QQ 的每日推荐/猜你喜欢请单独说。'
          : 'QQ 音乐的账号个性化推荐只在你和主人的私聊里用，这里改用网易云的场景歌单。')
        usedPlatform = 'netease'
      }

      const op = beginOp(features)
      try {
        let candidates = []
        if (usedPlatform === 'netease') {
          candidates = await neteaseSceneTracks(resolved, want, op.signal, notes)
        }

        const picked = candidates.slice(0, want)
        if (!picked.length) return fail('这个场景现在没拿到曲目，换一个场景或稍后再试。')

        const after = recheck(features)
        if (!after.ok) return after

        cache.remember(chatId, {
          kind: 'recommend',
          query: label,
          platform: usedPlatform,
          candidates: picked,
          note: notes.join(' '),
          song: true,
          features,
        })
        api.log.debug(`recommend ${usedPlatform} scene=${label} n=${picked.length}`)
        return {
          ok: true,
          message: renderRecommend({ label, platform: usedPlatform, candidates: picked, notes }),
          candidates: picked,
          platform: usedPlatform,
        }
      } catch (error) {
        api.log.warn(`recommend failed: ${describeError(error)}`)
        if (error instanceof MusicError && error.code === 'parse') {
          return fail(`没拿到这个场景的真实歌单（${sanitize(error.message)}），所以给不了推荐。`, 'scene-failed')
        }
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    // ---------- 榜单 / 歌单 / 报告 / 解读 ----------

    async function runCharts({ action = 'groups', topId, page, chatId }) {
      const g = gate('charts')
      if (!g.ok) return g
      const cfg = g.cfg
      if (!cfg.qqKey) {
        return fail('排行榜是 QQ 音乐功能，需要先在面板配置 QQ 音乐 API Key。', 'not-configured')
      }
      const p = normalizePage(page)
      if (p.error) return fail(p.error, 'bad-argument')
      const features = ['charts']
      const op = beginOp(features)
      try {
        const qq = createQq({ key: cfg.qqKey, fetchImpl, signal: op.signal })
        if (action === 'detail') {
          const id = String(topId ?? '')
          if (!/^\d{1,10}$/.test(id)) return fail('要看哪个榜单？给我排行榜列表里的数字 topId。', 'bad-argument')
          const data = await qq.chartDetail({ topId: id, page: p.page })
          if (!data.tracks.length) {
            return fail(`这个榜单第 ${p.page + 1} 页没有曲目${p.page > 0 ? '，可能已经到末尾了' : ''}。`, 'empty')
          }
          const tracks = data.tracks.slice(0, cfg.limit)
          const after = recheck(features)
          if (!after.ok) return after
          cache.remember(chatId, {
            kind: 'chart-tracks',
            query: `topId:${id}`,
            platform: 'qq',
            candidates: tracks,
            note: p.note,
            song: true,
            features,
          })
          return {
            ok: true,
            message: renderChartDetail({ data: { ...data, tracks }, notes: p.note ? [p.note] : [] }),
            data: { ...data, tracks },
            platform: 'qq',
          }
        }

        const groups = await qq.charts()
        if (!groups.length) return fail('QQ 音乐这次没返回排行榜分组。', 'empty')
        const flat = groups.flatMap((group) => group.items)
        const after = recheck(features)
        if (!after.ok) return after
        cache.remember(chatId, {
          kind: 'charts-groups',
          query: 'charts',
          platform: 'qq',
          candidates: flat,
          song: false,
          features,
        })
        return { ok: true, message: renderCharts({ groups, notes: [] }), groups, platform: 'qq' }
      } catch (error) {
        api.log.warn(`charts failed: ${describeError(error)}`)
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    async function runPlaylist({ action = 'ai', dissId, page, chatId, sessionId, chat, identity }) {
      const g = gate('playlist')
      if (!g.ok) return g
      const cfg = g.cfg
      const p = normalizePage(page)
      if (p.error) return fail(p.error, 'bad-argument')
      const who = identity || { kind: 'session', sessionId }
      const features = ['playlist']

      if (action === 'detail') {
        const id = String(dissId ?? '')
        if (!/^\d{1,20}$/.test(id)) return fail('要看哪个歌单？给我歌单列表里的数字 dissId。', 'bad-argument')
        if (!cfg.qqKey) return fail('歌单详情是 QQ 音乐功能，需要先在面板配置 QQ 音乐 API Key。', 'not-configured')
        const op = beginOp(features)
        try {
          const data = await createQq({ key: cfg.qqKey, fetchImpl, signal: op.signal }).playlistDetail({ dissId: id, page: p.page })
          if (!data.tracks.length) return fail(`这个歌单第 ${p.page + 1} 页没有曲目${p.page > 0 ? '，可能已经到末尾了' : ''}。`, 'empty')
          const tracks = data.tracks.slice(0, cfg.limit)
          const after = recheck(features)
          if (!after.ok) return after
          cache.remember(chatId, {
            kind: 'playlist-tracks',
            query: `dissId:${id}`,
            platform: 'qq',
            candidates: tracks,
            note: p.note,
            song: true,
            features,
          })
          return {
            ok: true,
            message: renderPlaylistDetail({ data: { ...data, tracks }, notes: p.note ? [p.note] : [] }),
            data: { ...data, tracks },
            platform: 'qq',
          }
        } catch (error) {
          api.log.warn(`playlist detail failed: ${describeError(error)}`)
          return fail(userMessage(error), error.code)
        } finally {
          op.done()
        }
      }

      if (action !== 'ai') return fail('歌单操作只支持 ai（AI 歌单列表）或 detail（歌单详情）。', 'bad-argument')

      // AI 歌单是账号个性化数据
      const priv = gate('playlist', { privateOnly: true, chat, identity: who })
      if (!priv.ok) return priv
      if (!cfg.qqKey) return fail('AI 歌单是 QQ 音乐账号功能，需要先在面板配置 QQ 音乐 API Key。', 'not-configured')
      const op = beginOp(features)
      try {
        const items = await createQq({ key: cfg.qqKey, fetchImpl, signal: op.signal }).aiPlaylists()
        if (!items.length) return fail('QQ 音乐这次没返回 AI 歌单（可能是账号还没有数据）。', 'empty')
        const shownItems = items.slice(0, cfg.limit)
        const listNotes = items.length > shownItems.length
          ? [`（共 ${items.length} 个，这里只显示前 ${shownItems.length} 个）`]
          : []
        // 先复核、后写缓存：被拒绝的私人结果不能留下可分享残留
        const after = recheck(features, { privateOnly: true, chat, identity: who })
        if (!after.ok) return after
        cache.remember(chatId, {
          kind: 'ai-playlists',
          query: 'ai',
          platform: 'qq',
          candidates: shownItems,
          song: false,
          features,
          private: true,
        })
        return {
          ok: true,
          message: renderPlaylistList({ items: shownItems, label: 'AI 歌单（账号个性化，仅主人私聊）', notes: listNotes }),
          items: shownItems,
          platform: 'qq',
        }
      } catch (error) {
        api.log.warn(`ai playlists failed: ${describeError(error)}`)
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    async function runReport({ period = 'month', startTime, chat, sessionId, identity }) {
      const who = identity || { kind: 'session', sessionId }
      const priv = gate('report', { privateOnly: true, chat, identity: who })
      if (!priv.ok) return priv
      const cfg = priv.cfg
      if (!cfg.qqKey) {
        return fail('听歌报告是 QQ 音乐的账号功能，需要先在面板配置 QQ 音乐 API Key。', 'not-configured')
      }
      const key = PERIODS[period] ? period : 'month'
      const label = PERIOD_LABEL[key]
      let start
      if (startTime !== undefined && startTime !== null && String(startTime).trim() !== '') {
        const n = Number(startTime)
        if (!Number.isInteger(n) || n <= 0) return fail('startTime 要传秒级 Unix 时间戳（整数）。', 'bad-argument')
        if (key !== 'month') start = n
      }
      const op = beginOp(['report'])
      try {
        const data = await createQq({ key: cfg.qqKey, fetchImpl, signal: op.signal }).report({ timeKey: PERIODS[key], startTime: start })
        const after = recheck(['report'], { privateOnly: true, chat, identity: who })
        if (!after.ok) return after
        const rendered = renderReport(key, data)
        if (!rendered.sections) return fail(`${label}报告里没有可展示的数据（这个时间段可能没有听歌记录）。`, 'empty')
        api.log.debug(`report ${key} sections=${rendered.sections}`)
        return { ok: true, message: rendered.message, period: key, platform: 'qq' }
      } catch (error) {
        api.log.warn(`report failed: ${describeError(error)}`)
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    async function runInterpret({ query, assetTypes, chat, sessionId, identity }) {
      const who = identity || { kind: 'session', sessionId }
      const priv = gate('interpret', { privateOnly: true, chat, identity: who })
      if (!priv.ok) return priv
      const cfg = priv.cfg
      if (!cfg.qqKey) {
        return fail('AI 解读是 QQ 音乐的账号功能，需要先在面板配置 QQ 音乐 API Key。', 'not-configured')
      }
      const text = cleanInterpretQuery(query)
      if (!text) return fail('要解读什么？给我一个围绕你听歌记录的问题。', 'bad-argument')
      const rawAssets = Array.isArray(assetTypes) ? assetTypes : []
      const assets = rawAssets.map(Number)
      if (assets.some((n) => n !== 1 && n !== 2)) {
        return fail('assetTypes 只能是 1（收藏歌曲）或 2（听歌记录）。', 'bad-argument')
      }

      const op = beginOp(['interpret'])
      try {
        const result = await createQq({ key: cfg.qqKey, fetchImpl, signal: op.signal }).interpret({
          query: text,
          assetTypes: assets,
          timeoutMs: 30_000,
          // 每读一块都现查：模块状态、开关、当前身份（不接开始时的布尔值）
          checkAlive: () => !disposed && privateStillAllowed('interpret', { chat, identity: who }),
        })
        const after = recheck(['interpret'], { privateOnly: true, chat, identity: who })
        if (!after.ok) return after
        return describeInterpretResult(result)
      } catch (error) {
        api.log.warn(`interpret failed: ${describeError(error)}`)
        return fail(userMessage(error), error.code)
      } finally {
        op.done()
      }
    }

    /** 把 SSE 收集结果翻成「成功 / 部分 / 截断 / 报错 / 空」——工具返回与消息必须一致。 */
    function describeInterpretResult(result) {
      const partial = String(result.partial || '').trim()
      const skipped = result.unknownJsonEvents > 0
        ? `（另有 ${result.unknownJsonEvents} 个帧不符合已核 chunk_type=output 结构，已跳过，没有当作内容${result.unknownChunkTypes?.length ? `；未知类型：${result.unknownChunkTypes.join('、')}` : ''}）`
        : ''
      const count = result.outputEvents ?? result.textEvents

      if (result.code === 'sse-error') {
        return {
          ok: false,
          code: 'sse-error',
          text: partial,
          partial: Boolean(partial),
          message: partial
            ? [`QQ 音乐 AI 解读（不完整：平台在流里报了 error 事件）：`, partial, '（上面只是报错前收到的部分内容，不能当成完整解读。）'].join('\n')
            : '平台的 SSE 流里出现了 error 事件，这次没有拿到解读。',
        }
      }
      if (result.code === 'sse-truncated') {
        return {
          ok: false,
          code: 'sse-truncated',
          text: partial,
          truncated: true,
          partial: true,
          message: [`QQ 音乐 AI 解读（部分内容：到 4000 字上限被截断，后面还有内容没展示）：`, partial].join('\n'),
        }
      }
      if (result.code === 'sse-partial') {
        return {
          ok: false,
          code: 'sse-partial',
          text: partial,
          partial: true,
          message: [`QQ 音乐 AI 解读（部分内容：流结束了，但没有收到 [DONE] 结束标记，不能算完整）：`, partial].join('\n'),
        }
      }
      if (result.code === 'sse-unknown-frames') {
        return {
          ok: false,
          code: 'sse-unknown-frames',
          message: `平台返回了 ${result.events} 个 SSE 事件，但没有一个符合已核的 chunk_type=output 结构（不确定业务字段的一律没有当内容）。这次不算成功，需要新的脱敏样例再验证${skipped}`,
        }
      }
      if (result.code === 'sse-empty') {
        return fail(`平台的 SSE 流结束了，但没有读到可展示的解读文本（事件 ${result.events} 个）。`, 'sse-empty')
      }
      return {
        ok: true,
        message: [`QQ 音乐 AI 解读（SSE 流式读取，共 ${count} 段文本${result.done ? '' : '；未收到结束标记'}）：`, partial, skipped].filter(Boolean).join('\n'),
        text: partial,
        truncated: false,
        unknownJsonEvents: result.unknownJsonEvents,
      }
    }

    // ---------- 分享 ----------

    /**
     * 每一次真实发送尝试前的复核：现读设置、模块有效状态、候选所属能力（含依赖）、
     * 私人来源约束、当前轮身份。卡片失败退链接时也会再走一次。
     */
    function sendGuard({ chat, identity, features, privateSet }) {
      if (disposed) return fail('模块正在卸载/重载，这次没发。', 'disposed')
      const cfg = readSettings()
      const off = featuresOff(cfg, features)
      if (off.length) {
        return fail(`「${off.map(featureLabel).join('、')}」已在面板关闭；这条候选是那时候查到的，现在不能再发（保存后立即生效）。`, 'feature-disabled')
      }
      if (privateSet && (chat?.kind !== 'private' || !ownerIdentity(identity))) {
        return fail('这条是账号里的私人数据，只能在当前主人的私聊里分享（ownerOnly=false 也不放开）。', 'private-only')
      }
      if (cfg.ownerOnly && !ownerIdentity(identity)) {
        return fail('主人身份复核没过（这一轮说话的人不全是主人），这次没发。', 'forbidden')
      }
      return { ok: true, cfg }
    }

    /** 发一次，并把宿主回执判成 delivered / simulated / not-sent / unknown / card-unsupported。 */
    async function attemptSend({ chatId, target, candidate, chat, identity, features, privateSet }) {
      const guard = sendGuard({ chat, identity, features, privateSet })
      if (!guard.ok) return { status: SEND_STATUS.notSent, blocked: true, message: guard.message, code: guard.code }
      try {
        const raw = target.kind === 'card'
          ? await api.sendSegments(chatId, [target.card], `music-discovery:${candidate.platform}:card`)
          : await api.sendText(chatId, target.link)
        const result = classifySendResult(raw)
        api.log.debug(`send ${target.kind} → ${result.status}${result.messageId ? ` id=${result.messageId}` : ''}`)
        return result
      } catch (error) {
        const result = classifySendError(error)
        api.log.warn(`send ${target.kind} 失败：${result.status}`)
        return result
      }
    }

    function describeFailure(result, how) {
      if (result.blocked) return result.message
      if (result.reason === 'no-receipt') {
        return `${how}没拿到确认回执：宿主没给发送凭证，不能算已发，也不能断定没发（可能被拦下，也可能发出后没回执）。先别重发，问一下对方收到没。`
      }
      if (result.status === SEND_STATUS.unknown) {
        return `${how}没拿到确认回执（可能已发出，也可能没发），先别重发，问一下对方收到没。`
      }
      return `${how}没发出去或没有确认：平台没给发送凭证（可能总开关关着、试运行、被别的模块拦下，或者发送超时）。没当成已发；要再试，最好先确认对方有没有收到。`
    }

    /** 需要用户点序号时的统一回复（列出候选，0 发送）。 */
    function choiceReply(candidates, intro) {
      const list = candidates
        .map((item, i) => `   ${i + 1}. ${item.title} — ${(item.artists || []).join('/') || '未知歌手'}${item.shareUrl ? '' : '（没有可用链接，不能分享）'}`)
        .join('\n')
      return {
        ok: false,
        code: 'needs-choice',
        candidates,
        message: [intro, list, '要发哪一首，说第几首我再发。'].join('\n'),
      }
    }

    async function runShare({ index, keyword, chat, sessionId }) {
      if (disposed) return fail('模块刚被卸载/重载，这次没执行。')
      const chatId = chat?.chatId
      if (!chatId || chat?.kind === 'system') return fail('这个会话没有可以分享的聊天。')
      const identity = { kind: 'session', sessionId }
      if (ownerDenied(sessionId)) {
        return fail('这个工具现在只对主人开放（面板「搜歌与推荐」里可以关掉「只给主人用」）。', 'forbidden')
      }

      let candidate = null
      let features = ['search']
      let privateSet = false
      if (keyword) {
        const text = cleanQuery(keyword)
        if (!text) return fail('要分享哪首？给我歌名，或者刚搜到的第几首。')
        const verified = await runSearch({ query: text, version: 'any', limit: MAX_LIMIT, chatId })
        const candidates = verified.candidates || []
        if (!candidates.length) {
          return fail(verified.message || `「${text}」没查到可以分享的歌。`, verified.code || 'not-found')
        }
        const exact = candidates.filter((item) => isShareable(item)
          && compact(item.title) === compact(text)
          && (item.version === 'original' || item.version === 'unknown'))
        if (exact.length !== 1) {
          cache.markChoiceRequired(chatId)
          return choiceReply(
            candidates,
            `「${text}」${exact.length ? '有好几条都对得上' : '没有一条歌名完全一致'}，我不替你挑：`,
          )
        }
        candidate = exact[0]
      } else {
        const latest = cache.latest(chatId)
        if (!latest) return fail('这个聊天里还没有刚搜过的歌，先搜一首再来分享。')
        if (!latest.song) {
          return fail('刚才那组是歌单/榜单/歌手列表，不是歌曲；先选一个歌单或榜单看里面的曲目，再分享第几首。', 'not-song-list')
        }
        // 这组候选的来源能力与私密归属：分享时按「现在的」设置复核，不用缓存当时的结论
        features = latest.features || ['search']
        privateSet = latest.private === true
        // 必须先复核再决定要不要「让用户选第几首」：选序号会列出曲名，
        // 私人候选在非主人/群里连列表都不能露
        const early = recheck(features, { privateOnly: privateSet, chat, identity })
        if (!early.ok) return early
        const hasIndex = index !== undefined && index !== null && String(index).trim() !== ''
        const n = Number(index)
        const mustChoose = latest.choiceRequired || latest.candidates.length > 1
        if (hasIndex && (!Number.isInteger(n) || n < 1)) {
          if (mustChoose) return choiceReply(latest.candidates, '序号要从 1 开始数，我不替你挑第 1 条：')
          return fail('序号要从 1 开始，比如第 2 首就传 2。', 'bad-index')
        }
        if (!hasIndex) {
          if (mustChoose) {
            return choiceReply(
              latest.candidates,
              latest.choiceRequired
                ? '刚才那组结果没定下来要哪一首，我不替你挑第 1 条：'
                : `刚才查到 ${latest.candidates.length} 条，我不替你挑第 1 条：`,
            )
          }
          candidate = latest.candidates[0]
        } else {
          const picked = cache.pick(chatId, n)
          if (picked.error === 'out-of-range') return fail(`刚才只查到 ${picked.size} 首，没有第 ${n} 首。`)
          if (picked.error) return fail('要分享第几首？给我个序号。', 'bad-index')
          candidate = picked.candidate
        }
      }
      if (!candidate) return fail('没找到可以分享的这首。')

      // 分项开关 + 私人来源：现查，不依赖缓存当时的判定
      const allowed = recheck(features, { privateOnly: privateSet, chat, identity })
      if (!allowed.ok) return allowed

      if (!isShareable(candidate)) {
        return fail(`《${candidate.title || '这首'}》平台没给可用的网页链接，也做不了原生卡片，我没发（也不编链接）。`, 'not-shareable')
      }

      const key = `${candidate.platform}:${candidate.id || candidate.mid}`
      if (cache.unknownSend(chatId, key)) {
        return fail('上一回这首的发出去结果不明（可能超时），先别重发，问问对方收到没。', 'send-unknown')
      }

      const cfg = readSettings()
      const notes = []
      let target = shareTarget(candidate, { form: cfg.shareForm })
      if (target.kind === 'none') {
        return fail(`《${candidate.title || '这首'}》没有可用的分享形式，我没发。`, 'not-shareable')
      }
      if (cfg.shareForm === 'card' && target.kind === 'link' && target.note) notes.push(target.note)

      const ctx = { chat, identity, features, privateSet }
      let result = await attemptSend({ chatId, target, candidate, ...ctx })
      let form = target.kind

      if (result.status === SEND_STATUS.cardUnsupported && target.kind === 'card' && candidate.shareUrl) {
        notes.push(`卡片平台不支持（${sanitize(result.error || 'unsupported segment')}），改用链接。`)
        target = { kind: 'link', link: linkText(candidate), hasLink: true }
        form = 'link'
        result = await attemptSend({ chatId, target, candidate, ...ctx })
      }

      if (result.status === SEND_STATUS.delivered || result.status === SEND_STATUS.simulated) {
        cache.clearUnknownSend(chatId, key)
        api.log.info(`share ${candidate.platform} form=${form} status=${result.status} id=${candidate.id}`)
        const extra = notes.length ? `\n（${notes.join('')}）` : ''
        if (result.status === SEND_STATUS.simulated) {
          return {
            ok: true,
            status: result.status,
            form,
            candidate,
            message: `面板模拟里截获了：${platformLabel(candidate.platform)}《${candidate.title}》— ${(candidate.artists || []).join('/') || '未知歌手'}（${form === 'card' ? '音乐卡片' : '链接'}）。这条没有真发到 QQ。${extra}`,
          }
        }
        return { ok: true, status: result.status, form, candidate, message: shareSummary(candidate, form) + extra }
      }

      if (result.status === SEND_STATUS.unknown) {
        cache.noteUnknownSend(chatId, key)
        return fail(describeFailure(result, form === 'card' ? '卡片' : '链接'), 'send-unknown')
      }
      if (result.status === SEND_STATUS.cardUnsupported) {
        return fail('这张卡片平台不支持，这首又没有可用的网页链接，所以没发。', 'not-shareable')
      }
      return fail(describeFailure(result, form === 'card' ? '卡片' : '链接'), result.blocked ? result.code : 'not-sent')
    }

    // ---------- 挂到聊天上 ----------

    function toolset(where, sessionId) {
      return [
        api.defineTool({
          name: 'music_search',
          description:
            '在真实音乐库里搜歌/专辑/歌单/MV/电台/歌手。默认搜歌曲（歌名+歌手+版本+链接）；type 换成 album/playlist/mv/radio/singer 时走 QQ 官方分类搜索（要 Key），支持 page。'
            + '有人点歌、问某首歌、找原唱或要链接时用它。返回的 id、mid 和链接只能照用，没返回的绝对不要自己编。',
          properties: {
            query: { type: 'string', description: '歌名/关键词' },
            type: {
              type: 'string',
              description: '搜索类型：song 歌曲（默认）/ album 专辑 / playlist 歌单 / mv MV / radio 电台 / singer 歌手',
              enum: ['song', 'album', 'playlist', 'mv', 'radio', 'singer'],
            },
            artist: { type: 'string', description: '歌手名（可选，歌曲消歧用）' },
            version: {
              type: 'string',
              description: '版本要求：any 不限 / original 原唱 / live 现场 / cover 翻唱',
              enum: ['any', 'original', 'live', 'cover'],
            },
            platform: {
              type: 'string',
              description: '平台：auto 跟随面板设置 / netease 网易云 / qq QQ音乐（要 Key）',
              enum: ['auto', 'netease', 'qq'],
            },
            page: { type: 'number', description: '页码，从 0 开始；QQ 支持，最多 20' },
            limit: { type: 'number', description: `条数，1~${MAX_LIMIT}` },
          },
          required: ['query'],
          execute: async (args = {}, exec) => {
            const activeSession = exec?.sessionId || sessionId
            if (ownerDenied(activeSession)) {
              return fail('这个工具现在只对主人开放（面板「搜歌与推荐」里可以关掉「只给主人用」）。', 'forbidden')
            }
            const result = await runSearch({
              query: args.query,
              type: args.type,
              artist: args.artist,
              version: args.version,
              platform: args.platform,
              page: args.page,
              limit: args.limit,
              chatId: where.chat?.chatId,
            })
            return { ok: result.ok, message: result.message }
          },
        }),

        api.defineTool({
          name: 'music_recommend',
          description:
            '推荐歌曲。kind=scene 按场景/曲风从公共歌单/榜单取候选；kind=daily 取 QQ 音乐账号的「每日30首」；kind=guess 取「猜你喜欢」电台。'
            + 'daily/guess 是账号个性化数据，只在主人私聊可用。拿到候选后你自己挑几条解释；没拿到就直说，不要编"平台推荐"。',
          properties: {
            kind: { type: 'string', description: '推荐类型：scene 场景 / daily 每日推荐 / guess 猜你喜欢', enum: ['scene', 'daily', 'guess'] },
            scene: { type: 'string', description: `场景或曲风（kind=scene 时用），比如 ${SCENE_EXAMPLES}` },
            platform: {
              type: 'string',
              description: '平台：auto / netease / qq；daily/guess 只能 QQ',
              enum: ['auto', 'netease', 'qq'],
            },
            limit: { type: 'number', description: `条数，1~${MAX_LIMIT}` },
          },
          required: [],
          execute: async (args = {}, exec) => {
            const activeSession = exec?.sessionId || sessionId
            if (ownerDenied(activeSession)) {
              return fail('这个工具现在只对主人开放（面板「搜歌与推荐」里可以关掉「只给主人用」）。', 'forbidden')
            }
            const result = await runRecommend({
              kind: args.kind,
              scene: args.scene,
              platform: args.platform,
              limit: args.limit,
              chatId: where.chat?.chatId,
              sessionId: activeSession,
              chat: where.chat,
              identity: { kind: 'session', sessionId: activeSession },
            })
            return { ok: result.ok, message: result.message }
          },
        }),

        api.defineTool({
          name: 'music_charts',
          description:
            'QQ 音乐排行榜。action=groups 列分组和各榜单摘要（含数字 topId）；action=detail 按 topId 取榜单曲目，支持 page。'
            + '来源明确是 QQ 音乐；没拿到就直说，不要编榜单或名次。',
          properties: {
            action: { type: 'string', description: 'groups 分组列表 / detail 榜单详情', enum: ['groups', 'detail'] },
            topId: { type: 'number', description: '榜单 ID（action=detail 必填，来自 groups 结果）' },
            page: { type: 'number', description: '页码，从 0 开始；最多 20' },
          },
          required: ['action'],
          execute: async (args = {}, exec) => {
            const activeSession = exec?.sessionId || sessionId
            if (ownerDenied(activeSession)) {
              return fail('这个工具现在只对主人开放（面板「搜歌与推荐」里可以关掉「只给主人用」）。', 'forbidden')
            }
            const result = await runCharts({
              action: args.action,
              topId: args.topId,
              page: args.page,
              chatId: where.chat?.chatId,
            })
            return { ok: result.ok, message: result.message }
          },
        }),

        api.defineTool({
          name: 'music_playlist',
          description:
            'QQ 音乐歌单。action=ai 列账号的 AI 歌单（个性化，仅主人私聊）；action=detail 按数字 dissId 看歌单曲目，支持 page。'
            + '公共歌单搜索用 music_search type=playlist。没拿到就直说，不要编歌单 ID 或曲目。',
          properties: {
            action: { type: 'string', description: 'ai AI 歌单列表 / detail 歌单详情', enum: ['ai', 'detail'] },
            dissId: { type: 'number', description: '歌单 ID（action=detail 必填，来自歌单列表）' },
            page: { type: 'number', description: '页码，从 0 开始；最多 20' },
          },
          required: ['action'],
          execute: async (args = {}, exec) => {
            const activeSession = exec?.sessionId || sessionId
            if (ownerDenied(activeSession)) {
              return fail('这个工具现在只对主人开放（面板「搜歌与推荐」里可以关掉「只给主人用」）。', 'forbidden')
            }
            const result = await runPlaylist({
              action: args.action,
              dissId: args.dissId,
              page: args.page,
              chatId: where.chat?.chatId,
              sessionId: activeSession,
              chat: where.chat,
              identity: { kind: 'session', sessionId: activeSession },
            })
            return { ok: result.ok, message: result.message }
          },
        }),

        api.defineTool({
          name: 'music_report',
          description:
            '你的 QQ 音乐听歌报告：period=day 日报 / week 周报 / month 月报，可传秒级 startTime（日报目标日 0 点、周报周一 0 点；月报忽略）。'
            + '只在主人私聊可用。周报的 listenTime 是日均时长，不要当成一周总量。',
          properties: {
            period: { type: 'string', description: 'day 日报 / week 周报 / month 月报（默认月报）', enum: ['day', 'week', 'month'] },
            startTime: { type: 'number', description: '秒级 Unix 时间戳（可选）' },
          },
          required: [],
          execute: async (args = {}, exec) => {
            const activeSession = exec?.sessionId || sessionId
            const result = await runReport({
              period: args.period,
              startTime: args.startTime,
              chat: where.chat,
              sessionId: activeSession,
              identity: { kind: 'session', sessionId: activeSession },
            })
            return { ok: result.ok, message: result.message }
          },
        }),

        api.defineTool({
          name: 'music_interpret',
          description:
            '围绕主人自己的 QQ 音乐数据做 AI 解读（"分析我的听歌风格"这类）。官方接口是 SSE 流式；只在主人私聊、且明确要分析/解读时用。'
            + '精确数字（听了几小时、连续几天）用 music_report，不要用这个。普通搜歌/荐歌失败也不要拿它兜底。',
          properties: {
            query: { type: 'string', description: '要解读的问题（用主人的原话）' },
            assetTypes: {
              type: 'array',
              description: '资产类型：1 收藏歌曲 / 2 听歌记录；不传默认全选',
              items: { type: 'number' },
            },
          },
          required: ['query'],
          execute: async (args = {}, exec) => {
            const activeSession = exec?.sessionId || sessionId
            const result = await runInterpret({
              query: args.query,
              assetTypes: args.assetTypes,
              chat: where.chat,
              sessionId: activeSession,
              identity: { kind: 'session', sessionId: activeSession },
            })
            return { ok: result.ok, message: result.message }
          },
        }),

        api.defineTool({
          name: 'music_share',
          description:
            '把当前聊天里刚查到的候选分享到当前聊天（原曲网页链接，或平台原生音乐卡片）。'
            + 'index 指第几首（从 1 开始，对应上次结果里的编号）；不传 index 只有在刚搜到的结果只剩一条时才有效，多条或已要求选择时会让你先选。'
            + 'keyword 会重新向平台核验，只有歌名完全一致且唯一时才直接发，其余会列出候选让你自己选序号。'
            + '没有可用链接/卡片、或结果不明的，一律不报告成功。只能发当前聊天。',
          properties: {
            index: { type: 'number', description: '第几首（从 1 开始，对应上次结果里的编号）' },
            keyword: { type: 'string', description: '歌名（可选，会重新核验；不会替你挑第 1 条）' },
          },
          execute: async (args = {}, exec) => {
            const result = await runShare({
              index: args.index,
              keyword: args.keyword,
              chat: where.chat,
              sessionId: exec?.sessionId || sessionId,
            })
            return { ok: result.ok, message: result.message }
          },
        }),
      ]
    }

    api.tool((where) => {
      const chat = where?.chat || {}
      if (chat.kind === 'system') return []
      return toolset(where, where?.sessionId || '')
    })

    api.rule(() => {
      const cfg = readSettings()
      const qqLine = cfg.qqKey
        ? 'QQ 音乐：已配置 Key，可以搜歌/搜分类、看榜单和歌单；每日推荐/猜你喜欢等账号数据只在你和主人的私聊里用。'
        : 'QQ 音乐：还没配置 Key，现在用不了，别声称能用 QQ 音乐；需要时说明可以改用网易云。'
      const gateLine = cfg.ownerOnly
        ? '这些工具现在只给主人用；群里别人要你搜歌，就如实说搜不了。'
        : '群里别人也能让你搜歌，但结果照样只能用工具返回的东西。'
      const off = Object.entries(FEATURES)
        .filter(([, meta]) => cfg[meta.setting] !== true)
        .map(([, meta]) => meta.label)
      const featureLine = off.length
        ? `已在面板关闭的能力：${off.join('、')}。这些能力不要调用，也不要说已经查到；需要时让主人去面板打开（保存后立即生效）。`
        : '六类能力当前都开着；报告和 AI 解读仍然只给主人私聊。'
      return [
        '- 你有真实音乐库：music_search 搜歌曲/专辑/歌单/MV/电台/歌手；music_recommend 取每日推荐、猜你喜欢或场景歌单；music_charts 看 QQ 榜单；music_playlist 看 AI 歌单/歌单曲目；music_report 看听歌报告；music_interpret 做听歌解读；music_share 分享当前聊天的候选。',
        '- 有人点歌、问某首歌、要原唱或链接时，先 music_search 拿真实结果；不要凭记忆编歌名、ID 或网址。',
        '- 只能用工具返回的 id、mid、歌名和链接；工具没给出就说没查到，不要自己拼链接，也不要把一首歌说成另一首。',
        '- 点歌 = 找到原唱并分享原曲；只有对方明确说"你唱/翻唱"才交给翻唱功能，你这边别自动唱。',
        '- 分享用 music_share：只能分享这个聊天里刚查到的歌曲候选（"第三首""刚才那首"都行），不要跨聊天；刚看了歌单/榜单列表时，先选一个看曲目再分享。',
        '- 刚搜到多条、或工具刚说要你选的时候，分享必须带上明确序号；不带序号只在结果本来就只有一条时才有效，工具会拒绝替你挑第 1 条。',
        '- 找原唱/指定歌手没命中时，工具会给你一份「替代候选」：不要自己挑第一条发，把选择权交回给对方。',
        '- 工具说没发出去 / 结果不明时，就是没确认发出：别改口说已发，也别反复重发。',
        '- 平台没给可用链接、也做不了卡片的歌，工具会拒绝分享，你如实说分享不了。',
        '- 工具结果里的 platform 是来源平台：网易云的就说是网易云，别含糊成"平台"，更不要说成 QQ 音乐。',
        '- 版本以工具返回的「原唱/现场/翻唱/版本未标注」为准，别把翻唱说成原唱。',
        '- 每日推荐（daily）≠ 猜你喜欢（guess）≠ 场景歌单（scene），不要混着叫；周报的听歌时长是「日均」，不是一周总量。',
        '- 听歌报告、AI 解读、AI 歌单、每日推荐/猜你喜欢都只用账号私人数据：只在主人私聊里调用；群里或别人私聊要这些，就如实说只有主人私聊能用。',
        `- ${qqLine}`,
        `- ${gateLine}`,
        `- ${featureLine}`,
        '- 主人命令：/搜歌 关键词、/荐歌 场景（或 每日/猜你喜欢）、/榜单 [topId或名字]、/歌单 [AI|dissId|关键词]、/报告 [日|周|月]、/解读 问题（别人发的不生效）。',
      ]
    })

    api.command({
      name: '搜歌',
      desc: '搜真实音乐库（主人）：/搜歌 歌名 歌手',
      run: async (arg, msg) => {
        const text = cleanQuery(arg)
        if (!text) return '用法：/搜歌 歌名 [歌手]，比如 /搜歌 晴天 周杰伦'
        const result = await runSearch({ query: text, chatId: msg?.chatId })
        return result.message
      },
    })

    api.command({
      name: '荐歌',
      desc: `荐歌（主人）：/荐歌 ${SCENE_EXAMPLES.split('、').slice(0, 4).join('/')}；/荐歌 每日；/荐歌 猜你喜欢`,
      run: async (arg, msg) => {
        const text = cleanQuery(arg)
        let kind = 'scene'
        let scene = text
        if (/^(每日|每日推荐|今天推荐|今日推荐)/.test(text)) {
          kind = 'daily'
          scene = ''
        } else if (/^(猜你喜欢|电台|随便听听)/.test(text)) {
          kind = 'guess'
          scene = ''
        }
        const result = await runRecommend({
          kind,
          scene,
          chatId: msg?.chatId,
          chat: msg,
          // 只带说话人 id，身份在每次复核时用 api.isOwner 现查
          identity: { kind: 'command', userId: msg?.userId },
        })
        return result.message
      },
    })

    api.command({
      name: '榜单',
      desc: 'QQ 音乐排行榜（主人）：/榜单 或 /榜单 topId 或 /榜单 热歌',
      run: async (arg, msg) => {
        const text = cleanQuery(arg)
        if (!text) {
          const result = await runCharts({ action: 'groups', chatId: msg?.chatId })
          return result.message
        }
        if (/^\d{1,10}$/.test(text)) {
          const result = await runCharts({ action: 'detail', topId: text, chatId: msg?.chatId })
          return result.message
        }
        const groups = await runCharts({ action: 'groups', chatId: msg?.chatId })
        if (!groups.ok) return groups.message
        const hit = (groups.groups || []).flatMap((group) => group.items).find((item) => item.name.includes(text))
        if (!hit) return `没找到叫「${text}」的榜单。\n\n${groups.message}`
        const result = await runCharts({ action: 'detail', topId: hit.topId, chatId: msg?.chatId })
        return result.message
      },
    })

    api.command({
      name: '歌单',
      desc: 'QQ 音乐歌单（主人）：/歌单 AI、/歌单 dissId 或 /歌单 关键词（搜公共歌单）',
      run: async (arg, msg) => {
        const text = cleanQuery(arg)
        if (!text || /^ai$/i.test(text)) {
          const result = await runPlaylist({
            action: 'ai',
            chatId: msg?.chatId,
            chat: msg,
            identity: { kind: 'command', userId: msg?.userId },
          })
          return result.message
        }
        if (/^\d{1,20}$/.test(text)) {
          const result = await runPlaylist({ action: 'detail', dissId: text, chatId: msg?.chatId })
          return result.message
        }
        const result = await runSearch({ query: text, type: 'playlist', chatId: msg?.chatId })
        return result.message
      },
    })

    api.command({
      name: '报告',
      desc: 'QQ 音乐听歌报告（主人私聊）：/报告 [日|周|月]',
      run: async (arg, msg) => {
        const text = cleanQuery(arg)
        const period = /^(日|今天|今日|d)/i.test(text) ? 'day' : /^(周|本周|这周|w)/i.test(text) ? 'week' : 'month'
        const result = await runReport({
          period,
          chat: msg,
          identity: { kind: 'command', userId: msg?.userId },
        })
        return result.message
      },
    })

    api.command({
      name: '解读',
      desc: 'QQ 音乐 AI 解读（主人私聊）：/解读 分析我的听歌风格',
      run: async (arg, msg) => {
        const text = cleanQuery(arg)
        if (!text) return '用法：/解读 分析我的听歌风格（只在主人私聊可用）'
        const result = await runInterpret({
          query: text,
          chat: msg,
          identity: { kind: 'command', userId: msg?.userId },
        })
        return result.message
      },
    })

    api.onDispose(() => {
      disposed = true
      for (const controller of inflight.keys()) {
        try {
          controller.abort()
        } catch {
          /* 已经结束的请求，忽略 */
        }
      }
      inflight.clear()
      cache.clear()
      api.log.debug('music-discovery disposed：缓存与在途请求已清理')
    })

    /** 导出入口和工具走同一套复核：身份按传入 sessionId 现查，不能靠调用方先算好。 */
    const exportIdentity = (args = {}) => ({ kind: 'session', sessionId: args.sessionId })

    return {
      search: (args) => runSearch({ ...args }),
      recommend: (args) => runRecommend({ ...args, identity: args.identity || exportIdentity(args) }),
      share: (args) => runShare({ ...args }),
      charts: (args) => runCharts({ ...args }),
      playlist: (args) => runPlaylist({ ...args, identity: args.identity || exportIdentity(args) }),
      report: (args) => runReport({ ...args, identity: args.identity || exportIdentity(args) }),
      interpret: (args) => runInterpret({ ...args, identity: args.identity || exportIdentity(args) }),
      cacheSize: () => cache.size,
    }
  },
}
