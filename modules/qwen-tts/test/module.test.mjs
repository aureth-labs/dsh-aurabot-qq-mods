import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import moduleDef from '../index.mjs'

test('install never overwrites existing script; saved key is not returned', async () => {
  const root = mkdtempSync(join(process.cwd(), 'qwen-test-'))
  try {
    const data = join(root, 'modules-data', 'qwen-tts'); mkdirSync(data, { recursive: true })
    const routes = {}
    moduleDef.setup({ dataDir: () => data, route: (p, fn) => { routes[p] = fn }, core: { http: { body: async r => r.body } } })
    const request = { method: 'POST', body: {} }
    assert.equal((await routes['/install'](request)).ok, true)
    const local = join(root, 'local'); const script = join(local, 'tts.mjs')
    writeFileSync(script, 'existing script')
    assert.equal((await routes['/install'](request)).ok, false)
    assert.equal(readFileSync(script, 'utf8'), 'existing script')
    await routes['/set']({ body: { patch: { apiKey: 'fake-key-123456' } } })
    const state = await routes['/get']()
    assert.equal(state.config.apiKeySet, true)
    assert.ok(!JSON.stringify(state).includes('fake-key-123456'))
    await routes['/set']({ body: { patch: { apiKey: '' } } })
    assert.equal(JSON.parse(readFileSync(join(local, 'tts.config.json'), 'utf8')).apiKey, 'fake-key-123456')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
