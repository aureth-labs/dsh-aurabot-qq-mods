// 适配层的纯逻辑测试：不联网、不需要插件环境。
import test from 'node:test'
import assert from 'node:assert/strict'

import { asrConfig, pickPath, probeStt, ttsConfig, wavHeader } from '../lib/providers.mjs'

test('pickPath 能顺着路径和数组下标取值', () => {
  const j = { data: { result: [{ text: '你好' }] }, text: '顶层' }
  assert.equal(pickPath(j, 'data.result[0].text'), '你好')
  assert.equal(pickPath(j, 'text'), '顶层')
  assert.equal(pickPath(j, 'data.missing.text'), undefined)
  assert.equal(pickPath(j, ''), undefined)
})

test('认不出的引擎一律回落到本地识别', () => {
  assert.equal(asrConfig({ asrProvider: 'nope' }).provider, 'local')
  assert.equal(asrConfig({}).provider, 'local')
  assert.equal(asrConfig({ asrProvider: 'openai' }).lang, 'zh')
})

test('OpenAI 兼容转写没填 Key 时明确提示，不假装就绪', async () => {
  const info = await probeStt({ provider: 'openai', url: 'https://api.example.com/v1', key: '' })
  assert.equal(info.ready, false)
  assert.match(info.why, /Key/)
})

test('自定义模板没填 url 也不能算就绪', async () => {
  const info = await probeStt({ provider: 'http', template: {} })
  assert.equal(info.ready, false)
})

test('follow 跟随全局引擎，并把音色带过去', () => {
  const g = ttsConfig({ ttsProvider: 'follow' }, { engine: 'gptsovits', gptsovits: { url: 'http://127.0.0.1:9880', refAudio: 'a.wav' } })
  assert.equal(g.provider, 'gptsovits')
  assert.equal(g.follow, true)

  const e = ttsConfig({ ttsProvider: 'follow' }, { engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: '+5%' })
  assert.equal(e.provider, 'edge')
  assert.equal(e.edgeVoice, 'zh-CN-XiaoxiaoNeural')
  assert.equal(e.edgeRate, '+5%')
})

test('显式指定的引擎优先于全局设置', () => {
  const c = ttsConfig({ ttsProvider: 'openai', ttsModel: 'tts-1' }, { engine: 'gptsovits' })
  assert.equal(c.provider, 'openai')
  assert.equal(c.follow, false)
  assert.equal(c.format, 'pcm')
})

test('WAV 头长度和采样率写得对', () => {
  const head = wavHeader(24000, 1, 16)
  assert.equal(head.length, 44)
  assert.equal(head.toString('ascii', 0, 4), 'RIFF')
  assert.equal(head.toString('ascii', 8, 12), 'WAVE')
  assert.equal(head.readUInt32LE(24), 24000)
  assert.equal(head.readUInt16LE(22), 1)
  assert.equal(head.readUInt16LE(34), 16)
  assert.equal(head.readUInt32LE(40), 0xffffffff) // 长度未知，边下边播用
})

// ---- 局域网入口的安全默认值（改坏了会直接暴露插件 API，所以上锁）----
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MODULE_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs'), 'utf8')

test('局域网 HTTPS 默认关闭', () => {
  assert.ok(MODULE_SRC.includes('lanHttps: false'), 'lanHttps 默认值必须是 false')
  assert.ok(MODULE_SRC.includes('settings().lanHttps !== true'), '只有显式打开才允许起服务')
})

test('反代只放行通话模块自己的接口', () => {
  const head = MODULE_SRC.indexOf('const ALLOW_PATHS = new Set([')
  assert.ok(head > 0, '找不到 ALLOW_PATHS')
  const body = MODULE_SRC.slice(MODULE_SRC.indexOf('[', head) + 1, MODULE_SRC.indexOf('])', head))
  const paths = body.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)
  assert.equal(paths.length, 8, `白名单应恰好 8 个路径，实际 ${paths.length}`)
  for (const one of paths) {
    assert.ok(one.startsWith('/aurabot/api/ext/voicecall/'), '白名单越界：' + one)
  }
})

test('反代必须校验会话令牌，且令牌不进上游 URL', () => {
  assert.ok(MODULE_SRC.includes('got !== want'), '缺少令牌校验')
  assert.ok(MODULE_SRC.includes("searchParams.delete('t')"), '转发前应摘掉 t= 参数')
  assert.ok(MODULE_SRC.includes('HttpOnly; Secure; SameSite=Lax'), 'Cookie 应带 HttpOnly/Secure/SameSite')
})
