import { setTimeout as delay } from 'node:timers/promises'

const MIMO = 'https://api.xiaomimimo.com/v1/chat/completions'
const MODELSCOPE = 'https://api-inference.modelscope.cn/v1'
export const REFERENCE_LIMIT = 7 * 1024 * 1024
const IMAGE_LIMIT = 20 * 1024 * 1024
const AUDIO_LIMIT = 16 * 1024 * 1024

export const MODEL_LIST = 'Qwen/Qwen-Image-2.1-Turbo\nQwen/Qwen-Image-2.1\nMiniMax/MiniMax-H3-Image'
const MODEL_ID = /^[\w.-]+\/[\w.-]+$/

export const SPEEDS = {
  slow: '请用较慢的语速说话，吐字清楚。',
  normal: '',
  fast: '请用较快的语速说话，吐字清楚。',
  'very-fast': '请用很快的语速说话，吐字清楚。',
  fastest: '请用极快的语速说话，尽量减少停顿，同时保持吐字清晰。',
}

export function modelChoices(settings) {
  const entries = String(settings.imageModels ?? MODEL_LIST).split(/[\s,，、]+/).filter(Boolean)
  const unique = new Map()
  for (const id of entries) {
    if (MODEL_ID.test(id) && !unique.has(id.toLowerCase())) unique.set(id.toLowerCase(), id)
  }
  const models = [...unique.values()]
  const preferred = String(settings.imageDefaultModel || '').trim().toLowerCase()
  return { models, defaultModel: unique.get(preferred) || models[0] || '' }
}

export function audioMime(bytes) {
  if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (bytes.length >= 10 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'audio/mpeg'
  return ''
}

export function imageMime(bytes) {
  if (bytes.length < 12) return ''
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  return ''
}

function base64Bytes(encoded, limit, label) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(limit / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(label + '格式无效或超出大小限制')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > limit) throw new Error(label + '格式无效或超出大小限制')
  return bytes
}

export function decodeReference(encoded) {
  const bytes = base64Bytes(encoded, REFERENCE_LIMIT, '参考音频')
  if (!audioMime(bytes)) throw new Error('参考音频需要是 WAV 或 MP3')
  return bytes
}

async function readJson(response, service) {
  if (!response.ok) {
    const hint = { 401: '请检查密钥', 403: '请检查密钥与模型权限', 429: '请检查额度或稍后重试' }
    throw new Error(service + '请求失败（HTTP ' + response.status + '）' + (hint[response.status] ? '，' + hint[response.status] : ''))
  }
  return response.json().catch(() => { throw new Error(service + '返回了无效响应') })
}

function auth(key) {
  return { authorization: 'Bearer ' + key, 'content-type': 'application/json' }
}

function requestSignal(signal, timeout) {
  return AbortSignal.any([signal, AbortSignal.timeout(timeout)])
}

export function createProviders({ signal, readReference, downloadImage, fetchImpl = globalThis.fetch, pollMs = 3000 }) {
  async function synthesize(text, settings, timeout = 180_000) {
    const input = String(text ?? '').trim()
    if (!input || [...input].length > 300) throw new Error('请输入 1–300 字的朗读内容')
    const key = String(settings.mimoKey || '').trim()
    if (!key) throw new Error('请填写 MiMo API Key')
    const request = requestSignal(signal, timeout)
    const reference = await readReference(settings)
    const mime = audioMime(reference)
    if (!mime || reference.length > REFERENCE_LIMIT) throw new Error('参考音频需要是 7 MB 以内的 WAV 或 MP3')
    const instruction = Object.hasOwn(SPEEDS, settings.voiceSpeed) && SPEEDS[settings.voiceSpeed]
    const messages = instruction ? [{ role: 'user', content: instruction }] : []
    messages.push({ role: 'assistant', content: input })
    const response = await fetchImpl(MIMO, {
      method: 'POST', headers: auth(key), redirect: 'error', signal: request,
      body: JSON.stringify({
        model: 'mimo-v2.5-tts-voiceclone',
        messages,
        audio: { format: 'wav', voice: 'data:' + mime + ';base64,' + reference.toString('base64') },
      }),
    })
    const result = await readJson(response, 'MiMo')
    const audio = base64Bytes(result.choices?.[0]?.message?.audio?.data, AUDIO_LIMIT, 'MiMo 返回的音频')
    if (audioMime(audio) !== 'audio/wav') throw new Error('MiMo 返回的音频不是 WAV')
    return audio
  }

  async function generate(input, settings) {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt || [...prompt].length >= 2000) throw new Error('请输入 1–1999 字的画面描述')
    const key = String(settings.modelScopeToken || '').trim()
    if (!key) throw new Error('请填写魔搭 Token')
    const { models, defaultModel } = modelChoices(settings)
    const requested = String(input.model || defaultModel).trim().toLowerCase()
    const model = models.find((id) => id.toLowerCase() === requested)
    if (!model) throw new Error('请从已配置的魔搭模型里选择一个模型')
    const size = String(input.size || '1024x1024').toLowerCase()
    if (!/^\d{2,4}x\d{2,4}$/.test(size)) throw new Error('图片尺寸格式应为 1024x1024')
    const body = { model, prompt, size }
    if (input.image) {
      const mime = imageMime(input.image)
      if (!mime || input.image.length > IMAGE_LIMIT) throw new Error('参考图片格式无效或超过 20 MB')
      body.image_url = ['data:' + mime + ';base64,' + input.image.toString('base64')]
    }
    const request = requestSignal(signal, 240_000)
    const headers = auth(key)
    const submitted = await readJson(await fetchImpl(MODELSCOPE + '/images/generations', {
      method: 'POST', headers: { ...headers, 'X-ModelScope-Async-Mode': 'true' },
      body: JSON.stringify(body), redirect: 'error', signal: request,
    }), '魔搭')
    if (typeof submitted.task_id !== 'string' || !submitted.task_id) throw new Error('魔搭没有返回任务编号')
    const taskUrl = MODELSCOPE + '/tasks/' + encodeURIComponent(submitted.task_id)
    for (;;) {
      await delay(pollMs, undefined, { signal: request })
      const task = await readJson(await fetchImpl(taskUrl, {
        headers: { ...headers, 'X-ModelScope-Task-Type': 'image_generation' }, redirect: 'error', signal: request,
      }), '魔搭')
      if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(task.task_status)) {
        throw new Error('魔搭生图任务未完成，请检查模型、额度与图片尺寸')
      }
      if (task.task_status !== 'SUCCEED') continue
      const src = task.output_images?.[0]
      if (typeof src !== 'string') throw new Error('魔搭没有返回图片')
      const inline = /^data:image\/[\w.+-]+;base64,(.+)$/i.exec(src)
      if (!inline && !/^https:\/\//i.test(src)) throw new Error('魔搭返回的图片地址无效')
      const bytes = inline ? base64Bytes(inline[1], IMAGE_LIMIT, '魔搭图片') : await downloadImage(src, request, IMAGE_LIMIT)
      request.throwIfAborted()
      if (!Buffer.isBuffer(bytes) || bytes.length > IMAGE_LIMIT || !imageMime(bytes)) throw new Error('魔搭返回的图片格式无效')
      return bytes
    }
  }

  return { synthesize, generate }
}
