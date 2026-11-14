// lib/tls-cert.mjs —— 自签名证书：自动生成、解析、指纹、以及「把打印机自己的自签名证书当信任锚」。
//
// 为什么需要它：
//   · 拓竹打印机的局域网端口（MQTT :8883、摄像头 :6000/:322）用的是**打印机自己生成的自签名证书**，
//     既没有公共 CA 链，证书里的 CN 也是打印机序列号而不是 IP —— 默认校验必然失败；
//   · 但直接 rejectUnauthorized:false 等于不校验，同网段任何人都能中间人冒充打印机，
//     访问码就交出去了；
//   · 所以这里走「首次连接自动固定（TOFU）」：第一次拿到打印机自签名证书后自动记下指纹 + 证书本体，
//     之后每次连接都用它当 ca 锚点真正校验，变了就拒绝。
//
// 另外，本模块自己也自动生成一张自签名证书（纯 Node，不依赖 openssl），
// 作为 TLS 客户端证书材料；Bambu 不要求客户端证书，所以它在握手时只有对方索要才会发送。
//
// 只依赖 node:crypto。

import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'

// ---------------- DER 基础 ----------------

function derLength (len) {
  if (len < 0x80) return Buffer.from([len])
  const bytes = []
  let rest = len
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der (tag, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const seq = (...items) => der(0x30, Buffer.concat(items))
const set = (...items) => der(0x31, Buffer.concat(items))
const explicit = (tag, payload) => der(0xa0 + tag, payload)

function derInt (value) {
  let bytes
  if (typeof value === 'bigint') {
    const hex = value.toString(16)
    bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')
  } else if (Buffer.isBuffer(value)) {
    bytes = value
  } else {
    const n = Number(value)
    const out = []
    let rest = n
    do {
      out.unshift(rest & 0xff)
      rest = Math.floor(rest / 256)
    } while (rest > 0)
    bytes = Buffer.from(out)
  }
  // 负数 / 最高位为 1 时补 0，避免被解释成负数
  if (bytes.length && (bytes[0] & 0x80)) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return der(0x02, bytes)
}

const derBool = (value) => der(0x01, Buffer.from([value ? 0xff : 0x00]))
const derOctet = (buf) => der(0x04, buf)
const derBitString = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]))
const derUtf8 = (text) => der(0x0c, Buffer.from(String(text), 'utf8'))
const derPrintable = (text) => der(0x13, Buffer.from(String(text), 'latin1'))
const derNull = () => Buffer.from([0x05, 0x00])

/** OBJECT IDENTIFIER：点分字符串 → DER */
function derOid (oid) {
  const parts = String(oid).split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk = []
    let rest = part
    do {
      chunk.unshift(rest & 0x7f)
      rest = Math.floor(rest / 128)
    } while (rest > 0)
    for (let i = 0; i < chunk.length; i++) bytes.push(i === chunk.length - 1 ? chunk[i] : chunk[i] | 0x80)
  }
  return der(0x06, Buffer.from(bytes))
}

/** UTC/Generalized 时间：2050 年后用 GeneralizedTime，之前用 UTCTime */
function derTime (date) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  const utc = d.getUTCFullYear() < 2050
  const stamp =
    (utc ? pad(d.getUTCFullYear() % 100) : String(d.getUTCFullYear())) +
    pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z'
  return utc
    ? der(0x17, Buffer.from(stamp, 'ascii'))
    : der(0x18, Buffer.from(stamp, 'ascii'))
}

/** Name ::= SEQUENCE OF RelativeDistinguishedName（这里每个 RDN 只有一个属性） */
function derName (commonName, org) {
  const rdns = [set(seq(derOid('2.5.4.3'), derUtf8(String(commonName || 'aurabot'))))]
  if (org) rdns.unshift(set(seq(derOid('2.5.4.10'), derUtf8(String(org)))))
  return seq(...rdns)
}

// ---------------- 自签名证书 ----------------

const OID_SHA256_RSA = '1.2.840.113549.1.1.11'
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const OID_SHA256_ECDSA = '1.2.840.10045.4.3.2'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_KEY_USAGE = '2.5.29.15'
const OID_EXT_KEY_USAGE = '2.5.29.37'
const OID_SAN = '2.5.29.17'
const OID_SKI = '2.5.29.14'

const isIp = (text) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(text || ''))

function altNames (list) {
  const items = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw == null ? '' : raw).trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    items.push(isIp(text) ? der(0x87, Buffer.from(text.split('.').map(Number))) : der(0x82, Buffer.from(text, 'ascii')))
  }
  return items
}

/**
 * 自动生成一张自签名证书（默认 RSA-2048 + SHA-256）。
 * 生成的证书带 CA:TRUE + SAN，可以直接当 tls.connect 的 ca 锚点，也能当客户端证书。
 *
 * @param {object} [opts]
 * @param {string} [opts.commonName='aurabot']
 * @param {string[]} [opts.sans=[]] 额外 SAN（IP 或域名），commonName 会自动加进去
 * @param {number} [opts.days=3650]
 * @param {'rsa'|'ec'} [opts.keyType='rsa']
 * @param {Date} [opts.notBefore]
 * @returns {{ certPem:string, keyPem:string, fingerprint256:string, serial:string, notBefore:number, notAfter:number, subject:string }}
 */
export function generateSelfSignedCert (opts = {}) {
  const commonName = String(opts.commonName || 'aurabot').slice(0, 64)
  const org = opts.org === undefined ? 'aurabot' : opts.org
  const days = Math.min(36500, Math.max(1, Number(opts.days) || 3650))
  const keyType = opts.keyType === 'ec' ? 'ec' : 'rsa'
  const notBefore = opts.notBefore instanceof Date ? opts.notBefore : new Date(Date.now() - 60 * 1000)
  const notAfter = new Date(notBefore.getTime() + days * 86400 * 1000)

  const { privateKey, publicKey } = keyType === 'ec'
    ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    : generateKeyPairSync('rsa', { modulusLength: 2048 })

  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const sigAlg = keyType === 'ec'
    ? seq(derOid(OID_SHA256_ECDSA))
    : seq(derOid(OID_SHA256_RSA), derNull())

  const serialBytes = randomBytes(16)
  serialBytes[0] = serialBytes[0] & 0x7f || 1 // 正数且非零

  const name = derName(commonName, org)
  const san = altNames([commonName, ...(Array.isArray(opts.sans) ? opts.sans : [])])
  const ski = createHash('sha1').update(spki).digest()

  const extensions = [
    seq(derOid(OID_BASIC_CONSTRAINTS), derBool(true), derOctet(seq(derBool(true)))),
    // keyUsage: digitalSignature + keyEncipherment + keyCertSign
    seq(derOid(OID_KEY_USAGE), derBool(true), derOctet(der(0x03, Buffer.from([0x02, 0x84])))),
    // extKeyUsage: serverAuth + clientAuth
    // critical 默认 FALSE：DER 要求省略，不能显式编一个 FALSE 进去
    seq(derOid(OID_EXT_KEY_USAGE), derOctet(seq(derOid('1.3.6.1.5.5.7.3.1'), derOid('1.3.6.1.5.5.7.3.2')))),
    // 只有当 subject 里没有 CN 时 SAN 才必须是 critical（RFC 5280 4.2.1.6）
    commonName ? seq(derOid(OID_SAN), derOctet(seq(...san))) : seq(derOid(OID_SAN), derBool(true), derOctet(seq(...san))),
    // SKI 按 RFC 5280 必须是非 critical
    seq(derOid(OID_SKI), derOctet(derOctet(ski))),
  ]

  const tbs = seq(
    explicit(0, derInt(2)), // v3
    derInt(serialBytes),
    sigAlg,
    name,
    seq(derTime(notBefore), derTime(notAfter)),
    name,
    spki,
    explicit(3, seq(...extensions)),
  )

  const signature = keyType === 'ec' ? sign('sha256', tbs, privateKey) : sign('sha256', tbs, privateKey)
  const certDer = seq(tbs, sigAlg, derBitString(signature))
  const keyPem = privateKey.export({ type: keyType === 'ec' ? 'pkcs8' : 'pkcs8', format: 'pem' })
  const certPem = derToPem(certDer, 'CERTIFICATE')

  const parsed = new X509Certificate(certPem)
  return {
    certPem,
    keyPem: String(keyPem),
    certDer,
    fingerprint256: normalizeFingerprint(parsed.fingerprint256),
    serial: parsed.serialNumber,
    notBefore: new Date(parsed.validFrom).getTime(),
    notAfter: new Date(parsed.validTo).getTime(),
    subject: parsed.subject,
    sans: [commonName, ...(Array.isArray(opts.sans) ? opts.sans : [])],
  }
}

// ---------------- PEM / 证书工具 ----------------

export function derToPem (der, label = 'CERTIFICATE') {
  const body = Buffer.isBuffer(der) ? der : Buffer.from(der)
  const lines = body.toString('base64').match(/.{1,64}/g) || []
  return '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----\n'
}

export function pemToDer (pem) {
  const text = String(pem || '')
  const match = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(text)
  if (!match) return null
  try {
    return Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  } catch {
    return null
  }
}

/** 指纹统一成小写、无冒号（便于比较与展示） */
export function normalizeFingerprint (value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
}

/** 从 tls socket 上取对端证书（DER）→ { der, pem, fingerprint256, subject, notAfter }；取不到返回 null */
export function peerCertOf (socket) {
  try {
    const cert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate(true) : null
    if (!cert) return null
    let der = null
    if (Buffer.isBuffer(cert.raw) && cert.raw.length) der = cert.raw
    else if (typeof cert.raw === 'object' && cert.raw && cert.raw.data) der = Buffer.from(cert.raw.data)
    if (!der && cert.fingerprint256) {
      // 注入的 socket（测试）可能只给指纹
      return {
        der: null,
        pem: '',
        fingerprint256: normalizeFingerprint(cert.fingerprint256),
        subject: cert.subject ? String(cert.subject.CN || '') : '',
        notAfter: 0,
      }
    }
    if (!der) return null
    const pem = derToPem(der)
    let fingerprint = normalizeFingerprint(cert.fingerprint256)
    let subject = ''
    let notAfter = 0
    try {
      const parsed = new X509Certificate(pem)
      if (!fingerprint) fingerprint = normalizeFingerprint(parsed.fingerprint256)
      subject = parsed.subject
      notAfter = new Date(parsed.validTo).getTime()
    } catch {
      if (!fingerprint) fingerprint = createHash('sha256').update(der).digest('hex')
    }
    return { der, pem, fingerprint256: fingerprint, subject, notAfter }
  } catch {
    return null
  }
}

/** 证书是否还在有效期内（自签名打印机证书常年有效，但过期了要提示） */
export function certFresh (info, now = Date.now()) {
  if (!info) return false
  if (!info.notAfter) return true
  return Number(info.notAfter) > now
}

/** 展示用：ab:cd:... 形式的分段指纹 */
export function prettyFingerprint (value) {
  const hex = normalizeFingerprint(value)
  if (hex.length !== 64) return hex
  return (hex.match(/.{2}/g) || []).join(':')
}
