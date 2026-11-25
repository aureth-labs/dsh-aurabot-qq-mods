// 关键词调 API 池（api-pool）测试：匹配内置变量、模板兜底、关键词匹配、真实请求链路。
// 全部走注入的 fake fetch / fake api，不打真网络、不写模块源码目录。
// 直接静态 import ../index.mjs：入口是纯函数 + export default 对象，不依赖插件宿主。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod, {
  normalizeKeywords, matchKeywords, keywordToRegExp, lookupVar, substParam, renderTemplate, keywordVars,
  getPath, extract, normalizeParts, probe, normalizeApi, libKey, htmlToText,
} from '../index.mjs'

// ---- 小工具 ----

/** 造一个够 probe 用的 fetch 响应（文本 JSON）。 */
function makeRes(body, contentType = 'application/json; charset=utf-8') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => Buffer.from(body, 'utf8'),
    text: async () => body,
  }
}

/** 临时替换全局 fetch，跑完恢复（node:test 顶层用例默认顺序执行）。 */
async function withFetch(impl, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = orig }
}

/** 捕获 fetch 调用；返回 { calls, run }。 */
function captureFetch(responseBody) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return makeRes(responseBody)
  }
  return { calls, impl }
}

/** 起一个够 setup(api) 用的假宿主；运行数据落在临时目录。 */
function fakeApi(root, opts = {}) {
  const handlers = {}
  const routes = {}
  const replies = []
  const segments = []
  const api = {
    handlers, routes, replies, segments,
    body: {}, // 路由处理器读的请求体，可在 setup 后改
    dataDir: (sub) => join(root, sub),
    log: { info() {} },
    isOwner: typeof opts.isOwner === 'function' ? opts.isOwner : () => false,
    on: (ev, h) => { handlers[ev] = h },
    route: (path, h) => { routes[path] = h },
    reply: async (_msg, text) => { replies.push(String(text)) },
    sendSegments: async (_chatId, segs, label) => { segments.push({ chatId: _chatId, segs, label }) },
    core: { http: { body: async () => api.body || {} } },
  }
  return api
}

/** 写一份池配置 → setup → 触发一条群消息，返回 fetch 调用与回复。 */
async function runMessage(apis, msg, {
  groups = ['888'], scope, blacklist, isOwner,
  body = JSON.stringify({ code: 200, data: { name: '狮子座', fortune: '大吉' } }),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    const cfg = { groups, apis }
    if (scope !== undefined) cfg.scope = scope
    if (blacklist !== undefined) cfg.blacklist = blacklist
    writeFileSync(join(root, 'apipool', 'pool.json'), JSON.stringify(cfg), 'utf8')
    const api = fakeApi(root, { isOwner })
    mod.setup(api)
    const { calls, impl } = captureFetch(body)
    let ret
    await withFetch(impl, async () => { ret = await api.handlers.message(msg) })
    return { calls, replies: api.replies, segments: api.segments, ret }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const MSG = { kind: 'group', groupId: '888', userId: '10001', nickname: '阿星', text: '狮子座', chatId: 'group:888' }
const STAR_JSON = JSON.stringify({ code: 200, data: { name: '狮子座', fortune: '大吉' } })

// ---- 模块元信息 ----

test('入口与 module.json 的 id/version/api 一致', () => {
  const m = JSON.parse(readFileSync(fileURLToPath(new URL('../module.json', import.meta.url)), 'utf8'))
  assert.equal(mod.id, m.id)
  assert.equal(mod.version, m.version)
  assert.equal(mod.api, m.api)
  assert.equal(typeof mod.setup, 'function')
  assert.equal(mod.version, '1.6.0')
})

// ---- 关键词匹配 ----

// 旧配置（纯字符串数组）统一按「正则匹配」处理，下面这批老用例保持原样以验证行为不变
test('normalizeKeywords：旧纯字符串 → regex（保持旧行为），新对象按 mode', () => {
  assert.deepEqual(normalizeKeywords(['座$', ' 壁纸 ', '']), [
    { value: '座$', mode: 'regex' }, { value: '壁纸', mode: 'regex' },
  ])
  assert.deepEqual(normalizeKeywords([{ value: ' 狮子座 ', mode: 'exact' }, { value: '座$', mode: 'regex' }]), [
    { value: '狮子座', mode: 'exact' }, { value: '座$', mode: 'regex' },
  ])
  assert.deepEqual(normalizeKeywords([]), [])
  assert.equal(normalizeApi({ name: 'x', keywords: ['座$'] }).keywords[0].mode, 'regex')
  assert.equal(normalizeApi({ name: 'x', keywords: [{ value: '座$', mode: 'exact' }] }).keywords[0].mode, 'exact')
})

test('matchKeywords：完全匹配（exact）整条字面相等才命中，不再子串包含', () => {
  const kws = [{ value: '狮子座', mode: 'exact' }]
  assert.equal(matchKeywords(kws, '狮子座').hit, true)
  assert.equal(matchKeywords(kws, '狮子座').match, '狮子座') // {match}=关键词本身
  assert.deepEqual(matchKeywords(kws, '狮子座').groups, {})
  assert.equal(matchKeywords(kws, '来点狮子座'), null)
  assert.equal(matchKeywords(kws, '狮子座运势'), null)
  assert.equal(matchKeywords(kws, '  狮子座  '), null) // 触发消息已 trim，但关键词不会去匹配带空格的原文
  // exact 下关键词按字面处理，不解析正则元字符
  assert.equal(matchKeywords([{ value: '1.2', mode: 'exact' }], '1x2'), null)
  assert.equal(matchKeywords([{ value: '1.2', mode: 'exact' }], '1.2').hit, true)
  assert.equal(matchKeywords([{ value: '座$', mode: 'exact' }], '狮子座'), null)
  assert.equal(matchKeywords([{ value: '座$', mode: 'exact' }], '座$').hit, true)
})

test('matchKeywords：正则匹配（regex）仍是子串匹配，不影响既有正则与捕获模板', () => {
  assert.equal(matchKeywords([{ value: '座$', mode: 'regex' }], '狮子座').match, '座')
  assert.equal(matchKeywords([{ value: '壁纸', mode: 'regex' }], '来点壁纸').hit, true) // 子串包含
  assert.equal(matchKeywords([{ value: '^壁纸$', mode: 'regex' }], '来点壁纸'), null)
  assert.deepEqual(matchKeywords([{ value: '(?<xz>\\S+座)$', mode: 'regex' }], '狮子座').groups, { xz: '狮子座' })
  assert.deepEqual(matchKeywords([{ value: '{xz}座', mode: 'regex' }], '狮子座').groups, { xz: '狮子' })
  // 同一接口可混用：完全匹配行 + 正则行，按顺序命中
  const mix = [{ value: '狮子座', mode: 'exact' }, { value: '座$', mode: 'regex' }]
  assert.equal(matchKeywords(mix, '狮子座').match, '狮子座')
  assert.equal(matchKeywords(mix, '今天狮子座').match, '座')
})

test('keywordVars：只统计正则匹配行里的占位符，完全匹配行按字面不算捕获', () => {
  assert.deepEqual(keywordVars([{ value: '王者语音{hero}', mode: 'regex' }, { value: '{city}天气', mode: 'exact' }]), ['hero'])
  assert.deepEqual(keywordVars(['座$', '\\S+座$']), []) // 旧纯字符串仍按正则，但无占位符
})

test('matchKeywords：普通正则也返回匹配文字 match（座$ 的核心修复）', () => {
  const r = matchKeywords(['座$'], '狮子座')
  assert.equal(r.hit, true)
  assert.equal(r.match, '座')           // 只有 m[0] 才有「匹配到的文字」
  assert.deepEqual(r.groups, {})        // 无命名捕获
})

test('matchKeywords：\\S+座$ 匹配整词，命名捕获拿整段', () => {
  const word = matchKeywords(['\\S+座$'], '狮子座')
  assert.equal(word.match, '狮子座')
  assert.deepEqual(word.groups, {})

  const named = matchKeywords(['(?<xz>\\S+座)$'], '狮子座')
  assert.equal(named.match, '狮子座')
  assert.deepEqual(named.groups, { xz: '狮子座' })
})

test('matchKeywords：捕获模板首尾锚定，只取占位符那一段', () => {
  assert.equal(keywordToRegExp('座$').source, '座$')
  assert.equal(keywordToRegExp('{xz}座').source, '^(?<xz>.*?)座$')
  const r = matchKeywords(['{xz}座'], '狮子座')
  assert.deepEqual(r.groups, { xz: '狮子' })   // 不含「座」
  assert.equal(r.match, '狮子座')
  assert.equal(matchKeywords(['{xz}座'], '今天狮子座').groups.xz, '今天狮子')
  assert.equal(matchKeywords(['{xz}座'], '狮子座呀'), null) // ^...$ 要求整条完全匹配
})

test('matchKeywords：正则写错退回纯包含；无命中返回 null', () => {
  const bad = matchKeywords(['('], 'a(b')
  assert.equal(bad.hit, true)
  assert.deepEqual(bad.groups, {})
  assert.equal(bad.match, '(')
  assert.equal(matchKeywords(['座$'], '你好'), null)
  assert.equal(matchKeywords([], '狮子座'), null)
})

test('keywordVars：抽出关键词里的占位符变量名并去重（旧纯字符串=正则）', () => {
  assert.deepEqual(keywordVars(['王者语音{hero}', '查询{city}天气{day}', '{hero}再来']), ['hero', 'city', 'day'])
  assert.deepEqual(keywordVars(['座$', '\\S+座$']), [])
})

// ---- 变量查表与替换 ----

test('lookupVar：固定映射 + ctx.vars，自有属性保护', () => {
  assert.equal(lookupVar('qq', { uid: '10001' }), '10001')
  assert.equal(lookupVar('nickname', { nickname: '阿星' }), '阿星')
  assert.equal(lookupVar('gid', { gid: '888' }), '888')
  assert.equal(lookupVar('qq', undefined), '')
  assert.equal(lookupVar('match', { vars: { match: '座' } }), '座')
  assert.equal(lookupVar('text', { vars: { text: '狮子座' } }), '狮子座')
  assert.equal(lookupVar('nope', { vars: {} }), undefined)
  assert.equal(lookupVar('toString', { vars: {} }), undefined) // 不能顺着原型链拿
})

test('substParam：内置/匹配/捕获变量在字符串与嵌套结构里都替换', () => {
  const ctx = { uid: '10001', nickname: '阿星', gid: '888', vars: { match: '座', text: '狮子座', hero: '瑶' } }
  assert.equal(
    substParam('https://x/{text}?q={match}&u={qq}&n={nickname}&g={gid}&h={hero}', ctx),
    'https://x/狮子座?q=座&u=10001&n=阿星&g=888&h=瑶',
  )
  assert.deepEqual(
    substParam({ url: 'https://x/{text}', list: ['{match}', '{hero}'] }, ctx),
    { url: 'https://x/狮子座', list: ['座', '瑶'] },
  )
  // vars 为空时占位符原样保留（真实触发不兜底默认值时的行为）
  assert.equal(substParam('{text}', { uid: '', vars: {} }), '{text}')
})

test('renderTemplate：JSON 路径优先，找不到再兜底内置/捕获变量（{match} 不再被抹成空）', () => {
  const ctx = { uid: '10001', nickname: '阿星', gid: '888', vars: { match: '座', text: '狮子座', hero: '瑶' } }
  assert.equal(
    renderTemplate('{data.name}/{data.overall.level}', { data: { name: '狮子座', overall: { level: '大吉' } } }, '', {}),
    '狮子座/大吉',
  )
  // 关键回归：老实现会把 {match}/{text} 在 JSON-path 阶段替换成 ''，内置变量在回复模板里用不了
  assert.equal(
    renderTemplate('匹配={match} 全文={text} QQ={qq} 群={gid} 英雄={hero}', {}, '', ctx),
    '匹配=座 全文=狮子座 QQ=10001 群=888 英雄=瑶',
  )
  // JSON 里真有同名字段时，路径优先于变量
  assert.equal(renderTemplate('{data.match}', { data: { match: 'X' } }, '', { vars: { match: 'Y' } }), 'X')
  // 原始响应体也能当 JSON 兜底
  assert.equal(renderTemplate('{data.name}', {}, STAR_JSON, {}), '狮子座')
  // 真找不到就留空
  assert.equal(renderTemplate('[{nope}]', {}, '', { vars: {} }), '[]')
})

test('normalizeApi：保留参数默认值 d（「测试参数」兜底靠它）+ 关键词归一化为带 mode 的对象', () => {
  const a = normalizeApi({ name: '星座', params: [{ k: 'xz', v: '{text}', d: '狮子座' }], keywords: [' 座$ '], type: 'text' })
  assert.deepEqual(a.params, [{ k: 'xz', v: '{text}', d: '狮子座' }])
  assert.deepEqual(a.keywords, [{ value: '座$', mode: 'regex' }]) // 旧字符串自动补 mode=regex
  assert.equal(a.method, 'GET')
  assert.equal(a.type, 'text')
  assert.equal(a.scope, undefined) // 触发范围已提升为全局，单条 API 不再带 scope
  const b = normalizeApi({ name: 'x', keywords: [{ value: ' 狮子座 ', mode: 'exact' }, { value: '', mode: 'exact' }] })
  assert.deepEqual(b.keywords, [{ value: '狮子座', mode: 'exact' }])
})

// ---- 真实请求链路（probe） ----

test('probe 真实触发：座$ + xz={text} 把整条消息传进 URL，模板里 {match}/{text} 可用', async () => {
  const a = {
    url: 'https://api.tangdouz.com/a/star.php', method: 'GET',
    params: [{ k: 'xz', v: '{text}', d: '狮子座' }, { k: 'return', v: 'json', d: '' }],
    type: 'text', parse: ['$.data'], template: '{data.name}：{data.fortune}（来自{match}/{text}）',
  }
  const ctx = { uid: '10001', nickname: '阿星', gid: '888', vars: { match: '座', text: '狮子座' } }
  const { calls, impl } = captureFetch(STAR_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, ctx, {}, false))
  assert.equal(calls.length, 1)
  const u = new URL(calls[0].url)
  assert.equal(u.searchParams.get('xz'), '狮子座')
  assert.equal(u.searchParams.get('return'), 'json')
  assert.equal(calls[0].opts.method, 'GET')
  assert.equal(r.ok, true)
  assert.equal(r.message, '狮子座：大吉（来自座/狮子座）')
})

test('probe 真实触发：\\S+座$ + xz={match} 传匹配到的整词', async () => {
  const a = {
    url: 'https://api.tangdouz.com/a/star.php', method: 'GET',
    params: [{ k: 'xz', v: '{match}', d: '狮子座' }, { k: 'return', v: 'json', d: '' }],
    type: 'text', parse: ['$.data'], template: '{data.name}',
  }
  const ctx = { uid: '', nickname: '', gid: '888', vars: { match: '狮子座', text: '狮子座' } }
  const { calls, impl } = captureFetch(STAR_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, ctx, {}, false))
  assert.equal(new URL(calls[0].url).searchParams.get('xz'), '狮子座')
  assert.equal(r.ok, true)
  assert.equal(r.message, '狮子座')
})

test('probe：变量直接写在 URL 里也能替换', async () => {
  const a = {
    url: 'https://api.tangdouz.com/a/star.php?xz={text}&return=json',
    params: [], type: 'text', parse: ['$.data'], template: '{data.name}',
  }
  const ctx = { uid: '', nickname: '', gid: '888', vars: { match: '座', text: '狮子座' } }
  const { calls, impl } = captureFetch(STAR_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, ctx, {}, false))
  assert.match(calls[0].url, /xz=狮子座/)
  assert.equal(r.ok, true)
  assert.equal(r.message, '狮子座')
})

test('probe 测试模式（useDefaults=true）：无真实触发语境时用参数默认值兜底', async () => {
  const a = {
    url: 'https://api.tangdouz.com/a/star.php', method: 'GET',
    params: [{ k: 'xz', v: '{text}', d: '狮子座' }, { k: 'return', v: 'json', d: '' }],
    type: 'text', parse: ['$.data'], template: '{data.name}',
  }
  const ctx = { uid: '', nickname: '', gid: '' } // /test 路由的语境：没有 vars
  const { calls, impl } = captureFetch(STAR_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, ctx, {}, true))
  assert.equal(new URL(calls[0].url).searchParams.get('xz'), '狮子座')
  assert.equal(r.ok, true)
  assert.equal(r.message, '狮子座')
})

test('probe 真实触发不兜底默认值：变量缺失时占位符原样送出（不误用默认值）', async () => {
  const a = {
    url: 'https://api.tangdouz.com/a/star.php', method: 'GET',
    params: [{ k: 'xz', v: '{text}', d: '狮子座' }],
    type: 'text', parse: ['$.data'], template: '{data.name}',
  }
  const { calls, impl } = captureFetch(STAR_JSON)
  await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '', vars: {} }, {}, false))
  assert.equal(new URL(calls[0].url).searchParams.get('xz'), '{text}')
})

// ---- 完整消息链路（setup + dispatch） ----

test('setup 消息链路：白名单群命中 座$ → 调接口 → 回复渲染结果', async () => {
  const apis = [{
    id: 'a1', name: '星座', enabled: true,
    url: 'https://api.tangdouz.com/a/star.php', method: 'GET',
    params: [{ k: 'xz', v: '{text}', d: '狮子座' }, { k: 'return', v: 'json', d: '' }],
    type: 'text', parse: ['$.data'], template: '{data.name}：{data.fortune}（来自{match}/{text}）',
    keywords: ['座$'],
  }]
  const { calls, replies, ret } = await runMessage(apis, MSG)
  assert.equal(ret, true)                       // 接管，不再交给模型
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].url).searchParams.get('xz'), '狮子座')
  assert.deepEqual(replies, ['狮子座：大吉（来自座/狮子座）'])
})

test('setup 消息链路：命名捕获回归（(?<xz>\\S+座)$ + xz={xz}）', async () => {
  const apis = [{
    id: 'a2', name: '星座-命名捕获', enabled: true,
    url: 'https://api.tangdouz.com/a/star.php', method: 'GET',
    params: [{ k: 'xz', v: '{xz}', d: '狮子座' }, { k: 'return', v: 'json', d: '' }],
    type: 'text', parse: ['$.data'], template: '{data.name}',
    keywords: ['(?<xz>\\S+座)$'],
  }]
  const { calls, replies, ret } = await runMessage(apis, MSG)
  assert.equal(ret, true)
  assert.equal(new URL(calls[0].url).searchParams.get('xz'), '狮子座')
  assert.deepEqual(replies, ['狮子座'])
})

test('setup 消息链路：非白名单群不触发、不请求', async () => {
  const apis = [{
    id: 'a1', name: '星座', enabled: true, url: 'https://api.tangdouz.com/a/star.php',
    params: [{ k: 'xz', v: '{text}', d: '狮子座' }], type: 'text', template: '{data.name}', keywords: ['座$'],
  }]
  const { calls, replies, ret } = await runMessage(apis, { ...MSG, groupId: '999' })
  assert.equal(ret, false)
  assert.equal(calls.length, 0)
  assert.deepEqual(replies, [])
})

test('setup 消息链路：完全匹配行 —— 整条相等才触发，带前后缀一律不触发', async () => {
  const apis = [{
    id: 'e1', name: '星座-完全匹配', enabled: true, url: 'https://api.tangdouz.com/a/star.php',
    params: [{ k: 'xz', v: '{text}', d: '' }], type: 'text', template: '{data.name}',
    keywords: [{ value: '狮子座', mode: 'exact' }],
  }]
  const exact = await runMessage(apis, { ...MSG, text: '狮子座' })
  assert.equal(exact.ret, true)
  assert.equal(exact.calls.length, 1)
  assert.equal(new URL(exact.calls[0].url).searchParams.get('xz'), '狮子座')
  assert.deepEqual(exact.replies, ['狮子座'])

  const withPrefix = await runMessage(apis, { ...MSG, text: '来点狮子座' })
  assert.equal(withPrefix.ret, false)
  assert.equal(withPrefix.calls.length, 0)
  assert.deepEqual(withPrefix.replies, [])
})

test('setup 消息链路：正则匹配行 —— 旧纯字符串导入后子串匹配行为不变', async () => {
  const apis = [{
    id: 'r1', name: '壁纸', enabled: true, url: 'https://api.tangdouz.com/a/star.php',
    params: [{ k: 'xz', v: '{text}', d: '' }], type: 'text', template: '{data.name}',
    keywords: ['壁纸'], // 旧格式纯字符串 → regex
  }]
  const { calls, ret } = await runMessage(apis, { ...MSG, text: '来点壁纸' })
  assert.equal(ret, true)
  assert.equal(calls.length, 1)
})

// ---- Q2：数组根 JSON 的解析（aa1.cn 神回复接口这类 [{...}] 返回） ----

const AA1_TEXT = '爸妈吵架，可我根本帮不上忙，怎么办?<br>神回复:在旁边鼓掌叫好'
const AA1_CLEAN = '爸妈吵架，可我根本帮不上忙，怎么办?\n神回复:在旁边鼓掌叫好' // htmlToText 后 <br> → 换行
const AA1_JSON = JSON.stringify([{ shenhuifu: AA1_TEXT }])

test('getPath：数组根自动解包，$.shenhuifu / shenhuifu 都能取到', () => {
  const arr = [{ shenhuifu: AA1_TEXT }]
  assert.equal(getPath(arr, '$.shenhuifu'), AA1_TEXT)
  assert.equal(getPath(arr, 'shenhuifu'), AA1_TEXT)
  assert.equal(getPath(arr, '$.0.shenhuifu'), AA1_TEXT) // 显式下标仍精确
  assert.equal(getPath([{ a: { b: 1 } }], '$.a.b'), 1) // 解包后继续往下走
  assert.equal(getPath([{ a: 1 }, { a: 2 }], '$.0.a'), 1) // 数字下标不被解包
  assert.equal(getPath(arr, '$.nope'), undefined) // 数组里没这个字段
})

test('Q2：extract / renderTemplate 对数组根 JSON 用自然路径取值', () => {
  const { value, json } = extract(['$.shenhuifu'], AA1_JSON)
  assert.equal(value, AA1_TEXT)
  assert.ok(Array.isArray(json))
  assert.equal(renderTemplate('神回复：{shenhuifu}', json, AA1_JSON, {}), '神回复：' + AA1_CLEAN)
})

test('Q2：probe 文本类型 + 解析表达式 $.shenhuifu 拿到神回复全文', async () => {
  const a = {
    url: 'https://v.api.aa1.cn/api/api-wenan-shenhuifu/index.php', method: 'GET',
    params: [{ k: 'aa1', v: 'json', d: '' }], type: 'text', parse: ['$.shenhuifu'], template: '',
  }
  const { calls, impl } = captureFetch(AA1_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '888', vars: {} }, {}, false))
  assert.equal(new URL(calls[0].url).searchParams.get('aa1'), 'json')
  assert.equal(r.ok, true)
  assert.equal(r.message, AA1_CLEAN) // <br> 自动转成换行（HTML → 纯文本清洗）
})

// ---- Q1：混合类型（文字 + 媒体直链，分多条消息发） ----

const QIAN_JSON = JSON.stringify({
  error: false, message: '抽签成功', count: 1,
  data: { image_url: 'https://www.xbhblg.top/api/chouqian/gif/44.png', number: 44, interpretation: '观机应变，以智取胜' },
})

test('normalizeParts：丢掉空行、非法类型回退 text', () => {
  assert.deepEqual(normalizeParts([
    { type: 'text', value: '  hi  ' }, { type: 'image', value: '$.data.url' },
    { type: 'wat', value: 'x' }, { type: 'image', value: '' },
  ]), [
    { type: 'text', value: 'hi' }, { type: 'image', value: '$.data.url' }, { type: 'text', value: 'x' },
  ])
  assert.deepEqual(normalizeParts(null), [])
  assert.equal(normalizeApi({ type: 'mixed', parts: [{ type: 'image', value: '$.data.image_url' }] }).type, 'mixed')
  assert.deepEqual(normalizeApi({ type: 'mixed', parts: [{ type: 'image', value: ' $.data.image_url ' }] }).parts,
    [{ type: 'image', value: '$.data.image_url' }])
})

test('Q1：probe 混合类型按消息段顺序返回 segments（文字取字典用模板 + 图片直链）', async () => {
  const a = {
    url: 'https://api.xbhblg.top/API/qian.php', method: 'GET', params: [],
    type: 'mixed',
    parts: [
      { type: 'text', value: '$.data' },           // 取到字典 → 走「回复模板」
      { type: 'image', value: '$.data.image_url' }, // 媒体段不走模板
    ],
    template: '第{number}签 {interpretation}',
    parse: ['$.不存在的全局解析表达式'],            // 全局解析表达式对混合类型无效
  }
  const { calls, impl } = captureFetch(QIAN_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '888', vars: {} }, {}, false))
  assert.equal(calls.length, 1) // probe 只请求接口，媒体下载交给 dispatch
  assert.equal(r.ok, true)
  assert.equal(r.type, 'mixed')
  assert.deepEqual(r.segments, [
    { type: 'text', text: '第44签 观机应变，以智取胜' },
    { type: 'image', mediaUrl: 'https://www.xbhblg.top/api/chouqian/gif/44.png' },
  ])
})

test('Q1：混合文字段取到非字典 → 直接回该值、不走回复模板', async () => {
  const a = {
    url: 'https://api.xbhblg.top/API/qian.php', params: [], type: 'mixed',
    parts: [{ type: 'text', value: '$.data.interpretation' }], // 字符串
    template: '这段模板不该生效 {number}',
  }
  const { impl } = captureFetch(QIAN_JSON)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '', vars: {} }, {}, false))
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments, [{ type: 'text', text: '观机应变，以智取胜' }])
})

test('Q1：probe 混合类型某媒体段没挖到直链 → 跳过且不影响文字段；全空则报错', async () => {
  const NO_URL = JSON.stringify({ data: { number: 44, interpretation: '观机应变' } }) // 全文无任何 http 直链
  const a = {
    url: 'https://api.xbhblg.top/API/qian.php', params: [], type: 'mixed',
    parts: [{ type: 'text', value: '$.data.interpretation' }, { type: 'image', value: '$.nope' }],
  }
  const { impl } = captureFetch(NO_URL)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '', vars: {} }, {}, false))
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments, [{ type: 'text', text: '观机应变' }])
  assert.match(r.message, /跳过/)

  const empty = await withFetch(impl, () => probe(fakeApi(''), { ...a, parts: [{ type: 'image', value: '$.nope' }] },
    { uid: '', nickname: '', gid: '', vars: {} }, {}, false))
  assert.equal(empty.ok, false)
  assert.match(empty.message, /没有任何有效段/)
})

test('Q1：setup 消息链路混合类型 → 文字 reply + 图片 sendSegments，分成两条消息', async () => {
  const apis = [{
    id: 'm1', name: '抽签', enabled: true,
    url: 'https://api.xbhblg.top/API/qian.php', method: 'GET', params: [],
    type: 'mixed',
    parts: [
      { type: 'text', value: '$.data' },
      { type: 'image', value: '$.data.image_url' },
    ],
    template: '第{number}签 {interpretation}',
    keywords: ['抽签'],
  }]
  const { calls, replies, segments, ret } = await runMessage(apis, { ...MSG, text: '抽签' }, { body: QIAN_JSON })
  assert.equal(ret, true)
  assert.equal(calls.length, 2) // ① 接口请求 ② 图片直链下载（sendOneMedia）
  assert.deepEqual(replies, ['第44签 观机应变，以智取胜'])
  assert.equal(segments.length, 1)
  assert.equal(segments[0].chatId, 'group:888')
  assert.equal(segments[0].segs[0].type, 'image')
  assert.match(segments[0].segs[0].data.file, /^base64:\/\//)
})

test('Q1：混合类型回复模板可用 {match}/{text} 内置变量', async () => {
  const apis = [{
    id: 'm2', name: '抽签', enabled: true,
    url: 'https://api.xbhblg.top/API/qian.php', method: 'GET', params: [],
    type: 'mixed', parts: [{ type: 'text', value: '$.data' }],
    template: '{text} → {match} 第{number}签', keywords: ['抽签$'],
  }]
  const { replies } = await runMessage(apis, { ...MSG, text: '求抽签' }, { body: QIAN_JSON })
  assert.deepEqual(replies, ['求抽签 → 抽签 第44签'])
})

test('Q1：错误模板对所有类型生效（解析失败也走 replyError）', async () => {
  const apis = [{
    id: 'm3', name: '抽签', enabled: true,
    url: 'https://api.xbhblg.top/API/qian.php', method: 'GET', params: [],
    type: 'image', parse: ['$.data.missing'], keywords: ['抽签'],
    errorTpl: '抱歉 {nickname}：{error}',
  }]
  const { replies } = await runMessage(apis, { ...MSG, nickname: '阿星', text: '抽签' }) // STAR_JSON 无图片直链
  assert.equal(replies.length, 1)
  assert.match(replies[0], /抱歉 阿星：/)
})

// ---- 生效范围（全局）：触发范围 + 触发人黑名单 ----

const SCOPE_APIS = [{
  id: 'g1', name: '星座', enabled: true, url: 'https://api.tangdouz.com/a/star.php',
  params: [{ k: 'xz', v: '{text}', d: '狮子座' }], type: 'text', template: '{data.name}',
  keywords: [{ value: '狮子座', mode: 'exact' }],
}]

test('全局 scope=owner：非主人不触发、不请求；主人（isOwner=true）照常触发', async () => {
  const no = await runMessage(SCOPE_APIS, MSG, { scope: 'owner' })
  assert.equal(no.ret, false)
  assert.equal(no.calls.length, 0)
  assert.deepEqual(no.replies, [])
  const yes = await runMessage(SCOPE_APIS, MSG, { scope: 'owner', isOwner: () => true })
  assert.equal(yes.ret, true)
  assert.equal(yes.calls.length, 1)
})

test('全局 scope=everyone（默认）所有人放行；旧 pool 缺 scope/blacklist 也不变', async () => {
  const r = await runMessage(SCOPE_APIS, MSG, {}) // 不写 scope/blacklist，模拟旧配置
  assert.equal(r.ret, true)
  assert.equal(r.calls.length, 1)
})

test('触发人黑名单：被拉黑的 QQ 不触发且不请求，其他群友照常', async () => {
  const blocked = await runMessage(SCOPE_APIS, MSG, { blacklist: ['10001'] })
  assert.equal(blocked.ret, false)
  assert.equal(blocked.calls.length, 0)
  const other = await runMessage(SCOPE_APIS, { ...MSG, userId: '10002' }, { blacklist: ['10001'] })
  assert.equal(other.ret, true)
  assert.equal(other.calls.length, 1)
})

test('黑名单对主人也生效：isOwner=true 但 QQ 在黑名单里，仍不触发', async () => {
  const r = await runMessage(SCOPE_APIS, MSG, { blacklist: ['10001'], isOwner: () => true })
  assert.equal(r.ret, false)
  assert.equal(r.calls.length, 0)
})

test('单条 API 的旧 a.scope 字段已失效，改由全局 cfg.scope 控制', async () => {
  const apis = SCOPE_APIS.map((a) => ({ ...a, scope: 'owner' })) // 老数据里残留的单条 scope
  const r = await runMessage(apis, MSG, { scope: 'everyone' })
  assert.equal(r.ret, true) // 全局 everyone 放行，单条 owner 不再拦
  const blocked = await runMessage(apis, MSG, { scope: 'owner' })
  assert.equal(blocked.ret, false) // 全局 owner 拦住非主人
})

test('/settings 落盘全局生效群 / 触发范围 / 黑名单，/groups 仍兼容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    writeFileSync(join(root, 'apipool', 'pool.json'), JSON.stringify({ groups: [], apis: [] }), 'utf8')
    const api = fakeApi(root)
    mod.setup(api)
    api.body = { groups: ['888', 'group:999'], scope: 'owner', blacklist: ['10001', ' 10002 ', ''] }
    const r = await api.routes['/settings']({})
    assert.equal(r.ok, true)
    assert.deepEqual(r.groups, ['888', '999'])
    assert.equal(r.scope, 'owner')
    assert.deepEqual(r.blacklist, ['10001', '10002'])
    const saved = JSON.parse(readFileSync(join(root, 'apipool', 'pool.json'), 'utf8'))
    assert.deepEqual(saved.groups, ['888', '999'])
    assert.equal(saved.scope, 'owner')
    assert.deepEqual(saved.blacklist, ['10001', '10002'])
    // 旧路由名 /groups 也能保存同一套设置
    assert.equal(typeof api.routes['/groups'], 'function')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadPool 归一化：旧文件缺 scope 补 everyone、blacklist 去空去空格后生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    // 模拟升级前的旧 pool.json：没有 scope / blacklist 字段
    writeFileSync(join(root, 'apipool', 'pool.json'),
      JSON.stringify({ groups: ['888'], apis: SCOPE_APIS }), 'utf8')
    const api = fakeApi(root)
    mod.setup(api)
    const { calls, impl } = captureFetch(STAR_JSON)
    let ret
    await withFetch(impl, async () => { ret = await api.handlers.message(MSG) })
    assert.equal(ret, true)          // 缺 scope → 默认 everyone，照常触发
    assert.equal(calls.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- API 库密钥（只写 + Bearer 自动带 + 导出脱敏） ----

const LIB = { id: 'lib1', name: 'tinyaii', base: 'https://api.tinyaii.cn', key: 'sk_secret_123' }
const LIB_A = {
  id: 'lk1', name: '查 IP', enabled: true, libId: 'lib1', path: 'v1/ip',
  method: 'GET', params: [{ k: 'ip', v: '8.8.8.8', d: '' }],
  type: 'text', parse: ['$.data'], template: '{data.ip}',
  keywords: [{ value: '查IP', mode: 'exact' }],
}

test('libKey：选了库就取该库密钥，库不存在 / 没选库都返回空串', () => {
  const cfg = { libraries: [LIB] }
  assert.equal(libKey(LIB_A, cfg), 'sk_secret_123')
  assert.equal(libKey({ libId: 'nope' }, cfg), '')
  assert.equal(libKey({ url: 'https://x.cn' }, cfg), '')
  assert.equal(libKey(null, cfg), '')
  // 旧配置库对象无 key 字段 → 空串（不需要密钥）
  assert.equal(libKey(LIB_A, { libraries: [{ id: 'lib1', base: 'https://x' }] }), '')
})

test('probe：选了带密钥的库 → 请求自动加 Authorization: Bearer；留空 / 不选库都不带', async () => {
  const ctx = { uid: '', nickname: '', gid: '888', vars: {} }
  // 带密钥
  {
    const { calls, impl } = captureFetch(STAR_JSON)
    await withFetch(impl, () => probe(fakeApi(''), LIB_A, ctx, { libraries: [LIB] }, false))
    assert.equal(calls[0].opts.headers['Authorization'], 'Bearer sk_secret_123')
  }
  // 库密钥留空
  {
    const { calls, impl } = captureFetch(STAR_JSON)
    await withFetch(impl, () => probe(fakeApi(''), LIB_A, ctx, { libraries: [{ ...LIB, key: '' }] }, false))
    assert.equal(calls[0].opts.headers['Authorization'], undefined)
  }
  // 不选库（直连 URL）
  {
    const { calls, impl } = captureFetch(STAR_JSON)
    await withFetch(impl, () => probe(fakeApi(''), { ...LIB_A, libId: '', url: 'https://x.cn/v1/ip' }, ctx, { libraries: [LIB] }, false))
    assert.equal(calls[0].opts.headers['Authorization'], undefined)
  }
})

test('probe：POST 请求同样带 Bearer，且密钥不泄进后续媒体直链下载', async () => {
  const a = { ...LIB_A, method: 'POST' }
  const { calls, impl } = captureFetch(STAR_JSON)
  await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '888', vars: {} }, { libraries: [LIB] }, false))
  const req = calls[0]
  assert.equal(req.opts.method, 'POST')
  assert.equal(req.opts.headers['Authorization'], 'Bearer sk_secret_123')
  assert.equal(req.opts.headers['content-type'], 'application/x-www-form-urlencoded')
})

test('setup 消息链路：选了带密钥库的接口触发 → 请求头带 Bearer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    writeFileSync(join(root, 'apipool', 'pool.json'),
      JSON.stringify({ groups: ['888'], libraries: [LIB], apis: [LIB_A] }), 'utf8')
    const api = fakeApi(root)
    mod.setup(api)
    const { calls, impl } = captureFetch(JSON.stringify({ data: { ip: '8.8.8.8' } }))
    let ret
    await withFetch(impl, async () => { ret = await api.handlers.message({ ...MSG, text: '查IP' }) })
    assert.equal(ret, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].opts.headers['Authorization'], 'Bearer sk_secret_123')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/pool 与 /libs 只回 hasKey，绝不回明文密钥；/libSave 外部视图也脱敏', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    writeFileSync(join(root, 'apipool', 'pool.json'), JSON.stringify({ libraries: [LIB] }), 'utf8')
    const api = fakeApi(root)
    mod.setup(api)
    const pool = (await api.routes['/pool']({})).pool
    assert.deepEqual(pool.libraries, [{ id: 'lib1', name: 'tinyaii', base: 'https://api.tinyaii.cn', hasKey: true }])
    assert.equal(JSON.stringify(pool).includes('sk_secret_123'), false)
    const libs = (await api.routes['/libs']({})).libs
    assert.equal(libs[0].hasKey, true)
    assert.equal(libs[0].key, undefined)
    assert.equal(JSON.stringify(libs).includes('sk_secret_123'), false)
    api.body = { lib: { id: 'lib1', name: 'tinyaii2', base: 'https://api.tinyaii.cn', key: '' } }
    const saved = await api.routes['/libSave']({})
    assert.equal(saved.libs[0].hasKey, true)
    assert.equal(saved.libs[0].key, undefined)
    assert.equal(JSON.stringify(saved).includes('sk_secret_123'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/libSave：留空 key 保留旧密钥、填新值替换、clearKey 才清空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    const file = join(root, 'apipool', 'pool.json')
    writeFileSync(file, JSON.stringify({ libraries: [LIB] }), 'utf8')
    const api = fakeApi(root)
    mod.setup(api)
    const read = () => JSON.parse(readFileSync(file, 'utf8'))
    // 编辑库名/地址，key 留空 = 不改 → 旧密钥保留
    api.body = { lib: { id: 'lib1', name: '改名', base: 'https://api.tinyaii.cn', key: '' } }
    await api.routes['/libSave']({})
    assert.equal(read().libraries[0].key, 'sk_secret_123')
    assert.equal(read().libraries[0].name, '改名')
    // 填新值 = 替换
    api.body = { lib: { id: 'lib1', name: '改名', base: 'https://api.tinyaii.cn', key: 'sk_new' } }
    await api.routes['/libSave']({})
    assert.equal(read().libraries[0].key, 'sk_new')
    // clearKey=true = 清空
    api.body = { lib: { id: 'lib1', name: '改名', base: 'https://api.tinyaii.cn', key: '', clearKey: true } }
    await api.routes['/libSave']({})
    assert.equal(read().libraries[0].key, '')
    // 新建库留空 = 不需要密钥
    api.body = { lib: { name: '新库', base: 'https://free.cn', key: '' } }
    await api.routes['/libSave']({})
    assert.equal(read().libraries.find((l) => l.name === '新库').key, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/export 导出的文件里绝不含库密钥（只有 id/name/base）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-apipool-'))
  try {
    mkdirSync(join(root, 'apipool'), { recursive: true })
    writeFileSync(join(root, 'apipool', 'pool.json'),
      JSON.stringify({ groups: ['888'], libraries: [LIB], apis: [LIB_A] }), 'utf8')
    const api = fakeApi(root)
    // 把下载目录指到临时目录，避免写到真实系统下载目录
    api.downloadDir = () => root
    mod.setup(api)
    const r = await api.routes['/export']({})
    assert.equal(r.ok, true)
    const dump = readFileSync(r.path, 'utf8')
    assert.equal(dump.includes('sk_secret_123'), false)
    const payload = JSON.parse(dump)
    assert.deepEqual(payload.libraries, [{ id: 'lib1', name: 'tinyaii', base: 'https://api.tinyaii.cn' }])
    assert.equal(payload.groups, undefined) // 本机生效设置也不导出
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- HTML → 纯文本清洗（接口字段里夹的 <strong>/<br>/<small> 等，QQ 不渲染 HTML） ----

const HTML_RICH = '<strong>优势潜力 (木):</strong> 有贵人相助<br>事业顺利<small>(提示：仅供参考)</small>'
const HTML_CLEAN = '优势潜力 (木): 有贵人相助\n事业顺利(提示：仅供参考)'

test('htmlToText：剥标签 / <br> 转换行 / 实体解码 / 无标签原样 / 非字符串原样', () => {
  assert.equal(htmlToText(HTML_RICH), HTML_CLEAN)
  assert.equal(htmlToText('<p>一</p><p>二</p>'), '一\n二')
  assert.equal(htmlToText('<ul><li>甲</li><li>乙</li></ul>'), '• 甲\n\n• 乙')
  assert.equal(htmlToText('A&nbsp;B&amp;C&lt;D&gt;E&quot;F&apos;G&#72;&#x49;'), `A B&C<D>E"F'GHI`)
  // 无标签/实体 → 原样返回（连 trim 都不做），< 后不是字母不当标签，URL 里的 & 不当实体
  assert.equal(htmlToText('普通文本 没有标签'), '普通文本 没有标签')
  assert.equal(htmlToText(' 前后有空格 '), ' 前后有空格 ')
  assert.equal(htmlToText('a < b > c'), 'a < b > c')
  assert.equal(htmlToText('x<5 y>3'), 'x<5 y>3')
  assert.equal(htmlToText('https://x.cn/a?p=1&q=2'), 'https://x.cn/a?p=1&q=2')
  assert.equal(htmlToText(123), 123)
  assert.equal(htmlToText(null), null)
  assert.equal(htmlToText(undefined), undefined)
})

test('清洗：renderTemplate 的模板路径取值也自动清洗', () => {
  const root = { data: { fortune: HTML_RICH } }
  assert.equal(renderTemplate('运势：{data.fortune}', root, '', {}), '运势：' + HTML_CLEAN)
})

test('清洗：probe 文本类型（有模板 / 无模板）都把字段里的 HTML 转成纯文本', async () => {
  const body = JSON.stringify({ data: { fortune: HTML_RICH } })
  const base = { url: 'https://x.cn/api', method: 'GET', params: [], type: 'text' }
  const ctx = { uid: '', nickname: '', gid: '', vars: {} }
  {
    const { impl } = captureFetch(body)
    const r = await withFetch(impl, () => probe(fakeApi(''), { ...base, parse: ['$.data'], template: '{data.fortune}' }, ctx, {}, false))
    assert.equal(r.ok, true)
    assert.equal(r.message, HTML_CLEAN)
  }
  {
    const { impl } = captureFetch(body)
    const r = await withFetch(impl, () => probe(fakeApi(''), { ...base, parse: ['$.data.fortune'], template: '' }, ctx, {}, false))
    assert.equal(r.ok, true)
    assert.equal(r.message, HTML_CLEAN)
  }
})

test('清洗：混合类型文字段（非字典直发）也清洗 HTML', async () => {
  const body = JSON.stringify({ data: { fortune: HTML_RICH } })
  const a = { url: 'https://x.cn/api', params: [], type: 'mixed', parts: [{ type: 'text', value: '$.data.fortune' }] }
  const { impl } = captureFetch(body)
  const r = await withFetch(impl, () => probe(fakeApi(''), a, { uid: '', nickname: '', gid: '', vars: {} }, {}, false))
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments, [{ type: 'text', text: HTML_CLEAN }])
})

test('清洗：错误模板里夹的 HTML 也会被清洗', async () => {
  const apis = [{
    id: 'e', name: '抽签', enabled: true, url: 'https://x.cn/api',
    type: 'image', parse: ['$.nope'], keywords: ['抽签'],
    errorTpl: '<b>抱歉</b><br>{error}',
  }]
  const { replies } = await runMessage(apis, { ...MSG, text: '抽签' }) // STAR_JSON 无图片直链 → 走错误模板
  assert.equal(replies.length, 1)
  assert.equal(replies[0].includes('<b>'), false)
  assert.equal(replies[0].includes('<br>'), false)
  assert.match(replies[0], /^抱歉\n/)
})
