// test/cloud-auth.test.mjs —— Bambu 云登录：账号密码、验证码、两步验证、错误与脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudLogin, verifyCloudToken, uidFromToken, CloudAuthError } from '../lib/cloud-auth.mjs'

const TOKEN = 'header.' + Buffer.from(JSON.stringify({ username: 'u_123456' })).toString('base64url') + '.sig'
const PASSWORD = 'SuperSecret-Pass-1'

function fakeFetch (routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    for (const route of routes) {
      if (url.indexOf(route.match) >= 0) {
        const body = typeof route.body === 'function' ? route.body(init) : route.body
        const headers = route.headers ? { getSetCookie: () => route.headers } : undefined
        const status = typeof route.status === 'function' ? route.status(init) : (route.status || 200)
        return {
          status,
          headers,
          async text () { return typeof body === 'string' ? body : JSON.stringify(body ?? null) },
        }
      }
    }
    return { status: 404, async text () { return '{}' } }
  }
  return { impl, calls }
}

test('uidFromToken 从 JWT 的 username 取 uid', () => {
  assert.equal(uidFromToken(TOKEN), '123456')
  assert.equal(uidFromToken('not-a-jwt'), '')
  assert.equal(uidFromToken('a.b.c'), '')
})

test('login：账号密码直接返回 accessToken，uid 从 JWT 解出', async () => {
  const { impl, calls } = fakeFetch([{ match: '/v1/user-service/user/login', body: { accessToken: TOKEN } }])
  const session = createCloudLogin({ account: 'me@example.com', password: PASSWORD, fetchImpl: impl })
  const r = await session.login()
  assert.equal(r.ok, true)
  assert.equal(r.accessToken, TOKEN)
  assert.equal(r.uid, '123456')
  assert.equal(r.region, 'us')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.account, 'me@example.com')
  assert.equal(body.password, PASSWORD)
  assert.equal(calls[0].init.headers.Authorization, undefined, '登录请求不带 bearer')
})

test('login：需要验证码 / 需要两步验证 时不抛错，返回 need', async () => {
  const codeLogin = fakeFetch([{ match: '/login', body: { loginType: 'verifyCode' } }])
  const r1 = await createCloudLogin({ account: 'a@b.c', password: 'x', fetchImpl: codeLogin.impl }).login()
  assert.deepEqual({ ok: r1.ok, need: r1.need }, { ok: false, need: 'code' })

  const tfa = fakeFetch([{ match: '/login', body: { loginType: 'tfa', tfaKey: 'KEY123' } }])
  const r2 = await createCloudLogin({ account: 'a@b.c', password: 'x', fetchImpl: tfa.impl }).login()
  assert.equal(r2.ok, false)
  assert.equal(r2.need, 'tfa')
})

test('login：账号/密码缺失、401、超时都给明确错误且不含密码', async () => {
  await assert.rejects(() => createCloudLogin({ account: 'a@b.c' }).login(), (e) => e.code === 'NO_PASSWORD' && !String(e.message).includes(PASSWORD))
  await assert.rejects(() => createCloudLogin({ password: 'x' }).login(), (e) => e.code === 'NO_ACCOUNT')
  const unauth = fakeFetch([{ match: '/login', status: 401, body: '{}' }])
  await assert.rejects(() => createCloudLogin({ account: 'a@b.c', password: PASSWORD, fetchImpl: unauth.impl }).login(), (e) => e.code === 'AUTH_FAILED' && !String(e.message).includes(PASSWORD))
  const boom = async (url) => { throw Object.assign(new Error('connect failed ' + PASSWORD), { name: 'TimeoutError' }) }
  await assert.rejects(() => createCloudLogin({ account: 'a@b.c', password: PASSWORD, fetchImpl: boom }).login(), (e) => e.code === 'TIMEOUT')
})

test('验证码：先发码再提交，失败码 1/2 有对应错误', async () => {
  const sent = []
  const { impl } = fakeFetch([
    { match: '/sendemail/code', body: {} },
    { match: '/login', body: (init) => {
      const body = JSON.parse(init.body)
      if (body.code === '000000') return { accessToken: TOKEN }
      return { code: body.code === '111111' ? 1 : 2 }
    }, status: (init) => (JSON.parse(init.body).code === '000000' ? 200 : 400) },
  ])
  const session = createCloudLogin({ account: 'me@example.com', password: PASSWORD, fetchImpl: impl })
  const r = await session.requestCode()
  assert.equal(r.channel, 'email')
  const ok = await session.submitCode('000000')
  assert.equal(ok.ok, true)
  assert.equal(ok.uid, '123456')
  await assert.rejects(() => session.submitCode('111111'), (e) => e.code === 'CODE_EXPIRED')
  await assert.rejects(() => session.submitCode('222222'), (e) => e.code === 'CODE_INCORRECT')
  await assert.rejects(() => session.submitCode(''), (e) => e.code === 'NO_CODE')
})

test('验证码：手机号必须走中国站 /api/v1/.../sendsmscode（否则 400）', async () => {
  const { impl, calls } = fakeFetch([{ match: '/sendsmscode', body: {} }])
  const session = createCloudLogin({ account: '13800138000', password: PASSWORD, fetchImpl: impl })
  const r = await session.requestCode()
  assert.equal(r.channel, 'sms')
  // 完整 URL 断言：以前只断言 endsWith，所以「走错站 + 少一层 /api」的 bug 测不出来。
  assert.equal(calls[0].url, 'https://api.bambulab.cn/api/v1/user-service/user/sendsmscode')
  assert.doesNotMatch(calls[0].url, /api\.bambulab\.com/, '短信验证码不该打国际站')
})

test('验证码：手机号即使传了 us，也要用中国站（发码和换 token 同站）', async () => {
  const { impl, calls } = fakeFetch([
    { match: '/sendsmscode', body: {} },
    { match: '/login', body: { accessToken: TOKEN } },
  ])
  const session = createCloudLogin({ account: '13800138000', password: PASSWORD, region: 'us', fetchImpl: impl })
  await session.requestCode()
  assert.equal(calls[0].url, 'https://api.bambulab.cn/api/v1/user-service/user/sendsmscode')
  // 换 token 也在同一站，否则发码成功、提交却失败
  const ok = await session.submitCode('000000')
  assert.equal(ok.ok, true)
  assert.equal(ok.region, 'cn', '手机号账号的 region 应当是 cn')
  assert.match(calls[1].url, /^https:\/\/api\.bambulab\.cn\//, '换 token 也要走中国站：' + calls[1].url)
})

test('验证码：邮箱仍按区域走，不受手机号规则影响', async () => {
  const { impl, calls } = fakeFetch([{ match: '/sendemail/code', body: {} }])
  const session = createCloudLogin({ account: 'me@example.com', password: PASSWORD, region: 'us', fetchImpl: impl })
  const r = await session.requestCode()
  assert.equal(r.channel, 'email')
  assert.equal(calls[0].url, 'https://api.bambulab.com/v1/user-service/user/sendemail/code')
})

test('两步验证：CSRF + cookie + tfaKey，token 从 Set-Cookie 取', async () => {
  const { impl, calls } = fakeFetch([
    { match: '/login', body: { loginType: 'tfa', tfaKey: 'KEY-1' } },
    { match: '/api/csrf', headers: ['bbl_csrf_token=csrf-abc; Path=/; HttpOnly'], body: '' },
    { match: '/api/sign-in/tfa', headers: ['token=' + TOKEN + '; Path=/'], body: {} },
  ])
  const session = createCloudLogin({ account: 'me@example.com', password: PASSWORD, fetchImpl: impl })
  const first = await session.login()
  assert.equal(first.need, 'tfa')
  const r = await session.submitTfa('123456')
  assert.equal(r.ok, true)
  assert.equal(r.uid, '123456')
  const tfaCall = calls.find((c) => c.url.includes('/api/sign-in/tfa'))
  assert.equal(tfaCall.init.headers['x-bbl-csrf-token'], 'csrf-abc')
  assert.equal(tfaCall.init.headers.Cookie, 'bbl_csrf_token=csrf-abc')
  assert.equal(JSON.parse(tfaCall.init.body).tfaKey, 'KEY-1')
})

test('两步验证：没有上下文 / 拿不到 CSRF / 错码', async () => {
  const noCtx = createCloudLogin({ account: 'a@b.c', password: 'x' })
  await assert.rejects(() => noCtx.submitTfa('123456'), (e) => e.code === 'NO_TFA_KEY')

  const noCsrf = fakeFetch([
    { match: '/login', body: { loginType: 'tfa', tfaKey: 'K' } },
    { match: '/api/csrf', body: '' },
  ])
  const s1 = createCloudLogin({ account: 'a@b.c', password: 'x', fetchImpl: noCsrf.impl })
  await s1.login()
  await assert.rejects(() => s1.submitTfa('123456'), (e) => e.code === 'CSRF_FAILED')

  const badCode = fakeFetch([
    { match: '/login', body: { loginType: 'tfa', tfaKey: 'K' } },
    { match: '/api/csrf', headers: ['bbl_csrf_token=c'], body: '' },
    { match: '/api/sign-in/tfa', status: 400, body: { error: 'Incorrect code' } },
  ])
  const s2 = createCloudLogin({ account: 'a@b.c', password: 'x', fetchImpl: badCode.impl })
  await s2.login()
  await assert.rejects(() => s2.submitTfa('000000'), (e) => e.code === 'CODE_INCORRECT')
})

test('verifyCloudToken：有效/过期/网络错误', async () => {
  const ok = fakeFetch([{ match: '/user/bind', body: { devices: [{ dev_id: 'SN' }] } }])
  const r1 = await verifyCloudToken({ accessToken: TOKEN, fetchImpl: ok.impl })
  assert.equal(r1.ok, true)
  assert.equal(r1.devices.length, 1)
  const expired = fakeFetch([{ match: '/user/bind', status: 401, body: {} }])
  assert.equal((await verifyCloudToken({ accessToken: TOKEN, fetchImpl: expired.impl })).code, 'TOKEN_EXPIRED')
  const noToken = await verifyCloudToken({})
  assert.equal(noToken.code, 'NO_TOKEN')
  assert.equal((await verifyCloudToken({ accessToken: TOKEN, fetchImpl: async () => { throw new Error('offline ' + TOKEN) } })).code, 'NETWORK')
})

test('CloudAuthError 带 code', () => {
  const err = new CloudAuthError('AUTH_FAILED', 'x')
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'AUTH_FAILED')
  assert.equal(err.name, 'CloudAuthError')
})
