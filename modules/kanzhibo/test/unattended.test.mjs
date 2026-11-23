import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTick } from '../lib/tick.mjs'
import { createBadge } from '../lib/badge.mjs'
import { readFileSync } from 'node:fs'
import { GIFT_AUTO_ALLOWED } from '../lib/gift.mjs'
import { registerCommands } from '../lib/commands.mjs'
import { LIVE_RE } from '../lib/util.mjs'
import { plus100FromText as p100, taskProgressFromText as tp, BADGE_CHAT_RE as re } from '../lib/room/find.mjs'
import { BADGE_CONFIRM_TEXTS } from '../lib/room/specs.mjs'

const TODAY = '2026-01-07'

test('无人值守 soak：多房间同一天只各送一次（room map 生效）', async () => {
  const ctx = { cdp: {}, port: 1, viewport: null, quietUntil: 0, badgeDay: '', badgeUrl: '', badgeRooms: { day: TODAY, rooms: {} }, badgeGiveUpDay: '', badgeGiveUpRoom: '', badgeRejectStreak: 0, badgeAskDay: '', badgeAskRoom: '', badgeAttemptDay: '', badgeAttemptRoom: '', badgeReportDay: '', sayLog: { day: TODAY, items: [] }, lastSayAt: 0 }
  let room = 'https://live.douyin.com/1'
  let calls = 0
  const t = createTick({
    ctx, api: { settings: () => ({ enabled: true, schedule: false, renewBadge: true, liveCommentOn: false, semiAuto: false, badgeDelaySec: 0 }), config: () => ({ ownerQQ: '' }), sendText: async () => {} },
    note: () => {}, sleep: async () => {}, saveState: () => true, loadState: () => ({}), dayKey: () => TODAY,
    roomKeyOf: (u) => String(u || ''), LIVE_RE, currentUrl: async () => room,
    ensureBrowser: async () => {}, closeBrowser: async () => {}, livePort: async () => 1,
    ensureInRoom: async () => ({ ok: true, joined: true, url: room }), waitRoomReady: async () => true, endedSignals: async () => '', enterFromProfile: async () => {},
    sendComment: async () => ({ ok: true }), gate: { peek: () => null, state: () => null },
    badgeSent: async () => false,
    doBadge: async () => { calls++; ctx.badgeDay = TODAY; ctx.badgeUrl = room; ctx.badgeRooms = ctx.badgeRooms || { day: TODAY, rooms: {} }; ctx.badgeRooms.rooms[room] = Date.now(); return { ok: true, message: 'ok' } },
    badgeReject: () => {}, closeTaskPanel: async () => {}, notifyOwner: () => {}, dropPending: async () => {},
    journal: () => {}, cleanShots: () => {}, getBusy: () => false, setBusy: () => {}, inWindow: () => true, clampCheckSec: () => 120,
    giveUpRoomsDiffer: () => false, getCommentedDay: () => '', setCommentedDay: () => {}, setCommentedUrl: () => {},
  })
  for (const r of ['https://live.douyin.com/1', 'https://live.douyin.com/1', 'https://live.douyin.com/2', 'https://live.douyin.com/2', 'https://live.douyin.com/1', 'https://live.douyin.com/3', 'https://live.douyin.com/3']) { room = r; await t.tick(true) }
  assert.equal(calls, 3, '实际 calls=' + calls)
})

test('无人值守：commitBadge 自动成功会写 badgeDay + badgeRooms', async () => {
  const ctx = { badgeRooms: { day: '', rooms: {} } }
  const saved = []
  const b = createBadge({
    ctx, api: { settings: () => ({ semiAuto: false, badgeNickname: '' }) }, note: () => {}, sleep: async () => {},
    saveState: (p) => { saved.push(p); return true }, dayKey: () => TODAY, roomKeyOf: (u) => String(u || ''), currentUrl: async () => 'roomX',
    shot: async () => '', ensureViewport: async () => {}, closeTaskPanel: async () => {},
    clicker: { commit: async () => ({ ok: true }) },
    panelText: async () => '今日任务1/3 100 亲密度 +100', chatLines: async () => ({ lines: [] }),
    plus100FromText: p100, taskProgressFromText: tp, BADGE_CHAT_RE: re, EVIDENCE_WAIT_MS: 200,
    BADGE_CONFIRM_TEXTS,
  })
  const r = await b.commitBadge({ ok: true, channel: 'dom' }, 0, 0)
  assert.equal(r.ok, true)
  assert.equal(ctx.badgeDay, TODAY)
  assert.ok(ctx.badgeRooms.rooms.roomX, '应记录房间 roomX 已送')
  assert.ok(saved.some((p) => p.badgeRooms && p.badgeRooms.rooms.roomX))
})

test('无人值守：灯牌 强制 在未送时会真的重试一次并清 attempt', async () => {
  let run = null; let calls = 0
  const ctx = { cdp: {}, badgeDay: '', badgeAttemptDay: TODAY, badgeAttemptRoom: 'roomX', badgeGiveUpDay: '', badgeRejectStreak: 0 }
  const api = { command: (c) => { run = c.run }, settings: () => ({}), config: () => ({ ownerQQ: '1' }), core: { http: {} }, saveSettings: () => {} }
  registerCommands({
    api, statusLine: async () => '', selfCheck: async () => '', confirmPending: async () => '', cancelPending: async () => '', gate: { peek: () => null },
    doBadge: async () => { calls++; return { ok: true, message: 'ok' } }, enterNow: async () => ({}), sendComment: async () => ({}),
    stripQuotes: (x) => x, fromOwnerDm: () => true, SAY_MAX_CHARS: 50, sayWaitSec: () => 0, markSaySent: () => {}, pushSayLog: () => {},
    recentOps: () => [], fmtStep: () => '', opsEnabled: () => false, opsSessionTitle: '', withBusy: async (f) => f(), stopAll: async () => {}, closeBrowser: async () => {},
    ctx, saveState: () => true, dropPending: async () => {}, tick: async () => ({}), getBusy: () => false, setBusy: () => {},
    dayKey: () => TODAY, roomKeyOf: (u) => u, journal: () => {}, currentUrl: async () => 'roomX', isLiveTarget: () => true, badgeSent: async () => false,
  })
  const r = await run('灯牌 强制', { chatId: 'private:1' })
  assert.equal(calls, 1)
  assert.equal(ctx.badgeAttemptDay, '')
  assert.match(String(r), /ok|已经/)
})


test('无人值守：送礼永远不允许自动（GIFT_AUTO_ALLOWED=false）', () => {
  assert.equal(GIFT_AUTO_ALLOWED, false)
  const src = readFileSync(new URL('../lib/gift.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(!GIFT_AUTO_ALLOWED \|\| api\.settings\(\)\.semiAuto\)/)
})
