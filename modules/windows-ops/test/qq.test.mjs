// qq.test.mjs —— windows-ops 的 QQ 原生共享/协助层测试
// 来源：aurabot 模块库 modules/windows-ops（MIT）。全部用注入的 fake ps，不打真 PowerShell、不动真 QQ。
// 覆盖：操作元数据风险等级、参数整理/夹范围、脚本生成（参数 base64、窗口识别、字面量 split）、
//       输出解释（成功/失败/窗口列表），以及和 createOps 的接线。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b64arg } from '../lib/ps.mjs'
import { createOps, OPS } from '../lib/ops.mjs'
import { QQ_OPS, qqScripts, prepareQq, interpretQq, pickQqTarget } from '../lib/qq.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-qq-'))

/** 造一个假的 ps：记录脚本，回复固定串/函数。 */
function fakePs(reply = '') {
  const calls = []
  return {
    calls,
    isWin: () => true,
    b64arg,
    run: async (script) => {
      calls.push(script)
      return typeof reply === 'function' ? reply(script) : reply
    },
  }
}

/** PowerShell 侧 Emit 的输出形态：压缩 JSON 再套一层 UTF-8 base64。 */
const qqOut = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

/** 从生成的脚本里抠出 $a 数组并解码。 */
function argvOf(script) {
  const m = script.match(/\$a=@\(([^)]*)\)/)
  if (!m) return []
  return (m[1].match(/'([^']*)'/g) || []).map((q) => Buffer.from(q.slice(1, -1), 'base64').toString('utf8'))
}

const PREFIX = "$ProgressPreference='SilentlyContinue'\n"
const ARGS = "function D([string]$b){ return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }\n$a=@('')"

// ---------- 元数据 ----------

test('QQ_OPS：共享是 safe，远程协助是 input（控制权交出去）', () => {
  assert.equal(QQ_OPS['qq.share'].danger, 'safe')
  assert.equal(QQ_OPS['qq.assist'].danger, 'input')
  assert.equal(QQ_OPS['qq.shareStop'].danger, 'safe')
  assert.equal(QQ_OPS['qq.windows'].danger, 'safe')
  // OPS 是合并后的总表，工具/安全闸门读的是它
  assert.equal(OPS['qq.share'].danger, 'safe')
  assert.equal(OPS['qq.assist'].danger, 'input')
})

// ---------- 目标好友解析 ----------

const FRIENDS = [
  { user_id: 123456789, nickname: '机器人', remark: '' },
  { user_id: 987654321, nickname: '主人', remark: '' },
  { user_id: 555666777, nickname: 'Alice', remark: '同事小A' },
  { user_id: 555666778, nickname: 'Alice', remark: '' },
  { user_id: 2113929217, nickname: '我的电脑', remark: '我的电脑' },
]

test('pickQqTarget：不指定 = 主人，用主人 QQ 号和昵称', () => {
  const r = pickQqTarget(FRIENDS, '', { botQQ: '123456789', ownerQQ: '987654321', ownerName: '主人' })
  assert.deepEqual(r, { ok: true, qq: '987654321', name: '主人' })
})

test('pickQqTarget：按 QQ 号指定好友，备注优先作为窗口显示名', () => {
  const r = pickQqTarget(FRIENDS, '555666777', { botQQ: '123456789', ownerQQ: '987654321' })
  assert.deepEqual(r, { ok: true, qq: '555666777', name: '同事小A' })
})

test('pickQqTarget：按备注或昵称指定；重名时报错并要求用 QQ 号', () => {
  assert.deepEqual(pickQqTarget(FRIENDS, '同事小A', { botQQ: '123456789' }), { ok: true, qq: '555666777', name: '同事小A' })
  const dup = pickQqTarget(FRIENDS, 'Alice', { botQQ: '123456789' })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /匹配到 2 个好友/)
})

test('pickQqTarget：机器人自己、陌生号、设备号都不能当目标', () => {
  assert.equal(pickQqTarget(FRIENDS, '123456789', { botQQ: '123456789' }).ok, false)
  assert.equal(pickQqTarget(FRIENDS, '111111111', { botQQ: '123456789' }).ok, false)
  assert.equal(pickQqTarget(FRIENDS, '我的电脑', { botQQ: '123456789' }).ok, false)
})

test('pickQqTarget：@ 前缀会被去掉，空列表也能清楚报错', () => {
  assert.deepEqual(pickQqTarget(FRIENDS, '@同事小A', { botQQ: '123456789' }), { ok: true, qq: '555666777', name: '同事小A' })
  const r = pickQqTarget([], '555666777', { botQQ: '123456789' })
  assert.equal(r.ok, false)
  assert.match(r.error, /好友列表里没有/)
})

// ---------- 参数整理 ----------

test('prepareQq：qq.windows 无参数', () => {
  assert.deepEqual(prepareQq('qq.windows', {}), { argv: [], summary: '' })
})

test('prepareQq：只给 botName 也能过；两个都空且 hwnd=0、botQQ 也空要抛错', () => {
  assert.deepEqual(prepareQq('qq.share', { botName: '机器人' }).argv, ['0', '机器人', '', '', '', '20'])
  assert.throws(() => prepareQq('qq.share', {}), /botQQ|botName|ownerName|hwnd/)
})

test('prepareQq：只给 botQQ 就按 QQ 号定位，summary 显示 QQ 号', () => {
  const r = prepareQq('qq.share', { botQQ: '123456789' })
  assert.deepEqual(r.argv, ['0', '', '', '123456789', '', '20'])
  assert.match(r.summary, /QQ 123456789/)
})

test('prepareQq：只给 hwnd 也能过，且 summary 显示句柄', () => {
  const r = prepareQq('qq.assist', { hwnd: 4265170 })
  assert.deepEqual(r.argv, ['4265170', '', '', '', ''])
  assert.match(r.summary, /#4265170/)
})

test('prepareQq：waitSec 夹到 5~60，默认 20', () => {
  assert.equal(prepareQq('qq.share', { botName: 'x', waitSec: 1 }).argv[5], '5')
  assert.equal(prepareQq('qq.share', { botName: 'x', waitSec: 999 }).argv[5], '60')
  assert.equal(prepareQq('qq.share', { botName: 'x' }).argv[5], '20')
})

test('prepareQq：targetQQ 进 argv 第 5 位，summary 也带目标 QQ', () => {
  const r = prepareQq('qq.assist', { botQQ: '123456789', ownerName: '同事小A', targetQQ: '555666777' })
  assert.deepEqual(r.argv, ['0', '', '同事小A', '123456789', '555666777'])
  assert.match(r.summary, /目标 QQ 555666777/)
})

test('prepareQq：未知操作抛错', () => {
  assert.throws(() => prepareQq('qq.nope', {}), /未知操作/)
})

// ---------- 脚本生成 ----------

test('qqScripts：五段脚本都带 base64 参数数组，且用户输入不直接拼进脚本', () => {
  const scripts = qqScripts({ PREFIX, ARGS })
  assert.deepEqual(Object.keys(scripts).sort(), ['qq.assist', 'qq.assistStop', 'qq.share', 'qq.shareStop', 'qq.windows'])
  for (const [op, s] of Object.entries(scripts)) {
    assert.match(s, /\$a=@\(/, `${op} 缺参数数组`)
    assert.doesNotMatch(s, /\$a=@\('[^']*[;`]/, `${op} 参数疑似直接拼串`)
  }
})

test('qqScripts：窗口行按字面量 | 拆分（防止 JS 模板把 \\| 吃掉后变成正则空匹配）', () => {
  const s = qqScripts({ PREFIX, ARGS })['qq.windows']
  assert.match(s, /\.Split\('\|'\)/)
  assert.doesNotMatch(s, /-split '\|'/)
})

test('qqScripts：按机器人 QQ 号锁定窗口（账号分区 WAL → RestartManager → PID）', () => {
  const s = qqScripts({ PREFIX, ARGS })['qq.share']
  for (const needle of ['AccountPids', 'qqnt_', 'DIPS-wal', 'SharedStorage-wal', 'RmGetList']) {
    assert.ok(s.includes(needle), `QQ 号识别脚本缺 ${needle}`)
  }
  // 账号识别必须在昵称兜底之前：SelectWin 里先查 botQQ，再查 botName
  const account = s.indexOf('AccountPids($botQQ)')
  const nick = s.indexOf('$w.own -eq $botName')
  assert.ok(account >= 0 && nick > account, '应按 QQ 号优先、昵称兜底')
})

test('qqScripts：qq.windows 按账号分区标注窗口，且过滤 4 位内部槽位', () => {
  const s = qqScripts({ PREFIX, ARGS })['qq.windows']
  assert.ok(s.includes('AccountMap'))
  assert.ok(s.includes('qq.Length < 5'))
})

test('qqScripts：共享流程包含「屏幕共享」按钮、选择框、桌面、确定、停止共享', () => {
  const s = qqScripts({ PREFIX, ARGS })['qq.share']
  for (const needle of ['屏幕共享', '选择你想共享的窗口', '桌面', '确定', '停止共享', 'FindStopBtn']) {
    assert.ok(s.includes(needle), `共享脚本缺 ${needle}`)
  }
})

test('qqScripts：远程协助菜单在同一段脚本里完成（arrow → 菜单项）', () => {
  const s = qqScripts({ PREFIX, ARGS })['qq.assist']
  for (const needle of ['远程协助', 'arrow', '邀请对方远程协助', '你正在邀请']) {
    assert.ok(s.includes(needle), `协助脚本缺 ${needle}`)
  }
  const arrow = s.indexOf('$arrow=ByClass $remote')
  const invite = s.indexOf("$invite=ByName $root '邀请对方远程协助'")
  assert.ok(arrow >= 0 && invite > arrow, '菜单项必须在 arrow 之后、同一段脚本内')
})

// ---------- 输出解释 ----------

test('interpretQq：成功消息原样返回', () => {
  const r = interpretQq('qq.share', qqOut({ ok: true, message: '已通过机器人 QQ 客户端发起屏幕共享' }))
  assert.equal(r.ok, true)
  assert.match(r.message, /已通过机器人 QQ/)
})

test('interpretQq：失败消息原样返回，不 throw', () => {
  const r = interpretQq('qq.share', qqOut({ ok: false, message: '共享选择框一直停在加载状态' }))
  assert.equal(r.ok, false)
  assert.match(r.message, /加载状态/)
})

test('interpretQq：窗口列表拼成可读多行，单元素也当数组', () => {
  const r = interpretQq('qq.windows', qqOut({ ok: true, windows: { hwnd: 4265170, pid: 50872, acct: '123456789', own: '机器人', header: '主人', x: 894, y: 306, w: 2048, h: 1456 } }))
  assert.equal(r.ok, true)
  assert.equal(r.data.length, 1)
  assert.match(r.message, /#4265170/)
  assert.match(r.message, /账号=123456789/)
  assert.match(r.message, /机器人/)
})

test('interpretQq：空窗口列表给明确说明', () => {
  const r = interpretQq('qq.windows', qqOut({ ok: true, windows: [] }))
  assert.equal(r.ok, true)
  assert.match(r.message, /没有找到机器人 QQ 窗口/)
})

test('interpretQq：非 JSON/base64 输出返回解析失败，不 throw', () => {
  const r = interpretQq('qq.windows', 'not-json')
  assert.equal(r.ok, false)
  assert.match(r.message, /解析失败/)
})

// ---------- 与 createOps 接线 ----------

test('createOps.run：qq.windows 走脚本并交给 interpretQq', async () => {
  const ps = fakePs(qqOut({ ok: true, windows: [{ hwnd: 4265170, pid: 50872, own: '机器人', header: '主人' }] }))
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('qq.windows', {})
  assert.equal(r.ok, true)
  assert.equal(r.data[0].own, '机器人')
  assert.equal(ps.calls.length, 1)
})

test('createOps.run：qq.share 的 argv 按 hwnd/botName/ownerName/botQQ/targetQQ/waitSec 顺序进脚本', async () => {
  const ps = fakePs(qqOut({ ok: false, message: '未找到窗口' }))
  const ops = createOps({ ps, dataDir: DATA })
  await ops.run('qq.share', { hwnd: 4265170, botName: '机器人', ownerName: '同事小A', botQQ: '123456789', targetQQ: '555666777', waitSec: 15 })
  const argv = argvOf(ps.calls[0])
  assert.deepEqual(argv, ['4265170', '机器人', '同事小A', '123456789', '555666777', '15'])
})

test('createOps.run：qq.share 失败不触发重试（动作类防重复点按钮），有结构化输出就按失败返回', async () => {
  let n = 0
  const ps = {
    isWin: () => true,
    b64arg,
    run: async () => {
      n += 1
      const err = new Error('PowerShell 执行失败')
      err.stdout = qqOut({ ok: false, message: '共享选择框一直停在加载状态' })
      throw err
    },
  }
  const ops = createOps({ ps, dataDir: DATA })
  const r = await ops.run('qq.share', { botName: '机器人', ownerName: '主人' })
  assert.equal(r.ok, false)
  assert.match(r.message, /加载状态/)
  assert.equal(n, 1)
})
