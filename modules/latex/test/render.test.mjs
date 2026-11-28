// 整条链路：LaTeX → SVG → PNG。要 mathjax-full（先 npm install）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

// 没装依赖时不要红一片，直接跳过（CI 和本地 npm install 之后会真的跑）。
// 这里用动态 import：render.mjs 顶上就 import 了 mathjax-full，静态引入会让整个测试文件加载失败。
let renderLatexPng = null
try {
  ;({ renderLatexPng } = await import('../lib/render.mjs'))
} catch {
  renderLatexPng = null
}

const todo = renderLatexPng
  ? test
  : (name, fn) => test(name, { skip: '没装 mathjax-full，先 npm install' }, fn)

const PNG_MAGIC = '89 50 4e 47 0d 0a 1a 0a'
const magicOf = (buf) => [...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')

todo('画得出来，而且是张 PNG', () => {
  const r = renderLatexPng('x^2+y^2=1', { fontSize: 40 })
  assert.equal(r.ok, true, r.error)
  assert.equal(magicOf(r.png), PNG_MAGIC)
  assert.ok(r.width > 60, `图太窄：${r.width}`)
  assert.ok(r.height > 15, `图太矮：${r.height}`)
})

todo('字号变大，图也变大', () => {
  const small = renderLatexPng('a+b', { fontSize: 24 })
  const big = renderLatexPng('a+b', { fontSize: 72 })
  assert.equal(small.ok, true, small.error)
  assert.equal(big.ok, true, big.error)
  assert.ok(big.width > small.width * 2)
})

todo('分式、根号、上下标都排得出来', () => {
  const r = renderLatexPng('\\frac{a+b}{c} = \\sqrt{x^2+y^2}', { fontSize: 40 })
  assert.equal(r.ok, true, r.error)
})

todo('缺括号会报错，不画错误图', () => {
  const r = renderLatexPng('\\frac{1}{2', { fontSize: 40 })
  assert.equal(r.ok, false)
  assert.match(r.error, /公式/)
})

todo('不认识的命令也算失败', () => {
  const r = renderLatexPng('\\thiscommanddoesnotexist{x}', { fontSize: 40 })
  assert.equal(r.ok, false)
})

todo('空公式直接拒绝', () => {
  const r = renderLatexPng('   ', { fontSize: 40 })
  assert.equal(r.ok, false)
})
