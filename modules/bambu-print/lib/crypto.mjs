// lib/crypto.mjs — bambu-print 安全层的基础密码学原语。
//
// 约定（见 ARCHITECTURE.md 第 0/2 节）：
//   * 只用 node: 内置模块；
//   * 本文件不写盘、不打印任何秘密，出错只抛 CryptoError（带 code）；
//   * AES-256-GCM（12B IV，16B tag）+ scrypt(N=32768,r=8,p=1) 派生密钥；
//   * 所有 b64 字段统一标准 base64，wrapped box 结构固定为 { v:1, iv, tag, data }。

import { createCipheriv, createDecipheriv, randomBytes as randomBytesNative, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

export const DEFAULT_KDF = Object.freeze({ N: 32768, r: 8, p: 1, keyLen: 32 })

// 随机串字母表（去掉 I L O U，避免和 1 0 混读）。

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16
const B64 = 'base64'

const CODE_TEXT = {
  BAD_KEY: '密钥长度不正确',
  BAD_BOX: '密文格式不正确',
  BAD_TAG: '解密失败：密钥不正确或数据被篡改',
  BAD_JSON: '密文内容不是合法 JSON',
  BAD_INPUT: '加密参数不正确',
  BAD_KDF: 'scrypt 参数不正确'
}

export class CryptoError extends Error {
  constructor (code, message) {
    super(message || CODE_TEXT[code] || '加密操作失败')
    this.name = 'CryptoError'
    this.code = code || 'CRYPTO'
  }
}

// ---------------------------------------------------------------- 随机量

/** @param {number} n 字节数 */
export function randomBytes (n) {
  const size = Number(n)
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new CryptoError('BAD_INPUT', '随机字节数不正确')
  return randomBytesNative(size)
}

/** 32 字节随机串的 base64url 表示，可安全放进日志/URL（本身仍是秘密，不要打印）。 */
export function randomToken (bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/** 16 字节盐。 */
export function newSalt () {
  return randomBytes(SALT_BYTES)
}

// ---------------------------------------------------------------- 安全码

/**
 * 只 trim，不改大小写（安全码大小写敏感）。
 * 空串原样返回空串（调用方据此判断「没填」）。
 */
export function normalizeCode (input) {
  if (input == null) return ''
  const text = typeof input === 'string' ? input : String(input)
  return text.trim()
}

const WEAK_SUBSTRINGS = [
  'qwerty', 'qwertyui', 'asdfgh', 'zxcvbn', 'password', 'passwd', 'letmein',
  'admin', 'abc123', '123456', '654321', '111111', '222222', '000000', '888888',
  '999999', '666666'
]

// 键盘整排/递增递减序列，整条都由它组成才算弱码。
const SEQUENCES = [
  '0123456789', '9876543210',
  'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz'
]

function isStraightRun (text) {
  const lower = text.toLowerCase()
  return SEQUENCES.some((seq) => seq.includes(lower))
}

/**
 * 安全码强度：长度 >= 8；纯数字 >= 10 位；不能单字符重复；不能是常见弱串/键盘序列。
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkCodeStrength (code) {
  const value = normalizeCode(code)
  if (!value) return { ok: false, reason: '安全码不能为空' }
  if (/\s/.test(value)) return { ok: false, reason: '安全码不能包含空格或换行' }
  if (value.length < 8) return { ok: false, reason: '安全码至少 8 位' }
  if (value.length > 128) return { ok: false, reason: '安全码最多 128 位' }
  if (/^\d+$/.test(value) && value.length < 10) return { ok: false, reason: '纯数字安全码至少 10 位' }
  if (new Set(value).size === 1) return { ok: false, reason: '安全码不能是同一个字符重复' }

  const lower = value.toLowerCase()
  if (WEAK_SUBSTRINGS.some((weak) => lower.includes(weak))) {
    return { ok: false, reason: '安全码不能包含 123456 / qwerty / password 这类常见串' }
  }
  if (isStraightRun(value)) return { ok: false, reason: '安全码不能是连续序列（如 12345678 / abcdefgh）' }
  if (/^\d+$/.test(value) && new Set(value.split('').map((c) => Number(c) - 0)).size <= 2) {
    return { ok: false, reason: '纯数字安全码变化太少' }
  }
  return { ok: true, reason: '' }
}

// ---------------------------------------------------------------- KDF

function toBuffer (value, what) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, B64)
  throw new CryptoError('BAD_INPUT', what + ' 类型不正确')
}

/**
 * scrypt 派生 32B 密钥。opts 覆盖 DEFAULT_KDF（测试传小 N 提速）。
 * maxmem 至少 128*N*r*2；N=32768,r=8 时为 64MB，必须显式给，否则 node 默认 32MB 会报错。
 */
export async function deriveKey (code, salt, opts = {}) {
  const params = { ...DEFAULT_KDF, ...(opts || {}) }
  const N = Math.floor(Number(params.N))
  const r = Math.floor(Number(params.r))
  const p = Math.floor(Number(params.p))
  const keyLen = Math.floor(Number(params.keyLen))
  if (!(N > 1) || !(r > 0) || !(p > 0) || !(keyLen >= 16 && keyLen <= 64)) {
    throw new CryptoError('BAD_KDF', 'scrypt 参数不正确')
  }
  const saltBuf = toBuffer(salt, '盐')
  if (saltBuf.length < 8) throw new CryptoError('BAD_INPUT', '盐太短')
  const secret = typeof code === 'string' ? code : normalizeCode(code)
  const maxmem = Math.max(Number(params.maxmem) || 0, 128 * N * r * 2)
  const derived = await scrypt(secret, saltBuf, keyLen, { N, r, p, maxmem })
  return Buffer.from(derived)
}

// ---------------------------------------------------------------- AEAD

function toKey (key) {
  const buf = Buffer.isBuffer(key) ? key : (key instanceof Uint8Array ? Buffer.from(key) : null)
  if (!buf || buf.length !== KEY_BYTES) throw new CryptoError('BAD_KEY', '密钥必须是 32 字节')
  return buf
}

function toPlainBytes (plaintext) {
  if (Buffer.isBuffer(plaintext)) return plaintext
  if (plaintext instanceof Uint8Array) return Buffer.from(plaintext)
  if (typeof plaintext === 'string') return Buffer.from(plaintext, 'utf8')
  throw new CryptoError('BAD_INPUT', '明文必须是字符串或 Buffer')
}

function aadBytes (aad) {
  return Buffer.from(String(aad == null ? '' : aad), 'utf8')
}

/** AES-256-GCM 加密 -> { v:1, iv, tag, data }（均 b64）。 */
export function seal (key, plaintext, aad) {
  const k = toKey(key)
  const iv = randomBytesNative(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  cipher.setAAD(aadBytes(aad))
  const body = Buffer.concat([cipher.update(toPlainBytes(plaintext)), cipher.final()])
  const tag = cipher.getAuthTag()
  return { v: 1, iv: iv.toString(B64), tag: tag.toString(B64), data: body.toString(B64) }
}

/** 解密；tag 校验失败统一抛 CryptoError('BAD_TAG')——「安全码错误」就是这条。 */
export function open (key, box, aad) {
  const k = toKey(key)
  if (!box || typeof box !== 'object') throw new CryptoError('BAD_BOX')
  const iv = Buffer.from(String(box.iv || ''), B64)
  const tag = Buffer.from(String(box.tag || ''), B64)
  const data = Buffer.from(String(box.data || ''), B64)
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CryptoError('BAD_BOX')
  const decipher = createDecipheriv('aes-256-gcm', k, iv)
  decipher.setAAD(aadBytes(aad))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    throw new CryptoError('BAD_TAG')
  }
}

export function sealJson (key, value, aad) {
  if (value === undefined) throw new CryptoError('BAD_INPUT', '没有可加密的对象')
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    throw new CryptoError('BAD_INPUT', '对象无法序列化')
  }
  return seal(key, Buffer.from(text, 'utf8'), aad)
}

export function openJson (key, box, aad) {
  const buf = open(key, box, aad)
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new CryptoError('BAD_JSON')
  }
}

/** 用 KEK 包 DEK（就是一次 seal，只是语义单独拉出来）。 */
export function wrapKey (kek, dek, aad) {
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw new CryptoError('BAD_KEY', 'DEK 必须是 32 字节')
  return seal(kek, dek, aad)
}

export function unwrapKey (kek, box, aad) {
  const dek = open(kek, box, aad)
  if (dek.length !== KEY_BYTES) throw new CryptoError('BAD_KEY', '解出的 DEK 长度不正确')
  return dek
}

// ---------------------------------------------------------------- 小工具

/**
 * 掩码：'••••' + 末 keep 位；太短（<= keep*2）就整条遮住，避免露出大半。
 * 空值返回 ''（调用方据此判断「没有可显示的信息」）。
 */
export function maskSecret (value, keep = 4) {
  const text = value == null ? '' : String(value)
  if (!text) return ''
  const k = Math.floor(Number(keep))
  if (!Number.isFinite(k) || k <= 0) return '••••'
  if (text.length <= k * 2) return '••••'
  return '••••' + text.slice(-k)
}

/** 全 0（尽力而为：JS 里字符串无法擦除，只能擦 Buffer）。 */
export function clearBuffer (buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0)
  return buf
}
