/**
 * security.test.mjs —— 发布版的安全边界回归
 *
 * 这一版把虚拟机 / SSH 那条链路整个撤了：不再有「模型决定一条命令 → 在远端执行」的通路。
 * 这组测试就是防止它被无意加回来，同时盯住其它几条边界：
 *
 *   1. 源码里不存在任何外部命令执行入口（execFile / spawn / ssh）
 *   2. 默认关闭：装上不自己动，要主人手动打开
 *   3. 没有 SSH / 凭据类设置项（撤销后不应残留可配远端主机的入口）
 *   4. 决策解析对垃圾输入只返回 null，不抛异常、不把危险字符带进动作名
 *   5. 模型失败 / 超时一律降级，不把异常抛到调度层
 *   6. 密码类设置不会被写进日志
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import autonomy, { parseDecision } from '../index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'index.mjs'), 'utf8')
/** 去掉注释再扫，免得注释里提到 ssh 就误报 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('外部命令执行必须过 exec-guard 白名单', () => {
  // 这一版撤掉了 SSH，保留两种本机固定调用：adb 手机操作、node --check 校验自写模块。
  // 关键约束：每一处 execFile 之前都必须先调 checkExec()，且模型给的文本不能进参数。
  const guardCalls = (CODE.match(/checkExec\(/g) || []).length
  const execCalls = (CODE.match(/execFile\(/g) || []).length
  assert.ok(execCalls > 0, '应当还有受控的 execFile 调用')
  assert.ok(guardCalls >= execCalls, `每个 execFile 都要先过 checkExec（execFile ${execCalls} 处，checkExec ${guardCalls} 处）`)

  // 模型给的字段绝不能出现在 execFile 的参数里
  assert.equal(/execFile\([^)]*\b(detail|steps|action|why)\b/.test(CODE), false, '模型给的字段不该进 execFile')
  // 不该把模板字符串直接塞进 execFile
  assert.equal(/execFile\([^)]*\$\{/.test(CODE), false, '不该把模板字符串塞进 execFile')
  // 绝不能出现 ssh
  assert.equal(/\bssh\b/i.test(CODE), false, '不该有 ssh')
  // 白名单模块必须在，且被引用
  assert.ok(/from '\.\/lib\/exec-guard\.mjs'/.test(CODE), '应当从 lib/exec-guard.mjs 引入守卫')
  assert.ok(/assertNoModelText/.test(CODE), '应当引入 assertNoModelText')
})

test('源码里没有 SSH / 远端主机相关的实现', () => {
  for (const banned of ['ssh ', 'sshKey', 'vmHost', 'vmPort', 'vmUser', 'VM_DANGER', 'media/sf_share']) {
    assert.equal(CODE.includes(banned), false, `不该出现 ${banned}`)
  }
})

test('默认关闭：装上不会自己动', () => {
  assert.equal(autonomy.defaults.enabled, false, '发布版默认必须关闭')
})

test('设置里没有远端主机 / 私钥入口', () => {
  const keys = (autonomy.settings || []).map((s) => s.key)
  for (const bad of ['vmHost', 'vmPort', 'vmUser', 'sshKey']) {
    assert.equal(keys.includes(bad), false, `设置项不该有 ${bad}`)
  }
})

test('动作表里没有只能在远端落地的动作', () => {
  const text = (autonomy.settings || []).map((s) => `${s.label || ''}${s.hint || ''}`).join(' ')
  assert.equal(/虚拟机/.test(text), false, '设置说明里不该再提虚拟机')
})

test('parseDecision：垃圾输入只返回 null，不抛', () => {
  for (const bad of ['', '   ', 'null', '{}', '不是 JSON', '{"action":""}', '{"action":"idle"}', '```', '{"why":"只有理由"}']) {
    assert.equal(parseDecision(bad), null, `输入 ${JSON.stringify(bad)} 应判无效`)
  }
})

test('parseDecision：动作名被清洗成安全标识符', () => {
  const cases = [
    ['{"action":"rm -rf /"}', 'rm-rf'],
    ['{"action":"a;b|c&d"}', 'abcd'],
    ['{"action":"  整理目录  "}', '整理目录'],
    ['{"action":"<script>"}', 'script'],
  ]
  for (const [input, want] of cases) {
    const d = parseDecision(input)
    assert.ok(d, `应能解析：${input}`)
    assert.equal(d.action, want, `${input} → ${want}`)
    assert.equal(/[^\w\u4e00-\u9fa5-]/.test(d.action), false, '动作名只允许字母数字下划线中文短横线')
  }
})

test('parseDecision：超长文本不炸，字段被截断', () => {
  const long = 'x'.repeat(20000)
  const d = parseDecision(JSON.stringify({ action: 'draw', detail: long, why: long }))
  assert.ok(d)
  assert.ok(d.detail.length <= 1500, 'detail 应被截断')
  assert.ok(d.why.length <= 60, 'why 应被截断')
})

test('parseDecision：steps 最多 6 条，不再当作命令执行', () => {
  const steps = Array.from({ length: 12 }, (_, i) => `step ${i}`)
  const d = parseDecision(JSON.stringify({ action: 'newmod', steps }))
  assert.ok(d)
  assert.equal(d.steps.length, 6, 'steps 最多保留 6 条')
  // 关键：源码里没有任何地方把 steps 当命令跑
  assert.equal(/steps[\s\S]{0,80}(execFile|spawn|bash -c)/.test(CODE), false, 'steps 不该进命令执行')
})

test('模型调用失败时降级，不把异常抛出去', async () => {
  const logs = []
  const api = {
    // 模型彻底不可用
    dsh: {
      get() {
        throw new Error('llm 服务挂了')
      },
    },
    config: () => ({}),
    settings: () => ({ ...autonomy.defaults, enabled: true }),
    dataDir: () => mkdtempSync(join(tmpdir(), 'autonomy-sec-')),
    log: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    later: () => {},
    every: () => {},
    on: () => {},
    route: () => {},
    command: () => {},
    tool: () => {},
    defineTool: () => ({}),
    use: () => null,
    core: {},
  }
  const out = autonomy.setup(api)
  assert.ok(out, 'setup 应能返回')
  // 叫醒一次：模型挂了也必须返回结果对象，而不是抛
  const r = await out.wake({ manual: true }).catch((e) => ({ threw: String(e && e.message) }))
  assert.equal(r.threw, undefined, 'wake 不该抛异常')
  assert.ok(r && typeof r === 'object')
})

test('密码类设置不会进日志', () => {
  // phoneLock 是 password 类型：日志里不该出现它的值
  const pw = (autonomy.settings || []).filter((s) => s.type === 'password')
  assert.ok(pw.length > 0, '应当有 password 类型设置（手机锁屏密码）')
  // 源码里不该有把设置整体打成日志的地方
  assert.equal(/log\.[a-z]+\([^)]*JSON\.stringify\((api\.)?settings\(\)/.test(CODE), false, '不该整体打印设置')
  assert.equal(/log\.[a-z]+\([^)]*\.phoneLock/.test(CODE), false, '不该打印手机锁屏密码')
})
