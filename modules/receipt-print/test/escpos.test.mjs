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

test('每张小票末尾空一行，再打一行按 columns 铺满的等号', () => {
  const bytes = buildReceiptBytes([{ text: '正文' }], { encoding: 'utf8', columns: 32 })
  assert.ok(bytes.includes(Buffer.from(`\n${'='.repeat(32)}\n`, 'utf8')))
  const tail = bytes.subarray(Math.max(0, bytes.length - 80)).toString('utf8')
  assert.ok(tail.includes('='.repeat(32)))
  assert.ok(bytes.indexOf(Buffer.from('='.repeat(32), 'utf8')) < bytes.indexOf(Buffer.from([0x1b, 0x64])), '等号要在走纸之前')
})

test('等号分隔线跟随有效宽度换算出的列数（80mm → 48 列）', () => {
  const bytes = buildReceiptBytes([{ text: '正文' }], { encoding: 'utf8', columns: 48 })
  assert.ok(bytes.includes(Buffer.from('='.repeat(48), 'utf8')))
  assert.ok(!bytes.includes(Buffer.from('='.repeat(49), 'utf8')))
})

test('行内图片按排版顺序插在文字中间', () => {
  const raster = { width: 8, height: 1, data: Buffer.from([0xff]) }
  const bytes = buildReceiptBytes([
    { text: 'A', style: 'normal' },
    { text: '', style: 'image', image: raster },
    { text: 'B', style: 'normal' },
  ], { encoding: 'utf8', columns: 32 })
  const posA = bytes.indexOf(Buffer.from('A', 'utf8'))
  const posImage = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30]))
  const posB = bytes.indexOf(Buffer.from('B', 'utf8'))
  assert.ok(posA >= 0 && posImage > posA && posB > posImage, `顺序应为 A < 图片 < B：${posA}/${posImage}/${posB}`)
})

test('可以关掉末尾的等号分隔线', () => {
  const bytes = buildReceiptBytes([{ text: '正文' }], { encoding: 'utf8', columns: 32, endSeparator: false })
  assert.ok(!bytes.includes(Buffer.from('='.repeat(32), 'utf8')))
})

test('样式指令：居中/右对齐/加粗/倍高/倍宽倍高', () => {
  const center = buildReceiptBytes([{ text: 'C', style: 'center' }], { encoding: 'utf8' })
  assert.ok(center.includes(Buffer.from([0x1b, 0x61, 0x01])))
  assert.ok(center.includes(Buffer.from([0x1b, 0x61, 0x00])), '对齐要复位')

  const right = buildReceiptBytes([{ text: 'R', style: 'right' }], { encoding: 'utf8' })
  assert.ok(right.includes(Buffer.from([0x1b, 0x61, 0x02])))

  const bold = buildReceiptBytes([{ text: 'B', style: 'bold' }], { encoding: 'utf8' })
  assert.ok(bold.includes(Buffer.from([0x1b, 0x45, 0x01])))
  assert.ok(bold.includes(Buffer.from([0x1b, 0x45, 0x00])))

  const big = buildReceiptBytes([{ text: 'B', style: 'big' }], { encoding: 'utf8' })
  assert.ok(big.includes(Buffer.from([0x1d, 0x21, 0x01])))

  const large = buildReceiptBytes([{ text: 'L', style: 'large' }], { encoding: 'utf8' })
  assert.ok(large.includes(Buffer.from([0x1d, 0x21, 0x11])))
  assert.ok(large.includes(Buffer.from([0x1d, 0x21, 0x00])), '字号要复位')
})
