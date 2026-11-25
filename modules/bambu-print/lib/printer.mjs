// lib/printer.mjs —— 打印机连接复用 / 状态缓存 / 命令下发
// 只依赖 node:events 与本地 mqtt/camera/status；不碰 vault/crypto/policy。
// 安全：任何错误消息、日志都不得出现 accessCode / accessToken / uid，一律用 mask 后的值。

import { createMqttClient } from './mqtt.mjs'
import { captureFrame, captureRtspsSnapshot, detectCameraPlan } from './camera.mjs'
import { normalizeStatus } from './status.mjs'
import { REGIONS } from './cloud.mjs'

const RECEIPT_TIMEOUT_MS = 2500
const MAX_GCODE_LEN = 2000

/** 深合并 report：纯对象递归合并，AMS 单元按 id 合并，数组默认替换。 */
export function mergeReport(prev, incoming) {
  if (!isPlain(prev)) return isPlain(incoming) ? clone(incoming) : {}
  if (!isPlain(incoming)) return clone(prev)
  const out = clone(prev)
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'ams' && isPlain(value) && isPlain(out[key])) {
      out[key] = { ...out[key], ...value, ams: mergeUnitList(out[key].ams, value.ams) }
      continue
    }
    if (isPlain(value) && isPlain(out[key])) {
      out[key] = mergeReport(out[key], value)
      continue
    }
    out[key] = clone(value)
  }
  return out
}

function mergeUnitList(prevList, nextList) {
  if (!Array.isArray(nextList)) return Array.isArray(prevList) ? clone(prevList) : []
  if (!Array.isArray(prevList)) return clone(nextList)
  const out = clone(prevList)
  for (const unit of nextList) {
    if (!isPlain(unit)) continue
    const idx = out.findIndex((item) => isPlain(item) && String(item.id) === String(unit.id))
    if (idx === -1) {
      out.push(clone(unit))
      continue
    }
    const merged = mergeReport(out[idx], unit)
    merged.tray = mergeUnitList(out[idx].tray, unit.tray)
    out[idx] = merged
  }
  return out
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlain(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = clone(v)
    return out
  }
  return value
}

/** target 的稳定键（不含任何秘密），用于连接/缓存复用 */
export function targetKey(target) {
  if (!target || typeof target !== 'object') return ''
  const mode = target.mode === 'cloud' ? 'cloud' : 'lan'
  const serial = String(target.serial || '')
  const host = String(target.host || target.ip || '')
  if (mode === 'cloud') return 'cloud:' + (target.uid ? 'uid' : 'anon') + ':' + serial
  return 'lan:' + host + ':' + serial
}

/** 把 target 自带的固定记录（index 从保险库解密后放进 target 的 tlsCa / tlsFingerprint）标准化 */
export function pinnedTrustOf(target) {
  if (!isPlain(target)) return { ca: [], fingerprint: '', learned: false }
  const ca = hasValue(target.tlsCa) ? [String(target.tlsCa)] : []
  const fingerprint = String(target.tlsFingerprint || '').replace(/:/g, '').toLowerCase()
  return { ca, fingerprint, learned: ca.length > 0 || fingerprint !== '' }
}

/**
 * 「要带着凭据建连」的硬门（fail-closed）。
 * · 云端不受影响：走公共 CA + 主机名校验；
 * · 局域网必须已经固定过证书（ca 锚点或指纹），否则一律不建连、不写 socket、不发访问码。
 * 学证书只能走 learnCert()（learnOnly：只握手读证书，一个 MQTT 报文都不发）。
 *
 * @param {object} target
 * @param {{ca?:string[],fingerprint?:string}|null} [trust] manager 从 certTrust 查到的固定记录
 * @returns {{ok:boolean, code:string|null, error:string|null}}
 */
export function requireLanTrust(target, trust = null) {
  if (!isPlain(target)) return { ok: false, code: 'BAD_TARGET', error: '缺少打印机信息' }
  if (target.mode === 'cloud') return { ok: true, code: null, error: null }
  const pinned = isPlain(trust) ? trust : pinnedTrustOf(target)
  const ca = Array.isArray(pinned.ca) ? pinned.ca.filter(Boolean) : []
  const fingerprint = String(pinned.fingerprint || '').replace(/:/g, '').toLowerCase()
  if (ca.length > 0 || fingerprint) return { ok: true, code: null, error: null }
  return { ok: false, code: 'CERT_UNPINNED', error: '局域网打印机还没固定证书，为安全起见不会发送访问码' }
}

/**
 * 连接参数的纯部分（不依赖 manager 闭包，便于单测）。
 * 云端：系统根证书 + 主机名校验 —— rejectUnauthorized:true、不给 ca、不固定指纹；
 *       云端 target 上误带的 tlsCa / tlsFingerprint 之类字段一律不可信，直接忽略，绝不因此降级。
 * 局域网：TOFU —— 固定过 ca 锚点才校验（rejectUnauthorized:true + ca），指纹交给 mqtt 做二次确认。
 *
 * @param {{mode?:'lan'|'cloud', host?:string, port?:number, ca?:string[]|string, fingerprint?:string, username?:string, password?:string}} input
 * @returns {object} 交给 createMqttClient 的选项
 */
export function buildConnectionOptions({ mode = 'lan', host = '', port = 8883, ca = [], fingerprint = '', username = '', password = '' } = {}) {
  const isCloud = mode === 'cloud'
  // 云端不认任何自带锚点/指纹：只信系统 CA
  const caList = isCloud ? [] : (Array.isArray(ca) ? ca : [ca]).map((x) => String(x || '')).filter(Boolean)
  const opts = {
    host,
    port,
    tlsFingerprint: isCloud ? '' : String(fingerprint || '').replace(/:/g, '').toLowerCase(),
  }
  if (isCloud) {
    opts.rejectUnauthorized = true
  } else {
    opts.rejectUnauthorized = caList.length > 0
    if (caList.length) opts.ca = caList
  }
  if (hasValue(username)) opts.username = String(username)
  if (hasValue(password)) opts.password = String(password)
  return opts
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value) !== ''
}

function numOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clampSpeed(value) {
  const n = numOrNull(value)
  if (n === null) return null
  const i = Math.round(n)
  if (i < 1 || i > 4) return null
  return String(i)
}

function clampTemp(value, max) {
  const n = numOrNull(value)
  if (n === null) return null
  if (n < 0 || n > max) return null
  return Math.round(n)
}

function sequenceIdOf(payload) {
  if (!isPlain(payload)) return null
  for (const section of Object.values(payload)) {
    if (isPlain(section) && hasValue(section.sequence_id)) return String(section.sequence_id)
  }
  return null
}

/**
 * 构造命令负载。
 * @param {string} action pause|resume|stop|light|speed|temperature|gcode|home|pushall|raw
 * @param {object} [params]
 * @param {string} [sequenceId] 序列号（字符串，自增）
 * @returns {{payload:object, expect:object|null}}
 */
export function buildCommand(action, params = {}, sequenceId = '0') {
  const p = isPlain(params) ? params : {}
  const seq = String(sequenceId)
  switch (action) {
    case 'pause':
      return wrap({ print: { command: 'pause', sequence_id: seq } })
    case 'resume':
      return wrap({ print: { command: 'resume', sequence_id: seq } })
    case 'stop':
      return wrap({ print: { command: 'stop', sequence_id: seq } })
    case 'light': {
      const on = typeof p.on === 'boolean' ? p.on : String(p.mode ?? p.value ?? '').toLowerCase() === 'on'
      return wrap({
        system: {
          command: 'ledctrl',
          led_node: 'chamber_light',
          led_mode: on ? 'on' : 'off',
          led_on_time: 500,
          led_off_time: 500,
          loop_times: 0,
          interval_time: 0,
          sequence_id: seq,
        },
      })
    }
    case 'speed': {
      const param = clampSpeed(p.level ?? p.value ?? p.param)
      if (param === null) return { payload: null, expect: null, error: '速度档位必须是 1 到 4' }
      return wrap({ print: { command: 'print_speed', param, sequence_id: seq } })
    }
    case 'temperature': {
      const bed = clampTemp(p.bed, 120)
      const nozzle = clampTemp(p.nozzle, 300)
      const lines = []
      if (bed !== null) lines.push('M140 S' + bed)
      if (nozzle !== null) lines.push('M104 S' + nozzle)
      if (!lines.length) return { payload: null, expect: null, error: '请给出热床或喷嘴目标温度' }
      const param = lines.join('\n') + '\n'
      return wrap({ print: { command: 'gcode_line', param, sequence_id: seq } })
    }
    case 'gcode': {
      const raw = typeof p.lines === 'string' ? p.lines : Array.isArray(p.lines) ? p.lines.join('\n') : ''
      const text = String(raw).trim()
      if (!text) return { payload: null, expect: null, error: 'G-code 不能为空' }
      const param = text + '\n'
      if (param.length > MAX_GCODE_LEN) {
        return { payload: null, expect: null, error: 'G-code 过长（上限 ' + MAX_GCODE_LEN + ' 字符）' }
      }
      return wrap({ print: { command: 'gcode_line', param, sequence_id: seq } })
    }
    case 'home':
      return wrap({ print: { command: 'gcode_line', param: 'G28\n', sequence_id: seq } })
    case 'pushall':
      return wrap({ pushing: { command: 'pushall', version: 1, push_target: 1, sequence_id: seq } })
    case 'raw': {
      const payload = p.payload ?? p
      if (!isPlain(payload)) return { payload: null, expect: null, error: 'raw 需要完整 payload 对象' }
      const cloned = clone(payload)
      if (!sequenceIdOf(cloned)) {
        const first = Object.keys(cloned)[0]
        if (first && isPlain(cloned[first])) cloned[first].sequence_id = seq
      }
      return { payload: cloned, expect: { sequenceId: sequenceIdOf(cloned) } }
    }
    default:
      return { payload: null, expect: null, error: '不支持的操作：' + String(action) }
  }
}

function wrap(payload) {
  return { payload, expect: { sequenceId: sequenceIdOf(payload) } }
}

/** 错误文本里的秘密清洗：只保留掩码，绝不回显。 */
function sanitizeError(err, secrets) {
  let text = err instanceof Error ? err.message : String(err ?? '未知错误')
  for (const secret of secrets) {
    if (!secret) continue
    const s = String(secret)
    if (s.length >= 3 && text.includes(s)) text = text.split(s).join('••••')
  }
  return text
}

/**
 * LAN 访问码：target.accessCode（每台打印机自己的）优先，其次凭据级 bindingAccessCode，
 * 最后 target.secret.accessCode（index 有时直接把 vault 的 secret 塞进 target）。
 */
function accessCodeOf(target) {
  if (!target || typeof target !== 'object') return undefined
  if (hasValue(target.accessCode)) return target.accessCode
  if (hasValue(target.bindingAccessCode)) return target.bindingAccessCode
  const secret = isPlain(target.secret) ? target.secret : null
  if (secret && hasValue(secret.accessCode)) return secret.accessCode
  return undefined
}

/** 云端访问令牌：target.accessToken 优先，其次 target.secret.accessToken */
function accessTokenOf(target) {
  if (!target || typeof target !== 'object') return undefined
  if (hasValue(target.accessToken)) return target.accessToken
  const secret = isPlain(target.secret) ? target.secret : null
  if (secret && hasValue(secret.accessToken)) return secret.accessToken
  return undefined
}

/** 所有需要从日志/错误里清洗掉的秘密 */
function secretsOf(target) {
  if (!target || typeof target !== 'object') return []
  const secret = isPlain(target.secret) ? target.secret : {}
  const list = [
    target.accessCode, target.bindingAccessCode, target.accessToken, target.password,
    secret.accessCode, secret.accessToken,
  ]
  return list.filter((v) => typeof v === 'string' && v).map(String)
}

/** 默认的每 target 串行队列（lock 未注入时使用） */
function createLocalLock() {
  const chains = new Map()
  return function lock(key) {
    const prev = chains.get(key) || Promise.resolve()
    let release = null
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const chained = prev.then(() => gate)
    chains.set(key, chained)
    return prev.then(() => () => {
      release()
      if (chains.get(key) === chained) chains.delete(key)
    })
  }
}

export function createPrinterManager({
  log = console,
  now = Date.now,
  clientFactory = createMqttClient,
  statusTtlMs = 3000,
  idleCloseMs = 120000,
  lock = null,
  cameraCapture = null,
  rtspsCapture = captureRtspsSnapshot,
  ffmpegPath = '',
  certTrust = null,
  // 只给测试用：允许「不校验 TLS 还带凭据」的连接（生产一律 fail-closed）
  allowInsecureCredentialsForTest = false,
} = {}) {
  const cache = new Map() // key -> { report, status, receivedAt }
  const conns = new Map() // key -> conn
  const seqByTarget = new Map()
  const serialLock = lock || createLocalLock()

  function debug(...args) {
    try {
      log.debug?.(...args)
    } catch {
      /* ignore */
    }
  }

  /**
   * 打印机的自签名证书：第一次连先「学」，之后每次都拿它当 ca 锚点严格校验。
   * certTrust 由 index 注入（读写 vault 里固定的 PEM + 指纹），这里只负责协议侧。
   */
  function trustOf(target) {
    if (!certTrust || typeof certTrust.get !== 'function') return { ca: [], fingerprint: '', learned: false }
    try {
      const rec = certTrust.get(target)
      if (!rec || !rec.pem) return { ca: [], fingerprint: '', learned: false }
      return { ca: [rec.pem], fingerprint: String(rec.fingerprint256 || ''), learned: true }
    } catch {
      return { ca: [], fingerprint: '', learned: false }
    }
  }

  function hostOf(target, mode) {
    const explicit = String(target.host || target.ip || '')
    if (explicit) return explicit
    // 兜底：云端只给 region 时用该区域的 MQTT 主机（index 正常会直接给 host）
    if (mode === 'cloud') {
      const region = REGIONS[String(target.region || '').toLowerCase()]
      if (region) return region.mqtt
    }
    return ''
  }

  /**
   * 局域网固定记录：保险库（certTrust）里的优先，其次 target 自带（index 直接塞进 target 的
   * tlsCa / tlsFingerprint）。云端不走这条，也不认 target 上任何锚点字段。
   */
  function lanTrustOf(target) {
    const fromStore = trustOf(target)
    if (fromStore.learned) return fromStore
    return pinnedTrustOf(target)
  }

  /**
   * 建连参数。
   * · 云端：buildConnectionOptions 只给 rejectUnauthorized:true，不带 ca、不固定指纹 ——
   *   用系统根证书 + 主机名校验（mqtt 那边也不会覆盖 checkServerIdentity）；
   *   target 上误带的 tlsCa / tlsFingerprint 一律忽略，绝不允许把云端降级成不校验。
   * · 局域网：TOFU，固定过 ca 才校验；没有锚点时 requireLanTrust 已经挡在前面，
   *   这里再兜一层（except 只给 learnCert 的 learnOnly 握手用）。
   */
  function connectionOptions(target, extra = {}, { except = false } = {}) {
    const mode = target.mode === 'cloud' ? 'cloud' : 'lan'
    const host = hostOf(target, mode)
    const trust = mode === 'lan' ? lanTrustOf(target) : { ca: [], fingerprint: '', learned: false }
    if (mode === 'lan' && !except) {
      const gate = requireLanTrust(target, trust)
      if (gate.ok !== true) throw Object.assign(new Error(gate.error), { code: gate.code || 'CERT_UNPINNED' })
    }
    const baseOpts = mode === 'lan'
      ? buildConnectionOptions({ mode, host, port: numOrNull(target.port) ?? 8883, ca: trust.ca, fingerprint: trust.fingerprint, username: 'bblp', password: accessCodeOf(target) })
      : buildConnectionOptions({ mode, host, port: numOrNull(target.port) ?? 8883, username: target.username || ('u_' + (target.uid || '')), password: accessTokenOf(target) })
    return {
      ...baseOpts,
      ...extra,
      clientId: 'aurabot_' + Math.random().toString(16).slice(2, 10),
      log: { debug },
    }
  }

  /**
   * 首次连接时学习打印机自己的自签名证书。
   * 只做 TLS 握手（learnOnly），拿到证书立刻断开，绝不发访问码。
   * 学到的证书交给 certTrust.save 落盘，之后的连接都严格校验它。
   *
   * @returns {Promise<{ok:boolean, fingerprint256?:string, pem?:string, saved?:boolean, error?:string, code?:string}>}
   */
  async function learnCert(target) {
    const mode = target.mode === 'cloud' ? 'cloud' : 'lan'
    if (mode !== 'lan') return { ok: false, code: 'NOT_LAN', error: '只有局域网连接需要学习打印机证书' }
    const host = hostOf(target, 'lan')
    if (!host) return { ok: false, code: 'NO_HOST', error: '缺少打印机 IP' }
    // learnOnly：只握手读证书，一个 MQTT 报文都不发 —— 所以这里允许「不校验」穿过凭据门
    const opts = connectionOptions(target, {
      learnOnly: true,
      tlsFingerprint: '',
      ...(allowInsecureCredentialsForTest === true ? { allowInsecureCredentialsForTest: true } : {}),
    }, { except: true })
    delete opts.ca
    let client = null
    try {
      client = clientFactory(Object.assign({}, opts, { rejectUnauthorized: false, learnOnly: true }))
      const info = await new Promise((resolve, reject) => {
        let settled = false
        const finish = (err, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err) reject(err)
          else resolve(value)
        }
        // 不 unref（同 lib/mqtt.mjs 的 connect 超时）：事件循环空闲时 Node 会提前退出，
        // Promise 永远不 settle。finish() 里 clearTimeout，不会拖住进程。
        const timer = setTimeout(() => finish(Object.assign(new Error('学习证书超时'), { code: 'TIMEOUT' })), 10000)
        client.on('peer-cert', (info2) => finish(null, info2))
        client.connect().catch((err) => finish(err))
      })
      let saved = false
      if (certTrust && typeof certTrust.save === 'function') {
        saved = certTrust.save(target, { pem: info.pem, fingerprint256: info.fingerprint256, subject: info.subject, notAfter: info.notAfter }) === true
      }
      return { ok: true, fingerprint256: info.fingerprint256, pem: info.pem, subject: info.subject, notAfter: info.notAfter, saved }
    } catch (error) {
      return { ok: false, code: error.code || 'LEARN_FAILED', error: String((error && error.message) || error) }
    } finally {
      try {
        client?.close?.()
      } catch {
        /* ignore */
      }
    }
  }

  function getConn(target) {
    const key = targetKey(target)
    const existing = conns.get(key)
    if (existing) {
      existing.touch()
      return existing
    }
    const serial = String(target.serial || '')
    if (!serial) throw Object.assign(new Error('缺少打印机序列号'), { code: 'NO_SERIAL' })
    if (target.mode === 'cloud') {
      if (!hasValue(accessTokenOf(target))) throw Object.assign(new Error('缺少云端访问令牌'), { code: 'NO_SECRET' })
    } else if (!hasValue(accessCodeOf(target))) {
      throw Object.assign(new Error('缺少访问码'), { code: 'NO_SECRET' })
    }
    if (!hostOf(target, target.mode === 'cloud' ? 'cloud' : 'lan')) {
      throw Object.assign(new Error('缺少打印机地址'), { code: 'NO_HOST' })
    }
    // fail-closed：要发凭据的连接必须先有信任锚点（云端天然满足）。不合规时直接抛错，
    // 不建 client、不写 socket —— 学证书只能走 learnCert()。
    // allowInsecureCredentialsForTest 只给测试，生产永远是 false。
    if (allowInsecureCredentialsForTest !== true) {
      const gate = requireLanTrust(target, target.mode === 'cloud' ? null : lanTrustOf(target))
      if (gate.ok !== true) throw Object.assign(new Error(gate.error), { code: gate.code || 'CERT_UNPINNED' })
    }
    const raw = clientFactory(connectionOptions(target, {}, { except: allowInsecureCredentialsForTest === true }))
    const conn = {
      key,
      serial,
      raw,
      report: {},
      waiters: new Set(),
      idleTimer: null,
      opened: null,
      closing: false,
      touch() {
        if (conn.idleTimer) {
          clearTimeout(conn.idleTimer)
          conn.idleTimer = null
        }
        if (idleCloseMs > 0) {
          const timer = setTimeout(() => {
            conn.close()
          }, idleCloseMs)
          if (typeof timer.unref === 'function') timer.unref()
          conn.idleTimer = timer
        }
      },
      async open() {
        if (!conn.opened) {
          conn.opened = (async () => {
            await raw.connect()
            await raw.subscribe('device/' + serial + '/report', 0)
          })()
          conn.opened.catch(() => {
            conn.opened = null
          })
        }
        return conn.opened
      },
      close() {
        conn.closing = true
        if (conn.idleTimer) {
          clearTimeout(conn.idleTimer)
          conn.idleTimer = null
        }
        conn.opened = null
        for (const waiter of [...conn.waiters]) waiter.reject(Object.assign(new Error('连接已关闭'), { code: 'MQTT_CLOSED' }))
        conn.waiters.clear()
        try {
          raw.close()
        } catch {
          /* ignore */
        }
        if (conns.get(key) === conn) conns.delete(key)
      },
    }

    raw.on('message', (topic, payload) => {
      if (typeof topic !== 'string' || !topic.endsWith('/report')) return
      let parsed
      try {
        parsed = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }
      if (!isPlain(parsed)) return
      conn.report = mergeReport(conn.report, parsed)
      cache.set(key, { report: conn.report, receivedAt: now(), stale: false })
      for (const waiter of [...conn.waiters]) {
        try {
          waiter.handler(parsed, conn.report)
        } catch {
          /* 单个监听器失败不影响其它 */
        }
      }
    })
    raw.on('close', () => {
      conn.opened = null
      for (const waiter of [...conn.waiters]) waiter.reject(Object.assign(new Error('MQTT 连接已断开'), { code: 'MQTT_CLOSED' }))
      conn.waiters.clear()
    })
    raw.on('error', (err) => {
      debug('[printer] MQTT 错误（' + key + '）：' + sanitizeError(err, secretsOf(target)))
    })

    conns.set(key, conn)
    conn.touch()
    return conn
  }

  function nextSequence(key) {
    const prev = Number(seqByTarget.get(key) || 0)
    const next = prev >= 999999 ? 1 : prev + 1
    seqByTarget.set(key, next)
    return String(next)
  }

  function topicOf(conn, suffix) {
    return 'device/' + conn.serial + '/' + suffix
  }

  function fail(target, err, code) {
    const message = sanitizeError(err, secretsOf(target))
    debug('[printer] 失败：' + message)
    return { ok: false, error: message, code: code || (err && err.code) || 'PRINTER_ERROR' }
  }

  async function fetchStatus(target, { timeoutMs = 6000 } = {}) {
    const key = targetKey(target)
    let conn
    try {
      conn = getConn(target)
    } catch (err) {
      return fail(target, err)
    }
    const receivedAt = now()
    try {
      await conn.open()
    } catch (err) {
      conn.close()
      return fail(target, err)
    }
    let lastPrint = null
    const waitReport = new Promise((resolve) => {
      const waiter = {
        handler(parsed) {
          if (isPlain(parsed.print)) lastPrint = parsed.print
          if (lastPrint && (hasValue(lastPrint.gcode_state) || hasValue(lastPrint.mc_percent))) {
            cleanup()
            resolve()
          }
        },
        reject(err) {
          cleanup()
          resolve(err)
        },
        timer: null,
      }
      function cleanup() {
        conn.waiters.delete(waiter)
        if (waiter.timer) clearTimeout(waiter.timer)
      }
      // 不 unref：等打印机回 report 时若没有别的句柄，Node 会在超时前退出，promise 不 settle。
      // cleanup() 会 clearTimeout。
      waiter.timer = setTimeout(() => {
        cleanup()
        resolve()
      }, Math.max(500, Number(timeoutMs) || 6000))
      conn.waiters.add(waiter)
    })

    try {
      const seq = nextSequence(key)
      const req = buildCommand('pushall', {}, seq)
      await conn.raw.publish(topicOf(conn, 'request'), JSON.stringify(req.payload))
    } catch (err) {
      for (const waiter of [...conn.waiters]) waiter.reject(Object.assign(new Error('状态请求发送失败'), { code: 'MQTT_ERROR' }))
      return fail(target, err)
    }

    const outcome = await waitReport
    conn.touch()
    const report = conn.report
    const hasPrint = isPlain(report.print)
    if (outcome instanceof Error && !hasPrint) return fail(target, outcome)
    if (!hasPrint) {
      return {
        ok: false,
        error: '打印机在 ' + Math.round((Number(timeoutMs) || 6000) / 1000) + ' 秒内没有返回状态',
        code: 'TIMEOUT',
      }
    }
    // 有回包但等超时：数据来自更早的报包，标记 stale
    const stalled = !(lastPrint && (hasValue(lastPrint.gcode_state) || hasValue(lastPrint.mc_percent)))
    const received = stalled ? receivedAt : now()
    const status = normalizeStatus(report, { now: now() })
    cache.set(key, { report, receivedAt: received })
    debug('[printer] 状态已更新（' + key + '）')
    return { ok: true, report, status, receivedAt: received, stale: stalled }
  }

  async function status(target, { timeoutMs = 6000, force = false } = {}) {
    if (!target || typeof target !== 'object') return { ok: false, error: '缺少打印机信息', code: 'BAD_TARGET' }
    const key = targetKey(target)
    const cached = cache.get(key)
    if (!force && cached && now() - cached.receivedAt <= statusTtlMs) {
      const report = cached.report
      const statusValue = normalizeStatus(report, { now: now() })
      return { ok: true, report, status: statusValue, receivedAt: cached.receivedAt, stale: false, cached: true }
    }
    const fresh = await fetchStatus(target, { timeoutMs })
    if (fresh.ok) return fresh
    if (cached && isPlain(cached.report.print)) {
      const report = cached.report
      return {
        ok: true,
        report,
        status: normalizeStatus(report, { now: now() }),
        receivedAt: cached.receivedAt,
        stale: true,
        cached: true,
        warning: fresh.error,
      }
    }
    return fresh
  }

  async function command(target, action, params = {}) {
    if (!target || typeof target !== 'object') return { ok: false, error: '缺少打印机信息' }
    const key = targetKey(target)
    const release = await serialLock(key)
    try {
      const built = buildCommand(action, params, '0')
      if (!built.payload) {
        return { ok: false, error: built.error || '命令无效' }
      }
      const seq = nextSequence(key)
      const built2 = buildCommand(action, params, seq)
      const payload = built2.payload
      const expectSeq = sequenceIdOf(payload)
      let conn
      try {
        conn = getConn(target)
        await conn.open()
      } catch (err) {
        return fail(target, err)
      }
      conn.touch()

      const ack = new Promise((resolve) => {
        const waiter = {
          handler(parsed) {
            const got = findSequence(parsed)
            if (expectSeq !== null && got !== null && String(got) !== String(expectSeq)) return
            if (expectSeq !== null && got === null) return
            cleanup()
            resolve(true)
          },
          reject() {
            cleanup()
            resolve(false)
          },
          timer: null,
        }
        function cleanup() {
          conn.waiters.delete(waiter)
          if (waiter.timer) clearTimeout(waiter.timer)
        }
        // 不 unref（同上）：等回执超时也必须真的等到，否则 promise 不 settle。
        waiter.timer = setTimeout(() => {
          cleanup()
          resolve(false)
        }, RECEIPT_TIMEOUT_MS)
        conn.waiters.add(waiter)
      })

      try {
        await conn.raw.publish(topicOf(conn, 'request'), JSON.stringify(payload))
      } catch (err) {
        return fail(target, err)
      }
      const acked = await ack
      conn.touch()
      return { ok: true, message: acknowledgeText(action, params, acked), acked }
    } finally {
      release()
    }
  }

  function findSequence(parsed) {
    if (!isPlain(parsed)) return null
    for (const section of Object.values(parsed)) {
      if (isPlain(section) && hasValue(section.sequence_id)) return String(section.sequence_id)
    }
    return null
  }

  function acknowledgeText(action, params, acked) {
    const tail = acked ? '（打印机已回执）' : '（已发送，打印机未在 2.5 秒内回执）'
    switch (action) {
      case 'pause':
        return '已发送暂停命令' + tail
      case 'resume':
        return '已发送继续命令' + tail
      case 'stop':
        return '已发送停止命令' + tail
      case 'light': {
        const on = typeof params.on === 'boolean' ? params.on : String(params.mode ?? params.value ?? '').toLowerCase() === 'on'
        return (on ? '已打开' : '已关闭') + '舱内灯' + tail
      }
      case 'speed':
        return '已设置打印速度档位 ' + String(params.level ?? params.value ?? params.param ?? '') + tail
      case 'temperature':
        return '已发送温度设置' + tail
      case 'gcode':
        return '已发送 G-code' + tail
      case 'home':
        return '已发送回零（G28）' + tail
      case 'pushall':
        return '已请求完整状态' + tail
      case 'raw':
        return '已发送原始命令' + tail
      default:
        return '已发送命令' + tail
    }
  }

  async function snapshot(target, { timeoutMs = 15000 } = {}) {
    if (!target || typeof target !== 'object') return { ok: false, error: '缺少打印机信息' }
    // 云端实时画面是 TUTK P2P（需要厂商 SDK），这里只走局域网；
    // 但云端绑定若拿到了 dev_ip + dev_access_code，index 会带 lanSnapshot:true 改走本机网络。
    if (target.mode === 'cloud' && target.lanSnapshot !== true) {
      return { ok: false, error: '云端模式暂不支持拍照' }
    }
    const host = String(target.ip || target.host || '')
    if (!host) return { ok: false, error: '缺少打印机 IP' }
    if (!hasValue(accessCodeOf(target))) return { ok: false, error: '缺少访问码' }
    const plan = detectCameraPlan(target.model)
    const base = {
      host,
      port: numOrNull(target.cameraPort) ?? 6000,
      accessCode: accessCodeOf(target),
      username: target.cameraUser || 'bblp',
      model: String(target.model || ''),
      timeoutMs,
      rejectUnauthorized: target.rejectUnauthorized === true,
      ...(ffmpegPath ? { ffmpegPath } : {}),
    }
    try {
      if (plan === 'rtsps') {
        const jpeg = await rtspsCapture(base)
        return { ok: true, jpeg, plan: 'rtsps' }
      }
      if (plan === 'mjpeg') {
        const jpeg = await captureWith(target, base)
        return { ok: true, jpeg, plan: 'mjpeg' }
      }
      // 型号未知：先试 MJPEG，失败再试 RTSPS
      try {
        const jpeg = await captureWith(target, base)
        return { ok: true, jpeg, plan: 'mjpeg' }
      } catch (firstErr) {
        try {
          const jpeg = await rtspsCapture(base)
          return { ok: true, jpeg, plan: 'rtsps' }
        } catch (secondErr) {
          return fail(target, firstErr, secondErr && secondErr.code === 'NO_FFMPEG' ? 'NO_FFMPEG' : undefined)
        }
      }
    } catch (err) {
      return fail(target, err)
    }
  }

  function captureWith(_target, base) {
    if (typeof cameraCapture === 'function') return cameraCapture(base)
    return captureFrame(base)
  }

  function closeAll() {
    for (const conn of [...conns.values()]) conn.close()
    conns.clear()
    cache.clear()
  }

  /** 给上层（index / 面板）用的信任判定：同一套规则，避免再复制一遍 */
  function trustState(target) {
    if (!target || typeof target !== 'object') return { ok: false, code: 'BAD_TARGET', error: '缺少打印机信息' }
    return requireLanTrust(target, target.mode === 'cloud' ? null : lanTrustOf(target))
  }

  return { status, command, snapshot, closeAll, learnCert, requireLanTrust: trustState, _conns: conns, _cache: cache }
}
