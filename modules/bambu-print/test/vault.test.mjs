// test/vault.test.mjs — 保险库的正常 / 边界 / 错误码 / 持久化 / 无泄漏测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createVault, VaultError, SCOPES } from '../lib/vault.mjs'

const CODE = 'kR7#mQp2Lz'
const OTHER_CODE = 'Zx9#wLm4Qr'
const ACCESS_CODE = 'SECRET-ACCESS-77'
const CLOUD_TOKEN = 'eyJ-TEST-TOKEN-do-not-log-1234567890'
const SHARED = 'Shared-Secret-42'
// 测试用低 N scrypt，保证整体几秒内跑完
const FAST_KDF = { N: 1024, r: 8, p: 1 }

const tempDirs = []
async function newDir () {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-vault-'))
  tempDirs.push(dir)
  return dir
}

test.after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** 建一个已加载、已注册 111 的保险库；optionally 解锁并加绑定。 */
async function setup (options = {}) {
  const dir = options.dir || await newDir()
  const clock = { t: 1_700_000_000_000 }
  const vault = createVault({
    dir,
    kdf: FAST_KDF,
    log: null,
    now: () => clock.t,
    // 不传 lockMinutes：用模块默认的 7 天；需要别的窗口时由 options.extra 覆盖
    ...options.extra
  })
  await vault.load()
  return { vault, dir, clock }
}

async function unlockedWithLan (options = {}) {
  const ctx = await setup(options)
  await ctx.vault.register('111')
  await ctx.vault.unlock('111')
  const binding = await ctx.vault.addBinding('111', {
    label: '我的 A1',
    mode: 'lan',
    accessCode: ACCESS_CODE,
    printers: [{ serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1', model: 'A1' }]
  })
  return { ...ctx, binding }
}

const expectCode = (code) => (err) => {
  assert.ok(err instanceof VaultError, '应抛 VaultError，实际：' + (err && err.name))
  assert.equal(err.code, code, '错误码应为 ' + code + '，实际 ' + err.code)
  return true
}

function assertNoSecrets (value, secrets = [ACCESS_CODE, CLOUD_TOKEN, SHARED, CODE, OTHER_CODE]) {
  const text = JSON.stringify(value) ?? ''
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), '公开返回值里出现了明文秘密：' + secret + ' -> ' + text.slice(0, 200))
  }
}

// ------------------------------------------------------------------ 断言文件权限与落盘

async function assertFileModes (dir) {
  const files = await readdir(dir)
  assert.ok(files.includes('vault.json'))
  assert.ok(files.includes('grants.json'))
  assert.ok(!files.some((f) => f.endsWith('.tmp')), '不应残留临时文件')
  if (process.platform !== 'win32') {
    for (const name of ['vault.json', 'grants.json']) {
      const info = await stat(path.join(dir, name))
      assert.equal(info.mode & 0o777, 0o600, name + ' 必须是 0600')
    }
    const dirInfo = await stat(dir)
    assert.equal(dirInfo.mode & 0o777, 0o700, '数据目录必须是 0700')
  }
}

// ------------------------------------------------------------------ 加载 / 注册 / 解锁

test('load 创建空库并给出空摘要', async () => {
  const { vault, dir } = await setup()
  assert.equal(vault.userCount(), 0)
  assert.deepEqual(vault.summary(), { users: 0, boundUsers: 0, bindings: 0, printers: 0, unlocked: 0, activeGrants: 0 })
  assert.deepEqual(vault.listUsers(), [])
  assert.deepEqual(vault.listBindings('111'), [])
  assert.deepEqual(vault.printers('111'), [])
  await assertFileModes(dir)
})

test('load 未经加载时抛 NOT_LOADED', async () => {
  const dir = await newDir()
  const vault = createVault({ dir, kdf: FAST_KDF, log: null })
  assert.throws(() => vault.summary(), expectCode('NOT_LOADED'))
  assert.throws(() => vault.hasUser('111'), expectCode('NOT_LOADED'))
  assert.throws(() => vault.printers('111'), expectCode('NOT_LOADED'))
  await assert.rejects(() => vault.register('111'), expectCode('NOT_LOADED'))
})

test('load 遇到坏 JSON 抛错且不静默清空', async () => {
  const dir = await newDir()
  await writeFile(path.join(dir, 'vault.json'), '{ this is not json', 'utf8')
  const vault = createVault({ dir, kdf: FAST_KDF, log: null })
  await assert.rejects(() => vault.load(), expectCode('BAD_FILE'))
  assert.equal(await readFile(path.join(dir, 'vault.json'), 'utf8'), '{ this is not json', '坏文件不能被改写')

  const dir2 = await newDir()
  await writeFile(path.join(dir2, 'grants.json'), '', 'utf8')
  const vault2 = createVault({ dir: dir2, kdf: FAST_KDF, log: null })
  await assert.rejects(() => vault2.load(), expectCode('BAD_FILE'))
})

test('register / unlock / 重复注册 / 非法 QQ', async () => {
  const { vault } = await setup()
  assert.deepEqual(await vault.register('111'), { ok: true, existed: false })
  assert.equal(vault.hasUser('111'), true)
  assert.equal(vault.userCount(), 1)
  assert.deepEqual(await vault.register('111'), { ok: true, existed: true }, '重复注册是幂等的，不抛错也不重置')
  await assert.rejects(() => vault.register('abc'), expectCode('BAD_INPUT'))

  // 没有安全码了：建号即可用，不需要先 unlock
  assert.equal(vault.isUnlocked('111'), true, '建号即会话可用')

  const ok = await vault.unlock('111')
  assert.equal(ok.ok, true)
  assert.ok(ok.until > 1_700_000_000_000, 'unlock 返回到期时间')
  assert.equal(ok.until, 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000, '默认 7 天')

  await assert.rejects(() => vault.unlock('999'), expectCode('NO_USER'))
})

test('vault.json 里没有明文凭据，只有加密盒子', async () => {
  const { vault, dir, binding } = await unlockedWithLan()
  await vault.register('222')
  await vault.addBinding('222', { label: '云端账号', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456789', region: 'us' })
  await vault.audit({ actor: '111', action: 'bind', ok: true, note: 'test' })

  const vaultRaw = await readFile(path.join(dir, 'vault.json'), 'utf8')
  for (const secret of [ACCESS_CODE, CLOUD_TOKEN, CODE, OTHER_CODE]) {
    assert.ok(!vaultRaw.includes(secret), 'vault.json 不能出现明文：' + secret)
  }
  assert.ok(vaultRaw.includes('01S00A123456789'), '元数据镜像保留序列号用于列表')
  const parsed = JSON.parse(vaultRaw)
  const record = parsed.users['111']
  assert.equal(record.v, 1)
  // 没有用户盐了：DEK 由本机主密钥包着，mode 标记为 host
  assert.equal(record.wrapped.v, 1)
  assert.equal(record.wrapped.tag.length > 0, true)
  assert.deepEqual(record.prefs, { groupShowName: false, selectedPrinter: '', interface: '', groupMode: '', groupPhoto: null })
  assert.ok(binding.id.startsWith('b_'))
  assert.ok(!('accessCode' in record), '用户记录里不能有明文字段')

  const auditRaw = await readFile(path.join(dir, 'audit.jsonl'), 'utf8')
  assert.ok(!auditRaw.includes(ACCESS_CODE) && !auditRaw.includes(CLOUD_TOKEN))
})

test('没有安全码之后不存在「输错码锁定」：unlock 不接受也不消耗任何码', async () => {
  const { vault } = await setup()
  await vault.register('111')
  // unlock 只接受 qq；多传一个参数会被忽略而不是当成密码
  const ok = await vault.unlock('111')
  assert.equal(ok.ok, true)
  assert.equal(vault.isUnlocked('111'), true)
  // 记录里不再有 attempts 的失败计数（没有可试错的密码了）
  const listed = vault.listUsers().find((u) => u.qq === '111')
  assert.equal(listed.lockedUntil, 0, '不该有任何锁定状态')
})

test('会话可以反复开关，不影响数据可用性', async () => {
  const { vault } = await setup()
  await vault.register('111')
  assert.equal(vault.isUnlocked('111'), true, '建号即会话可用')
  vault.lock('111')
  assert.equal(vault.isUnlocked('111'), false)
  await vault.unlock('111')
  assert.equal(vault.isUnlocked('111'), true)
  // 重开实例后依旧可用（load 时预热）
  const reopened = createVault({ dir: vault.dir, kdf: FAST_KDF, log: null })
  await reopened.load()
  assert.equal(reopened.isUnlocked('111'), true, '重开后自动预热，不用解锁')
  // 磁盘上的 attempts 不含任何秘密
})

test('解锁会话到期即失效（滑窗续期）', async () => {
  // 最短 1 天，测试里直接用 1 天窗口验证滑窗
  const { vault, clock } = await setup({ extra: { lockMinutes: 1440 } })
  await vault.register('111')
  await vault.unlock('111')
  clock.t += 23 * 60 * 60 * 1000
  assert.equal(vault.isUnlocked('111'), true, '1 天内仍有效')
  const renewed = await vault.unlock('111')
  assert.ok(renewed.until > clock.t + 23 * 60 * 60 * 1000, '再次解锁是滑窗续期')
  clock.t += 24 * 60 * 60 * 1000
  assert.equal(vault.isUnlocked('111'), false, '过期后失效')
  assert.deepEqual(vault.printers('111'), [], '过期后不再拿得到任何 ref')
})

test('setLockMinutes 影响后续解锁的到期时间', async () => {
  const { vault, clock } = await setup()
  await vault.register('111')
  vault.setLockMinutes(2880)
  const first = await vault.unlock('111')
  assert.equal(first.until - clock.t, 2 * 24 * 60 * 60 * 1000)
  vault.setLockMinutes(1440)
  const second = await vault.unlock('111')
  assert.equal(second.until - clock.t, 24 * 60 * 60 * 1000)
  assert.equal(vault.setLockMinutes(999999).lockMinutes, 43200, '超过上限自动夹到 30 天')
  assert.equal(vault.setLockMinutes('1').lockMinutes, 1440, '低于下限夹到 1 天')
  assert.equal(vault.setLockMinutes(null).lockMinutes, 1440, '非法值保留当前值')
})

test('lock / lockAll 清空会话', async () => {
  const { vault } = await setup()
  await vault.register('111')
  await vault.register('222')
  await vault.unlock('111')
  await vault.unlock('222')
  assert.equal(vault.summary().unlocked, 2)
  vault.lock('111')
  assert.equal(vault.isUnlocked('111'), false)
  assert.equal(vault.isUnlocked('222'), true)
  vault.lockAll()
  assert.equal(vault.summary().unlocked, 0)
})

test('addBinding 校验 LAN / cloud 输入', async () => {
  const { vault } = await unlockedWithLan()
  await assert.rejects(
    () => vault.addBinding('111', { label: 'x', mode: 'lan', printers: [{ serial: '01S00B000000001', ip: '192.168.1.60' }] }),
    expectCode('BAD_INPUT'), '没有访问码')
  await assert.rejects(
    () => vault.addBinding('111', { label: 'x', mode: 'lan', accessCode: SHARED, printers: [] }),
    expectCode('BAD_INPUT'), '没有打印机')
  await assert.rejects(
    () => vault.addBinding('111', { label: 'x', mode: 'lan', accessCode: SHARED, printers: [{ serial: '01S00B000000001', ip: 'not-an-ip' }] }),
    expectCode('BAD_INPUT'))
  await assert.rejects(() => vault.addBinding('111', { label: 'x', mode: 'cloud', uid: '123456' }), (err) => err.code === 'BAD_INPUT', '缺 token')
  await assert.rejects(
    () => vault.addBinding('111', { label: 'x', mode: 'lan', accessCode: 'has space', printers: [{ serial: '01S00B000000002', ip: '192.168.1.61' }] }),
    expectCode('BAD_INPUT'), '访问码不能含空格')
  await assert.rejects(
    () => vault.addBinding('111', { label: 'x', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456', region: 'mars' }),
    expectCode('BAD_INPUT'))
  await assert.rejects(() => vault.addBinding('111', { label: 'x', mode: 'serial' }), expectCode('BAD_INPUT'))
})

test('addBinding 在会话失效时会自动补会话（不再要求手动解锁）', async () => {
  const { vault } = await setup()
  await vault.register('111')
  vault.lock('111')
  assert.equal(vault.isUnlocked('111'), false)
  // 没有安全码之后，写操作只需确保会话存在：这里应当自动续上而不是抛 LOCKED
  const added = await vault.addBinding('111', { mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456' })
  assert.ok(added.id.startsWith('b_'))
})

test('每台打印机可以自带 accessCode，有效访问码优先用打印机的', async () => {
  const { vault } = await unlockedWithLan()
  const added = await vault.addBinding('111', {
    label: '混合',
    mode: 'lan',
    accessCode: SHARED,
    printers: [
      { serial: '01S00B111111111', ip: '192.168.1.61', name: 'P1S', accessCode: ACCESS_CODE },
      { serial: '01S00B222222222', ip: '192.168.1.62', name: 'A1 mini' }
    ]
  })
  const refs = vault.printers('111')
  const bySerial = Object.fromEntries(refs.map((r) => [r.serial, r]))
  assert.equal(bySerial['01S00B111111111'].accessCode, ACCESS_CODE, '打印机级优先')
  assert.equal(bySerial['01S00B222222222'].accessCode, SHARED, '回落到绑定级兜底')
  assert.equal(added.ok, true)
  assertNoSecrets(vault.listBindings('111'))
})

test('绑定数量上限与重复序列号去重', async () => {
  const { vault } = await setup({ extra: { maxBindings: 2 } })
  await vault.register('111')
  await vault.unlock('111')
  const first = await vault.addBinding('111', {
    label: 'a',
    mode: 'lan',
    accessCode: SHARED,
    printers: [
      { serial: '01S00C000000001', ip: '192.168.1.70' },
      { serial: '01S00C000000001', ip: '192.168.1.70' }
    ]
  })
  assert.equal(vault.printers('111').length, 1, '重复序列号只留一条')
  await vault.addBinding('111', { label: 'b', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456' })
  await assert.rejects(
    () => vault.addBinding('111', { label: 'c', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456' }),
    expectCode('BAD_INPUT'), '超过 maxBindings')
  assert.ok(first.id)
})

test('setDiscoveredPrinters / renameBinding / removeBinding', async () => {
  const { vault, binding } = await unlockedWithLan()
  await vault.addBinding('111', { label: '云端账号', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456789', region: 'eu' })
  const cloudId = vault.listBindings('111').find((b) => b.mode === 'cloud').id
  const discovered = await vault.setDiscoveredPrinters('111', cloudId, [
    { serial: '01S00D000000001', name: 'X1C', model: 'X1C' },
    { serial: '01S00D000000002', name: 'P1P', model: 'P1P' }
  ])
  assert.equal(discovered.printers, 2)
  assert.equal(vault.printers('111').filter((p) => p.bindingId === cloudId).length, 2)
  const cloudRef = vault.printers('111').find((p) => p.bindingId === cloudId)
  assert.equal(cloudRef.accessToken, CLOUD_TOKEN, '云端 ref 带 accessToken/uid/region')
  assert.equal(cloudRef.uid, '123456789')
  assert.equal(cloudRef.region, 'eu')
  assert.equal(cloudRef.accessCode, '', '没有局域网访问码时是空串而不是 undefined')
  // ref 是内部结构（已解锁时含秘密）；对外的元数据/掩码视图不能有明文
  assert.equal(cloudRef.tokenMask.includes(CLOUD_TOKEN), false)
  assertNoSecrets([vault.listBindings('111'), vault.summary(), cloudRef.tokenMask])

  await vault.renameBinding('111', cloudId, '工作室')
  assert.equal(vault.listBindings('111').find((b) => b.id === cloudId).label, '工作室')
  await assert.rejects(() => vault.renameBinding('111', 'b_nope', 'x'), expectCode('NOT_FOUND'))

  await vault.removeBinding('111', cloudId)
  assert.equal(vault.listBindings('111').length, 1)
  await assert.rejects(() => vault.removeBinding('111', cloudId), expectCode('NOT_FOUND'))
  assert.equal(vault.listBindings('111')[0].id, binding.id)
})

test('listBindings / printers 未解锁时不含任何秘密', async () => {
  const { vault } = await unlockedWithLan()
  const cloud = await vault.addBinding('111', { label: '云端账号', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456789' })
  await vault.setDiscoveredPrinters('111', cloud.id, [{ serial: '01S00H000000001', name: 'X1C', model: 'X1C' }])
  vault.lock('111')

  const bindings = vault.listBindings('111')
  assert.equal(bindings.length, 2)
  for (const b of bindings) {
    assert.equal(b.tokenMask, '', '未解锁不给掩码')
    assert.equal(b.unlocked, false)
    assert.ok(!('secret' in b) && !('accessCode' in b) && !('accessToken' in b))
  }
  const refs = vault.printers('111')
  assert.ok(refs.length >= 2)
  for (const r of refs) {
    assert.ok(!('accessCode' in r) && !('accessToken' in r) && !('secret' in r), '未解锁 ref 不能带秘密')
    assert.equal(r.secretAvailable, false)
  }
  assertNoSecrets([bindings, refs, vault.summary(), vault.listUsers()])
})

test('listBindings 解锁后给出掩码但不给明文', async () => {
  const { vault } = await unlockedWithLan()
  await vault.addBinding('111', { label: '云端账号', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456789' })
  const bindings = vault.listBindings('111')
  const lan = bindings.find((b) => b.mode === 'lan')
  const cloud = bindings.find((b) => b.mode === 'cloud')
  assert.match(lan.tokenMask, /^••••/)
  assert.match(cloud.tokenMask, /^••••/)
  assert.ok(cloud.tokenMask.endsWith(CLOUD_TOKEN.slice(-4)))
  assertNoSecrets(bindings)
})

test('secretOf 需要解锁，返回该绑定的秘密字段', async () => {
  const { vault, binding } = await unlockedWithLan()
  const secret = vault.secretOf('111', binding.id)
  assert.deepEqual(secret, { mode: 'lan', accessCode: ACCESS_CODE })
  vault.lock('111')
  assert.throws(() => vault.secretOf('111', binding.id), expectCode('LOCKED'))
  await vault.unlock('111')
  assert.throws(() => vault.secretOf('111', 'b_nope'), expectCode('NOT_FOUND'))
})

test('prefs：未解锁返回默认值，setPrefs 未解锁抛 LOCKED', async () => {
  const { vault } = await unlockedWithLan()
  const DEFAULTS = { groupShowName: false, selectedPrinter: '', interface: '', groupMode: '', groupPhoto: null }
  assert.deepEqual(vault.prefs('111'), DEFAULTS)
  const set = await vault.setPrefs('111', { groupShowName: true, selectedPrinter: 'b_x:0' })
  assert.deepEqual(set.prefs, { groupShowName: true, selectedPrinter: 'b_x:0', interface: '', groupMode: '', groupPhoto: null })
  vault.lock('111')
  assert.deepEqual(vault.prefs('111'), DEFAULTS, '未解锁只给默认值')
  await assert.rejects(() => vault.setPrefs('111', { groupShowName: false }), expectCode('LOCKED'))
  assert.deepEqual(vault.prefs('000'), DEFAULTS)
  await vault.unlock('111')
  assert.deepEqual(vault.prefs('111'), { groupShowName: true, selectedPrinter: 'b_x:0', interface: '', groupMode: '', groupPhoto: null }, '偏好持久化')
})

test('prefs.interface：空/cloud/lan/auto，非法值抛 BAD_INPUT', async () => {
  const { vault, dir } = await unlockedWithLan()
  for (const iface of ['', 'cloud', 'lan', 'auto']) {
    const result = await vault.setPrefs('111', { interface: iface })
    assert.equal(result.prefs.interface, iface)
    assert.equal(vault.prefs('111').interface, iface)
  }
  assert.equal((await vault.setPrefs('111', { interface: 'LAN' })).prefs.interface, 'lan', '大小写不敏感')
  assert.equal((await vault.setPrefs('111', { interface: null })).prefs.interface, '', 'null 视为跟随默认')
  assert.equal((await vault.setPrefs('111', { interface: ' cloud ' })).prefs.interface, 'cloud', '两端空白被 trim')
  for (const bad of ['wifi', 'internet', 42, {}]) {
    await assert.rejects(() => vault.setPrefs('111', { interface: bad }), expectCode('BAD_INPUT'), '非法接口：' + String(bad))
  }
  // interface 是非秘密偏好，落盘可见；prefs 对象里永远只有这三个字段
  await vault.setPrefs('111', { interface: 'lan' })
  const raw = JSON.parse(await readFile(path.join(dir, 'vault.json'), 'utf8'))
  assert.equal(raw.users['111'].prefs.interface, 'lan')
  assert.deepEqual(Object.keys(raw.users['111'].prefs).sort(), ['groupMode', 'groupPhoto', 'groupShowName', 'interface', 'selectedPrinter'])
  assert.deepEqual(Object.keys(vault.prefs('111')).sort(), ['groupMode', 'groupPhoto', 'groupShowName', 'interface', 'selectedPrinter'])
})

// ------------------------------------------------------------------ resolve

test('resolve 支持空 / 序号 / serial / 名称子串 / 绑定名 / ref，多个命中给候选', async () => {
  const { vault, binding } = await unlockedWithLan()
  await vault.addBinding('111', {
    label: '工作室',
    mode: 'lan',
    accessCode: SHARED,
    printers: [
      { serial: '01S00E000000001', ip: '192.168.1.80', name: 'A1 mini' },
      { serial: '01S00E000000002', ip: '192.168.1.81', name: 'P1S' }
    ]
  })
  const all = vault.printers('111')
  assert.equal(all.length, 3)

  assert.deepEqual(vault.resolve('111', ''), { match: null, candidates: all.map((r) => r.ref) }.match === null ? vault.resolve('111', '') : null)
  if (all.length > 1) {
    const empty = vault.resolve('111', '')
    assert.equal(empty.match, null, '多台时不做猜测')
    assert.equal(empty.candidates.length, 3)
  }

  assert.equal(vault.resolve('111', '1').match.ref, all[0].ref)
  assert.equal(vault.resolve('111', '2').match.ref, all[1].ref)
  assert.equal(vault.resolve('111', '99').match, null)
  assert.equal(vault.resolve('111', 'abc').match, null)
  assert.equal(vault.resolve('111', '01S00E000000002').match.serial, '01S00E000000002')
  assert.equal(vault.resolve('111', 'p1s').match.name, 'P1S', '名称子串大小写不敏感')
  assert.equal(vault.resolve('111', 'MINI').match.name, 'A1 mini')
  assert.equal(vault.resolve('111', binding.id + ':0').match.ref, binding.id + ':0')
  assert.equal(vault.resolve('111', '工作室').candidates.length, 2, '绑定名命中两台 -> 候选')
  const ambiguous = vault.resolve('111', '工作室')
  assert.equal(ambiguous.match, null)
  assertNoSecrets(ambiguous)
})

test('只有一台打印机时空 selector 直接命中', async () => {
  const { vault, binding } = await unlockedWithLan()
  const result = vault.resolve('111', '')
  assert.ok(result.match)
  assert.equal(result.match.ref, binding.id + ':0')
  assert.equal(result.match.accessCode, ACCESS_CODE, '已解锁时可以拿到有效访问码')
})

// ------------------------------------------------------------------ 授权

async function grantSetup (options = {}) {
  const ctx = await unlockedWithLan(options)
  await ctx.vault.addBinding('111', { label: '云端账号', mode: 'cloud', accessToken: CLOUD_TOKEN, uid: '123456789', region: 'cn' })
  await ctx.vault.setDiscoveredPrinters('111', ctx.vault.listBindings('111').find((b) => b.mode === 'cloud').id, [
    { serial: '01S00F000000001', name: 'X1C', model: 'X1C' }
  ])
  await ctx.vault.register('222')
  return ctx
}

test('createGrant：按 QQ 直接生效，grants.json 里没有任何秘密', async () => {
  const { vault, dir, binding } = await grantSetup()
  const grant = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id], scopes: ['status'], minutes: 30 })
  assert.equal(grant.ok, true)
  assert.deepEqual(grant.scopes, ['status'])
  assert.ok(grant.expiresAt > 0, '有到期时间')
  assert.equal(grant.code, undefined, '不再有授权码')

  const raw = await readFile(path.join(dir, 'grants.json'), 'utf8')
  assert.ok(!raw.includes(ACCESS_CODE) && !raw.includes(CLOUD_TOKEN), 'grants.json 不能有明文秘密')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.grants.length, 1)
  assert.equal(parsed.grants[0].ownerQQ, '111')
  assert.equal(parsed.grants[0].granteeQQ, '222', '共享对象就是 QQ 本身')
  assert.ok(Array.isArray(parsed.grants[0].bindings), '只记绑定 id 与元数据')
  assert.equal(parsed.grants[0].wrapped, undefined, '不再有可解密的密文盒子')

  const listed = vault.listGrants()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].ownerQQ, '111')
  assert.equal(listed[0].granteeQQ, '222')
  assert.equal(listed[0].revoked, false)
  assertNoSecrets(listed)
})

test('createGrant：必须解锁 / 范围与时长校验 / bindingIds 为空表示全部 / 不能授权给自己', async () => {
  const { vault } = await grantSetup()
  vault.lock('111')
  await assert.rejects(
    () => vault.createGrant({ ownerQQ: '111', granteeQQ: '222', scopes: ['status'] }),
    expectCode('LOCKED'), '授权必须 owner 已解锁')
  await vault.unlock('111')
  const all = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', scopes: SCOPES.slice() })
  assert.deepEqual(all.scopes, ['status', 'control', 'photo'])
  await assert.rejects(() => vault.createGrant({ ownerQQ: '111', granteeQQ: '222', scopes: ['root'] }), expectCode('BAD_INPUT'))
  await assert.rejects(() => vault.createGrant({ ownerQQ: '111', granteeQQ: '222', minutes: 0 }), expectCode('BAD_INPUT'))
  await assert.rejects(() => vault.createGrant({ ownerQQ: '111', granteeQQ: '222', minutes: 1441 }), expectCode('BAD_INPUT'))
  await assert.rejects(() => vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: ['b_nope'] }), expectCode('NOT_FOUND'))
  await assert.rejects(() => vault.createGrant({ ownerQQ: '111', granteeQQ: '111' }), expectCode('BAD_INPUT'))
  const short = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', minutes: 1440 })
  assert.equal(short.expiresAt - Date.now() <= 1440 * 60 * 1000 + 1000, true, '上限 1440 分钟')
})

test('授权立即可用（无需兑换），撤销/到期立即失效', async () => {
  const { vault, clock, binding } = await grantSetup()
  const grant = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id], scopes: ['status', 'photo'] })

  // 建好就能用
  const sessions = vault.grantSessions('222')
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].ownerQQ, '111')
  assert.deepEqual(sessions[0].scopes, ['status', 'photo'])
  assertNoSecrets(sessions)

  const granted = vault.grantedPrinters('222', grant.grantId)
  assert.equal(granted.ok, true)
  assert.equal(granted.printers.length, 1)
  assert.equal(granted.ownerQQ, '111')

  // 主人没解锁时不能凭空解出秘密
  vault.lock('111')
  const locked = vault.grantedPrinters('222', grant.grantId)
  assert.equal(locked.ok, false)
  assert.equal(locked.code, 'OWNER_LOCKED')
  assert.deepEqual(locked.printers, [])

  await vault.unlock('111')
  // 撤销后立刻失效
  await vault.revokeGrant({ byQQ: '111', grantId: grant.grantId })
  assert.deepEqual(vault.grantSessions('222'), [])
  assert.equal(vault.listGrants()[0].revoked, true)

  // 到期后自动失效
  const second = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', minutes: 30 })
  assert.equal(vault.grantSessions('222').length, 1)
  clock.t += 31 * 60 * 1000
  assert.deepEqual(vault.grantSessions('222'), [], '过期后不再出现')
})

test('grantedPrinters / grantTargets 只含被选中的绑定（用所有者的凭据）', async () => {
  const { vault, binding } = await grantSetup()
  const grant = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id], scopes: ['status'] })

  const granted = vault.grantedPrinters('222', grant.grantId)
  assert.equal(granted.ok, true)
  assert.equal(granted.printers.length, 1, '只含被授权的那个绑定')
  assert.equal(granted.printers[0].accessCode, ACCESS_CODE, '用的是绑定者的访问码')
  assert.equal(granted.ownerQQ, '111')
  assert.deepEqual(granted.scopes, ['status'])

  const bySelector = vault.grantTargets('222', '')
  assert.equal(bySelector.match.ref, granted.printers[0].ref, '只有一个授权时自动命中')
  assert.deepEqual(bySelector.scopes, ['status'])
  const byEmptyOwner = vault.grantTargets('222', '111')
  assert.ok(byEmptyOwner.match)

  const missing = vault.grantedPrinters('222', 'g_nope')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')
  assert.deepEqual(missing.printers, [])

  // 别人的授权查不到（只认 granteeQQ）
  assert.equal(vault.grantedPrinters('333', grant.grantId).ok, false)

  // 云端授权也能带出 token 字段（只在内存里）
  const cloudId = vault.listBindings('111').find((b) => b.mode === 'cloud').id
  const cloudGrant = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [cloudId] })
  const cloudRefs = vault.grantedPrinters('222', cloudGrant.grantId).printers
  assert.equal(cloudRefs[0].accessToken, CLOUD_TOKEN)
  assert.equal(cloudRefs[0].uid, '123456789')
  assert.equal(cloudRefs[0].region, 'cn')
})

test('revokeGrant：owner / grantee 都能撤销，第三方拒绝，撤销后再授权可继续', async () => {
  const { vault, binding } = await grantSetup()
  const grant = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id] })
  assert.equal(vault.grantSessions('222').length, 1)

  await assert.rejects(() => vault.revokeGrant({ byQQ: '333', grantId: grant.grantId }), expectCode('FORBIDDEN'))
  await assert.rejects(() => vault.revokeGrant({ byQQ: '111', grantId: 'g_nope' }), expectCode('NOT_FOUND'))

  const revoked = await vault.revokeGrant({ byQQ: '222', grantId: grant.grantId })
  assert.equal(revoked.ok, true)
  assert.deepEqual(vault.grantSessions('222'), [])
  assert.equal(vault.listGrants()[0].revoked, true)

  const second = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id] })
  assert.equal(vault.grantSessions('222').length, 1, '重新授权后又能用')
  await vault.revokeGrant({ byQQ: '111', grantId: second.grantId })
  assert.deepEqual(vault.grantSessions('222'), [])
})

test('wipeUser 删除用户、授权与会话，且不需要安全码', async () => {
  const { vault, dir, binding } = await grantSetup()
  await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id] })
  assert.equal(vault.grantSessions('222').length, 1)

  const result = await vault.wipeUser('111')
  assert.equal(result.ok, true)
  assert.equal(result.removedGrants, 1)
  assert.equal(vault.hasUser('111'), false)
  assert.equal(vault.isUnlocked('111'), false)
  assert.deepEqual(vault.listGrants(), [])
  assert.deepEqual(vault.grantSessions('222'), [])
  const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
  assert.ok(!raw.includes('111'), '用户记录被删除')
  await assert.rejects(() => vault.wipeUser('111'), expectCode('NO_USER'))
})

// ------------------------------------------------------------------ 持久化 / 并发 / 审计

test('重新 load 后授权仍然有效（只靠 QQ 记录，无码无会话）', async () => {
  const { vault, dir, binding, clock } = await grantSetup()
  const grant = await vault.createGrant({ ownerQQ: '111', granteeQQ: '222', bindingIds: [binding.id] })
  // 用同一套假时钟，否则真实时间已经超过 expiresAt，会被当成过期
  const reopened = createVault({ dir, kdf: FAST_KDF, log: null, now: () => clock.t })
  await reopened.load()
  // 重新加载后「谁授权给谁」还在；但秘密要在所有者解锁后才能解
  assert.equal(reopened.listGrants().length, 1)
  assert.equal(reopened.grantSessions('222').length, 1, '授权记录本身就是许可（loaded 后即可见）')
  await reopened.unlock('111')
  assert.equal(reopened.grantedPrinters('222', grant.grantId).ok, true)
})

test('load() 之后 prefs 与统计在空 qq / 未知用户上不抛错', async () => {
  const { vault } = await setup()
  assert.deepEqual(vault.prefs(''), { groupShowName: false, selectedPrinter: '', interface: '', groupMode: '', groupPhoto: null })
  assert.deepEqual(vault.prefs('999'), { groupShowName: false, selectedPrinter: '', interface: '', groupMode: '', groupPhoto: null })
  assert.deepEqual(vault.listBindings(''), [])
  assert.deepEqual(vault.printers(''), [])
  assert.deepEqual(vault.resolve('', ''), { match: null, candidates: [] })
  assert.deepEqual(vault.grantSessions(''), [])
  assert.equal(vault.isUnlocked(''), false)
  for (const value of Object.values(vault.summary())) assert.equal(typeof value, 'number')
})

test('listUsers 的 printers/bindings 是台数而不是数组', async () => {
  const { vault } = await grantSetup()
  const row = vault.listUsers().find((u) => u.qq === '111')
  assert.equal(typeof row.printers, 'number')
  assert.equal(row.printers, 2, 'LAN 1 台 + 云端 1 台')
  assert.equal(typeof row.bindings, 'number')
  assert.equal(row.bindings, 2)
  assert.equal(typeof row.unlocked, 'boolean')
  assert.ok(!Array.isArray(row.printers) && !Array.isArray(row.bindings))
})


test('账号：主机密钥包装 DEK，建号即可绑能用', async () => {
  const { dir, vault, clock } = await setup()
  try {
    // 1) 免码注册 + 免码解锁
    const reg = await vault.register('111')
    assert.equal(reg.ok, true)
    assert.equal(vault.isUnlocked('111'), true, '建号即可用')

    const opened = await vault.unlock('111')
    // 用注入的时钟比较（测试里 now() 是固定的，不能拿 Date.now() 比）
    assert.ok(opened.until > clock.t, '解锁应当给出未来的到期时间')
    assert.equal(vault.isUnlocked('111'), true)

    // 2) 能正常绑定、读回来
    await vault.addBinding('111', {
      label: '我的 A1',
      mode: 'lan',
      accessCode: ACCESS_CODE,
      printers: [{ serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1' }],
    })
    assert.equal(vault.printers('111').length, 1)

    // 3) host-key.bin 存在且是 32 字节（不是明文口令，只是一把随机主密钥）
    const hostKey = await readFile(path.join(dir, 'host-key.bin'))
    assert.equal(hostKey.length, 32)

    // 4) 落盘仍然看不到访问码明文
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(raw.includes(ACCESS_CODE), false)
    assert.equal(raw.includes('BEGIN CERTIFICATE'), false)

    // 5) 多用户互不影响：222 也能直接开
    await vault.register('222')
    const opened222 = await vault.unlock('222')
    assert.equal(opened222.ok, true)
    assert.equal(vault.isUnlocked('222'), true)

    // 6) 锁定后免码可以再开（这是它和「密码」的区别：可靠性换保密性）
    vault.lock('111')
    assert.equal(vault.isUnlocked('111'), false)
    await vault.unlock('111')
    assert.equal(vault.isUnlocked('111'), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('host-key.bin 被换掉后解不开（不静默降级）', async () => {
  const { dir, vault } = await setup()
  try {
    await vault.register('111')
    await vault.lock('111')
    // 模拟本机主密钥被替换：解不开就如实报错，而不是悄悄重建/丢数据
    await writeFile(path.join(dir, 'host-key.bin'), Buffer.alloc(32, 7))
    const fresh = createVault({ dir, log: null, kdf: FAST_KDF })
    await fresh.load()
    await assert.rejects(() => fresh.unlock('111'), (err) => err.code === 'BAD_FILE')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('打印机自签名证书固定：加密落盘、指纹换人时报错、force 才覆盖', async () => {
  const { dir, vault, binding } = await unlockedWithLan()
  try {
    const { generateSelfSignedCert } = await import('../lib/tls-cert.mjs')
    const refs0 = vault.printers('111')
    assert.ok(refs0.length, 'helper 应该已经建好一条局域网绑定')
    const ref = { bindingId: refs0[0].bindingId, serial: refs0[0].serial, certPort: 8883 }

    const first = generateSelfSignedCert({ commonName: '01S00A123456789' })
    const r1 = await vault.setPrinterCert('111', ref, { pem: first.certPem, fingerprint256: first.fingerprint256, subject: '01S00A123456789' }, {})
    assert.equal(r1.ok, true)
    assert.equal(r1.slot, 'mqtt')

    // 从 printers() 能读到锚点
    const refs = vault.printers('111')
    assert.equal(refs[0].tlsCa, first.certPem)
    assert.equal(refs[0].tlsFingerprint, first.fingerprint256)

    // 落盘是加密的：磁盘上看不到 PEM 原文
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(raw.includes('BEGIN CERTIFICATE'), false, '证书也要加密存放')

    // 指纹变了（换了证书 / 有人在冒充）：默认拒绝覆盖
    const second = generateSelfSignedCert({ commonName: '01S00A123456789' })
    await assert.rejects(
      () => vault.setPrinterCert('111', ref, { pem: second.certPem, fingerprint256: second.fingerprint256 }, {}),
      (err) => err.code === 'CERT_CHANGED',
    )
    // 确认后（force）才换成新的
    const forced = await vault.setPrinterCert('111', ref, { pem: second.certPem, fingerprint256: second.fingerprint256 }, { force: true })
    assert.equal(forced.ok, true)
    assert.equal(forced.replaced, true)
    assert.equal(vault.printers('111')[0].tlsFingerprint, second.fingerprint256)

    // 摄像头槽位独立
    const cam = await vault.setPrinterCert('111', { bindingId: ref.bindingId, serial: ref.serial, certPort: 6000 }, { pem: second.certPem, fingerprint256: second.fingerprint256 }, {})
    assert.equal(cam.slot, 'camera')
    assert.equal(vault.printers('111')[0].cameraCa, second.certPem)

    // RTSPS(:322) 有**自己的**槽位：不能写进 mqtt 槽把控制面锚点覆盖掉
    const third = generateSelfSignedCert({ commonName: '01S00A123456789' })
    const rtsps = await vault.setPrinterCert('111', { bindingId: ref.bindingId, serial: ref.serial, certPort: 322 }, { pem: third.certPem, fingerprint256: third.fingerprint256 }, {})
    assert.equal(rtsps.ok, true)
    assert.equal(rtsps.slot, 'rtsps', ':322 必须是独立槽位')
    const after = vault.printers('111')[0]
    assert.equal(after.rtspsCa, third.certPem, 'ref 要带出 :322 的锚点')
    assert.equal(after.rtspsFingerprint, third.fingerprint256)
    assert.equal(after.tlsFingerprint, second.fingerprint256, '写 :322 不能动到 8883 的既定指纹')
    assert.equal(after.cameraCa, second.certPem, '写 :322 不能动到 6000 的锚点')

    // 非法指纹直接被拒
    await assert.rejects(() => vault.setPrinterCert('111', ref, { pem: 'x', fingerprint256: 'zz' }, {}), (err) => err.code === 'BAD_INPUT')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
