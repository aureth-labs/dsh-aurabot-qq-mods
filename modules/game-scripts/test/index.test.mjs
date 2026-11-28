import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import module from '../index.mjs'

function fakeApi(dataDir) {
  const state = {
    toolFilter: null,
    command: null,
    rules: [],
    logs: [],
  }
  const api = {
    settings: () => ({ scriptDir: join(dataDir, 'scripts') }),
    dataDir: () => dataDir,
    defineTool: (definition) => definition,
    tool: (filter) => { state.toolFilter = filter },
    rule: (rule) => { state.rules.push(rule) },
    command: (definition) => { state.command = definition },
    log: { info: (message) => { state.logs.push(message) } },
  }
  return { api, state }
}

test('setup wires owner-only tools, command, and private rule', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-index-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const { api, state } = fakeApi(dataDir)
  const instance = module.setup(api)

  assert.equal(state.command.name, '脚本')
  assert.equal(state.command.sensitive, true)
  assert.match(await state.command.run('帮助', { kind: 'private' }), /脚本 列表/)

  const ownerTools = state.toolFilter({ level: 'full', chat: { kind: 'private' } })
  assert.deepEqual(ownerTools.map((tool) => tool.name), [
    'game_script_save',
    'game_script_run',
    'game_script_list',
    'game_script_read',
  ])
  assert.deepEqual(state.toolFilter({ level: 'full', chat: { kind: 'group' } }), [])
  assert.deepEqual(state.toolFilter({ level: 'limited', chat: { kind: 'private' } }), [])

  const save = ownerTools.find((tool) => tool.name === 'game_script_save')
  const list = ownerTools.find((tool) => tool.name === 'game_script_list')
  const saved = await save.execute({ name: 'demo', code: "console.log('hi')" })
  assert.equal(saved.ok, true)
  assert.match((await list.execute({})).message, /demo/)

  assert.match(state.rules[0]('private'), /game_script_save/)
  assert.equal(state.rules[0]('social'), '')
  assert.ok(state.logs.some((line) => line.includes('已加载')))

  instance.dispose()
})
