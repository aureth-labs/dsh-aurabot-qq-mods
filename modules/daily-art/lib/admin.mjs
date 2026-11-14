import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { probeKonachan } from './konachan.mjs'
import { validateKonachanProxy } from './transport.mjs'

const keys = ['konachanApiKey', 'konachanProxyUrl']
const id = 'daily-art'
const maxBody = 4096

export function openVault(api) {
  const file = api.dataDir('credentials.json')
  let values
  try { values = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('每日推图凭据文件无法读取')
    values = {}
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('每日推图凭据文件格式错误')
  function save(patch) {
    const next = { ...values, ...patch }
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    values = next
  }
  function migrate(cfg) {
    const current = cfg.ext?.[id] || {}
    if (!keys.some(key => Object.hasOwn(current, key))) return cfg
    const patch = Object.fromEntries(keys.filter(key => !Object.hasOwn(values, key) && typeof current[key] === 'string' && current[key]).map(key => [key, current[key]]))
    if (Object.keys(patch).length) save(patch)
    const clean = { ...current }
    for (const key of keys) { delete clean[key]; delete clean[`${key}Set`] }
    return { ...cfg, ext: { ...cfg.ext, [id]: clean } }
  }
  return { save, migrate, settings: () => ({ ...api.settings(), ...Object.fromEntries(keys.map(key => [key, values[key] ?? ''])) }),
    status: () => Object.fromEntries(keys.map(key => [`${key}Set`, Boolean(values[key])])) }
}

const normalizeAddress = value => String(value || '').trim().toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
const isLoopback = address => address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))

function panelRequestAllowed(req, security = {}) {
  const { origin, host, 'sec-fetch-site': site, 'x-forwarded-for': forwarded } = req.headers || {}
  if (site && site !== 'same-origin') return false
  let panel
  try { panel = new URL(origin) } catch { return false }
  if (!['http:', 'https:'].includes(panel.protocol) || panel.host !== host) return false
  const hostname = normalizeAddress(panel.hostname)
  const localHost = hostname === 'localhost' || isLoopback(hostname)
  if (!localHost && hostname !== normalizeAddress(security.publicHostname)) return false
  const peer = normalizeAddress(req.socket?.remoteAddress || req.connection?.remoteAddress)
  if (!isLoopback(peer)) return false

  // Extension routes do not inherit Aurabot's admin gate. Only trust a configured local proxy.
  const trusted = String(security.trustedProxy || '').split(',').map(normalizeAddress).includes(peer)
  if (!trusted) return localHost && !forwarded
  const client = normalizeAddress(String(forwarded || '').split(',').at(-1))
  return isIP(client) !== 0 && (security.panelRemoteAccess === true || (localHost && isLoopback(client)))
}

async function readBody(req) {
  if (Number(req.headers?.['content-length']) > maxBody) throw new Error('请求体过大')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBody) throw new Error('请求体过大')
    chunks.push(bytes)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求体格式错误')
  return input
}

export function registerAdmin(api, vault, { probe = probeKonachan } = {}) {
  const shutdown = new AbortController()
  let busy = false
  const failure = message => ({ ok: false, message })
  api.onDispose(() => shutdown.abort())

  const route = (path, run) => api.route(path, async req => {
    if (shutdown.signal.aborted || req.method !== 'POST' || !/^application\/json\b/i.test(req.headers?.['content-type'] || '')) return failure('请求不允许')
    if (!panelRequestAllowed(req, api.config().security)) return failure('请从本机面板或已配置的可信面板反代访问')
    let input
    try { input = await readBody(req) } catch { return failure('请提交不超过 4 KiB 的 JSON 对象') }
    if (shutdown.signal.aborted) return failure('模块已重新加载，请重试')
    return run(input)
  })
  route('/credentials', input => {
    const patch = {}
    for (const key of keys) {
      const value = input[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length > 1024) return failure('凭据格式无效')
      patch[key] = value.trim()
    }
    if (Object.hasOwn(patch, 'konachanProxyUrl')) {
      try { validateKonachanProxy(patch.konachanProxyUrl) } catch (error) { return failure(error.message) }
    }
    try { vault.save(patch) } catch { return failure('无法保存凭据') }
    return { ok: true, ...vault.status() }
  })
  route('/connection-test', async input => {
    if (!['konachan', 'yandere'].includes(input.source)) return failure('未知图源')
    if (busy) return failure('正在检测，请稍后再试')
    const { konachanProxyUrl: proxyUrl, konachanApiKey: apiKey, konachanUsername: username } = vault.settings()
    try { validateKonachanProxy(proxyUrl) } catch (error) { return failure(error.message) }
    busy = true
    try {
      const results = await probe(input.source === 'konachan' ? { apiKey, username } : {}, {
        source: input.source, proxyUrl, signal: shutdown.signal, checkImage: true, log: api.log, operation: 'connection-test', trace: true,
      })
      return shutdown.signal.aborted ? failure('模块已重新加载，请重试') : { ok: true, proxyConfigured: Boolean(proxyUrl), results }
    } catch { return failure('连接检测失败') }
    finally { busy = false }
  })
}
