// test/settings.test.mjs —— 设置规则表 / 归一化 / 总开关判定的单元测试。
// 这些函数是「面板看到的」和「模块真按的」共用的唯一真相，所以边界要逐条钉死。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SETTING_RULES, normalizeSettings, describeRules, describeRule, effectiveEnabled,
} from '../lib/settings.mjs'

const RULE_KEYS = Object.keys(SETTING_RULES)

test('规则表：键和 kind 与约定完全一致，且没有 enabled 键（防止宿主再画一个总开关）', () => {
  const expected = {
    active: 'bool',
    multiUser: 'bool',
    groupMode: 'enum',
    groupPhoto: 'bool',
    allowGroupName: 'bool',
    defaultInterface: 'enum',
    ownerInterface: 'enumAllowEmpty',
    ownerLocalAllowed: 'bool',
    ownerNoCode: 'bool',
    unlockDays: 'int',
    maxBindings: 'int',
    requestTimeoutMs: 'int',
    selectedTtlMinutes: 'int',
    tutkBridgePath: 'text',
    tutkLibPath: 'text',
    tutkTimeoutMs: 'int',
    enrollBaseUrl: 'text',
    enrollTtlMinutes: 'int',
    enrollMaxTtlMinutes: 'int',
  }
  assert.deepEqual(RULE_KEYS, Object.keys(expected))
  for (const [key, kind] of Object.entries(expected)) assert.equal(SETTING_RULES[key].kind, kind, key + ' 的 kind 不对')
  // 宿主对 flag === 'enabled' 或规则里出现 enabled 的模块会再画一个总开关，这里必须彻底没有它
  assert.equal(Object.hasOwn(SETTING_RULES, 'enabled'), false, '规则表里不能有 enabled')
  for (const rule of Object.values(SETTING_RULES)) {
    assert.equal(typeof rule.label, 'string')
    assert.ok(rule.label.length > 0, '每条规则都要有 label')
    assert.equal(typeof rule.hint, 'string')
    assert.ok(rule.hint.length > 0, '每条规则都要有 hint')
  }
  assert.equal(SETTING_RULES.active.label, '总开关')
  assert.equal(SETTING_RULES.unlockDays.label, '解锁有效期（天）')
  assert.equal(SETTING_RULES.active.hint, '关掉后不再响应任何打印机命令，也不会去连打印机')
  assert.equal(SETTING_RULES.active.def, false)
})

test('int：越界值夹到边界，按 round 取整', () => {
  assert.equal(normalizeSettings({ unlockDays: 0 }).unlockDays, 1)
  assert.equal(normalizeSettings({ unlockDays: 999 }).unlockDays, 30)
  assert.equal(normalizeSettings({ maxBindings: 0 }).maxBindings, 1)
  assert.equal(normalizeSettings({ maxBindings: 99 }).maxBindings, 20)
  assert.equal(normalizeSettings({ requestTimeoutMs: 100 }).requestTimeoutMs, 2000)
  assert.equal(normalizeSettings({ requestTimeoutMs: 999999 }).requestTimeoutMs, 20000)
  assert.equal(normalizeSettings({ tutkTimeoutMs: 1 }).tutkTimeoutMs, 3000)
  assert.equal(normalizeSettings({ tutkTimeoutMs: 999999 }).tutkTimeoutMs, 60000)
  assert.equal(normalizeSettings({ selectedTtlMinutes: 0 }).selectedTtlMinutes, 1)
  assert.equal(normalizeSettings({ selectedTtlMinutes: 999 }).selectedTtlMinutes, 60)
  // 取整：字符串数字也认，小数四舍五入
  assert.equal(normalizeSettings({ unlockDays: '12' }).unlockDays, 12)
  assert.equal(normalizeSettings({ unlockDays: 7.6 }).unlockDays, 8)
  assert.equal(normalizeSettings({ unlockDays: 7.4 }).unlockDays, 7)
})

test('空串 / undefined / null / NaN 一律回落默认值', () => {
  const empty = normalizeSettings({})
  assert.equal(empty.unlockDays, 7)
  assert.equal(empty.maxBindings, 5)
  assert.equal(empty.requestTimeoutMs, 6000)
  assert.equal(empty.selectedTtlMinutes, 10)
  assert.equal(empty.tutkTimeoutMs, 20000)
  for (const bad of ['', null, undefined, NaN, 'abc', {}]) {
    const n = normalizeSettings({ unlockDays: bad, maxBindings: bad, requestTimeoutMs: bad, tutkTimeoutMs: bad, selectedTtlMinutes: bad })
    assert.equal(n.unlockDays, 7, 'unlockDays 遇到 ' + String(bad) + ' 应回落默认')
    assert.equal(n.maxBindings, 5, 'maxBindings 遇到 ' + String(bad) + ' 应回落默认')
    assert.equal(n.requestTimeoutMs, 6000)
    assert.equal(n.tutkTimeoutMs, 20000)
    assert.equal(n.selectedTtlMinutes, 10)
  }
  assert.equal(normalizeSettings({ unlockDays: Infinity }).unlockDays, 7, 'Infinity 不是有限值，回落默认')
  assert.equal(normalizeSettings({ unlockDays: 0.5 }).unlockDays, 1, '0.5 取整后落到下界 1')
})

test('enum：非法值回落默认，合法值原样保留', () => {
  assert.equal(normalizeSettings({ groupMode: 'hack' }).groupMode, 'status')
  assert.equal(normalizeSettings({ groupMode: 'control' }).groupMode, 'control')
  assert.equal(normalizeSettings({ groupMode: 'off' }).groupMode, 'off')
  assert.equal(normalizeSettings({ defaultInterface: 'auto' }).defaultInterface, 'cloud')
  assert.equal(normalizeSettings({ defaultInterface: 'lan' }).defaultInterface, 'lan')
  assert.equal(normalizeSettings({ ownerInterface: 'x' }).ownerInterface, '')
  assert.equal(normalizeSettings({ ownerInterface: '' }).ownerInterface, '')
  assert.equal(normalizeSettings({ ownerInterface: 'lan' }).ownerInterface, 'lan')
  assert.equal(normalizeSettings({ ownerInterface: null }).ownerInterface, '')
})

test('bool：def=true 的键只有明确 false 才关；def=false 的键只有明确 true 才开', () => {
  // def true：groupPhoto / ownerLocalAllowed
  for (const key of ['groupPhoto', 'ownerLocalAllowed']) {
    assert.equal(normalizeSettings({})[key], true, key + ' 未配置时应为 true')
    assert.equal(normalizeSettings({ [key]: undefined })[key], true)
    assert.equal(normalizeSettings({ [key]: null })[key], true)
    assert.equal(normalizeSettings({ [key]: false })[key], false)
    assert.equal(normalizeSettings({ [key]: true })[key], true)
    assert.equal(normalizeSettings({ [key]: 0 })[key], true, '不是 false 就当没关')
  }
  // def false：active / allowGroupName
  for (const key of ['active', 'allowGroupName']) {
    assert.equal(normalizeSettings({})[key], false, key + ' 未配置时应为 false')
    assert.equal(normalizeSettings({ [key]: undefined })[key], false)
    assert.equal(normalizeSettings({ [key]: null })[key], false)
    assert.equal(normalizeSettings({ [key]: true })[key], true)
    assert.equal(normalizeSettings({ [key]: false })[key], false)
    assert.equal(normalizeSettings({ [key]: 'true' })[key], false, '只认真正的 true，不认字符串')
  }
})

test('text：去首尾空白；非字符串按字符串处理', () => {
  assert.equal(normalizeSettings({ tutkBridgePath: '  C:/x/bridge.exe  ' }).tutkBridgePath, 'C:/x/bridge.exe')
  assert.equal(normalizeSettings({ tutkLibPath: '   ' }).tutkLibPath, '')
  assert.equal(normalizeSettings({ tutkBridgePath: undefined }).tutkBridgePath, '')
  assert.equal(normalizeSettings({ tutkBridgePath: 123 }).tutkBridgePath, '123')
})

test('normalizeSettings 只输出规则表里的键：未知键（users/enabled/__panelGroup）一律丢弃', () => {
  const n = normalizeSettings({
    enabled: false,
    active: true,
    users: '200002',
    groups: '700001',
    __panelGroup: 'platform',
    unlockMinutes: 1440,
    somethingElse: 1,
  })
  assert.deepEqual(Object.keys(n), RULE_KEYS)
  for (const gone of ['enabled', 'users', 'groups', '__panelGroup', 'unlockMinutes', 'somethingElse']) {
    assert.equal(Object.hasOwn(n, gone), false, '不该出现 ' + gone)
  }
  assert.equal(n.active, true)
  // 非对象输入不抛错，整份回落默认
  for (const bad of [null, undefined, '', 0, 'x', []]) {
    const out = normalizeSettings(bad)
    assert.deepEqual(Object.keys(out), RULE_KEYS)
    assert.equal(out.unlockDays, 7)
  }
})

test('effectiveEnabled：active 优先，只有 active 没写过才回落到 enabled', () => {
  assert.equal(effectiveEnabled({ active: true }), true)
  assert.equal(effectiveEnabled({ active: false, enabled: true }), false, 'active 写过就以它为准')
  assert.equal(effectiveEnabled({ enabled: true }), true, '老配置只有 enabled 时回落')
  assert.equal(effectiveEnabled({ enabled: false }), false)
  assert.equal(effectiveEnabled({}), false)
  assert.equal(effectiveEnabled({ active: null, enabled: true }), true, 'null 当作没写过，回落 enabled')
  assert.equal(effectiveEnabled({ active: undefined, enabled: true }), true)
  assert.equal(effectiveEnabled(null), false)
  assert.equal(effectiveEnabled(undefined), false)
})

test('describeRules 深拷贝：同键、可 JSON 序列化、改返回值不影响规则表', () => {
  const rules = describeRules()
  assert.deepEqual(Object.keys(rules), RULE_KEYS)
  assert.equal(typeof rules, 'object')
  // 不能带函数（宿主面板会把 rules 原样塞进渲染树 / JSON）
  const dumped = JSON.stringify(rules)
  assert.equal(typeof dumped, 'string')
  assert.deepEqual(JSON.parse(dumped), rules)
  assert.equal(JSON.stringify(rules).includes('function'), false)
  assert.equal(describeRule('unlockDays').min, 1)
  assert.equal(describeRule('unlockDays').max, 30)
  assert.equal(describeRule('no-such-key'), null)
  // 深拷贝：改返回值不污染 SETTING_RULES
  rules.groupMode.values.push('hacked')
  rules.unlockDays.max = 999
  assert.deepEqual(SETTING_RULES.groupMode.values, ['off', 'status', 'control'])
  assert.equal(SETTING_RULES.unlockDays.max, 30)
  assert.equal(describeRules().unlockDays.max, 30)
})
