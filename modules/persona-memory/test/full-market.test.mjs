import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import definition from '../index.mjs'
import { REQUIRED_CAPABILITIES } from '../lib/service.mjs'

function harness(core, dataDir) {
  const routes = new Map()
  const api = {
    core, dataDir, use: () => null, lib: () => ({ listPersonas: () => [] }),
    settings: () => ({ enabled: false }),
    saveSettings: () => assert.fail('Setup changed settings'),
    route(path, handler, { access }) {
      assert.equal(access, 'panel')
      routes.set(path, handler)
    },
  }
  return { api, routes }
}

test('preview bridge keeps existing data and reports full compatibility requirements', () => {
  const personaMemoryBridge = {
    api: 1, state: 'preview', capabilities: ['native-memory-view', 'confirmed-delivery'],
    readNativeMemory: () => assert.fail('Unexpected native read'),
    onDelivery: () => assert.fail('Unexpected subscription'),
  }
  const { api, routes } = harness({ personaMemoryBridge }, () => assert.fail('Unexpected file access'))
  const module = definition.setup(api)
  try {
    assert.deepEqual([...routes.keys()], ['/state'])
    const { capabilities, active } = routes.get('/state')()
    assert.equal(capabilities.ready, false)
    assert.ok(capabilities.missing.includes('request-context-replace'))
    assert.equal(active, false)
  } finally {
    module.dispose()
  }
})

test('the full bridge receives the lifecycle and exposes the full management routes', t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-market-memory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let binding
  const personaMemoryBridge = {
    api: 1, root, capabilities: [...REQUIRED_CAPABILITIES],
    bind(service, runtime, facade) { binding = { service, runtime, facade } },
    unbind(service) { assert.equal(service, binding.service); binding = null },
    configure({ migration, participants }) { assert.ok(migration); assert.ok(participants.length > 0) },
    persona: () => 'fixture-persona', ownerQQ: () => '10001',
    prepare() {}, activate() {}, pause() {}, currentScope() {}, resetParticipants() {},
    prepareNative() {}, activateNative() {}, previewSessionReset() {}, validateSessionReset() {},
    clearSessions() {}, clearAuxiliary() {},
  }
  const { api, routes } = harness({ personaMemoryBridge, http: {} }, file => join(root, file))
  const module = definition.setup(api)
  try {
    assert.equal(binding.service, module.service)
    for (const route of ['/search','/correct','/forget','/organize','/native-activate','/legacy-import','/reset-preview','/reset']) {
      assert.equal(typeof routes.get(route), 'function', route)
    }
    assert.equal(routes.get('/state')().capabilities.ready, true)
    assert.equal(routes.get('/state')().active, false)
  } finally {
    module.dispose()
  }
})
