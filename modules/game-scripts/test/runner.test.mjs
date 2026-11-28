import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSettings } from '../lib/policy.mjs'
import { createRunner } from '../lib/runner.mjs'

const nodeLines = [
  "console.log('hello ' + process.argv.slice(2).join(','))",
]

const stdinLines = [
  "let data = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => { data += chunk })",
  "process.stdin.on('end', () => console.log('stdin:' + data.trim()))",
]

const childLines = [
  "import { spawnSync } from 'node:child_process'",
  'try {',
  "  spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })",
  "  console.log('child allowed')",
  '} catch (error) {',
  "  console.log('child blocked ' + (error.code || error.message))",
  '}',
]

test('runs a Node script with args and input', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({ timeoutSeconds: 5 }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'hello.mjs'), nodeLines.join('\n'))
  await writeFile(join(config.scriptDir, 'echo.mjs'), stdinLines.join('\n'))
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  const hello = await runner.run('hello', { args: ['a', 'b'] })
  assert.equal(hello.ok, true)
  assert.match(hello.stdout, /hello a,b/)
  assert.match(hello.message, /退出码 0/)

  const echo = await runner.run('echo', { input: '小鲸鱼' })
  assert.equal(echo.ok, true)
  assert.match(echo.stdout, /stdin:小鲸鱼/)
})

test('Node permission model blocks child processes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({ nodeSandbox: true, timeoutSeconds: 5 }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'child.mjs'), childLines.join('\n'))
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  const result = await runner.run('child')
  assert.equal(result.ok, true)
  assert.match(result.stdout, /child blocked/)
})

test('timeout kills a hanging script', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({ timeoutSeconds: 1 }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'hang.mjs'), 'setInterval(() => {}, 1000)')
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  const result = await runner.run('hang')
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
  assert.match(result.message, /超时/)
})

test('output cap stops a noisy script', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({ maxOutputKb: 1, timeoutSeconds: 5 }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'noisy.mjs'), "console.log('x'.repeat(9000))")
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  const result = await runner.run('noisy')
  assert.equal(result.truncated, true)
  assert.equal(result.ok, false)
  assert.match(result.message, /输出超过/)
})

test('only one run at a time', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({ timeoutSeconds: 1 }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'hang.mjs'), 'setInterval(() => {}, 1000)')
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  const first = runner.run('hang')
  await assert.rejects(() => runner.run('hang'), /上一个脚本还在跑/)
  const result = await first
  assert.equal(result.timedOut, true)
})

test('missing PowerShell reports the configured path', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({
    runtime: 'powershell',
    powershellPath: 'this-pwsh-does-not-exist-game-scripts',
    timeoutSeconds: 5,
  }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'hello.ps1'), "Write-Output 'hello'")
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  const result = await runner.run('hello')
  assert.equal(result.ok, false)
  assert.match(result.message, /找不到 PowerShell/)
  assert.match(result.message, /this-pwsh-does-not-exist-game-scripts/)
})

test('rate limit holds', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'game-scripts-runner-'))
  const config = normalizeSettings({ maxRunsPerHour: 2, timeoutSeconds: 5 }, { dataDir })
  await mkdir(config.scriptDir, { recursive: true })
  await writeFile(join(config.scriptDir, 'hello.mjs'), nodeLines.join('\n'))
  const runner = createRunner(() => config)
  t.after(async () => {
    runner.dispose()
    await rm(dataDir, { recursive: true, force: true })
  })

  assert.equal((await runner.run('hello')).ok, true)
  assert.equal((await runner.run('hello')).ok, true)
  await assert.rejects(() => runner.run('hello'), /一小时最多/)
})
