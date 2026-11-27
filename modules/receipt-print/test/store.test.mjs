import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, normalizeTemplate } from '../lib/store.mjs'

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

test('模板触发方式：定时与 schedule.enabled 同步，旧的按 enabled 推断', () => {
  const schedule = normalizeTemplate({ name: '定时', schedule: { enabled: true, time: '07:00' } })
  assert.equal(schedule.trigger, 'schedule')
  assert.equal(schedule.schedule.enabled, true)

  const legacy = normalizeTemplate({ name: '旧模板', schedule: { enabled: false } })
  assert.equal(legacy.trigger, 'manual')

  const model = normalizeTemplate({ name: '自触发', trigger: 'model', schedule: { enabled: true } })
  assert.equal(model.trigger, 'model')
  assert.equal(model.schedule.enabled, false, '非定时触发不能保留定时标记')

  const unknown = normalizeTemplate({ name: '乱填', trigger: 'xxx' })
  assert.equal(unknown.trigger, 'manual')
})

test('额外预设只补一次：同名跳过，删掉不复活', async () => {
  const dir = await tempDir()
  const store = openStore(dir)
  store.seed({ name: '每日简报', prompt: '写简报' })
  const created = store.seedPresets([
    { name: '每日简报', prompt: '重复的' },
    { name: '晨间计划', prompt: '写计划' },
    { name: '睡前一句', prompt: '写晚安', schedule: { enabled: false, time: '22:30', days: [] } },
  ])
  assert.deepEqual(created.map((t) => t.name), ['晨间计划', '睡前一句'])
  assert.equal(store.templates().length, 3)
  assert.equal(store.get('每日简报').prompt, '写简报', '同名的旧模板不能被覆盖')

  assert.deepEqual(store.seedPresets([{ name: '今日菜单', prompt: '写菜单' }]), [])
  assert.equal(store.templates().length, 3)

  store.deleteTemplate('晨间计划')
  const again = openStore(dir)
  assert.deepEqual(again.seedPresets([{ name: '晨间计划', prompt: '写计划' }]), [])
  assert.equal(again.get('晨间计划'), null)
})

test('预设生成方式只同步一次，且不动改过提示词的模板', async () => {
  const dir = await tempDir()
  const store = openStore(dir)
  store.saveTemplate({ name: '每日简报', prompt: '固定提示词', engine: 'think' })
  store.saveTemplate({ name: '今日总结', prompt: '我自己改过的', engine: 'ask' })
  const changed = store.syncPresetEngines([
    { name: '每日简报', prompt: '固定提示词', engine: 'ask' },
    { name: '今日总结', prompt: '原始提示词', engine: 'think' },
  ])
  assert.deepEqual(changed, ['每日简报'])
  assert.equal(store.get('每日简报').engine, 'ask')
  assert.equal(store.get('今日总结').engine, 'ask', '提示词被改过就不碰')

  store.saveTemplate({ ...store.get('每日简报'), engine: 'think' })
  const reopened = openStore(dir)
  assert.deepEqual(reopened.syncPresetEngines([{ name: '每日简报', prompt: '固定提示词', engine: 'ask' }]), [])
  assert.equal(reopened.get('每日简报').engine, 'think', '同步只做一次，之后尊重用户选择')
})

test('预设提示词升级只替换未改过的默认值', async () => {
  const store = openStore(await tempDir())
  store.saveTemplate({ name: '灵感便签', prompt: '旧默认提示词' })
  store.saveTemplate({ name: '晨间计划', prompt: '我自己改的' })
  assert.equal(store.replacePresetPrompt('灵感便签', '旧默认提示词', '新默认提示词'), true)
  assert.equal(store.get('灵感便签').prompt, '新默认提示词')
  assert.equal(store.replacePresetPrompt('晨间计划', '旧默认提示词', '新默认提示词'), false)
  assert.equal(store.get('晨间计划').prompt, '我自己改的')
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
