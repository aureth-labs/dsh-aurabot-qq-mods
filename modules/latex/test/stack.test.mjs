// 拼图：多张公式竖着合成一张，居中、留间距、背景统一。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stackImages } from '../lib/stack.mjs'

/** 造一张纯色小图，方便数位置。 */
function block(width, height, value) {
  const rgba = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) rgba.set([value, value, value, 255], p * 4)
  return { width, height, rgba }
}

const pixelAt = (img, x, y) => {
  const p = (y * img.width + x) * 4
  return img.rgba[p]
}

test('只有一张时原样返回', () => {
  const one = block(10, 4, 7)
  assert.equal(stackImages([one]), one)
})

test('高度是几张加起来再加间距', () => {
  const merged = stackImages([block(10, 4, 1), block(10, 6, 2)], { gap: 3 })
  assert.equal(merged.width, 10)
  assert.equal(merged.height, 4 + 3 + 6)
})

test('宽度取最大的，窄的居中', () => {
  const merged = stackImages([block(20, 2, 1), block(10, 2, 2)], { gap: 0 })
  assert.equal(merged.width, 20)
  assert.equal(merged.height, 4)
  assert.equal(pixelAt(merged, 0, 0), 1) // 第一张铺满
  assert.equal(pixelAt(merged, 0, 2), 255) // 第二张只有 10 宽，左右各留 5，露出来的是底色
  assert.equal(pixelAt(merged, 5, 2), 2)
  assert.equal(pixelAt(merged, 14, 2), 2)
  assert.equal(pixelAt(merged, 15, 2), 255)
})

test('间距用底色填满', () => {
  const merged = stackImages([block(4, 2, 1), block(4, 2, 1)], { gap: 2, fill: [9, 9, 9, 255] })
  assert.equal(pixelAt(merged, 0, 2), 9)
  assert.equal(pixelAt(merged, 0, 3), 9)
})

test('空数组给 null', () => {
  assert.equal(stackImages([]), null)
  assert.equal(stackImages(null), null)
})
