// little-notes 测试：mock api，覆盖工具、面板接口、权限门禁和两个定时兜底。
// 不联网、不需要插件环境。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod, { hooks } from '../index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'little-notes-test-'))
const routes = {}
const commands = []
const rules = []
const contexts = []
const jobs = []
const sends = []
const toolFns = []
let thinkReplies = []
let logRows = []

const api = {
  dataDir: () => dir,
  config: () => ({ ownerName: '老公' }),
  settings: () => ({}),
  log: { info() {}, warn() {}, error() {} },
  tool(fn) { toolFns.push(fn) },
  defineTool: (p) => p,
  rule: (f) => rules.push(f),
  context: (f) => contexts.push(f),
  command: (c) => commands.push(c),
  route: (p, f) => { routes[p] = f },
  every: (ms, fn, name) => jobs.push({ name, fn }),
  think: async () => thinkReplies.shift() ?? '',
  send: (chatId, text) => sends.push({ chatId, text }),
  core: {
    hub: {
      turnSendersAllOwner: (sid) => sid === 's1',
      chatLogOf: () => logRows,
    },
    http: { body: async (req) => req.__body },
  },
}

mod.setup(api)

// 主人私聊的工具（level full / sessionId s1）
const tools = toolFns[0]({ chat: { chatId: 'private:123', kind: 'private' }, level: 'full', sessionId: 's1' })
// 群聊的工具（非主人会话）
const socialTools = toolFns[0]({ chat: { chatId: 'group:1', kind: 'group' }, level: 'social', sessionId: 'g1' })
const byName = (list, n) => list.find((t) => t.name === n)
const dbFile = () => JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8'))

test('注册了 4 个工具、2 个定时任务、3 个命令', () => {
  assert.deepEqual(tools.map((t) => t.name), ['note_add', 'note_search', 'note_recent', 'note_forget'])
  const jobNames = [...new Set(jobs.map((j) => j.name))]
  assert.equal(jobNames.length, 2)
  assert.ok(jobNames.some((n) => n.includes('每晚整理')))
  assert.ok(jobNames.some((n) => n.includes('日子提醒')))
  assert.deepEqual(commands.map((c) => c.name), ['本子', '记', '翻'])
})

test('note_add 记一笔，默认称呼用 ownerName', async () => {
  const r = await byName(tools, 'note_add').execute({
    text: '11月20日他说考完试想去看海', kind: 'promise', about: '老公', tags: ['约定'], important: true, due: '2026-11-20',
  })
  assert.equal(r.ok, true)
  assert.match(r.message, /答应过/)
  assert.match(r.message, /老公/)
})

test('note_search 按人 / 关键词 / 类型 / 日期翻', async () => {
  await byName(tools, 'note_add').execute({ text: '他说他喜欢雨天', kind: 'fact', about: '老公' })
  await byName(tools, 'note_add').execute({ text: '随便记一笔', kind: 'note' })

  const rAbout = await byName(tools, 'note_search').execute({ about: '老公' })
  assert.match(rAbout.message, /翻到 3 条/)

  const rKw = await byName(tools, 'note_search').execute({ keyword: '看海' })
  assert.match(rKw.message, /看海/)

  const rKind = await byName(tools, 'note_search').execute({ kind: 'fact' })
  assert.match(rKind.message, /翻到 1 条/)

  const rNone = await byName(tools, 'note_search').execute({ keyword: '不存在的词xyz' })
  assert.equal(rNone.ok, true)
  assert.match(rNone.message, /没有对得上/)
})

test('note_recent 看最近', async () => {
  const r = await byName(tools, 'note_recent').execute({})
  assert.match(r.message, /共 3 条/)
})

test('note_forget 按 id 划掉；划掉的不再出现在 note_recent', async () => {
  const target = dbFile()['private:123'].find((e) => e.text.includes('雨天'))
  const r = await byName(tools, 'note_forget').execute({ id: target.id })
  assert.equal(r.ok, true)
  assert.match(r.message, /划掉了/)
  const after = dbFile()['private:123'].find((e) => e.id === target.id)
  assert.ok(after.deletedAt, '划掉的条目留在本子上（留痕）')
  const recent = await byName(tools, 'note_recent').execute({})
  assert.ok(!recent.message.includes('雨天'))
})

test('note_forget 只有主人能删（群聊被拒）', async () => {
  const r = await byName(socialTools, 'note_forget').execute({ keyword: '看海' })
  assert.equal(r.ok, false)
  assert.match(r.message, /主人/)
})

test('每个聊天独立一本', async () => {
  await byName(socialTools, 'note_add').execute({ text: '群友说周末聚餐', kind: 'said', about: '小鱼' })
  const db = dbFile()
  assert.equal(db['group:1'].length, 1)
  assert.equal(db['private:123'].filter((e) => !e.deletedAt).length, 2)
})

test('note_forget 按关键词：多条命中要求说清楚，唯一命中直接删', async () => {
  await byName(tools, 'note_add').execute({ text: '他说周五要加班', kind: 'said', about: '老公' })
  const rMulti = await byName(tools, 'note_forget').execute({ keyword: '他说' })
  assert.equal(rMulti.ok, false)
  assert.match(rMulti.message, /对上 2 条/)

  const rOne = await byName(tools, 'note_forget').execute({ keyword: '看海' })
  assert.equal(rOne.ok, true)
})

test('超过上限丢最旧的普通条目，标星的保留', async () => {
  const db = dbFile()
  db['private:123'] = Array.from({ length: 500 }, (_, i) => ({
    id: 'x' + i, at: i, kind: 'note', text: 't' + i, tags: [], important: i % 100 === 0,
  }))
  writeFileSync(join(dir, 'notes.json'), JSON.stringify(db))
  await byName(tools, 'note_add').execute({ text: '第501条' })
  let after = dbFile()['private:123']
  assert.equal(after.length, 500)
  assert.ok(!after.some((e) => e.text === 't1'), '丢的是最旧的普通条目 t1')
  for (const t of ['t0', 't100', 't200', 't300', 't400']) {
    assert.ok(after.some((e) => e.text === t), `星标的 ${t} 保留`)
  }

  // 全是星标还超限时，才丢最旧的星标
  const allStar = Array.from({ length: 502 }, (_, i) => ({
    id: 'y' + i, at: i, kind: 'note', text: 's' + i, tags: [], important: true,
  }))
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ 'private:123': allStar }))
  await byName(tools, 'note_add').execute({ text: '第503条' })
  after = dbFile()['private:123']
  assert.equal(after.length, 500)
  assert.ok(!after.some((e) => e.text === 's0'), '全是星标时丢最旧的 s0')
  assert.ok(!after.some((e) => e.text === 's2'), '全是星标时丢最旧的 s2')
  assert.ok(after.some((e) => e.text === 's3'), '更新的星标保留')
})

test('锁定的条目永不淘汰，本子超上限也保', async () => {
  const db = dbFile()
  const list = Array.from({ length: 499 }, (_, i) => ({
    id: 'n' + i, at: i, kind: 'note', text: 'n' + i, tags: [], important: false,
  }))
  list.unshift({ id: 'L1', at: -2, kind: 'promise', text: '锁住的约定A', tags: [], important: true, locked: true })
  list.unshift({ id: 'L2', at: -1, kind: 'note', text: '锁住的B', tags: [], important: false, locked: true })
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ 'private:123': list }))
  await byName(tools, 'note_add').execute({ text: '新来的' })
  let after = dbFile()['private:123']
  assert.equal(after.length, 500)
  assert.ok(after.some((e) => e.text === '锁住的约定A'), '锁住的星标保留')
  assert.ok(after.some((e) => e.text === '锁住的B'), '锁住的普通条也保留')

  // 锁的太多实在放不下：宁超上限也不丢锁的
  const locked500 = Array.from({ length: 500 }, (_, i) => ({
    id: 'k' + i, at: i, kind: 'note', text: 'k' + i, tags: [], important: true, locked: true,
  }))
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ 'private:123': locked500 }))
  await byName(tools, 'note_add').execute({ text: '新来的第二条' })
  after = dbFile()['private:123']
  assert.equal(after.length, 501)
  assert.ok(after.some((e) => e.text === 'k0'), '锁住的最旧的也保留')
  assert.ok(after.some((e) => e.text === '新来的第二条'))

  // /lock 接口切换
  const entry = after.find((e) => e.text === '新来的第二条')
  const rLock = await routes['/lock']({ __body: { chatId: 'private:123', id: entry.id } })
  assert.equal(rLock.ok, true)
  assert.equal(rLock.locked, true)
  const rUn = await routes['/lock']({ __body: { chatId: 'private:123', id: entry.id } })
  assert.equal(rUn.locked, false)
})

test('面板接口：汇总 / 补记 / 标星 / 划掉留痕 / 恢复', async () => {
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ 'private:123': [], 'group:1': [] }))
  const rNotes = await routes['/notes']()
  assert.equal(rNotes.ok, true)
  assert.ok(Array.isArray(rNotes.notes))

  const rAdd = await routes['/add']({ __body: { chatId: 'private:123', text: '面板补一笔', kind: 'said', about: '老公' } })
  assert.equal(rAdd.ok, true)
  assert.equal(rAdd.entry.text, '面板补一笔')

  const rPin = await routes['/pin']({ __body: { chatId: 'private:123', id: rAdd.entry.id } })
  assert.equal(rPin.ok, true)
  assert.equal(rPin.important, true)

  const rDel = await routes['/del']({ __body: { chatId: 'private:123', id: rAdd.entry.id } })
  assert.equal(rDel.ok, true)
  assert.ok(rDel.gone.deletedAt)
  const kept = dbFile()['private:123'].find((e) => e.id === rAdd.entry.id)
  assert.ok(kept, '划掉的留在本子上')
  assert.ok(kept.deletedAt)

  const rUndel = await routes['/undel']({ __body: { chatId: 'private:123', id: rAdd.entry.id } })
  assert.equal(rUndel.ok, true)
  assert.ok(!dbFile()['private:123'].find((e) => e.id === rAdd.entry.id).deletedAt)

  const rBad = await routes['/add']({ __body: { chatId: '', text: '' } })
  assert.equal(rBad.ok, false)
})

test('规则告诉她什么时候主动记', () => {
  const rule = rules[0]('private')
  assert.match(rule, /note_add/)
  assert.match(rule, /note_search/)
})

test('每轮上下文里有本子概况', () => {
  const ctx = contexts[0]({ chat: { chatId: 'private:123', kind: 'private' } })
  assert.match(ctx, /小本本/)
})

test('每晚整理：挑新的补进本子，重复的跳过，同一天只跑一次', async () => {
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ 'private:123': [], 'group:1': [] }))
  logRows = [
    { t: 1, chatId: 'private:123', who: '希希小锅锅', uid: '1', text: '第501条' },
    { t: 2, chatId: 'private:123', who: '希希小锅锅', uid: '1', text: '他说他下个月要去成都出差' },
    { t: 3, chatId: 'private:123', who: 'bot', text: '好的呀' },
    { t: 4, chatId: 'private:123', who: '希希小锅锅', uid: '1', text: '一路顺风，到了跟我说' },
    { t: 5, chatId: 'private:123', who: '希希小锅锅', uid: '1', text: '对了，你说想要那台相机' },
    { t: 6, chatId: 'private:123', who: 'bot', text: '嗯嗯' },
    { t: 7, chatId: 'group:1', who: '小鱼', uid: '2', text: '一条不够六条的' },
  ]
  thinkReplies = ['[{"kind":"fact","about":"老公","text":"他说他下个月要去成都出差","tags":["出差"]},{"kind":"fact","about":"老公","text":"他想要一台相机"}]']
  await hooks.tidyOnce(new Date('2026-11-13T23:30:00'))
  const added = dbFile()['private:123'].filter((e) => (e.tags || []).includes('整理'))
  assert.equal(added.length, 2)
  assert.ok(added.some((e) => e.text.includes('相机')))
  assert.ok(!added.some((e) => e.text.includes('第501条')), '已有的不重复补')

  thinkReplies = ['[{"kind":"note","text":"不该出现的一条"}]']
  await hooks.tidyOnce(new Date('2026-11-13T23:50:00'))
  assert.ok(!dbFile()['private:123'].some((e) => e.text === '不该出现的一条'), '同一天只整理一次')
})

test('整理只在深夜跑，白天不动', async () => {
  thinkReplies = ['[{"kind":"note","text":"白天不该整理"}]']
  await hooks.tidyOnce(new Date('2026-11-14T10:00:00'))
  assert.ok(!dbFile()['private:123'].some((e) => e.text === '白天不该整理'))
})

test('日子提醒：到期当天主动说一句，只提一次，凌晨不说话', async () => {
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ 'private:123': [], 'group:1': [] }))
  await byName(tools, 'note_add').execute({ text: '答应他6月1日一起去看展', kind: 'promise', about: '老公', due: '2026-06-01' })
  thinkReplies = ['宝贝，今天不是说好一起去看展嘛，我都记着呢！']
  await hooks.remindOnce(new Date('2026-06-01T09:00:00'))
  assert.equal(sends.length, 1)
  assert.equal(sends[0].chatId, 'private:123')
  assert.match(sends[0].text, /看展/)
  assert.ok(dbFile()['private:123'].find((e) => e.text.includes('看展')).remindAt)

  sends.length = 0
  thinkReplies = ['不该再说一遍']
  await hooks.remindOnce(new Date('2026-06-01T15:00:00'))
  assert.equal(sends.length, 0)

  await byName(tools, 'note_add').execute({ text: '6月2日要做的事', kind: 'note', about: '老公', due: '2026-06-02' })
  thinkReplies = ['大半夜的不该说话']
  await hooks.remindOnce(new Date('2026-06-02T03:00:00'))
  assert.equal(sends.length, 0)
})

test('收尾清理临时目录', () => {
  rmSync(dir, { recursive: true, force: true })
  assert.ok(true)
})
