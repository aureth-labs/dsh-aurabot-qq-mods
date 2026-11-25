// 小红书浏览器启动回归：用假进程和假 CDP 验证「静默退出 / 启动超时」的报错文案
// 不再把一切失败合并成「请检查浏览器路径和专用资料目录」（同 douyin browser-lifecycle 的钩子模式）。
// 不打真网络、不启动真实浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowser, findBrowser } from '../lib/browser.mjs'

function harness({ mode = 'timeout' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-browser-'))
  const children = []
  const kills = []
  const b = createBrowser({
    profileDir: dir,
    browserPath: () => process.execPath,
    now: () => 1_000_000,
    platform: 'linux',
    stopWaitMs: 5,
    stderrWaitMs: 5,
    getPort: async () => 18888,
    wait: async () => {},
    log: { info: () => {}, warn: () => {} },
    spawnProcess: (_bin, _args, opts) => {
      assert.equal(opts.detached, true)
      const child = new EventEmitter()
      child.pid = 1000 + children.length
      child.stderr = new EventEmitter()
      child.unref = () => {}
      child.kill = (signal) => { kills.push(signal); child.emit('exit', 0, signal); return true }
      children.push(child)
      // 静默退出：进程起来马上 exit、stderr 一个字不写（同目录残留实例 / 清理搬盘弄坏安装）
      if (mode === 'silent-exit') queueMicrotask(() => child.emit('exit', 0, null))
      return child
    },
    getBrowserJson: async () => { throw new Error('连接被拒绝') },
    connect: () => { throw new Error('不该走到建立 CDP 连接') },
    killGroup: (pid, signal) => { kills.push(signal); children.find((c) => c.pid === pid)?.emit('exit', 0, signal) },
  })
  return { b, children, kills, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('静默退出要说清真实原因，不再一律怪「路径和资料目录」', async () => {
  const h = harness({ mode: 'silent-exit' })
  try {
    const r = await h.b.open('定时')
    assert.equal(r.ok, false)
    assert.match(r.message, /自己退出/)
    assert.match(r.message, /任务管理器|重装 Edge/)
    assert.doesNotMatch(r.message, /检查浏览器路径和专用资料目录/, '路径明明没问题，不该再怪路径')
  } finally {
    h.cleanup()
  }
})

test('启动超时要说「调试端口没开」，不怪路径', async () => {
  const h = harness({ mode: 'timeout' })
  try {
    const r = await h.b.open('定时')
    assert.equal(r.ok, false)
    assert.match(r.message, /调试端口/)
    assert.match(r.message, /30 秒内/)
    assert.doesNotMatch(r.message, /检查浏览器路径和专用资料目录/)
  } finally {
    h.cleanup()
  }
})

test('findBrowser：填的路径不存在就回退常见安装位置探测；哪儿都没有才报空', () => {
  const exists = (p) => p === 'C:\\fake\\msedge.exe' || p === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  assert.equal(findBrowser('C:\\fake\\msedge.exe', exists), 'C:\\fake\\msedge.exe', '填的路径真实存在就用填的')
  assert.equal(findBrowser('C:\\missing\\msedge.exe', exists), 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '填的不存在时回退自动探测')
  assert.equal(findBrowser('C:\\missing\\msedge.exe', () => false), '', '哪儿都没有返回空，由调用方报「路径不对」')
})
