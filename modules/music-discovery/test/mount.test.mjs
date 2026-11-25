// 挂载：工具与规则列得出来、/搜歌 /荐歌 能走通、卸载时清缓存并在途请求被取消。
// 自然语言里她会不会真的调工具，属于宿主验收，这里不假装验过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, hangUntilAbort, OWNER_PRIVATE } from './helpers.mjs'
import module from '../index.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))

function setup(settings = {}) {
  const fetch = fakeFetch([
    { match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) },
    {
      match: (url) => url.includes('api/playlist/list'),
      reply: jsonResponse(fixture('netease-playlists.json')),
    },
    {
      match: (url) => url.includes('api/v6/playlist/detail'),
      reply: (url, init) => {
        const id = new URLSearchParams(String(init?.body || '')).get('id')
        const detail = fixture('netease-detail.json')
        if (id === '111') return jsonResponse({ result: detail.playlist })
        if (id === '3778678') return jsonResponse({ result: detail.chart })
        return jsonResponse({ result: detail.playlist222 })
      },
    },
  ])
  const harness = createHarness({ fetch, settings })
  harness.mount()
  return { harness, fetch }
}

test('模块定义：id/version/api 与 module.json 一致', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'module.json'), 'utf8'))
  assert.equal(module.id, manifest.id)
  assert.equal(module.version, manifest.version)
  assert.equal(module.api, manifest.api)
  assert.equal(typeof module.setup, 'function')
  assert.equal(manifest.requires.includes('song'), false)
})

test('挂载后能列出七个工具和动态规则', () => {
  const { harness } = setup()
  const names = harness.tools().map((tool) => tool.name)
  // 0.2.0 在原有三个工具上增加榜单/歌单/报告/解读；旧名称保持不变
  assert.deepEqual(names, [
    'music_search',
    'music_recommend',
    'music_charts',
    'music_playlist',
    'music_report',
    'music_interpret',
    'music_share',
  ])
  for (const tool of harness.tools()) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.description.length > 20, true)
  }

  const rules = harness.rules().join('\n')
  assert.match(rules, /music_search/)
  assert.match(rules, /不要凭记忆编歌名/)
  assert.match(rules, /翻唱/)
  assert.match(rules, /\/搜歌/)
  assert.match(rules, /还没配置 Key/)
})

test('规则随设置变化：填了 Key、关掉 ownerOnly 说法跟着变', () => {
  const { harness } = setup({ qqKey: 'qmk-fixture-0000-not-a-real-key', ownerOnly: false })
  const rules = harness.rules().join('\n')
  assert.match(rules, /已配置 Key/)
  assert.match(rules, /群里别人也能让你搜歌/)
  assert.doesNotMatch(rules, /还没配置 Key/)
})

test('工具生成函数：system 会话不给工具', () => {
  const { harness } = setup()
  const tools = harness.tools({ chat: { chatId: 'system:x', kind: 'system' }, level: 'chat', sessionId: 's-sys' })
  assert.equal(tools.length, 0)
})

test('/搜歌 在 mock 里返回真实查询结构（编号 + 链接 + 来源）', async () => {
  const { harness } = setup()
  const text = await harness.command('搜歌', '晴天 周杰伦')
  assert.equal(typeof text, 'string')
  assert.match(text, /^网易云 · 搜「晴天 周杰伦」/)
  assert.match(text, /1\. /)
  assert.match(text, /https:\/\/music\.163\.com\/song\?id=/)
  assert.match(text, /来源：网易云搜索/)
})

test('/搜歌 不带参数给用法；/搜歌 空结果如实说', async () => {
  const { harness } = setup()
  assert.match(await harness.command('搜歌', ''), /用法：\/搜歌/)

  const emptyFetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: jsonResponse({ code: 200, result: { songs: [] } }) }])
  const emptyHarness = createHarness({ fetch: emptyFetch })
  emptyHarness.mount()
  assert.match(await emptyHarness.command('搜歌', '没有这首歌xyz'), /没搜到/)
})

test('/荐歌 在 mock 里返回真实歌单候选；不带参数给热歌榜', async () => {
  const { harness } = setup()
  const text = await harness.command('荐歌', '学习')
  assert.match(text, /^网易云 · 「学习\/专注」挑了 3 首/)
  assert.match(text, /来源：/)

  const chartText = await harness.command('荐歌', '')
  assert.match(chartText, /热歌榜|挑了/)
})

test('/搜歌 结果能接着被「第几首」分享（命令与工具共用同一份聊天缓存）', async () => {
  const { harness } = setup()
  await harness.command('搜歌', '晴天')
  const shared = await harness.call('music_share', { index: 2 })
  assert.equal(shared.ok, true)
  assert.equal(harness.sends.length, 1)
  assert.equal(harness.sends[0].chatId, OWNER_PRIVATE.chat.chatId)
})

test('卸载：缓存清空、在途请求被取消', async () => {
  const fetch = fakeFetch([{ match: 'api/cloudsearch/pc', reply: hangUntilAbort() }])
  const harness = createHarness({ fetch })
  harness.mount()

  const pending = harness.call('music_search', { query: '晴天' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await harness.dispose()
  const result = await pending

  assert.equal(result.ok, false)
  assert.match(result.message, /取消|卸载/)
  assert.equal(harness.exports.cacheSize(), 0)
})

test('卸载后再调用不会发请求', async () => {
  const { harness, fetch } = setup()
  const before = fetch.calls.length
  await harness.dispose()
  const result = await harness.call('music_search', { query: '晴天' })
  assert.equal(result.ok, false)
  assert.match(result.message, /卸载/)
  assert.equal(fetch.calls.length, before)
})
