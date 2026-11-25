// 表情包模块内联：从 Aurabot 插件 src/core/store.js 与 src/tools/tools.js 搬来。
// 对应插件 v1.2.0-rc.1。

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

// ---------------- 工具定义 ----------------

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


// ---------------- 文字处理（从 src/core/text.js 搬来） ----------------

/** 去掉孤立的代理字符：按 UTF-16 截断会把 emoji 劈成两半。 */
export function cleanText(text) {
  const s = String(text ?? '')
  return s.isWellFormed() ? s : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

export const clipText = (text, n) => [...cleanText(text)].slice(0, n).join('')
