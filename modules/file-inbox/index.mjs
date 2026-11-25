// 私聊收件箱（file-inbox）
// 作用：修复「主人私聊发文件，插件只收到 [文件 xxx] 占位预览、内容拿不到」的问题。
// 原理：插件入站管线其实已把 file 段解析出来（但只在 recentFiles 里记账，
// 且内置 qq_read_file 只肯读文本文件）。本模块监听 message 事件，从 msg.raw 原始 OneBot 事件里
// 抽出 file 段 → 取下载地址（段自带 url，否则 get_private_file_url / get_file 兜底）→
// 下载落盘到 api.dataDir('inbox') → 记进 inbox.json → 注册工具 inbox_files 给她自己取用。
// 来源：aurabot 本地用户模块；数据一律写 api.dataDir()，模块目录不落任何运行数据。

import { mkdirSync, writeFileSync, statSync, existsSync, unlinkSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { inflateRawSync } from 'node:zlib'

const MAX_KEEP = 50 // 收件箱最多留几份文件（旧的自动删，防撑爆硬盘）

// ---- 常见格式分类：图片 / 音频 / 视频 / 压缩包 / 文档 / 文本代码，其余归「其他」 ----
const CATS = [
  ['图片', /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?|ico|svg)$/i],
  ['音频', /\.(mp3|wav|flac|aac|ogg|oga|opus|m4a|wma|ape|amr|mid|midi)$/i],
  ['视频', /\.(mp4|mov|avi|mkv|flv|wmv|webm|m4v|ts|3gp|rmvb)$/i],
  ['压缩包', /\.(zip|rar|7z|tar|t?gz|bz2|xz|cab|iso)$/i],
  ['文档', /\.(pdf|docx?|xlsx?|pptx?|csv|epub|mobi)$/i],
  ['文本', /\.(txt|md|json|xml|ya?ml|ini|log|html?|css|js|mjs|cjs|ts|py|java|c|cpp|h|cs|go|rs|sh|bat|ps1|sql|toml)$/i],
]
const catOf = (name) => (CATS.find(([, re]) => re.test(String(name)))?.[0]) || '其他'
const TEXT_RE = CATS[5][1] // 文本类：工具里可以直接读内容
/** 面板/工具里按扩展名给 Content-Type（够用就好，认不出就 octet-stream）。 */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.amr': 'audio/amr',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv', '.xml': 'application/xml',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** 文件名净化：去掉路径分隔等危险字符，太长截断。 */
function safeName(name) {
  const base = String(name || '未命名文件').replace(/[\\/:*?"<>|]/g, '_').trim()
  return base.length > 120 ? base.slice(0, 120) : base || '未命名文件'
}

/** 人类可读的大小。 */
function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

// ---- zip 清单解析：读中央目录列条目（名字 + 原始大小），纯 JS 无依赖，最多列 200 条 ----
function zipList(buf) {
  // 找 End of Central Directory（从尾部扫，注释最多 64KB）
  let eo = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break }
  }
  if (eo < 0) throw new Error('不是标准 zip（找不到中央目录），可能是加密包或别的压缩格式')
  const count = buf.readUInt16LE(eo + 10)
  let off = buf.readUInt32LE(eo + 16)
  const entries = []
  for (let n = 0; n < count && entries.length < 200 && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const flags = buf.readUInt16LE(off + 8)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const name = (flags & 0x800) ? buf.toString('utf8', off + 46, off + 46 + nameLen) : buf.toString('latin1', off + 46, off + 46 + nameLen)
    entries.push(`${name}（${humanSize(usize)}${(flags & 1) ? '，已加密' : ''}）`)
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  if (!entries.length) throw new Error('zip 里没有可列的条目')
  const more = count > entries.length ? `\n…还有 ${count - entries.length} 个条目没列` : ''
  return `共 ${count} 个条目：\n` + entries.join('\n') + more
}

// ---- ffmpeg 定位与音频转写（转 16k 单声道 wav → 本地 ASR）----
function findFfmpeg(configured = '') {
  const direct = String(configured || '').trim().replace(/^"|"$/g, '')
  if (direct) { try { if (existsSync(direct)) return direct } catch {} }
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  const dirs = [
    ...String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean),
    join(os.homedir(), '.grabit', 'bin'), // grabit 装的位置
    join(os.homedir(), 'AppData', 'Local', 'grabit', 'bin'),
  ]
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n)
      try { if (existsSync(p)) return p } catch {}
    }
  }
  return ''
}
function runFfmpeg(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let done = false
    const child = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => { if (!done) { try { child.kill() } catch {} done = true; resolve(false) } }, timeoutMs)
    child.on('error', () => { if (!done) { clearTimeout(timer); done = true; resolve(false) } })
    child.on('exit', (code) => { if (!done) { clearTimeout(timer); done = true; resolve(code === 0) } })
  })
}
// ---- 办公文件（docx/xlsx/pptx）抽正文：本质是 zip 包 XML，用自带 zlib 解压，无第三方依赖 ----
/** 从 zip Buffer 里取出指定名称的条目内容（按中央目录找，支持目录前缀）。 */
function zipExtract(buf, want) {
  let eo = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break }
  }
  if (eo < 0) throw new Error('不是标准 zip')
  const count = buf.readUInt16LE(eo + 10)
  let off = buf.readUInt32LE(eo + 16)
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const flags = buf.readUInt16LE(off + 8)
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const local = buf.readUInt32LE(off + 42)
    const name = (flags & 0x800) ? buf.toString('utf8', off + 46, off + 46 + nameLen) : buf.toString('latin1', off + 46, off + 46 + nameLen)
    if (name === want || name.endsWith('/' + want)) {
      if (flags & 1) throw new Error('条目已加密')
      // 本地头里名字/额外字段长度可能与中央目录不同，以本地头为准
      const lNameLen = buf.readUInt16LE(local + 26)
      const lExtraLen = buf.readUInt16LE(local + 28)
      const start = local + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(start, start + csize)
      return method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return null
}
const xmlText = (s) => String(s || '')
  .replace(/<\/w:p>|<\/a:p>|<\/text:p>/g, '\n')      // 段落/页断行
  .replace(/<w:tab[^>]*\/>|<[^>]+>/g, '')             // 去标签
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
/** docx：word/document.xml 抽正文。 */
function docxText(buf) {
  const xml = zipExtract(buf, 'word/document.xml')
  if (!xml) throw new Error('不是标准 docx（缺 word/document.xml）')
  return xmlText(xml.toString('utf8'))
}
/** pptx：ppt/slides/slideN.xml 按页抽文字。 */
function pptxText(buf) {
  let eo = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break }
  if (eo < 0) throw new Error('不是标准 pptx')
  const count = buf.readUInt16LE(eo + 10)
  let off = buf.readUInt32LE(eo + 16)
  const slides = []
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    const m = name.match(/^ppt\/slides\/(slide\d+\.xml)$/)
    if (m) slides.push([Number(m[1].replace(/\D/g, '')), name])
    off += 46 + nameLen + extraLen + commentLen
  }
  if (!slides.length) throw new Error('pptx 里没有幻灯片')
  slides.sort((a, b) => a[0] - b[0])
  return slides.map(([no, name]) => `【第 ${no} 页】\n` + (xmlText(zipExtract(buf, name)?.toString('utf8')) || '（本页无文字）')).join('\n\n')
}
/** xlsx：sharedStrings.xml + 每个 sheet 的单元格按行拼（字符/数值/内联串，公式取缓存值）。 */
function xlsxText(buf) {
  const shared = []
  const ss = zipExtract(buf, 'xl/sharedStrings.xml')
  if (ss) for (const m of ss.toString('utf8').matchAll(/<t[^>]*>([^<]*)<\/t>/g)) shared.push(xmlText(m[1]))
  let eo = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break }
  if (eo < 0) throw new Error('不是标准 xlsx')
  const count = buf.readUInt16LE(eo + 10)
  let off = buf.readUInt32LE(eo + 16)
  const sheets = []
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) sheets.push(name)
    off += 46 + nameLen + extraLen + commentLen
  }
  if (!sheets.length) throw new Error('xlsx 里没有工作表')
  return sheets.map((name, si) => {
    const xml = zipExtract(buf, name)?.toString('utf8') || ''
    const rows = []
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const [, attrs, inner] = cm
        const type = attrs.match(/t="(\w+)"/)?.[1]
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1]
        const is = inner.match(/<is>[\s\S]*?<t[^>]*>([^<]*)<\/t>/)?.[1]
        if (type === 's' && v !== undefined) cells.push(shared[Number(v)] ?? '')
        else if (type === 'inlineStr' && is !== undefined) cells.push(xmlText(is))
        else if (v !== undefined) cells.push(xmlText(v))
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join(' | '))
    }
    return `【工作表 ${si + 1}（${name.split('/').pop()}）${rows.length} 行】\n` + (rows.slice(0, 300).join('\n') || '（空表）') + (rows.length > 300 ? `\n…还有 ${rows.length - 300} 行` : '')
  }).join('\n\n')
}
const asrCache = new Map() // path → { at, text } 同一个音频别反复转写
async function transcribeAudio(path, local, cfg) {
  const cached = asrCache.get(path)
  if (cached && Date.now() - cached.at < 3600_000) return cached.text
  if (!local?.active?.('asr')) throw new Error('本机语音识别（ASR）没开：面板「本地能力」打开后才能听懂音频')

  const bin = findFfmpeg(typeof cfg === 'function' ? cfg().ffmpegPath : '')
  if (!bin) throw new Error('本机没有 ffmpeg，转不了音频格式')
  const dir = mkdtempSync(join(tmpdir(), 'inbox-asr-'))
  const wav = join(dir, 'a.wav')
  try {
    const ok = await runFfmpeg(bin, ['-y', '-i', path, '-ac', '1', '-ar', '16000', '-vn', '-f', 'wav', wav])
    if (!ok || !existsSync(wav)) throw new Error('ffmpeg 转码失败')
    const r = await local.call('asr', { file: wav })
    const text = String(r?.text || r || '').trim()
    if (!text) throw new Error('没听出内容（可能是纯音乐）')
    asrCache.set(path, { at: Date.now(), text })
    return text
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/** 读收件箱清单（inbox.json）。 */
function loadManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'inbox.json'), 'utf8')) } catch { return [] }
}
function saveManifest(dir, list) {
  try { writeFileSync(join(dir, 'inbox.json'), JSON.stringify(list, null, 2), 'utf8') } catch {}
}

/** 从原始 OneBot 事件里抽出所有 file 段（兼容 CQ 码字符串：拿不到结构化数据就返回空）。 */
function fileSegments(raw) {
  const m = raw?.message
  if (!Array.isArray(m)) return []
  return m.filter((s) => s && s.type === 'file' && s.data)
}

export default {
  id: 'file-inbox',
  name: '私聊收件箱',
  version: '1.3.0',
  api: 1,
  description: '私聊收到的文件真的收下来：自动下载存进收件箱，她自己能用工具取',
  panel: 'panel.js',
  capabilities: ['network', 'filesystem', 'process'], // 联网下载 + 落盘保存 + ffmpeg 子进程转音频
  settings: [
    { key: 'scope', label: '收谁的文件', type: 'select', options: [{ value: 'owner', label: '只收主人私聊的（推荐）' }, { value: 'all', label: '所有私聊的都收' }], hint: '默认只收主人私聊，免得被陌生人塞文件撑爆硬盘' },
    { key: 'ownerQQ', label: '主人 QQ', type: 'text', hint: '选「只收主人私聊的」时用来认人；留空则按插件配置里的主人判定' },
    { key: 'maxMB', label: '单个文件上限（MB）', type: 'number', min: 1, max: 2048, step: 1, hint: '超过就不收，只回一句「太大了」' },
    { key: 'autoReply', label: '收下后回一条确认', type: 'switch', hint: '收到文件后回「已放进收件箱」，她还能接着搭话' },
    { key: 'ffmpegPath', label: 'ffmpeg 路径（选填）', type: 'text', hint: '音频转文字要用；留空则自动找 PATH 和常见安装位置（如 ~\\.grabit\\bin）' },
    { key: 'exts', label: '只要这些后缀（留空=全收）', type: 'textarea', hint: '逗号分隔，如：zip,rar,7z,pdf,docx' },
  ],
  defaults: { scope: 'owner', ownerQQ: '', maxMB: 500, autoReply: true, exts: '' },
  setup(api) {
    const cfg = api.settings
    const log = (...a) => { try { api.log.info('[收件箱]', ...a) } catch {} }

    // ---- 判定这条私聊要不要收 ----
    function ownerMatch(msg) {
      const ownerQQ = String(cfg().ownerQQ || '').trim()
      if (ownerQQ) return String(msg.userId) === ownerQQ
      // 没填主人 QQ：退回插件配置里的主人号兜底（宿主 core 给的是 getConfig，不是 cfg）
      try {
        const c = api.core?.getConfig?.() ?? api.core?.cfg?.() ?? {}
        const o = c.ownerQQ ?? c.botQQ ?? ''
        if (!o) { log('没找到主人号（模块设置 ownerQQ 和插件配置 ownerQQ 都空），这条文件不收'); return false }
        return String(msg.userId) === String(o)
      } catch { return false }
    }
    function shouldCollect(msg) {
      if (msg.kind !== 'private') return false
      const mode = String(cfg().scope || 'owner')
      if (mode === 'all') return true
      const ok = ownerMatch(msg)
      if (!ok) log(`私聊 ${msg.userId} 不是认定的主人，不收`)
      return ok
    }
    function extAllowed(name) {
      const list = String(cfg().exts || '').split(/[,，\s]+/).map((s) => s.replace(/^\./, '').toLowerCase()).filter(Boolean)
      if (!list.length) return true
      const ext = String(name).split('.').pop().toLowerCase()
      return list.includes(ext)
    }

    // ---- 取下载地址：段自带 url → get_private_file_url → get_file ----
    async function resolveUrl(seg, msg) {
      const d = seg.data || {}
      if (typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) return { url: d.url }
      const fid = String(d.file_id ?? d.id ?? '')
      if (fid) {
        try {
          const r = await api.onebot('get_private_file_url', { user_id: Number(msg.userId), file_id: fid, ...(d.file_hash ? { file_hash: d.file_hash } : {}) }, { timeoutMs: 15000 })
          if (r?.url) return { url: r.url }
        } catch {}
        try {
          const r = await api.onebot('get_file', { file_id: fid }, { timeoutMs: 15000 })
          if (r?.url) return { url: r.url }
          if (r?.file && existsSync(r.file)) return { localPath: r.file } // 网关在本机时直接给本地路径
        } catch {}
      }
      return {}
    }

    // ---- 下载（网址）或复制（本地路径），成功返回落盘路径 ----
    async function saveFile({ url, localPath }, name, maxBytes) {
      const dir = api.dataDir('inbox')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const dest = join(dir, `${stamp}-${safeName(name)}`)
      if (localPath) {
        copyFileSync(localPath, dest)
        return dest
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`文件 ${humanSize(buf.length)} 超过上限 ${humanSize(maxBytes)}`)
      writeFileSync(dest, buf)
      return dest
    }

    // ---- 清理：最多留 MAX_KEEP 份 ----
    function prune(dir, list) {
      for (const it of list.slice(MAX_KEEP)) { try { if (existsSync(it.path)) unlinkSync(it.path) } catch {} }
      return list.slice(0, MAX_KEEP)
    }

    // ---- 接收记录：每次尝试都记一行（jsonl，最多留 500 条），面板可查 ----
    function record(dir, entry) {
      const file = join(dir, '接收记录.jsonl')
      let lines = []
      try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch {}
      lines.push(JSON.stringify({ at: Date.now(), ...entry }))
      try { writeFileSync(file, lines.slice(-500).join('\n') + '\n', 'utf8') } catch {}
    }

    // ---- 主逻辑：收到私聊消息，抽文件、下载、登记、确认 ----
    api.on('message', async (msg) => {
      const raw = msg.raw || {}
      if (raw.simulated) return false // 面板模拟测试不带真文件，跳过
      const segs = fileSegments(raw)
      if (!segs.length || !shouldCollect(msg)) return false

      const maxBytes = Math.max(1, Number(cfg().maxMB) || 500) * 1024 * 1024
      const dir = api.dataDir('inbox')
      const before = loadManifest(dir)
      const now = Date.now()
      let savedCount = 0
      for (const seg of segs) {
        const d = seg.data || {}
        const name = String(d.file_name || d.name || d.file || '未命名文件')
        const size = Number(d.file_size ?? d.size) || 0
        if (!extAllowed(name)) { record(dir, { action: '跳过', name, size, from: msg.userId, reason: '后缀不在允许列表' }); log(`《${name}》后缀不在允许列表，没收`); continue }
        if (size > maxBytes) {
          record(dir, { action: '跳过', name, size, from: msg.userId, reason: `超过上限 ${cfg().maxMB}MB` })
          log(`《${name}》${humanSize(size)} 超过上限，没收`)
          if (cfg().autoReply) await api.reply(msg, `《${name}》有 ${humanSize(size)}，超过我定的 ${cfg().maxMB}MB 上限，收不了啦`)
          continue
        }
        try {
          const src = await resolveUrl(seg, msg)
          if (!src.url && !src.localPath) throw new Error('拿不到下载地址（可能已过期）')
          const path = await saveFile(src, name, maxBytes)
          const bytes = size || (existsSync(path) ? statSync(path).size : 0)
          before.unshift({ id: `${now}-${Math.floor(Math.random() * 1e6)}`, name, size: bytes, cat: catOf(name), from: msg.userId, nickname: msg.nickname, at: now, path })
          savedCount++
          record(dir, { action: '收下', name, size: bytes, from: msg.userId, nickname: msg.nickname, path })
          log(`收下《${name}》(${humanSize(bytes)}) → ${path}`)
        } catch (error) {
          record(dir, { action: '失败', name, size, from: msg.userId, reason: error.message })
          log(`《${name}》没收下：${error.message}`)
          if (cfg().autoReply) await api.reply(msg, `《${name}》没收下：${error.message}`)
        }
      }
      saveManifest(dir, prune(dir, before))
      if (cfg().autoReply && savedCount > 0) {
        const latest = loadManifest(dir)[0]
        await api.reply(msg, `收到啦～《${latest.name}》（${humanSize(latest.size)}）已放进我的收件箱，要用跟我说一声就行`)
      }
      return false // 不接管：占位消息照常交给她，她知道有文件来了
    })

    // ---- 隐私闸门：收件箱工具只在「主人私聊」里可用，群聊和别人的私聊一律不开 ----
    function chatAllowed(chat) {
      return chat?.kind === 'private' && ownerMatch({ userId: String(chat.userId || '') })
    }

    // ---- 给她的工具一：查收件箱 / 读文本类文件 ----
    api.tool(({ chat }) => {
      if (!chatAllowed(chat)) return [] // 群聊 / 别人私聊：工具不出现，更不会被套话
      return api.defineTool({
        name: 'inbox_files',
        description: '查我的收件箱：列出最近收到的文件（含类型与本机路径）。指定编号可「读」内容：文本读全文、zip 报清单、docx/pptx/xlsx 抽正文、音频转文字、图片/视频引导发回或给路径。',
        properties: {
          read: { type: 'number', description: '要读的文件编号（列表里的序号，从 1 开始）。不填就只列清单' },
        },
        required: [],
        execute: async ({ read }) => {
          const dir = api.dataDir('inbox')
          const list = loadManifest(dir)
          if (!list.length) return { ok: true, message: '收件箱空空的，还没收到过文件' }
          if (!read) {
            const lines = list.slice(0, 10).map((it, i) => `${i + 1}. [${it.cat || catOf(it.name)}]《${it.name}》 ${humanSize(it.size)}（${new Date(it.at).toLocaleString('zh-CN')} 收）${it.cat === '文本' ? '（可读内容）' : it.cat === '图片' || it.cat === '音频' || it.cat === '视频' ? '（可发回去）' : ''}\n   路径：${it.path}`)
            return { ok: true, message: `收件箱共 ${list.length} 份：\n${lines.join('\n')}` }
          }
          const it = list[Number(read) - 1]
          if (!it) return { ok: false, message: `没有第 ${read} 号文件` }
          const p = String(it.path || '')
          const cat = it.cat || catOf(it.name)
          if (!existsSync(p)) return { ok: false, message: `《${it.name}》的文件已经被清理了` }
          // 按类型把「内容」给她：文本读全文、zip 报清单、音频转文字；图片引导发回看；视频只收不看
          try {
            if (cat === '文本') {
              const buf = readFileSync(p)
              if (buf.length > 100 * 1024) return { ok: false, message: `《${it.name}》文本太大（${humanSize(buf.length)}），只给路径：${p}` }
              return { ok: true, message: `《${it.name}》内容：\n${buf.toString('utf8').slice(0, 40000)}` }
            }
            if (/\.zip$/i.test(p)) {
              return { ok: true, message: `《${it.name}》（${humanSize(it.size)}）里装着：\n${zipList(readFileSync(p))}` }
            }
            // 办公文件抽正文（pdf 除外：格式复杂，纯 JS 抽不可靠，如实说明）
            if (/\.docx$/i.test(p)) {
              const text = docxText(readFileSync(p))
              return { ok: true, message: `《${it.name}》正文：\n${text.slice(0, 30000)}` }
            }
            if (/\.pptx$/i.test(p)) {
              const text = pptxText(readFileSync(p))
              return { ok: true, message: `《${it.name}》各页文字：\n${text.slice(0, 30000)}` }
            }
            if (/\.xlsx$/i.test(p)) {
              const text = xlsxText(readFileSync(p))
              return { ok: true, message: `《${it.name}》表格内容：\n${text.slice(0, 30000)}` }
            }
            if (/\.pdf$/i.test(p)) {
              return { ok: true, message: `《${it.name}》是 PDF（${humanSize(it.size)}），PDF 文字提取做不到不丢字，本机路径 ${p}。要看内容请转成 docx/txt 再发一次，或用 inbox_send 发回聊天` }
            }
            if (cat === '音频') {
              const text = await transcribeAudio(p, api.core?.local, cfg)
              return { ok: true, message: `《${it.name}》里的声音说的是：\n${text.slice(0, 8000)}` }
            }
            if (cat === '图片') {
              return { ok: true, message: `《${it.name}》是一张图（${humanSize(it.size)}），路径 ${p}。想亲眼看看就用 inbox_send 把它发回聊天，发回来你就能看到了` }
            }
            if (cat === '视频') {
              return { ok: true, message: `《${it.name}》是视频（${humanSize(it.size)}），只收不看；本机路径 ${p}。要用它时用 inbox_send 发回去` }
            }
            return { ok: true, message: `《${it.name}》是${cat}文件（${humanSize(it.size)}），没法直接读内容；本机路径 ${p}，要用时用 inbox_send 发回去` }
          } catch (error) {
            return { ok: false, message: `读《${it.name}》失败：${error.message}` }
          }
        },
      })
    })

    // ---- 给她的工具二：把收件箱里的文件发回当前聊天（按类型选发法）----
    api.tool(({ chat }) => {
      if (!chatAllowed(chat)) return [] // 只在主人私聊里能发：绝不把主人的文件/消息带进群聊
      return api.defineTool({
        name: 'inbox_send',
        description: '把收件箱里的某个文件发回当前聊天：图片当图片发、音频当语音发、视频当视频发、压缩包/文档走文件发送。先 inbox_files 看编号。',
        properties: {
          no: { type: 'number', description: '文件编号（inbox_files 列表里的序号，从 1 开始）' },
        },
        required: ['no'],
        execute: async ({ no }) => {
          const it = loadManifest(api.dataDir('inbox'))[Number(no) - 1]
          if (!it) return { ok: false, message: `没有第 ${no} 号文件` }
          if (!existsSync(it.path)) return { ok: false, message: `《${it.name}》的文件已经被清理了` }
          const cat = it.cat || catOf(it.name)
          try {
            if (cat === '图片') {
              await api.sendSegments(chat.chatId, [{ type: 'image', data: { file: it.path } }], `[图片·${it.name}]`)
            } else if (cat === '音频') {
              await api.sendSegments(chat.chatId, [{ type: 'record', data: { file: it.path } }], `[语音·${it.name}]`, { throwOnError: true })
            } else if (cat === '视频') {
              await api.sendSegments(chat.chatId, [{ type: 'video', data: { file: it.path } }], `[视频·${it.name}]`)
            } else {
              // 压缩包 / 文档 / 其他：走私聊/群文件上传
              const params = chat.kind === 'group'
                ? { group_id: Number(chat.groupId), file: it.path, name: it.name }
                : { user_id: Number(chat.userId), file: it.path, name: it.name }
              await api.onebot(chat.kind === 'group' ? 'upload_group_file' : 'upload_private_file', params, { timeoutMs: 120000 })
            }
            return { ok: true, message: `把《${it.name}》（${cat}）发出去了` }
          } catch (error) {
            return { ok: false, message: `发《${it.name}》失败：${error.message}` }
          }
        },
      })
    })
    api.rule(() => '私聊有人发文件时会自动进收件箱（工具 inbox_files 可查，文本类能读内容，图片/音频/视频/压缩包用 inbox_send 发回去）；有人提到刚发的文件，就用 inbox_files 看看收件箱。')

    // ---- 面板小接口：清单 + 文件预览/下载（route 全路径精确匹配，query 不算路径）----
    api.route('/inbox', async () => {
      const dir = api.dataDir('inbox')
      const list = loadManifest(dir).slice(0, 50)
      let records = []
      try { records = readFileSync(join(dir, '接收记录.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-100).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } }) } catch {}
      return { ok: true, total: list.length, items: list, records: records.reverse() }
    })
    api.route('/inbox/file', async (req, res) => {
      const q = api.core.http.query(req)
      const it = loadManifest(api.dataDir('inbox')).find((x) => x.id === String(q.id || ''))
      if (!it || !existsSync(it.path)) return { ok: false, message: '没有这份文件（可能已被清理）' }
      const buf = readFileSync(it.path)
      const ext = String(it.name).split('.').pop().toLowerCase()
      const type = MIME['.' + ext] || 'application/octet-stream'
      if (q.download) res.setHeader?.('content-disposition', `attachment; filename="${safeName(it.name).replace(/[^\w.-]/g, '_')}"`)
      return api.core.http.send(res, 200, buf, type)
    })
  },
}
