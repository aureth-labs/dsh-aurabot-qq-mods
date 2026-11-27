import test from 'node:test'
import assert from 'node:assert/strict'
import { describeMoments, pickNewMoments } from '../lib/moments.mjs'

const at = (hour) => new Date(2026, 10, 27, hour, 0, 0).getTime()

test('说说诊断：正常读到新说说时提示待打印条数', () => {
  const list = [{ at: at(9), text: 'a' }, { at: at(10), text: 'b' }]
  const text = describeMoments({ auto: true, list, lastAt: at(9), seeded: true })
  assert.match(text, /说说自动打印：开着/)
  assert.match(text, /读到 2 条说说/)
  assert.match(text, /待打印 1 条/)
})

test('说说诊断：没有 diary 模块说清楚原因', () => {
  const text = describeMoments({ auto: true, diary: 'missing' })
  assert.match(text, /找不到/)
  assert.match(text, /读不到说说/)
})

test('说说诊断：只读不到 history 时提示宿主太旧', () => {
  assert.match(describeMoments({ diary: 'old' }), /history\(\) 接口/)
  assert.match(describeMoments({ diary: 'error', error: '权限不足' }), /权限不足/)
})

test('说说诊断：仅自己可见被跳过时要能解释', () => {
  const list = [{ at: at(10), text: 'self', visibility: 'self' }]
  const text = describeMoments({ auto: true, list, lastAt: at(9), seeded: true })
  assert.match(text, /没有新的说说/)
  assert.match(text, /仅自己可见/)
})

test('说说诊断：还没初始化时只记位置不补打', () => {
  const text = describeMoments({ auto: true, list: [{ at: at(10), text: 'a' }], lastAt: 0, seeded: false })
  assert.match(text, /还没初始化/)
})

test('pickNewMoments：只挑比水位新的，并跳过仅自己可见', () => {
  const list = [
    { at: at(8), text: 'old' },
    { at: at(10), text: 'new' },
    { at: at(11), text: 'self', visibility: 'self' },
  ]
  const { rows, watermark } = pickNewMoments(list, at(9))
  assert.deepEqual(rows.map((r) => r.text), ['new'])
  assert.equal(watermark, at(11))
  assert.equal(pickNewMoments(list, at(9), { includeSelf: true }).rows.length, 2)
})
