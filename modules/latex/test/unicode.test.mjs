// Unicode 数学符号 → LaTeX：手打的 x²、√2、∫₀¹、α+β 都该认。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasUnicodeMath, unicodeToLatex } from '../lib/unicode.mjs'

test('上标攒成一组', () => {
  assert.equal(unicodeToLatex('x²'), 'x^{2}')
  assert.equal(unicodeToLatex('x²³'), 'x^{23}')
  assert.equal(unicodeToLatex('e⁻ˣ'), 'e^{-x}')
  assert.equal(unicodeToLatex('2²+3²'), '2^{2}+3^{2}')
})

test('下标也攒成一组', () => {
  assert.equal(unicodeToLatex('a₀'), 'a_{0}')
  assert.equal(unicodeToLatex('H₂O'), 'H_{2}O')
  assert.equal(unicodeToLatex('∫₀¹'), '\\int_{0}^{1}')
})

test('根号按后面的东西包', () => {
  assert.equal(unicodeToLatex('√2'), '\\sqrt{2}')
  assert.equal(unicodeToLatex('√x'), '\\sqrt{x}')
  assert.equal(unicodeToLatex('√(x+1)'), '\\sqrt{x+1}')
  assert.equal(unicodeToLatex('√(a+(b+c))'), '\\sqrt{a+(b+c)}')
  assert.equal(unicodeToLatex('√\\pi'), '\\sqrt{\\pi}')
})

test('希腊字母和运算符', () => {
  assert.equal(unicodeToLatex('α+β'), '\\alpha+\\beta')
  assert.equal(unicodeToLatex('πr²'), '\\pi r^{2}')
  assert.equal(unicodeToLatex('a×b÷c'), 'a\\times b\\div c')
  assert.equal(unicodeToLatex('x≠y'), 'x\\neq y')
  assert.equal(unicodeToLatex('a≤b≥c'), 'a\\leq b\\geq c')
  assert.equal(unicodeToLatex('n→∞'), 'n\\to\\infty')
})

test('已经是 LaTeX 的不动', () => {
  assert.equal(unicodeToLatex('\\frac{1}{2}'), '\\frac{1}{2}')
  assert.equal(unicodeToLatex('x^2'), 'x^2')
  assert.equal(unicodeToLatex('\\alpha'), '\\alpha')
})

test('中文原样留着，交给上层判断', () => {
  assert.equal(unicodeToLatex('面积 πr²'), '面积 \\pi r^{2}')
})

test('有没有能转的东西', () => {
  assert.equal(hasUnicodeMath('x²'), true)
  assert.equal(hasUnicodeMath('π'), true)
  assert.equal(hasUnicodeMath('√2'), true)
  assert.equal(hasUnicodeMath('x^2'), false)
  assert.equal(hasUnicodeMath('今天吃啥'), false)
})
