import test from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth, wrapText } from '../lib/layout.mjs'

test('显示宽度：中文和全角占 2 列', () => {
  assert.equal(displayWidth('中文ab'), 6)
  assert.equal(displayWidth('ＡＢ'), 4)
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth(''), 0)
})

test('折行：中文按 2 列算，不超宽', () => {
  assert.deepEqual(wrapText('一二三四五', 4), ['一二', '三四', '五'])
  assert.deepEqual(wrapText('abcdefgh', 5), ['abcde', 'fgh'])
  for (const line of wrapText('热敏打印机小票测试一二三四五六七', 10)) {
    assert.ok(displayWidth(line) <= 10)
  }
})

test('折行：标点不单独起一行', () => {
  const lines = wrapText('今天把说说自动打印的配图调好了呀，', 32)
  assert.deepEqual(lines, ['今天把说说自动打印的配图调好了', '呀，'])
  for (const line of lines) {
    assert.equal(/^[。，、；：！？）》」』】]/.test(line), false)
    assert.ok(displayWidth(line) <= 32)
  }
})

test('折行：保留空行，清理行尾空白', () => {
  assert.deepEqual(wrapText('第一行  \n\n第三行', 20), ['第一行', '', '第三行'])
})
