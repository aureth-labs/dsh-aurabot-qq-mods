import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLines } from '../lib/templates.mjs'
import { buildReceiptBytes } from '../lib/escpos.mjs'
import {
  decodeEscpos,
  formatDecoded,
  decodeStatusByte,
  decodeStatusBytes,
  decodeAsb,
  decodePrinterStatus,
  searchCommands,
} from '../lib/escpos-decode.mjs'

test('解码自己发出的票据：文本、二维码、切纸都能认出来', () => {
  const { lines, qr } = buildLines({
    template: { name: '测试' },
    body: '你好，世界',
    width: 32,
    footer: '页脚',
    qr: 'https://example.com',
    now: new Date(2026, 10, 20, 18, 0),
  })
  const bytes = buildReceiptBytes(lines, { encoding: 'gbk', cut: 'partial', columns: 32, qr })
  const decoded = decodeEscpos(bytes)
  const names = decoded.entries.map((entry) => entry.name)

  assert.ok(names.includes('初始化打印机'))
  assert.ok(names.includes('进入汉字模式'))
  assert.ok(names.includes('二维码 / 二维条码'))
  assert.ok(names.some((name) => name.includes('切')))
  assert.ok(decoded.entries.some((entry) => entry.text && entry.text.includes('你好')))
  assert.ok(decoded.entries.every((entry) => entry.length > 0))
  assert.ok(formatDecoded(bytes).includes('GS V'))
})

test('解码位图：跳过数据块，不把图当文本', () => {
  const raster = Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1d, 0x76, 0x30, 0x00, 0x02, 0x00, 0x01, 0x00]),
    Buffer.from([0xff, 0xff]),
    Buffer.from([0x1d, 0x56, 0x01]),
  ])
  const decoded = decodeEscpos(raster)
  assert.deepEqual(decoded.entries.map((entry) => entry.name), ['初始化打印机', '打印光栅位图', '切纸'])
  assert.equal(decoded.entries[1].length, 10)
  assert.ok(decoded.entries[1].extra.includes('16 dot'))
})

test('未知控制字节原样列出', () => {
  const decoded = decodeEscpos(Buffer.from([0x1f, 0x00]))
  assert.equal(decoded.entries.length, 2)
  assert.ok(decoded.entries[0].name.includes('未知'))
  assert.equal(decoded.entries[0].hex, '1F')
})

test('状态字节：脱机、缺纸能报成错误', () => {
  const offline = decodeStatusByte(0x08, 1)
  assert.equal(offline.label, '打印机状态')
  assert.ok(offline.errors.includes('脱机'))

  const paperEnd = decodeStatusByte(0x40, 3)
  assert.ok(paperEnd.errors.includes('缺纸'))

  const cover = decodeAsb(Buffer.from([0x02, 0x04, 0x00, 0x00]))
  assert.ok(cover.errors.includes('机盖打开'))

  const printer = decodePrinterStatus(0x08)
  assert.ok(printer.errors.includes('脱机'))
})

test('四个状态字节依次解读', () => {
  const decoded = decodeStatusBytes(Buffer.from([0x00, 0x00, 0x00, 0x40]))
  assert.equal(decoded.results.length, 4)
  assert.equal(decoded.results[3].label, '纸张传感器')
  assert.ok(decoded.errors.some((item) => item.includes('缺纸')))
})

test('指令表能按关键词检索', () => {
  const rows = searchCommands('切纸')
  assert.ok(rows.some((row) => row.includes('GS V')))
  assert.ok(searchCommands('1D 56').length >= 2)
  assert.ok(searchCommands('二维码').some((row) => row.includes('GS ( k')))
  assert.ok(searchCommands('').length > 50)
})
