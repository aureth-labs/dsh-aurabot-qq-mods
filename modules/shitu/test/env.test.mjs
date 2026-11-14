/**
 * env.test.mjs —— 环境探针与归属判定
 *
 * 这组测试钉死「不会动用户已有环境」这条硬约束：
 * 别人的目录、别人的 venv、只有标点的图，都不能被当成「可以随便改」。
 * 全部只碰临时目录，不启动 python、不联网。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OWNED_MARKER,
  VERSION_FILE,
  dirUsable,
  readOwnedMarker,
  readVersionFile,
  venvDirOf,
  venvOwnedByShitu,
  venvPython,
} from '../lib/env.mjs'

/** 建一个临时目录，测完删掉。 */
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shitu-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 在 dir 下造一个「看起来像 venv」的目录。 */
function fakeVenv(dir, { command = '', marker = '' } = {}) {
  const vd = venvDirOf(dir)
  mkdirSync(vd, { recursive: true })
  if (command) writeFileSync(join(vd, 'pyvenv.cfg'), `home = C:\\Python312\ncommand = ${command}\n`, 'utf8')
  if (marker) writeFileSync(join(vd, OWNED_MARKER), marker, 'utf8')
  return vd
}

test('空目录可以让我们用', (t) => {
  const dir = tmp(t)
  assert.deepEqual(dirUsable(dir).ok, true)
  assert.equal(dirUsable(dir).fresh, true)
})

test('不存在的目录也算可用（安装器会建）', (t) => {
  const dir = join(tmp(t), 'not-yet')
  assert.equal(dirUsable(dir).ok, true)
})

test('本模块铺过的目录（有 .shitu-ver）可以继续用', (t) => {
  const dir = tmp(t)
  writeFileSync(join(dir, 'ocr_run.py'), '# 我们的脚本', 'utf8')
  writeFileSync(join(dir, VERSION_FILE), '1.0.0\n', 'utf8')
  const r = dirUsable(dir)
  assert.equal(r.ok, true)
  assert.equal(r.ours, true)
})

test('用户的目录（有别的文件、没有我们的标记）一律拒绝', (t) => {
  const dir = tmp(t)
  writeFileSync(join(dir, 'ocr_core.py'), "print('用户自己的 OCR')", 'utf8')
  const r = dirUsable(dir)
  assert.equal(r.ok, false)
  assert.match(r.reason, /换一个空目录/)
})

test('只有空 .venv 的目录算半成品，可以用', (t) => {
  const dir = tmp(t)
  mkdirSync(venvDirOf(dir), { recursive: true })
  const r = dirUsable(dir)
  assert.equal(r.ok, true)
  assert.equal(r.partial, true)
})

test('有 .shitu-owned 标记的 venv 认作自己的', (t) => {
  const dir = tmp(t)
  fakeVenv(dir, { marker: 'by=shitu\n' })
  assert.equal(venvOwnedByShitu(dir), true)
})

test('没有标记、command 也不指向我们 → 不是我们的 venv', (t) => {
  const dir = tmp(t)
  fakeVenv(dir, { command: 'C:\\Python312\\python.exe -m venv D:\\my-project\\.venv' })
  assert.equal(venvOwnedByShitu(dir), false)
})

test('老版本 venv（无标记但 command 含 shitu 路径）会被认领', (t) => {
  // 真实的安装路径是 <data>/shitu/ocr/.venv，所以 command 里一定带 shitu。
  // 临时目录名要显式含 shitu，才能模拟这个形态。
  const root = tmp(t)
  const dir = join(root, 'shitu', 'ocr')
  mkdirSync(dir, { recursive: true })
  const vd = venvDirOf(dir)
  fakeVenv(dir, { command: `C:\\Python312\\python.exe -m venv ${vd}` })
  assert.equal(venvOwnedByShitu(dir), true)
})

test('command 里有 shitu 字样但指向别的 .venv → 不认', (t) => {
  const root = tmp(t)
  const dir = join(root, 'shitu', 'ocr')
  mkdirSync(dir, { recursive: true })
  fakeVenv(dir, { command: 'C:\\Python312\\python.exe -m venv D:\\other\\shitu\\ocr\\.venv-别的' })
  assert.equal(venvOwnedByShitu(dir), false)
})

test('没有 venv 目录时不算自己的', (t) => {
  const dir = tmp(t)
  assert.equal(venvOwnedByShitu(dir), false)
})

test('归属标记能读回键值', (t) => {
  const dir = tmp(t)
  fakeVenv(dir, { marker: 'created=2026-11-11T00:00:00.000Z\nassets=1.0.0\nby=shitu\n' })
  assert.deepEqual(readOwnedMarker(dir), {
    created: '2026-11-11T00:00:00.000Z',
    assets: '1.0.0',
    by: 'shitu',
  })
})

test('没有标记时读出空对象，不抛', (t) => {
  const dir = tmp(t)
  assert.deepEqual(readOwnedMarker(dir), {})
})

test('脚本版本文件读写', (t) => {
  const dir = tmp(t)
  assert.equal(readVersionFile(dir), '')
  writeFileSync(join(dir, VERSION_FILE), '1.2.3\n', 'utf8')
  assert.equal(readVersionFile(dir), '1.2.3')
})

test('venv 里的 python 路径按平台拼', (t) => {
  const dir = tmp(t)
  const p = venvPython(dir)
  if (process.platform === 'win32') assert.match(p, /Scripts[\\/]python\.exe$/)
  else assert.match(p, /bin[\\/]python$/)
  assert.ok(p.startsWith(venvDirOf(dir)))
})
