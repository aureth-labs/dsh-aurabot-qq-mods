// test/tls-cert.test.mjs —— 自签名证书生成 / 解析 / 指纹 / TOFU 工具
import test from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import {
  generateSelfSignedCert,
  derToPem,
  pemToDer,
  normalizeFingerprint,
  prettyFingerprint,
  peerCertOf,
  certFresh,
} from '../lib/tls-cert.mjs'

test('生成的自签名证书能被 X509Certificate 解析，且有正确的 CA / keyUsage / SAN', () => {
  const cert = generateSelfSignedCert({ commonName: '192.168.1.50', sans: ['aurabot', '192.168.1.50'] })
  assert.match(cert.certPem, /^-----BEGIN CERTIFICATE-----/)
  assert.match(cert.keyPem, /^-----BEGIN PRIVATE KEY-----/)
  const parsed = new X509Certificate(cert.certPem)
  assert.equal(parsed.ca, true, '自签名锚点必须是 CA')
  assert.match(parsed.subject, /CN=192\.168\.1\.50/)
  assert.equal(parsed.subject, parsed.issuer, '自签名：subject == issuer')
  assert.ok(parsed.validTo)
  assert.ok(cert.notAfter > Date.now(), '默认有效期在未来')
  assert.match(parsed.subjectAltName, /IP Address:192\.168\.1\.50/)
  assert.match(parsed.subjectAltName, /DNS:aurabot/)
  // 指纹与 Node 自己算的一致
  assert.equal(cert.fingerprint256, normalizeFingerprint(parsed.fingerprint256))
  assert.equal(cert.fingerprint256.length, 64)
})

test('生成了证书和私钥就能真的起 TLS 服务，并且用自己当 ca 校验通过', async () => {
  const cert = generateSelfSignedCert({ commonName: '127.0.0.1', sans: ['127.0.0.1'] })
  const server = tls.createServer({ cert: cert.certPem, key: cert.keyPem }, (socket) => socket.end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const authorized = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, ca: [cert.certPem], checkServerIdentity: () => undefined }, () => {
        resolve(socket.authorized)
        socket.end()
      })
      socket.on('error', reject)
    })
    assert.equal(authorized, true, '用自己的证书当锚点应当校验通过')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('有效期 / EC 密钥 / 自定义组织名', () => {
  const ec = generateSelfSignedCert({ commonName: 'printer', days: 30, keyType: 'ec', org: 'bambu' })
  const parsed = new X509Certificate(ec.certPem)
  assert.equal(parsed.publicKey.asymmetricKeyType, 'ec')
  assert.match(parsed.subject, /O=bambu/)
  const span = ec.notAfter - ec.notBefore
  assert.ok(Math.abs(span - 30 * 86400 * 1000) < 120000, '有效期约 30 天')
  // 天数会被夹紧
  const tiny = generateSelfSignedCert({ days: 0 })
  assert.ok(tiny.notAfter > Date.now())
  const huge = generateSelfSignedCert({ days: 999999 })
  assert.ok(huge.notAfter - huge.notBefore <= 36500 * 86400 * 1000)
})

test('PEM / DER 互转、指纹格式化', () => {
  const cert = generateSelfSignedCert({ commonName: 'a' })
  const der = pemToDer(cert.certPem)
  assert.ok(Buffer.isBuffer(der))
  assert.equal(derToPem(der), cert.certPem)
  assert.equal(pemToDer('not a pem'), null)
  assert.equal(normalizeFingerprint('AA:BB:CC'), 'aabbcc')
  assert.equal(prettyFingerprint('aa'.repeat(32)), ('aa'.repeat(32).match(/.{2}/g) || []).join(':'))
  assert.equal(prettyFingerprint('abc'), 'abc', '长度不对就原样返回')
})

test('peerCertOf：从 socket 上取证书；取不到就返回 null', () => {
  const cert = generateSelfSignedCert({ commonName: 'b' })
  const der = pemToDer(cert.certPem)
  const fake = { getPeerCertificate: () => ({ raw: der, fingerprint256: 'AB:CD', subject: { CN: 'b' }, valid_to: new Date(Date.now() + 86400000).toUTCString() }) }
  const info = peerCertOf(fake)
  assert.ok(info)
  assert.equal(info.fingerprint256, 'abcd')
  assert.equal(info.pem, cert.certPem)
  assert.match(info.subject, /CN=b/)

  assert.equal(peerCertOf(null), null)
  assert.equal(peerCertOf({}), null)
  assert.equal(peerCertOf({ getPeerCertificate: () => null }), null)
  // 只有指纹（注入的测试 socket）
  const only = peerCertOf({ getPeerCertificate: () => ({ fingerprint256: 'EE:FF' }) })
  assert.equal(only.fingerprint256, 'eeff')
  assert.equal(only.pem, '')
})

test('certFresh：没有到期时间当作有效，过期就是 false', () => {
  assert.equal(certFresh(null), false)
  assert.equal(certFresh({ notAfter: 0 }), true)
  assert.equal(certFresh({ notAfter: Date.now() + 1000 }), true)
  assert.equal(certFresh({ notAfter: Date.now() - 1000 }), false)
})
