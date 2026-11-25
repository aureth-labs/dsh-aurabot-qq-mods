import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBadge } from '../lib/badge.mjs'
import { plus100FromText, taskProgressFromText, BADGE_CHAT_RE } from '../lib/room/find.mjs'
import { BADGE_CONFIRM_TEXTS } from '../lib/room/specs.mjs'

// B4 回归：Lynx 面板读不到 +100 时，只有「今日任务 X/3」进度上涨，不能判成功。
test('badgeEvidence：只有进度上涨、无 +100/播报 → 不算成功', async () => {
  const badge = createBadge({
    chatLines: async () => ({ lines: [] }),
    panelText: async () => '今日任务1/3',
    plus100FromText,
    taskProgressFromText,
    BADGE_CHAT_RE,
    sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
    EVIDENCE_WAIT_MS: 80,
    BADGE_CONFIRM_TEXTS,
  })
  const ev = await badge.badgeEvidence(0, 0, '')
  assert.equal(ev.ok, false)
})

test('badgeEvidence：面板出现 +100 → 成功', async () => {
  const badge = createBadge({
    chatLines: async () => ({ lines: [] }),
    panelText: async () => '今日任务1/3 100 亲密度 +100',
    plus100FromText,
    taskProgressFromText,
    BADGE_CHAT_RE,
    sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
    EVIDENCE_WAIT_MS: 200,
    BADGE_CONFIRM_TEXTS,
  })
  const ev = await badge.badgeEvidence(0, 0, '')
  assert.equal(ev.ok, true)
  assert.match(String(ev.how), /\+100/)
})
