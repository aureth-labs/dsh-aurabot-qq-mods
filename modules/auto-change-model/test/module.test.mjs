import test from 'node:test'
import assert from 'node:assert/strict'
import module from '../index.mjs'

function fixture(rules = []) {
  let settings = { ...module.defaults, enabled: true, rulesJson: JSON.stringify(rules) }
  let current = 'work'
  const events = new Map(), routes = new Map(), warnings = []
  const api = {
    settings: () => settings,
    config: () => ({ persona: { current: 'global-other' } }),
    lib: () => ({ personaNow: () => current, resolvePersonaId: (id) => id }),
    on: (name, fn) => events.set(name, fn),
    route: (name, fn, options) => routes.set(name, { fn, options }),
    core: { listModels: async () => [{ provider: 'p', model: 'm', apiKey: 'secret' }], personas: { list: () => [{ id: 'work', name: '工作', body: 'private' }] } },
    log: { warn: (s) => warnings.push(s) },
  }
  const exports = module.setup(api)
  return { api, exports, events, routes, warnings, settings: (patch) => { settings = { ...settings, ...patch } }, persona: (id) => { current = id } }
}
const rule = { id: 'default', provider: 'p', model: 'm' }

test('synchronous hook replaces selection without inheriting effort', () => {
  const f = fixture([rule])
  assert.deepEqual(f.events.get('model')({ provider: 'old', model: 'old', reasoningEffort: 'max' }), { provider: 'p', model: 'm', reasoningEffort: '' })
})
test('no match, disabled and invalid settings preserve upstream selection', () => {
  const f = fixture([])
  const hook = f.events.get('model')
  assert.equal(hook(), undefined)
  f.settings({ rulesJson: '{' })
  assert.equal(hook(), undefined)
  assert.equal(hook(), undefined)
  assert.equal(f.warnings.length, 1)
  f.settings({ rulesJson: JSON.stringify([rule]), enabled: false })
  assert.equal(hook(), undefined)
  f.settings({ enabled: true })
  assert.equal(hook().model, 'm')
})
test('persona is resolved for each call, not from the global selection', () => {
  const f = fixture([{ ...rule, personas: ['work'] }])
  assert.equal(f.events.get('model')().model, 'm')
  f.persona('relax')
  assert.equal(f.events.get('model')(), undefined)
  f.api.lib = () => ({})
  assert.equal(f.events.get('model')(), undefined)
  assert.match(f.warnings.at(-1), /人格/)
})
test('protected status endpoint only returns model/persona identifiers', async () => {
  const f = fixture([rule])
  const route = f.routes.get('/status')
  assert.deepEqual(route.options, { access: 'panel' })
  const status = await route.fn()
  assert.deepEqual(status.models, [{ provider: 'p', model: 'm' }])
  assert.deepEqual(status.personas, [{ id: 'work', name: '工作' }])
  assert.equal(status.rule.id, 'default')
  assert.ok(!JSON.stringify(status).includes('secret'))
})
test('disabled configuration can be previewed without activating the model hook', async () => {
  const f = fixture([rule])
  f.settings({ enabled: false })
  const status = await f.routes.get('/status').fn()
  assert.equal(status.enabled, false)
  assert.equal(status.rule.id, 'default')
  assert.ok(Number.isFinite(Date.parse(status.checkedAt)))
  assert.equal(f.events.get('model')(), undefined)
})
test('date/time recalculated on demand and edited rules take effect', () => {
  const f = fixture([{ ...rule, dates: ['2026-11-28'], start: '09:00', end: '18:00' }])
  assert.equal(f.exports.evaluate(new Date('2026-11-28T01:00:00Z')).rule.id, 'default')
  assert.equal(f.exports.evaluate(new Date('2026-11-28T10:00:00Z')).rule, null)
  f.settings({ rulesJson: JSON.stringify([{ ...rule, model: 'new' }]) })
  assert.equal(f.exports.evaluate().rule.model, 'new')
})
