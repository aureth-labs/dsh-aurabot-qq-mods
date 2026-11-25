// 长夜如梦：面板路由的来源校验
// 全程在临时目录，不碰真实数据、不联网。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const mod = (await import(new URL('../index.mjs', import.meta.url).href)).default

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
}

async function makeApi({ publicHostname = '' } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'night-'))
  mkdirSync(join(dataDir, 'ref'), { recursive: true })
  const routes = new Map()
  const api = {
    id: 'night',
    dir: SRC,
    dataDir: () => dataDir,
    config: () => ({ ownerQQ: '10001', timeZone: 'Asia/Shanghai', security: { publicHostname } }),
    settings: () => ({ enabled: true, timeZone: 'Asia/Shanghai' }),
    saveSettings: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    core: {
      http: {
        send: (res, status, body) => { res.status = status; res.body = String(body) },
        query: (req) => req?.__query || {},
        body: async (req) => req?.__body || {},
      },
      mutes: { muted: () => false, clear: () => {} },
      store: {},
    },
    route: (p, fn) => routes.set(p, fn),
    tool: (fn) => fn,
    defineTool: (t) => t,
    command: () => {},
    rule: () => {},
    on: () => () => {},
    every: () => () => {},
    onDispose: () => {},
    use: () => null,
    lazy: () => null,
    ask: async () => '',
    send: async () => {},
    later: (fn) => fn,
    isOwner: () => true,
  }
  await mod.setup(api)
  return { api, routes, dataDir }
}

const SAME = { origin: 'http://127.0.0.1:6180' }
const EVIL = { origin: 'https://evil.example' }

console.log('=== 读接口：跨站要拒，同源要放 ===')
{
  const { routes } = await makeApi()

  const evilDreams = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: EVIL })
  check('/dreams 跨站被拒', evilDreams.ok === false && evilDreams.denied === true, JSON.stringify(evilDreams).slice(0, 60))
  check('/dreams 被拒时不给 items', evilDreams.items === undefined)

  const sameDreams = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: SAME })
  check('/dreams 同源放行', sameDreams.ok === true, 'items=' + (sameDreams.items || []).length)

  const noOrigin = await routes.get('/dreams')({ url: '/dreams', method: 'GET' })
  check('/dreams 无 Origin（非浏览器）放行', noOrigin.ok === true)

  const evilState = await routes.get('/state')({ url: '/state', method: 'GET', headers: EVIL })
  check('/state 跨站被拒', evilState.ok === false && evilState.denied === true)

  const sameState = await routes.get('/state')({ url: '/state', method: 'GET', headers: SAME })
  check('/state 同源放行', sameState.ok === true)

  const evilHealth = await routes.get('/health')({ url: '/health', method: 'GET', headers: EVIL })
  check('/health 跨站被拒', evilHealth.ok === false && evilHealth.denied === true)

  const sameHealth = await routes.get('/health')({ url: '/health', method: 'GET', headers: SAME })
  check('/health 同源放行', sameHealth.ok === true && sameHealth.id === 'night')
}

console.log('\n=== 写接口：跨站要拒，但同源不能挡（面板的 call() 没 body 时用 GET）===')
{
  const { routes } = await makeApi()

  // 面板「叫醒」按钮就是 call('/wake') —— 纯 GET。
  const sameWakeGet = await routes.get('/wake')({ url: '/wake', method: 'GET', headers: SAME })
  check('/wake 同源 GET 放行（面板就是这么调的）', sameWakeGet.denied !== true, JSON.stringify(sameWakeGet).slice(0, 50))

  const sameSleepGet = await routes.get('/sleep')({ url: '/sleep', method: 'GET', headers: SAME })
  check('/sleep 同源 GET 不被闸拦住', sameSleepGet.denied !== true)

  const sameWakeNoOrigin = await routes.get('/wake')({ url: '/wake', method: 'GET' })
  check('/wake 无 Origin 放行（非浏览器客户端）', sameWakeNoOrigin.denied !== true)

  // 跨站一律拒，不管方法
  const evilSleep = await routes.get('/sleep')({ url: '/sleep', method: 'POST', headers: EVIL, __body: {} })
  check('/sleep POST 跨站被拒', evilSleep.ok === false && evilSleep.denied === true)

  const evilWake = await routes.get('/wake')({ url: '/wake', method: 'GET', headers: EVIL })
  check('/wake GET 跨站被拒', evilWake.ok === false && evilWake.denied === true)

  const evilDreamDelete = await routes.get('/dreams/delete')({ url: '/dreams/delete', method: 'GET', headers: EVIL })
  check('/dreams/delete 跨站被拒', evilDreamDelete.ok === false && evilDreamDelete.denied === true)

  const evilPin = await routes.get('/dreams/pin')({ url: '/dreams/pin', method: 'POST', headers: EVIL, __body: {} })
  check('/dreams/pin 跨站 POST 被拒', evilPin.ok === false && evilPin.denied === true)

  const evilUnmute = await routes.get('/unmute')({ url: '/unmute', method: 'POST', headers: EVIL, __body: {} })
  check('/unmute 跨站被拒', evilUnmute.ok === false && evilUnmute.denied === true)

  const evilDream = await routes.get('/dream')({ url: '/dream', method: 'POST', headers: EVIL, __body: {} })
  check('/dream 跨站被拒', evilDream.ok === false && evilDream.denied === true)
}

console.log('\n=== Sec-Fetch-Site 也要管 ===')
{
  const { routes } = await makeApi()
  const cross = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  check('Sec-Fetch-Site=cross-site 被拒', cross.ok === false && cross.denied === true)

  const sameSite = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } })
  check('Sec-Fetch-Site=same-origin 放行', sameSite.ok === true)
}

console.log('\n=== 局域网 / 配置的对外域名也算同源 ===')
{
  const { routes } = await makeApi({ publicHostname: 'bot.example.com' })
  const lan = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: { origin: 'http://192.168.1.26:6180' } })
  check('局域网 Origin 放行', lan.ok === true)

  const pub = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: { origin: 'https://bot.example.com' } })
  check('配置的 publicHostname 放行', pub.ok === true)

  const other = await routes.get('/dreams')({ url: '/dreams', method: 'GET', headers: { origin: 'https://other.example.com' } })
  check('别的域名仍被拒', other.ok === false && other.denied === true)
}

const pass = results.filter((r) => r.ok).length
console.log(`\n合计 ${pass} 通过 / ${results.length - pass} 失败`)
if (pass !== results.length) process.exit(1)
