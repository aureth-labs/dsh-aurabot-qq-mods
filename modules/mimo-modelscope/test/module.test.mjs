import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import definition from '../index.mjs'

const id = definition.id
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tm1sAAAAASUVORK5CYII=', 'base64')

function wav(sample) {
  const file = Buffer.alloc(46)
  file.write('RIFF', 0)
  file.writeUInt32LE(38, 4)
  file.write('WAVEfmt ', 8)
  file.writeUInt32LE(16, 16)
  file.writeUInt16LE(1, 20)
  file.writeUInt16LE(1, 22)
  file.writeUInt32LE(24000, 24)
  file.writeUInt32LE(48000, 28)
  file.writeUInt16LE(2, 32)
  file.writeUInt16LE(16, 34)
  file.write('data', 36)
  file.writeUInt32LE(2, 40)
  file.writeInt16LE(sample, 44)
  return file
}

function startModule(t, { settings = {}, prepare } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mimo-modelscope-market-test-'))
  const dir = join(root, 'modules-data', id)
  mkdirSync(dir, { recursive: true })
  const cfg = {
    local: { tts: false, image: false },
    ext: { [id]: { ...settings } },
  }
  prepare?.(root, dir)
  const routes = new Map()
  const disposers = []
  const configListeners = []
  const stop = () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
  t.after(() => {
    stop()
    rmSync(root, { recursive: true, force: true })
  })
  const api = {
    id,
    dir: fileURLToPath(new URL('../', import.meta.url)),
    config: () => cfg,
    settings: () => ({ ...definition.defaults, ...cfg.ext[id] }),
    setConfig: (patch) => {
      const before = { local: { ...cfg.local } }
      Object.assign(cfg.local, patch.local)
      Object.assign(cfg.ext[id], patch.ext?.[id])
      for (const listener of configListeners) listener(cfg, before)
    },
    saveSettings: (patch) => api.setConfig({ ext: { [id]: patch } }),
    dataDir: (...parts) => join(dir, ...parts),
    lib: (path) => {
      if (path === 'core/config.js') return { registerSecretField() {} }
      assert.equal(path, 'core/net.js')
      return { fetchImage: () => assert.fail('Unexpected image download') }
    },
    core: { http: { raw: async (req, max) => {
      const data = Buffer.from(JSON.stringify(req.body))
      if (data.length > max) throw new Error('请求体过大')
      return data
    } } },
    command() {},
    tool() {},
    log: { warn: (message) => assert.fail(message) },
    on: (event, fn) => {
      assert.equal(event, 'config')
      configListeners.push(fn)
      disposers.push(() => configListeners.splice(configListeners.indexOf(fn), 1))
    },
    onDispose: (fn) => disposers.push(fn),
    route: (path, handler, options) => {
      assert.equal(options.access, 'panel')
      routes.set(path, handler)
    },
  }
  definition.setup(api)
  const call = (path, body, method = body === undefined ? 'GET' : 'POST') => routes.get(path)({ method, body })
  return { api, root, stop, call }
}

test('参考音频可多份保存和切换，旧文件继续可用，写入失败时保留原选择', async (t) => {
  const first = wav(1)
  const replacement = wav(2)
  const result = wav(3)
  let expected = replacement
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions')
    assert.equal(options.headers.authorization, 'Bearer test-mimo')
    assert.equal(JSON.parse(options.body).audio.voice, 'data:audio/wav;base64,' + expected.toString('base64'))
    return Response.json({ choices: [{ message: { audio: { data: result.toString('base64') } } }] })
  })
  const legacy = 'ref-01bde710-af6a-4787-af84-f2c766f34e4c.wav'
  const { api, call } = startModule(t, {
    settings: { mimoKey: 'test-mimo', referenceFile: legacy },
    prepare(_root, dir) {
      mkdirSync(join(dir, 'reference'))
      writeFileSync(join(dir, 'reference', legacy), first)
    },
  })
  const reference = api.dataDir('reference')
  const upload = (bytes, name) => call('/reference', { base64: bytes.toString('base64'), name })
  const select = (id) => call('/reference/select', { id })

  const initial = await call('/status')
  assert.deepEqual(initial.currentReference, { id: legacy, name: '参考音频.wav' })
  assert.equal((await select('bundled')).ok, true)
  assert.equal((await call('/status')).currentReference.name, '懒羊羊.wav')
  expected = readFileSync(join(api.dir, 'assets', '懒羊羊.wav'))
  assert.equal((await call('/preview-voice', { text: '晚安' })).ok, true)
  expected = replacement
  assert.equal((await select('../config.json')).ok, false)
  assert.equal((await call('/reference')).ok, false)
  assert.equal((await upload(Buffer.from('invalid audio'))).ok, false)
  assert.deepEqual(readdirSync(reference), [legacy])
  assert.equal((await upload(first, '第一次录音.wav')).ok, true)
  const before = api.settings().referenceFile
  assert.deepEqual(readFileSync(join(reference, before)), first)

  const save = api.saveSettings
  api.saveSettings = () => { throw new Error('模拟配置写入失败') }
  assert.equal((await upload(replacement)).ok, false)
  assert.deepEqual(readdirSync(reference).sort(), [legacy, before].sort())
  assert.equal(api.settings().referenceFile, before)
  api.saveSettings = save

  assert.equal((await upload(replacement, 'C:\\音频\\第二次录音.wav')).ok, true)
  assert.notEqual(api.settings().referenceFile, before)
  assert.deepEqual(readFileSync(join(reference, api.settings().referenceFile)), replacement)
  assert.deepEqual(await call('/preview-voice', { text: '晚安' }), {
    ok: true, url: 'data:audio/wav;base64,' + result.toString('base64'),
  })
  const status = await call('/status')
  assert.equal(status.voiceReady, true)
  assert.equal(status.currentReference.name, '第二次录音.wav')
  assert.deepEqual(status.references.map(({ name }) => name), ['懒羊羊.wav', '参考音频.wav', '第一次录音.wav', '第二次录音.wav'])
  assert.equal((await select(before)).ok, true)
  assert.equal((await call('/status')).currentReference.name, '第一次录音.wav')
  expected = first
  assert.equal((await call('/preview-voice', { text: '晚安' })).ok, true)
  assert.ok(!JSON.stringify(status).includes('test-mimo'))
})

test('内置语音和生图按需接管，脚本执行使用当前设置，停用只清理自有脚本', async (t) => {
  const audio = wav(4)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.xiaomimimo.com/v1/chat/completions') {
      assert.equal(JSON.parse(options.body).messages.at(-1).content, '测试语音')
      return Response.json({ choices: [{ message: { audio: { data: audio.toString('base64') } } }] })
    }
    if (url === 'https://api-inference.modelscope.cn/v1/images/generations') {
      const body = JSON.parse(options.body)
      assert.equal(body.model, definition.defaults.imageDefaultModel)
      assert.equal(body.size, '1024x1536')
      assert.equal(body.image_url[0], 'data:image/png;base64,' + image.toString('base64'))
      return Response.json({ task_id: 'market-test' })
    }
    assert.equal(url, 'https://api-inference.modelscope.cn/v1/tasks/market-test')
    return Response.json({ task_status: 'SUCCEED', output_images: ['data:image/png;base64,' + image.toString('base64')] })
  })
  const { api, root, call, stop } = startModule(t)
  const localDir = join(root, 'local')
  const ttsPath = join(localDir, 'tts.mjs')
  const imagePath = join(localDir, 'image.mjs')
  const set = (slot, enabled) => call('/local', { slot, enabled })
  const initial = await call('/status')
  assert.deepEqual(initial.currentReference, { id: 'bundled', name: '懒羊羊.wav', bundled: true })
  assert.deepEqual(initial.local, {
    tts: { enabled: true, ready: false, active: false, conflict: false },
    image: { enabled: true, ready: false, active: false, conflict: false },
  })
  assert.equal(existsSync(ttsPath), false)
  assert.equal(existsSync(imagePath), false)
  mkdirSync(localDir, { recursive: true })
  writeFileSync(ttsPath, '// 用户自己的语音脚本')
  api.saveSettings({ mimoKey: 'test-mimo', modelScopeToken: 'test-scope' })
  assert.equal((await set('tts', true)).ok, false)
  assert.equal(readFileSync(ttsPath, 'utf8'), '// 用户自己的语音脚本')
  assert.equal(api.config().local.tts, false)
  assert.equal(api.config().local.image, true)
  assert.equal(existsSync(imagePath), true)
  rmSync(ttsPath)
  assert.equal((await set('tts', true)).ok, true)
  assert.deepEqual((await call('/status')).local, {
    tts: { enabled: true, ready: true, active: true, conflict: false },
    image: { enabled: true, ready: true, active: true, conflict: false },
  })
  api.setConfig({ local: { tts: false } })
  assert.equal(existsSync(ttsPath), false)
  assert.equal((await call('/status')).local.tts.enabled, false)
  api.saveSettings({ voiceSpeed: 'slow' })
  assert.equal(existsSync(ttsPath), false)
  assert.equal((await set('tts', true)).ok, true)
  api.setConfig({ ext: { [id]: { voiceEnabled: false } } })
  assert.equal(existsSync(ttsPath), false)
  assert.equal(existsSync(imagePath), true)
  api.setConfig({ ext: { [id]: { voiceEnabled: true } } })
  assert.equal(existsSync(ttsPath), true)

  const voice = await import(pathToFileURL(ttsPath).href)
  const drawing = await import(pathToFileURL(imagePath).href)
  assert.deepEqual(readFileSync(await voice.default({ text: '测试语音' })), audio)
  assert.equal(drawing.supportsImage, true)
  assert.deepEqual(await drawing.default({ prompt: '画一只猫', size: '1024x1536', image: image.toString('base64') }), image)
  assert.equal((await set('tts', false)).ok, true)
  assert.equal(api.config().local.tts, false)
  assert.equal(existsSync(ttsPath), false)
  writeFileSync(ttsPath, '// 重新启用用户脚本')
  stop()
  assert.equal(existsSync(imagePath), false)
  assert.equal(readFileSync(ttsPath, 'utf8'), '// 重新启用用户脚本')
  await assert.rejects(drawing.default({ prompt: '画一只猫' }), /请启用/)
})
