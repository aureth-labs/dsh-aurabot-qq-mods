// 记忆总库 2.1.0 单元测试
// 覆盖：判定器、标签规整、存储读写、时效判定、遗忘强度
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const u = (p) => new URL('../' + p, import.meta.url).href

const { makeGrader, splitWords } = await import(u('lib/grade.mjs'))
const { normalizeTags } = await import(u('lib/tags.mjs'))
const { openStoreSqlite, sqliteAvailable } = await import(u('lib/store-sqlite.mjs'))
const { judgeFreshness } = await import(u('lib/freshness.mjs'))
const { strengthOf, stateOf } = await import(u('lib/forget.mjs'))

// ---------- 判定器 ----------
test('判定器：家里真名一律机密', () => {
  const g = makeGrader({ familyNames: '张三\n李四', ownerQQ: '111111111' })
  assert.equal(g.classify({ text: '张三今天说他腰疼', tags: [], chatId: '' }), 'secret')
  assert.equal(g.classify({ text: '李四买了新车', tags: [], chatId: '' }), 'secret')
})

test('判定器：家人 QQ 算机密', () => {
  const g = makeGrader({ familyQQ: '222222222\n333333333' })
  assert.equal(g.classify({ text: 'QQ 222222222 这个号', tags: [], chatId: '' }), 'secret')
  assert.equal(g.classify({ text: '333333333 是我家那位', tags: [], chatId: '' }), 'secret')
})

test('判定器：知识标签走公开', () => {
  const g = makeGrader({})
  assert.equal(g.classify({ text: '学了点什么', tags: ['知识'], chatId: '' }), 'public')
  assert.equal(g.classify({ text: '在抖音看了个视频', tags: [], chatId: '' }), 'public')
})

test('判定器：群聊来源算公开', () => {
  const g = makeGrader({})
  assert.equal(g.classify({ text: '今天天气不错', tags: [], chatId: 'group:123456' }), 'public')
})

test('判定器：普通闲聊算内部', () => {
  const g = makeGrader({})
  assert.equal(g.classify({ text: '今天天气不错', tags: [], chatId: 'private:999' }), 'internal')
})

test('判定器：称呼只在家人私聊里算机密', () => {
  const g = makeGrader({ familyQQ: '222222222' })
  assert.equal(
    g.classify({ text: '爸爸今天说要多喝水', tags: [], chatId: 'private:222222222' }),
    'secret',
    '家人私聊说称呼要判机密',
  )
  assert.notEqual(
    g.classify({ text: '我爸爸今天说要多喝水', tags: [], chatId: 'private:999999' }),
    'secret',
    '外人私聊说的不算',
  )
  assert.notEqual(
    g.classify({ text: '爸爸今天说要多喝水', tags: [], chatId: 'group:123456' }),
    'secret',
    '群里说的不算',
  )
})

test('判定器：置顶一律机密', () => {
  const g = makeGrader({})
  assert.equal(g.classify({ text: '随便什么', tags: [], chatId: '', pin: true }), 'secret')
})

test('判定器：知识标签绕过称呼判定', () => {
  const g = makeGrader({ familyQQ: '222222222' })
  assert.equal(
    g.classify({ text: '爸爸教了我一个端口号', tags: ['知识'], chatId: 'private:222222222' }),
    'public',
    '知识条不该因为提了称呼就压成机密',
  )
})

test('splitWords 能切开各种分隔符', () => {
  assert.deepEqual(splitWords('a|b,c，d;e；f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.deepEqual(splitWords(''), [])
  assert.deepEqual(splitWords(null), [])
})

// ---------- 标签 ----------
test('标签：散标签能规整', () => {
  const r = normalizeTags(['B站', '抖音', '知识'])
  assert.ok(Array.isArray(r))
  assert.ok(r.length > 0)
})

test('标签：危险标签会被丢掉', () => {
  const r = normalizeTags(['机密'])
  assert.ok(!r.includes('机密'), '机密标签不该留着')
})

// ---------- 存储（只有 sqlite 可用时才跑）----------
const canSqlite = sqliteAvailable()

test('存储：写入能查回来', { skip: !canSqlite && 'sqlite 不可用' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-test-'))
  try {
    const store = openStoreSqlite(dir)
    assert.ok(store, 'store 要能打开')
    const item = store.add('测试：张三喜欢吃面', { tags: ['事实'], importance: 0.7 })
    assert.ok(item && item.id, '要有 id')
    const got = store.get(item.id)
    assert.equal(got.text, '测试：张三喜欢吃面')
    assert.deepEqual(got.tags, ['事实'])
    assert.equal(got.importance, 0.7)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存储：能按关键词搜', { skip: !canSqlite && 'sqlite 不可用' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-test-'))
  try {
    const store = openStoreSqlite(dir)
    store.add('张三喜欢吃面', { tags: ['事实'] })
    store.add('今天下雨了', { tags: [] })
    const hits = store.search('张三')
    assert.ok(hits.length >= 1, '要搜得到')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存储：能改能删', { skip: !canSqlite && 'sqlite 不可用' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-test-'))
  try {
    const store = openStoreSqlite(dir)
    const it = store.add('原文', { tags: [] })
    store.update(it.id, { text: '改过的' })
    assert.equal(store.get(it.id).text, '改过的')
    store.remove(it.id)
    assert.equal(store.get(it.id), null)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存储：list 能分页和按密级筛', { skip: !canSqlite && 'sqlite 不可用' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-test-'))
  try {
    const store = openStoreSqlite(dir)
    for (let i = 0; i < 5; i++) store.add('条 ' + i, { tags: [], cls: i % 2 ? 'secret' : 'public' })
    const page1 = store.list({ limit: 2, offset: 0 })
    assert.equal(page1.length, 2, '一页两条')
    const secrets = store.list({ limit: 100, cls: 'secret' })
    assert.ok(secrets.length > 0, '要筛得到')
    assert.ok(
      secrets.every((x) => x.cls === 'secret'),
      '筛出来的都得是 secret',
    )
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 时效 ----------
test('时效：身体状态会过期', () => {
  const r = judgeFreshness('今天头疼得厉害', { tags: [] })
  assert.equal(r.kind, 'state', '要判成 state')
  assert.ok(r.spanDays > 0, '要有保质期，实际 ' + r.spanDays)
})

test('时效：心情只留一天', () => {
  const r = judgeFreshness('心情不太好', { tags: [] })
  assert.equal(r.spanDays, 1, '心情该是 1 天')
})

test('时效：置顶的不过期', () => {
  const r = judgeFreshness('随便什么', { tags: [], pin: true })
  assert.equal(r.kind, 'pinned', '要判成 pinned')
  assert.equal(r.spanDays, 0, '置顶不该有过期时间')
  assert.equal(r.suggestImportance, 1, '置顶重要度固定 1')
})

test('时效：知识类不过期', () => {
  const r = judgeFreshness('在B站看了个教程', { tags: ['知识'] })
  assert.equal(r.spanDays, 0, '知识不该有过期时间')
  assert.equal(r.kind, 'knowledge', '要判成 knowledge')
})

test('时效：规矩事实类不过期', () => {
  const r = judgeFreshness('每天早上八点提醒我吃药', { tags: ['规矩'] })
  assert.equal(r.spanDays, 0, '规矩不该有过期时间')
  assert.ok(r.kind === 'fact' || r.kind === 'rule', '要判成 fact/rule，实际 ' + r.kind)
})

// ---------- 遗忘 ----------
test('遗忘：重要度高的一直留', () => {
  const now = Date.now()
  const item = { importance: 1, at: now - 180 * 86400_000, lastHit: now - 180 * 86400_000 }
  const s = strengthOf(item, now)
  assert.ok(s > 0, '重要度 1 的还有强度')
})

test('遗忘：重要度越高掉得越慢', () => {
  const now = Date.now()
  const DAY = 86400_000
  const mk = (imp) => ({ importance: imp, at: now - 30 * DAY, lastHit: now - 30 * DAY })
  const low = strengthOf(mk(0.3), now)
  const high = strengthOf(mk(0.9), now)
  assert.ok(high > low, '重要度 0.9 该比 0.3 留得多：' + high + ' vs ' + low)
})

test('遗忘：越久没想起强度越低', () => {
  const now = Date.now()
  const DAY = 86400_000
  const mk = (days) => ({ importance: 0.5, at: now - days * DAY, lastHit: now - days * DAY })
  const near = strengthOf(mk(1), now)
  const far = strengthOf(mk(60), now)
  assert.ok(far < near, '60 天的该比 1 天的低：' + far + ' vs ' + near)
})

test('stateOf：强度决定档位', () => {
  assert.equal(stateOf(0.5), 'active', '0.5 该是 active')
  assert.equal(stateOf(0.08), 'sleeping', '0.08 该是 sleeping')
  assert.equal(stateOf(0.01), 'archived', '0.01 该是 archived')
})
