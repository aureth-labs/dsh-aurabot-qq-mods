import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildEnv,
  clip,
  fence,
  normalizeArgs,
  normalizeName,
  normalizeSettings,
  permissionFlagFor,
  scriptPath,
} from '../lib/policy.mjs'

const dataDir = resolve(tmpdir(), 'game-scripts-policy')

test('settings defaults', () => {
  const config = normalizeSettings({}, { dataDir })
  assert.equal(config.runtime, 'node')
  assert.equal(config.ext, '.mjs')
  assert.equal(config.scriptDir, resolve(dataDir, 'scripts'))
  assert.equal(config.timeoutMs, 20000)
  assert.equal(config.maxOutputBytes, 16 * 1024)
  assert.equal(config.maxScriptBytes, 64 * 1024)
  assert.equal(config.maxRunsPerHour, 30)
  assert.equal(config.nodeSandbox, true)
})

test('settings clamps and runtime fallback', () => {
  const config = normalizeSettings({
    runtime: 'shell',
    timeoutSeconds: 999,
    maxOutputKb: 0,
    maxScriptKb: 9999,
    maxRunsPerHour: 0,
    nodeSandbox: false,
  }, { dataDir })
  assert.equal(config.runtime, 'node')
  assert.equal(config.timeoutMs, 300000)
  assert.equal(config.maxOutputBytes, 1024)
  assert.equal(config.maxScriptBytes, 512 * 1024)
  assert.equal(config.maxRunsPerHour, 1)
  assert.equal(config.nodeSandbox, false)
})

test('relative and absolute script directories', () => {
  const relative = normalizeSettings({ scriptDir: 'my-scripts' }, { dataDir })
  assert.equal(relative.scriptDir, resolve(dataDir, 'my-scripts'))
  const absolute = resolve(dataDir, 'elsewhere')
  assert.equal(normalizeSettings({ scriptDir: absolute }, { dataDir }).scriptDir, absolute)
})

test('powershell path strips wrapping quotes and defaults to pwsh', () => {
  const quoted = normalizeSettings({ powershellPath: '  "C:/Program Files/PowerShell/7/pwsh.exe"  ' }, { dataDir })
  assert.equal(quoted.powershellPath, 'C:/Program Files/PowerShell/7/pwsh.exe')
  assert.equal(normalizeSettings({ powershellPath: '   ' }, { dataDir }).powershellPath, 'pwsh')
})

test('script names are safe', () => {
  assert.equal(normalizeName('Guess.MJS'), 'guess')
  assert.equal(normalizeName('guess.mjs'), 'guess')
  assert.equal(normalizeName('a.js'), 'a')
  assert.equal(normalizeName('x.ps1'), 'x')
  assert.equal(normalizeName('snake-2'), 'snake-2')
  assert.equal(normalizeName('a_b'), 'a_b')
  for (const bad of ['', '..', '../evil', 'a/b', '.hidden', 'con', 'com1', 'a b', 'x'.repeat(41)]) {
    assert.throws(() => normalizeName(bad), /脚本名|保留名/)
  }
})

test('script path stays inside the script directory', () => {
  const config = normalizeSettings({}, { dataDir })
  assert.equal(scriptPath(config, 'guess'), resolve(config.scriptDir, 'guess.mjs'))
  assert.throws(() => scriptPath({ ...config, scriptDir: dataDir }, '../evil'), /脚本名|路径/)
})

test('args are bounded strings', () => {
  assert.deepEqual(normalizeArgs(['a', 1]), ['a', '1'])
  assert.deepEqual(normalizeArgs(null), [])
  assert.throws(() => normalizeArgs('a'), /字符串数组/)
  assert.throws(() => normalizeArgs(Array.from({ length: 21 }, () => 'x')), /最多 20/)
  assert.throws(() => normalizeArgs(['x'.repeat(201)]), /200/)
})

test('permission flag follows Node version', () => {
  assert.equal(permissionFlagFor('22.2.0'), '--experimental-permission')
  assert.equal(permissionFlagFor('22.12.0'), '--experimental-permission')
  assert.equal(permissionFlagFor('22.13.0'), '--permission')
  assert.equal(permissionFlagFor('23.5.0'), '--permission')
  assert.equal(permissionFlagFor('24.21.0'), '--permission')
})

test('child environment is allowlisted', () => {
  const env = buildEnv({
    PATH: '/usr/bin',
    SystemRoot: 'C:/Windows',
    SECRET_TOKEN: 'nope',
    NODE_OPTIONS: '--require evil.js',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.SystemRoot, 'C:/Windows')
  assert.equal(env.SECRET_TOKEN, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})

test('clip and fence are safe', () => {
  assert.equal(clip('abc', 10), 'abc')
  assert.match(clip('abcdef', 3), /后面还有 3 个字/)
  assert.match(fence('const a = 1'), /^```\n/)
  assert.match(fence('a ``` b'), /^````/)
})
