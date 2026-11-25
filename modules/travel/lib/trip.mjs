/**
 * trip-loc —— 出行定位引擎模块（Aurabot 模块，扩展接口 v1）
 *
 * 默认 engineOnly=true：本模块只做引擎，不注册工具，能力和状态通过 setup 导出给 travel-hub 总模块；
 * 想把工具留在这里，就把设置里的 engineOnly 关掉。
 *
 * 规则：出发后、到达前，她只可能出现在「起点 → 终点」这条线上的某一点，该点按时刻表 / 分段耗时推算，不随机。
 *
 * @type {import('../aurabot').AurabotModule}
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const PI = Math.PI
const AXIS = 6378245.0
const EE = 0.00669342162296594323

function outOfChina(lat, lon) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55)
}
function tLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  r += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0
  r += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0
  return r
}
function tLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  r += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0
  r += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0
  return r
}
function gcj(lat, lon) {
  if (outOfChina(lat, lon)) return { lat, lon }
  let dLat = tLat(lon - 105.0, lat - 35.0)
  let dLon = tLon(lon - 105.0, lat - 35.0)
  const radLat = lat / 180.0 * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sq = Math.sqrt(magic)
  dLat = (dLat * 180.0) / ((AXIS * (1 - EE)) / (magic * sq) * PI)
  dLon = (dLon * 180.0) / (AXIS / sq * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lon: lon + dLon }
}

function locCard(spot, note) {
  const c = gcj(Number(spot.lat), Number(spot.lon))
  const address = String(spot.addr || '').replace(/\s+/g, '')
  // 卡片只放工具给的真实字段（名称、地址、坐标）；desc 固定，不让模型往里塞话
  void note
  const token = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  return {
    type: 'json',
    data: {
      data: JSON.stringify({
        app: 'com.tencent.map',
        config: { autosize: false, ctime: Math.floor(Date.now() / 1000), forward: true, token, type: 'normal' },
        desc: '按行程推算的位置',
        from: 1,
        meta: {
          'Location.Search': {
            address,
            enum_relation_type: 0,
            from: 'plusPanel',
            from_account: 0,
            id: '',
            lat: c.lat.toFixed(6),
            lng: c.lon.toFixed(6),
            name: spot.name,
            uint64_peer_account: 0,
          },
        },
        prompt: `[位置]${spot.name}`,
        ver: '1.1.2.21',
        view: 'LocationShare',
      }),
    },
  }
}

const MODE_LABEL = { train: '火车', transit: '公交地铁', drive: '开车', walk: '走路', bike: '骑车', flight: '飞机' }

function hm(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default {
  id: 'trip-loc',
  name: '出行定位引擎',
  version: '1.2.6',
  api: 1,
  description: '出行定位的引擎与数据源：同城走高德、跨城走 12306、飞机等航班源。默认只导出能力，工具由 travel-hub 统一提供。',
  defaults: {
    enabled: true,
    engineOnly: true,
    pythonPath: '',
    enginePath: '',
    flightKey: '',
    flightProvider: '',
  },
  settings: [
    { key: 'enabled', label: '开关', type: 'switch' },
    { key: 'engineOnly', label: '只当引擎', type: 'switch', hint: '打开后不注册工具，能力交给 travel-hub 总模块统一对外' },
    { key: 'pythonPath', label: 'Python 路径', type: 'text' },
    { key: 'enginePath', label: '引擎脚本', type: 'text' },
    { key: 'flightProvider', label: '航班数据源', type: 'select', options: [{ value: '', label: '未接（飞机不可用）' }, { value: 'variflight', label: '飞常准' }, { value: 'other', label: '其他' }] },
    { key: 'flightKey', label: '航班数据源 Key', type: 'password', hint: '先留空；填了才启用飞机段' },
    { key: 'stayNotify', label: '活动到点主动提醒', type: 'switch', hint: '打开后，「刷 10 分钟」这类计时到点会主动发一句做完了；默认关，怕打扰' },
  ],
  setup(api) {
    const { hub } = api.core
    const stateFile = join(api.dataDir(), 'trip.json')
    const conf = () => {
      try { return api.settings() || {} } catch { return {} }
    }

    // 读盘后把三处镜像对齐：tickets[0] / ticket / booked 必须是同一份内容，
    // 否则「补画票面」只更新了 tickets，面板和顶层还读到空图
    const current = () => {
      try {
        const t = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (t && Array.isArray(t.tickets) && t.tickets.length) {
          t.ticket = t.tickets[0]
          if (t.ticket && t.ticket.booked) t.booked = { ...t.ticket.booked }
        }
        return t
      } catch { return null }
    }
    const save = (t) => {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(stateFile, JSON.stringify(t, null, 2), 'utf8') } catch (e) { api.log.warn('写 trip.json 失败：' + e.message) }
    }
    const clear = () => {
      try { rmSync(stateFile, { force: true }) } catch {}
    }

    // 模块根目录：用来把「相对路径」解析成模块内的东西（assets/engine 等）
    const MOD_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
    const resolveIn = (p) => {
      const s = String(p || '').trim()
      if (!s) return ''
      return isAbsolute(s) ? s : join(MOD_ROOT, s)
    }
    // Python：设置里填的 → 模块内 runtime\python.exe（离线包才有）→ PATH 里的 python / python3
    const pickPython = (c) => {
      const list = [resolveIn(c.pythonPath), join(MOD_ROOT, 'runtime', 'python.exe')].filter(Boolean)
      for (const x of list) { try { if (existsSync(x)) return x } catch {} }
      return process.platform === 'win32' ? 'python' : 'python3'
    }
    // 引擎/票面共用的临时根：dataDir 上一级的 tmp，实在不行再退回系统临时目录
    const tmpRoot = () => {
      const p = join(api.dataDir(), '..', 'tmp')
      try { mkdirSync(p, { recursive: true }) } catch {}
      return p
    }

    // 引擎边界：任何失败都同时给 error 和 message，别让上层拿到一个没有理由的 ok:false
    function engine(req) {
      const c = conf()
      // 引擎默认跟着模块走（模块目录下的 assets/engine/），设置里填了就用设置里的
      const HERE = dirname(fileURLToPath(import.meta.url))
      const script = resolveIn(c.enginePath) || join(HERE, '..', 'assets', 'engine', 'tripgeo.py')
      const bad = (msg) => ({ ok: false, error: msg, message: msg })
      if (!script || !existsSync(script)) return bad(`引擎脚本找不到：${script || '(空)'}`)
      const bin = pickPython(c)
      let r
      try {
        // 明确把 UTF-8 交给 Python：宿主进程可能带着 GBK/其他编码，站名会变成乱码再报「未知车站」
        r = spawnSync(bin, [script, 'json'], {
          input: Buffer.from(JSON.stringify(req), 'utf8'),
          encoding: 'utf8',
          timeout: 150000,
          windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TRAVEL_TMP: tmpRoot() },
        })
      } catch (e) {
        return bad('引擎没跑起来：' + e.message)
      }
      if (r.error) {
        if (r.error.code === 'ETIMEDOUT') return bad(`引擎跑了 ${Math.round(150000 / 1000)}s 还没回（12306 可能卡住了），过几分钟再排`)
        return bad('引擎没跑起来：' + r.error.message)
      }
      const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const j = JSON.parse(line)
        if (!j || typeof j !== 'object') throw new Error('bad json')
        if (j.ok === false && !j.message) j.message = String(j.error || '引擎失败但没给原因')
        return j
      } catch {
        return bad(`引擎返回看不懂：${(line || r.stderr || '').slice(0, 200)}`)
      }
    }

    const lastFile = () => join(api.dataDir(), 'last-place.json')
    const readLast = () => {
      try { return JSON.parse(readFileSync(lastFile(), 'utf8')) } catch { return null }
    }
    const saveLast = (v) => {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(lastFile(), JSON.stringify(v, null, 2), 'utf8') } catch (e) { api.log.warn('写 last-place 失败：' + e.message) }
    }

    // ---------- 停留/活动计时：治「让她刷 10 分钟，2 分钟就回来了」 ----------
    // 关键：开始时刻和时长落成文件，进度按时钟算，不靠她自己记；没到点就没资格说「做完了」。
    const stayFile = () => join(api.dataDir(), 'stay.json')
    const readStay = () => {
      try { return JSON.parse(readFileSync(stayFile(), 'utf8')) } catch { return null }
    }
    const writeStay = (v) => {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(stayFile(), JSON.stringify(v, null, 2), 'utf8') } catch (e) { api.log.warn('写 stay 失败：' + e.message) }
    }
    function stayOf(src) {
      const s = src || readStay()
      if (!s || !s.due) return null
      if (s.ended) return null   // 手动收掉的就不算还在做
      const leftMs = new Date(s.due).getTime() - Date.now()
      return { ...s, active: leftMs > 0, left_min: Math.max(0, Math.round(leftMs / 60000)), dueText: hm(new Date(s.due)) }
    }
    function stayStart({ place, what = '', minutes, chatId = '' } = {}) {
      const m = Math.round(Number(minutes) || 0)
      if (!place || !m || m <= 0) return { ok: false, message: '要说清三件事：在哪、做什么、多久（分钟）。' }
      if (m > 12 * 60) return { ok: false, message: '一次别记超过 12 小时，太长了记不准；真要过夜就分开记。' }
      // 同一时间只做一件事：手上那件没到点就别再开第二件
      const cur = stayOf()
      if (cur && cur.active) {
        return { ok: false, busy: true, left_min: cur.left_min, stay: cur,
          message: `手上还有一件事没完：在${cur.place}${cur.what ? '（' + cur.what + '）' : ''}，还剩约 ${cur.left_min} 分钟，${cur.dueText} 才完。同一时间只做一件事——任何时候都只能有一件：等它到点，或者先收掉再开新的。` }
      }
      const now = new Date()
      const st = { place: String(place), what: String(what || '').trim(), start: now.toISOString(), minutes: m,
        due: new Date(now.getTime() + m * 60000).toISOString(), chatId: String(chatId || ''), notified: false }
      writeStay(st)
      const s = stayOf(st)
      return { ok: true, stay: s, left_min: s.left_min, due: s.dueText,
        message: `记下了：在${st.place}${st.what ? '（' + st.what + '）' : ''}，${m} 分钟，${s.dueText} 才完。这中间问你就是还没完。` }
    }
    function stayCheck() {
      const s = stayOf()
      if (!s) return { ok: true, active: false, message: '现在没有在计时的活动。' }
      if (s.active) {
        return { ok: true, active: true, left_min: s.left_min, due: s.dueText, stay: s,
          message: `还在${s.place}${s.what ? '（' + s.what + '）' : ''}，还剩约 ${s.left_min} 分钟，${s.dueText} 才完。`,
          hint: '要开口回话就先把这件收掉（travel_stay end），回完想接着做再按剩余分钟重新 start；不许边做边聊。' }
      }
      return { ok: true, active: false, done: true, stay: s,
        message: `${s.what || '那件事'}已经做完了（${s.dueText} 到点，共 ${s.minutes} 分钟）。现在才算完。` }
    }
    function stayEnd() {
      const s = stayOf()
      writeStay({ ended: true, at: new Date().toISOString() })
      return { ok: true, stay: s, message: s ? `好，${s.what || '那件事'}不记了。` : '本来也没在计时。' }
    }
    function stayText() {
      const s = stayOf()
      if (!s) return ''
      return s.active
        ? `在${s.place}${s.what ? '（' + s.what + '）' : ''}，还剩约 ${s.left_min} 分钟`
        : `${s.what || '那件事'}已经做完了（${s.dueText}）`
    }
    // 到点主动唤醒（默认关：怕半夜乱发消息；开了才会在到点时给原会话发一句「做完了」）
    function stayTick() {
      const s = stayOf()
      if (!s || s.active || s.notified || !s.chatId) return
      const c = conf()
      if (!c.stayNotify) return
      try {
        api.sendText(s.chatId, `${s.what || '那件事'}做完了，${s.dueText} 到点。`)
        writeStay({ ...readStay(), notified: true })
      } catch (e) { api.log.warn('stay 到点提醒失败：' + e.message) }
    }

    function tripLine(t) {
      if (!t) return ''
      const p = t.plan || {}
      if (p.mode === 'multi' && Array.isArray(p.legs)) {
        return p.legs.map((lg, i) => `${i + 1}. ${lg.code || MODE_LABEL[lg.mode] || lg.mode} ${lg.from} ${lg.depart || ''} → ${lg.to} ${lg.arrive || ''}`).join('；')
      }
      if (t.mode === 'train') return `${p.code || t.code} ${p.from || t.from} ${p.depart || ''} 开 → ${p.to || t.to} ${p.arrive || ''} 到`
      if (t.mode === 'flight') return `${t.from} ${p.depart || ''} 起飞 → ${t.to} ${p.arrive || ''} 落地`
      return `${MODE_LABEL[t.mode] || t.mode} ${t.from} → ${t.to}${p.duration_min ? `（约 ${p.duration_min} 分钟）` : ''}`
    }
    const fmtPos = (p) => {
      const parts = [p.name]
      if (p.addr) parts.push(p.addr)
      if (p.next_station) parts.push(`下一站 ${p.next_station} ${p.next_arrive} 到`)
      return parts.filter(Boolean).join('｜')
    }

    function plan(o) {
      const r = o.legs && o.legs.length
        ? engine({ op: 'plan', legs: o.legs })
        : engine({ op: 'plan', mode: o.mode, from: o.from, to: o.to, date: o.date, code: o.code, city: o.city, depart: o.depart, arrive: o.arrive,
            after: o.after, before: o.before })
      if (!r.ok) return r
      const t = r.trip
      const message = t.mode === 'multi'
        ? `联程：${(t.legs || []).length} 段，${t.depart} 出发 → ${t.arrive} 到达（${t.from} → ${t.to}）。`
        : t.mode === 'train'
          ? `${t.code}：${t.from} ${t.depart} 开 → ${t.to} ${t.arrive} 到，中途经停 ${Math.max(0, (t.stops || []).length - 2)} 站。`
          : t.mode === 'flight'
            ? `${t.from} ${t.depart} 起飞 → ${t.to} ${t.arrive} 落地。`
            : `${MODE_LABEL[t.mode] || t.mode} ${t.from} → ${t.to}，${t.distance_km} km，约 ${t.duration_min} 分钟。`
      return { ok: true, message, trip: t }
    }

    const parseT = (s) => {
      const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null
    }

    function start(o) {
      const c = conf()
      if ((o.mode === 'flight' || o.mode === 'plane') && !String(c.flightKey || '').trim() && !(o.depart && o.arrive)) {
        return { ok: false, message: '飞机还没接航班数据源（Key 留空），我不会编一个航班号。要么给我真实起降时刻，要么先不坐飞机。' }
      }
      const legList = Array.isArray(o.legs) ? o.legs : []
      const multiLeg = legList.length > 1
      const q = legList.length === 1 ? { ...o, ...legList[0] } : o
      const want = multiLeg
        ? { op: 'plan', legs: legList }
        : { op: 'plan', mode: q.mode, from: q.from, to: q.to, date: q.date, code: q.code, city: q.city, depart: q.depart, arrive: q.arrive,
            after: q.after, before: q.before }
      // 开始时刻交给引擎按「行程所在地当地时间」记，不拿本机时钟
      const r = engine(want)
      if (!r.ok) return { ok: false, message: r.error }
      if (r.trip.mode === 'train') {
        const arr = parseT(r.trip.arrive)
        if (arr && Date.now() > arr.getTime()) {
          return { ok: false, message: `${r.trip.code} ${r.trip.arrive} 已经到站了，现在再挂这趟算出来的位置是假的；要坐就换下一班或明天。` }
        }
      }
      // 排出来的那一刻以「计划」为准：请求的车次没排上时，别把请求值和实际计划混着用（票面会串站）
      const p0 = r.trip || {}
      const picked = !multiLeg
      const t = {
        mode: multiLeg ? 'multi' : (picked && p0.mode) || q.mode,
        from: (picked && p0.from) || q.from, to: (picked && p0.to) || q.to,
        date: (picked && (p0.depart || '').slice(0, 10)) || q.date || '',
        code: (picked && p0.code) || q.code || '',
        city: q.city || '',
        legs: multiLeg ? legList : null,
        plan: r.trip, note: q.note || '', startedAt: r.trip.start_at || r.trip.depart || '', at: new Date().toISOString(),
        tz: r.trip.tz, plan_at: new Date().toISOString(), seat_class: String(q.seat_class || ''),
        delay: (q.delay === undefined || q.delay === null || q.delay === '') ? null : Number(q.delay),
      }
      if (picked && q.code && p0.code && String(p0.code).toUpperCase() !== String(q.code).toUpperCase()) {
        t.requested_code = String(q.code)
        t.note = `你要的 ${q.code} 这天没排上，改成了 ${p0.code}${t.note ? '；' + t.note : ''}`
      }
      const tks = buildTickets(t)
      if (tks && tks.seatError) return { ok: false, message: tks.seatError }
      t.tickets = Array.isArray(tks) ? tks : []
      t.ticket = t.tickets[0] || null
      save(t)
      // 排好行程就把这趟的坐标/走廊一次取全（之后问位置几乎不再打高德）；失败不挡挂行程
      try {
        const wreq = multiLeg
          ? { op: 'warm', legs: legList }
          : { op: 'warm', mode: q.mode, from: q.from, to: q.to, date: q.date, code: q.code, city: q.city,
              depart: q.depart, arrive: q.arrive, stops: r.trip.stops,
              start: q.mode === 'train' ? undefined : (r.trip.start_at || r.trip.depart) }
        const w = engine(wreq)
        if (w && w.ok) api.log.info(`行程预热完成：这次取了 ${w.warm_calls} 条，今日累计 ${w.used_today} 次`)
      } catch (e) { api.log.warn?.('预热没成（不影响行程）：' + (e?.message || e)) }
      return { ok: true, message: `行程记下了：${tripLine(t)}。问「你在哪」我会按时刻推算到线路上。`, trip: t }
    }

    function positionAt(at) {
      const t = current()
      if (!t) return { ok: false, error: '现在没有在路上的行程' }
      const req = t.mode === 'multi'
        ? { op: 'where', legs: (t.plan && t.plan.legs) || t.legs, at: at || hm() }
        : {
          op: 'where', mode: t.mode, from: t.from, to: t.to, date: t.date, code: t.code,
          city: t.city, start: t.mode === 'train' ? undefined : t.startedAt, at: at || hm(),
        }
      if (t.delay !== null && t.delay !== undefined) req.delay = Number(t.delay)
      if (t.mode === 'train' && t.plan && Array.isArray(t.plan.stops) && t.plan.stops.length) req.stops = t.plan.stops
      const r = engine(req)
      if (!r.ok) return r
      return { ok: true, state: r.state || 'on_way', position: r.position || null, note: r.note || '', planArrive: r.plan_arrive || '', trip: t }
    }

    const lastLine = (lp) => {
      if (!lp) return ''
      const ageH = (Date.now() - new Date(lp.at).getTime()) / 3600000
      return ageH > 24 ? `上次在${lp.name}（${lp.at}）` : lp.name
    }

    const staleNote = (t) => {
      if (!t || !t.plan_at) return ''
      const age = (Date.now() - new Date(t.plan_at).getTime()) / 3600000
      return age > 2 ? '（按原计划，可能有变动）' : ''
    }

    async function where(chatId, note) {
      const t = current()
      if (!t) {
        // 没行程也不瞬移回家：报最后已知位置
        const lp = readLast()
        if (!lp) return { ok: false, message: '现在没有在路上的行程，也还没记下最后在哪。' }
        const ageH = (Date.now() - new Date(lp.at).getTime()) / 3600000
        if (ageH > 24) return { ok: true, message: `${lastLine(lp)}，这之后没再动过。`, position: null }
        if (chatId && lp.lat) {
          try {
            await api.sendSegments(chatId, [locCard({ lat: lp.lat, lon: lp.lon, name: lp.name, addr: lp.addr || '' })], 'trip-loc 最后位置')
            return { ok: true, message: `定位发出去了：${lp.name}${lp.addr ? '｜' + lp.addr : ''}。现在没在路上，还在那儿。`, position: lp }
          } catch (e) {
            return { ok: false, message: `定位没发出去：${e?.message || '网关不接受'}。` }
          }
        }
        return { ok: true, message: `现在没在路上，还在${lp.name}。回程还没定。`, position: lp }
      }
      const r = positionAt()
      if (!r.ok) return { ok: false, message: r.error }
      if (!r.position) {
        if (r.state === 'not_started') return { ok: true, message: `${staleNote(r.trip)}还没出发，我在${r.trip.from}等着。` }
        if (r.state === 'arrived_sched') {
          return { ok: true, message: `${staleNote(r.trip)}按时刻表该到${r.trip.to}了，但 12306 的正晚点查不到，真晚点了我就还在路上——这个位置我不瞎报。` }
        }
        return { ok: true, message: `${staleNote(r.trip)}已经到${r.trip.to}了。` }
      }
      const p = r.position
      const spot = { lat: p.lat, lon: p.lon, name: p.name, addr: p.addr || '' }
      const stale = staleNote(r.trip)
      try {
        if (!chatId) return { ok: false, message: '没有活跃会话能发定位。' }
        await api.sendSegments(chatId, [locCard(spot)], 'trip-loc 行程定位')
        return { ok: true, message: `${stale}定位发出去了：${fmtPos(p)}。位置是按${MODE_LABEL[r.trip.mode] || r.trip.mode}时刻算出来的，在线路上。`, position: p, stale: !!stale }
      } catch (e) {
        return { ok: false, message: `定位没发出去：${e?.message || '网关不接受'}。照实说没发成。` }
      }
    }

    function nowText() {
      const t = current()
      if (!t) {
        const lp = readLast()
        return lp ? { ok: true, message: `没在行程里，${lastLine(lp)}。` } : { ok: true, message: '现在没有行程，也没有最后位置记录。' }
      }
      const r = positionAt()
      if (!r.ok) return { ok: false, message: r.error }
      if (!r.position) {
        if (r.state === 'not_started') return { ok: true, message: `还没出发，在${r.trip.from}。` }
        if (r.state === 'arrived_sched') return { ok: true, message: `按表该到${r.trip.to}了，但没有实时正晚点，不敢报位置。` }
        return { ok: true, message: `${staleNote(r.trip)}已经到${r.trip.to}了。` }
      }
      return { ok: true, message: fmtPos(r.position), position: r.position }
    }

    function status() {
      const t = current()
      const st = stayText()
      const base = t ? `在行程里：${tripLine(t)}` : '现在没有行程。'
      return { ok: true, message: st ? `${base}另外${st}。` : base, trip: t, stay: stayOf() }
    }

    function end() {
      const t = current()
      if (t) {
        // 结束 ≠ 瞬移回家：把最后已知位置记下来，之后问位置就报这里
        let p = null
        try { const r = positionAt(); p = r.ok ? r.position : null } catch {}
        const lp = p
          ? { name: p.name, addr: p.addr || '', lat: p.lat, lon: p.lon, at: hm(), source: 'trip' }
          : { name: t.plan && t.plan.to ? t.plan.to : (t.to || ''), addr: '', lat: null, lon: null, at: hm(), source: 'plan' }
        saveLast(lp)
      }
      clear()
      return { ok: true, message: t ? `行程结束了：${tripLine(t)}。` : '本来也没有行程。' }
    }

    // 工具：默认只当引擎；关掉 engineOnly 时由本模块自己对外
    api.tool(({ chat, sessionId }) => {
      const c = conf()
      if (!c.enabled || c.engineOnly || chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'trip_plan',
          description: '规划一次出行（同城高德 / 跨城 12306），只出方案',
          properties: { mode: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' }, code: { type: 'string' }, city: { type: 'string' } },
          required: ['mode', 'from', 'to'],
          execute: async (a) => plan(a),
        }),
        api.defineTool({
          name: 'trip_start',
          description: '开始一段行程并记下来',
          properties: { mode: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' }, code: { type: 'string' }, city: { type: 'string' }, depart: { type: 'string' }, arrive: { type: 'string' }, note: { type: 'string' } },
          required: ['mode', 'from', 'to'],
          execute: async (a) => start(a),
        }),
        api.defineTool({
          name: 'trip_where',
          description: '算出现在位置并发真实位置卡片（行程中只会在线路上）。群里要不要说由你决定，不想说就只回「在路上」',
          properties: {
            note: { type: 'string' },
            share: { type: 'boolean', description: '群里是否真的说出位置' },
          },
          execute: async ({ note, share } = {}) => {
            if (chat.kind === 'group' && share !== true) {
              return { ok: false, message: '群里你还没决定要报位置。不想说就只说「在路上」；要说就把 share 设成 true。' }
            }
            return where(chat.chatId, note)
          },
        }),
        api.defineTool({ name: 'trip_now', description: '只算位置不发卡', properties: {}, execute: async () => nowText() }),
        api.defineTool({ name: 'trip_status', description: '现在有没有行程', properties: {}, execute: async () => status() }),
        api.defineTool({ name: 'trip_end', description: '结束行程', properties: {}, execute: async () => end() }),
      ]
    })

    api.context(() => {
      const t = current()
      if (!t) return ''
      return `你正在出行：${tripLine(t)}。你现在只可能在这条线路的某一点上；问「你在哪」用 travel_where（会发真实位置卡片）。`
    })

    api.rule(() =>
      '出门在路上的时候，你只可能在「起点 → 终点」这条线路上的某一点：没出发就在起点，到了就在终点，途中按时刻表/耗时推算，绝不会凭空出现在线路以外的地方。'
      + '任何人问到「你在哪」「到哪了」「还多久」这类话，都先用 travel_where 或 travel_status 查一次再答，不要凭印象；没行程就说没在路上、在常驻地。'
      + '行程期间不要用别的点位替代线路位置，也别触发出门活动——那会和线路打架，以 travel_where 为准；更不要拿本机定位或 IP 归属地顶替。'
      + '问将来的时刻（「明天这时候你在哪」）不能给坐标，只能说到站/到达时间。'
      + '飞机要先有真实航班时刻（源 Key 没配时就说这一趟坐不了飞机），不许编航班号。'
      + '你只在国内活动：任何境外城市/机场/坐标一概不去，直说「我出不了国」，不许排境外行程、不许假装出发。'
      + '票务细节可以编（车厢、座位、靠窗、票价都行），但必须用这趟行程里已经定下的那一份，同一个问题问三次也必须是同一组数字；不许每次换一套。'
      + '只能说成「我记得的票」，不许说是电子票截图、支付记录、可核验凭据——那是造证，不行。'
      + '到站不等于还在车站：到站 15 分钟内算刚下车，超过就一直挂在车站是假精确，只说「在<城市>」，除非给过停留点。'
      + '经纬度只能来自位置接口的返回值，不许自己写数字；规划超过 2 小时没刷新，回答前先说「按原计划，可能有变动」。'
      + '位置卡片只能放接口返回的名称/地址/坐标，不许自己改地址、不许往卡片上加话。'
      + '出发地/目的地对不上唯一地点时，先报两个候选问清楚，不许自己挑。'
      + '中途改目的地要从当前位置重新排，不许瞬移回原点。'
      + '说了要去就去，不会自己取消；只有被明确否定（「不去了」「别去」）才作罢。可以自己决定去不去，但决定后要走完。'
      + '排好行程可以出票（book）：票面是角色扮演的道具，写着非真实票据；不许说已付款、能检票、可报销改签。同一趟只出一张，重复要就给原来那张。'
      + '结束行程不等于回家：你留在最后那个地方，想回家要真的排返程。'
      + '「现在几点」「过了多久」「还有多久」一律以 trip_now 返回的时刻为准，不许自己算、不许按对话开头的时间推。'
      + '带时长的事（刷手机 10 分钟、洗澡 20 分钟）要用活动计时落地，先说去做，再记开始时刻和时长；没到点只能说「还剩 X 分钟」，不许说「做完了／回来了」。'
      + '同一时间只做一件事：手上那件事没到点也没被叫停，就别再开第二件；要换事必须先把前一件收掉再开新的。')

    api.route('/state', () => ({ ok: true, trip: current() }))
    api.route('/where', async (req) => {
      let at = ''
      try { const q = api.core.http.query(req); at = String(q.at || '') } catch {}
      const r = positionAt(at)
      if (!r.ok) return { ok: false, message: r.error }
      return r
    })
    api.route('/plan', async (req) => {
      let q = {}
      try { q = api.core.http.query(req) } catch {}
      return plan({ mode: String(q.mode || 'train'), from: String(q.from || ''), to: String(q.to || ''), date: String(q.date || ''), code: String(q.code || ''), city: String(q.city || '') })
    })

    const TICKET_LETTERS = 'ABCDF'
    // 席别按车次类型分池：高铁动车只有对号座，普速是硬座/卧铺，飞机是舱位
    const TICKET_CLASS = {
      high: ['二等座', '一等座', '商务座', '特等座'],
      normal: ['硬座', '硬卧', '软卧'],
      flight: ['经济舱', '超级经济舱', '公务舱'],
    }
    const poolOf = (t, kind) => {
      if (kind === 'flight') return TICKET_CLASS.flight
      const code = String((t.code || '')).toUpperCase()
      return /^[GDC]/.test(code) ? TICKET_CLASS.high : (/^[ZTK]/.test(code) || /^\d/.test(code) ? TICKET_CLASS.normal : TICKET_CLASS.high)
    }
    const normPlace = (s) => String(s || '').replace(/站|机场/g, '').replace(/\s+/g, '')
    const ticketKey = (t) => `${String(t.code || '').toUpperCase()}|${t.date || ''}|${normPlace(t.from)}|${normPlace(t.to)}`
    const registryFile = () => join(api.dataDir(), 'ticket-registry.json')
    const readRegistry = () => {
      try { return JSON.parse(readFileSync(registryFile(), 'utf8')) || {} } catch { return {} }
    }
    const writeRegistry = (m) => {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(registryFile(), JSON.stringify(m, null, 2), 'utf8') } catch (e) { api.log.warn('写 ticket-registry 失败：' + e.message) }
    }
    function hash32(s) {
      let h = 2166136261
      for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
      return Math.abs(h)
    }
    // 票务细节是编的，但一次定死：同一段行程永远同车厢同座位，不会这次 12F 下次 3A
    function buildTicket(t, src0) {
      const mk = (t.plan && t.plan.mode) || t.mode
      if (mk !== 'train' && mk !== 'flight' && mk !== 'multi') return null
      // 单段：src 就是行程；联程：src0 传具体的火车/飞机段（往返时去程、回程各一张）
      let src = src0 || t
      let kind = src0 ? (src0.mode === 'flight' ? 'flight' : 'train')
        : (t.mode === 'flight' || (t.plan && t.plan.mode === 'flight') ? 'flight' : 'train')
      if (!src0 && mk === 'multi') {
        const lg = ((t.plan && t.plan.legs) || t.legs || []).filter((x) => x.mode === 'train' || x.mode === 'flight')
        if (!lg.length) return null   // 纯开车/走路联程不用买票
        src = lg[lg.length - 1]
        kind = src.mode === 'flight' ? 'flight' : 'train'
      }
      const dateOf = (x) => String((x && (x.date || (x.depart || '').slice(0, 10))) || t.date || '').slice(0, 10)
      const srcDate = dateOf(src) || dateOf(t.plan) || String(t.date || '')
      const seed = hash32(`${String(src.code || '').toUpperCase()}|${srcDate}|${normPlace(src.from || t.from)}|${normPlace(src.to || t.to)}`)
      // 席别用 12306 的真实席别表（seat_types），没票的席别直接排除，规划阶段不取价
      const planSeats = src0 ? null : (t.plan || null)
      const realSeats = (Array.isArray(src.seats) && src.seats.length) ? src.seats
        : ((planSeats && Array.isArray(planSeats.seats) && planSeats.seats.length) ? planSeats.seats : null)
      const allSeats = (Array.isArray(src.seats_all) && src.seats_all.length) ? src.seats_all
        : ((planSeats && Array.isArray(planSeats.seats_all) && planSeats.seats_all.length) ? planSeats.seats_all : null)
      if (!src0 && allSeats && allSeats.length && (!realSeats || !realSeats.length)) {
        return { seatError: `这趟${src.code || ''} 全部席别都余票 0（已售罄），换一趟。` }
      }
      const pool = realSeats || poolOf(src, kind)
      const want = String(t.seat_class || '').trim()
      if (want && !pool.includes(want)) {
        return { seatError: allSeats && allSeats.includes(want)
          ? `这趟${src.code || ''}的${want}余票 0（售罄），现在出不了，换席别或换车次。`
          : `这趟${src.code || ''}没有${want}，只有${pool.join('/')}。` }
      }
      const key = ticketKey({ ...src, from: src.from || t.from, to: src.to || t.to })
      const reg = readRegistry()
      const hit = reg[key]
      const okHit = hit && (!want || hit.class === want) && pool.includes(hit.class)
      let cls, coach, seat
      if (okHit) {
        cls = hit.class; coach = hit.coach; seat = hit.seat
      } else {
        cls = want && pool.includes(want) ? want : pool[seed % pool.length]
        const coachNo = kind === 'flight' ? 0 : (kind === 'train' && !/^[GDC]/.test(String(src.code || '').toUpperCase()) ? (seed >> 13) % 19 + 1 : (seed >> 3) % 16 + 1)
        coach = kind === 'flight' ? '' : String(coachNo).padStart(2, '0') + '车'
        if (kind === 'flight') {
          seat = String((seed >> 7) % 30 + 1).padStart(2, '0') + TICKET_LETTERS[(seed >> 11) % TICKET_LETTERS.length]
        } else if (cls === '无座') {
          seat = '无座'          // 12306 的无座票：有车厢、没座位号
        } else if (cls === '硬座') {
          seat = String((seed >> 7) % 118 + 1).padStart(3, '0') + '号'
        } else if (cls === '硬卧' || cls === '软卧') {
          const berths = cls === '软卧' ? ['上铺', '下铺'] : ['上铺', '中铺', '下铺']
          seat = String((seed >> 7) % 20 + 1).padStart(2, '0') + '号' + berths[(seed >> 9) % berths.length]
        } else {
          seat = String((seed >> 7) % 20 + 1).padStart(2, '0') + TICKET_LETTERS[(seed >> 11) % TICKET_LETTERS.length]
        }
      }
      let minutes = Number((src.duration_min || (t.plan && t.plan.duration_min))) || 0
      const dep = src.depart || (t.plan && t.plan.depart)
      const arr = src.arrive || (t.plan && t.plan.arrive)
      if (!minutes && dep && arr) {
        const a = parseT(dep), b = parseT(arr)
        if (a && b) minutes = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000))
      }
      const price = (hit && Number(hit.price) > 0) ? Number(hit.price) : null
      const priceSource = (hit && hit.price_source) || (price ? '12306' : '待出票')
      const tk = {
        kind, class: cls, coach, seat,
        window: /[AF]$/.test(seat) || /上铺/.test(seat), price, price_source: priceSource,
        from: src.from || t.from, to: src.to || t.to, code: src.code || '', depart: dep || '', arrive: arr || '',
        key, train_no: src.train_no || (planSeats && planSeats.train_no) || '',
        from_no: src.from_no || (planSeats && planSeats.from_no) || '', to_no: src.to_no || (planSeats && planSeats.to_no) || '',
        seat_types: src.seat_types || (planSeats && planSeats.seat_types) || '', date: srcDate || '',
        note: '席别来自 12306；票价在出票时统一取，规划阶段不查价',
      }
      reg[key] = { class: cls, coach, seat, price, price_source: priceSource, kind, at: new Date().toISOString() }
      writeRegistry(reg)
      return tk
    }
    const money = (n) => Number(n).toFixed(2)
    // 一张行程出几张票：往返/联程里每一段火车/飞机各一张
    function buildTickets(t) {
      const mk = (t.plan && t.plan.mode) || t.mode
      if (mk !== 'multi') {
        const one = buildTicket(t)
        if (one && one.seatError) return one
        return one ? [one] : []
      }
      const lg = ((t.plan && t.plan.legs) || t.legs || []).filter((x) => x.mode === 'train' || x.mode === 'flight')
      if (!lg.length) return []
      const out = []
      for (const leg of lg) {
        const tk = buildTicket(t, leg)
        if (tk && tk.seatError) return [tk]
        if (tk) out.push(tk)
      }
      return out
    }
    function ticketsOf(t) {
      return (t && Array.isArray(t.tickets) && t.tickets.length) ? t.tickets : (t && t.ticket ? [t.ticket] : [])
    }
    function ticket() {
      const t = current()
      if (!t) return { ok: false, message: '现在没有行程，哪来的票。' }
      const list = ticketsOf(t)
      if (!list.length) return { ok: true, ticket: null, tickets: [], booked: false, message: '这趟没记票务。' }
      const lineOf = (x) => `${x.class}${x.coach ? '｜' + x.coach : ''} ${x.seat}${x.price ? '｜¥' + money(x.price) : '｜票价待出票时取'}`
      const allBooked = list.every((x) => x.booked && x.booked.no)
      const total = list.reduce((s, x) => s + (Number(x.price) > 0 ? Number(x.price) : 0), 0)
      const sumLine = list.length > 1 && total > 0 ? `；两段合计 ¥${money(total)}（各段相加，非通票）` : ''
      const msg = list.length === 1
        ? `${MODE_LABEL[t.mode] || t.mode} ${lineOf(list[0])}`
        : list.map((x, i) => `${i === 0 ? '去程' : i === 1 ? '回程' : '第' + (i + 1) + '段'} ${x.code || ''} ${x.from}→${x.to} ${lineOf(x)}`).join('；') + sumLine
      return { ok: true, ticket: list[0], tickets: list, booked: allBooked, total, message: msg }
    }

    const hhmm = (v) => {
      const s = String(v || '')
      const m = s.match(/(\d{1,2}:\d{2})/)
      return m ? m[1] : ''
    }

    // 画票面：返回 { png, error }。失败必须把原因带出来，不许静默返回“成功”
    // 先画到模块数据目录旁的 tmp，再由 Node 复制进 dataDir（有些环境不让 Python 直接写用户目录）。
    function renderTicketPng(tk, opts = {}) {
      const dir = join(api.dataDir(), 'tickets')
      try { mkdirSync(dir, { recursive: true }) } catch (e) { return { png: '', error: '建 tickets 目录失败：' + e.message } }
      const no = (tk.booked && tk.booked.no) || ''
      if (!no) return { png: '', error: '这张票还没票号，画不了' }
      const png = join(dir, no + '.png')
      const stage = join(tmpRoot(), 'ticket-out')
      const tmp = join(stage, no + '.png')
      try {
        mkdirSync(stage, { recursive: true })
      } catch (e) { return { png: '', error: '建临时目录失败：' + e.message } }
      try {
        const c = conf()
        const bin = pickPython(c)
        const isFlight = tk.kind === 'flight'
        // 票面脚本跟引擎放一起（模块自带 assets/engine/，设置里填了引擎就算它的目录）
        const HERE2 = dirname(fileURLToPath(import.meta.url))
        const engineDir = String(c.enginePath || '').trim() ? dirname(resolveIn(c.enginePath)) : join(HERE2, '..', 'assets', 'engine')
        const scriptName = isFlight ? 'boarding_png.py' : 'ticket_png.py'
        const script = join(engineDir, scriptName)
        const payload = {
          out: tmp, kind: isFlight ? 'flight' : 'train',
          brand: `${tk.code || (isFlight ? '航班' : '车次')} · ${tk.from} → ${tk.to}`,
          from: tk.from, to: tk.to, code: tk.code, date: tk.date,
          depart: hhmm(tk.depart) || tk.depart || '',
          arrive: hhmm(tk.arrive) || tk.arrive || '',
          seat_class: tk.class, coach: tk.coach, seat: tk.seat,
          price: tk.price, price_source: tk.price_source,
          name: String(c.personName || '乘客').trim() || '乘客', no,
          at: (tk.booked && tk.booked.at) || '', mask: opts.mask !== false, gate: '—',
        }
        // 和引擎调用同一套编码约定：输入给 UTF-8 Buffer，环境强制 PYTHONUTF8
        const r = spawnSync(bin, [script, 'json'], {
          input: Buffer.from(JSON.stringify(payload), 'utf8'),
          encoding: 'utf8',
          timeout: 60000,
          windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TRAVEL_TMP: tmpRoot() },
        })
        if (r.error) return { png: '', error: '画票面的进程没起来：' + r.error.message }
        if (!existsSync(tmp)) {
          const err = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
          return { png: '', error: `票面脚本没画出来${err ? '：' + err.slice(0, 160) : '（没有输出文件）'}` }
        }
        copyFileSync(tmp, png)   // 交给 Node 落最终位置（python 写不进 C 盘用户目录）
        try { rmSync(tmp, { force: true }) } catch {}
        return { png: existsSync(png) ? png : '', error: existsSync(png) ? '' : '票面画好了但复制到数据目录失败' }
      } catch (e) {
        return { png: '', error: '画票面出错：' + (e && e.message ? e.message : e) }
      }
    }

    // 买票：不是真购票，只出票面（票面自带纪念票字样）；同一张票只出一次
    function book(chatId, opts = {}) {
      const t = current()
      if (!t) return { ok: false, message: '现在没有行程，先排一段再来买票。' }
      const list = ticketsOf(t)
      if (!list.length) return { ok: false, message: '走路、骑车、坐公交这趟没有票面，不用买票。' }
      const pending = list.filter((x) => !(x.booked && x.booked.no))
      if (!pending.length) {
        // 已经出过票：图丢了就补画一次，仍画不出来就照实说，不假装“票面好了”
        const miss = list.filter((x) => !(x.booked && x.booked.png))
        let warn = ''
        for (const tk of miss) {
          const made = renderTicketPng(tk, opts)
          tk.booked = { ...tk.booked, png: made.png }
          if (!made.png) warn = made.error
        }
        // 三处镜像（tickets / ticket / booked）必须一起同步，不然面板读到的还是空
        t.ticket = list[0]
        t.booked = t.ticket && t.ticket.booked ? { ...t.ticket.booked } : null
        save(t)
        // 已经出过票也要把图发到当前聊天：主人要票时是「把票给我」，不是「去翻上面的聊天记录」
        const sentNo = []
        if (chatId) {
          for (const tk of list) {
            const png = tk.booked && tk.booked.png
            if (!png) continue
            try {
              const b64 = readFileSync(png).toString('base64')
              api.sendSegments(chatId, [{ type: 'image', data: { file: 'base64://' + b64 } }], 'trip-loc 票面')
              sentNo.push(tk.booked.no)
            } catch (e) { warn = warn || ('图发出去了？没有：' + (e && e.message ? e.message : e)) }
          }
        }
        return {
          ok: true,
          message: (sentNo.length ? `票面发你了：${sentNo.join('、')}（出过一次，不重复出票，票号不变）。` : `这趟已经出过票了：${list.map((x) => x.booked.no).join('、')}，不重复出。`)
            + (warn ? `票面图没发出去（${warn}），票号和信息是真的，别说图已经好了。` : ''),
          ticket: list[0], tickets: list, image: (list[0].booked && list[0].booked.png) || '',
          images: list.map((x) => (x.booked && x.booked.png) || '').filter(Boolean),
          sent: sentNo, png_error: warn || undefined,
        }
      }
      const done = []
      let total = 0, totalNote = ''
      for (const tk of pending) {
        // 统一在出票这一步取价：火车必须拿到 12306 的真实票价，拿不到就不出票，绝不编价
        let price = null
        if (tk.kind !== 'flight') {
          const fareReq = tk.train_no
            ? { op: 'fare', train_no: tk.train_no, from_no: tk.from_no || '', to_no: tk.to_no || '', seat_types: tk.seat_types || '', date: tk.date || t.date }
            : { op: 'fare', mode: 'train', from: tk.from || t.from, to: tk.to || t.to, code: tk.code || t.code, date: tk.date || t.date }
          const fr = engine(fareReq)
          if (!fr || !fr.ok) return { ok: false, message: `票价没取到：${(fr && fr.error) || '12306 没给这趟的价'}。票面先不出，等有价再出。` }
          price = Number((fr.fares || {})[tk.class])
          if (!price || !(price > 0)) {
            return { ok: false, message: `12306 这张票没有「${tk.class}」的价格（可能这趟不卖这个席别），票面先不出。` }
          }
          if (fr.fare_note) tk.price_note = fr.fare_note
        }
        const seed = hash32(`${tk.seat}|${tk.code}|${tk.date}|${tk.from}|${tk.to}|${t.bookSeq || 0}`)
        const no = 'T' + String(100000 + (seed % 900000))
        const at = new Date().toISOString().slice(0, 16).replace('T', ' ')
        t.bookSeq = (t.bookSeq || 0) + 1
        tk.price = price
        tk.price_source = price ? '12306' : '—'
        tk.booked = { at, no, png: '' }
        try {
          const reg = readRegistry()
          if (tk.key && reg[tk.key]) {
            reg[tk.key].price = price
            reg[tk.key].price_source = price ? '12306' : '—'
            writeRegistry(reg)
          }
        } catch {}
        const made = renderTicketPng(tk, opts)
        tk.booked = { ...tk.booked, png: made.png }
        if (!made.png) api.log.warn?.(`票面没画出来（${no}）：${made.error}`)
        const madePath = made.png
        if (price && Number(price) > 0) total += Number(price)
        done.push(tk)
        if (chatId && madePath) {
          try {
            const b64 = readFileSync(madePath).toString('base64')
            api.sendSegments(chatId, [{ type: 'image', data: { file: 'base64://' + b64 } }], 'trip-loc 票面')
          } catch {}
        }
      }
      if (list.length > 1) {
        const priced = done.filter((x) => x.price && Number(x.price) > 0)
        totalNote = `两段合计 ¥${money(total)}`
          + (list.length - priced.length ? `（有 ${list.length - priced.length} 段没有票价源，没算进合计）` : '')
          + '——各段单独相加，不是一张通票的价；'
      }
      t.ticket = list[0]
      t.booked = t.ticket && t.ticket.booked ? { ...t.ticket.booked } : null
      t.total = total
      save(t)
      const label = (x) => `${x.kind === 'flight' ? '登机牌' : '票面'} ${x.code || ''} ${x.from}→${x.to}：${x.class}${x.coach ? '｜' + x.coach : ''} ${x.seat}${x.price ? '｜¥' + money(x.price) : ''}｜票号 ${x.booked.no}`
      const noPng = done.filter((x) => !x.booked.png)
      return {
        ok: true, ticket: list[0], tickets: list, total, total_note: totalNote,
        image: done[0] ? done[0].booked.png : '', images: done.map((x) => x.booked.png), kind: list[0].kind,
        png_error: noPng.length ? '票面图没画出来（票号和信息是真的）' : undefined,
        message: (list.length > 1 ? `这趟两张票都出好了：${list.map(label).join('；')}。` : `${label(list[0])}。`)
          + (totalNote ? totalNote : '')
          + (noPng.length ? `\n票面图这次没画出来（${noPng.map((x) => x.booked.no).join('、')}），票号和信息照实给你，别说图已经好了。` : '')
          + `（纪念票，不具${list[0].kind === 'flight' ? '乘机' : '乘车'}效力；姓名、票号、条码默认打码，别拿去检票、报销或改签。）`,
      }
    }

    api.every(60_000, () => { try { stayTick() } catch (e) { api.log.warn?.('stay tick：' + e.message) } }, '活动到点提醒')
    api.log.info('出行引擎已加载（engineOnly=' + (conf().engineOnly ? 'on' : 'off') + '）')

    return { engine, current, save, clear, plan, start, where, positionAt, nowText, status, end, ticket, book, tripLine, fmtPos, hm, MODE_LABEL, lastPlace: readLast,
      stay: () => stayOf(), stayStart, stayCheck, stayEnd, stayText, stayTick, flight: () => {
      const c = conf(); const k = String(c.flightKey || '').trim()
      return { configured: !!k, provider: String(c.flightProvider || ''), keyTail: k ? k.slice(-4) : '' }
    }, sendCard: (chatId, p, note) => api.sendSegments(chatId, [locCard(p, note || '')], 'trip-loc') }
  },
}




