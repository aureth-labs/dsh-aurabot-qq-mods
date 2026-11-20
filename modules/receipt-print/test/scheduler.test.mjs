import test from 'node:test'
import assert from 'node:assert/strict'
import { dueTemplates, tick } from '../lib/scheduler.mjs'

const at = (h, m) => new Date(2026, 10, 20, h, m)

const tpl = (patch = {}) => ({
  id: 't1',
  name: '日报',
  enabled: true,
  schedule: { enabled: true, time: '08:30', days: [] },
  ...patch,
})

test('到点触发，同一天只触发一次', () => {
  assert.equal(dueTemplates([tpl()], at(8, 30), {}).length, 1)
  assert.equal(dueTemplates([tpl()], at(8, 30), { t1: '2026-11-20' }).length, 0)
  assert.equal(dueTemplates([tpl()], at(8, 31), {}).length, 0)
})

test('按星期过滤，不选星期等于每天', () => {
  const day = at(8, 30).getDay()
  assert.equal(dueTemplates([tpl({ schedule: { enabled: true, time: '08:30', days: [day] } })], at(8, 30), {}).length, 1)
  assert.equal(dueTemplates([tpl({ schedule: { enabled: true, time: '08:30', days: [(day + 1) % 7] } })], at(8, 30), {}).length, 0)
})

test('停用或没开定时不触发', () => {
  assert.equal(dueTemplates([tpl({ enabled: false })], at(8, 30), {}).length, 0)
  assert.equal(dueTemplates([tpl({ schedule: { enabled: false, time: '08:30', days: [] } })], at(8, 30), {}).length, 0)
})

test('tick 调用 run', async () => {
  const ran = []
  const due = tick({ templates: [tpl()], now: at(8, 30), lastRun: () => '', run: (t) => ran.push(t.id) })
  assert.equal(due.length, 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(ran, ['t1'])
})
