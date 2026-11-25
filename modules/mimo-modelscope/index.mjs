import { randomUUID } from 'node:crypto'
import { readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createProviders, imageMime, modelChoices, MODEL_LIST, REFERENCE_LIMIT } from './lib/providers.mjs'
import { localBindings } from './lib/local.mjs'
import { referenceStore } from './lib/references.mjs'

const MAX_UPLOAD_JSON = Math.ceil(REFERENCE_LIMIT / 3) * 4 + 4096
const VOICE_FILE = /^mimo-modelscope-[a-f0-9-]{36}\.wav$/
const DAY = 24 * 60 * 60 * 1000

function errorText(error) {
  if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') return '服务响应超时'
  return String(error.message || error)
}
const textArg = (description) => ({ type: 'string', description })

export default {
  id: 'mimo-modelscope',
  name: 'MiMo 语音与魔搭生图',
  version: '1.0.4',
  api: 1,
  description: '小米 MiMo 音色克隆与魔搭多模型生图',
  panel: 'panel.js',
  tab: 'modules',
  navGroup: 'market',
  defaults: {
    voiceEnabled: true,
    attachVoice: true,
    mimoKey: '',
    voiceSpeed: 'normal',
    imageEnabled: true,
    attachImage: true,
    modelScopeToken: '',
    imageModels: MODEL_LIST,
    imageDefaultModel: 'Qwen/Qwen-Image-2.1-Turbo',
  },
  setup(api) {
    // 自定义面板接管字段渲染，宿主仍负责密钥脱敏及空白输入时保留原值。
    const { registerSecretField } = api.lib('core/config.js')
    for (const key of ['mimoKey', 'modelScopeToken']) registerSecretField(['ext', api.id, key])
    const lifecycle = new AbortController()
    const { signal } = lifecycle
    api.onDispose(() => lifecycle.abort())
    const { fetchImage } = api.lib('core/net.js')
    const { raw } = api.core.http
    const audioDir = api.dataDir('audio')
    mkdirSync(audioDir, { recursive: true })
    const references = referenceStore(api)
    const voiceReady = (settings) => Boolean(settings.voiceEnabled && String(settings.mimoKey || '').trim() && references.status(settings).currentReference)
    const imageReady = (settings) => Boolean(settings.imageEnabled && String(settings.modelScopeToken || '').trim() && modelChoices(settings).defaultModel)

    const providers = createProviders({
      signal,
      readReference: (settings) => references.read(settings, signal),
      downloadImage: (src, request, maxBytes) => fetchImage(src, {
        maxBytes, allowLocal: false, timeoutMs: 30_000,
        fetchImpl: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.any([request, opts.signal]) }),
      }),
    })

    async function pruneAudio() {
      const now = Date.now()
      const entries = await readdir(audioDir)
      await Promise.all(entries.filter((name) => VOICE_FILE.test(name)).map(async (name) => {
        const file = join(audioDir, name)
        const info = await stat(file).catch(() => null)
        if (info && now - info.mtimeMs > DAY) await unlink(file).catch(() => {})
      }))
    }

    function enabledSettings(key) {
      signal.throwIfAborted()
      const settings = api.settings()
      if (!settings[key]) throw new Error(key === 'voiceEnabled' ? '请在模块面板启用 MiMo 语音' : '请在模块面板启用魔搭生图')
      return settings
    }

    async function voiceFile(text, timeout) {
      const audio = await providers.synthesize(text, enabledSettings('voiceEnabled'), timeout)
      await pruneAudio()
      signal.throwIfAborted()
      const file = join(audioDir, 'mimo-modelscope-' + randomUUID() + '.wav')
      await writeFile(file, audio, { flag: 'wx', signal })
      return file
    }

    const generate = (input) => providers.generate(input, enabledSettings('imageEnabled'))
    const local = localBindings(api, {
      tts: ({ text }) => voiceFile(text, 55_000),
      image: ({ prompt, size, image }) => generate({ prompt, size, image: image ? Buffer.from(image, 'base64') : null }),
    }, { tts: voiceReady, image: imageReady })

    function canSend(chat) {
      const cfg = api.config()
      return cfg.enabled && !cfg.dryRun && Boolean(chat?.chatId) && chat.kind !== 'system' &&
        api.isOwner(chat.userId || chat.chatId.slice('private:'.length))
    }

    async function sendVoice(chat, text) {
      if (!canSend(chat)) return '当前会话无法发送，请检查主人权限、总开关和试运行状态'
      const file = await voiceFile(text)
      try {
        signal.throwIfAborted()
        if (!canSend(chat)) return '语音已生成，当前会话无法发送'
        return await api.sendVoiceFile(chat.chatId, file, '[MiMo 语音]') ? '' : '语音没有发到 QQ'
      } finally {
        await unlink(file).catch(() => {})
      }
    }

    async function sendDrawing(chat, input) {
      if (!canSend(chat)) return '当前会话无法发送，请检查主人权限、总开关和试运行状态'
      const image = input.reference ? await api.core.hub.referenceImage(chat, input.reference) : null
      if (input.reference && !image) return '当前聊天里找不到所选参考图'
      const bytes = await generate({ ...input, image })
      signal.throwIfAborted()
      if (!canSend(chat)) return '图片已生成，当前会话无法发送'
      return await api.sendImage(chat.chatId, 'base64://' + bytes.toString('base64')) ? '' : '图片没有发到 QQ'
    }

    function command(run) {
      return async (arg, msg) => {
        if (!api.isOwner(msg.userId)) return '只有主人可以使用此命令'
        try { return await run(arg, msg) } catch (error) { return errorText(error) }
      }
    }

    api.command({
      name: '语音', aliases: ['说话', 'say'], desc: '用 MiMo 发语音，例如 /语音 晚安', sensitive: true,
      run: command((text, msg) => text.trim() ? sendVoice(msg, text) : '用法：/语音 晚安'),
    })
    api.command({
      name: '画图', desc: '用魔搭画图，例如 /画图 --model 组织/模型 雨中的橘猫', sensitive: true,
      run: command((arg, msg) => {
        const match = /^--model\s+(\S+)\s+([\s\S]+)$/.exec(arg)
        if (!arg.trim() || (!match && /^--model(?:\s|$)/.test(arg))) return '用法：/画图 [--model 组织/模型] 画面描述'
        return sendDrawing(msg, match ? { model: match[1], prompt: match[2] } : { prompt: arg })
      }),
    })

    function ownerChat(chat, level) {
      return level === 'full' && chat.kind === 'private' && api.isOwner(chat.userId || chat.chatId.slice('private:'.length))
    }

    api.tool(({ chat, level }) => {
      if (!ownerChat(chat, level)) return []
      const settings = api.settings()
      const tools = []
      if (voiceReady(settings)) {
        tools.push(api.defineTool({
          name: 'mimo_say',
          description: '用 MiMo 音色把指定文字发成一条 QQ 语音',
          properties: { text: textArg('要朗读的内容') },
          required: ['text'],
          execute: async ({ text }) => {
            const error = await sendVoice(chat, text)
            return { ok: !error, message: error || '已发送 MiMo 语音' }
          },
        }))
      }
      const { models } = modelChoices(settings)
      if (settings.imageEnabled && settings.modelScopeToken && models.length) {
        tools.push(api.defineTool({
          name: 'modelscope_draw',
          description: '用魔搭生成图片并发回 QQ，可为这一次指定模型及聊天参考图',
          properties: {
            prompt: textArg('画面描述'),
            model: { type: 'string', enum: models, description: '可选，省略则使用模块默认模型' },
            size: textArg('可选，格式为 1024x1024'),
            reference: { type: 'string', enum: ['last', 'quote'], description: '可选，使用聊天里的最近图片或引用图片' },
          },
          required: ['prompt'],
          slow: '我去画一张，画好就发给你。',
          execute: async (input) => {
            if (input.reference && !['last', 'quote'].includes(input.reference)) throw new Error('参考图只支持 last 或 quote')
            const error = await sendDrawing(chat, input)
            return { ok: !error, message: error || '已发送魔搭图片' }
          },
        }))
      }
      return tools
    })

    const panelAccess = { access: 'panel' }
    const post = (path, fn, max = 32 * 1024) => api.route(path, async (req) => {
      if (req.method !== 'POST') return { ok: false, message: '请使用 POST' }
      try {
        const body = JSON.parse((await raw(req, max)).toString('utf8') || '{}')
        signal.throwIfAborted()
        return await fn(body || {})
      } catch (error) {
        return { ok: false, message: errorText(error) }
      }
    }, panelAccess)

    api.route('/status', () => {
      const settings = api.settings()
      const library = references.status(settings)
      const bindings = local.status()
      return {
        ok: true,
        voiceReady: bindings.tts.ready,
        hasReference: Boolean(library.currentReference),
        ...library,
        ...modelChoices(settings),
        local: bindings,
      }
    }, panelAccess)

    post('/reference', (input) => {
      references.upload(input)
      return { ok: true, message: '已保存并使用这段参考音频' }
    }, MAX_UPLOAD_JSON)

    post('/reference/select', ({ id }) => {
      references.select(id)
      return { ok: true, message: '参考音频已切换' }
    })

    post('/preview-voice', async ({ text }) => {
      const bytes = await providers.synthesize(text, enabledSettings('voiceEnabled'))
      return { ok: true, url: 'data:audio/wav;base64,' + bytes.toString('base64') }
    })
    post('/preview-image', async ({ prompt, model }) => {
      const bytes = await generate({ prompt, model })
      return { ok: true, url: 'data:' + imageMime(bytes) + ';base64,' + bytes.toString('base64') }
    })
    post('/local', ({ slot, enabled }) => {
      if (typeof enabled !== 'boolean') throw new Error('请选择开启或关闭接管')
      const { active, ready } = local.set(slot, enabled)
      if (!enabled) return { ok: true, message: '接管已关闭' }
      if (active) return { ok: true, message: '接管已启用' }
      return { ok: true, message: ready ? '接管尚未生效，请检查本地接口' : '已开启自动接管，配置完成后生效' }
    })
  },
}
