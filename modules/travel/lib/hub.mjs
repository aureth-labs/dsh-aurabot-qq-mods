/**
 * travel-hub —— 出行总控（Aurabot 模块，扩展接口 v1）
 *
 * 一个入口，四件事：
 *   1) 行程：火车高铁走 12306，同城走路/骑车/开车/公交走高德，飞机等航班源
 *   2) 定位：出发后到抵达前，只出现在起点→终点这条线上的某一点（按时刻表推算，不随机）
 *   3) 出门：读 outings 的状态，一起展示
 *   4) 自检：引擎、高德 key、12306、航班 key 一次看全
 *
 * 引擎能力来自 trip-loc（它默认 engineOnly，只导出、不注册工具）。
 * @type {import('../aurabot').AurabotModule}
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export default {
  id: 'travel-hub',
  name: '出行总控',
  version: '1.0.3',
  api: 1,
  description: '行程、定位、出门合成一个入口；面板分概览 / 行程 / 定位 / 出门 / 自检五页。',
  panel: 'panel.js',
  defaults: {
    enabled: true,
    showOutings: true,
    panelWrite: true,
  },
  settings: [
    { key: 'enabled', label: '开关', type: 'switch' },
    { key: 'showOutings', label: '概览里带出门状态', type: 'switch' },
    { key: 'panelWrite', label: '允许面板改行程', type: 'switch', hint: '关掉后面板只能看，发出行/结束只能由主人在 QQ 里发 /行程 命令（只用宿主鉴权，最稳）' },
  ],
  setup(api) {
    const { hub } = api.core
    const conf = () => {
      try { return api.settings() || {} } catch { return {} }
    }
    const engineMod = () => {
      try {
        const m = api.use('trip-loc')
        return m && typeof m.plan === 'function' ? m : null
      } catch { return null }
    }
    const dataRoot = () => dirname(api.dataDir())
    // 面板令牌：一次性、限时 90 秒，只在 /overview 响应里给；跨站读不到响应体，拿不到也用不了第二次
    const nonces = new Map()
    const newNonce = () => {
      const n = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
      const now = Date.now()
      for (const [k, v] of nonces) if (v < now) nonces.delete(k)
      nonces.set(n, now + 90 * 1000)
      return n
    }
    const queryOf = (req) => {
      try { return api.core.http.query(req) || {} } catch { return {} }
    }
    const consumeNonce = (req) => {
      const n = String(queryOf(req).confirm || '')
      const exp = nonces.get(n)
      if (!exp) return { ok: false, message: '面板令牌无效或已用过（可能被别的页面在调），刷新面板再来一次。' }
      nonces.delete(n)
      if (Date.now() > exp) return { ok: false, message: '面板令牌过期了，刷新面板再来一次。' }
      return { ok: true }
    }
    const readJson = (p) => {
      try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
    }
    const realLocState = () => readJson(join(dataRoot(), 'real-loc', 'state.json')) || { place: 'home' }
    const outingsState = () => readJson(join(dataRoot(), 'outings', 'state.json'))

    function flightConf() {
      const e = engineMod()
      if (e && typeof e.flight === 'function') return e.flight()
      return { configured: false, provider: '', keyTail: '' }
    }

    // 位置只有一个事实源：行程中按行程推；没行程取最后已知位置；real-loc / outings 只作对照，不当位置
    function positionTruth() {
      const e = engineMod()
      if (e) {
        const t = e.current()
        if (t) {
          const r = e.positionAt('')
          if (r && r.ok) {
            if (r.position) {
              return { source: 'trip', lat: r.position.lat, lon: r.position.lon, name: r.position.name,
                addr: r.position.addr || '', state: r.state || 'on_way', at: r.position.at || '', trip: true }
            }
            return { source: 'trip', state: r.state || 'unknown', name: r.note || '', at: '', trip: true, no_coord: true }
          }
        }
        if (typeof e.lastPlace === 'function') {
          const lp = e.lastPlace()
          if (lp && lp.lat) return { source: 'last', lat: lp.lat, lon: lp.lon, name: lp.name || '', addr: lp.addr || '', state: 'last', at: lp.at || '', trip: false }
        }
      }
      const place = realLocState()
      return { source: 'real-loc', state: String(place.place || 'home'), name: '', at: '', trip: false, no_coord: true }
    }

    function overview() {
      const e = engineMod()
      const t = e ? e.current() : null
      const place = realLocState()
      const out = outingsState()
      const outingsTrip = !!(out && out.trip)
      const conflict = !!(t && (outingsTrip || String(place.place || '') !== 'home'))
      const pos = positionTruth()
      return {
        ok: true,
        token: newNonce(),
        trip: t
          ? { ...t, line: e.tripLine(t) }
          : null,
        position: pos,
        place: { id: place.place || 'home' },
        outings: conf().showOutings && out
          ? { placeId: out.placeId || '', trip: out.trip || null, planCount: (out.plan || []).length, lastReason: out.lastReason || '' }
          : null,
        conflict,
        conflictNote: conflict ? '行程中和 real-loc / outings 有冲突：位置只认 position 这一处（行程优先），别用 loc_send、别触发出门。' : '',
        flight: flightConf(),
        engineReady: !!e,
      }
    }

    const LEG_WORD = { 火车: 'train', 高铁: 'train', 铁路: 'train', 开车: 'drive', 驾车: 'drive', 打车: 'drive', 走路: 'walk', 步行: 'walk', 骑车: 'bike', 骑行: 'bike', 公交: 'transit', 地铁: 'transit', 飞机: 'flight', 航班: 'flight' }
    function parseLegs(arr) {
      return (arr || []).map((s) => {
        const w = String(s).split(/[,，]/).map((x) => x.trim()).filter(Boolean)
        return { mode: LEG_WORD[w[0]] || w[0], from: w[1] || '', to: w[2] || '', date: w[3] || '', code: w[4] || '' }
      })
    }
    // 工具参数由宿主传入且是只读的：这里永远返回新对象，绝不原地改
    function normalizeArgs(src) {
      const o = { ...(src || {}) }
      if (Array.isArray(o.legs) && o.legs.length) o.legs = parseLegs(o.legs)
      else delete o.legs
      if (o.from !== undefined) o.from = placeArg(o.from)
      if (o.to !== undefined) o.to = placeArg(o.to)
      for (const k of ['mode', 'date', 'code', 'city', 'depart', 'arrive', 'after', 'before', 'seat_class', 'return_date', 'return_code', 'action', 'place', 'what']) {
        if (o[k] !== undefined && o[k] !== null) o[k] = String(o[k]).trim()
      }
      return o
    }

    // 位置卡限频：同一聊天 5 分钟只发一张；状态切换（发车/到站/换乘）后的第一次放行
    const rateFile = () => join(api.dataDir(), 'card-rate.json')
    const readRate = () => { try { return JSON.parse(readFileSync(rateFile(), 'utf8')) } catch { return {} } }
    const writeRate = (v) => { try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(rateFile(), JSON.stringify(v, null, 2), 'utf8') } catch {} }
    const CARD_MIN_GAP = 5 * 60 * 1000

    // 中途改目的地：新段必须从「现在站的地方」出发，不许回到原点重算
    function replanFromHere(tl, a) {
      const t = tl.current()
      if (!t) return a
      const nowT = tl.nowText()
      const p = nowT.position
      if (!p || p.lat === undefined) {
        return { ...a, rerouteNote: '中途改道，但现在算不出你在线路上哪一点，先说好从哪走。' }
      }
      const here = `当前位置@${p.lat},${p.lon}`
      const today = new Date().toISOString().slice(0, 10)
      const tail = ((a.legs && a.legs.length)
        ? a.legs
        : [{ mode: a.mode, from: a.from, to: a.to, date: a.date, code: a.code, depart: a.depart, arrive: a.arrive, city: a.city }]
      ).map((lg) => {
        const o = { mode: lg.mode, from: lg.from, to: lg.to, date: lg.date || '', code: lg.code || '' }
        if (lg.depart) o.depart = lg.depart
        if (lg.arrive) o.arrive = lg.arrive
        if (lg.city) o.city = lg.city
        return o
      })
      const firstFrom = tail[0].from
      const nm = (s) => String(s || '').replace(/站|机场/g, '')
      const sameSpot = nm(p.name).includes(nm(firstFrom)) || (nm(firstFrom).length > 2 && nm(p.name) === nm(firstFrom))
      if (sameSpot) {
        if (tail.length === 1) {
          // 回程只排一段：按单程传，不要塞进 legs 让引擎当联程
          const { legs: _drop, ...base } = a
          return { ...base, ...tail[0] }
        }
        return { ...a, legs: tail }
      }
      const legs = [{ mode: 'drive', from: here, to: firstFrom, date: today }, ...tail]
      return { ...a, legs, rerouteNote: `已改道：先从${p.name}回${firstFrom}，再走原来那段。` }
    }

    function need() {
      const e = engineMod()
      if (!e) return { ok: false, message: '引擎模块 trip-loc 没在跑，先确认它已启用。' }
      return null
    }

    // 「从家出发」「去乐山大佛」这类口语地名：家 → 当前城市（拿不到就按常驻成都），景区名交给引擎前缀匹配
    const HOME_WORDS = /^(家|家里|家附近|家里附近|这边|这里|我这|我现在这里|home|river)$/i
    const CITY_RE = /([\u4e00-\u9fa5]{2,8}?)市/
    function homeCity() {
      try {
        const p = positionTruth()
        const t = String((p && (p.addr || p.name)) || '')
        const m = t.match(CITY_RE)
        if (m) return m[1]
      } catch { /* 没位置就退回常驻城市 */ }
      return '成都'
    }
    function placeArg(v) {
      const s = String(v || '').trim()
      if (!s) return s
      return HOME_WORDS.test(s) ? homeCity() : s
    }
    // 引擎报错一律翻成人话，并且**保证 message 不为空**：宿主渲染规则是 ok:false → 「✗ message || '没成功'」，
    // 空 message 就是主人看到的那句「没成功」。任何 ok:false 都必须带能照做的原因。
    function explainRail(r) {
      if (!r || r.ok !== false) return r
      const raw = String(r.error || r.message || r.reason || '').trim()
      const m = raw.match(/未知车站: *([^'"，；]+)/)
      if (m) {
        const nm = m[1].trim()
        return { ...r, ok: false, message: `「${nm}」不是火车站名，也不是能对上的城市。要坐车就把出发地/目的地写成城市或车站，比如「成都」「成都东」「乐山」「乐山站」；写景区名（乐山大佛、都江堰）我会按最近的车站算，实在对不上就换个说法再排。`, station_error: nm }
      }
      if (/限流|太密/.test(raw)) {
        return { ...r, ok: false, message: '12306 太密了，我这边先歇几分钟（保护性停手，不是坏了）。行程和票都还在，过几分钟再排一次就行。', raw }
      }
      if (/没回话|超时|被挡|timed out|ETIMEDOUT|ECONNRESET/.test(raw)) {
        return { ...r, ok: false, message: '12306 这次没回话（超时了）。过两三分钟再排一次；已经记下的行程不受影响。', raw }
      }
      if (/车站表没取到/.test(raw)) {
        return { ...r, ok: false, message: '12306 车站表这次没取到，过几分钟再试；我这边的备份表也没法匹配这个写法。', raw }
      }
      if (/预售|只放|15 天/.test(raw)) {
        return { ...r, ok: false, message: '12306 只放 15 天内的票，这天还没开售；换个近日期先排。', raw }
      }
      if (/没有车次/.test(raw)) {
        return { ...r, ok: false, message: '这趟车这天不跑（或已经过发车时间了），换个车次或日期。', raw }
      }
      if (/找不到车次/.test(raw)) {
        return { ...r, ok: false, message: '这条线这天没查到车次：可能没直达，也可能超出 15 天预售期；换前后一天或换个站名再排。', raw }
      }
      if (/引擎没跑起来|引擎返回看不懂|引擎脚本找不到/.test(raw)) {
        return { ...r, ok: false, message: `排程引擎没起来：${raw}。这不是站名问题，得让主人看一眼后台。`, raw }
      }
      if (raw) return { ...r, ok: false, message: `这次没排成：${raw.slice(0, 160)}`, raw }
      return { ...r, ok: false, message: '这次没排成，引擎没给原因（已写进日志，搜 travel 能看到耗时和原始返回）。' }
    }

    // 异步版（start / book / rebook / refund 这些要等引擎的）
    async function runAsync(label, fn) {
      const t0 = Date.now()
      try {
        const r = await fn()
        const ms = Date.now() - t0
        if (r && r.ok === false) api.log.warn(`[${label}] 失败 ${ms}ms：${String(r.error || r.message || '').slice(0, 200)}`)
        return explainRail(r)
      } catch (e) {
        const ms = Date.now() - t0
        api.log.warn(`[${label}] 抛异常 ${ms}ms：${e && e.message ? e.message : e}`)
        return { ok: false, message: `操作没成（${ms}ms）：${e && e.message ? e.message : e}` }
      }
    }


    // 同步版（plan 是 spawnSync，本身同步）
    function runPlan(label, fn) {
      const t0 = Date.now()
      try {
        const r = fn()
        const ms = Date.now() - t0
        if (r && r.ok === false) api.log.warn(`[${label}] 排程失败 ${ms}ms：${String(r.error || r.message || '').slice(0, 200)}`)
        return explainRail(r)
      } catch (e) {
        const ms = Date.now() - t0
        api.log.warn(`[${label}] 抛异常 ${ms}ms：${e && e.message ? e.message : e}`)
        return { ok: false, message: `排程出错了（${ms}ms）：${e && e.message ? e.message : e}` }
      }
    }


    api.tool(({ chat, sessionId }) => {
      if (!conf().enabled || chat.kind === 'system') return []
      const inGroup = () => chat.kind === 'group'
      return [
        api.defineTool({
          name: 'travel_status',
          description: '一句话看现在：有没有行程、在哪、是否在出门。群里只给模糊答案（在路上 / 没在出门），不报线路和地点。',
          properties: {},
          execute: async () => {
            const o = overview()
            const tl = engineMod()
            const stay = tl && typeof tl.stayText === 'function' ? tl.stayText() : ''
            if (inGroup()) {
              const g = o.trip ? '现在在路上。' : (stay ? '在忙，还没完。' : '没在出门。')
              return { ok: true, message: g, hint: '群里默认只说「在路上 / 在忙」；你要愿意细说，再用 travel_where 把 share 设成 true。' }
            }
            const parts = []
            parts.push(o.trip ? `行程：${o.trip.line}` : '现在没有行程')
            const pos = o.position
            if (pos && pos.lat) {
              parts.push(`位置：${pos.name}${pos.addr ? '｜' + pos.addr : ''}（${pos.source === 'trip' ? '按行程推算' : '最后已知'}，${pos.at}）`)
            } else if (pos && pos.source === 'trip') {
              parts.push(`位置：${pos.name || '按时刻表在路上'}`)
            } else {
              parts.push(`当前地点：${o.place.id}`)
            }
            if (stay) parts.push(`手上的事：${stay}`)
            if (o.outings) parts.push(o.outings.trip ? `出门中（${o.outings.placeId}）` : '没在出门')
            return { ok: true, message: parts.join('；') + '。' }
          },
        }),

        api.defineTool({
          name: 'travel_plan',
          description: '规划一次出行：同城走路/骑车/开车/公交用 transit|drive|walk|bike（高德），跨城火车高铁用 train（12306）。只出方案不保存。',
          properties: {
            mode: { type: 'string', description: 'train / transit / drive / walk / bike / flight' },
            from: { type: 'string', description: '出发地或车站（火车写城市或车站：成都、成都东；说「家」按当前城市算）' },
            to: { type: 'string', description: '目的地（火车写城市或车站：乐山、乐山站；写景区名会按最近的车站算）' },
            date: { type: 'string', description: '日期 YYYY-MM-DD（train）' },
            code: { type: 'string', description: '车次（可选）' },
            city: { type: 'string', description: '同城公交城市（transit）' },
            after: { type: 'string', description: '最早出发时刻 HH:MM（火车用）；「一早走」就填 06:00' },
            before: { type: 'string', description: '最晚到达时刻 HH:MM（火车用）；「中午前到」就填 12:00' },
            depart: { type: 'string', description: '航班起飞时刻（flight）' },
            arrive: { type: 'string', description: '航班到达时刻（flight）' },
            legs: { type: 'array', description: '联程/换乘：每段一条 "train,成都东,重庆北,2026-11-20"，第五项可带车次；段间自动留够换乘时间（同站 20 分、异站 60 分）' },
            seat_class: { type: 'string', description: '席别（可选）：高铁 二等座/一等座/商务座/特等座；普速 硬座/硬卧/软卧；飞机 经济舱/超级经济舱/公务舱。不填则按车次默认，且同趟固定不变' },
          },
          required: [],
          execute: async (a) => {
            const miss = need(); if (miss) return miss
            const tl = engineMod()
            return runPlan('travel_plan', () => tl.plan(replanFromHere(tl, normalizeArgs(a))))
          },
        }),

        api.defineTool({
          name: 'travel_go',
          description: '开始一段行程并记下来（之后问「你在哪」按这条线路推算）。参数同 travel_plan。',
          properties: {
            mode: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
            date: { type: 'string' }, code: { type: 'string' }, city: { type: 'string' },
            after: { type: 'string', description: '最早出发时刻 HH:MM（火车用）' },
            before: { type: 'string', description: '最晚到达时刻 HH:MM（火车用）' },
            depart: { type: 'string' }, arrive: { type: 'string' },
            delay: { type: 'number', description: '已知晚点分钟数（没有实时正晚点数据时由人说；不说就别填）' },
            legs: { type: 'array', description: '联程/换乘：每段一条 "train,成都东,重庆北,2026-11-20"，第五项可带车次' },
            seat_class: { type: 'string', description: '席别（可选）：高铁 二等座/一等座/商务座/特等座；普速 硬座/硬卧/软卧；飞机 经济舱/超级经济舱/公务舱。不填按车次默认，同趟固定' },
          },
          required: [],
          execute: async (a) => {
            const miss = need(); if (miss) return miss
            const tl = engineMod()
            const t0 = Date.now()
            let r
            try {
              r = await tl.start(replanFromHere(tl, normalizeArgs(a)))
            } catch (e) {
              api.log.warn(`[travel_go] 抛异常 ${Date.now() - t0}ms：${e && e.message ? e.message : e}`)
              return { ok: false, message: `出发没记上（${Date.now() - t0}ms）：${e && e.message ? e.message : e}` }
            }
            if (r && r.ok === false) {
              api.log.warn(`[travel_go] 失败 ${Date.now() - t0}ms：${String(r.error || r.message || '').slice(0, 200)}`)
              return explainRail(r)
            }
            return { ...r, booked: false, hint: (r.hint ? r.hint + '；' : '') + '行程只是记下来，票还没出；要票面就调 travel_book（非真实票据，不许说已付款）。' }
          },
        }),

        api.defineTool({
          name: 'travel_where',
          description: '算出现在位置并发一条真实位置卡片。行程中只会在起点和终点之间的线路上，按时刻推算。群里要不要告诉对方由你决定：不想说就只回「在路上」，要说就把 share 设成 true。',
          properties: {
            share: { type: 'boolean', description: '群里是否真的把位置告诉对方；单聊不用设' },
          },
          execute: async ({ share } = {}) => {
            if (inGroup() && share !== true) {
              return {
                ok: false,
                message: '群里你还没决定要报位置。不想说就说「在路上」「快到了」这类模糊话；真想报，就把 share 设成 true 再说一次。',
              }
            }
            const miss = need(); if (miss) return miss
            const tl = engineMod()
            const nowT = tl.nowText()
            const st = (nowT.position && nowT.position.state) || nowT.state || (tl.current() ? 'on_way' : 'none')
            const rate = readRate()
            const last = rate[chat.chatId]
            if (last && Date.now() - last.at < CARD_MIN_GAP && last.st === st) {
              return { ok: true, card: false, message: `${nowT.message || ''}（刚发过位置卡，这次只报文字；状态一变我就会再发一次）`, position: nowT.position || null }
            }
            const r = await tl.where(chat.chatId)
            if (r && r.ok) {
              rate[chat.chatId] = { at: Date.now(), st: (r.position && r.position.state) || st }
              writeRate(rate)
              return { ...r, card: true }
            }
            // 没有行程也没有最后位置：退到常驻地点（不拿本机定位顶替）
            const o = overview()
            if (!o.place) return { ok: false, message: '现在没有行程，也没有记下常驻地点，说不准在哪。' }
            return {
              ok: true, state: 'at_place', place: o.place.id,
              message: `现在没在路上，在${o.place.id}。`,
              hint: '没行程时以常驻地点为准；不要拿电脑本机定位顶替，那是主人的位置不是你的。',
            }
          },
        }),

        api.defineTool({
          name: 'travel_ticket',
          description: '只看票务细节（席别、车厢、座位、票价），不发图。主人要看票面/要票，必须用 travel_book 把图片发到当前聊天，不许拿这个工具的文字去复述、也不许让主人「往上翻」。',
          properties: {},
          execute: async () => {
            const miss = need(); if (miss) return miss
            return engineMod().ticket()
          },
        }),

        api.defineTool({
          name: 'travel_book',
          description: '把票面图片发到当前聊天：第一次调是「出票」，之后每次调都会把同一张票面重新发一遍（票号不变、不重复出票）。主人说「把票发我」「看看车票」就调这个，别用文字描述代替。默认对乘车人、票号、二维码打码；主人要完整票面才把 mask 设 false。',
          properties: {
            mask: { type: 'boolean', description: '是否打码（默认 true）。false 才出完整票面和可扫样式二维码' },
          },
          execute: async ({ mask } = {}) => {
            const miss = need(); if (miss) return miss
            return runAsync('travel_book', () => engineMod().book(chat.chatId, { mask: mask !== false }))
          },
        }),

        api.defineTool({
          name: 'travel_roundtrip',
          description: '往返：去程 + 回程两段一次排好（两段各自按时刻表推算，回程日期必填）。票面只覆盖回程那一段，去程单独出。',
          properties: {
            from: { type: 'string' }, to: { type: 'string' },
            date: { type: 'string', description: '去程日期 YYYY-MM-DD' },
            return_date: { type: 'string', description: '回程日期 YYYY-MM-DD' },
            code: { type: 'string', description: '去程车次（可选）' },
            return_code: { type: 'string', description: '回程车次（可选）' },
            seat_class: { type: 'string', description: '席别（可选）' },
          },
          required: ['from', 'to', 'date', 'return_date'],
          execute: async (a) => {
            const miss = need(); if (miss) return miss
            const q = normalizeArgs(a)
            if (String(q.date) > String(q.return_date)) return { ok: false, message: '回程日期不能早于去程日期。' }
            const tl = engineMod()
            const legs = [
              `train,${q.from},${q.to},${q.date}${q.code ? ',' + q.code : ''}`,
              `train,${q.to},${q.from},${q.return_date}${q.return_code ? ',' + q.return_code : ''}`,
            ]
            const args = { legs: parseLegs(legs) }
            if (q.seat_class) args.seat_class = q.seat_class
            const r = await tl.start(args)
            if (r.ok === false) return explainRail(r)
            r.message = `往返排好了：去程 ${q.date}，回程 ${q.return_date}。${r.message}`
            return { ...r, booked: false, hint: '往返是两段行程，票面各出各的；先出哪段就再说 travel_book。' }
          },
        }),

        api.defineTool({
          name: 'travel_rebook',
          description: '改签：同一段区间换日期或车次，重新排这一段；旧票作废（本来就是纪念票）。',
          properties: {
            date: { type: 'string', description: '新日期 YYYY-MM-DD' },
            code: { type: 'string', description: '新车次（可选，不填就同车次别的日期）' },
            seat_class: { type: 'string', description: '新席别（可选）' },
          },
          execute: async (a) => {
            const miss = need(); if (miss) return miss
            const tl = engineMod()
            const t = tl.current()
            if (!t) return { ok: false, message: '现在没有行程，先排一段再改签。' }
            if (t.mode === 'multi') return { ok: false, message: '联程不整段改签；要说改哪一段，先结束再重排。' }
            const old = t.booked && t.booked.no ? `旧票 ${t.booked.no} 作废。` : ''
            const args = { mode: t.mode, from: t.from, to: t.to, date: a.date || t.date, code: a.code || t.code }
            if (a.seat_class) args.seat_class = a.seat_class
            const r = await tl.start(args)
            if (r.ok) r.message = `改签好了：${r.message}${old ? ' ' + old : ''}`
            return { ...r, booked: false, hint: '改签后要票面就再调 travel_book。' }
          },
        }),

        api.defineTool({
          name: 'travel_refund',
          description: '退票：把当前这张纪念票作废（本来没付钱，不存在退款），行程还在，想再走就重新出票。',
          properties: {},
          execute: async () => {
            const miss = need(); if (miss) return miss
            const tl = engineMod()
            const t = tl.current()
            if (!t) return { ok: false, message: '现在没有行程，没有可退的票。' }
            if (!t.booked || !t.booked.no) return { ok: false, message: '这趟还没出过票，没什么可退的。' }
            const no = t.booked.no
            t.refunded = { at: new Date().toISOString().slice(0, 16).replace('T', ' '), no }
            delete t.booked
            const list = Array.isArray(t.tickets) ? t.tickets : (t.ticket ? [t.ticket] : [])
            const nos = []
            for (const x of list) if (x && x.booked) { nos.push(x.booked.no); delete x.booked }
            tl.save(t)
            return { ok: true, message: `票退了：${nos.length > 1 ? nos.join('、') : no}。纪念票本来就没付钱，不用等退款；行程还在，想走再出票。` }
          },
        }),

        api.defineTool({
          name: 'travel_stay',
          description: '给「做一件事要花多久」计时：开始（在哪、做什么、几分钟）之后，问进度只报「还剩几分钟」；没到点不许说做完了。刷手机 10 分钟、洗澡 20 分钟、煲汤 1 小时都用这个。',
          properties: {
            action: { type: 'string', description: 'start 开始 / check 查进度 / end 不记了' },
            place: { type: 'string', description: '在哪儿（start 必填），写具体点：浴室、厨房、床上' },
            what: { type: 'string', description: '做什么（可选），如 刷手机、洗澡、煲汤' },
            minutes: { type: 'number', description: '要花多久（分钟），start 必填；最长 12 小时' },
          },
          required: ['action'],
          execute: async (a = {}) => {
            const miss = need(); if (miss) return miss
            const tl = engineMod()
            const act = String(a.action || '').trim().toLowerCase()
            if (typeof tl.stayStart !== 'function') return { ok: false, message: '这个版本的引擎没有计时能力，先别用。' }
            if (act === 'start') {
              if (!a.minutes) return { ok: false, message: '要说清多久：妈妈让你刷 10 分钟，就填 10；不填我没法计时。' }
              return tl.stayStart({ place: String(a.place || '').trim(), what: String(a.what || '').trim(), minutes: a.minutes, chatId: chat.chatId || '' })
            }
            if (act === 'end') return tl.stayEnd()
            if (act === 'check') return tl.stayCheck()
            return { ok: false, message: 'action 只能是 start（开始）/ check（查进度）/ end（收掉）。' }
          },
        }),

        api.defineTool({
          name: 'travel_now',
          description: '只算位置不发出（自己心里有数时用）。',
          properties: {},
          execute: async () => {
            const miss = need(); if (miss) return miss
            return engineMod().nowText()
          },
        }),

        api.defineTool({
          name: 'travel_end',
          description: '行程结束或中途取消，之后不再按这条线推算。',
          properties: {},
          execute: async () => {
            const miss = need(); if (miss) return miss
            return engineMod().end()
          },
        }),
      ]
    })

    api.rule(() =>
      '出门在路上的时候，你只可能在「起点 → 终点」这条线路上的某一点：没出发在起点，到了在终点，途中按时刻表推算，不会凭空出现在线路以外。'
      + '有人问位置（「你在哪」「到哪了」「还有多久」都算，甚至没直说要位置）时，先自动查一次 travel_status / travel_where，不许凭印象或记忆回答：有行程就按线路算，没行程就报常驻地点。'
      + '绝对不要拿电脑本机定位、IP 归属地顶替你的位置——那是主人的坐标，报出去就是把自己钉在主人的桌子上。'
      + '群里默认只说「在路上」「快到了」这类模糊话，不报具体地点；只有你确实想让对方知道，才调 travel_where 并把 share 设成 true。'
      + '私聊里对主人可以照实报，用 travel_where 算并发位置卡片。'
      + '问未来的时刻不能给坐标，只说到站/到达时间。'
      + '飞机没有真实航班时刻就不要说坐飞机，不许编航班号。'
      + '你只在国内活动：境外（含港澳台以外的任何外国城市、机场、坐标）一律不去，有人约你去国外就直说「我出不了国」，不许排境外行程、不许假装出发、不许用估算坐标糊弄。'
      + '票务细节可以编（车厢、座位、靠窗、票价都行），但必须用 travel_ticket 里那趟行程已经定下的一份，问三次也得是同一组数字，不许每次换；也不许说成电子票截图/支付记录这种可核验凭据。'
      + '结束行程不等于回到家：`travel_end` 之后你还停在最后那个地方，要回去得真的排一段返程；没排就照实说「还在<城市>，回程还没定」。'
      + '坐标唯一来源是工具返回值：任何经纬度只能是 travel_where / 位置接口给的，自己写数字等于编造位置。'
      + '到站后别一直说自己在车站：到站 15 分钟内算刚下车，久了只能说「在<城市>」，除非整趟行程里给过停留点。'
      + '规划出来超过 2 小时没刷新，回答位置前先说「按原计划，可能有变动」。'
      + '位置卡片上只能有工具返回的名称、地址、坐标，不许自己改地址、不许在卡片上加一句「我在XX门口」这种补充；卡片是证据，不是台词。'
      + '地名对不上唯一一个地方时（工具说「有两个都对得上」），先把两个选项报出来问清楚，不许自己挑一个就走。'
      + '中途要改目的地，必须从你现在站的地方重新排；工具没给坐标就别编，老实说从哪走。'
      + '你说要去，就一定去，不会自己冻结行程；只有主人明确说「不去了」「别去」才算取消。要不要去可以自己决定，但决定了就得走完，不能中途悄悄消失。'
      + '行程排好后可以「出票」：travel_book 按票根版式生成一张票面图，属于纪念票、不具乘车效力。默认把乘车人、票号、二维码打码；主人明确要完整版才把 mask 设 false。不是真购票——不许说「已付款」「明早真付钱」「能检票上车」「可报销改签」；同一趟只出一次，重复要就给原来那张。'
      + '【票面要说实话】工具返回的 image 是空、或者带 png_error，就照实说「票号和信息有了，图没画出来」，不许说「票面弄好了」。也不许编造「界面被人挡着」「排队」「验证码」这类没发生的事；卡住了就说工具给的那句原因。'
      + '【排程报错要照实说】tools 返回「未知车站」「车站表没取到」「12306 限流」这些，原话照实讲卡在哪一步：是站名写法、数据源取不到、还是问太密了。能改成城市/车站名就改一次再排；是限流就说过几分钟再试。不许把「排不出来」编成「成都东都不认识」，也不许一句「我去车站现场买」就把问题糊过去。工具返回的 message 就是原话，不许自己缩成「没成功」这种没原因的话。'
      + '【时间只认工具，不许自己算】「现在几点」「几号」「过了多久」「还有多久」全部以 travel_status / travel_now 返回的时刻为准，不许凭感觉、不许按对话开始的时间推。没查工具就不要报钟点；查到的和你以为的不一样，以工具为准。'
      + '【要做多久的事，先落计时】主人说「去刷 10 分钟」「洗个澡 20 分钟」「帮我看 40 分钟汤」这种带时长的活，先说一句要去，然后立刻 travel_stay start（place / what / minutes），别只在嘴上答应。'
      + '【没到点不许说做完】答应了 10 分钟，就只在 travel_stay check 返回 active=false 之后才可以说「做完了／回来了」。中途被问「好了没」「你在干嘛」，就照工具结果说「还在<place>，还剩 X 分钟」，不许提前结束、不许含糊说「快了」。'
      + '【不自己改时长】工具给剩 7 分钟就报 7 分钟；不许因为对方催就把 10 分钟缩成 3 分钟，也不许无限延长。真要提前收尾，只能是被明确叫停（「别做了」「快出来」），并说清「本来要到点，你叫我就提前停了」。'
      + '【同一时间只做一件事·任何时候】手里那件计时的事没到点、也没被叫停，就绝不开第二件：不许一边洗澡一边刷手机，不许「顺手再煮个汤」。工具回「手上还有一件事没完」就是提醒你专注，等它到点或先收掉（travel_stay end）再换下一件。回话也算一件事：手上没停就别边做边聊，要聊先 travel_stay end，回完想接着做就按剩余分钟重新 start。'
      + '【到点才回去】计时到点前，你就还在那个地方做那件事，不算回到主人身边；到点后第一次回应要先交代「刚做完（几点到点）」，再说别的。')

    // ---------- 面板接口（每页一组） ----------
    api.route('/overview', () => overview())

    api.route('/plan', async (req) => {
      const miss = need(); if (miss) return miss
      return runPlan('route:/plan', () => engineMod().plan(normalizeArgs(queryOf(req))))
    })

    api.route('/go', async (req) => {
      const miss = need(); if (miss) return miss
      if (conf().panelWrite === false) return { ok: false, message: '面板写入已关：发出行/结束请由主人在 QQ 里发 /行程 命令（走宿主主人鉴权）。' }
      const nv = consumeNonce(req); if (!nv.ok) return nv
      const q = normalizeArgs(queryOf(req))
      q.delay = q.delay === undefined || q.delay === '' ? null : Number(q.delay)
      // 面板是主人手点的，按表单原样出发；不替他改成「从当前位置改道」
      return runAsync('route:/go', () => engineMod().start(q))
    })

    api.route('/end', async (req) => {
      const miss = need(); if (miss) return miss
      if (conf().panelWrite === false) return { ok: false, message: '面板写入已关：发出行/结束请由主人在 QQ 里发 /行程 命令（走宿主主人鉴权）。' }
      const nv = consumeNonce(req); if (!nv.ok) return nv
      return engineMod().end()
    })

    api.route('/roundtrip', async (req) => {
      const miss = need(); if (miss) return miss
      if (conf().panelWrite === false) return { ok: false, message: '面板写入已关：发出行/结束请由主人在 QQ 里发 /行程 命令（走宿主主人鉴权）。' }
      const nv = consumeNonce(req); if (!nv.ok) return nv
      const q = normalizeArgs(queryOf(req))
      if (!q.from || !q.to || !q.date || !q.return_date) return { ok: false, message: '往返要出发地、目的地、去程日期、回程日期。' }
      const tl = engineMod()
      const legs = [
        `train,${q.from},${q.to},${q.date}${q.code ? ',' + q.code : ''}`,
        `train,${q.to},${q.from},${q.return_date}${q.return_code ? ',' + q.return_code : ''}`,
      ]
      const args = { legs: parseLegs(legs) }
      if (q.seat_class) args.seat_class = q.seat_class
      return runAsync('route:/roundtrip', () => tl.start(args))
    })

    api.route('/rebook', async (req) => {
      const miss = need(); if (miss) return miss
      if (conf().panelWrite === false) return { ok: false, message: '面板写入已关：改签请在 QQ 里让角色自己改（走宿主主人鉴权）。' }
      const nv = consumeNonce(req); if (!nv.ok) return nv
      const q = queryOf(req)
      const tl = engineMod()
      const t = tl.current()
      if (!t) return { ok: false, message: '现在没有行程，先排一段再改签。' }
      if (t.mode === 'multi') return { ok: false, message: '联程不整段改签；要说改哪一段，先结束再重排。' }
      return runAsync('route:/rebook', () => tl.start({ mode: t.mode, from: t.from, to: t.to, date: String(q.date || t.date), code: String(q.code || t.code), seat_class: String(q.seat_class || t.seat_class || '') }))
    })

    api.route('/refund', async (req) => {
      const miss = need(); if (miss) return miss
      if (conf().panelWrite === false) return { ok: false, message: '面板写入已关：退票请在 QQ 里让角色自己退（走宿主主人鉴权）。' }
      const nv = consumeNonce(req); if (!nv.ok) return nv
      const tl = engineMod()
      const t = tl.current()
      if (!t) return { ok: false, message: '现在没有行程，没有可退的票。' }
      const list = Array.isArray(t.tickets) ? t.tickets : (t.ticket ? [t.ticket] : [])
      const nos = []
      for (const x of list) if (x && x.booked) { nos.push(x.booked.no); delete x.booked }
      if (!nos.length) return { ok: false, message: '这趟还没出过票，没什么可退的。' }
      delete t.booked
      t.refunded = { at: new Date().toISOString().slice(0, 16).replace('T', ' '), nos }
      tl.save(t)
      return { ok: true, message: `票退了：${nos.join('、')}。纪念票本来就没付钱，不用等退款；行程还在，想走再出票。` }
    })

    api.route('/here', async (req) => {
      const miss = need(); if (miss) return miss
      let at = ''
      try { const q = api.core.http.query(req) || {}; at = String(q.at || '') } catch {}
      const r = engineMod().positionAt(at)
      return r.ok ? r : { ok: false, message: r.error || '算不出来' }
    })

    api.route('/outings', () => ({ ok: true, state: outingsState() }))

    api.route('/selfcheck', async () => {
      const out = {}
      const t0 = Date.now()
      const e = engineMod()
      out.tz = (() => {
        const local = -new Date().getTimezoneOffset() / 60
        if (!e) return { ok: false, detail: '引擎没加载，判不了时区' }
        try {
          const r = e.engine({ op: 'plan', mode: 'drive', from: '成都', to: '德阳' })
          const tz = r.trip && r.trip.tz
          return tz === 8
            ? { ok: true, detail: `行程按所在地 UTC+8（本机 UTC${local >= 0 ? '+' : ''}${local}）` }
            : { ok: false, detail: `行程时区 ${tz} 不对（本机 UTC${local}）` }
        } catch (err) { return { ok: false, detail: String(err?.message || err) } }
      })()
      out.engineModule = { ok: !!e, detail: e ? 'trip-loc 已导出' : 'trip-loc 没加载' }
      if (e) {
        out.drive = await (async () => {
          try {
            const r = e.engine({ op: 'plan', mode: 'drive', from: '成都', to: '德阳' })
            return r.ok ? { ok: true, detail: `${r.trip.distance_km} km / ${r.trip.duration_min} min`, ms: Date.now() - t0 } : { ok: false, detail: r.error }
          } catch (err) { return { ok: false, detail: String(err?.message || err) } }
        })()
        out.train = await (async () => {
          try {
            const d = new Date()
            const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            const r = e.engine({ op: 'plan', mode: 'train', from: '成都东', to: '重庆北', date })
            return r.ok ? { ok: true, detail: `${r.trip.code} ${r.trip.depart} → ${r.trip.arrive}` } : { ok: false, detail: r.error }
          } catch (err) { return { ok: false, detail: String(err?.message || err) } }
        })()
        out.trip = e.current() ? { ok: true, detail: e.tripLine(e.current()) } : { ok: false, detail: '没有行程（正常）' }
      }
      out.flight = (() => {
        const f = flightConf()
        return f.configured ? { ok: true, detail: `${f.provider || '已接'}，尾号 ${f.keyTail}` } : { ok: false, detail: '留空：飞机不可用（不编班次）' }
      })()
      out.totalMs = Date.now() - t0
      return { ok: true, checks: out }
    })

    // 主人专用命令：只有宿主认定的主人能触发，等于给写操作上了真鉴权
    const MODE_WORD = { 火车: 'train', 高铁: 'train', 铁路: 'train', 开车: 'drive', 驾车: 'drive', 打车: 'drive', 走路: 'walk', 步行: 'walk', 骑车: 'bike', 骑行: 'bike', 公交: 'transit', 地铁: 'transit', 飞机: 'flight', 航班: 'flight' }
    api.command({
      name: '行程',
      aliases: ['出行'],
      desc: '出行总控（只认主人）：/行程 出发 <方式> <从> <到> [车次] ｜ /行程 在哪 ｜ /行程 状态 ｜ /行程 结束',
      run: async (arg) => {
        const s = String(arg || '').trim()
        const w = s.split(/\s+/).filter(Boolean)
        const sub = w[0] || '状态'
        if (sub === '结束' || sub === '到了' || sub === '取消') return engineMod().end()
        if (sub === '在哪' || sub === '位置') return engineMod().where('')
        if (sub === '状态') {
          const o = overview()
          return o.trip ? `在路上：${o.trip.line}` : '现在没有行程'
        }
        if (sub === '出发') {
          const mode = MODE_WORD[w[1] || '']
          if (!mode) return '方式要说清楚：火车 / 开车 / 走路 / 骑车 / 公交 / 飞机'
          const fr = w[2], to = w[3], code = w[4]
          if (!fr || !to) return '用法：/行程 出发 火车 成都东 重庆北 [车次]'
          const r = engineMod().start({ mode, from: fr, to, code })
          return r.message || (r.ok ? '记下了。' : '没成。')
        }
        return '用法：/行程 出发 <方式> <从> <到> [车次] ｜ /行程 在哪 ｜ /行程 状态 ｜ /行程 结束'
      },
    })

    api.log.info('出行总控已加载')
  },
}


