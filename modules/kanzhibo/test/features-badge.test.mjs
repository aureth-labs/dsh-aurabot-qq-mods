import { test } from 'node:test'
import assert from 'node:assert/strict'
import { badgeRowState } from '../lib/features/badge.mjs'

const T = '2026-11-22'

test('badgeRowState：可送（1钻，可得100 + 送灯牌）→ open', () => {
  const r = badgeRowState('送1个"灯牌"\n1钻，可得100亲密度\n送灯牌')
  assert.equal(r.state, 'open')
})

test('badgeRowState：强完成标记 → sent', () => {
  const r = badgeRowState('送1个基础灯牌 已完成 +100')
  assert.equal(r.state, 'sent')
})

test('badgeRowState：弱标记 + progress≥1 → sent（保守）', () => {
  const r = badgeRowState('送1个基础灯牌 今日第27位送灯牌，连续15天 +100', { progressBefore: 2 })
  assert.equal(r.state, 'sent')
})

test('badgeRowState：弱标记但 progress 未知 → unknown（不冒进）', () => {
  const r = badgeRowState('送1个基础灯牌 今日第27位送灯牌，连续15天 +100', { progressBefore: null })
  assert.equal(r.state, 'unknown')
})

test('badgeRowState：没有灯牌行 → unknown', () => {
  const r = badgeRowState('粉丝团 今日任务 1/3')
  assert.equal(r.state, 'unknown')
})

test('badgeRowState：恢复勋章态（AX 实测：无“灯牌”，只有“点亮粉丝团恢复勋章/点亮 (1钻)”）→ open/恢复', () => {
  const r = badgeRowState('点亮粉丝团恢复勋章\n勋章已熄灭，点亮后可继续做任务升级\n点亮 (1钻)\n恢复点亮后可继续提升亲密度')
  assert.equal(r.state, 'open')
  assert.equal(r.kind, '恢复')
})

test('badgeRowState：真机已送态（今日任务1/3 + 今日第18位送灯牌，连续1天）→ sent', () => {
  const text = '3 今日任务1/3\n粉丝团灯牌\n今日第18位送灯牌，连续1天\n送1个基础灯牌'
  const r = badgeRowState(text, { progressBefore: 1 })
  assert.equal(r.state, 'sent')
})
test('badgeRowState：真机可送态（送灯牌 + 1钻，可得100亲密度）→ open', () => {
  const text = '送1个“灯牌”\n1钻，可得100亲密度\n送灯牌'
  const r = badgeRowState(text, { progressBefore: 0 })
  assert.equal(r.state, 'open')
})
