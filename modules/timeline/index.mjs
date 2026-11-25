// 飞鱼时间线（独立扩展模块）
//
// 设计（对应主人意见一）：时间线**不是**提醒插件，而是「回复前查日程 → 把当前块注入她的上下文」。
//   - 不主动发消息、不写定时提醒，因此不会和 speakup / purpose 抢职责。
//   - 每轮判断话题：普通闲聊不注入；涉及“现在/今天/未来安排/时间”时，把「当前块 + 下一块」注入提示词。
//   - 另给她一个 my_schedule 工具，让她回答时间问题前先查，回答以查到为准。
//
// 数据全部在模块自己的 dataDir（plugins-data/aurabot/modules-data/timeline/timeline.json），
// 面板 / 命令 / AI 拟稿都写这里，可追溯。
// 时区统一北京时间（UTC+8），直接在 Date 上做偏移，不引入时区库。

import { readFileSync, writeFileSync } from 'node:fs'

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'timeline',
  name: '时间线',
  version: '1.0.0',
  api: 1,
  description: '飞鱼的日程表：按话题把「当前块」注入上下文 + my_schedule 工具，AI 拟稿/主人改，避免时间错乱',
  panel: 'panel.js',

  defaults: {
    enabled: true,
    // gated = 按话题触发（普通闲聊不注）；always = 每轮都注；off = 只留工具不注入
    injectMode: 'gated',
    // 命中这些关键词才注入。普通闲聊不触发；涉及「现在/今天/未来安排/时间/考试放假」才注。
    topics: '你在做什么,干嘛,做什么,做什么呢,要去干嘛,你要做什么,你要干什么,你想干什么,忙什么,忙不忙,几点了,几点了,几点,今天几点,明天几点,你几点,你几点上课,几点上课,几点吃饭,几点吃饭了,几点睡,几点睡的,几点睡觉,早上几点,中午几点,下午几点,几点休息,午休,吃饭了吗,吃了吗,中午,中午吃饭,下午,下午课,下午有课,明天,后天,今天,昨天,今天干嘛,今天做什么,今天忙不忙,今天安排,今天有什么安排,今天有什么事,今天做什么,今天是不是没课,今天有课,今天没课,有没有课,今天课多吗,本周安排,这周安排,下周安排,周末干嘛,最近安排,期中,期中考试,期末,期末考试,复习,作业,考试,放假,寒暑假,课表,考试安排,安排,计划,日程,行程,要去干嘛,要去,旅游,出差,起飞,赶车,天气,下雨,考试安排,考完没',
    // 命中后注入到几点为止的今日剩余行程（0 = 只注当前+下一块钱）
    injectTodayUntil: 22,
    // AI 每天自动拟稿（默认关）。到点只写草稿到数据，不发消息。
    aiAutoEnabled: false,
    aiAutoTime: '23:30',
    // draft = 只写草稿，主人到面板确认；apply = 直接生效
    aiAutoMode: 'draft',
    // 换了人格（config.persona.current 变了）时自动重建周模板；draft=只写周表不动当日，apply=也清掉旧 overrides。
    autoRebuildWeek: true,
    autoRebuildMode: 'draft',
    cnName: '大肥鱼',
    city: '南京',
    lat: '32.0603',
    lon: '118.7969',
    holidaySource: 'builtin',
  },

  settings: [
    { key: 'enabled', label: '启用时间线', type: 'switch', hint: '关了就不注入、也不给她 my_schedule 工具' },
    { key: 'injectMode', label: '注入模式', type: 'select', options: [{ value: 'gated', label: '按话题触发（推荐）' }, { value: 'always', label: '每轮都注入' }, { value: 'off', label: '不注入（只留工具）' }] },
    { key: 'injectTodayUntil', label: '命中后注入今日行程到（点）', type: 'number', min: 0, max: 24, hint: '0 = 只注入当前块 + 下一块' },
    { key: 'topics', label: '注入话题（逗号分隔）', type: 'textarea', hint: '普通闲聊不会注；命中这里任一关键词就把日程片段注入她的上下文。可以先把话题放宽，再慢慢收窄。' },
    { key: 'aiAutoEnabled', label: '每天自动拟第二天日程', type: 'switch', hint: '默认关。到点让 AI 拟一份草稿写进数据，不发消息。' },
    { key: 'aiAutoTime', label: '自动拟稿时间', type: 'text', placeholder: 'HH:MM' },
    { key: 'aiAutoMode', label: '自动拟稿结果', type: 'select', options: [{ value: 'draft', label: '只写草稿，要确认' }, { value: 'apply', label: '直接生效' }] },
    { key: 'cnName', label: '称呼', type: 'text', hint: '仅风格说明用；身份自动从人格卡读' },
    { key: 'autoRebuildWeek', label: '换人格时自动重建周模板', type: 'switch', hint: '切换到新人格后，下次自动拟稿前按新正文重排周一~周日的常规表。' },
    { key: 'autoRebuildMode', label: '自动重建后处理', type: 'select', options: [{ value: 'draft', label: '保留旧的当日安排' }, { value: 'apply', label: '清掉旧overrides（彻底换）' }] },
    { key: 'city', label: '城市（用于天气/计划）', type: 'text' },
    { key: 'lat', label: '纬度', type: 'text' },
    { key: 'lon', label: '经度', type: 'text' },
  ],

  setup(api) {
    const PATH = api.dataDir('timeline.json')
    const cfg = () => api.settings() || {}
    const now = () => Date.now()

    // ---------- 时间工具（北京时间） ----------
    const pad = (n) => String(n).padStart(2, '0')
    const beijing = (ts) => {
      const d = new Date(ts + 8 * 3600 * 1000)
      return {
        h: d.getUTCHours(), m: d.getUTCMinutes(),
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()],
        wd: d.getUTCDay(), // 0=周日
      }
    }
    const dateKey = (ts) => beijing(ts).date
    const parseDate = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00+08:00`)
    const addDays = (ts, n) => ts + n * 86400000
    const wdIndex = (key) => { const w = beijing(parseDate(key)).wd; return w === 0 ? 7 : w } // 1=周一..7=周日
    const hhmm = (s) => {
      if (String(s || '').trim() === '24:00' || String(s || '').trim() === '24:59') return String(s || '').trim()
      const p = String(s || '').match(/(\d{1,2}):(\d{2})/)
      return p ? `${pad(Math.min(23, +p[1]))}:${pad(Math.min(59, +p[2]))}` : '00:00'
    }
    const toMin = (s) => { const p = hhmm(s).split(':'); return +p[0] * 60 + +p[1] }
    const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n)
    const nowHHMM = (ts) => `${pad(beijing(ts).h)}:${pad(beijing(ts).m)}`

    // ---------- 数据 ----------
    /**
     * 通用周模板：只描述「一个人典型的一天」（起床/上午/午饭/午休/下午/晚饭/晚间/睡觉），
     * 不含任何学生专属内容（早八、课表、晚自习）。换人格时不会被这套模板带偏，
     * 由「重建模板」按当前人格正文重排；模型不给结果时也用它兜底。
     */
    const genericWeek = () => ({
      1: [['07:20', '07:50', '起床洗漱'], ['08:30', '12:00', '上午安排'], ['12:00', '13:00', '午饭'], ['13:00', '13:40', '午休'], ['14:00', '18:00', '下午安排'], ['18:30', '19:30', '晚饭'], ['19:30', '22:00', '自由/学习'], ['23:00', '23:59', '睡觉']],
      2: [['07:20', '07:50', '起床洗漱'], ['08:30', '12:00', '上午安排'], ['12:00', '13:00', '午饭'], ['13:00', '13:40', '午休'], ['14:00', '18:00', '下午安排'], ['18:30', '19:30', '晚饭'], ['19:30', '22:00', '自由/学习'], ['23:00', '23:59', '睡觉']],
      3: [['07:20', '07:50', '起床洗漱'], ['08:30', '12:00', '上午安排'], ['12:00', '13:00', '午饭'], ['13:00', '13:40', '午休'], ['14:00', '18:00', '下午安排'], ['18:30', '19:30', '晚饭'], ['19:30', '22:00', '自由/学习'], ['23:00', '23:59', '睡觉']],
      4: [['07:20', '07:50', '起床洗漱'], ['08:30', '12:00', '上午安排'], ['12:00', '13:00', '午饭'], ['13:00', '13:40', '午休'], ['14:00', '18:00', '下午安排'], ['18:30', '19:30', '晚饭'], ['19:30', '22:00', '自由/学习'], ['23:00', '23:59', '睡觉']],
      5: [['07:30', '08:00', '起床洗漱'], ['08:30', '12:00', '上午安排'], ['12:00', '13:00', '午饭'], ['13:00', '13:40', '午休'], ['14:00', '17:30', '下午安排'], ['18:30', '19:30', '晚饭'], ['19:30', '22:30', '晚间自由'], ['23:30', '23:59', '睡觉']],
      6: [['08:30', '09:00', '自然醒/洗漱'], ['09:30', '11:30', '自由安排/学习'], ['12:00', '13:30', '午饭'], ['14:00', '14:30', '午休'], ['15:00', '18:00', '自由安排/出门'], ['18:30', '19:30', '晚饭'], ['19:30', '23:00', '放松/视频'], ['23:30', '23:59', '睡觉']],
      7: [['08:30', '09:30', '自然醒'], ['09:30', '12:00', '自由安排'], ['12:00', '13:30', '午饭'], ['14:00', '15:00', '午休'], ['15:00', '18:00', '运动/散步/出行'], ['18:30', '19:30', '晚饭'], ['19:30', '23:00', '放松/准备下周'], ['23:30', '23:59', '睡觉']],
    })
    const defaultData = () => ({
      version: 1,
      // 星期 → 时间段（1=周一..7=周日）。块之间允许空隙。
      week: genericWeek(),
      holidays: {}, // 'YYYY-MM-DD': 名称
      events: {}, // 'YYYY-MM-DD': { title, kind, note }
      overrides: {}, // 'YYYY-MM-DD': [{start,end,title,source,note}]
      drafts: {}, // 'YYYY-MM-DD': { status:'draft'|'active', blocks:[], note, createdAt, source }
      // 周模板是谁建的：换人格后据此判断「这套周表还是不是她的」
      meta: { weekPersonaId: '', weekPersonality: '', weekBuiltAt: 0, weekSource: 'generic', weekNote: '通用模板（未按人格定制）' },
      log: [],
    })
    const load = () => {
      try { return { ...defaultData(), ...JSON.parse(readFileSync(PATH, 'utf8')) } } catch { return defaultData() }
    }
    const save = (d) => {
      try { writeFileSync(PATH, JSON.stringify(d, null, 2), 'utf8'); return true } catch (e) { api.log.warn(`时间线：写数据失败：${e?.message}`); return false }
    }
    const log = (d, action, detail) => { (d.log = d.log || []).push({ at: now(), action, detail: clip(detail, 200) }); return d.log.slice(-80) }

    // ---------- 日程计算 ----------
    /** 把 day 的数字周几块转换成标准化块，供备注与优先级使用 */
    const planFor = (d, dayKey, ts) => {
      const out = []
      const listFrom = (arr, source, extra = {}) => {
        if (!Array.isArray(arr)) return
        for (const it of arr) {
          const b = Array.isArray(it) ? { start: it[0], end: it[1], title: it[2] } : it
          if (!b || !b.start || !b.end || b.start === b.end) continue
          const s = hhmm(b.start), e = hhmm(b.end)
          if (toMin(s) >= toMin(e)) continue
          // e 若小于 s（跨天，如 23:00-07:00）
          push(out, { start: s, end: e, title: clip(b.title || (source === 'monthly' ? '安排' : '日常'), 60), kind: b.kind || defaultKind(s, e), source, note: b.note || b.desc || '' })
        }
      }
      listFrom(d.week && d.week[wdIndex(dayKey)], 'week')
      listFrom(d.monthly && d.monthly[dayKey] && d.monthly[dayKey].blocks, 'monthly')
      listFrom(d.overrides && d.overrides[dayKey], d.overrides[dayKey] && d.overrides[dayKey][0] ? d.overrides[dayKey][0].source : 'override')

      // 特殊日：节假日/考试/事件覆盖整天
      const ev = d.events && d.events[dayKey]
      if (ev) {
        out.length = 0
        push(out, { start: '00:00', end: '24:00', title: `【${clip(ev.title || '有事的日子', 60)}】${clip(ev.note || '', 60)}`, kind: ev.kind || 'event', source: 'event' })
      }
      if (d.holidays && d.holidays[dayKey]) {
        out.push({ start: '00:00', end: '24:00', title: `节假日·${d.holidays[dayKey]}`, kind: 'holiday', source: 'holiday' })
      }
      sortBy(out)
      return out
    }
    const push = (arr, b) => { if (b && b.start && b.end) arr.push(b) }
    const sortBy = (arr) => arr.sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(b.end) - toMin(a.end))
    const defaultKind = (s, e) => (s < '08:00' ? 'rest' : (s < '11:30' ? 'class' : (s < '13:30' ? 'meal' : (s < '18:00' ? 'study' : 'free'))))

    /** 当前块 + 下一块，用于注入 */
    const currentBlock = (d, ts) => {
      const day = dateKey(ts), t = nowHHMM(ts)
      const blocks = planFor(d, day, ts)
      let cur = null, next = null
      for (const b of blocks) {
        if (toMin(b.start) <= toMin(t) && toMin(t) < toMin(b.end)) { cur = b; break }
        if (toMin(t) < toMin(b.start) && !next) next = b
      }
      return { day, t, cur, next }
    }

    /** 为注入构造文本片段 */
    const renderTrack = (d, ts) => {
      const { day, t, cur, next } = currentBlock(d, ts)
      const b = beijing(ts)
      const head = `现在 ${day} ${b.weekday} ${t}`
      const active = cur ? `你在${cur.title}` : '你现在没有安排'
      const nxt = next ? `接下来是${next.title}（${next.start}）` : '后面暂时没有安排'
      return `【时间线·${head}】${active}；${nxt}.`
    }

    /** 为某天构造「当前块 + 后续日程」的摘要（面板/工具用） */
    const renderDay = (d, dayKey, ts) => {
      const blocks = planFor(d, dayKey, ts)
      if (!blocks.length) return { day: dayKey, blocks: [], note: dayKey + ' 没有安排' }
      const b = beijing(ts)
      const lines = blocks.map((x) => `${x.start}-${x.end} ${x.title}`)
      return {
        day: dayKey,
        holiday: holidayKey(d, dayKey, parseDate(dayKey)) ? '（' + holidayKey(d, dayKey, parseDate(dayKey)) + '）' : '',
        blocks,
        note: lines.join('；'),
        at: `${b.h}点`,
      }
    }

    /** 命中话题检测。普通闲聊不触发；涉及时间/计划/考试放假才触发。 */
    const TIMEWORD = /(今天|明天|后天|昨天|早上|中午|下午|晚上|周末|下周|这周|最近|这几日|这几天|待会|一会儿|下面|接下来|要去|去逛逛|逛街|干嘛|做什么|忙啥|期中|期末|月考|考试|放假|寒暑假|课表|上课|安排|计划|日程|行程|几点|起床|睡|午休|吃饭|吃什么|吃啥|吃|要不要)/
    const classify = (text) => {
      const s = String(text || '').trim()
      if (!s) return { hit: false }
      const hits = []
      for (const k of String(cfg().topics || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)) {
        if (s.includes(k)) hits.push(k)
      }
      if (hits.length) return { hit: true, hits }
      // 兜底：明显的时间/行程话题（即使话题表没配到）
      if (TIMEWORD.test(s)) return { hit: true, hits: ['(时间)'] }
      return { hit: false }
    }

    const buildInjection = (d, ts, cls) => {
      const mode = cfg().injectMode
      if (cfg().enabled === false || mode === 'off') return ''
      let text = renderTrack(d, ts)
      if (mode === 'always') return withToday(d, ts, text)
      if (cls.hit) return withToday(d, ts, text)
      return ''
    }
    const withToday = (d, ts, text) => {
      const until = Number(cfg().injectTodayUntil) || 0
      if (!until) return text
      const day = dateKey(ts), t = nowHHMM(ts)
      const rest = []
      for (const b of planFor(d, day, ts)) {
        if (toMin(b.start) >= toMin(t)) rest.push(`${b.start} ${b.title}`)
      }
      if (!rest.length) return text
      return `${text}\n今日${rest.join('；')}。`
    }

    // ---------- 节假日与天气 ----------
/** 内置节假日（粗略，可在面板直接改 holidays；以当年官方公布为准） */
    const builtinHolidays = (year) => {
      if (String(year) === '2026') return {
        '01-01': '元旦',
        '02-16': '春节', '02-17': '春节', '02-18': '春节', '02-19': '春节',
        '04-05': '清明',
        '05-01': '劳动节', '05-02': '劳动节假',
        '06-19': '端午',
        '09-25': '中秋',
        '10-01': '国庆', '10-02': '国庆', '10-03': '国庆',
      }
      return {}
    }
    const holidayKey = (d, dayKey, ts) => {
      const b = beijing(ts)
      if (d.holidays && d.holidays[dayKey]) return d.holidays[dayKey]
      if (b.wd === 0 || b.wd === 6) return '周末'
      const m = String(dayKey).slice(5, 10)
      return builtinHolidays(String(dayKey).slice(0, 4))[m] || ''
    }

    const weatherCache = new Map()
    const fetchWeather = async (day) => {
      const key = String(day || dateKey(now())).slice(0, 10)
      if (weatherCache.has(key)) return weatherCache.get(key)
      const res = { ok: false }
      try {
        const s = `${key}`, e = `${key}`
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${cfg().lat || 32.0603}&longitude=${cfg().lon || 118.7969}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FShanghai&start_date=${s}&end_date=${e}`
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        const code = j.daily && j.daily.weathercode && j.daily.weathercode[0]
        const rain = Number(j.daily?.precipitation_sum?.[0]) || 0
        res.ok = true
        res.text = `${cfg().city || '南京'}当天最高温 ${j.daily?.temperature_2m_max?.[0] ?? '——'}°C，降水 ${rain}mm，天气码 ${code}`
      } catch (e) {
        res.error = e?.message
      }
      weatherCache.set(key, res)
      return res
    }

    // ---------- AI 拟稿 ----------
    const moodLabel = () => {
      const m = api.use('mood')
      try { return m && m.label ? m.label() : '' } catch { return '' }
    }
    const memoryHint = () => {
      const m = api.use('memory')
      try {
        const owner = String(api.config().ownerQQ || '')
        const chat = { kind: 'private', userId: owner, chatId: 'private:' + owner }
        return m && m.contextFor ? clip(m.contextFor(chat, 'private:' + owner), 900) : ''
      } catch { return '' }
    }

    // ---------- 人格信息（让时间线随人格通用） ----------
    /** 当前人格 id（config.persona.current） */
    const currentPersonaId = () => {
      try { return String(api.config()?.persona?.current || '') } catch { return '' }
    }
    /**
     * 从人格正文里粗判身份类型，给提示词一个「每天大致干什么」的锚点。
     * 只是关键词启发，不是精确分类；判断交给模型，这里只是先给个方向。
     */
    const rhythmOf = (name, body) => {
      const t = `${name}\n${body}`
      const marks = []
      if (/上班族|打工|上班|下班|通勤|加班|早九晚|朝九晚|坐班|工位|办公室/.test(t)) marks.push('上班族')
      if (/同学|课程|早八|上课|下课|老师|学生|考试|晚自习|作业|答辩/.test(t)) marks.push('学生')
      if (/自由职业|接单|在家办公|主播|自媒体|创作|写作|画师/.test(t)) marks.push('自由职业')
      if (/创业|老板|开店|个体|电商|店主/.test(t)) marks.push('创业/个体')
      if (/全职|带娃|奶爸|宝妈|家庭主妇|主夫/.test(t)) marks.push('全职在家')
      if (/退休|养老|广场舞/.test(t)) marks.push('退休')
      return marks.slice(0, 3).join('/') || '普通城市年轻人'
    }
    /**
     * 读当前人格正文（人格卡 + 身份标签）。拿不到就用空串，调用方会用「普通日常」兜底。
     * 用 api.config().persona.current 定位人格卡；core.personas.read 可能因权限返回 null。
     */
    const personaBrief = () => {
      try {
        const id = currentPersonaId()
        const p = api.core?.personas?.read?.(id) || null
        const name = (p && p.name) || id || '她'
        const body = (p && p.body) || (api.core?.personas?.current?.() || '')
        return { id: id || (p && p.id) || '', name, body: String(body || '').trim(), rhythm: rhythmOf(name, String(body || '')) }
      } catch {
        return { id: currentPersonaId(), name: currentPersonaId() || '她', body: '', rhythm: '普通城市年轻人' }
      }
    }
    /** 周表是不是还没按当前人格建过 */
    const needsWeek = (d) => {
      const id = currentPersonaId()
      const m = d.meta || {}
      if (!id) return false // 没人格信息时不能断定
      return !m.weekPersonaId
    }
    /** 当前人格换了，旧周表还算不算数 */
    const stalePersona = (d) => {
      const id = currentPersonaId()
      const m = d.meta || {}
      if (!id || !m.weekPersonaId) return false
      return m.weekPersonaId !== id
    }

    const planPrompt = (dayKey, inputs, mode) => {
      const m = String(mode || '常规')
      const p = inputs.persona || {}
      const who = p.name || '她'
      return `你是「${who}」的日程助手。现在请按这个身份的生活节奏，拟一份「${m}」日程安排。
身份信息（据此定她「典型的一天」怎么过）：
${p.body ? p.body : '（没有拿到人格正文，就按一个普通城市年轻人的日常拟，别写成学生或上班族特定场景）'}
${p.rhythm ? '身份倾向：' + p.rhythm : ''}
日期：${inputs.head}${inputs.holiday ? '，这是' + inputs.holiday + '，按假期安排' : ''}
要求：
- 用北京时间，时间段按时间先后排列
- 按她的身份覆盖典型一天：起床、上午（上班/上课/安排）、午饭、午休、下午、晚饭、晚间（学习/自由/休息）、睡觉
- 每个块 30 分钟 ~ 4 小时合理，别写碎片
- 照顾天气、节假日和当天心情，安排得有点烟火气但不夸张
返回 JSON：{"blocks":[{"start":"HH:MM","end":"HH:MM","title":"做什么","kind":"sleep|morning|work|class|meal|nap|study|free|night"}],"note":"一句话安排思路"}
背景信息：
${inputs.webNotice ? inputs.webNotice + '。' : ''}${inputs.weather ? '天气：' + inputs.weather + '。' : ''}${inputs.mood ? '她今天心情：' + inputs.mood + '。' : ''}${inputs.memory ? '相关记忆摘录：' + inputs.memory : ''}`
    }

    const parsePlan = (txt) => {
      const raw = String(txt || '')
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return { ok: false, error: '没有拿到 JSON' }
      // 尽量喂给 JSON.parse；模型可能带中文引号/多余解释
      const candidates = [m[0], raw]
      let o = null
      for (const c of candidates) {
        try { o = JSON.parse(c); break } catch { o = null }
      }
      if (!o) {
        try { o = JSON.parse(m[0].replace(/[“”]/g, '"').replace(/　/g, ' ')) } catch { o = null }
      }
      if (!o || !Array.isArray(o.blocks) || !o.blocks.length) return { ok: false, error: '没有解析出有效的 blocks' }
      const blocks = o.blocks
        .filter((b) => b && b.start && b.end)
        .map((b) => ({ start: hhmm(b.start), end: hhmm(b.end), title: clip(b.title || b.name || '安排', 80), kind: clip(b.kind || 'free', 24) }))
        .filter((b) => toMin(b.start) < toMin(b.end))
      if (!blocks.length) return { ok: false, error: '没有可用的时间段' }
      return { ok: true, blocks, note: clip(o.note || '', 120) }
    }

    const buildInputs = async (dayKey) => {
      const ts = parseDate(dayKey)
      const holiday = holidayKey(load(), dayKey, ts)
      // 内置表里没有的日期，让会带网页搜索/浏览工具的模型去判是不是节假日/调休
      let webNotice = ''
      if (!holiday) {
        try {
          const ans = await api.ask({
            system: '你是中国节假日助手。用你可用的网页搜索/浏览工具，判断下面这一天是不是中国大陆的法定节假日、调休日还是普通工作日。只回答一行：「节假日：名称」；「调休上班日」；「普通工作日」；查不到就回「查不到」。不要多说。',
            text: `${dayKey} 这一天是不是假期/调休呢？`,
            maxTokens: 300,
          })
          const a = clip(String(ans || '').trim(), 80)
          if (!/普通工作日|查不到|不知道|不确定|无法|没搜到|搜不到/.test(a)) webNotice = a
        } catch { webNotice = '' }
      }
      const w = await fetchWeather(dayKey)
      return {
        date: dayKey,
        holiday: holiday || '',
        weather: w.ok ? w.text : '',
        mood: moodLabel(),
        memory: memoryHint(),
        persona: personaBrief(),
        webNotice,
        head: `${dayKey} 周${beijing(ts).weekday}`,
      }
    }

    const aiPlan = async (day, mode) => {
      const inputs = await buildInputs(day)
      try {
        const txt = await api.ask({ system: '你是日程规划助手，输出严格 JSON。', text: planPrompt(day, inputs, mode || '常规'), maxTokens: 1200 })
        const parsed = parsePlan(txt)
        if (!parsed.ok) return { ok: false, ...parsed, error: parsed.error }
        return { ok: true, ...parsed, inputs }
      } catch (e) {
        // 模型失败时退化为纯结构草案，保证有结果
        const struct = { ok: true, blocks: structBlocks(inputs), note: '模型调用失败，按结构生成的草案', inputs, fallback: true }
        return struct
      }
    }

    /** 模型拿不到时的兜底提纲（通用作息，不含学生专属） */
    const structBlocks = (inputs) => {
      const holiday = !!inputs.holiday
      const base = holiday
        ? [['09:00', '09:30', '起床'], ['09:30', '10:30', '洗漱/早餐'], ['10:30', '12:00', '自由/散步'], ['12:00', '13:00', '午饭'], ['13:00', '14:00', '午休'], ['14:00', '17:00', '出行/安排'], ['17:00', '18:00', '晚饭'], ['18:00', '22:30', '自由安排'], ['23:00', '23:59', '睡觉']]
        : [['07:20', '07:50', '起床洗漱'], ['07:50', '08:10', '出门/准备'], ['08:30', '12:00', '上午安排'], ['12:00', '13:00', '午饭'], ['13:00', '13:40', '午休'], ['14:00', '18:00', '下午安排'], ['18:30', '19:30', '晚饭'], ['19:30', '22:30', '晚间自由'], ['23:00', '23:59', '睡觉']]
      return base.map(([start, end, title]) => ({ start, end, title, kind: 'free' }))
    }

    /** 按当前人格重排「周一~周日」常规周表 */
    const buildWeekPrompt = (brief) => `请根据下面这个人的身份，拟一份「周一到周日」的常规日程模板（不是某一天）。
身份信息：
${brief.body ? brief.body : '（没有人格正文，按普通城市年轻人日常拟）'}
${brief.rhythm ? '身份倾向：' + brief.rhythm : ''}
要求：
- 先判断她主要是什么身份（上班族/学生/自由职业/创业者/全职在家/退休…），整份周表按该身份的固定作息排
- 周一至周五偏工作日/学习日，周六周日偏休息日/自由安排
- 每天固定覆盖：起床、上午、午饭、午休/休息、下午、晚饭、晚间、睡觉
- 全天时间段用北京时间，块 30 分钟 ~ 4 小时，别写碎片，按时间先后排
- 返回 JSON：{"week":{"1":[["07:20","07:50","起床洗漱"],...],"2":...,...,"7":...},"note":"一句话说明这套周表"}
- 键只给 1-7（1=周一，7=周日），七天都要有；值是 [开始,结束,做什么] 三元组，也可以带第 4 个 kind
身份倾向说明：只需据此定作息形状，不必照抄她的话。`

    /** 解析周表 JSON：接受 {"week":{...}} 或直接 {1:[...],...}，兼容对象块 */
    const parseWeek = (txt) => {
      const raw = String(txt || '')
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) return { ok: false, error: '没有拿到周表 JSON' }
      let o = null
      for (const c of [m[0], raw]) { try { o = JSON.parse(c); break } catch { o = null } }
      if (!o) { try { o = JSON.parse(m[0].replace(/[“”]/g, '"').replace(/　/g, ' ')) } catch { o = null } }
      const src = o && typeof o === 'object' ? (o.week && typeof o.week === 'object' ? o.week : o) : null
      if (!src) return { ok: false, error: '周表结构不对' }
      const week = {}
      for (const key of [1, 2, 3, 4, 5, 6, 7]) {
        // JSON 对象的键是字符串（"1"…"7"），数字索引取不到，两种都试
        const arr = src[key] !== undefined ? src[key] : src[String(key)]
        if (!Array.isArray(arr)) { continue }
        const blocks = []
        for (const it of arr) {
          const b = Array.isArray(it) ? { start: it[0], end: it[1], title: it[2], kind: it[3] } : it
          if (!b || !b.start || !b.end) { continue }
          const s = hhmm(b.start), e = hhmm(b.end)
          if (toMin(s) >= toMin(e)) { continue }
          blocks.push([s, e, clip(b.title || '安排', 40)])
        }
        week[key] = blocks
      }
      const filled = [1, 2, 3, 4, 5, 6, 7].filter((k) => week[k] && week[k].length)
      // 只要至少有 3 天能用就接受，缺的天用通用模板补上；全缺才判失败。
      if (!filled.length || filled.length < 3) return { ok: false, error: '周表有天缺块或格式不对' }
      for (const k of [1, 2, 3, 4, 5, 6, 7]) if (!week[k] || !week[k].length) week[k] = [['09:00', '12:00', '自由安排'], ['12:00', '18:00', '午饭/休息'], ['18:00', '23:00', '自由'], ['23:00', '23:59', '睡觉']]
      return { ok: true, week, note: clip(o && o.note, 120) || '按身份拟的周表' }
    }

    /** 重建周模板（异步，可能很慢，调用方自行 await） */
    const rebuildWeek = async (d) => {
      const brief = personaBrief()
      try {
        const inputs = await buildInputs(dateKey(now()))
        const txt = await api.ask({ system: '你是日程规划助手，输出严格 JSON。只给 JSON，不要别的话。', text: buildWeekPrompt(brief), maxTokens: 2600 })
        const parsed = parseWeek(txt)
        if (parsed.ok) return { ok: true, week: parsed.week, note: parsed.note, source: 'ai' }
        return { ok: true, week: genericWeek(), note: '模型没返回可用周表，先按通用作息建了一版：' + (parsed.error || ''), source: 'fallback' }
      } catch (e) {
        return { ok: true, week: genericWeek(), note: '模型调用失败，先按通用作息建了一版：' + (e?.message || e), source: 'fallback' }
      }
    }

    // ---------- 自动拟稿（每天到点） + 人格变更重建周表 ----------
    let lastPlanDay = ''
    let rebuiltOnce = false
    const autoTick = () => {
      const c = cfg()
      const d = load()
      if (c.autoRebuildWeek === true && (stalePersona(d) || (!rebuiltOnce && needsWeek(d)))) {
        rebuiltOnce = true
        const run = async () => {
          const r = await rebuildWeek(load())
          const nd = load()
          nd.week = r.week
          nd.meta = nd.meta || {}
          nd.meta.weekPersonaId = currentPersonaId()
          nd.meta.weekPersonality = personaBrief().rhythm || ''
          nd.meta.weekBuiltAt = now()
          nd.meta.weekSource = r.source
          nd.meta.weekNote = r.note
          if (c.autoRebuildMode === 'apply') nd.overrides = {}
          log(nd, 'rebuild', `按「${currentPersonaId()}」重建周表（${r.source}）：${r.note}`)
          save(nd)
          api.log.info(`时间线：人格变更/首次初始化，已重建周模板（${r.source}）`)
        }
        run().catch((e) => { rebuiltOnce = false; api.log.warn('时间线重建周表：' + (e?.message || e)) })
      }
      if (c.aiAutoEnabled !== true || !c.aiAutoTime) return
      const t = nowHHMM(now())
      if (t !== hhmm(c.aiAutoTime)) return
      const tomorrow = dateKey(now() + 86400000)
      if (lastPlanDay === tomorrow) return
      lastPlanDay = tomorrow
      // 异步，不阻塞定时器
      const run = async () => {
        const r = await aiPlan(tomorrow, '常规')
        if (!r.ok) { api.log.warn(`时间线：自动拟稿失败：${r.error}`); return }
        const d = load()
        if (c.aiAutoMode === 'apply') {
          d.overrides = d.overrides || {}
          d.overrides[tomorrow] = r.blocks
          d.drafts = d.drafts || {}
          d.drafts[tomorrow] = { status: 'active', blocks: r.blocks, note: r.note, createdAt: now(), source: 'ai-auto' }
        } else {
          d.drafts = d.drafts || {}
          d.drafts[tomorrow] = { status: 'draft', blocks: r.blocks, note: r.note, createdAt: now(), source: 'ai-auto' }
        }
        log(d, 'plan', `自动拟 ${tomorrow}：${r.blocks.length} 块，${r.note}`)
        save(d)
        api.log.info(`时间线：自动拟 ${tomorrow} 完成（${r.blocks.length} 块，模式 ${c.aiAutoMode}）`)
      }
      run().catch((e) => api.log.warn('时间线自动拟稿：' + (e?.message || e)))
    }

    // ---------- 提示词注入（每轮） ----------
    api.on('prompt', async (content, info) => {
      try {
        const c = cfg()
        if (c.enabled === false || c.injectMode === 'off') return content
        const chat = info && info.chat
        // 只看主人私聊：日程是她的现状，不必给群聊，避免为她造「人设/作息」外泄
        if (!chat || chat.kind !== 'private' || String(chat.userId) !== String(api.config().ownerQQ || '')) return content
        const d = load()
        const cls = classify(info?.queryText)
        const text = buildInjection(d, now(), cls)
        if (!text) return content
        const injected = [{ type: 'text', text }, ...(Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }])]
        return injected
      } catch (e) {
        api.log.warn('时间线注入出错：' + (e?.message || e))
        return content
      }
    })

    // ---------- 工具：让她回答前先查 ----------
    api.tool((where) => {
      const c = cfg()
      if (c.enabled === false || where.level !== 'full') return []
      return [api.defineTool({
        name: 'my_schedule',
        description: '查你自己的日程。别人问你「你现在在做什么 / 你几点上班或上课 / 今天、明天、周末做了什么安排 / 你是放假还是考试、在忙什么 / 今天有什么计划」时，先查它再回答。回答里说到任何时间都以查到的为准，不要凭感觉编；查不到就照实说没什么安排。date 不填默认今天。',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD，可以不填（默认今天）' } },
        execute: async ({ date }) => {
          const d = load()
          const day = String(date || dateKey(now())).slice(0, 10)
          const blocks = planFor(d, day, now())
          if (!blocks.length) return { ok: true, message: `${day} 你没有安排（没课也没计划）。`, blocks: [] }
          return { ok: true, message: blocks.map((b) => `${b.start}-${b.end} ${b.title}`).join('；'), blocks, day }
        },
      })]
    })

    // ---------- 规则 ----------
    api.rule((kind) => {
      const c = cfg()
      if (c.enabled === false || kind !== 'private') return []
      return [
        '【你的时间安排】',
        '- 别人问你你现在在做什么、今天/明天/周末有什么安排、你几点上班或上课、几点吃饭/午休/睡觉、考试放假、最近在忙什么这类时间问题时，先用 my_schedule 查你自己的日程再回答。',
        '- 回答里提到的具体时间一律以查到的为准，不要即兴编时间，也不要把上一刻说过的安排再说成另一件事。',
        '- 如果你确实没有安排就照实说没安排，不要临时编造一个日程。',
      ]
    })

    // ---------- 命令 ----------
    const toDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s).slice(0, 10) : '')
    api.command({
      name: 'timeline',
      aliases: ['时间线', '日程', '安排', '拟明天', '拟日程', '拟', '重建模板', '重建周模板', '周模板', '模板'],
      desc: '看/拟日程：/timeline（看今天）；/timeline 2026-11-10；/timeline 拟明天；/timeline 重建模板（按当前人格重排周表）',
      run: async (arg) => {
        const a = String(arg || '').trim().toLowerCase()
        const d = load()
        // 按当前人格重建「周一~周日」常规周表
        if (a === '重建模板' || a === '重建周模板' || a === '周模板' || a === '模板' || a === 'rebuild') {
          try {
            const r = await rebuildWeek(d)
            const nd = load()
            nd.week = r.week
            nd.meta = nd.meta || {}
            nd.meta.weekPersonaId = currentPersonaId()
            nd.meta.weekPersonality = personaBrief().rhythm || ''
            nd.meta.weekBuiltAt = now()
            nd.meta.weekSource = r.source
            nd.meta.weekNote = r.note
            log(nd, 'rebuild', `按「${currentPersonaId()}」重建周表（${r.source}）：${r.note}`)
            save(nd)
            const days = r.week ? Object.keys(r.week).length : 0
            const srcTxt = r.source === 'ai' ? 'AI 拟' : '模型没回，先按通用作息'
            return `已按当前人格「${personaBrief().name}」重建周模板（${days} 天，${srcTxt}）：${r.note}\n面板「时间线」页可编辑微调。`
          } catch (e) {
            return `重建周模板出错了：${e?.message || e}。可在面板里直接编辑 ` + '`week`。'
          }
        }
        if (a === '' || a === '拟明天' || a === '拟日程' || a === '拟' || a === 'ai' || a === '明天') {
          const target = dateKey(now() + 86400000)
          try {
            const r = await aiPlan(target, '常规')
            if (!r.ok) return `拟 ${target} 没成功：${r.error || '未知'}。你可在面板「时间线」页编辑。`
            const Dr = d.drafts || {}
            Dr[target] = { status: 'draft', blocks: r.blocks, note: r.note, createdAt: now(), source: r.fallback ? 'structure' : 'ai' }
            d.drafts = Dr
            log(d, 'ai', `QQ 里拟 ${target}：${r.blocks.length} 块`)
            save(d)
            const preview = r.blocks.slice(0, 3).map((b) => `${b.start}-${b.end} ${b.title}`).join('；')
            return `${target} 我拟好了（${r.blocks.length} 块${r.fallback ? '，模型没回就按结构拟的' : ''}）：${preview}${r.note ? '。思路：' + r.note : ''}\n到面板「时间线」页「应用」才生效。`
          } catch (e) {
            return `拟 ${target} 出错了：${e?.message || e}。可在面板直接编辑日程。`
          }
        }
        if (a === '存' || a === '保存') return '日程已经存在 `modules-data/timeline/timeline.json`，面板能改，改完自动生效。'
        const day = toDate(a) || dateKey(now())
        const blocks = planFor(d, day, now())
        const holiday = d.holidays && d.holidays[day] ? `（${d.holidays[day]}）` : ''
        if (!blocks.length) return `${day}${holiday} 还没有日程安排。面板「时间线」页可以编辑，或发 /timeline 拟明天 让我拟一份。`
        return `${day}${holiday}\n${blocks.map((b) => `${b.start}-${b.end} ${b.title}`).join('\n')}`
      },
    })

    // ---------- 面板路由 ----------
    api.route('/timeline', async () => ({
      ok: true,
      data: load(),
      persona: personaBrief(),
      status: { needsWeek: needsWeek(load()), stalePersona: stalePersona(load()) },
      settings: cfg(),
    }))
    api.route('/timeline/save', async (req) => {
      let b = {}
      try { b = (await api.core.http.body(req)) || {} } catch { b = {} }
      if (typeof b.json === 'string') {
        try { JSON.parse(b.json) } catch (e) { return { ok: false, error: 'JSON 语法错误：' + e.message } }
        const d = JSON.parse(b.json)
        d.holidays = d.holidays || {}
        d.overrides = d.overrides || {}
        d.drafts = d.drafts || {}
        d.log = d.log || []
        log(d, 'save', '面板保存整份日程 JSON')
        save(d)
        return { ok: true, data: load() }
      }
      if (b.patch && typeof b.patch === 'object') {
        const d = load()
        for (const [k, v] of Object.entries(b.patch)) {
          if (k === 'overrides' || k === 'holidays' || k === 'events' || k === 'monthly' || k === 'week' || k === 'drafts') {
            d[k] = { ...(d[k] || {}), ...v }
          }
        }
        log(d, 'patch', '面板保存部分字段')
        save(d)
        return { ok: true, data: load() }
      }
      return { ok: false, error: '没收到数据' }
    })
    api.route('/timeline/ai', async (req) => {
      const b = await body(req)
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date).slice(0, 10) : dateKey(now() + 86400000)
      const r = await aiPlan(day, '常规')
      if (!r.ok) return r
      const d = load()
      d.drafts = d.drafts || {}
      d.drafts[day] = { status: 'draft', blocks: r.blocks, note: r.note, createdAt: now(), source: r.fallback ? 'structure' : 'ai' }
      log(d, 'ai', `AI 拟 ${day}：${r.blocks.length} 块`)
      save(d)
      return { ok: true, date: day, blocks: d.drafts[day].blocks, note: r.note, fallback: r.fallback, inputs: r.inputs, data: load() }
    })
    api.route('/timeline/rebuild', async (req) => {
      const b = await body(req)
      try {
        const r = await rebuildWeek(load())
        const nd = load()
        nd.week = r.week
        nd.meta = nd.meta || {}
        nd.meta.weekPersonaId = currentPersonaId()
        nd.meta.weekPersonality = personaBrief().rhythm || ''
        nd.meta.weekBuiltAt = now()
        nd.meta.weekSource = r.source
        nd.meta.weekNote = r.note
        if (b.apply === true) nd.overrides = {}
        log(nd, 'rebuild', `面板重建周模板（${r.source}）：${r.note}`)
        save(nd)
        return { ok: true, week: r.week, source: r.source, note: r.note, meta: nd.meta, data: load() }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    })
    api.route('/timeline/apply', async (req) => {
      const b = await body(req)
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date).slice(0, 10) : dateKey(now())
      const blocks = Array.isArray(b.blocks) ? b.blocks : []
      if (!blocks.length) return { ok: false, error: '没有 blocks' }
      const d = load()
      d.overrides = d.overrides || {}
      d.overrides[day] = blocks.map((x) => ({ start: hhmm(x.start), end: hhmm(x.end), title: clip(x.title || '安排', 80), kind: clip(x.kind || 'free', 12), source: x.source || 'manual' }))
      d.drafts = d.drafts || {}
      if (d.drafts[day]) d.drafts[day].status = 'active'
      log(d, 'apply', `生效 ${day}：${blocks.length} 块`)
      save(d)
      return { ok: true, data: load() }
    })
    api.route('/timeline/log', async () => ({ ok: true, log: (load().log || []).slice(-50) }))
    api.route('/timeline/weather', async (req) => {
      const b = await body(req)
      const day = String(b.date || dateKey(now())).slice(0, 10)
      return { ok: true, day, weather: await fetchWeather(day) }
    })
    const body = async (req) => { try { return (await api.core.http.body(req)) || {} } catch { return {} } }

    api.every(60_000, autoTick, '时间线-自动拟稿')

    return {
      load: () => load(),
      planFor: (dayKey) => planFor(load(), dayKey, now()),
      renderTrack: (ts) => renderTrack(load(), ts || now()),
      renderDay: (dayKey) => renderDay(load(), dayKey, now()),
      classify: (text) => classify(text),
      parsePlan: (txt) => parsePlan(txt),
      parseWeek: (txt) => parseWeek(txt),
      aiPlan: (day) => aiPlan(day, '常规'),
      rebuildWeek: (d) => rebuildWeek(d || load()),
      personaBrief: () => personaBrief(),
      needsWeek: (d) => needsWeek(d || load()),
      stalePersona: (d) => stalePersona(d || load()),
      version: '1.0.0',
    }
  },
}
