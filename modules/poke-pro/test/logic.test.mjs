import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  pickWeighted,
  weightsToProbabilities,
  createCooldown,
  parsePokeTargets,
} from '../lib/weighted.mjs'
import {
  parseIdList,
  parseLineList,
  parseTargets,
  parseCommandPool,
  clampProbability,
  clampInt,
  buildActionList,
  DEFAULT_WEIGHTS,
  ACTION_LABELS,
} from '../lib/settings.mjs'
import { cronMatches } from '../index.mjs'

/* ---------------- 加权抽取 ---------------- */

/** 固定随机源，验证边界。 */
const fixedRandom = (v) => () => v

test('权重 0 的项永远不被选中', () => {
  const items = [{ id: 'a', weight: 0 }, { id: 'b', weight: 10 }]
  for (const r of [0, 0.1, 0.5, 0.99]) {
    assert.equal(pickWeighted(items, fixedRandom(r)), 'b', `r=${r} 应该选 b`)
  }
})

test('全 0 权重返回 null', () => {
  assert.equal(pickWeighted([{ id: 'a', weight: 0 }, { id: 'b', weight: 0 }], fixedRandom(0.5)), null)
  assert.equal(pickWeighted([], fixedRandom(0.5)), null)
  assert.equal(pickWeighted(null, fixedRandom(0.5)), null)
})

test('按权重比例分配区间', () => {
  const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }]
  // 总权重 4：a 占 [0,1)，b 占 [1,4)
  assert.equal(pickWeighted(items, fixedRandom(0.0)), 'a')
  assert.equal(pickWeighted(items, fixedRandom(0.24)), 'a')
  assert.equal(pickWeighted(items, fixedRandom(0.26)), 'b')
  assert.equal(pickWeighted(items, fixedRandom(0.99)), 'b')
})

test('r=1.0 的浮点边界落到最后一项，不会返回 undefined', () => {
  const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]
  assert.equal(pickWeighted(items, fixedRandom(0.999999999)), 'b')
})

test('分布大致符合权重（统计检验）', () => {
  const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 9 }]
  let countA = 0
  const N = 10000
  for (let i = 0; i < N; i++) if (pickWeighted(items) === 'a') countA++
  const ratio = countA / N
  assert.ok(ratio > 0.08 && ratio < 0.12, `a 的比例应约 10%，实际 ${(ratio * 100).toFixed(1)}%`)
})

test('weightsToProbabilities 归一化正确', () => {
  const p = weightsToProbabilities([{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }, { id: 'c', weight: 0 }])
  assert.equal(Math.round(p.a * 100), 25)
  assert.equal(Math.round(p.b * 100), 75)
  assert.equal(p.c, 0)
})

test('全 0 时概率全 0', () => {
  const p = weightsToProbabilities([{ id: 'a', weight: 0 }])
  assert.equal(p.a, 0)
})

/* ---------------- 冷却 ---------------- */

function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('冷却期内阻断，过期后放行', () => {
  const c = fakeClock()
  const cd = createCooldown(10_000, c.now)
  assert.equal(cd.hit('u1'), true)
  assert.equal(cd.hit('u1'), false, '冷却中应拒绝')
  c.advance(10_001)
  assert.equal(cd.hit('u1'), true, '过期后应放行')
})

test('不同 key 互不影响', () => {
  const c = fakeClock()
  const cd = createCooldown(5_000, c.now)
  assert.equal(cd.hit('a'), true)
  assert.equal(cd.hit('b'), true)
})

test('remaining 反映剩余时间', () => {
  const c = fakeClock()
  const cd = createCooldown(10_000, c.now)
  cd.hit('k')
  assert.equal(cd.remaining('k'), 10_000)
  c.advance(4000)
  assert.equal(cd.remaining('k'), 6000)
  c.advance(7000)
  assert.equal(cd.remaining('k'), 0)
})

test('ttlMs 暴露出来供配置变更检测', () => {
  const cd = createCooldown(12_345)
  assert.equal(cd.ttlMs, 12_345)
})

test('clear / forget 生效', () => {
  const c = fakeClock()
  const cd = createCooldown(5_000, c.now)
  cd.hit('a'); cd.hit('b')
  cd.forget('a')
  assert.equal(cd.size(), 1)
  cd.clear()
  assert.equal(cd.size(), 0)
})

/* ---------------- 设置解析 ---------------- */

test('parseIdList 支持多种分隔符', () => {
  assert.deepEqual(parseIdList('4,14,15'), [4, 14, 15])
  assert.deepEqual(parseIdList('4，14 15\n21'), [4, 14, 15, 21])
  assert.deepEqual(parseIdList([4, '14']), [4, 14])
})

test('parseIdList 丢掉非法项', () => {
  assert.deepEqual(parseIdList('4,abc,-1,3.5,15'), [4, 15])
})

test('parseLineList 去空行', () => {
  assert.deepEqual(parseLineList('a\n\n  b  \nc'), ['a', 'b', 'c'])
})

test('parseCommandPool 支持逗号和换行', () => {
  assert.deepEqual(parseCommandPool('盒,捣\n拍'), ['盒', '捣', '拍'])
})

test('parsePokeTargets 解析 群:QQ', () => {
  const out = parsePokeTargets(['460973561:1959676873', '123:456'])
  assert.deepEqual(out, [{ groupId: 460973561, userId: 1959676873 }, { groupId: 123, userId: 456 }])
})

test('parsePokeTargets 丢掉格式错误的', () => {
  const out = parsePokeTargets(['ok:1', '坏格式', '1:2', '1:2:3', '', ':'])
  assert.deepEqual(out, [{ groupId: 1, userId: 2 }])
})

test('parseTargets 接受数组和字符串', () => {
  assert.deepEqual(parseTargets(['1:2']), [{ groupId: 1, userId: 2 }])
  assert.deepEqual(parseTargets('1:2\n3:4'), [{ groupId: 1, userId: 2 }, { groupId: 3, userId: 4 }])
})

test('clampProbability 夹紧并兜底', () => {
  assert.equal(clampProbability(-0.5, 0.1), 0)
  assert.equal(clampProbability(1.5, 0.1), 1)
  assert.equal(clampProbability('abc', 0.1), 0.1)
})

test('clampInt 夹紧并兜底', () => {
  assert.equal(clampInt(-5, 10, 1, 100), 1)
  assert.equal(clampInt(999, 10, 1, 100), 100)
  assert.equal(clampInt('x', 10, 1, 100), 10)
  assert.equal(clampInt(3.7, 10, 1, 100), 4, '四舍五入')
})

test('buildActionList 把 0 权重保留为 0', () => {
  const list = buildActionList({ a: 5, b: 0, c: -1 })
  assert.deepEqual(list, [{ id: 'a', weight: 5 }, { id: 'b', weight: 0 }, { id: 'c', weight: 0 }])
})

test('默认权重与动作标签齐全', () => {
  for (const id of Object.keys(DEFAULT_WEIGHTS)) {
    assert.ok(ACTION_LABELS[id], `${id} 应有中文名`)
  }
  assert.equal(DEFAULT_WEIGHTS.record, 0, '语音默认关闭')
})

/* ---------------- cron ---------------- */

const at = (str) => new Date(str)

test('cron * * * * * 每分钟都匹配', () => {
  assert.equal(cronMatches('* * * * *', at('2026-11-08T22:30:00')), true)
})

test('cron 30 22 * * * 只在 22:30 匹配', () => {
  assert.equal(cronMatches('30 22 * * *', at('2026-11-08T22:30:00')), true)
  assert.equal(cronMatches('30 22 * * *', at('2026-11-08T22:31:00')), false)
  assert.equal(cronMatches('30 22 * * *', at('2026-11-08T21:30:00')), false)
})

test('cron 支持逗号列表', () => {
  assert.equal(cronMatches('0,30 * * * *', at('2026-11-08T10:30:00')), true)
  assert.equal(cronMatches('0,30 * * * *', at('2026-11-08T10:15:00')), false)
})

test('cron 支持范围', () => {
  assert.equal(cronMatches('* 9-17 * * *', at('2026-11-08T12:00:00')), true)
  assert.equal(cronMatches('* 9-17 * * *', at('2026-11-08T20:00:00')), false)
})

test('cron 支持步长', () => {
  assert.equal(cronMatches('*/15 * * * *', at('2026-11-08T10:00:00')), true)
  assert.equal(cronMatches('*/15 * * * *', at('2026-11-08T10:15:00')), true)
  assert.equal(cronMatches('*/15 * * * *', at('2026-11-08T10:07:00')), false)
})

test('cron 星期匹配', () => {
  // 2026-11-08 是周日（getDay=0）
  assert.equal(cronMatches('* * * * 0', at('2026-11-08T10:00:00')), true)
  assert.equal(cronMatches('* * * * 1', at('2026-11-08T10:00:00')), false)
})

test('cron 格式错误返回 false，不乱触发', () => {
  assert.equal(cronMatches('@daily', at('2026-11-08T10:00:00')), false)
  assert.equal(cronMatches('30 22 * *', at('2026-11-08T22:30:00')), false, '字段数不对')
  assert.equal(cronMatches('', at('2026-11-08T10:00:00')), false)
  assert.equal(cronMatches(null, at('2026-11-08T10:00:00')), false)
})
