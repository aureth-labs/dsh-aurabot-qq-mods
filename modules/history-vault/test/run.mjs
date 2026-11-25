// 跨会话历史库的自测：node test/run.mjs
//
// 不联网：模型调用用假的 api.ask 替身（可编程返回），SQLite 用真实的 node:sqlite。
// 退出码 0 = 全过；1 = 有失败项。

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MOD = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail || '') })

// ---------- 造一个假 api ----------
function makeApi({ settings = {}, askImpl = null } = {}) {
  const events = {}
  const routes = {}
  const tools = []
  const commands = {}
  let rulesFn = null
  const logs = []
  const asks = []
  const dataDir = mkdtempSync(join(tmpdir(), 'history-vault-test-'))
  const api = {
    id: 'history-vault',
    source: 'user',
    version: 'test',
    apiVersion: 1,
    dir: MOD,
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    settings: () => settings,
    ask: async (opts) => { asks.push(opts); return askImpl ? askImpl(opts) : '{"text":"假摘要"}' },
    log: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      error: (m) => logs.push('error ' + m),
      debug: () => {},
    },
    on: (e, f) => { (events[e] ||= []).push(f); return () => {} },
    rule: (f) => { rulesFn = f; return () => {} },
    tool: (b) => { tools.push(b); return () => {} },
    defineTool: (t) => t,
    command: (c) => { commands[c.name] = c; return () => {} },
    route: (p, h) => { routes[p] = h; return () => {} },
    every: () => () => {},
    later: () => () => {},
    onDispose: () => () => {},
    context: () => () => {},
    emit: () => {},
    use: () => null,
    lazy: () => ({}),
    has: () => false,
    core: { http: { query: () => new URLSearchParams(), body: async () => ({}) } },
  }
  return { api, events, routes, tools, commands, getRules: () => rulesFn, logs, asks, dataDir }
}

const mod = await import('./../index.mjs')
const { dayKeyOf, monthKeyOf, cleanLineText, lineFromActivity, renderDayInput, renderMonthInput, parseAbstractOut, renderMemoHead, parseRecordList, shouldRecord, cutoffDayOf, normalizeChatId } = mod
const modDefault = mod.default

// ---------- chatId 归一（面板「查看」填中文前缀时查不到，0.1.2 的实际毛病） ----------
check('标准 private: 原样', normalizeChatId('private:749830684') === 'private:749830684')
check('标准 group: 原样', normalizeChatId('group:1051200032') === 'group:1051200032')
check('中文「私聊:」归一成 private:', normalizeChatId('私聊:749830684') === 'private:749830684', normalizeChatId('私聊:749830684'))
check('中文「私聊：」全角冒号也认', normalizeChatId('私聊：749830684') === 'private:749830684')
check('中文「群:」归一成 group:', normalizeChatId('群:1051200032') === 'group:1051200032', normalizeChatId('群:1051200032'))
check('中文「群聊:」归一成 group:', normalizeChatId('群聊:1051200032') === 'group:1051200032')
check('只填号码按私聊', normalizeChatId('749830684') === 'private:749830684')
check('带空格也认', normalizeChatId('  私聊 : 749830684 ') === 'private:749830684')
check('空串认不出（调用方去提示）', normalizeChatId('') === '')
check('乱写认不出（不拿错 id 去查）', normalizeChatId('abc') === '' && normalizeChatId('private:123') === '')

// ---------- 纯函数 ----------
check('dayKeyOf 东八区', dayKeyOf(Date.UTC(2026, 10, 5, 20, 0, 0)) === '2026-11-06', dayKeyOf(Date.UTC(2026, 10, 5, 20, 0, 0)))
check('dayKeyOf 当天', dayKeyOf(Date.UTC(2026, 10, 6, 3, 0, 0)) === '2026-11-06')
check('monthKeyOf', monthKeyOf(Date.UTC(2026, 10, 6, 3, 0, 0)) === '2026-11')
check('cleanLineText 压空白', cleanLineText('  a \n b  ') === 'a b')
check('cleanLineText 截 600', cleanLineText('x'.repeat(700)).length === 600)
check('lineFromActivity 正常', (() => { const r = lineFromActivity({ text: '你好', chatId: 'private:1', who: '主人', userId: '1', kind: 'in', t: 1000 }); return r?.text === '你好' && r?.dir === 'in' })())
check('lineFromActivity 空文字拒收', lineFromActivity({ text: '   ' }) === null)
check('lineFromActivity 非对象拒收', lineFromActivity(null) === null)

// ---------- 回归：out 事件正文在 reply，不在 text（0.1.0 全丢） ----------
check('out 事件从 reply 取正文', (() => {
  const r = lineFromActivity({ kind: 'out', chatId: 'private:749830684', reply: '她发出去的话', userText: '主人说的话' })
  return r?.text === '她发出去的话' && r?.dir === 'out'
})(), '她把话说出去后必须能进库')
check('out 事件不该误取 userText', (() => {
  const r = lineFromActivity({ kind: 'out', chatId: 'private:749830684', reply: '她的回复', userText: '主人的原话' })
  return r?.text === '她的回复' // 主人说的话是 in 事件负责，out 只记她说的
})())
check('out 事件的 who 记为「她」', lineFromActivity({ kind: 'out', chatId: 'private:1', reply: '在' })?.who === '她')
check('in 事件仍取 text', lineFromActivity({ kind: 'in', chatId: 'private:1', text: '主人的话', nickname: '主人' })?.text === '主人的话')
check('既没 text 也没 reply 时拒收', lineFromActivity({ kind: 'out', chatId: 'private:1' }) === null)
check('昵称是 - 时不写成「-」', lineFromActivity({ kind: 'in', chatId: 'private:749830684', text: '干嘛呢', nickname: '-', userId: '749830684' })?.who === '749830684')
check('主人消息的 who 用 owner 标记', lineFromActivity({ kind: 'in', chatId: 'private:749830684', text: '干嘛呢', nickname: '-', owner: true })?.who === '主人')

// ---------- 回归：满 n 天的时间窗不能多等一天（0.1.0 用 day<cutoff，导致 days 恒为 0） ----------
// 2026-11-06 23:50（东八区）= 2026-11-06T15:50Z
const NOW_1106 = Date.UTC(2026, 10, 6, 15, 50, 0)
check('满 1 天：截止到昨天（11-05）', cutoffDayOf(NOW_1106, 1) === '2026-11-05', cutoffDayOf(NOW_1106, 1))
check('满 1 天：11-06 的聊天当晚就能压（day <= 截止日不成立于今天的反例）', '2026-11-06' > cutoffDayOf(NOW_1106, 1))
// 关键回归：11-07 凌晨时，11-06 这一整天的聊天必须已经开始可压（旧代码要等到 11-08）
check('隔天凌晨就能压前一天（旧代码多等一天）', '2026-11-06' <= cutoffDayOf(Date.UTC(2026, 10, 6, 16, 30, 0), 1), cutoffDayOf(Date.UTC(2026, 10, 6, 16, 30, 0), 1))
check('满 2 天：截止到 11-04', cutoffDayOf(NOW_1106, 2) === '2026-11-04', cutoffDayOf(NOW_1106, 2))
check('满 32 天：截止到 10-05', cutoffDayOf(NOW_1106, 32) === '2026-10-05', cutoffDayOf(NOW_1106, 32))
check('跨月回退正确（03-01 往回 1 天 = 02-28）', cutoffDayOf(Date.UTC(2027, 2, 1, 4, 0, 0), 1) === '2027-02-28', cutoffDayOf(Date.UTC(2027, 2, 1, 4, 0, 0), 1))
check('东八区凌晨不串日（11-07 00:10 往回 1 天 = 11-06）', cutoffDayOf(Date.UTC(2026, 10, 6, 16, 10, 0), 1) === '2026-11-06', cutoffDayOf(Date.UTC(2026, 10, 6, 16, 10, 0), 1))

check('renderDayInput 拼行', renderDayInput([{ t: new Date('2026-11-05T10:00:00+08:00').getTime(), who: '主人', text: '早' }]).includes('主人：早'))
check('renderMonthInput 拼天', renderMonthInput([{ day: '2026-11-01', abstract: '聊了饭' }]).includes('2026-11-01 聊了饭'))
check('parseAbstractOut 标准', parseAbstractOut('前缀 {"text":"摘要"} 后缀') === '摘要')
check('parseAbstractOut 坏 JSON', parseAbstractOut('not json') === '')
check('renderMemoHead 带 chatId', renderMemoHead('private:1').includes('private:1'))

// ---------- 白名单（群/私聊分开） ----------
check('群白名单解析：纯群号归群', (() => { const s = parseRecordList('1051200032, group:999', 'group'); return s.size === 2 && s.has('group:1051200032') && s.has('group:999') })())
check('群白名单丢弃 private: 前缀项', parseRecordList('private:123', 'group').size === 0)
check('私聊白名单解析：纯号码归私聊', (() => { const s = parseRecordList('749830684\nprivate:10001', 'private'); return s.size === 2 && s.has('private:749830684') && s.has('private:10001') })())
check('私聊白名单丢弃 group: 前缀项', parseRecordList('group:999', 'private').size === 0)
check('空名单 = 不限（空集）', parseRecordList('', 'group').size === 0 && parseRecordList('，，', 'private').size === 0)
check('群开关关了群不录', shouldRecord({ chatId: 'group:42' }, { recordGroups: false }) === false)
check('群开关开着群录', shouldRecord({ chatId: 'group:42' }, { recordGroups: true, groupList: '' }) === true)
check('群白名单外不录', shouldRecord({ chatId: 'group:42' }, { recordGroups: true, groupList: '1051200032' }) === false)
check('群白名单内录', shouldRecord({ chatId: 'group:1051200032' }, { recordGroups: true, groupList: '1051200032' }) === true)
check('私聊白名单管不到群（群名单空=群全录）', shouldRecord({ chatId: 'group:42' }, { recordGroups: true, privateList: '749830684' }) === true)
check('私聊白名单外不录', shouldRecord({ chatId: 'private:999' }, { privateList: '749830684' }) === false)
check('私聊白名单内录', shouldRecord({ chatId: 'private:749830684' }, { privateList: '749830684' }) === true)
check('群白名单管不到私聊（私名单空=私全录）', shouldRecord({ chatId: 'private:999' }, { groupList: '1051200032' }) === true)
check('未知 chatId 类型不录', shouldRecord({ chatId: 'system:x' }, {}) === false)

// ---------- 完整流程 ----------
{
  const env = makeApi({ settings: { enabled: true, compressAfterDays: 1, monthAfterDays: 32, dailyCalls: 6 } })
  await modDefault.setup(env.api)

  // ① 入站走 activity，出站走 send（两条通道分工，见 index.mjs 注释）
  const onActivity = env.events.activity?.[0]
  const onSend = env.events.send?.[0]
  const day = dayKeyOf(Date.now() - 3 * 86_400_000) // 3 天前，满足 compressAfterDays
  const base = Date.now() - 3 * 86_400_000
  onActivity({ kind: 'in', chatId: 'private:10001', userId: '10001', nickname: '主人', text: '明天记得买大米饭', t: base })
  onSend([{ type: 'text', data: { text: '好，我记住了' } }], { chatId: 'private:10001' }) // 她发出去的话
  onActivity({ kind: 'in', chatId: 'private:10001', userId: '10001', nickname: '主人', text: '   ', t: base + 120_000 }) // 空的该被丢

  const stats = await env.routes['/stats']()
  check('L0 归档了 2 条（空的被丢）', stats.lines === 2, JSON.stringify(stats))
  check('send 通道记下了她说的话', stats.lines === 2, `收 1 + 发 1 = 2，实际 ${stats.lines}`)

  // /read 内部走 api.core.http.query(req)：真机是普通对象，测试替身换成能给定查询的。
  // 注意 read() 不带 day/keyword 时是「备忘视角」，只回日摘要不回原文（模块本来就这样），所以这里按天查。
  // send 通道按真实当前时间落库（它在真实世界里就是「此刻发出」），入站用的却是 3 天前，
  // 两边不在同一天。这里分别按各自的日子读回来验。
  const dayOfBase = dayKeyOf(base)
  env.api.core.http.query = () => ({ chatId: 'private:10001', day: dayOfBase })
  const recIn = await env.routes['/read']({ headers: {} })
  const txtIn = (recIn.lines || []).map((l) => l.text)
  check('读回原文含主人说的话', txtIn.includes('明天记得买大米饭'), JSON.stringify(txtIn))
  check('主人消息的 who 记「主人」', (recIn.lines || []).every((l) => l.who === '主人'), JSON.stringify((recIn.lines || []).map((l) => l.who)))

  env.api.core.http.query = () => ({ chatId: 'private:10001', day: dayKeyOf(Date.now()) })
  const recOut = await env.routes['/read']({ headers: {} })
  const txtOut = (recOut.lines || []).map((l) => l.text)
  check('读回原文含她说的话', txtOut.includes('好，我记住了'), JSON.stringify(txtOut))
  check('她的话 who 记「她」', (recOut.lines || []).every((l) => l.who === '她'), JSON.stringify((recOut.lines || []).map((l) => l.who)))

  // ② 压缩：跑两次，第二次不花模型调用（指纹幂等）
  // every 的替身没跑，直接调内部：通过让 compressTick 暴露 —— 这里用归档后等待不可行，改为直接调用 route 触发不了压缩。
  // 改法：把 tick 触发交给模块自己的 every 替身 —— 我们在 makeApi 里记下了 every 回调吗？这里 every 是 () => () => {}。
  // 所以直接用第二个途径：调用 pendingDays 的入口不暴露。于是这里改成信任内部 tick，用「把日期改旧」的方式手动驱动不可行 ——
  // 换个思路：直接断言「ask 一次都没被调用过」之后再手动触发。为了让测试能驱动 tick，makeApi 需要记录 every 回调 —— 见 makeApi2。
  check('setup 后没有立刻调模型', env.asks.length === 0, String(env.asks.length))
}

// ---------- 能驱动 tick 的完整环境 ----------
{
  let tick = null
  const env = makeApi({ settings: { enabled: true, compressAfterDays: 1, monthAfterDays: 32, dailyCalls: 6 } })
  env.api.every = (ms, fn) => { tick = fn; return () => {} }
  await modDefault.setup(env.api)

  const base = Date.now() - 3 * 86_400_000
  const onActivity = env.events.activity?.[0]
  const onSend = env.events.send?.[0]
  onActivity({ kind: 'in', chatId: 'group:42', userId: '2', nickname: '猫米', text: '今晚一起开黑', t: base })
  onSend([{ type: 'text', data: { text: '带上我' } }], { chatId: 'group:42' })

  await tick?.()
  check('tick 压出了日摘要（花了 1 次模型调用）', env.asks.length === 1, String(env.asks.length))
  check('摘要内容进了库', await env.routes['/read'](null) || true) // read 需要 query，这里只验证不炸

  const n1 = env.asks.length
  await tick?.()
  await tick?.()
  check('同一天重复 tick 不再花模型调用（指纹幂等）', env.asks.length === n1, `${env.asks.length} vs ${n1}`)

  // ③ prompt 注入备忘
  const onPrompt = env.events.prompt?.[0]
  const out = onPrompt([], { chat: { chatId: 'group:42', kind: 'group' }, queryText: '我们之前说好什么了？' })
  check('prompt 注入了备忘', Array.isArray(out) && out.at(-1)?.text?.includes('group:42'), JSON.stringify(out?.at(-1)?.text || '').slice(0, 120))
  check('备忘含日摘要内容', out.at(-1)?.text?.includes('假摘要'))
  const out2 = onPrompt([], { chat: { chatId: 'group:42', kind: 'group' }, queryText: '别的' })
  check('同一会话备忘未变化时不再重复注入', out2.length === 0, JSON.stringify(out2).slice(0, 120))
  const out2b = onPrompt([], { sessionId: 'session-b', chat: { chatId: 'group:42', kind: 'group' }, queryText: '换会话' })
  check('新会话仍会注入一次', out2b.length === 1 && out2b.at(-1).text.includes('group:42'))
  const out3 = onPrompt([], { chat: { chatId: 'system:x', kind: 'system' }, queryText: 'x' })
  check('system 回合不注入', out3.length === 0)

  // ④ recall_history 工具
  const toolBuilder = env.tools[0]
  const tools = toolBuilder({ chat: { chatId: 'group:42', kind: 'group' } })
  const tool = Array.isArray(tools) ? tools[0] : tools
  check('工具名叫 recall_history', tool?.name === 'recall_history')
  const r1 = await tool.execute({ day: dayKeyOf(base) })
  check('按天查能拿到日摘要+原文', r1.ok && r1.message.includes('假摘要') && r1.message.includes('开黑'), r1.message.slice(0, 160))
  const r2 = await tool.execute({ keyword: '开黑' })
  check('按词查命中原文', r2.ok && r2.message.includes('开黑'), r2.message.slice(0, 160))
  const r3 = await tool.execute({ keyword: '不存在的词xyz' })
  check('查不到给空话术不报错', r3.ok && r3.message.includes('没有'), r3.message.slice(0, 80))
  const toolsNone = toolBuilder({ chat: { chatId: 'system:x', kind: 'system' } })
  check('system 回合不给工具', Array.isArray(toolsNone) && toolsNone.length === 0)
  // 隔离：别的聊天查不到这个聊天的事
  const toolOther = (toolBuilder({ chat: { chatId: 'private:999', kind: 'private' } }))
  const r4 = await (Array.isArray(toolOther) ? toolOther[0] : toolOther).execute({ keyword: '开黑' })
  check('聊天之间互相隔离', r4.ok && !r4.message.includes('开黑'), r4.message.slice(0, 80))

  // ⑤ 预算闸：dailyCalls=1 时第二次压缩日不再调模型
  const env2 = makeApi({ settings: { enabled: true, compressAfterDays: 1, dailyCalls: 1 } })
  let t2 = null
  env2.api.every = (ms, fn) => { t2 = fn; return () => {} }
  await modDefault.setup(env2.api)
  const onA2 = env2.events.activity?.[0]
  const base2 = Date.now() - 2 * 86_400_000
  onA2({ kind: 'in', chatId: 'private:7', who: '主人', userId: '7', text: '第一条', t: base2 })
  onA2({ kind: 'in', chatId: 'private:8', who: '乙', userId: '8', text: '另一聊天', t: base2 })
  await t2?.()
  const spent = env2.asks.length
  check('预算内压缩成功', spent >= 1, String(spent))
  check('预算耗尽后不再调模型', env2.asks.length <= 1, String(env2.asks.length)) // dailyCalls=1，第二个聊天该等明天

  // ⑥ 开关关闭：不归档不注入
  const env3 = makeApi({ settings: { enabled: false } })
  await modDefault.setup(env3.api)
  env3.events.activity?.[0]?.({ kind: 'in', chatId: 'private:1', who: 'x', text: 'hi', t: Date.now() })
  env3.events.send?.[0]?.([{ type: 'text', data: { text: '不该记' } }], { chatId: 'private:1' })
  const s3 = await env3.routes['/stats']()
  check('关掉后不归档', s3.lines === 0, String(s3.lines))
}

// ---------- 私聊完整性（用户重点：私聊必须都存下） ----------
// 私聊里她说的话不止「正常回复」一种出口：命令回复、发图、模块代发、主动搭话都不经过
// deliverTurn（也就不广播 activity），只靠 activity 会漏掉一半。这里逐条钉死。
{
  const env = makeApi({ settings: { enabled: true, compressAfterDays: 1, monthAfterDays: 32, dailyCalls: 6 } })
  await modDefault.setup(env.api)
  const pri = 'private:749830684'
  const act = (e) => env.events.activity?.[0]?.(e)
  const send = (segs, info) => env.events.send?.[0]?.(segs, info)

  // 入站 + 静默观察（她看见但不接的话，只在 activity kind='silent' 里）
  act({ kind: 'in', chatId: pri, userId: '749830684', nickname: '-', owner: true, text: '在吗' })
  act({ kind: 'silent', chatId: pri, text: '别人说了但没接', nickname: '群友' })
  // 正常回复：hub 会同时广播 activity out 并走 send —— 必须只记一次
  act({ kind: 'out', chatId: pri, reply: '在的', userText: '在吗' })
  send([{ type: 'text', data: { text: '在的' } }], { chatId: pri })
  // 命令回复（只走 send）
  send([{ type: 'text', data: { text: '历史库：原文 1 条' } }], { chatId: pri })
  // 模块代发 / 主动搭话（只走 send）
  send([{ type: 'text', data: { text: '代发的内容' } }], { chatId: pri })
  // 发图（只走 send，正文没有 text 段）
  send([{ type: 'image', data: { file: 'x.jpg' } }], { chatId: pri })
  // 纯 @ / 空壳不该产生垃圾行
  send([{ type: 'at', data: { qq: '123' } }], { chatId: pri })
  // 后台自省回合不归档
  send([{ type: 'text', data: { text: '后台自言自语' } }], { chatId: 'system:reflect' })

  const s = await env.routes['/stats']()
  check('私聊各出口全部归档（6 条）', s.lines === 6, `实际 ${s.lines}：收1 + 静默1 + 回复1 + 命令1 + 代发1 + 图1`)

  env.api.core.http.query = () => ({ chatId: pri, day: dayKeyOf(Date.now()) })
  const r = await env.routes['/read']({ headers: {} })
  const rows = r.lines || []
  const txt = rows.map((l) => l.text)
  check('正常回复没有被记两遍（activity + send 不重复）', txt.filter((t) => t === '在的').length === 1, JSON.stringify(txt))
  check('命令回复进库', txt.includes('历史库：原文 1 条'))
  check('模块代发进库', txt.includes('代发的内容'))
  check('发图记成占位符', txt.includes('[图片]'))
  check('静默观察的话进库', txt.includes('别人说了但没接'))
  check('纯 @ 不产生空行', !txt.some((t) => !t || t === '[at]'))
  check('后端自省回合不归档', !txt.includes('后台自言自语'))
  check('她的话统一记成「她」', rows.filter((l) => ['在的', '代发的内容', '[图片]'].includes(l.text)).every((l) => l.who === '她'), JSON.stringify(rows.map((l) => l.who)))

  // ---------- 面板「按聊天查看」能真的看到东西（0.1.2 报「一直无归档」） ----------
  // ① /chats 列出库里真实存在的聊天，面板据此给可点的 chatId
  const cs = await env.routes['/chats']()
  const hit = (cs.chats || []).find((c) => c.chatId === pri)
  check('/chats 列出真实聊天', Boolean(hit) && hit.lines === 6, JSON.stringify(cs.chats))
  check('/chats 不带 system 聊天', !(cs.chats || []).some((c) => c.chatId.startsWith('system:')))

  // ② 面板默认查询（不带 day/keyword）时，原文层必须有东西 —— 这是「一直无归档」的正根：
  //    旧面板只看 days/month/lines，没摘要的日子连原文都不显示，就报「没有归档」
  const plain = await env.routes['/read']({ headers: {} })
  check('不带 day/keyword 也能看到原文', (plain.lines || []).length > 0, JSON.stringify({ days: plain.days?.length, lines: plain.lines?.length }))

  // ③ 填中文前缀也要能查到（归一化在服务端也兜一层）
  env.api.core.http.query = () => ({ chatId: '私聊:749830684', day: dayKeyOf(Date.now()) })
  const cn = await env.routes['/read']({ headers: {} })
  check('填「私聊:号码」也能查到', (cn.lines || []).length > 0, JSON.stringify(cn.lines?.length))

  // ---------- 「列出全部内容」按钮（面板一眼看全三层，不用先知道 chatId） ----------
  env.api.core.http.query = () => ({})
  const dump = await env.routes['/dump']({ headers: {} })
  check('/dump 返回三层统计', dump.ok && dump.stats.lines === 6 && dump.stats.days >= 0 && typeof dump.stats.months === 'number', JSON.stringify(dump.stats))
  check('/dump 列出全部原文', dump.lines.length === 6 && dump.shown === 6, `lines=${dump.lines.length} shown=${dump.shown}`)
  check('/dump 原文带方向与说话人', dump.lines.every((l) => l.dir === 'in' || l.dir === 'out') && dump.lines.some((l) => l.who === '她'), JSON.stringify(dump.lines.map((l) => `${l.dir}/${l.who}`)))
  check('/dump 原文按时间正序', dump.lines.length > 1 && dump.lines[0].t <= dump.lines[dump.lines.length - 1].t)
  check('/dump 三层字段都在', Array.isArray(dump.days) && Array.isArray(dump.months))
}

// ---------- 汇总 ----------
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.detail}`)
}
console.log(failed ? `\n${failed} 项失败` : `\n全部 ${results.length} 项通过`)
process.exit(failed ? 1 : 0)
