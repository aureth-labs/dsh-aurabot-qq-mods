import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTick } from '../lib/tick.mjs'
import { LIVE_RE } from '../lib/util.mjs'

const TODAY = '2026-01-04'
function makeTick({ sent = false, doResult = { ok: true, message: 'ok', evidence: '+100' } } = {}) {
  const rec = { saved: [], journal: [], notify: [], sentText: [], doBadgeCalls: 0, reject: [] }
  const settings = { enabled: true, schedule: false, renewBadge: true, liveCommentOn: false, semiAuto: false, minuteReport: false, badgeDelaySec: 0, target: 'https://live.douyin.com/1' }
  const ctx = {
    cdp: {}, port: 1, viewport: null, quietUntil: 0,
    badgeDay: '', badgeUrl: '', badgeGiveUpDay: '', badgeGiveUpRoom: '', badgeRejectDay: '', badgeRejectStreak: 0,
    badgeAskDay: '', badgeAskRoom: '', badgeAttemptDay: '', badgeAttemptRoom: '', badgeReportDay: '',
    sayLog: { day: TODAY, items: [] }, lastSayAt: 0, giftAttemptDay: '', giftAttemptRoom: '', giftAttemptName: '',
  }
  const t = createTick({
    ctx,
    api: {
      settings: () => settings,
      config: () => ({ ownerQQ: '10001' }),
      sendText: async (chat, text) => { rec.sentText.push({ chat, text }) },
    },
    note: () => {}, sleep: async () => {},
    saveState: (p) => { rec.saved.push(p); Object.assign(ctx, p); return true },
    loadState: () => ({}), dayKey: () => TODAY,
    roomKeyOf: (u) => String(u || ''),
    LIVE_RE, currentUrl: async () => 'https://live.douyin.com/1',
    ensureBrowser: async () => {}, closeBrowser: async () => {}, livePort: async () => 1,
    ensureInRoom: async () => ({ ok: true, joined: true, url: 'https://live.douyin.com/1' }),
    waitRoomReady: async () => true, endedSignals: async () => '', enterFromProfile: async () => {},
    sendComment: async () => ({ ok: true }),
    gate: { peek: () => null, state: () => null },
    badgeSent: async () => sent,
    doBadge: async () => { rec.doBadgeCalls++; return doResult },
    badgeReject: (why) => rec.reject.push(why),
    closeTaskPanel: async () => {}, notifyOwner: (t2) => rec.notify.push(t2), dropPending: async () => {},
    journal: (step, detail, ok) => rec.journal.push({ step, detail, ok }),
    cleanShots: () => {},
    getBusy: () => false, setBusy: () => {},
    inWindow: () => true, clampCheckSec: () => 120,
    giveUpRoomsDiffer: () => false,
    getCommentedDay: () => '', setCommentedDay: () => {}, setCommentedUrl: () => {},
  })
  return { t, rec, ctx }
}

test('tick：自动送灯牌成功 → 记 badgeDay + 落日志', async () => {
  const { t, rec, ctx } = makeTick({ sent: false })
  const r = await t.tick(true)
  assert.equal(r.ok, true)
  assert.equal(rec.doBadgeCalls, 1)
  assert.equal(ctx.badgeDay, TODAY)
  assert.ok(rec.journal.some((j) => /灯牌已送过|续灯牌/.test(j.step)))
})

test('tick：判定今天已送 → 不再调用 doBadge，直接记已送', async () => {
  const { t, rec, ctx } = makeTick({ sent: true })
  const r = await t.tick(true)
  assert.equal(r.ok, true)
  assert.equal(rec.doBadgeCalls, 0)
  assert.equal(ctx.badgeDay, TODAY)
  assert.ok(rec.journal.some((j) => j.step === '灯牌已送过'))
})
