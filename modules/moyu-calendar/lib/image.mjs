// 下载微信图床上的日历原图，并按日期缓存在模块数据目录。
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBody, shortError, signalWithTimeout } from './http.mjs'

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** /640、/300 换成 /0，拿原图。只接受 mmbiz.qpic.cn。 */
export function originalImageUrl(url) {
  const raw = String(url || '').trim().replace(/&amp;/g, '&').split('#')[0]
  let parsed
  try { parsed = new URL(raw) } catch { return '' }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mmbiz.qpic.cn' || parsed.username || parsed.password) return ''
  parsed.pathname = parsed.pathname.replace(/\/(?:0|300|640)$/, '/0')
  parsed.hash = ''
  return parsed.href
}

export function detectMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return ''
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

export function isMmbiz(url) {
  try {
    const parsed = new URL(String(url || ''))
    return parsed.protocol === 'https:' && parsed.hostname === 'mmbiz.qpic.cn'
  } catch { return false }
}

export async function downloadImage(url, { fetchImpl = (...args) => fetch(...args), maxBytes = 5_000_000, timeoutMs = 20000, signal } = {}) {
  const target = originalImageUrl(url)
  if (!target) return { ok: false, error: '图片地址不是微信图床 mmbiz.qpic.cn' }
  try {
    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: signalWithTimeout(signal, timeoutMs),
    })
    if (!response?.ok) return { ok: false, error: `图片 HTTP ${response?.status ?? ''}` }
    if (!isMmbiz(response.url || target)) return { ok: false, error: '图片被重定向到非微信图床' }
    const bytes = await readBody(response, maxBytes)
    const mime = detectMime(bytes)
    if (!mime) return { ok: false, error: '下载到的内容不是 PNG、JPEG 或 WebP' }
    return { ok: true, bytes, mime }
  } catch (error) {
    return { ok: false, error: shortError(error) === '超时或已停止' ? '下载图片超时或已停止' : `下载图片失败：${shortError(error)}` }
  }
}

function cacheName(date, ext) {
  return `${date}.${ext}`
}

export async function readCache(dir, date) {
  for (const ext of Object.values(EXT)) {
    const file = join(dir, cacheName(date, ext))
    let bytes
    try { bytes = await readFile(file) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const mime = detectMime(bytes)
    if (!mime) {
      await unlink(file).catch(() => {})
      continue
    }
    return { file, bytes, mime }
  }
  return null
}

export async function writeCache(dir, date, bytes, mime) {
  const ext = EXT[mime]
  if (!ext) throw new Error('不支持的图片类型')
  await mkdir(dir, { recursive: true })
  const file = join(dir, cacheName(date, ext))
  await writeFile(file, bytes)
  return { file, bytes, mime }
}

/** 只删自己写的日期图片，保留任务记录。默认留 14 天。 */
export async function pruneCache(dir, keepDays = 14, nowMs = Date.now()) {
  let names = []
  try { names = await readdir(dir) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const cutoff = nowMs - keepDays * 24 * 60 * 60 * 1000
  for (const name of names) {
    const matched = name.match(/^(\d{4}-\d{2}-\d{2})\.(png|jpg|webp)$/)
    if (!matched) continue
    const published = Date.parse(`${matched[1]}T00:00:00+08:00`)
    if (Number.isFinite(published) && published < cutoff) await unlink(join(dir, name)).catch(() => {})
  }
}
