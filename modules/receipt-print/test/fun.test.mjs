import test from 'node:test'
import assert from 'node:assert/strict'
import { funLines } from '../lib/fun.mjs'
import { displayWidth } from '../lib/layout.mjs'

test('每日彩蛋按日期固定，换一天会变', () => {
  const a = funLines({ now: new Date(2026, 10, 20, 18, 0), name: '今日总结', width: 32 })
  const b = funLines({ now: new Date(2026, 10, 20, 21, 30), name: '今日总结', width: 32 })
  assert.deepEqual(a, b, '同一天重打内容应一致')

  const next = funLines({ now: new Date(2026, 10, 21, 18, 0), name: '今日总结', width: 32 })
  assert.notDeepEqual(a, next)

  assert.ok(a.some((line) => line.includes('幸运数字')))
  assert.ok(a.some((line) => line.includes('幸运色')))
  assert.ok(a.some((line) => line.includes('今日关键词')))
  for (const line of a) assert.ok(displayWidth(line) <= 32)
})

test('纸太窄时不加彩蛋', () => {
  assert.deepEqual(funLines({ width: 10 }), [])
})
