/**
 * ocr.test.mjs —— 真跑一次识别（需要本机已装引擎）
 *
 * 这组是唯一会启动 python 的测试。引擎没装好时整组 skip，
 * 所以 CI（没有 venv）不会因为它变红；本地想验证真实效果时才有意义。
 *
 * 想让它在这里跑起来：
 *   SHITU_ENGINE_DIR=<装好引擎的目录> node --test test/ocr.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createOcr } from '../lib/ocr.mjs'
import { venvPython } from '../lib/env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELFTEST = join(HERE, '..', 'lib', 'assets', 'selftest.png')

/** 本机引擎目录：优先环境变量，其次 Aurabot 的默认数据目录。 */
const ENGINE_DIR =
  process.env.SHITU_ENGINE_DIR ||
  join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'modules-data', 'shitu', 'ocr')

/** 引擎真的可用吗（脚本在 + venv 里的 python 在）。 */
function engineReady() {
  return existsSync(join(ENGINE_DIR, 'ocr_run.py')) && existsSync(venvPython(ENGINE_DIR))
}

const SKIP = engineReady() ? false : `本机没装识别引擎（${ENGINE_DIR}），跳过真实识别测试`

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ocr = createOcr({ dir: () => ENGINE_DIR, log: silent, timeoutMs: 120_000 })

test('识别自带测试图，能读出里面的字', { skip: SKIP }, async () => {
  const buf = readFileSync(SELFTEST)
  const r = await ocr.one(buf, { mediaType: 'image/png' })
  assert.equal(r.ok, true, '识别失败：' + (r.error || ''))
  assert.ok(r.text.length > 0, '一个字符都没读出来')
  assert.match(r.text, /OCR/, '测试图上有「OCR」字样，应该读得到：' + r.text)
  assert.ok(r.lines.length > 0)
  assert.ok(r.elapsedMs > 0, '应该有耗时')
})

test('同样的图第二次命中缓存，不再起进程', { skip: SKIP }, async () => {
  const buf = readFileSync(SELFTEST)
  const a = await ocr.one(buf, { mediaType: 'image/png' })
  const b = await ocr.one(buf, { mediaType: 'image/png' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.cached, true, '第二次应该走缓存')
  assert.equal(a.text, b.text, '缓存前后结果要一致')
})

test('坏数据不会把进程搞崩，返回 ok:false', { skip: SKIP }, async () => {
  const r = await ocr.one(Buffer.from('这不是一张图'), { mediaType: 'image/png' })
  assert.equal(r.ok, false)
  assert.ok(r.error.length > 0, '要带上失败原因')
})

test('清缓存之后计数归零', { skip: SKIP }, async () => {
  ocr.clearCache()
  assert.equal(ocr.cacheSize().count, 0)
})
