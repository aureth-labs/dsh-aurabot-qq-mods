import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginDir = process.env.AURABOT_PLUGIN_DIR
const id = 'wechat-bridge'

test('Aurabot 宿主面板能读取、保存模块设置并拒绝外部请求', {
  skip: !pluginDir && '设置 AURABOT_PLUGIN_DIR 后运行宿主面板测试',
}, async (t) => {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'wechat-bridge-panel-test-'))
  const dataDir = join(root, 'aurabot')
  const testEnv = {
    DSH_HOME: join(root, 'dsh'),
    AURABOT_DATA_DIR: dataDir,
    AURABOT_WORKSPACE: join(root, 'workspace'),
    AURABOT_UNIFIED_DATA_DIR: join(root, 'unified'),
    AURABOT_REGISTRY_URL: 'http://127.0.0.1:9/index.json',
  }
  const previous = new Map(Object.keys(testEnv).map((key) => [key, process.env[key]]))
  Object.assign(process.env, testEnv)
  let fake
  t.after(async () => {
    fake?.dispose()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const target = await realpath(root)
    assert.equal(dirname(target), parent)
    assert.match(basename(target), /^wechat-bridge-panel-test-/)
    await rm(target, { recursive: true, force: true })
  })

  const installed = join(dataDir, 'modules', id)
  const source = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(installed, { recursive: true })
  await Promise.all([
    copyFile(join(source, 'index.mjs'), join(installed, 'index.mjs')),
    copyFile(join(source, 'module.json'), join(installed, 'module.json')),
    cp(join(source, 'lib'), join(installed, 'lib'), { recursive: true }),
  ])
  const configFile = join(dataDir, 'config.json')
  const tokenFile = join(root, 'gateway.token')
  const token = 'synthetic-secret-for-panel-test'
  await writeFile(tokenFile, token)
  await writeFile(configFile, JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    gateway: 'onebot',
    ownerQQ: '123450001',
    botQQ: '123450002',
    workspaceDir: testEnv.AURABOT_WORKSPACE,
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') },
    ext: { other: { keep: true } },
  }))

  const fromPlugin = (path) => import(pathToFileURL(resolve(pluginDir, path)).href)
  const { createFakeDsh } = await fromPlugin('test/helpers/fake-dsh.js')
  const { apply } = await fromPlugin('src/host.js')
  fake = createFakeDsh({ brain: async () => '模拟回复' })
  fake.ctx.webServer.port = 5099
  const host = apply(fake.ctx)
  await host.ready
  async function json(path, body) {
    const response = await fake.call(path, body)
    assert.equal(response.status, 200, path)
    const result = response.json()
    assert.equal(result.ok, true, path)
    return result
  }

  const modules = await json('/modules')
  const entry = modules.list.find((item) => item.id === id)
  assert.equal(entry?.running, 'user', entry?.error)
  assert.equal(entry.defaults.enabled, false)
  assert.deepEqual(entry.settings.map(({ key }) => key), ['enabled', 'url', 'account', 'tokenFile'])
  assert.equal(entry.panel, false, '模块使用宿主的原生设置表单')
  assert.deepEqual(entry.routes, [])
  assert.equal((await fake.call('/modules/panel?id=' + id)).status, 404)
  const unconfigured = await json('/modules/simulate', { text: '/wx-bind', as: 'owner' })
  assert.match(unconfigured.steps[0], /填写本机网关/)

  const settings = { url: 'http://127.0.0.1:6174', account: 'fixture', tokenFile }
  const saved = { enabled: false, binding: null, ...settings }
  await json('/save', { ext: { [id]: settings } })
  const state = await json('/state')
  assert.deepEqual(state.config.ext[id], saved)
  assert.deepEqual(state.config.ext.other, { keep: true })
  assert.equal(host.getConfig().dryRun, true)
  assert.equal(JSON.stringify(state).includes(token), false)
  const disk = JSON.parse(await readFile(configFile, 'utf8'))
  assert.deepEqual(disk.ext[id], saved)

  const remote = await fake.call('/modules', null, {}, '203.0.113.7')
  assert.equal(remote.status, 403)
  const crossSite = await fake.call('/save', { ext: { [id]: { account: 'foreign' } } },
    { origin: 'https://untrusted.example' }, '127.0.0.1')
  assert.equal(crossSite.status, 403)
  assert.deepEqual(host.getConfig().ext[id], saved)
  const group = await json('/modules/simulate', { text: '/wx-bind', as: 'owner', kind: 'group' })
  assert.match(group.steps[0], /主人的 QQ 私聊/)
})
