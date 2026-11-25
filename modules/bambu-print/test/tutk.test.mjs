// test/tutk.test.mjs —— TUTK 云画面：铸码、URL、桥接抓帧、错误与脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  buildTutkUrl, parseTutkUrl, mintTutcode, looksLikeTutkUid, TUTK_URL_PREFIX,
} from '../lib/tutk.mjs'

const TOKEN = 'eyJ-CLOUD-TOKEN-do-not-print-1234567890'
const UID = 'ABCDEFGHIJKLMNOPQRST'
const AUTHKEY = 'a1b2c3d4'
const PASSWD = 'p@ssw0rd'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9])

test('buildTutkUrl / parseTutkUrl 往返，region 归一', () => {
  const url = buildTutkUrl({ uid: UID, authkey: AUTHKEY, passwd: PASSWD, region: 'cn' })
  assert.ok(url.startsWith(TUTK_URL_PREFIX + '?'))
  const parsed = parseTutkUrl(url)
  assert.equal(parsed.uid, UID)
  assert.equal(parsed.authkey, AUTHKEY)
  assert.equal(parsed.passwd, PASSWD)
  assert.equal(parsed.region, 'cn')
  assert.equal(new URLSearchParams(url.split('?')[1]).get('region'), 'cn')
  assert.throws(() => buildTutkUrl({}), /uid/)
  assert.throws(() => parseTutkUrl('https://example.com'), /TUTK/)
  assert.throws(() => parseTutkUrl('bambu:///tutk?region=us'), /uid/)
})

test('looksLikeTutkUid 宽松校验', () => {
  assert.equal(looksLikeTutkUid(UID), true)
  assert.equal(looksLikeTutkUid('short'), false)
  assert.equal(looksLikeTutkUid(''), false)
})

test('mintTutcode：成功解析 ttcode/authkey/passwd，请求头带 Bearer 且不回显 token', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return {
      status: 200,
      async text () { return JSON.stringify({ ttcode: UID, authkey: AUTHKEY, passwd: PASSWD, region: 'us' }) },
    }
  }
  const r = await mintTutcode({ accessToken: TOKEN, serial: '01S00A123456789', region: 'us', fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.uid, UID)
  assert.equal(r.url, buildTutkUrl({ uid: UID, authkey: AUTHKEY, passwd: PASSWD, region: 'us' }))
  assert.match(seen.url, /\/v1\/iot-service\/api\/user\/ttcode$/)
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.Authorization, 'Bearer ' + TOKEN)
  assert.equal(JSON.parse(seen.init.body).dev_id, '01S00A123456789')
  assert.equal(JSON.stringify(r).includes(TOKEN), false, '返回值不能带 token')
})

test('mintTutcode：兼容 data 包裹与 uid 字段', async () => {
  const fetchImpl = async () => ({ status: 200, async text () { return JSON.stringify({ data: { uid: UID, auth_key: AUTHKEY, password: PASSWD, region: 'eu' } }) } })
  const r = await mintTutcode({ accessToken: TOKEN, serial: 'SN', region: 'eu', fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.region, 'eu')
})

test('mintTutcode：无 token / 无 serial / HTTP 401 / 非 JSON / 缺 uid 都给明确错误且不含秘密', async () => {
  assert.equal((await mintTutcode({ serial: 'SN' })).code, 'NO_TOKEN')
  assert.equal((await mintTutcode({ accessToken: TOKEN })).code, 'NO_SERIAL')
  const cases = [
    [{ status: 401, async text () { return '' } }, 'HTTP', /令牌无效/],
    [{ status: 500, async text () { return '' } }, 'HTTP', /暂时不可用/],
    [{ status: 200, async text () { return '<html>' } }, 'BAD_JSON', /无法解析/],
    [{ status: 200, async text () { return JSON.stringify({ authkey: 'x' }) } }, 'NO_UID', /uid/],
    [{ status: 200, async text () { return JSON.stringify({ ttcode: UID }) } }, 'NO_SECRETS', /不完整/],
  ]
  for (const [res, code, re] of cases) {
    const r = await mintTutcode({ accessToken: TOKEN, serial: 'SN', fetchImpl: async () => res })
    assert.equal(r.ok, false)
    assert.equal(r.code, code)
    assert.match(r.error, re)
    assert.equal(r.error.includes(TOKEN), false)
  }
})

test('mintTutcode：网络错误与超时的文案不含 token', async () => {
  const netErr = new Error('connect ECONNREFUSED ' + TOKEN)
  const r1 = await mintTutcode({ accessToken: TOKEN, serial: 'SN', fetchImpl: async () => { throw netErr } })
  assert.equal(r1.code, 'NETWORK')
  assert.equal(r1.error.includes(TOKEN), false)
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
  const r2 = await mintTutcode({ accessToken: TOKEN, serial: 'SN', fetchImpl: async () => { throw timeout } })
  assert.equal(r2.code, 'TIMEOUT')
})

function fakeChild (behavior) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { written: '', write (s) { this.written += s }, end () {} }
  child.kill = () => {}
  behavior(child)
  return child
}
