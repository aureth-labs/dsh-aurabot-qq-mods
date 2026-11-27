// 首次启动自取：模型和 onnxruntime 不打进包里（市场包上限 25MB），这里按需下载一次。
// · 模型：hf-mirror 镜像的 bge-small-zh-v1.5 int8 ONNX（23MB）
// · 运行时：npmmirror 的 onnxruntime-node tgz（约 115MB），解压后只留 Windows x64 那几个文件

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'

const MODEL = {
  file: 'model_int8.onnx',
  size: 23903394,
  urls: [
    'https://modelscope.cn/models/Xenova/bge-small-zh-v1.5/resolve/master/onnx/model_int8.onnx',
    'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_int8.onnx',
    'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_int8.onnx',
  ],
}

const ORT = {
  version: '1.31.1',
  urls: [
    'https://registry.npmmirror.com/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz',
    'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz',
  ],
  urlsCommon: [
    'https://registry.npmmirror.com/onnxruntime-common/-/onnxruntime-common-1.31.1.tgz',
  ],
}

/** 极简 tar 读取：只认普通文件，够解 npm 包 */
function readTar(buf) {
  const out = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    const start = off + 512
    if (type === '0' || type === '') out.push({ name, data: buf.subarray(start, start + size) })
    off = start + Math.ceil(size / 512) * 512
  }
  return out
}

async function download(urls, onProgress) {
  let lastError = null
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      const chunks = []
      let got = 0
      for await (const chunk of res.body) {
        chunks.push(chunk)
        got += chunk.length
        onProgress?.(got, total)
      }
      return Buffer.concat(chunks)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('下载失败')
}

export function createBootstrap({ dir, log = console }) {
  const assets = join(dir, 'assets')
  const modelPath = join(assets, MODEL.file)
  const ortRoot = join(dir, 'node_modules', 'onnxruntime-node')
  const commonRoot = join(dir, 'node_modules', 'onnxruntime-common')
  const state = { stage: '', got: 0, total: 0, error: '', done: false }

  const modelOk = () => existsSync(modelPath) && statSync(modelPath).size > MODEL.size * 0.9
  const ortOk = () => existsSync(join(ortRoot, 'package.json'))
  const commonOk = () => existsSync(join(commonRoot, 'package.json'))
  // onnxruntime-node 少了依赖 onnxruntime-common 也 require 不起来，必须一起算就绪
  const ready = () => modelOk() && ortOk() && commonOk()

  async function getModel() {
    if (modelOk()) return
    mkdirSync(assets, { recursive: true })
    state.stage = '下载模型'
    const buf = await download(MODEL.urls, (got, total) => {
      state.got = got
      state.total = total || MODEL.size
    })
    if (buf.length < MODEL.size * 0.9) throw new Error(`模型只下到 ${buf.length} 字节，不完整`)
    writeFileSync(modelPath, buf)
    log.info?.(`[记忆向量] 模型下载完成 ${Math.round(buf.length / 1024)} KB`)
  }

  async function getRuntime() {
    const needOrt = !ortOk()
    const needCommon = !commonOk()
    if (!needOrt && !needCommon) return
    state.stage = '下载向量运行时'
    if (needOrt) {
      const tgz = await download(ORT.urls, (got, total) => {
        state.got = got
        state.total = total
      })
      state.stage = '解开运行时'
      const files = readTar(gunzipSync(tgz))
      const keep = (name) => {
        if (name.endsWith('/')) return false
        // 只要 win32-x64 的二进制、js 代码和 package.json；lib/ 里全是普通 js，不能一起滤掉
        if (name.includes('/bin/') && !name.includes('/win32/x64/')) return false
        if (/DirectML\.dll$|dxcompiler\.dll$/.test(name)) return false
        return true
      }
      for (const f of files) {
        if (!keep(f.name)) continue
        const rel = f.name.replace(/^package\//, '')
        const dest = join(ortRoot, rel)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, f.data)
      }
    }
    // onnxruntime-common 是它的依赖：缺了它 require('onnxruntime-node') 会直接失败，所以不能静默跳过
    if (needCommon) {
      state.stage = '下载运行时依赖'
      const tgz2 = await download(ORT.urlsCommon, () => {})
      for (const f of readTar(gunzipSync(tgz2))) {
        if (f.name.endsWith('/')) continue
        const dest = join(commonRoot, f.name.replace(/^package\//, ''))
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, f.data)
      }
    }
    log.info?.('[记忆向量] 向量运行时准备好了')
  }

  return {
    state,
    ready,
    async ensure() {
      if (ready()) {
        state.done = true
        return true
      }
      try {
        await getModel()
        await getRuntime()
        state.done = true
        state.stage = ''
        return true
      } catch (error) {
        state.error = error.message
        state.stage = ''
        log.warn?.('[记忆向量] 自取失败：' + error.message)
        return false
      }
    },
  }
}
