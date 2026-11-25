import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { downloadKonachanImage, konachanCredentials, PermanentImageError, ratingSelection, selectKonachan } from './lib/konachan.mjs'
import { confirmGroupImages, definitelyFailed, isSendTimeout } from './lib/qq-delivery.mjs'
import { defaultImageCacheDir } from './lib/image-cache.mjs'
import { imageKeys, openImageDelivery } from './lib/image-delivery.mjs'
import { registerSearch } from './lib/search.mjs'
import { openVault, registerAdmin } from './lib/admin.mjs'
import { booruSources, konachanProxy } from './lib/transport.mjs'

const time = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const defaultTimes = '09:00\n17:00'
const defaultCount = 5
const maxCount = 10
const retryMs = 5 * 60_000
const deliveryFiles = { konachan: 'delivery.json', yandere: 'delivery-yandere.json' }

function clock(now) {
  const parts = Object.fromEntries(time.formatToParts(now).map(({ type, value }) => [type, value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, timeOfDay: `${parts.hour}:${parts.minute}` }
}

function pushSchedule(settings) {
  const times = String(settings.pushTimes ?? '').trim() || defaultTimes
  const labels = new Set()
  for (const value of times.split(/[\s,，;；]+/).filter(Boolean)) {
    if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('推送时间请使用 24 小时制 HH:mm，例如 09:30')
    labels.add(value.padStart(5, '0'))
  }
  if (!labels.size) throw new Error('请至少填写一个推送时间')
  const count = settings.pushCount === '' ? defaultCount : settings.pushCount ?? defaultCount
  if (!Number.isInteger(count) || count < 1 || count > maxCount) throw new Error(`每批图片数须为 1–${maxCount} 的整数`)
  return { labels: [...labels].sort(), count }
}

function qqNumbers(input) {
  return String(input ?? '').split(/[\s,，;；]+/).filter(id => /^[1-9]\d{4,14}$/.test(id))
}

function targets(settings) {
  return new Set([
    ...qqNumbers(settings.groupWhitelist).map(id => `group:${id}`),
    ...qqNumbers(settings.privateWhitelist).map(id => `private:${id}`),
  ])
}

function pushFilters(settings, source) {
  const tagList = value => String(value ?? '').split(/[\s,，;；]+/).filter(Boolean)
  return {
    min_score: settings.pushMinScore === '' ? 31 : settings.pushMinScore ?? 31,
    max_score: settings.pushMaxScore === '' ? undefined : settings.pushMaxScore,
    tags: tagList(settings.pushTags),
    exclude_tags: tagList(settings.pushExcludeTags),
    min_width: settings.pushMinWidth === '' ? 0 : settings.pushMinWidth ?? 0,
    min_height: settings.pushMinHeight === '' ? 0 : settings.pushMinHeight ?? 0,
    rating: ratingSelection(settings.pushRating, source),
    orientation: settings.pushOrientation || 'any',
    sort: settings.pushSort || 'newest',
    advanced: settings.pushAdvanced || '',
  }
}

function readState(file, day) {
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { day, used: [], slots: {} }
  }
  if (!state || typeof state.day !== 'string' || !Array.isArray(state.used) || !state.slots || typeof state.slots !== 'object') {
    throw new Error('推送记录格式不正确，已停止发送以免重复')
  }
  return state.day === day ? state : { day, used: state.used, slots: {} }
}

function writeState(file, state) {
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
  renameSync(temp, file)
}

export function startDailyArt(api, { now = Date.now, select = selectKonachan, download = downloadKonachanImage, source = 'konachan', cacheDir, imageDelivery } = {}) {
  const file = api.dataDir(deliveryFiles[source])
  const readProxy = konachanProxy
  const title = source === 'konachan' ? '每日推图' : `${booruSources[source].name} 推图`
  const shutdown = new AbortController()
  const retryAt = new Map()
  let running = false
  let lastDay = ''
  let lastScheduleError = ''

  function excluded(used, recipients) {
    const keys = new Set(used)
    if (imageDelivery) for (const key of imageDelivery.known(...recipients)) keys.add(key)
    return keys
  }

  function canSend(day) {
    const cfg = api.config()
    return !shutdown.signal.aborted && clock(now()).day === day && api.settings().enabled === true && cfg.enabled && !cfg.dryRun
  }

  function slotIsCurrent(day, label, proxyUrl, rating) {
    const settings = api.settings()
    if (!canSend(day) || readProxy(settings) !== proxyUrl) return false
    try {
      return pushSchedule(settings).labels.includes(label) && (!rating || ratingSelection(settings.pushRating, source).join(',') === rating)
    } catch { return false }
  }

  async function deliver(day, label, slotKey, slot, proxyUrl) {
    const rating = slot.rating ?? 's'
    if (!slotIsCurrent(day, label, proxyUrl, rating)) return
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(20_000)])
    const downloads = await Promise.allSettled(slot.images.map(async ({ key, url, md5 }) => {
      const bytes = await download(url, { source, proxyUrl, signal, log: api.log, operation: 'scheduled', cacheDir })
      return { keys: imageKeys(key, md5, bytes), segment: { type: 'image', data: { file: `base64://${bytes.toString('base64')}` } } }
    }))
    const broken = downloads.flatMap((result, i) => result.status === 'rejected' && result.reason instanceof PermanentImageError ? [i] : [])
    if (broken.length && slotIsCurrent(day, label, proxyUrl, rating)) {
      const settings = api.settings()
      const before = readState(file, day)
      const replacement = await select(excluded(before.used, Object.keys(slot.recipients)), broken.length, {
        source, signal: shutdown.signal, filters: slot.filters ?? pushFilters(settings, source), credentials: konachanCredentials(settings),
        proxyUrl, log: api.log, operation: 'scheduled-repair',
      })
      if (!slotIsCurrent(day, label, proxyUrl, rating)) return
      const current = readState(file, day)
      const batch = current.slots[slotKey]
      const used = new Set(current.used)
      if (!batch || JSON.stringify(batch.images) !== JSON.stringify(slot.images) || replacement.length !== broken.length ||
        new Set(replacement.map(image => image.key)).size !== broken.length || replacement.some(image => used.has(image.key))) return
      broken.forEach((index, i) => { batch.images[index] = replacement[i] })
      current.used.push(...replacement.map(image => image.key))
      writeState(file, current)
      api.log.warn(`${label} 已替换 ${broken.length} 张失效图片，下次仅补发仍待发送的目标`)
      return
    }
    const failed = downloads.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
    const images = downloads.map(result => result.value)
    for (const chatId of Object.keys(slot.recipients)) {
      if (!slotIsCurrent(day, label, proxyUrl, rating)) return
      if (!targets(api.settings()).has(chatId)) continue
      const state = readState(file, day)
      const recipient = state.slots[slotKey]?.recipients[chatId]
      if (recipient !== 'pending') continue

      const claim = imageDelivery?.reserve(chatId, images)
      const segments = (claim?.items ?? images).map(image => image.segment)
      state.slots[slotKey].recipients[chatId] = segments.length ? 'sending' : 'skipped'
      try { writeState(file, state) } catch (error) { claim?.release(); throw error }
      if (!segments.length) continue

      let status = 'pending'
      const startedAt = Date.now()
      let cancelled = false
      try {
        const result = await api.core.hub.sendSegments(chatId, segments, `[${title} ${day} ${label}]`, {
          throwOnError: true,
          timeoutMs: 60_000,
          isCurrent: () => {
            cancelled = !slotIsCurrent(day, label, proxyUrl, rating) || !targets(api.settings()).has(chatId)
            return !cancelled
          },
        })
        if (result?.message_id != null) status = 'sent'
        else if (result != null) status = 'uncertain'
        else if (cancelled) claim?.release()
        else if (claim) status = 'uncertain'
      } catch (error) {
        const timedOut = isSendTimeout(error)
        const receipt = timedOut ? await confirmGroupImages(api, chatId, segments, startedAt, shutdown.signal) : null
        if (receipt) status = 'sent'
        else {
          if (definitelyFailed(error)) claim?.release()
          else status = 'uncertain'
          api.log.warn(`${label} → ${chatId}：${error.message}${status === 'uncertain' ? '（结果不明，跳过重发）' : '（稍后重试）'}`)
        }
      }

      // 等回执时可能热重载或跨日，合并进最新记录，不能覆盖另一轮的进度。
      const current = readState(file, clock(now()).day)
      if (current.day === day && current.slots[slotKey]?.recipients[chatId] === 'sending') {
        current.slots[slotKey].recipients[chatId] = status
        writeState(file, current)
      }
      if (status === 'sent') api.log.info(`${label} → ${chatId}：已推送 ${segments.length} 张图片`)
    }
  }

  async function tick() {
    const { day, timeOfDay } = clock(now())
    if (running || !canSend(day)) return
    let schedule
    try {
      schedule = pushSchedule(api.settings())
      lastScheduleError = ''
    } catch (error) {
      if (lastScheduleError !== error.message) api.log.warn(error.message)
      lastScheduleError = error.message
      return
    }
    running = true
    try {
      if (lastDay !== day) { retryAt.clear(); lastDay = day }
      for (const label of schedule.labels) {
        if (timeOfDay < label || !canSend(day)) break
        // 整点沿用旧版的数字键，升级不会重发已经送达的批次。
        const slotKey = label.endsWith(':00') ? String(Number(label.slice(0, 2))) : label
        if (now() < (retryAt.get(slotKey) || 0)) continue
        const settings = api.settings()
        const proxyUrl = readProxy(settings)
        if (!slotIsCurrent(day, label, proxyUrl)) continue
        const eligible = targets(settings)
        if (!eligible.size) continue
        const state = readState(file, day)
        let slot = state.slots[slotKey]
        if (slot && ![...eligible].some(id => slot.recipients[id] === 'pending')) continue
        retryAt.set(slotKey, now() + retryMs)
        try {
          const filters = pushFilters(settings, source)
          const rating = filters.rating.join(',')
          if (slot && (slot.rating ?? 's') !== rating) continue
          if (!slot) {
            const credentials = konachanCredentials(settings)
            const { count } = pushSchedule(settings)
            const images = await select(excluded(state.used, eligible), count, { source, signal: shutdown.signal, filters, credentials, proxyUrl, log: api.log, operation: 'scheduled' })
            if (!slotIsCurrent(day, label, proxyUrl)) continue
            const latest = api.settings()
            const latestCredentials = konachanCredentials(latest)
            if (count !== pushSchedule(latest).count || JSON.stringify(filters) !== JSON.stringify(pushFilters(latest, source)) ||
              credentials.username !== latestCredentials.username || credentials.apiKey !== latestCredentials.apiKey) {
              retryAt.delete(slotKey)
              continue
            }
            const recipients = [...targets(latest)]
            if (!recipients.length) continue
            const current = readState(file, day)
            slot = current.slots[slotKey]
            if (!slot) {
              const used = new Set(current.used)
              if (images.some(({ key }) => used.has(key))) continue
              slot = { images, rating, filters, recipients: Object.fromEntries(recipients.map(id => [id, 'pending'])) }
              current.slots[slotKey] = slot
              current.used.push(...images.map(({ key }) => key))
              writeState(file, current)
            }
          }
          await deliver(day, label, slotKey, slot, proxyUrl)
        } catch (error) {
          if (!shutdown.signal.aborted) api.log.warn(`${label} 推送未完成，稍后重试：${error.message}`)
        }
      }
    } finally { running = false }
  }

  api.onDispose(() => shutdown.abort())
  api.later(0, tick)
  api.every(15_000, tick, title)
  return tick
}

const scheduleDefaults = {
  enabled: false, groupWhitelist: '', privateWhitelist: '', pushTimes: defaultTimes, pushCount: defaultCount,
  pushMinScore: 31, pushMaxScore: '', pushTags: '', pushExcludeTags: '', pushRating: ['s'],
  pushMinWidth: 0, pushMinHeight: 0, pushOrientation: 'any', pushSort: 'newest', pushAdvanced: '',
}
const accountFields = [
  { key: 'konachanUsername', label: 'Konachan 用户名', type: 'text', hint: '使用个人 API Key 时填写 Konachan 账号用户名。' },
  { key: 'konachanApiKey', label: 'Konachan API Key', type: 'password', hint: '留空使用公开接口。认证失败会自动回退。' },
]
const proxyField = { key: 'konachanProxyUrl', label: '共用代理地址', type: 'password', placeholder: 'http://host.docker.internal:7890', hint: '两个图源的 API 和图片下载共用。未设置时直连。' }
const searchAccessField = { key: 'allowPrivateWhitelistSearch', label: '允许私聊白名单用户按需找图', type: 'switch', hint: '开启后，Aurabot「系统 → 权限」的私聊白名单用户可用两个图源的 Safe 找图。' }
const ratingLabels = { s: 'Safe（s）', q: 'Questionable（q）', e: 'Explicit（e）' }
const scheduleFields = [
    { key: 'enabled', label: '开启定时推送', type: 'switch', hint: '开启后会向下方名单补发当天已错过的时段。' },
    { key: 'pushTimes', label: '每日推送时间（北京时间）', type: 'textarea', placeholder: defaultTimes, hint: '24 小时制 HH:mm。每行一个，也可用逗号分隔。留空使用 09:00、17:00。' },
    { key: 'pushCount', label: '每批图片数', type: 'number', min: 1, max: maxCount, hint: '每个推送时间发送的张数。留空使用 5 张。' },
    { key: 'groupWhitelist', label: '群聊推送白名单', type: 'textarea', hint: '填 QQ 群号，每行一个，也可用逗号分隔。留空时不推送到群聊。' },
    { key: 'privateWhitelist', label: '私聊推送白名单', type: 'textarea', hint: '填接收推送的 QQ 号，每行一个，也可用逗号分隔。主人也需填写。' },
    { key: 'pushMinScore', label: '最低评分', type: 'number', hint: '包含该分数。留空按 31 处理，即评分大于 30。' },
    { key: 'pushMaxScore', label: '最高评分', type: 'number', hint: '包含该分数。留空不限制最高分。' },
    { key: 'pushTags', label: '包含标签', type: 'textarea', placeholder: 'hatsune_miku, landscape', hint: '最多 5 个英文站点标签。图片需同时匹配，空格、换行或逗号分隔。' },
    { key: 'pushExcludeTags', label: '排除标签', type: 'textarea', placeholder: 'swimsuit, text', hint: '最多 5 个英文站点标签，命中任意一个就跳过。' },
    { key: 'pushRating', label: '定时推送分级', type: 'multi-select' },
    { key: 'pushMinWidth', label: '最小宽度（px）', type: 'number', min: 0, hint: '留空或填 0 不限制。' },
    { key: 'pushMinHeight', label: '最小高度（px）', type: 'number', min: 0, hint: '留空或填 0 不限制。' },
    { key: 'pushOrientation', label: '画幅', type: 'select', options: [
      { value: 'any', label: '不限' }, { value: 'landscape', label: '横图' }, { value: 'portrait', label: '竖图' }, { value: 'square', label: '方图' },
    ] },
    { key: 'pushSort', label: '排序方式', type: 'select', options: [
      { value: 'newest', label: '最新优先' }, { value: 'oldest', label: '最早优先' },
      { value: 'score', label: '评分从高到低' }, { value: 'score_asc', label: '评分从低到高' },
      { value: 'resolution', label: '分辨率从高到低' }, { value: 'resolution_asc', label: '分辨率从低到高' },
    ] },
    { key: 'pushAdvanced', label: '高级筛选', type: 'textarea', placeholder: 'ratio:16:9 mpixels:2.5..', hint: '可用 id、width、height、mpixels、ratio、date、parent、user、source、md5、vote，空格或换行分隔。宽高高级条件不能与上方相应的下限同时填写。' },
]

const legacyId = 'daily-art-yandere'

export function migrateYandereSettings(cfg) {
  const legacy = cfg.ext?.[legacyId]
  if (!legacy) return cfg
  const ext = { ...cfg.ext }
  delete ext[legacyId]
  const main = { ...ext['daily-art'] }
  if (!main.yandere) {
    main.yandere = Object.fromEntries(Object.keys(scheduleDefaults).filter(key => Object.hasOwn(legacy, key)).map(key => [key, legacy[key]]))
    if (cfg.modules?.[legacyId]?.enabled === false) main.yandere.enabled = false
    if (!konachanProxy(main) && legacy.yandereProxyUrl) main.konachanProxyUrl = legacy.yandereProxyUrl
  }
  ext['daily-art'] = main
  return { ...cfg, ext, modules: { ...cfg.modules, [legacyId]: { ...cfg.modules?.[legacyId], enabled: false } } }
}

export default {
  id: 'daily-art',
  name: '每日推图 · 逛图站',
  version: '3.2.0',
  api: 1,
  panel: 'panel.js',
  description: '在同一页管理 Konachan 和 Yande.re 定时推图及 QQ 按需找图。',
  defaults: { ...scheduleDefaults, konachanUsername: '', allowPrivateWhitelistSearch: false, cacheImages: false, imageCacheDir: '' },
  setup(api) {
    const vault = openVault(api)
    const imageDelivery = openImageDelivery(api.dataDir('image-delivery.json'), Object.values(deliveryFiles).map(file => api.dataDir(file)))
    const defaultCacheDir = defaultImageCacheDir(api)
    const cacheDir = () => {
      const settings = vault.settings()
      return settings.cacheImages === true ? String(settings.imageCacheDir ?? '').trim() || defaultCacheDir : ''
    }
    function migrate() {
      const current = api.config()
      const next = vault.migrate(migrateYandereSettings(current))
      if (next !== current) api.setConfig(() => next)
    }
    migrate()
    api.on('config', migrate)
    const runtime = { ...api, settings: vault.settings }
    startDailyArt(runtime, { cacheDir, imageDelivery })
    startDailyArt({ ...api, settings: () => {
      const settings = vault.settings()
      return { ...scheduleDefaults, ...settings.yandere, konachanProxyUrl: settings.konachanProxyUrl }
    } }, { source: 'yandere', cacheDir, imageDelivery })
    registerAdmin(api, vault)
    registerSearch(runtime, { cacheDir, imageDelivery })
    api.route('/settings-schema', () => ({ ok: true, proxyField, searchAccessField, accountFields, scheduleFields, scheduleDefaults, defaultCacheDir, ...vault.status(),
      ratings: Object.fromEntries(Object.entries(booruSources).map(([id, site]) => [id, site.ratings.map(value => ({ value, label: ratingLabels[value] }))])),
    }))
  },
}
