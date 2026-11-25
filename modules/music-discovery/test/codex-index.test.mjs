// Codex验收补丁：序号必须是整数，不能截断1.9后发送第1首。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeFetch, jsonResponse } from './helpers.mjs'

function mount(songs) {
  const h = createHarness({ fetch: fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse({ code: 200, result: { songs } }) }]) })
  h.mount()
  return h
}
const first = { id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], originCoverType: 1 }
const second = { id: 1412022124, name: '晴天', ar: [{ name: '空匪' }], originCoverType: 1 }

test('Codex：唯一候选的小数序号拒绝且0发送，整数序号仍正常', async () => {
  const h = mount([first])
  try {
    await h.raw.search({ query: '晴天' })
    for (const index of [1.9, '1.9', 0.9]) {
      const r = await h.raw.share({ index })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'bad-index')
      assert.equal(h.sends.length, 0)
    }
    const ok = await h.raw.share({ index: 1 })
    assert.equal(ok.ok, true)
    assert.equal(h.sends.length, 1)
  } finally { await h.dispose() }
})

test('Codex：待选择的小数序号继续待选，合法整数才发送指定候选', async () => {
  const h = mount([first, second])
  try {
    await h.raw.search({ query: '晴天' })
    const bad = await h.raw.share({ index: 1.9 })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'needs-choice')
    assert.equal(h.sends.length, 0)
    const good = await h.raw.share({ index: 2 })
    assert.equal(good.ok, true)
    assert.equal(h.sends.length, 1)
    assert.match(h.sends[0].text, /空匪/)
  } finally { await h.dispose() }
})
