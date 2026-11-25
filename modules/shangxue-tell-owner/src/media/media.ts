import { existsSync, statSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { TicketMedia } from '../tickets/types.js'

/** OneBot 消息段。 */
interface Segment {
  type?: string
  data?: Record<string, any>
}

/** 把 OneBot url 字段变成可下载的地址（file:// 原样，其余 http）。 */
function normalizeUrl(u: unknown): string {
  const s = String(u == null ? '' : u).trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || /^base64:\/\//i.test(s) || /^file:\/\//i.test(s)) return s
  return s
}

export interface ExtractOptions {
  /** 一次最多抓多少个附件（防止被大量图片刷爆） */
  limit?: number
}

/**
 * 从消息里抽附件。优先读 raw.message（原始段数组），
 * 没有再退回 msg.images / msg.records / msg.forwards 这些已解析字段。
 */
export function extractMedia(msg: any, opts: ExtractOptions = {}): TicketMedia[] {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 9
  const out: TicketMedia[] = []
  const push = (m: TicketMedia): void => {
    if (out.length >= limit) return
    if (!m.url && !m.file) return
    out.push(m)
  }

  const segs: Segment[] = Array.isArray(msg && msg.raw && msg.raw.message) ? msg.raw.message : []
  if (segs.length) {
    for (const seg of segs) {
      if (!seg || !seg.type) continue
      const d = seg.data || {}
      if (seg.type === 'image') {
        const url = normalizeUrl(d.url || d.file)
        push({ url, file: '', kind: 'image', name: String(d.file || '').slice(0, 80) })
      } else if (seg.type === 'file') {
        const url = normalizeUrl(d.url || d.file)
        push({ url, file: '', kind: 'file', name: String(d.name || d.file || '').slice(0, 120) })
      } else if (seg.type === 'record') {
        const url = normalizeUrl(d.url || d.file)
        push({ url, file: '', kind: 'record', name: String(d.file || '').slice(0, 80) })
      } else if (seg.type === 'video') {
        const url = normalizeUrl(d.url || d.file)
        push({ url, file: '', kind: 'video', name: String(d.file || '').slice(0, 80) })
      }
    }
  }

  // 兜底：已解析字段
  if (!out.length) {
    const imgs = Array.isArray(msg && msg.images) ? msg.images : []
    for (const im of imgs) {
      const url = normalizeUrl(im && (im.url || im.file))
      push({ url, file: '', kind: 'image' })
    }
    const recs = Array.isArray(msg && msg.records) ? msg.records : []
    for (const r of recs) {
      const url = normalizeUrl(r && (r.url || r.file))
      push({ url, file: '', kind: 'record' })
    }
  }

  return out
}

/** 从一个 URL 猜测合适的扩展名。 */
export function guessExt(url: string, kind: string): string {
  const m = /\.([a-z0-9]{1,5})(?:\?|#|$)/i.exec(url || '')
  if (m) return '.' + m[1].toLowerCase()
  if (kind === 'image') return '.jpg'
  if (kind === 'record') return '.amr'
  if (kind === 'video') return '.mp4'
  return '.bin'
}

/** 路径/文件名是否已带可识别扩展名。 */
export function hasKnownExt(nameOrPath: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|mp4|mov|mkv|avi|webm|amr|silk|mp3|wav|ogg|m4a|flac|pdf|zip|rar|7z|txt|docx?|xlsx?|pptx?)(?:\?|#|$)/i.test(
    String(nameOrPath || ''),
  )
}

export interface SniffResult {
  /** 推断出的扩展名（含点），认不出返回 '' */
  ext: string
  /** 推断出的媒体类别 image/video/record/file */
  kind: string
}

/**
 * 读取文件头魔术字节，判断真实类型。
 * 用于「附件路径没有扩展名」（如对象存储哈希名）时补上正确后缀、判断图片/视频/语音。
 */
export function sniffMedia(buf: Buffer): SniffResult {
  if (!buf || buf.length < 4) return { ext: '', kind: 'file' }
  const b = buf
  const ascii = (o: number, n: number): string => b.toString('latin1', o, o + n)

  // 图片
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: '.png', kind: 'image' }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', kind: 'image' }
  if (ascii(0, 3) === 'GIF') return { ext: '.gif', kind: 'image' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: '.webp', kind: 'image' }
  if (b[0] === 0x42 && b[1] === 0x4d) return { ext: '.bmp', kind: 'image' }

  // 视频
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4).toLowerCase()
    if (brand.startsWith('qt')) return { ext: '.mov', kind: 'video' }
    if (brand === 'avif') return { ext: '.avif', kind: 'image' }
    return { ext: '.mp4', kind: 'video' }
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: '.webm', kind: 'video' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return { ext: '.avi', kind: 'video' }

  // 音频
  if (ascii(0, 3) === 'ID3') return { ext: '.mp3', kind: 'record' }
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { ext: '.mp3', kind: 'record' }
  if (ascii(0, 4) === 'fLaC') return { ext: '.flac', kind: 'record' }
  if (ascii(0, 4) === 'OggS') return { ext: '.ogg', kind: 'record' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { ext: '.wav', kind: 'record' }
  if (ascii(0, 2) === '#!') return { ext: '', kind: 'file' } // AMR 变体，少见，不猜测
  if (ascii(4, 4) === 'AMR' || ascii(0, 5) === '#!AMR') return { ext: '.amr', kind: 'record' }

  // 文档
  if (ascii(0, 4) === '%PDF') return { ext: '.pdf', kind: 'file' }
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { ext: '.zip', kind: 'file' }

  return { ext: '', kind: 'file' }
}

/** 判断是否本机绝对路径（Windows 盘符 / UNC / POSIX 绝对路径）。 */
export function isAbsPath(p: string): boolean {
  const s = String(p || '').trim()
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s)
}

function isFileSync(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch (error) {
    return false
  }
}

/** 放宽匹配：忽略大小写与路径分隔符比较两个文件名。 */
function looseEq(a: string, b: string): boolean {
  return a.toLowerCase().replace(/\\/g, '/') === b.toLowerCase().replace(/\\/g, '/')
}

/**
 * 把「用户/模型给的一个来源」（可能是完整绝对路径、file://、也可能只有一个文件名/无后缀名）
 * 在本机解析成一个真实存在的绝对文件路径。找不到返回 ''。
 *
 * 解析顺序：
 *   1) 就是绝对路径且文件存在 → 用它（含 file:// 解析）。
 *   2) 相对路径：在 searchDirs 里拼出来找。
 *   3) 只给了文件名：在 searchDirs（以及该路径自身所在目录）里按文件名比对；
 *      再尝试「名字本身就是某个目录下唯一文件」的宽松匹配（忽略大小写）。
 *   4) 若文件名没有扩展名或扩展名不对：在同目录里找「去掉后缀后同名」的文件
 *      （例如模型传了 a.png 但磁盘上实际叫 a 或 a.PNG）。
 */
export function resolveLocalFile(raw: string, searchDirs: string[] = []): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  // file:// → 本地路径
  let p = s
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\//i, ''))
    } catch (error) {
      p = p.replace(/^file:\/\//i, '')
    }
  }
  // 1) 绝对路径直接存在
  if (isAbsPath(p) && isFileSync(p)) return resolve(p)

  // 收集候选目录：显式给的 searchDirs + 路径自身所在目录
  const dirs: string[] = []
  const pushDir = (d: string): void => {
    const r = String(d || '').trim()
    if (r && !dirs.some((x) => looseEq(x, r))) dirs.push(r)
  }
  if (isAbsPath(p)) pushDir(dirname(p))
  else pushDir(dirname(p) === '.' ? '' : dirname(p))
  for (const d of searchDirs) pushDir(d)

  const wantBase = basename(p)
  const wantNoExt = wantBase.replace(/\.[a-z0-9]{1,6}$/i, '')

  // 2)/3) 在各目录里拼路径 / 按文件名匹配
  for (const d of dirs) {
    // 相对路径直接拼
    if (!isAbsPath(p)) {
      const cand = resolve(d || '.', p)
      if (isFileSync(cand)) return cand
    }
    let entries: string[] = []
    try {
      entries = readdirSync(d || '.')
    } catch (error) {
      continue
    }
    // 精确同名（忽略大小写）
    for (const name of entries) {
      if (looseEq(name, wantBase)) {
        const cand = resolve(d || '.', name)
        if (isFileSync(cand)) return cand
      }
    }
    // 4) 去掉后缀后同名（模型给了后缀、磁盘上没后缀，或反之）
    if (wantNoExt) {
      for (const name of entries) {
        const noExt = name.replace(/\.[a-z0-9]{1,6}$/i, '')
        if (looseEq(noExt, wantNoExt)) {
          const cand = resolve(d || '.', name)
          if (isFileSync(cand)) return cand
        }
      }
    }
  }
  return ''
}
