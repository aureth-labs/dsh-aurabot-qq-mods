import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClicker } from '../lib/room/click.mjs'

// 行为测试（不是源码正则）：验证“命中校验/点击”用的是**选中的那个候选**的原始序号，
// 而不是永远 0 号。候选顺序 [大(index0), 小(index1)]，按面积升序后选中的是“小”=index1。
test('clickOnce/prepare 用选中候选的原始序号做命中（F12）', async () => {
  let hitPick = null
  const evalJs = async (code) => {
    if (/pickEl/.test(code)) {
      const m = /\((\d+)\)\s*$/.exec(String(code))
      hitPick = m ? Number(m[1]) : -1
      return { ok: true, points: Array.from({ length: 9 }, () => ({ x: 5, y: 5, ok: true })) }
    }
    return {
      total: 2,
      list: [
        { text: '按钮B', sig: 'sb', area: 400, rect: { left: 10, top: 10, width: 20, height: 20, right: 30, bottom: 30 } },
        { text: '按钮A', sig: 'sa', area: 100, rect: { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 } },
      ],
    }
  }
  const c = createClicker({ evalJs, send: async () => {}, sleep: async () => {}, note: () => {} })
  const r = await c.prepare({ label: '测试', spec: { text: '按钮' }, allowMultiple: true, tries: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.cand.text, '按钮A')
  assert.equal(hitPick, 1, '应按原始候选序号 1 命中，而不是 0')
})
