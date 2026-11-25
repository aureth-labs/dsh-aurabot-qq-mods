import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { EventEmitter } from 'node:events'
import { normalizePrinter, parseTcpTarget, windowsArgs, sendBytes, WINDOWS_SCRIPT, queryStatus, statusQueryBytes } from '../lib/transport.mjs'

function fakeSpawn(captured) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    const record = { command, args, options, stdin: null }
    captured.push(record)
    child.stdin = {
      end(buf) {
        record.stdin = buf
        setImmediate(() => child.emit('close', 0))
      },
    }
    setImmediate(() => {
      if (!record.stdin) child.emit('close', 0)
    })
    return child
  }
}

test('打印机参数归一化', () => {
  const p = normalizePrinter({ name: ' POS-58 ', transport: 'weird', target: ' 1.2.3.4 ', width: 48 }, { width: 32 })
  assert.equal(p.name, 'POS-58')
  assert.equal(p.transport, 'windows')
  assert.equal(p.target, '1.2.3.4')
  assert.equal(p.paperWidthMm, 80)
  assert.equal(p.effectiveWidthMm, 0, '0 表示按纸宽自动')
  assert.equal(normalizePrinter({ width: 32 }).paperWidthMm, 58)
  assert.equal(normalizePrinter({ paperWidthMm: 40, effectiveWidthMm: 35 }).paperWidthMm, 40)
  assert.equal(normalizePrinter({ paperWidthMm: 40, effectiveWidthMm: 35 }).effectiveWidthMm, 35)
  assert.equal(normalizePrinter({ paperWidthMm: 300 }).paperWidthMm, 58, '超范围纸宽回落默认值')
})

test('解析网口目标', () => {
  assert.deepEqual(parseTcpTarget({ target: '192.168.1.5', port: 9100 }), { host: '192.168.1.5', port: 9100 })
  assert.deepEqual(parseTcpTarget({ target: '192.168.1.5:9101', port: 9100 }), { host: '192.168.1.5', port: 9101 })
  assert.deepEqual(parseTcpTarget({ target: 'http://printer.local', port: 9100 }), { host: 'printer.local', port: 9100 })
})

test('Windows 参数和脚本', () => {
  const args = windowsArgs('C:\\x\\raw.ps1', 'POS-58', 'C:\\x\\job.bin')
  assert.ok(args.includes('-PrinterName'))
  assert.ok(args.includes('POS-58'))
  assert.ok(WINDOWS_SCRIPT.includes('WritePrinter'))
  assert.ok(WINDOWS_SCRIPT.includes('winspool.drv'))
})

test('TCP：字节真的送到本地假打印机', async () => {
  const chunks = []
  const server = createServer((socket) => {
    socket.on('data', (chunk) => chunks.push(chunk))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const printer = normalizePrinter({ name: 'lan', transport: 'tcp', target: `127.0.0.1:${port}` })
  const result = await sendBytes(printer, Buffer.from('hello escpos'), { timeoutMs: 3000 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  server.close()
  assert.equal(result.ok, true)
  assert.equal(Buffer.concat(chunks).toString(), 'hello escpos')
})

test('TCP：连不上会报错而不是卡住', async () => {
  const printer = normalizePrinter({ name: 'lan', transport: 'tcp', target: '127.0.0.1:1' })
  const result = await sendBytes(printer, Buffer.from('x'), { timeoutMs: 800 })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('网口状态查询：发出 DLE EOT，读回 4 个状态字节', async () => {
  const received = []
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      received.push(chunk)
      socket.write(Buffer.from([0x00, 0x00, 0x00, 0x40]))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const printer = normalizePrinter({ name: 'lan', transport: 'tcp', target: `127.0.0.1:${port}` })
  const result = await queryStatus(printer, { timeoutMs: 1000, waitMs: 200 })
  server.close()
  assert.equal(result.ok, true)
  assert.equal(result.supported, true)
  assert.deepEqual([...result.bytes], [0x00, 0x00, 0x00, 0x40])
  assert.deepEqual([...received[0]], [...statusQueryBytes()])
})

test('CUPS 只能发送，状态查询明确说不支持', async () => {
  const result = await queryStatus(normalizePrinter({ transport: 'cups', target: 'POS-58' }))
  assert.equal(result.ok, false)
  assert.equal(result.supported, false)
  assert.ok(result.error.includes('只能发'))
})

test('CUPS：调用 lp -o raw', async () => {
  const captured = []
  const printer = normalizePrinter({ name: 'cups', transport: 'cups', target: 'POS58' })
  const result = await sendBytes(printer, Buffer.from('abc'), { spawnImpl: fakeSpawn(captured) })
  assert.equal(result.ok, true)
  assert.equal(captured[0].command, 'lp')
  assert.deepEqual(captured[0].args, ['-d', 'POS58', '-o', 'raw', '-'])
  assert.equal(captured[0].stdin.toString(), 'abc')
})

test('Windows：调用 PowerShell 并清理临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-win-'))
  const captured = []
  const printer = normalizePrinter({ name: 'usb', transport: 'windows', target: 'POS-58' })
  const result = await sendBytes(printer, Buffer.from('raw-bytes'), {
    platform: 'win32', dataDir: dir, spawnImpl: fakeSpawn(captured),
  })
  assert.equal(result.ok, true)
  assert.equal(captured[0].command, 'powershell.exe')
  assert.ok(captured[0].args.includes('POS-58'))
  const files = await readdir(dir)
  assert.ok(files.includes('raw-print.ps1'))
  assert.ok(!files.some((f) => f.startsWith('job-')), '临时 job 文件应该被删掉')
  assert.ok((await readFile(join(dir, 'raw-print.ps1'), 'utf8')).includes('WritePrinter'))
})

test('Windows：非 Windows 平台直接拒绝', async () => {
  const printer = normalizePrinter({ name: 'usb', transport: 'windows', target: 'POS-58' })
  const result = await sendBytes(printer, Buffer.from('x'), { platform: 'linux', dataDir: await mkdtemp(join(tmpdir(), 'receipt-win-')) })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是 Windows/)
})

test('预览模式不调用任何外部程序', async () => {
  const printer = normalizePrinter({ name: 'preview', transport: 'preview' })
  const result = await sendBytes(printer, Buffer.from('x'))
  assert.deepEqual(result, { ok: true, preview: true })
})
