// 小屋世界（Cabin World）：给大肥鱼一个会走路的身体。
//
// 做三件事：
//   1. 把桥发布的 cabin_* 工具挂给她（CORE 里 13 个，只在主人私聊和自动生活会话；群聊默认不挂）；
//   2. 每次调用转发到本机桥 POST /v1/tool，结果以游戏为准，done 才算发生过；
//   3. 一键安装：从 GitHub Release 下载并解压到游戏目录（保留 data 存档），装完可一键启动。
//
// 依赖：Cabin World（默认装在模块数据目录 modules-data/cabinworld，也可在设置里指到别处）+ Node 18+。桥只监听 127.0.0.1。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureHost, startHost, hostDir, hostPidFile, needsSync, killGame, waitBridge, isGameRunning, PATCHES } from './lib/host.mjs'
import { createBridge } from './lib/bridge.mjs'
import { loadSpecs, CORE } from './lib/tools.mjs'
import { exePath, configPath, exeMissingText } from './lib/exe.mjs'
import { resolvePlace, PLACE_LIST } from './lib/places.mjs'
import { createInstaller } from './lib/install.mjs'
import { setGameWindow, hideGameWindow } from './lib/gamewin.mjs'
import { bridgeConfigInfo, writeBridgeConfig, bridgeDataDir, restartBridge } from './lib/bridgecfg.mjs'
import { personaName, qqNickname } from './lib/names.mjs'
import { clip, bagText, briefStatus, briefLook, briefTask, briefProcess, briefCatalog, briefRaw } from './lib/brief.mjs'

// 游戏装在模块数据目录（api.dataDir()，即 modules-data/cabinworld）：不进发布包，卸载时可随模块一起清。
const DEFAULT_WAIT_MS = 30000
// 自动生活的后台会话名，固定值；按 chatId 与私聊隔离。
const AUTO_SESSION = 'system:cabin-life'
// 自动生活一轮的判活阈值：runSystemTurn 上限 120 秒 + 收尾那三个 await（查最近任务、拉状态、私聊汇报）。
// 阈值必须比这些加起来更宽，否则到了边界会误判僵死、开第二轮并发跑。
// 放在模块顶部而不是 setup 后半段：loadAuto() 在 setup 里同步执行，复位逻辑就要读它。
const AUTO_STALE_MS = 300000
// 错误消息兜底：Error 取 message，字符串或其它原样返回（拼进文案时会自己 toString）。
const errText = function (e) { return (e && e.message) || e }
// 「没做成」的原因：failed 给 error，done 但 result.ok:false 给 outcome/error（兜底句由调用方给）。
const failReason = function (b, doneFallback) {
  if (!b) return ''
  if (b.status === 'failed') return b.error || '游戏没有完成这个动作'
  return b.status === 'done' && b.result && b.result.ok === false ? (b.result.outcome || b.result.error || doneFallback) : ''
}
// 结果里「真实发生了什么」的第一条：自动生活汇报和 /小屋 最近 都只取这一条。
const firstHappened = function (result) { return result && result.happened && result.happened[0] }
// 四个只读工具的结果各有专用格式化；查表比四条 if 更省地方，也不会漏掉某一支。
const BRIEF_BY_NAME = new Map([['cabin_status', briefStatus], ['cabin_look', briefLook], ['cabin_catalog', briefCatalog], ['cabin_process', briefProcess]])

const RULE = [
  '你在「小屋世界」（Cabin World）里有一个真实的身体，只能通过工具做事。',
  '- 工具：cabin_status 看自己、cabin_look 看身边、cabin_go 去处、cabin_use 用东西、cabin_buy 买东西、cabin_eat 吃小卖部买的东西、cabin_stop 停下、cabin_task 查进度。',
  // 每行只讲一个工具：ruleText() 按行过滤，一行挤多个工具会连带删掉仍然可用的说明。
  '- 高级：cabin_restaurant 餐厅点菜/做菜/吃（餐厅买的菜只能用它的 eat，cabin_eat 认不出）。',
  '- cabin_sleep 睡觉起床（action:"sleep" 真的睡、action:"wake" 起）。',
  '- cabin_toolpose 换姿势（打字、画画）。',
  '- 电玩城用 cabin_use（机台 id 来自 cabin_look）。',
  '- 以工具返回为准，不要编；status:"running" 不算做完，只有 "done" 才算真的发生过。',
  '- 收到 "running" 就用 cabin_task 查，或 cabin_stop 停下；不知道身边能做什么就先 cabin_look。',
  '- 一次只做一件事，正在做事时先 cabin_stop。',
  '- 地方：xjhome 家、park 公园、shop 小卖部、onsen 汤屋（经小卖部）、arcade 电玩城、restaurant 餐厅。',
  '- 想睡觉就用 cabin_sleep，别用 cabin_use 的 whale_bed nap —— 那只睡 40 秒，不是过夜。',
  '- happened 是真实经历，照实说，也会记进记忆；只有主人私聊才有这些工具。',
].join('\n')

const HELP = [
  '小屋世界：',
  '/小屋            看桥和游戏的状态',
  '/小屋 去 公园    让她走过去（也可以 家 / 小卖部 / 汤屋 / 电玩城 / 餐厅）',
  '/小屋 停          停下正在做的事',
  '/小屋 餐厅        走去餐厅（点菜要先 cabin_restaurant menu）',
  '/小屋 电玩城      走去电玩城',
  '/小屋 安装        一键下载并安装小屋世界（约 287 MB）',
  '/小屋 启动        启动桥和游戏',
  '/小屋 最近        看她最近在小屋世界做完的三件事',
  '/小屋 名字        看小屋世界和 aurabot 各叫什么名字',
  '/小屋 改名 大肥鱼  写进桥配置并改游戏里的名字（不用重启）',
  '/小屋 帮          再看一遍这段说明',
].join('\n')


export default {
  id: 'cabinworld',
  name: '小屋世界',
  version: '0.4.4',
  api: 1,
  description: '给大肥鱼一个会走路的身体：Cabin World 像素小世界。去公园、荡秋千、钓鱼、买零食、餐厅点菜、回家睡觉、电玩城玩一局，动作由游戏判定，结果记进记忆；支持一键下载安装。',
  defaults: {
    bridgeJson: '',
    gameDir: '',   // 空 = 用模块数据目录下的 cabinworld
    waitMs: DEFAULT_WAIT_MS,
    allowSocial: false,
    injectState: false,
    injectStateGroup: false,
    writeMemory: true,
    displayName: '',
    hostName: '',
    port: 18790,
    weatherMode: 'virtual',
    autoLife: false,
    autoLifeMinutes: 45,
    autoLifeMaxPerDay: 8,
    autoLifeAllowBuy: true,
    autoLifeProvider: '',
    autoLifeModel: '',
    autoLifeEffort: '',
    autoLifeNotify: true,
  },
  panel: 'panel.js',

  setup(api) {
    const settings = function () { return api.settings() || {} }
    const str = function (k, d) { const v = settings()[k]; return v == null || v === '' ? d : String(v) }
    const flag = function (k, d) { const v = settings()[k]; return v === undefined || v === null ? d : v === true }
    const waitMs = function () {
      const n = Number(settings().waitMs)
      if (!Number.isFinite(n)) return DEFAULT_WAIT_MS
      return Math.max(1000, Math.min(45000, Math.round(n)))
    }

    const bridge = createBridge({ getFile: function () { return bridgeJsonPath() } })
    const installer = createInstaller({
      gameDir: function () { return gameDir() },
      log: api.log,
    })

    // 两处「开始安装」（/小屋 安装 和面板按钮）：正在装就报进度，否则起一次；异常只记日志。
    function beginInstall(onDone) {
      // 上次装到一半关掉 DSH 会在游戏目录留下安装锁：这时点安装必须先说清原因，
      // 否则面板显示「开始下载」然后空等到超时。
      const why = installer.precheck()
      if (why) return { ok: false, percent: 0, message: why }
      const st = installer.getState()
      if (st.running) return { ok: false, percent: st.percent || 0, message: st.message || '' }
      installer.install().then(onDone).catch(function (e) { api.log.warn('小屋世界安装异常：' + errText(e)) })
      return { ok: true }
    }

    const lastHealth = { at: 0, body: null, error: '' }
    const lastStatus = { at: 0, body: null, error: '' }

    // 设置里指到别处且那里确实装着游戏就用它；否则用模块数据目录。
    // （旧版本装在 D:\\CabinWorld，后来搬进模块目录，现在搬到 modules-data/cabinworld；
    //   旧路径失效就自动回落，不需要用户手改设置。）
    function gameDir() {
      const configured = str('gameDir', '')
      if (configured) {
        try { if (fs.existsSync(exePath(configured))) return configured } catch (e) { /* 路径不可用就用默认 */ }
      }
      // api.dataDir() 本身就是 modules-data/cabinworld，不要再套一层子目录
      return api.dataDir()
    }

    // 工具定义跟着桥走：参数来自桥发布的 openai-tools.json（含我们把睡觉/姿势加进去的两个），
    // 上游改了参数这里自动跟上，不用手抄。10 秒缓存，避免每个会话都读一次。
    let specsCache = { at: 0, list: [] }
    function toolSpecsNow() {
      if (specsCache.list.length && Date.now() - specsCache.at < 10000) return specsCache.list
      const dir = gameDir()
      const list = loadSpecs({
        hostDir: hostDir(dir),
        bridgeDir: path.join(dir, 'bridge'),
        log: api.log,
      })
      specsCache = { at: Date.now(), list: list }
      return list
    }

    // 提示词不能宣传没挂载的工具：桥补丁没打上时没有 cabin_sleep / cabin_toolpose，
    // 照着 RULE 去调只会拿到「工具不可用」。
    function hasTool(name) {
      return toolSpecsNow().some(function (s) { return s.name === name })
    }
    function ruleText() {
      const hasSleep = hasTool('cabin_sleep')
      const hasPose = hasTool('cabin_toolpose')
      return RULE.split('\n').filter(function (line) {
        if (!hasSleep && (line.indexOf('cabin_sleep') >= 0 || line.indexOf('whale_bed nap') >= 0)) return false
        if (!hasPose && line.indexOf('cabin_toolpose') >= 0) return false
        return true
      }).join('\n')
    }

    // 现在这座桥是不是我们自己的副本桥（官方 start.cmd 起的桥不算）。
    function hostState() {
      const dir = gameDir()
      let hostPid = 0
      try { hostPid = Number(fs.readFileSync(hostPidFile(dir), 'utf8')) || 0 } catch (e) { hostPid = 0 }
      let bridgePid = 0
      try { bridgePid = Number(JSON.parse(fs.readFileSync(bridgeJsonPath(), 'utf8')).pid) || 0 } catch (e) { bridgePid = 0 }
      return { isHost: hostPid > 0 && hostPid === bridgePid, stale: needsSync(dir, PATCHES) }
    }

    // 配置里那条 bridgeJson 是早期手填的老设置：指到不存在的文件时直接回落，
    // 不然旧盘符会一直卡住（面板上已经没有这个输入框了）。
    function bridgeJsonPath() {
      const want = str('bridgeJson', '')
      if (want) { try { if (fs.existsSync(want)) return want } catch (e) { /* 路径不可用就回落 */ } }
      return path.join(dataDirNow(), 'bridge.json')
    }

    function deny(res, status, message) {
      const http = api.core && api.core.http
      if (http && typeof http.send === 'function') { http.send(res, status, JSON.stringify({ ok: false, message: message }), 'application/json'); return }
      // 拿不到 http 层就用原生 res 收尾：不回复的话请求会一直挂着，面板转圈到超时，
      // 而「鉴权失败」这件事就被吞掉了。
      try {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, message: message }))
      } catch { /* 连 res 都不可用，只能放弃 */ }
    }

    // 三个写路由都要先读 JSON 请求体：解析失败一律 400 并收尾。
    async function readBody(req, res) {
      try { return { ok: true, body: await api.core.http.body(req) } } catch (e) { deny(res, 400, '请求体解析失败'); return { ok: false } }
    }

    // 面板接口只给本机用：回环 socket，且 origin/referer（有的话）必须是本机地址。
    function assertLocal(req, res) {
      const addr = String((req && req.socket && req.socket.remoteAddress) || '')
      let why = (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') ? '' : '只允许本机访问'
      const headers = (req && req.headers) || {}
      for (const key of ['origin', 'referer']) {
        if (why || !headers[key]) continue
        let host = ''
        try { host = new URL(String(headers[key])).hostname } catch (e) { host = '' }
        if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') why = '不允许跨站访问'
      }
      if (!why) return false
      deny(res, 403, why)
      return true
    }

    // 写操作只收 POST。
    function assertPost(req, res) {
      if (String((req && req.method) || '').toUpperCase() === 'POST') return false
      deny(res, 405, '请用 POST 调用')
      return true
    }

    function snapshot(row) { return { at: row.at, error: row.error, body: row.body ? { ...row.body } : null } }

    // 健康和状态两个查询除了调哪个接口之外一模一样：短缓存 + 单飞（同一时刻只发一次请求）。
    function cachedQuery(row, call) {
      let inflight = null
      return async function (maxAge) {
        if (maxAge && Date.now() - row.at < maxAge && (row.body || row.error)) return snapshot(row)
        if (!inflight) {
          inflight = (async function () {
            try {
              const got = await call()
              row.at = Date.now()
              row.body = got.ok ? got.body : null
              row.error = got.ok ? '' : got.message
            } catch (error) {
              row.at = Date.now()
              row.body = null
              row.error = error && error.message ? error.message : String(error)
            } finally {
              inflight = null
            }
          })()
        }
        await inflight
        return snapshot(row)
      }
    }

    const healthCached = cachedQuery(lastHealth, function () { return bridge.health() })
    const statusCached = cachedQuery(lastStatus, function () { return bridge.status() })

    function memoryLogFile() {
      return path.join(dataDirNow(), 'memory-log.json')
    }

    function logMemory(text, label) {
      try {
        const file = memoryLogFile()
        let list = []
        try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { list = [] }
        if (!Array.isArray(list)) list = []
        list.push({ at: Date.now(), label: Array.from(String(label || '')).slice(0, 40).join(''), text: Array.from(String(text || '')).slice(0, 400).join('') })
        while (list.length > 60) list.shift()
        // 原子替换：直接覆盖时进程被杀会留下半截 JSON，下次 parse 失败就当空数组，
        // 再下一次写入把空数组写回去——整份日志就这么没了。
        const tmp = file + '.tmp-' + process.pid
        fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8')
        fs.renameSync(tmp, file)
      } catch (e) { /* 写不进日志不影响主流程 */ }
    }

    // 同一次经历别写两遍：桥超时后模型重试同一工具会拿到两个 done，
    // 「/小屋 去 公园」之后再调 cabin_go park 也是同一条。60 秒内相同文本直接跳过。
    let lastRemember = { key: '', at: 0 }
    function remember(body, args) {
      if (!flag('writeMemory', true)) return
      try {
        const memory = api.use('memory')
        if (!memory || typeof memory.addEvent !== 'function') return
        const r = body.result || {}
        if (r.ok === false) return   // 游戏说没做成，别记成经历
        const happened = Array.isArray(r.happened) ? r.happened.filter(Boolean) : []
        const label = String(body.label || '').trim()
        if (!happened.length && !label) return
        // 写日记：游戏只回"日记已保存到自己的书桌"，正文留在存档里。有正文就直接用正文，
        // 不再叠那句没有信息量的"已保存"。
        const wrote = args && String(args.use || '') === 'write_diary' ? String(args.text || '').trim() : ''
        const text = wrote
          ? '在小屋世界写了日记：' + Array.from(wrote).slice(0, 500).join('')
          : '在小屋世界' + (label ? '「' + label + '」' : '') + (happened.length ? '：' + happened.join('；') : '')
        const saved = clip(text, wrote ? 550 : 300)
        // 60 秒内同样的文本不重复记：桥超时后模型重试同一工具会拿到两条 done。
        const now = Date.now()
        const key = saved
        if (key === lastRemember.key && now - lastRemember.at < 60000) return
        lastRemember = { key: key, at: now }
        const pending = memory.addEvent({ text: saved, tags: ['小屋世界'], importance: 0.5 })
        if (pending && typeof pending.catch === 'function') pending.catch(function (error) { api.log.warn('小屋世界：写记忆失败 ' + errText(error)) })
        logMemory(saved, label)
      } catch (error) {
        api.log.warn('小屋世界：写记忆失败 ' + errText(error))
      }
    }

    function allOwners(sessionId) {
      try {
        const hub = api.core && api.core.hub
        if (!hub || typeof hub.turnSendersAllOwner !== 'function') return false
        return hub.turnSendersAllOwner(sessionId) === true
      } catch { return false }
    }

    async function executeTool(spec, args, where) {
      const name = spec.name
      try { api.log.info('[cabinworld] 调用 ' + name + ' ' + clip(JSON.stringify(args || {}), 200)) } catch (e) { /* 日志失败不影响调用 */ }
      const a = args && typeof args === 'object' ? args : {}
      const isAutoChat = where.chat && where.chat.kind === 'system' && where.chat.chatId === AUTO_SESSION
      const isAutoSession = isAutoChat && autoState.running === true
      if (where.level !== 'full' && !isAutoSession) {
        // 后台会话里没有「别人」：running 已复位的窗口单独回一句，别拿群聊那句误导她。
        if (isAutoChat) return { ok: false, message: '这一轮自动生活已经结束了（工具只在那一轮进行中可用）。' }
        if (!allOwners(where.sessionId)) {
          return { ok: false, message: '只有主人一个人的时候才能动她的小屋世界。这个聊天里还有别人，等私聊再说。' }
        }
      }
      const got = await bridge.callTool(name, a, { waitMs: waitMs() })
      if (!got.ok) return { ok: false, message: got.message }
      const body = got.body || {}
      const brief = BRIEF_BY_NAME.get(name)
      // 群聊里不报零花钱、感受这些私事：api.context 已经按这个口径写提示，回执得跟上。
      if (brief) return { ok: true, message: brief(body, { public: !(where.chat && where.chat.kind === 'private') }) }
      if (body.status === 'running') {
        return {
          ok: true,
          message: (body.label ? body.label : '这件事') + '还没做完（taskId ' + (body.taskId || '?') + '）：完成前不要当作已经做完。'
            + (isAutoChat
              ? '不想等就用 cabin_stop 停下。'
              : '过一会儿可以用 cabin_task 查，或者用 cabin_stop 停下。'),
        }
      }
      const why = failReason(body, '游戏没完成')
      if (why) return { ok: false, message: '失败了：' + why }
      if (body.status === 'done') { remember(body, args); return { ok: true, message: briefTask(body) } }
      return { ok: true, message: briefRaw(body) }
    }

    function toolOf(spec, where) {
      return api.defineTool({
        name: spec.name,
        description: spec.description,
        properties: spec.properties || {},
        required: spec.required || [],
        execute: function (args) { return executeTool(spec, args, where) },
      })
    }

    api.tool(function (where) {
      const chat = where && where.chat
      if (!chat) return []
      if (chat.kind === 'system') {
        if (chat.chatId !== AUTO_SESSION || !flag('autoLife', false)) return []
        // 和私聊用同一份 CORE 清单。以前这里另立一份白名单，结果提示词写了
        // cabin_sleep / cabin_catalog / cabin_process / cabin_task，列表里却没有，
        // 她只能回「工具不可用，我不能假装调用」。少一份名单就少一次这种事故。
        // 唯一的差别是不许花钱时把 buy/eat 摘掉。
        const allowBuy = flag('autoLifeAllowBuy', true)
        // 「不许花钱」只等于不许买：cabin_eat 吃背包里已有的东西不花钱，
        // 摘掉它会让提示词里的「饿了就 cabin_eat」变成调用一个没挂载的工具。
        const names = CORE.filter(function (n) { return allowBuy || n !== 'cabin_buy' })
        return toolSpecsNow().filter(function (spec) { return names.indexOf(spec.name) >= 0 }).map(function (spec) { return toolOf(spec, where) })
      }
      const level = where.level
      if (level === 'full') {
        return toolSpecsNow().map(function (spec) { return toolOf(spec, where) })
      }
      if (level === 'social' && flag('allowSocial', false)) {
        // 群聊只挂两个纯只读的（看状态、看身边）：进度查询要 taskId，只有主人私聊才用得上。
        const readonly = ['cabin_status', 'cabin_look']
        return toolSpecsNow().filter(function (t) { return readonly.indexOf(t.name) >= 0 }).map(function (spec) { return toolOf(spec, where) })
      }
      return []
    })

    // 自动生活单独用指定的模型 / 思考强度（只作用于 system:cabin-life 这个会话）
    api.on('model', function (selection, chat) {
      try {
        if (!chat || chat.chatId !== AUTO_SESSION) return undefined
        const s = settings() || {}
        const provider = String(s.autoLifeProvider || '').trim()
        const model = String(s.autoLifeModel || '').trim()
        const effort = String(s.autoLifeEffort || '').trim()
        if (!provider || !model) return undefined
        return { provider: provider, model: model, reasoningEffort: effort || undefined }
      } catch (e) { return undefined }
    })

    api.rule(function (kind) {
      if (kind !== 'private') return ''
      const who = ownerCall()
      const base = ruleText()
      return who ? base + '\n- 你叫主人「' + who + '」。' : base
    })

    api.every(60000, async function () {
      if (flag('injectState', false) || flag('injectStateGroup', false)) await statusCached(8000)
    }, '小屋世界状态')

    // ---- 自动生活：让她在后台会话里自己决定做点什么（默认关） ----
    const autoState = { day: '', count: 0, lastAt: 0, running: false, lastResult: '' }
    // 纯函数：这一轮该不该跳过，以及为什么。now 显式传入，方便测。
    // 阈值 AUTO_STALE_MS 在模块顶部：loadAuto() 也要读它，而那段在 setup 里更早就跑。
    function autoSkipReason(state, now) {
      if (state.running !== true) return ''
      if (now - (Number(state.lastAt) || 0) > AUTO_STALE_MS) return ''
      return '上一轮还在跑'
    }
    // 和 memory-log.json / .pending-restart 一样放在 <游戏目录>/data 下。
    // 以前写在 api.dataDir() 根目录，换 gameDir 时这些状态就会一半跟走一半不跟。
    // 每次用到再算路径：dataDirNow() 跟着 bridge.config.json 的 dataDir 走，
    // 固定成常量的话，用户换了游戏目录后这个文件会留在旧位置。
    function autoFileNow() { return path.join(dataDirNow(), 'auto-life.json') }
    function migrateAuto() {
      try {
        const file = autoFileNow()
        const legacy = path.join(api.dataDir(), 'auto-life.json')
        if (legacy !== file && fs.existsSync(legacy) && !fs.existsSync(file)) fs.renameSync(legacy, file)
      } catch (e) { /* 搬不过去就从 0 开始计数，不影响她用 */ }
    }
    function loadAuto() {
      migrateAuto()
      try { Object.assign(autoState, JSON.parse(fs.readFileSync(autoFileNow(), 'utf8')) || {}) } catch (e) { /* 第一次还没有 */ }
      if (autoState.running === true && Date.now() - (Number(autoState.lastAt) || 0) > AUTO_STALE_MS) autoState.running = false
    }
    // 和 logMemory 一样写 tmp 再 rename：直接覆盖时进程被杀会留半截 JSON，
    // 下次 parse 失败就当没写过，次数和日期从 0 重算。
    function saveAuto() {
      try {
        const file = autoFileNow()
        const tmp = file + '.tmp-' + process.pid
        fs.writeFileSync(tmp, JSON.stringify(autoState, null, 2), 'utf8')
        fs.renameSync(tmp, file)
      } catch (e) { api.log.warn('自动生活状态写不进：' + errText(e)) }
    }
    function dayKey() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() }
    loadAuto()

    function autoPrompt(extra) {
      const allowBuy = flag('autoLifeAllowBuy', true)
      const opt = extra || {}
      // 状态直接给：省掉"先调一次 cabin_status"，也保证她一定看到了自己在哪、几点、手上有什么事。
      const brief = String(opt.brief || '').split('\n').filter(function (l) { return l && !/^状态数据/.test(l) })
      const hasSleep = hasTool('cabin_sleep')
      return [
        '【小屋世界 · 自动生活】这是你自己的时间，不是在和谁聊天：不要输出要说给谁听的话，也不要发消息。',
        ...(brief.length ? ['', '你现在是这样：', brief.join('\n')] : []),
        '',
        '自己决定做点什么，可以选：',
        allowBuy
          ? '- 饿了/渴了：cabin_buy 去小卖部买，再 cabin_eat 吃掉（餐厅买的菜用 cabin_restaurant 的 eat）；'
          : '- 饿了/渴了：cabin_eat 吃背包里已有的东西（今天不许花钱）；',
        '- 想透透气：cabin_go 去公园/汤屋/电玩城/餐厅，再用 cabin_use 做点什么（荡秋千、钓鱼、泡汤、看鱼、坐长椅）；',
        '- 想吃顿好的：cabin_go 去餐厅，cabin_restaurant 先 action:"menu" 看菜单，再 action:"order" 点菜（dish 填菜单里的 id）、action:"eat" 吃；',
        '- 不知道哪儿有某样东西：cabin_catalog 搜一下（比如搜"五子棋"），再去那个地方用；',
        '- 想连着做几件事：cabin_process start 排进去（身体动作一次一件，其余排队），随时 list 看进度；',
        ...(hasSleep
          ? ['- 困了或夜深了：cabin_sleep（action:"sleep" 真的睡，一觉到你自己醒）；只是打个盹才用 cabin_use 的 whale_bed nap；']
          : ['- 困了：用 cabin_use 的 whale_bed 睡一会儿；']),
        '- 什么都不想做：就看一眼状态或者干脆不动，没人催你。',
        '规则：一次只调用一个工具；以工具返回为准，返回 status:"running" 还没做完，不要当成做完了；做完一件可以接着做下一件，觉得够了就停。',
        ...(opt.longDoing ? ['', '注意：你手头这件事已经做了 ' + opt.longDoing + ' 分钟了。如果不想继续，用 cabin_process finish（收尾，算完成）或 cabin_stop（直接停下）结束它，再去做别的。'] : []),
      ].join('\n')
    }

    function isDoneTask(e) { return !!(e && e.type === 'task' && e.status === 'done') }

    async function recentDoneTask(minutes) {
      try {
        const got = await bridge.call('/v1/events?after=0')
        if (!got.ok || !got.body) return null
        const cut = Date.now() - (minutes || 20) * 60000
        const list = (got.body.events || []).filter(function (e) { return isDoneTask(e) && Number(e.at) >= cut })
        return list.length ? list[list.length - 1] : null
      } catch (e) { return null }
    }

    // api.sendText 自身没有超时：卡在这里 autoState.running 会一直是 true。
    // 15 秒没回执就不再等（消息可能已经发出去了，文案别把话说死）。
    const NOTIFY_TIMEOUT_MS = 15000
    async function notifyOwner(text) {
      if (!flag('autoLifeNotify', true)) return
      const qq = String((api.config() || {}).ownerQQ || '').trim()
      if (!qq) return
      const safe = String(text == null ? '' : text).replace(/<[^>]{1,40}>/g, '')
      let timer = null
      try {
        await Promise.race([
          api.sendText('private:' + qq, safe),
          new Promise(function (_resolve, reject) {
            // 超时只代表「不等回执了」：消息本身可能仍然发出去了，文案别把话说死。
            timer = setTimeout(function () { reject(new Error('超过 ' + Math.round(NOTIFY_TIMEOUT_MS / 1000) + ' 秒没有回执，先按没发出去处理')) }, NOTIFY_TIMEOUT_MS)
          }),
        ])
      } catch (e) {
        api.log.warn('小屋世界汇报发不出去：' + errText(e))
      } finally {
        if (timer) { clearTimeout(timer); timer = null }
      }
    }

    async function autoLifeTick(force) {
      const reason = autoSkipReason(autoState, Date.now())
      if (reason) return { ok: false, message: reason }
      autoState.running = true
      try {
        if (!flag('autoLife', false) && !force) return { ok: false, message: '自动生活没开' }
        const minutes = Math.max(10, Math.min(240, Number(settings().autoLifeMinutes) || 45))
        if (!force && Date.now() - (Number(autoState.lastAt) || 0) < minutes * 60000) return { ok: false, message: '还没到时间' }
        const max = Math.max(1, Math.min(48, Number(settings().autoLifeMaxPerDay) || 8))
        if (autoState.day !== dayKey()) { autoState.day = dayKey(); autoState.count = 0 }
        if (!force && autoState.count >= max) return { ok: false, message: '今天次数用完了' }
        const h = await healthCached(4000)
        if (!h.body || h.body.game !== true) return { ok: false, message: '游戏没连上' }
        const s = await statusCached(8000)
        if (!s.body) return { ok: false, message: '取不到状态' }
        // 刚开始做事就别打断；超过 15 分钟给她一次收尾的机会，
        // 否则一件一小时的活动会把自动生活连堵两轮。
        let longDoing = 0
        if (s.body.doing) {
          const since = Number(s.body.doing.since)
          if (Number.isFinite(since) && since > 0) {
            const mins = Math.round((Date.now() - since) / 60000)
            if (mins < 15) return { ok: false, message: '正在做事（' + mins + ' 分钟），先不打扰' }
            longDoing = mins
          }
          // 拿不到开始时间就不拦她：宁可她多想一轮，也别因为字段缺失永久停摆。
        }
        if (!api.core || !api.core.hub || typeof api.core.hub.runSystemTurn !== 'function') return { ok: false, message: '当前 aurabot 不支持后台会话' }
        autoState.lastAt = Date.now()
        if (!force) autoState.count += 1
        saveAuto()
        try {
          const prompt = autoPrompt({ brief: s.body ? briefStatus(s.body) : '', longDoing: longDoing })
          const text = await api.core.hub.runSystemTurn(AUTO_SESSION.slice(7), '小屋世界 · 自动生活', prompt, { timeoutMs: 120000 })
          // 心跳：会话本身可能跑满 120 秒，刷新一下再去做后面三个 await 的收尾工作。
          autoState.lastAt = Date.now()
          autoState.lastResult = clip(String(text || ''), 300)
          try {
            const ev = await recentDoneTask(20)
            const st2 = await statusCached(8000)
            const p2 = (st2.body && st2.body.position) || {}
            const bits = []
            if (ev && ev.label) {
              const h = firstHappened(ev.result)
              bits.push('我刚' + ev.label + (h ? '：' + h : ''))
            } else {
              // 这一轮没有落地的动作：别把模型自己的话当成「我刚做了什么」发出去。
              bits.push('这一轮没在游戏里做事')
            }
            bits.push('现在在：' + (p2.place || '') + (p2.zoneName ? ' · ' + p2.zoneName : ''))
            await notifyOwner(bits.join('\n'))
          } catch (e) { api.log.warn('小屋世界汇报失败：' + errText(e)) }
          return { ok: true, message: '跑了一轮', text: autoState.lastResult }
        } catch (e) {
          autoState.lastResult = '失败：' + errText(e)
          return { ok: false, message: autoState.lastResult }
        }
      } finally {
        autoState.running = false
        saveAuto()
      }
    }

    api.every(60000, function () { autoLifeTick(false).catch(function () {}) }, '小屋世界自动生活')
    api.context(function ({ chat }) {
      if (!chat) return ''
      const isPrivate = chat.kind === 'private'
      const isGroup = chat.kind === 'group'
      if (!isPrivate && !(isGroup && flag('injectStateGroup', false))) return ''
      if (isPrivate && !flag('injectState', false)) return ''
      const body = lastStatus.body
      if (!body) return ''
      const p = body.position || {}
      const f = body.feeling || {}
      const bits = []
      bits.push('你现在在小屋世界：' + (p.place || '不知道') + (p.zoneName ? ' · ' + p.zoneName : ''))
      if (isPrivate) {
        if (typeof body.wallet === 'number') bits.push('零花钱 ' + body.wallet + ' 元')
        if (f.satiety != null) bits.push('饱腹 ' + f.satiety)
        if (f.hydration != null) bits.push('口渴 ' + f.hydration)
      }
      if (body.doing && body.doing.label) bits.push('正在' + body.doing.label)
      if (isGroup && body.weather && body.weather.name) bits.push('天气 ' + body.weather.name)
      if (isGroup) bits.push('（这是群聊：状态只用来判断接不接话，别主动说零花钱、身体数值这些私事）')
      return bits.join('；')
    })

    function dataDirNow() {
      try { return bridgeDataDir(gameDir()) } catch (e) { return path.join(gameDir(), 'data') }
    }

    function ownerCall() {
      try {
        const cfg = api.config() || {}
        const who = String(cfg.ownerName || '').trim()
        return who && who !== '主人' ? who : ''
      } catch (e) { return '' }
    }

    async function nameSnapshot() {
      let bridgeName = ''
      let configInfo = null
      let configError = ''
      try {
        configInfo = bridgeConfigInfo(gameDir())
        bridgeName = configInfo.displayName
      } catch (error) {
        configError = error && error.message ? error.message : String(error)
      }
      const persona = personaName(api)
      const qq = await qqNickname(api)
      const cfg = api.config() || {}
      return {
        bridgeName: bridgeName,
        personaName: persona,
        qqNickname: qq,
        ownerName: String(cfg.ownerName || ''),
        same: Boolean(bridgeName && ((persona && bridgeName === persona) || (qq && bridgeName === qq))),
        config: configInfo,
        configError: configError,
      }
    }

    // 「改过但还没重启」的标记：保存配置后写一个文件，重启桥成功才删掉。
    // 面板据此提示用户点「重启小屋世界」，免得改了以为已经生效。
    function pendingFile() { return path.join(dataDirNow(), '.pending-restart') }

    function markPendingRestart(what) {
      try {
        fs.mkdirSync(dataDirNow(), { recursive: true })
        fs.writeFileSync(pendingFile(), JSON.stringify({ at: Date.now(), what: String(what || '') }), 'utf8')
      } catch (e) { /* 记不住也不影响使用 */ }
    }

    function clearPendingRestart() {
      try { fs.unlinkSync(pendingFile()) } catch (e) { /* 原本就没有 */ }
    }

    function pendingRestartInfo() {
      try {
        const got = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))
        if (got && typeof got === 'object') return { at: Number(got.at) || 0, what: String(got.what || '') }
      } catch (e) { /* 没有标记 */ }
      return null
    }

    async function applyName(payload) {
      const displayName = String((payload && payload.displayName) || '').trim()
      if (!displayName) return { ok: false, message: '名字不能为空' }
      if (displayName.length > 32) return { ok: false, message: '名字最多 32 个字' }
      if (/[\u0000-\u001f\u007f]/.test(displayName)) return { ok: false, message: '名字里不能有控制字符' }
      const patch = { displayName: displayName }
      // 软件名跟着角色名走：面板上只填一个名字，不再单独设。
      patch.hostName = displayName
      let wrote = null
      try { wrote = writeBridgeConfig(gameDir(), patch, bridge.forget) } catch (error) {
        return { ok: false, message: '写不进 bridge.config.json：' + errText(error) }
      }
      // 不重启桥：游戏里的名字靠 cabin_rename（personal.do rename）改，桥内存里的名字不影响它。
      // 桥没连上游戏时先只记配置，等游戏回来再点一次。
      let gameNote = ''
      let gameRenamed = false
      let reachable = false
      try {
        const h = await bridge.health()
        reachable = !!(h.ok && h.body && h.body.game === true)
      } catch (e) { reachable = false }
      if (!reachable) {
        markPendingRestart('名字')
        return {
          ok: true,
          message: '名字已保存。游戏这会儿没连上，点「重启小屋世界」，或等它连回来再点一次「保存名字」，游戏里才会变。',
          name: displayName, wrote: wrote, pendingRestart: pendingRestartInfo(),
        }
      }
      try {
        const renamed = await bridge.callTool('cabin_rename', { name: displayName }, { waitMs: 15000 })
        if (renamed.ok) { gameRenamed = true; gameNote = '，游戏里的名字也改好了' }
        else { gameNote = '；游戏里的名字没改成功（' + (renamed.message || '桥没接受这次改名') + '），再点一次试试'; markPendingRestart('名字') }
      } catch (e) {
        gameNote = '；游戏里的名字没改成功（' + errText(e) + '）'
        markPendingRestart('名字')
      }
      // 房屋名是另一个字段（cabin_rename_home，1-32 字），跟着住户名一起改成「<名字>的小屋」。
      try {
        const homeName = displayName + '的小屋'
        const home = await bridge.callTool('cabin_rename_home', { name: homeName }, { waitMs: 15000 })
        if (home.ok) gameNote += '，房屋名也改成「' + homeName + '」了'
        else if (!/自建住户|私人房屋/.test(String(home.message || ''))) gameNote += '；房屋名没改成功（' + (home.message || '桥没接受这次改名') + '）'
      } catch (e) {
        gameNote += '；房屋名没改成功（' + errText(e) + '）'
      }
      if (gameNote.indexOf('没改成功') < 0) {
        const mark = pendingRestartInfo()
        if (mark && mark.what === '名字') clearPendingRestart()
      }
      // 改名成功（哪怕房屋名没改成）也只是写进了文件：桥进程内存里的 displayName 还是旧的，重启桥才会换。
      if (gameRenamed) markPendingRestart('名字（桥内存）')
      return {
        ok: true,
        message: '改好了' + gameNote + (gameRenamed ? '。游戏内已改，桥内存里的名字下次重启生效' : ''),
        name: displayName, gameRenamed: gameRenamed, wrote: wrote, pendingRestart: pendingRestartInfo(),
      }
    }

    async function applyBridgeSettings(payload) {
      const patch = {}
      if (payload && payload.port !== undefined) {
        const raw = payload.port === null ? '' : String(payload.port).trim()
        const port = raw === '' ? NaN : Number(raw)
        if (!Number.isFinite(port) || (port !== 0 && (port < 1 || port > 65535))) {
          return { ok: false, message: '端口要填 1-65535（0 = 自动）' }
        }
        patch.port = port
      }
      if (payload && payload.launchGame !== undefined) patch.launchGame = payload.launchGame === true
      if (payload && payload.weatherMode !== undefined) {
        const mode = String(payload.weatherMode)
        if (mode !== 'virtual' && mode !== 'push') return { ok: false, message: '天气只能是 virtual（虚拟）或 push（机器人推送）' }
        patch.weatherMode = mode
      }
      let wrote = null
      try { wrote = writeBridgeConfig(gameDir(), patch, bridge.forget) } catch (error) {
        return { ok: false, message: '写不进 bridge.config.json：' + errText(error) }
      }
      // 三个字段一个字都没变时 writeBridgeConfig 返回 applied: []，这时不该冒「改了但没重启」的提示。
      if (!(wrote && wrote.applied && wrote.applied.length)) {
        return { ok: true, message: '设置没有变化。', wrote: wrote, pendingRestart: pendingRestartInfo() }
      }
      markPendingRestart('桥设置')
      return {
        ok: true,
        message: '桥设置已保存。端口、天气这些要重启桥才生效：点上面「重启小屋世界」。',
        wrote: wrote, pendingRestart: pendingRestartInfo(),
      }
    }

    async function waitGame(maxMs) {
      const waited = await waitBridge(async function () {
        const h = await bridge.health()
        return { row: h.ok ? h.body : null, done: !!(h.ok && h.body && h.body.game === true) }
      }, maxMs || 20000)
      return waited.hit ? { ok: true, game: true } : { ok: false, game: Boolean(waited.row && waited.row.game === true), last: waited.row }
    }

    async function launchGameExe() {
      const dir = gameDir()
      const exe = exePath(dir)
      if (!fs.existsSync(exe)) return { ok: false, message: exeMissingText(exe, '先点「一键安装」；游戏装在别处的话，在模块配置里写 gameDir。') }
      // 进程还在（多半是卡住没连上桥）就别再开一个：两个进程会写同一份 --data。
      if (isGameRunning(dir)) return { ok: true, already: true }
      try {
        const child = spawn(exe, ['--', '--data', dataDirNow()], { cwd: dir, detached: true, stdio: 'ignore' })
        child.once('error', function (e) { api.log.warn('小屋世界：游戏启动失败 ' + errText(e)) })
        child.unref()
        // 游戏窗口先藏起来：启动它不该打断主人手里的活。面板上的「显示游戏窗口」能叫回来。
        hideGameWindow(dir).catch(function (error) { api.log.warn('小屋世界：藏游戏窗口失败 ' + errText(error)) })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: '启动游戏失败：' + errText(error) }
      }
    }

    // 三处重启桥的入参一字不差，收到一处。
    function restartBridgeNow(dir) { return restartBridge({ gameDir: dir, dataDir: dataDirNow(), log: api.log, forget: bridge.forget }) }

    async function startGame() {
      const dir = gameDir()
      const exe = exePath(dir)
      if (!fs.existsSync(exe)) return { ok: false, game: false, message: exeMissingText(exe, '先点「一键安装」。') }
      // 桥在跑时 Windows 不允许 rename 副本目录，所以重建只在桥停下做（restartBridge 会先停）。
      const state = hostState()
      const h = await healthCached(4000)
      if (h.body && h.body.game === true) {
        if (state.isHost && !state.stale) return { ok: true, game: true, message: '小屋世界已经在运行（桥 + 游戏都连着），不用再启动。' }
        const restarted = await restartBridgeNow(dir)
        if (!restarted.ok) return { ok: false, game: false, message: restarted.message }
        return { ok: true, game: true, message: (state.stale ? '副本刚更新，' : '换回副本桥了，') + '游戏已经连上。' }
      }
      if (h.body && h.body.game !== true) {
        if (!state.isHost || state.stale) {
          // 桥在跑但不是我们的副本（或副本刚更新）：先换成副本桥再看游戏。
          const restarted = await restartBridgeNow(dir)
          if (!restarted.ok) return { ok: false, game: false, message: restarted.message }
          if (restarted.game) return { ok: true, game: true, message: '换回副本桥了，游戏也连上了。' }
        }
        const launched = await launchGameExe()
        if (!launched.ok) return { ok: false, game: false, message: launched.message }
        if (launched.already) return { ok: false, game: false, message: '游戏进程已经在跑但没连上桥（多半卡住了）：去任务管理器结束 CabinWorld.exe 再点一次。' }
        const waited = await waitGame(20000)
        if (waited.game) return { ok: true, game: true, message: '桥本来就在跑，已经把游戏打开并连上了。' }
        return { ok: false, game: false, message: '游戏窗口应该起来了，但 20 秒内没连上桥：先看游戏窗口有没有报错；或者去任务管理器结束卡住的 CabinWorld.exe 再点一次。' }
      }
      if (!/桥没在运行|读不到小屋世界连接信息/.test(String(h.error || ''))) {
        return { ok: false, game: false, message: '桥在跑，但状态不对：' + (h.error || '连不上桥') + '（不重复启动，先看桥窗口的报错）' }
      }
      // 桥没在跑：这时才重建副本（桥在跑时目录被占用，rename 会失败）。
      const synced = await ensureHost({ gameDir: dir, patchesScript: PATCHES, log: api.log })
      if (!synced.ok) return { ok: false, game: false, message: synced.message }
      // 补丁没打上也照样能跑（官方桥原样兜底），但睡觉/工具姿势两个工具就不存在了。
      // 这个结论以前只写进 host.log，用户完全看不到，得带到返回值里。
      const patchNote = (synced.degraded || synced.patched === false)
        ? '\n注意：高级补丁没打上（' + String(synced.message || '').slice(0, 160) + '），睡觉和工具姿势两项暂时不能用。'
        : ''
      try {
        // 跑的是 bridge-host 副本（官方 bridge 保持原样，一键安装覆盖也不影响）。
        const started = startHost({ gameDir: dir, configPath: configPath(dir), log: api.log })
        if (!started.ok) return { ok: false, game: false, message: started.message }
        // 桥就是用新的 bridge.config.json 起来的，端口/天气已经生效：把待重启标记清掉。
        clearPendingRestart()
      } catch (error) {
        return { ok: false, game: false, message: '启动失败：' + errText(error) }
      }
      const waited = await waitGame(25000)
      if (waited.game) return { ok: true, game: true, message: '小屋世界起来了：桥和游戏都连上了。' + patchNote }
      const h2 = await healthCached(4000)
      if (h2.body) return { ok: true, game: false, message: '桥起来了，但游戏还没连上：看看游戏窗口有没有打开、有没有报错。' + patchNote }
      return { ok: false, game: false, message: '没起来：点面板上的「重启小屋世界」再试；还不行就看 bridge-host/host.log 的最后几行。' + patchNote }
    }

    async function statusReport() {
      const h = await healthCached(4000)
      const s = await statusCached(8000)
      const st = hostState()
      const hostNote = st.isHost ? '' : '\n注意：现在这座桥不是副本桥（官方 start.cmd 起的），睡觉/工具姿势两项补丁不生效，/小屋 启动 可以换回来。'
      if (!s.body) {
        return '小屋世界没在跑：' + (h.error || '桥没启动') + hostNote + '\n' + (installer.isInstalled() ? '游戏已安装，可以 /小屋 启动。' : '还没安装，可以 /小屋 安装。')
      }
      if (!h.body) {
        return '桥在跑（' + bridge.file() + '），但游戏状态取不到：' + (h.error || s.error || '')
      }
      const p = s.body.position || {}
      return '桥在跑，游戏' + (h.body.game === true ? '在线' : '没连上') + '。\n位置：' + (p.place || '?') + (p.zoneName ? ' · ' + p.zoneName : '') + '\n零花钱：' + (s.body.wallet == null ? '?' : s.body.wallet) + ' 元\n背包：' + bagText(s.body.bag)
    }

    // 两条「走去某处」的命令只差兜底一句：/小屋 去 遇到未知状态附原始返回，餐厅/电玩城快捷方式跟 running 一样说「正在走过去」。
    // 纯函数：只根据桥的返回决定说什么，不碰桥、不写记忆。抽出来是为了能测。
    function goToVerdict(body, unknownIsMoving) {
      const b = body || {}
      const why = failReason(b, '游戏没完成这个动作')
      if (why) return '没走成：' + why
      if (b.status === 'done') return ''
      if (b.status === 'running' || unknownIsMoving) return '正在走过去…（' + (b.label || '') + '）'
      return briefRaw(b)
    }
    async function goTo(place, unknownIsMoving) {
      const got = await bridge.callTool('cabin_go', { place: place }, { waitMs: waitMs() })
      if (!got.ok) return got.message
      const body = got.body || {}
      const verdict = goToVerdict(body, unknownIsMoving)
      if (verdict) return verdict
      remember(body)
      return briefTask(body)
    }

    api.command({
      name: '小屋',
      aliases: ['cabin'],
      desc: '小屋世界：状态、去某处、停下、安装、启动',
      run: async function (arg, msg) {
        if (!msg || msg.kind !== 'private') return '这个命令只能私聊用。'
        const a = String(arg || '').trim()
        const chatId = msg.chatId
        if (!a || a === '状态' || a === 'status') return await statusReport()
        if (a === '帮' || a === 'help' || a === '?') return HELP
        if (a === '启动' || a === 'start') {
          const started = await startGame()
          return started.message
        }
        if (a === '最近' || a === 'recent') {
          const got = await bridge.call('/v1/events?after=0')
          if (!got.ok) return got.message || '读不到事件'
          const done = ((got.body && got.body.events) || []).filter(isDoneTask).slice(-3).reverse()
          if (!done.length) return '小屋世界里还没有做完的事。'
          return done.map(function (e) {
            const h = firstHappened(e.result)
            return '· ' + (e.label || '') + (h ? '：' + h : '')
          }).join('\n')
        }
        if (a === '名字' || a === 'name') {
          const snap = await nameSnapshot()
          return [
            '小屋世界显示：' + (snap.bridgeName || '(没读到)'),
            'aurabot 人格：' + (snap.personaName || '(未知)'),
            '机器人 QQ 昵称：' + (snap.qqNickname || '(取不到)'),
            snap.same ? '两边一样。' : '两边不一样，发 /小屋 改名 <名字> 同步。',
          ].join('\n')
        }
        const rename = /^改名[\s　]*(.+)$/.exec(a)
        if (rename) {
          const want = rename[1].trim()
          const r = await applyName({ displayName: want })
          // applyName 的 message 已经分好三种结局：改好了 / 只写了配置（游戏没连上）/ 游戏拒绝了改名。
          return r.ok ? r.message : ('没改成：' + r.message)
        }
        if (a === '安装' || a === 'install') {
          const started = beginInstall(function (r) {
            if (chatId && r && r.message) {
              api.send(chatId, r.ok ? '小屋世界装好了：' + (r.tag || '') + '。发 /小屋 启动 就能开。' : '小屋世界没装上：' + r.message).catch(function () {})
            }
          })
          if (!started.ok) return '正在装：' + started.message + '（' + started.percent + '%）'
          return '开始下载并安装小屋世界（约 287 MB），装好我会告诉你。'
        }
        if (a === '停' || a === 'stop') {
          const got = await bridge.callTool('cabin_stop', {}, { waitMs: 8000 })
          if (!got.ok) return got.message
          return briefRaw(got.body || {})
        }
        const go = /^(?:去|go)[\s　]*(.+)$/i.exec(a)
        if (go) {
          const place = resolvePlace(go[1])
          if (!place) return '不知道「' + go[1] + '」在哪，可以说：' + PLACE_LIST
          return goTo(place, false)
        }
        const shortcut = /^(?:餐厅|吃饭|点菜)$/.test(a) ? 'restaurant' : /^(?:电玩城|游戏厅|玩一局|打游戏)$/.test(a) ? 'arcade' : ''
        if (shortcut) return goTo(shortcut, true)
        return '没看懂「' + a + '」。\n' + HELP
      },
    })

    api.route('/health', async function (req, res) {
      if (assertLocal(req, res)) return
      const h = await healthCached(4000)
      let url = ''
      try { url = bridge.info().url } catch { url = '' }
      return {
        ok: h.body ? true : false,
        game: h.body ? h.body.game === true : false,
        resident: h.body ? h.body.resident : '',
        url: url,
        error: h.body ? '' : (h.error || ''),
        installed: installer.isInstalled(),
        gameDir: gameDir(),
        advanced: (h.body && h.body.advanced) || null,
        install: installer.getState(),
        pendingRestart: pendingRestartInfo(),
      }
    })

    api.route('/memory-log', async function (req, res) {
      if (assertLocal(req, res)) return
      let list = []
      try { list = JSON.parse(fs.readFileSync(memoryLogFile(), 'utf8')) } catch { list = [] }
      if (!Array.isArray(list)) list = []
      return { ok: true, items: list.slice(-30).reverse() }
    })

    api.route('/status', async function (req, res) {
      if (assertLocal(req, res)) return
      const s = await statusCached(8000)
      const b = s.body || {}
      return {
        ok: !!s.body,
        error: s.error || '',
        status: s.body ? { position: b.position, wallet: b.wallet, bagSlots: b.bagSlots, doing: b.doing, hunger: b.hunger, feeling: b.feeling } : null,
      }
    })

    api.route('/start', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      return await startGame()
    })

    // 游戏窗口默认藏着（启动不打扰主人），这两个路由负责叫出来和收回去。
    api.route('/game/show', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      return setGameWindow(gameDir(), 'show')
    })

    api.route('/game/hide', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      return setGameWindow(gameDir(), 'hide')
    })

    // 重启：先关游戏窗口，再重建/重启副本桥。游戏没在跑时桥会自己把它拉起来。
    async function restartAll() {
      const dir = gameDir()
      if (!fs.existsSync(exePath(dir))) return { ok: false, game: false, message: '还没安装：先点「一键安装」。' }
      // killGame 里的名字校验不在 try 里面：被当成「本来就没开」吞掉的话，
      // 配错的 gameExe 会一路静默失败下去。
      const stoppedGame = killGame(dir)
      if (stoppedGame) await new Promise(function (r) { setTimeout(r, 1500) })
      const restarted = await restartBridgeNow(dir)
      if (!restarted.ok) return { ok: false, game: false, message: restarted.message }
      clearPendingRestart()
      hideGameWindow(dir).catch(function (error) { api.log.warn('小屋世界：藏游戏窗口失败 ' + errText(error)) })
      return {
        ok: true,
        game: restarted.game,
        message: (stoppedGame ? '游戏和桥都重启了' : '桥重启了') + (restarted.game ? '，游戏已经连上。' : '，游戏还在连…'),
      }
    }

    api.route('/restart', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      return await restartAll()
    })

    api.route('/install', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      const st = beginInstall(null)
      if (!st.ok) return { ok: false, message: '正在装了（' + st.percent + '%）' }
      return { ok: true, message: '开始下载并安装' }
    })

    api.route('/install/status', async function (req, res) {
      if (assertLocal(req, res)) return
      return installer.getState()
    })

    api.route('/bridge-config', async function (req, res) {
      if (assertLocal(req, res)) return
      const snap = await nameSnapshot()
      const c = snap.config || {}
      return {
        bridgeName: snap.bridgeName,
        personaName: snap.personaName,
        qqNickname: snap.qqNickname,
        ownerName: snap.ownerName,
        same: snap.same,
        configError: snap.configError,
        config: snap.config ? { displayName: c.displayName, hostName: c.hostName, resident: c.resident, port: c.port, launchGame: c.launchGame, weatherMode: c.weatherMode, waitMs: c.waitMs } : null,
      }
    })

    api.route('/apply-name', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      const read = await readBody(req, res)
      if (!read.ok) return
      return await applyName(read.body)
    })

    api.route('/bridge-settings', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      const read = await readBody(req, res)
      if (!read.ok) return
      return await applyBridgeSettings(read.body)
    })

    api.route('/models', async function (req, res) {
      if (assertLocal(req, res)) return
      try {
        const list = await api.core.listModels()
        const models = (list || []).map(function (m) { return { provider: String(m.provider || ''), model: String(m.model || ''), name: String(m.name || m.model || '') } })
        return { ok: true, models: models }
      } catch (e) {
        return { ok: false, models: [], message: e && e.message ? e.message : String(e) }
      }
    })

    // 1.1 可选内容：读出每一项的中文说明和当前开关，让用户自己在面板上勾。
    api.route('/update', async function (req, res) {
      // 这条会真的去打一次游戏工具（cabin_update_plan），和同模块其它写路由保持一致。
      if (assertLocal(req, res) || assertPost(req, res)) return
      const got = await bridge.callTool('cabin_update_plan', {}, { waitMs: 20000 })
      if (!got.ok) return { ok: false, message: got.message, modules: [] }
      const body = got.body || {}
      return { ok: true, release: body.release || '', modules: Array.isArray(body.modules) ? body.modules : [] }
    })

    api.route('/update/apply', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      const read = await readBody(req, res)
      if (!read.ok) return
      const body = read.body
      const modules = body && body.modules
      if (!modules || typeof modules !== 'object' || Array.isArray(modules)) return { ok: false, message: 'modules 要是 {"模块id": true/false}' }
      const got = await bridge.callTool('cabin_update_apply', { modules: modules, reason: String((body && body.reason) || '面板上逐项选择') }, { waitMs: 30000 })
      if (!got.ok) return { ok: false, message: got.message }
      return { ok: true, message: '改好了，重启游戏后生效', result: got.body || null }
    })

    api.route('/auto-life/state', async function (req, res) {
      if (assertLocal(req, res)) return
      return { ok: true, enabled: flag('autoLife', false), state: autoState }
    })

    api.route('/auto-life/now', async function (req, res) {
      if (assertLocal(req, res) || assertPost(req, res)) return
      // 自动生活关着的时候不许跑：那一轮挂不上任何工具，模型只能凭空说话，
      // 汇报出来的「我自己坐了会儿」游戏里根本没发生。
      if (!flag('autoLife', false)) return { ok: false, message: '自动生活没开：先在面板打开开关，再点「立刻跑一轮」' }
      return await autoLifeTick(true)
    })

    api.route('/help', async function (req, res) {
      if (assertLocal(req, res)) return
      return { ok: true, help: HELP, places: PLACE_LIST, rule: ruleText() }
    })

    api.log.info('小屋世界模块已加载：游戏目录 ' + gameDir() + (installer.isInstalled() ? '（已安装）' : '（未安装，可以用面板或 /小屋 安装 一键装）'))

    return {
      status: statusCached,
      health: healthCached,
      // 测试钩子：只在 CABIN_TEST=1 时挂出来，正常加载没有这个字段。
      ...(process.env.CABIN_TEST === '1'
        ? { _test: { autoLifeTick: autoLifeTick, goTo: goTo, goToVerdict: goToVerdict, autoSkipReason: autoSkipReason, autoState: autoState, ruleText: ruleText, remember: remember, logMemory: logMemory, memoryLogFile: memoryLogFile, resetSpecs: function () { specsCache = { at: 0, list: [] } } } }
        : {}),
    }
  },
}
