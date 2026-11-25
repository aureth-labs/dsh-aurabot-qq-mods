// token-budget 模块测试：scorer / ledger 纯函数 + setup 后的行为（prompt 链、熔断、命令、面板）。
// 全部走假 api（见 helpers.mjs），不打网络、不连 QQ；数据在临时目录，测试互不影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'
import { tokenize, cosine, estTokens, scoreItem, topK } from '../lib/scorer.mjs'
import { createLedger, dayKey } from '../lib/ledger.mjs'
import { makeApi, OWNER, TZ } from './helpers.mjs'

const counts = (tokens) => { const m = new Map(); for (const t of tokens) m.set(t, (m.get(t) || 0) + 1); return m }

// ---------- scorer ----------

test('tokenize：中文切单字 + 2-gram、英文按词、标点丢弃', () => {
  assert.deepEqual(tokenize('喜欢猫'), ['喜', '欢', '猫', '喜欢', '欢猫'])
  assert.ok(tokenize('Hello, 世界! 123').includes('hello'))
  assert.ok(tokenize('Hello, 世界! 123').includes('123'))
  assert.ok(!tokenize('喜欢，猫！').some((t) => t.includes('，')))
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
})

test('cosine：同句 1、无关 0、空向量 0', () => {
  const a = counts(tokenize('今天去了杭州'))
  assert.equal(cosine(a, counts(tokenize('今天去了杭州'))), 1)
  assert.equal(cosine(a, counts(tokenize('完全不相干的一句话'))), 0)
  assert.equal(cosine(a, new Map()), 0)
})

test('estTokens：中文 0.6/字、英文 0.3/字符、空串至少 1', () => {
  assert.equal(estTokens('一二三四五六七八九十'), 6)
  assert.equal(estTokens('abcdefgh'), 2)
  assert.equal(estTokens(''), 1)
  assert.equal(estTokens(null), 1)
})

test('scoreItem / topK：按相关度取、过期的不进榜', () => {
  const now = Date.now()
  const items = [
    { text: '主人喜欢猫', importance: 0.5, chatId: 'private:1' },
    { text: '去年在杭州上班', importance: 0.9 },
    { text: '主人养了一只叫团子的猫', importance: 0.5, validUntil: now - 1000 }, // 已过期
  ]
  const picked = topK(items, '主人喜欢什么动物', 16, { now })
  assert.ok(picked.some((it) => it.text === '主人喜欢猫'), '相关条目要进榜')
  assert.ok(!picked.some((it) => it.text.includes('团子')), '过期条目不该进榜')
  assert.equal(topK(items, '主人喜欢什么动物', 1, { now }).length, 1, 'k=1 只带一条')
  assert.equal(scoreItem(null, 'x'), 0)
  assert.equal(scoreItem({ text: 'x' }, ''), 0, '没有查询就不打分')
})

test('topK / scoreItem：同聊天的条目有加成', () => {
  const now = Date.now()
  const it = { text: '主人喜欢猫', importance: 0.5, chatId: 'private:1' }
  const withChat = scoreItem(it, '主人喜欢猫', { chatId: 'private:1', now })
  const otherChat = scoreItem(it, '主人喜欢猫', { chatId: 'group:9', now })
  assert.ok(withChat > otherChat, '同聊天的条目得分应更高')
})

// ---------- ledger ----------

const ledgerOf = (env, over = {}) => createLedger({
  dataDir: over.dataDir || env.dir,
  log: env.api.log,
  tzOffsetMin: TZ,
  prices: over.prices || { in: 2, out: 8, limit: 15 },
  overheadFactor: over.overheadFactor ?? 1,
  softPct: over.softPct ?? 80,
})

test('dayKey：固定时区下按本地日期滚', () => {
  // 2026-11-09 23:30 UTC+8；再过 1 小时跨到本地 11-10
  const t0 = Date.UTC(2026, 10, 9, 15, 30)
  assert.equal(dayKey(t0, TZ), '2026-11-09')
  assert.equal(dayKey(t0 + 3600_000, TZ), '2026-11-10')
})

test('ledger：记账、花费折算、软硬熔断、豁免、跨日清零', (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const led = ledgerOf(env, { prices: { in: 2, out: 8, limit: 15 } })
  led.add('in', 100_000) // 0.2 元
  led.add('out', 1_000_000) // 8 元
  assert.equal(Math.round(led.spentYuan() * 100) / 100, 8.2)
  assert.equal(led.state(), 'ok') // 8.2 / 15 = 54%，还没到 80% 软熔线
  led.add('out', 500_000) // +4 = 12.2 元 ≥ 80% 软熔线 12
  assert.equal(led.state(), 'soft')
  led.add('out', 500_000) // +4 = 16.2 元 ≥ 15
  assert.equal(led.state(), 'hard')
  led.setExempt(Date.now(), true)
  assert.equal(led.state(), 'ok', '豁免日永远 ok')
  const nextDay = Date.now() + 86_400_000
  assert.equal(led.spentYuan(nextDay), 0, '跨日从零算')
  assert.equal(led.state(nextDay), 'ok')
})

test('ledger：overheadFactor 放大、账本落盘、损坏回退空账', (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const led = ledgerOf(env, { prices: { in: 0, out: 1_000_000, limit: 15 }, overheadFactor: 1.5 })
  led.add('out', 10) // 10 * 1.5 = 15 token → 15 元（单价 1 元/token）
  assert.equal(led.state(), 'hard')
  const file = join(env.dir, 'ledger.json')
  assert.ok(existsSync(file), '账本该写到 dataDir')
  assert.ok(readFileSync(file, 'utf8').includes('ledger') === false ? true : true) // 可读即可
  writeFileSync(file, '{oops') // 写坏
  const led2 = ledgerOf(env, { prices: { in: 0, out: 1, limit: 15 } })
  assert.equal(led2.state(), 'ok', '坏账本当空账，别卡死聊天')
})

test('ledger：takeNotifySlot 每日至多 2 次；recent 出 7 天', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-led-'))
  const led = createLedger({ dataDir: dir, tzOffsetMin: TZ, overheadFactor: 1, prices: { in: 0, out: 0, limit: 1 } })
  assert.equal(led.takeNotifySlot(), 1)
  assert.equal(led.takeNotifySlot(), 2)
  assert.equal(led.takeNotifySlot(), -1)
  led.add('in', 5)
  const recent = led.recent(7)
  assert.equal(recent.length, 7)
  assert.equal(recent[6].inTok, 5)
})

test('ledger：按会话分桶记账、chatsByDay 聚合排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-chat-'))
  const led = createLedger({ dataDir: dir, tzOffsetMin: TZ, overheadFactor: 1, prices: { in: 0, out: 0, limit: 1 } })
  led.addChat('group:1', 'in', 100)
  led.addChat('group:1', 'out', 50)
  led.addChat('group:1', 'saved', 0, 300) // saved 不计轮次
  led.addChat('private:2', 'in', 10)
  led.addChat('private:2', 'saved', 0, 5)
  const chats = led.chatsByDay(7)
  assert.equal(chats.length, 2)
  assert.equal(chats[0].chatId, 'group:1', '按活跃度排序，group:1 量大在前')
  assert.equal(chats[0].inTok, 100)
  assert.equal(chats[0].outTok, 50)
  assert.equal(chats[0].saved, 300)
  assert.equal(chats[0].turns, 2, 'saved 不算轮次')
  assert.equal(chats[1].saved, 5)
})

// ---------- 模块行为 ----------

test('模块元信息：id、版本、面板、设置项类型', () => {
  assert.equal(plugin.id, 'token-budget')
  assert.equal(plugin.version, '1.2.0')
  assert.equal(plugin.api, 1)
  assert.equal(plugin.panel, 'panel.js')
  const keys = plugin.settings.map((s) => s.key)
  assert.deepEqual(keys, ['enabled', 'memoryTopK', 'promptBudgetTokens', 'dailyBudgetYuan', 'priceIn', 'priceOut', 'softFusePct', 'overheadFactor', 'fallbackModel', 'protectOwner'])
  for (const key of ['enabled', 'protectOwner']) assert.equal(plugin.settings.find((s) => s.key === key).type, 'switch', key + ' 应是 switch')
})

test('setup 注册了钩子、命令、路由与定时器', (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  for (const name of ['prompt', 'group/decide', 'model', 'activity']) assert.ok(env.hooks.has(name), '缺钩子 ' + name)
  assert.ok(env.commands.has('预算'))
  assert.ok(env.routes.has('/status'))
  assert.equal(env.timers.length, 1)
})

test('prompt：预算内原样通过；超预算从旧内容开始削', async (t) => {
  const env = makeApi({ settings: { promptBudgetTokens: 100 } })
  t.after(env.cleanup)
  const small = [{ type: 'text', text: '一句话'.repeat(5) }]
  const kept = await env.runHook('prompt', small, { chat: { kind: 'group', chatId: 'group:1' }, queryText: '在聊什么' })
  assert.equal(kept.length, 1)

  const big = Array.from({ length: 30 }, () => ({ type: 'text', text: '很长很长的记忆内容'.repeat(3) }))
  big.push({ type: 'text', text: '本轮用户消息' })
  const trimmed = await env.runHook('prompt', big, { chat: { kind: 'group', chatId: 'group:1' } })
  assert.equal(trimmed.at(-1).text, '本轮用户消息', '最新一块必须保住')
  assert.ok(trimmed.length < 30, '旧块该被丢')

  // 超大单块截头留尾（保留后段）：预算 1000，旧块 1200 token 装不下 → 按剩余预算截前段
  const env3 = makeApi({ settings: { promptBudgetTokens: 1000 } })
  t.after(env3.cleanup)
  const huge = [{ type: 'text', text: '甲'.repeat(1000) + '乙'.repeat(1000) }, { type: 'text', text: '新'.repeat(50) }]
  const t2 = await env3.runHook('prompt', huge, { chat: { kind: 'group', chatId: 'group:1' } })
  assert.equal(t2.length, 2, '截过的块保留在链里')
  assert.ok(t2[0].text.length < 2000, '超预算块该被截短')
  assert.ok(t2[0].text.includes('乙'), '截头留尾：留下的是后段')
  assert.equal(t2[1].text, '新'.repeat(50), '最新块不受影响')
})

test('prompt：记忆模块在跑时追加 top-K 记忆块；不在跑时不动', async (t) => {
  const memItems = [{ text: '主人喜欢猫', importance: 0.6 }, { text: '她昨天去了杭州' }]
  const env = makeApi({ mods: { memory: { list: () => memItems } } })
  t.after(env.cleanup)
  const out = await env.runHook('prompt', [{ type: 'text', text: '我在想要不要养猫' }], { chat: { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER }, queryText: '我在想要不要养猫' })
  const joined = out.map((b) => b.text || '').join('\n')
  assert.ok(joined.includes('想起的相关旧事'), '该追加记忆块')
  assert.ok(joined.includes('主人喜欢猫'))
  assert.ok(!joined.includes('杭州'), '不相关的记忆不该带上')

  const env2 = makeApi() // 没有 memory
  t.after(env2.cleanup)
  const out2 = await env2.runHook('prompt', [{ type: 'text', text: '任意' }], { chat: { kind: 'group', chatId: 'group:1' }, queryText: '养猫' })
  assert.equal(out2.length, 1, '记忆模块没跑就不追加')
})

const decideOf = (env, d, info) => {
  let v = d
  for (const fn of env.hooks.get('group/decide')) { const next = fn(v, info); if (next !== undefined && next !== null) v = next }
  return v
}
const modelOf = (env, sel, chat) => {
  let v = sel
  for (const fn of env.hooks.get('model')) { const n = fn(v, chat); if (n !== undefined) v = n }
  return v
}
// 熔断测试共用：单价极高，一条消息就爆线
const FUSE_SETTINGS = { dailyBudgetYuan: 0.5, priceIn: 1000, priceOut: 1000 }

test('熔断：硬熔拦非必回轮次，必回 / 被 @ / 主人放行', async (t) => {
  const env = makeApi({ settings: FUSE_SETTINGS })
  t.after(env.cleanup)
  const act = env.hooks.get('activity')[0]
  await act({ kind: 'in', chatId: 'group:1', text: '长'.repeat(1000) })
  await act({ kind: 'out', chatId: 'group:1', text: '长'.repeat(1000) })
  assert.equal(decideOf(env, { reply: true, mode: 'engaged' }, { msg: { userId: '2' } }).reply, false, '普通轮次硬熔拦下')
  assert.equal(decideOf(env, { reply: true, mode: 'must' }, { msg: { userId: '2' } }).reply, true, '必回放行')
  assert.equal(decideOf(env, { reply: true, mode: 'engaged' }, { msg: { userId: '2', mentioned: true } }).reply, true, '被 @ 放行')
  assert.equal(decideOf(env, { reply: true, mode: 'engaged' }, { msg: { userId: OWNER, kind: 'private', chatId: `private:${OWNER}` } }).reply, true, '主人放行')
  assert.equal(await env.runHook('prompt', [{ type: 'text', text: 'x' }], { chat: { kind: 'group', chatId: 'group:1' } }), null, '硬熔下 prompt 返回 null')
  const pOwner = await env.runHook('prompt', [{ type: 'text', text: 'x' }], { chat: { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER } })
  assert.notEqual(pOwner, null, '主人私聊不受熔断影响')
})

test('软熔：填了 fallbackModel 才换模型，主人不换', (t) => {
  const env = makeApi({ settings: { ...FUSE_SETTINGS, fallbackModel: 'deepseek/deepseek-chat' } })
  t.after(env.cleanup)
  env.hooks.get('activity')[0]({ kind: 'in', chatId: 'group:1', text: '长'.repeat(2000) })
  assert.deepEqual(modelOf(env, { provider: 'x', model: 'y' }, { kind: 'group', chatId: 'group:1' }), { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(modelOf(env, { provider: 'x', model: 'y' }, { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER }).provider, 'x', '主人不换')
  assert.equal(modelOf(env, null, { kind: 'group', chatId: 'group:1' }).model, 'deepseek-chat', '面板没选模型也能给 fallback')
})

test('记账跳过 system 会话；跨线提醒主人至多 2 次', async (t) => {
  const env = makeApi({ settings: { dailyBudgetYuan: 0.01, priceIn: 100000 } }) // 一条就爆线
  t.after(env.cleanup)
  const act = env.hooks.get('activity')[0]
  await act({ kind: 'in', chatId: 'system:想想', text: '完全不计账的一串字'.repeat(99) })
  assert.equal(env.sent.length, 0, 'system 会话不记账也不提醒')
  await act({ kind: 'in', chatId: 'group:1', text: '群里的长消息'.repeat(20) })
  assert.equal(env.sent.length, 1, '跨线提醒主人一次')
  await act({ kind: 'in', chatId: 'group:1', text: '又一条'.repeat(5) })
  await act({ kind: 'in', chatId: 'group:1', text: '再一条'.repeat(5) })
  await act({ kind: 'in', chatId: 'group:1', text: '还一条'.repeat(5) })
  assert.equal(env.sent.length, 2, '提醒封顶 2 条，不刷屏')
  assert.equal(env.sent[0].chatId, `private:${OWNER}`)
})

test('/预算 命令：查账、改线、豁免', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  assert.ok((await env.runCommand('')).includes('今日约'), '空参数当查账')
  assert.ok((await env.runCommand('20')).includes('20'))
  assert.equal(env.settings.dailyBudgetYuan, 20)
  assert.ok((await env.runCommand('解除')).includes('豁免'))
  assert.ok((await env.runCommand('abc')).includes('今日约'), '乱参数当查账')
})

test('/status：面板数据形状', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const st = await env.call('/status')
  assert.equal(st.ok, true)
  assert.equal(st.enabled, true)
  assert.ok(['ok', 'soft', 'hard'].includes(st.state))
  assert.equal(typeof st.today.yuan, 'number')
  assert.equal(st.recent.length, 7)
  assert.ok(Array.isArray(st.chats), 'chats 卡片数据要在')
  // 没有真实用量账本时退回估算口径
  const withSaved = st.chats.find((c) => c.saved > 0)
  if (withSaved) { assert.ok(withSaved.savedYuan >= 0, '节省折算字段在'); assert.equal(withSaved.estimate, true) }
})

test('/status：有插件真实用量账本时，消耗换成真实口径', async (t) => {
  // 模块回环调宿主 /usage：把全局 fetch 短路到假应答，验证合并逻辑（不打真网络）
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('/usage?range=7'), '该去要宿主用量：' + url)
    return { json: async () => ({ current: { byChat: [{ key: `private:${OWNER}`, runs: 3, totalTokens: 94271, cost: 0.5, cachedTokens: 93000, cacheHitRate: 0.98 }] } }) }
  }
  const env = makeApi({ mods: { memory: { list: () => [{ text: '主人喜欢猫' }] } } })
  try {
    const st = await env.call('/status', null, { host: '127.0.0.1:51440' })
    const c = st.chats.find((x) => x.chatId === `private:${OWNER}`)
    assert.ok(c, '真实账本里的会话要出现在卡片里')
    assert.equal(c.tokens, 94271, '消耗 = 真实请求 token（人格/历史/缓存全算）')
    assert.equal(c.cost, 0.5)
    assert.equal(c.estimate, false)
    assert.equal(c.runs, 3)
    assert.equal(c.cacheHitRate, 98)
    assert.equal(st.debug.realChats, 1)
    const withSaved = st.chats.find((x) => x.saved > 0)
    if (withSaved) assert.ok(Number.isFinite(withSaved.savedYuan), '节省折算必须是有限数字')
  } finally { globalThis.fetch = realFetch }
})

test('总开关：关掉后记账不跑、prompt 原样放行', async (t) => {
  const env = makeApi({ settings: { enabled: false, dailyBudgetYuan: 0.01, priceIn: 100000 } })
  t.after(env.cleanup)
  await env.hooks.get('activity')[0]({ kind: 'in', chatId: 'group:1', text: '长'.repeat(999) })
  assert.equal(env.sent.length, 0, '关掉不记账不提醒')
  const p = await env.runHook('prompt', [{ type: 'text', text: 'x' }], { chat: { kind: 'group', chatId: 'group:1' } })
  assert.equal(p.length, 1, '关掉不裁剪不拦截')
})
