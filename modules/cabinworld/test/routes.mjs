// 面板路由：只认回环 + 只收 POST；不发网络请求、不写配置。
// 用法：node test/routes.mjs

import path from 'node:path'
import mod from '../index.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}
const firstLine = (s) => String(s || '').split('\n')[0]

const routes = new Map()
const commands = new Map()
const missing = path.join(process.env.TEMP || '.', 'cabinworld-routes-missing')
let bodyFails = false

const settings = {
  gameDir: missing,
  bridgeJson: path.join(missing, 'bridge.json'),
  waitMs: 30000,
  writeMemory: false,
}

const api = {
  id: mod.id, version: '1.2.1', apiVersion: 1, source: 'user', dir: process.cwd(),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  settings: () => settings,
  defineTool: (spec) => ({ ...spec }),
  tool: () => () => {},
  rule: () => () => {},
  context: () => () => {},
  every: () => () => {},
  on: () => () => {},
  command: (c) => { commands.set(c.name, c); return () => {} },
  route: (p, h) => { routes.set(p, h); return () => {} },
  use: () => null,
  send: async () => {},
  sendText: async () => {},
  config: () => ({ ownerQQ: '', ownerName: '' }),
  core: {
    hub: { turnSendersAllOwner: () => true },
    http: {
      send: (res, status, body) => { res.status = status; res.body = body },
      body: async () => { if (bodyFails) throw new Error('请求体解析失败'); return {} },
    },
  },
  dataDir: () => process.env.TEMP || '.',
}

await mod.setup(api)

function fakeReq(opts) {
  const o = opts || {}
  return { method: o.method || 'GET', socket: { remoteAddress: o.addr || '127.0.0.1' }, headers: o.headers || {} }
}

async function call(route, req) {
  const handler = routes.get(route)
  if (!handler) throw new Error('没有注册路由 ' + route)
  const res = { status: 0, body: null }
  const out = await handler(req, res)
  if (!res.status) { res.status = 200; res.body = out }
  return res
}

ok(routes.size > 0 && commands.has('小屋'), 'setup 注册了路由和命令', routes.size + ' 个路由')

const health = await call('/health', fakeReq({}))
ok(health.status === 200, '回环 GET /health → 200', 'status ' + health.status + ' ' + firstLine(JSON.stringify(health.body || {})))

// 字段形状：面板靠 install.phase 画进度、靠 pendingRestart 提醒重启，两个都不能是 undefined
const healthBody = health.body || {}
ok(healthBody.install && typeof healthBody.install === 'object' && !Array.isArray(healthBody.install), '/health 里 install 是对象', typeof healthBody.install)
ok(Object.prototype.hasOwnProperty.call(healthBody, 'pendingRestart'), '/health 里有 pendingRestart 字段', JSON.stringify(healthBody.pendingRestart))

const away = await call('/health', fakeReq({ addr: '10.0.0.5' }))
ok(away.status === 403, '非回环 10.0.0.5 → 403', 'status ' + away.status)

const evil = await call('/health', fakeReq({ headers: { origin: 'https://evil.example' } }))
ok(evil.status === 403, '回环但 Origin 跨站 → 403', 'status ' + evil.status)

const notPost = await call('/apply-name', fakeReq({ method: 'GET' }))
ok(notPost.status === 405, 'GET /apply-name → 405', 'status ' + notPost.status)

bodyFails = true
const badBody = await call('/apply-name', fakeReq({ method: 'POST' }))
ok(badBody.status === 400, 'POST /apply-name 体解析失败 → 400', 'status ' + badBody.status)

// 其余写路由也走 assertPost：GET 一律 405（不改配置、不真去安装/重启）
for (const route of ['/install', '/start', '/restart', '/bridge-settings', '/update/apply']) {
  const notAllowed = await call(route, fakeReq({ method: 'GET' }))
  ok(notAllowed.status === 405, 'GET ' + route + ' → 405', 'status ' + notAllowed.status)
}
