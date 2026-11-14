// lib/envelope.mjs — 离线信封（BBX1）的服务端：私钥保管、一次性、有效期。
//
// 契约见 docs/ENVELOPE.md（二进制格式 + 服务端策略）与 docs/ENROLL.md（整体流程）。
// 加解密**只有一份实现**，在 assets/enroll/bbx.js：网页只能加密，这里只能解密。
// 本文件不写第二套加解密，只做「密钥文件 / 防重放 / 时间判定 / 对外形状」。
//
// 安全边界（和 lib/vault.mjs 同一套写法）：
//   * 私钥只在 bbx-key.json（0600，目录 0700，tmp+rename 原子写）和本进程内存里，
//     永不出现在返回值、日志、面板、聊天里。
//   * 文件存在但坏了 / kty 不对 → BAD_KEY，**拒绝静默重新生成**：静默换钥会让用户
//     已经贴出去的信封全部作废，而且没有任何人知道。
//   * 一次性：解密 + 校验通过后，先把 jti 记账落盘，再返回明文；同一个信封第二次
//     一定是 REPLAYED。失败的也作废（防止对着一个信封暴力试）。
//   * 日志只记错误码和 jti 前 4 字节；明文秘密只活在调用栈上，不缓存、不落盘。

import { chmod, mkdir, open as openFile, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  EnvelopeError as BbxEnvelopeError,
  MAX_TEXT,
  exportPrivateJwk,
  fromBase64Url,
  generateKeyPair,
  importPrivateJwk,
  openEnvelope,
  publicKeyToText
} from '../assets/enroll/bbx.js'

/**
 * 内置默认登录网页地址（作者仓库的 GitHub Pages，发布内容就是 assets/enroll/ 这个目录）。
 *
 * 注意：这是**这个仓库**的地址。别人 fork 之后应当把设置项 enrollBaseUrl 改成
 * 自己那份（否则用户点开的是别人的页面 —— 页面只能加密，偷不到私钥，但能偷用户输入）。
 * 用户 fork 之后应该在设置项 enrollBaseUrl 里改成自己部署的那份——
 * 内置这份只有仓库维护者能改，别人 fork 出来的机器人如果还用这个地址，
 * 点开的就是别人的页面（页面只能加密，偷不到私钥，但能偷用户在页面里输的明文）。
 */
export const DEFAULT_ENROLL_BASE = 'https://cdcp998.github.io/dsh-aurabot-qq-mods/'

/** 时钟偏移容忍（秒）：两边机器时间不可能完全一致。 */
const SKEW_SEC = 120
/** 已用记录超过这么多条就按 exp 淘汰最旧的（防止文件无限长）。 */
const USED_FILE_MAX = 5000
/** 已用记录的保留窗口：exp 过去超过 24 小时就可以忘掉（过期信封本来也解不开）。 */
const USED_KEEP_SEC = 24 * 60 * 60
/** 登录网页地址上限（docs/ENROLL.md：长度 < 300）。 */
const MAX_BASE_URL = 300
/** 允许出现在对外错误上的 code（其它一律折算成 IO，避免把内部细节漏出去）。 */
const ALLOWED_CODES = new Set([
  'NO_CRYPTO', 'NOT_READY', 'BAD_KEY', 'BAD_FORMAT', 'BAD_VERSION', 'BAD_SUITE', 'TOO_LARGE',
  'BAD_TAG', 'BAD_PAYLOAD', 'EXPIRED', 'NOT_YET', 'REPLAYED', 'BAD_INPUT', 'IO'
])

/** 所有对外的中文话术：都不含任何明文秘密，也不解释「具体哪一位不对」。 */
const MESSAGES = {
  NO_CRYPTO: '当前环境不支持 WebCrypto，信封功能不可用',
  NOT_READY: '信封服务还没准备好，请稍后再试',
  BAD_KEY: '私钥文件损坏，已拒绝自动重新生成（重新生成会让已经发出去的信封全部作废）',
  BAD_FORMAT: '这段不是本模块的信封（应该以 BBX1. 开头）',
  BAD_VERSION: '信封版本不支持，请刷新登录网页后重新生成',
  BAD_SUITE: '信封的加密套件不支持，请刷新登录网页后重新生成',
  TOO_LARGE: '这段太长了，不像是本模块的信封',
  BAD_TAG: '这段信封解不开：可能不是给这台机器的，或者内容被改过',
  BAD_PAYLOAD: '信封内容不正确',
  EXPIRED: '信封已过期，请重新生成一个',
  NOT_YET: '信封的签发时间比本机时间还晚，请检查两边的时钟',
  REPLAYED: '这个信封已经用过了，请重新生成一个',
  BAD_INPUT: '参数不正确',
  IO: '读写信封数据文件失败（检查数据目录的权限）'
}

/**
 * 服务端信封错误。code 与 assets/enroll/bbx.js 同一套，网页端抛出来的错误会原样透传。
 * message 一律中文，且永远不含明文秘密。
 */
export class EnvelopeError extends BbxEnvelopeError {
  constructor (code, message) {
    const key = code || 'IO'
    super(key, message || MESSAGES[key] || MESSAGES.IO)
    this.name = 'EnvelopeError'
    this.code = key
  }
}

function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 把任意异常折算成带合法 code 的 EnvelopeError；已经是本类就原样返回。 */
function asEnvelopeError (err, fallback = 'IO') {
  if (err instanceof EnvelopeError) return err
  if (err instanceof BbxEnvelopeError) {
    // bbx.js 的 code 大部分在允许表里（INTERNAL 之类不在）→ 不在的折算成 fallback，
    // 话术也换成我们自己的，避免把内部字符串漏给用户。
    const code = ALLOWED_CODES.has(err.code) ? err.code : fallback
    const message = code === err.code && err.message ? err.message : (MESSAGES[code] || MESSAGES.IO)
    return new EnvelopeError(code, message)
  }
  const raw = err && typeof err.code === 'string' ? err.code : ''
  const code = ALLOWED_CODES.has(raw) ? raw : fallback
  // 不把 fs / 系统异常原文（英文、带路径）透传出去。
  return new EnvelopeError(code, MESSAGES[code] || MESSAGES.IO)
}

/** 宽松夹取：设置里读出来的上限只夹不报错。 */
function clampSoft (value, fallback, min, max) {
  const raw = Number(value)
  if (value == null || value === '' || !Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.floor(raw)))
}

/** 规范化登录网页前缀：留空用内置默认，非 http(s) / 过长直接拒。 */
function resolveBase (value) {
  const raw = value == null ? '' : String(value).trim()
  if (!raw) return DEFAULT_ENROLL_BASE
  const clean = raw.split('#')[0].trim()
  if (!/^https?:\/\//i.test(clean)) {
    throw new EnvelopeError('BAD_INPUT', '登录网页地址必须以 http:// 或 https:// 开头')
  }
  if (clean.length >= MAX_BASE_URL) {
    throw new EnvelopeError('BAD_INPUT', '登录网页地址过长（最多 ' + (MAX_BASE_URL - 1) + ' 个字符）')
  }
  return clean
}

/** 信封只有一种用途：登录（账号密码必填，见 bbx.js 的 encodeBody）。 */
function kindOf () {
  return 'login'
}

/** 日志里只留 jti 前 4 字节（base64url 4 字节 = 6 个字符）。 */
function shortJti (jti) {
  const text = jti == null ? '' : String(jti)
  return text.slice(0, 6)
}

/**
 * 账号掩码：a***@b.com / 138****8000。
 * inspect 只回显这个，永远不出明文账号——它的作用就是「贴进来先看看对不对」。
 */
export function maskAccount (value) {
  const raw = value == null ? '' : String(value).trim()
  if (!raw) return ''
  const at = raw.indexOf('@')
  if (at > 0) {
    const name = raw.slice(0, at)
    const domain = raw.slice(at)
    const head = name.slice(0, 1)
    return head + '***' + domain
  }
  if (/^\+?[\d\s-]{6,}$/.test(raw)) {
    const digits = raw.replace(/[^\d+]/g, '')
    if (digits.length >= 8) return digits.slice(0, 3) + '****' + digits.slice(-4)
  }
  if (raw.length <= 2) return '*'.repeat(raw.length)
  return raw.slice(0, 2) + '*'.repeat(Math.min(6, Math.max(1, raw.length - 2)))
}

class EnvelopeService {
  constructor (options = {}) {
    const dir = options.dir == null ? '' : String(options.dir).trim()
    if (!dir) throw new EnvelopeError('BAD_INPUT', '必须提供数据目录 dir')
    this.dir = path.resolve(dir)
    /**
     * 密钥文件可以放在数据目录之外 —— 这是「把私钥托管到更严的地方」唯一真正可用的形态：
     * 由部署方把文件放进单独加密卷 / systemd credentials / 容器 secret 挂载 / Vault 注入的文件，
     * 模块只按绝对路径读写。空串 = 用数据目录里的 bbx-key.json。
     *
     * 注意：这里**只支持文件路径**，不支持「从网络拉一把私钥」。理由见 docs/ENROLL.md
     * 「能不能把私钥托管到 GitHub」那一节。
     */
    const keyPath = options.keyPath == null ? '' : String(options.keyPath).trim()
    if (keyPath && !path.isAbsolute(keyPath)) {
      throw new EnvelopeError('BAD_INPUT', '登录私钥路径要写绝对路径（相对路径会跟着工作目录变，不安全）')
    }
    this.keyPathCustom = !!keyPath
    this.files = {
      key: keyPath || path.join(this.dir, 'bbx-key.json'),
      used: path.join(this.dir, 'bbx-used.json')
    }
    this.log = options.log === null ? null : (options.log || console)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.maxTtlMinutes = clampSoft(options.maxTtlMinutes, 1440, 1, 1440)
    /**
     * 私钥存在哪。见 docs/ENROLL.md「私钥放在哪」：
     *   'file'      —— 落盘 bbx-key.json（0600）。默认，链接重启后仍然有效。
     *   'ephemeral' —— 只在内存里，进程一停就没了。磁盘上**没有任何可偷的私钥**，
     *                  代价是重启（含热重载）后旧链接失效，要重新 /打印机 登录 拿新的。
     * 两种都挡不住「在机器人运行期间 dump 进程内存」——见文档里那条「明确不解决」。
     */
    this.keyMode = options.keyMode === 'ephemeral' ? 'ephemeral' : 'file'
    /**
     * 「密钥在别处」时，**不要**在数据目录里另生成一份。
     * 否则用户以为用了外部托管，实际数据目录里还躺着一把能解密的私钥。
     */
    if (this.keyPathCustom && this.keyMode === 'ephemeral') {
      throw new EnvelopeError('BAD_INPUT', '「私钥路径」和「仅内存」不能同时设置：二选一')
    }
    this.queue = Promise.resolve()
    this._ready = null
    this._privateKey = null
    this._publicKey = ''
    this._fingerprint = ''
    this._keyCreatedAt = 0
    // 用 null 原型：jti 是 base64url，可能出现 "__proto__" 这种键。
    this._used = Object.create(null)
  }

  /**
   * 同步「允许的最大生存时间」。设置面板改了 enrollMaxTtlMinutes 之后装配层调它，
   * 不用重建服务（重建会丢掉已加载的私钥和已用记录队列）。
   * @param {number} minutes
   */
  setMaxTtlMinutes (minutes) {
    this.maxTtlMinutes = clampSoft(minutes, this.maxTtlMinutes, 1, 1440)
    return this.maxTtlMinutes
  }

  // ------------------------------------------------------------ 就绪 / 私钥

  /** 加载或首次生成私钥。幂等，可并发调用（同一个 promise）。 */
  ensure () {
    if (!this._ready) {
      this._ready = this.#setup().catch((err) => {
        this._ready = null // 失败允许下次重试（例如目录权限修好了）
        throw asEnvelopeError(err, 'IO')
      })
    }
    return this._ready
  }

  async #setup () {
    await this.#ensureDir()
    if (this.keyMode === 'ephemeral') {
      // 只放内存：不读也不写 bbx-key.json。
      //
      // 磁盘上如果还留着上一任（file 模式）的私钥，**必须删掉**，不能只是「不用它」：
      // 那把旧钥对应的公钥可能还印在用户手里的旧链接上，用户完全可能用旧链接生成一段新信封
      // 发过来（本模块会拒收），而那段密文会留在聊天记录里 —— 事后拿到数据目录的人
      // 用这把残留旧钥就能把它解开。留着它等于「仅内存」这个承诺是假的。
      await this.#purgeKeyFile()
      await this.#createKey({ persist: false })
      this.#logInfo('已生成仅内存私钥：指纹 ' + this._fingerprint + '（进程重启后失效）')
    } else {
      const record = await this.#readKeyRecord()
      if (record) {
        this.#adopt(record.key, record.publicKey, record.createdAt)
        this.#logInfo('已加载私钥：指纹 ' + this._fingerprint)
      } else {
        await this.#createKey()
        this.#logInfo('已生成新私钥：指纹 ' + this._fingerprint)
      }
    }
    await this.#loadUsed()
    this.#logInfo('信封服务就绪：已用记录 ' + this.stats().used + ' 条，上限 ' + this.maxTtlMinutes + ' 分钟')
    return this
  }

  async #ensureDir () {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
    } catch {
      throw new EnvelopeError('IO')
    }
    await chmod(this.dir, 0o700).catch(() => {})
  }

  /** 毫秒时间戳；注入的 now 返回 0 也算数（测试会用它把时间冻在原点）。 */
  #nowMs () {
    const raw = Number(this.now())
    return Number.isFinite(raw) ? raw : Date.now()
  }

  #adopt (privateKey, publicKey, createdAt) {
    this._privateKey = privateKey
    this._publicKey = publicKey
    this._fingerprint = fingerprintOf(publicKey)
    this._keyCreatedAt = createdAt
  }

  /**
   * 读并严格校验 bbx-key.json。
   * 返回 null 表示文件还不存在；其它任何异常都是 BAD_KEY（绝不静默重建）。
   */
  async #readKeyRecord () {
    let raw
    try {
      raw = await readFile(this.files.key, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      throw new EnvelopeError('IO')
    }
    if (!raw.trim()) throw new EnvelopeError('BAD_KEY')
    let rec
    try {
      rec = JSON.parse(raw)
    } catch {
      throw new EnvelopeError('BAD_KEY')
    }
    if (!isPlainObject(rec)) throw new EnvelopeError('BAD_KEY')
    if (rec.v !== 1) throw new EnvelopeError('BAD_KEY')
    if (rec.alg && rec.alg !== 'P-256') throw new EnvelopeError('BAD_KEY')
    const jwk = rec.privateJwk
    if (!isPlainObject(jwk)) throw new EnvelopeError('BAD_KEY')
    if (jwk.kty !== 'EC') throw new EnvelopeError('BAD_KEY')
    if (jwk.crv && jwk.crv !== 'P-256') throw new EnvelopeError('BAD_KEY')
    if (!jwk.d || !jwk.x || !jwk.y) throw new EnvelopeError('BAD_KEY')

    // 私钥里的 x/y 必须和文件里记的公钥是同一把，否则「网页显示的公钥」和
    // 「实际能解的私钥」就对不上了——那比文件坏掉更隐蔽，必须当坏文件处理。
    const publicKey = publicKeyFromJwk(jwk)
    const recorded = rec.publicKey == null ? '' : String(rec.publicKey).trim()
    if (recorded && recorded !== publicKey) throw new EnvelopeError('BAD_KEY')

    let key
    try {
      key = await importPrivateJwk(jwk)
    } catch (err) {
      throw asEnvelopeError(err, 'BAD_KEY')
    }
    const createdAt = Number(rec.createdAt)
    return {
      key,
      publicKey,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : 0
    }
  }

  /**
   * 仅内存模式启动时清掉残留的密钥文件。
   * 只 unlink，不读内容、不备份 —— 备份一份就等于把私钥又留在了磁盘上。
   * 文件不存在是正常情况（大多数时候就是这样）。
   */
  async #purgeKeyFile () {
    try {
      await unlink(this.files.key)
      this.#logWarn('已删除上一任落盘的私钥（bbx-key.json）：当前是「仅内存」模式，磁盘上不该留任何私钥')
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      // 删不掉（权限 / 只读挂载）：不能假装成功，否则用户以为磁盘上已经干净了。
      throw new EnvelopeError('IO', '当前是「仅内存」模式，但删不掉磁盘上残留的旧私钥 bbx-key.json：' + MESSAGES.IO)
    }
  }

  /** @param {{persist?: boolean}} opts persist=false 时只生成、不落盘（仅内存模式） */
  async #createKey (opts = {}) {
    const persist = opts.persist !== false
    let pair
    try {
      pair = await generateKeyPair()
    } catch (err) {
      throw asEnvelopeError(err, 'NO_CRYPTO')
    }
    const publicKey = publicKeyToText(pair.publicRaw)
    const createdAt = Math.floor(this.#nowMs())
    if (persist) {
      const privateJwk = await exportPrivateJwk(pair.privateKey)
      const record = { v: 1, alg: 'P-256', createdAt, publicKey, privateJwk }
      await this.#atomicWrite(this.files.key, JSON.stringify(record, null, 2) + '\n')
    }
    this.#adopt(pair.privateKey, publicKey, createdAt)
  }

  /** 87 字符 b64url 公钥。未 ensure 时抛 NOT_READY。 */
  publicKey () {
    if (!this._publicKey) throw new EnvelopeError('NOT_READY')
    return this._publicKey
  }

  /** SHA-256(公钥原始 65 字节) 前 4 字节 hex（8 位），给入口头核对用。 */
  fingerprint () {
    if (!this._fingerprint) {
      if (!this._publicKey) throw new EnvelopeError('NOT_READY')
      this._fingerprint = fingerprintOf(this._publicKey)
    }
    return this._fingerprint
  }

  keyCreatedAt () {
    return this._keyCreatedAt
  }

  /** '<base>#k=<公钥>'；baseUrl 为空用内置默认。 */
  link (baseUrl) {
    const publicKey = this.publicKey()
    return resolveBase(baseUrl) + '#k=' + publicKey
  }

  /** 换一把私钥，并清空已用记录（旧链接与在途信封立即作废）。 */
  async rotate () {
    await this.ensure()
    await this.#enqueue(async () => {
      let pair
      try {
        pair = await generateKeyPair()
      } catch (err) {
        throw asEnvelopeError(err, 'NO_CRYPTO')
      }
      const publicKey = publicKeyToText(pair.publicRaw)
      const createdAt = Math.floor(this.#nowMs())
      const record = {
        v: 1,
        alg: 'P-256',
        createdAt,
        publicKey,
        privateJwk: await exportPrivateJwk(pair.privateKey)
      }

      const previousUsed = this._used
      this._used = Object.create(null)
      try {
        // 先清已用记录、再换钥：中途崩溃最坏是「旧钥 + 空记录」（等于重置），
        // 不会出现「新钥配着一堆旧 jti」的错位状态。
        await this.#atomicWrite(this.files.used, this.#usedJson())
        // 仅内存模式：**不写密钥文件**。旧文件留着不动（见 #setup 的说明）。
        if (this.keyMode !== 'ephemeral') {
          await this.#atomicWrite(this.files.key, JSON.stringify(record, null, 2) + '\n')
        }
      } catch (err) {
        this._used = previousUsed
        throw asEnvelopeError(err, 'IO')
      }
      this.#adopt(pair.privateKey, publicKey, createdAt)
    })
    this.#logInfo('已轮换私钥：旧链接与在途信封全部作废，新指纹 ' + this._fingerprint)
    return {
      publicKey: this.publicKey(),
      fingerprint: this.fingerprint(),
      keyCreatedAt: this._keyCreatedAt
    }
  }

  // ------------------------------------------------------------ 解密

  /**
   * 解密 + 解析 + 时间判定 + 消费 jti。
   * 成功才记账，且先记账再返回；重复提交同一个信封 → REPLAYED。
   */
  async open (input) {
    try {
      await this.ensure()
      const raw = this.#prepare(input)
      const body = await this.#decrypt(raw)
      this.#assertFresh(body)
      const kind = kindOf(body)
      await this.#consume(body.jti, body.exp)
      this.#logInfo('信封已使用：' + kind + '，ttl=' + body.ttlMin + ' 分钟，jti=' + shortJti(body.jti))
      return {
        kind,
        account: body.account,
        password: body.password,
        ttlMin: body.ttlMin,
        exp: body.exp,
        region: body.region,
        jti: body.jti,
        iat: body.iat
      }
    } catch (err) {
      const wrapped = asEnvelopeError(err, 'IO')
      this.#logWarn('解信封失败：' + wrapped.code)
      throw wrapped
    }
  }

  /**
   * 只解信封看元数据：不消费 jti、不回显任何秘密（账号一律掩码）。
   * 时间与有效期策略和 open() 一致（过期的信封照样报 EXPIRED）。
   */
  async inspect (input) {
    try {
      await this.ensure()
      const raw = this.#prepare(input)
      const body = await this.#decrypt(raw)
      this.#assertFresh(body)
      this.#logInfo('信封预览：' + kindOf(body) + '，jti=' + shortJti(body.jti))
      return {
        ok: true,
        kind: kindOf(body),
        ttlMin: body.ttlMin,
        expiresAt: body.exp * 1000,
        region: body.region,
        accountMasked: maskAccount(body.account),
        hasAccount: true,
        hasPassword: true
      }
    } catch (err) {
      const wrapped = asEnvelopeError(err, 'IO')
      this.#logWarn('预览信封失败：' + wrapped.code)
      throw wrapped
    }
  }

  /** 先 trim，再拦超长（bbx.js 也会拦，但我们先挡，避免把 4096 字符拖进解码）。 */
  #prepare (input) {
    if (input == null) throw new EnvelopeError('BAD_INPUT', '请把网页生成的信封整段贴过来')
    if (typeof input !== 'string') throw new EnvelopeError('BAD_INPUT', '信封要以文本形式提供')
    const raw = input.trim()
    if (!raw) throw new EnvelopeError('BAD_FORMAT', '信封是空的')
    if (raw.length > MAX_TEXT) throw new EnvelopeError('TOO_LARGE')
    return raw
  }

  async #decrypt (raw) {
    if (!this._privateKey) throw new EnvelopeError('NOT_READY')
    try {
      return await openEnvelope(this._privateKey, raw)
    } catch (err) {
      throw asEnvelopeError(err, 'BAD_TAG')
    }
  }

  /** 时间判定：过期 / 未生效 / 超过本机允许的生存时间上限。 */
  #assertFresh (body) {
    const nowSec = Math.floor(Number(this.now()) / 1000)
    if (!Number.isFinite(body.exp) || !Number.isFinite(body.iat) || !Number.isFinite(body.ttlMin)) {
      throw new EnvelopeError('BAD_PAYLOAD', '信封的时间字段不正确')
    }
    if (body.ttlMin > this.maxTtlMinutes) {
      throw new EnvelopeError('BAD_PAYLOAD', '信封的有效期（' + body.ttlMin + ' 分钟）超过了本机允许的上限（' + this.maxTtlMinutes + ' 分钟）')
    }
    if (nowSec > body.exp + SKEW_SEC) throw new EnvelopeError('EXPIRED')
    if (body.iat > nowSec + SKEW_SEC) throw new EnvelopeError('NOT_YET')
  }

  // ------------------------------------------------------------ 一次性

  /** 读 bbx-used.json；文件坏了按空处理（只告警，不阻断服务），但绝不假装成功。 */
  async #loadUsed () {
    this._used = Object.create(null)
    let raw
    try {
      raw = await readFile(this.files.used, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      throw new EnvelopeError('IO')
    }
    if (!raw.trim()) return
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.#logWarn('已用记录文件损坏，按空处理（重放保护被重置）')
      return
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.used)) {
      this.#logWarn('已用记录文件结构不对，按空处理（重放保护被重置）')
      return
    }
    const out = Object.create(null)
    for (const [jti, value] of Object.entries(parsed.used)) {
      const exp = Number(value)
      if (!jti || !Number.isFinite(exp) || exp <= 0) continue
      out[jti] = Math.floor(exp)
    }
    this._used = out
    this.#pruneUsed(Math.floor(Number(this.now()) / 1000))
  }

  /** 清掉 exp 过去 24 小时以上的条目；超过 5000 条按 exp 淘汰最旧的。 */
  #pruneUsed (nowSec) {
    const keepFrom = nowSec - USED_KEEP_SEC
    const rows = []
    for (const [jti, exp] of Object.entries(this._used)) {
      if (!(exp >= keepFrom)) {
        delete this._used[jti]
        continue
      }
      rows.push([jti, exp])
    }
    if (rows.length <= USED_FILE_MAX) return
    rows.sort((a, b) => a[1] - b[1]) // exp 小的就是旧的，先淘汰
    const drop = rows.length - USED_FILE_MAX
    for (let i = 0; i < drop; i += 1) delete this._used[rows[i][0]]
  }

  /**
   * 把磁盘上的已用记录并进内存（只加不减，保留 exp 更大的那个）。
   * 单进程内查询+写入已经由队列串行化了；跨实例 / 跨进程还需要这一步：
   * 进队列后再读一次盘，才看得见别人刚记下的 jti。
   */
  async #refreshUsedFromDisk () {
    let raw
    try {
      raw = await readFile(this.files.used, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return
      throw new EnvelopeError('IO')
    }
    if (!raw.trim()) return
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // 坏文件：保留内存里的记录，绝不当成「没消费过」
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.used)) return
    for (const [jti, value] of Object.entries(parsed.used)) {
      const exp = Number(value)
      if (!jti || !Number.isFinite(exp) || exp <= 0) continue
      const known = this._used[jti]
      if (!known || exp > known) this._used[jti] = Math.floor(exp)
    }
  }

  #usedJson () {
    const used = {}
    for (const [jti, exp] of Object.entries(this._used)) used[jti] = exp
    return JSON.stringify({ v: 1, used }, null, 2) + '\n'
  }

  /**
   * 记账并落盘。查重与写入都在同一条队列里，并发提交同一个信封只可能成功一次。
   * 写盘失败不回滚内存记录：宁可这一次报 IO，也不让同一个信封在本进程里用两次。
   */
  #consume (jti, expSec) {
    const key = String(jti || '')
    return this.#enqueue(async () => {
      if (!key) throw new EnvelopeError('BAD_PAYLOAD', '信封缺少一次性标记')
      await this.#refreshUsedFromDisk()
      if (Object.prototype.hasOwnProperty.call(this._used, key)) {
        throw new EnvelopeError('REPLAYED')
      }
      this._used[key] = Math.floor(Number(expSec))
      this.#pruneUsed(Math.floor(Number(this.now()) / 1000))
      await this.#atomicWrite(this.files.used, this.#usedJson())
    })
  }

  stats () {
    const nowSec = Math.floor(Number(this.now()) / 1000)
    const keepFrom = nowSec - USED_KEEP_SEC
    let used = 0
    for (const [jti, exp] of Object.entries(this._used)) {
      if (exp >= keepFrom) used += 1
      else delete this._used[jti]
    }
    return { used, keyCreatedAt: this._keyCreatedAt }
  }

  // ------------------------------------------------------------ 落盘 / 日志

  /** 所有写操作走同一条队列；队列里的任务不要再次入队（会死锁）。 */
  #enqueue (task) {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** tmp + rename 原子写，0600（和 lib/vault.mjs 同一套）。 */
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

  #logInfo (message) {
    if (this.log && typeof this.log.info === 'function') this.log.info('[bambu-print] ' + message)
  }

  #logWarn (message) {
    if (this.log && typeof this.log.warn === 'function') this.log.warn('[bambu-print] ' + message)
  }
}

/** 公钥文本 → 指纹（SHA-256 前 4 字节 hex）。 */
function fingerprintOf (publicKey) {
  const raw = fromBase64Url(publicKey)
  if (raw.length !== 65 || raw[0] !== 0x04) throw new EnvelopeError('BAD_KEY')
  return createHash('sha256').update(Buffer.from(raw)).digest().subarray(0, 4).toString('hex')
}

/** 从私钥 JWK 的 x/y 还原公钥文本（同时用来校验文件自洽）。 */
function publicKeyFromJwk (jwk) {
  const x = fromBase64Url(jwk.x)
  const y = fromBase64Url(jwk.y)
  if (x.length !== 32 || y.length !== 32) throw new EnvelopeError('BAD_KEY')
  const raw = new Uint8Array(65)
  raw[0] = 0x04
  raw.set(x, 1)
  raw.set(y, 33)
  try {
    return publicKeyToText(raw)
  } catch (err) {
    throw asEnvelopeError(err, 'BAD_KEY')
  }
}

/** 工厂函数（index.mjs 与测试都用这个，不要直接 new）。 */
export function createEnvelopeService (options = {}) {
  return new EnvelopeService(options)
}

export default createEnvelopeService
