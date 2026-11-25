// lib/camera.mjs —— Bambu 局域网摄像头单帧抓取（两种机型路径）
//   1) MJPEG over TLS :6000（A1 / A1 mini / P1P / P1S）：80 字节认证包 + 16 字节帧头 + JPEG
//   2) RTSPS :322（X1 / H2 / P2S / X2D）：纯 JS 解不了 H.264，交给可选的本机 ffmpeg 截一帧
// 云端实时画面是 TUTK P2P，需要厂商专有 SDK，本模块不实现；云端设备只要能拿到
// dev_ip + dev_access_code 且与机器人同网，就由 index 改走这里的局域网路径。
// 只依赖 node:tls / node:net / node:child_process；connect 与 spawn 都可注入以便测试。
// 只接受 JPEG（FFD8 ... FFD9），单帧上限 8MB，超时中止；错误文本不含访问码。
//
// 安全约定（review P1-4 / P2-2 / RTSPS TLS）：
//   1) MJPEG 路径 fail-closed：没有 CA 锚点就**不建连接、不发 80 字节认证包**，
//      直接抛 CAMERA_UNPINNED（只有 learnCameraCert 的 learnOnly 握手例外）。
//   2) RTSPS 路径不把访问码放进 ffmpeg 的 argv：URL 只出现在通过 stdin 喂给 ffmpeg 的
//      concat 描述脚本里（见 rtspsFfmpegArgs 的注释与实测依据）。
//   3) RTSPS :322 在 spawn 之前先自己握手核对对端证书（ffmpeg 的 rtsp/tls 既不吃自签名
//      CA 也不吃指纹 pin，靠它校验不可行）：指纹不一致 / 握手失败一律拒绝，**ffmpeg
//      根本不启动**，访问码发不出去；没给 pin 时只做 TOFU 学习并把实测指纹返回上层。

import tls from 'node:tls'
import net from 'node:net'
import { X509Certificate } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { peerCertOf, normalizeFingerprint } from './tls-cert.mjs'

export const AUTH_PACKET_SIZE = 80
export const HEADER_SIZE = 16
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const DEFAULT_CAMERA_PORT = 6000
export const RTSPS_PORT = 322
export const DEFAULT_FFMPEG = 'ffmpeg'

/** 走 MJPEG :6000 的型号 */
const MJPEG_MODELS = new Set(['A1', 'A1MINI', 'A1 MINI', 'P1P', 'P1S'])
/** 走 RTSPS :322 的型号（H.264，需要本机 ffmpeg） */
const RTSPS_MODELS = new Set(['X1', 'X1C', 'X1E', 'X1CARBON', 'X1 CARBON', 'H2', 'H2D', 'P2S', 'X2D'])

/**
 * 按型号判断抓帧路径。
 * @param {string} model 型号或完整型号名（大小写/空格/连字符不敏感）
 * @returns {'mjpeg'|'rtsps'|'unknown'}
 */
export function detectCameraPlan(model) {
  const raw = String(model ?? '').trim().toUpperCase()
  if (!raw) return 'unknown'
  const normalized = raw.replace(/^(BAMBU\s*LAB\s*)/, '').replace(/[\s_-]/g, '')
  if (MJPEG_MODELS.has(normalized)) return 'mjpeg'
  if (RTSPS_MODELS.has(normalized)) return 'rtsps'
  // 前缀兜底：X1 Carbon / X1-Carbon Combo 等带后缀的写法
  for (const key of RTSPS_MODELS) {
    const compact = key.replace(/[\s_-]/g, '')
    if (normalized.startsWith(compact)) return 'rtsps'
  }
  for (const key of MJPEG_MODELS) {
    const compact = key.replace(/[\s_-]/g, '')
    if (normalized.startsWith(compact)) return 'mjpeg'
  }
  return 'unknown'
}

/** RTSPS 地址；密码做百分号编码，避免访问码里的特殊字符破坏 URL */
export function rtspsUrl({ host, accessCode, username = 'bblp', port = RTSPS_PORT } = {}) {
  const h = String(host ?? '')
  const user = encodeURIComponent(String(username ?? 'bblp'))
  const code = encodeURIComponent(String(accessCode ?? ''))
  return 'rtsps://' + user + ':' + code + '@' + h + ':' + Number(port || RTSPS_PORT) + '/streaming/live/1'
}

/**
 * RTSPS 到底连哪个端口。纯函数，方便单测。
 *
 * 为什么不能无脑用 opts.port：老调用方（printer.mjs）会把 **MJPEG 的 :6000** 原样放进
 * opts.port 传进来，拿它去和 :322 握手会连错端口、比错证书。所以：
 *   1) opts.rtspsPort 显式指定（1..65535 的整数）就用它 —— 新代码请用这个；
 *   2) 否则 opts.port 只有「不是 :6000」时才被当成 RTSPS 端口（端口转发的场景）；
 *   3) 其余情况一律 RTSPS_PORT(322)。
 * 这样老调用方传 port: 6000 时行为仍是「连打印机自己的 :322」，不会退化。
 */
export function rtspsPortOf(opts = {}) {
  const valid = (n) => Number.isInteger(n) && n > 0 && n <= 65535
  const explicit = Number(opts.rtspsPort)
  if (valid(explicit)) return explicit
  const candidate = Number(opts.port)
  if (valid(candidate) && candidate !== DEFAULT_CAMERA_PORT) return candidate
  return RTSPS_PORT
}

/**
 * ffmpeg 从 stdin 读 concat 描述脚本时允许的内部协议。
 * concat 默认白名单是 file,crypto,data，脚本里的 rtsps 会被拒；这里显式放开
 * rtsp/rtp/rtsps/tcp/tls，以及读取脚本本身要用的 pipe。
 * 端到端实测（ffmpeg 6.1.1 + 本地假 RTSP 服务端）：OPTIONS/DESCRIBE/SETUP/PLAY 都按
 * 脚本里的协议打开，SETUP 的 Transport 是 RTP/AVP/TCP;unicast;interleaved=0-1，
 * 说明脚本里的 option 指令确实透传给了内层 rtsp 输入。
 */
export const RTSPS_CONCAT_PROTOCOLS = 'file,crypto,data,pipe,rtsp,rtp,rtsps,tcp,tls'

/** concat 脚本的单引号转义：' -> '\'' */
function concatQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'"
}

/**
 * 交给 ffmpeg stdin 的 concat 描述脚本（**访问码只出现在这里**）。
 *
 * 为什么是 concat + stdin（review P2-2）：
 *   - ffmpeg 没法从环境变量或 stdin 直接拿到一个 "RTSP URL"：-i 要的是文件名，
 *     rtsp_flags listen 不是客户端用法，-i pipe:0 也读不了 RTSP。
 *   - 但 concat demuxer 读的是文本脚本，每行 file 是一个可打开的输入 URL，并且支持
 *     option <name> <value> 把选项透传给内层输入。把这些放进脚本、用 -i pipe:0 从
 *     stdin 喂进去，argv 里就只剩 pipe:0 和固定参数。
 *   - 脚本走匿名管道（不落盘），没有可被同机其它用户读取的凭据文件；进程结束管道即关。
 *   - 实测依据见 RTSPS_CONCAT_PROTOCOLS；不带 pipe 时会报
 *     "Protocol 'pipe' not on whitelist"，所以白名单必须包含 pipe。
 *
 * 注意：ffmpeg 自己**不校验** :322 的对端证书（Bambu 两个端口证书不同，:6000 的锚点
 * 也覆盖不到它；ffmpeg 的 rtsp/tls 也不吃指纹 pin）。所以身份核对放在 ffmpeg 之外，
 * 由 captureRtspsSnapshot 在 spawn 之前用 verifyRtspsPeerCert 完成；本函数只负责
 * 「怎样把访问码交给 ffmpeg 而不是交给 argv」。
 */
export function rtspsConcatScript({ host, accessCode, username = 'bblp', port = RTSPS_PORT } = {}) {
  const url = rtspsUrl({ host, accessCode, username, port })
  return 'file ' + concatQuote(url) + '\n' + 'option rtsp_transport tcp\n'
}

/**
 * ffmpeg 参数：从 stdin 的 concat 脚本打开 rtsps，只取 1 帧 MJPEG 到 stdout。
 *
 * **访问码永远不出现在这里**：参数表只有固定选项和输入名（默认 pipe:0）。
 * 为了兼容旧调用签名仍接受 host/accessCode/username/port，但它们不会写进 argv。
 * @param {{input?:string,host?:string,accessCode?:string,username?:string,port?:number}} [opts]
 */
export function rtspsFfmpegArgs({ input = 'pipe:0' } = {}) {
  const source = String(input || 'pipe:0')
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', RTSPS_CONCAT_PROTOCOLS,
    '-f', 'concat',
    '-safe', '0',
    '-i', source,
    '-y',
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ]
}

/**
 * 80 字节认证包：
 *  0x40 (4B LE) | 0x3000 (4B LE) | 0 (4B LE) | 0 (4B LE) | username 32B | accessCode 32B
 */
export function buildAuthPacket(username, accessCode) {
  const buf = Buffer.alloc(AUTH_PACKET_SIZE)
  buf.writeUInt32LE(0x40, 0)
  buf.writeUInt32LE(0x3000, 4)
  buf.writeUInt32LE(0, 8)
  buf.writeUInt32LE(0, 12)
  const user = String(username ?? '')
  const code = String(accessCode ?? '')
  // 只拷贝能放下的部分，不抛出（避免把秘密放进异常消息）
  Buffer.from(user, 'utf8').copy(buf, 16, 0, 32)
  Buffer.from(code, 'utf8').copy(buf, 48, 0, 32)
  return buf
}

/** 前 3 字节小端 = payload 长度 */
export function parseFrameHeader(header) {
  if (!header || header.length < HEADER_SIZE) return null
  const view = Buffer.isBuffer(header) ? header : Buffer.from(header)
  return view[0] | (view[1] << 8) | (view[2] << 16)
}

/** JPEG 魔数 + 结尾校验 */
export function isJpeg(buf) {
  if (!buf || buf.length < 4) return false
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (!(view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff && (view[3] === 0xe0 || view[3] === 0xe1))) return false
  if (view.length < 4) return false
  return view[view.length - 2] === 0xff && view[view.length - 1] === 0xd9
}

/** 错误文本里的访问码/用户名不得回显 */
function scrub(message, secrets) {
  let out = String(message ?? '')
  for (const secret of secrets) {
    const s = typeof secret === 'string' ? secret : ''
    if (s.length >= 3 && out.includes(s)) out = out.split(s).join('••••')
  }
  return out
}

function openSocket({ host, port, rejectUnauthorized, connect, tls: useTls = true, ca, learnOnly = false }) {
  if (typeof connect === 'function') {
    const socket = connect({ host, port, rejectUnauthorized, learnOnly })
    if (!socket || typeof socket.on !== 'function' || typeof socket.write !== 'function') {
      throw new Error('注入的 connect 没有返回可用 Duplex')
    }
    return socket
  }
  if (!useTls) return net.connect({ host, port })
  const anchors = caAnchors(ca)
  return tls.connect({
    host,
    port,
    // 有锚点就一定校验（打印机自签名证书）；没有锚点时只可能是 learnOnly 的读证书握手
    rejectUnauthorized: anchors.length ? true : (learnOnly ? false : rejectUnauthorized === true),
    ...(anchors.length ? { ca: anchors } : {}),
    minVersion: 'TLSv1.2',
    checkServerIdentity: () => undefined,
  })
}

/** ca 既接受 PEM 字符串，也接受数组；统一成非空字符串列表 */
function caAnchors(ca) {
  return (Array.isArray(ca) ? ca : ca ? [ca] : []).map((x) => String(x || '')).filter(Boolean)
}

/**
 * 只做 TLS 握手取对端证书，端口通用（:6000 MJPEG 与 :322 RTSPS 共用）。
 *
 * learnCameraCert 是它的历史别名：那个名字和默认端口都是 MJPEG 时代的，RTSPS 用
 * port: 322 调同一个实现。Bambu 两个端口的证书不同，锚点不能互相顶替，
 * 所以端口必须显式传进来（默认值只是兼容老调用）。
 *
 * 不发任何应用数据，因此还没有把访问码交出去；learnOnly 握手不校验证书。
 * @returns {Promise<{ok:boolean,pem?:string,fingerprint256?:string,subject?:string,notAfter?:number,error?:string,code?:string}>}
 */
export function learnPeerCert({ host, port = DEFAULT_CAMERA_PORT, timeoutMs = 8000, connect, tls: useTls = true } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy?.()
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    // 同 captureMjpegFrame：定时器不 unref，否则事件循环空闲时 Node 会提前退出，
    // 这个 Promise 永远不 settle（CI 上表现为 cancelledByParent）。
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT', error: '读取证书超时' }), Math.max(1000, Number(timeoutMs) || 8000))
    let socket = null
    try {
      const targetPort = Number(port) > 0 ? Number(port) : DEFAULT_CAMERA_PORT
      socket = openSocket({ host, port: targetPort, rejectUnauthorized: false, ca: [], connect, tls: useTls, learnOnly: true })
    } catch (error) {
      finish({ ok: false, code: (error && error.code) || 'CONNECT_FAILED', error: String((error && error.message) || error) })
      return
    }
    const take = () => {
      const cert = peerCertOf(socket)
      if (!cert || !cert.fingerprint256) finish({ ok: false, code: 'TLS_NO_CERT', error: '摄像头没有出示 TLS 证书' })
      else finish({ ok: true, pem: cert.pem, fingerprint256: cert.fingerprint256, subject: cert.subject, notAfter: cert.notAfter })
    }
    if (typeof socket.once === 'function') {
      socket.once('secureConnect', take)
      socket.once('connect', () => { if (!useTls) take() })
      socket.once('error', (error) => finish({ ok: false, code: (error && error.code) || 'CONNECT_FAILED', error: String((error && error.message) || error) }))
    } else {
      take()
    }
  })
}

/** 兼容老名字：MJPEG :6000 的取证书入口，实现就是 learnPeerCert */
export function learnCameraCert(opts = {}) {
  return learnPeerCert(opts)
}

/** 证书 PEM 的 SHA-256 指纹（小写无冒号）；PEM 残缺/解析不了返回 '' */
export function fingerprintOfPem(pem) {
  try {
    return normalizeFingerprint(new X509Certificate(String(pem || '')).fingerprint256)
  } catch {
    return ''
  }
}

/**
 * 调用方给的 :322 pin 从哪来。纯函数。
 *
 * **故意不读 opts.ca**：那是 MJPEG :6000 的锚点，两个端口证书不同。上层（index / printer）
 * 习惯把 :6000 锚点放在 ca 里传给所有型号；如果这里也读 ca，X1 系列就会拿错锚点去比对，
 * 报成「证书被换过」——既误导又把「哪个端口该 pin 什么」搅浑。:322 的 PEM 锚点走
 * opts.rtspsCa，指纹走 expectedFingerprint / fingerprint / tlsFingerprint / rtspsFingerprint。
 *
 * @returns {{pinned:boolean,fingerprint:string,pem:string,viaCa:boolean}}
 */
export function rtspsPinOf(opts = {}) {
  const explicit = normalizeFingerprint(
    opts.expectedFingerprint ?? opts.fingerprint ?? opts.tlsFingerprint ?? opts.rtspsFingerprint,
  )
  if (explicit) return { pinned: true, fingerprint: explicit, pem: '', viaCa: false }
  const anchors = caAnchors(opts.rtspsCa)
  if (!anchors.length) return { pinned: false, fingerprint: '', pem: '', viaCa: false }
  const want = fingerprintOfPem(anchors[0])
  // 证书 PEM 解析不了（测试桩/证书链文本）：退化成整串 PEM 比较，同一份材料仍然能对上
  if (!want) return { pinned: true, fingerprint: '', pem: anchors[0].trim(), viaCa: true }
  return { pinned: true, fingerprint: want, pem: '', viaCa: true }
}

/**
 * 调用方给的 pin 与实测证书是否一致。纯函数，方便直接单测。
 * @returns {{ok:boolean,code?:string,expected:string,actual:string}}
 */
export function verifyPinnedCert(pin, cert) {
  const expected = String((pin && pin.fingerprint) || '')
  if (!pin || pin.pinned !== true) return { ok: false, code: 'RTSPS_CERT_UNPINNED', expected, actual: '' }
  if (pin.pem) {
    const wantPem = String(pin.pem).trim()
    const gotPem = String((cert && cert.pem) || '').trim()
    if (!gotPem) return { ok: false, code: 'RTSPS_CERT_UNVERIFIED', expected: wantPem, actual: '' }
    return wantPem === gotPem
      ? { ok: true, expected: wantPem, actual: gotPem }
      : { ok: false, code: 'RTSPS_CERT_MISMATCH', expected: wantPem, actual: gotPem }
  }
  const actual = String((cert && cert.fingerprint256) || '')
  if (!actual) return { ok: false, code: 'RTSPS_CERT_UNVERIFIED', expected, actual: '' }
  return expected === actual
    ? { ok: true, expected, actual }
    : { ok: false, code: 'RTSPS_CERT_MISMATCH', expected, actual }
}

/**
 * RTSPS :322 的 spawn 前证书核对（RTSPS TLS P1 的核心）。
 *
 * 为什么要自己先握手：ffmpeg 的 rtsp/tls 输入（rtsp_flags / ca_file / 自签名 CA）在
 * 实际发行版里既不能可靠地把打印机自签名证书当锚点，也没有 pin 指纹的选项 —— 让
 * ffmpeg 去"校验"等于没有校验。所以真正能保证的是顺序：
 *   先握手取证书 → 与调用方的 pin 比对 → **只在对得上时才 spawn ffmpeg**。
 * 对不上、握手失败、拿不到证书时 ffmpeg 根本不启动，访问码连 stdin 都没进过。
 *
 * :6000 学到的锚点不适用于 :322（两个端口证书不同），调用方必须按端口分别 pin。
 *
 * 没有 :322 的 pin（opts.rtspsCa / expectedFingerprint 都没给）时：
 *   · requirePin: true（captureRtspsSnapshot 默认）→ 返回 RTSPS_UNPINNED，但把实测指纹
 *     带回去，上层展示给用户确认一次就能固定；
 *   · requirePin: false → 纯 TOFU 学习模式，ok:true 且 verified:false。
 *
 * @param {{host:string,port?:number,timeoutMs?:number,rtspsCa?:string[]|string,fingerprint?:string,
 *   rtspsFingerprint?:string,tlsFingerprint?:string,expectedFingerprint?:string,connect?:Function,
 *   learn?:Function,requirePin?:boolean,allowUnpinned?:boolean}} opts
 * @returns {Promise<{ok:boolean,code?:string,error?:string,fingerprint256?:string,pem?:string,
 *   notAfter?:number,verified:boolean,learned:boolean}>}
 */
export async function verifyRtspsPeerCert(opts = {}) {
  const host = String(opts.host || '')
  const port = Number(opts.port) > 0 ? Number(opts.port) : RTSPS_PORT
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000
  const requirePin = opts.requirePin === true
  const allowUnpinned = opts.allowUnpinned === true
  if (!host) return { ok: false, code: 'BAD_INPUT', error: '缺少摄像头主机地址', verified: false, learned: false }

  const pin = rtspsPinOf(opts)

  // 无论有没有 pin 都先握手：握手本身不发任何应用数据（更没有访问码），
  // 拿到实测指纹才能在「没 pin」时把该 pin 的值告诉上层，让用户确认一次就能固定。
  const learn = typeof opts.learn === 'function' ? opts.learn : learnPeerCert
  let learned
  try {
    learned = await learn({ host, port, timeoutMs, connect: opts.connect, tls: opts.tls !== false })
  } catch (error) {
    return { ok: false, code: (error && error.code) || 'RTSPS_CERT_UNVERIFIED', error: 'RTSPS 取证书失败：' + String((error && error.message) || error), verified: false, learned: false }
  }
  if (!learned || learned.ok !== true) {
    const code = String((learned && learned.code) || 'RTSPS_CERT_UNVERIFIED')
    const mapped = code === 'TLS_NO_CERT' ? 'RTSPS_CERT_UNVERIFIED' : code
    return {
      ok: false,
      code: mapped,
      error: 'RTSPS 取证书失败：' + String((learned && learned.error) || code),
      verified: false,
      learned: false,
    }
  }
  const info = {
    fingerprint256: normalizeFingerprint(learned.fingerprint256),
    pem: String(learned.pem || ''),
    subject: String(learned.subject || ''),
    notAfter: Number(learned.notAfter) || 0,
  }
  if (!info.fingerprint256) {
    return { ok: false, code: 'RTSPS_CERT_UNVERIFIED', error: 'RTSPS 对端没有出示可用的证书指纹', verified: false, learned: false }
  }
  if (!pin.pinned) {
    if (requirePin && !allowUnpinned) {
      // fail-closed：没有可核对的 pin，不启动 ffmpeg。但把实测指纹带回去，
      // 上层（index/panel）可以直接展示「这台 :322 的指纹是 …，确认后固定」。
      return {
        ok: false,
        code: 'RTSPS_UNPINNED',
        error: 'RTSPS 对端证书没有 pin，为安全起见不会启动 ffmpeg',
        ...info,
        verified: false,
        learned: true,
      }
    }
    // 纯学习（TOFU）：把实测指纹交给上层落盘，这里不假装验证过
    return { ok: true, ...info, verified: false, learned: true }
  }
  const verdict = verifyPinnedCert(pin, info)
  if (!verdict.ok) {
    return {
      ok: false,
      code: verdict.code === 'RTSPS_CERT_MISMATCH' ? 'RTSPS_CERT_MISMATCH' : 'RTSPS_CERT_UNVERIFIED',
      error: verdict.code === 'RTSPS_CERT_MISMATCH'
        ? 'RTSPS 对端证书与已固定的不一致（实测 ' + prettyShort(info.fingerprint256) + '），已拒绝发送访问码'
        : 'RTSPS 对端证书无法核对',
      ...info,
      verified: false,
      learned: false,
    }
  }
  return { ok: true, ...info, verified: true, learned: false }
}

/** 日志/错误文本里的短指纹（不含秘密，只用于让人认出是哪张证书） */
function prettyShort(value) {
  const hex = normalizeFingerprint(value)
  if (!hex) return '（无）'
  return hex.slice(0, 16) + '…'
}

/**
 * 抓一帧 JPEG（MJPEG over TLS :6000，A1/A1 mini/P1P/P1S 路径）。
 *
 * fail-closed（review P1-4）：没有 CA 锚点时不建连接、不发 80 字节认证包，直接抛
 * CAMERA_UNPINNED。因为无锚点的 TLS 连接不校验证书，而认证包里就是访问码 —— 那等于
 * 把它交给任意一个冒充者。锚点必须先由 learnCameraCert 学到并由调用方传进来。
 *
 * opts.allowUnpinnedForTest：**只给测试桩用**，默认 false，生产调用方一律不要传。
 *
 * @param {{host:string,port?:number,accessCode:string,username?:string,timeoutMs?:number,
 *   rejectUnauthorized?:boolean,ca?:string[]|string,connect?:Function,tls?:boolean,
 *   allowUnpinnedForTest?:boolean}} opts
 * @returns {Promise<Buffer>}
 */
export async function captureMjpegFrame(opts = {}) {
  const host = String(opts.host || '')
  const port = Number(opts.port) || DEFAULT_CAMERA_PORT
  const username = opts.username || 'bblp'
  const accessCode = opts.accessCode
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000
  const useTls = opts.tls !== false
  const anchors = caAnchors(opts.ca)

  if (!host) throw Object.assign(new Error('缺少摄像头主机地址'), { code: 'BAD_INPUT' })
  if (!accessCode) throw Object.assign(new Error('缺少访问码'), { code: 'NO_SECRET' })
  // 关键的一条：没有锚点就不连接。放在 openSocket 之前，注入的 connect 也一样不会被调用。
  if (!anchors.length && opts.allowUnpinnedForTest !== true) {
    throw Object.assign(new Error('摄像头证书没固定，为安全起见不会发送访问码'), { code: 'CAMERA_UNPINNED' })
  }

  const socket = openSocket({
    host,
    port,
    rejectUnauthorized: opts.rejectUnauthorized === true,
    ca: anchors,
    connect: typeof opts.connect === 'function' ? opts.connect : null,
    tls: useTls,
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = Buffer.alloc(0)
    let needHeader = true
    let payloadLen = 0

    // 不要 unref 这个定时器。
    // unref 过的定时器不阻止进程退出：抓帧期间如果正好没有别的句柄撑着事件循环
    // （比如注入的假 socket、或者对端一直不响应又没别的活动），Node 会直接退出，
    // 这个 Promise 永远不 settle —— 表现就是「Promise resolution is still pending but
    // the event loop has already resolved」。定时器本来就短（默认 15s、最坏 60s），
    // 让它正常参与事件循环更安全；finish() 里会 clearTimeout，不会拖住进程。
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('摄像头超时（' + timeoutMs + 'ms）'), { code: 'TIMEOUT' }))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      socket.removeListener('end', onClose)
    }

    function finish(err, result) {
      if (settled) return
      settled = true
      cleanup()
      try {
        if (!socket.destroyed) socket.destroy()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(result)
    }

    function onError(err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      const detail = scrub(wrapped.message || 'TLS 错误', [accessCode, username])
      finish(Object.assign(new Error('摄像头连接失败：' + detail), { code: wrapped.code || 'CAMERA_ERROR' }))
    }

    function onClose() {
      finish(Object.assign(new Error('摄像头连接提前关闭'), { code: 'CAMERA_CLOSED' }))
    }

    function onData(chunk) {
      if (settled) return
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
      for (;;) {
        if (needHeader) {
          if (buffer.length < HEADER_SIZE) return
          payloadLen = parseFrameHeader(buffer.subarray(0, HEADER_SIZE))
          buffer = buffer.subarray(HEADER_SIZE)
          if (!Number.isFinite(payloadLen) || payloadLen <= 0) {
            finish(Object.assign(new Error('摄像头返回了无效的帧长度'), { code: 'BAD_FRAME_HEADER' }))
            return
          }
          if (payloadLen > MAX_FRAME_BYTES) {
            finish(Object.assign(new Error('摄像头单帧超过 8MB 上限'), { code: 'FRAME_TOO_LARGE' }))
            return
          }
          needHeader = false
          continue
        }
        if (buffer.length < payloadLen) return
        const frame = buffer.subarray(0, payloadLen)
        if (!isJpeg(frame)) {
          finish(Object.assign(new Error('摄像头返回的不是 JPEG 图像'), { code: 'BAD_JPEG' }))
          return
        }
        finish(null, Buffer.from(frame))
        return
      }
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.once('end', onClose)

    let authSent = false
    const sendAuth = () => {
      if (settled || authSent) return
      authSent = true
      try {
        socket.write(buildAuthPacket(username, accessCode), (err) => {
          if (err) onError(err)
        })
      } catch (err) {
        onError(err)
      }
    }
    if (typeof opts.connect === 'function') {
      socket.once('connect', sendAuth)
      socket.once('secureConnect', sendAuth)
      setImmediate(sendAuth)
    } else {
      socket.once('secureConnect', sendAuth)
    }
  })
}
/**
 * RTSPS 截一帧（X1 / H2 / P2S / X2D）。纯 JS 解不了 H.264，必须借本机 ffmpeg。
 *
 * 凭据传递（review P2-2）：访问码只在 rtspsConcatScript() 生成的脚本文本里，通过
 * ffmpeg 的 **stdin** 喂进去；argv 只有 -f concat -i pipe:0 这类固定参数，同机其它
 * 进程 ps/读取 argv 拿不到访问码。脚本走匿名管道不落盘，因此也不需要清理临时文件。
 *
 * 对端身份（review P1 RTSPS TLS）：ffmpeg 的 rtsp/tls 既不能把打印机自签名证书当锚点，
 * 也没有 pin 选项，所以**在 spawn 之前**用 verifyRtspsPeerCert 自己握手取证书：
 *   · 指纹对不上 / 握手失败 → 抛错，ffmpeg 一次都不启动，访问码不会离开本进程；
 *   · 没有 pin 且没有 allowUnpinnedRtsps → 抛 RTSPS_UNPINNED（默认 fail-closed）；
 *   · 通过后照常 spawn，并把实测指纹放在返回值里，方便上层把 :322 的证书落盘。
 *
 * :6000 学到的锚点不适用于 :322（两个端口证书不同），必须按端口分别 pin。
 *
 * @param {{host:string,accessCode:string,username?:string,rtspsPort?:number,port?:number,
 *   timeoutMs?:number,ffmpegPath?:string,spawn?:Function,maxBytes?:number,
 *   rtspsCa?:string[]|string,expectedFingerprint?:string,fingerprint?:string,
 *   rtspsFingerprint?:string,tlsFingerprint?:string,connect?:Function,learn?:Function,
 *   certTimeoutMs?:number,allowUnpinnedRtsps?:boolean}} opts
 *   opts.ca 是 :6000 的锚点，**不用于 :322**；:322 用 rtspsCa / expectedFingerprint。
 *   opts.port 只有不等于 :6000 时才被当作 RTSPS 端口，优先用 opts.rtspsPort（见 rtspsPortOf）。
 * @returns {Promise<Buffer>} JPEG；实测证书信息挂在不可枚举属性上：
 *   shot.fingerprint256 / shot.pem / shot.subject / shot.notAfter / shot.port /
 *   shot.verified / shot.learned（也可解构 { jpeg, fingerprint256 } 取）。
 *   Buffer 的深比较只看可枚举属性，所以老调用方的 deepEqual 行为不变。
 */
export async function captureRtspsSnapshot(opts = {}) {
  const host = String(opts.host || '')
  const accessCode = opts.accessCode
  const username = opts.username || 'bblp'
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20000
  const ffmpegPath = String(opts.ffmpegPath || DEFAULT_FFMPEG)
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_FRAME_BYTES
  const spawnImpl = typeof opts.spawn === 'function' ? opts.spawn : nodeSpawn
  // 上层习惯把 MJPEG 的 :6000 放在 opts.port 里传进来，所以这里不能直接用 opts.port
  const rtspsPort = rtspsPortOf(opts)

  if (!host) throw Object.assign(new Error('缺少摄像头主机地址'), { code: 'BAD_INPUT' })
  if (!accessCode) throw Object.assign(new Error('缺少访问码'), { code: 'NO_SECRET' })

  // 关键顺序：先核对对端，再 spawn。这一步之前访问码只在本进程内存里。
  const trust = await verifyRtspsPeerCert({
    host,
    port: rtspsPort,
    timeoutMs: Number(opts.certTimeoutMs) > 0 ? Number(opts.certTimeoutMs) : Math.min(8000, timeoutMs),
    // 注意：opts.ca 是 :6000 的锚点，不参与 :322 的比对（两端口证书不同），见 rtspsPinOf
    rtspsCa: opts.rtspsCa,
    fingerprint: opts.fingerprint,
    rtspsFingerprint: opts.rtspsFingerprint,
    tlsFingerprint: opts.tlsFingerprint,
    expectedFingerprint: opts.expectedFingerprint,
    connect: opts.connect,
    learn: opts.learn,
    tls: opts.tls,
    requirePin: true,
    allowUnpinned: opts.allowUnpinnedRtsps === true,
  })
  if (!trust.ok) {
    const code = trust.code || 'RTSPS_CERT_UNVERIFIED'
    const message = code === 'RTSPS_CERT_MISMATCH'
      ? 'RTSPS 对端证书与已固定的不一致，已拒绝发送访问码'
      : code === 'RTSPS_UNPINNED'
        ? 'RTSPS 证书没固定，为安全起见不会启动 ffmpeg（先 learnPeerCert 再传 fingerprint/ca）'
        : scrub(String(trust.error || 'RTSPS 对端证书核对失败'), [accessCode, username])
    throw Object.assign(new Error(message), {
      code,
      fingerprint256: trust.fingerprint256 || '',
      ...(trust.pem ? { pem: trust.pem } : {}),
      ...(trust.expected ? { expected: trust.expected } : {}),
    })
  }

  const measured = {
    fingerprint256: trust.fingerprint256,
    pem: trust.pem || '',
    subject: trust.subject || '',
    notAfter: trust.notAfter || 0,
  }

  // argv 里永远不含访问码；URL 只在这个脚本文本里，从 stdin 交给 ffmpeg。
  const args = rtspsFfmpegArgs({ input: 'pipe:0' })
  const script = rtspsConcatScript({ host, accessCode, username, port: rtspsPort })

  const jpeg = await new Promise((resolve, reject) => {
    let settled = false
    let child = null
    const chunks = []
    let total = 0
    let stderrText = ''

    // 同样不 unref（见 captureMjpegFrame 的说明）
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('RTSPS 截帧超时（' + timeoutMs + 'ms）'), { code: 'TIMEOUT' }))
    }, timeoutMs)

    function killChild() {
      if (!child) return
      try {
        if (!child.killed) child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }

    function finish(err, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killChild()
      if (err) reject(err)
      else resolve(result)
    }

    function missingError(err) {
      const spawnErr = err instanceof Error ? err : new Error(String(err))
      const missing = spawnErr.code === 'ENOENT'
      return Object.assign(
        new Error(missing
          ? 'X1 系列需要本机 ffmpeg 才能截帧（未找到 ' + ffmpegPath + '）'
          : 'ffmpeg 启动失败：' + scrub(spawnErr.message, [accessCode, username])),
        { code: missing ? 'NO_FFMPEG' : 'FFMPEG_SPAWN' },
      )
    }

    try {
      // stdin 必须是管道：concat 脚本（含 rtsps URL 与访问码）从这里进 ffmpeg，不进 argv
      child = spawnImpl(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      finish(missingError(err))
      return
    }
    if (!child || typeof child.on !== 'function') {
      finish(Object.assign(new Error('X1 系列需要本机 ffmpeg 才能截帧'), { code: 'NO_FFMPEG' }))
      return
    }

    child.on('error', (err) => finish(missingError(err)))

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (settled || !chunk) return
        total += chunk.length
        if (total > maxBytes) {
          finish(Object.assign(new Error('截帧超过 8MB 上限'), { code: 'FRAME_TOO_LARGE' }))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      child.stdout.on('error', () => {
        /* stdout 出错由 close 统一处理 */
      })
    }

    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (!chunk) return
        // 只留很短尾部用于提示，并清洗访问码
        stderrText = (stderrText + chunk.toString('utf8')).slice(-400)
      })
      child.stderr.on('error', () => {
        /* ignore */
      })
    }

    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        const detail = scrub(stderrText.replace(/\s+/g, ' ').trim(), [accessCode, username])
        const hint = detail ? '（' + detail.slice(0, 120) + '）' : ''
        finish(Object.assign(new Error('ffmpeg 截帧失败，退出码 ' + code + hint), { code: 'FFMPEG_FAILED' }))
        return
      }
      const jpeg = Buffer.concat(chunks)
      if (!jpeg.length) {
        finish(Object.assign(new Error('ffmpeg 没有输出画面，请检查相机是否可用'), { code: 'EMPTY_FRAME' }))
        return
      }
      if (!isJpeg(jpeg)) {
        finish(Object.assign(new Error('ffmpeg 输出不是 JPEG 图像'), { code: 'BAD_JPEG' }))
        return
      }
      finish(null, jpeg)
    })

    // 监听器都挂好之后再写脚本：即使 stdin 立刻 EPIPE，也不会变成未捕获的 error 事件。
    // 写完立刻关 stdin（EOF 让 concat 开始解析）；真正原因统一看 stderr / 退出码。
    if (child.stdin && typeof child.stdin.end === 'function') {
      if (typeof child.stdin.on === 'function') {
        child.stdin.on('error', () => {
          /* ignore：真正原因看 stderr / 退出码 */
        })
      }
      try {
        child.stdin.end(script)
      } catch {
        /* ignore：真正原因看 stderr / 退出码 */
      }
    }
  })

  // 返回值仍然是 Buffer（老调用方 assert.deepEqual / Buffer.isBuffer / 直接写文件都不受影响），
  // 实测证书信息挂在**不可枚举**属性上：Buffer 的深比较只看可枚举自有属性，所以带着它
  // 也等于原来的那个 Buffer；新的调用方可以解构 { jpeg, fingerprint256 } 拿到指纹落盘。
  return attachRtspsCertInfo(jpeg, {
    fingerprint256: measured.fingerprint256,
    pem: measured.pem,
    subject: measured.subject,
    notAfter: measured.notAfter,
    port: rtspsPort,
    verified: trust.verified === true,
    learned: trust.learned === true,
  })
}

/** 把 :322 的实测证书信息挂到 JPEG Buffer 上（不可枚举，不进深比较、不进 JSON） */
export function attachRtspsCertInfo(jpeg, info = {}) {
  const buf = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg || [])
  const fields = {
    jpeg: buf,
    fingerprint256: normalizeFingerprint(info.fingerprint256),
    pem: String(info.pem || ''),
    subject: String(info.subject || ''),
    notAfter: Number(info.notAfter) || 0,
    port: Number(info.port) > 0 ? Number(info.port) : RTSPS_PORT,
    verified: info.verified === true,
    learned: info.learned === true,
  }
  for (const [key, value] of Object.entries(fields)) {
    try {
      Object.defineProperty(buf, key, { value, enumerable: false, configurable: true, writable: false })
    } catch {
      /* ignore：已经定义过就算了 */
    }
  }
  return buf
}

/**
 * 「证书没固定」不能被当成普通失败再换一条路径重试：RTSPS 同样是拿访问码去连一个
 * 没校验过的对端，回退等于把 P1-4 又绕过去了。这类错误一律直接向上抛。
 */
function isUnpinned(err) {
  const code = String((err && err.code) || '')
  return code === 'CAMERA_UNPINNED' || code === 'RTSPS_UNPINNED' || code === 'RTSPS_CERT_MISMATCH'
}

/**
 * 抓一帧 JPEG。给了 model 就按型号自动选路径（X1/H2/P2S/X2D 走 RTSPS+ffmpeg），
 * 没给 model 时保持原行为走 MJPEG :6000。
 * MJPEG 没有 CA 锚点会直接 CAMERA_UNPINNED；RTSPS 没有 pin（或 allowUnpinnedRtsps）
 * 会直接 RTSPS_UNPINNED。两者都 fail-closed，且不会互相降级。
 *
 * 注意端口别混：opts.ca 是 MJPEG :6000 的锚点；RTSPS :322 的 pin 要用
 * opts.rtspsCa / opts.expectedFingerprint（两个端口证书不同，opts.ca 不会被当成 :322 的 pin）。
 * @param {{host:string,port?:number,accessCode:string,model?:string,username?:string,
 *   timeoutMs?:number,rejectUnauthorized?:boolean,connect?:Function,spawn?:Function,
 *   ffmpegPath?:string,tls?:boolean,ca?:string[]|string,fingerprint?:string,
 *   expectedFingerprint?:string,allowUnpinnedRtsps?:boolean,learn?:Function}} opts
 * @returns {Promise<Buffer>} JPEG
 */
export async function captureFrame(opts = {}) {
  const model = opts.model ?? opts.devModel ?? ''
  if (!model) return captureMjpegFrame(opts)
  const plan = detectCameraPlan(model)
  if (plan === 'rtsps') return captureRtspsSnapshot(opts)
  if (plan === 'mjpeg') return captureMjpegFrame(opts)
  try {
    return await captureMjpegFrame(opts)
  } catch (firstErr) {
    if (isUnpinned(firstErr)) throw firstErr
    try {
      return await captureRtspsSnapshot(opts)
    } catch (secondErr) {
      throw Object.assign(new Error('无法从该型号抓帧：局域网 MJPEG 与 RTSPS 都失败'), {
        code: 'CAMERA_UNSUPPORTED',
        cause: secondErr,
        mjpegError: firstErr,
      })
    }
  }
}

/** detectCameraPlan 的别名（index 可按名字调用） */
export const capturePlan = detectCameraPlan

/**
 * 按型号自动选择路径抓一帧，并返回用了哪条路径：mjpeg -> :6000；rtsps -> ffmpeg；
 * unknown -> 先 MJPEG 再 RTSPS。
 * @returns {Promise<{jpeg:Buffer, plan:'mjpeg'|'rtsps'}>}
 */
export async function captureByPlan(opts = {}) {
  const plan = detectCameraPlan(opts.model)
  if (plan === 'rtsps') {
    const shot = await captureRtspsSnapshot(opts)
    return { jpeg: shot, plan: 'rtsps', fingerprint256: shot.fingerprint256, verified: shot.verified === true }
  }
  if (plan === 'mjpeg') return { jpeg: await captureMjpegFrame(opts), plan: 'mjpeg' }
  try {
    return { jpeg: await captureMjpegFrame(opts), plan: 'mjpeg' }
  } catch (firstErr) {
    // 证书没固定就停在这里，不要用另一条路径偷偷把访问码再送一次
    if (isUnpinned(firstErr)) throw firstErr
    try {
      const shot = await captureRtspsSnapshot(opts)
      return { jpeg: shot, plan: 'rtsps', fingerprint256: shot.fingerprint256, verified: shot.verified === true }
    } catch (secondErr) {
      throw Object.assign(new Error('无法从该型号抓帧：局域网 MJPEG 与 RTSPS 都失败'), {
        code: 'CAMERA_UNSUPPORTED',
        cause: secondErr,
        mjpegError: firstErr,
      })
    }
  }
}
