import { booruSources, requestKonachan, validateKonachanProxy } from './transport.mjs'
import { requestAudit } from './diagnostics.mjs'
import { saveCachedImage } from './image-cache.mjs'
import { imageKeys } from './image-delivery.mjs'
import { setTimeout as delay } from 'node:timers/promises'

const pageSize = 100
const maxImageBytes = 4 * 1024 * 1024
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const tagPattern = /^[a-z0-9_][a-z0-9_()'.+\-]{0,79}$/
const orders = { newest: 'id_desc', oldest: 'id', score: 'score', score_asc: 'score_asc', resolution: 'mpixels', resolution_asc: 'mpixels_asc', random: 'random' }

export function ratingSelection(value, source) {
  const site = booruSources[source]
  const chosen = Array.isArray(value) ? value : [value || 's']
  if (!chosen.length) throw new Error('请至少选择一个内容分级')
  if (chosen.some(rating => !site.ratings.includes(rating))) {
    throw new Error(source === 'konachan' ? 'Konachan 当前只支持 Safe（s）分级' : `${site.name} 不支持所选分级`)
  }
  return site.ratings.filter(rating => chosen.includes(rating))
}

export function konachanCredentials(settings) {
  return { username: String(settings.konachanUsername ?? '').trim(), apiKey: String(settings.konachanApiKey ?? '').trim() }
}

class KonachanAuthError extends Error {}
export class PermanentImageError extends Error {}

async function requestList(site, path, query, { fetchPosts = requestKonachan, signal, credentials, proxyUrl = '', log, operation, fallback, trace = false } = {}) {
  validateKonachanProxy(proxyUrl)
  const url = new URL(path, site)
  const audit = requestAudit({ log, operation, stage: path, host: url.hostname, proxyUrl, authenticated: Boolean(credentials?.apiKey), fallback })
  url.search = new URLSearchParams(query)
  if (credentials?.apiKey) {
    if (!credentials.username || credentials.username.length > 100 || !/^\S{1,256}$/.test(credentials.apiKey)) {
      audit('warn', 'invalid-credentials')
      throw new KonachanAuthError(credentials.username ? 'Konachan 用户名或 API Key 格式无效' : '缺少 Konachan 用户名')
    }
    url.searchParams.set('username', credentials.username)
    url.searchParams.set('api_key', credentials.apiKey)
  }
  const timeout = AbortSignal.timeout(10_000)
  let response
  try {
    response = await fetchPosts(url, { redirect: 'manual', proxyUrl, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch (error) {
    if (!signal?.aborted) audit('warn', timeout.aborted ? 'timeout' : 'network-error', undefined, error)
    throw new Error(`${url.hostname} ${proxyUrl ? '代理请求' : '直连请求'}失败或超时`)
  }
  if (response.headers.get('cf-mitigated') === 'challenge') {
    audit('warn', 'cloudflare-challenge', response)
    await response.body?.cancel().catch(() => {})
    throw new Error(`${url.hostname} 要求 Cloudflare 验证（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const rejected = credentials?.apiKey && [401, 403].includes(response.status)
    audit('warn', rejected ? 'auth-rejected' : 'http-error', response)
    if (rejected) throw new KonachanAuthError(`${url.hostname} 拒绝了认证请求（HTTP ${response.status}）`)
    throw new Error(`${url.hostname} 返回 HTTP ${response.status}`)
  }
  let items
  try { items = await response.json() } catch (error) {
    audit('warn', timeout.aborted ? 'timeout' : 'invalid-json', response, error)
    throw new Error(`${url.hostname} 没有返回有效的 JSON 列表`)
  }
  if (!Array.isArray(items)) {
    audit('warn', 'invalid-list', response)
    throw new Error('Konachan 返回的列表格式不正确')
  }
  if (trace || fallback) audit('info', 'ok', response)
  return items
}

async function requestWithFallback(site, path, query, options = {}) {
  try {
    return { items: await requestList(site, path, query, options) }
  } catch (error) {
    if (!(error instanceof KonachanAuthError) || options.signal?.aborted) throw error
    try {
      const items = await requestList(site, path, query, { ...options, credentials: undefined, fallback: true })
      return { items, fallbackReason: error.message }
    } catch (publicError) {
      throw new Error(`${error.message}，公开接口重试也失败：${publicError.message}`)
    }
  }
}

function listReader(options = {}) {
  const source = options.source || 'konachan'
  const { origin } = booruSources[source]
  let credentials = source === 'konachan' ? options.credentials : undefined
  return async (path, query) => {
    const { items, fallbackReason } = await requestWithFallback(origin, path, query, { ...options, credentials })
    if (fallbackReason) credentials = undefined // 同一次分页查询后续直接用公开接口。
    return items
  }
}

export async function probeKonachan(credentials, options) {
  const source = options?.source || 'konachan'
  const { origin, probe } = booruSources[source]
  return Promise.all(probe.map(async site => {
    const host = new URL(site).hostname
    try {
      const checkImage = options?.checkImage && site === origin
      const { items, fallbackReason } = await requestWithFallback(site, '/post.json', { limit: checkImage ? 5 : 1, tags: 'rating:s' }, { ...options, credentials: source === 'konachan' ? credentials : undefined })
      const result = { host, ok: true, message: `作品列表可读，返回 ${items.length} 条` }
      if (fallbackReason) result.fallbackReason = fallbackReason
      if (checkImage) {
        const sample = items.filter(item => item?.rating === 's').map(item => imageUrl(item, source)).find(Boolean)
        try {
          if (!sample) throw new Error('列表中没有可下载的安全样图')
          const bytes = await downloadKonachanImage(sample, options)
          result.image = { ok: true, message: `样图下载成功（${Math.ceil(bytes.length / 1024)} KB）` }
        } catch (error) { result.image = { ok: false, message: error.message } }
      }
      return result
    } catch (error) {
      return { host, ok: false, message: error.message }
    }
  }))
}

function imageUrl(post, source) {
  const { origin, images } = booruSources[source]
  for (const [candidate, size] of [[post.sample_url, post.sample_file_size], [post.jpeg_url, post.jpeg_file_size], [post.file_url, post.file_size]]) {
    if (size > maxImageBytes) continue
    if (!candidate) continue
    try {
      const url = new URL(candidate, origin)
      if (images.includes(url.origin) && !url.username && !url.password && /\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return url.href
    } catch { /* 忽略无效图片地址 */ }
  }
  return null
}

export async function downloadKonachanImage(value, { source = 'konachan', proxyUrl = '', signal, fetchImage = requestKonachan, log, operation, trace = false, cacheDir } = {}) {
  const url = imageUrl({ file_url: value }, source)
  const { name } = booruSources[source]
  if (!url) throw new PermanentImageError('图片地址无效')
  validateKonachanProxy(proxyUrl)
  const timeout = AbortSignal.timeout(20_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const audit = requestAudit({ log, operation, stage: 'image-download', host: new URL(url).hostname, proxyUrl })
  const retryDelays = [300, 700]
  for (const wait of [...retryDelays, null]) {
    try {
      const { bytes, type } = await downloadImageAttempt(url, { name, proxyUrl, requestSignal, timeout, fetchImage, audit, trace })
      if (!signal?.aborted) await saveCachedImage(cacheDir, source, bytes, type, log)
      return bytes
    } catch (error) {
      const cause = error.cause
      const reset = (cause?.cause?.code || cause?.code) === 'ECONNRESET'
      if (!reset || wait === null || requestSignal.aborted) throw error
      audit('warn', 'retry-connection-reset', undefined, cause)
      await delay(wait, undefined, { signal: requestSignal })
    }
  }
}

async function downloadImageAttempt(url, { name, proxyUrl, requestSignal, timeout, fetchImage, audit, trace }) {
  let response
  try { response = await fetchImage(url, { proxyUrl, signal: requestSignal }) } catch (error) {
    audit('warn', timeout.aborted ? 'timeout' : 'network-error', undefined, error)
    throw new Error(`${proxyUrl ? '代理' : '直连'}下载图片失败或超时`, { cause: error })
  }
  if (response.headers.get('cf-mitigated') === 'challenge') {
    audit('warn', 'cloudflare-challenge', response)
    await response.body?.cancel().catch(() => {})
    throw new Error(`${name} 图片下载要求 Cloudflare 验证（HTTP ${response.status}）`)
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!response.ok || !imageTypes.has(type) || Number(response.headers.get('content-length')) > maxImageBytes || !response.body) {
    await response.body?.cancel().catch(() => {})
    if (!response.ok) {
      audit('warn', 'http-error', response)
      const ErrorType = [404, 410].includes(response.status) ? PermanentImageError : Error
      throw new ErrorType(`${name} 图片下载返回 HTTP ${response.status}`)
    }
    if (!imageTypes.has(type) || !response.body) {
      audit('warn', 'invalid-image', response)
      throw new PermanentImageError(`${name} 没有返回支持的图片格式`)
    }
    audit('warn', 'image-too-large', response)
    throw new PermanentImageError('图片超过 4 MB')
  }
  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > maxImageBytes) break
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    audit('warn', timeout.aborted ? 'timeout' : 'image-read-error', response, error)
    throw new Error(`读取 ${name} 图片失败或超时`, { cause: error })
  }
  if (bytes > maxImageBytes || !bytes) {
    audit('warn', bytes ? 'image-too-large' : 'empty-image', response)
    throw new PermanentImageError(bytes ? '图片超过 4 MB' : `${name} 返回了空图片`)
  }
  if (trace) audit('info', 'ok', response)
  return { bytes: Buffer.concat(chunks), type }
}

// 来源接口统一返回 { key, url }，后续来源可用自己的 ID 前缀。
export async function selectKonachan(excluded, count, { filters = {}, ...options } = {}) {
  const source = options.source || 'konachan'
  const { query, matches } = postCriteria({ min_score: 31, ...filters }, source)
  const list = listReader(options)
  const images = new Map()
  const known = new Set(excluded)
  for (let page = 1; page <= 20; page++) {
    const posts = await list('/post.json', { tags: query, limit: pageSize, page })
    for (const post of posts) {
      if (!matches(post)) continue
      const key = `${source}:${post.id}`
      const identities = imageKeys(key, post.md5)
      if (identities.some(identity => known.has(identity))) continue
      const src = imageUrl(post, source)
      if (!src) continue
      images.set(key, { key, url: src, ...(post.md5 && { md5: post.md5 }) })
      for (const identity of identities) known.add(identity)
      if (images.size === count) return [...images.values()]
    }
    if (posts.length === 0) break
  }
  throw new Error(`${booruSources[source].name} 未找到足够的合格新图（需要 ${count} 张，找到 ${images.size} 张），可放宽推送筛选条件`)
}

function tag(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  if (!tagPattern.test(name)) throw new Error('请使用图源的英文标签名，例如 hatsune_miku')
  return name
}

export async function lookupKonachanTags(prefix, options) {
  const name = tag(prefix)
  const items = await listReader(options)('/tag.json', { name: `${name}*`, order: 'count', limit: 20 })
  return items.filter(item => typeof item?.name === 'string' && item.name.startsWith(name) && tagPattern.test(item.name) && item.count > 0)
    .slice(0, 12).map(item => ({ tag: item.name, count: item.count, type: ['通用', '画师', '未知', '作品', '角色'][item.type] || '其他' }))
}

function tags(value) {
  if (!Array.isArray(value) || value.length > 5) throw new Error('包含和排除条件各最多填 5 个标签')
  return [...new Set(value.map(tag))]
}

const numberRange = /^(?:[<>]=?\d+|\d+|\d+\.\.\d*|\.\.\d+)$/
const pixelRange = /^(?:[<>]=?\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:\.\.(?:\d+(?:\.\d+)?)?)?|\.\.\d+(?:\.\d+)?)$/
const advancedRules = {
  id: numberRange, width: numberRange, height: numberRange, mpixels: pixelRange,
  ratio: /^[1-9]\d*:[1-9]\d*$/, date: /^\d{4}-\d{2}-\d{2}$/, parent: /^(?:none|[1-9]\d*)$/,
  user: /^[a-z0-9_.\-]+$/i, vote: /^[1-3]:[a-z0-9_.\-]+$/i,
  source: /^https?:\/\/[^\s]+$/i, md5: /^[a-f0-9]{32}$/i,
}

function advancedTerms(text, reserved) {
  const terms = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  for (const term of terms) {
    const colon = term.indexOf(':')
    const key = term.slice(0, colon)
    const value = term.slice(colon + 1)
    if (colon < 1 || term.length > 250 || !Object.hasOwn(advancedRules, key) || !advancedRules[key].test(value)) {
      throw new Error(`高级筛选格式无效：${term.slice(0, 80)}`)
    }
    if (reserved.has(key)) throw new Error(`筛选项 ${key} 重复，请只保留一个条件`)
    reserved.add(key)
  }
  return terms
}

function postCriteria(args, source) {
  const { min_score, max_score, min_width = 0, min_height = 0, orientation = 'any', sort = 'newest', rating = 's', advanced } = args
  const include = tags(args.tags ?? [])
  const exclude = tags(args.exclude_tags ?? [])
  if (![min_score, max_score].every(n => n == null || Number.isSafeInteger(n)) || (min_score != null && max_score != null && min_score > max_score)) {
    throw new Error('评分上下限须为整数，且下限不能大于上限')
  }
  if (![min_width, min_height].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('尺寸下限须为非负整数')
  const ratings = ratingSelection(rating, source)
  if (!Object.hasOwn(orders, sort) || !['any', 'landscape', 'portrait', 'square'].includes(orientation)) throw new Error('不支持的排序或画幅')
  if (include.some(t => exclude.includes(t))) throw new Error('同一个标签不能同时包含和排除')
  const query = [...include, ...exclude.map(t => `-${t}`)]
  // 站点会用最后一个同名 rating 覆盖前面的条件。两档时排除第三档，三档时由本地校验。
  if (ratings.length === 1) query.push(`rating:${ratings[0]}`)
  else if (ratings.length === 2) query.push(`-rating:${booruSources[source].ratings.find(r => !ratings.includes(r))}`)
  if (min_score != null || max_score != null) query.push(`score:${min_score ?? ''}..${max_score ?? ''}`)
  query.push(`order:${orders[sort]}`)
  if (min_width) query.push(`width:${min_width}..`)
  if (min_height) query.push(`height:${min_height}..`)
  query.push(...advancedTerms(advanced, new Set([...(min_width ? ['width'] : []), ...(min_height ? ['height'] : [])])))

  function matches(post, requireDimensions = false) {
    if (!Number.isSafeInteger(post?.id) || post.id <= 0 || !ratings.includes(post.rating) || !Number.isFinite(post.score)) return false
    if ((min_score != null && post.score < min_score) || (max_score != null && post.score > max_score)) return false
    if (requireDimensions || min_width || min_height || orientation !== 'any') {
      if (!Number.isSafeInteger(post.width) || !Number.isSafeInteger(post.height) || post.width <= 0 || post.height <= 0 || post.width < min_width || post.height < min_height) return false
      const shape = post.width > post.height ? 'landscape' : post.width < post.height ? 'portrait' : 'square'
      if (orientation !== 'any' && shape !== orientation) return false
    }
    const postTags = String(post.tags ?? '').split(/\s+/)
    return include.every(t => postTags.includes(t)) && !exclude.some(t => postTags.includes(t))
  }
  return { query: query.join(' '), matches }
}

export async function searchKonachan(args, options) {
  const source = options?.source || 'konachan'
  const { origin } = booruSources[source]
  const { created_since, created_until, limit = 8, excluded = new Set() } = args
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('候选数量须在 1–12 之间')
  const { query, matches } = postCriteria(args, source)
  const list = listReader(options)
  const found = new Map()
  const known = new Set(excluded)
  for (let page = 1; page <= 3; page++) {
    const posts = await list('/post.json', { tags: query, limit: 40, page })
    if (!posts.length) break
    for (const p of posts) {
      if (!matches(p, true)) continue
      const identities = imageKeys(source + ':' + p.id, p.md5)
      if (identities.some(identity => known.has(identity))) continue
      if (created_since != null && (!Number.isSafeInteger(p.created_at) || p.created_at < created_since || p.created_at > created_until)) continue
      const postTags = String(p.tags ?? '').split(/\s+/).filter(t => tagPattern.test(t))
      const url = imageUrl(p, source)
      if (!url) continue
      found.set(p.id, { id: p.id, md5: p.md5, rating: p.rating, score: p.score, width: p.width, height: p.height, tags: postTags.slice(0, 25), post_url: `${origin}/post/show/${p.id}`, url })
      for (const identity of identities) known.add(identity)
      if (found.size === limit) return [...found.values()]
    }
  }
  return [...found.values()]
}
