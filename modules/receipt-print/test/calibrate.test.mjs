import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCalibration, buildBlackBand, blackBandBitmap, calibrationCandidates, calibrationBitmap, mmColumns } from '../lib/calibrate.mjs'
import { displayWidth } from '../lib/layout.mjs'

test('候选行宽度正好等于对应毫米的列数', () => {
  const rows = calibrationCandidates(58)
  assert.ok(rows.length >= 10)
  for (const row of rows) {
    assert.equal(displayWidth(row.text), mmColumns(row.mm))
    assert.match(row.text, /^\d+mm#+\]$/)
  }
  assert.ok(rows.some((row) => row.mm === 48))
  assert.ok(rows[0].mm > rows[rows.length - 1].mm)
})

test('校准页包含说明、候选行和验证方框', () => {
  const { lines, images } = buildCalibration({ paperWidthMm: 58, effectiveWidthMm: 48, columns: 32 })
  assert.equal(lines[0].style, 'title')
  assert.ok(lines.some((line) => line.text.includes('有效宽度')))
  assert.ok(lines.some((line) => line.text.includes('48mm#')))
  assert.equal(images.length, 1)
  assert.equal(images[0].width, 384)
  assert.equal(images[0].height, 32)
  assert.equal(images[0].data.length, 48 * 32)
})

test('80mm 纸按有效宽度生成', () => {
  const { images, candidates } = buildCalibration({ paperWidthMm: 80, effectiveWidthMm: 72, columns: 48 })
  assert.equal(images[0].width, 576)
  assert.ok(candidates.some((row) => row.mm === 72))
  assert.equal(candidates[0].mm, 78)
})

test('有效宽度留空时按纸宽推算', () => {
  const { effective, images } = buildCalibration({ paperWidthMm: 58, effectiveWidthMm: 0 })
  assert.equal(effective, 48)
  assert.equal(images[0].width, 384)
})

test('方框四边闭合、内部留白', () => {
  const bitmap = calibrationBitmap(64, 8)
  const bytesPerRow = 8
  const bit = (x, y) => (bitmap.data[y * bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1
  assert.equal(bit(0, 0), 1)
  assert.equal(bit(63, 0), 1)
  assert.equal(bit(63, 31), 1)
  assert.equal(bit(0, 31), 1)
  assert.equal(bit(32, 16), 0)
})

test('全黑测试条：按纸宽铺满，默认 100mm，最长 120mm', () => {
  const bitmap = blackBandBitmap({ widthDots: 464, lengthMm: 100 })
  assert.equal(bitmap.width, 464)
  assert.equal(bitmap.height, 800)
  assert.equal(bitmap.data.length, 58 * 800)
  assert.ok(bitmap.data.every((byte) => byte === 0xff), '整条应该全黑')

  const capped = blackBandBitmap({ widthDots: 464, lengthMm: 500 })
  assert.equal(capped.height, 120 * 8, '长度要封顶，避免打印头过热')
})

test('全黑测试条页面带说明和位图，宽度按纸宽而不是有效宽度', () => {
  const page = buildBlackBand({ paperWidthMm: 58, lengthMm: 80, columns: 32 })
  assert.equal(page.widthDots, 464)
  assert.equal(page.lengthMm, 80)
  assert.equal(page.images[0].height, 640)
  assert.ok(page.lines.some((line) => line.text.includes('80mm')))
  assert.ok(page.lines[0].text.includes('打印范围'))
})
