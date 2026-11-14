// lib/vault.mjs — bambu-print 的加密保险库（用户记录 + 绑定向导 + 授权）。
//
// 安全模型（ARCHITECTURE.md 第 0/1/3 节）：
//   * 每个用户一把随机 32B DEK；KEK = scrypt(该用户安全码, 每人独立 16B 盐)。
//     DEK 用 KEK 经 AES-256-GCM 包成 user.wrapped（AAD = "user:<qq>"），
//     绑定数据（含 accessCode/accessToken）用 DEK 加密封成 user.payload（AAD 同上）。
//     没有机器主密钥：拿到整份数据目录也解不开任何人的秘密。
//   * 明文秘密只活在内存：解锁会话里只放 DEK，每次用时临时解出 payload，用完擦 Buffer。
//   * 日志/返回值永不含秘密：对外结构只有 id/label/mode/counts/掩码。
//   * 所有写操作（含「读 payload -> 改 -> 加密 -> 落盘」整个过程）都在同一条 promise
//     队列里串行执行，避免并发请求互相覆盖；落盘是 tmp + rename 的原子替换，文件 0600。
//
// 与 ARCHITECTURE 的两处细化（已在汇报中说明）：
//   1. 用户记录里拆成两个盒子：wrapped（KEK 包的 DEK，契约第 2/3 条要求）与 payload
//      （DEK 加密的绑定数据）。契约原文把两者都叫 wrapped，实现上必须分开。
//   2. 用户记录额外带一份 meta 元数据镜像（id/label/mode/打印机 serial-ip-name-model，
//      绝无 secret），只用于「未解锁时的列表与统计」；payload 永远是唯一真源，
//      任何写操作后都从 payload 重建 meta。
//
// 授权（grant）：owner 解锁后把选中绑定打包成 printerRefs（含秘密），用随机 12 位
// 只把「谁授权给谁、哪几套绑定、什么范围、到什么时候」记成明文元数据（不含秘密）；
// 校验命中，命中后放内存会话（到期/撤销即清）。

import { chmod, mkdir, open as openFile, readFile, rename, stat, appendFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  clearBuffer, CryptoError, maskSecret, open, randomBytes, sealJson, unwrapKey, wrapKey
} from './crypto.mjs'

/** 授权范围 */
export const SCOPES = Object.freeze(['status', 'control', 'photo'])
/** 授权默认 / 最长时长（分钟） */
export const DEFAULT_GRANT_MINUTES = 30
export const MAX_GRANT_MINUTES = 1440
/** 连续错码的锁定梯度：第 5 次错锁 15 分钟，第 10 次错锁 60 分钟 */
export const FAIL_LOCK_TIERS = Object.freeze([{ fails: 5, minutes: 15 }, { fails: 10, minutes: 60 }])
/** 审计日志轮转阈值 */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024
/** 解锁时长：默认 7 天，最少 1 天，最多 30 天（内部一律换算成分钟） */
export const MIN_LOCK_MINUTES = 1440
export const DEFAULT_LOCK_MINUTES = 10080
export const MAX_LOCK_MINUTES = 43200
const AUDIT_MEMORY_ROWS = 2000

const QQ_RE = /^\d{1,15}$/
const SERIAL_RE = /^[A-Za-z0-9._-]{4,40}$/
const HOST_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})$/
const REGIONS = ['us', 'eu', 'cn']
const CODE_RE = /^[^\s]{4,64}$/
/** 偏好里的「优先走哪个网络」：'' 跟随默认，绝不指向具体凭据。 */
export const PREF_INTERFACES = Object.freeze(['', 'cloud', 'lan', 'auto'])
/** 绑定用户自己的群聊权限偏好：'' 跟随全局，其余覆盖。 */
export const PREF_GROUP_MODES = Object.freeze(['', 'off', 'status', 'control'])

const VAULT_MESSAGES = {
  NO_USER: '该用户还没有设置安全码',
  EXISTS: '该用户已经设置过安全码',
  BAD_CODE: '安全码不正确',
  NEED_CODE: '这个账号设了安全码，必须用安全码解锁',
  LOCKED_OUT: '尝试次数过多，请稍后再试',
  LOCKED: '请先解锁（提供该用户的安全码）',
  WEAK_CODE: '安全码强度不足',
  NOT_FOUND: '找不到对应的记录',
  BAD_INPUT: '参数不正确',
  EXPIRED: '授权已过期',
  FORBIDDEN: '没有权限执行该操作',
  NOT_LOADED: '安全库尚未加载',
  BAD_FILE: '安全库文件损坏',
  BAD_STATE: '安全库状态异常'
}

export class VaultError extends Error {
  constructor (code, message) {
    super(message || VAULT_MESSAGES[code] || '安全库操作失败')
    this.name = 'VaultError'
    this.code = code || 'VAULT'
  }
}

const userAad = (qq) => 'user:' + String(qq)
const grantAad = (id) => 'grant:' + String(id)

function newId (prefix) {
  return prefix + '_' + randomBytes(5).toString('hex').slice(0, 9)
}

function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 打印机地址：合法 IPv4（每段 <= 255）或带点的域名。 */
function isHost (value) {
  const text = value == null ? '' : String(value).trim()
  if (!text || !HOST_RE.test(text)) return false
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return true
}

function text (value, field, { min = 1, max = 200 } = {}) {
  const raw = value == null ? '' : String(value).replace(/[\r\n\t]/g, ' ').trim()
  if (raw.length < min) throw new VaultError('BAD_INPUT', field + '不能为空')
  if (raw.length > max) throw new VaultError('BAD_INPUT', field + '过长（最多 ' + max + ' 字）')
  return raw
}

function assertQQ (qq) {
  const value = qq == null ? '' : String(qq).trim()
  if (!QQ_RE.test(value)) throw new VaultError('BAD_INPUT', 'QQ 号不正确')
  return value
}

/** 严格校验：用于授权时长等「越界必须报错」的场景。 */
function clampMinutes (minutes, fallback, min, max) {
  const raw = Number(minutes)
  if (minutes == null || minutes === '' || !Number.isFinite(raw)) return fallback
  const whole = Math.floor(raw)
  if (whole < min || whole > max) {
    throw new VaultError('BAD_INPUT', '时长必须在 ' + min + '~' + max + ' 分钟之间')
  }
  return whole
}

/** 宽松夹取：用于「从设置里读出来的解锁时长」，只夹不报错。 */
function clampSoft (minutes, fallback, min, max) {
  const raw = Number(minutes)
  if (minutes == null || minutes === '' || !Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

function normalizeScopes (scopes) {
  if (scopes == null) return SCOPES.slice()
  const list = Array.isArray(scopes) ? scopes : [scopes]
  const picked = []
  for (const item of list) {
    const name = String(item == null ? '' : item).trim().toLowerCase()
    if (!name) continue
    if (!SCOPES.includes(name)) throw new VaultError('BAD_INPUT', '未知的授权范围：' + name)
    if (!picked.includes(name)) picked.push(name)
  }
  if (!picked.length) throw new VaultError('BAD_INPUT', '至少需要一个授权范围')
  return picked
}

/** 从 ref 里去掉一切秘密字段，只留展示用元数据（反问候选、日志、面板都能直接用）。 */
export function publicPrinterRef (ref) {
  if (!isPlainObject(ref)) return null
  return {
    ref: ref.ref,
    bindingId: ref.bindingId,
    bindingLabel: ref.bindingLabel,
    mode: ref.mode,
    index: ref.index,
    serial: ref.serial,
    ip: ref.ip,
    name: ref.name,
    model: ref.model,
    tokenMask: ref.tokenMask || '',
    secretAvailable: !!ref.secretAvailable
  }
}

function sanitizeNote (note) {
  const raw = note == null ? '' : String(note)
  // 审计里绝不落长串（token/访问码都长），只留人类可读摘要
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 160)
}

/** 默认偏好（每个用户一份，绝不污染共享对象）。 */
function defaultPrefs () {
  return { groupShowName: false, selectedPrinter: '', interface: '', groupMode: '', groupPhoto: null }
}

/** 把存盘的偏好洗成白名单形状：多余字段丢掉，缺的补默认。 */
function readPrefs (value) {
  const raw = isPlainObject(value) ? value : {}
  const groupMode = PREF_GROUP_MODES.includes(String(raw.groupMode == null ? '' : raw.groupMode)) ? String(raw.groupMode == null ? '' : raw.groupMode) : ''
  const iface = PREF_INTERFACES.includes(String(raw.interface == null ? '' : raw.interface)) ? String(raw.interface == null ? '' : raw.interface) : ''
  return {
    groupShowName: raw.groupShowName === true,
    selectedPrinter: raw.selectedPrinter == null ? '' : String(raw.selectedPrinter).slice(0, 80),
    interface: iface,
    groupMode,
    groupPhoto: typeof raw.groupPhoto === 'boolean' ? raw.groupPhoto : null
  }
}

/** 空安全库。 */
function emptyVault () {
  return { v: 1, users: {} }
}

/** 空授权库。 */
function emptyGrants () {
  return { v: 1, grants: [] }
}

export class Vault {
  constructor (options = {}) {
    const dir = options.dir == null ? '' : String(options.dir).trim()
    if (!dir) throw new VaultError('BAD_INPUT', '必须提供数据目录 dir')
    this.dir = path.resolve(dir)
    this.files = {
      vault: path.join(this.dir, 'vault.json'),
      grants: path.join(this.dir, 'grants.json'),
      audit: path.join(this.dir, 'audit.jsonl'),
      auditOld: path.join(this.dir, 'audit.1.jsonl'),
      // 「免安全码」账号的机器主密钥（0600，和 vault.json 同目录）。
      // 它只用来包**免码账号**的 DEK；设了安全码的账号完全不碰它。
      hostKey: path.join(this.dir, 'host-key.bin')
    }
    this.log = options.log === null ? null : (options.log || console)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.lockMinutes = clampSoft(options.lockMinutes, DEFAULT_LOCK_MINUTES, MIN_LOCK_MINUTES, MAX_LOCK_MINUTES)
    this.maxBindings = Math.max(1, Math.floor(Number(options.maxBindings) || 5))

    this.db = emptyVault()
    this.grantsDb = emptyGrants()
    this.auditRows = []
    this.sessions = new Map() // qq -> { dek, until }
    this.grantMap = new Map() // granteeQQ -> Map(grantId -> { key, ownerQQ, scopes, expiresAt })
    this.queue = Promise.resolve()
    this.loaded = false
    // 机器主密钥：懒加载（只有遇到免码账号才去读/建）。
    // 它不是「明文密钥」——仍然是一把 32B 随机数，只是它的保管者从「用户脑子里的安全码」
    // 变成了「这台机器上的这个文件」。代价写进了 README「安全边界」。
    this._hostKey = null
  }

  // ------------------------------------------------------------ 加载 / 落盘

  async load () {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700).catch(() => {})
    await this.#ensureFile(this.files.vault, emptyVault())
    await this.#ensureFile(this.files.grants, emptyGrants())

    this.db = await this.#readJson(this.files.vault, '安全库')
    this.grantsDb = await this.#readJson(this.files.grants, '授权库')
    this.#normalizeDb()
    this.auditRows = await this.#readAudit()
    this.loaded = true
    // 没有安全码了：能解开的记录在加载时就预热会话，同步读取路径才不用到处 await。
    await this.#warmAll()
    this.#logInfo('已加载：用户 ' + Object.keys(this.db.users).length + ' 个，授权 ' + this.grantsDb.grants.length + ' 条')
    return { ok: true, users: Object.keys(this.db.users).length, grants: this.grantsDb.grants.length }
  }

  async #ensureFile (file, fallback) {
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new VaultError('BAD_FILE', '数据路径不是文件：' + path.basename(file))
      await chmod(file, 0o600).catch(() => {})
      return
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
      await this.#atomicWrite(file, JSON.stringify(fallback, null, 2) + '\n')
    }
  }

  async #readJson (file, label) {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new VaultError('BAD_FILE', label + '文件不存在')
      throw new VaultError('BAD_FILE', label + '读取失败：' + (err && err.message))
    }
    if (!raw.trim()) throw new VaultError('BAD_FILE', label + '文件是空的（拒绝静默重置）')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new VaultError('BAD_FILE', label + '文件不是合法 JSON（拒绝静默重置）')
    }
    if (!isPlainObject(parsed)) throw new VaultError('BAD_FILE', label + '文件结构不正确')
    return parsed
  }

  async #readAudit () {
    try {
      const raw = await readFile(this.files.audit, 'utf8')
      const rows = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const row = JSON.parse(trimmed)
          if (isPlainObject(row)) rows.push(row)
        } catch {
          // 单行坏掉不影响其它行；审计是 append-only 的旁路，不阻断启动
        }
      }
      return rows.slice(-AUDIT_MEMORY_ROWS)
    } catch (err) {
      if (err && err.code === 'ENOENT') return []
      throw new VaultError('BAD_FILE', '审计日志读取失败：' + (err && err.message))
    }
  }

  #normalizeDb () {
    if (!isPlainObject(this.db.users)) this.db.users = {}
    this.db.v = 1
    for (const [qq, rec] of Object.entries(this.db.users)) {
      if (!isPlainObject(rec)) throw new VaultError('BAD_FILE', '用户记录损坏：' + qq)
      rec.v = 1
      rec.prefs = readPrefs(rec.prefs)
      rec.meta = this.#metaFromPayload(rec.meta && Array.isArray(rec.meta.bindings) ? rec.meta.bindings : [])
      rec.createdAt = Number(rec.createdAt) || 0
      rec.updatedAt = Number(rec.updatedAt) || 0
      rec.lastSeenAt = Number(rec.lastSeenAt) || 0
    }
    if (!Array.isArray(this.grantsDb.grants)) this.grantsDb.grants = []
    this.grantsDb.v = 1
    this.grantsDb.grants = this.grantsDb.grants.filter((g) => isPlainObject(g) && g.id)
  }

  #metaFromPayload (bindings) {
    const list = Array.isArray(bindings) ? bindings : []
    return {
      bindings: list.map((b) => ({
        id: String(b.id || ''),
        label: String(b.label || ''),
        mode: b.mode === 'cloud' ? 'cloud' : 'lan',
        createdAt: Number(b.createdAt) || 0,
        printers: (Array.isArray(b.printers) ? b.printers : []).map((p) => ({
          serial: String(p.serial || ''),
          ip: String(p.ip || ''),
          name: String(p.name || ''),
          model: String(p.model || '')
        }))
      }))
    }
  }

  /** 所有写操作走同一条队列；队列里的任务直接调用 #write*Now，不要再次入队（会死锁）。 */
  #enqueue (task) {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async #atomicWrite (file, content) {
    const dir = path.dirname(file)
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid.toString(36) + '.' + Date.now().toString(36) + '.tmp')
    let handle = null
    try {
      handle = await openFile(tmp, 'w', 0o600)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
    try {
      await chmod(tmp, 0o600).catch(() => {})
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => {})
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
  }

  #writeVaultNow () {
    return this.#atomicWrite(this.files.vault, JSON.stringify(this.db, null, 2) + '\n')
  }

  #writeGrantsNow () {
    return this.#atomicWrite(this.files.grants, JSON.stringify(this.grantsDb, null, 2) + '\n')
  }

  // ------------------------------------------------------------ 基础查询

  #assertLoaded () {
    if (!this.loaded) throw new VaultError('NOT_LOADED')
  }

  hasUser (qq) {
    this.#assertLoaded()
    return !!this.#record(qq)
  }

  userCount () {
    this.#assertLoaded()
    return Object.keys(this.db.users).length
  }

  #record (qq) {
    const key = qq == null ? '' : String(qq).trim()
    const rec = this.db.users[key]
    return isPlainObject(rec) ? rec : null
  }

  #mustRecord (qq) {
    const rec = this.#record(qq)
    if (!rec) throw new VaultError('NO_USER')
    return rec
  }

  summary () {
    this.#assertLoaded()
    let bindings = 0
    let printers = 0
    let boundUsers = 0
    for (const rec of Object.values(this.db.users)) {
      const list = rec.meta && Array.isArray(rec.meta.bindings) ? rec.meta.bindings : []
      const count = list.reduce((sum, b) => sum + (Array.isArray(b.printers) ? b.printers.length : 0), 0)
      bindings += list.length
      printers += count
      if (list.length) boundUsers += 1
    }
    return {
      users: Object.keys(this.db.users).length,
      boundUsers,
      bindings,
      printers,
      unlocked: this.#liveSessionQQs().length,
      activeGrants: this.#activeGrants().length
    }
  }

  listUsers () {
    this.#assertLoaded()
    const now = this.now()
    return Object.keys(this.db.users).map((qq) => {
      const rec = this.db.users[qq]
      const list = rec.meta && Array.isArray(rec.meta.bindings) ? rec.meta.bindings : []
      const printers = list.reduce((sum, b) => sum + (Array.isArray(b.printers) ? b.printers.length : 0), 0)
      return {
        qq,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        lastSeenAt: rec.lastSeenAt,
        bindings: list.length,
        printers,
        unlocked: this.isUnlocked(qq),
        lockedUntil: 0
      }
    })
  }

  // ------------------------------------------------------------ 解锁会话

  #liveSession (qq) {
    const key = qq == null ? '' : String(qq).trim()
    const session = this.sessions.get(key)
    if (!session) return null
    if (!(session.until > this.now())) {
      clearBuffer(session.dek)
      this.sessions.delete(key)
      return null
    }
    return session
  }

  #liveSessionQQs () {
    return [...this.sessions.keys()].filter((qq) => !!this.#liveSession(qq))
  }

  /**
   * 预热：把本机主密钥能解开的记录解一次放进会话（启动时跑）。
   * 单条失败不影响别人（host-key 被换过、或那条记录被外部改坏）。
   */
  async #warmAll () {
    const until = this.now() + this.lockMinutes * 60000
    for (const [qq, rec] of Object.entries(this.db.users)) {
      if (!rec) continue
      try {
        const kek = await this.#hostKek()
        let dek
        try {
          dek = unwrapKey(kek, rec.wrapped, userAad(qq))
        } finally {
          clearBuffer(kek)
        }
        const previous = this.sessions.get(qq)
        if (previous) clearBuffer(previous.dek)
        this.sessions.set(qq, { dek, until })
      } catch {
        this.#logWarn('预热失败，跳过：' + qq)
      }
    }
  }

  isUnlocked (qq) {
    if (!this.loaded) return false
    return !!this.#liveSession(qq)
  }

  /** 设置变化时调整解锁滑窗；只夹取不报错（index 直接把设置值丢进来）。 */
  setLockMinutes (minutes) {
    this.#assertLoaded()
    this.lockMinutes = clampSoft(minutes, this.lockMinutes, MIN_LOCK_MINUTES, MAX_LOCK_MINUTES)
    return { ok: true, lockMinutes: this.lockMinutes }
  }

  lock (qq) {
    this.#assertLoaded()
    const key = qq == null ? '' : String(qq).trim()
    const session = this.sessions.get(key)
    if (session) {
      clearBuffer(session.dek)
      this.sessions.delete(key)
    }
    this.#clearGrantSessions(key)
    return { ok: true }
  }

  lockAll () {
    this.#assertLoaded()
    for (const session of this.sessions.values()) clearBuffer(session.dek)
    this.sessions.clear()
    for (const perGrantee of this.grantMap.values()) {
      for (const session of perGrantee.values()) clearBuffer(session.key)
    }
    this.grantMap.clear()
    return { ok: true }
  }

  // ------------------------------------------------------------ payload 读写

  #readPayload (dek, box, aad, label) {
    const buf = open(dek, box, aad)
    try {
      const parsed = JSON.parse(buf.toString('utf8'))
      if (!isPlainObject(parsed)) throw new VaultError('BAD_FILE', label + '结构不正确')
      return parsed
    } catch (err) {
      if (err instanceof VaultError) throw err
      throw new VaultError('BAD_FILE', label + '无法解析')
    } finally {
      clearBuffer(buf)
    }
  }

  #openUserPayload (qq, rec, dek) {
    if (!isPlainObject(rec.payload)) throw new VaultError('BAD_FILE', '用户数据缺少密文')
    const payload = this.#readPayload(dek, rec.payload, userAad(qq), '用户数据')
    if (!Array.isArray(payload.bindings)) payload.bindings = []
    return payload
  }

  #payloadFor (qq) {
    const key = qq == null ? '' : String(qq).trim()
    const rec = this.#mustRecord(key)
    const session = this.#liveSession(key)
    if (!session) throw new VaultError('LOCKED')
    return { rec, dek: session.dek, payload: this.#openUserPayload(key, rec, session.dek) }
  }

  /** 加密 payload 并落盘（必须在队列任务里调用）。 */
  async #persistUserPayload (qq, rec, dek, bindings) {
    rec.payload = sealJson(dek, { v: 1, bindings }, userAad(qq))
    rec.meta = this.#metaFromPayload(bindings)
    rec.updatedAt = this.now()
    await this.#writeVaultNow()
  }

  /**
   * 串行的「读 payload -> 改 -> 加密 -> 落盘」。
   * fn 收到可改的 payload，返回值原样透传给调用方。
   */
  #withUser (qq, fn) {
    const key = qq == null ? '' : String(qq).trim()
    return this.#enqueue(async () => {
      const { rec, dek, payload } = this.#payloadFor(key)
      const out = await fn({ rec, dek, payload, qq: key })
      await this.#persistUserPayload(key, rec, dek, payload.bindings)
      return out
    })
  }

  /**
   * 机器主密钥（惰性创建）：免安全码账号的 DEK 用它包着。
   * 文件 0600、32 字节随机；和 vault.json 放在同一个目录。
   * 拿得到这个目录的人就能解开免码账号的秘密 —— 这是「免安全码」的必然代价，不是疏漏。
   */
  async #hostKek () {
    // 返回副本：调用方普遍 clearBuffer(kek)，直接交出内部缓存会把主密钥清零。
    if (this._hostKey) return Buffer.from(this._hostKey)
    try {
      const buf = await readFile(this.files.hostKey)
      if (Buffer.isBuffer(buf) && buf.length === 32) {
        this._hostKey = buf
        await chmod(this.files.hostKey, 0o600).catch(() => {})
        return Buffer.from(buf)
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw new VaultError('BAD_FILE', '读取本机主密钥失败：' + ((error && error.message) || error))
    }
    const fresh = randomBytes(32)
    const tmp = this.files.hostKey + '.' + process.pid.toString(36) + '.tmp'
    const handle = await openFile(tmp, 'w', 0o600)
    try {
      await handle.writeFile(fresh)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.files.hostKey)
    await chmod(this.files.hostKey, 0o600).catch(() => {})
    this._hostKey = fresh
    return Buffer.from(fresh)
  }


  /** 这条记录的 DEK 能不能用给定的主密钥解开（解不开 = 老版本遗留，需要重建）。 */
  #canDecrypt (kek, key, rec) {
    if (!kek || !rec || !rec.wrapped) return false
    try {
      unwrapKey(kek, rec.wrapped, userAad(key))
      return true
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------ 注册 / 解锁

  /**
   * 建号（幂等）。
   *
   * 顺带处理一种历史状态：老版本用安全码加密的记录，现在没有安全码已经解不开了。
   * 遇到这种记录就**替换**成一条新记录（等于让用户重新登录一次），
   * 而不是把人卡在「有记录但永远解不开」的死路上。
   */
  async register (qq) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    const existed = await this.#enqueue(async () => {
      const now = this.now()
      const dek = randomBytes(32)
      let kek = null
      try {
        kek = await this.#hostKek()
        const existing = this.#record(key)
        // 已有且解得开 → 幂等返回；解不开（老版本遗留）→ 覆盖重建
        if (existing && this.#canDecrypt(kek, key, existing)) return true
        this.db.users[key] = {
          v: 1,
          wrapped: wrapKey(kek, dek, userAad(key)),
          payload: sealJson(dek, { v: 1, bindings: [] }, userAad(key)),
          meta: this.#metaFromPayload([]),
          createdAt: now,
          updatedAt: now,
          lastSeenAt: 0,
          prefs: defaultPrefs()
        }
        await this.#writeVaultNow()
        // 建号即可用：把刚生成的 DEK 直接放进会话，调用方不用再 unlock 一次
        const previous = this.sessions.get(key)
        if (previous) clearBuffer(previous.dek)
        this.sessions.set(key, { dek, until: now + this.lockMinutes * 60000 })
        return false
      } catch (error) {
        clearBuffer(dek)
        throw error
      } finally {
        if (kek) clearBuffer(kek)
      }
    })
    return { ok: true, existed }
  }


  /**
   * 「解锁」= 把这个用户的 DEK 解进内存会话。没有用户输入：钥匙在本机 host-key.bin。
   * 会话只决定 DEK 缓存多久，以及授权路径「所有者数据现解现用」的语义。
   */
  async unlock (qq) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    return this.#enqueue(async () => {
      const rec = this.#record(key)
      if (!rec) throw new VaultError('NO_USER')
      let dek = null
      let kek = null
      try {
        kek = await this.#hostKek()
        dek = unwrapKey(kek, rec.wrapped, userAad(key))
      } catch {
        throw new VaultError('BAD_FILE', '本机主密钥解不开这个账号的数据（host-key.bin 可能被换过）')
      } finally {
        if (kek) clearBuffer(kek)
      }

      const until = this.now() + this.lockMinutes * 60000
      const previous = this.sessions.get(key)
      if (previous) clearBuffer(previous.dek)
      this.sessions.set(key, { dek, until })
      rec.lastSeenAt = this.now()
      await this.#writeVaultNow()
      return { ok: true, until }
    })
  }


  async wipeUser (qq) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    const removed = await this.#enqueue(async () => {
      if (!this.#record(key)) throw new VaultError('NO_USER')
      delete this.db.users[key]
      const before = this.grantsDb.grants.length
      this.grantsDb.grants = this.grantsDb.grants.filter(
        (grant) => String(grant.ownerQQ) !== key && String(grant.granteeQQ) !== key
      )
      await this.#writeVaultNow()
      if (this.grantsDb.grants.length !== before) await this.#writeGrantsNow()
      return { ok: true, removedGrants: before - this.grantsDb.grants.length }
    })
    this.lock(key)
    await this.audit({ actor: key, action: 'wipe', ok: true, note: '删除用户及其授权' })
    return removed
  }

  // ------------------------------------------------------------ 绑定

  #validatePrinterInput (raw, { requireIp }) {
    if (!isPlainObject(raw)) throw new VaultError('BAD_INPUT', '打印机条目格式不正确')
    const serial = String(raw.serial == null ? '' : raw.serial).trim()
    if (!SERIAL_RE.test(serial)) throw new VaultError('BAD_INPUT', '序列号不正确')
    const ip = raw.ip == null ? '' : String(raw.ip).trim()
    if (requireIp && !isHost(ip)) throw new VaultError('BAD_INPUT', '打印机地址不正确')
    if (ip && !isHost(ip)) throw new VaultError('BAD_INPUT', '打印机地址不正确')
    const entry = {
      serial,
      ip,
      name: raw.name == null ? '' : String(raw.name).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40),
      model: raw.model == null ? '' : String(raw.model).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40)
    }
    if (raw.accessCode != null && String(raw.accessCode).trim()) {
      const code = String(raw.accessCode).trim()
      if (!CODE_RE.test(code)) throw new VaultError('BAD_INPUT', '访问码格式不正确')
      entry.accessCode = code
    }
    // 自签名证书固定记录：只有指纹和 PEM，不参与输入校验的正则之外的东西
    if (isPlainObject(raw.certs)) {
      const clean = {}
      for (const slot of ['mqtt', 'camera']) {
        const item = raw.certs[slot]
        if (!isPlainObject(item)) continue
        const fingerprint = String(item.fingerprint256 || '').replace(/:/g, '').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(fingerprint)) continue
        clean[slot] = {
          pem: String(item.pem || ''),
          fingerprint256: fingerprint,
          subject: String(item.subject || '').slice(0, 120),
          notAfter: Number(item.notAfter) || 0,
          pinnedAt: Number(item.pinnedAt) || 0,
        }
      }
      if (Object.keys(clean).length) entry.certs = clean
    }
    return entry
  }

  /** 在队列外做纯校验，队列内只做「读 -> 改 -> 写」。 */
  #prepareBinding (input, currentCount) {
    const mode = String(input.mode == null ? '' : input.mode).trim().toLowerCase()
    if (mode !== 'lan' && mode !== 'cloud') throw new VaultError('BAD_INPUT', '模式只能是 lan 或 cloud')
    const label = input.label == null || !String(input.label).trim()
      ? '绑定 ' + (currentCount + 1)
      : text(input.label, '名称', { min: 1, max: 40 })

    const secret = {}
    const printers = []
    const seen = new Set()
    if (mode === 'lan') {
      const bindingCode = input.accessCode == null ? '' : String(input.accessCode).trim()
      if (bindingCode && !CODE_RE.test(bindingCode)) throw new VaultError('BAD_INPUT', '访问码格式不正确')
      const rawList = Array.isArray(input.printers) ? input.printers : []
      if (!rawList.length) throw new VaultError('BAD_INPUT', '局域网绑定至少需要一台打印机')
      for (const raw of rawList) {
        const printer = this.#validatePrinterInput(raw, { requireIp: true })
        if (seen.has(printer.serial)) continue
        if (!printer.accessCode && !bindingCode) {
          throw new VaultError('BAD_INPUT', '缺少访问码（扫码或打印机屏幕上的访问码）')
        }
        seen.add(printer.serial)
        printers.push(printer)
      }
      if (bindingCode) secret.accessCode = bindingCode
    } else {
      const token = input.accessToken == null ? '' : String(input.accessToken).trim()
      if (token.length < 8 || /[\r\n\t]/.test(token)) throw new VaultError('BAD_INPUT', '访问令牌不正确')
      const uid = String(input.uid == null ? '' : input.uid).trim()
      if (!QQ_RE.test(uid)) throw new VaultError('BAD_INPUT', '用户 ID 不正确')
      const region = String(input.region == null ? '' : input.region).trim().toLowerCase() || 'us'
      if (!REGIONS.includes(region)) throw new VaultError('BAD_INPUT', '区域只能是 us / eu / cn')
      secret.accessToken = token
      secret.uid = uid
      secret.region = region
      const rawList = Array.isArray(input.printers) ? input.printers : []
      for (const raw of rawList) {
        const printer = this.#validatePrinterInput(raw, { requireIp: false })
        if (seen.has(printer.serial)) continue
        seen.add(printer.serial)
        printers.push(printer)
      }
    }
    return { label, mode, secret, printers }
  }

  async addBinding (qq, input = {}) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    // 没有安全码之后，「有没有会话」只是缓存状态：过期或被 lock 过就自动续上，
    // 不该让用户在写操作时撞到 LOCKED。
    if (!this.#liveSession(key)) await this.unlock(key)
    if (!isPlainObject(input)) throw new VaultError('BAD_INPUT')
    const prep = this.#prepareBinding(input, this.#bindingCount(key))
    const now = this.now()
    const binding = { id: newId('b'), label: prep.label, mode: prep.mode, secret: prep.secret, printers: prep.printers, createdAt: now }
    if (prep.mode === 'cloud') binding.discoveredAt = now

    const view = await this.#withUser(key, ({ rec, payload }) => {
      if (payload.bindings.length >= this.maxBindings) {
        throw new VaultError('BAD_INPUT', '绑定数量已达上限（' + this.maxBindings + '）')
      }
      payload.bindings.push(binding)
      rec.lastSeenAt = now
      return this.#bindingMetaView(binding)
    })
    await this.audit({
      actor: key,
      action: 'bind',
      target: binding.id,
      ok: true,
      note: prep.mode + ' 绑定「' + prep.label + '」' + prep.printers.length + ' 台'
    })
    return { ok: true, id: binding.id, binding: view }
  }

  #bindingCount (qq) {
    const rec = this.#record(qq)
    const list = rec && rec.meta && Array.isArray(rec.meta.bindings) ? rec.meta.bindings : []
    return list.length
  }

  #bindingMetaView (binding) {
    return {
      id: binding.id,
      label: binding.label,
      mode: binding.mode,
      printers: (binding.printers || []).map((p) => ({ serial: p.serial, name: p.name || '', model: p.model || '' })),
      createdAt: binding.createdAt || 0
    }
  }

  #mustBinding (payload, id) {
    const bindingId = String(id == null ? '' : id).trim()
    const binding = (payload.bindings || []).find((b) => String(b.id) === bindingId)
    if (!binding) throw new VaultError('NOT_FOUND', '找不到该绑定')
    return binding
  }

  async setDiscoveredPrinters (qq, id, printers) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    const list = Array.isArray(printers) ? printers : []
    const next = []
    const seen = new Set()
    for (const raw of list) {
      const entry = this.#validatePrinterInput(raw, { requireIp: false })
      if (seen.has(entry.serial)) continue
      seen.add(entry.serial)
      next.push(entry)
    }
    const result = await this.#withUser(key, ({ payload }) => {
      const binding = this.#mustBinding(payload, id)
      for (const entry of next) {
        // 云端发现时保留手工填过的访问码（用户手动覆盖优先于 dev_access_code）
        const previous = (binding.printers || []).find((p) => p.serial === entry.serial)
        if (!entry.accessCode && previous && previous.accessCode) entry.accessCode = previous.accessCode
      }
      binding.printers = next
      binding.discoveredAt = this.now()
      return { ok: true, printers: next.length, binding: this.#bindingMetaView(binding) }
    })
    await this.audit({ actor: key, action: 'discover', target: String(id), ok: true, note: '写入 ' + next.length + ' 台打印机' })
    return result
  }

  /**
   * 记录打印机的自签名证书（首次连接时自动学习到的）。
   * 证书本体加密存在 payload 里；meta 只放指纹（不含任何可被冒充用的材料）。
   * 再次记录到同一台打印机但指纹变了 = 打印机证书被换了（重刷固件 / 别人在冒充），
   * 除非 force=true，否则拒绝覆盖并把旧指纹报回去，让上层提示用户确认。
   */
  async setPrinterCert (qq, printerRef, info, { force = false } = {}) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    const pem = String((info && info.pem) || '')
    const fingerprint = String((info && info.fingerprint256) || '').replace(/:/g, '').toLowerCase()
    if (!pem || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new VaultError('BAD_INPUT', '证书格式不正确')
    const bindingId = String((printerRef && printerRef.bindingId) || printerRef || '')
    const serial = String((printerRef && printerRef.serial) || '')
    const port = Number(printerRef && printerRef.certPort) || 0
    const result = await this.#withUser(key, ({ payload }) => {
      const binding = this.#mustBinding(payload, bindingId)
      const printer = (binding.printers || []).find((p) => String(p.serial) === serial)
      if (!printer) throw new VaultError('NOT_FOUND', '找不到这台打印机')
      const store = isPlainObject(printer.certs) ? printer.certs : {}
      // 三个端口各有各的证书槽：8883 = MQTT 控制面，6000 = MJPEG 画面，322 = RTSPS 画面。
      // 以前只分 camera / mqtt 两槽，:322 会掉进 mqtt 槽把控制面的锚点覆盖掉。
      const slot = port === 6000 ? 'camera' : (port === 322 ? 'rtsps' : 'mqtt')
      const previous = store[slot]
      if (previous && previous.fingerprint256 && previous.fingerprint256 !== fingerprint) {
        if (!force) throw new VaultError('CERT_CHANGED', '这台打印机的证书和上次不一样了（可能是重刷固件，也可能有人在冒充），确认是本人操作后再替换')
      }
      store[slot] = {
        pem,
        fingerprint256: fingerprint,
        subject: String((info && info.subject) || '').slice(0, 120),
        notAfter: Number((info && info.notAfter) || 0),
        pinnedAt: this.now(),
      }
      printer.certs = store
      return { ok: true, slot, fingerprint256: fingerprint, replaced: Boolean(previous && previous.fingerprint256 !== fingerprint) }
    })
    await this.audit({ actor: key, action: 'pin-cert', target: serial || bindingId, ok: true, note: (result.slot === 'camera' ? '摄像头' : result.slot === 'rtsps' ? 'RTSPS 画面' : 'MQTT') + ' 证书指纹 ' + fingerprint.slice(0, 12) })
    return result
  }

  async removeBinding (qq, id) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    const bindingId = String(id == null ? '' : id).trim()
    const result = await this.#withUser(key, ({ rec, payload }) => {
      const binding = this.#mustBinding(payload, id)
      payload.bindings = payload.bindings.filter((b) => b.id !== binding.id)
      if (this.#prefRefBinding(rec.prefs.selectedPrinter) === binding.id) rec.prefs.selectedPrinter = ''
      return { ok: true, label: binding.label }
    })
    await this.audit({ actor: key, action: 'unbind', target: bindingId, ok: true, note: '删除绑定「' + result.label + '」' })
    return { ok: true }
  }

  #prefRefBinding (ref) {
    const value = String(ref || '')
    const idx = value.indexOf(':')
    return idx > 0 ? value.slice(0, idx) : value
  }

  async renameBinding (qq, id, label) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    const nextLabel = text(label, '名称', { min: 1, max: 40 })
    const view = await this.#withUser(key, ({ payload }) => {
      const binding = this.#mustBinding(payload, id)
      binding.label = nextLabel
      return this.#bindingMetaView(binding)
    })
    await this.audit({ actor: key, action: 'rename', target: String(id), ok: true, note: '改名为「' + nextLabel + '」' })
    return { ok: true, binding: view }
  }

  // ------------------------------------------------------------ 列表 / 解析

  listBindings (qq) {
    this.#assertLoaded()
    const rec = this.#record(qq)
    if (!rec) return []
    const session = this.#liveSession(qq)
    if (session) {
      const payload = this.#openUserPayload(String(qq).trim(), rec, session.dek)
      return payload.bindings.map((b) => this.#bindingView(b, true))
    }
    const meta = rec.meta && Array.isArray(rec.meta.bindings) ? rec.meta.bindings : []
    return meta.map((b) => this.#bindingView(b, false))
  }

  #bindingView (binding, unlocked) {
    const mode = binding.mode === 'cloud' ? 'cloud' : 'lan'
    const secret = isPlainObject(binding.secret) ? binding.secret : {}
    const printers = (Array.isArray(binding.printers) ? binding.printers : []).map((p) => ({
      serial: String(p.serial || ''),
      ip: String(p.ip || ''),
      name: String(p.name || ''),
      model: String(p.model || '')
    }))
    let tokenMask = ''
    if (unlocked) {
      if (mode === 'cloud' && secret.accessToken) tokenMask = maskSecret(secret.accessToken)
      else if (mode === 'lan' && secret.accessCode) tokenMask = maskSecret(secret.accessCode)
    }
    return {
      id: String(binding.id || ''),
      label: String(binding.label || ''),
      mode,
      printers,
      createdAt: Number(binding.createdAt) || 0,
      tokenMask,
      unlocked: !!unlocked
    }
  }

  /**
   * 构建 printerRef 列表。withSecret=false 时只给元数据（未解锁 / 反问候选）。
   * LAN 的有效访问码 = 该打印机的 accessCode || 绑定级 accessCode（覆盖优先）。
   */
  #buildRefs (bindings, withSecret) {
    const refs = []
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      const mode = binding.mode === 'cloud' ? 'cloud' : 'lan'
      const secret = isPlainObject(binding.secret) ? binding.secret : {}
      const list = Array.isArray(binding.printers) ? binding.printers : []
      list.forEach((printer, index) => {
        // 云端设备在 listDevices 时可能带回局域网地址 + 访问码（dev_ip / dev_access_code），
        // 那就让它也能走局域网协议（状态/控制/拍照都更快更稳）。
        const printerCode = String(printer.accessCode || '')
        const bindingCode = String(secret.accessCode || '')
        const accessCode = printerCode || bindingCode
        const token = String(secret.accessToken || '')
        const ref = {
          ref: String(binding.id) + ':' + index,
          bindingId: String(binding.id || ''),
          bindingLabel: String(binding.label || ''),
          mode,
          index,
          serial: String(printer.serial || ''),
          ip: String(printer.ip || ''),
          name: String(printer.name || ''),
          model: String(printer.model || ''),
          tokenMask: maskSecret(mode === 'cloud' ? token : accessCode),
          secretAvailable: withSecret ? (mode === 'lan' ? !!(accessCode || token) : !!token) : false
        }
        if (withSecret) {
          // 自签名证书信任锚点：有就带出去（mqtt 用），没有就让上层先学
          const certs = isPlainObject(printer.certs) ? printer.certs : {}
          ref.tlsCa = String((certs.mqtt && certs.mqtt.pem) || '')
          ref.tlsFingerprint = String((certs.mqtt && certs.mqtt.fingerprint256) || '')
          ref.cameraCa = String((certs.camera && certs.camera.pem) || '')
          ref.cameraFingerprint = String((certs.camera && certs.camera.fingerprint256) || '')
          // RTSPS(:322) 的证书是**另一个**端口的，必须单独带出来：index 用它对 ffmpeg 抓拍做 pin 比对。
          ref.rtspsCa = String((certs.rtsps && certs.rtsps.pem) || '')
          ref.rtspsFingerprint = String((certs.rtsps && certs.rtsps.fingerprint256) || '')
          // 字段集合固定，index 的 targetOf 可以直接取用（缺省是空串，不 undefined）
          ref.accessCode = accessCode
          ref.accessToken = token
          ref.uid = String(secret.uid || '')
          ref.region = mode === 'cloud' ? String(secret.region || 'us') : ''
          ref.secret = mode === 'lan'
            ? { mode, accessCode, ip: ref.ip, serial: ref.serial }
            : { mode, accessToken: token, uid: ref.uid, region: ref.region, ip: ref.ip, accessCode }
        }
        refs.push(ref)
      })
    }
    return refs
  }

  printers (qq) {
    this.#assertLoaded()
    const rec = this.#record(qq)
    if (!rec) return []
    const session = this.#liveSession(qq)
    if (session) {
      const payload = this.#openUserPayload(String(qq).trim(), rec, session.dek)
      return this.#buildRefs(payload.bindings, true)
    }
    const meta = rec.meta && Array.isArray(rec.meta.bindings) ? rec.meta.bindings : []
    return this.#buildRefs(meta, false)
  }

  #matchRefs (refs, selector) {
    const raw = selector == null ? '' : String(selector).trim()
    if (!refs.length) return []
    if (!raw) return refs.length === 1 ? [refs[0]] : refs.slice()
    const lower = raw.toLowerCase()
    const byRef = refs.filter((r) => r.ref.toLowerCase() === lower)
    if (byRef.length) return byRef
    const bySerial = refs.filter((r) => String(r.serial || '').toLowerCase() === lower)
    if (bySerial.length) return bySerial
    const byLabel = refs.filter((r) => String(r.bindingLabel || '').toLowerCase() === lower)
    if (byLabel.length) return byLabel
    if (/^\d{1,3}$/.test(raw)) {
      const index = Number(raw)
      if (index >= 1 && index <= refs.length) return [refs[index - 1]]
    }
    return refs.filter((r) => [r.name, r.model, r.bindingLabel, r.serial].some((value) => String(value || '').toLowerCase().includes(lower)))
  }

  resolve (qq, selector) {
    this.#assertLoaded()
    const refs = this.printers(qq)
    const matches = this.#matchRefs(refs, selector)
    if (matches.length === 1) return { match: matches[0], candidates: [] }
    if (matches.length === 0) return { match: null, candidates: [] }
    return { match: null, candidates: matches.map(publicPrinterRef) }
  }

  /** 只在明确要求时返回秘密；必须已解锁。 */
  secretOf (qq, bindingId) {
    this.#assertLoaded()
    const { payload } = this.#payloadFor(qq)
    const binding = this.#mustBinding(payload, bindingId)
    const secret = isPlainObject(binding.secret) ? binding.secret : {}
    if (binding.mode === 'cloud') {
      return {
        mode: 'cloud',
        accessToken: String(secret.accessToken || ''),
        uid: String(secret.uid || ''),
        region: String(secret.region || 'us')
      }
    }
    return { mode: 'lan', accessCode: String(secret.accessCode || '') }
  }

  // ------------------------------------------------------------ 偏好

  /** 未解锁（或不认识这个用户）时只给安全默认值，绝不因为会话过期而「放开」显示。 */
  prefs (qq) {
    // 空 qq / 未加载 / 未知用户都安全返回默认值（load() 之后可直接调，不抛错）
    const rec = this.#record(qq)
    if (!rec) return defaultPrefs()
    if (!this.#liveSession(qq)) return defaultPrefs()
    return readPrefs(rec.prefs)
  }

  /**
   * 非秘密偏好（群权限 / 拍照 / 文件名 / 接口），未解锁也能读。
   * 只含白名单字段，绝不带 selectedPrinter 之外的任何东西，更不带秘密。
   */
  publicPrefs (qq) {
    const rec = this.#record(qq)
    if (!rec) return defaultPrefs()
    return readPrefs(rec.prefs)
  }

  async setPrefs (qq, patch = {}) {
    this.#assertLoaded()
    const key = assertQQ(qq)
    if (!isPlainObject(patch)) throw new VaultError('BAD_INPUT')
    if (!this.#liveSession(key)) throw new VaultError('LOCKED')
    const next = {}
    if (Object.prototype.hasOwnProperty.call(patch, 'groupShowName')) next.groupShowName = patch.groupShowName === true
    if (Object.prototype.hasOwnProperty.call(patch, 'selectedPrinter')) {
      const value = patch.selectedPrinter == null ? '' : String(patch.selectedPrinter).trim()
      if (value.length > 80) throw new VaultError('BAD_INPUT', '打印机标记过长')
      next.selectedPrinter = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'groupMode')) {
      const value = patch.groupMode == null ? '' : String(patch.groupMode).trim().toLowerCase()
      if (!PREF_GROUP_MODES.includes(value)) throw new VaultError('BAD_INPUT', '群权限只能跟随全局、off、status 或 control')
      next.groupMode = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'groupPhoto')) {
      if (patch.groupPhoto === null || patch.groupPhoto === '') next.groupPhoto = null
      else next.groupPhoto = patch.groupPhoto === true
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'interface')) {
      const value = patch.interface == null ? '' : String(patch.interface).trim().toLowerCase()
      if (!PREF_INTERFACES.includes(value)) {
        throw new VaultError('BAD_INPUT', '网络接口只能是空、cloud、lan 或 auto')
      }
      next.interface = value
    }
    const prefs = await this.#enqueue(async () => {
      const rec = this.#mustRecord(key)
      Object.assign(rec.prefs, next)
      rec.updatedAt = this.now()
      await this.#writeVaultNow()
      return readPrefs(rec.prefs)
    })
    return { ok: true, prefs }
  }

  // ------------------------------------------------------------ 授权
  //
  // 授权的语义：A 把自己的 Bambu 凭据「限时借给」B。B 拿到后能查看/管理 A 选中的打印机，
  // 用的就是 A 的凭据（所以 B 不需要自己绑打印机，也不需要 A 交安全码）。
  //
  // 实现上不再有「授权码 + 兑换」：那一步原本是为了让授权码充当分享密钥，现在既然
  // 目标 QQ 是明确写下来的，就直接按 QQ 生效 —— 少一次人工转发，也少一个能泄露的字符串。
  // 秘密仍然只加密存在 A 自己的保险箱里：B 的需求在运行时由 A 的 DEK 现解现用，
  // 内存里只有短暂解出的 ref，随时撤销、到期即失效，磁盘上不会多一份可解密的副本。

  #activeGrants () {
    const now = this.now()
    return this.grantsDb.grants.filter((g) => !g.revokedAt && Number(g.expiresAt) > now)
  }

  #grantRecord (grantId) {
    const id = grantId == null ? '' : String(grantId).trim()
    return this.grantsDb.grants.find((g) => String(g.id) === id) || null
  }

  #grantLive (grant) {
    return !!grant && !grant.revokedAt && Number(grant.expiresAt) > this.now()
  }

  /**
   * A 授权给 B：立刻生效（B 不需要兑换），到期自动失效，A/ B 都能随时撤销。
   * bindingIds 为空 = A 当前全部绑定。
   */
  async createGrant ({ ownerQQ, granteeQQ, bindingIds, scopes, minutes } = {}) {
    this.#assertLoaded()
    const owner = assertQQ(ownerQQ)
    const grantee = assertQQ(granteeQQ)
    if (owner === grantee) throw new VaultError('BAD_INPUT', '不用授权给自己')
    const chosen = normalizeScopes(scopes)
    const life = clampMinutes(minutes, DEFAULT_GRANT_MINUTES, 1, MAX_GRANT_MINUTES)
    const wanted = Array.isArray(bindingIds) ? bindingIds.map((id) => String(id == null ? '' : id).trim()).filter(Boolean) : []

    const created = await this.#enqueue(async () => {
      // 必须 A 已解锁：要读 A 的 payload 才知道有哪些绑定（但秘密不复制出来）。
      const { payload } = this.#payloadFor(owner)
      const selected = wanted.length ? wanted.map((id) => this.#mustBinding(payload, id)) : payload.bindings.slice()
      if (!selected.length) throw new VaultError('NOT_FOUND', '没有可授权的绑定')
      const now = this.now()
      const expiresAt = now + life * 60000
      const grantId = newId('g')
      // 只落「谁授权给谁、哪几台（id + 展示用元数据）、什么范围、到什么时候」，
      // 没有任何秘密、也没有能解出秘密的密钥。
      this.grantsDb.grants.push({
        id: grantId,
        ownerQQ: owner,
        granteeQQ: grantee,
        scopes: chosen,
        bindings: selected.map((binding) => ({
          id: String(binding.id),
          label: String(binding.label || ''),
          mode: binding.mode === 'cloud' ? 'cloud' : 'lan',
          printers: (binding.printers || []).map((p) => ({
            serial: String(p.serial || ''),
            name: String(p.name || ''),
            model: String(p.model || '')
          }))
        })),
        createdAt: now,
        expiresAt,
        revokedAt: 0
      })
      await this.#writeGrantsNow()
      return { grantId, expiresAt, count: selected.length }
    })
    await this.audit({
      actor: owner,
      action: 'grant',
      target: created.grantId,
      ok: true,
      note: '授权给 ' + grantee + '，' + created.count + ' 个绑定，' + life + ' 分钟'
    })
    return { ok: true, grantId: created.grantId, expiresAt: created.expiresAt, scopes: chosen, count: created.count }
  }

  /** 某个人身上所有仍然有效的授权（不需要兑换记录）。 */
  #liveGrantSessions (granteeQQ) {
    const grantee = granteeQQ == null ? '' : String(granteeQQ).trim()
    if (!grantee) return []
    return this.grantsDb.grants
      .filter((g) => String(g.granteeQQ) === grantee && this.#grantLive(g))
      .map((g) => ({
        grantId: String(g.id),
        ownerQQ: String(g.ownerQQ),
        scopes: Array.isArray(g.scopes) ? g.scopes.slice() : SCOPES.slice(),
        expiresAt: Number(g.expiresAt)
      }))
  }

  grantSessions (granteeQQ) {
    this.#assertLoaded()
    return this.#liveGrantSessions(granteeQQ)
  }

  /**
   * 某条授权里现在能用的 printerRefs。
   * 需要**所有者当前已解锁**：秘密只从所有者自己的保险箱现解，不另存副本。
   */
  #grantRefs (grant) {
    const owner = String(grant.ownerQQ)
    let payload
    try {
      payload = this.#payloadFor(owner).payload
    } catch (error) {
      if (error instanceof VaultError && error.code === 'LOCKED') {
        throw new VaultError('OWNER_LOCKED', '这台打印机的主人现在没解锁，凭据取不出来：让对方私聊随便发一条打印机命令（比如「/打印机 状态」），密钥会自动恢复，再试一次就行。')
      }
      throw error
    }
    const ids = (Array.isArray(grant.bindings) ? grant.bindings : []).map((b) => String(b && b.id)).filter(Boolean)
    const picked = ids.length ? payload.bindings.filter((b) => ids.includes(String(b.id))) : payload.bindings
    return this.#buildRefs(picked, true)
  }

  /** 某条授权里的全部打印机 ref（含秘密，只在模块内存里用）。 */
  grantedPrinters (granteeQQ, grantId) {
    this.#assertLoaded()
    const id = grantId == null ? '' : String(grantId).trim()
    const grant = this.#grantRecord(id)
    if (!grant || String(grant.granteeQQ) !== String(granteeQQ == null ? '' : granteeQQ).trim()) {
      return { ok: false, code: 'NOT_FOUND', message: '找不到该授权', printers: [] }
    }
    if (!this.#grantLive(grant)) return { ok: false, code: 'EXPIRED', message: VAULT_MESSAGES.EXPIRED, printers: [] }
    let printers
    try {
      printers = this.#grantRefs(grant)
    } catch (error) {
      const code = error instanceof VaultError ? error.code : 'EXPIRED'
      return { ok: false, code, message: error && error.message ? error.message : VAULT_MESSAGES.EXPIRED, printers: [] }
    }
    return {
      ok: true,
      grantId: String(grant.id),
      ownerQQ: String(grant.ownerQQ),
      scopes: (Array.isArray(grant.scopes) ? grant.scopes : SCOPES).slice(),
      expiresAt: Number(grant.expiresAt),
      printers
    }
  }

  #clearGrantSessions () {
    // 授权不再持有内存会话（每次从所有者的保险箱现解），这里只保留调用点兼容。
  }

  #dropGrantSession () {
    // 同上：没有可清理的会话密钥。
  }

  /**
   * 在有效的授权里按 selector 找打印机。
   * 第二参数可以是 grantId、ownerQQ 或打印机 selector；为空且只有一个授权时直接给全部打印机。
   */
  grantTargets (granteeQQ, grantIdOrOwnerQQ) {
    this.#assertLoaded()
    const sessions = this.#liveGrantSessions(granteeQQ)
    const empty = { match: null, candidates: [], scopes: [], ownerQQ: '', grantId: '' }
    if (!sessions.length) return empty

    const raw = grantIdOrOwnerQQ == null ? '' : String(grantIdOrOwnerQQ).trim()
    let picked = sessions
    let selector = raw
    if (raw) {
      const byGrant = sessions.filter((s) => s.grantId === raw)
      if (byGrant.length) {
        picked = byGrant
        selector = ''
      } else {
        const byOwner = sessions.filter((s) => s.ownerQQ === raw)
        if (byOwner.length) {
          picked = byOwner
          selector = ''
        }
      }
    }

    const refs = []
    for (const session of picked) {
      const grant = this.#grantRecord(session.grantId)
      if (!grant) continue
      try {
        refs.push(...this.#grantRefs(grant))
      } catch {
        // 主人当前没解锁：这台暂时不可用，跳过
      }
    }

    const single = picked.length === 1 ? picked[0] : null
    const base = {
      scopes: [...new Set(picked.flatMap((s) => s.scopes))],
      ownerQQ: single ? single.ownerQQ : '',
      grantId: single ? single.grantId : ''
    }
    const matches = this.#matchRefs(refs, selector)
    if (matches.length === 1) return { ...base, match: matches[0], candidates: [] }
    return { ...base, match: null, candidates: matches.map(publicPrinterRef) }
  }

  async revokeGrant ({ byQQ, grantId, force = false } = {}) {
    this.#assertLoaded()
    const actor = assertQQ(byQQ)
    const id = grantId == null ? '' : String(grantId).trim()
    await this.#enqueue(async () => {
      const grant = this.#grantRecord(id)
      if (!grant) throw new VaultError('NOT_FOUND', '找不到该授权')
      if (!force && String(grant.ownerQQ) !== actor && String(grant.granteeQQ) !== actor) {
        throw new VaultError('FORBIDDEN')
      }
      if (!grant.revokedAt) {
        grant.revokedAt = this.now()
        await this.#writeGrantsNow()
      }
    })
    await this.audit({ actor, action: 'revoke', target: id, ok: true, note: '撤销授权' })
    return { ok: true }
  }

  listGrants () {
    this.#assertLoaded()
    const now = this.now()
    return this.grantsDb.grants.map((grant) => ({
      id: String(grant.id),
      ownerQQ: String(grant.ownerQQ),
      granteeQQ: String(grant.granteeQQ),
      scopes: Array.isArray(grant.scopes) ? grant.scopes.slice() : [],
      bindings: (Array.isArray(grant.bindings) ? grant.bindings : []).map((b) => ({
        id: String(b && b.id),
        label: String(b && b.label || ''),
        mode: b && b.mode === 'cloud' ? 'cloud' : 'lan',
        count: Array.isArray(b && b.printers) ? b.printers.length : 0
      })),
      createdAt: Number(grant.createdAt) || 0,
      expiresAt: Number(grant.expiresAt) || 0,
      revoked: !!grant.revokedAt || Number(grant.expiresAt) <= now,
      revokedAt: Number(grant.revokedAt) || 0
    }))
  }

  // ------------------------------------------------------------ 审计

  /**
   * 追加一条审计。只记「谁、做了什么、成没成」+ 一段人类可读备注；
   * 备注去掉换行并截断，token / 访问码这类长串本来也不会传进来。
   */
  async audit (entry = {}) {
    this.#assertLoaded()
    const row = {
      at: this.now(),
      actor: String(entry.actor == null ? '' : entry.actor),
      action: String(entry.action == null ? '' : entry.action).slice(0, 40),
      ok: entry.ok !== false,
      target: String(entry.target == null ? '' : entry.target).slice(0, 80),
      note: sanitizeNote(entry.note)
    }
    this.auditRows.push(row)
    if (this.auditRows.length > AUDIT_MEMORY_ROWS) this.auditRows = this.auditRows.slice(-AUDIT_MEMORY_ROWS)
    try {
      await appendFile(this.files.audit, JSON.stringify(row) + '\n', { mode: 0o600 })
      await this.#maybeRotateAudit()
    } catch (err) {
      this.#logWarn('审计写入失败：' + ((err && err.message) || err))
    }
    return row
  }

  /** 最近的审计（新的在前）。 */
  auditList (limit = 50) {
    const n = Math.max(1, Math.min(AUDIT_MEMORY_ROWS, Math.floor(Number(limit) || 50)))
    return this.auditRows.slice(-n).reverse().map((row) => ({ ...row }))
  }

  /** 超过阈值就把当前文件换成 audit.1.jsonl（只留一代）。 */
  async #maybeRotateAudit () {
    try {
      const info = await stat(this.files.audit)
      if (info.size < AUDIT_MAX_BYTES) return
      await rename(this.files.audit, this.files.auditOld)
      await chmod(this.files.auditOld, 0o600).catch(() => {})
    } catch {
      // 轮转失败不影响主流程
    }
  }

  // ------------------------------------------------------------ 日志

  #logInfo (message) {
    if (this.log && typeof this.log.info === 'function') this.log.info('[bambu-print] ' + message)
  }

  #logWarn (message) {
    if (this.log && typeof this.log.warn === 'function') this.log.warn('[bambu-print] ' + message)
  }
}

/** 工厂函数（index 与测试都用这个，不用直接 new）。 */
export function createVault (options = {}) {
  return new Vault(options)
}

export default Vault
