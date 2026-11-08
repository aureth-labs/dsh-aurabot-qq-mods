// test/install.test.mjs —— 「装上去能不能跑」的验证（CI 会跑 modules/*/test/*.test.mjs）。
// 做法：把模块该发布的文件复制到临时目录（模拟装进 modules/<id>/），再从那里 import 入口、
// 用假 api 跑一遍 setup，最后按插件的方式解析 panel.js。不需要插件源码、不需要联网。

import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MOD = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))

function installCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'kanzhibo-install-'))
  for (const name of ['module.json', 'index.mjs', 'panel.js', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(MOD, name)), '缺 ' + name)
    cpSync(join(MOD, name), join(dir, name))
  }
  cpSync(join(MOD, 'lib'), join(dir, 'lib'), { recursive: true })
  return dir
}

function fakeApi(dataDir) {
  const settings = { enabled: false, target: '', schedule: false, semiAuto: true, giftByDm: false, renewBadge: false }
  const config = { ownerQQ: '10001', douyin: { enabled: true } }
  const api = {
    id: 'kanzhibo', source: 'user', version: manifest.version, apiVersion: 1, dir: dataDir,
    settings: () => ({ ...settings }),
    saveSettings: (p) => Object.assign(settings, p),
    config: () => config,
    setConfig: (p) => { if (typeof p === 'function') Object.assign(config, p(config)); else Object.assign(config, p) },
    dataDir: () => dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    on() { return () => {} }, emit() {}, later() { return () => {} }, every() { return () => {} },
    tool() { return () => {} }, defineTool: (t) => t, rule() { return () => {} },
    command() { return () => {} }, route() { return () => {} }, onDispose() {},
    send: async () => {}, sendText: async () => {}, sendImage: async () => {}, sendFile: async () => {},
    sendVoiceFile: async () => {}, sendSegments: async () => {}, onebot: async () => ({}),
    ask: async () => '', think: async () => '',
    core: { hub: { turnHasOwner: () => false, turnSendersAllOwner: () => false, groupName: () => '群' }, http: {} },
    dsh: { get: () => undefined },
    use: () => null, lazy: () => ({}), has: () => false, lib: () => ({}),
  }
  return api
}

test('安装后入口能加载，和 module.json 对得上', async () => {
  const dir = installCopy()
  try {
    const mod = (await import(pathToFileURL(join(dir, 'index.mjs')).href + '?t=' + Date.now())).default
    assert.equal(mod.id, manifest.id)
    assert.equal(mod.version, manifest.version)
    assert.equal(mod.api, manifest.api)
    assert.equal(typeof mod.setup, 'function')
    assert.ok(Array.isArray(mod.defaults) === false && typeof mod.defaults === 'object')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('setup 能注册工具/命令/接口，不抛错', async () => {
  const dir = installCopy()
  try {
    const mod = (await import(pathToFileURL(join(dir, 'index.mjs')).href + '?t=' + Date.now())).default
    const api = fakeApi(dir)
    const out = mod.setup(api)
    assert.equal(typeof out.tick, 'function')
    assert.equal(typeof out.selfCheck, 'function')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('panel.js 能按插件的方式解析（new Function 包一层）', () => {
  const source = readFileSync(join(MOD, 'panel.js'), 'utf8')
  const Comp = new Function('React', 'h', 'ui', 'call', source)
  assert.equal(typeof Comp, 'function')
})
