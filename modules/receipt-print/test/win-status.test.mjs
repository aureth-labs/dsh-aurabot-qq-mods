import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  buildStatusScript,
  parseWindowsStatus,
  renderDriverStatus,
  queryWindowsStatus,
} from '../lib/win-status.mjs'
import { queryStatus } from '../lib/transport.mjs'

function fakeSpawn(stdout, code = 0, stderr = '') {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout)
      if (stderr) child.stderr.emit('data', stderr)
      child.emit('close', code)
    })
    return child
  }
}

test('正常状态：空闲，没有错误', () => {
  const info = parseWindowsStatus({
    found: true,
    printerStatus: 3,
    detectedErrorState: 2,
    workOffline: false,
    printerState: 0,
    jobCount: 0,
    portName: 'USB001',
  })
  assert.equal(info.printerStatusText, '空闲')
  assert.equal(info.detectedErrorText, '正常')
  assert.deepEqual(info.problems, [])
  const text = renderDriverStatus(info, '58mm')
  assert.match(text, /打印机「58mm」：空闲/)
  assert.match(text, /端口：USB001/)
  assert.match(text, /驱动视角/)
})

test('离线：workOffline 和状态码都识别', () => {
  const a = parseWindowsStatus({ found: true, printerStatus: 7, detectedErrorState: 9, workOffline: true })
  assert.ok(a.problems.includes('离线'))
  const b = parseWindowsStatus({ found: true, printerStatus: 3, workOffline: false, getPrinterStatus: 'Offline' })
  assert.ok(b.problems.includes('离线'))
})

test('缺纸、卡纸、开盖来自不同字段', () => {
  assert.ok(parseWindowsStatus({ found: true, getPrinterStatus: 'PaperOut' }).problems.includes('缺纸'))
  assert.ok(parseWindowsStatus({ found: true, detectedErrorState: 8 }).problems.includes('卡纸'))
  assert.ok(parseWindowsStatus({ found: true, printerState: 0x200000 }).problems.includes('机盖打开'))
  assert.ok(parseWindowsStatus({ found: true, detectedErrorState: 3 }).problems.includes('纸张将尽'))
})

test('PrinterState 位标志去重', () => {
  const info = parseWindowsStatus({ found: true, printerState: 0x2 | 0x8, detectedErrorState: 8 })
  const jams = info.problems.filter((x) => x === '卡纸')
  assert.equal(jams.length, 1)
})

test('找不到打印队列时给出明确提示', () => {
  const info = parseWindowsStatus({ found: false })
  assert.match(renderDriverStatus(info, 'X'), /找不到这个打印队列/)
})

test('PowerShell 脚本转义单引号', () => {
  assert.match(buildStatusScript("a'b"), /\$name = 'a''b'/)
  assert.ok(!buildStatusScript("x'; Remove-Item C:\\ /s").includes("x'; Remove"))
})

test('queryWindowsStatus 解析 PowerShell 输出', async () => {
  const out = JSON.stringify({
    found: true,
    printerStatus: 7,
    detectedErrorState: 4,
    workOffline: true,
    printerState: 0,
    jobCount: 2,
    portName: 'USB001',
  })
  const result = await queryWindowsStatus({ target: '58mm' }, { spawnImpl: fakeSpawn(out) })
  assert.equal(result.ok, true)
  assert.ok(result.driver.problems.includes('离线'))
  assert.ok(result.driver.problems.includes('缺纸'))
  assert.equal(result.driver.jobCount, 2)
})

test('queryWindowsStatus 处理非零退出码', async () => {
  const result = await queryWindowsStatus({ target: '58mm' }, { spawnImpl: fakeSpawn('', 1, '拒绝访问') })
  assert.equal(result.ok, false)
  assert.match(result.error, /拒绝访问/)
})

test('queryStatus 对 windows 走驱动状态而不是报「只能发送」', async () => {
  const out = JSON.stringify({ found: true, printerStatus: 3, detectedErrorState: 2 })
  const result = await queryStatus({ transport: 'windows', target: '58mm' }, { spawnImpl: fakeSpawn(out) })
  assert.equal(result.ok, true)
  assert.equal(result.driver.printerStatusText, '空闲')
})
