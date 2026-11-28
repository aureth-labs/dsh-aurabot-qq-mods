// 光栅化和 PNG 编码。纯本地计算，不依赖 MathJax。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { encodePng } from '../lib/png.mjs'
import { parseColor, parseXml, pathRings, rasterizeSvg } from '../lib/raster.mjs'

const PNG_MAGIC = '89 50 4e 47 0d 0a 1a 0a'

test('XML 能认出嵌套和自闭合标签', () => {
  const tree = parseXml('<svg viewBox="0 0 10 10"><g fill="red"><path d="M0 0"/><use xlink:href="#a"/></g></svg>')
  const svg = tree.children[0]
  assert.equal(svg.tag, 'svg')
  assert.equal(svg.attrs.viewbox, '0 0 10 10')
  assert.equal(svg.children[0].tag, 'g')
  assert.deepEqual(svg.children[0].children.map((c) => c.tag), ['path', 'use'])
})

test('属性里的 > 不会把标签切断', () => {
  const tree = parseXml('<svg data-x="a>b"><rect width="5"/></svg>')
  assert.equal(tree.children[0].children[0].attrs.width, '5')
})

test('path 拆成折线，Z 会闭合', () => {
  const rings = pathRings('M0 0 L10 0 L10 10 Z')
  assert.equal(rings.length, 1)
  // 三个顶点 + 闭合回起点 = 4 个点
  assert.equal(rings[0].length, 8)
  assert.deepEqual(rings[0].slice(0, 2), [0, 0])
  assert.deepEqual(rings[0].slice(-2), [0, 0])
})

test('曲线会被拆成多段，不再是两个点', () => {
  const rings = pathRings('M0 0 Q5 10 10 0')
  assert.ok(rings[0].length > 6)
})

test('transform 会作用到点上', () => {
  const rings = pathRings('M0 0 L10 0 L10 10 Z', [2, 0, 0, 2, 0, 0])
  assert.deepEqual(rings[0].slice(2, 4), [20, 0])
})

test('矩形填满上半边，下半边留白', () => {
  const svg = '<svg viewBox="0 0 1000 1000"><rect x="0" y="0" width="1000" height="500"/></svg>'
  const img = rasterizeSvg(svg, { pxPerEm: 10, background: 'white' })
  assert.equal(img.width, 10)
  assert.equal(img.height, 10)
  const at = (x, y) => {
    const p = (y * img.width + x) * 4
    return [img.rgba[p], img.rgba[p + 1], img.rgba[p + 2], img.rgba[p + 3]]
  }
  assert.deepEqual(at(2, 2), [0, 0, 0, 255]) // 上半边是黑的
  assert.deepEqual(at(2, 8), [255, 255, 255, 255]) // 下半边是白底
})

test('透明背景时白处 alpha 为 0', () => {
  const svg = '<svg viewBox="0 0 1000 1000"><rect x="0" y="0" width="500" height="500"/></svg>'
  const img = rasterizeSvg(svg, { pxPerEm: 10, background: 'transparent' })
  assert.equal(img.rgba[3], 255) // 左上角有墨
  assert.equal(img.rgba[(9 * img.width + 9) * 4 + 3], 0) // 右下角空
})

test('use 会引用 defs 里的字形', () => {
  const svg =
    '<svg viewBox="0 0 1000 1000"><defs><path id="a" d="M0 0 L500 0 L500 500 L0 500 Z"/></defs>' +
    '<g><use xlink:href="#a"/></g></svg>'
  const img = rasterizeSvg(svg, { pxPerEm: 10, background: 'white' })
  assert.equal(img.rgba[0], 0) // 左上被字形盖住
  assert.equal(img.rgba[(9 * img.width + 9) * 4], 255) // 右下还是白
})

test('颜色和兜底', () => {
  assert.deepEqual(parseColor('#f00'), [255, 0, 0])
  assert.deepEqual(parseColor('#FF6600'), [255, 102, 0])
  assert.deepEqual(parseColor('blue'), [0, 0, 255])
  assert.deepEqual(parseColor('这不是颜色', [1, 2, 3]), [1, 2, 3])
})

test('PNG 编码出来是张真 PNG', () => {
  const rgba = new Uint8Array(4 * 3 * 4).fill(200)
  const png = encodePng(4, 3, rgba)
  assert.equal([...png.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' '), PNG_MAGIC)
  // 第 16 字节起是宽高（IHDR）
  assert.equal(png.readUInt32BE(16), 4)
  assert.equal(png.readUInt32BE(20), 3)
  assert.ok(png.length > 40)
})
