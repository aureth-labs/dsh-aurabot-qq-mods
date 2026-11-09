import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { checkModule, checkRevoked, checkTestCoverage, compareVersions, filesOf, listModules, makeZip, mergeIndex, packModule, smokeTest, testFilesOf } from '../scripts/lib.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/modules/hello-world', import.meta.url))

/** 复制一份夹具到临时目录（可以改 id），测试结束删掉。 */
function copy(t, change = (m) => m, id = 'hello-world') {
  const root = mkdtempSync(join(tmpdir(), 'mods-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, id)
  cpSync(FIXTURE, dir, { recursive: true })
  const path = join(dir, 'module.json')
  writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, 'utf8')))))
  return { id, dir }
}
function tempOut(t) {
  const out = mkdtempSync(join(tmpdir(), 'mods-out-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  return out
}

/** 读 zip：返回 文件名 → 内容。 */
function unzip(buf) {
  const out = new Map()
  const end = buf.length - 22
  assert.equal(buf.readUInt32LE(end), 0x06054b50)
  let p = buf.readUInt32LE(end + 16)
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const nameLen = buf.readUInt16LE(p + 28)
    const local = buf.readUInt32LE(p + 42)
    const start = local + 30 + buf.readUInt16LE(local + 26)
    out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), inflateRawSync(buf.subarray(start, start + buf.readUInt32LE(p + 20))))
    p += 46 + nameLen
  }
  return out
}

test('合格的模块通过检查', () => {
  assert.deepEqual(checkModule({ id: 'hello-world', dir: FIXTURE }).errors, [])
})

test('id 和文件夹名不一致会报错', (t) => {
  assert.ok(checkModule(copy(t, (m) => ({ ...m, id: 'other' }))).errors.some((e) => e.includes('文件夹名')))
})

test('占用内置模块 id 要显式声明', (t) => {
  const mod = copy(t, (m) => ({ ...m, id: 'memory' }), 'memory')
  assert.ok(checkModule(mod).errors.some((e) => e.includes('replacesBuiltin')))
  assert.deepEqual(checkModule(copy(t, (m) => ({ ...m, id: 'memory', replacesBuiltin: true }), 'memory')).errors, [])
})

test('代码用了没声明的能力会报错，声明后通过', (t) => {
  const mod = copy(t)
  writeFileSync(join(mod.dir, 'extra.mjs'), "import { exec } from 'node:child_process'\nawait fetch('https://example.com')\n")
  const { errors } = checkModule(mod)
  assert.ok(errors.some((e) => e.includes('process')))
  assert.ok(errors.some((e) => e.includes('network')))
  writeFileSync(join(mod.dir, 'module.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(mod.dir, 'module.json'), 'utf8')), capabilities: ['process', 'network'] }))
  assert.deepEqual(checkModule(mod).errors, [])
})

test('有 npm 依赖却没配 build 会报错', (t) => {
  const mod = copy(t)
  writeFileSync(join(mod.dir, 'package.json'), JSON.stringify({ dependencies: { cheerio: '1.0.0' } }))
  assert.ok(checkModule(mod).errors.some((e) => e.includes('build')))
})

test('依赖不存在的模块会报错', (t) => {
  assert.ok(checkModule(copy(t, (m) => ({ ...m, requires: ['nope'] }))).errors.some((e) => e.includes('nope')))
})

test('打包结果可重复，不含测试文件', (t) => {
  const out = tempOut(t)
  const mod = { id: 'hello-world', dir: FIXTURE }
  const a = packModule(mod, out)
  const first = readFileSync(join(out, a.file))
  const b = packModule(mod, out)
  assert.equal(a.sha256, b.sha256)
  assert.equal(a.sha256, createHash('sha256').update(first).digest('hex'))
  assert.equal(a.path, 'hello-world-v1.0.0/hello-world-v1.0.0.zip')
  const files = unzip(first)
  assert.deepEqual([...files.keys()].sort(), ['LICENSE', 'README.md', 'index.mjs', 'module.json'])
  assert.match(files.get('index.mjs').toString(), /hello-world/)
})

test('入口和 module.json 不一致时不能打包', (t) => {
  assert.throws(() => packModule(copy(t, (m) => ({ ...m, version: '2.0.0' })), tempOut(t)), /version/)
})

test('入口加载报错会被发现', () => {
  const errors = smokeTest(new Map([['index.mjs', Buffer.from("throw new Error('boom')")]]), { id: 'x', version: '1.0.0', api: 1 })
  assert.match(errors[0], /boom/)
})

test('中文文件名按 UTF-8 写入', () => {
  assert.equal(unzip(makeZip(new Map([['说明.txt', Buffer.from('好')]]))).get('说明.txt').toString(), '好')
})

test('索引：新增、保留、下架', () => {
  const previous = { schema: 1, assetsBase: 'x/', modules: [{ id: 'a', version: '1.0.0', publishedAt: 'old' }, { id: 'gone', version: '1.0.0' }], revoked: [], generatedAt: 'old' }
  const index = mergeIndex({ previous, built: [{ id: 'b', version: '1.0.0' }], present: ['a', 'b'], revoked: [], assetsBase: 'x/', now: 'now', commit: 'abc' })
  assert.deepEqual(index.modules.map((e) => e.id), ['a', 'b'])
  assert.equal(index.modules[0].publishedAt, 'old')
  assert.equal(index.modules[1].commit, 'abc')
})

test('索引内容没变时不改时间戳', () => {
  const base = { built: [], present: [], revoked: [], assetsBase: 'x/', commit: '' }
  const previous = mergeIndex({ ...base, previous: null, now: 't1' })
  assert.equal(mergeIndex({ ...base, previous, now: 't2' }).generatedAt, 't1')
})

test('撤回清单校验、版本比较、目录过滤', () => {
  assert.deepEqual(checkRevoked([{ id: 'abc', versions: ['1.0.0'], reason: '恶意代码' }]), [])
  assert.equal(checkRevoked([{ id: 'abc' }]).length, 1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.deepEqual(listModules(join(FIXTURE, 'nope')), [])
})

test('分类必填且要在清单里；目录按分类排列', async () => {
  const { validateManifest } = await import('../scripts/lib.mjs')
  const { renderCatalog } = await import('../scripts/catalog.mjs')
  const m = { id: 'demo', name: '演示', version: '1.0.0', description: '说明', author: '作者', license: 'MIT', api: 1, minPluginVersion: '1.2.0', requires: [], capabilities: [] }
  assert.ok(validateManifest(m, 'demo', new Set()).some((e) => e.includes('category')))
  assert.ok(validateManifest({ ...m, category: 'nope' }, 'demo', new Set()).some((e) => e.includes('category')))
  assert.deepEqual(validateManifest({ ...m, category: 'tool', tags: ['天气'] }, 'demo', new Set()), [])
  assert.ok(validateManifest({ ...m, category: 'tool', tags: 'x' }, 'demo', new Set()).some((e) => e.includes('tags')))
  const text = renderCatalog([{ ...m, category: 'tool' }, { ...m, id: 'a', name: '甲', category: 'platform' }])
  assert.ok(text.indexOf('## 逛平台') < text.indexOf('## 工具'))
  assert.ok(!text.includes('## 桌面'))
})

// ── 新模块必须带测试 ─────────────────────────────────────────────────────

test('testFilesOf：只认 test/ 下的 *.test.mjs / *.spec.mjs，没有 test/ 返回空', (t) => {
  const mod = copy(t)
  assert.deepEqual(testFilesOf(mod.dir), [], '夹具里没有 test/')
  mkdirSync(join(mod.dir, 'test'), { recursive: true })
  writeFileSync(join(mod.dir, 'test', 'a.test.mjs'), 'export {}\n')
  writeFileSync(join(mod.dir, 'test', 'helpers.mjs'), 'export {}\n')
  assert.deepEqual(testFilesOf(mod.dir), ['a.test.mjs'], 'helpers 不算测试文件')
})

test('checkTestCoverage：新模块没测试要报错，有测试就通过；老模块一律放过', (t) => {
  const mod = copy(t)
  // 老模块（required=false）：不检查
  assert.deepEqual(checkTestCoverage(mod.dir), [])
  assert.deepEqual(checkTestCoverage(mod.dir, { required: false }), [])

  // 新模块（required=true）没测试 → 报错
  const errors = checkTestCoverage(mod.dir, { required: true })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /test\//)

  // 补上测试就通过
  mkdirSync(join(mod.dir, 'test'), { recursive: true })
  writeFileSync(join(mod.dir, 'test', 'hello.test.mjs'), 'export {}\n')
  assert.deepEqual(checkTestCoverage(mod.dir, { required: true }), [])
})

test('checkTestCoverage：test/ 里只有 helpers 没有测试文件，仍然算没测试', (t) => {
  const mod = copy(t)
  mkdirSync(join(mod.dir, 'test'), { recursive: true })
  writeFileSync(join(mod.dir, 'test', 'helpers.mjs'), 'export {}\n')
  assert.equal(checkTestCoverage(mod.dir, { required: true }).length, 1)
})

test('新模块的测试目录不进发布包（包体积不受影响）', (t) => {
  const mod = copy(t)
  mkdirSync(join(mod.dir, 'test'), { recursive: true })
  writeFileSync(join(mod.dir, 'test', 'hello.test.mjs'), 'export {}\n')
  // 只验「发布文件清单里没有 test/」，不真的打包（打包要 spawn 子进程跑 smoke test）
  const files = filesOf(mod.dir)
  assert.ok(!files.some((f) => f.startsWith('test/')), '发布文件清单里不该有 test/')
  assert.ok(files.includes('index.mjs'))
})
