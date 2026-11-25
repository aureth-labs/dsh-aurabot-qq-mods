import test from 'node:test'
import assert from 'node:assert/strict'
import pngjs from 'pngjs'
import { decodeImage, toGray, imageRaster, autoLevels, adjustTone, unsharp } from '../lib/image.mjs'
import { rasterCommand, buildReceiptBytes } from '../lib/escpos.mjs'

const { PNG } = pngjs

function makePng(width, height, pixels) {
  const png = new PNG({ width, height })
  pixels.forEach((color, i) => {
    png.data[i * 4] = color
    png.data[i * 4 + 1] = color
    png.data[i * 4 + 2] = color
    png.data[i * 4 + 3] = 255
  })
  return PNG.sync.write(png)
}

test('PNG 解码成 RGBA 并转灰度', () => {
  const png = makePng(2, 2, [0, 255, 255, 0])
  const image = decodeImage(png)
  assert.equal(image.width, 2)
  assert.equal(image.height, 2)
  const gray = toGray(image)
  assert.deepEqual([...gray.gray], [0, 255, 255, 0])
})

test('图片按纸宽缩放并打包成 1bpp', () => {
  // 3x2：第一行黑白黑，第二行白白黑
  const png = makePng(3, 2, [0, 255, 0, 255, 255, 0])
  const raster = imageRaster(png, { maxWidthDots: 3, maxHeightDots: 2, dither: false })
  assert.equal(raster.width, 3)
  assert.equal(raster.height, 2)
  assert.equal(raster.data.length, 2)
  assert.equal(raster.data[0], 0b10100000)
  assert.equal(raster.data[1], 0b00100000)
})

test('图片按最大高度等比缩小', () => {
  const png = makePng(4, 10, new Array(40).fill(128))
  const raster = imageRaster(png, { maxWidthDots: 40, maxHeightDots: 20, dither: false })
  assert.equal(raster.height, 20)
  assert.equal(raster.width, 8)
})

test('autoLevels 把低对比度拉到满幅，纯色图不动', () => {
  const flat = autoLevels(Uint8Array.from([100, 100, 150, 150]))
  assert.deepEqual([...flat], [0, 0, 255, 255])

  const solid = Uint8Array.from([128, 128, 128, 128])
  assert.deepEqual([...autoLevels(solid)], [128, 128, 128, 128])
})

test('adjustTone 的伽马提亮暗部，对比度拉开明暗', () => {
  const source = Uint8Array.from([64, 128, 192])
  const brightened = adjustTone(source, { gamma: 2 })
  assert.ok(brightened[0] > 64, '暗部应该变亮')
  assert.ok(brightened[1] > 128)

  const contrasted = adjustTone(Uint8Array.from([100, 156]), { contrast: 100 })
  assert.ok(contrasted[0] < 100)
  assert.ok(contrasted[1] > 156)
})

test('unsharp 让边缘更分明，纯色图不变', () => {
  const edge = Uint8Array.from([0, 0, 0, 255, 255, 255])
  const sharpened = unsharp(edge, 6, 1)
  assert.deepEqual([...sharpened], [...edge], '高度不足 3 时原样返回')

  const rows = new Uint8Array(9 * 9).fill(128)
  for (let y = 0; y < 9; y++) for (let x = 5; x < 9; x++) rows[y * 9 + x] = 220
  const out = unsharp(rows, 9, 9, { amount: 1 })
  assert.ok(out[4 * 9 + 4] < 128, '边缘亮侧旁的暗侧应更暗')
  assert.ok(out[4 * 9 + 5] > 220, '边缘应更亮')
})

test('imageRaster 会先调色再打包', () => {
  // 低对比度灰图，自动色阶后应出现黑白点，而不是全白
  const png = makePng(4, 4, [100, 100, 150, 150, 100, 100, 150, 150, 100, 100, 150, 150, 100, 100, 150, 150])
  const raster = imageRaster(png, { maxWidthDots: 4, maxHeightDots: 4, dither: false })
  assert.equal(raster.width, 4)
  assert.ok(raster.data.some((byte) => byte !== 0), '调色后不应是纯白')
  assert.ok(raster.data.some((byte) => byte !== 0xff), '也不应是纯黑')
})

test('rasterCommand 生成 GS v 0 头，并把不足一行的位补齐', () => {
  const command = rasterCommand({ width: 10, height: 3, data: Buffer.from([0xff, 0xff, 0xff]) })
  assert.deepEqual([...command.subarray(0, 8)], [0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x02])
  assert.equal(command[8], 0x00)
  assert.equal(command[9], 0x03, 'yL')
  assert.equal(command[10], 0x00, 'yH')
  assert.equal(command.length, 3 + 8 + 2 * 3 + 1 + 3)
})

test('buildReceiptBytes 把图片放在文字之后、切纸之前', () => {
  const raster = { width: 8, height: 1, data: Buffer.from([0xff]) }
  const bytes = buildReceiptBytes([{ text: '正文' }], {
    encoding: 'utf8',
    cut: 'partial',
    images: [raster],
  })
  const text = bytes.toString('utf8')
  assert.ok(text.indexOf('正文') < text.indexOf('\x1dv0'))
  assert.ok(text.indexOf('\x1dv0') < text.indexOf('\x1dV'))
})
