import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReceiptBytes } from '../lib/escpos.mjs'

const find = (buf, needle) => buf.indexOf(Buffer.from(needle)) >= 0

test('初始化指令在最前面', () => {
  const bytes = buildReceiptBytes([{ text: 'hi' }], { encoding: 'utf8' })
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40])
})

test('GBK 编码中文', () => {
  const bytes = buildReceiptBytes([{ text: '中' }], { encoding: 'gbk' })
  assert.ok(find(bytes, [0xd6, 0xd0]))
  assert.ok(find(bytes, [0x1c, 0x26])) // FS & 汉字模式
})

test('UTF-8 编码中文', () => {
  const bytes = buildReceiptBytes([{ text: '中' }], { encoding: 'utf8' })
  assert.ok(bytes.includes(Buffer.from('中', 'utf8')))
  assert.ok(!find(bytes, [0x1c, 0x26]))
})

test('标题：居中 + 倍宽倍高', () => {
  const bytes = buildReceiptBytes([{ text: '标题', style: 'title' }], { encoding: 'utf8' })
  assert.ok(find(bytes, [0x1b, 0x61, 0x01]))
  assert.ok(find(bytes, [0x1d, 0x21, 0x11]))
  assert.ok(find(bytes, [0x1d, 0x21, 0x00]))
})

test('分隔线按纸宽输出', () => {
  const bytes = buildReceiptBytes([{ text: '-'.repeat(32), style: 'sep' }], { encoding: 'utf8', width: 32 })
  assert.ok(bytes.includes(Buffer.from('-'.repeat(32), 'utf8')))
})

test('切纸与走纸', () => {
  const partial = buildReceiptBytes([], { encoding: 'utf8', cut: 'partial', feed: 3 })
  assert.ok(find(partial, [0x1b, 0x64, 0x03]))
  assert.deepEqual([...partial.subarray(-4)], [0x1d, 0x56, 0x42, 0x00])

  const full = buildReceiptBytes([], { encoding: 'utf8', cut: 'full' })
  assert.deepEqual([...full.subarray(-3)], [0x1d, 0x56, 0x00])

  const none = buildReceiptBytes([], { encoding: 'utf8', cut: 'none' })
  assert.ok(!find(none, [0x1d, 0x56]))
})

test('二维码指令', () => {
  const bytes = buildReceiptBytes([], { encoding: 'utf8', qr: 'https://example.com' })
  assert.ok(find(bytes, [0x1d, 0x28, 0x6b]))
  assert.ok(bytes.includes(Buffer.from('https://example.com', 'utf8')))
})
