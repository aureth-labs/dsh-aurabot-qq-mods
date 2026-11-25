/**
 * trigger.test.mjs —— 主人触发 / 默认关闭 / 超时降级 / 凭据保护
 *
 * 复审点名要的四项里的三样，加上凭据不进日志。
 * 全部用假 api 跑，不碰真模型、不碰真手机。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import autonomy from '../index.mjs'

/** 造一个够模块 setup 用的假 api；返回控制器，方便断言和注入故障。 */
function makeApi(over = {}) {
  const logs = []
  const commands = {}
  const routes = {}
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-trigger-'))
  let settings = { ...autonomy.defaults, ...(over.settings || {}) }
  const api = {
    settings: () => settings,
    saveSettings: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    },
    config: () => ({}),
    dataDir: () => dir,
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
    },
    later: () => {},
    every: () => {},
    on: () => {},
    route: (p, fn) => {
      routes[p] = fn
    },
    command: (def) => {
      commands[def.name] = def
    },
    tool: () => {},
    defineTool: (t) => t,
    use: () => null,
    isOwner: (id) => over.owner === id,
    dsh: over.dsh || null,
    core: {},
    ...(over.api || {}),
  }
  return { api, logs, commands, routes, dir, getSettings: () => settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('默认关闭：装上空配置时 enabled 是 false', () => {
  assert.equal(autonomy.defaults.enabled, false)
  assert.equal(autonomy.defaults.enabled === true, false, '绝不能默认开着')
})

test('主人触发：非主人发 /自主 被拒，且不动设置', () => {
  const c = makeApi({ owner: '3205277184', settings: { enabled: false } })
  try {
    autonomy.setup(c.api)
    const cmd = c.commands['自主']
    assert.ok(cmd, '应当注册了 /自主')
    // 非主人
    const out = cmd.run('开', { userId: '999999' })
    assert.equal(out, '', '非主人应拿到空回复（不暴露任何状态）')
    assert.equal(c.getSettings().enabled, false, '设置不能被改')
    assert.equal(
      c.logs.some(([lvl]) => lvl === 'warn'),
      true,
      '应当在日志里留一笔拒绝记录',
    )
    // 缺 userId 也拒
    assert.equal(cmd.run('开', {}), '')
    assert.equal(c.getSettings().enabled, false)
  } finally {
    c.cleanup()
  }
})

test('主人触发：主人发 /自主 生效', () => {
  const c = makeApi({ owner: '3205277184', settings: { enabled: false } })
  try {
    autonomy.setup(c.api)
    const cmd = c.commands['自主']
    const out = cmd.run('开', { userId: '3205277184' })
    assert.match(out, /开了|好/)
    assert.equal(c.getSettings().enabled, true, '主人应当能开')
    const off = cmd.run('关', { userId: '3205277184' })
    assert.match(off, /停|关/)
    assert.equal(c.getSettings().enabled, false)
  } finally {
    c.cleanup()
  }
})

test('超时降级：模型 hang 住时真取消、不抛、及时返回', async () => {
  // 一个永不产出、但会响应 abort 的流：模拟模型服务卡死。
  // 关键断言：abort 之后流必须收到信号停下，而不是留在后台挂 30 秒。
  let aborted = false
  let finished = false
  const hang = {
    llm: {
      async *stream(params) {
        try {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 30_000)
            if (params && params.signal) {
              params.signal.addEventListener('abort', () => {
                clearTimeout(t)
                aborted = true
                const err = new Error('aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }
          })
          finished = true
          yield { type: 'text-delta', text: 'never' }
        } catch (error) {
          throw error
        }
      },
    },
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : null),
  }
  // 超时压到 1 秒、重试压到 2 次，整轮几秒内必须结束；awakeFrom/awakeTo 固定为全天（CI 是 UTC 时区，不固定会撞夜间静默短路，2026-11-10 CI 实测）
  const c = makeApi({ owner: '3205277184', settings: { enabled: true, awakeFrom: 0, awakeTo: 24, askTimeoutSec: 1, grants: { model: true, phone: false } }, dsh: hang })
  try {
    const out = autonomy.setup(c.api)
    const started = Date.now()
    const r = await Promise.race([
      out.wake({ manual: true }).catch((e) => ({ threw: String(e && e.message) })),
      new Promise((res) => setTimeout(() => res({ timedOut: true }), 20_000)),
    ])
    const spent = Date.now() - started
    assert.equal(r.threw, undefined, '不该把异常抛给调用方')
    assert.equal(r.timedOut, undefined, '不该把整轮卡死')
    assert.ok(spent < 15_000, `应当及时返回，实际 ${spent}ms`)
    assert.equal(aborted, true, '超时必须真的 abort 底层流')
    assert.equal(finished, false, 'aborted 之后不该继续跑到结束')
    assert.equal(
      c.logs.some(([lvl, msg]) => lvl === 'warn' && /超时/.test(msg)),
      true,
      '应当把超时写进日志',
    )
  } finally {
    c.cleanup()
  }
})

test('模型直接抛错时降级，不污染状态文件', async () => {
  const boom = {
    llm: {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('上游 500')
      },
    },
    get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : null),
  }
  const c = makeApi({ owner: '3205277184', settings: { enabled: true, awakeFrom: 0, awakeTo: 24, grants: { model: true, phone: false } }, dsh: boom })
  try {
    const out = autonomy.setup(c.api)
    const r = await out.wake({ manual: true }).catch((e) => ({ threw: String(e && e.message) }))
    assert.equal(r.threw, undefined, '不该抛')
    // 状态文件要么没写，要么是合法 JSON
    const files = readdirSync(c.dir)
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      JSON.parse(readFileSync(join(c.dir, f), 'utf8'))
    }
  } finally {
    c.cleanup()
  }
})

test('凭据保护：手机锁屏密码不写进日志、不写进活动流水', () => {
  const SECRET = 'zQ7-unique-secret-7761'
  const c = makeApi({ owner: '3205277184', settings: { enabled: true, phoneLock: SECRET } })
  try {
    autonomy.setup(c.api)
    // 把能触发的命令都跑一遍（都是读状态/改设置，不碰手机）
    for (const arg of ['状态', '开', '关', '30']) c.commands['自主'].run(arg, { userId: '3205277184' })
    const all = c.logs.map(([, msg]) => msg).join('\n')
    assert.equal(all.includes(SECRET), false, '日志里不该出现锁屏密码')
    // 数据目录里的文件同样不该有
    for (const f of readdirSync(c.dir)) {
      const p = join(c.dir, f)
      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch (e) {
        continue
      }
      assert.equal(text.includes(SECRET), false, `${f} 里不该出现锁屏密码`)
    }
  } finally {
    c.cleanup()
  }
})

test('凭据保护：password 类型的设置项存在，且源码不打印设置对象', () => {
  const pw = (autonomy.settings || []).filter((s) => s.type === 'password')
  assert.ok(pw.length > 0, '应当有 password 类型（手机锁屏密码）')
  const src = readFileSync(join(process.cwd(), 'modules/autonomy/index.mjs'), 'utf8')
  assert.equal(/JSON\.stringify\(\s*api\.settings\(\)\s*\)/.test(src), false, '不该整体打印设置')
  assert.equal(/log\.[a-z]+\([^)]*phoneLock/.test(src), false, '不该打印锁屏密码')
})
