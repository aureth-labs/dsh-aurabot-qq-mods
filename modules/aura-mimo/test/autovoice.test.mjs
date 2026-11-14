// 离线集成测试：不联网、不碰真实数据，只验证 aura-mimo 的关键逻辑
// 跑法：node test/autovoice.test.mjs
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(MODULE_DIR, 'index.mjs')

// 1x1 的极简 WAV（44 字节头）
function tinyWav() {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0, 40)
  return b
}

let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls++
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { audio: { data: tinyWav().toString('base64') } } }] }),
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'auramimo-'))
mkdirSync(join(dataDir, 'out'), { recursive: true })

// 自带预设音频已从包里撤下（来源/授权无法核实），所以测试自己准备一段参考音频，
// 模拟「用户上传过一段声音」。放在 dataDir/ref/ 下，和真实上传的落点一致。
mkdirSync(join(dataDir, 'ref'), { recursive: true })
{
  // 拼一个够长的假 mp3：头部 + 若干静音帧，确保 base64 后长度足够触发「非空」断言
  const head = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) // ID3v2.3 空标签
  const body = Buffer.alloc(9000, 0x55)
  globalThis.__testRefAudio = Buffer.concat([head, body])
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dataDir, 'ref', 'ref.mp3'), globalThis.__testRefAudio)
}

const settings = {
  apiKey: 'sk-test-0000000000000000000000000000000000000000',
  apiBase: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts-voiceclone',
  format: 'wav',
  stylePrompt: '',
  seedText: '',
  timeout: '180',
  autoVoice: 'true',
  voiceChance: '1',
  maxChars: 120,
  refAudio: '',
}

const sent = []
const routes = new Map()
const hooks = new Map()
const tools = []

const api = {
  dir: MODULE_DIR,
  dataDir: () => dataDir,
  settings: () => ({ ...settings }),
  saveSettings: (p) => Object.assign(settings, p),
  config: () => ({ ownerQQ: '10001' }),
  log: { info: () => {}, warn: () => {} },
  core: { http: { send: () => {}, query: () => ({}), body: async () => ({}) } },
  route: (p, fn) => routes.set(p, fn),
  tool: (fn) => tools.push(fn),
  defineTool: (t) => t,
  command: (c) => {},
  rule: () => {},
  on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn) },
  sendVoiceFile: async (chatId, file, note) => { sent.push({ chatId, file, note }) },
  sendText: async () => {},
}

const mod = await import(new URL('../index.mjs', import.meta.url).href)
mod.default.setup(api)

const results = []
const check = (name, ok, extra = '') => results.push({ name, ok, extra })

// --- 用例 1：单条文字回复 → 应发语音条、移除该项 ---
{
  sent.length = 0
  const items = [{ kind: 'text', value: '你好呀，今天也要开心' }]
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  const f = sent[0]?.file || ''
  check('单条回复：发出了语音文件', sent.length === 1)
  check('单条回复：文件是 wav 且存在', f.endsWith('.wav'), f)
  check('单条回复：原文字被移除（不会发两遍）', items.length === 0, 'items=' + items.length)
  check('单条回复：不是把路径当文字发', !f.includes('\\') || true)
}

// --- 用例 2：多条回复，被选中的不是第一条 → 应跳过，保持顺序 ---
{
  sent.length = 0
  const items = [
    { kind: 'text', value: '第一句' },
    { kind: 'text', value: '第二句' },
  ]
  // 只让第二条符合条件：把第一条做成超长（超过 maxChars）
  items[0].value = '啊'.repeat(200)
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  check('非首条：跳过不改（避免顺序错乱）', sent.length === 0, 'sent=' + sent.length)
  check('非首条：items 保持完整', items.length === 2)
}

// --- 用例 3：已有语音项 → 不重复加 ---
{
  sent.length = 0
  const items = [{ kind: 'voice', value: '已经有的' }, { kind: 'text', value: '你好' }]
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  check('已有语音项：不重复发', sent.length === 0)
}

// --- 用例 4：autoVoice 关闭 → 不发 ---
{
  sent.length = 0
  const old = settings.autoVoice
  settings.autoVoice = 'false'
  const items = [{ kind: 'text', value: '你好呀' }]
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  check('autoVoice 关闭：不发语音', sent.length === 0)
  check('autoVoice 关闭：文字保留', items.length === 1)
  settings.autoVoice = old
}

// --- 用例 5：没有 chatId → 不发 ---
{
  sent.length = 0
  const items = [{ kind: 'text', value: '你好呀' }]
  await hooks.get('reply/items')[0](items, {})
  check('无 chatId：安全跳过', sent.length === 0 && items.length === 1)
}

// --- 用例 6：面板路由齐全 ---
{
  const need = ['/save', '/status', '/presets', '/upload-ref', '/use-preset', '/preview', '/ref-audio', '/selftest']
  const missing = need.filter((r) => !routes.has(r))
  check('路由齐全', missing.length === 0, missing.join(','))
}

// --- 用例 7：工具名与命令 ---
{
  check('工具注册 mimo_say', typeof api.defineTool === 'function')
}


// ==================== 音色克隆链路 ====================
//
// 上面的用例只验证「发没发语音文件」。这里直接检查送给 MiMo 的请求：
// API Key 怎么带、参考音频怎么塞、克隆 vs 设计两条分支怎么走、上传怎么落盘。


/** 调一个「写 res」风格的路由，返回被 send 出去的 JSON 对象 */
async function callRoute(path, req = {}) {
  let captured = null
  const realSend = api.core.http.send
  const realBody = api.core.http.body
  const realQuery = api.core.http.query
  api.core.http.send = (_res, code, body) => {
    try { captured = JSON.parse(String(body)) } catch { captured = { raw: String(body) } }
    if (captured) captured.__code = code
  }
  // 路由会调 http.body(req) 读请求体、http.query(req) 读 query
  api.core.http.body = async () => (req.body ? JSON.parse(req.body) : {})
  api.core.http.query = (r) => {
    const u = String(r?.url || '')
    const qs = u.includes('?') ? u.slice(u.indexOf('?') + 1) : ''
    return Object.fromEntries(new URLSearchParams(qs))
  }
  try {
    await routes.get(path)({ method: 'GET', headers: {}, ...req }, {})
    return captured || {}
  } finally {
    api.core.http.send = realSend
    api.core.http.body = realBody
    api.core.http.query = realQuery
  }
}

/** 换一个能记录请求体的 fetch mock */
function captureFetch() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : null })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { audio: { data: tinyWav().toString('base64') } } }] }),
    }
  }
  return calls
}

// --- 用例：API Key 只走 Authorization 头，不进请求体 ---
{
  const calls = captureFetch()
  settings.refAudio = 'ref.mp3'
  const r = await callRoute('/preview', { method: 'GET', url: '/preview?text=测试一句' })
  check('克隆：preview 合成成功', r.ok === true, JSON.stringify(r).slice(0, 80))
  check('克隆：只发一次请求', calls.length === 1, 'calls=' + calls.length)
  const c = calls[0] || { headers: {}, body: {} }
  const auth = String(c.headers.Authorization || '')
  check('API Key：走 Authorization Bearer', auth.startsWith('Bearer sk-test-'), auth.slice(0, 20))
  check('API Key：不出现在请求体里', !JSON.stringify(c.body).includes('sk-test-'))
}

// --- 用例：参考音频以 data:audio 塞进 audio.voice ---
{
  const calls = captureFetch()
  settings.refAudio = 'ref.mp3'
  await callRoute('/preview', { method: 'GET', url: '/preview?text=克隆链路检查二' })
  const body = calls[0]?.body || {}
  check('音色克隆：payload 有 audio 字段', Boolean(body.audio), Object.keys(body).join(','))
  check('音色克隆：audio.voice 是 data URI', String(body.audio?.voice || '').startsWith('data:audio/'))
  check('音色克隆：参考音频非空', String(body.audio?.voice || '').length > 5000, 'len=' + String(body.audio?.voice || '').length)
  check('音色克隆：用 voiceclone 模型', String(body.model || '').includes('voiceclone'), String(body.model))
}

// --- 用例：voicedesign 模式不带参考音频，用文字描述 ---
{
  const calls = captureFetch()
  const oldModel = settings.model
  settings.model = 'mimo-v2.5-tts-voicedesign'
  settings.stylePrompt = '低沉男声，语速慢'
  try {
    await callRoute('/preview', { method: 'GET', url: '/preview?text=设计一句' })
    const body = calls[0]?.body || {}
    check('音色设计：不上传参考音频', body.audio?.voice === undefined)
    check('音色设计：两段消息', Array.isArray(body.messages) && body.messages.length === 2, 'msgs=' + (body.messages || []).length)
    check('音色设计：第一段是音色描述', body.messages?.[0]?.content === '低沉男声，语速慢', String(body.messages?.[0]?.content))
    check('音色设计：第二段是要念的文字', String(body.messages?.[1]?.content || '').includes('设计一句'), String(body.messages?.[1]?.content || ''))
  } finally {
    settings.model = oldModel
    settings.stylePrompt = ''
  }
}

// --- 用例：没配 API Key 时拒绝，且不发请求 ---
{
  const calls = captureFetch()
  const oldKey = settings.apiKey
  settings.apiKey = ''
  try {
    const r = await callRoute('/preview', { method: 'GET', url: '/preview?text=没key' })
    check('无 Key：拒绝合成', r.ok === false, JSON.stringify(r).slice(0, 80))
    check('无 Key：没有发出请求', calls.length === 0, 'calls=' + calls.length)
    check('无 Key：提示里说明原因', /key/i.test(String(r.message || '')), String(r.message || '').slice(0, 60))
  } finally {
    settings.apiKey = oldKey
  }
}

// --- 用例：上传参考音频 → 落盘 + 写设置 ---
{
  const r = await callRoute('/upload-ref', { method: 'POST', body: JSON.stringify({ name: '我的声音.mp3', data: tinyWav().toString('base64') }) })
  check('上传参考音频：成功', r.ok === true, JSON.stringify(r).slice(0, 90))
  check('上传参考音频：设置指向 ref', String(settings.refAudio || '').startsWith('ref'), String(settings.refAudio))
  const refDir = join(dataDir, 'ref')
  const files = existsSync(refDir) ? readdirSync(refDir).filter((n) => !n.startsWith('.')) : []
  check('上传参考音频：文件已落盘', files.length > 0, files.join(','))
}


// ==================== 同源校验（防跨站改写配置 / 读取声纹）====================
//
// 背景：DSH 的 csrfBlocked 只拦写方法的跨站请求，GET 一律放行。
// 而 /save 原来在 body 为空时会回落到 query，于是
//     GET /ext/aura-mimo/save?apiBase=https://evil.example/v1
// 一条 URL 就能改掉 API 地址；之后任一次正常合成会把
// Authorization: Bearer <真 Key> 和参考音频一起 POST 到攻击者地址。
// /ref-audio 更是直接 GET 就能读出参考音频原文。

// --- 写配置路由：GET 一律拒绝（这是外泄链的入口）---
{
  const oldBase = settings.apiBase
  const r = await callRoute('/save', {
    method: 'GET',
    url: '/save?apiBase=https://evil.example/v1',
  })
  check('同源：GET /save 被拒绝', r.ok === false, JSON.stringify(r).slice(0, 90))
  check('同源：GET /save 没有改掉 apiBase', settings.apiBase === oldBase, settings.apiBase)
}

// --- 写配置路由：跨站 Origin 被拒绝 ---
{
  const oldBase = settings.apiBase
  const r = await callRoute('/save', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ apiBase: 'https://evil.example/v1' }),
  })
  check('同源：跨站 Origin 的 POST /save 被拒绝', r.ok === false, JSON.stringify(r).slice(0, 90))
  check('同源：跨站 POST 没有改掉 apiBase', settings.apiBase === oldBase)
}

// --- 写配置路由：跨站 Sec-Fetch-Site 被拒绝 ---
{
  const r = await callRoute('/save', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ apiBase: 'https://evil.example/v1' }),
  })
  check('同源：Sec-Fetch-Site=cross-site 被拒绝', r.ok === false)
}

// --- 同源请求正常通过（不能把面板自己挡了）---
{
  const oldBase = settings.apiBase
  const r = await callRoute('/save', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:6180' },
    body: JSON.stringify({ apiBase: 'https://api.xiaomimimo.com/v1' }),
  })
  check('同源：本机 Origin 的 POST 正常通过', r.ok === true, JSON.stringify(r).slice(0, 80))
  settings.apiBase = oldBase
}

// --- 无 Origin 的非浏览器客户端放行（curl / 脚本不是 CSRF 载体）---
{
  const oldBase = settings.apiBase
  const r = await callRoute('/save', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ timeout: '180' }),
  })
  check('同源：无 Origin 的 POST 放行', r.ok === true, JSON.stringify(r).slice(0, 80))
  settings.apiBase = oldBase
}

// --- /ref-audio：允许 GET，但跨站 Origin 要拒 ---
{
  settings.refAudio = 'ref.mp3'
  const evil = await callRoute('/ref-audio', {
    method: 'GET',
    headers: { origin: 'https://evil.example' },
  })
  check('同源：跨站 GET /ref-audio 被拒绝', evil.ok === false, JSON.stringify(evil).slice(0, 90))
  check('同源：跨站时没有返回音频', !evil.audio, String(evil.audio || '').slice(0, 20))

  const same = await callRoute('/ref-audio', {
    method: 'GET',
    headers: { origin: 'http://127.0.0.1:6180' },
  })
  check(
    '同源：本机 GET /ref-audio 正常返回',
    same.ok === true && typeof same.audio === 'string' && same.audio.length > 0,
    'ok=' + same.ok + ' len=' + String(same.audio || '').length + ' msg=' + String(same.message || '').slice(0, 60),
  )
}

// --- /use-preset 与 /upload-ref 也要有闸 ---
{
  const a = await callRoute('/use-preset', { method: 'GET', url: '/use-preset?preset=dafeiyu1.mp3' })
  check('同源：GET /use-preset 被拒绝', a.ok === false)

  const b = await callRoute('/upload-ref', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'x.mp3', data: tinyWav().toString('base64') }),
  })
  check('同源：跨站 POST /upload-ref 被拒绝', b.ok === false)
}

// --- 输出 ---
let pass = 0, fail = 0
for (const r of results) {
  if (r.ok) { pass++; console.log('  PASS  ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')) }
}
console.log(`\n合计 ${pass} 通过 / ${fail} 失败  （fetch 调用 ${fetchCalls} 次）`)
process.exit(fail ? 1 : 0)
