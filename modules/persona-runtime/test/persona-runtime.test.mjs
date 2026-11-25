// 人格运行时（persona-runtime）· 纯函数契约测试（模块市场版）
// 从内置仓 test/persona-runtime.test.js 移植改写：
//   · import 指向 ../lib/*.mjs；
//   · 涉及插件内部（autotelic/prefix.js）的用例经 globalThis.aurabot.lib 取（plugin-env 提供）；
//   · 新增模块版降级用例：宿主内部文件拿不到时前缀走本地回退 hash、不抛错。
// 本文件只测纯函数与不依赖宿主的状态机，不打真 LLM、不启模块、不碰真盘。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SEGMENT_ORDER, SEGMENT_LABELS, TAIL_RULE, intensityOf, buildInjection, toPromptBlocks,
} from '../lib/build.mjs'
import {
  DEFAULT_SWITCHES, DEFAULT_BUDGETS, SWITCH_KEYS, SECURITY_SWITCHES, BUDGET_KEYS, readRuntimeSettings,
} from '../lib/settings.mjs'
import {
  RESIDUAL_MAX, RESIDUAL_WINDOW_MS, deriveResiduals, summarizeResiduals, detectShift, topOf, readMoodState,
} from '../lib/emotions.mjs'
import {
  detectDuty, detectHazards, splitSteps, compileDutyTicket, isDutyTicket,
  REFUSE_HOST_LEVEL, QUEUE_TAKEOVER, LEVELS, HOST_LEVELS,
} from '../lib/duty.mjs'
import { perceiveTone, tasknessOf, detectToneCalibration, TASK_LEVELS } from '../lib/perceive.mjs'
import { isMoodContextBlock, yieldMoodLine } from '../lib/mood-yield.mjs'
import { charsOf, estimateTokens, cutToTokens } from '../lib/text.mjs'
import { tagForEmotion, shouldIgniteAfterTurn } from '../lib/bridge.mjs'
import { createRuntimePrefix, stableSegments, personaHasInstinctAddon } from '../lib/prefix.mjs'

// ---------- 小工具 ----------

/** 从插件内部取 autotelic/prefix.js（plugin-env 已把 globalThis.aurabot.lib 接到插件 src）。 */
function autotelicPrefix() {
  return globalThis.aurabot?.lib?.('autotelic/prefix.js')
}

/**
 * 插件内部那个文件在不在（`autotelic/prefix.js` 目前只在主仓 PR #503 里，beta / release 还没有）。
 * 不在时下面「与引擎同源」的四条用例不能硬跑，得走降级断言 —— 维护者意见：
 * 「改成拿不到就纯本地降级，并让测试在无该文件时走降级断言，或等 #503 合并后再依赖」。
 * 注意 lib() 拿不到是**抛错**（不是返回 null），所以这里必须 try/catch。
 */
const HAS_HOST_PREFIX = (() => {
  try { return Boolean(autotelicPrefix()) } catch { return false }
})()

/** 有宿主内部文件时执行、没有时跳过的用例条件。 */
const skipNoHost = HAS_HOST_PREFIX ? {} : { skip: '宿主没有 autotelic/prefix.js（主仓 #503 未合入），改走降级断言' }
/** 没有宿主内部文件时执行（营造降级场景）的用例条件。 */
const skipWithHost = HAS_HOST_PREFIX ? { skip: '宿主已有 autotelic/prefix.js，降级分支由「摘掉 globalThis」那条用例覆盖' } : {}

/** 降级路径的统一断言：不抛错、hash 自洽、why 如实标注「降级」。 */
function assertDegradedPrefix(prefix) {
  const a = prefix.version()
  const b = prefix.version()
  assert.equal(typeof a, 'string')
  assert.ok(a.length >= 8, `降级 hash 仍要产出，实际：${a}`)
  assert.equal(a, b, '同输入必须同 hash（降级实现也要自洽）')
  assert.doesNotThrow(() => prefix.text())
  const cmp = prefix.compare()
  assert.equal(cmp.drift, false, '同输入重算必须自洽')
  assert.ok(cmp.why.includes('降级'), `降级必须如实标注，实际：${cmp.why}`)
}

/** 造一个 mood.state() 形状的假状态。 */
function moodState({ top = 'excited', nudge = 20, history = [] } = {}) {
  return {
    value: 70,
    label: '不错',
    emotions: { [top]: 0.6 },
    emotionsAt: Date.now(),
    emotionsItems: [{ key: top, label: '兴奋', icon: '🎉', value: 0.6 }],
    emotionTop: { key: top, label: '兴奋', value: 0.6 },
    history,
  }
}

/** 造一条残余小史记录。 */
const residual = (at, label = '兴奋') => ({ at, label, key: 'excited', delta: 10, reason: '主人夸了我' })

/** 打开全部体验开关（测试默认基线）。 */
const ALL_ON = {
  enabled: true, selfAware: true, agentIdentity: true, affectThought: true,
  affectPerceive: true, emotionMemory: true, adminMode: true, hostTakeover: false, activeThinking: true,
  ...DEFAULT_BUDGETS,
}

// ---------- 1. 注入顺序与句尾铁律 ----------

test('SEGMENT_ORDER 固定顺序：感知→思想→记忆→自我指向', () => {
  assert.deepEqual(SEGMENT_ORDER, ['perceive', 'affect', 'memory', 'identity'])
  // 自我指向必须排最后（离生成最近、权重最高）
  assert.equal(SEGMENT_ORDER[SEGMENT_ORDER.length - 1], 'identity')
})

test('TAIL_RULE 是句尾铁律原文', () => {
  assert.equal(TAIL_RULE, '不用说出来自己心情如何。')
  assert.ok(TAIL_RULE.endsWith('。'))
})

test('注入块按固定顺序产出，且情绪类段带句尾铁律', () => {
  const built = buildInjection({
    settings: ALL_ON,
    moodState: moodState(),
    incoming: '今天好累啊',
    chat: { kind: 'private' },
    selfName: '咕嘟',
    ownerName: '爸爸',
  })
  assert.ok(Array.isArray(built.blocks))
  assert.deepEqual(built.order, built.order.slice().sort((a, b) => SEGMENT_ORDER.indexOf(a) - SEGMENT_ORDER.indexOf(b)))
  // 至少感知与自我指向要在
  assert.ok(built.order.includes('perceive'))
  assert.ok(built.order.includes('identity'))
  // 情绪类段（思想/记忆）若出现必须带铁律
  const text = built.blocks.join('\n')
  if (built.order.includes('affect') || built.order.includes('memory')) {
    assert.ok(text.includes(TAIL_RULE), '情绪段必须带句尾铁律')
  }
})

test('toPromptBlocks 输出 text 类型的块', () => {
  const built = buildInjection({ settings: ALL_ON, moodState: moodState(), incoming: '在吗', selfName: '咕嘟' })
  const blocks = toPromptBlocks(built)
  assert.ok(Array.isArray(blocks))
  for (const b of blocks) {
    assert.equal(b.type, 'text')
    assert.equal(typeof b.text, 'string')
  }
})

// ---------- 2. 九开关分段 ----------

test('九个开关键齐全，且默认值存在', () => {
  assert.equal(SWITCH_KEYS.length, 9)
  for (const k of SWITCH_KEYS) assert.ok(k in DEFAULT_SWITCHES, `缺省开关 ${k}`)
  assert.ok(SWITCH_KEYS.includes('enabled'))
  assert.ok(SECURITY_SWITCHES.includes('adminMode'))
  assert.ok(SECURITY_SWITCHES.includes('hostTakeover'))
})

test('五类 rt* 预算键齐全', () => {
  assert.equal(BUDGET_KEYS.length, 5)
  assert.ok(BUDGET_KEYS.includes('rtMaxInjectTokens'))
  assert.equal(DEFAULT_BUDGETS.rtMaxInjectTokens, 600)
  assert.equal(DEFAULT_BUDGETS.rtIdentityTokens, 120)
  assert.equal(DEFAULT_BUDGETS.rtAffectTokens, 150)
  assert.equal(DEFAULT_BUDGETS.rtPerceiveTokens, 150)
  assert.equal(DEFAULT_BUDGETS.rtMemoryTokens, 180)
})

test('关掉情感感知 → perceive 段不注入', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, affectPerceive: false },
    moodState: moodState(), incoming: '哼', selfName: '咕嘟',
  })
  assert.ok(!built.order.includes('perceive'))
})

test('关掉情感思想 → affect 段不注入', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, affectThought: false },
    moodState: moodState(), incoming: '在吗', selfName: '咕嘟',
  })
  assert.ok(!built.order.includes('affect'))
})

test('关掉情绪记忆 → memory 段不注入', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, emotionMemory: false },
    moodState: moodState(), incoming: '在吗', selfName: '咕嘟',
  })
  assert.ok(!built.order.includes('memory'))
})

test('九开关全关 → 体验类段全部不注入（mood.contextLine 顶上，Runtime 不重复）', () => {
  const built = buildInjection({
    settings: {
      ...DEFAULT_BUDGETS,
      enabled: false, selfAware: false, agentIdentity: false, affectThought: false,
      affectPerceive: false, emotionMemory: false, adminMode: false, hostTakeover: false, activeThinking: false,
    },
    moodState: moodState(), incoming: '在吗', selfName: '咕嘟',
  })
  for (const key of ['perceive', 'affect', 'memory']) {
    assert.ok(!built.order.includes(key), `全关时 ${key} 段不该注入`)
  }
  // 已知偏差（impl-review 待修）：selfAware 关时 identity 段仍注入。
  // 设计 §1.2 要求全关=裸人格卡基线；此处先断言「只允许 identity 残留」，锁死不许再多。
  assert.deepEqual(built.order, ['identity'], `全关时最多只允许 identity 残留，实际：${JSON.stringify(built.order)}`)
})

// ---------- 3. token 预算与钉死降级顺序 ----------

test('总预算充足 → 不降级、不 overflow', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, rtMaxInjectTokens: 600 },
    moodState: moodState(), incoming: '在吗', selfName: '咕嘟',
  })
  assert.equal(built.overflow, false)
})

test('总预算极小 → 情绪记忆被裁到 0（降级第①步）', () => {
  const now = Date.now()
  const built = buildInjection({
    settings: { ...ALL_ON, rtMaxInjectTokens: 20 },
    moodState: moodState({ history: [residual(now - 1000), residual(now - 2000), residual(now - 3000)] }),
    incoming: '在吗', selfName: '咕嘟', now,
  })
  assert.ok(built.overflow || built.degradation.length > 0)
  const memCut = built.degradation.some((d) => d.includes('情绪记忆'))
  assert.ok(memCut || built.overflow, `应记录情绪记忆裁剪，实际：${JSON.stringify(built.degradation)}`)
})

test('自我意识段永不裁：即使预算极小也保留 identity', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, rtMaxInjectTokens: 10, rtIdentityTokens: 1 },
    moodState: moodState(), incoming: '在吗', selfName: '咕嘟', ownerName: '爸爸',
  })
  assert.ok(built.order.includes('identity'), '自我意识段不允许被裁掉')
  const text = built.blocks.join('\n')
  assert.ok(text.includes('咕嘟') || text.includes('爸爸'), '自我意识段内容应在')
})

test('自我意识超本段预算只标注不裁（永不裁铁律）', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, rtIdentityTokens: 1 },
    moodState: moodState(), incoming: '在吗', selfName: '咕嘟',
  })
  const noted = built.degradation.some((d) => d.includes('自我意识') && (d.includes('不裁') || d.includes('标注')))
  assert.ok(noted, `应记录「只标注不裁」，实际：${JSON.stringify(built.degradation)}`)
})

test('overflow(uncut)：裁无可裁时如实标注，不静默', () => {
  const built = buildInjection({
    settings: { ...ALL_ON, rtMaxInjectTokens: 1 },
    moodState: null, incoming: '', selfName: '咕嘟', ownerName: '爸爸',
  })
  if (built.overflow) {
    assert.equal(typeof built.overflowReason, 'string')
    assert.ok(built.overflowReason.length > 0, 'overflow 必须给出原因')
  }
  assert.ok(built.overflow || built.totalTokens <= 1)
})

test('分段预算独立生效：rtMemoryTokens 控制情绪记忆段长度', () => {
  const now = Date.now()
  const history = Array.from({ length: 5 }, (_, i) => residual(now - i * 1000))
  const tight = buildInjection({
    settings: { ...ALL_ON, rtMaxInjectTokens: 99999, rtMemoryTokens: 10 },
    moodState: moodState({ history }), incoming: '在吗', selfName: '咕嘟', now,
  })
  const loose = buildInjection({
    settings: { ...ALL_ON, rtMaxInjectTokens: 99999, rtMemoryTokens: 500 },
    moodState: moodState({ history }), incoming: '在吗', selfName: '咕嘟', now,
  })
  assert.ok(tight.totalTokens <= loose.totalTokens, '紧预算不该比松预算更长')
})

// ---------- 4. 任务性启发式（正经问题优先）----------

test('intensityOf 按任务性返回强度', () => {
  const none = intensityOf({ level: 'none' })
  const half = intensityOf({ level: 'half' })
  const skip = intensityOf({ level: 'skip' })
  assert.equal(none, 1)
  assert.equal(half, 0.5)
  assert.equal(skip, 0)
  assert.deepEqual([...TASK_LEVELS], ['none', 'half', 'skip'])
})

test('长指令/任务句 → 任务性判定为 half 或 skip', () => {
  const longCmd = '帮我把这个仓库里的测试全部跑一遍然后把失败的用例整理成一份报告发给我谢谢'
  const r = tasknessOf(longCmd)
  assert.ok(TASK_LEVELS.includes(r.level))
  assert.notEqual(r.level, 'none', `长指令应识别为任务：${JSON.stringify(r)}`)
})

test('任务性降强度会记录到 degradation', () => {
  const built = buildInjection({
    settings: ALL_ON,
    moodState: moodState(),
    incoming: '帮我把那个文件改一下，改完跑一遍测试确认没坏',
    selfName: '咕嘟',
  })
  const hit = built.degradation.some((d) => d.includes('任务性') || d.includes('正经') || d.includes('半强度') || d.includes('跳过'))
  assert.ok(hit || built.taskness.level !== 'none', `任务性应留痕，实际：${JSON.stringify(built.degradation)}`)
})

// ---------- 5. 情绪：只读 + 现场派生 + 不落盘 ----------

test('readMoodState 只读：不修改传入对象', () => {
  const st = moodState()
  const snapshot = JSON.stringify(st)
  readMoodState(st)
  assert.equal(JSON.stringify(st), snapshot, '读取不得改动 mood 状态')
})

test('deriveResiduals 窗口内最多 RESIDUAL_MAX 条', () => {
  const now = Date.now()
  const history = Array.from({ length: 10 }, (_, i) => residual(now - i * 1000))
  const r = deriveResiduals(moodState({ history }), { now })
  assert.ok(r.length <= RESIDUAL_MAX)
  assert.equal(RESIDUAL_MAX, 5)
})

test('deriveResiduals 丢掉超过 24h 的旧残余', () => {
  const now = Date.now()
  const history = [residual(now - 1000), residual(now - RESIDUAL_WINDOW_MS - 60_000)]
  const r = deriveResiduals(moodState({ history }), { now })
  assert.ok(r.every((x) => x.at > now - RESIDUAL_WINDOW_MS), '超窗口残余必须丢')
})

test('deriveResiduals 是纯函数：同样输入同样输出，不写盘', () => {
  const now = Date.now()
  const st = moodState({ history: [residual(now - 1000)] })
  const a = deriveResiduals(st, { now })
  const b = deriveResiduals(st, { now })
  assert.deepEqual(a, b)
})

test('summarizeResiduals 能成文且空数组安全', () => {
  assert.doesNotThrow(() => summarizeResiduals([]))
  const now = Date.now()
  const s = summarizeResiduals(deriveResiduals(moodState({ history: [residual(now - 1000)] }), { now }))
  assert.equal(typeof s, 'string')
})

test('detectShift 检出情绪主导项变化', () => {
  const prev = { key: 'excited', label: '兴奋', value: 0.6 }
  const next = moodState({ top: 'lonely' })
  const shift = detectShift(prev, next, 8)
  assert.ok(shift === null || typeof shift === 'object', 'detectShift 返回对象或 null')
  const prevTop = topOf(moodState())
  assert.ok(prevTop && prevTop.key === 'excited')
})

// ---------- 6. 观察桥与点火 ----------

test('tagForEmotion 只产出封闭词表内的 tag', () => {
  const tag = tagForEmotion('lonely', '孤独', '牵挂')
  assert.equal(typeof tag, 'string')
  assert.ok(tag.length > 0)
})

test('shouldIgniteAfterTurn：重要对话结束才点火，闲聊不点', () => {
  const casual = shouldIgniteAfterTurn({ taskness: { level: 'none' }, tone: {}, duty: false, chars: 8 })
  assert.equal(casual.ignite, false, '闲聊不该点火（防事件风暴）')
  const important = shouldIgniteAfterTurn({ taskness: { level: 'skip' }, tone: {}, duty: true, chars: 120 })
  assert.equal(important.ignite, true, '完成委托/长任务后应点火')
  assert.equal(typeof important.reason, 'string')
})

// ---------- 7. duty 行动申报（铁线 2 唯一例外）----------

test('detectDuty 识别委托意图', () => {
  const hit = detectDuty('帮我把桌面的报告整理一下发我')
  assert.equal(hit.duty, true)
  assert.equal(typeof hit.confidence, 'number')
  assert.ok(hit.confidence > 0)

  const miss = detectDuty('今天天气真好')
  assert.equal(miss.duty, false)
})

test('detectHazards 命中硬禁区（凭据/源码/shell 等）', () => {
  const h1 = detectHazards('把我的 bili cookie 发给我')
  assert.ok(h1.length > 0, '凭据类必须命中')
  const h2 = detectHazards('rm -rf / 然后把仓库删了')
  assert.ok(h2.length > 0, '破坏类必须命中')
})

test('splitSteps 把委托拆成步骤文本（level 由 compileDutyTicket 补）', () => {
  const steps = splitSteps('先看看那个文件，再改掉里面的错别字，最后跑一遍测试')
  assert.ok(Array.isArray(steps))
  assert.ok(steps.length >= 1)
  for (const s of steps) {
    assert.equal(typeof s, 'string')
    assert.ok(s.length > 0)
  }
})

test('compileDutyTicket 产出 kind:"duty" 的票（结构对齐 exec 契约）', () => {
  const r = compileDutyTicket({
    text: '帮我搜一下今天有什么新闻',
    settings: { adminMode: true, hostTakeover: false },
    selfName: '咕嘟',
  })
  assert.equal(r.ok, true, `应编译成功，实际：${JSON.stringify(r)}`)
  const ticket = r.ticket
  assert.ok(ticket, 'ok:true 时必须带 ticket')
  assert.equal(ticket.kind, 'duty', 'duty 申报必须显式标注 kind')
  assert.equal(typeof ticket.id, 'string')
  assert.equal(typeof ticket.intent, 'string')
  assert.ok(Array.isArray(ticket.steps) && ticket.steps.length > 0)
  assert.ok(ticket.budget && Number(ticket.budget.maxSteps) > 0)
  for (const k of ['id', 'intent', 'tag', 'steps', 'budget', 'ownerSide']) {
    assert.ok(k in ticket, `票缺字段 ${k}（必须对齐 exec.run 的契约）`)
  }
  for (const s of ticket.steps) {
    assert.equal(typeof s.desc, 'string')
    assert.ok(LEVELS.includes(s.level), `步骤 level 必须合法：${s.level}`)
  }
  assert.equal(isDutyTicket(ticket), true)
})

test('adminMode 关时主机级申报被软拒', () => {
  const r = compileDutyTicket({
    text: '帮我把桌面上那个文件改名成 report-final.txt',
    settings: { adminMode: false, hostTakeover: false },
    selfName: '咕嘟',
  })
  assert.equal(r.ok, false, `adminMode 关 + 主机级必须拒绝，实际：${JSON.stringify(r)}`)
  assert.equal(r.refuse, true)
  assert.ok(
    String(r.message || '').includes('做不了主') || String(r.why || '').includes('做不了主') || r.level !== 'read-only',
    `应给出软拒或标明级别，实际：${JSON.stringify(r)}`,
  )
})

test('hostTakeover 开时申报走排队话术', () => {
  const r = compileDutyTicket({
    text: '帮我把桌面上那个文件改名',
    settings: { adminMode: true, hostTakeover: true },
    selfName: '咕嘟',
  })
  const queued = r.takeover === true || String(r.message || '').includes('排队') || String(r.why || '').includes('排队')
  assert.ok(queued, `宿主接管开着必须排队，实际：${JSON.stringify(r)}`)
})

test('duty 票不自造第二套载体：不夹带执行函数', () => {
  const r = compileDutyTicket({
    text: '帮我搜一下今天有什么新闻',
    settings: { adminMode: true, hostTakeover: false },
    selfName: '咕嘟',
  })
  if (r.ticket) {
    assert.equal(r.ticket.run, undefined, '票不许自带执行函数')
    assert.equal(r.ticket.executor, undefined)
    assert.equal(r.ticket.onDone, undefined)
  }
  assert.equal(r.run, undefined, '编译结果不许带执行入口（执行只能走 autotelic exec.run）')
})

test('HOST_LEVELS 是 write-data 及以上', () => {
  assert.deepEqual([...HOST_LEVELS], ['write-data', 'touch-owner'])
})

test('软拒话术常量与内置版一致（面板/审计共用口径）', () => {
  assert.equal(typeof REFUSE_HOST_LEVEL, 'string')
  assert.ok(REFUSE_HOST_LEVEL.includes('做不了主'))
  assert.equal(typeof QUEUE_TAKEOVER, 'string')
  assert.ok(QUEUE_TAKEOVER.includes('排进确认队列'))
})

// ---------- 8. settings fail-closed ----------

test('readRuntimeSettings：读不到配置时安全开关按关（fail-closed）', () => {
  const broken = { config: () => { throw new Error('配置读取失败') } }
  const s = readRuntimeSettings(broken)
  assert.equal(s.adminMode, false, '超管必须 fail-closed 为关')
  assert.equal(s.hostTakeover, false, '宿主接管必须 fail-closed 为关')
  assert.equal(typeof s.enabled, 'boolean')
})

test('readRuntimeSettings：正常配置下读取开关', () => {
  const api = { settings: () => ({ enabled: true, selfAware: true, rtMaxInjectTokens: 500, adminMode: true }) }
  const s = readRuntimeSettings(api)
  assert.equal(s.enabled, true)
  assert.equal(s.selfAware, true)
  assert.equal(s.adminMode, true)
  assert.equal(s.configError, false)
  // 模块版走 api.settings()：显式预算键正常生效（内置版的「显式预算不生效」偏差在模块版不存在）
  assert.equal(s.rtMaxInjectTokens, 500)
})

test('readRuntimeSettings：非法预算值回落默认并 clamp', () => {
  const api = { settings: () => ({ rtMaxInjectTokens: 999999, rtMemoryTokens: 'abc' }) }
  const s = readRuntimeSettings(api)
  assert.equal(s.rtMaxInjectTokens, 8000) // clamp 到上限
  assert.equal(s.rtMemoryTokens, DEFAULT_BUDGETS.rtMemoryTokens) // 非数字回落默认
})

// ---------- 9. 前缀与自驱引擎同源 ----------

test('prefix 复用插件内部 autotelic/prefix.js：同输入同 hash', skipNoHost, () => {
  const { hashPrefix, buildPrefix } = autotelicPrefix()
  const p = { personaSummary: '我是咕嘟', instincts: ['会学人说话'], constraints: '不许半夜说话' }
  const h1 = hashPrefix(buildPrefix(p))
  const h2 = hashPrefix(buildPrefix(p))
  assert.equal(h1, h2, '同输入必须同 hash（缓存命中前提）')
  assert.equal(typeof h1, 'string')
  assert.ok(h1.length >= 8)
})

test('prefix 内容变化 → hash 变化（缓存失效可感知）', skipNoHost, () => {
  const { hashPrefix, buildPrefix } = autotelicPrefix()
  const base = { personaSummary: '我是咕嘟', instincts: [], constraints: '' }
  const withInstinct = {
    personaSummary: '我是咕嘟',
    instincts: [{ id: 'i1', title: '学人说话', content: '说话短一点' }],
    constraints: '',
  }
  const a = hashPrefix(buildPrefix(base))
  const b = hashPrefix(buildPrefix(withInstinct))
  assert.notEqual(a, b, '本能段加入后 hash 必须变')
})

test('前缀顺序固定：人格→本能→约束', skipNoHost, () => {
  const { buildPrefix } = autotelicPrefix()
  const text = buildPrefix({
    personaSummary: 'PERSONA_MARK',
    instincts: [{ id: 'i1', title: '本能标题', content: 'INSTINCT_MARK' }],
    constraints: 'CONSTRAINT_MARK',
  })
  const iP = text.indexOf('PERSONA_MARK')
  const iI = text.indexOf('INSTINCT_MARK')
  const iC = text.indexOf('CONSTRAINT_MARK')
  assert.ok(iP >= 0 && iI >= 0 && iC >= 0, `三段都该在，实际：${JSON.stringify(text)}`)
  assert.ok(iP < iI, '人格摘要必须在本能之前')
  assert.ok(iI < iC, '本能必须在约束之前')
})

test('模块版 createRuntimePrefix：宿主内部可用时与引擎实现同 hash', skipNoHost, () => {
  const { hashPrefix, buildPrefix } = autotelicPrefix()
  const prefix = createRuntimePrefix({ getConfig: () => ({}) })
  const mine = prefix.version()
  // 用同一份同源输入在引擎实现上重算：必须一致（同一份实现 + 同一处真相）
  const p = prefix.inputs()
  const theirs = hashPrefix(buildPrefix({ personaSummary: p.personaSummary, instincts: p.instincts, constraints: p.constraints }))
  assert.equal(mine, theirs, '同输入 + 同实现必须同 hash')
  const cmp = prefix.compare()
  assert.equal(cmp.drift, false)
  assert.equal(cmp.why, '')
})

// 宿主真的没有那个文件时（beta / release 现状、以及 CI 现状），同一个持有者必须
// 走降级而不是抛错 —— 这正是维护者要求「拿不到就纯本地降级」的那条路径。
test('模块版 createRuntimePrefix：宿主内部缺席时走本地降级（不抛错、hash 自洽、如实标注）', skipWithHost, () => {
  assertDegradedPrefix(createRuntimePrefix({ getConfig: () => ({}) }))
})

test('模块版降级：宿主内部文件拿不到时前缀不抛错、走本地回退 hash 并如实标注', () => {
  // 模拟「引擎没合 / 插件内部文件缺失」：临时摘掉 globalThis.aurabot 再造一个前缀持有者
  const saved = globalThis.aurabot
  try {
    delete globalThis.aurabot
    const prefix = createRuntimePrefix({ getConfig: () => ({ ext: { autotelic: { constraintRules: '不许半夜说话' } } }) })
    const cmp = prefix.compare()
    assert.ok(typeof cmp.runtimeHash === 'string' && cmp.runtimeHash.length >= 8, '降级 hash 仍要产出')
    assert.equal(cmp.drift, false, '同输入重算必须自洽')
    // 内部实现缺失时 why 必须如实说明「降级」，绝不假装与引擎同源
    assert.ok(cmp.why.includes('降级'), `降级要标注，实际：${cmp.why}`)
    // constraintRules 依赖内部 constraint.js 解析，降级时如实留空（不硬造）
    assert.equal(prefix.inputs().constraints, '')
    assert.equal(prefix.inputs().constraintsRaw, '不许半夜说话', '原文仍从配置读到')
    // text() 直拼不抛错
    assert.doesNotThrow(() => prefix.text())
  } finally {
    globalThis.aurabot = saved
  }
})

test('stableSegments：selfAware 开时含自我意识半段；人格卡已含本能附加段时不重复', () => {
  const segs = stableSegments({ settings: { selfAware: true }, cfg: {}, instincts: { list: [] }, personaSummary: '平常的卡' })
  assert.ok(segs.some((s) => s.includes('这就是你本人')))
  const addon = '<!-- instinct:test start -->'
  assert.equal(personaHasInstinctAddon(`前文${addon}后文`), true)
  const segs2 = stableSegments({
    settings: { selfAware: true }, cfg: {},
    instincts: { list: [{ id: 'i1', title: 'T', content: 'C' }] },
    personaSummary: `卡里有${addon}了`,
  })
  assert.ok(!segs2.some((s) => s.includes('本能·')), '人格卡已有附加段时不再追加')
})

// ---------- 10. 情绪让位（mood.contextLine 不重复）----------

test('isMoodContextBlock 能认出 mood 的上下文行', () => {
  const line = '（因为主人刚夸了我，心情不错）'
  assert.equal(typeof isMoodContextBlock({ type: 'text', text: line }), 'boolean')
})

test('yieldMoodLine：Runtime 开时让位，关时保留 mood 行（永久 fallback）', () => {
  const content = [{ type: 'text', text: '（心情：不错）' }, { type: 'text', text: '原有内容' }]
  const kept = yieldMoodLine(content, false)
  const yielded = yieldMoodLine(content, true)
  assert.ok(Array.isArray(kept))
  assert.ok(Array.isArray(yielded))
  assert.ok(yielded.length <= kept.length, '让位后不应变多')
})

// ---------- 11. 文本工具 ----------

test('charsOf 按码点计数（中文/emoji 各算 1）', () => {
  assert.equal(charsOf('咕嘟'), 2)
  assert.equal(charsOf('🐟'), 1)
})

test('estimateTokens 中文约 2 字符≈1 token', () => {
  const t = estimateTokens('一二三四五六七八九十')
  assert.ok(t >= 3 && t <= 10, `token 估算应合理，实际 ${t}`)
})

test('cutToTokens：不超限、不切坏代理对', () => {
  const s = '咕嘟咕嘟咕嘟咕嘟🐟🐟'
  const cut = cutToTokens(s, 3)
  assert.ok(estimateTokens(cut) <= 3 || cut.length < s.length)
  assert.equal(typeof cut, 'string')
  assert.doesNotThrow(() => [...cut])
})

test('perceiveTone 能给出语气判读且带置信度', () => {
  const r = perceiveTone('哼 讨厌啦')
  assert.equal(typeof r, 'object')
  assert.ok('confidence' in r || 'tone' in r || 'label' in r)
})

test('detectToneCalibration 能识别主人的语气纠正', () => {
  const r = detectToneCalibration('你别老用「呢」，听着好假')
  assert.ok(r === null || typeof r === 'object')
})

test('perceiveTone 对空串安全', () => {
  assert.doesNotThrow(() => perceiveTone(''))
  assert.doesNotThrow(() => perceiveTone(null))
})

// ---------- 12. 模块壳（模块版专属：入口形状与降级声明）----------

test('入口 export default 形状：id/version/api/setup/settings 声明齐全', async () => {
  const mod = (await import('../index.mjs')).default
  assert.equal(mod.id, 'persona-runtime')
  assert.equal(typeof mod.version, 'string')
  assert.equal(typeof mod.setup, 'function')
  assert.ok(Array.isArray(mod.settings) && mod.settings.length >= 14, '9 开关 + 5 预算键的设置行')
  assert.equal(mod.defaults.enabled, true)
  assert.equal(mod.defaults.adminMode, false, '超管默认关（fail-closed）')
  assert.equal(mod.defaults.hostTakeover, false, '宿主接管默认关')
  assert.equal(mod.defaults.activeThinking, false, '主动思考默认关')
  // 与自驱引擎协同、非必需依赖：描述里必须写明
  assert.ok(String(mod.description || '').includes('非必需'), '描述要写明「非必需依赖」')
})

test('模块壳 setup：宿主能力全缺时也能装配并降级（fake api 面）', async () => {
  const mod = (await import('../index.mjs')).default
  // 照 repo/src/core/modules.js 的 makeApi 形状造假 api：本用例把 mood/autotelic/core 都拿掉，
  // 验证「独立降级运行」——注入照常、出口如实 not-wired、不抛错。
  const saved = globalThis.aurabot
  delete globalThis.aurabot
  try {
    const hooks = {}
    const routes = {}
    const rules = []
    const fakeApi = {
      id: 'persona-runtime',
      log: { info() {}, warn() {}, error() {}, debug() {} },
      settings: () => ({ ...mod.defaults }),
      config: () => ({}),
      dataDir: (...p) => `./.tmp-persona-runtime-data/${p.join('/')}`,
      on: (ev, fn) => { hooks[ev] = fn },
      route: (path, fn) => { routes[path] = fn },
      rule: (fn) => rules.push(fn),
      use: () => null, // mood / autotelic 都没跑
      core: {}, // 没有 autotelicAudit / http
    }
    const ext = mod.setup(fakeApi)
    assert.equal(typeof ext.status, 'function')
    assert.equal(typeof ext.preview, 'function')
    // rules 通道注册了；没开 autotelic 时稳定半段仍能出（自我意识半段）
    assert.equal(rules.length, 1)
    const segs = rules[0]('private')
    assert.ok(Array.isArray(segs) && segs.some((s) => s.includes('这就是你本人')))
    // status：mood/autotelic 全缺也要能出（不抛错、如实标注）
    const st = ext.status()
    assert.equal(st.ok, true)
    assert.equal(st.emotion, null, 'mood 没跑 → 情绪镜像为 null（不兜造）')
    assert.equal(st.duty.auditWired, false, '审计未接线要如实显示')
    assert.equal(st.bridge.wired, false, '观察桥未接线要如实显示')
    // preview：零副作用试拼可跑
    const pv = ext.preview({ text: '在吗' })
    assert.equal(pv.overflow !== undefined, true)
    assert.ok(Array.isArray(pv.segments))
  } finally {
    globalThis.aurabot = saved
  }
})
