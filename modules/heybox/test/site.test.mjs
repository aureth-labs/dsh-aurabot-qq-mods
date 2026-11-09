import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, defer, ok } from './helpers.mjs'
import { isPeakTime, linkIdOf, normalizeCookie, today } from '../lib/site.mjs'
import { AUTH_STATUS } from '../lib/api.mjs'

// 固定东八区，让本地午夜和 UTC 日期不同，能检出 UTC 重置的回归。
process.env.TZ = 'Asia/Shanghai'

const feed = async (url) => {
  assert.equal(url.pathname, '/bbs/app/feeds')
  return ok({ links: [{ linkid: '123456', title: '游戏' }] })
}

test('hasLogin 认 pkey 和 user_pkey，自动逛额度和 lastRun 落盘', async (t) => {
  const f = fixture({ fetcher: feed })
  t.after(() => f.close())
  assert.equal(f.hb.hasLogin(), true)
  f.cfg.heybox.cookie = 'user_pkey=abc'
  assert.equal(f.hb.hasLogin(), true)
  f.cfg.heybox.cookie = 'pkey='
  assert.equal(f.hb.hasLogin(), false)
  await f.hb.tick()
  assert.equal(f.calls.length, 0)
  f.cfg.heybox.cookie = 'pkey=abc'
  await f.hb.tick()
  assert.equal(f.turns.length, 1)
  assert.equal(f.hb.state().quota.browse, 1)
  assert.equal(f.hb.state().lastRun, f.time)
  await f.hb.tick()
  assert.equal(f.turns.length, 1)
})

test('总开关、dryRun、醒着时间和缺失配置都按语义处理', async (t) => {
  const f = fixture({ fetcher: feed })
  t.after(() => f.close())
  f.cfg.enabled = false
  await f.hb.tick(); assert.equal((await f.hb.runDuty()).ok, false)
  f.cfg.enabled = true; f.cfg.dryRun = true
  await f.hb.tick(); assert.equal((await f.hb.runDuty()).ok, false)
  f.cfg.dryRun = false; f.cfg.speakUp = { awakeFrom: 12, awakeTo: 23 }
  await f.hb.tick(); assert.equal(f.calls.length, 0)
  f.cfg.speakUp = { awakeFrom: 0, awakeTo: 24 }
  // offPeakOnly 缺省关闭，模型没有选择分享时不会发消息。
  await f.hb.tick()
  assert.equal(f.turns.length, 1)
  assert.equal(f.sends.length, 0)
})

test('today 使用本地日历，旧额度跨本地午夜重置', async (t) => {
  const date = new Date(2026, 0, 2, 0, 30)
  assert.equal(today(date), '2026-01-02')
  assert.equal(date.toISOString().slice(0, 10), '2026-01-01')
  const f = fixture({ now: date.getTime(), initialState: { quota: { date: '2026-01-01', browse: 5, share: 2 } } })
  t.after(() => f.close())
  assert.equal(f.hb.state().quota.date, '2026-01-02')
  assert.equal(f.hb.state().quota.browse, 0)
  assert.equal(f.hb.state().quota.share, 0)
})

test('峰时左闭右开、支持跨午夜及按起始日判断周末', () => {
  const cross = { peakStartAM: 22, peakEndAM: 2, peakStartPM: 0, peakEndPM: 0 }
  const monday = (h, m = 0) => new Date(2026, 5, 8, h, m)
  assert.equal(isPeakTime(cross, monday(21, 59)), false)
  assert.equal(isPeakTime(cross, monday(22)), true)
  assert.equal(isPeakTime(cross, new Date(2026, 5, 9, 1, 59)), true)
  assert.equal(isPeakTime(cross, new Date(2026, 5, 9, 2)), false)
  // 周六凌晨属于周五的跨午夜峰时；周一凌晨属于周日。
  assert.equal(isPeakTime(cross, new Date(2026, 5, 13, 1)), true)
  assert.equal(isPeakTime(cross, monday(1)), false)
  assert.equal(isPeakTime({ ...cross, peakWeekend: true }, monday(1)), true)
  assert.equal(isPeakTime({}, monday(9)), true)
  assert.equal(isPeakTime({}, monday(12)), false)
  assert.equal(isPeakTime({}, monday(14)), true)
  assert.equal(isPeakTime({}, monday(18)), false)
})

test('峰时跳过自动逛，不联网、不消耗模型或额度', async (t) => {
  const f = fixture({ config: { heybox: { offPeakOnly: true } }, fetcher: feed })
  t.after(() => f.close())
  await f.hb.tick()
  assert.equal(f.calls.length, 0)
  assert.equal(f.turns.length, 0)
  assert.equal(f.hb.state().quota.browse, 0)
  assert.match(f.hb.state().lastSkipReason, /峰时/)
  f.cfg.heybox.offPeakOnly = false
  await f.hb.tick()
  assert.equal(f.hb.state().quota.browse, 1)
})

test('分享默认开启，先占额防并发；失败回滚，超时不重发', async (t) => {
  const gate = defer()
  const calls = []
  let mode = 'pending'
  const f = fixture({ hub: { sendText: async (...args) => {
    calls.push(args)
    if (mode === 'pending') return gate.promise
    if (mode === 'fail') throw new Error('发送失败')
    if (mode === 'timeout') throw new Error('网关超时')
    return { message_id: 1 }
  } } })
  t.after(() => f.close())
  const verdict = (id) => ({ share: '分享一条游戏帖子', linkId: id })
  f.cfg.heybox.shareToOwner = false
  assert.equal((await f.hb.shareToOwner(verdict('123456'))).skipped, true)
  delete f.cfg.heybox.shareToOwner
  f.cfg.heybox.shareDaily = 1
  const first = f.hb.shareToOwner(verdict('123456'))
  assert.equal(f.hb.state().quota.share, 1)
  assert.equal((await f.hb.shareToOwner(verdict('234567'))).skipped, true)
  assert.deepEqual(calls[0], ['private:12345678', '分享一条游戏帖子\nhttps://www.xiaoheihe.cn/app/bbs/link/123456'])
  gate.reject(new Error('发送失败'))
  assert.equal((await first).ok, false)
  assert.equal(f.hb.state().quota.share, 0)
  mode = 'fail'
  assert.equal((await f.hb.shareToOwner(verdict('234567'))).ok, false)
  assert.equal(f.hb.state().quota.share, 0)
  mode = 'timeout'
  const timed = await f.hb.shareToOwner(verdict('345678'))
  assert.equal(timed.uncertain, true)
  assert.equal(f.hb.state().quota.share, 1)
  f.cfg.heybox.shareDaily = 3
  assert.equal((await f.hb.shareToOwner(verdict('345678'))).skipped, true)
  assert.equal(calls.length, 3)
})

test('无法确认发送结果时保留额度；明确返回失败时回滚', async (t) => {
  let result = null
  const f = fixture({ hub: { sendText: async () => result } })
  t.after(() => f.close())
  const verdict = (id) => ({ share: '看看', linkId: id })
  assert.equal((await f.hb.shareToOwner(verdict('123456'))).uncertain, true)
  assert.equal(f.hb.state().quota.share, 1)
  assert.equal((await f.hb.shareToOwner(verdict('123456'))).skipped, true)
  result = { ok: false }
  assert.equal((await f.hb.shareToOwner(verdict('234567'))).uncertain, false)
  assert.equal(f.hb.state().quota.share, 1)
  result = { message_id: 2 }
  assert.equal((await f.hb.shareToOwner(verdict('234567'))).ok, true)
  f.cfg.heybox.enabled = false
  assert.equal((await f.hb.shareToOwner(verdict('345678'))).skipped, true)
})

test('分享记录被历史截断后仍不能重复发送', async (t) => {
  const f = fixture()
  t.after(() => f.close())
  assert.equal((await f.hb.shareToOwner({ share: '看看', linkId: '123456' })).ok, true)
  const { readFileSync, writeFileSync } = await import('node:fs')
  const state = JSON.parse(readFileSync(f.stateFile, 'utf8'))
  state.history = Array.from({ length: 60 }, (_, i) => ({ kind: 'browse', at: i }))
  writeFileSync(f.stateFile, JSON.stringify(state))
  assert.equal((await f.hb.shareToOwner({ share: '看看', linkId: '123456' })).skipped, true)
  assert.equal(f.sends.length, 1)
})

test('并发 tick 只启动一轮，运行期间关掉总开关后不分享', async (t) => {
  const turn = defer(), started = defer()
  const f = fixture({ fetcher: feed, config: { heybox: { shareToOwner: true } }, hub: { runSystemTurn: async () => { started.resolve(); return turn.promise } } })
  t.after(() => f.close())
  const first = f.hb.tick()
  await started.promise
  await f.hb.tick()
  f.cfg.enabled = false
  turn.resolve(JSON.stringify({ note: '游戏', share: '看这个', linkId: '123456' }))
  await first
  assert.equal(f.calls.length, 1)
  assert.equal(f.sends.length, 0)
  assert.equal(f.hb.state().quota.browse, 1)
})

test('模块重建后未完成的分享继续占额并阻止重发', async (t) => {
  const gate = defer()
  const f = fixture({ config: { heybox: { shareToOwner: true, shareDaily: 1 } }, hub: { sendText: async () => gate.promise } })
  t.after(() => f.close())
  const first = f.hb.shareToOwner({ share: '看看', linkId: '123456' })
  assert.equal(f.hb.state().quota.share, 1)
  // 同一个状态文件被重新加载时，待确认记录仍然生效。
  const { createHeybox } = await import('../lib/site.mjs')
  const reloaded = createHeybox({ getConfig: () => f.cfg, stateFile: f.stateFile, credFile: 'missing', hub: { sendText: async () => { throw new Error('不应发送') } } })
  t.after(() => reloaded.dispose())
  assert.equal((await reloaded.shareToOwner({ share: '看看', linkId: '123456' })).skipped, true)
  assert.equal(reloaded.clearQuota().ok, false)
  gate.reject(new Error('超时'))
  assert.equal((await first).uncertain, true)
})

test('自动分享仅允许模型选择本轮信息流的帖子并检查 dryRun', async (t) => {
  const f = fixture({ fetcher: feed, config: { heybox: { shareToOwner: true } }, hub: { runSystemTurn: async () => JSON.stringify({ note: '游戏', share: '看这个', linkId: '123456' }) } })
  t.after(() => f.close())
  await f.hb.tick()
  assert.equal(f.sends.length, 1)
  assert.equal(f.hb.state().quota.share, 1)
  f.cfg.dryRun = true
  assert.equal((await f.hb.shareToOwner({ share: '看看', linkId: '234567' })).skipped, true)
  assert.equal(f.sends.length, 1)
})

test('Cookie 只有 pkey 时补同值的 user_pkey，login 状态算登录失效（#164）', () => {
  assert.equal(normalizeCookie('pkey=a; heybox_id=1'), 'pkey=a; heybox_id=1; user_pkey=a')
  assert.equal(normalizeCookie('pkey=a;'), 'pkey=a; user_pkey=a')
  assert.equal(normalizeCookie('pkey=a; user_pkey=b'), 'pkey=a; user_pkey=b')
  assert.equal(normalizeCookie('user_pkey=b'), 'user_pkey=b')
  assert.equal(normalizeCookie('heybox_id=1'), 'heybox_id=1')
  assert.equal(normalizeCookie(''), '')
  assert.ok(AUTH_STATUS.has('login'))
})

test('linkIdOf 认 app 端 16 进制分享链接、网页路径与直接给的 id', () => {
  // app 端分享链接：link_id 是 16 进制，接口原样接受
  const share = 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=TGtTqLjhcLHk1BE4&h_src=YXBwX3NoYXJl&link_id=855a72949646&new_post_share_style_v2=1'
  assert.equal(linkIdOf(share), '855a72949646')
  assert.equal(linkIdOf('https://www.xiaoheihe.cn/app/bbs/link/855a72949646'), '855a72949646')
  // 十进制老链接和裸 id 照旧
  assert.equal(linkIdOf('https://www.xiaoheihe.cn/app/bbs/link/192865129'), '192865129')
  assert.equal(linkIdOf('192865129'), '192865129')
  assert.equal(linkIdOf('855a72949646'), '855a72949646')
  // 认不出就返回空，不能把整条 URL 里的数字拼成一个假 id
  assert.equal(linkIdOf(''), '')
  assert.equal(linkIdOf('随便一句话'), '')
  assert.equal(linkIdOf(undefined), '')
})

test('watch 拿到 app 端分享链接时按原样 16 进制 link_id 拉详情', async (t) => {
  const seen = []
  const detailFetch = async (url) => {
    seen.push(url)
    assert.equal(url.pathname, '/bbs/app/link/tree')
    assert.equal(url.searchParams.get('link_id'), '855a72949646')
    return ok({ link: { title: '测试帖', description: '正文内容', user: { username: '作者' }, link_like_count: 3 } })
  }
  const f = fixture({ fetcher: detailFetch })
  t.after(() => f.close())
  const share = 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=TGtTqLjhcLHk1BE4&h_src=YXBwX3NoYXJl&link_id=855a72949646&new_post_share_style_v2=1'
  const r = await f.hb.watch(share)
  assert.equal(seen.length, 1)
  assert.equal(r.ok, true)
  assert.match(r.message, /测试帖/)
  assert.match(r.message, /正文内容/)
})

