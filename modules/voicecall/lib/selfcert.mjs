// 自己签一张局域网用的证书，不依赖 openssl，也不需要用户手动准备文件。
//
// 为什么需要：手机上要开麦克风，浏览器只认 https（安全上下文）。台式机调 localhost 可以，
// 手机连 192.168.x.x 就必须有证书。让别人装上去就能用，只能自己签。
//
// 生成的是 X.509 v3 自签证书：RSA 2048 + SHA256，SAN 里带当前所有局域网 IP 和 localhost，
// basicConstraints CA:false、keyUsage digitalSignature+keyEncipherment、extKeyUsage serverAuth。
// 浏览器第一次会提示「不是私密连接」，点「高级 → 继续前往」即可（自签证书的正常现象）。

import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

// ---------- 最小的 DER 编码器 ----------
const len = (n) => {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...items) => tlv(0x30, Buffer.concat(items))
const set = (...items) => tlv(0x31, Buffer.concat(items))
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body)

const integer = (buf) => {
  let b = buf
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'))
const octet = (b) => tlv(0x04, b)
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))

/** 点分 OID → DER */
const oid = (s) => {
  const parts = s.split('.').map(Number)
  const body = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f]
    let v = p >>> 7
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80)
      v >>>= 7
    }
    body.push(...chunk)
  }
  return tlv(0x06, Buffer.from(body))
}

/** BIT STRING，bits 是「有效位之前的填充位数」 */
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]))

/** UTCTime：2049 年前用两位年份 */
const utcTime = (date) => {
  const p = (n) => String(n).padStart(2, '0')
  const y = date.getUTCFullYear()
  const body =
    (y >= 2050 ? String(y) : p(y % 100)) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z'
  return tlv(0x17, Buffer.from(body, 'ascii'))
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

const nameOf = (cn, org) =>
  seq(
    set(seq(oid(OID.commonName), utf8(cn))),
    ...(org ? [set(seq(oid(OID.organization), utf8(org)))] : []),
  )

const ipToBytes = (ip) => {
  const parts = String(ip).split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
  return Buffer.from(parts.map(Number))
}

/**
 * 签一张证书。
 * @param {{ commonName?: string, org?: string, ips?: string[], days?: number, rsaBits?: number }} opt
 * @returns {{ cert: string, key: string, sans: string[] }}
 */
export function makeSelfSignedCert(opt = {}) {
  const commonName = String(opt.commonName || 'aurabot-call')
  const org = String(opt.org || 'Aurabot')
  const days = Math.max(1, Math.min(825, Number(opt.days) || 825))
  const bits = Number(opt.rsaBits) || 2048
  const ips = [...new Set((opt.ips || []).filter((ip) => ipToBytes(ip)))]

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  const serial = randomBytes(16)
  serial[0] &= 0x7f // 正数
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  const notAfter = new Date(Date.now() + days * 24 * 3600 * 1000)

  const algId = seq(oid(OID.sha256WithRSA), Buffer.from([0x05, 0x00])) // + NULL

  // SAN：DNS localhost + 给定的所有 IP
  const generalNames = [ctx(2, Buffer.from('localhost', 'ascii'), false), ...ips.map((ip) => ctx(7, ipToBytes(ip), false))]
  const san = seq(...generalNames)

  // keyUsage：digitalSignature(0) + keyEncipherment(2) → 1010 0000，后面 5 位补齐
  const keyUsage = bitString(Buffer.from([0b1010_0000]), 5)
  const extKeyUsage = seq(oid(OID.serverAuth))
  const basicConstraints = seq() // CA:false（缺省即 false，空 SEQUENCE）

  const extensions = seq(
    seq(oid(OID.basicConstraints), bool(true), octet(basicConstraints)),
    seq(oid(OID.keyUsage), bool(true), octet(keyUsage)),
    seq(oid(OID.extKeyUsage), octet(extKeyUsage)),
    seq(oid(OID.subjectAltName), octet(san)),
  )

  const subject = nameOf(commonName, org)
  const tbs = seq(
    ctx(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algId,
    subject, // issuer = subject（自签）
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    ctx(3, extensions),
  )

  const signer = createSign('RSA-SHA256')
  signer.update(tbs)
  const signature = signer.sign(privateKey)
  const cert = seq(tbs, algId, bitString(signature))

  const pem = (label, der) => {
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
  }

  return {
    cert: pem('CERTIFICATE', cert),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    sans: ['localhost', ...ips],
  }
}

/** 证书里有没有覆盖这个 IP（没有就得重签，否则手机还是会报错） */
export function certCoversIps(pemText, ips = []) {
  const text = String(pemText || '')
  if (!text.includes('BEGIN CERTIFICATE')) return false
  try {
    // 证书里的 IP 是 DER 二进制，直接按字节找不现实；用 Node 自带的解析能力读 SAN。
    const der = Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
    const needle = (ip) => {
      const bytes = ipToBytes(ip)
      return bytes ? der.includes(bytes) : false
    }
    return ips.every((ip) => needle(ip))
  } catch (error) {
    return false
  }
}
