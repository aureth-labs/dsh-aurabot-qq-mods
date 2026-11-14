// test/policy.test.mjs — 权限 / 脱敏 / 限流 / 解析的纯函数测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canBind, canControl, canGrant, canPhoto, checkGroup, checkPrivate,
  createRateLimiter, groupMode, maskIp, maskQQ, parseIdList, parseMinutes,
  redaction, roleOf
} from '../lib/policy.mjs'

const OWNER = '10001'
const ADMIN = '20002'
const USER = '30003'
const STRANGER = '40004'
const GROUP = '900001'
const OTHER_GROUP = '900002'

const settings = {
  users: USER + ',30004',
  groups: GROUP + '，900003',
  // 注意：旧配置里的 admins 已废弃，这里留着验证它不再提权
  admins: ADMIN,
  groupMode: 'status',
  groupPhoto: true,
  allowGroupName: false,
  unlockDays: 7
}

// ------------------------------------------------------------------ parseIdList

test('parseIdList 支持逗号/中文逗号/顿号/空白/换行，只留 4~15 位数字', () => {
  assert.deepEqual(parseIdList('123456,234567'), ['123456', '234567'])
  assert.deepEqual(parseIdList('123456，234567'), ['123456', '234567'])
  assert.deepEqual(parseIdList('123456 234567\n345678\t456789'), ['123456', '234567', '345678', '456789'])
  assert.deepEqual(parseIdList('123456、234567;345678'), ['123456', '234567', '345678'])
  assert.deepEqual(parseIdList('123,ab,1234567890123456,123456'), ['123456'], '太短/太长/非数字都丢掉')
  assert.deepEqual(parseIdList('123456,123456,123456'), ['123456'], '去重')
  assert.deepEqual(parseIdList(''), [])
  assert.deepEqual(parseIdList(null), [])
  assert.deepEqual(parseIdList(undefined), [])
  assert.deepEqual(parseIdList([123456, '234567', 'bad']), ['123456', '234567'])
  assert.deepEqual(parseIdList('1234'), ['1234'], '4 位也算合法')
})

// ------------------------------------------------------------------ roleOf

test('roleOf：只有 config 里的主人是 owner，白名单是 user，其余 guest（没有管理员这一级）', () => {
  assert.equal(roleOf({ userId: OWNER, isOwner: true, settings }), 'owner')
  assert.equal(roleOf({ userId: ADMIN, settings }), 'guest', 'settings.admins 已废弃：不在白名单就是 guest')
  assert.equal(roleOf({ userId: ADMIN, isOwner: false, settings }), 'guest')
  assert.equal(roleOf({ userId: USER, settings }), 'user')
  assert.equal(roleOf({ userId: STRANGER, settings }), 'guest')
  assert.equal(roleOf({ userId: '', settings }), 'guest')
  assert.equal(roleOf({}), 'guest')
  assert.equal(roleOf({ userId: USER }), 'guest', '没有设置时一律 guest')
  // 即使旧配置里残留 admins，也不再生效
  const legacy = { ...settings, admins: ADMIN }
  assert.equal(roleOf({ userId: ADMIN, settings: legacy }), 'guest', '旧 admins 配置不再提升权限')
  const roles = [[OWNER, true], [ADMIN, false], [USER, false], [STRANGER, false]].map(([id, isOwner]) => roleOf({ userId: id, isOwner, settings }))
  assert.deepEqual([...new Set(roles)].sort(), ['guest', 'owner', 'user'])
})

// ------------------------------------------------------------------ 私聊

test('checkPrivate：主人/白名单通过，陌生人（含旧 admins）拒绝', () => {
  assert.equal(checkPrivate({ userId: OWNER, isOwner: true, settings }).ok, true)
  assert.equal(checkPrivate({ userId: ADMIN, settings }).ok, false, '不再有管理员白名单捷径')
  assert.equal(checkPrivate({ userId: ADMIN, settings: { ...settings, admins: ADMIN } }).ok, false)
  assert.equal(checkPrivate({ userId: USER, settings }).ok, true)
  const stranger = checkPrivate({ userId: STRANGER, settings })
  assert.equal(stranger.ok, false)
  assert.match(stranger.reason, /白名单/)
  assert.equal(checkPrivate({}).ok, false)
  const fresh = checkPrivate({ userId: USER, settings, hasBinding: false })
  assert.equal(fresh.ok, true)
  assert.ok(fresh.hint, '没有绑定时给提示但不拒绝')
})

// ------------------------------------------------------------------ groupMode / 群

test('groupMode：off / status / control，未知值一律 off', () => {
  assert.equal(groupMode({ groupMode: 'status' }), 'status')
  assert.equal(groupMode({ groupMode: 'control' }), 'control')
  assert.equal(groupMode({ groupMode: 'off' }), 'off')
  assert.equal(groupMode({ groupMode: 'CONTROL' }), 'control')
  assert.equal(groupMode({ groupMode: 'weird' }), 'off')
  assert.equal(groupMode({}), 'off')
  assert.equal(groupMode(null), 'off')
  assert.equal(groupMode({ groupMode: true }), 'control')
  assert.equal(groupMode({ groupMode: false }), 'off')
})

test('checkGroup：群白名单 + 群模式 + 本人绑定', () => {
  assert.equal(checkGroup({ groupId: GROUP, userId: USER, settings, hasBinding: true }).ok, true)
  assert.equal(checkGroup({ groupId: OTHER_GROUP, userId: USER, settings, hasBinding: true }).ok, false, '不在群白名单')
  // 绑定用户对自己的打印机有最高权限：全局 off 不再一刀切，模式选中打印机后按所有者偏好判定
  assert.equal(checkGroup({ groupId: GROUP, userId: USER, settings: { ...settings, groupMode: 'off' }, hasBinding: true }).ok, true)
  assert.equal(checkGroup({ groupId: GROUP, userId: STRANGER, settings, hasBinding: false }).ok, false)
  const noBinding = checkGroup({ groupId: GROUP, userId: USER, settings, hasBinding: false })
  assert.equal(noBinding.ok, false)
  assert.match(noBinding.reason, /私聊/)
  assert.equal(checkGroup({ groupId: GROUP, userId: USER, settings: { groups: '' }, hasBinding: true }).ok, false, '空群白名单 = 不响应')
  assert.equal(checkGroup({ groupId: '', userId: USER, settings, hasBinding: true }).ok, false)
})

// ------------------------------------------------------------------ 控制 / 拍照

test('canControl：群 status 只读，control 才放行，私聊看角色', () => {
  const status = { ...settings, groupMode: 'status' }
  const control = { ...settings, groupMode: 'control' }
  const denied = canControl({ chat: 'group', role: 'owner', settings: status })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /只允许查看状态/)
  assert.equal(canControl({ chat: 'group', role: 'user', settings: control }).ok, true)
  assert.equal(canControl({ chat: 'group', role: 'owner', settings: { ...settings, groupMode: 'off' } }).ok, false)
  assert.equal(canControl({ chat: 'private', role: 'user', settings }).ok, true)
  assert.equal(canControl({ chat: 'private', role: 'guest', settings }).ok, false)
  assert.equal(canControl({ chat: 'private', role: 'owner', settings }).ok, true)
  assert.equal(canControl({ chat: '', role: 'owner', settings }).ok, false, '未知会话类型拒绝')
})

test('canPhoto：群需要群模式开 + groupPhoto 未关，私聊看角色', () => {
  assert.equal(canPhoto({ chat: 'group', role: 'user', settings: { ...settings, groupMode: 'control' } }).ok, true)
  assert.equal(canPhoto({ chat: 'group', role: 'user', settings: { ...settings, groupMode: 'status' } }).ok, true, 'status 模式也能拍照')
  assert.equal(canPhoto({ chat: 'group', role: 'user', settings: { ...settings, groupPhoto: false } }).ok, false)
  assert.equal(canPhoto({ chat: 'group', role: 'user', settings: { ...settings, groupMode: 'off' } }).ok, false)
  assert.equal(canPhoto({ chat: 'private', role: 'guest', settings }).ok, false)
  assert.equal(canPhoto({ chat: 'private', role: 'user', settings }).ok, true)
})

// ------------------------------------------------------------------ 绑定 / 授权

test('canBind：只私聊', () => {
  assert.equal(canBind({ chat: 'private', role: 'owner' }).ok, true)
  assert.equal(canBind({ chat: 'private', role: 'user' }).ok, true)
  assert.equal(canBind({ chat: 'private', role: 'guest' }).ok, true, '私聊里 guest 也能自己绑定')
  const group = canBind({ chat: 'group', role: 'owner' })
  assert.equal(group.ok, false)
  assert.match(group.reason, /私聊/)
  assert.equal(canBind({ chat: '', role: 'owner' }).ok, false)
  assert.equal(canBind({ chat: 'private' }).ok, false, '没有角色信息时不放行')
})

test('canGrant：只私聊，绑定者本人（owner/user）可以，陌生人不行', () => {
  assert.equal(canGrant({ chat: 'private', role: 'owner', settings }).ok, true)
  assert.equal(canGrant({ chat: 'private', role: 'user', settings }).ok, true, '白名单用户也能给自己绑定的打印机授权')
  assert.equal(canGrant({ chat: 'private', role: 'guest', settings }).ok, false)
  const group = canGrant({ chat: 'group', role: 'owner', settings })
  assert.equal(group.ok, false)
  assert.match(group.reason, /私聊/)
  assert.equal(canGrant({ chat: 'private' }).ok, false)
})

// ------------------------------------------------------------------ 脱敏

test('redaction：私聊不脱敏，群默认全隐藏', () => {
  assert.deepEqual(redaction({ chat: 'private', requesterQQ: USER, ownerQQ: ADMIN, prefs: {}, settings }),
    { hideName: false, hideProject: false })
  assert.deepEqual(redaction({ chat: 'group', requesterQQ: USER, ownerQQ: USER, prefs: {}, settings }),
    { hideName: true, hideProject: true })
  assert.deepEqual(redaction({ chat: 'group', requesterQQ: STRANGER, ownerQQ: USER, prefs: { groupShowName: true }, settings }),
    { hideName: true, hideProject: true }, '不是绑定所有者')
  assert.deepEqual(redaction({ chat: 'group', requesterQQ: USER, ownerQQ: USER, prefs: { groupShowName: false }, settings: { ...settings, allowGroupName: true } }),
    { hideName: true, hideProject: true }, '用户没开')
  assert.deepEqual(redaction({ chat: 'group', requesterQQ: USER, ownerQQ: USER, prefs: { groupShowName: true }, settings: { ...settings, allowGroupName: false } }),
    { hideName: true, hideProject: true }, '主人没开')
  assert.deepEqual(redaction({ chat: 'group', requesterQQ: USER, ownerQQ: USER, prefs: { groupShowName: true }, settings: { ...settings, allowGroupName: true } }),
    { hideName: false, hideProject: true }, '三个条件都满足：只放开名字')
  assert.deepEqual(redaction({ chat: 'group', requesterQQ: OWNER, ownerQQ: OWNER, prefs: { groupShowName: true }, settings: { ...settings, allowGroupName: true } }),
    { hideName: false, hideProject: true }, '主人自己的绑定也一样')
  assert.equal(redaction({ chat: 'group', requesterQQ: USER, ownerQQ: USER, prefs: { groupShowName: true }, settings: { ...settings, allowGroupName: true } }).hideProject, true, 'hideProject 恒 true')
  assert.equal(redaction({}).hideName, true)
  assert.equal(redaction({}).hideProject, true)
})

test('maskQQ / maskIp', () => {
  assert.equal(maskQQ('123456789'), '123****789')
  assert.equal(maskQQ(123456789), '123****789')
  assert.equal(maskQQ('12345'), '1***5')
  assert.equal(maskQQ('123'), '****')
  assert.equal(maskQQ(''), '****')
  assert.equal(maskQQ(null), '****')
  assert.ok(!maskQQ('123456789').includes('4567'), '中间位不能露出')

  assert.equal(maskIp('192.168.1.50'), '192.168.*.*')
  assert.equal(maskIp('10.0.0.1'), '10.0.*.*')
  assert.equal(maskIp('192.168.1'), '***')
  assert.equal(maskIp('not-an-ip'), '***')
  assert.equal(maskIp(''), '')
  assert.equal(maskIp(null), '')
  assert.equal(maskIp('fe80::1'), 'fe80:1::*', 'IPv6 只留前两组')
  assert.equal(maskIp('999.1.1.1'), '***', '非法 IPv4')
})

// ------------------------------------------------------------------ 限流

test('createRateLimiter：窗口内计数、超限给 retryMs、窗口后恢复', () => {
  const clock = { t: 1000 }
  const limiter = createRateLimiter({ now: () => clock.t })
  assert.deepEqual(limiter.hit('a', 2, 1000), { ok: true, retryMs: 0, remaining: 1 })
  assert.deepEqual(limiter.hit('a', 2, 1000), { ok: true, retryMs: 0, remaining: 0 })
  const blocked = limiter.hit('a', 2, 1000)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.retryMs > 0 && blocked.retryMs <= 1000)
  assert.equal(limiter.hit('b', 2, 1000).ok, true, '不同 key 互不影响')
  clock.t += 1001
  assert.equal(limiter.hit('a', 2, 1000).ok, true, '窗口过期后恢复')
  assert.equal(limiter.reset('a'), true)
  assert.equal(limiter.reset('missing'), false)
  assert.equal(limiter.reset(), true)
  assert.equal(limiter.hit('a', 1, 1000).ok, true)
})

test('createRateLimiter 对异常参数安全降级', () => {
  const limiter = createRateLimiter()
  assert.equal(limiter.hit('x', 0, 0).ok, true, 'limit 至少 1')
  assert.equal(limiter.hit('', NaN, NaN).ok, true, '空 key / NaN 也能用')
  assert.equal(limiter.hit(null, -5, -1).ok, true)
})

// ------------------------------------------------------------------ parseMinutes

test('parseMinutes 支持分钟/小时/天与中文', () => {
  assert.equal(parseMinutes('30', 15, 1440), 30)
  assert.equal(parseMinutes('30分钟', 15, 1440), 30)
  assert.equal(parseMinutes('1小时', 15, 1440), 60)
  assert.equal(parseMinutes('1.5小时', 15, 1440), 90)
  assert.equal(parseMinutes('2h', 15, 1440), 120)
  assert.equal(parseMinutes('1天', 15, 1440), 1440)
  assert.equal(parseMinutes('半小时', 15, 1440), 30)
  assert.equal(parseMinutes('', 15, 1440), 15)
  assert.equal(parseMinutes(null, 15, 1440), 15)
  assert.equal(parseMinutes('abc', 15, 1440), 15)
  assert.equal(parseMinutes('0', 15, 1440), 15, '0 视为无效')
  assert.equal(parseMinutes('-5', 15, 1440), 15)
  assert.equal(parseMinutes('99999', 15, 1440), 1440, '夹到上限')
  assert.equal(parseMinutes('99999', 15, 60), 60, '自定义上限')
  assert.equal(parseMinutes('1', 15, 1440), 1)
  assert.equal(parseMinutes('30', 99999, 1440), 30)
  assert.equal(parseMinutes('x', 99999, 1440), 1440, 'fallback 也会被夹住')
  assert.equal(parseMinutes('x', 0, 1440), 1, 'fallback 小于下限夹到 1')
})

// ------------------------------------------------------------------ 回归：无秘密泄漏

test('policy 返回值只含布尔/字符串，不出现秘密形状的字段', () => {
  const results = [
    checkPrivate({ userId: USER, settings }),
    checkGroup({ groupId: GROUP, userId: USER, settings, hasBinding: true }),
    canControl({ chat: 'group', role: 'user', settings: { ...settings, groupMode: 'control' } }),
    canPhoto({ chat: 'private', role: 'user', settings }),
    canBind({ chat: 'private', role: 'user' }),
    canGrant({ chat: 'private', role: 'owner', settings }),
    redaction({ chat: 'group', requesterQQ: USER, ownerQQ: USER, prefs: {}, settings })
  ]
  const text = JSON.stringify(results).toLowerCase()
  for (const forbidden of ['token', 'accesscode', 'password', '••••']) {
    assert.ok(!text.includes(forbidden), '不应出现字段：' + forbidden)
  }
  for (const result of results) {
    for (const value of Object.values(result)) {
      assert.ok(['boolean', 'string', 'undefined'].includes(typeof value))
    }
  }
})
