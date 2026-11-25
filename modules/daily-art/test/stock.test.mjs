import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const host = process.env.AURABOT_PLUGIN_DIR
const live = process.env.DA_LIVE_SAFE === '1'
const persistent = process.env.DA_STOCK_DATA
const restarting = process.env.DA_STOCK_RESTART === '1'
const market = process.env.DA_MARKET_DIST
const repo = fileURLToPath(new URL('../', import.meta.url))
const owner = '10000001'
const bot = '20000002'

async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout
  do { const value = await fn(); if (value) return value; await delay(50) } while (Date.now() < end)
  throw new Error('等待验收事件超时')
}

test('stock host installs, groups the panel, claims raw requests and protects credentials across reloads', { skip: !host, timeout: 90000 }, async t => {
  const fromHost = path => import(pathToFileURL(resolve(host, path)).href)
  const { createFakeDsh } = await fromHost('test/helpers/fake-dsh.js')
  const { startMockOneBot } = await fromHost('test/helpers/mock-onebot.js')
  const dir = persistent || mkdtempSync(join(tmpdir(), 'daily-art-stock-'))
  mkdirSync(dir, { recursive: true })
  const previous = process.env.AURABOT_DATA_DIR
  const previousRegistry = process.env.AURABOT_REGISTRY_URL
  process.env.AURABOT_DATA_DIR = dir
  if (market) {
    const modules = JSON.parse(readFileSync(join(market, 'release.json'), 'utf8'))
    const assetsBase = 'https://daily-art.test/assets/'
    const registry = 'https://daily-art.test/index.json'
    const fetchActual = globalThis.fetch
    const entry = modules.find(item => item.id === 'daily-art')
    assert.ok(entry)
    process.env.AURABOT_REGISTRY_URL = registry
    t.mock.method(globalThis, 'fetch', (url, options) => {
      if (url === registry) return Promise.resolve(Response.json({ schema: 1, assetsBase, modules: [entry] }))
      if (url === assetsBase + entry.path) return Promise.resolve(new Response(readFileSync(join(market, entry.file))))
      return fetchActual(url, options)
    })
  }
  const { apply } = await fromHost('src/host.js')
  const onebot = await startMockOneBot({ selfId: bot })
  let fake, instance, sequence = 1
  t.after(async () => {
    fake?.dispose()
    await onebot.close()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    if (previousRegistry === undefined) delete process.env.AURABOT_REGISTRY_URL
    else process.env.AURABOT_REGISTRY_URL = previousRegistry
    if (!persistent) rmSync(dir, { recursive: true, force: true })
  })
  const mod = join(dir, 'modules', 'daily-art')
  if (!restarting && !market) {
    mkdirSync(mod, { recursive: true })
    for (const file of ['lib', 'index.mjs', 'module.json', 'panel.js']) cpSync(join(repo, file), join(mod, file), { recursive: true })
  }
  const configFile = join(dir, 'config.json')
  const config = restarting ? JSON.parse(readFileSync(configFile, 'utf8')) : { enabled: true, dryRun: false, setupDone: true, ownerQQ: owner, botQQ: bot,
    allow: { private: [], groups: [] }, gateway: 'onebot', model: { provider: 'fake', model: 'fake-1' },
    modules: { 'group-admin': { enabled: false } },
    ext: { 'daily-art': { enabled: false, pushTimes: '00:00', pushCount: 1, privateWhitelist: owner, pushRating: ['s'], konachanApiKey: 'legacy-fixture' } },
  }
  config.snowluma = { autoStart: false, wsUrl: onebot.wsUrl, httpUrl: onebot.httpUrl, wsToken: onebot.token, httpToken: onebot.token }
  writeFileSync(configFile, JSON.stringify(config))
  async function boot() {
    fake = createFakeDsh({ brain: async () => { throw Error('找图不应进入共享聊天回合') } })
    fake.ctx.llm.stream = async function* () {
      yield { type: 'text-delta', text: live ? '{"intent":"search","tags":["landscape"],"count":1}' : '{"intent":"clarify"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    instance = apply(fake.ctx)
    await instance.ready
    await fake.call('/onebot/reconnect')
    await until(() => onebot.connected())
  }
  const post = async (path, body, peer = '127.0.0.1') => (await fake.call(`/ext/daily-art${path}`, body,
    { 'content-type': 'application/json', origin: 'http://127.0.0.1:5099', 'sec-fetch-site': 'same-origin' }, peer)).json()
  const push = text => onebot.push({ message_type: 'private', sub_type: 'friend', user_id: Number(owner), message_id: sequence++, sender: { user_id: Number(owner), nickname: 'owner' }, message: [{ type: 'text', data: { text } }] })
  const sent = () => onebot.sent('send_private_msg').filter(call => String(call.params.user_id) === owner).flatMap(call => call.params.message)
  const imageCount = () => sent().filter(segment => segment.type === 'image').length
  await boot()
  if (market && !restarting) {
    const list = (await fake.call('/modules/community')).json().list
    assert.equal(list.find(item => item.id === 'daily-art')?.blocked, '')
    const installed = (await fake.call('/modules/community/install', { id: 'daily-art' })).json()
    assert.equal(installed.ok, true, installed.message)
    assert.equal(installed.modules.find(item => item.id === 'daily-art')?.running, 'user')
  }
  if (restarting) {
    assert.equal(instance.getConfig().ext['daily-art'].enabled, true)
    const record = JSON.parse(readFileSync(join(dir, 'modules-data', 'daily-art', 'delivery.json'), 'utf8'))
    assert.equal(record.slots['0'].recipients[`private:${owner}`], 'sent')
    await delay(17000)
    assert.equal(imageCount(), 0)
    return
  }
  const module = (await fake.call('/modules')).json().list.find(item => item.id === 'daily-art')
  const client = readFileSync(resolve(host, 'client/client.js'), 'utf8')
  const start = client.indexOf('const NAV_GROUPS =')
  const end = client.indexOf('const navOrder =', start)
  assert.ok(start >= 0 && end > start)
  const groupOf = runInNewContext(client.slice(start, end) + '\nnavGroupOf')
  assert.equal(groupOf({ id: `ext:${module.id}`, ext: module.id, label: module.name }).id, 'platform')
  assert.ok(module.panel && !module.routes.some(route => route.endsWith('/pair')))
  assert.equal(module.defaults.cacheImages, false)
  const schema = (await fake.call('/ext/daily-art/settings-schema')).json()
  assert.match(schema.defaultCacheDir, /daily-art-images$/)
  assert.equal((await post('/credentials', {}, '203.0.113.7')).ok, false)
  assert.equal(instance.getConfig().ext['daily-art'].konachanApiKey, undefined)
  const vault = join(dir, 'modules-data', 'daily-art', 'credentials.json')
  assert.equal(JSON.parse(readFileSync(vault, 'utf8')).konachanApiKey, 'legacy-fixture')
  assert.equal((await post('/credentials', { konachanApiKey: 'new-fixture' })).konachanApiKeySet, true)
  assert.equal(JSON.parse(readFileSync(vault, 'utf8')).konachanApiKey, 'new-fixture')
  assert.equal((await post('/credentials', { konachanApiKey: '' })).konachanApiKeySet, false)
  push('konachan找图 风景')
  if (live) {
    await until(() => imageCount() === 1, 45000)
    instance.setConfig({ ...instance.getConfig(), ext: { ...instance.getConfig().ext, 'daily-art': { ...instance.getConfig().ext['daily-art'], enabled: true, pushTags: 'landscape' } } })
    await until(() => imageCount() === 2, 45000)
    const record = JSON.parse(readFileSync(join(dir, 'modules-data', 'daily-art', 'delivery.json'), 'utf8'))
    assert.equal(record.slots['0'].rating, 's')
    assert.equal(record.slots['0'].recipients[`private:${owner}`], 'sent')
  } else await until(() => sent().some(segment => segment.data.text?.includes('补充想找的主题')))
  assert.equal(fake.turns.length, 0)
  if (persistent) return
  fake.dispose()
  await boot()
  assert.equal((await post('/credentials', {})).konachanApiKeySet, false)
  assert.equal((await fake.call('/state')).json().config.ext['daily-art'].konachanApiKey, undefined)
  if (live) { await delay(2000); assert.equal(imageCount(), 2) }
  instance.setConfig({ ...instance.getConfig(), safeMode: true, modules: { ...instance.getConfig().modules, 'daily-art': { enabled: false } } })
  fake.dispose()
  await boot()
  const disabled = (await fake.call('/state')).json()
  assert.equal(disabled.config.ext['daily-art'].konachanApiKey, undefined)
  assert.ok(!disabled.modules.some(module => module.id === 'daily-art' && module.running))
})
