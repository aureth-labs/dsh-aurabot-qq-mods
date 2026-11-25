import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGift } from '../lib/gift.mjs'
import { createTick } from '../lib/tick.mjs'
import { createBadge } from '../lib/badge.mjs'
import { registerCommands } from '../lib/commands.mjs'
import { LIVE_RE } from '../lib/util.mjs'

function giftDeps(over = {}) {
  const ctx = { giftAttemptDay: '', giftAttemptRoom: '', giftAttemptName: '' }
  const state = { saved: {}, clicked: false }
  const deps = {
    ctx,
    api: { settings: () => ({ giftByDm: true }) },
    note: () => {}, sleep: async () => {},
    saveState: (p) => { Object.assign(state.saved, p); return true },
    dayKey: () => '2026-01-03', roomKeyOf: (u) => u, currentUrl: async () => 'https://live.douyin.com/1',
    evalJs: async () => null, pageText: async () => '赠送成功',
    clicker: { commit: async () => { state.clicked = true; return { ok: true } } },
    askOwner: async () => ({}), journal: () => {},
    GIFT_CELL_SPEC: () => '', GIFT_CONFIRM_SPEC: {}, LIVE_RE,
    ensureViewport: async () => {}, clickBy: async () => {}, gate: { peek: () => null },
    readBalance: async () => 100,
    ...over,
  }
  return { deps, state, ctx }
}

test('送礼 commitGift：确认成功后清 attempt', async () => {
  const { deps, state } = giftDeps()
  const g = createGift(deps)
  const r = await g.commitGift({ ok: true }, '小心心', 100, true)
  assert.equal(r.ok, true)
  assert.equal(state.clicked, true)
  assert.equal(state.saved.giftAttemptDay, '')
})

test('送礼 commitGift：状态写盘失败 → 不点击', async () => {
  const { deps, state } = giftDeps({ saveState: () => false })
  const g = createGift(deps)
  const r = await g.commitGift({ ok: true }, '小心心', 100, true)
  assert.equal(r.ok, false)
  assert.match(String(r.message), /写盘失败/)
  assert.equal(state.clicked, false)
})

test('tick dailyReport：发出一条日报（含标题）', async () => {
  const sent = []
  const t = createTick({
    ctx: { sayLog: { day: '2026-01-03', items: [] }, badgeDay: '', badgeGiveUpDay: '' },
    api: {
      settings: () => ({ renewBadge: true, liveCommentOn: false }),
      config: () => ({ ownerQQ: '10001' }),
      sendText: async (chat, text) => { sent.push({ chat, text }) },
    },
    dayKey: () => '2026-01-03', loadState: () => ({}), saveState: () => true,
    getCommentedDay: () => '', sleep: async () => {}, note: () => {},
  })
  await t.dailyReport('日报')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chat, 'private:10001')
  assert.match(sent[0].text, /看直播日报/)
})


test('灯牌强制：判定今天已送 → 拒绝强制，不调用 doBadge', async () => {
  let run = null; let doCalls = 0
  const api = { command: (c) => { run = c.run }, settings: () => ({}), config: () => ({ ownerQQ: '1' }), core: { http: {} }, saveSettings: () => {} }
  registerCommands({
    api, statusLine: async () => '', selfCheck: async () => '', confirmPending: async () => '', cancelPending: async () => '',
    gate: { peek: () => null }, doBadge: async () => { doCalls++; return { ok: true } }, enterNow: async () => ({}),
    sendComment: async () => ({}), stripQuotes: (x) => x, fromOwnerDm: () => true, SAY_MAX_CHARS: 50, sayWaitSec: () => 0,
    markSaySent: () => {}, pushSayLog: () => {}, recentOps: () => [], fmtStep: () => '', opsEnabled: () => false, opsSessionTitle: '',
    withBusy: async (f) => f(), stopAll: async () => {}, closeBrowser: async () => {},
    ctx: { cdp: {}, badgeAttemptDay: '2026-01-05', badgeAttemptRoom: 'https://live.douyin.com/1', badgeDay: '' },
    saveState: () => true, dropPending: async () => {}, tick: async () => ({}), getBusy: () => false, setBusy: () => {},
    dayKey: () => '2026-01-05', roomKeyOf: (u) => u, journal: () => {}, currentUrl: async () => 'https://live.douyin.com/1',
    isLiveTarget: () => true, badgeSent: async () => true,
  })
  const r = await run('灯牌 强制', { chatId: 'private:1' })
  assert.match(String(r), /不允许强制重点/)
  assert.equal(doCalls, 0)
})

test('commitBadge：状态写盘失败 → 不点击', async () => {
  let clicked = false
  const badge = createBadge({
    ctx: {}, api: { settings: () => ({ semiAuto: false }) }, note: () => {}, sleep: async () => {},
    saveState: () => false, dayKey: () => '2026-01-05', roomKeyOf: (u) => u, currentUrl: async () => '',
    shot: async () => '', ensureViewport: async () => {},
    clicker: { commit: async () => { clicked = true; return { ok: true } } },
    BADGE_CONFIRM_TEXTS: [],
  })
  const r = await badge.commitBadge({ ok: true, channel: 'dom' }, 0, 0)
  assert.equal(r.ok, false)
  assert.match(String(r.message), /写盘失败/)
  assert.equal(clicked, false)
})
