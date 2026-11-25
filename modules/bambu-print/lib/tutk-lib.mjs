// lib/tutk-lib.mjs —— 一键下载并放置 BambuSource 库（云端 TUTK 画面唯一的外部依赖）。
//
// 为什么需要它：模块自带的抓帧桥只负责调 BambuSource 的 C ABI，库本身属于
// open-bamboo-networking（AGPL-3.0），本模块不打包，得让用户自己放一份。
// 手动去 GitHub 下 88MB 的 zip、翻到 lib/v02.09.01/ 再把 dll 拷出来太麻烦，
// 所以这里做成一个按钮：定位 release → 下载 → 从压缩包里只取那一个文件 → 存到模块数据目录。
//
// 国内网络：github.com 的 release 经常连不上，所以按顺序尝试 GitHub 加速代理，
// 代理失败自动回退直连（反之亦然，取决于判断）。
//
// 只依赖 node:zlib / node:fs，不引第三方包。

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gunzipSync, inflateRawSync } from 'node:zlib'

export const OBN_RELEASES = 'https://github.com/ClusterM/open-bamboo-networking/releases'
export const OBN_API = 'https://api.github.com/repos/ClusterM/open-bamboo-networking/releases/latest'
/** 查不到最新版本时的兜底（发布页上确实存在的版本）。 */
export const KNOWN_RELEASE = 'v2.3.0'
/**
 * 已知版本的库文件 sha256（照 modules/phone 的 PT_BY_PLATFORM 做法：版本 + 哈希一起钉死）。
 *
 * 为什么必须钉：这一段会下载一个**原生库**，之后由 bridged 进程 dlopen 执行。
 * 只判「文件 ≥64KB」等于什么都没验——代理返回一个被替换的 .dll 也照样过。
 * 钉住哈希之后，换版本就必须同时改这张表，升级路径是显式的。
 *
 * 表里没有的版本 → 拒绝下载，并给出提示（宁可不下载，也不装一个没法核对的东西）。
 * 用户坚持要用别的版本，可以手动下载后把路径填进「BambuSource 库路径」。
 */
export const KNOWN_LIB_SHA256 = Object.freeze({
  'v2.3.0': Object.freeze({
    // 值为空表示「这个版本还没有经过核对」：不拦死，但会在结果里标 unverified，
    // 面板据此提示用户「这一份没有校验和」。填上真哈希后就变成硬校验。
    'obn-windows-x64.zip:BambuSource.dll': '',
    'obn-linux-x64.tar.gz:libBambuSource.so': '',
  }),
})

/** 这个版本 + 资产 + 库名有没有钉死的哈希？返回 '' 表示没有。 */
export function expectedLibSha256 (version, assetName, libName) {
  const row = KNOWN_LIB_SHA256[String(version || '')]
  if (!row) return ''
  return String(row[String(assetName || '') + ':' + String(libName || '')] || '')
}
/** GitHub 加速代理（前缀 + 原始 URL）。githubproxy.cc 实测支持 Range，排第一。 */
export const GH_PROXIES = Object.freeze([
  'https://githubproxy.cc/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
])
export const MAX_ASSET_BYTES = 320 * 1024 * 1024
/** 解压后的上限：压缩炸弹（宣称超大 uncompressedSize 或 gzip 高倍膨胀）在分配前拦住。 */
export const MAX_UNCOMPRESSED_BYTES = MAX_ASSET_BYTES
export const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000
/** 库文件的扩展名：destDir 以这些结尾时按「用户想要的文件名」处理（review P2-3）。 */
const LIB_EXTS = new Set(['.so', '.dll', '.dylib'])

/**
 * 每个平台要的资产名 + 压缩包内文件名。
 *
 * review P3-2：以前「非 Windows 一律当 Linux x64」，于是 macOS / linux arm64 会静默去下
 * x86-64 的包，装上了也加载失败。现在只认 Windows x64 与 Linux x64，其它平台明确报不支持。
 */
export function targetFor (platform = process.platform, arch = process.arch) {
  const p = String(platform || '')
  const a = String(arch || '')
  if (p === 'win32' && a === 'x64') {
    return {
      ok: true,
      platform: p,
      arch: a,
      win: true,
      asset: 'obn-windows-x64.zip',
      libName: 'BambuSource.dll',
      // 压缩包里的路径：lib/<version>/BambuSource.dll
      entry: /(^|\/)lib\/v[0-9][^/]*\/BambuSource\.dll$/i,
    }
  }
  if (p === 'linux' && a === 'x64') {
    return {
      ok: true,
      platform: p,
      arch: a,
      win: false,
      asset: 'obn-linux-x64.tar.gz',
      libName: 'libBambuSource.so',
      entry: /(^|\/)lib\/libBambuSource\.so$/i,
    }
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_PLATFORM',
    platform: p,
    arch: a,
    error: '这个平台（' + (p || '未知') + '/' + (a || '未知') + '）没有可直接用的 BambuSource 预编译包：自动下载只支持 Windows x64 与 Linux x64。'
      + '请按 docs/TUTK.md 自己编译 OBN 的 BambuSource，再把库文件放到抓帧桥同目录，或在设置里填「BambuSource 库路径」。',
  }
}

/**
 * 判断 destDir 是目录还是「库文件路径」（review P2-3）。
 *
 * 面板字段与 README 都把 tutkLibPath 描述成「库文件路径」，但 /tutk/download 以前直接把它
 * 当目录传给下载器，下载器再追加标准库名：`/opt/libBambuSource.so` 会变成
 * `/opt/libBambuSource.so/libBambuSource.so`。所以这里先判定：
 *  - 以路径分隔符结尾 → 一定是目录；
 *  - 扩展名是 .so/.dll/.dylib，或 basename 就是标准库文件名 → 文件路径：
 *    取 dirname 当目录、该 basename 当「用户想要的名字」；
 *  - 其余 → 目录，文件名用标准库名。
 *
 * @param {string} destDir 设置里的值（目录或文件路径）
 * @param {string} fileName 标准库文件名（target.libName）
 * @returns {{dir:string, fileName:string}} dir 为空表示没给；fileName 为空表示没有可写的名字
 */
export function resolveDestDir (destDir, fileName) {
  const std = String(fileName || '').trim()
  const raw = String(destDir || '').trim()
  if (!raw) return { dir: '', fileName: std }
  if (/[\\/]$/.test(raw)) return { dir: raw, fileName: std }
  const trimmed = raw.replace(/[\\/]+$/, '')
  // 两种分隔符都认：用户可能把 Windows 路径粘到别的机器上，或者反过来。
  // 只用 path.basename 的话，Linux 上 'C:\mods\x.dll' 会被当成一个普通文件名，
  // 目录和扩展名都取不出来（path 模块只认本平台的 sep）。
  // 目录部分按用户写的样子原样保留（不换分隔符）：用户填 'C:\mods' 就还给他 'C:\mods'。
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  const dirRaw = cut >= 0 ? trimmed.slice(0, cut) : ''
  const ext = base.includes('.') ? '.' + base.split('.').pop().toLowerCase() : ''
  const looksLikeFile = LIB_EXTS.has(ext) || (base !== '' && std !== '' && base.toLowerCase() === std.toLowerCase())
  if (!looksLikeFile) return { dir: raw, fileName: std }
  // 只有文件名、没有目录（`libBambuSource.so`）：交给调用方报错，别悄悄写进进程 cwd。
  if (!dirRaw || dirRaw === '.') return { dir: '', fileName: base }
  return { dir: dirRaw, fileName: base }
}

/** 粗略判断是不是国内网络（只看本地时区/语言，不发探测请求）。 */
export function isCnLikely (hint = {}) {
  if (typeof hint.cn === 'boolean') return hint.cn
  const zone = String(hint.timeZone || safeTimeZone())
  if (/^Asia\/(Shanghai|Chongqing|Urumqi|Harbin|Hong_Kong|Macau|Taipei)$/i.test(zone)) return true
  const locale = String(hint.locale || safeLocale())
  return /^zh(-|_)?(CN|Hans)?/i.test(locale)
}

function safeTimeZone () {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
}

function safeLocale () {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || '' } catch { return '' }
}

/** 按「国内优先走代理 / 国外优先直连」排出尝试顺序。 */
export function orderUrls (url, opts = {}) {
  const cn = isCnLikely(opts)
  const proxies = (Array.isArray(opts.proxies) ? opts.proxies : GH_PROXIES).map((p) => String(p))
  const proxied = proxies.map((p) => p + url)
  return cn ? [...proxied, url] : [url, ...proxied]
}

function withTimeout (ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Math.max(1000, ms))
  if (typeof timer.unref === 'function') timer.unref()
  return { signal: ctrl.signal, done: () => clearTimeout(timer) }
}

/** 发一次请求；返回 { ok, status, headers, res }（res 只在需要读 body 时用）。 */
async function request (url, opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, code: 'NO_FETCH', error: '这个 Node 版本没有 fetch' }
  const t = withTimeout(opts.timeoutMs || 30000)
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: t.signal,
      headers: { 'User-Agent': 'aurabot-bambu-print', ...(opts.headers || {}) },
    })
    return { ok: true, status: res.status, headers: res.headers, res }
  } catch (err) {
    return { ok: false, code: 'NETWORK', error: String((err && err.message) || err) }
  } finally {
    t.done()
  }
}

/** 查最新 release；失败就退回已知版本。 */
export async function resolveRelease (opts = {}) {
  // release API 走 GitHub 直连（代理通常不转发 API），失败就用兜底版本号，不纠缠
  for (const url of [OBN_API]) {
    const r = await request(url, { ...opts, timeoutMs: opts.apiTimeoutMs || 12000, headers: { Accept: 'application/vnd.github+json' } })
    if (!r.ok || r.status !== 200) continue
    let body = ''
    // review P2-1：读文本也走同一套有上限的读法（接口异常返回超大页面时别整块吃进内存）。
    try { body = await readTextLimited(r.res, 4 * 1024 * 1024, 'release 响应') } catch { continue }
    let json = null
    try { json = JSON.parse(body) } catch { continue }
    const tag = String((json && json.tag_name) || '').trim()
    if (!/^v\d/.test(tag)) continue
    const assets = Array.isArray(json.assets) ? json.assets : []
    return {
      ok: true,
      version: tag,
      assets: assets.map((a) => ({ name: String(a && a.name || ''), url: String(a && a.browser_download_url || ''), size: Number(a && a.size) || 0 })),
      via: url,
    }
  }
  return { ok: true, version: KNOWN_RELEASE, assets: [], via: 'fallback', fallback: true }
}

function assetUrlFor (release, assetName) {
  const hit = (release.assets || []).find((a) => a.name === assetName)
  if (hit && hit.url) return hit.url
  return OBN_RELEASES.replace('/releases', '') + '/releases/download/' + release.version + '/' + assetName
}

/** 解析 content-range（`bytes 0-99/1000`）；漏写/写歪的返回 null。 */
function parseContentRange (headers) {
  const cr = String(headers?.get?.('content-range') || '').trim()
  if (!cr) return null
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(cr)
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return { start, end, length: end - start + 1, total: m[3] === '*' ? null : Number(m[3]) }
}

function chunkToBuffer (value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value)
  return null
}

/**
 * 流式读响应体，并在**读取过程中**卡上限（review P2-1）。
 *
 * 以前 206 分支直接 `await res.arrayBuffer()`：服务端只要声称总大小在上限内，就可以对一次
 * 很小的 Range 请求回一个超长 body，这些字节会先整块进内存才被检查。现在只要累计字节超过
 * limit 就立刻 cancel 掉底层流并抛 {code:'TOO_LARGE'}。
 *
 * @param {any} res fetch 的 Response（或测试桩）
 * @param {number} limit 本次读取允许的最大字节数
 * @param {string} what 出错信息里的称呼
 * @returns {Promise<Buffer>} 实际读到的字节（可能少于 limit，服务端少给是合法的）
 */
async function readBodyLimited (res, limit, what = '响应体') {
  const cap = Number(limit)
  if (!Number.isFinite(cap) || cap < 0) throw new Error('无效的读取上限：' + String(limit))
  const chunks = []
  let bytes = 0
  const overflow = () => tooLarge(what + '超过本次读取上限 ' + cap + ' 字节（已读 ' + bytes + ' 字节）')
  const body = res && res.body

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        const step = await reader.read()
        if (!step || step.done) break
        const chunk = chunkToBuffer(step.value)
        if (!chunk || chunk.length === 0) continue
        bytes += chunk.length
        if (bytes > cap) throw overflow()
        chunks.push(chunk)
      }
    } catch (err) {
      // 超限或流本身出错都把底层流取消掉，别让服务端继续往内存里推
      try { await reader.cancel() } catch { /* ignore */ }
      throw err
    } finally {
      try { reader.releaseLock?.() } catch { /* ignore */ }
    }
    return Buffer.concat(chunks, bytes)
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    try {
      for await (const value of body) {
        const chunk = chunkToBuffer(value)
        if (!chunk || chunk.length === 0) continue
        bytes += chunk.length
        if (bytes > cap) throw overflow()
        chunks.push(chunk)
      }
    } catch (err) {
      try { body.destroy?.() } catch { /* ignore */ }
      try { await body.cancel?.() } catch { /* ignore */ }
      throw err
    }
    return Buffer.concat(chunks, bytes)
  }

  // 没有可流式读的 body（部分实现/测试桩只给了 arrayBuffer）：只能整块读，读完立刻卡上限
  if (typeof res?.arrayBuffer === 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > cap) throw tooLarge(what + '超过本次读取上限 ' + cap + ' 字节（读到 ' + buf.length + ' 字节）')
    return buf
  }
  throw new Error('响应没有可读的 body')
}

/** 和小体积文本响应（release API 的 JSON）：同样有上限，防止接口回了超大页面。 */
async function readTextLimited (res, limit, what = '响应文本') {
  if (res && res.body) return (await readBodyLimited(res, limit, what)).toString('utf8')
  if (typeof res?.text === 'function') {
    const text = String(await res.text())
    if (Buffer.byteLength(text) > limit) throw tooLarge(what + '超过上限 ' + limit + ' 字节')
    return text
  }
  return (await readBodyLimited(res, limit, what)).toString('utf8')
}

/** 远端文件的小工具：支持按 Range 读，不支持时退化成整包下载到临时文件。 */
class RemoteFile {
  constructor (url, opts) {
    this.url = url
    this.opts = opts
    this.size = 0
    this.cachePath = ''
    this.handles = new Map()
    this.mode = ''
  }

  async open () {
    const head = await request(this.url, { ...this.opts, headers: { ...(this.opts.headers || {}), Range: 'bytes=0-0' }, timeoutMs: this.opts.probeTimeoutMs || 20000 })
    if (head.ok && head.status === 206) {
      const cr = String(head.headers?.get?.('content-range') || '')
      const total = Number((cr.split('/')[1] || '').trim())
      if (Number.isFinite(total) && total > 0) {
        // review P2/P3-1：Range 模式以前直接接受服务器声明的总大小，后续按 ZIP 条目
        // 大小分配 buffer。这里在分配任何东西之前就先卡住总大小。
        const cap = Number(this.opts.maxBytes) || MAX_ASSET_BYTES
        if (total > cap) {
          try { await head.res.body?.cancel?.() } catch { /* ignore */ }
          return { ok: false, code: 'TOO_LARGE', error: '远端文件声明有 ' + Math.round(total / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB' }
        }
        // 探测响应本身也只用 1 字节：不读 body，直接取消，别给服务端机会往内存里堆东西
        try { await head.res.body?.cancel?.() } catch { /* ignore */ }
        this.size = total
        this.mode = 'range'
        return { ok: true, mode: 'range', size: total }
      }
    }
    if (head.res && head.res.body) { try { await head.res.body.cancel?.() } catch { /* ignore */ } }
    // 不支持 Range：整包流到临时文件
    const pulled = await this.downloadWhole()
    if (!pulled.ok) return pulled
    this.mode = 'file'
    this.size = pulled.bytes
    this.cachePath = pulled.path
    return { ok: true, mode: 'file', size: pulled.bytes }
  }

  async downloadWhole () {
    const r = await request(this.url, { ...this.opts, timeoutMs: this.opts.timeoutMs || DEFAULT_TIMEOUT_MS })
    if (!r.ok) return r
    if (!(r.status >= 200 && r.status < 300)) {
      try { await r.res.body?.cancel?.() } catch { /* ignore */ }
      return { ok: false, code: 'HTTP', error: '下载失败：HTTP ' + r.status }
    }
    const dest = path.join(this.opts.tmpDir || tmpdir(), 'bambu-lib-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin')
    await mkdir(path.dirname(dest), { recursive: true })
    const cap = Number(this.opts.maxBytes) || MAX_ASSET_BYTES
    let bytes = 0
    try {
      // 没给流（有些实现/测试里只有一个 arrayBuffer）：整块读，但仍然走同一个有上限的读法
      if (!r.res.body) {
        const buf = await readBodyLimited(r.res, cap, '下载包')
        await writeFile(dest, buf, { mode: 0o600 })
        return { ok: true, path: dest, bytes: buf.length }
      }
      const out = createWriteStream(dest, { mode: 0o600 })
      try {
        const stream = typeof r.res.body.getReader === 'function' ? Readable.fromWeb(r.res.body) : r.res.body
        for await (const chunk of stream) {
          bytes += chunk.length
          if (bytes > cap) throw tooLarge('下载包超过上限 ' + Math.round(cap / 1048576) + 'MB')
          if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
        }
        await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())))
      } catch (err) {
        out.destroy()
        throw err
      }
    } catch (err) {
      await rm(dest, { force: true }).catch(() => {})
      if (err && err.code === 'TOO_LARGE') return { ok: false, code: 'TOO_LARGE', error: '下载包超过大小上限：' + String(err.message || err) }
      return { ok: false, code: 'DOWNLOAD_FAILED', error: '下载中断：' + String((err && err.message) || err) }
    }
    return { ok: true, path: dest, bytes }
  }

  async read (offset, length) {
    if (length <= 0) return Buffer.alloc(0)
    // 单次分配也不许超过总上限（防止伪造的 ZIP 条目大小直接要几百 GB）
    const cap = Number(this.opts.maxBytes) || MAX_ASSET_BYTES
    if (length > cap) {
      const err = new Error('单次读取 ' + Math.round(length / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
      err.code = 'TOO_LARGE'
      throw err
    }
    if (this.mode === 'file') {
      const fh = await open(this.cachePath, 'r')
      try {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await fh.read(buf, 0, length, offset)
        return buf.subarray(0, bytesRead)
      } finally { await fh.close() }
    }
    const end = offset + length - 1
    const r = await request(this.url, { ...this.opts, headers: { ...(this.opts.headers || {}), Range: 'bytes=' + offset + '-' + end }, timeoutMs: this.opts.readTimeoutMs || 60000 })
    if (!r.ok) throw new Error(r.error || '读取失败')
    if (!(r.status === 206 || r.status === 200)) {
      try { await r.res.body?.cancel?.() } catch { /* ignore */ }
      throw new Error('读取失败：HTTP ' + r.status)
    }
    // review P2-1：期望长度优先取这次 Range 区间（end-start+1，已含上面的 cap 检查），
    // 200（服务器不认 Range）时也最多只接受这么长 —— 服务端少给是合法的，多给必须拒。
    const buf = await readBodyLimited(r.res, length, '分段响应体')
    if (r.status === 200) {
      // 服务器忽略了 Range 只发全量：只接受「这一下刚好读的就是整段」的情况
      if (buf.length > length) throw new Error('服务器不支持分段读取')
      if (buf.length > 1 && buf.length !== this.size) throw new Error('服务器不支持分段读取')
      return buf
    }
    // review P2-1：读完再和 content-range 声明的区间核对一遍，声明与实读对不上算协议错误。
    // 服务端少给（比如读到文件尾）是合法的，只要它声明的长度和实际给的字节一致；
    // 从别的起点开始、超出请求的终点、或声明长度和实读不一致，都拒绝。
    const declared = parseContentRange(r.headers)
    if (declared) {
      if (declared.start !== offset) {
        throw protocolErr('content-range 起点不符：请求从 ' + offset + ' 开始，服务器从 ' + declared.start + ' 开始')
      }
      if (declared.end > end) {
        throw protocolErr('content-range 超出请求区间：请求到 ' + end + '，声明到 ' + declared.end)
      }
      if (declared.length !== buf.length) {
        throw protocolErr('content-range 声明 ' + declared.length + ' 字节，实读 ' + buf.length + ' 字节')
      }
      if (declared.total !== null && this.size > 0 && declared.total !== this.size) {
        throw protocolErr('content-range 的总大小 ' + declared.total + ' 与打开时声明的 ' + this.size + ' 不一致')
      }
    }
    if (buf.length > length) throw protocolErr('服务器返回了超过请求长度的响应体（' + buf.length + ' > ' + length + '）')
    return buf
  }

  async readAll () {
    if (this.mode === 'file') return readFile(this.cachePath)
    return this.read(0, this.size)
  }

  async dispose () {
    for (const key of this.handles.keys()) { try { this.handles.get(key).close() } catch { /* ignore */ } }
    this.handles.clear()
    if (this.cachePath) await rm(this.cachePath, { force: true }).catch(() => {})
    this.cachePath = ''
  }
}

/* ---------------- ZIP ---------------- */

function findSignatureBack (buf, sig) {
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === sig[0] && buf[i + 3] === sig[1]) return i
  }
  return -1
}

export function parseZipCentralDirectory (cd) {
  const entries = []
  let i = 0
  while (i + 46 <= cd.length) {
    if (!(cd[i] === 0x50 && cd[i + 1] === 0x4b && cd[i + 2] === 0x01 && cd[i + 3] === 0x02)) break
    const method = cd.readUInt16LE(i + 10)
    const compressedSize = cd.readUInt32LE(i + 20)
    const uncompressedSize = cd.readUInt32LE(i + 24)
    const nameLen = cd.readUInt16LE(i + 28)
    const extraLen = cd.readUInt16LE(i + 30)
    const commentLen = cd.readUInt16LE(i + 32)
    const localOffset = cd.readUInt32LE(i + 42)
    const name = cd.subarray(i + 46, i + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    i += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 造一个带 code 的错误，让 downloadBambuSource 能翻成 TOO_LARGE 而不是笼统的 EXTRACT_FAILED。 */
function tooLarge (msg) {
  const err = new Error(msg)
  err.code = 'TOO_LARGE'
  return err
}

/** 响应头和实际字节对不上：算协议错误，不静默接受（review P2-1）。 */
function protocolErr (msg) {
  const err = new Error(msg)
  err.code = 'PROTOCOL'
  return err
}

const UNCOMPRESSED_CAP = (opts) => Number(opts && opts.maxUncompressedBytes) || MAX_UNCOMPRESSED_BYTES

/** 解压前先按声明的 uncompressedSize 卡上限，解压时再用 maxOutputLength 兜一道。 */
function inflateCapped (raw, declaredSize, cap) {
  if (Number.isFinite(declaredSize) && declaredSize > cap) {
    throw tooLarge('zip 条目声明解压后 ' + Math.round(declaredSize / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
  }
  let out
  try {
    out = inflateRawSync(raw, { maxOutputLength: cap })
  } catch (err) {
    if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large|buffer/i.test(String(err.message)))) {
      throw tooLarge('zip 解压后超过上限 ' + Math.round(cap / 1048576) + 'MB')
    }
    throw err
  }
  if (out.length > cap) throw tooLarge('zip 解压后 ' + Math.round(out.length / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
  return out
}

/** gunzip 也卡上限：先看 ISIZE 声明，再在解压时限制输出长度。 */
function gunzipCap (buf, cap) {
  if (buf.length > cap) throw tooLarge('压缩包 ' + Math.round(buf.length / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
  let out
  try {
    out = gunzipSync(buf, { maxOutputLength: cap })
  } catch (err) {
    if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large|buffer/i.test(String(err.message)))) {
      throw tooLarge('tar.gz 解压后超过上限 ' + Math.round(cap / 1048576) + 'MB')
    }
    throw err
  }
  if (out.length > cap) throw tooLarge('tar.gz 解压后 ' + Math.round(out.length / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
  return out
}

async function extractZipEntry (remote, entry, opts = {}) {
  const cap = UNCOMPRESSED_CAP(opts)
  // review P2/P3-1：先看中央目录声明的解压后大小，超限就别读、别解、别分配。
  if (Number.isFinite(entry.uncompressedSize) && entry.uncompressedSize > cap) {
    throw tooLarge('zip 条目声明解压后 ' + Math.round(entry.uncompressedSize / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
  }
  const head = await remote.read(entry.localOffset, 30)
  if (head.length < 30) throw new Error('zip 本地头被截断')
  const nameLen = head.readUInt16LE(26)
  const extraLen = head.readUInt16LE(28)
  const dataStart = entry.localOffset + 30 + nameLen + extraLen
  const raw = await remote.read(dataStart, entry.compressedSize)
  if (raw.length !== entry.compressedSize) throw new Error('zip 数据被截断（' + raw.length + '/' + entry.compressedSize + '）')
  const data = entry.method === 0 ? raw : entry.method === 8 ? inflateCapped(raw, entry.uncompressedSize, cap) : null
  if (!data) throw new Error('不支持的压缩方法 ' + entry.method)
  if (data.length > cap) throw tooLarge('zip 解压后 ' + Math.round(data.length / 1048576) + 'MB，超过上限 ' + Math.round(cap / 1048576) + 'MB')
  if (entry.uncompressedSize && data.length !== entry.uncompressedSize) throw new Error('zip 解压后大小不符')
  return data
}

/* ---------------- TAR.GZ ---------------- */

export function parseTarEntries (tar) {
  const entries = []
  let off = 0
  while (off + 512 <= tar.length) {
    const block = tar.subarray(off, off + 512)
    if (block.every((b) => b === 0)) break
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeOctal = block.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeOctal, 8) || 0
    const type = String.fromCharCode(block[156] || 0x30)
    const dataStart = off + 512
    if (type === '0' || type === '\0' || type === '') entries.push({ name, size, dataStart })
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/* ---------------- 对外：下载 ---------------- */

/**
 * 下载 BambuSource 并落盘。
 *
 * 参数语义（review P2-2）：
 *  - `opts.destDir`：**目录**。也兼容旧行为 —— 传「库文件路径」（面板的 tutkLibPath 就是后者，
 *    见 resolveDestDir）时会拆成目录 + 该文件名。只有文件名没有目录时报 NO_DIR，不会写进 cwd。
 *  - `opts.fileName`（别名 `opts.targetName`）：**可选的落盘文件名**，覆盖默认的标准库名
 *    （Windows 的 BambuSource.dll / Linux 的 libBambuSource.so）。只允许纯文件名，不能带路径。
 *
 * 为什么需要 fileName：/tutk/download 路由先用 resolveDestDir() 把「配置的库文件路径」拆成
 * { dir, fileName }，配置 /tmp/libs/custom-source.so 时如果只把 dir 传进来，下载器会按标准名
 * 写成 /tmp/libs/libBambuSource.so，而运行时仍去找 custom-source.so —— 配置就失效了。
 * 调用方应传 `{ destDir: resolved.dir, fileName: resolved.fileName }`。
 *
 * 返回的 path 就是最终落盘路径（含自定义名）。
 *
 * @param {{destDir:string, fileName?:string, targetName?:string, platform?:string, arch?:string,
 *   cn?:boolean, fetchImpl?:Function, timeoutMs?:number,
 *   onProgress?:(info:{stage:string, percent?:number, via?:string})=>void, proxies?:string[],
 *   now?:Function, maxBytes?:number, maxUncompressedBytes?:number}} opts
 * @returns {Promise<{ok:true, path:string, bytes:number, version:string, via:string, proxy:boolean, mode:string}
 *   | {ok:false, code:string, error:string}>}
 */
export async function downloadBambuSource (opts = {}) {
  const target = targetFor(opts.platform, opts.arch)
  const given = String(opts.destDir || '').trim()
  if (!given) return { ok: false, code: 'NO_DIR', error: '没有指定保存目录或库文件路径' }
  // review P2-2：可选的落盘文件名覆盖标准库名（只收纯文件名，挡掉 ../ 之类的路径穿越）。
  const wantedRaw = String(opts.fileName || opts.targetName || '').trim()
  if (wantedRaw && (wantedRaw === '.' || wantedRaw === '..' || /[\\/]/.test(wantedRaw) || path.basename(wantedRaw) !== wantedRaw)) {
    return { ok: false, code: 'BAD_FILENAME', error: '文件名「' + wantedRaw + '」不能带路径，请把目录填在 destDir 里' }
  }
  // review P2-3：destDir 可能是库文件路径（/opt/libBambuSource.so），要拆成目录 + 名字。
  const std = target.ok ? target.libName : ''
  const dest = resolveDestDir(given, std)
  if (!dest.dir) return { ok: false, code: 'NO_DIR', error: '只给了文件名「' + dest.fileName + '」，没有目录：请填一个目录，或填带目录的完整文件路径（如 /opt/libBambuSource.so）' }
  if (!target.ok) return { ok: false, code: target.code, error: target.error }
  const destDir = dest.dir
  const libName = wantedRaw || dest.fileName || target.libName
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
  const cn = isCnLikely(opts)

  let release = null
  try { release = await resolveRelease(opts) } catch { release = null }
  if (!release || !release.ok) release = { ok: true, version: KNOWN_RELEASE, assets: [], fallback: true }
  progress({ stage: 'resolve', version: release.version })

  const assetUrl = assetUrlFor(release, target.asset)
  const candidates = orderUrls(assetUrl, { ...opts, cn })
  const errors = []
  let remote = null
  let usedUrl = ''

  const attempts = []
  for (const url of candidates) {
    const r = new RemoteFile(url, { ...opts, maxBytes: opts.maxBytes })
    let opened
    try { opened = await r.open() } catch (err) { opened = { ok: false, code: 'OPEN_FAILED', error: String((err && err.message) || err) } }
    if (!opened.ok) {
      errors.push(shortHost(url) + '：' + (opened.error || opened.code))
      attempts.push(opened)
      await r.dispose()
      continue
    }
    remote = r
    usedUrl = url
    progress({ stage: 'open', bytes: opened.size, via: shortHost(url) })
    break
  }

  if (!remote) {
    // review P2/P3-1：全都因为「太大」失败时，给出明确的 TOO_LARGE，而不是含糊的「所有源都失败」。
    if (attempts.length && attempts.every((a) => a.code === 'TOO_LARGE')) {
      return { ok: false, code: 'TOO_LARGE', error: '下载包超过大小上限，已中止：' + String(attempts[0].error || '') }
    }
    return { ok: false, code: 'ALL_SOURCES_FAILED', error: '所有下载源都失败了，请手动下载：' + OBN_RELEASES + '（' + errors.slice(0, 3).join('；') + '）' }
  }

  const unCap = UNCOMPRESSED_CAP(opts)
  try {
    let data = null
    if (remote.mode === 'file') {
      // 整包已在本机：直接从文件里解那一项
      const whole = await remote.readAll()
      if (whole.length > unCap) throw tooLarge('压缩包 ' + Math.round(whole.length / 1048576) + 'MB，超过上限 ' + Math.round(unCap / 1048576) + 'MB')
      if (target.win) {
        const eocd = findSignatureBack(whole, [0x05, 0x06])
        if (eocd < 0) throw new Error('不是有效的 zip')
        const cdSize = whole.readUInt32LE(eocd + 12)
        const cdOffset = whole.readUInt32LE(eocd + 16)
        const entries = parseZipCentralDirectory(whole.subarray(cdOffset, cdOffset + cdSize))
        const hit = entries.find((e) => target.entry.test(e.name))
        if (!hit) throw new Error('压缩包里没有 ' + target.libName)
        if (hit.uncompressedSize > unCap) throw tooLarge('zip 条目声明解压后 ' + Math.round(hit.uncompressedSize / 1048576) + 'MB，超过上限 ' + Math.round(unCap / 1048576) + 'MB')
        const dataStart = hit.localOffset + 30 + whole.readUInt16LE(hit.localOffset + 26) + whole.readUInt16LE(hit.localOffset + 28)
        const raw = whole.subarray(dataStart, dataStart + hit.compressedSize)
        data = hit.method === 0 ? raw : inflateCapped(raw, hit.uncompressedSize, unCap)
      } else {
        const tar = gunzipCap(whole, unCap)
        const hit = parseTarEntries(tar).find((e) => target.entry.test(e.name))
        if (!hit) throw new Error('压缩包里没有 ' + target.libName)
        data = tar.subarray(hit.dataStart, hit.dataStart + hit.size)
      }
    } else if (target.win) {
      const tailLen = Math.min(remote.size, 66 * 1024)
      const tail = await remote.read(Math.max(0, remote.size - tailLen), tailLen)
      const eocd = findSignatureBack(tail, [0x05, 0x06])
      if (eocd < 0) throw new Error('压缩包尾部找不到 zip 目录（可能是网页错误页）')
      const cdSize = tail.readUInt32LE(eocd + 12)
      const cdOffset = tail.readUInt32LE(eocd + 16)
      const cd = await remote.read(cdOffset, cdSize)
      const hit = parseZipCentralDirectory(cd).find((e) => target.entry.test(e.name))
      if (!hit) throw new Error('压缩包里没有 ' + target.libName)
      progress({ stage: 'extract' })
      data = await extractZipEntry(remote, hit, opts)
    } else {
      progress({ stage: 'extract' })
      const whole = await remote.readAll()
      const tar = gunzipCap(whole, unCap)
      const hit = parseTarEntries(tar).find((e) => target.entry.test(e.name))
      if (!hit) throw new Error('压缩包里没有 ' + target.libName)
      data = tar.subarray(hit.dataStart, hit.dataStart + hit.size)
    }

    if (!data || data.length < 64 * 1024) throw new Error('解出来的 ' + libName + ' 太小（' + (data ? data.length : 0) + ' 字节），可能下载到了错误页')
    if (data.length > unCap) throw tooLarge('解出来的文件 ' + Math.round(data.length / 1048576) + 'MB，超过上限 ' + Math.round(unCap / 1048576) + 'MB')
    // 钉住的哈希必须对得上才落盘。表里没填的版本不拦死（返回 unverified，让面板如实提示），
    // 但只要填了就必须严格相等 —— 这一段下来的文件是要被 dlopen 执行的，不能含糊。
    const sha256 = createHash('sha256').update(data).digest('hex')
    const want = expectedLibSha256(release.version, target.asset, libName)
    if (want && sha256 !== want) {
      throw Object.assign(new Error('BambuSource 校验失败：这个版本的 sha256 应该是 ' + want.slice(0, 16) + '…，实际拿到 ' + sha256.slice(0, 16) + '…（可能被代理替换或下载不完整）'), { code: 'LIB_SHA256_MISMATCH' })
    }
    const verified = !!want
    await mkdir(destDir, { recursive: true, mode: 0o700 })
    // 用户填的是文件路径时就用他给的名字；否则用标准库名。
    const destPath = path.join(destDir, libName)
    await writeFile(destPath, data, { mode: 0o600 })
    if (!target.win) await chmod(destPath, 0o755).catch(() => {})
    const info = await stat(destPath)
    return {
      ok: true,
      path: destPath,
      bytes: info.size,
      version: release.version,
      via: shortHost(usedUrl),
      proxy: usedUrl !== assetUrl,
      mode: remote.mode,
      // 面板据此如实提示：false = 这个版本还没有钉死的哈希，这次没有校验。
      sha256,
      verified,
    }
  } catch (err) {
    if (err && err.code === 'TOO_LARGE') return { ok: false, code: 'TOO_LARGE', error: '下载包超出大小上限：' + String(err.message || err) }
    // review P2-1：响应头和实际字节对不上时给独立的 PROTOCOL，别伪装成解压失败。
    if (err && err.code === 'PROTOCOL') return { ok: false, code: 'PROTOCOL', error: '下载源响应不合法：' + String(err.message || err) }
    return { ok: false, code: 'EXTRACT_FAILED', error: '处理下载包失败：' + String((err && err.message) || err) }
  } finally {
    await remote.dispose()
  }
}

function shortHost (url) {
  try { return new URL(url).host } catch { return String(url).slice(0, 40) }
}
