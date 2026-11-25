// screen-ops.test.mjs —— v1.3.0 的共享帧操作（screen.capture / screen.info）测试
// 来源：aurabot 模块库 modules/windows-ops（MIT）。注入 fake ps，不打真 PowerShell。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOps, OPS } from '../lib/ops.mjs'
import { b64arg } from '../lib/ps.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-screen-'))

function fakePs() {
  const calls = []
  return {
    calls,
    isWin: () => true,
    b64arg,
    run: async (script) => {
      calls.push(script)
      // screen.capture 的输出带缩放后的宽高；screen.info 只有虚拟屏幕矩形
      if (script.includes('JpegBitmapEncoder')) return '{"x":0,"y":0,"w":1920,"h":1080,"sw":1280,"sh":720}'
      return '{"x":0,"y":0,"w":1920,"h":1080}'
    },
  }
}

test('操作目录里声明了共享帧与屏幕尺寸（都是 safe，不碰键鼠）', () => {
  assert.equal(OPS['screen.capture'].danger, 'safe')
  assert.equal(OPS['screen.info'].danger, 'safe')
})

test('screen.capture：脚本用 WPF JPEG 编码器 + 缩放，文件落 dataDir/shots，矩形原样带回', async () => {
  const ps = fakePs()
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('screen.capture', { maxWidth: 1600, quality: 70 })
  assert.equal(r.ok, true)
  assert.match(r.data.file, /shots[\\/]frame-.*\.jpg$/)
  assert.equal(existsSync(r.data.file), false) // fake ps 不真写文件，只验路径生成
  assert.deepEqual({ x: r.data.x, y: r.data.y, width: r.data.width, height: r.data.height }, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.equal(r.data.scaledWidth, 1280)
  // 参数经 base64 进脚本：1600 → MTYwMA==，70 → NzA=
  assert.ok(ps.calls[0].includes("'MTYwMA=='"))
  assert.ok(ps.calls[0].includes("'NzA='"))
  // 质量/缩放的关键语句在脚本里（防止以后换成 PNG 又把帧撑大）
  assert.match(ps.calls[0], /JpegBitmapEncoder/)
  assert.match(ps.calls[0], /QualityLevel/)
  assert.match(ps.calls[0], /HighQualityBilinear/)
  assert.match(ps.calls[0], /CopyFromScreen/)
})

test('screen.capture：参数越界会被夹住（宽度 320~3840、质量 20~95）', async () => {
  const ps = fakePs()
  const ops = createOps({ ps, dataDir: DATA })
  await ops.run('screen.capture', { maxWidth: 10, quality: 999 })
  assert.ok(ps.calls[0].includes("'MzIw'")) // 320
  assert.ok(ps.calls[0].includes("'OTU='")) // 95
})

test('screen.info：返回虚拟屏幕矩形', async () => {
  const ps = fakePs()
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('screen.info', {})
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, { x: 0, y: 0, width: 1920, height: 1080 })
  assert.match(r.message, /1920×1080/)
})
