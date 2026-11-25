// 精力与疲劳时段（energy.mjs）测试。
//
// 这个文件管两件事：精力怎么扣、什么时候算「疲劳时段」。
// 时段判错会导致「下午三点说我要睡了」或者「半夜还在精神抖擞」，
// 都是很难解释的状态，所以时段边界要钉死。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_NOON,
  DEFAULT_NIGHT,
  parseHHMM,
  parseWindow,
  inWindow,
  fatigueKind,
  inFatigue,
  clamp,
  drain,
  recover,
  exhausted,
  nextWakeTime,
  wakeWindowText,
  humanDuration,
  dayLabel,
  sliceByFatigue,
  closeAction,
} from '../energy.mjs'

const MINUTE = 60_000
const at = (h, m = 0, day = 15) => new Date(2026, 10, day, h, m).getTime()

// ---------------------------------------------------------------- 时间解析

test('parseHHMM 能解析合法时间', () => {
  assert.equal(parseHHMM('08:00'), 480)
  assert.equal(parseHHMM('23:30'), 1410)
  assert.equal(parseHHMM('00:00'), 0)
  assert.equal(parseHHMM('8:0'), 480) // 单位数也认
})

test('parseHHMM 拒绝非法输入', () => {
  for (const bad of ['', 'abc', '25:00', '12:60', null, undefined, '12']) {
    assert.equal(parseHHMM(bad), null, `应该拒绝：${bad}`)
  }
})

test('parseWindow 解析区间，反向区间也认（23:30-07:00）', () => {
  assert.deepEqual(parseWindow('13:00-14:30'), [780, 870])
  assert.deepEqual(parseWindow('23:30-07:00'), [1410, 420])
  assert.equal(parseWindow(''), null)
  assert.equal(parseWindow('08:00-08:00'), null, '首尾相同视为非法')
})

// ---------------------------------------------------------------- 区间判断

test('inWindow：普通区间', () => {
  const w = parseWindow('13:00-14:30')
  assert.equal(inWindow(780, w), true) // 13:00 含
  assert.equal(inWindow(869, w), true)
  assert.equal(inWindow(870, w), false) // 右开
  assert.equal(inWindow(779, w), false)
})

test('inWindow：跨零点区间', () => {
  const w = parseWindow('23:30-07:00')
  assert.equal(inWindow(1410, w), true) // 23:30
  assert.equal(inWindow(0, w), true) // 00:00
  assert.equal(inWindow(419, w), true) // 06:59
  assert.equal(inWindow(420, w), false) // 07:00 右开
  assert.equal(inWindow(720, w), false) // 12:00
})

test('inWindow 对空窗口一律 false', () => {
  assert.equal(inWindow(500, null), false)
})

// ---------------------------------------------------------------- 疲劳时段

test('夜间优先于午间', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }
  assert.equal(fatigueKind(cfg, at(23, 30)), 'night')
  assert.equal(fatigueKind(cfg, at(2, 0)), 'night')
  assert.equal(fatigueKind(cfg, at(13, 30)), 'noon')
  assert.equal(fatigueKind(cfg, at(15, 0)), '')
  assert.equal(fatigueKind(cfg, at(20, 0)), '')
})

test('疲劳时段边界：右端不含', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }
  assert.equal(fatigueKind(cfg, at(7, 0)), '')
  assert.equal(fatigueKind(cfg, at(14, 30)), '')
  assert.equal(fatigueKind(cfg, at(6, 59)), 'night')
})

test('没配就用默认窗口', () => {
  assert.equal(fatigueKind({}, at(23, 45)), 'night')
  assert.equal(fatigueKind({}, at(13, 10)), 'noon')
  // 默认值本身要对得上常量
  assert.equal(DEFAULT_NIGHT, '23:30-07:00')
  assert.equal(DEFAULT_NOON, '13:00-14:30')
})

test('inFatigue 和 fatigueKind 结论一致', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }
  for (const t of [at(23, 30), at(2, 0), at(13, 30), at(15, 0), at(20, 0)]) {
    assert.equal(inFatigue(cfg, t), Boolean(fatigueKind(cfg, t)), `时间 ${new Date(t).toISOString()}`)
  }
})

// ---------------------------------------------------------------- 精力增减

test('clamp 卡在 0~100', () => {
  assert.equal(clamp(-5), 0)
  assert.equal(clamp(105), 100)
  assert.equal(clamp(50), 50)
  assert.equal(clamp(50, 10, 60), 50)
})

test('drain：按分钟和条数扣，不会扣成负数', () => {
  assert.equal(drain(100, { minutes: 10, perMinute: 1 }), 90)
  assert.equal(drain(100, { messages: 5, perMessage: 4 }), 80)
  assert.equal(drain(10, { messages: 10, perMessage: 4 }), 0, '不能扣成负的')
  assert.equal(drain(100, {}), 100, '什么都不传就不变')
})

test('recover：只加不回退，上限 100', () => {
  assert.equal(recover(50, { minutes: 10, perMinute: 1 }), 60)
  assert.equal(recover(95, { minutes: 10, perMinute: 1 }), 100)
  assert.equal(recover(50, {}), 50)
})

test('exhausted 默认阈值 0.5', () => {
  assert.equal(exhausted(0), true)
  assert.equal(exhausted(0.5), true)
  assert.equal(exhausted(0.6), false)
  assert.equal(exhausted(5, 5), true)
  assert.equal(exhausted(5.1, 5), false)
})

// ---------------------------------------------------------------- 起床时间

test('夜睡：起床时间落在配置的钟点（jitter=0）', () => {
  const ts = at(23, 30) // 11/15 23:30 睡
  const wake = nextWakeTime({ wakeTime: '08:00', wakeJitterMinutes: 0 }, ts, { kind: 'night' })
  const d = new Date(wake)
  assert.equal(d.getHours(), 8)
  assert.equal(d.getMinutes(), 0)
  assert.equal(d.getDate(), 16, '应该是第二天早上')
})

test('夜睡：至少睡 20 分钟，不会算出过去的时间', () => {
  const ts = at(7, 55) // 已经快到起床点了才睡
  const wake = nextWakeTime({ wakeTime: '08:00', wakeJitterMinutes: 0 }, ts, { kind: 'night' })
  assert.ok(wake >= ts + 20 * MINUTE, '至少 20 分钟')
})

// 抖动用 rng: () => 0.5 归零——注意 noonNapJitterMinutes 传 0 没用，
// 源码写的是 `Number(cfg.noonNapJitterMinutes) || 15`，0 是假值会回退成默认 15。
const noJitter = () => 0.5

test('午睡：固定时长，不跟夜间起床点走', () => {
  const ts = at(13, 0)
  const wake = nextWakeTime({ noonNapMinutes: 60 }, ts, { kind: 'noon', rng: noJitter })
  assert.equal(wake - ts, 60 * MINUTE)
})

test('午睡时长有上下限（10~180 分钟）', () => {
  const ts = at(13, 0)
  const tooLong = nextWakeTime({ noonNapMinutes: 999 }, ts, { kind: 'noon', rng: noJitter })
  assert.equal(tooLong - ts, 180 * MINUTE, '封顶 180')
  const tooShort = nextWakeTime({ noonNapMinutes: 1 }, ts, { kind: 'noon', rng: noJitter })
  assert.equal(tooShort - ts, 10 * MINUTE, '至少 10')
})

test('午睡没配时长就用默认 60 分钟', () => {
  const ts = at(13, 0)
  const wake = nextWakeTime({}, ts, { kind: 'noon', rng: noJitter })
  assert.equal(wake - ts, 60 * MINUTE)
})

test('jitter 用注入的 rng，结果可复现', () => {
  const ts = at(23, 0)
  const cfg = { wakeTime: '08:00', wakeJitterMinutes: 30 }
  const a = nextWakeTime(cfg, ts, { kind: 'night', rng: () => 0 })
  const b = nextWakeTime(cfg, ts, { kind: 'night', rng: () => 0 })
  assert.equal(a, b, '同一个 rng 结果应该一致')
  const c = nextWakeTime(cfg, ts, { kind: 'night', rng: () => 1 })
  assert.notEqual(a, c, '不同 rng 应该有差别')
})

test('wakeWindowText：没浮动只显示一个点，有浮动显示区间', () => {
  assert.equal(wakeWindowText({ wakeTime: '08:00', wakeJitterMinutes: 0 }), '08:00')
  assert.equal(wakeWindowText({ wakeTime: '08:00', wakeJitterMinutes: 30 }), '07:30-08:30')
})

// ---------------------------------------------------------------- 文案

test('humanDuration 说人话', () => {
  assert.match(humanDuration(0), /./)
  assert.match(humanDuration(90 * MINUTE), /小时/)
})

test('dayLabel 能给出日期标签', () => {
  const label = dayLabel(at(12, 0))
  assert.equal(typeof label, 'string')
  assert.ok(label.length > 0)
})

// ---------------------------------------------------------------- 时段切分

test('sliceByFatigue 把一段连续时间按疲劳时段切开', () => {
  // 从 22:00 到次日 09:00，应该切出「非疲劳 → 夜 → 非疲劳」三段
  const from = at(22, 0)
  const to = at(9, 0, 16)
  const slices = sliceByFatigue({ nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }, from, to, 10)
  assert.ok(slices.length >= 3, `至少切成 3 段，实际 ${slices.length}`)
  const kinds = slices.map((s) => s.kind)
  assert.ok(kinds.includes('night'), '应该包含夜间段')
  assert.equal(kinds[0], '', '开头 22:00 还没到疲劳时段')
  assert.equal(kinds[kinds.length - 1], '', '结尾 09:00 已经过了')
  // 每段时长都是正数
  assert.ok(slices.every((s) => s.minutes > 0))
})

// ---------------------------------------------------------------- 收线该不该真睡（#250）

test('closeAction：夜间收线真的睡', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }
  const r = closeAction(cfg, '晚安', at(23, 30))
  assert.deepEqual(r, { sleep: true, kind: 'night' })
  const r2 = closeAction(cfg, '晚安', at(2, 0))
  assert.deepEqual(r2, { sleep: true, kind: 'night' })
})

test('closeAction：午间收线算午睡', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }
  const r = closeAction(cfg, '晚安', at(13, 30))
  assert.deepEqual(r, { sleep: true, kind: 'noon' })
})

test('closeAction：白天收线只安静，不睡（#250 的核心）', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30', dayMuteMinutes: 30 }
  for (const h of [7, 10, 15, 18, 22]) {
    const r = closeAction(cfg, '晚安', at(h, 0))
    assert.equal(r.sleep, false, `${h}:00 不该真睡`)
    assert.equal(r.muteMinutes, 30, `${h}:00 应该只安静 30 分钟`)
  }
})

test('closeAction：她说「眯一会儿」时夜里也按午睡算', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30' }
  const r = closeAction(cfg, '眯一会儿', at(2, 0))
  assert.deepEqual(r, { sleep: true, kind: 'noon' }, '深夜说眯一会儿不该算整夜睡')
})

test('closeAction：白天说「眯一会儿」也不睡', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30', dayMuteMinutes: 20 }
  const r = closeAction(cfg, '眯一会儿', at(16, 0))
  assert.equal(r.sleep, false)
  assert.equal(r.muteMinutes, 20)
})

test('closeAction：dayMuteMinutes 有下限，不能配成 0', () => {
  const cfg = { nightFatigue: '23:30-07:00', noonFatigue: '13:00-14:30', dayMuteMinutes: 0 }
  const r = closeAction(cfg, '晚安', at(15, 0))
  assert.ok(r.muteMinutes >= 5, '至少 5 分钟')
})
