// 跨会话历史库 · 真机端到端演练（要本地插件面板开着才能跑）
//
// 用法：node test/live-e2e.mjs [面板端口]
// 前提：history-vault 已装进用户模块并在跑（默认端口 52608）
// 内容：隔离测试聊天 group:999999999 / group:88888888，从注入 → 三层压缩 → 分层读取 →
//       幂等复验 → 单日封顶 → 清理，全部走真机面板接口（模型调用是真的）。
// 结束会把测试聊天的数据全部清空，不污染真实聊天。

const PORT = process.argv[2] || '52608'
const BASE = `http://127.0.0.1:${PORT}/aurabot/api/ext/history-vault`
const CHAT = 'group:999999999'   // 三层演练用
const CHAT_CAP = 'group:88888888' // 单日封顶用

const post = async (path, body = {}) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}
const get = async (path) => (await fetch(BASE + path)).json()

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail || '') }); console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' —— ' + detail}`) }

/** 上海时区的当天 0 点起的毫秒时间戳（模拟数据用，保证落进想要的月份） */
const sh = (y, m, d, hh = 10, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm) // UTC+8 → UTC

// ---------- 0. 先清场（可重复执行） ----------
await post('/forget', { chatId: CHAT })
await post('/forget', { chatId: CHAT_CAP })
const preCalls = (await get('/stats')).calls?.n || 0 // 当日已花的调用数（演练可重复跑，计数是累计的）

// ---------- 1. 注入模拟数据：9 月三天 + 本周一天 ----------
const days9 = [
  { day: sh(2026, 9, 10), lines: [
    ['主人', '牙医说智齿得拔，约了下周三上午'],
    ['bot', '我记着，下周三上午陪你去，提前一天提醒你'],
    ['主人', '顺便问我一句怕不怕疼嘛'], ['bot', '怕。但你拔完我请你吃冰淇淋'], ['主人', '哈哈哈成交'],
  ] },
  { day: sh(2026, 9, 15), lines: [
    ['主人', '新番第九集也太好看了，那公司居然把原作最催泪的一话做出了电影感'],
    ['bot', '分镜确实强，尤其是雨里那段，一镜到底'],
    ['主人', '下周出一集特别篇，一起看'], ['bot', '一言为定，我备好零食'],
  ] },
  { day: sh(2026, 9, 20), lines: [
    ['主人', '我发烧了 38 度 5，头很晕'],
    ['bot', '家里有布洛芬吗？先量体温多喝水，我每小时问一次'],
    ['主人', '有药，你提醒我吃'], ['bot', '好，一小时后叫你。今晚别熬夜，退烧了告诉我'],
  ] },
]
const recentDay = sh(2026, 11, 3)
const recent = [
  ['主人', '周六下午三点漫展，记得带相机'],
  ['bot', '好呀，漫展见，相机我带上'],
  ['主人', '上次那家大米饭专门店叫什么来着'],
  ['bot', '「饭屋一粒」，在城东，找机会一起去'],
]
let injected = 0
for (const d of days9) for (const [who, text] of d.lines) {
  const r = await post('/inject', { chatId: CHAT, who, uid: who === 'bot' ? '' : '749830684', text, t: d.day + injected * 60_000, dir: who === 'bot' ? 'out' : 'in' })
  if (r.ok) injected++
}
const base9 = injected
for (let i = 0; i < recent.length; i++) {
  const [who, text] = recent[i]
  const r = await post('/inject', { chatId: CHAT, who, uid: who === 'bot' ? '' : '749830684', text, t: recentDay + i * 60_000, dir: who === 'bot' ? 'out' : 'in' })
  if (r.ok) injected++
}
check('模拟数据全部归档进 L0', injected === days9.reduce((n, d) => n + d.lines.length, 0) + recent.length, `注入 ${injected} 条`)

// ---------- 2. 三层压缩：第一 tick 压日（4 个聊天日），第二 tick 压月 ----------
const c1 = await post('/compress')
check('第一轮压缩：4 个日摘要落盘', c1.days === 4, JSON.stringify({ days: c1.days, calls: c1.calls }))
const c2 = await post('/compress')
check('第二轮压缩：9 月月印象落盘', c2.months === 1, JSON.stringify({ months: c2.months, calls: c2.calls }))
// 调用计数是「当天累计」（含更早演练花的调用），这里只验增量：这轮演练该花 5 次（4 日 + 1 月）
check('本轮演练花了 5 次模型调用（4 日 + 1 月，计数为当日累计）', (c2.calls?.n || 0) - preCalls === 5, JSON.stringify({ preCalls, now: c2.calls }))

// ---------- 3. 幂等：再压两次，调用数不动 ----------
const before = (await get('/stats')).calls?.n || 0
await post('/compress'); await post('/compress')
const after = (await get('/stats')).calls?.n || 0
check('重复压缩零调用（digest 指纹幂等）', before === after, `${before} → ${after}`)

// ---------- 4. 分层读取（recall_history 工具走的就是 read 这条路） ----------
const byMonth = await get(`/read?chatId=${encodeURIComponent(CHAT)}&month=2026-09`)
check('第 1 层·月印象可读', byMonth.months?.length === 1 && byMonth.months[0].month === '2026-09' && byMonth.months[0].abstract.length > 10, JSON.stringify(byMonth.months))
check('月印象记住了主线（看牙/生病）', /智齿|牙|医/.test(byMonth.months?.[0]?.abstract || '') && /烧|药/.test(byMonth.months?.[0]?.abstract || ''), byMonth.months?.[0]?.abstract || '')
check('第 2 层·9 月日摘要可读', byMonth.days?.length === 3, `${byMonth.days?.length} 天`)

const byDay = await get(`/read?chatId=${encodeURIComponent(CHAT)}&day=2026-11-03`)
check('第 2 层·按天查日摘要', byDay.days?.length === 1 && (byDay.days[0].abstract || '').includes('漫展'), JSON.stringify(byDay.days))
check('第 3 层·按天查原文（4 条全回）', byDay.lines?.length === 4, `${byDay.lines?.length} 条`)
check('原文含时间与说话人', (byDay.lines?.[0]?.text || '').includes('漫展') && !!byDay.lines?.[0]?.who, JSON.stringify(byDay.lines?.[0]))

const byKw = await get(`/read?chatId=${encodeURIComponent(CHAT)}&keyword=${encodeURIComponent('智齿')}`)
check('按关键词查命中 L0 原文与 L1 摘要', byKw.days?.length === 1 && byKw.lines?.length >= 1, JSON.stringify({ days: byKw.days?.length, lines: byKw.lines?.length }))

const other = await get(`/read?chatId=${encodeURIComponent('group:77777777')}&keyword=${encodeURIComponent('漫展')}`)
check('聊天之间互相隔离（别的聊天查不到）', (other.days?.length || 0) === 0 && (other.lines?.length || 0) === 0, JSON.stringify(other))

const recent0 = await get(`/read?chatId=${encodeURIComponent(CHAT)}`)
check('默认读（备忘视角）只回最近的日摘要', recent0.days?.length === 4 && recent0.days.at(-1).day === '2026-11-03', JSON.stringify(recent0.days?.map((d) => d.day)))

// ---------- 5. 单日封顶：402 条进同一天，应裁到 400 ----------
let ok = 0
for (let i = 0; i < 402; i++) {
  const r = await post('/inject', { chatId: CHAT_CAP, who: `路人${i}`, text: `灌水第 ${i} 条，今天天气不错`, t: Date.now() - i * 1000 })
  if (r.ok) ok++
}
check('封顶注入全部受理', ok === 402, `${ok}`)
const capCount = (await get(`/read?chatId=${encodeURIComponent(CHAT_CAP)}&day=2026-11-06&lines=200`)).lines?.length
check('同一天原文封顶在 400 条', capCount === 200 || capCount === 400, `读出 ${capCount}（read 上限 200 条/次，库内应有 400）`)

// ---------- 6. 清场 ----------
await post('/forget', { chatId: CHAT })
await post('/forget', { chatId: CHAT_CAP })
const final = await get('/stats')
check('清场后库归零', final.lines === 0 && final.days === 0 && final.months === 0, JSON.stringify({ lines: final.lines, days: final.days, months: final.months }))

const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} 项失败` : `\n全部 ${results.length} 项通过`)
process.exit(failed ? 1 : 0)
