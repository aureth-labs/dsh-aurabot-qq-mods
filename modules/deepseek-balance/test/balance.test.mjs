// DeepSeek 余额模块测试：不打真网络，fetch 全注入。
// 覆盖：触发词匹配、结果格式化、鉴权失败的提示、各种错误码、/v1 404 回退、缓存与开关清缓存。
// 跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/deepseek-balance/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createBalanceQuery,
  formatBalance,
  matchesTrigger,
  money,
  queryBalance,
  resolveBase,
  triggerList,
  CACHE_MS,
  DEFAULT_BASE_URL,
  DENY_TEXT,
  NO_KEY_TEXT,
} from '../lib/balance.mjs'
import mod from '../index.mjs'

const OK_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '8.33', granted_balance: '0.00', topped_up_balance: '8.33' }],
}

// 造一个和 fetch 同形状的返回
const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

// 记录请求，按顺序返回预设响应
function fakeFetch(responses) {
  const calls = []
  const list = Array.isArray(responses) ? responses : [responses]
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (!list.length) throw new Error('没有更多预设响应了')
    const next = list.shift()
    if (next instanceof Error) throw next
    return next
  }
  fn.calls = calls
  return fn
}

const settings = (patch = {}) => ({ apiKey: 'sk-test', baseUrl: DEFAULT_BASE_URL, ...patch })

// ---------- 触发词 ----------

test('触发词：默认一个「余额」', () => {
  assert.deepEqual(triggerList({}), ['余额'])
  assert.deepEqual(triggerList({ trigger: '' }), ['余额'])
})

test('触发词：中英文逗号、顿号、空格都能分隔，空项丢掉', () => {
  assert.deepEqual(triggerList({ trigger: '余额, 剩多少，还有钱吗、查钱  看看' }), ['余额', '剩多少', '还有钱吗', '查钱', '看看'])
})

test('触发词匹配：大小写不敏感、首尾空格不影响、空文本不命中', () => {
  const s = { trigger: '余额,Balance' }
  assert.equal(matchesTrigger(s, '余额'), true)
  assert.equal(matchesTrigger(s, '  余额  '), true)
  assert.equal(matchesTrigger(s, 'balance'), true)
  assert.equal(matchesTrigger(s, 'BALANCE'), true)
  assert.equal(matchesTrigger(s, ''), false)
  assert.equal(matchesTrigger(s, '   '), false)
  assert.equal(matchesTrigger(s, '余额宝'), false)
})

// ---------- 格式化 ----------

test('金额：非数字回退成 0.00', () => {
  assert.equal(money('8.3'), '8.30')
  assert.equal(money(''), '0.00')
  assert.equal(money(undefined), '0.00')
  assert.equal(money('abc'), '0.00')
})

test('格式化：赠送和充值都为 0 时不显示括号', () => {
  const text = formatBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' }] })
  assert.equal(text, 'DeepSeek 余额：¥0.00')
})

test('格式化：有赠送/充值就带上明细', () => {
  assert.equal(
    formatBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.33', granted_balance: '2.00', topped_up_balance: '6.33' }] }),
    'DeepSeek 余额：¥8.33 （赠送 2.00 / 充值 6.33）',
  )
})

test('格式化：多币种依次列出，美元用 $', () => {
  const text = formatBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '5', granted_balance: '0', topped_up_balance: '5' },
      { currency: 'CNY', total_balance: '100', granted_balance: '0', topped_up_balance: '100' },
    ],
  })
  assert.equal(text, 'DeepSeek 余额：$5.00 （赠送 0.00 / 充值 5.00） ¥100.00 （赠送 0.00 / 充值 100.00）')
})

test('格式化：余额不足会明说', () => {
  const text = formatBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '', topped_up_balance: '0.00' }] })
  assert.equal(text, '余额不足，API 调用会被拒绝：¥0.00')
})

test('格式化：空数组和缺字段都有兜底，不抛异常', () => {
  assert.equal(formatBalance({ is_available: true, balance_infos: [] }), '查到了，但账户里没有余额信息。')
  assert.equal(formatBalance({}), '查到了，但账户里没有余额信息。')
  assert.equal(formatBalance(null), '查到了，但账户里没有余额信息。')
  assert.equal(formatBalance({ balance_infos: [null] }), '查到了，但账户里没有余额信息。')
})

test('接口地址：空值回退默认，末尾斜杠去掉', () => {
  assert.equal(resolveBase({}), DEFAULT_BASE_URL)
  assert.equal(resolveBase({ baseUrl: '   ' }), DEFAULT_BASE_URL)
  assert.equal(resolveBase({ baseUrl: 'https://proxy.example.com/' }), 'https://proxy.example.com')
  assert.equal(resolveBase({ baseUrl: 'https://proxy.example.com/v1//' }), 'https://proxy.example.com/v1')
})

// ---------- 请求与错误码 ----------

test('没填 Key：直接提示去面板填，不发请求', async () => {
  const f = fakeFetch([])
  const r = await queryBalance({ apiKey: '' }, { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(r.message, NO_KEY_TEXT)
  assert.equal(f.calls.length, 0)
})

test('成功：请求地址、请求头正确，结果被格式化', async () => {
  const f = fakeFetch(respond(200, OK_BODY))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.message, 'DeepSeek 余额：¥8.33 （赠送 0.00 / 充值 8.33）')
  assert.equal(f.calls[0].url, 'https://api.deepseek.com/v1/user/balance')
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk-test')
  assert.equal(f.calls[0].init.headers.Accept, 'application/json')
  assert.equal(f.calls[0].init.method, 'GET')
})

test('鉴权失败 401：提示 Key 无效', async () => {
  const f = fakeFetch(respond(401, { error: { message: 'Authentication Fails' } }))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
  assert.match(r.message, /API Key 无效或已过期/)
})

test('鉴权失败 403：提示没有权限', async () => {
  const f = fakeFetch(respond(403, ''))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(r.status, 403)
  assert.match(r.message, /没有查询余额的权限/)
})

test('其它错误码：带上状态码和服务端给的原因', async () => {
  const f = fakeFetch(respond(500, { error: { message: '内部错误' } }))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(r.status, 500)
  assert.equal(r.message, '查询失败（HTTP 500）：内部错误')
})

test('错误码但没有 JSON：退回用原文的片段', async () => {
  const f = fakeFetch(respond(502, '<html>Bad Gateway</html>'))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.status, 502)
  assert.match(r.message, /查询失败（HTTP 502）：<html>Bad Gateway<\/html>/)
})

test('200 但返回的不是 JSON：提示可能被网关改写', async () => {
  const f = fakeFetch(respond(200, 'not json'))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.message, /不是 JSON/)
})

test('超时：提示多少秒超时', async () => {
  const f = fakeFetch(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
  const r = await queryBalance(settings(), { fetchImpl: f, timeoutMs: 3000 })
  assert.equal(r.ok, false)
  assert.equal(r.message, '查询超时（3 秒），等会儿再试？')
})

test('连不上：说明是哪个地址', async () => {
  const f = fakeFetch(new Error('fetch failed'))
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(r.message, '连不上 https://api.deepseek.com/v1：fetch failed')
})

test('/v1 撞 404 时自动退回根路径再试一次', async () => {
  const f = fakeFetch([respond(404, ''), respond(200, OK_BODY)])
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].url, 'https://api.deepseek.com/v1/user/balance')
  assert.equal(f.calls[1].url, 'https://api.deepseek.com/user/balance')
})

test('405 也走回退', async () => {
  const f = fakeFetch([respond(405, ''), respond(200, OK_BODY)])
  const r = await queryBalance(settings(), { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(f.calls.length, 2)
})

test('自己填的中转地址撞 404：不回退，也不改用户填的地址', async () => {
  const f = fakeFetch(respond(404, ''))
  const r = await queryBalance(settings({ baseUrl: 'https://my-proxy.example.com' }), { fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://my-proxy.example.com/user/balance')
})

// ---------- 缓存 ----------

test('缓存：30 秒内第二次直接用缓存，不再请求', async () => {
  let clock = 1000
  const f = fakeFetch(respond(200, OK_BODY))
  const q = createBalanceQuery({ fetchImpl: f, now: () => clock })
  q.syncEnabled(true)

  const a = await q.run(settings())
  assert.equal(a.ok, true)
  assert.equal(f.calls.length, 1)

  clock += CACHE_MS - 1
  const b = await q.run(settings())
  assert.equal(b.fromCache, true)
  assert.equal(b.message, a.message)
  assert.equal(f.calls.length, 1)
})

test('缓存：超过 30 秒重新请求', async () => {
  let clock = 1000
  const f = fakeFetch([respond(200, OK_BODY), respond(200, {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99' }],
  })])
  const q = createBalanceQuery({ fetchImpl: f, now: () => clock })
  q.syncEnabled(true)

  await q.run(settings())
  clock += CACHE_MS + 1
  const b = await q.run(settings())
  assert.equal(b.fromCache, undefined)
  assert.equal(b.message, 'DeepSeek 余额：¥9.99 （赠送 0.00 / 充值 9.99）')
  assert.equal(f.calls.length, 2)
})

test('缓存：失败的查询不进缓存，下次还会重试', async () => {
  const f = fakeFetch([respond(500, ''), respond(200, OK_BODY)])
  const q = createBalanceQuery({ fetchImpl: f })
  q.syncEnabled(true)

  const bad = await q.run(settings())
  assert.equal(bad.ok, false)
  assert.equal(q.cached, '')

  const good = await q.run(settings())
  assert.equal(good.ok, true)
  assert.equal(f.calls.length, 2)
})

test('缓存：开关从关到开时清空，重新打开拿到新数据', async () => {
  let clock = 1000
  const f = fakeFetch([
    respond(200, OK_BODY),
    respond(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '7.77', granted_balance: '0', topped_up_balance: '7.77' }] }),
  ])
  const q = createBalanceQuery({ fetchImpl: f, now: () => clock })
  q.syncEnabled(true)
  const first = await q.run(settings())
  assert.match(first.message, /¥8\.33/)

  // 关掉：状态复位，缓存清空
  q.syncEnabled(false)
  assert.equal(q.cached, '')

  // 重新打开：即使还在 30 秒内也不该吃旧缓存
  q.syncEnabled(true)
  clock += 1
  const second = await q.run(settings())
  assert.match(second.message, /¥7\.77/)
  assert.equal(f.calls.length, 2)
})

test('reset() 手动清缓存', async () => {
  const f = fakeFetch([respond(200, OK_BODY), respond(200, OK_BODY)])
  const q = createBalanceQuery({ fetchImpl: f })
  q.syncEnabled(true)
  await q.run(settings())
  q.reset()
  assert.equal(q.cached, '')
  await q.run(settings())
  assert.equal(f.calls.length, 2)
})

// ---------- 模块接线 ----------

function bootModule(patch = {}) {
  const state = { replies: [], handler: null, settings: { ...mod.defaults, apiKey: 'sk-test', ...patch }, warns: [] }
  mod.setup({
    settings: () => ({ ...state.settings }),
    isOwner: (id) => String(id) === '1001',
    reply: async (msg, text) => { state.replies.push(text) },
    log: { info() {}, warn: (m) => state.warns.push(m), error() {}, debug() {} },
    on: (name, fn) => { if (name === 'message') state.handler = fn },
  })
  return state
}

const owner = { chatId: 'private:1001', userId: '1001', kind: 'private', text: '余额' }
const stranger = { chatId: 'group:9001', userId: '2002', kind: 'group', text: '余额' }

async function withFetch(f, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = f
  try {
    return await fn()
  } finally {
    globalThis.fetch = orig
  }
}

test('模块：元信息和 module.json 一致', async () => {
  const { readFileSync } = await import('node:fs')
  const meta = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
  assert.equal(mod.id, meta.id)
  assert.equal(mod.version, meta.version)
  assert.equal(mod.api, meta.api)
  assert.equal(mod.name, meta.name)
  assert.equal(mod.description, meta.description)
})

test('模块：开关默认关闭，不接管也不回复', async () => {
  const state = bootModule()
  assert.equal(mod.defaults.enabled, false)
  await withFetch(fakeFetch([]), async () => {
    assert.equal(await state.handler(owner), false)
  })
  assert.equal(state.replies.length, 0)
})

test('模块：打开后命中触发词就查余额并回复', async () => {
  const state = bootModule({ enabled: true })
  await withFetch(fakeFetch(respond(200, OK_BODY)), async () => {
    assert.equal(await state.handler(owner), true)
  })
  assert.equal(state.replies[0], 'DeepSeek 余额：¥8.33 （赠送 0.00 / 充值 8.33）')
})

test('模块：非触发词不接管', async () => {
  const state = bootModule({ enabled: true })
  await withFetch(fakeFetch([]), async () => {
    assert.equal(await state.handler({ ...owner, text: '你好' }), false)
  })
  assert.equal(state.replies.length, 0)
})

test('模块：别人查、群友开关关着 → 只回提示，不请求', async () => {
  const state = bootModule({ enabled: true })
  const f = fakeFetch([])
  await withFetch(f, async () => {
    assert.equal(await state.handler(stranger), true)
  })
  assert.equal(state.replies[0], DENY_TEXT)
  assert.equal(f.calls.length, 0)
})

test('模块：别人查、群友开关打开 → 正常返回余额', async () => {
  const state = bootModule({ enabled: true, allowOthers: true })
  await withFetch(fakeFetch(respond(200, OK_BODY)), async () => {
    assert.equal(await state.handler(stranger), true)
  })
  assert.match(state.replies[0], /¥8\.33/)
})

test('模块：查询失败也会回一句人话，并写一条警告日志', async () => {
  const state = bootModule({ enabled: true })
  await withFetch(fakeFetch(respond(401, '')), async () => {
    await state.handler(owner)
  })
  assert.match(state.replies[0], /API Key 无效/)
  assert.equal(state.warns.length, 1)
  assert.match(state.warns[0], /查询失败/)
})

test('模块：每次 setup 是独立实例，缓存互不串', async () => {
  const first = bootModule({ enabled: true })
  const second = bootModule({ enabled: true })
  await withFetch(fakeFetch([respond(200, OK_BODY), respond(200, OK_BODY)]), async () => {
    await first.handler(owner)
    await second.handler(owner)
  })
  // 两个实例各自的第一次查询都真的发了请求
  assert.equal(first.replies.length, 1)
  assert.equal(second.replies.length, 1)
})
