import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeyboxClient, BASE_PARAMS } from '../lib/api.mjs'
import { createHeybox } from '../lib/site.mjs'

const HEX32 = /^[0-9a-f]{32}$/

test('BASE_PARAMS 不再内置 device_id，避免所有人共用同一个设备指纹', () => {
  assert.equal('device_id' in BASE_PARAMS, false, 'BASE_PARAMS 里不该再有写死的 device_id')
})

test('每个客户端各自随机生成 device_id，并随请求发出', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ status: 'ok', result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const a = new HeyboxClient({ fetchImpl, delay: async () => {} })
  const b = new HeyboxClient({ fetchImpl, delay: async () => {} })
  await a.get('/bbs/app/feeds')
  await b.get('/bbs/app/feeds')
  assert.match(a.deviceId, HEX32)
  assert.match(b.deviceId, HEX32)
  assert.notEqual(a.deviceId, b.deviceId, '两个客户端不该共用同一个设备指纹')
  assert.equal(new URL(urls[0]).searchParams.get('device_id'), a.deviceId)
  assert.equal(new URL(urls[1]).searchParams.get('device_id'), b.deviceId)
})

test('注入的 device_id 优先，同一个客户端多次请求保持不变', async () => {
  const urls = []
  const fixed = '0123456789abcdef0123456789abcdef'
  const c = new HeyboxClient({
    deviceId: fixed,
    fetchImpl: async (url) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ status: 'ok', result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    delay: async () => {},
  })
  await c.get('/bbs/app/feeds')
  await c.get('/bbs/app/hot')
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get('device_id')), [fixed, fixed])
})

test('站点层把设备指纹落盘：重启后复用同一个值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-devid-'))
  const stateFile = join(dir, 'state.json')
  const seen = []
  const boot = () => {
    const cfg = { enabled: true, dryRun: false, ownerQQ: '12345678', heybox: { enabled: true, cookie: 'pkey=x; heybox_id=1' } }
    const hb = createHeybox({
      getConfig: () => cfg,
      setCookie: (v) => { cfg.heybox.cookie = v },
      hub: {},
      stateFile,
      credFile: join(dir, 'missing.json'),
      clientFactory: (opts) => {
        seen.push(opts.deviceId)
        return new HeyboxClient({ ...opts, fetchImpl: async () => { throw new Error('禁止联网') }, delay: async () => {} })
      },
    })
    hb.risk() // 触发客户端创建
    hb.dispose()
  }
  try {
    boot()
    boot()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.match(seen[0], HEX32)
  assert.equal(seen[1], seen[0], '同一台机器重启后应当沿用同一个设备指纹')
})
