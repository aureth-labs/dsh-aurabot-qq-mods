// 0.2.0 升级：六类分项开关、总开关契约、配置变更取消在途、私人数据边界。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, fakeFetch, jsonResponse, hangUntilAbort, OWNER_PRIVATE, GROUP, OTHER_PRIVATE } from './helpers.mjs'
import module from '../index.mjs'

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const KEY = 'qmk-fixture-0000-not-a-real-key'
const QQ_SETTINGS = { platform: 'qq', qqKey: KEY }

function setup({ settings = {}, routes = [] } = {}) {
  const fetch = fakeFetch(routes)
  const harness = createHarness({ fetch, settings })
  harness.mount()
  return { harness, fetch }
}

test('0.2.0 设置：保留旧五项，新增六个 switch，默认值符合约定', () => {
  assert.equal(module.version, '0.2.0')
  for (const key of ['platform', 'limit', 'shareForm', 'ownerOnly', 'qqKey']) {
    assert.ok(key in module.defaults, `旧设置 ${key} 必须保留`)
  }
  const switches = {
    recommendEnabled: true,
    searchEnabled: true,
    chartsEnabled: true,
    playlistEnabled: true,
    reportEnabled: false,
    interpretEnabled: false,
  }
  for (const [key, value] of Object.entries(switches)) {
    assert.equal(module.defaults[key], value, `${key} 默认值`)
    const setting = module.settings.find((item) => item.key === key)
    assert.equal(setting?.type, 'switch', `${key} 是 switch`)
    assert.match(setting.hint, /保存后|默认/, `${key} 提示应说明生效方式/默认值`)
  }
  assert.equal(module.defaults.ownerOnly, true)
  assert.equal(module.defaults.qqKey, '')
  // 总开关复用宿主 modules.<id>.enabled，不新增第二套同名设置
  assert.equal('enabled' in module.defaults, false)
  assert.equal(module.settings.some((item) => item.key === 'enabled'), false)
})

test('六类开关逐个关闭：入口直接拒绝，0 联网、0 发送', async () => {
  const cases = [
    { key: 'recommendEnabled', call: (h) => h.raw.recommend({ kind: 'scene', scene: '学习' }) },
    { key: 'searchEnabled', call: (h) => h.raw.search({ query: '晴天' }) },
    { key: 'chartsEnabled', call: (h) => h.raw.charts({}) },
    { key: 'playlistEnabled', call: (h) => h.raw.playlist({ action: 'detail', dissId: 9012001 }) },
    { key: 'reportEnabled', call: (h) => h.raw.report({ period: 'day' }) },
    { key: 'interpretEnabled', call: (h) => h.raw.interpret({ query: '分析我的听歌风格' }) },
  ]
  for (const item of cases) {
    const { harness, fetch } = setup({ settings: { ...QQ_SETTINGS, [item.key]: false } })
    const result = await item.call(harness)
    assert.equal(result.ok, false, item.key)
    assert.equal(result.code, 'feature-disabled', item.key)
    assert.match(result.message, /关闭/, item.key)
    assert.equal(fetch.calls.length, 0, `${item.key} 关闭后不许联网`)
    assert.equal(harness.sends.length, 0)
    await harness.dispose()
  }
})

test('旧挂载实例也绕不过开关：先取工具，再关设置，调用仍 0 请求', async () => {
  const { harness, fetch } = setup({ settings: QQ_SETTINGS })
  const tool = harness.tool('music_charts')
  harness.state.settings.chartsEnabled = false
  const result = await tool.execute({ action: 'groups' }, { sessionId: OWNER_PRIVATE.sessionId })
  assert.equal(result.ok, false)
  assert.match(result.message, /排行榜单.*关闭/)
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('重开开关后立即恢复：不需要重载模块', async () => {
  const { harness, fetch } = setup({
    settings: { ...QQ_SETTINGS, chartsEnabled: false },
    routes: [{ match: (url) => url.endsWith('/charts'), reply: jsonResponse(fixture('qq-charts.json')) }],
  })
  const off = await harness.call('music_charts', { action: 'groups' })
  assert.equal(off.ok, false)
  harness.state.settings.chartsEnabled = true
  const on = await harness.call('music_charts', { action: 'groups' })
  assert.equal(on.ok, true)
  assert.equal(fetch.calls.length, 1)
  await harness.dispose()
})

test('配置保存后取消该能力的在途请求（推荐）', async () => {
  const fetch = fakeFetch([{ match: (url) => url.includes('api/playlist/list'), reply: hangUntilAbort() }])
  const harness = createHarness({ fetch })
  harness.mount()
  const pending = harness.exports.recommend({ scene: '学习', chatId: OWNER_PRIVATE.chat.chatId })
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.state.settings.recommendEnabled = false
  harness.emitConfig({}, {})
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
  assert.equal(fetch.calls.length, 1, '取消后不许再发新请求')
  await harness.dispose()
})

test('总开关复用宿主卸载契约：dispose 后旧入口拒绝且取消在途', async () => {
  const fetch = fakeFetch([{ match: (url) => url.includes('api/playlist/list'), reply: hangUntilAbort() }])
  const harness = createHarness({ fetch })
  harness.mount()
  const tool = harness.tool('music_recommend')
  const pending = harness.exports.recommend({ scene: '学习', chatId: OWNER_PRIVATE.chat.chatId })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await harness.dispose()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
  const after = await tool.execute({ kind: 'scene', scene: '学习' }, { sessionId: OWNER_PRIVATE.sessionId })
  assert.equal(after.ok, false)
  assert.equal(fetch.calls.length, 1)
})

test('私人能力：群聊、别人私聊、混合轮、ownerOnly=false 都不放开', async () => {
  const cases = [
    { tool: 'music_report', args: { period: 'day' }, where: GROUP, ownerOnly: false },
    { tool: 'music_interpret', args: { query: '分析我的听歌风格' }, where: GROUP, ownerOnly: false },
    { tool: 'music_playlist', args: { action: 'ai' }, where: GROUP, ownerOnly: false },
    { tool: 'music_recommend', args: { kind: 'daily' }, where: GROUP, ownerOnly: false },
    { tool: 'music_report', args: { period: 'week' }, where: OTHER_PRIVATE, ownerOnly: false },
  ]
  for (const item of cases) {
    const { harness, fetch } = setup({ settings: { ...QQ_SETTINGS, reportEnabled: true, interpretEnabled: true, ownerOnly: item.ownerOnly } })
    harness.state.owner = item.where === OWNER_PRIVATE
    const result = await harness.call(item.tool, item.args, item.where)
    assert.equal(result.ok, false, item.tool)
    assert.match(result.message, /私人数据|主人私聊/, `${item.tool} 必须是 private-only`)
    assert.equal(fetch.calls.length, 0, `${item.tool} 不许联网`)
    await harness.dispose()
  }
})

test('主人私聊里 ownerOnly=false 也能用私人能力（只按私聊+主人判）', async () => {
  const { harness, fetch } = setup({
    settings: { ...QQ_SETTINGS, ownerOnly: false, reportEnabled: true },
    routes: [{ match: (url) => url.endsWith('/me/report'), reply: jsonResponse(fixture('qq-report-day.json')) }],
  })
  const result = await harness.call('music_report', { period: 'day' })
  assert.equal(result.ok, true)
  assert.equal(fetch.calls.length, 1)
  await harness.dispose()
})

test('报告返回前身份被撤：不返回私人数据', async () => {
  const fetch = fakeFetch([{
    match: (url) => url.endsWith('/me/report'),
    reply: () => {
      harness.state.owner = false
      return jsonResponse(fixture('qq-report-day.json'))
    },
  }])
  const harness = createHarness({ fetch, settings: { ...QQ_SETTINGS, reportEnabled: true } })
  harness.mount()
  const result = await harness.raw.report({ period: 'day' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'private-only')
  assert.doesNotMatch(result.message, /听歌时长|Top 歌手|周杰伦/)
  await harness.dispose()
})

test('命令也受开关与私聊限制：群里 /报告、/解读 不联网', async () => {
  const { harness, fetch } = setup({ settings: { ...QQ_SETTINGS, reportEnabled: true, interpretEnabled: true } })
  const report = await harness.command('报告', '日', { chatId: 'group:2002', kind: 'group', userId: '1001' })
  assert.match(report, /主人私聊/)
  const interpret = await harness.command('解读', '分析我的听歌风格', { chatId: 'group:2002', kind: 'group', userId: '1001' })
  assert.match(interpret, /主人私聊/)
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('命令受分项开关拦截：搜索/榜单关闭时 0 请求', async () => {
  const { harness, fetch } = setup({ settings: { ...QQ_SETTINGS, searchEnabled: false, chartsEnabled: false } })
  const search = await harness.command('搜歌', '晴天')
  assert.match(search, /已.*关闭|关闭/)
  const charts = await harness.command('榜单', '')
  assert.match(charts, /关闭/)
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('规则随开关变化：关闭的能力写进规则，私人范围明确', () => {
  const { harness } = setup({ settings: { ...QQ_SETTINGS, reportEnabled: false, interpretEnabled: false, chartsEnabled: false } })
  const rules = harness.rules().join('\n')
  assert.match(rules, /已在面板关闭的能力：.*排行榜单/)
  assert.match(rules, /听歌报告/)
  assert.match(rules, /主人私聊/)
  assert.match(rules, /每日推荐/)
})

test('导出方法同样受开关拦截（不走工具也不能绕过）', async () => {
  const { harness, fetch } = setup({ settings: { ...QQ_SETTINGS, chartsEnabled: false } })
  const result = await harness.exports.charts({ chatId: OWNER_PRIVATE.chat.chatId })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'feature-disabled')
  assert.equal(fetch.calls.length, 0)
  await harness.dispose()
})

test('六个分项开关关闭时，对应主人命令也 0 请求', async () => {
  const cases = [
    { key: 'recommendEnabled', command: '荐歌', arg: '学习' },
    { key: 'searchEnabled', command: '搜歌', arg: '晴天' },
    { key: 'chartsEnabled', command: '榜单', arg: '' },
    { key: 'playlistEnabled', command: '歌单', arg: 'AI' },
    { key: 'reportEnabled', command: '报告', arg: '日' },
    { key: 'interpretEnabled', command: '解读', arg: '分析我的听歌风格' },
  ]
  for (const item of cases) {
    const { harness, fetch } = setup({ settings: { ...QQ_SETTINGS, [item.key]: false } })
    const message = await harness.command(item.command, item.arg)
    assert.match(message, /关闭/, item.key)
    assert.equal(fetch.calls.length, 0, `${item.key} 命令关闭后不许联网`)
    await harness.dispose()
  }
})

test('旧挂载的六个工具都绕不过关闭：逐个 0 请求', async () => {
  const cases = [
    { key: 'recommendEnabled', tool: 'music_recommend', args: { kind: 'scene', scene: '学习' } },
    { key: 'searchEnabled', tool: 'music_search', args: { query: '晴天' } },
    { key: 'chartsEnabled', tool: 'music_charts', args: { action: 'groups' } },
    { key: 'playlistEnabled', tool: 'music_playlist', args: { action: 'detail', dissId: 9012001 } },
    { key: 'reportEnabled', tool: 'music_report', args: { period: 'day' } },
    { key: 'interpretEnabled', tool: 'music_interpret', args: { query: '分析我的听歌风格' } },
  ]
  for (const item of cases) {
    const { harness, fetch } = setup({ settings: QQ_SETTINGS })
    const tool = harness.tool(item.tool)
    harness.state.settings[item.key] = false
    const result = await tool.execute(item.args, { sessionId: OWNER_PRIVATE.sessionId })
    assert.equal(result.ok, false, item.key)
    assert.equal(fetch.calls.length, 0, item.key)
    await harness.dispose()
  }
})

test('ownerOnly=false：公共搜索/榜单对群里开放，私人报告仍拒绝', async () => {
  const fetch = fakeFetch([
    { match: 'api/cloudsearch/pc', reply: jsonResponse(fixture('netease-search.json')) },
    { match: (url) => url.endsWith('/charts'), reply: jsonResponse(fixture('qq-charts.json')) },
  ])
  const harness = createHarness({
    fetch,
    settings: { platform: 'netease', qqKey: KEY, ownerOnly: false, reportEnabled: true },
  })
  harness.mount()
  const search = await harness.call('music_search', { query: '晴天' }, GROUP)
  assert.equal(search.ok, true, '公共搜索对群里开放')
  const charts = await harness.call('music_charts', { action: 'groups' }, GROUP)
  assert.equal(charts.ok, true, '公共榜单对群里开放')
  const report = await harness.call('music_report', { period: 'day' }, GROUP)
  assert.equal(report.ok, false)
  assert.match(report.message, /主人私聊/)
  assert.equal(harness.sends.length, 0)
  await harness.dispose()
})
