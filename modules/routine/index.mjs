// routine 作息：她一天里的骨架。上班/上学、通勤、在家休息、请假调休，都由这张表判定。
// 职责边界刻意做薄：这里只回答「她现在是什么处境」，不做事件池、不做决策建模——
// 处境通过 api.context 注入（只描述、不下指令），行为让她自己演。
// 和 livin 的接法是零侵入：只在状态切换沿拨 ext.livin.enabled，到家了才让过日子醒来。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROFESSIONS, weekIdxOf, goodsOf } from './professions.mjs'
import { newTask, willSlack, willGoOut, newOuting, doWork, doSlack, goOut, backHome, stayHome, taskFailed } from './plan.mjs'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const DEFAULTS = {
  enabled: false, // 托管总开关：关了就不注入、不碰 livin，装上不动
  profession: 'office', // 职业：决定每周班表模板和上班时的处境描述，面板里换
  pressureOn: true, // 压力值：工作日累积、休息恢复，攒满会自动请假
  pressurePerWorkDay: 10, // 每个完整上班日 +多少压力
  pressureRecover: 15, // 每个休息日 -多少压力
  pressureLeaveRecover: 25, // 请假那天额外再 -多少
  pressureThreshold: 80, // 压力到这个数，第二天自动请假
  commuteMin: 30, // 班段开始前多少分钟算通勤
  quietStart: 1, // 睡觉时段（点），只影响注入和状态判定，livin 那边有自己的睡觉闸
  quietEnd: 8,
  planOn: true, // 她自己拿主意：上班摸鱼还是干活、放假出门还是在家
  planIntervalMin: 30, // 多久做一次决定（分钟）
  planShareChance: 25, // 决定完主动跟主人说一声的概率（%）
  taskOn: true, // 上班时手上有具体的活：按职业生成，有截止时间，拖过头会被说
  tasksPerDay: 2, // 每天几条活
  taskHours: 3, // 每条活大概多久到期（会随机浮动）
}

// 默认班表：周一到五 9 点到 6 点，周末休。这是底座，面板里随时改。
const DEFAULT_WEEK = {
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '18:00']],
  sat: [],
  sun: [],
}

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
const addDays = (t, n) => t + n * DAY
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const toMin = (s) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : -1 }
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const minsOf = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes() }
const inQuiet = (t, c) => { const h = new Date(t).getHours(); return c.quietStart <= c.quietEnd ? (h >= c.quietStart && h < c.quietEnd) : (h >= c.quietStart || h < c.quietEnd) }

// 「今天/明天/后天/YYYY-MM-DD」→ dayKey；解析不出来返回 ''
export function parseDay(s, now) {
  const t = String(s || '').trim()
  if (!t) return ''
  if (t === '今天') return dayKey(now)
  if (t === '明天') return dayKey(addDays(now, 1))
  if (t === '后天') return dayKey(addDays(now, 2))
  const m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return `${Number(m[1])}-${Number(m[2])}-${Number(m[3])}`
  return ''
}

// 判「休息/在家」的口径：rest（休息日）、leave（请假）、home 的非班段，livin 都开
const LIVIN_ON = new Set(['rest', 'leave', 'home'])

export default {
  id: 'routine',
  name: '作息',
  version: '1.2.1',
  api: 1,
  category: 'desktop',
  tags: ['作息', '上下班', '生活', '职业', '自主'],
  description: '她的一天的骨架：十一种职业班表（含三班倒/夜班/双班）、通勤、在家休息、请假调休。上班是干活还是摸鱼、放假是出门还是在家，都由她自己定（默认半小时决定一次）；上班时手上有按职业生成的活，有截止时间，拖过头会被主管说，影响心情。只有「在家休息」的时段才让过日子醒来；上班时间注入「此刻处境」，让她自然知道自己在忙什么班。',
  capabilities: ['filesystem', 'plugin-config', 'plugin-internals'],
  minPluginVersion: '1.2.0',
  requires: [],
  license: 'MIT',
  author: 'Ariz0324',

  defaults: DEFAULTS,
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用作息托管', type: 'switch', hint: '开了才注入「此刻处境」、才会按作息控制过日子开关' },
    { key: 'pressureOn', label: '压力值', type: 'switch', hint: '工作日累积、休息恢复，攒满会自动请假在家缓一天' },
    { key: 'pressureThreshold', label: '压力请假阈值', type: 'number', min: 40, max: 100, step: 5 },
    { key: 'pressurePerWorkDay', label: '每个上班日累积压力', type: 'number', min: 2, max: 30, step: 1 },
    { key: 'pressureRecover', label: '每个休息日恢复压力', type: 'number', min: 2, max: 40, step: 1 },
    { key: 'pressureLeaveRecover', label: '请假当天额外恢复', type: 'number', min: 5, max: 60, step: 5 },
    { key: 'commuteMin', label: '通勤时长（分钟）', type: 'number', min: 0, max: 120, step: 5 },
    { key: 'quietStart', label: '睡觉时段从（点）', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'quietEnd', label: '睡觉时段到（点）', type: 'number', min: 1, max: 24, step: 1 },
    { key: 'planOn', label: '让她自己拿主意', type: 'switch', hint: '上班摸鱼还是干活、放假出门还是在家，都由她自己定' },
    { key: 'planIntervalMin', label: '多久做一次决定（分钟）', type: 'number', min: 10, max: 180, step: 5 },
    { key: 'planShareChance', label: '决定完主动说一声的概率（%）', type: 'number', min: 0, max: 100, step: 5, hint: '不是每次都汇报，偶尔冒一句更像人' },
    { key: 'taskOn', label: '上班有具体的活', type: 'switch', hint: '按职业随机生成，有截止时间；拖过头会被主管说，心情会受影响' },
    { key: 'tasksPerDay', label: '每天几条活', type: 'number', min: 1, max: 5, step: 1 },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const dir = api.dataDir()
    mkdirSync(dir, { recursive: true })
    const stateFile = () => join(dir, 'routine.json')
    const schedFile = () => join(dir, 'schedule.json')

    // ---------- 班表：底座在 schedule.json，改动走面板；不存在就落一份默认 ----------
    const loadSchedule = () => {
      try {
        const raw = JSON.parse(readFileSync(schedFile(), 'utf8')) || {}
        raw.week = { ...DEFAULT_WEEK, ...(raw.week || {}) }
        return raw
      } catch {
        const fresh = { week: JSON.parse(JSON.stringify(DEFAULT_WEEK)) }
        try { writeJson(schedFile(), fresh) } catch {}
        return fresh
      }
    }
    const writeJson = (f, v) => {
      try {
        const tmp = `${f}.tmp`
        writeFileSync(tmp, JSON.stringify(v, null, 1) + '\n', 'utf8')
        renameSync(tmp, f)
      } catch (e) { api.log.warn?.(`[routine] 写 ${f} 失败：${e.message}`) }
    }
    let sched = loadSchedule()

    // ---------- 状态一本账：托管判定历史 + 自记日程 + 扰动 + 压力 ----------
    const load = () => {
      try {
        const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) || {}
        raw.history ||= []
        raw.self ||= [] // 她自己记的日程 {id, day, start, end, kind:'busy'|'off', what}
        raw.disturb ||= [] // 每周日生成的下周扰动 {id, day, type, segments, note}
        raw.overrides ||= {} // 最高优先级 { 'YYYY-MM-DD': {type:'leave', note} }
        raw.pressure = Number.isFinite(raw.pressure) ? raw.pressure : 0
        raw.day ||= ''
        raw.current ||= { state: 'home', since: Date.now() }
        raw.lastLivinWrite ||= 0
        raw.managedOn = !!raw.managedOn
        raw.plan ||= emptyPlan() // 她自己拿主意：今天的活、出门、日志
        return raw
      } catch {
        return { history: [], self: [], disturb: [], overrides: {}, pressure: 0, day: dayKey(Date.now()), current: { state: 'home', since: Date.now() }, lastLivinWrite: 0, plan: emptyPlan() }
      }
    }
    const emptyPlan = () => ({ day: '', log: [], tasks: [], outing: null, lastAt: 0, lastShareAt: 0, homeAt: 0, livinOff: false })
    let st = load()
    const save = () => writeJson(stateFile(), st)
    const record = (event, extra = {}) => {
      st.history.push({ at: Date.now(), event, ...extra })
      st.history = st.history.filter((h) => Date.now() - h.at < 7 * DAY).slice(-500)
    }

    // ---------- 三层日程：overrides(请假/手动) > disturb(周日扰动) > self(她记的) > week(底座) ----------
    const segsFrom = (list) => (Array.isArray(list) ? list.map((s) => [toMin(s[0]), toMin(s[1])]).filter((s) => s[0] >= 0 && s[1] >= 0 && s[1] !== s[0]) : [])
    // 结束 < 开始 = 跨午夜的夜班段（23:00-07:00），合法，别过滤掉

    // ---------- 职业：班表模板 + 轮班同步 ----------
    const profOf = () => PROFESSIONS[cfg().profession] || PROFESSIONS.office
    // 按职业同步 sched.week：切了职业（pendingProf）或轮班周序号变了就重排；
    // 用户手动改过班表（weekSource='custom'）后轮换暂停，直到再切一次职业
    function applyProfession(now) {
      const prof = profOf()
      const id = cfg().profession || 'office'
      const idx = prof.rot ? ((weekIdxOf(now) % prof.rot.cycle) + prof.rot.cycle) % prof.rot.cycle : 0
      const wanted = prof.rot ? `${id}#${idx}` : id
      if (sched.pendingProf) { sched.pendingProf = false; sched.weekSource = '' }
      if (sched.weekSource === 'custom') return
      if (sched.weekSource !== wanted) {
        sched.week = JSON.parse(JSON.stringify(prof.rot ? prof.rot.variants[idx] : prof.week))
        sched.weekSource = wanted
        writeJson(schedFile(), sched)
        record('profession', { prof: prof.name, shift: prof.rot ? `第 ${idx + 1}/${prof.rot.cycle} 轮班` : '' })
        api.log.info(`[routine] 职业班表同步：${prof.name}${prof.rot ? `（${prof.rot.variants[idx] === prof.week ? '' : '轮班 ' + (idx + 1) + '/' + prof.rot.cycle}）` : ''}`)
      }
    }

    function resolveDay(day, now) {
      const ov = st.overrides[day]
      if (ov) return { type: ov.type, segments: ov.segments ? segsFrom(ov.segments) : [], note: ov.note || '', src: 'override' }
      const dist = st.disturb.find((d) => d.day === day)
      if (dist) return { type: dist.type, segments: segsFrom(dist.segments || []), note: dist.note || '', src: 'disturb' }
      const self = st.self.filter((e) => e.day === day)
      const offEv = self.find((e) => e.kind === 'off')
      if (offEv) return { type: 'rest', segments: [], note: self.map((e) => e.what).join('、'), src: 'self' }
      const busyEv = self.find((e) => e.kind === 'busy')
      if (busyEv && (busyEv.start || busyEv.end)) {
        return { type: 'work', segments: segsFrom([[busyEv.start || '00:00', busyEv.end || '23:59']]), note: busyEv.what, src: 'self' }
      }
      const dow = DOW[new Date(now.getFullYear(), now.getMonth(), now.getDate()).getDay()]
      const week = sched.week[dow] || []
      const segments = segsFrom(week)
      return { type: segments.length ? 'work' : 'rest', segments, note: '', src: 'week' }
    }

    // 核心判定：给定时刻，她在什么处境。纯函数（读 st/sched/cfg），测试直接调。
    // 判定顺序刻意是：班段（含跨午夜延续）> 通勤 > 睡觉 > 休息/请假 > 班间/下班——
    // 夜班（0-8 点、23-7 点）压过睡觉时段，凌晨三点在班上就是在班上，不是睡觉。
    function stateAt(now) {
      const c = cfg()
      const d = new Date(now)
      const mins = minsOf(now)
      const cm = Number(c.commuteMin) || 0
      const inSeg = (segs) => {
        for (const [a, b] of segs) {
          if (a < b ? (mins >= a && mins < b) : (mins >= a || mins < b)) return [a, b]
        }
        return null
      }
      const day = dayKey(now)
      const desc = resolveDay(day, d)
      const prof = profOf()
      const flavor = prof.goods ? `，在卖${goodsOf(prof, day)}` : ''

      // 班段内（夜班的跨午夜段：结束 < 开始）
      let seg = null
      if (desc.type === 'work') seg = inSeg(desc.segments)
      // 前一天的跨午夜班段延续到今天凌晨（保安周五 23:00-07:00，周六凌晨 3 点还在班上）
      if (!seg) {
        const prev = resolveDay(dayKey(now - DAY), new Date(now - DAY))
        if (prev.type === 'work') {
          for (const [a, b] of prev.segments) {
            if (a > b && mins < b) { seg = [a, b]; break }
          }
        }
      }
      if (seg) {
        // 夜班 = 跨午夜段，或凌晨（6 点前）开班的段；早读 7:30-12:00、周六半天门诊这种「结束在中午前」的班不是夜班
        const night = seg[0] > seg[1] || seg[0] < 6 * 60
        return {
          state: 'work',
          label: `${night ? '夜班中' : (prof.w?.on || '上班中')}（${fmtMin(seg[0])}–${fmtMin(seg[1])}${flavor}）`,
          night,
          livin: false,
          day: desc,
          seg,
        }
      }
      // 通勤：班段开始前 cm 分钟（只看当天不跨夜的班段，夜班 0 点开班的通勤算前一晚，这里不追）
      if (desc.type === 'work' && cm > 0) {
        for (const [a, b] of desc.segments) {
          if (a > b) continue
          if (mins >= a - cm && mins < a) return { state: 'commute', label: `在通勤路上（${fmtMin(a)}出门${flavor}）`, livin: false, day: desc, seg: [a, b] }
        }
      }
      if (inQuiet(now, c)) return { state: 'sleep', label: '睡觉中', livin: false, day: null, seg: null }
      if (desc.type === 'rest') return { state: 'home', label: '休息日，在家', livin: true, day: desc, seg: null }
      if (desc.type === 'leave') return { state: 'home', label: '请假在家', livin: true, day: desc, seg: null }
      // 上班日但不在班段里
      const segs = desc.segments
      const first = segs[0]
      const last = segs[segs.length - 1]
      if (first && mins < first[0]) return { state: 'home', label: '还没出门，在家', livin: true, day: desc, seg: null }
      if (last && last[0] < last[1] && mins >= last[1]) {
        // 最后一段是夜班（跨午夜判定见上，凌晨开班也算）：早上这段时间在补觉
        if ((last[0] > last[1] || last[0] < 6 * 60) && mins < last[1] + 4 * HOUR / MIN) return { state: 'home', label: '下夜班了，在家补觉', livin: true, day: desc, seg: null }
        return { state: 'home', label: `${prof.w?.back || '下班到家了'}，今晚是自己的时间`, livin: true, day: desc, seg: null }
      }
      // 两班之间的空档（餐饮午市结束到晚市开始）
      return { state: 'home', label: `${prof.w?.gap || '班间休息'}，这一小段是自己的`, livin: true, day: desc, seg: null }
    }

    // ---------- livin 开关：只在状态切换沿写，写之前先看现在是不是已经是那个值 ----------
    // 手动在面板关掉 livin 时，同一个状态内 routine 不会抢回来——到下一个状态沿才纠正。
    function applyLivin(res, now) {
      if (!cfg().enabled) return
      const cur = st.current
      const edge = cur.state !== res.state
      if (!edge) return
      const desired = res.livin === true
      try {
        const ext = api.config().ext || {}
        const nowOn = !!(ext.livin && ext.livin.enabled)
        if (nowOn !== desired) {
          api.setConfig({ ext: { livin: { enabled: desired } } })
          st.lastLivinWrite = now
          record('livin', { to: desired ? '开' : '关', why: res.label })
          api.log.info(`[routine] 状态沿 ${cur.state}→${res.state}，livin ${desired ? '开' : '关'}`)
        } else {
          record('livin', { to: desired ? '开(已是)' : '关(已是)', why: res.label })
          save()
        }
      } catch (e) { api.log.warn?.(`[routine] 拨 livin 开关失败：${e.message}`) }
    }

    // ---------- 压力：跨天结账 + 攒满自动请假 ----------
    function rollDay(now) {
      const today = dayKey(now)
      if (st.day === today) return false
      const c = cfg()
      // 结昨天的账：上班日攒压力，休息/请假恢复——只结一次（st.day 翻日才算）
      if (st.day) {
        const yDesc = resolveDay(st.day, new Date(now - DAY))
        if (c.pressureOn) {
          if (yDesc.type === 'work') st.pressure = clamp(st.pressure + c.pressurePerWorkDay, 0, 100)
          else if (yDesc.type === 'rest') st.pressure = clamp(st.pressure - c.pressureRecover, 0, 100)
          else if (yDesc.type === 'leave') st.pressure = clamp(st.pressure - c.pressureLeaveRecover, 0, 100)
        }
      }
      // 过期的自记日程清掉（留 7 天余量给回顾）
      const minDay = dayKey(now - DAY)
      st.self = st.self.filter((e) => e.day >= minDay)
      // 周日晚上生成下一周的扰动：临时加班 / 调休，低概率、一周最多两条
      const dow = new Date(now).getDay()
      if (dow === 0 && !st.distWeek) {
        st.distWeek = dayKey(now)
        genDisturb(now)
      }
      st.day = today
      record('day', { day: today, pressure: st.pressure })
      // 攒满请假：给明天挂 override，压力泄掉，心情记一笔（reason 不含任何聊天内容，跨聊天安全）
      if (c.pressureOn && st.pressure >= c.pressureThreshold) {
        const tmr = dayKey(addDays(now, 1))
        st.overrides[tmr] = { type: 'leave', note: '压力到顶，自动请假' }
        st.pressure = clamp(st.pressure - c.pressureLeaveRecover, 0, 100)
        try { api.use('mood')?.nudge?.(-6, '压力累积到顶，请了一天假在家缓一缓') } catch {}
        record('leave', { day: tmr, pressure: st.pressure })
        api.log.info(`[routine] 压力 ${c.pressureThreshold}+，明天（${tmr}）自动请假`)
      }
      save()
      return true
    }

    function genDisturb(now) {
      const c = cfg()
      st.disturb = st.disturb.filter((d) => d.day >= dayKey(now))
      const next7 = Array.from({ length: 7 }, (_, i) => addDays(now, i + 1))
      const workSegs = (sched.week.mon && sched.week.mon.length) ? sched.week.mon : [['09:00', '18:00']]
      let picks = 0
      for (const t of next7) {
        if (picks >= 2) break
        const day = dayKey(t)
        const desc = resolveDay(day, new Date(t))
        const roll = Math.random() * 100
        if (desc.type === 'rest' && roll < 25) {
          st.disturb.push({ id: `d${t}`, day, type: 'work', segments: workSegs, note: profOf().w?.overtime || '临时加班' })
          picks++
        } else if (desc.type === 'work' && roll >= 25 && roll < 45) {
          st.disturb.push({ id: `d${t}`, day, type: 'rest', segments: [], note: profOf().w?.overtime === '临时补课' ? '临时调课' : '调休' })
          picks++
        }
      }
      if (picks) api.log.info(`[routine] 下周扰动 ${picks} 条已生成`)
    }

    // ---------- 她自己拿主意：上班摸鱼还是干活、放假出门还是在家 ----------
    // 每 planIntervalMin 分钟决定一次。决定只落四件事：心情、记忆、日志、要不要说一声。
    const SHARE_GAP = 45 * MIN // 两次主动说至少隔这么久，别刷屏
    const planConfig = () => {
      const c = cfg()
      return { on: !!c.planOn, interval: Number(c.planIntervalMin) || 30, shareChance: Number(c.planShareChance) || 0, taskOn: !!c.taskOn, tasksPerDay: Number(c.tasksPerDay) || 2 }
    }
    const planLog = (now, ev) => {
      const p = st.plan
      p.log.push({ at: now, ...ev })
      p.log = p.log.filter((e) => now - e.at < 3 * DAY).slice(-80)
    }

    const sayToOwner = (text) => {
      const owner = String(api.config()?.ownerQQ || '')
      if (!owner) return false
      try {
        api.send(`private:${owner}`, text) // hub.deliver：走正常私聊通道，跟 speakup 一样
        return true
      } catch (e) { api.log.warn?.(`[routine] 主动说一声失败：${e.message}`); return false }
    }

    // 关键事件进长期记忆，她以后聊天能想起来
    const remember = (text) => {
      try { api.use('memory')?.addEvent?.({ text, tags: ['日常', '工作'], importance: 0.5 }) } catch {}
    }

    function applyDecision(dec, now) {
      if (!dec || !dec.kind) return null
      const c = cfg()
      const p = st.plan
      if (dec.mood) { try { api.use('mood')?.nudge?.(dec.mood, dec.text) } catch {} }
      if (dec.memory) remember(dec.text)
      const entry = { at: now, kind: dec.kind, text: dec.text, shared: false }
      const chance = Number(c.planShareChance) || 0
      if (dec.shareable && dec.say && now - (p.lastShareAt || 0) >= SHARE_GAP && Math.random() * 100 < chance) {
        entry.shared = sayToOwner(dec.say)
        if (entry.shared) p.lastShareAt = now
      }
      planLog(now, entry)
      save()
      api.log.info(`[routine] ${dec.kind}：${dec.text}${entry.shared ? '（说了）' : ''}`)
      return dec
    }

    const pendingTasks = () => st.plan.tasks.filter((t) => !t.done && !t.failed)
    const moodValue = () => { try { return Number(api.use('mood')?.state?.()?.value) || 60 } catch { return 60 } }
    // 最近记过的同类事，抽新的时先避开，免得连着两天摸同一种鱼、去同一个地方
    const recentOf = (kind, n = 8) => {
      const out = []
      for (let i = st.plan.log.length - 1; i >= 0 && out.length < n; i--) {
        const e = st.plan.log[i]
        if (e.kind !== kind) continue
        const t = String(e.text || '')
        if (t && !out.includes(t)) out.push(t)
      }
      return out
    }
    const recentOutings = () => recentOf('out', 6).map((t) => t.replace(/^出门了，/, ''))

    // 每个 tick（5 分钟）都走一遍：查超时、查回家、备活；决定本身按 planIntervalMin 节流
    function planTick(now, res) {
      const c = cfg()
      const p = st.plan
      const today = dayKey(now)
      if (p.day !== today) {
        p.day = today
        p.tasks = []
        p.outing = null
        p.livinOff = false
        p.homeAt = 0
        p.log = p.log.filter((e) => now - e.at < 3 * DAY)
      }

      // 1) 到期没做完的活：被主管说一顿（不管托管开关，挂着的事总得有个结果）
      if (c.taskOn) {
        for (const t of p.tasks) {
          if (!t.done && !t.failed && now >= t.deadline) {
            t.failed = true
            applyDecision(taskFailed({ task: t, profId: c.profession }), now)
          }
        }
      }

      // 2) 出门到点回来了：心情缓和一点，livin 还给过日子
      if (p.outing && now >= p.outing.until) {
        const o = p.outing
        p.outing = null
        if (p.livinOff) {
          p.livinOff = false
          try { api.setConfig({ ext: { livin: { enabled: true } } }) } catch {}
        }
        applyDecision(backHome({ outing: o }), now)
      }

      if (!c.enabled || !c.planOn) return null

      // 3) 在班段里就备好今天的活：按班段剩余时间分配截止点，别排到下班以后
      if (c.taskOn && res.state === 'work' && !p.tasks.length) {
        const seg = res.seg
        const mins = minsOf(now)
        const leftMin = seg ? (seg[1] > seg[0] ? seg[1] - mins : seg[1] + 24 * 60 - mins) : 8 * 60
        const n = clamp(Number(c.tasksPerDay) || 2, 1, 5)
        const base = Number(c.taskHours) || 3
        for (let i = 0; i < n; i++) {
          const hours = clamp(base * Math.max(0.3, leftMin / 60 / 8), 0.5, 6)
          // 同一天抽的几条活不能撞，撞了就换
          p.tasks.push(newTask(c.profession, now, { hours, avoid: p.tasks.map((t) => t.title) }))
        }
        record('plan-tasks', { n, titles: p.tasks.map((t) => t.title) })
        save()
      }

      // 4) 到点做一次决定
      if (now - (p.lastAt || 0) < (Number(c.planIntervalMin) || 30) * MIN) return null
      p.lastAt = now
      const profId = c.profession || 'office'
      const mood = moodValue()

      if (res.state === 'work') {
        const list = pendingTasks()
        const next = list.slice().sort((a, b) => a.deadline - b.deadline)[0]
        const urgent = !!next && next.deadline - now < HOUR
        if (willSlack({ mood, pressure: st.pressure, urgent, now })) {
          return applyDecision(doSlack({ profId, recent: recentOf('slack', 6) }), now)
        }
        if (!next) return null // 活都干完了，没什么可记的，别拿「收了收尾」刷日志
        return applyDecision(doWork({ task: next }), now)
      }

      // 休息日：出门还是在家。同一个判断 3 小时内不重复记，免得一天几十条「在家待着」
      const restDay = res.state === 'home' && (res.day?.type === 'rest' || res.day?.type === 'leave')
      if (restDay && !p.outing) {
        if (now - (p.homeAt || 0) < 3 * HOUR) return null
        p.homeAt = now
        if (willGoOut({ mood, pressure: st.pressure, now })) {
          const o = newOuting(now, { recent: recentOutings() })
          p.outing = o
          // 出门了就别让过日子按「在家」找乐子
          try {
            if (api.config()?.ext?.livin?.enabled) { api.setConfig({ ext: { livin: { enabled: false } } }); p.livinOff = true }
          } catch {}
          return applyDecision(goOut({ outing: o }), now)
        }
        return applyDecision(stayHome({ now }), now)
      }
      return null
    }

    // ---------- 主循环：每 5 分钟对一次表，状态沿才动作 ----------
    const alignLivin = (res, now, why) => {
      const desired = res.livin === true
      try {
        if (!!api.config().ext?.livin?.enabled !== desired) {
          api.setConfig({ ext: { livin: { enabled: desired } } })
          st.lastLivinWrite = now
          record('livin', { to: desired ? '开' : '关', why })
          api.log.info(`[routine] livin ${desired ? '开' : '关'}（${why}：${res.label}）`)
        }
      } catch (e) { api.log.warn?.(`[routine] 拨 livin 开关失败：${e.message}`) }
    }

    const tick = async () => {
      const now = Date.now()
      rollDay(now)
      applyProfession(now) // 轮班职业翻周时重排 week（手动班表除外）
      const res = stateAt(now)
      const on = cfg().enabled
      if (on && !st.managedOn) {
        // 托管刚打开（面板/配置/热重载后第一次）：立刻对齐 livin 到当前处境，不等下一个状态沿
        st.current = { state: res.state, since: now, label: res.label }
        alignLivin(res, now, '托管开启')
        save()
      }
      st.managedOn = on
      if (on) applyLivin(res, now)
      try { planTick(now, res) } catch (e) { api.log.warn?.(`[routine] 决定：${e.message}`) }
      if (res.state !== st.current.state) {
        st.current = { state: res.state, since: now, label: res.label }
        record('state', { state: res.state, label: res.label })
        save()
      }
    }

    // ---------- 注入【此刻·作息】：只描述处境，不下指令；画图免责跟在尾巴上 ----------
    // 教训来自 wardrobe：【当前的穿着】混进画图稿导致她画自己时叠开衫——所以这里明说「画图以画稿为准」。
    api.context(({ chat }) => {
      const c = cfg()
      if (!c.enabled || chat.kind === 'system') return ''
      const res = stateAt(Date.now())
      if (res.state === 'sleep') return ''
      let line = ''
      const p = c.pressureOn && st.pressure >= 60 ? `，压力${st.pressure}有点重` : ''
      if (res.state === 'work') line = res.night
        ? `现在是夜班，${res.label}${p}，忙起来回复会慢，只能抽空看一眼手机${res.day?.note ? `（${res.day.note}）` : ''}`
        : `现在是${profOf().w?.time || '上班时间'}，${res.label}${p}，只能偶尔偷偷看下手机${res.day?.note ? `（${res.day.note}）` : ''}`
      else if (res.state === 'commute') line = `${res.label}，只能简单聊两句`
      else if (res.state === 'home') {
        line = res.day?.type === 'leave' ? `今天请假在家${p}，状态一般，慢慢缓`
          : res.label === '下夜班了，在家补觉' ? `刚下夜班，${p}困得不行，回去补觉了`
          : res.day?.type === 'rest' ? `今天是休息日，${res.day.note ? '（' + res.day.note + '）' : ''}时间都是自己的`
          : `${res.label}${p}，这一段是自己的时间`
        if (res.day?.note && res.day.type !== 'rest') line += `（${res.day.note}）`
      }
      // 今天自己的事：最后三条 + 现在是不是在外面 + 手头还压着什么活
      const now = Date.now()
      const pl = st.plan
      const items = (pl.log || []).filter((e) => now - e.at < 12 * HOUR).slice(-3)
      const outLine = pl.outing && now < pl.outing.until ? `；现在在外面，${pl.outing.act}` : ''
      const left = (pl.tasks || []).filter((t) => !t.done && !t.failed)
      const taskLine = left.length ? `；手头还压着${left.map((t) => `「${t.title}」`).join('')}` : ''
      const seq = items.map((e) => `${hhmm(e.at)} ${e.text}`).join('；')
      const donePart = seq || outLine || taskLine
        ? `【今天·我做的】${seq}${outLine}${taskLine}。这些是我自己今天的事，不用一条条汇报，聊到的时候自然提一句就好。`
        : ''
      const base = line ? `【此刻·作息】${line}。处境只是背景，不用说出来；画图时场景和穿着以画稿为准，不要把作息字眼画进去。` : ''
      return [base, donePart].filter(Boolean).join('\n')
    })

    // ---------- 给她的工具：她的日程她自己记 ----------
    api.tool(() => [
      api.defineTool({
        name: 'life_schedule',
        description: '记自己的日程，或者看看最近排了什么。聊天里说到「周三要值班」「明天下午开会」就自己记下来；记了的事优先于固定班表。',
        properties: {
          action: { type: 'string', description: 'add 记一条（默认）/ list 看最近排了什么 / cancel 取消一条', },
          what: { type: 'string', description: 'add 时必填：什么事，比如「下午去总部开会」' },
          date: { type: 'string', description: '哪天：今天 / 明天 / 后天 / YYYY-MM-DD' },
          start: { type: 'string', description: '开始 HH:MM（可选，busy 时建议填）' },
          end: { type: 'string', description: '结束 HH:MM（可选）' },
          kind: { type: 'string', description: 'busy=这段时间有事先不找乐子；off=这天整天算休息（默认 busy）' },
          id: { type: 'string', description: 'cancel 时填要取消的条目 id' },
        },
        execute: async ({ action = 'add', what, date, start, end, kind = 'busy', id } = {}) => {
          rollDay(Date.now())
          if (action === 'list') {
            const now = Date.now()
            const items = st.self.filter((e) => e.day >= dayKey(now)).slice(0, 12)
            const dist = st.disturb.filter((d) => d.day >= dayKey(now)).slice(0, 6)
            const f = (e) => `${e.day}${e.start ? ' ' + e.start + (e.end ? '-' + e.end : '') : ''} ${e.what || e.note}${e.kind === 'off' ? '（整天休息）' : ''}`
            const lines = [...items.map(f), ...dist.map(f)].filter(Boolean)
            return { ok: true, message: lines.length ? `最近排的：\n${lines.map((l) => '- ' + l).join('\n')}` : '最近没有额外安排，就按固定班表走。' }
          }
          if (action === 'cancel') {
            const i = st.self.findIndex((e) => e.id === id)
            if (i < 0) return { ok: false, message: '没找到这条日程。' }
            const [gone] = st.self.splice(i, 1)
            save()
            record('self-cancel', { what: gone.what, day: gone.day })
            return { ok: true, message: `取消了：${gone.day} ${gone.what}` }
          }
          const day = parseDay(date, Date.now())
          if (!day) return { ok: false, message: '没认出是哪天，用「今天/明天/后天」或 YYYY-MM-DD。' }
          if (!what) return { ok: false, message: '记什么事总得说一句。' }
          if (start && toMin(start) < 0) return { ok: false, message: '开始时间格式是 HH:MM。' }
          if (end && toMin(end) < 0) return { ok: false, message: '结束时间格式是 HH:MM。' }
          const entry = { id: `s${Date.now()}`, day, what: String(what).slice(0, 40), start: start || '', end: end || '', kind: kind === 'off' ? 'off' : 'busy', at: Date.now() }
          st.self.push(entry)
          st.self = st.self.slice(-60)
          save()
          record('self-add', { day, what: entry.what, kind: entry.kind })
          return { ok: true, message: `记下了：${day}${entry.start ? ' ' + entry.start + (entry.end ? '-' + entry.end : '') : ''} ${entry.what}${entry.kind === 'off' ? '（整天休息）' : ''}` }
        },
      }),
      api.defineTool({
        name: 'my_day',
        description: '看看自己今天干了什么、手上还有什么活没做完、是不是在外面。想不起来今天做过什么，或者要回答「你今天忙什么呢」时用。',
        properties: {},
        execute: async () => {
          const now = Date.now()
          const p = st.plan
          const items = (p.log || []).filter((e) => now - e.at < 24 * HOUR)
          const left = (p.tasks || []).filter((t) => !t.done && !t.failed)
          const done = (p.tasks || []).filter((t) => t.done)
          const lines = []
          if (p.outing && now < p.outing.until) lines.push(`现在在外面：${p.outing.act}`)
          if (left.length) lines.push(`还没做完：${left.map((t) => `「${t.title}」（还有 ${Math.max(0, Math.round((t.deadline - now) / MIN))} 分钟到期）`).join('、')}`)
          if (done.length) lines.push(`做完了：${done.map((t) => `「${t.title}」`).join('、')}`)
          if (items.length) lines.push('今天做过：\n' + items.slice(-10).map((e) => `- ${hhmm(e.at)} ${e.text}`).join('\n'))
          return { ok: true, message: lines.length ? lines.join('\n') : '今天还没做什么，就按作息过。' }
        },
      }),
    ])

    // ---------- 主人命令：/作息 on|off|状态（QQ 里直接说，不用开面板） ----------
    api.command({
      name: 'routine',
      aliases: ['作息'],
      desc: '作息托管：/作息 on 开 · /作息 off 关 · /作息 职业 换工作 · 不带参数看当前状态',
      run: (arg) => {
        const a = String(arg || '').trim()
        if (/^(on|开|打开|启用)$/i.test(a)) {
          api.saveSettings({ enabled: true })
          const res = stateAt(Date.now())
          st.current = { state: res.state, since: Date.now(), label: res.label }
          alignLivin(res, Date.now(), '托管开启')
          st.managedOn = true
          save()
          return `作息托管开了。现在是${res.state === 'sleep' ? '睡觉中' : res.label}，过日子${res.livin ? '开着，她在家休息' : `先关着，${profOf().w?.time || '上班时间'}不找乐子`}`
        }
        if (/^(off|关|关闭|停用)$/.test(a)) {
          api.saveSettings({ enabled: false })
          st.managedOn = false
          save()
          return '作息托管关了：不再注入「此刻处境」，也不动过日子的开关了'
        }
        // /作息 职业 → 列出；/作息 职业 医生|nurse → 换职业（名字/id 都认，模糊匹配）
        if (/^职业|job/i.test(a)) {
          const q = a.replace(/^职业|job/i, '').trim()
          if (!q) {
            return '可选职业：\n' + Object.entries(PROFESSIONS).map(([id, p]) => `- ${p.name}（${p.desc}）`).join('\n') + '\n换工作：/作息 职业 医生'
          }
          const hit = Object.entries(PROFESSIONS).find(([id, p]) => id === q || p.name.includes(q) || q.includes(p.name) || id.includes(q.toLowerCase()))
          if (!hit) return `没有叫「${q}」的职业。可选：${Object.values(PROFESSIONS).map((p) => p.name).join('、')}`
          const p = switchProfession(hit[0])
          const res = stateAt(Date.now())
          return `换工作了：${p.name}。${p.desc}，班表已按这个职业重排${cfg().enabled ? `，现在判定：${res.state === 'sleep' ? '睡觉中' : res.label}` : ''}。之前手动改过的班表被模板覆盖了，要改回面板里再改。`
        }
        const res = stateAt(Date.now())
        const c = cfg()
        return `现在：${res.state === 'sleep' ? '睡觉中' : res.label}；职业：${profOf().name}；压力 ${st.pressure}${c.pressureOn ? '/' + c.pressureThreshold : ''}；托管${c.enabled ? '开着' : '关着'}（/作息 on 开，/作息 职业 换工作）`
      },
    })

    // ---------- 职业：换工作（QQ 命令里也接了一个） ----------
    const switchProfession = (id) => {
      const p = PROFESSIONS[id]
      if (!p) return null
      api.saveSettings({ profession: id })
      sched.pendingProf = true
      writeJson(schedFile(), sched)
      applyProfession(Date.now())
      record('profession', { to: p.name })
      api.log.info(`[routine] 职业换成${p.name}，班表已按模板重排`)
      return p
    }
    api.route('/professions', async (req) => {
      if (req && req.method === 'POST') {
        const b = await api.core.http.body(req)
        const p = switchProfession(String(b.id || ''))
        if (!p) return { ok: false, message: '没有这个职业' }
        // 班表变了立刻对一次表，托管开着的话 livin 跟着新处境走
        try { await tick() } catch {}
        return { ok: true, profession: b.id, name: p.name, week: sched.week }
      }
      return {
        ok: true,
        current: cfg().profession || 'office',
        weekSource: sched.weekSource || '',
        list: Object.entries(PROFESSIONS).map(([id, p]) => ({ id, name: p.name, desc: p.desc, goods: p.goods, rotating: !!p.rot })),
      }
    })

    // ---------- 面板接口 ----------
    // 托管总开关：开的时候立刻对一次表，把 livin 拨到当前处境对应的值（不等下一个状态沿）
    api.route('/enabled', async (req) => {
      const b = await api.core.http.body(req)
      const on = !!b.on
      api.saveSettings({ enabled: on })
      record('managed', { on })
      api.log.info(`[routine] 托管开关：${on ? '开' : '关'}`)
      if (on) {
        const res = stateAt(Date.now())
        st.current = { state: res.state, since: Date.now(), label: res.label }
        const desired = res.livin === true
        try {
          if (!!api.config().ext?.livin?.enabled !== desired) {
            api.setConfig({ ext: { livin: { enabled: desired } } })
            st.lastLivinWrite = Date.now()
            record('livin', { to: desired ? '开' : '关', why: '托管开启，对齐当前处境' })
            api.log.info(`[routine] 托管开启，livin 对齐当前处境（${res.label}）→ ${desired ? '开' : '关'}`)
          }
        } catch (e) { api.log.warn?.(`[routine] 开托管对齐 livin 失败：${e.message}`) }
      }
      save()
      return { ok: true, enabled: on }
    })
    api.route('/state', async () => {
      const now = Date.now()
      const res = stateAt(now)
      const todayDesc = res.state === 'sleep' ? resolveDay(dayKey(now), new Date(now)) : res.day
      return {
        ok: true,
        enabled: cfg().enabled,
        state: res.state,
        label: res.state === 'sleep' ? '睡觉中' : res.label,
        since: st.current.since,
        pressure: st.pressure,
        pressureOn: cfg().pressureOn,
        threshold: cfg().pressureThreshold,
        today: { type: todayDesc?.type, note: todayDesc?.note || '', segments: todayDesc?.segments?.map((s) => [fmtMin(s[0]), fmtMin(s[1])]) || [], src: todayDesc?.src },
        livinManaged: { on: !!api.config().ext?.livin?.enabled, lastWrite: st.lastLivinWrite },
        profession: { id: cfg().profession || 'office', name: profOf().name, desc: profOf().desc, rotating: !!profOf().rot, weekSource: sched.weekSource || '' },
        mood: (() => { try { const m = api.use('mood'); return m?.label?.() || '' } catch { return '' } })(),
      }
    })
    api.route('/schedule', async (req) => {
      if (req && req.method === 'POST') {
        const b = await api.core.http.body(req)
        if (b.week) {
          const week = {}
          for (const d of DOW) {
            const raw = Array.isArray(b.week[d]) ? b.week[d] : []
            week[d] = raw.map((s) => [toMin(s[0]), toMin(s[1])]).filter((s) => s[0] >= 0 && s[1] >= 0 && s[1] !== s[0]).map((s) => [fmtMin(s[0]), fmtMin(s[1])])
          }
          sched.week = week
          sched.weekSource = 'custom' // 手动班表优先，职业轮换暂停（再切一次职业会重排）
          sched.pendingProf = false
          writeJson(schedFile(), sched)
          record('schedule', {})
        }
        return { ok: true, week: sched.week }
      }
      return { ok: true, week: sched.week }
    })
    api.route('/pressure', async (req) => {
      const b = await api.core.http.body(req)
      const d = Number(b.delta)
      if (!Number.isFinite(d)) return { ok: false, message: 'delta 要是数字' }
      st.pressure = clamp(st.pressure + d, 0, 100)
      save()
      return { ok: true, pressure: st.pressure }
    })
    api.route('/events', async (req) => {
      if (req && req.method === 'POST') {
        const b = await api.core.http.body(req)
        const i = st.self.findIndex((e) => e.id === b.id)
        if (i >= 0) {
          const [gone] = st.self.splice(i, 1)
          save()
          return { ok: true }
        }
        const j = st.disturb.findIndex((e) => e.id === b.id)
        if (j >= 0) { st.disturb.splice(j, 1); save(); return { ok: true } }
        return { ok: false, message: '没这条' }
      }
      const now = dayKey(Date.now())
      return {
        ok: true,
        self: st.self.filter((e) => e.day >= now).map((e) => ({ ...e })),
        disturb: st.disturb.filter((e) => e.day >= now).map((e) => ({ ...e })),
      }
    })
    // ---------- 面板：她自己拿主意的日志 ----------
    api.route('/plan', async (req) => {
      if (req && req.method === 'POST') {
        const b = await api.core.http.body(req)
        const patch = {}
        if (typeof b.on === 'boolean') patch.planOn = b.on
        if (Number.isFinite(Number(b.interval)) && b.interval !== undefined) patch.planIntervalMin = clamp(Number(b.interval), 10, 180)
        if (Number.isFinite(Number(b.shareChance)) && b.shareChance !== undefined) patch.planShareChance = clamp(Number(b.shareChance), 0, 100)
        if (typeof b.taskOn === 'boolean') patch.taskOn = b.taskOn
        if (Object.keys(patch).length) { api.saveSettings(patch); record('plan-config', patch) }
        return { ok: true, config: planConfig() }
      }
      const now = Date.now()
      const p = st.plan
      return {
        ok: true,
        config: planConfig(),
        log: (p.log || []).slice(-40).reverse().map((e) => ({ ...e })),
        tasks: (p.tasks || []).map((t) => ({ ...t, leftMin: t.done || t.failed ? 0 : Math.max(0, Math.round((t.deadline - now) / MIN)) })),
        outing: p.outing && now < p.outing.until ? { ...p.outing, leftMin: Math.round((p.outing.until - now) / MIN) } : null,
      }
    })
    // 面板上「让她现在决定一次」：清掉节流，立刻走一遍
    api.route('/plan/now', async () => {
      st.plan.lastAt = 0
      await tick()
      const p = st.plan
      return { ok: true, last: (p.log || [])[0] || null, log: (p.log || []).slice(-40).reverse() }
    })
    api.route('/history', async () => ({ ok: true, history: st.history.slice(-120).reverse() }))

    api.every(5 * MIN, () => { tick().catch((e) => api.log.warn?.(`[routine] tick：${e.message}`)) }, '作息')
    // 启动先对一次表（livin 热重载/宿主重启后，托管开关要立刻跟上当前处境）
    api.later(3000, () => { tick().catch((e) => api.log.warn?.(`[routine] 启动对表：${e.message}`)) })

    api.log.info('作息就绪：她的上下班和在家时间由这张表判定')
    // hooks：测试直调
    return { tick, stateAt, resolveDay, rollDay, genDisturb, applyProfession, switchProfession, planTick, st: () => st, plan: () => st.plan, sched: () => sched, set: (patch) => { st = { ...st, ...patch } }, reloadSchedule: () => { sched = loadSchedule() } }
  },
}
