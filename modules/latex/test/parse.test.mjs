// 纯函数测试：认出公式、整句判断、括号检查。不联网。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TRIGGERS, cutAroundTrigger, extractFormulas, hasTrigger, looksLikeLatex, parseTriggers, stripTrigger, validateLatex } from '../lib/parse.mjs'

test('认出 $$ 和 $ 两种写法', () => {
  const { formulas } = extractFormulas('给我画 $$a^2+b^2=c^2$$ 和 $x=1$')
  assert.deepEqual(formulas.map((f) => f.latex), ['a^2+b^2=c^2', 'x=1'])
  assert.equal(formulas[0].display, true)
  assert.equal(formulas[1].display, false)
})

test('认出 \\[ … \\] 和 \\( … \\)', () => {
  const { formulas } = extractFormulas('\\[\\frac{1}{2}\\] 还有 \\(\\sqrt{3}\\)')
  assert.deepEqual(formulas.map((f) => f.latex), ['\\frac{1}{2}', '\\sqrt{3}'])
  assert.equal(formulas[0].display, true)
  assert.equal(formulas[1].display, false)
})

test('$$ 不会被当成两个 $', () => {
  const { formulas } = extractFormulas('$$x$$')
  assert.equal(formulas.length, 1)
  assert.equal(formulas[0].latex, 'x')
})

test('转义的 \\$ 不算公式开头', () => {
  const { formulas } = extractFormulas('价格 \\$5 不画')
  assert.equal(formulas.length, 0)
})

test('没闭合的 $ 不吞掉后面的字', () => {
  const { formulas, rest } = extractFormulas('只有一个 $ 符号')
  assert.equal(formulas.length, 0)
  assert.match(rest, /只有一个/)
})

test('去掉公式后剩下的字还在', () => {
  const { rest } = extractFormulas('这个 $a+b$ 对吗')
  assert.equal(rest, '这个 对吗')
})

test('空公式不推给渲染服务', () => {
  const { formulas } = extractFormulas('$$$$')
  assert.equal(formulas.length, 0)
})

test('带命令或上下标才当公式', () => {
  assert.equal(looksLikeLatex('\\frac{1}{2}'), true)
  assert.equal(looksLikeLatex('x^2+y^2=1'), true)
  assert.equal(looksLikeLatex('a_n'), true)
  assert.equal(looksLikeLatex('3+5=8'), false)
  assert.equal(looksLikeLatex('今天吃了什么'), false)
  assert.equal(looksLikeLatex('这个 x^2 怎么算'), false)
})

test('\\text{} 里的中文不算中文', () => {
  assert.equal(looksLikeLatex('\\text{面积} = \\pi r^2'), true)
})

test('「渲染 x^2」这种口令会被剥掉', () => {
  assert.equal(stripTrigger('渲染 x^2'), 'x^2')
  assert.equal(stripTrigger('latex: \\frac{1}{2}'), '\\frac{1}{2}')
  assert.equal(stripTrigger('x^2'), 'x^2')
})

test('括号检查', () => {
  assert.equal(validateLatex('\\frac{1}{2}'), '')
  assert.match(validateLatex('\\frac{1'), /少了一个/)
  assert.match(validateLatex('x}'), /多了一个/)
  assert.equal(validateLatex('x +'), '')
  assert.match(validateLatex('x \\'), /没写完的命令/)
  assert.match(validateLatex('   '), /空的/)
  assert.equal(validateLatex('\\{a\\}'), '')
})

test('触发词能自己配', () => {
  assert.equal(hasTrigger('把公式渲染一下', ''), true)
  assert.equal(hasTrigger('帮我 latex 一下', ''), true)
  assert.equal(hasTrigger('帮我画画这个', '画画'), true)
  assert.equal(hasTrigger('帮我画画这个', '公式'), false)
  assert.deepEqual(parseTriggers('a, b，c；d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseTriggers('   '), DEFAULT_TRIGGERS)
})

test('触发词不在开头也能切出公式', () => {
  assert.equal(cutAroundTrigger('把公式渲染一下 x^2+1', ''), 'x^2+1')
  assert.equal(cutAroundTrigger('帮我渲染一下这个 \\frac{1}{2}', ''), '\\frac{1}{2}')
  assert.equal(cutAroundTrigger('x^2', ''), 'x^2')
  assert.equal(cutAroundTrigger('渲染一下这个', ''), '')
})
