// test/crypto.test.mjs — 密码学原语的正常 / 边界 / 错误码 / 无泄漏测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CryptoError, DEFAULT_KDF, checkCodeStrength, clearBuffer,
  deriveKey, maskSecret, newSalt, normalizeCode, open, openJson, randomBytes,
  randomToken, seal, sealJson, unwrapKey, wrapKey
} from '../lib/crypto.mjs'

const FAST = { N: 1024, r: 8, p: 1 }
const SALT = Buffer.from('0123456789abcdef', 'utf8')
const KEY = Buffer.from('k'.repeat(32), 'utf8')
const CODE = 'kR7#mQp2Lz'

test('DEFAULT_KDF 是冻结的 N=32768/r=8/p=1/keyLen=32', () => {
  assert.equal(DEFAULT_KDF.N, 32768)
  assert.equal(DEFAULT_KDF.r, 8)
  assert.equal(DEFAULT_KDF.p, 1)
  assert.equal(DEFAULT_KDF.keyLen, 32)
  assert.ok(Object.isFrozen(DEFAULT_KDF))
})

test('randomBytes / randomToken / newSalt 长度正确且不重复', () => {
  assert.equal(randomBytes(16).length, 16)
  assert.notEqual(randomBytes(16).toString('hex'), randomBytes(16).toString('hex'))
  assert.match(randomToken(), /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(randomToken(8).length, 11) // 8B -> base64url 11 字符
  assert.equal(newSalt().length, 16)
  assert.notEqual(newSalt().toString('hex'), newSalt().toString('hex'))
  assert.throws(() => randomBytes(0), (err) => err instanceof CryptoError && err.code === 'BAD_INPUT')
  assert.throws(() => randomBytes(99999), (err) => err.code === 'BAD_INPUT')
})

test('normalizeCode 只 trim，不改大小写，空值返回空串', () => {
  assert.equal(normalizeCode('  AbC  '), 'AbC')
  assert.equal(normalizeCode('AbC'), normalizeCode('AbC'))
  assert.notEqual(normalizeCode('abc'), normalizeCode('ABC'))
  assert.equal(normalizeCode(''), '')
  assert.equal(normalizeCode(null), '')
  assert.equal(normalizeCode(undefined), '')
})

test('checkCodeStrength 拒绝弱码、接受强码', () => {
  const weak = [
    ['', '空'],
    ['abc123', '太短'],
    ['12345678', '纯数字 < 10 位'],
    ['11111111', '同一字符重复'],
    ['aaaaaaaa', '同一字符重复'],
    ['qwertyuiop', '键盘序列'],
    ['1234567890', '数字递减/递增序列'],
    ['password123', '常见串'],
    ['Abc#12 34xy', '含空格']
  ]
  for (const [code, why] of weak) {
    const result = checkCodeStrength(code)
    assert.equal(result.ok, false, '应拒绝：' + why)
    assert.ok(result.reason.length > 0, '必须给出中文原因：' + why)
    const trimmed = normalizeCode(code)
    if (trimmed) assert.ok(!result.reason.includes(trimmed), '原因里不要回显安全码')
    assert.match(result.reason, /[\u4e00-\u9fa5]/, '原因必须是中文')
  }
  const strong = ['kR7#mQp2Lz', '8371946251', 'Tr0ub4dor&3']
  for (const code of strong) {
    const result = checkCodeStrength(code)
    assert.equal(result.ok, true, '应接受：' + code)
    assert.equal(result.reason, '')
  }
})

test('deriveKey 确定、按盐/大小写隔离、长度 32', async () => {
  const a = await deriveKey(CODE, SALT, FAST)
  const b = await deriveKey(CODE, SALT, FAST)
  const other = await deriveKey(CODE, Buffer.from('fedcba9876543210', 'utf8'), FAST)
  const lower = await deriveKey(CODE.toLowerCase(), SALT, FAST)
  assert.equal(a.length, 32)
  assert.equal(a.toString('hex'), b.toString('hex'))
  assert.notEqual(a.toString('hex'), other.toString('hex'))
  assert.notEqual(a.toString('hex'), lower.toString('hex'), '安全码大小写敏感')
})

test('deriveKey 默认参数（N=32768）可用且 maxmem 足够', async () => {
  const key = await deriveKey(CODE, SALT)
  assert.equal(key.length, 32)
})

test('deriveKey 参数非法抛 BAD_KDF / BAD_INPUT', async () => {
  await assert.rejects(() => deriveKey(CODE, SALT, { N: 1 }), (err) => err.code === 'BAD_KDF')
  await assert.rejects(() => deriveKey(CODE, SALT, { keyLen: 8 }), (err) => err.code === 'BAD_KDF')
  await assert.rejects(() => deriveKey(CODE, Buffer.from('short'), FAST), (err) => err.code === 'BAD_INPUT')
})

test('seal/open 往返并产出 v:1 的 b64 盒子', () => {
  const box = seal(KEY, Buffer.from('hello 世界', 'utf8'), 'user:1')
  assert.equal(box.v, 1)
  assert.equal(Buffer.from(box.iv, 'base64').length, 12)
  assert.equal(Buffer.from(box.tag, 'base64').length, 16)
  assert.equal(open(KEY, box, 'user:1').toString('utf8'), 'hello 世界')
  assert.notEqual(box.data, 'hello 世界', '密文不能是明文')
  assert.notEqual(Buffer.from(box.data, 'base64').toString('utf8'), 'hello 世界')
  assert.notEqual(seal(KEY, 'x', 'a').iv, seal(KEY, 'x', 'a').iv, 'IV 必须随机')
})

test('open 在密钥错 / AAD 错 / 密文被改时抛 BAD_TAG', () => {
  const box = seal(KEY, 'payload', 'user:1')
  const wrongKey = Buffer.from('z'.repeat(32), 'utf8')
  assert.throws(() => open(wrongKey, box, 'user:1'), (err) => err instanceof CryptoError && err.code === 'BAD_TAG')
  assert.throws(() => open(KEY, box, 'user:2'), (err) => err.code === 'BAD_TAG')
  const flipped = Buffer.from(box.data, 'base64')
  flipped[0] ^= 0xff
  assert.throws(() => open(KEY, { ...box, data: flipped.toString('base64') }, 'user:1'), (err) => err.code === 'BAD_TAG')
  assert.throws(() => open(KEY, { ...box, tag: Buffer.alloc(16).toString('base64') }, 'user:1'), (err) => err.code === 'BAD_TAG')
})

test('open 对坏盒子/坏密钥抛 BAD_BOX / BAD_KEY', () => {
  const box = seal(KEY, 'x', 'a')
  assert.throws(() => open(KEY, null, 'a'), (err) => err.code === 'BAD_BOX')
  assert.throws(() => open(KEY, { iv: 'short', tag: box.tag, data: box.data }, 'a'), (err) => err.code === 'BAD_BOX')
  assert.throws(() => open(Buffer.alloc(16), box, 'a'), (err) => err.code === 'BAD_KEY')
  assert.throws(() => seal(Buffer.alloc(31), 'x', 'a'), (err) => err.code === 'BAD_KEY')
})

test('sealJson/openJson 往返，坏 JSON 抛 BAD_JSON', () => {
  const value = { v: 1, bindings: [{ id: 'b_1', printers: [{ serial: '01S00A123456789' }] }] }
  const box = sealJson(KEY, value, 'user:1')
  assert.deepEqual(openJson(KEY, box, 'user:1'), value)
  const notJson = seal(KEY, Buffer.from('{not json', 'utf8'), 'user:1')
  assert.throws(() => openJson(KEY, notJson, 'user:1'), (err) => err.code === 'BAD_JSON')
})

test('wrapKey/unwrapKey 包 DEK，AAD 不对就失败', () => {
  const dek = randomBytes(32)
  const kek = Buffer.from('K'.repeat(32), 'utf8')
  const box = wrapKey(kek, dek, 'user:1')
  assert.deepEqual(unwrapKey(kek, box, 'user:1'), dek)
  assert.throws(() => unwrapKey(kek, box, 'user:2'), (err) => err.code === 'BAD_TAG')
  assert.throws(() => wrapKey(kek, Buffer.alloc(16), 'user:1'), (err) => err.code === 'BAD_KEY')
})

test('maskSecret 只露末位，短值全遮，空值空串', () => {
  assert.equal(maskSecret('1234567890abcdef', 4), '••••cdef')
  assert.equal(maskSecret('short'), '••••')
  assert.equal(maskSecret('12345678', 4), '••••')
  assert.equal(maskSecret('', 4), '')
  assert.equal(maskSecret(null), '')
  assert.equal(maskSecret('abcdefghij', 2), '••••ij')
  assert.equal(maskSecret('abcdefghij', 0), '••••')
})

test('clearBuffer 全 0 且返回同一个 Buffer', () => {
  const buf = Buffer.from('secret-value', 'utf8')
  assert.equal(clearBuffer(buf), buf)
  assert.ok(buf.every((byte) => byte === 0))
  assert.equal(clearBuffer(null), null)
})

test('错误信息与返回值都不含测试 secret', () => {
  const secret = 'MY-SUPER-SECRET-77'
  const box = seal(KEY, secret, 'a')
  let message = ''
  try {
    open(Buffer.from('q'.repeat(32), 'utf8'), box, 'a')
  } catch (err) {
    message = String(err.message) + String(err.code) + String(err.name)
    assert.equal(err.name, 'CryptoError')
    assert.ok(err instanceof Error)
  }
  assert.ok(message.length > 0)
  assert.ok(!message.includes(secret))
  assert.ok(!message.includes(KEY.toString('utf8')))
  // 掩码结果也不该出现完整 secret
  assert.ok(!maskSecret(secret).includes(secret))
})
