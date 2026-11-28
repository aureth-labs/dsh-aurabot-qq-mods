import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSettings } from '../lib/policy.mjs'
import { createStore } from '../lib/store.mjs'

test('store saves, lists, reads, overwrites, and removes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-store-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const config = normalizeSettings({}, { dataDir })
  const store = createStore(() => config)

  assert.deepEqual(await store.list(), [])

  const saved = await store.save('Guess', "console.log('hi')")
  assert.equal(saved.name, 'guess')
  assert.equal(saved.bytes, 17)

  const rows = await store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'guess')

  const read = await store.read('guess.mjs')
  assert.equal(read.code, "console.log('hi')")

  await assert.rejects(() => store.save('guess', 'x'), /已经存在/)
  await store.save('guess', "console.log('new')", { overwrite: true })
  assert.equal((await store.read('guess')).code, "console.log('new')")

  await store.remove('guess')
  assert.deepEqual(await store.list(), [])
  await assert.rejects(() => store.read('guess'), /没有叫/)
})

test('store ignores unrelated files and rejects traversal', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-store-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const config = normalizeSettings({}, { dataDir })
  const store = createStore(() => config)
  await store.save('game', 'x')
  await writeFile(join(config.scriptDir, 'notes.txt'), 'ignore me')
  const rows = await store.list()
  assert.deepEqual(rows.map((row) => row.name), ['game'])
  await assert.rejects(() => store.save('../evil', 'x'), /脚本名/)
  await assert.rejects(() => store.save('a/b', 'x'), /脚本名/)
})

test('store enforces script size', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-store-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const config = normalizeSettings({ maxScriptKb: 1 }, { dataDir })
  const store = createStore(() => config)
  await assert.rejects(() => store.save('big', 'x'.repeat(1025)), /超过/)
  await assert.rejects(() => store.save('empty', '   '), /空的/)
})
