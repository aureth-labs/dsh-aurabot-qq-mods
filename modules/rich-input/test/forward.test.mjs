// 合并转发：收消息时预拉并缓存；展开时一条占位对一条转发，不重复、不串台。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, forwardSeg, textBlock, info, msgWith, forwardNode, allText } from './harness.mjs'

const NODES = [forwardNode('甲', '111', '第一句正文'), forwardNode('乙', '222', '第二句正文')]

test('收到转发就预拉并缓存，展开时直接用缓存', async () => {
  const h = makeHarness({
    onCall: async (action) => action === 'get_forward_msg' ? { messages: NODES } : {}
  })
  await h.message(msgWith('m1', [forwardSeg('fid-1')]))
  // 预拉是 .then，不 await 消息钩子；让微任务跑一下
  await new Promise((r) => setTimeout(r, 0))

  const out = await h.prompt([textBlock('[合并转发]')], info())
  assert.match(allText(out), /甲\(111\):第一句正文/)
  assert.match(allText(out), /乙\(222\):第二句正文/)
  // 预拉拉过一次，展开就用缓存，不该再拉第二遍
  const pulls = h.calls.call.filter((c) => c.action === 'get_forward_msg')
  assert.equal(pulls.length, 1)
})

test('一条消息里两个 [合并转发]：各展各的，不重复不串台', async () => {
  const h = makeHarness({
    onCall: async (action, params) => {
      if (action !== 'get_forward_msg') return {}
      return { messages: params.id === 'fid-A' ? [forwardNode('甲', '111', 'AAA 正文')] : [forwardNode('乙', '222', 'BBB 正文')] }
    }
  })
  await h.message(msgWith('m1', [forwardSeg('fid-A'), forwardSeg('fid-B')]))
  await new Promise((r) => setTimeout(r, 0))

  const out = await h.prompt([textBlock('[合并转发] \n [合并转发]')], info())
  const text = allText(out)
  // 两条转发都展开，各自只出现一次，内容不串台
  assert.equal((text.match(/AAA 正文/g) || []).length, 1)
  assert.equal((text.match(/BBB 正文/g) || []).length, 1)
  assert.doesNotMatch(text, /甲\(111\):AAA 正文[\s\S]*甲\(111\):AAA 正文/, '同一条不该复制两遍')
})

test('已经展开过的 [合并转发]{...} 不再二次展开', async () => {
  const h = makeHarness({
    onCall: async (action) => action === 'get_forward_msg' ? { messages: NODES } : {}
  })
  await h.message(msgWith('m1', [forwardSeg('fid-1')]))
  await new Promise((r) => setTimeout(r, 0))

  const already = '[合并转发]{甲(111):第一句正文;}'
  const out = await h.prompt([textBlock(already)], info())
  assert.equal(out, undefined, '带 { 的占位符算已展开，模块不碰')
})
