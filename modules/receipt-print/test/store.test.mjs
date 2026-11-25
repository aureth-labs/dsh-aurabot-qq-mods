import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.mjs'

const tempDir = () => mkdtemp(join(tmpdir(), 'receipt-store-'))

test('种子模板只会写一次', async () => {
  const store = openStore(await tempDir())
  assert.equal(store.templates().length, 0)
  const seeded = store.seed({ name: '每日简报', prompt: '写简报' })
  assert.equal(seeded.name, '每日简报')
  store.seed({ name: '第二个', prompt: 'x' })
  assert.equal(store.templates().length, 1)
})

test('今日总结只补种一次，删掉也不复活', async () => {
  const dir = await tempDir()
  const store = openStore(dir)
  store.seed({ name: '每日简报', prompt: '写简报' })

  const summary = store.seedSummary({
    name: '今日总结',
    prompt: '写总结',
    schedule: { enabled: true, time: '18:00', days: [] },
  })
  assert.equal(summary.name, '今日总结')
  assert.equal(summary.schedule.enabled, true)
  assert.equal(summary.schedule.time, '18:00')
  assert.equal(store.templates().length, 2)

  assert.equal(store.seedSummary({ name: '今日总结', prompt: '写总结' }), null)
  assert.equal(store.templates().length, 2)

  store.deleteTemplate('今日总结')
  assert.equal(store.seedSummary({ name: '今日总结', prompt: '写总结' }), null)
  assert.equal(store.get('今日总结'), null)

  const again = openStore(dir)
  assert.equal(again.seedSummary({ name: '今日总结', prompt: '写总结' }), null)
  assert.equal(again.get('今日总结'), null)
})

test('按名字或 id 取模板，保存和删除', async () => {
  const store = openStore(await tempDir())
  const t = store.saveTemplate({ name: '日报', prompt: '写日报', schedule: { enabled: true, time: '08:30', days: [1, 3] } })
  assert.equal(store.get('日报').id, t.id)
  assert.equal(store.get(t.id).name, '日报')
  assert.deepEqual(store.get('日报').schedule.days, [1, 3])

  const updated = store.saveTemplate({ ...t, name: '日报 v2' })
  assert.equal(store.get('日报 v2').id, t.id)
  assert.equal(store.templates().length, 1)

  assert.equal(store.deleteTemplate('日报 v2').id, t.id)
  assert.equal(store.templates().length, 0)
})

test('打印记录最多保留 30 条，新的在前', async () => {
  const store = openStore(await tempDir())
  for (let i = 0; i < 35; i++) store.addHistory({ template: `t${i}`, ok: true })
  const history = store.history(30)
  assert.equal(history.length, 30)
  assert.equal(history[0].template, 't34')
})

test('说说水位只前进不后退，并记住是否已初始化', async () => {
  const dir = await tempDir()
  const store = openStore(dir)
  assert.equal(store.momentSeeded(), false)
  assert.equal(store.momentLast(), 0)

  store.markMoment(2000, { seeded: true })
  assert.equal(store.momentLast(), 2000)
  assert.equal(store.momentSeeded(), true)

  store.markMoment(1000)
  assert.equal(store.momentLast(), 2000, '旧时间不能把水位拉回去')

  const again = openStore(dir)
  assert.equal(again.momentLast(), 2000)
  assert.equal(again.momentSeeded(), true)
})

test('每次打印写备份文件并记录触发来源', async () => {
  const dir = await tempDir()
  const store = openStore(dir)
  store.addHistory({
    template: '今日总结',
    ok: true,
    text: '今天的第一行\n第二行',
    trigger: { type: 'schedule', reason: '每天 18:00' },
  })
  const entry = store.history(1)[0]
  assert.equal(entry.trigger.type, 'schedule')
  assert.match(entry.backup, /^backups\//)
  const saved = await readFile(join(dir, entry.backup), 'utf8')
  assert.match(saved, /触发类型：schedule/)
  assert.match(saved, /触发原因：每天 18:00/)
  assert.match(saved, /今天的第一行/)
})

test('未知触发类型归到 unknown，正文过长会截断', async () => {
  const store = openStore(await tempDir())
  store.addHistory({ template: '旧记录', text: 'x'.repeat(9000), trigger: { type: 'whatever' } })
  const entry = store.history(1)[0]
  assert.equal(entry.trigger.type, 'unknown')
  assert.equal(entry.text.length, 8000)
})

test('落盘后重新打开还能读回来', async () => {
  const dir = await tempDir()
  const store = openStore(dir)
  const t = store.saveTemplate({ name: '清单', prompt: '列清单' })
  store.markRun(t.id, '2026-11-20')
  store.addHistory({ template: '清单', ok: true })

  const again = openStore(dir)
  assert.equal(again.get('清单').prompt, '列清单')
  assert.equal(again.lastRun(t.id), '2026-11-20')
  assert.equal(again.history(5).length, 1)
  const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.version, 1)
})

test('自定义备份目录：一次打印一个文件，不动目录里别的文件', async () => {
  const dir = await tempDir()
  const custom = await mkdtemp(join(tmpdir(), 'receipt-backup-'))
  await writeFile(join(custom, 'keep.txt'), '我的笔记')
  const store = openStore(dir)
  store.addHistory({ template: '今日总结', text: '第一张', trigger: { type: 'schedule', reason: '每天 18:00' } }, { backupDir: custom })
  store.addHistory({ template: '今日总结', text: '第二张', trigger: { type: 'schedule', reason: '每天 18:00' } }, { backupDir: custom })

  const files = await readdir(custom)
  const mine = files.filter((f) => f.startsWith('receipt-'))
  assert.equal(mine.length, 2)
  assert.ok(files.includes('keep.txt'))
  const contents = await Promise.all(mine.map((f) => readFile(join(custom, f), 'utf8')))
  assert.ok(contents.some((t) => t.includes('第一张')))
  assert.ok(contents.some((t) => t.includes('第二张')))
  assert.ok(store.history(2).every((e) => e.backup.startsWith(custom)))
})

test('同一毫秒连打两张也会各自留一份备份', async () => {
  const dir = await tempDir()
  const custom = await mkdtemp(join(tmpdir(), 'receipt-backup-'))
  const store = openStore(dir)
  const at = new Date(2026, 10, 20, 10, 0, 0, 123).getTime()
  store.addHistory({ at, template: '今日总结', text: '同一毫秒 A' }, { backupDir: custom })
  store.addHistory({ at, template: '今日总结', text: '同一毫秒 B' }, { backupDir: custom })

  const mine = (await readdir(custom)).filter((f) => f.startsWith('receipt-'))
  assert.equal(mine.length, 2)
  const contents = await Promise.all(mine.map((f) => readFile(join(custom, f), 'utf8')))
  assert.ok(contents.some((t) => t.includes('同一毫秒 A')))
  assert.ok(contents.some((t) => t.includes('同一毫秒 B')))
})

test('备份目录不可写时退回默认目录并记下原因', async () => {
  const dir = await tempDir()
  const blocker = join(dir, 'blocked')
  await writeFile(blocker, 'not a dir')
  const store = openStore(dir)
  const item = store.addHistory({ template: 'A', text: '正文', trigger: { type: 'command' } }, { backupDir: blocker })
  assert.match(item.backup, /^backups\//)
  assert.match(item.backupError, /不可写/)
  const saved = await readFile(join(dir, item.backup), 'utf8')
  assert.match(saved, /正文/)
})
