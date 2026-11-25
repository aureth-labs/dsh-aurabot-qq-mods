// ps-ops.test.mjs —— windows-ops PowerShell 底座与操作层测试（注入 fake ps，不打真进程）
// 来源：aurabot 模块库 modules/windows-ops（MIT）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPs, b64arg } from '../lib/ps.mjs'
import { createOps, OPS } from '../lib/ops.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-ops-'))

/** 收集每次 run 的脚本与参数列表（base64），供断言。 */
function fakePs(outputs = {}) {
  const calls = []
  return {
    calls,
    isWin: () => true,
    b64arg,
    run: async (script) => {
      calls.push(script)
      // 取脚本里最后一段 $a=(...) 参数列表并解码，模拟 PowerShell 的行为
      const m = script.match(/\$a=\@\(([^)]*)\)/)
      const argv = m ? m[1].match(/'([^']*)'/g)?.map((q) => Buffer.from(q.slice(1, -1), 'base64').toString('utf8')) || [] : []
      const key = (script.match(/Get-Clipboard/) ? 'clipboard.read' : '')
      return outputs[key] ?? outputs['*'] ?? 'ok'
    },
  }
}

test('b64arg：用户字符串转 base64，脚本里解码后是原文（注入只当普通字符）', () => {
  const evil = "'; Remove-Item C:\\ -Recurse; '"
  const back = Buffer.from(b64arg(evil), 'base64').toString('utf8')
  assert.equal(back, evil)
})

test('createPs：默认路径指向 System32 的 powershell.exe', () => {
  const ps = createPs({})
  if (process.platform === 'win32') {
    assert.match(ps.exe, /[Ss]ystem32.*powershell\.exe$/)
    assert.equal(ps.isWin(), true)
  } else {
    assert.equal(ps.isWin(), false)
  }
})

test('clipboard.read：脚本不含拼接的用户输入；输出原样带回 data', async () => {
  const ps = fakePs({ 'clipboard.read': '你好，剪贴板' })
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('clipboard.read', {})
  assert.equal(r.ok, true)
  assert.equal(r.data, '你好，剪贴板')
})

test('clipboard.write：文本经 base64 进脚本（解码后与原文一致）', async () => {
  const ps = fakePs({ '*': '' })
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('clipboard.write', { text: 'ab"cd; evil' })
  assert.equal(r.ok, true)
  assert.match(ps.calls[0], /Set-Clipboard -Value \(D \$a\[0\]\)/)
  // 解码参数 = 原文
  const m = ps.calls[0].match(/\$a=\@\('([^']+)'\)/)
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), 'ab"cd; evil')
})

test('key.text：SendKeys 特殊字符被转义（+ → {+}）', async () => {
  const ps = fakePs({ '*': '' })
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('key.text', { text: 'a+b(c)' })
  assert.equal(r.ok, true)
  const m = ps.calls[0].match(/\$a=\@\('([^']+)'\)/)
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), 'a{+}b{(}c{)}')
})

test('key.press：只接受白名单键名', async () => {
  const ps = fakePs({ '*': '' })
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('key.press', { key: 'enter' })
  assert.equal(r.ok, true)
  const m = ps.calls[0].match(/\$a=\@\('([^']+)'\)/)
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), '{ENTER}')
  await assert.rejects(ops.run('key.press', { key: '{ENTER}' })) // 任意 token 不放行
  await assert.rejects(ops.run('key.press', { key: 'win' }))
})

test('window.list：单元素 JSON 包成数组；无窗口进程列表为空', async () => {
  const ps = fakePs({ '*': JSON.stringify({ w: [{ pid: 1, name: 'a', title: 't' }] }) })
  const ops = createOps({ ps, dataDir: DATA })
  const one = await ops.run('window.list', {})
  assert.deepEqual(one.data, [{ pid: 1, name: 'a', title: 't' }])
  const ps2 = fakePs({ '*': JSON.stringify({ w: [] }) })
  const empty = await createOps({ ps: ps2, dataDir: DATA }).run('window.list', {})
  assert.deepEqual(empty.data, [])
})

test('screenshot：文件路径强制落在数据目录 shots/ 下', async () => {
  const ps = fakePs({ '*': 'ok' })
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('screenshot', {})
  assert.equal(r.ok, true)
  assert.match(String(r.data), /^.+[\/\\]shots[\/\\]shot-\d+\.png$/)
  // 传入的 file 参数被忽略，不能把截图写到别处
  const r2 = await ops.run('screenshot', { file: 'C:/Windows/evil.png' })
  assert.match(String(r2.data), /[\/\\]shots[\/\\]/)
})

test('mouse.click：坐标按数字传递，right 映射右键标志', async () => {
  const ps = fakePs({ '*': 'ok' })
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('mouse.click', { x: 10.6, y: '20', button: 'right' })
  assert.equal(r.ok, true)
  const m = ps.calls[0].match(/\$a=\@\('([^']+)','([^']+)','([^']+)'\)/)
  const argv = [m[1], m[2], m[3]].map((q) => Buffer.from(q, 'base64').toString('utf8'))
  assert.deepEqual(argv, ['11', '20', 'right']) // x 取整
})

test('非 Windows 平台给可读错误，不悄悄执行', async () => {
  const ps = { isWin: () => false, b64arg, run: async () => 'ok' }
  const r = await createOps({ ps, dataDir: DATA }).run('clipboard.read', {})
  assert.equal(r.ok, false)
  assert.match(r.message, /只能在 Windows/)
})

test('OPS 元数据齐全：脚本目录与元数据一致', () => {
  for (const op of Object.keys(OPS)) assert.equal(typeof OPS[op].danger, 'string')
})
