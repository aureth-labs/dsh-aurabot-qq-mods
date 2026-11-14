// test/click.test.mjs —— 执行级测试（2026-11-09 加）。
// verify.mjs 大多是「源码字符串 grep」，抓不到运行时回归（0.9.5 的 r2 作用域、myNickname
// 都是在 157 项全绿下炸的）。clicker 的依赖（evalJs / send / sleep / note）本来就是注入的，
// 所以喂一套假 CDP 就能把 find→稳定→唯一→命中→点击 全链真正执行一遍，不用开浏览器。
// 用法：node --test test/click.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createClicker } from '../lib/click.mjs'
import { createGate } from '../lib/gate.mjs'

/** 假 CDP：靠表达式里独有的片段分清是 find / hit / mark / unmark / scroll（和真页面无关，只回灌状态）。 */
function fakeCdp(state) {
  const sends = []
  const notes = []
  const sleeps = []
  const evalJs = async (expr) => {
    if (expr.includes('pickRoot')) return state.hitResult // HIT_SRC
    if (expr.includes('cssText')) return { left: 1, top: 1, width: 10, height: 10 } // MARK_SRC / markRect
    if (expr.includes("getElementById('ab-mark')")) return true // UNMARK_SRC
    if (expr.includes('scrollX')) return { x: 0, y: 0 } // SCROLL_SRC
    if (expr.includes('spec.ancestorText')) return state.findResult // FIND_SRC
    return null
  }
  const clicker = createClicker({
    evalJs,
    send: (method, params) => { sends.push({ method, params }); return Promise.resolve({}) },
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    note: (t, l) => notes.push([t, l]),
  })
  return { clicker, sends, notes, sleeps }
}

const cand = (over = {}) => ({
  text: '送灯牌',
  sig: 'div.btn>div|送灯牌',
  tag: 'div',
  clickable: true,
  where: 'doc',
  area: 2400,
  rect: { left: 100, top: 100, right: 160, bottom: 140, width: 60, height: 40 },
  ...over,
})

/** 9 点全命中的命中校验（第 4 个点是中心）。 */
const goodHit = (r = { left: 100, top: 100, width: 60, height: 40 }) => {
  const inset = Math.max(3, Math.min(6, Math.round(r.width / 6)))
  const xs = [r.left + inset, r.left + r.width / 2, r.left + r.width - inset]
  const ys = [r.top + inset, r.top + r.height / 2, r.top + r.height - inset]
  const points = []
  for (const y of ys) for (const x of xs) points.push({ x: Math.round(x), y: Math.round(y), ok: true, hit: '送灯牌' })
  return { ok: true, good: 9, rect: r, points }
}

const presses = (sends) => sends.filter((s) => s.method === 'Input.dispatchMouseEvent' && s.params.type === 'mousePressed')

test('prepare + commit 全链：唯一候选 → 签名一致 → 点中心', async () => {
  const state = { findResult: { total: 1, list: [cand()] }, hitResult: goodHit() }
  const { clicker, sends } = fakeCdp(state)
  const prep = await clicker.prepare({ label: '送灯牌按钮', spec: { text: '^送灯牌$' } })
  assert.ok(prep.ok, 'prepare 应该成功：' + (prep.reason || ''))
  assert.equal(prep.point.x, 130) // 恰好是 9 点的中心
  assert.equal(prep.point.y, 120)
  const r = await clicker.commit(prep, {})
  assert.ok(r.ok, 'commit 应该成功：' + (r.reason || ''))
  assert.equal(presses(sends).length, 1, '只应按下一次')
  assert.equal(presses(sends)[0].params.x, 130)
  assert.equal(presses(sends)[0].params.y, 120)
})

test('commit：等确认期间目标换了（签名不一致）就拒绝点', async () => {
  const state = { findResult: { total: 1, list: [cand()] }, hitResult: goodHit() }
  const { clicker, sends } = fakeCdp(state)
  const prep = await clicker.prepare({ label: '送灯牌按钮', spec: { text: '^送灯牌$' } })
  assert.ok(prep.ok)
  state.findResult = { total: 1, list: [cand({ sig: 'div.OTHER|点亮', text: '点亮' })] }
  const r = await clicker.commit(prep, {})
  assert.ok(!r.ok)
  assert.match(r.reason, /目标换了/)
  assert.equal(presses(sends).length, 0, '一个都不能点')
})

test('prepare：同名候选有两个（不重叠）→ 唯一性拒绝', async () => {
  const state = {
    findResult: {
      total: 2,
      list: [cand(), cand({ rect: { left: 500, top: 100, right: 560, bottom: 140, width: 60, height: 40 } })],
    },
    hitResult: goodHit(),
  }
  const { clicker, sends } = fakeCdp(state)
  const prep = await clicker.prepare({ label: '送灯牌按钮', spec: { text: '^送灯牌$' } })
  assert.ok(!prep.ok)
  assert.match(prep.reason, /同时找到 2 个/)
  assert.equal(presses(sends).length, 0)
})

test('prepare：命中校验不过（2/9）→ 拒绝点', async () => {
  const points = []
  for (let i = 0; i < 9; i++) points.push({ x: 100 + i, y: 100 + i, ok: i < 2, hit: '别的东西' })
  const state = { findResult: { total: 1, list: [cand()] }, hitResult: { ok: false, good: 2, points } }
  const { clicker, sends } = fakeCdp(state)
  const prep = await clicker.prepare({ label: '送灯牌按钮', spec: { text: '^送灯牌$' } })
  assert.ok(!prep.ok)
  assert.match(prep.reason, /命中校验没过/)
  assert.equal(presses(sends).length, 0)
})

test('prepare：中心被挡住时，选离中心最近的好点', async () => {
  const hit = goodHit()
  hit.points[4] = { ...hit.points[4], ok: false, hit: '弹幕飘过' } // 挡中心
  const state = { findResult: { total: 1, list: [cand()] }, hitResult: hit }
  const { clicker } = fakeCdp(state)
  const prep = await clicker.prepare({ label: '送灯牌按钮', spec: { text: '^送灯牌$' } })
  assert.ok(prep.ok)
  assert.notEqual(prep.point.y, 120, '不能再点被挡住的中心')
  assert.equal(prep.point.x, 130)
  assert.equal(prep.point.y, 106, '离中心最近的好点在正上方（14px < 24px）')
})

test('clickOnce：一步到底（找→唯一→命中→点）', async () => {
  const state = { findResult: { total: 1, list: [cand()] }, hitResult: goodHit() }
  const { clicker, sends } = fakeCdp(state)
  const r = await clicker.clickOnce({ label: '入口', spec: { text: '粉丝团' }, settleMs: 0 })
  assert.ok(r.ok, 'clickOnce 应该成功：' + (r.reason || ''))
  const seq = sends.map((s) => s.method + ':' + s.params.type)
  assert.deepEqual(seq, [
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ], '点击事件序列：移两下 → 按下 → 抬起')
})

test('markRect：有 rect 画框、没 rect 不炸', async () => {
  const state = { findResult: { total: 1, list: [cand()] }, hitResult: goodHit() }
  const { clicker } = fakeCdp(state)
  assert.equal(await clicker.markRect(null), null)
  const m = await clicker.markRect(cand().rect)
  assert.ok(m, '画框要返回位置')
})

test('gate：一次只放一个、用过即废、到点自动过期', () => {
  let t = 1000
  const gate = createGate({ ttlMs: 5000, now: () => t })
  assert.ok(gate.open({ kind: 'badge', label: '灯牌' }).ok)
  assert.ok(!gate.open({ kind: 'gift', label: '礼物' }).ok, '还有一个在等时不能开第二个')
  assert.equal(gate.state().label, '灯牌')
  const taken = gate.take()
  assert.equal(taken.label, '灯牌')
  assert.equal(gate.peek(), null, '取走后就没有了')
  assert.ok(gate.open({ kind: 'gift', label: '礼物' }).ok)
  t = 7000
  // 注意：peek() 发现过期时会顺手把它清掉，所以「拿刚过期的那个」必须直接 sweep，
  // 不能先 peek —— 模块里 armGate 的定时器就是只调 sweep。
  const gone = gate.sweep()
  assert.equal(gone && gone.label, '礼物', 'sweep 能拿到刚过期的那个')
  assert.equal(gate.peek(), null)
})

test('gate：take 带错号不消费、setTtl 立刻生效', () => {
  let t = 1000
  const gate = createGate({ ttlMs: 5000, now: () => t })
  const g = gate.open({ kind: 'badge', label: '灯牌' })
  assert.ok(g.ok)
  assert.equal(gate.take('错的id'), null, 'id 对不上不能取')
  assert.ok(gate.peek(), '没被误取')
  const live = gate.take(g.action.id)
  assert.equal(live.label, '灯牌')
  gate.setTtl(1000)
  assert.ok(gate.open({ kind: 'test', label: '短' }).ok)
  t = 2200
  assert.equal(gate.peek(), null, '改成 1 秒后到点就过期')
})
