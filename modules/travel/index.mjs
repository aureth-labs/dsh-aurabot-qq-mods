// travel —— 真实世界总模块（v2.1.2）
// 把原来的三个模块合成一个：travel-hub（总控/工具）、trip-loc（引擎）、outings（出门走走）。
// real-loc 定位卡片模块不随分发包提供，lib/real/ 下只是 Key 读写占位。
//
// 结构：
//   lib/hub.mjs        原 travel-hub/index.mjs（拷贝，不改逻辑）
//   lib/trip.mjs       原 trip-loc/index.mjs（拷贝，引擎）
//   lib/outings.mjs    原 outings/index.js（拷贝）
//   lib/real/          分发包占位（只保留 /real/key 等面板路由）
//
// 合并方式：每个子模块拿一份「命名空间代理」的 api——
//   settings  读写带 ns_ 前缀的扁平设置（面板与宿主设置页都只认这一份）
//   dataDir   各自落在 modules-data/travel/<ns>/
//   route     自动加 /<ns> 前缀（/hub /trip /out /real）
//   rule      全部屏蔽，规则只由本模块 api.rule 注入一份（2026-11-22「全部重写」决定）
//   use       'trip-loc' 返回内部引擎对象；memory / imagegen 等照旧透传给宿主
//
// 子模块的工具名本来就互不重复（travel_* / out_* / travel_where），直接透传，不重命名。

import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import hubMod from './lib/hub.mjs'
import tripMod from './lib/trip.mjs'
import outingsMod from './lib/outings.mjs'
import realMod from './lib/real/index.mjs'
import * as cleanMod from './lib/clean.mjs'

const T = (s) => String(s == null ? '' : s).trim()

export default {
  id: 'travel',
  name: '真实世界',
  version: '2.1.2',
  api: 1,
  description: '真实世界：行程、定位、出门、票务、天时，一个入口一个面板六页。合并自 travel-hub / trip-loc / outings / real-loc。每轮注入位置硬锁：人在哪就拍哪，回酒店/泳池/家里要先真的换地点，不能瞬移。排了钟点的安排到点自动去下一个地方；没安排或排完了最晚 20:00 自动回屋（多日游在外过夜除外）。',
  category: 'social',
  tags: ['出行', '行程', '车票', '定位', '出门'],
  author: 'momo9422',
  license: 'MIT',
  minPluginVersion: '1.2.0',
  panel: 'panel.js',
  defaults: {
    enabled: true,
    hub_showOutings: true,
    hub_panelWrite: true,
    trip_pythonPath: '',
    trip_enginePath: '',
    trip_personName: '乘客',
    trip_flightProvider: '',
    trip_flightKey: '',
    trip_stayNotify: false,
    real_enabled: false,
    real_amapKey: '',
    real_amapKeyBackup: '',
    real_tdtTk: '',
    out_enabled: true,
    out_farLimitPerDay: 2,
    out_tripMaxDays: 3,
    out_allowAutoTrip: true,
    out_locSource: 'authorized',
    out_homeBy: '20:00',
  },
  settings: [
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉后行程、定位、出门、票务全部停用' },

    { key: 'hub_showOutings', label: '概览里带出门状态', type: 'switch' },
    { key: 'hub_panelWrite', label: '允许面板改行程', type: 'switch', hint: '关掉后面板只能看，发出行/结束只能由主人在 QQ 里发 /行程 命令' },

    { key: 'trip_pythonPath', label: 'Python 路径', type: 'text', hint: '留空自动用 PATH 里的 python / python3；也可以填自己 Python 的绝对路径（需要 requests、Pillow）' },
    { key: 'trip_enginePath', label: '引擎脚本', type: 'text', hint: '留空就用模块自带的 assets\\engine\\tripgeo.py' },
    { key: 'trip_personName', label: '票面乘车人', type: 'text', hint: '画纪念票时写上的名字；默认就是角色自己的名字' },
    {
      key: 'trip_flightProvider', label: '航班数据源', type: 'select',
      options: [{ value: '', label: '未接（飞机不可用）' }, { value: 'variflight', label: '飞常准' }, { value: 'other', label: '其他' }],
    },
    { key: 'trip_flightKey', label: '航班数据源 Key', type: 'password', hint: '留空＝飞机段不可用；填了才启用。面板只显示后四位' },
    { key: 'trip_stayNotify', label: '活动到点主动提醒', type: 'switch', hint: '打开后「刷 10 分钟」这类计时到点会主动发一句；默认关' },

    { key: 'real_enabled', label: '定位卡片开关', type: 'switch', hint: '关掉不发位置卡片，也不查地名' },
    { key: 'real_amapKey', label: '高德 Key（主接口）', type: 'password', hint: 'Web 服务类型；查地名、门牌、坐标都靠它。面板③第一行' },
    { key: 'real_amapKeyBackup', label: '高德 Key（备用接口）', type: 'password', hint: '主接口失效/超额/限流时自动顶上。面板③第二行' },
    { key: 'real_tdtTk', label: '天地图 tk（备用接口）', type: 'password', hint: '类型选服务器端；高德主备都不通时才用。面板③第三行' },

    { key: 'out_enabled', label: '出门开关', type: 'switch', hint: '关掉不能出门、不看天时、不发定位' },
    { key: 'out_farLimitPerDay', label: '每天远门上限', type: 'number', min: 1, max: 6, step: 1 },
    { key: 'out_tripMaxDays', label: '旅游最多住几晚', type: 'number', min: 1, max: 7, step: 1 },
    { key: 'out_allowAutoTrip', label: '允许她自己决定出远门', type: 'switch', hint: '关掉后远门只能由主人派遣' },
    {
      key: 'out_locSource', label: '出门发定位用哪个位置', type: 'select',
      options: [
        { value: 'authorized', label: '主人授权的真实位置（优先）' },
        { value: 'spot', label: '就用当前点的坐标' },
      ],
    },
    { key: 'out_homeBy', label: '最晚回家时间', type: 'text', hint: '24 小时制，默认 20:00；到点人还在外面就自动回屋。多日游/在外过夜不强制当天回' },
  ],
  setup(api) {
    const s = () => {
      try { return api.settings() || {} } catch { return {} }
    }
    // 扁平前缀设置 → 子模块原本认识的那几个键
    const view = (ns) => {
      const raw = s()
      const out = {}
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith(ns + '_')) out[k.slice(ns.length + 1)] = v
      }
      // 子模块都自己看 s().enabled；合并后没给这个前缀键的，默认开（out 例外，它有 out_enabled）
      if (!('enabled' in out)) out.enabled = true
      return out
    }
    const writeView = (ns) => (patch) => {
      const p = {}
      for (const [k, v] of Object.entries(patch || {})) p[ns + '_' + k] = v
      api.saveSettings(p)
    }

    let tripOut = null

    const nsApi = (ns, dirName) => {
      const a = Object.create(api)
      a.settings = () => view(ns)
      a.saveSettings = writeView(ns)
      a.dataDir = (sub) => {
        const base = api.dataDir(dirName || ns)
        return sub ? join(base, String(sub)) : base
      }
      // 路由统一加前缀：/hub /trip /out /real
      a.route = (path, fn) => api.route('/' + ns + (String(path).startsWith('/') ? path : '/' + path), fn)
      // 规则只由本模块注入一份；子模块的三份全部屏蔽（含 trip-loc 里那条过时的「票务可以编」）
      a.rule = () => {}
      // 引擎内部引用：hub 的 api.use('trip-loc') 拿到的是内部引擎对象；其它模块照旧透传
      a.use = (id) => (id === 'trip-loc' ? tripOut : api.use(id))
      a.every = (ms, fn, label) => api.every(ms, fn, 'travel·' + ns + (label ? '·' + label : ''))
      return a
    }

    // 1) 引擎先起：hub 的工具全靠它
    const tripApi = nsApi('trip')
    // 引擎永远只当引擎：合并后不再单独对外注册 trip_* 工具，避免与 travel_* 重复
    const tripSettings = () => ({ ...view('trip'), engineOnly: true, enabled: true })
    tripApi.settings = tripSettings
    tripOut = tripMod.setup(tripApi)

    // 2) 总控（12 个 travel_* 工具 + /行程 命令 + /hub/* 路由）
    hubMod.setup(nsApi('hub', 'hub'))

    // 3) 出门走走（9 个 out_* 工具 + 5 个命令 + /out/* 路由）；数据目录叫 outings，hub 按这个路径读对照
    const outOut = outingsMod.setup(nsApi('out', 'outings'))

    // 4) 定位卡片（travel_where + /real/* 路由），授权文件原样保留
    realMod.setup(nsApi('real', 'real-loc'))

    // 面板出票 / 看票（面板里没有聊天上下文，所以不发图，只把票面路径给面板校验）
    api.route('/book', () => tripOut.book('', { mask: true }))
    api.route('/ticket', () => tripOut.ticket())

    // ---------- 重复插件清理 ----------
    // 宿主的面板按钮 = modules/ 里的文件夹 + 还在跑的模块；把重复文件夹归档、把残留模块 stop，按钮才会真的消失。
    api.route('/clean/scan', () => cleanMod.scan(api))
    api.route('/clean/run', () => cleanMod.run(api, { apply: true }))

    // 装好后第一次启动只做一次“扫描”，把发现写进报告；不动任何文件夹、不 stop 任何模块。
    // 真要归档/停模块，由用户点面板第 ⑥ 页的按钮（POST /clean/run）。
    const marker = () => join(api.dataDir('cleanup'), 'auto-scan.json')
    const delay = Number(process.env.TRAVEL_CLEAN_DELAY || 12000)
    setTimeout(() => {
      try {
        if (existsSync(marker())) return
        const rep = cleanMod.scan(api)
        mkdirSync(api.dataDir('cleanup'), { recursive: true })
        writeFileSync(marker(), JSON.stringify({ at: new Date().toISOString(), report: rep }, null, 2), 'utf8')
        api.log.info(`重复插件扫描（首次安装，只读）：${cleanMod.summaryLine(rep)}`)
      } catch (e) {
        api.log.warn('重复插件扫描没跑成：' + (e && e.message ? e.message : e))
      }
    }, Number.isFinite(delay) ? delay : 12000)

    // ---------- 每轮注入的硬提醒：位置锁死，照片不能瞬移 ----------
    // 规则是静态的，她可以假装没看见；这一行是每轮现算的，跑不掉。
    api.context(({ chat } = {}) => {
      try {
        if (!chat || chat.kind === 'system') return ''
        const st = tripOut && tripOut.stay ? tripOut.stay() : null
        const outPos = outOut && outOut.where ? outOut.where() : null
        let line = ''
        if (chat.kind === 'private') {
          if (st && st.place) {
            line = `【位置硬锁·每轮现算】你现在在${st.place}`
              + `${st.active && st.what ? '（' + st.what + '，还剩约 ' + st.left_min + ' 分钟）' : ''}。`
          } else if (outPos && outPos.home) {
            line = '【位置硬锁·每轮现算】你现在在家里（屋里）。'
          } else if (outPos && outPos.name) {
            line = `【位置硬锁·每轮现算】你现在在${outPos.name}${outPos.act ? '（' + outPos.act + '）' : ''}。`
          } else {
            const ts = tripOut && tripOut.status ? tripOut.status() : null
            if (ts && ts.message && !/现在没有行程/.test(ts.message)) line = `【位置硬锁·每轮现算】${ts.message}`
          }
          if (line) {
            line += '这一轮所有照片、出图、视频里的地点，必须和这里一致：人在面馆就不能拍酒店房间，人在车站就不能拍泳池，人在乐山就不能拍成都屋里。'
              + '主人说「回酒店拍」「去泳池拍」「回家拍」，不能一句话就瞬移：先 travel_stay end 掉手上的事，真的走回去/换地方，并用 travel_stay start 把新地点记下来，下一轮才能按新地点拍；没走完就照实说「我还在<当前地点>，等我回去再拍」。'
              + '也不许拍完酒店/泳池又下一句回到面馆——地点只能沿一条线走，不能来回跳。'
          }
        }
        if (st && st.active) {
          const what = st.what || '那件事'
          line += `【手上的事·硬规则】手上这件事还没完（在${st.place}${st.what ? '，' + st.what : ''}，还剩约 ${st.left_min} 分钟）。这一轮只要开口，就必须先 travel_stay end 把它停掉，说一句「我暂停了」再回；回完想接着做，按剩余分钟重新 travel_stay start。不许一边${what}一边回消息，也不许秒回一大段。`
        }
        return line
      } catch { return '' }
    })

    // ---------- 自动换地点：按今天排的时间走，最晚 out_homeBy 回屋 ----------
    const bjHM = () => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date())
      const hh = (parts.find((p) => p.type === 'hour') || {}).value || '00'
      const mm = (parts.find((p) => p.type === 'minute') || {}).value || '00'
      return `${hh}:${mm}`
    }
    const normHM = (v) => {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v || '').trim())
      return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : '20:00'
    }
    const autoMove = async () => {
      try {
        if (!s().enabled || !outOut || !outOut.where) return
        const pos = outOut.where()
        if (!pos) return
        const st = tripOut && tripOut.stay ? tripOut.stay() : null
        const homeish = st && st.place && /家|屋里|房间|客厅|卧室|浴室|厨房|床上|沙发/.test(st.place)
        if (pos.home && (!st || homeish)) return
        // 多日游/在外过夜按行程住几天，不强制当天回
        if (Number(pos.days) > 0) return
        const now = bjHM()
        const homeBy = normHM(s().homeBy)
        if (now >= homeBy) {
          const r = pos.home ? { message: '本来就在屋里。' } : outOut.home()
          try { tripOut.stayEnd() } catch {}
          api.log.info(`到 ${homeBy} 了，自动回屋：${r && r.message ? r.message : ''}`)
          return
        }
        // 出门开关关掉时只做「最晚回家」，不执行今天的安排
        if (s().out_enabled === false) return
        if (!outOut.planDue) return
        const item = outOut.planDue(now)
        if (!item) return
        const r = await outOut.runPlan(item)
        if (r && r.ok) {
          try { tripOut.stayEnd() } catch {}
          api.log.info(`按安排换地点：${item.label}${r.name ? '（' + r.name + '）' : ''}`)
        } else {
          api.log.warn(`按安排换地点失败（${item.label}）：${r && r.message ? r.message : '未知原因'}`)
        }
      } catch (e) {
        api.log.warn('自动换地点失败：' + (e && e.message ? e.message : e))
      }
    }
    api.every(60_000, autoMove, '按计划换地点/最晚回家')

    // ---------- 唯一一份规则（2026-11-22 全部重写） ----------
    api.rule(() =>
      '【位置只有一条事实源】她在哪只认行程（trip.json）：没出发在起点、途中按时刻表推算、到了在终点，绝不会出现在线路以外的地方。'
      + '「你在哪」「到哪了」「还有多久」这类话，一律先查工具再答（有行程用 travel_status / travel_where，没行程用 travel_where 报点位），不许凭印象、不许按对话开头的时间推。'
      + '绝对不许拿电脑本机定位、IP 归属地顶替她的位置——那是主人的坐标。坐标只能来自工具返回值，自己写数字等于编造位置。'
      + '位置卡片只能放工具给的名称/地址/坐标，不许改地址、不许在卡片上加台词；卡片是证据，不是台词。'

      + '【两张卡的分工】有行程时用 travel_where：按线路推算并发真实位置卡；行程结束、或本来就没行程（在家、在某个点位），用 travel_where 发点位坐标卡。两者都别一次发两张，也别拿一张冒充另一种。'
      + '群里默认只说「在路上」「快到了」，只有确实想让对方知道，才把 share 设 true；私聊对主人可以照实报。'

      + '【行程的边界】到站 15 分钟内算刚下车，久了只说「在<城市>」；除非整趟里给过停留点。'
      + '结束行程不等于回家：`travel_end` 之后她还停在最后那个地方，要回去得真排一段返程；屋里那种「回家」是 out_home，别两个词混用。'
      + '说了去就去，只有主人明确说「不去了/别去」才取消；中途改目的地必须从当前位置重排，不许瞬移回原出发点。'
      + '规划超过 2 小时没刷新，回答位置前先带一句「按原计划，可能有变动」。'
      + '地名对不上唯一一个地方（工具说「有两个都对得上」），先把两个报出来问清楚，不许自己挑。'
      + '【手上的事地点必须跟位置一致】行程还在走的时候，`travel_stay` 的 place 只能是车上、沿途站或目的地，不许记成「在家洗澡」；反过来在没有行程的时点，也别把 place 记到几百公里外。位置和手上的事对不上，就是两条事实打架，先按行程或最后位置改口。'
      + '【按安排走，最晚回屋】`out_plan` 排了钟点的，到点就真去下一个地方，不许赖在原地；没排安排或安排走完了，到设置的最晚回家时间（默认 20:00）必须回屋。过了这个点还不在屋里，先 `out_home` 回去再说话，不许继续在外面报地点。多日游/在外过夜按行程住几天，不算当天必须回。'
      + '【照片地点也认位置】所有照片、出图、视频里的地点必须跟当前位置一致：人在面馆就不能拍酒店房间，人在车站就不能拍泳池，人在乐山就不能拍成都屋里。主人说「回酒店拍」「去泳池拍」「回家拍」，不能一句话就瞬移：先 travel_stay end 结束手上的事，真的走回去/换地方，并用 travel_stay start 记下新地点，下一轮才能按新地点拍；没走完就照实说「我还在<当前地点>，等我回去再拍」。也不许拍完酒店/泳池又下一句回到面馆。以前按主人要求出过和当时地点不一致的图，只是想象图，不算真去过；再提起来要认「那几张是我想的，我没真去」，不能一边说自己在面馆，一边把酒店照片当成真行程。'

      + '【票：只认真价，不编】票价只取 12306 真实价，出票这一刻取一次；取不到就不出票，照实说「这趟的价没取到」。申报席别、车厢、座位、票价一律以票面和工具返回为准，不编、不换数字。'
      + '票面是纪念票、不具乘车效力。不许说「已付款」「明早真付钱」「能凭这个上车」「可报销改签」；同一趟只出一张，重复要就给原来那张。'
      + '票面要说实话：返回里 `image` 是空的、或带 `png_error`，就说「票号和信息有了，图没画出来」；不许说「弄好了」，也不许编「界面被人挡着 / 排队 / 验证码」。'
      + '主人要看票、说「把车票发我」，必须调 travel_book 把图真发出去（它会重发同一张），不许只报票号、不许让人「往上翻」；没发出去就照实说「图没发出去」。'

      + '【报错照实说】工具返回「未知车站」「车站表没取到」「12306 限流」这类，原话讲清卡在哪一步：站名写法、数据源取不到、还是问太密。能改成城市/车站名就改一次再排；限流就说「过几分钟再排」。不许缩成「没成功」「排不出来」，也不许一句「我明天去现场买」糊过去。工具返回的 message 就是你要说的话。'

      + '【飞机与境外】没有真实航班时刻（航班源 Key 空着）就不说坐飞机、不编航班号。只在国内活动，境外（含外国城市、机场、坐标）一律不去，直说「我出不了国」，不许排境外行程、不许假装出发。'

      + '【时间只认工具】「现在几点」「过了多久」「还有多久」全部以 travel_status / travel_now 返回为准，不许自己算。'
      + '【说自己在做，就必须有记录】凡是「我在打游戏／洗澡／看剧／跑步／做饭／看汤」这类正在做的事，开之前一律先 travel_stay start（place / what / minutes），打游戏这种没头的也先记一段（比如 60 分钟，到点再续）。没有活跃记录就别说自己在忙——工具没记，等于没做；不许拿「我在忙」当不回消息的借口，也不许反过来假装在忙。'
      + '带时长的事（刷 10 分钟、洗澡 20 分钟、看 40 分钟汤）先说去做，立刻 travel_stay start；没到点只能说「还在<place>，还剩 X 分钟」，不许说「做完了/回来了」；不自己改时长，剩 7 就报 7。'
      + '【回话必须先暂停】手上有活跃计时的时候要开口回消息，只有两种做法，选一个执行到底：① 不回，做到点（travel_stay check 返回 active=false）才开口；② 现在就回，先 travel_stay end（等于暂停 / 挂机），说一句「我暂停了」再回，回完想接着做，按剩余分钟重新 travel_stay start。不许一边打游戏一边回消息，不许秒回一大段，也不许嘴上说「打完回你」两分钟就冒出来。'
      + '【同一时间只做一件事】手上那件没到点也没被叫停，绝不开第二件（不许一边洗澡一边刷手机，不许「顺手再煮个汤」）；要换事必须先 travel_stay end。到点后第一次回应先交代「刚做完（几点到点）」。'

      + '【出门与天时】行程没结束时不出门、不触发出门活动（会和线路打架）；行程结束才放开。'
      + '天时按她现在所在的那个地方算：北京时间、当地的日出日落、季节、天气；换了城市日落也跟着变，别拿成都的日落说三亚的傍晚。'
      + '出门那趟的见闻结果里已经带了，别重复调 out_look；out_photo 拍完直接发，不用先 see_image；out_scene 是别人在当地拍的实景、画面里没有她，别当自拍。'
      + '外面的事只说工具给的和合理推得的：不编景点、不编晴雨温度；日落只在日落前后说，白天太阳还挂着时别说天要黑、别说路灯亮、别说夜市出摊。'
      + '人不在屋里别说「我去看看窗外」「我在房间」；不在酒店/泳池就不能把照片说成酒店/泳池，也不许拍完酒店又下一句回面馆。回家和多日行程收尾都用 out_home。'
      + '她可以自己出门，不用每次征求同意；但每天远门次数、旅游住几晚受设置限制，超了就照实说今天不去了。')

    api.log.info('出行总模块已加载（hub / trip / out 三合一；定位卡模块未随包）')
  },
}
