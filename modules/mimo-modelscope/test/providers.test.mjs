import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProviders, decodeReference, modelChoices } from '../lib/providers.mjs'

const wav = Buffer.alloc(44)
wav.write('RIFF', 0)
wav.write('WAVE', 8)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tm1sAAAAASUVORK5CYII=', 'base64')

test('MiMo 上传参考音频，按语速配置请求并验证返回的 WAV', async () => {
  const { synthesize } = createProviders({
    signal: new AbortController().signal,
    readReference: async () => wav,
    fetchImpl: async (url, options) => {
      assert.match(url, /^https:\/\/api\.xiaomimimo\.com\/v1\/chat\/completions$/)
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.authorization, 'Bearer test-mimo')
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'mimo-v2.5-tts-voiceclone')
      assert.match(body.messages[0].content, /很快/)
      assert.deepEqual(body.messages[1], { role: 'assistant', content: '晚安' })
      assert.equal(body.audio.voice, 'data:audio/wav;base64,' + wav.toString('base64'))
      return Response.json({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] })
    },
  })
  assert.deepEqual(await synthesize(' 晚安 ', { mimoKey: 'test-mimo', voiceSpeed: 'very-fast' }), wav)
  assert.deepEqual(decodeReference(wav.toString('base64')), wav)
  assert.throws(() => decodeReference('bm90IGF1ZGlv'), /WAV 或 MP3/)
})

test('魔搭去重和校验模型，异步轮询后下载图片并保留参考图', async () => {
  const settings = { modelScopeToken: 'test-scope', imageModels: 'A/One，a/one\nB/Two\n无效', imageDefaultModel: 'b/two' }
  assert.deepEqual(modelChoices(settings), { models: ['A/One', 'B/Two'], defaultModel: 'B/Two' })
  let polls = 0
  const { generate } = createProviders({
    signal: new AbortController().signal,
    pollMs: 1,
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') {
        assert.equal(options.headers['X-ModelScope-Async-Mode'], 'true')
        const body = JSON.parse(options.body)
        assert.equal(body.model, 'A/One')
        assert.equal(body.size, '1024x1536')
        assert.match(body.image_url[0], /^data:image\/png;base64,/)
        return Response.json({ task_id: 'a/b' })
      }
      assert.ok(url.endsWith('/tasks/a%2Fb'))
      assert.equal(options.headers['X-ModelScope-Task-Type'], 'image_generation')
      return ++polls === 1 ? Response.json({ task_status: 'RUNNING' }) :
        Response.json({ task_status: 'SUCCEED', output_images: ['https://example.com/example.png'] })
    },
    downloadImage: async (url) => {
      assert.equal(url, 'https://example.com/example.png')
      return png
    },
  })
  await assert.rejects(generate({ prompt: '画图', model: 'C/Three' }, settings), /已配置/)
  assert.deepEqual(await generate({ prompt: '画图', model: 'a/one', image: png, size: '1024x1536' }, settings), png)
  assert.equal(polls, 2)
})

test('模块停止时取消魔搭轮询', async () => {
  const controller = new AbortController()
  const { generate } = createProviders({
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST')
      controller.abort()
      return Response.json({ task_id: 'stop-me' })
    },
  })
  await assert.rejects(generate({ prompt: '画图' }, { modelScopeToken: 'test-scope' }), { name: 'AbortError' })
})
