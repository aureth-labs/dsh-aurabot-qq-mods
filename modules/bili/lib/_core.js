// B站模块内联的核心工具：从 Aurabot 插件 src/core 与 src/tools 搬来。
// 模块独立分发时不能 import 插件源码，所以在这里复制一份。
// 对应插件 v1.2.0-rc.1 的 src/core/store.js、src/core/text.js、src/tools/tools.js。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

// ---------------- 数据目录 ----------------

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件所有数据都放这儿：~/.dsh/plugins-data/aurabot/ */
export function dataDir(...parts) {
  const base = process.env.AURABOT_DATA_DIR || join(dshHome(), 'plugins-data', 'aurabot')
  return join(base, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export { existsSync }

// ---------------- 文字处理 ----------------

/** 去掉孤立的代理字符：按 UTF-16 截断会把 emoji 劈成两半，这种字符串发给模型会被整轮 400。 */
export function cleanText(text) {
  const s = String(text ?? '')
  return s.isWellFormed() ? s : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

/** 按字符截断，不会切开 emoji。 */
export const clipText = (text, n) => [...cleanText(text)].slice(0, n).join('')

/** 清理提示词内容块里的文字。 */
export const cleanContent = (content) => content.map((c) => (c?.type === 'text' ? { ...c, text: cleanText(c.text) } : c))

// ---------------- 工具定义 ----------------

/**
 * 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形：parameters / output.schema 是 JSON Schema。
 * render 可选：默认只回一行文字。
 */
export function defineTool({ name, description, properties = {}, required = [], execute, render, slow }) {
  const parameters = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    ...(slow ? { slow } : {}),
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: render || ((_args, value) => [{ type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' }]),
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  }
}

export const str = (description) => ({ type: 'string', description })
export const int = (description) => ({ type: 'integer', description })
export const bool = (description) => ({ type: 'boolean', description })


// ---------------- 头像地址（从 src/modules/profile/index.js 搬来） ----------------

/** 头像只能用网址图片。 */
export function avatarSource(input) {
  const s = String(input || '').trim()
  if (/^https?:\/\//i.test(s)) return { ok: true, file: s }
  return { ok: false, message: '头像只能用网址图片' }
}


// ---------------- 图片类型判断（从 src/chat/inbound.js 搬来） ----------------

export function mimeOf(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return 'application/octet-stream'
}
