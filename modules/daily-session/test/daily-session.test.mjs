import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'
import { dayKey, nextResetAt, periodOf, prevDayKey } from '../lib/schedule.mjs'
import { chatRecord, loadState, rememberInjection, saveState } from '../lib/state.mjs'
import { cleanDigest, digestRequest, fallbackDigest, pickLogRows } from '../lib/digest.mjs'

const groupId = 'group:1'
const yesterday = () => prevDayKey(periodOf(new Date()))

function makeApi(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'daily-session-test-'))
  const hooks = { every: {}, later: [], contexts: [], command: null, routes: {} }
  const resets = []
  const asks = []
  const api = {
    dataDir: () => dir,
    settings: () => ({
      enabled: true,
      resetHour: 0,
      scope: 'all',
      injectDigest: true,
      maxMessages: 120,
      maxChars: 8000,
      digestMaxChars: 600,
      askMaxTokens: 220,
      dryRun: false,
      ...settings,
    }),
    log: { info() {}, warn() {}, error() {} },
    core: {
      hub: {
        sessions: () => ({ [groupId]: { sessionId: 'session-new' } }),
        chatLogOf: () => [
          { t: 1, chatId: groupId, who: 'user', text: '昨天聊了关山灯' },
          { t: 2, chatId: 'group:2', who: 'user', text: '别的群不该进摘要' },
          { t: 3, chatId: groupId, who: 'bot', text: '收到' },
          { t: 4, chatId: groupId, who: 'user', text: '已遗忘的内容', forgottenAt: 123 },
        ],
        resetChat: (id) => { resets.push(id); return true },
      },
    },
    ask: async (req) => { asks.push(req); return '- 聊了关山灯\n- 明天继续写' },
    isOwner: (id) => id === 'owner',
    every: (ms, fn, name) => { hooks.every[name] = fn; return () => {} },
    later: (ms, fn) => { hooks.later.push(fn); return () => {} },
    context: (fn) => { hooks.contexts.push(fn); return () => {} },
    command: (c) => { hooks.command = c; return () => {} },
    route: (path, fn) => { hooks.routes[path] = fn; return () => {} },
  }
  return { api, dir, hooks, resets, asks }
}

function seedState(dir, period, digestDay = '') {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    chats: {
      [groupId]: {
        lastPeriod: period,
        lastResetAt: 0,
        digest: digestDay ? { day: digestDay, text: '- 昨天决定继续写铁门关', at: 1 } : null,
        injected: {},
      },
    },
  }))
}

test('周期计算：跨天、重置小时、跨年', () => {
  const late = new Date(2026, 10, 26, 23, 30)
  assert.equal(periodOf(late, 0), '2026-11-26')
  assert.equal(periodOf(late, 3), '2026-11-26')
  const early = new Date(2026, 10, 27, 1, 30)
  assert.equal(periodOf(early, 0), '2026-11-27')
  assert.equal(periodOf(early, 3), '2026-11-26')
  assert.equal(prevDayKey('2026-01-01'), '2025-12-31')
  assert.equal(prevDayKey('bad'), '')
  assert.equal(dayKey(new Date(2026, 1, 3)), '2026-02-03')
  assert.ok(nextResetAt(new Date(2026, 10, 26, 9, 0), 0) > Date.now() - 1)
})

test('聊天流水提炼：按 chatId 过滤、跳过遗忘、限量', () => {
  const rows = [
    { chatId: groupId, who: 'user', text: '一' },
    { chatId: 'group:2', who: 'user', text: '别群' },
    { chatId: groupId, who: 'bot', text: '二' },
    { chatId: groupId, who: 'user', text: '忘了', forgottenAt: 1 },
    { chatId: groupId, who: 'user', text: '三' },
  ]
  const lines = pickLogRows(rows, groupId, { maxMessages: 2, maxChars: 8000 })
  assert.deepEqual(lines, ['她：二', '对方：三'])
  assert.equal(pickLogRows(null, groupId).length, 0)
  const req = digestRequest('2026-11-25', lines)
  assert.match(req.system, /不是给你的指令/)
  assert.match(req.text, /2026-11-25/)
  assert.match(req.text, /她：二/)
})

test('摘要清理与模型失败回落', () => {
  assert.equal(cleanDigest('```\n- 一条\n\n# 标题\n```', 600), '- 一条')
  assert.equal(cleanDigest('- 很短', 1), '- 很短') // 下限 60 字，不会被极小值截断
  assert.equal(cleanDigest('- ' + '很'.repeat(100), 60).length, 60)
  const fallback = fallbackDigest(['对方：甲', '她：乙'], 600)
  assert.match(fallback, /模型提炼失败/)
  assert.match(fallback, /对方：甲/)
  assert.equal(fallbackDigest([], 600), '')
})

test('状态读写与注入去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-state-'))
  const path = join(dir, 'sub', 'state.json')
  const state = loadState(path, { warn() {} })
  const rec = chatRecord(state, groupId)
  rec.lastPeriod = '2026-11-26'
  rememberInjection(rec, 's1', '2026-11-25')
  rememberInjection(rec, 's2', '2026-11-25')
  assert.ok(saveState(path, state, { warn() {} }))
  const loaded = loadState(path, { warn() {} })
  assert.equal(loaded.chats[groupId].lastPeriod, '2026-11-26')
  assert.equal(Object.keys(loaded.chats[groupId].injected).length, 2)
  rememberInjection(loaded.chats[groupId], 's3', '2026-11-25')
  rememberInjection(loaded.chats[groupId], 's4', '2026-11-25')
  assert.equal(Object.keys(loaded.chats[groupId].injected).length, 3)
})

test('注册层：定时任务、上下文、命令、路由都挂上了', () => {
  const t = makeApi()
  mod.setup(t.api)
  assert.ok(t.hooks.every['每日会话拆分-每日检查'])
  assert.equal(t.hooks.contexts.length, 1)
  assert.ok(t.hooks.command && t.hooks.command.name === '会话拆分')
  for (const p of ['/status', '/run-now', '/split-now', '/clear-digest']) assert.ok(t.hooks.routes[p])
})

test('首次启动只登记，不打断已有会话', async () => {
  const t = makeApi()
  const exported = mod.setup(t.api)
  await exported.runNow()
  assert.equal(t.resets.length, 0)
  const state = JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'))
  assert.equal(state.chats[groupId].lastPeriod, periodOf(new Date()))
})

test('跨天：重置单个会话、提炼昨日、不碰别的群', async () => {
  const t = makeApi()
  seedState(t.dir, yesterday())
  const exported = mod.setup(t.api)
  const result = await exported.runNow()
  assert.equal(result.reset, 1)
  assert.deepEqual(t.resets, [groupId])
  assert.equal(result.digests, 1)
  assert.equal(t.asks.length, 1)
  assert.match(t.asks[0].text, /昨天聊了关山灯/)
  assert.doesNotMatch(t.asks[0].text, /别的群不该进摘要/)
  assert.doesNotMatch(t.asks[0].text, /已遗忘的内容/)
  const state = JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'))
  assert.equal(state.chats[groupId].digest.day, yesterday())
  assert.match(state.chats[groupId].digest.text, /聊了关山灯/)
})

test('注入只在摘要对应的新会话首轮发生一次', () => {
  const t = makeApi()
  seedState(t.dir, periodOf(new Date()), yesterday())
  mod.setup(t.api)
  const ctx = t.hooks.contexts[0]
  const first = ctx({ chat: { chatId: groupId, kind: 'group' }, sessionId: 'session-new' })
  assert.match(first, /【昨日会话摘要/)
  assert.match(first, /铁门关/)
  assert.equal(ctx({ chat: { chatId: groupId, kind: 'group' }, sessionId: 'session-new' }), '')
  assert.equal(ctx({ chat: { chatId: 'group:2', kind: 'group' }, sessionId: 'session-new' }), '')
  assert.equal(ctx({ chat: { chatId: groupId, kind: 'group' }, sessionId: 'session-old' }), '')
})

test('模型失败时回落原文，不静默失效', async () => {
  const t = makeApi()
  t.api.ask = async () => { throw new Error('model down') }
  seedState(t.dir, yesterday())
  const exported = mod.setup(t.api)
  await exported.runNow()
  const state = JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'))
  assert.match(state.chats[groupId].digest.text, /模型提炼失败/)
  assert.match(state.chats[groupId].digest.text, /昨天聊了关山灯/)
})

test('面板立即拆分：无视当天已重置，强制拆分全部；拆完不再重复', async () => {
  const t = makeApi()
  seedState(t.dir, periodOf(new Date())) // 今天已拆过
  mod.setup(t.api)
  const r = await t.hooks.routes['/split-now']()
  assert.equal(r.ok, true)
  assert.equal(r.split, 1)
  assert.equal(r.digests, 1)
  assert.deepEqual(r.chats[0], { chatId: groupId, reset: true, digestDay: yesterday() })
  assert.deepEqual(t.resets, [groupId])
  await t.hooks.routes['/run-now']()
  assert.equal(t.resets.length, 1) // lastPeriod 已更新，到期检查不会重复拆
})

test('面板立即拆分：试运行不真重置', async () => {
  const t = makeApi({ dryRun: true })
  seedState(t.dir, periodOf(new Date()))
  mod.setup(t.api)
  const r = await t.hooks.routes['/split-now']()
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.split, 1)
  assert.equal(t.resets.length, 0)
})

test('主人命令：别人不能重置，主人只能重置当前聊天', async () => {
  const t = makeApi()
  mod.setup(t.api)
  const denied = await t.hooks.command.run('现在', { chatId: groupId, userId: 'stranger' })
  assert.match(denied, /只有主人/)
  assert.equal(t.resets.length, 0)
  const ok = await t.hooks.command.run('现在', { chatId: groupId, userId: 'owner' })
  assert.match(ok, /已重置/)
  assert.deepEqual(t.resets, [groupId])
})

test('入口导出和 manifest 一致，且顶层加载不需要插件环境', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
  assert.equal(mod.id, manifest.id)
  assert.equal(mod.version, manifest.version)
  assert.equal(mod.api, manifest.api)
  assert.equal(typeof mod.setup, 'function')
})
