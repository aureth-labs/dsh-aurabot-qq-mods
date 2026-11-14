// test/envelope.test.mjs —— 离线信封（BBX1）：格式互操作 + 服务端一次性/有效期策略。
//
// 这里测的是**真加密**：加密用 assets/enroll/bbx.js（就是 GitHub Pages 上跑的那一份），
// 解密用 lib/envelope.mjs，两边没有任何桩。所以「网页生成的、机器人能开」是真的验证过的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAGIC, generateKeyPair, openEnvelope, publicKeyToText, sealEnvelope, toBase64Url,
  fromBase64Url, encodeBody, decodeBody, looksLikeEnvelope,
} from '../assets/enroll/bbx.js'
import { createEnvelopeService, DEFAULT_ENROLL_BASE, maskAccount } from '../lib/envelope.mjs'
import { validateInputs, buildPayload, classify } from '../assets/enroll/enroll-form.js'

const ACCOUNT_EMAIL = 'me@example.com'
const ACCOUNT = 'me@example.com'
const PASSWORD = 'pw-DO-NOT-LEAK-123'


const nowSec = () => Math.floor(Date.now() / 1000)

async function tmpdir () {
  return mkdtemp(path.join(os.tmpdir(), 'bambu-env-'))
}

/** 起一个服务，同时返回它的公钥（模拟「/打印机 登录 拿到链接」那一步）。 */
async function svc (dir, opts = {}) {
  const service = createEnvelopeService({ dir, log: { info () {}, warn () {}, error () {}, debug () {} }, ...opts })
  await service.ensure()
  return service
}

const kit = async (service) => {
  const pub = service.publicKey()
  const now = nowSec()
  return {
    pub,
    login: (extra = {}) => sealEnvelope(pub, {
      account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: now, exp: now + 600, region: 'cn', ...extra,
    }),
  }
}

// ------------------------------------------------------------------ bbx.js 本身

test('bbx：base64url 往返，且不含 + / =', () => {
  for (const n of [1, 2, 3, 31, 32, 65, 99]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff)
    const text = toBase64Url(bytes)
    assert.doesNotMatch(text, /[+/=]/, '长度 ' + n + ' 的编码含非 url 安全字符：' + text)
    assert.deepEqual(Array.from(fromBase64Url(text)), Array.from(bytes))
  }
})

test('bbx：body 编码/解析往返，只有账号和密码', () => {
  const base = { ttlMin: 30, iat: 1000, exp: 2800, region: 'cn' }
  const body = decodeBody(encodeBody({ ...base, account: ACCOUNT, password: PASSWORD }))
  assert.equal(body.account, ACCOUNT)
  assert.equal(body.password, PASSWORD)
  assert.equal(body.ttlMin, 30)
  assert.equal(body.region, 'cn')
  assert.equal(body.flags & 2, 2, 'bit1 = 带账号')
})

test('bbx：非法输入在编码阶段就被拒（不是等到解密后才发现）', () => {
  const base = { ttlMin: 10, iat: 1000, exp: 1600, region: 'us' }
  assert.throws(() => encodeBody({ ...base, password: PASSWORD }), /账号/, '缺账号')
  assert.throws(() => encodeBody({ ...base, account: ACCOUNT }), /密码/, '缺密码')
  assert.throws(() => encodeBody({ ...base, account: ACCOUNT, password: PASSWORD, ttlMin: 0 }), /生存时间/, 'ttl 0')
  assert.throws(() => encodeBody({ ...base, account: ACCOUNT, password: PASSWORD, ttlMin: 1441 }), /生存时间/, 'ttl 超上限')
})

test('bbx：加密→解密 往返（账号密码带空格和中文也原样回来）', async () => {
  const kp = await generateKeyPair()
  const pub = publicKeyToText(kp.publicRaw)
  const now = nowSec()
  const tricky = { account: '用户@example.com', password: ' p@ss word ', ttlMin: 5, iat: now, exp: now + 300, region: 'eu' }
  const text = await sealEnvelope(pub, tricky)
  assert.match(text, /^BBX1\./)
  const out = await openEnvelope(kp.privateKey, text)
  // 账号只 trim；密码一个字符都不能动
  assert.equal(out.account, '用户@example.com')
  assert.equal(out.password, ' p@ss word ')
  assert.equal(out.region, 'eu')
})

test('bbx：换一把密钥就解不开（这是「不是给这台机器的」那条边界）', async () => {
  const a = await generateKeyPair()
  const b = await generateKeyPair()
  const now = nowSec()
  const text = await sealEnvelope(publicKeyToText(a.publicRaw), { account: ACCOUNT, password: PASSWORD, ttlMin: 5, iat: now, exp: now + 300, region: 'us' })
  await assert.rejects(() => openEnvelope(b.privateKey, text), (e) => e.code === 'BAD_TAG')
})

test('bbx：头部任意一位被改都解不开（AAD 覆盖 magic/ver/suite/eph/salt/iv）', async () => {
  const kp = await generateKeyPair()
  const now = nowSec()
  const text = await sealEnvelope(publicKeyToText(kp.publicRaw), { account: ACCOUNT, password: PASSWORD, ttlMin: 5, iat: now, exp: now + 300, region: 'us' })
  const bytes = fromBase64Url(text.slice('BBX1.'.length))
  // 挑几个关键位置各改一位：ver(4) / suite(5) / 临时公钥首字节(6) / salt(71) / iv(87)
  for (const at of [4, 5, 6, 71, 87]) {
    const copy = Uint8Array.from(bytes)
    copy[at] ^= 0x01
    const broken = MAGIC + '.' + toBase64Url(copy)
    await assert.rejects(() => openEnvelope(kp.privateKey, broken), (e) => {
      assert.ok(['BAD_TAG', 'BAD_VERSION', 'BAD_SUITE', 'BAD_FORMAT'].includes(e.code), '偏移 ' + at + ' 的错误码是 ' + e.code)
      return true
    })
  }
})

test('bbx：尾巴被截断 / 前面不是 BBX1. 都给明确错误，不崩', async () => {
  const kp = await generateKeyPair()
  const now = nowSec()
  const text = await sealEnvelope(publicKeyToText(kp.publicRaw), { account: ACCOUNT, password: PASSWORD, ttlMin: 5, iat: now, exp: now + 300, region: 'us' })
  // 截掉尾巴之后长度还在下限以上，所以是「解不开」而不是「格式不对」——两种都 fail-closed。
  await assert.rejects(() => openEnvelope(kp.privateKey, text.slice(0, text.length - 20)), (e) => e.code === 'BAD_TAG')
  // 截到比头部还短就是格式错误
  await assert.rejects(() => openEnvelope(kp.privateKey, text.slice(0, 60)), (e) => e.code === 'BAD_FORMAT')
  await assert.rejects(() => openEnvelope(kp.privateKey, 'BBX2.' + text.slice(5)), (e) => e.code === 'BAD_FORMAT')
  await assert.rejects(() => openEnvelope(kp.privateKey, 'whatever'), (e) => e.code === 'BAD_FORMAT')
  await assert.rejects(() => openEnvelope(kp.privateKey, '   '), (e) => e.code === 'BAD_FORMAT')
})

test('bbx：looksLikeEnvelope 用于界面提示，不会把短串认成信封', () => {
  assert.equal(looksLikeEnvelope('BBX1.' + 'A'.repeat(200)), true)
  assert.equal(looksLikeEnvelope('BBX1.short'), false)
  assert.equal(looksLikeEnvelope('hello'), false)
  assert.equal(looksLikeEnvelope(''), false)
})

// ------------------------------------------------------------------ 信封服务

test('服务：首次 ensure 生成密钥，公钥 87 字符，指纹 = SHA-256(公钥) 前 4 字节', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const pub = service.publicKey()
    assert.equal(pub.length, 87)
    assert.match(pub, /^[A-Za-z0-9_-]{87}$/)
    assert.equal(service.fingerprint().length, 8)
    assert.match(service.fingerprint(), /^[0-9a-f]{8}$/)
    const { createHash } = await import('node:crypto')
    const want = createHash('sha256').update(Buffer.from(fromBase64Url(pub))).digest('hex').slice(0, 8)
    assert.equal(service.fingerprint(), want, '指纹要和网页上显示的那串算法一致')
    assert.ok(service.keyCreatedAt() > 0)

    // 落盘的文件里只有私钥的 JWK，没有任何明文秘密
    const raw = await readFile(path.join(dir, 'bbx-key.json'), 'utf8')
    assert.match(raw, /privateJwk/)
    assert.equal(raw.includes(PASSWORD), false)
    assert.equal(raw.includes(PASSWORD), false)
    // 重启复用同一把
    const again = await svc(dir)
    assert.equal(again.publicKey(), pub, '重启后必须还是同一把钥，否则用户手里的链接全废')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：登录信封解出全部字段，kind 判定正确', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const k = await kit(service)

    const login = await service.open(await k.login())
    assert.equal(login.kind, 'login')
    assert.equal(login.account, ACCOUNT)
    assert.equal(login.password, PASSWORD)
    assert.equal(login.account, ACCOUNT)
    assert.equal(login.password, PASSWORD)
    assert.equal(login.region, 'cn')
    assert.ok(login.exp > login.iat)

    // 第二个信封同样只能是登录
    const again = await service.open(await k.login())
    assert.equal(again.kind, 'login')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：同一个信封只能用一次（REPLAYED）', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const k = await kit(service)
    const text = await k.login()
    await service.open(text)
    await assert.rejects(() => service.open(text), (e) => e.code === 'REPLAYED')
    // 换一段新的照常能用
    await service.open(await k.login())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：jti 落盘，进程重启后旧信封仍然拒收（不只是内存里记着）', async () => {
  const dir = await tmpdir()
  try {
    const first = await svc(dir)
    const k = await kit(first)
    const text = await k.login()
    await first.open(text)
    const used = JSON.parse(await readFile(path.join(dir, 'bbx-used.json'), 'utf8'))
    assert.equal(used.v, 1)
    assert.equal(Object.keys(used.used).length, 1)

    const second = await svc(dir)
    await assert.rejects(() => second.open(text), (e) => e.code === 'REPLAYED')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：失败（篡改 / 解不开）也要作废，不能拿同一段反复试', async () => {
  // 这里测的是「解不开的那段本来也用不了」，所以改坏一段之后 SS 仍然不接受它，
  // 并且不会因此把别人的合法信封误标成已用。
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const k = await kit(service)
    const good = await k.login()
    const broken = good.slice(0, -6) + 'AAAAAA'
    await assert.rejects(() => service.open(broken), (e) => e.code === 'BAD_TAG')
    assert.equal(service.stats().used, 0, '解不开的密文没有可信 jti，不该记进已用表')
    await service.open(good)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：过期信封拒收；120 秒时钟容差内仍然接受', async () => {
  const dir = await tmpdir()
  try {
    // 时间全部由 now 注入，避免依赖真实时钟
    const fixed = 1_800_000_000_000 // 毫秒
    const service = await svc(dir, { now: () => fixed })
    const k = await kit(service)
    const nowS = Math.floor(fixed / 1000)

    const fresh = await sealEnvelope(k.pub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowS - 400, exp: nowS - 100, region: 'us' })
    await service.open(fresh) // 过期 100 秒 < 120 秒容差 → 收

    const stale = await sealEnvelope(k.pub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowS - 900, exp: nowS - 130, region: 'us' })
    await assert.rejects(() => service.open(stale), (e) => e.code === 'EXPIRED', '过期 130 秒应当拒')

    const future = await sealEnvelope(k.pub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowS + 300, exp: nowS + 600, region: 'us' })
    await assert.rejects(() => service.open(future), (e) => e.code === 'NOT_YET')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：生存时间超过本机上限直接拒，改设置后立即生效', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir, { maxTtlMinutes: 10 })
    const k = await kit(service)
    const long = await sealEnvelope(k.pub, { account: ACCOUNT, password: PASSWORD, ttlMin: 60, iat: nowSec(), exp: nowSec() + 3600, region: 'us' })
    await assert.rejects(() => service.open(long), (e) => {
      assert.equal(e.code, 'BAD_PAYLOAD')
      assert.match(e.message, /60/, '要说出具体是多少分钟')
      return true
    })
    // 上调上限后同一段就能用了（不用重建服务）
    assert.equal(service.setMaxTtlMinutes(120), 120)
    await service.open(long)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：inspect 只给摘要，不含秘密，且不消费信封', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const k = await kit(service)
    const text = await k.login()
    const info = await service.inspect(text)
    assert.equal(info.ok, true)
    assert.equal(info.kind, 'login')
    assert.equal(info.accountMasked, 'm***@example.com')
    assert.equal(info.hasPassword, true)
    assert.equal(info.region, 'cn')
    const dumped = JSON.stringify(info)
    assert.equal(dumped.includes(PASSWORD), false, 'inspect 不能回显安全码')
    assert.equal(dumped.includes(PASSWORD), false, 'inspect 不能回显密码')
    assert.equal(dumped.includes(ACCOUNT), false, '账号必须是掩码，不能出现明文')
    // 关键：inspect 不消费
    assert.equal(service.stats().used, 0)
    const opened = await service.open(text)
    assert.equal(opened.account, ACCOUNT)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：rotate 换钥后，旧公钥加密的信封全部解不开，已用记录清空', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const oldPub = service.publicKey()
    const oldText = await sealEnvelope(oldPub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowSec(), exp: nowSec() + 600, region: 'us' })
    await service.open(oldText)
    assert.equal(service.stats().used, 1)

    const rotated = await service.rotate()
    assert.notEqual(rotated.publicKey, oldPub)
    assert.equal(service.stats().used, 0, '换了钥之后旧 jti 表就该清掉')

    // 旧公钥生成的（没消费过的）信封也解不开了
    const stale = await sealEnvelope(oldPub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowSec(), exp: nowSec() + 600, region: 'us' })
    await assert.rejects(() => service.open(stale), (e) => e.code === 'BAD_TAG')
    // 新公钥的照常
    const fresh = await sealEnvelope(rotated.publicKey, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowSec(), exp: nowSec() + 600, region: 'us' })
    await service.open(fresh)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：链接 = 前缀 + #k=公钥；留空用内置地址；非 http(s) 直接拒', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const pub = service.publicKey()
    assert.equal(service.link(''), DEFAULT_ENROLL_BASE + '#k=' + pub)
    assert.equal(service.link('https://me.github.io/x/'), 'https://me.github.io/x/#k=' + pub)
    // 末尾已经带 # 的不要再叠一个
    assert.equal(service.link('https://me.github.io/x/#'), 'https://me.github.io/x/#k=' + pub)
    assert.throws(() => service.link('ftp://evil/'), (e) => e.code === 'BAD_INPUT')
    assert.throws(() => service.link('javascript:alert(1)'), (e) => e.code === 'BAD_INPUT')
    assert.match(DEFAULT_ENROLL_BASE, /^https:\/\//)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('仅内存模式：磁盘上没有任何私钥文件，但加解密照常工作', async () => {
  const dir = await tmpdir()
  try {
    const service = createEnvelopeService({
      dir, keyMode: 'ephemeral', log: { info () {}, warn () {}, error () {}, debug () {} },
    })
    await service.ensure()
    const pub = service.publicKey()
    assert.equal(pub.length, 87)

    // 关键断言：数据目录里没有 bbx-key.json
    const listing = await fs.readdir(dir).catch(() => [])
    assert.equal(listing.includes('bbx-key.json'), false, '仅内存模式绝不能把私钥落盘：' + listing.join(','))

    // 功能不变：能加密、能解开
    const now = nowSec()
    const text = await sealEnvelope(pub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: now, exp: now + 600, region: 'cn' })
    const opened = await service.open(text)
    assert.equal(opened.kind, 'login')
    assert.equal(opened.account, ACCOUNT)

    // 重启（新实例）就是新密钥：旧链接和旧信封一起失效，这是模式的代价，要如实发生
    const again = createEnvelopeService({ dir, keyMode: 'ephemeral', log: { info () {}, warn () {}, error () {}, debug () {} } })
    await again.ensure()
    assert.notEqual(again.publicKey(), pub, '仅内存模式重启必须换钥')
    await assert.rejects(() => again.open(text), (e) => e.code === 'BAD_TAG')

    // 磁盘上依然什么都没有
    const listing2 = await fs.readdir(dir).catch(() => [])
    assert.equal(listing2.includes('bbx-key.json'), false, listing2.join(','))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('仅内存模式：会删掉上一任落盘的旧私钥（否则「磁盘上没有私钥」是假的）', async () => {
  const dir = await tmpdir()
  try {
    // 先用 file 模式造一份密钥文件
    const fileMode = await svc(dir)
    const oldPub = fileMode.publicKey()
    assert.equal(existsSync(path.join(dir, 'bbx-key.json')), true, 'file 模式应当落盘')

    // 切到仅内存：必须自己生成新钥，且**删掉**旧钥。
    // 留着旧钥的后果很具体：旧链接还在用户手里 → 用户用它生成一段信封 → 本模块拒收，
    // 但那段密文已经躺在聊天记录里了；事后拿到数据目录的人用这把旧钥就能解开它。
    const eph = createEnvelopeService({ dir, keyMode: 'ephemeral', log: { info () {}, warn () {}, error () {}, debug () {} } })
    await eph.ensure()
    assert.notEqual(eph.publicKey(), oldPub, '仅内存模式必须自己生成，不能读磁盘上那把')
    assert.equal(existsSync(path.join(dir, 'bbx-key.json')), false, '旧私钥必须被删掉，不能只是「不用」')

    // 而旧公钥生成的密文，用新私钥解不开（这才是要保证的事）
    const stale = await sealEnvelope(oldPub, { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: nowSec(), exp: nowSec() + 600, region: 'us' })
    await assert.rejects(() => eph.open(stale), (e) => e.code === 'BAD_TAG')

    // rotate 在仅内存模式下也不写盘
    const beforeRotate = eph.publicKey()
    const rotated = await eph.rotate()
    assert.notEqual(rotated.publicKey, beforeRotate, 'rotate 要换一把新的')
    assert.equal(existsSync(path.join(dir, 'bbx-key.json')), false, 'rotate 也不该把私钥写回磁盘')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('仅内存模式：私钥文件删不掉时如实报错，不能假装磁盘已经干净', async () => {
  // 用一个同名目录占住 bbx-key.json：unlink 一个目录在 Linux 上是 EISDIR、在 Windows 上是 EPERM，
  // 两边都会走到「删不掉」的分支。（不能靠把目录 chmod 成只读：ensure() 里的 #ensureDir() 会把它改回 0700。）
  const dir = await tmpdir()
  try {
    const fileMode = await svc(dir)
    assert.ok(fileMode.publicKey())
    const keyFile = path.join(dir, 'bbx-key.json')
    await rm(keyFile, { force: true })
    await fs.mkdir(keyFile, { recursive: true })
    try {
      const eph = createEnvelopeService({ dir, keyMode: 'ephemeral', log: { info () {}, warn () {}, error () {}, debug () {} } })
      await assert.rejects(() => eph.ensure(), (e) => e.code === 'IO')
    } finally {
      await rm(keyFile, { recursive: true, force: true }).catch(() => {})
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('私钥放别处：keyPath 指到数据目录之外，数据目录里不生成私钥', async () => {
  const dataDir = await tmpdir()
  const keyDir = await tmpdir()
  const keyPath = path.join(keyDir, 'enroll-key.json')
  try {
    const service = createEnvelopeService({
      dir: dataDir, keyPath, log: { info () {}, warn () {}, error () {}, debug () {} },
    })
    await service.ensure()
    assert.equal(service.publicKey().length, 87)

    // 私钥落在指定的外部路径，而不是数据目录
    assert.equal(existsSync(keyPath), true, '私钥应当落在 keyPath')
    assert.equal(existsSync(path.join(dataDir, 'bbx-key.json')), false, '数据目录里不能再生成一份')
    const listing = await readdir(dataDir).catch(() => [])
    assert.equal(listing.includes('bbx-key.json'), false, listing.join(','))

    // 功能正常
    const now = nowSec()
    const text = await sealEnvelope(service.publicKey(), { account: ACCOUNT, password: PASSWORD, ttlMin: 10, iat: now, exp: now + 600, region: 'cn' })
    const opened = await service.open(text)
    assert.equal(opened.account, ACCOUNT)

    // 重启复用同一个 keyPath
    const again = createEnvelopeService({ dir: dataDir, keyPath, log: { info () {}, warn () {}, error () {}, debug () {} } })
    await again.ensure()
    assert.equal(again.publicKey(), service.publicKey(), '重启后要用同一把钥')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(keyDir, { recursive: true, force: true })
  }
})

test('私钥放别处：只接受绝对路径，且不能和「仅内存」同时设置', async () => {
  const dir = await tmpdir()
  try {
    assert.throws(
      () => createEnvelopeService({ dir, keyPath: 'relative/key.json', log: { info () {}, warn () {}, error () {}, debug () {} } }),
      (e) => e.code === 'BAD_INPUT',
      '相对路径会跟着工作目录漂移，必须拒',
    )
    assert.throws(
      () => createEnvelopeService({ dir, keyPath: path.join(dir, 'k.json'), keyMode: 'ephemeral', log: { info () {}, warn () {}, error () {}, debug () {} } }),
      (e) => e.code === 'BAD_INPUT',
      '两者语义冲突：要么用外部文件，要么纯内存',
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：密钥文件坏了要报 BAD_KEY，绝不满血复活换个新的', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const pub = service.publicKey()
    const file = path.join(dir, 'bbx-key.json')
    const good = await readFile(file, 'utf8')

    // 1) 不是 JSON
    await writeFile(file, '{not json', 'utf8')
    const broken = createEnvelopeService({ dir, log: { info () {}, warn () {}, error () {}, debug () {} } })
    await assert.rejects(() => broken.ensure(), (e) => e.code === 'BAD_KEY')
    assert.equal(await readFile(file, 'utf8'), '{not json', '坏文件不能被覆盖掉：那会让人以为只是换了把钥')

    // 2) kty 不对
    await writeFile(file, JSON.stringify({ v: 1, alg: 'P-256', createdAt: 1, publicKey: pub, privateJwk: { kty: 'RSA' } }), 'utf8')
    const wrong = createEnvelopeService({ dir, log: { info () {}, warn () {}, error () {}, debug () {} } })
    await assert.rejects(() => wrong.ensure(), (e) => e.code === 'BAD_KEY')

    // 3) 修回去就能用（不因为一次失败就永久卡住）
    await writeFile(file, good, 'utf8')
    const fixed = await svc(dir)
    assert.equal(fixed.publicKey(), pub)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：已用记录文件坏了只告警、不阻断（重放保护降级但功能还在）', async () => {
  const dir = await tmpdir()
  try {
    await svc(dir)
    await writeFile(path.join(dir, 'bbx-used.json'), 'garbage', 'utf8')
    const service = await svc(dir)
    const k = await kit(service)
    await service.open(await k.login())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：并发 open 同一个信封，恰好成功一次', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const k = await kit(service)
    const text = await k.login()
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.open(text)))
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(ok.length, 1, '只能成功一次')
    assert.equal(rejected.length, 7)
    for (const r of rejected) assert.equal(r.reason.code, 'REPLAYED')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务：错误话术里不出现任何明文秘密', async () => {
  const dir = await tmpdir()
  try {
    const service = await svc(dir)
    const k = await kit(service)
    const text = await k.login()
    const messages = []
    await service.open(text)
    try { await service.open(text) } catch (e) { messages.push(e.message, e.code) }
    try { await service.open(text.slice(0, -8) + 'ZZZZZZZZ') } catch (e) { messages.push(e.message, e.code) }
    const dumped = messages.join('\n')
    assert.equal(dumped.includes(PASSWORD), false)
    assert.equal(dumped.includes(PASSWORD), false)
    assert.equal(dumped.includes(ACCOUNT), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------------------------ 表单逻辑（网页端）

test('表单：现在只有「登录」一种用途，账号密码必填', () => {
  assert.equal(classify({ account: ACCOUNT, password: PASSWORD }), 'login')
  // 只填了账号（没密码）也归到 login，让 validateInputs 报缺密码
  assert.equal(classify({ account: ACCOUNT }), 'login')
  // 什么都不填也是 login，但校验会报错
  assert.equal(classify({}), 'login')
})

test('表单：校验通过时 buildPayload 和 bbx.encodeBody 能直接对接', async () => {
  const input = { account: ACCOUNT, password: PASSWORD, ttlMin: 30, region: 'cn' }
  const verdict = validateInputs(input)
  assert.equal(verdict.ok, true, '不该有错：' + verdict.errors.join('；'))
  assert.equal(verdict.kind, 'login')
  const payload = buildPayload(input)
  assert.equal(payload.ttlMin, 30)
  assert.equal(payload.exp - payload.iat, 30 * 60)
  // 真跑一次 encode，确认字段组合合法
  const body = decodeBody(encodeBody(payload))
  assert.equal(body.account, ACCOUNT)
})

test('表单：默认区域是中国大陆（大多数用户是国服账号）', () => {
  const payload = buildPayload({ account: ACCOUNT, password: PASSWORD })
  assert.equal(payload.region, 'cn')
})

test('表单：该拒的都要拒，且错误里不带密码原文', () => {
  const cases = [
    [{ ttlMin: 10 }, /请填写 Bambu 账号和密码/],
    [{ account: ACCOUNT, ttlMin: 10 }, /请填写 Bambu 密码/],
    [{ password: PASSWORD, ttlMin: 10 }, /请填写 Bambu 账号/],
    [{ account: 'not-an-account', password: PASSWORD, ttlMin: 10 }, /邮箱/],
    [{ account: ACCOUNT, password: PASSWORD, ttlMin: 0 }, /1~1440/],
    [{ account: ACCOUNT, password: PASSWORD, ttlMin: 1441 }, /1~1440/],
    [{ account: ACCOUNT, password: PASSWORD, ttlMin: 'abc' }, /整数/],
    [{ account: ACCOUNT, password: PASSWORD, ttlMin: 1.5 }, /整数/],
  ]
  for (const [input, pattern] of cases) {
    const v = validateInputs(input)
    assert.equal(v.ok, false, '应当被拒：' + JSON.stringify(input))
    assert.match(v.errors.join('；'), pattern)
    assert.equal(v.errors.join('').includes(PASSWORD), false, '错误信息不能回显密码')
  }
})

test('表单：不再有任何「安全码强度」提示（安全码已取消）', () => {
  const v = validateInputs({ account: ACCOUNT, password: PASSWORD, ttlMin: 10 })
  assert.equal(v.ok, true)
  assert.equal(v.warnings.join(''), '', '不该再出现弱码提示')
})

test('表单：账号掩码', () => {
  assert.equal(maskAccount('me@example.com'), 'm***@example.com')
  assert.equal(maskAccount('13800138000'), '138****8000')
  assert.equal(maskAccount(''), '')
  // 掩码不能把整个账号露出来
  assert.equal(maskAccount('ab@cd.ef').includes('ab@'), false)
})
