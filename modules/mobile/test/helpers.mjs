// 通过仓库 scripts/plugin-env.mjs 加载测试宿主，不在模块运行时代码里导入本体源码。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createMobileService as createService } from '../lib/service.mjs'

if (!globalThis.aurabot?.src) throw new Error('请设置 AURABOT_PLUGIN_DIR，并用 --import ./scripts/plugin-env.mjs 运行测试')
export const pluginSource = globalThis.aurabot.src
export const pluginRoot = new URL('../', pluginSource)
export const version = JSON.parse(readFileSync(new URL('package.json', pluginRoot), 'utf8')).version
export const { createFakeDsh } = await import(new URL('test/helpers/fake-dsh.js', pluginRoot))
export const { startMockOneBot } = await import(new URL('test/helpers/mock-onebot.js', pluginRoot))
export const { buildWav } = globalThis.aurabot.lib('voice/wav.js')

// 手机端要 1.3.0 起的本体接口（core/media.js 等，本体 #299）。模块库 CI 的测试宿主可能更旧：
// 这时用到宿主的测试跳过并写明原因，不当成失败；纯单元测试照常运行。
let createMediaAccess = null
try { ({ createMediaAccess } = globalThis.aurabot.lib('core/media.js')) } catch {}
export const hostSkip = createMediaAccess ? false : `测试宿主是本体 ${version}，没有 core/media.js；手机端要 1.3.0 起的接口，跳过`
/** 用到本体宿主的测试用它注册；宿主太旧时自动跳过。 */
export function hostTest(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {} }
  return test(name, { ...options, skip: options.skip || hostSkip }, fn)
}

export function createMobileService(options) {
  if (!options.media && !createMediaAccess) throw new Error(hostSkip)
  const media = options.media || createMediaAccess({ root: fileURLToPath(pluginRoot), use: options.use, config: options.config })
  return createService({ version, media, ...options })
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(20) }
  throw new Error('等待手机端事件或会话超时')
}
