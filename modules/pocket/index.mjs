// 口袋（pocket）：把她原有的对话流开放给自己的手机 app。
//
// app 消息 → 模拟主人私聊 → 她的原生对话流（记忆、心情、表情包、语音、模组全在）
// → 她的回复经 activity 事件捕获 → HTTP 推回 app。
// 记忆与 QQ 端共用同一套（同一条 chatlog 流水、同一份长期记忆）。
//
// 为什么自带一个 HTTP 服务：DSH 面板那个端口要登录态，手机连不上。
// 所以模组自己开一个局域网端口（默认 7788），同时托管 app 的界面和接口。
// 安全边界：接口全要配对密钥；消息只能注入主人私聊，不能发给别人、不能操作群。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, createWriteStream } from 'node:fs'
import { join, extname, normalize, sep } from 'node:path'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const RING_MAX = 500
const VERSION = '1.4.9'
const DEFAULT_PORT = 7788
const MAX_MEDIA_BYTES = 12 * 1024 * 1024

// 测试钩子
export const hooks = {}

// ---------- 手机宠物数值（app 端独立一份，不影响她的心情） ----------

const FOODS = {
  rice: { name: '白米饭', satiety: 22, mood: 7, intimacy: 2, line: '白米饭！冒尖的那种！' },
  fish: { name: '小鱼干', satiety: 14, mood: 4, intimacy: 1, line: '小鱼干也不错啦 勉强吃' },
  hotpot: { name: '火锅', satiety: 26, mood: 6, intimacy: 2, line: '火锅！辣的那种！' },
  milktea: { name: '奶茶', satiety: 9, mood: 5, intimacy: 1, line: '奶茶到了没 我要少冰' },
  cake: { name: '小蛋糕', satiety: 11, mood: 6, intimacy: 1, line: '甜的 我今天就想吃甜的' },
  ice: { name: '冰淇淋', satiety: 8, mood: 4, intimacy: 1, line: '大晚上吃这个 明天嗓子疼也认了' },
}

const PET_DEFAULT = { satiety: 62, mood: 78, intimacy: 8, fedTimes: 0, lastTick: 0, lastFeedAt: 0, lastPetAt: 0 }

// 基础色调：图标人物和界面一起换（app 端有同名配色，这里只存 key）
const TONES = ['ocean', 'sakura', 'mint', 'grape', 'sunset', 'moon', 'abyss', 'rose']

// ---------- 图片 / 语音的字节处理（app 收发媒体用） ----------

function sniffMime(buf) {
  const b = buf || Buffer.alloc(0)
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 6 && b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE') return 'audio/wav'
  if (b.length > 12 && b.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
  if (b.length > 12 && b.slice(0, 4).toString('latin1') === '\x1aE\xdf\xa3') return 'audio/webm'
  if (b.length > 2 && b[0] === 0x23 && b[1] === 0x21) return 'text/plain'
  return 'application/octet-stream'
}

/** app 发来的图：dataURL / 裸 base64 / base64:// 都收，解出 Buffer（超限或不是图返回 null） */
function decodeImage(img) {
  let s = String(img || '').trim()
  if (!s) return null
  const m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i)
  const b64 = m ? m[2] : s.startsWith('base64://') ? s.slice(9) : s
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64) || b64.replace(/\s/g, '').length < 64) return null
  let buf
  try { buf = Buffer.from(b64.replace(/\s/g, ''), 'base64') } catch { return null }
  if (!buf.length || buf.length > MAX_MEDIA_BYTES) return null
  const mime = sniffMime(buf)
  if (!mime.startsWith('image/')) return null
  return { buf, mime }
}

/** 发送钩子里的媒体段 → { buf, mime }：base64:// / file:// / 本地路径 / http 都试一遍 */
async function mediaBytesOf(data) {
  const d = data || {}
  const tries = [d.url, d.file, d.path].filter((x) => typeof x === 'string' && x.trim())
  for (const src of tries) {
    try {
      const s = src.trim()
      if (s.startsWith('base64://')) {
        const buf = Buffer.from(s.slice(9), 'base64')
        if (buf.length && buf.length <= MAX_MEDIA_BYTES) return { buf, mime: sniffMime(buf) }
        continue
      }
      const local = s.startsWith('file://') ? new URL(s).pathname.replace(/^\/([A-Za-z]:\/)/, '$1') : /^([A-Za-z]:[\\/]|\/)/.test(s) ? s : ''
      if (local && existsSync(local) && statSync(local).isFile()) {
        const buf = readFileSync(local)
        if (buf.length <= MAX_MEDIA_BYTES) return { buf, mime: sniffMime(buf) }
        continue
      }
      if (/^https?:\/\//i.test(s)) {
        const r = await fetch(s, { signal: AbortSignal.timeout(15000) })
        if (!r.ok) continue
        const ab = await r.arrayBuffer()
        if (ab.byteLength && ab.byteLength <= MAX_MEDIA_BYTES) return { buf: Buffer.from(ab), mime: r.headers.get('content-type')?.split(';')[0] || sniffMime(Buffer.from(ab)) }
      }
    } catch {}
  }
  return null
}

/** ffmpeg 把 webm/opus（浏览器 MediaRecorder）转 16k 单声道 wav，给 DSH 语音识别用 */
function toWav16k(inputBuf) {
  return new Promise((resolve, reject) => {
    const dir = join(tmpdir(), 'pocket-asr')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, `in-${Date.now()}-${randomBytes(3).toString('hex')}.bin`)
    const dst = join(dir, `out-${Date.now()}-${randomBytes(3).toString('hex')}.wav`)
    writeFileSync(src, inputBuf)
    const clean = () => { try { unlinkSync(src) } catch {} ; try { unlinkSync(dst) } catch {} }
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', dst], { windowsHide: true })
    let err = ''
    p.stderr?.on('data', (c) => { err += c })
    p.on('error', () => { clean(); reject(new Error('本机没有 ffmpeg（装一下：winget install Gyan.FFmpeg）')) })
    p.on('close', (code) => {
      try {
        if (code === 0 && existsSync(dst)) {
          const wav = readFileSync(dst)
          resolve(wav)
        } else {
          reject(new Error('录音转码失败 ' + (err || `exit ${code}`).slice(0, 120)))
        }
      } finally { clean() }
    })
  })
}

function readPet(dir) {
  try {
    const p = join(dir, 'pet.json')
    if (!existsSync(p)) return { ...PET_DEFAULT }
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return { ...PET_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...PET_DEFAULT }
  }
}

function writePet(dir, pet) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(pet, null, 2), 'utf8')
  } catch {}
}

/** 时间流逝：每小时掉饱食度，饿久了心情跟着掉。 */
function tickPet(dir, now = Date.now()) {
  const p = readPet(dir)
  const hours = Math.max(0, (now - (p.lastTick || now)) / 3_600_000)
  if (hours >= 0.05) {
    const satiety = Math.max(0, Math.min(100, p.satiety - hours * 3.2))
    const moodDrop = satiety < 20 ? hours * 2.2 : hours * 0.25
    const idleDays = Math.max(0, (now - (p.lastFeedAt || now)) / 86_400_000)
    p.satiety = Math.round(satiety * 10) / 10
    p.mood = Math.round(Math.max(0, Math.min(100, p.mood - moodDrop)))
    p.intimacy = Math.round(Math.max(0, p.intimacy - Math.max(0, idleDays - 2) * 0.4) * 10) / 10
    p.lastTick = now
    writePet(dir, p)
  }
  return p
}

const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))

// ---------- 自定义头像（用户从相册挑的那张） ----------

const MAX_AVATAR_BYTES = 6 * 1024 * 1024

function avatarFile(dir) {
  return join(dir, 'avatar.bin')
}

function readAvatar(dir) {
  try {
    const p = avatarFile(dir)
    if (!existsSync(p)) return null
    const buf = readFileSync(p)
    if (!buf.length) return null
    let mime = 'image/jpeg'
    const meta = join(dir, 'avatar.meta.json')
    if (existsSync(meta)) {
      try {
        mime = String(JSON.parse(readFileSync(meta, 'utf8')).mime || mime)
      } catch {}
    }
    return { buf, mime }
  } catch {
    return null
  }
}

function saveAvatar(dir, dataUrl) {
  const s = String(dataUrl || '').trim()
  const m = s.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([\s\S]+)$/i)
  let mime = ''
  let b64 = ''
  if (m) {
    mime = m[1].toLowerCase().replace('image/jpg', 'image/jpeg')
    b64 = m[2]
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 64) {
    mime = 'image/jpeg' // 只给 base64 也行，按 jpeg 存
    b64 = s
  } else {
    return { ok: false, message: '这张读不出来，换一张试试' }
  }
  let buf
  try {
    buf = Buffer.from(b64.replace(/\s/g, ''), 'base64')
  } catch {
    return { ok: false, message: '这张读不出来，换一张试试' }
  }
  if (!buf.length) return { ok: false, message: '图是空的' }
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, message: '图太大了（压到 6MB 以内）' }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(avatarFile(dir), buf)
    writeFileSync(join(dir, 'avatar.meta.json'), JSON.stringify({ mime, at: Date.now(), size: buf.length }, null, 2), 'utf8')
    return { ok: true, size: buf.length, mime }
  } catch (e) {
    return { ok: false, message: '存不下来：' + (e?.message || e) }
  }
}

function clearAvatar(dir) {
  try {
    unlinkSync(avatarFile(dir))
  } catch {}
  try {
    unlinkSync(join(dir, 'avatar.meta.json'))
  } catch {}
  return { ok: true }
}

/** 读 mood 模组当下的心情（0-100）；模组不在跑就返回 null */
function moodNow(host) {
  try {
    const raw = host?.use?.('mood')?.state?.()
    if (typeof raw === 'number') return pct(raw)
    const v = Number(raw?.value ?? raw?.mood)
    return Number.isFinite(v) ? pct(v) : null
  } catch {
    return null
  }
}

/**
 * 小窝的状态栏。
 * 装了 aurabot「喂食」模组就用它的真实数值（饱食 = 100-饥饿、亲密度 = 好感度），
 * 这样 app 里看到的就是面板上那份，喂食/饿肚子两边同步；没装才退回 pocket 自己那套。
 */
function petState(dir, host) {
  const d = new Date()
  const sleepy = d.getHours() >= 23 || d.getHours() < 6
  const foods = Object.entries(FOODS).map(([id, f]) => ({ id, name: f.name }))
  const f = host?.use?.('feed')
  if (f && typeof f.hunger === 'function') {
    let hunger = 0
    let aff = 0
    let fed = 0
    try {
      hunger = Number(f.hunger()) || 0
      const s = f.state?.() || {}
      aff = Number(s.affection) || 0
      const today = new Date().toDateString()
      fed = (Array.isArray(s.log) ? s.log : []).filter((r) => r.source === '投喂' && new Date(r.at).toDateString() === today).length
    } catch {}
    return {
      satiety: pct(100 - hunger),
      mood: moodNow(host) ?? pct(100 - hunger),
      intimacy: pct(aff),
      fedTimes: fed,
      hungry: hunger >= 70,
      sleepy,
      foods,
      from: 'feed', // app 可以据此提示「和 aurabot 面板同步」
    }
  }
  const p = tickPet(dir)
  return {
    satiety: pct(p.satiety),
    mood: moodNow(host) ?? pct(p.mood),
    intimacy: pct(p.intimacy),
    fedTimes: p.fedTimes || 0,
    hungry: p.satiety < 30,
    sleepy,
    foods,
    from: 'local',
  }
}

function petInteract(dir, action, foodId, host) {
  const p = tickPet(dir)
  const now = Date.now()
  const feed = host?.use?.('feed')
  const mood = host?.use?.('mood')

  if (action === 'feed') {
    const food = FOODS[foodId] || FOODS.rice
    if (now - (p.lastFeedAt || 0) < 20_000) return { ok: false, refused: true, reply: '刚吃过 你养小猪呢' }
    // 有喂食模组就用它的：它会同时算饥饿曲线、记饭点、掉心情、写记忆、加好感
    if (feed && typeof feed.feed === 'function') {
      let r = null
      try {
        r = feed.feed({ food: food.name, portion: '一份', source: '投喂' })
      } catch (e) {
        r = { ok: false, error: e?.message || String(e) }
      }
      if (!r || r.ok === false) return { ok: false, refused: true, reply: String(r?.error || '现在吃不下') }
      p.lastFeedAt = now
      p.lastTick = now
      writePet(dir, p)
      return { ok: true, reply: food.line, event: `主人喂了我${food.name}`, from: 'feed', satiety: r.satiety }
    }
    if (p.satiety >= 96) return { ok: false, refused: true, reply: '吃不下了 真的 再喂要撑死了' }
    p.satiety = Math.min(100, p.satiety + food.satiety)
    p.mood = Math.min(100, p.mood + food.mood)
    p.intimacy = Math.min(100, (p.intimacy || 0) + food.intimacy)
    p.fedTimes = (p.fedTimes || 0) + 1
    p.lastFeedAt = now
    p.lastTick = now
    writePet(dir, p)
    return { ok: true, reply: food.line, event: `主人喂了我${food.name}`, from: 'local' }
  }

  if (action === 'pet') {
    if (now - (p.lastPetAt || 0) < 8_000) return { ok: false, refused: true, reply: '摸够了没啊' }
    // 心情推到 mood 模组，aurabot 面板上的心情曲线也跟着动
    try {
      mood?.nudge?.(3, '主人摸了摸我的头')
    } catch {}
    p.mood = Math.min(100, p.mood + 3)
    p.intimacy = Math.min(100, (p.intimacy || 0) + 0.4)
    p.lastPetAt = now
    p.lastTick = now
    writePet(dir, p)
    return { ok: true, reply: (moodNow(host) ?? p.mood) > 70 ? '嗯…再摸一下' : '别摸头 头发乱了', event: '主人摸了摸我的头' }
  }

  if (action === 'play') {
    try {
      mood?.nudge?.(5, '主人陪我玩了一会儿')
    } catch {}
    p.mood = Math.min(100, p.mood + 5)
    p.satiety = Math.max(0, p.satiety - 4)
    p.intimacy = Math.min(100, (p.intimacy || 0) + 0.8)
    p.lastTick = now
    writePet(dir, p)
    return { ok: true, reply: '玩一会儿嘛 我尾巴都甩起来了', event: '主人陪我玩了一会儿' }
  }

  return { ok: false, reply: '？' }
}

// ---------- 私网地址收集（配对用） ----------

// 虚拟网卡（VPN 客户端、Docker、VM 那类）拿到的地址手机根本连不上，
// 混进列表里只会让人一条条白试。Tailscale 例外：它就是拿来打洞的。
const VIRTUAL_NIC = /(docker|vethernet|vmware|virtualbox|hyper-?v|\bwsl\b|wintun|clash|mihomo|meta|zerotier|radmin|hamachi|npcap|bluetooth|蓝牙|loopback|vpn)/i
const nicUsable = (name) => /tailscale/i.test(String(name || '')) || !VIRTUAL_NIC.test(String(name || ''))

function lanAddresses() {
  const out = []
  const v6 = []
  try {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (!nicUsable(name)) continue
      for (const ni of list || []) {
        if (ni.internal) continue
        if (ni.family === 'IPv4') {
          // 内网段 + Tailscale 网段（100.64.0.0/10）
          if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) out.push(ni.address)
          else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ni.address)) out.push(ni.address)
        } else if (ni.family === 'IPv6') {
          const a = String(ni.address).split('%')[0]
          // 只收公网可路由的（2xxx / 3xxx 段）：fe80 是链路本地、fc/fd 是内网，都没法从外面连
          if (/^[23][0-9a-f]{3}:/i.test(a)) v6.push(a)
        }
      }
    }
  } catch {}
  // 局域网 IPv4 排前面（在家扫码配对最稳），公网 IPv6 跟在后面供出外网使用
  return [...new Set([...out, ...v6.map((a) => `[${a}]`)])]
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// ---------- 主逻辑 ----------

export default {
  id: 'pocket',
  name: '口袋aurabot',
  version: VERSION,
  api: 1,
  description: '把她的对话流接进手机 app：app 消息走她原生流程（记忆、心情、表情包、语音、模组全在），回复与主动搭话实时推回手机；记忆与 QQ 端共用一套。',
  category: 'platform',
  tags: ['手机', '同步', '接口'],
  author: 'Ariz0324',
  license: 'MIT',
  minPluginVersion: '1.2.0',
  requires: [],
  capabilities: ['filesystem', 'plugin-config', 'plugin-internals', 'network', 'process'],
  defaults: { enabled: false, token: '', port: DEFAULT_PORT, tone: 'ocean', tunnelAuto: false, tunnelToken: '', tunnelHost: '' },
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用手机接口', type: 'switch', hint: '关掉后 app 连不上（QQ 端不受影响）' },
    { key: 'port', label: '服务端口', type: 'number', hint: `手机连的端口，默认 ${DEFAULT_PORT}；改了要重启插件` },
    { key: 'token', label: '配对密钥', type: 'string', hint: '留空自动生成；换掉之后所有设备要重新配对' },
    { key: 'tone', label: '图标色调', type: 'string', hint: '手机端配色：ocean/sakura/mint/grape/sunset/moon/abyss/rose' },
    { key: 'tunnelToken', label: '固定隧道 Token（可选）', type: 'string', hint: 'Cloudflare Zero Trust 里创建隧道后复制的 token；填了就走固定域名，地址不再每次都变' },
    { key: 'tunnelHost', label: '固定隧道域名（可选）', type: 'string', hint: '隧道里配的 Public Hostname，如 pocket.example.com（不要写 https://）' },
  ],

  setup(api) {
    const dir = api.dataDir()
    // 界面放在 assets/app（市场规范只允许 lib/test/assets/docs 四个子目录）
    const base = api.dir || dir
    const appDir = existsSync(join(base, 'assets', 'app', 'index.html')) ? join(base, 'assets', 'app') : join(base, 'app')
    // 启动流水账：服务没起来时，「面板说不清为什么」的部分在这里能查到（只留最后 40 行左右）
    const bootLogFile = join(dir, 'boot.log')
    const bootLog = (msg) => {
      try {
        if (existsSync(bootLogFile) && statSync(bootLogFile).size > 32 * 1024) writeFileSync(bootLogFile, '')
        appendFileSync(bootLogFile, `${new Date().toISOString()} ${msg}\n`)
      } catch {}
    }
    const bootTail = (n = 8) => {
      try {
        return readFileSync(bootLogFile, 'utf8').trim().split('\n').slice(-n)
      } catch {
        return []
      }
    }
    bootLog(`模块加载 v${VERSION}｜dir=${base}｜app=${appDir}`)

    // ---- 「代码换了但没被重载」的检测 ----
    // DSH 对服务类模块的热重载不总生效：磁盘上的文件已经变了，内存里跑的还是旧那份，
    // 表现就是「改完没反应」「手动重启服务也没用」。这里用「本文件的 mtime 是否晚于本次 setup」
    // 判断，面板据此直接叫用户重启，而不是让人对着旧界面猜。
    const loadedAt = Date.now()
    const selfFile = (() => {
      try {
        return fileURLToPath(import.meta.url)
      } catch {
        return join(base, 'index.mjs')
      }
    })()
    const staleInfo = () => {
      const out = { stale: false, running: VERSION, disk: VERSION, changedAt: 0 }
      try {
        const st = statSync(selfFile)
        out.changedAt = Math.round(st.mtimeMs)
        // +2s 容忍：热重载扫描和 setup 之间本来就有几百毫秒差
        if (st.mtimeMs > loadedAt + 2000) out.stale = true
      } catch {}
      try {
        const j = JSON.parse(readFileSync(join(base, 'module.json'), 'utf8'))
        if (j && j.version) out.disk = String(j.version)
        if (out.disk !== VERSION) out.stale = true
      } catch {}
      return out
    }
    const cfg = () => api.config()
    const s = () => api.settings()
    const on = () => s().enabled === true // 默认关，面板里手动开
    const port = () => Number(s().port) || DEFAULT_PORT
    const tone = () => {
      const t = String(s().tone || '')
      return TONES.includes(t) ? t : 'ocean'
    }

    // ---- 密钥 ----
    const tokenOf = () => {
      const t = String(s().token || '').trim()
      if (t) return t
      const gen = 'pk_' + randomBytes(12).toString('base64url')
      try {
        api.saveSettings({ token: gen })
      } catch {}
      return gen
    }

    // ---- 事件环（app 轮询拿消息） ----
    let seq = 0
    const ring = []
    const pushEvent = (type, data) => {
      ring.push({ seq: ++seq, at: Date.now(), type, ...data })
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
      return seq
    }

    const ownerQQ = () => String(cfg().ownerQQ || '')
    const ownerChat = () => `private:${ownerQQ()}`

    // 她发出去的话（含主动搭话）→ 推给 app
    api.on('activity', (a) => {
      if (a?.kind !== 'out') return
      if (String(a.chatId || '') !== ownerChat()) return
      pushEvent('her', { text: String(a.reply || '') })
    })
    api.on('onebot/state', (st) => pushEvent('qq-state', { state: String(st || '') }))

    // 她发出去的图片 / 表情包 / 语音条 → 抓原始段转 base64 推给 app
    // （文字仍走上面的 activity 事件；这里只补媒体。干跑/总开关关着时按没发算。）
    api.on('send', async (message, info) => {
      if (!on()) return
      const c = cfg()
      if (c.dryRun) return
      if (String(info?.chatId || '') !== ownerChat()) return
      const list = Array.isArray(message) ? message : []
      for (const seg of list) {
        const t = seg?.type
        if (t === 'image' || t === 'mface') {
          const m = await mediaBytesOf(seg?.data)
          if (m && m.mime.startsWith('image/')) {
            pushEvent('her-media', { kind: 'image', mime: m.mime, data: m.buf.toString('base64'), text: String(seg?.data?.summary || '') })
          }
        } else if (t === 'record') {
          const m = await mediaBytesOf(seg?.data)
          if (m) pushEvent('her-media', { kind: 'voice', mime: m.mime.startsWith('audio/') ? m.mime : 'audio/wav', data: m.buf.toString('base64') })
        }
      }
      return undefined // 只观察，不改写
    })

    // ---- 注入一条主人私聊消息（可带一张图，app 端已压缩成 base64） ----
    function inject(text, image) {
      const clean = String(text || '').trim().slice(0, 4000)
      const img = decodeImage(image)
      if (!clean && !img) return { ok: false, message: '要说点什么（或发张图）' }
      const segs = []
      if (img) segs.push({ type: 'image', data: { file: 'base64://' + img.buf.toString('base64') } })
      if (clean) segs.push({ type: 'text', data: { text: clean } })
      const hub = api.core?.hub
      const ev = {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(cfg().botQQ) || 0,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        user_id: Number(ownerQQ()) || 0,
        message_id: 'pocket-' + Date.now() + '-' + randomBytes(2).toString('hex'),
        raw_message: (img ? '[图片]' : '') + clean,
        message: segs,
        sender: { user_id: Number(ownerQQ()) || 0, nickname: String(cfg().ownerName || '主人') },
      }
      const shown = (img ? '[图片]' : '') + (clean && img ? ' ' + clean : clean)
      const my = pushEvent('me', { text: shown })
      if (hub && typeof hub.onMessage === 'function') {
        Promise.resolve(hub.onMessage(ev)).catch((e) => api.log.warn('注入消息出错：', e?.message || e))
        return { ok: true, via: 'hub', seq: my }
      }
      // 兜底：hub 拿不到时直接让她想（带人格和记忆），回复走 activity 照样推给 app
      const said = img ? `${clean ? clean + '（还发了一张图）' : '（发来一张图，纯图片没有字）'}` : clean
      api.think(`${said}\n（这句话来自主人的手机 app，回给他，但不要在 QQ 上发）`).catch((e) => api.log.warn('think 出错：', e?.message || e))
      return { ok: true, via: 'think', seq: my }
    }

    // ---- 主人发语音条：录音转 16k wav → DSH 自带识别 → 按 QQ 端同样的「[语音] 文字」注入 ----
    async function voiceNote(audio) {
      let buf = null
      try {
        const s = String(audio || '').trim()
        const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s.startsWith('base64://') ? s.slice(9) : s
        if (b64 && /^[A-Za-z0-9+/=\s]+$/.test(b64)) buf = Buffer.from(b64.replace(/\s/g, ''), 'base64')
      } catch {}
      if (!buf || !buf.length) return { ok: false, message: '没收到录音' }
      if (buf.length > MAX_MEDIA_BYTES) return { ok: false, message: '录音太大了' }
      // 识别回退链：DSH 语音输入（SenseVoice）→ voicecall 配的识别服务（本地 faster-whisper / OpenAI 兼容）
      let text = ''
      const stt = api.dsh?.get?.('speechToText')
      if (stt && typeof stt.resolve === 'function' && typeof stt.transcribe === 'function') {
        try {
          const wav = await toWav16k(buf)
          const spec = stt.resolve({ audio: new Uint8Array(wav) })
          const r = await stt.transcribe(spec, AbortSignal.timeout(120000))
          text = String(typeof r === 'string' ? r : r?.text || r?.transcript || '').trim()
        } catch (e) {
          api.log.debug('DSH 语音识别失败，试 voicecall 的：', e?.message || e)
        }
      }
      if (!text) {
        try {
          const prov = await import(pathToFileURL(join(api.dir, '..', 'voicecall', 'lib', 'providers.mjs')).href)
          const vcSettings = (api.config().ext || {}).voicecall || {}
          const ac = prov.asrConfig(vcSettings)
          const probe = await prov.probeStt(ac)
          if (!probe.ready) return { ok: false, message: '识别服务没就绪：' + probe.why + '（也可以在 DSH 面板开启「语音输入」）' }
          const wav = await toWav16k(buf)
          const r = await prov.transcribe(ac, wav)
          text = String(r?.text || '').trim()
        } catch (e) {
          return { ok: false, message: '没听清：' + (e?.message || e) }
        }
      }
      if (!text) return { ok: false, message: '识别出来是空的（说话太短？）' }
      pushEvent('me', { text: `[语音] ${text}` })
      const hub = api.core?.hub
      if (hub && typeof hub.onMessage === 'function') {
        const ev = {
          time: Math.floor(Date.now() / 1000),
          self_id: Number(cfg().botQQ) || 0,
          post_type: 'message',
          message_type: 'private',
          sub_type: 'friend',
          user_id: Number(ownerQQ()) || 0,
          message_id: 'pocket-voice-' + Date.now(),
          raw_message: `[语音] ${text}`,
          message: [{ type: 'text', data: { text: `[语音] ${text}` } }],
          sender: { user_id: Number(ownerQQ()) || 0, nickname: String(cfg().ownerName || '主人') },
        }
        Promise.resolve(hub.onMessage(ev)).catch((e) => api.log.warn('注入语音出错：', e?.message || e))
        return { ok: true, text }
      }
      api.think(`[主人发来一条语音，说的是] ${text}\n（这句话来自主人的手机 app，回给他，但不要在 QQ 上发）`).catch(() => {})
      return { ok: true, text }
    }

    // ---- 聊天历史（她自己的 chatlog） ----
    function chatlogDir() {
      // modules-data/pocket → plugins-data/aurabot/chatlog
      return join(dir, '..', '..', 'chatlog')
    }
    function readHistory(days = 3, limit = 300) {
      const d = chatlogDir()
      const out = []
      try {
        const files = readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort()
        for (const f of files.slice(-Math.max(1, Math.min(15, days)))) {
          try {
            for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
              if (!line.trim()) continue
              try {
                const o = JSON.parse(line)
                if (String(o.chatId || '') !== ownerChat()) continue
                out.push({ at: o.t, who: o.who === 'bot' ? 'her' : 'me', text: String(o.text || '') })
              } catch {}
            }
          } catch {}
        }
      } catch {}
      return out.slice(-Math.max(10, Math.min(1000, limit)))
    }

    // ---- 统一的操作层：面板接口和手机服务都调这里 ----
    const ops = {
      health: () => ({
        // 只给探活需要的最小信息：人格名/主人名等不算敏感但也没必要出现在免鉴权接口里
        ok: true,
        app: 'pocket',
        version: VERSION,
        tone: tone(),
      }),
      state: () => {
        const m = api.use('mood')
        const raw = m?.state?.() || null
        const ms = raw && typeof raw === 'object' ? raw : null
        const mv = typeof raw === 'number' ? raw : null
        return {
          ok: true,
          persona: String(cfg().persona?.current || ''),
          owner: String(cfg().ownerName || '主人'),
          qqOnline: api.core?.onebot?.state === 'connected',
          tone: tone(),
          tones: TONES,
          // mood.state() = { value, label, at, reason, history }
          mood: mv != null ? mv : ms ? Number(ms.value ?? ms.mood ?? 0) : null,
          moodLabel: String((ms?.label) || (m?.label ? m.label() : '')),
          memoryCount: api.use('memory')?.list?.()?.length ?? null,
          pet: petState(dir, api),
        }
      },
      events: (after) => ({ ok: true, seq, list: ring.filter((e) => e.seq > Number(after || 0)).slice(0, 200) }),
      history: (days) => ({ ok: true, list: readHistory(days) }),
      message: (text, image) => inject(text, image),
      voiceNote: (audio) => voiceNote(audio),
      pet: (action, food) => {
        const r = petInteract(dir, String(action || ''), String(food || 'rice'), api)
        if (r.ok && r.event) {
          try {
            api.use('memory')?.addEvent?.({ text: r.event, source: 'event' })
          } catch {}
        }
        return { ...r, state: petState(dir, api) }
      },
      moments: async () => {
        let list = []
        try {
          const h = await api.use('diary')?.history?.()
          if (Array.isArray(h)) list = h.map((x) => ({ at: x.at, text: String(x.text || ''), visibility: x.visibility || '' }))
        } catch {}
        // 心情曲线也一起给（近 24 次变化）
        let mood = []
        try {
          const ms = api.use('mood')?.state?.()
          if (ms && Array.isArray(ms.history)) {
            mood = ms.history
              .slice(0, 24)
              .map((x) => ({ at: x.at, value: Number(x.to ?? x.value ?? x.mood) }))
              .filter((x) => Number.isFinite(x.value))
              .reverse()
          }
          if (mood.length === 0 && ms && Number.isFinite(Number(ms.value))) mood = [{ at: ms.at || Date.now(), value: Number(ms.value) }]
        } catch {}
        list.sort((a, b) => b.at - a.at)
        return { ok: true, list: list.slice(0, 50), mood }
      },
      skin: () => {
        const persona = String(cfg().persona?.current || 'default')
        const custom = join(dir, 'skins', persona + '.json')
        if (existsSync(custom)) {
          try {
            return { ok: true, skin: JSON.parse(readFileSync(custom, 'utf8')), builtin: false, tone: tone() }
          } catch {}
        }
        return { ok: true, skin: defaultSkin(persona), builtin: true, tone: tone() }
      },
      /** 换她的形象（用户从相册挑的图） */
      setAvatar: (image) => saveAvatar(dir, image),
      clearAvatar: () => clearAvatar(dir),
      avatarInfo: () => {
        const a = readAvatar(dir)
        return { ok: true, custom: Boolean(a), size: a ? a.buf.length : 0, mime: a ? a.mime : null }
      },
      setTone: (t) => {
        const clean = String(t || '').trim()
        if (!TONES.includes(clean)) return { ok: false, message: '没有这个色调' }
        try {
          api.saveSettings({ tone: clean })
        } catch {}
        return { ok: true, tone: clean }
      },
      /** 语音：走她 voice 模组的 speak()，返回文件路径 */
      voice: async (text) => {
        const clean = String(text || '').trim().slice(0, 300)
        if (!clean) return { ok: false, message: '缺文字' }
        const voice = api.use('voice')
        if (!voice?.speak) return { ok: false, message: '语音模组没在跑' }
        try {
          const r = await voice.speak(clean)
          const file = r?.file
          if (file && existsSync(file)) return { ok: true, file }
          return { ok: false, message: '语音没生成出来' }
        } catch (e) {
          return { ok: false, message: '语音出错：' + (e?.message || e) }
        }
      },
    }

    // ---- 面板侧接口（走 DSH 面板端口，自己在面板里用） ----
    const urlOf = (req) => {
      try {
        return new URL(req.url || '/', 'http://local')
      } catch {
        return new URL('/', 'http://local')
      }
    }
    function deny(res, code, message) {
      try {
        api.core.http.send(res, code, JSON.stringify({ ok: false, message }), 'application/json')
      } catch {}
      return undefined
    }
    // 密钥比较用常量时间：两边先哈希到定长，防时序侧信道
    function safeEqual(given, want) {
      try {
        const h = (v) => createHash('sha256').update(String(v)).digest()
        return !!want && timingSafeEqual(h(given), h(want))
      } catch {
        return false
      }
    }
    // 密钥失败限流：同一来源 60 秒内错 10 次，接下来直接 429
    const FAIL_WIN = 60_000
    const FAIL_MAX = 10
    const fails = new Map()
    const failKeyOf = (req) => String(req.socket?.remoteAddress || '?')
    function rateLimited(req) {
      const now = Date.now()
      const k = failKeyOf(req)
      const arr = (fails.get(k) || []).filter((t) => now - t < FAIL_WIN)
      fails.set(k, arr)
      return arr.length >= FAIL_MAX
    }
    function noteFail(req) {
      const k = failKeyOf(req)
      const arr = fails.get(k) || []
      arr.push(Date.now())
      fails.set(k, arr)
    }
    const clearFails = (req) => fails.delete(failKeyOf(req))
    function guard(req, res) {
      if (!on()) {
        deny(res, 403, '手机接口关着')
        return false
      }
      const want = tokenOf()
      const given = String(req.headers?.['x-phone-token'] || urlOf(req).searchParams.get('token') || '')
      if (!want || !safeEqual(given, want)) {
        noteFail(req)
        deny(res, 401, '密钥不对')
        return false
      }
      clearFails(req)
      return true
    }
    async function bodyOf(req) {
      const ct = String(req.headers?.['content-type'] || '')
      if (!/application\/json/i.test(ct)) throw new Error('content-type 必须是 application/json')
      try {
        const b = await api.core.http.body(req)
        return b && typeof b === 'object' ? b : {}
      } catch {
        return {}
      }
    }

    // ---- 外网隧道（cloudflared quick tunnel：手机在外面没 IPv6 也能连，https 直达） ----
    // cloudflared 是独立进程，模组热重载/重启不影响它；pid 存 tunnel.json，面板随时能停。
    const tunnelFile = () => join(api.dataDir(), 'tunnel.json')
    let tunnelProc = null
    let tunnelUrl = ''
    let tunnelErr = ''
    let cfPathCache = { path: '', at: 0 }

    function readTunnelFile() {
      try {
        const j = JSON.parse(readFileSync(tunnelFile(), 'utf8'))
        return j && typeof j === 'object' ? j : {}
      } catch {
        return {}
      }
    }

    function pidAlive(pid) {
      const n = Number(pid)
      if (!n || n === process.pid) return false
      try {
        process.kill(n, 0)
        return true
      } catch {
        return false
      }
    }

    function findCloudflared() {
      if (cfPathCache.path && Date.now() - cfPathCache.at < 60000) return cfPathCache.path
      let found = ''
      const custom = String((api.config().ext || {}).pocket?.cloudflaredPath || '').trim()
      if (custom && existsSync(custom)) found = custom
      if (!found) {
        try {
          // where.exe 很快，且结果缓存 60 秒
          const out = execFileSync('where.exe', ['cloudflared'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
          const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
          if (first && existsSync(first)) found = first
        } catch {}
      }
      if (!found) {
        for (const p of [join(homedir(), 'auratools', 'bin', 'cloudflared.exe'), join(homedir(), '.cloudflared', 'cloudflared.exe'), 'C:\\cloudflared\\cloudflared.exe']) {
          if (existsSync(p)) { found = p; break }
        }
      }
      cfPathCache = { path: found, at: Date.now() }
      return found
    }

    // ---- 固定域名隧道（Cloudflare named tunnel）----
    // 临时隧道（trycloudflare.com）每次重启都换域名，手机里存的那条就失效了 —— 这是
    // 「昨天还能连、今天连不上」最常见的原因。填了 token + 域名就走 named tunnel，地址恒定。
    const namedToken = () => String(s().tunnelToken || '').trim()
    const namedHost = () =>
      String(s().tunnelHost || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/：/g, ':')
        .replace(/\/+$/, '')
        .replace(/\s+/g, '')
        .toLowerCase()

    function tunnelInfo() {
      const saved = readTunnelFile()
      const alive = cfRunning()
      const tok = namedToken()
      const host = namedHost()
      const mode = tok ? 'named' : 'quick'
      let url = ''
      if (mode === 'named') {
        // 固定域名：地址就是配好的域名，不用从日志里捞
        url = host ? `https://${host}` : ''
      } else {
        // 地址来源优先级：本进程抓到的 → pid 存活时存盘的 → 外部启动时写进日志的
        url = tunnelUrl || ''
        if (!url && saved.pid && pidAlive(saved.pid)) url = String(saved.url || '')
        if (!url && alive) url = urlFromLog()
        if (url) tunnelUrl = url
      }
      // named 模式必须确认「现在跑的就是 named 那条」，否则会把上一条 quick 的遗留进程当成自己的
      const running =
        mode === 'named'
          ? !!tunnelProc || (alive && saved.mode === 'named' && saved.url === url)
          : !!tunnelProc || (alive && !!url)
      return {
        ok: true,
        installed: !!findCloudflared(),
        running,
        // named 模式的地址由配置决定，跟是否在跑无关 —— 未启动时也给出来，面板才好显示「将使用哪个域名」
        url: mode === 'named' ? url : running ? url : '',
        error: tunnelErr,
        pid: tunnelProc?.pid || saved.pid || 0,
        auto: s().tunnelAuto === true,
        mode,
        host,
        tokenSet: !!tok,
      }
    }

    // cloudflared 是不是在跑（不管是谁拉起来的：模组、面板按钮、还是用户自己开的）
    function cfRunning() {
      try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
        })
        return /cloudflared\.exe/i.test(String(out))
      } catch {
        return false
      }
    }

    // 外部启动的隧道把地址打在 tunnel.log 里，退而求其次从日志尾部捞一次
    function urlFromLog() {
      try {
        const s = readFileSync(join(api.dataDir(), 'tunnel.log'), 'utf8')
        const all = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi) || []
        return all.length ? all[all.length - 1] : ''
      } catch {
        return ''
      }
    }

    async function tunnelStart() {
      const cur = tunnelInfo()
      if (cur.running) return { ok: true, url: cur.url, message: '隧道已经在跑' }
      const exe = findCloudflared()
      if (!exe) {
        return {
          ok: false,
          installed: false,
          message: '没找到 cloudflared：去 https://github.com/cloudflare/cloudflared/releases/latest 下载 cloudflared-windows-amd64.exe，随便放个位置（比如 C:\\Users\\你\\auratools\\bin\\），然后在面板设置里把路径填进「cloudflaredPath」；或直接放进 PATH。',
        }
      }
      const tok = namedToken()
      const host = namedHost()
      if (tok && !host) {
        return {
          ok: false,
          message: `填了固定隧道 token，但没填域名：到 Cloudflare 该隧道里加一条 Public Hostname（域名 → http://localhost:${port()}），再把那个域名填进「固定隧道域名」。`,
        }
      }
      tunnelUrl = ''
      tunnelErr = ''
      if (tok) return await startNamed(exe, tok, host)
      // detached + unref：DSH 退出/模组热重载都不带走隧道，重开面板照样能认出来
      const p = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${port()}`, '--no-autoupdate'], {
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      try {
        p.unref()
        p.stdout?.unref?.()
        p.stderr?.unref?.()
      } catch {}
      tunnelProc = p
      const grab = (buf) => {
        const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
        if (m && !tunnelUrl) {
          tunnelUrl = m[0]
          try {
            writeFileSync(tunnelFile(), JSON.stringify({ url: tunnelUrl, pid: p.pid, at: Date.now() }))
          } catch {}
        }
      }
      p.stderr?.on('data', grab)
      p.stdout?.on('data', grab)
      p.on('exit', (code) => {
        if (tunnelProc === p) {
          tunnelProc = null
          tunnelErr = code ? `隧道进程退出了（code ${code}）` : ''
        }
      })
      p.on('error', (e) => {
        if (tunnelProc === p) {
          tunnelProc = null
          tunnelErr = '启动失败：' + (e?.message || e)
        }
      })
      for (let i = 0; i < 30 && !tunnelUrl && tunnelProc === p; i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (tunnelUrl) return { ok: true, url: tunnelUrl }
      if (tunnelProc) return { ok: true, url: '', message: '隧道在连了，地址一会儿就好，稍后刷新面板' }
      return { ok: false, message: tunnelErr || '隧道没能起来' }
    }

    /**
     * 固定域名隧道：token 走环境变量（不出现在命令行，任务管理器里看不到），
     * 就绪判断不用日志（detached 后管道不可靠），而是直接拿公网域名探 /api/health ——
     * 顺带验证了 DNS 已生效、CF 的 Public Hostname 指向了本机端口。
     */
    async function startNamed(exe, tok, host) {
      const target = `https://${host}`
      let out = null
      try {
        out = createWriteStream(join(api.dataDir(), 'tunnel.log'), { flags: 'a' })
      } catch {}
      const p = spawn(exe, ['tunnel', 'run', '--no-autoupdate'], {
        windowsHide: true,
        detached: true,
        stdio: ['ignore', out || 'ignore', out || 'ignore'],
        env: { ...process.env, TUNNEL_TOKEN: tok },
      })
      try {
        p.unref()
      } catch {}
      tunnelProc = p
      tunnelUrl = target
      p.on('exit', (code) => {
        if (tunnelProc === p) {
          tunnelProc = null
          tunnelErr = code ? `隧道进程退出了（code ${code}）` : ''
        }
      })
      p.on('error', (e) => {
        if (tunnelProc === p) {
          tunnelProc = null
          tunnelErr = '启动失败：' + (e?.message || e)
        }
      })
      try {
        writeFileSync(tunnelFile(), JSON.stringify({ url: target, pid: p.pid, at: Date.now(), mode: 'named' }))
      } catch {}
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2500))
        if (tunnelProc !== p) return { ok: false, mode: 'named', message: tunnelErr || '隧道进程退出了，详情看面板上的报错或 tunnel.log' }
        try {
          const r = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(5000) })
          if (r.ok) return { ok: true, mode: 'named', url: target, message: '固定域名隧道已连通：' + target }
        } catch {}
      }
      return {
        ok: true,
        mode: 'named',
        url: target,
        message:
          `隧道进程起来了，但 30 秒内没能从公网访问到 ${target}。两种常见原因：① 域名刚绑，解析还没生效（等 1–2 分钟再试）；② Cloudflare 里那条 Public Hostname 的 Service 没填 http://localhost:${port()}。`,
      }
    }

    function tunnelStop() {
      const saved = readTunnelFile()
      const targets = new Set([tunnelProc?.pid].filter(Boolean))
      if (saved.pid && pidAlive(saved.pid)) targets.add(saved.pid)
      tunnelProc = null
      tunnelUrl = ''
      tunnelErr = ''
      let killed = 0
      for (const pid of targets) {
        try {
          process.kill(Number(pid))
          killed++
        } catch {}
      }
      // 外部（或历史遗留）拉起的隧道没有可靠 pid，按镜像名收掉；这个 exe 只为本模组服务
      if (!killed && cfRunning()) {
        try {
          execFileSync('taskkill', ['/IM', 'cloudflared.exe', '/F'], { windowsHide: true, timeout: 8000 })
          killed++
        } catch {}
      }
      try {
        unlinkSync(tunnelFile())
      } catch {}
      return { ok: true, message: killed ? '隧道已停' : '本来就没在跑' }
    }

    api.route('/net-info', () => {
      // 打开面板就顺手自愈一次：开关开着但没在监听（热重载失败、端口被占后进程退出）时重新起
      if (on() && !server) start()
      return { ok: true, addresses: lanAddresses(), enabled: on(), port: port(), tone: tone(), tunnel: tunnelInfo(), service: svcInfo(), stale: staleInfo() }
    })
    api.route('/service', async (req) => {
      const b = await bodyOf(req).catch(() => ({}))
      if (b.action === 'restart') return restart()
      return svcInfo()
    })
    api.route('/tunnel', async (req) => {
      const b = await bodyOf(req).catch(() => ({}))
      if (b.action === 'start') {
        // 面板连 token / 域名一起提交，省掉「先保存、再启动」的时序问题
        const patch = {}
        if (typeof b.tunnelToken === 'string') patch.tunnelToken = b.tunnelToken.trim()
        if (typeof b.tunnelHost === 'string') patch.tunnelHost = b.tunnelHost.trim()
        if (Object.keys(patch).length) {
          api.saveSettings(patch)
          // 换了配置先把在跑的收掉，否则 named 与 quick 会同时占着出口
          if (cfRunning()) tunnelStop()
        }
        return tunnelStart()
      }
      if (b.action === 'stop') return tunnelStop()
      return tunnelInfo()
    })
    api.route('/state', (req, res) => (guard(req, res) ? ops.state() : undefined))
    api.route('/events', (req, res) => (guard(req, res) ? ops.events(urlOf(req).searchParams.get('after')) : undefined))
    api.route('/history', (req, res) => (guard(req, res) ? ops.history(Number(urlOf(req).searchParams.get('days') || 3) || 3) : undefined))
    api.route('/moments', async (req, res) => (guard(req, res) ? ops.moments() : undefined))
    api.route('/skin', (req, res) => (guard(req, res) ? ops.skin() : undefined))
    api.route('/message', async (req, res) => {
      if (!guard(req, res)) return
      try {
        const b = await bodyOf(req)
        return ops.message(b.text, b.image)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })
    api.route('/voice-note', async (req, res) => {
      if (!guard(req, res)) return
      try {
        return await ops.voiceNote((await bodyOf(req)).audio)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })
    // 临时诊断路由已移除
    api.route('/pet', async (req, res) => {
      if (!guard(req, res)) return
      try {
        const b = await bodyOf(req)
        return ops.pet(b.action, b.food)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })
    api.route('/voice', async (req, res) => {
      if (!guard(req, res)) return
      const text = String(urlOf(req).searchParams.get('text') || '').trim()
      const r = await ops.voice(text)
      if (!r.ok) return { ok: false, message: r.message }
      api.core.http.send(res, 200, readFileSync(r.file), 'audio/wav')
      return undefined
    })
    api.route('/tone', async (req, res) => {
      if (!guard(req, res)) return
      try {
        return ops.setTone((await bodyOf(req)).tone)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })

    // ---- 手机侧自带服务 ----
    let server = null
    let listening = 0
    let listenErr = ''
    let ipv4Only = false // 双栈监听起来时退回只监听 IPv4（系统禁了 IPv6 的机器上很常见）
    let retryTimer = null // 端口被上一实例短暂占用时的重试定时器

    function send(res, code, body, type, extra) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
      res.writeHead(code, {
        'content-type': type || 'application/json; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-pocket-token, x-phone-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        ...(extra || {}),
      })
      res.end(buf)
    }
    const json = (res, code, o) => send(res, code, JSON.stringify(o), 'application/json; charset=utf-8')

    async function readBody(req) {
      const chunks = []
      let size = 0
      for await (const c of req) {
        size += c.length
        if (size > 16 * 1024 * 1024) throw new Error('太大了')
        chunks.push(c)
      }
      if (!chunks.length) return {}
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        return JSON.parse(raw)
      } catch {
        return {}
      }
    }

    function authed(req, url) {
      const want = tokenOf()
      const given = String(req.headers['x-pocket-token'] || req.headers['x-phone-token'] || url.searchParams.get('token') || '')
      return safeEqual(given, want)
    }

    /** 静态文件：只认 app 目录里的东西，别想跳出去 */
    function serveStatic(res, pathname) {
      const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
      const full = normalize(join(appDir, rel))
      const noStore = { 'cache-control': 'no-store' } // 界面随模组更新，别让 WebView 缓存旧版
      // 用户自己换过形象：这一张顶掉内置的，顶栏/空间/小窝一次全换
      if (rel === '/icons/avatar.png') {
        const custom = readAvatar(dir)
        if (custom) return send(res, 200, custom.buf, custom.mime, noStore)
      }
      if (!full.startsWith(normalize(appDir + sep)) && full !== normalize(appDir)) return send(res, 403, 'nope', 'text/plain')
      if (!existsSync(full) || !statSync(full).isFile()) {
        // 单页应用：找不到文件就回首页
        const idx = join(appDir, 'index.html')
        if (existsSync(idx)) return send(res, 200, readFileSync(idx), MIME['.html'], noStore)
        return send(res, 404, 'app 没装好（缺 app/index.html）', 'text/plain; charset=utf-8')
      }
      const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
      return send(res, 200, readFileSync(full), type, noStore)
    }

    async function handle(req, res) {
      let url
      try {
        url = new URL(req.url || '/', 'http://x')
      } catch {
        return json(res, 400, { ok: false, message: 'bad url' })
      }
      if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain')

      const p = url.pathname
      if (!p.startsWith('/api/')) return serveStatic(res, p)

      // 只有健康检查不用密钥（配对时先探活）
      if (p === '/api/health') {
        if (!on()) return json(res, 503, { ok: false, message: '手机接口关着' })
        return json(res, 200, { ...ops.health(), port: listening || port() })
      }
      if (!on()) return json(res, 403, { ok: false, message: '手机接口关着' })
      if (rateLimited(req)) return json(res, 429, { ok: false, message: '失败次数太多，请一分钟后再试' })
      if (!authed(req, url)) {
        noteFail(req)
        return json(res, 401, { ok: false, message: '密钥不对' })
      }
      clearFails(req)

      const route = p.slice(5)
      try {
        // 隧道启停：面板点按钮、或本地脚本 / 另一台机器都能叫（同一套密钥鉴权）
        if (route === 'tunnel') {
          if (req.method === 'POST') {
            const b = await readBody(req)
            if (b.action === 'start') return json(res, 200, await tunnelStart())
            if (b.action === 'stop') return json(res, 200, tunnelStop())
            return json(res, 200, tunnelInfo())
          }
          return json(res, 200, tunnelInfo())
        }
        if (route === 'state') return json(res, 200, ops.state())
        if (route === 'events') return json(res, 200, ops.events(url.searchParams.get('after')))
        if (route === 'history') return json(res, 200, ops.history(Number(url.searchParams.get('days') || 3) || 3))
        if (route === 'moments') return json(res, 200, await ops.moments())
        if (route === 'skin') return json(res, 200, ops.skin())
        if (route === 'avatar') {
          if (req.method === 'DELETE') return json(res, 200, ops.clearAvatar())
          if (req.method === 'GET') return json(res, 200, ops.avatarInfo())
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '要 POST' })
          const b = await readBody(req)
          return json(res, 200, ops.setAvatar(b.image))
        }
        if (route === 'tone') {
          if (req.method === 'POST') {
            const b = await readBody(req)
            return json(res, 200, ops.setTone(b.tone))
          }
          return json(res, 200, { ok: true, tone: tone(), tones: TONES })
        }
        if (route === 'message') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '要 POST' })
          const b = await readBody(req)
          return json(res, 200, ops.message(b.text, b.image))
        }
        if (route === 'voice-note') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '要 POST' })
          const b = await readBody(req)
          return json(res, 200, await ops.voiceNote(b.audio))
        }
        if (route === 'pet') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '要 POST' })
          const b = await readBody(req)
          return json(res, 200, ops.pet(b.action, b.food))
        }
        if (route === 'voice') {
          const text = String(url.searchParams.get('text') || '').trim() || String((await readBody(req)).text || '')
          const r = await ops.voice(text)
          if (!r.ok) return json(res, 200, r)
          return send(res, 200, readFileSync(r.file), 'audio/wav', { 'cache-control': 'no-store' })
        }
        return json(res, 404, { ok: false, message: '没有这个接口：' + route })
      } catch (e) {
        return json(res, 500, { ok: false, message: String(e?.message || e) })
      }
    }

    function start(attempt = 0) {
      if (server) return
      const base = port()
      const entry = join(appDir, 'index.html')
      bootLog(`start 尝试#${attempt}：port=${base} app=${appDir}`)
      // 前端文件缺失时不能静默跳过：面板会以为「端口在、服务开着」，其实什么都没监听
      if (!existsSync(entry)) {
        listenErr = `前端文件缺失（${entry}），模块没装完整，服务没启动`
        api.log.error('口袋：' + listenErr)
        bootLog('失败：' + listenErr)
        return
      }
      const tryListen = (p, left, host) => {
        const srv = createServer((req, res) => {
          Promise.resolve(handle(req, res)).catch((e) => {
            try {
              json(res, 500, { ok: false, message: String(e?.message || e) })
            } catch {}
          })
        })
        srv.on('error', (e) => {
          listenErr = String(e?.message || e)
          const code = e?.code || ''
          try {
            srv.close()
          } catch {}
          // 端口被占：往上找空位
          if (code === 'EADDRINUSE' && left > 0) return tryListen(p + 1, left - 1, host)
          // 双栈监听起来又失败（系统或网卡禁了 IPv6）：退回只监听 IPv4，先让服务能用
          if (!host && (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL' || code === 'EINVAL')) {
            api.log.warn(`口袋：IPv6 双栈监听失败（${code}），改为只监听 IPv4`)
            ipv4Only = true
            return tryListen(p, left, '0.0.0.0')
          }
          api.log.warn(`口袋服务起不来（端口 ${p}）：${listenErr}`)
          bootLog(`listen ${p} 失败：${code || ''} ${listenErr}`)
          // 上一个实例还没退干净时端口会短暂占用：隔几秒再试，最多 3 次，别让人手动重启模块
          if (attempt < 3) {
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = setTimeout(() => {
              retryTimer = null
              start(attempt + 1)
            }, 3000 * (attempt + 1))
            retryTimer.unref?.()
          }
        })
        // 不指定 host = 监听 ::（IPv6 双栈），这样 IPv4 和公网 IPv6 都能进 —— 在外 4G/5G 直连靠的就是 IPv6
        const done = () => {
          server = srv
          listening = p
          listenErr = ''
          const addrs = lanAddresses()
          const t = tokenOf()
          // 日志脱敏：只露前两位，别把配对密钥写进日志
          api.log.info(
            `口袋已开：http://${addrs[0] || '127.0.0.1'}:${p}${ipv4Only ? '（仅 IPv4）' : ''}（密钥 ${t ? t.slice(0, 2) + '****' : '未生成'}，完整密钥见面板）`,
          )
          if (p !== base) api.log.warn(`口袋：端口 ${base} 被占用，实际监听 ${p}——手机要填 ${p}`)
          bootLog(`监听成功 ${p}${ipv4Only ? '（仅 IPv4）' : ''}${p !== base ? `（${base} 被占用）` : ''}`)
          // 开了「隧道自动启动」时，服务一起来就把外网通道也拉起来（DSH 重启后自动恢复）
          if (s().tunnelAuto === true) {
            setTimeout(() => {
              tunnelStart().catch((e) => api.log.warn('隧道自启失败：', String(e?.message || e)))
            }, 1500)
          }
        }
        if (host) srv.listen(p, host, done)
        else srv.listen(p, done)
      }
      try {
        tryListen(base, 6)
      } catch (e) {
        listenErr = String(e?.message || e)
        api.log.warn('口袋服务创建失败：', listenErr)
      }
    }

    /** 服务真实状态：面板据此区分「根本没起来」和「起来了但端口漂了」 */
    function svcInfo() {
      return { started: !!server, listening: listening || 0, wantPort: port(), ipv4Only, error: listenErr, tail: bootTail(6) }
    }

    /** 重启监听：端口被别人占、或模块热重载后没起来时，面板点一下就能自愈，不用关整个模块 */
    function restart() {
      bootLog('手动重启服务')
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      try {
        server?.close()
      } catch {}
      server = null
      listening = 0
      listenErr = ''
      ipv4Only = false
      start()
      return { ok: true, started: !!server, listening, wantPort: port(), error: listenErr }
    }

    // 开关开着就起服务；前端文件缺失由 start() 内部置 listenErr（面板能看见，不再静默失败）
    if (on()) start()
    api.onDispose(() => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      try {
        server?.close()
      } catch {}
      server = null
    })

    /** 面板要的信息 */
    hooks.__panel = () => ({
      enabled: on(),
      port: listening || port(),
      addresses: lanAddresses(),
      token: tokenOf(),
      tone: tone(),
      tones: TONES,
      error: listenErr,
      ...svcInfo(),
    })

    hooks.__test = { inject, voiceNote, guard, petInteract, petState, pushEvent, ring: () => ring, readHistory, tokenOf, lanAddresses, urlOf, ops, handle, decodeImage, mediaBytesOf, sniffMime }
  },
}

/** 默认皮肤（app 端按这份参数画形象）。 */
function defaultSkin(persona) {
  return {
    persona,
    name: '鲸汐汐',
    tones: TONES_SKIN,
    whale: { body: '#7db9ec', belly: '#eaf4fd', fin: '#5f97d6', cheek: '#f7b8c4' },
  }
}

const TONES_SKIN = TONES
