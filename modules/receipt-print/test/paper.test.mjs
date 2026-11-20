import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePaper,
  columnsFromMm,
  normalizePaperMm,
  normalizeEffectiveMm,
  parseHexPayload,
} from '../lib/paper.mjs'

test('58mm 纸：有效 48mm，每行 32 列', () => {
  assert.deepEqual(resolvePaper({ paperWidthMm: 58 }), {
    paperMm: 58,
    effectiveMm: 48,
    dots: 384,
    columns: 32,
  })
})

test('80mm 纸：有效 72mm，每行 48 列', () => {
  assert.deepEqual(resolvePaper({ paperWidthMm: 80 }), {
    paperMm: 80,
    effectiveMm: 72,
    dots: 576,
    columns: 48,
  })
})

test('自定义纸宽按 mm 自适配列数', () => {
  assert.equal(resolvePaper({ paperWidthMm: 40 }).columns, 20) // 有效 30mm
  assert.equal(columnsFromMm(30), 20)
  assert.equal(columnsFromMm(48), 32)
  assert.equal(columnsFromMm(72), 48)
})

test('有效宽度优先于纸宽，且不会超过纸宽', () => {
  assert.equal(resolvePaper({ paperWidthMm: 80, effectiveWidthMm: 40 }).columns, 26)
  const clamped = resolvePaper({ paperWidthMm: 58, effectiveWidthMm: 100 })
  assert.equal(clamped.effectiveMm, 58)
})

test('纸宽归一化：非法值回落，0 有效宽度表示自动', () => {
  assert.equal(normalizePaperMm(0), 58)
  assert.equal(normalizePaperMm(200), 58)
  assert.equal(normalizePaperMm(57.5), 57.5)
  assert.equal(normalizeEffectiveMm(0, 58), 48)
  assert.equal(normalizeEffectiveMm(-3, 80), 72)
})

test('自检指令十六进制解析', () => {
  assert.deepEqual([...parseHexPayload('1B 40 1B 61 01').bytes], [0x1b, 0x40, 0x1b, 0x61, 0x01])
  assert.deepEqual([...parseHexPayload('0x1B,0x40').bytes], [0x1b, 0x40])
  assert.deepEqual([...parseHexPayload('1B401B61').bytes], [0x1b, 0x40, 0x1b, 0x61])
  assert.equal(parseHexPayload('   ').ok, true)
  assert.equal(parseHexPayload('1B 4').ok, false, '奇数位应报错')
  assert.equal(parseHexPayload('ZZ').ok, false, '非十六进制应报错')
})
