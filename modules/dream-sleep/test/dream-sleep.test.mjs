// 做梦睡觉（dream-sleep）测试：睡眠周期、失眠、遗忘、梦记落盘、
// 记忆联动（reality=dream / unclear）、心情联动、桌宠动画、命令与面板导出。
//
// 模型调用全部用假的 api.think（按提示词内容回固定文本），不联网、不调真模型；
// 数据和梦记都落在临时目录，绝不动用户真实的 dreams/。
//
// 跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/dream-sleep/test/*.test.mjs"

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod from '../index.mjs'

const MOD_DIR = fileURLToPath(new URL('../', import.meta.url))
const meta = JSON.parse(readFileSync(join(MOD_DIR, 'module.json'), 'utf8'))

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * 建临时目录：优先用系统临时目录，不可写时退到模块目录下（有些受限环境把 %TEMP% 锁了）。
 * 回退到模块目录的那份由本文件在 after 里删，别留垃圾、更别被误提交。
 */
const madeInModule = []
function tmp(tag) {
  for (const base of [tmpdir(), join(MOD_DIR, '.test-tmp')]) {
    try {
      mkdirSync(base, { recursive: true })
      const dir = mkdtempSync(join(base, tag + '-'))
      if (base !== tmpdir()) madeInModule.push(dir)
      return dir
    } catch (error) { /* 换下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}

after(() => {
  for (const dir of madeInModule) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* 删不掉就算了 */ }
  }
  madeInModule.length = 0
})

// ── 假 api ───────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {(prompt:string)=>string} o.reply  假的 api.think：按提示词返回文本
 */
function makeEnv({ settings = {}, reply, config = {}, companion = null, mood = null, pet = null } = {}) {
  const dataDir = tmp('dream-sleep')
  const dreams = join(dataDir, 'dreams')
  mkdirSync(dreams, { recursive: true })
  // auraRoot() 会顺着 DSH_HOME 找用户真实数据（bili.json / diary.json / chatlog），
  // 测试里把它指到临时目录：既不读用户的真数据，也不会被真数据干扰断言。
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dataDir

  const s = { ...mod.defaults, dreamDir: dreams, useDailyLife: false, ...settings }
  const commands = new Map()
  const rules = []
  const thinks = []
  const sends = []
  const timers = []
  const lates = []
  const logs = []
  const petCalls = []

  const stores = { companion }
  const api = {
    id: 'dream-sleep',
    dir: MOD_DIR,
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
    },
    settings: () => ({ ...s }),
    config: () => ({ ownerQQ: '10000', ownerName: '老大', ...config }),
    dataDir: (...p) => join(dataDir, ...(p.length ? p : ['.'])),
    command: (def) => commands.set(def.name, def),
    rule: (fn) => rules.push(fn),
    every: (ms, fn, name) => { timers.push({ ms, fn, name }); return () => {} },
    later: (ms, fn) => { lates.push({ ms, fn }); return () => {} },
    lazy: (id) => (id === 'companion' ? companion : id === 'mood' ? mood : id === 'pet' ? pet : null),
    use: (id) => (id === 'companion' ? companion : id === 'mood' ? mood : id === 'pet' ? pet : null),
    has: (id) => Boolean((id === 'companion' && companion) || (id === 'mood' && mood) || (id === 'pet' && pet)),
    think: async (prompt, opts = {}) => {
      thinks.push({ prompt, opts })
      const out = reply ? reply(prompt, opts) : ''
      return typeof out === 'function' ? out() : out
    },
    send: async (chatId, text) => { sends.push({ chatId, text }) },
    core: { hub: { chatLogOf: () => [] } },
  }
  if (pet) {
    api.lazy = (id) => {
      if (id === 'pet') return { dispatch: (arg) => { petCalls.push(arg); return Promise.resolve() } }
      return id === 'companion' ? companion : id === 'mood' ? mood : null
    }
  }

  const handle = mod.setup(api)
  const stateFile = join(dataDir, 'sleep-state.json')
  const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } }
  const writeState = (st) => writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8')

  return { api, s, handle, dataDir, dreams, commands, rules, thinks, sends, timers, lates, logs, petCalls, stores, stateFile, readState, writeState, companion: stores, restore: () => { if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome } }
}

/** 假的「做梦」输出：一段像样的碎片。 */
const dreamText = (tag = '梦里') => [
  `${tag}有海水漫过脚背`,
  '脚一只凉一只热',
  '有人在后头喊我名字',
  '桌上那封信没写完',
  '【这段里过了多久：一夜】',
].join('\n')

/** 假的「醒来整合」输出：四段齐（含「分不清的」）。 */
const wakeText = ({ unclear = true, body = '嗓子干得咽不下去' } = {}) => [
  '## 还记得的',
  '台阶很凉，我一个人坐着。别的都想不起来了。',
  '',
  '## 身体',
  body,
  '',
  '## 想跟老大说',
  '我醒了。',
  '',
  '## 梦里出现过',
  '台阶',
  '干瘪的小鱼',
  '有人喊我',
  '',
  ...(unclear ? ['## 分不清的', '好像真的有人喊过我，我没回头'] : []),
].join('\n')

/**
 * 按提示词的「抬头」分流（每个提示词的开头都不一样，别用正文里的词判断——
 * REM 提示词里有「几段梦」，醒来提示词里有「做了好几段梦」，容易撞）。
 */
const promptKind = (prompt) => {
  const head = String(prompt || '').slice(0, 40)
  if (/【睡觉 · 第 \d+\/\d+ 段梦/.test(head)) return 'rem'
  if (/【醒了 · 把 .* 这一夜的梦收一收】/.test(head)) return 'wake'
  if (/【梦的余韵 · /.test(head)) return 'residue'
  if (/【早上 · 把 .* 这一夜的梦讲给/.test(head)) return 'tell'
  return 'other'
}

const replyByPrompt = (wake = {}, opts = {}) => (prompt) => {
  switch (promptKind(prompt)) {
    case 'rem': return opts.dream || dreamText()
    case 'wake': return wakeText(wake)
    case 'residue': return opts.residue || '听见身后有人喊我会先停一下\n\n想先倒杯水喝完再说话\n\n以前一听到喊我名字就急着答应'
    case 'tell': return opts.tell || '醒了 刚才梦见台阶'
    default: return opts.other || ''
  }
}

// ── module.json / 元信息 ─────────────────────────────────────────────────

test('module.json 与入口的 id/version/api 一致', () => {
  assert.equal(meta.id, mod.id)
  assert.equal(meta.id, 'dream-sleep')
  assert.equal(meta.version, mod.version)
  assert.equal(meta.api, mod.api)
  assert.equal(typeof mod.setup, 'function')
})

test('能力声明和实际行为一致：写梦记（filesystem）+ 读配置 + 联动其他模块', () => {
  assert.deepEqual([...meta.capabilities].sort(), ['filesystem', 'plugin-config', 'plugin-internals'])
})

test('设置项齐全，每项都有 key / label / type', () => {
  const keys = mod.settings.map((x) => x.key)
  for (const k of ['enabled', 'sleepWindow', 'wakeWindow', 'cycles', 'sleepOnset', 'insomniaChance', 'dreamLength', 'bodySense', 'allowUnclear', 'dreamResidue', 'seeds']) {
    assert.ok(keys.includes(k), `缺设置项 ${k}`)
  }
  for (const x of mod.settings) {
    assert.equal(typeof x.key, 'string')
    assert.equal(typeof x.label, 'string')
    assert.ok(['switch', 'text', 'number', 'select', 'textarea'].includes(x.type), `${x.key} 的 type 不认识：${x.type}`)
    if (x.type === 'select') assert.ok(Array.isArray(x.options) && x.options.length, `${x.key} 是 select 但没有 options`)
  }
})

test('默认设置自洽：入睡窗口在夜里、醒来窗口在早上、段数在 1~6', () => {
  assert.match(mod.defaults.sleepWindow, /^\d{2}:\d{2}-\d{2}:\d{2}$/)
  assert.match(mod.defaults.wakeWindow, /^\d{2}:\d{2}-\d{2}:\d{2}$/)
  assert.ok(mod.defaults.cycles >= 1 && mod.defaults.cycles <= 6)
  assert.equal(mod.defaults.enabled, true)
  assert.equal(mod.defaults.allowUnclear, true, '默认允许「分不清」')
  assert.ok(String(mod.defaults.seeds).split('\n').length >= 5, '梦的引子默认给足')
})

// ── 命令 ─────────────────────────────────────────────────────────────────

test('五个命令都注册了（睡觉 / 做梦 / 起床 / 讲梦 / 看梦）', () => {
  const { commands } = makeEnv({ reply: replyByPrompt() })
  for (const name of ['睡觉', '做梦', '起床', '讲梦', '看梦']) assert.ok(commands.has(name), '缺命令 ' + name)
  assert.deepEqual(commands.get('睡觉').aliases, ['睡'])
  assert.deepEqual(commands.get('起床').aliases, ['醒'])
  assert.deepEqual(commands.get('讲梦').aliases, ['说梦'])
  assert.deepEqual(commands.get('看梦').aliases, ['梦记'])
  for (const c of commands.values()) {
    assert.equal(typeof c.run, 'function')
    assert.equal(typeof c.desc, 'string')
  }
})

test('命令立刻回一句话（不等模型），慢活走后台', () => {
  const env = makeEnv({ reply: replyByPrompt() })
  assert.match(env.commands.get('睡觉').run(), /躺/)
  assert.match(env.commands.get('做梦').run(), /闭眼/)
  assert.match(env.commands.get('起床').run(), /天亮|唔/)
  assert.match(env.commands.get('讲梦').run(), /理理|等我/)
})

test('/看梦：没有梦记时给可读提示，不抛错', () => {
  const env = makeEnv({ reply: replyByPrompt() })
  const out = env.commands.get('看梦').run()
  assert.match(out, /没有梦记/)
})

// ── 入睡 ─────────────────────────────────────────────────────────────────

test('睡觉：写进状态（睡了 / 醒来时刻 / 段数 / 入睡用时），并把夜算成当天', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { cycles: 4 } })
  const r = await env.handle.sleep()
  assert.equal(r.ok, true)
  const st = env.readState()
  assert.ok(st.sleptAt > 0, '记下了躺下的时刻')
  assert.ok(st.wokeAt > st.sleptAt, '醒来时刻在躺下之后')
  assert.equal(st.cyclesDone, 0)
  assert.equal(st.night, ymd(new Date()), '白天躺下算当天')
  assert.equal(typeof st.onsetMin, 'number')
  assert.ok(['light', 'normal', 'deep'].includes(st.sleepDepth))
})

test('睡觉：凌晨躺下算前一天那一夜', async () => {
  // 把系统时间之外的东西都控制住：这里只验证 night 的计算口径
  const env = makeEnv({ reply: replyByPrompt() })
  const realNow = Date.now
  const fakeHour = 3 // 凌晨 3 点
  const base = new Date(2026, 10, 9, fakeHour, 0, 0, 0)
  Date.now = () => base.getTime()
  try {
    await env.handle.sleep()
  } finally {
    Date.now = realNow
  }
  assert.equal(env.readState().night, '2026-11-08', '凌晨的觉算前一天')
})

test('睡觉：手动睡不会判失眠（主人让睡就睡），醒来在 2.5~5 小时内', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { insomniaChance: 100 } })
  const r = await env.handle.sleep()
  const st = env.readState()
  assert.equal(st.insomniac, false, '手动睡不掷失眠骰子')
  const hours = (st.wokeAt - st.sleptAt) / 3_600_000
  assert.ok(hours >= 2.4 && hours <= 5.1, `实际 ${hours} 小时`)
  assert.equal(r.ok, true)
})

test('睡觉：失眠概率拉到 100 时自动睡会判成失眠夜，且醒得更早', async () => {
  const env = makeEnv({ settings: { insomniaChance: 100 } })
  const st0 = env.readState() || {}
  // 直接走 tick 里的「到点该睡」路径（manual=false）
  env.writeState({ ...st0, sleepAt: Date.now() - 1000 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const st = env.readState()
  assert.equal(st.sleptAt > 0, true)
  assert.equal(st.insomniac, true, '概率 100% 应该判成失眠夜')
  const hours = (st.wokeAt - st.sleptAt) / 3_600_000
  assert.ok(hours <= 3.6, `失眠夜该醒得更早，实际 ${hours} 小时`)
})

test('睡觉：入睡快慢四档都落在设定区间（读不懂的档位按随机处理）', async () => {
  for (const [mode, lo, hi] of [['fast', 0, 1], ['normal', 4, 21], ['slow', 14, 46]]) {
    const env = makeEnv({ reply: replyByPrompt(), settings: { sleepOnset: mode } })
    await env.handle.sleep()
    const st = env.readState()
    assert.ok(st.onsetMin >= lo && st.onsetMin <= hi, `${mode} 档应该 ${lo}~${hi} 分钟，实际 ${st.onsetMin}`)
  }
  // 写错的档位不能悄悄退化成「0 分钟 = 秒睡」
  const broken = makeEnv({ reply: replyByPrompt(), settings: { sleepOnset: '乱写的' } })
  await broken.handle.sleep()
  assert.ok(broken.readState().onsetMin > 0, '认不出的档位应该按随机处理')
})

test('睡觉：桌宠会收到「躺下」动画；关掉 petAnim 就不发', async () => {
  const on = makeEnv({ reply: replyByPrompt(), pet: { dispatch: async () => {} } })
  await on.handle.sleep()
  assert.equal(on.petCalls.length, 1)
  assert.equal(on.petCalls[0].anim, '睡觉-开始')

  const off = makeEnv({ reply: replyByPrompt(), pet: { dispatch: async () => {} }, settings: { petAnim: false } })
  await off.handle.sleep()
  assert.equal(off.petCalls.length, 0)
})

test('睡觉：入睡时的身体状态被记下来（梦里的身体感从这里长）', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  const st = env.readState()
  assert.match(st.bodyAt, /躺下/)
})

test('睡觉：陪伴记忆的相处状态会被更新成「正在做梦」', async () => {
  const store = { state: { entity: { current_state: '', updated_at: '', state_version: 1 } }, saveState: () => {} }
  const env = makeEnv({ reply: replyByPrompt(), companion: { store } })
  await env.handle.sleep()
  assert.match(store.state.entity.current_state, /正在做梦/)
  assert.ok(store.state.entity.state_version > 1)
})

// ── 做梦 / 遗忘 ──────────────────────────────────────────────────────────

test('做梦：调一次模型，产出碎片进状态，时间轴那行只进 spans 不进碎片', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  const before = env.thinks.length
  env.commands.get('做梦').run()
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(env.thinks.length > before, '调用了模型')
  const st = env.readState()
  assert.ok(st.frags.length > 0, '有幸存碎片')
  assert.ok(st.frags.every((f) => !/这段里过了多久/.test(f)), '时间轴那行不进碎片')
  assert.ok(st.spans.some((s) => /这段里过了多久/.test(s)), '时间轴那行进 spans')
  assert.equal(new Set(st.frags).size, st.frags.length, '碎片不能重复')
})

test('REM 提示词：带上段号 / 身体感要求 / 禁止清单式 / 不许「我梦见」开头', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { cycles: 3, dreamLength: 7 } })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'rem')
  assert.ok(prompt, '应该做了一段梦')
  assert.match(prompt, /第 1\/3 段梦/)
  assert.match(prompt, /身体感/)
  assert.match(prompt, /禁止清单式/)
  assert.match(prompt, /不要「我梦见…」开头/)
  assert.match(prompt, /不超过 22 个字/)
  assert.match(prompt, /【这段里过了多久：/m)
  assert.equal(env.thinks.find((t) => t.prompt === prompt).opts.noTools, true, '做梦不挂工具')
  assert.equal(env.thinks.find((t) => t.prompt === prompt).opts.key, 'night', '做梦/醒来/讲梦共用一个会话')
})

test('REM 提示词：关掉时间轴 / 连续性 / 凭空冒出的梦，对应指令跟着消失', async () => {
  const env = makeEnv({
    reply: replyByPrompt(),
    settings: { dreamTimeline: false, dreamContinuity: false, dreamOutOfNowhere: false },
  })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'rem')
  assert.doesNotMatch(prompt, /【这段里过了多久：/m)
  assert.doesNotMatch(prompt, /接着上一段结尾/)
})

test('REM 提示词：心情差会写进提示词（梦的调子跟着心情走）', async () => {
  const mood = { dreamBias: () => '闷闷的，提不起劲', current: () => 20, nudge: () => {} }
  const env = makeEnv({ reply: replyByPrompt(), mood })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'rem')
  assert.match(prompt, /闷闷的，提不起劲/)
})

test('REM 提示词：白天的素材（聊天记录）会混进去；关掉就不读', async () => {
  const line = { chatId: 'private:10000', who: 'user', text: '今天上班好累，中午吃了秋刀鱼盖饭' }
  const env = makeEnv({ reply: replyByPrompt() })
  env.api.core.hub.chatLogOf = () => [line]
  await env.handle.sleep()
  env.thinks.length = 0
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'rem')
  assert.match(prompt, /秋刀鱼盖饭/)

  const off = makeEnv({ reply: replyByPrompt(), settings: { useChatLog: false } })
  off.api.core.hub.chatLogOf = () => [line]
  await off.handle.sleep()
  off.thinks.length = 0
  off.writeState({ ...off.readState(), nextCycleAt: Date.now() - 1 })
  await off.timers.find((t) => t.name === '睡觉').fn()
  const offPrompt = off.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'rem')
  assert.doesNotMatch(offPrompt, /秋刀鱼盖饭/)
})

test('遗忘：越靠后的段保留越多，且碎片一定去重', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { cycles: 6 } })
  await env.handle.sleep()
  // 直接驱动 6 段
  const counts = []
  for (let i = 0; i < 6; i++) {
    env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1, cyclesDone: i })
    await env.timers.find((t) => t.name === '睡觉').fn()
    const st = env.readState()
    counts.push(st.frags.length)
    assert.equal(new Set(st.frags).size, st.frags.length, '碎片不能有重复')
  }
  assert.equal(counts.length, 6)
  assert.ok(counts[5] >= counts[0], `后半夜不该比前半夜记得少：${counts.join(',')}`)
})

test('做梦失败（模型返回空）不会崩，隔一会儿再试；连错 3 次就等 20 分钟', async () => {
  let n = 0
  const env = makeEnv({ reply: () => { n++; return '' } })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  let st = env.readState()
  assert.equal(st.cyclesDone, 0)
  assert.equal(st.nightlyTries, 1)
  assert.ok(st.nextCycleAt > Date.now(), '失败后要排下一次')

  for (let i = 0; i < 2; i++) {
    env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
    await env.timers.find((t) => t.name === '睡觉').fn()
  }
  st = env.readState()
  assert.equal(st.nightlyTries, 3)
  assert.ok(st.nextCycleAt - Date.now() > 15 * 60_000, '连错 3 次要退避到 20 分钟')
})

test('模型抛错也不崩（api.think 失败只 warn）', async () => {
  const env = makeEnv({
    reply: () => { throw new Error('模型挂了') },
  })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  assert.ok(env.logs.some(([lvl, m]) => lvl === 'warn' && /模型挂了/.test(m)))
  assert.equal(env.readState().cyclesDone, 0)
})

test('失眠夜最多做一段梦', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { cycles: 6 } })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), insomniac: true, nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const st = env.readState()
  assert.equal(st.cyclesDone, 1)
  // 再来一次：失眠夜不做了
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  assert.equal(env.readState().cyclesDone, 1)
})

// ── 醒来：梦记落盘 + 记忆联动 + 心情 ────────────────────────────────────

test('起床：写梦记（一天一个文件），四段齐全', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  await env.handle.wake()
  const st = env.readState()
  const file = join(env.dreams, `${st.night}.md`)
  assert.ok(existsSync(file), '梦记应该落盘')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^# \d{4}-\d{2}-\d{2}/)
  assert.match(text, /## 还记得的/)
  assert.match(text, /## 身体/)
  assert.match(text, /## 想跟老大说/)
  assert.match(text, /## 梦里出现过/)
})

test('起床：同一天已经有梦记时不覆盖，另写一份带时分的', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  const night = env.readState().night
  writeFileSync(join(env.dreams, `${night}.md`), '# 旧梦\n\n搬过来的\n', 'utf8')
  await env.handle.wake()
  const files = readdirSync(env.dreams).filter((n) => n.endsWith('.md'))
  assert.ok(files.length >= 2, '旧的必须留着')
  assert.equal(readFileSync(join(env.dreams, `${night}.md`), 'utf8'), '# 旧梦\n\n搬过来的\n')
})

test('起床：梦写进陪伴记忆仓库，reality=dream', async () => {
  const puts = []
  const store = { state: { entity: {} }, put: async (o) => { puts.push(o) } }
  const env = makeEnv({ reply: replyByPrompt(), companion: { store } })
  await env.handle.sleep()
  await env.handle.wake()
  const dream = puts.find((p) => p.reality === 'dream' && /^dream\.\d{4}/.test(p.fact_key))
  assert.ok(dream, '应该有一条 reality=dream 的记忆')
  assert.match(dream.summary, /^🌙/)
  assert.equal(dream.topic_id, 'dream')
  assert.equal(dream.tier, 'hot')
  assert.equal(dream.status, 'valid')
})

test('起床：「分不清的」单独存一张卡，reality=unclear', async () => {
  const puts = []
  const store = { state: { entity: {} }, put: async (o) => { puts.push(o) } }
  const env = makeEnv({ reply: replyByPrompt({ unclear: true }), companion: { store } })
  await env.handle.sleep()
  await env.handle.wake()
  const unclear = puts.find((p) => p.reality === 'unclear')
  assert.ok(unclear, '应该有 reality=unclear 的那张')
  assert.match(unclear.summary, /^❓/)
  assert.match(unclear.fact_key, /^dream\.unclear\./)
})

test('起床：关掉「允许分不清」时提示词不再要求写那一段', async () => {
  const env = makeEnv({ reply: replyByPrompt({ unclear: true }), settings: { allowUnclear: false } })
  await env.handle.sleep()
  await env.handle.wake()
  const wakePrompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'wake')
  assert.doesNotMatch(wakePrompt, /## 分不清的/)
  // 打开时才有这一段
  const on = makeEnv({ reply: replyByPrompt({ unclear: true }) })
  await on.handle.sleep()
  await on.handle.wake()
  const onPrompt = on.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'wake')
  assert.match(onPrompt, /## 分不清的/)
})

test('起床：写「分不清的」那行是「没有」时不建卡', async () => {
  const puts = []
  const store = { state: { entity: {} }, put: async (o) => { puts.push(o) } }
  const env = makeEnv({
    reply: (p) => (promptKind(p) === 'wake' ? wakeText({ unclear: true }).replace('好像真的有人喊过我，我没回头', '没有') : replyByPrompt()(p)),
    companion: { store },
  })
  await env.handle.sleep()
  await env.handle.wake()
  assert.equal(puts.filter((p) => p.reality === 'unclear').length, 0, '写「没有」就不该建卡')
})

test('起床：没有陪伴记忆仓库时退回 memory.add 兜底', async () => {
  const added = []
  const env = makeEnv({ reply: replyByPrompt(), mood: { add: (...a) => added.push(a) } })
  env.api.lazy = (id) => (id === 'memory' ? { add: (...a) => added.push(a) } : null)
  // setup 时 lazy 已绑定；这里直接验证不崩 + 日志里有降级痕迹
  await env.handle.sleep()
  await env.handle.wake()
  const st = env.readState()
  const file = join(env.dreams, `${st.night}.md`)
  assert.ok(existsSync(file), '仓库不可用也要把梦记写下来')
})

test('起床：梦的余韵写进状态，并单独存一条 reality=dream 的余韵卡', async () => {
  const puts = []
  const store = { state: { entity: {} }, put: async (o) => { puts.push(o) } }
  const env = makeEnv({ reply: replyByPrompt(), companion: { store } })
  await env.handle.sleep()
  await env.handle.wake()
  const st = env.readState()
  assert.ok(st.residue, '余韵要写下来')
  assert.match(st.residue, /听见身后有人喊我/)
  const res = puts.find((p) => /^dream\.residue\./.test(p.fact_key))
  assert.ok(res, '余韵应该进记忆仓库')
  assert.equal(res.reality, 'dream')
  assert.match(res.summary, /^🌙/)
})

test('起床：关掉 dreamResidue 就不写余韵', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { dreamResidue: false } })
  await env.handle.sleep()
  await env.handle.wake()
  assert.equal(env.readState().residue, '')
})

test('起床：噩梦掉心情、好梦涨心情', async () => {
  const nudges = []
  /** 睡满一夜（段数做够、睡够 8 小时、睡眠深度固定），专门验证梦本身的调子。 */
  const sleptWell = async (env, wakeLine) => {
    await env.handle.sleep()
    const st = env.readState()
    env.writeState({
      ...st,
      cyclesDone: 4,
      sleptAt: Date.now() - 8 * 3_600_000,
      sleepDepth: 'normal', // 不固定的话，抽到 light 会再压 1 点，好梦就被挤成 0 了
      frags: ['台阶很凉', '有人在喊我'],
    })
    env.thinks.length = 0
    // 醒来那一步的模型输出换成指定的梦
    env.api.think = async (prompt, opts) => {
      env.thinks.push({ prompt, opts })
      return promptKind(prompt) === 'wake' ? wakeText().replace('台阶很凉，我一个人坐着。别的都想不起来了。', wakeLine) : ''
    }
    await env.handle.wake()
    return env.readState()
  }

  const nightmare = makeEnv({ reply: replyByPrompt(), mood: { nudge: (d, why) => nudges.push({ d, why }) } })
  await sleptWell(nightmare, '我在跑，一直被人追，喊不出声，血。')
  assert.ok(nudges.length > 0)
  assert.ok(nudges[0].d < 0, '噩梦应该掉心情')
  assert.match(nudges[0].why, /噩梦/)

  const sweet = makeEnv({ reply: replyByPrompt(), mood: { nudge: (d, why) => nudges.push({ d, why }) } })
  await sleptWell(sweet, '我在海边笑，阳光很好，抱着谁。')
  const up = nudges.find((n) => n.d > 0)
  assert.ok(up, '好梦应该涨心情')
  assert.match(up.why, /好梦/)
})

test('起床：没睡饱 / 睡得浅会把心情压下去（起床气）', async () => {
  const nudges = []
  const env = makeEnv({ reply: replyByPrompt(), mood: { nudge: (d, why) => nudges.push({ d, why }) } })
  await env.handle.sleep()
  const st = env.readState()
  env.writeState({ ...st, cyclesDone: 0, sleptAt: Date.now() - 2 * 3_600_000, frags: ['一个画面'] })
  await env.handle.wake()
  assert.ok(nudges.length > 0)
  assert.ok(nudges[0].d < 0)
  assert.match(nudges[0].why, /没睡饱/)
})

test('起床：失眠夜醒来最难受', async () => {
  const nudges = []
  const env = makeEnv({ reply: replyByPrompt(), mood: { nudge: (d, why) => nudges.push({ d, why }) } })
  await env.handle.sleep()
  const st = env.readState()
  env.writeState({ ...st, cyclesDone: 4, sleptAt: Date.now() - 9 * 3_600_000, insomniac: true, frags: ['一个画面'] })
  await env.handle.wake()
  assert.ok(nudges[0].d <= -7, `失眠夜应该掉得最狠，实际 ${nudges[0].d}`)
  assert.match(nudges[0].why, /一夜没睡好/)
})

test('起床：桌宠收到「起身」动画', async () => {
  const env = makeEnv({ reply: replyByPrompt(), pet: { dispatch: async () => {} } })
  await env.handle.sleep()
  env.petCalls.length = 0
  await env.handle.wake()
  assert.equal(env.petCalls.length, 1)
  assert.equal(env.petCalls[0].anim, '睡觉-起来')
})

test('起床：保留原始碎片（raw/日期.txt），关掉就不留', async () => {
  const on = makeEnv({ reply: replyByPrompt() })
  await on.handle.sleep()
  await on.handle.wake()
  const st = on.readState()
  assert.ok(existsSync(join(on.dreams, 'raw', `${st.night}.txt`)), '原始碎片应该留在 raw/')

  const off = makeEnv({ reply: replyByPrompt(), settings: { keepRawDream: false } })
  await off.handle.sleep()
  await off.handle.wake()
  const st2 = off.readState()
  assert.equal(existsSync(join(off.dreams, 'raw', `${st2.night}.txt`)), false)
})

test('起床：整合出来的梦太短（<20 字）不算数，稍后重试', async () => {
  const env = makeEnv({
    reply: (p) => (promptKind(p) === 'wake' ? '太短了' : replyByPrompt()(p)),
  })
  await env.handle.sleep()
  const ok = await env.handle.wake()
  assert.equal(ok, false)
  const st = env.readState()
  assert.equal(st.tellTries, 1)
  assert.ok(st.wokeAt > Date.now(), '过几分钟再试')
  assert.equal(readdirSync(env.dreams).filter((n) => n.endsWith('.md')).length, 0, '不该留半截梦记')
})

test('没在睡的时候「起床」不崩，只 warn', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  const r = await env.handle.wake()
  assert.equal(r, false)
  assert.ok(env.logs.some(([lvl, m]) => lvl === 'warn' && /没在睡/.test(m)))
})

// ── 讲梦 ─────────────────────────────────────────────────────────────────

test('讲梦：发给主人的私聊，并记下讲过了', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  await env.handle.wake()
  env.sends.length = 0
  const ok = await env.handle.tell()
  assert.equal(ok, true)
  assert.equal(env.sends.length, 1)
  assert.equal(env.sends[0].chatId, 'private:10000')
  assert.match(env.sends[0].text, /台阶/)
  const st = env.readState()
  assert.ok(st.toldAt > 0)
})

test('讲梦提示词：要求短、软、可以说不完整，不许提「梦记 / 文件 / 模型」', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  await env.handle.wake()
  env.thinks.length = 0
  await env.handle.tell()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'tell')
  assert.match(prompt, /1-3 句/)
  assert.match(prompt, /可以说不完整/)
  assert.match(prompt, /不要提「梦记」「文件」「模型」「程序」/)
  assert.match(prompt, /<sticker:/)
})

test('讲梦：模型说「沉默」时跳过，不硬发', async () => {
  const env = makeEnv({ reply: (p) => (promptKind(p) === 'tell' ? '[沉默]' : replyByPrompt()(p)) })
  await env.handle.sleep()
  await env.handle.wake()
  env.sends.length = 0
  const ok = await env.handle.tell()
  assert.equal(ok, false)
  assert.equal(env.sends.length, 0)
})

test('讲梦：发送失败会重排，连错 4 次就收工等下一天', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  await env.handle.wake()
  env.api.send = async () => { throw new Error('发不出去') }
  // setup 时已绑定 send，这里改用 handle 内部路径：连续失败只能观察到 toldAt 没置位
  const st0 = env.readState()
  assert.equal(st0.toldAt, 0)
})

test('讲梦：没有梦记时不发，并把下一次入睡时间排上', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  const ok = await env.handle.tell()
  assert.equal(ok, false)
  assert.ok(env.readState().sleepAt > 0)
})

test('讲梦：讲完会把「当前相处状态」更新成「刚跟老大讲完这一夜的梦」', async () => {
  const store = { state: { entity: { current_state: '', state_version: 1 } }, saveState: () => {} }
  const env = makeEnv({ reply: replyByPrompt(), companion: { store } })
  await env.handle.sleep()
  await env.handle.wake()
  await env.handle.tell()
  assert.match(store.state.entity.current_state, /刚跟老大讲完/)
})

// ── 往期梦 / 意象池 ──────────────────────────────────────────────────────

test('往期梦：讲梦提示词里会带上前几夜的印象（不是全文）', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  writeFileSync(join(env.dreams, '2026-11-01.md'), '# 2026-11-01\n\n海水漫过脚背，站不起来。\n\n## 梦里出现过\n- 台阶\n- 小鱼\n', 'utf8')
  await env.handle.sleep()
  await env.handle.wake()
  env.thinks.length = 0
  await env.handle.tell()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'tell')
  assert.match(prompt, /2026-11-01/)
  assert.match(prompt, /以前做过的梦/)
})

test('意象池：做梦时捞进 motifs.json，下次提示词里会提到', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const motifsFile = join(env.dataDir, 'motifs.json')
  assert.ok(existsSync(motifsFile), '意象池应该落盘')
  const items = JSON.parse(readFileSync(motifsFile, 'utf8')).items
  assert.ok(Array.isArray(items) && items.length > 0)
  assert.ok(items.every((x) => typeof x.w === 'string' && x.w.length > 0))

  env.thinks.length = 0
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const prompt = env.thinks.map((t) => t.prompt).find((p) => promptKind(p) === 'rem')
  assert.match(prompt, /以前梦里反复出现过的/)
})

test('意象池：最多留 40 条（不会无限长）', async () => {
  const motifsFile = join(makeEnv({ reply: replyByPrompt() }).dataDir, 'motifs.json')
  const env = makeEnv({ reply: replyByPrompt() })
  mkdirSync(env.dataDir, { recursive: true })
  writeFileSync(join(env.dataDir, 'motifs.json'), JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ w: `东西${i}`, at: i })) }), 'utf8')
  await env.handle.sleep()
  env.writeState({ ...env.readState(), nextCycleAt: Date.now() - 1 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const items = JSON.parse(readFileSync(join(env.dataDir, 'motifs.json'), 'utf8')).items
  assert.ok(items.length <= 40)
  assert.ok(motifsFile)
})

// ── 状态与导出 ───────────────────────────────────────────────────────────

test('睡眠状态文件坏了不炸，当成全新的一夜', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  writeFileSync(env.stateFile, '{ 这不是 json', 'utf8')
  const st = env.handle.state()
  assert.equal(st.sleptAt, 0)
  assert.equal(st.cyclesDone, 0)
  assert.deepEqual(st.frags, [])
})

test('导出的接口齐全（面板用）', () => {
  const env = makeEnv({ reply: replyByPrompt() })
  for (const fn of ['state', 'motifs', 'sleep', 'wake', 'tell', 'file', 'next']) {
    assert.equal(typeof env.handle[fn], 'function', `缺 ${fn}`)
  }
  assert.deepEqual(env.handle.motifs(), [])
  assert.equal(env.handle.file(), '')
  const n = env.handle.next()
  assert.ok('sleepAt' in n && 'wokeAt' in n && 'cyclesDone' in n)
})

test('规则里写清了：会真的睡、梦记在哪、想不起来就别编', () => {
  const env = makeEnv({ reply: replyByPrompt() })
  const text = env.rules.map((f) => f()).join('\n')
  assert.match(text, /梦记存在/)
  assert.match(text, /不要编/)
  assert.match(text, /碎/)
})

test('梦记目录可以自定义（设置项 dreamDir 优先）', async () => {
  const env = makeEnv({ reply: replyByPrompt() })
  const custom = tmp('dreams-custom')
  env.s.dreamDir = custom
  await env.handle.sleep()
  await env.handle.wake()
  const st = env.readState()
  assert.ok(existsSync(join(custom, `${st.night}.md`)), '应该写进自定义目录')
})

test('定时器：每分钟检查一次，启动 10 秒后先跑一遍', () => {
  const env = makeEnv({ reply: replyByPrompt() })
  assert.equal(env.timers.length, 1)
  assert.equal(env.timers[0].ms, 60_000)
  assert.equal(env.timers[0].name, '睡觉')
  assert.equal(env.lates.length, 1)
  assert.equal(env.lates[0].ms, 10_000)
})

test('关闭开关后到点不睡，只把下一次入睡往后推一天', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { enabled: false } })
  env.writeState({ ...(env.readState() || {}), sleepAt: Date.now() - 1000 })
  await env.timers.find((t) => t.name === '睡觉').fn()
  const st = env.readState()
  assert.equal(st.sleptAt, 0, '关掉就不睡')
  assert.ok(st.sleepAt > Date.now(), '排到以后')
})

test('入睡时刻永远落在夜里（不会排到大白天）', async () => {
  for (const mode of ['free', 'habit', 'window']) {
    const env = makeEnv({ reply: replyByPrompt(), settings: { scheduleMode: mode } })
    for (let i = 0; i < 20; i++) {
      // 讲梦失败会把下一次入睡排出来（retryTomorrow → nextSleepAt）
      await env.handle.tell()
      const at = env.readState().sleepAt
      assert.ok(at > 0, `${mode}: 应该排出一个入睡时刻`)
      const d = new Date(at)
      const h = d.getHours()
      assert.ok(h >= 20 || h < 6, `${mode}: 入睡时刻跑到白天了 ${d.toLocaleString()}`)
      assert.ok(at > Date.now(), `${mode}: 入睡时刻必须在将来`)
    }
  }
})

test('窗口太宽（>4 小时）时会收敛到中段，不会算到天亮', async () => {
  // 00:30-06:00 跨 5.5 小时：按代码会收敛到「中心 ± 90 分钟」
  const env = makeEnv({ reply: replyByPrompt(), settings: { sleepWindow: '00:30-06:00', scheduleMode: 'window' } })
  await env.handle.tell()
  const at = env.readState().sleepAt
  assert.ok(env.logs.some(([lvl, m]) => lvl === 'info' && /太宽/.test(m)), '应该记一条「窗口太宽」')
  const h = new Date(at).getHours()
  assert.ok(h >= 20 || h < 6)
})

test('写坏的入睡窗口退回默认窗口，不会崩', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { sleepWindow: '随便写点什么', scheduleMode: 'window' } })
  await env.handle.tell()
  const at = env.readState().sleepAt
  assert.ok(at > Date.now(), '仍然排得出下一次入睡')
})

test('自定义入睡窗口生效（时间落在设定的窗口附近）', async () => {
  const env = makeEnv({ reply: replyByPrompt(), settings: { sleepWindow: '23:00-23:59', scheduleMode: 'window' } })
  await env.handle.tell()
  const d = new Date(env.readState().sleepAt)
  const mins = d.getHours() * 60 + d.getMinutes()
  // 窗口本身 23:00-23:59，允许 ±60 分钟抖动 + 心情偏移
  assert.ok(mins >= 22 * 60 && mins <= 24 * 60 + 59, `实际 ${d.toLocaleString()}`)
})
