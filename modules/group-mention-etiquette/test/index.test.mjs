import test from 'node:test'
import assert from 'node:assert/strict'
import mod from '../index.mjs'

let decide
mod.setup({ on(event, fn) { assert.equal(event, 'group/decide'); decide = fn } })
const other = { atOthers: true, mentioned: false }
for (const mode of ['engaged', 'interject']) {
  test(`${mode}：仅旁听明确 @ 别人的消息`, () => {
    const original = Object.freeze({ reply: true, mode, reason: '原判断', extra: 1 })
    assert.deepEqual(decide(original, { msg: other }), { ...original, reply: false, mode: 'none', reason: '这条在 @ 别人，旁听' })
    for (const msg of [{ ...other, mentioned: true }, { atOthers: false }, { text: '@甲 真的假的？' }]) {
      assert.equal(decide(original, { msg }), undefined)
    }
  })
}
test('不碰明确唤醒、已有拒绝和其他模块的自定义决定', () => {
  for (const [reply, mode] of [[true, 'must'], [false, 'none'], [false, 'engaged'], [true, 'custom']]) {
    assert.equal(decide({ reply, mode }, { msg: other }), undefined)
  }
})
