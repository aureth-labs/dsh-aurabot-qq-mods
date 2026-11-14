import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openVault, registerAdmin } from '../lib/admin.mjs'

test('migration separates credentials and does not resurrect an explicitly cleared secret', t => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-art-vault-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const legacy = { ext: { 'daily-art': { konachanApiKey: 'fixture-key', konachanProxyUrl: 'http://user:pass@localhost:80', enabled: true } } }
  const api = { dataDir: name => join(dir, name), settings: () => legacy.ext['daily-art'] }
  const vault = openVault(api)
  assert.deepEqual(vault.migrate(legacy).ext['daily-art'], { enabled: true })
  assert.equal(JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).konachanApiKey, 'fixture-key')
  vault.save({ konachanApiKey: '' })
  const reopened = openVault(api)
  reopened.migrate(legacy)
  assert.equal(reopened.settings().konachanApiKey, '')
})

test('credential routes accept only the local panel or an explicitly trusted panel proxy', async () => {
  const routes = new Map()
  const cfg = { security: {} }
  let dispose, finishProbe
  const probe = new Promise(resolve => { finishProbe = resolve })
  const api = { config: () => cfg, log: {}, route: (name, fn) => routes.set(name, fn), onDispose: fn => { dispose = fn } }
  const patch = []
  registerAdmin(api, { settings: () => ({}), status: () => ({}), save: value => patch.push(value) }, { probe: () => probe })
  const request = (path, body, headers = {}, peer = '127.0.0.1') => routes.get(path)({ method: 'POST', socket: { remoteAddress: peer },
    headers: { 'content-type': 'application/json', host: 'localhost:5099', origin: 'http://localhost:5099', ...headers },
    async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } })
  const credentials = { konachanApiKey: 'fixture' }
  const forwarded = { 'x-forwarded-for': '127.0.0.1, 203.0.113.1' }
  const remotePanel = { host: 'panel.example', origin: 'https://panel.example', ...forwarded }
  assert.equal(routes.has('/pair'), false)
  assert.equal((await request('/credentials', credentials, {}, '203.0.113.1')).ok, false)
  assert.equal((await request('/credentials', credentials, {}, '')).ok, false)
  assert.equal((await request('/credentials', credentials, { origin: undefined })).ok, false)
  assert.equal((await request('/credentials', credentials, { origin: 'https://evil.example' })).ok, false)
  assert.equal((await request('/credentials', credentials, { host: 'evil.example', origin: 'https://evil.example' })).ok, false)
  assert.equal((await request('/credentials', credentials, { 'sec-fetch-site': 'same-site' })).ok, false)
  assert.equal((await request('/credentials', credentials, forwarded)).ok, false)
  assert.equal((await request('/credentials', { konachanApiKey: 'x'.repeat(5000) })).ok, false)
  assert.deepEqual(patch, [])
  assert.deepEqual(await request('/credentials', credentials), { ok: true })
  assert.deepEqual(patch, [credentials])

  cfg.security = { trustedProxy: '127.0.0.1', publicHostname: 'panel.example' }
  assert.equal((await request('/credentials', credentials)).ok, false)
  assert.equal((await request('/credentials', credentials, remotePanel)).ok, false)
  cfg.security.panelRemoteAccess = true
  assert.equal((await request('/credentials', credentials, remotePanel, '203.0.113.1')).ok, false)
  assert.equal((await request('/credentials', credentials, remotePanel, '::ffff:127.0.0.1')).ok, true)
  const active = request('/connection-test', { source: 'yandere' }, remotePanel)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await request('/connection-test', { source: 'yandere' }, remotePanel)).ok, false)
  dispose()
  finishProbe([])
  assert.equal((await active).ok, false)
  assert.equal((await request('/credentials', credentials, remotePanel)).ok, false)
})
