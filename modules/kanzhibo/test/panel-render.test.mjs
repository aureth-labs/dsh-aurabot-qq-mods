import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 用假 React/ui 渲染 panel.js 组件树，验证「面板有哪些卡/按钮」以及「点按钮调到哪个接口」。
// 不启动浏览器、不连 DSH。
const source = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
const Comp = new Function('React', 'h', 'ui', 'call', source)

function makeHarness(settings) {
  const calls = []
  const React = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}, useRef: () => ({ current: null }),
  }
  const h = (type, props, ...children) => { if (typeof type === 'function') { const r = type(props || {}, ...children); return (r && typeof r === 'object') ? r : { type: 'frag', props: {}, children: [] } } return { type, props: props || {}, children: children.flat(Infinity) } }
  const ui = new Proxy({}, { get: (_t, name) => (props, ...children) => ({ type: 'ui:' + String(name), props: props || {}, children: children.flat(Infinity) }) })
  const call = async (path, body) => { calls.push({ path, body }); return { ok: true, message: 'ok' } }
  const tree = Comp(React, h, ui, call)({ settings, draftSettings: { ...settings }, setSettings: () => {}, toast: () => {} })
  return { tree, calls }
}
const SETTINGS = {
  enabled: true, target: 'https://live.douyin.com/1', schedule: false, startTime: '20:00', endTime: '23:30', checkSec: 120,
  liveCommentOn: false, liveComment: '', commentDelaySec: 8, renewBadge: true, badgeDelaySec: 30, badgeNickname: '蔚', badgeJudgeV2: false,
  giftByDm: false, semiAuto: true, confirmSec: 90, browserPath: '', minuteReport: false,
}
function nodes(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out
  out.push(tree)
  for (const c of tree.children || []) nodes(c, out)
  for (const v of Object.values(tree.props || {})) {
    if (Array.isArray(v)) v.forEach((x) => nodes(x, out))
    else if (v && typeof v === 'object') nodes(v, out)
  }
  return out
}
function allText(tree, out = []) {
  if (tree == null) return out
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out }
  if (typeof tree !== 'object') return out
  const p = tree.props || {}
  for (const k of ['title', 'label', 'desc', 'placeholder']) if (typeof p[k] === 'string') out.push(p[k])
  for (const c of tree.children || []) allText(c, out)
  return out
}
function btnByText(tree, t) {
  return nodes(tree).find((n) => String(n.type).startsWith('ui:Btn') && allText(n).join('').includes(t))
}

test('panel：卡片与按钮齐全（不启动浏览器）', () => {
  const { tree } = makeHarness(SETTINGS)
  const text = allText(tree).join('\n')
  for (const t of ['抖音账号', '浏览器窗口', '运行状态', '进房评论', '粉丝团灯牌', '送礼', '私信发弹幕', '操作记录']) {
    assert.ok(text.includes(t), '缺少卡片：' + t)
  }
  for (const b of ['扫码登录', '检查登录', '显示浏览器窗口', '收起窗口', '刷新']) {
    assert.ok(btnByText(tree, b), '缺少按钮：' + b)
  }
  // 昵称输入框（placeholder 蔚）
  const hasNickInput = nodes(tree).some((n) => n.type === 'input' && (n.props.placeholder === '蔚' || n.props.value === '蔚'))
  assert.ok(hasNickInput, '缺少「自己的直播间昵称」输入框')
})

test('panel：按钮接到正确接口', async () => {
  const { tree, calls } = makeHarness(SETTINGS)
  const click = async (t) => { const b = btnByText(tree, t); assert.ok(b && b.props.onClick, '没有按钮 ' + t); const start = calls.length; await b.props.onClick(); return { path: calls[start] && calls[start].path } }
  assert.equal((await click('显示浏览器窗口')).path, '/window?show=1')
  assert.equal((await click('收起窗口')).path, '/window?show=0')
  assert.equal((await click('扫码登录')).path, '/login')
  assert.equal((await click('检查登录')).path, '/login/state')
})
