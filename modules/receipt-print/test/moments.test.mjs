import test from 'node:test'
import assert from 'node:assert/strict'
import { pickNewMoments, extractImageSources, timeOf } from '../lib/moments.mjs'

test('timeOf 支持毫秒、秒和 ISO 字符串', () => {
  assert.equal(timeOf(1700000000000), 1700000000000)
  assert.equal(timeOf(1700000000), 1700000000000)
  assert.equal(timeOf('2026-11-20T10:00:00.000Z'), Date.parse('2026-11-20T10:00:00.000Z'))
  assert.equal(timeOf(''), 0)
  assert.equal(timeOf('不是时间'), 0)
})

test('pickNewMoments 只挑新的，按时间从旧到新', () => {
  const base = 1700000000000
  const list = [
    { at: base + 3000, text: '第三条' },
    { at: base + 1000, text: '第一条' },
    { at: base + 2000, text: '第二条' },
  ]
  const result = pickNewMoments(list, base + 1500)
  assert.deepEqual(result.rows.map((r) => r.text), ['第二条', '第三条'])
  assert.equal(result.watermark, base + 3000)
})

test('pickNewMoments 跳过仅自己可见，但 watermark 仍推进', () => {
  const base = 1700000000000
  const list = [
    { at: base + 1000, text: '公开', visibility: 'public' },
    { at: base + 2000, text: '自己', visibility: 'self' },
  ]
  const skipped = pickNewMoments(list, base + 500)
  assert.deepEqual(skipped.rows.map((r) => r.text), ['公开'])
  assert.equal(skipped.watermark, base + 2000)

  const included = pickNewMoments(list, base + 500, { includeSelf: true })
  assert.deepEqual(included.rows.map((r) => r.text), ['公开', '自己'])
})

test('extractImageSources 收集字段、Markdown 和图片直链', () => {
  const row = {
    text: '看图 ![a](https://cdn.example.com/a.png) 还有 https://cdn.example.com/b.jpg?x=1',
    images: ['https://cdn.example.com/c.png', { url: 'https://cdn.example.com/d.jpg' }],
    pics: 'https://cdn.example.com/e.png',
  }
  const sources = extractImageSources(row)
  assert.ok(sources.includes('https://cdn.example.com/a.png'))
  assert.ok(sources.includes('https://cdn.example.com/b.jpg?x=1'))
  assert.ok(sources.includes('https://cdn.example.com/c.png'))
  assert.ok(sources.includes('https://cdn.example.com/d.jpg'))
  assert.ok(sources.includes('https://cdn.example.com/e.png'))
  assert.equal(new Set(sources).size, sources.length)
})
