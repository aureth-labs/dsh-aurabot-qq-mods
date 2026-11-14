import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState, interact, snapshot, syncFeed, loadState, parseAction, dayOf } from '../lib/growth.mjs'
import { openStore } from '../lib/store.mjs'

const T = Date.parse('2026-11-14T10:00:00Z')
const H = 3_600_000

test('聊天冷却可配置为逐条计分，但每日上限依然有效', () => {
  const s = createState(T)
  assert.equal(interact(s, 'chat', T).ok, true)
  assert.equal(interact(s, 'chat', T + 1000).ok, false)
  assert.equal(interact(s, 'chat', T + 30_000).ok, true)
  assert.equal(s.bond, 2)
  assert.equal(interact(s, 'chat', T + 31_000, { chatCooldownSeconds: 0, chatDailyLimit: 3 }).ok, true)
  assert.equal(interact(s, 'chat', T + 32_000, { chatCooldownSeconds: 0, chatDailyLimit: 3 }).ok, false)
  assert.equal(s.bond, 3)
})

test('奖励在北京时间零点更新', () => {
  const before = Date.parse('2026-11-14T15:59:59Z')
  const s = createState(before)
  const cfg = { chatDailyLimit: 1, chatCooldownSeconds: 0 }
  interact(s, 'chat', before, cfg)
  assert.equal(interact(s, 'chat', before + 500, cfg).ok, false)
  assert.equal(interact(s, 'chat', before + 1000, cfg).ok, true)
  assert.equal(s.day, '2026-11-15')
  assert.equal(dayOf(before), '2026-11-14')
  assert.equal(s.totals.chat, 2)
})

test('摸摸与玩耍分别冷却；精神不足或休息时不能刷玩耍', () => {
  const s = createState(T)
  assert.equal(interact(s, 'play', T).ok, true)
  assert.equal(interact(s, 'touch', T).ok, true)
  assert.equal(interact(s, 'play', T + 1000).ok, false)
  s.energy = 25
  assert.equal(interact(s, 'play', T + 11 * 60_000).ok, false)
  s.energy = 80
  interact(s, 'sleep', T + 12 * 60_000)
  assert.equal(interact(s, 'play', T + 13 * 60_000).ok, false)
  assert.equal(s.totals.play, 1)
})

test('休息按时间恢复，睡醒切换不凭空增加经验或精神', () => {
  const s = createState(T)
  s.energy = 30
  interact(s, 'sleep', T)
  interact(s, 'wake', T)
  assert.equal(s.energy, 30)
  assert.equal(s.xp, 0)
  interact(s, 'sleep', T)
  assert.equal(snapshot(s, T + 2 * H).energy, 54)
  interact(s, 'wake', T + 2 * H)
  assert.equal(s.energy, 54)
})

test('离线不扣亲密度；时间回拨不倒扣精神', () => {
  const s = createState(T)
  s.bond = 200
  const future = snapshot(s, T + 30 * 24 * H)
  assert.equal(future.bond, 200)
  assert.equal(future.energy, 20)
  assert.equal(snapshot(s, T - H).energy, 80)
})

test('实际投喂仅一次计分，自己吃、没吃进去、历史记录不计', () => {
  const s = createState(T)
  const records = [
    { at: T - 1000, food: '旧记录', source: '投喂', gain: 20 },
    { at: T + 1000, food: '米饭', source: '投喂', gain: 20, portion: '一份' },
    { at: T + 2000, food: '饼干', source: '自己吃', gain: 5 },
    { at: T + 3000, food: '米饭', source: '投喂', gain: 0 },
  ]
  assert.equal(syncFeed(s, records, T + 10_000), true)
  assert.equal(s.bond, 5)
  assert.equal(s.totals.feed, 1)
  assert.equal(syncFeed(s, records, T + 20_000), false)
  const loaded = loadState(JSON.parse(JSON.stringify(s)), T + H)
  syncFeed(loaded, records, T + H)
  assert.equal(loaded.bond, 5)
  assert.equal(JSON.stringify(loaded.seenFeed).includes('米饭'), false)
})

test('连续投喂受冷却及每日上限限制', () => {
  const s = createState(T)
  const times = [1, 2, 31, 62, 93, 124].map(min => T + min * 60_000)
  const records = times.map(at => ({ at, food: '饭', source: '投喂', gain: 20 }))
  syncFeed(s, records, T + 3 * H)
  assert.equal(s.totals.feed, 4)
  assert.equal(s.bond, 20)
})

test('等级与关系阶段按真实积累变化，满值不虚报增长', () => {
  const s = createState(T)
  s.xp = 25; s.bond = 100
  assert.equal(snapshot(s, T).level, 2)
  assert.equal(snapshot(s, T).stage, '亲近')
  s.bond = 999
  const r = interact(s, 'feed', T)
  assert.equal(s.bond, 1000)
  assert.match(r.message, /亲密度 \+1/)
})

test('只有整句互动短语触发，讨论或引用一段话不触发', () => {
  assert.equal(parseAction('陪你玩！'), 'play')
  assert.equal(parseAction('晚安～'), 'sleep')
  assert.equal(parseAction('我不想陪你玩'), null)
  assert.equal(parseAction('帮我写一个摸摸你的模块'), null)
})

test('原子存档可重开，坏存档不被自动重置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-store-'))
  try {
    const store = openStore(dir, T)
    interact(store.state, 'touch', T)
    store.save(store.state)
    assert.equal(openStore(dir, T + H).state.bond, 2)
    writeFileSync(join(dir, 'state.json'), '{损坏')
    assert.throws(() => openStore(dir, T + H))
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{损坏')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
