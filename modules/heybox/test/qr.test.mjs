import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, json, ok, defer, fakeTokenBrowser } from './helpers.mjs'

function qrResponse(handler) {
  return async (url, options) => {
    const path = url.pathname
    if (path === '/account/get_qrcode_url') return ok({ qr_url: 'https://example.test/login?qr=abc', expire: 120 })
    return handler(path, options)
  }
}

test('扫码待确认不算成功；verified:false 既不保存 Cookie 也不清冷却', async (t) => {
  let poll = 0
  const f = fixture({ fetcher: qrResponse(async (path) => {
    if (path === '/account/qr_state') return ++poll === 1 ? ok({ error: 'ready' }) : ok({ error: 'ok', pkey: 'new' })
    if (path === '/account/restore_login') return ok({})
    throw new Error(path)
  }) })
  t.after(() => f.close())
  const start = await f.hb.qrStart()
  assert.equal(start.ok, true)
  assert.match(start.png, /^data:image\/png;base64,/)
  assert.equal((await f.hb.qrPoll()).state, 'ready')
  const r = await f.hb.qrPoll()
  assert.equal(r.ok, false)
  assert.equal(r.verified, false)
  assert.equal(f.cfg.heybox.cookie, 'pkey=old; heybox_id=1')
  assert.equal(f.hb.risk().level, 0)
})

test('扫码验证遇到验证码不保存 Cookie、升级冷却，之后轮询不再发送请求', async (t) => {
  const f = fixture({ fetcher: qrResponse(async (path) => {
    if (path === '/account/qr_state') return ok({ error: 'ok', pkey: 'new' })
    if (path === '/account/restore_login') return json({ status: 'show_captcha' }, 403)
    throw new Error(path)
  }) })
  t.after(() => f.close())
  await f.hb.qrStart()
  const result = await f.hb.qrPoll()
  assert.equal(result.ok, false)
  assert.equal(result.verified, false)
  assert.equal(f.cfg.heybox.cookie, 'pkey=old; heybox_id=1')
  assert.equal(f.hb.risk().reason, 'captcha')
  const count = f.calls.length
  assert.equal((await f.hb.qrPoll()).ok, false)
  assert.equal(f.calls.length, count)
})

test('扫码确认可用才保存 Cookie 并清冷却，Cookie 不返回面板', async (t) => {
  const f = fixture({ fetcher: qrResponse(async (path, options) => {
    if (path === '/account/qr_state') return json({ status: 'ok', result: { error: 'ok', heybox_id: '42' } }, 200, { 'set-cookie': 'pkey=new; Path=/; HttpOnly' })
    if (path === '/account/restore_login') { assert.match(options.headers.cookie, /pkey=new/); return ok({ profile: { heybox_id: '42', username: '盒友' } }) }
    throw new Error(path)
  }) })
  t.after(() => f.close())
  await f.hb.qrStart()
  const result = await f.hb.qrPoll()
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.cookie, undefined)
  assert.match(f.cfg.heybox.cookie, /pkey=new/)
  assert.equal(f.hb.risk().leftMs, 0)
})

test('未通过账号检查时保留原有已过期的风控等级', async (t) => {
  const f = fixture({ initialState: { risk: { level: 2, until: 1, reason: 'captcha', at: 1 } }, fetcher: qrResponse(async (path) => {
    if (path === '/account/qr_state') return ok({ error: 'ok', pkey: 'new' })
    if (path === '/account/restore_login') return ok({})
    throw new Error(path)
  }) })
  t.after(() => f.close())
  assert.equal((await f.hb.qrStart()).ok, true)
  assert.equal((await f.hb.qrPoll()).verified, false)
  assert.equal(f.hb.risk().level, 2)
  assert.equal(f.cfg.heybox.cookie, 'pkey=old; heybox_id=1')
})

test('手动解除冷却必须确认当前账号有效，且新的风控不能被旧验证清除', async (t) => {
  let mode = 'empty'
  const f = fixture({ initialState: { risk: { level: 1, until: new Date(2026, 5, 8, 11).getTime(), reason: 'captcha', at: 1 } }, fetcher: async (url) => {
    assert.equal(url.pathname, '/account/restore_login')
    if (mode === 'empty') return ok({})
    if (mode === 'captcha') return json({ status: 'need_captcha' }, 403)
    return ok({ account_detail: { userid: '1' } })
  } })
  t.after(() => f.close())
  assert.equal((await f.hb.clearRisk()).ok, false)
  assert.equal(f.hb.risk().level, 1)
  mode = 'captcha'
  assert.equal((await f.hb.clearRisk()).ok, false)
  assert.equal(f.hb.risk().level, 2)
  mode = 'ok'
  assert.equal((await f.hb.clearRisk()).ok, true)
  assert.equal(f.hb.risk().level, 0)
})

test('扫码状态查询期间不能重新生成二维码或并发验证当前账号', async (t) => {
  const pending = defer(), started = defer()
  const f = fixture({ fetcher: qrResponse(async (path) => {
    if (path === '/account/qr_state') { started.resolve(); return pending.promise }
    throw new Error(path)
  }) })
  t.after(() => f.close())
  await f.hb.qrStart()
  const polling = f.hb.qrPoll()
  await started.promise
  assert.equal((await f.hb.qrStart()).state, 'busy')
  assert.equal((await f.hb.clearRisk()).ok, false)
  pending.resolve(ok({ error: 'wait' }))
  assert.equal((await polling).state, 'wait')
})

test('手动验证期间配置换了账号时不解除原冷却', async (t) => {
  const pending = defer(), started = defer()
  const f = fixture({ initialState: { risk: { level: 1, until: new Date(2026, 5, 8, 11).getTime(), reason: 'captcha' } }, fetcher: async () => { started.resolve(); return pending.promise } })
  t.after(() => f.close())
  const checking = f.hb.clearRisk()
  await started.promise
  f.cfg.heybox.cookie = 'pkey=other'
  pending.resolve(ok({ profile: { heybox_id: '1' } }))
  assert.equal((await checking).ok, false)
  assert.equal(f.hb.risk().level, 1)
})

test('冷却中扫码不自动绕过；429 状态在后续操作中持续生效', async (t) => {
  const f = fixture({ fetcher: qrResponse(async (path) => path === '/account/qr_state' ? json({}, 429) : ok()) })
  t.after(() => f.close())
  assert.equal((await f.hb.qrStart()).ok, true)
  assert.equal((await f.hb.qrPoll()).ok, false)
  const count = f.calls.length
  assert.equal((await f.hb.qrStart()).ok, false)
  assert.equal(f.calls.length, count)
  assert.equal(f.hb.risk().reason, 'ratelimit')
})

test('扫码成功后补取 x_xhh_tokenid 并写进 Cookie（它是网页前端种的，不在接口里）', async (t) => {
  // 背景：扫码三步（get_qrcode_url / qr_state / restore_login）都不下发 x_xhh_tokenid，
  // 实测要用 pkey 打开网页，前端 JS 才会把它种进浏览器。这条守住「必须补取」这件事。
  const f = fixture({
    tokenBrowser: fakeTokenBrowser({ token: 'tok-abc-123' }),
    fetcher: qrResponse(async (path) => {
      if (path === '/account/qr_state') return ok({ error: 'ok', pkey: 'new' })
      if (path === '/account/restore_login') return ok({ profile: { heybox_id: '42', username: '盒友' } })
      throw new Error(path)
    }),
  })
  t.after(() => f.close())
  await f.hb.qrStart()
  const r = await f.hb.qrPoll()
  assert.equal(r.ok, true)
  assert.equal(r.hasToken, true, '结果里要标明有发帖令牌')
  assert.match(f.cfg.heybox.cookie, /pkey=new/, 'pkey 要留下')
  assert.match(f.cfg.heybox.cookie, /x_xhh_tokenid=tok-abc-123/, 'tokenid 要补进 Cookie')
  assert.match(r.message, /含发帖令牌/)
})

test('补取不到 tokenid 时照样登录成功，但如实提示缺令牌', async (t) => {
  // 取 token 失败不能把整个扫码判死：pkey 是有效的，只是写操作会受限。
  const f = fixture({
    tokenBrowser: fakeTokenBrowser({ token: null }),   // 前端一直没种
    fetcher: qrResponse(async (path) => {
      if (path === '/account/qr_state') return ok({ error: 'ok', pkey: 'new' })
      if (path === '/account/restore_login') return ok({ profile: { heybox_id: '42' } })
      throw new Error(path)
    }),
  })
  t.after(() => f.close())
  await f.hb.qrStart()
  const r = await f.hb.qrPoll()
  assert.equal(r.ok, true, '取不到 token 也要算登录成功')
  assert.equal(r.hasToken, false)
  assert.match(f.cfg.heybox.cookie, /pkey=new/)
  assert.doesNotMatch(f.cfg.heybox.cookie, /x_xhh_tokenid=/)
  assert.match(r.message, /缺 x_xhh_tokenid/)
})
