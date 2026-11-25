// 本地语音识别（按住说话用）：把一段 16kHz/单声道/PCM16 的 WAV 转成文字。
//
// 为什么不走 DSH 的 ctx.speechToText：那是宿主对「客户端」暴露的服务，模块拿不到；
// 但 DSH 自带 sherpa-onnx 原生 addon 与 SenseVoice 模型，直接复用同一套就够了（不额外装东西）。
// 为什么不用 aur abot 的 local/asr.mjs 槽位：那要求主人自己起一个 HTTP 识别服务（默认 8000 端口，
// 本机实测没起），按住说话是高频小动作，不该依赖一个要另外维护的进程。
//
// 模型查找顺序（第一个能用的就赢）：
//   ① 设置里手填的 modelDir（面板「语音识别模型目录」）
//   ② DSH 的标准位置 <dataDir>/speech-to-text/sensevoice/models/sensevoice-onnx
// 都找不到就明确报 unsupported，不静默失败。

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

// 本文件是 ESM：没有 require。原生 .node 只能 require 进来，所以自造一个。
const requireCjs = createRequire(import.meta.url)

/** SenseVoice 模型文件名（DSH 自带的就是这一套）。 */
const MODEL_FILE = 'model.int8.onnx'
const TOKENS_FILE = 'tokens.txt'

/** 识别器懒加载一次：模型 240MB，每次按键重载会把按住说话拖到十几秒。 */
let cached = null // { key, rec, addon }

/** 候选模型目录（按优先级）。 */
function candidateDirs(explicit) {
  const out = []
  if (explicit) out.push(String(explicit))
  // DSH 的语音识别模型默认就落在这里（panel 里下载的就是这一套）
  out.push(join(process.cwd(), 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'))
  const home = String(process.env.DSH_HOME || '').trim()
  if (home) out.push(join(home, 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'))
  const userProfile = String(process.env.USERPROFILE || '').trim()
  if (userProfile) out.push(join(userProfile, '.dsh', 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'))
  return out
}

/** 找一个能用的模型目录；找不到返回 null。 */
export function resolveModelDir(explicit) {
  for (const dir of candidateDirs(explicit)) {
    try {
      if (existsSync(join(dir, MODEL_FILE)) && existsSync(join(dir, TOKENS_FILE))) return dir
    } catch {}
  }
  return null
}

/** 找 sherpa-onnx 原生 addon：DSH 把它放在 app.asar.unpacked 里（原生 .node 不能在 asar 里加载）。 */
function loadAddon() {
  const tries = []
  // ① Electron 主进程直接给
  try {
    const res = process.resourcesPath
    if (res) tries.push(join(res, 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
  } catch {}
  // ② 从当前进程的可执行文件反推：<安装目录>/DeepSeek Harness.exe → <安装目录>/resources/
  //    （插件是宿主里的模块，process.resourcesPath 不一定在；装目录却总能从 execPath 猜到）
  try {
    const exe = process.execPath
    if (exe) {
      const dir = dirname(exe)
      const cands = [
        join(dir, 'resources'),
        join(dir, '..', 'resources'),
        join(dir, '..', '..', 'resources'),
      ]
      for (const root of cands) {
        tries.push(join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
        tries.push(join(root, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
        tries.push(join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
      }
    }
  } catch {}
  // ③ 走模块解析（装了 sherpa-onnx-node 的常规布局）
  try {
    for (const spec of ['sherpa-onnx-win-x64/sherpa-onnx.node', 'sherpa-onnx-node', '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice']) {
      try { const hit = requireCjs.resolve(spec); if (hit) tries.push(hit) } catch {}
    }
  } catch {}
  // ④ 从 asar 包里反推：Electron 的主入口一定在 <安装目录>/resources/app.asar 里，
  //    而宿主进程自己就是那个入口——argv[1] 或 module 链上能找到这条路径。
  try {
    const hints = [process.argv[1], process.argv[0], ...(process.argv.slice(2) || [])].filter(Boolean).map(String)
    for (const h of hints) {
      const m = /^(.+?[\\/]resources)[\\/]app\.asar(?:[\\/]|$)/i.exec(h)
      if (m) {
        const root = m[1]
        tries.push(join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
        tries.push(join(root, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
      }
    }
  } catch {}
  // ⑤ 最后兜底：Windows 上 DSH 的默认安装目录（用户没改路径时就是这里）
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (!base) continue
      for (const name of ['DeepSeek Harness', 'deepseek-harness', 'DeepSeek-Harness']) {
        const root = join(base, 'Programs', name, 'resources')
        tries.push(join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
        tries.push(join(base, name, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))
      }
    }
  }
  for (const p of tries) {
    try {
      if (!existsSync(p)) continue
      // 直接 require .node 拿到的是 C++ binding；拿 .js 包时它可能只导出类
      const mod = requireCjs(p)
      if (mod && typeof mod.createOfflineRecognizer === 'function') return mod
      // sherpa-onnx-node 那种只给封装类的包：拆出它内部持有的 addon
      if (mod && typeof mod.OfflineRecognizer === 'function' && mod.__addon) return mod.__addon
    } catch {}
  }
  return null
}

/**
 * 转写一段 WAV。
 *
 * @param {Buffer} wav - 完整 WAV（16kHz / 单声道 / PCM16）
 * @param {{ modelDir?: string }} opts - 模型目录覆盖
 * @returns {Promise<{ok:true, text:string} | {ok:false, reason:string, message:string}>}
 */
export async function transcribeWav(wav, opts = {}) {
  const dir = resolveModelDir(opts.modelDir)
  if (!dir) {
    return {
      ok: false, reason: 'unsupported',
      message: '没找到语音识别模型（DSH 面板里下载 SenseVoice，或在桌宠设置里填模型目录）',
    }
  }
  const addon = loadAddon()
  if (!addon) {
    return { ok: false, reason: 'unsupported', message: '没找到 sherpa-onnx 运行库（DSH 自带，可能装的是精简版）' }
  }

  // 模型只加载一次；换目录才重建
  if (!cached || cached.key !== dir) {
    try {
      cached = {
        key: dir,
        addon,
        rec: addon.createOfflineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            senseVoice: { model: join(dir, MODEL_FILE), language: 'zh', useInverseTextNormalization: 1 },
            tokens: join(dir, TOKENS_FILE),
            numThreads: 2, provider: 'cpu', debug: 0,
          },
        }),
      }
    } catch (error) {
      cached = null
      return { ok: false, reason: 'generate-error', message: '模型加载失败：' + String(error?.message || error) }
    }
  }

  try {
    const samples = decodePcm16(wav)
    if (!samples || samples.length === 0) return { ok: false, reason: 'bad-request', message: '这段音频是空的' }
    const { rec, addon: a } = cached
    const stream = a.createOfflineStream(rec)
    a.acceptWaveformOffline(stream, { samples, sampleRate: 16000 })
    a.decodeOfflineStream(rec, stream)
    const json = a.getOfflineStreamResultAsJson(stream)
    const parsed = JSON.parse(json)
    // 识别结果里带 <|zh|>/<|EMO_*>|/<|Speech|> 这类标记，只要正文
    const text = String(parsed?.text || '').replace(/<\|[^|]*\|>/g, '').trim()
    return { ok: true, text }
  } catch (error) {
    return { ok: false, reason: 'generate-error', message: String(error?.message || error) }
  }
}

/**
 * 从 WAV 字节里取出 PCM 采样并归一成 [-1,1] 浮点（sherpa 要的就是这个）。
 *
 * 只认 16bit PCM：我们在渲染页自己拼的 WAV 就这一种，不必支持别的位深。
 */
function decodePcm16(wav) {
  if (!wav || wav.length < 44) return null
  // 找 data 块：不能假定它一定在 36 偏移（有些编码器会插 LIST 块）
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const end = Math.min(start + size, wav.length)
      const count = Math.floor((end - start) / 2)
      const out = new Float32Array(count)
      for (let i = 0; i < count; i++) out[i] = wav.readInt16LE(start + i * 2) / 0x8000
      return out
    }
    offset += 8 + size + (size % 2) // 块按偶数字节对齐
  }
  return null
}
