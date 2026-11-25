// 通过 DSH 的 llm 服务生图。
//
// 走的是「对话模型」这条路：选中生图模型后发一轮请求，上游把图片以
// 图片块（block.type === 'image'）或回复文本里的 Markdown 图片链接返回。
// 两条都要收：不同适配器给的形态不一样。

import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'

const MAX_REDIRECTS = 3

/** 公网地址才允许下载：模型给什么链接都不能拿去打内网。 */
export function isPublicAddress (address) {
  const value = String(address || '')
  if (value.includes(':')) {
    const a = value.toLowerCase().replace(/^\[|\]$/g, '')
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
    if (mapped) return isPublicAddress(mapped[1])
    if (a === '::' || a === '::1') return false
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return false // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(a)) return false // fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(a)) return false // ff00::/8
    return true
  }
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 0 || b === 168)) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
  if (a === 203 && b === 0) return false
  if (a >= 224) return false
  return true
}

/** 解析并拒绝指向内网的目标；每一跳重定向都要重新校验。
 *  lookupImpl 可注入，测试用；生产环境走 node:dns。 */
export async function assertPublicUrl (raw, lookupImpl = lookup) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error('生图结果链接无效')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('生图结果链接必须是 HTTP(S)')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (!isPublicAddress(host)) throw new Error('生图结果链接指向非公网地址，已拒绝')
    return url.toString()
  }
  let rows
  try {
    rows = await lookupImpl(host, { all: true, verbatim: true })
  } catch {
    throw new Error('生图结果链接无法解析')
  }
  if (!rows.length) throw new Error('生图结果链接无法解析')
  for (const row of rows) {
    if (!isPublicAddress(row.address)) throw new Error('生图结果链接指向非公网地址，已拒绝')
  }
  return url.toString()
}

/** Markdown 图片在前（回复里常有先列的文档链接），裸链接兜底。 */
export function imageUrlsFromText (text) {
  const out = []
  const push = (raw) => {
    const value = String(raw).replace(/^<|>$/g, '').replace(/[.,;!?，。；！？]+$/g, '')
    if (/^https?:\/\//i.test(value) && !out.includes(value)) out.push(value)
  }
  for (const m of String(text || '').matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) push(m[1])
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)) push(m[0])
  return out
}

/** 下载用的默认实现：走全局 fetch（能力扫描据此识别 network）。 */
const defaultFetch = (url, init) => fetch(url, init)

/** 逐跳校验重定向后下载，带上限。 */
export async function downloadImage (url, { maxBytes = 20 * 1024 * 1024, timeoutMs = 180000, fetchImpl = defaultFetch, lookupImpl = lookup } = {}) {
  let target = url
  let response
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    target = await assertPublicUrl(target, lookupImpl)
    const current = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    if (current.status >= 300 && current.status < 400) {
      const location = current.headers.get('location')
      try { await current.body?.cancel() } catch {}
      if (!location) throw new Error(`图片下载失败（HTTP ${current.status}）`)
      if (hop === MAX_REDIRECTS) throw new Error('图片下载重定向次数过多')
      target = new URL(location, target).toString()
      continue
    }
    response = current
    break
  }
  if (!response) throw new Error('图片下载失败')
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared && declared > maxBytes) throw new Error('生图结果超过大小限制')
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > maxBytes) throw new Error('生图结果超过大小限制')
  return buf
}

/**
 * 发一轮「生图」对话并取回图片。
 * @param {object} deps
 * @param {object} deps.dsh 宿主 ctx
 * @param {{provider: string, model: string}} deps.target 选中的生图模型
 * @param {string} deps.prompt 提示词
 * @param {number} [deps.maxBytes] 下载上限
 * @returns {Promise<Buffer>}
 */
export async function generateViaDsh ({ dsh, target, prompt, maxBytes = 20 * 1024 * 1024, timeoutMs = 180000, dnsImpl }) {
  const llm = dsh?.llm || dsh?.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务，无法用已接入的模型生图')
  if (!target?.provider || !target?.model) throw new Error('还没有选择生图模型')

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(prompt || '') }],
    source: { kind: 'plugin', plugin: 'aurabot' },
  }]

  let text = ''
  let imageBlock = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      sessionId: 'aurabot-imagegen',
      signal: controller.signal,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') text += chunk.text
      // 图片块：优先拿现成的附件，省一次下载。
      if (!imageBlock) {
        const block = chunk.block
        if (chunk.type === 'block-end' && block && block.type === 'image' && block.attachment) imageBlock = block.attachment
      }
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const f = chunk.reason.failure || {}
        throw new Error('模型报错：' + (f.message || f.code || '未知'))
      }
    }
  } finally {
    clearTimeout(timer)
  }

  // 1) 图片块 → 用 DSH 附件服务读回字节
  if (imageBlock) {
    const attachments = dsh.attachments || dsh.get?.('attachments')
    if (!attachments || typeof attachments.readImage !== 'function') throw new Error('宿主没有附件服务，读不了生成的图片')
    const stored = await attachments.readImage(imageBlock)
    return Buffer.from(stored.data)
  }

  // 2) 回复文本里的图片链接
  const urls = imageUrlsFromText(text)
  if (!urls.length) {
    const reply = String(text).trim()
    throw new Error(reply
      ? `模型没有返回图片；回复开头：${reply.slice(0, 120)}`
      : '模型没有返回任何内容，请确认这个生图模型在 DSH 里可用')
  }
  return downloadImage(urls[0], { maxBytes, timeoutMs, ...(dnsImpl ? { lookupImpl: dnsImpl } : {}) })
}
