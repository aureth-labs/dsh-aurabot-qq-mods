/**
 * describe.test.mjs —— 图片元信息与画面描述
 *
 * imageFacts / sniff / dimension 是纯本地计算（只读文件头），
 * 这些测试保证「她至少能知道这是一张什么格式、多大的图」这条兜底不会挂。
 * describeImage 用的 ask 是假的，不联网。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { describeImage, dimension, imageFacts, sniff } from '../lib/describe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PNG = readFileSync(join(HERE, '..', 'lib', 'assets', 'selftest.png'))

// ── sniff：按文件头判格式，不看扩展名 ──────────────────────

test('认出 PNG', () => {
  assert.equal(sniff(PNG), 'image/png')
})

test('认出 JPEG', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
  assert.equal(sniff(jpeg), 'image/jpeg')
})

test('认出 GIF', () => {
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary')
  assert.equal(sniff(gif), 'image/gif')
})

test('认出 WEBP', () => {
  const webp = Buffer.alloc(16)
  webp.write('RIFF', 0, 'ascii')
  webp.write('WEBP', 8, 'ascii')
  assert.equal(sniff(webp), 'image/webp')
})

test('不认识的东西返回空串，不抛', () => {
  assert.equal(sniff(Buffer.from('这不是图片')), '')
  assert.equal(sniff(Buffer.alloc(0)), '')
  assert.equal(sniff(null), '')
  assert.equal(sniff(Buffer.from([1, 2, 3])), '')
})

// ── dimension：读图宽高 ────────────────────────────────────

test('读出 PNG 的宽高', () => {
  const d = dimension(PNG)
  assert.match(d, /^\d+×\d+$/)
  const [w, h] = d.split('×').map(Number)
  assert.ok(w > 0 && h > 0, '宽高要是正数')
})

test('读不出时返回空串，不抛', () => {
  assert.equal(dimension(Buffer.from('乱七八糟')), '')
  assert.equal(dimension(Buffer.alloc(0)), '')
})

// ── imageFacts：给她看的「这是一张什么图」 ────────────────

test('基本信息包含格式和尺寸', () => {
  const facts = imageFacts(PNG)
  assert.ok(facts.length >= 2, '至少要有格式和尺寸')
  assert.equal(facts[0], 'PNG')
  assert.match(facts[1], /^\d+×\d+ · \d+KB$/)
})

test('mediaType 优先于嗅探结果', () => {
  const facts = imageFacts(PNG, 'image/jpeg')
  assert.equal(facts[0], 'JPEG')
})

test('动图会被标出来', () => {
  // 造一个含两个 Graphic Control Extension 的假 GIF
  const gif = Buffer.concat([
    Buffer.from('GIF89a', 'binary'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00]),
  ])
  const facts = imageFacts(gif)
  assert.ok(facts.includes('动图'), '两张以上帧应该标成动图：' + JSON.stringify(facts))
})

test('静态图不会被误标成动图', () => {
  const facts = imageFacts(PNG)
  assert.equal(facts.includes('动图'), false)
})

test('空 buffer 不抛', () => {
  const facts = imageFacts(Buffer.from([]))
  assert.ok(Array.isArray(facts))
})

// ── describeImage：借模型描述，失败要有保底 ────────────────

test('正常返回时去掉首尾空白', async () => {
  const text = await describeImage(
    { ask: async () => '  一个蓝色头发的女孩，背景是白色。  ', log: { debug() {} } },
    { buf: PNG, mediaType: 'image/png', model: { provider: 'p', model: 'm' } },
  )
  assert.equal(text, '一个蓝色头发的女孩，背景是白色。')
})

test('把模型和图片都传给了 ask', async () => {
  let got = null
  await describeImage(
    { ask: async (o) => { got = o; return '描述' }, log: { debug() {} } },
    { buf: PNG, mediaType: 'image/png', model: { provider: 'p', model: 'm' } },
  )
  assert.deepEqual(got.model, { provider: 'p', model: 'm' })
  assert.equal(got.images.length, 1)
  assert.equal(got.images[0].mediaType, 'image/png')
  assert.ok(got.system.length > 0, '要有 system 提示词')
})

test('没指定模型时跟随默认（不传 model）', async () => {
  let got = null
  await describeImage(
    { ask: async (o) => { got = o; return '描述' }, log: { debug() {} } },
    { buf: PNG, mediaType: 'image/png' },
  )
  assert.equal(got.model, undefined)
})

test('ask 抛错时返回空串，不把异常甩给调用方', async () => {
  const text = await describeImage(
    { ask: async () => { throw new Error('模型挂了') }, log: { debug() {} } },
    { buf: PNG, mediaType: 'image/png' },
  )
  assert.equal(text, '')
})

test('空图不调用模型', async () => {
  let called = false
  const text = await describeImage(
    { ask: async () => { called = true; return 'x' }, log: { debug() {} } },
    { buf: Buffer.alloc(0), mediaType: 'image/png' },
  )
  assert.equal(text, '')
  assert.equal(called, false, '没图就不该花 token')
})
