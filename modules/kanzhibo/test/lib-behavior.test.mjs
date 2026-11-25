import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveRoomId, roomKeyOf, isLiveTarget } from '../lib/util.mjs'
import { createWorklog } from '../lib/worklog.mjs'
import { createSay } from '../lib/say.mjs'

test('util：直播间地址识别与 roomKey', () => {
  assert.equal(liveRoomId('https://live.douyin.com/123456789'), '123456789')
  assert.equal(liveRoomId('https://www.douyin.com/follow/live/987654?anchor_id=1'), '987654')
  assert.equal(liveRoomId('https://www.douyin.com/user/abc'), '')
  assert.equal(roomKeyOf('https://live.douyin.com/123'), '123')
  assert.equal(isLiveTarget('123456'), true)
  assert.equal(isLiveTarget('https://www.douyin.com/user/x'), false)
})

test('worklog：真写 jsonl、内存计数、失败标记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-wl-'))
  const day = '2026-01-02'
  const wl = createWorklog({ dataDir: () => dir, dayKey: () => day })
  wl.journal('第一步', '细节')
  wl.journal('第二步', '', false)
  assert.equal(wl.count, 2)
  const items = wl.recentOps(10)
  assert.equal(items.length, 2)
  assert.equal(items[1].ok, false)
  const raw = readFileSync(join(dir, 'worklog', day + '.jsonl'), 'utf8').trim().split('\n')
  assert.equal(raw.length, 2)
  assert.equal(JSON.parse(raw[0]).step, '第一步')
  rmSync(dir, { recursive: true, force: true })
})

test('say：冷却、落盘、日志、引号、主人私聊判定（纯行为）', () => {
  const ctx = { lastSayAt: 0, sayLog: { day: '2026-01-02', items: [] } }
  const saved = {}
  const say = createSay({ ctx, saveState: (p) => Object.assign(saved, p), dayKey: () => '2026-01-02', ownerChat: () => 'private:10001' })
  assert.equal(say.stripQuotes('「你好」'), '你好')
  assert.equal(say.sayWaitSec(), 0)
  say.markSaySent()
  assert.ok(ctx.lastSayAt > 0)
  assert.ok(saved.lastSayAt > 0)
  assert.ok(say.sayWaitSec() > 0)
  say.pushSayLog('hello')
  assert.equal(ctx.sayLog.items.length, 1)
  assert.equal(saved.sayLog.items[0].text, 'hello')
  assert.equal(say.fromOwnerDm({ chatId: 'private:10001' }), true)
  assert.equal(say.fromOwnerDm({ chatId: 'group:888' }), false)
})
