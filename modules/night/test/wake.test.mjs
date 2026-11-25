// 唤醒判定（wake.mjs）测试。
//
// 「睡着了之后，对方要叫几次才能把她叫醒」——这套概率模型有个特点：
// 攒够次数必醒、掷不中不清零、群聊可能直接静默。
// 这些行为如果不写下来，改参数时很容易把「永远叫不醒」或者「一下就醒」调出来。
//
// 注意：默认 wakeStartCount = 2，意味着**私聊里发第一条她必定不回**。
// 这是刻意设计的（睡着别被随随便便吵醒），有测试钉着，改之前要想清楚。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createWaker, MODE_NEVER, MODE_PRIVATE, MODE_BOTH } from '../wake.mjs'

/** 造一个 waker：固定配置 + 可控的骰子。 */
function makeWaker(cfg = {}, { stage = () => ({ factor: 1, label: '' }), rng = () => 0.99 } = {}) {
  const config = {
    wakeMode: MODE_PRIVATE,
    wakeWindowMinutes: 10,
    wakeStartCount: 2,
    wakeStepCount: 4,
    ...cfg,
  }
  return createWaker(() => config, () => stage(), rng)
}

// ---------------------------------------------------------------- 档位

test('never 档：谁叫都不醒', () => {
  const w = makeWaker({ wakeMode: MODE_NEVER })
  for (let i = 0; i < 10; i++) {
    const r = w.check({ sessionId: 'private:1' })
    assert.equal(r.woke, false)
    assert.match(r.reason, /不可唤醒/)
  }
})

test('private_only 档：群聊直接静默，连计数都不攒', () => {
  const w = makeWaker({ wakeMode: MODE_PRIVATE })
  const r = w.check({ sessionId: 'group:1', isGroup: true, atMe: true })
  assert.equal(r.allowed, false)
  assert.equal(r.woke, false)
  assert.match(r.reason, /群聊已被静默/)
  assert.deepEqual(w.peek('group:1'), [0, 0], '不该攒次数')
})

test('private_only 档：私聊正常累计', () => {
  const w = makeWaker({ wakeMode: MODE_PRIVATE })
  // allowed 表示「被拦住了」，第一条还差次数所以 false——但它确实在计数
  const r = w.check({ sessionId: 'private:1' })
  assert.equal(r.count, 1, '应该计数')
  assert.equal(r.allowed, false, '第一条还差次数')
  assert.deepEqual(w.peek('private:1')[0], 1, 'peek 能看到这次计数')
})

test('both 档：群里点名才计数，没点名不算', () => {
  const w = makeWaker({ wakeMode: MODE_BOTH })
  const plain = w.check({ sessionId: 'group:1', isGroup: true, atMe: false })
  assert.equal(plain.allowed, false)
  assert.match(plain.reason, /没被点名/)
  // 点名了就会计数，但第一条同样还差次数（和私聊一致）
  const first = w.check({ sessionId: 'group:1', isGroup: true, atMe: true })
  assert.equal(first.count, 1, '点名了应该计数')
  assert.equal(first.allowed, false, '第一条还差次数')
  const second = w.check({ sessionId: 'group:1', isGroup: true, atMe: true })
  assert.equal(second.allowed, true, '第二条开始掷骰')
})

// ---------------------------------------------------------------- 计数与概率

test('默认配置下，第一条不掷骰（wakeStartCount = 2）', () => {
  const w = makeWaker()
  const r = w.check({ sessionId: 'private:1' })
  assert.equal(r.allowed, false)
  assert.equal(r.chance, 0)
  assert.match(r.reason, /还差 1 次/)
})

test('第二条开始掷骰', () => {
  const w = makeWaker({}, { rng: () => 0.99 }) // 掷不中
  w.check({ sessionId: 'private:1' })
  const r = w.check({ sessionId: 'private:1' })
  assert.equal(r.allowed, true)
  assert.ok(r.chance > 0, '应该有概率')
})

test('骰子够小就醒，够大就继续睡', () => {
  const always = makeWaker({}, { rng: () => 0 })
  always.check({ sessionId: 'private:1' })
  assert.equal(always.check({ sessionId: 'private:1' }).woke, true)

  const never = makeWaker({}, { rng: () => 0.999 })
  never.check({ sessionId: 'private:1' })
  assert.equal(never.check({ sessionId: 'private:1' }).woke, false)
})

test('掷不中不清零，继续攒', () => {
  const w = makeWaker({}, { rng: () => 0.999 })
  w.check({ sessionId: 'private:1' })
  w.check({ sessionId: 'private:1' })
  w.check({ sessionId: 'private:1' })
  assert.equal(w.peek('private:1')[0], 3, '三次都该记着')
})

test('攒够步数必醒（概率到 100%）', () => {
  // start=2 step=4 → 第 6 次概率 100%
  const w = makeWaker({}, { rng: () => 0.999 })
  let wokeAt = 0
  for (let i = 1; i <= 8; i++) {
    const r = w.check({ sessionId: 'private:1' })
    if (r.woke) { wokeAt = i; break }
  }
  assert.equal(wokeAt, 6, `应该在第六次必醒，实际 ${wokeAt}`)
})

test('醒了以后计数清零', () => {
  const w = makeWaker({}, { rng: () => 0 })
  w.check({ sessionId: 'private:1' })
  const r = w.check({ sessionId: 'private:1' })
  assert.equal(r.woke, true)
  assert.deepEqual(w.peek('private:1'), [0, 0], '醒了计数该清空')
})

test('概率随条数递增', () => {
  const w = makeWaker({}, { rng: () => 0.999 })
  const chances = []
  for (let i = 0; i < 6; i++) {
    const r = w.check({ sessionId: 'private:1' })
    if (r.allowed) chances.push(r.chance)
  }
  for (let i = 1; i < chances.length; i++) {
    assert.ok(chances[i] >= chances[i - 1], '概率应该单调不减')
  }
})

// ---------------------------------------------------------------- 阶段系数

test('深睡阶段系数低，概率被压低', () => {
  const light = makeWaker({}, { rng: () => 0.999, stage: () => ({ factor: 1, label: '浅睡' }) })
  const deep = makeWaker({}, { rng: () => 0.999, stage: () => ({ factor: 0.3, label: '深睡' }) })
  for (const w of [light, deep]) w.check({ sessionId: 'private:1' })
  const l = light.check({ sessionId: 'private:1' })
  const d = deep.check({ sessionId: 'private:1' })
  assert.ok(d.chance < l.chance, '深睡概率应该更低')
  assert.match(d.reason, /深睡/, '理由里应该带上阶段名')
})

// ---------------------------------------------------------------- 会话隔离

test('不同会话各算各的', () => {
  const w = makeWaker({}, { rng: () => 0.999 })
  w.check({ sessionId: 'private:1' })
  w.check({ sessionId: 'private:1' })
  assert.equal(w.peek('private:1')[0], 2)
  assert.deepEqual(w.peek('private:2'), [0, 0], '另一个会话不该被影响')
})

test('reset 只清指定会话', () => {
  const w = makeWaker({}, { rng: () => 0.999 })
  w.check({ sessionId: 'private:1' })
  w.check({ sessionId: 'private:2' })
  w.reset('private:1')
  assert.deepEqual(w.peek('private:1'), [0, 0])
  assert.equal(w.peek('private:2')[0], 1, '另一个还留着')
})

test('resetAll 全清', () => {
  const w = makeWaker({}, { rng: () => 0.999 })
  w.check({ sessionId: 'private:1' })
  w.check({ sessionId: 'private:2' })
  w.resetAll()
  assert.deepEqual(w.peek('private:1'), [0, 0])
  assert.deepEqual(w.peek('private:2'), [0, 0])
})

// ---------------------------------------------------------------- 窗口

test('窗口过期后重新计数', () => {
  const w = makeWaker({ wakeWindowMinutes: 10 }, { rng: () => 0.999 })
  w.check({ sessionId: 'private:1' })
  assert.equal(w.peek('private:1')[0], 1)
  // 直接把窗口起点往前推 11 分钟，模拟过期
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 11 * 60_000
    const r = w.check({ sessionId: 'private:1' })
    assert.equal(r.count, 1, '过期后应该从 1 重新开始')
  } finally {
    Date.now = realNow
  }
})

// ---------------------------------------------------------------- 文案

test('statusLine 在没攒次数时给出说明', () => {
  const w = makeWaker()
  assert.match(w.statusLine('private:1'), /没有攒/)
})

test('statusLine 在攒了但还不够时说还差几次', () => {
  const w = makeWaker({}, { rng: () => 0.999 })
  w.check({ sessionId: 'private:1' })
  assert.match(w.statusLine('private:1'), /还差 1 次/)
})

test('mode() 返回当前档位，非法值回退到 private_only', () => {
  assert.equal(makeWaker({ wakeMode: MODE_BOTH }).mode(), MODE_BOTH)
  assert.equal(makeWaker({ wakeMode: 'garbage' }).mode(), MODE_PRIVATE)
  assert.equal(makeWaker({ wakeMode: undefined }).mode(), MODE_PRIVATE)
})
