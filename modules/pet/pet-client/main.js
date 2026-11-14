// Aurabot 桌宠客户端（Electron 主进程）—— 本文件是模板/生成物：
// 由插件「桌宠」模块 POST /aurabot/api/ext/pet/client/install 生成到
//   <Aurabot 数据目录>/modules-data/pet/app/
// 运行前在本机装 Electron（插件本体不引入任何 npm 依赖）：
//   cd <app 目录> && npm init -y && npm i -D electron && npx electron main.js
//
// 行为：
//   · 读同目录上一级的 host.json（baseUrl + token 契约）→ 长轮询 GET /events?since=&wait=25
//   · proactive 事件弹气泡：优先播事件里的 anim（P2 点播，带 playbackId 回执），
//     否则从当前形象包的 speak 池里按权重抽一段（P1）；播完回 idle。
//   · 素材经 GET /asset/<包>/<文件>.webm?token= 拉（P1/P4；packs 目录在插件数据目录）。
//   · 端口漂移：baseUrl 失败或轮询出错都会重读 host.json 再试。
//   · 窗口：置顶、透明无边框、主进程权威拖拽（pet:drag-start/move/end，2026-11-07）+ 甩抛（physics.js，P3）、托盘退出、单实例锁。

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
// 崩溃保险丝（小屋联调期加）：未捕获异常/拒绝写进 app-crash.log 再退出——
// 以前这些只会进被丢弃的 stderr，客户端悄悄没了连个遗言都没有，没法排查。
for (const sig of ['uncaughtException', 'unhandledRejection']) {
  process.on(sig, (err) => {
    try { fs.appendFileSync(path.join(__dirname, 'app-crash.log'), `${new Date().toISOString()} ${sig}: ${err && err.stack ? err.stack : String(err)}\n`) } catch {}
    console.error(`[${sig}]`, err)
  })
}
const physics = require('./physics.js')
// 形象包元数据（池 ∪ 目录全量、菜单树），与 main.js 同目录生成。
// 容错：手工同步客户端时可能只拷了 main.js —— 缺了就退回「只认三个池」的老行为，绝不因此起不来。
let packmeta = null
try { packmeta = require('./packmeta.js') } catch (e) { console.error('缺少 packmeta.js，右键菜单只能列出 idle/speak/click 三个池：', e.message) }
// 行为执行器 + 反应层纯逻辑。容错：缺了就全量降级为 refused，绝不崩。
let behaviorApi = null
try { behaviorApi = require('./behavior.js') } catch (e) { console.error('缺少 behavior.js，行为动作全部不可用：', e.message) }
if (!behaviorApi) behaviorApi = {
  ACTIONS: {}, THRESHOLDS: {},
  execute: (a) => Promise.resolve({ status: 'refused', reason: 'behavior-module-missing:' + a }),
  isTeasing: () => false, isPatting: () => false, isCursorIdle: () => false,
  canReact: () => false, pickWanderTarget: () => null,
}
const metaApi = packmeta || {
  knownAnims: (pools) => Object.values(pools || {}).flat(),
  animUrlMap: (names, makeUrl) => Object.fromEntries((names || []).map((n) => [n, makeUrl(n)]).filter(([, u]) => u)),
  labelsOf: (m) => Object.fromEntries(Object.entries(m || {}).filter(([, id]) => typeof id === 'string' && id).map(([o, id]) => [id, o])),
  resolveMenu: () => [],
}

const HOST_FILE = process.env.AURABOT_PET_HOST || path.join(__dirname, '..', 'host.json')
const POLL_WAIT_MS = 25_000
const FETCH_TIMEOUT_MS = 40_000

if (!app.requestSingleInstanceLock()) app.quit() // 单实例锁

let win = null
let tray = null
let cursor = null      // 事件游标（null = 首次连接只取水位）
let bootId = ''
let focusOn = false
let clientId = 'pet-' + Math.random().toString(16).slice(2, 10)
let pack = null        // 当前形象包视图（/config 的 pack 字段）
let apiBase = null     // { baseUrl, api, token }

function readHost() {
  try {
    const h = JSON.parse(fs.readFileSync(HOST_FILE, 'utf8'))
    // baseUrl 接受任意合法 http(s) URL（2026-11-02 远端直连）：同机是 http://127.0.0.1:<port>，
    // 服务器部署是 https://bot.example.com 这类；解析失败（含 baseUrl=null 的自举等待期）返回 null 继续等。
    const u = new URL(String(h.baseUrl || ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!/^[a-f0-9]{32,80}$/.test(String(h.token || ''))) return null
    if (!/^\/.+/.test(String(h.api || ''))) h.api = '/aurabot/api/ext/pet'
    // 明文风险提示：http 且非回环（跨机明文）只在控制台警告一次，不阻断——用户可能在内网里就是这么用
    if (u.protocol === 'http:' && !isLoopbackHostname(u.hostname) && !readHost.plainWarned) {
      readHost.plainWarned = true
      console.warn(`[pet] 警告：桌宠正通过明文 http 连接 ${u.hostname}（非本机回环）。令牌与气泡内容都是明文传输，跨公网请改用 https。`)
    }
    return { baseUrl: String(h.baseUrl).replace(/\/+$/, ''), token: h.token, api: h.api }
  } catch { return null }
}
/** 回环主机名判定（客户端侧）：127.x / localhost / ::1。 */
function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(\.\d+){3}$/.test(h)
}

// ---------- 桌宠服务端访问 ----------
async function apiGet(pathname, query) {
  const host = readHost()
  if (!host) return null
  const url = `${host.baseUrl}${host.api}${pathname}${query ? '?' + new URLSearchParams(query) : ''}`
  const res = await fetch(url, { headers: { 'x-pet-token': host.token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}
/** 需要看失败响应体的 GET（1.0.14，/balance 用）：服务端降级回 **HTTP 502 + {ok:false,message}**，
 *  apiGet 会把 4xx/5xx 直接抛掉、中文文案就丢了——这里不管状态码都把 body 读回来。 */
async function apiGetAny(pathname) {
  const host = readHost()
  if (!host) return null
  const url = `${host.baseUrl}${host.api}${pathname}`
  try {
    const res = await fetch(url, { headers: { 'x-pet-token': host.token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    let data = null
    try { data = await res.json() } catch { data = null }
    if (data && typeof data === 'object') return data
    return res.ok ? data : null
  } catch { return null }
}
function apiPost(pathname, body) {
  const host = readHost()
  if (!host) return
  fetch(`${host.baseUrl}${host.api}${pathname}`, {
    method: 'POST',
    headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).catch(() => {})
}
/** 需要看响应的 POST（图标动作 /behavior/icon/act 用）：失败/非 JSON 一律返回 null，不抛。
 *  注意：服务端拒绝时回 **HTTP 400 + 同一份 JSON body**（{ok:false, reason:'icon-mischief-disabled'}），
 *  所以 4xx 也要把 body 读回来——否则安全闸的中文原因全丢，面板只能显示一句「被拒绝」。 */
async function apiPostAwait(pathname, body) {
  const host = readHost()
  if (!host) return null
  try {
    const res = await fetch(`${host.baseUrl}${host.api}${pathname}`, {
      method: 'POST',
      headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    let data = null
    try { data = await res.json() } catch { data = null }
    if (data && typeof data === 'object') return data
    return res.ok ? data : null
  } catch { return null }
}
/** 素材地址：GET /asset/<包>/<文件>?token=（<video> 标签带不了自定义头，token 走查询参数）。 */
function assetUrl(packName, file) {
  const host = readHost()
  if (!host) return ''
  return `${host.baseUrl}${host.api}/asset/${encodeURIComponent(packName)}/${encodeURIComponent(file)}?token=${host.token}`
}
/** 把当前形象包推给渲染页：素材地址表 + 池 + 权重 + 物理参数。 */
function pushPackToRenderer() {
  if (!win || win.isDestroyed()) return
  const view = pack && pack.name ? pack : null
  let anims = {}
  if (view) {
    // 关键：右键「动作」菜单能列出的动画远多于三个池（default 包 106 段里只有 26 段在池里）。
    // 地址表只按池建 → 菜单里另外 80 段点下去查不到 URL，渲染页静默 return false，
    // 桌宠就"一直在播自己的动画"。所以这里按「池 ∪ 包目录里的全部 webm」建表。
    const names = metaApi.knownAnims(view.animations, loadPackMeta().files)
    anims = metaApi.animUrlMap(names, (n) => assetUrl(view.name, `${n}.webm`))
  }
  const js = `window.__setPack && window.__setPack(${JSON.stringify({
    anims,
    pools: view ? view.animations : { idle: [], speak: [], click: [] },
    weights: view ? view.weights : {},
    events: view ? view.events : {},
    workStatus: view ? (view.workStatus || {}) : {}, // 干活状态 → 动画（服务端按命名约定/包配置解析好）
    physics: view ? view.physics : null,
  })})`
  win.webContents.executeJavaScript(js).catch(() => {})
}
/** 把动画节奏倍率推给渲染页（1.0.14）：渲染页 scheduleIdle 的间隔 ÷ 它（>1 更活泼）。
 *  独立于 pushPackToRenderer：包没变、只改节奏时也能即时生效（8 秒轮询刷新路径）。 */
function pushAnimRate() {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`window.__setAnimRate && window.__setAnimRate(${JSON.stringify(animRate)})`).catch(() => {})
}
let lastWorkKey = ''
// 人物大小倍率（服务端 /config 的 scale，0.5~2.0）：整窗等比缩放 = setSize + setZoomFactor，
// 布局（舞台/气泡/字体）随 zoom 一起缩，物理身体盒由 bodyBox 按窗口宽反推，天然对上。
const BASE_W = 280, BASE_H = 430 // createWindow 的原始窗口尺寸（缩放的基准；BASE_H 只是「气泡全开」的上限）
let curScale = 1
// 当前「贴合内容」所需的基础高度（缩放前 px，由渲染页按气泡是否显示上报，见 pet:fit）。
// applyScale 必须乘它、而不是 BASE_H：否则 /config 的 scale 一到达就把窗口按 430 重设，
// 刚缩掉的上方空白又被加回来（实测过：窗口先 290 后跳回 473）。
const REST_H = 264 // 16(底距)+240(舞台)+8(顶距)
let fitBaseH = REST_H
// 松手后落地开关（服务端 /config 的 releaseLand）：开 = 按甩出速度抛出去并落回地面（原行为）；
// 关 = 拖到哪松手就停在哪（不抛也不落，连「温柔放下」的原地掉落也一并停掉）。
// 拦截点放主进程 pet:throw 一处：渲染页的甩抛（pet:throw）和原地掉落（throwWith(0,0)）都走这条通道。
let releaseLand = true
// ---------- /config 参数化契约（服务端 /config 下发，8 秒轮询即时生效）----------
let animRate = 1          // 动画节奏倍率 0.5~2（缺省 1）：渲染端挤压/idle 节拍按它缩放
let balanceEnabled = true // 右键「查看余额」显隐（缺省 true；菜单没有这一项时其他项照常可点）
let cfgPhysics = null     // /config 的 physics.{gravity,restitution}（缺省 null = 只用默认/包物理）
let clickChase = false    // 点击扑鼠标独立闸（默认关；=== true 口径，服务端已收口）
let teaseChase = false    // 晃鼠标勾引追独立闸（默认关；=== true 口径，服务端已收口）
/** 生效物理参数：默认值 ← pack.physics ← /config.physics 逐层覆盖（后者优先）。
 *  甩抛循环与松手初速估算统一走这里，别再各自拼一份（口径不一致是老 bug 温床）。 */
function effectivePhysics() {
  return { ...physics.DEFAULT_PHYSICS, ...(pack && pack.physics ? pack.physics : {}), ...(cfgPhysics || {}) }
}
/** 把 animRate 推给渲染页（window.__setAnimRate）。低频路径：只在值变化时调。 */
function pushAnimRate() {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`window.__setAnimRate && window.__setAnimRate(${JSON.stringify(animRate)})`).catch(() => {})
}
function applyScale(s) {
  if (!win || win.isDestroyed()) return
  const v = Math.min(2, Math.max(0.5, Number(s) || 1))
  if (Math.abs(v - curScale) < 0.01) return
  curScale = v
  try {
    win.setResizable(true) // 创建时是 resizable:false，编程改尺寸前临时放开
    setSizeDip(Math.round(BASE_W * v), Math.round(fitBaseH * v)) // 高度跟当前贴合值走，别按 430 撑回原样
    win.setResizable(false)
    win.webContents.setZoomFactor(v)
  } catch {}
}
async function refreshConfig() {
  try {
    const cfg = await apiGet('/config')
    if (cfg && cfg.ok) {
      const changed = JSON.stringify(pack) !== JSON.stringify(cfg.pack || null)
      pack = cfg.pack || null
      focusOn = cfg.focus === true
      applyScale(cfg.scale)
      releaseLand = cfg.releaseLand !== false
      // 参数化契约消费（坏值/缺字段一律回落默认，参考 releaseLand/petScale 的写法口径）：
      const ph = cfg.physics && typeof cfg.physics === 'object' ? cfg.physics : {}
      const g = Number(ph.gravity)
      const r = Number(ph.restitution)
      cfgPhysics = {
        ...(Number.isFinite(g) ? { gravity: Math.max(0, Math.min(10000, g)) } : {}),
        ...(Number.isFinite(r) ? { restitution: Math.max(0, Math.min(1, r)) } : {}),
      }
      if (!cfgPhysics.gravity && cfgPhysics.restitution == null) cfgPhysics = null // 一个有效字段都没有 = 服务端没实现，整体回落
      const ar = Number(cfg.animRate)
      const newRate = Number.isFinite(ar) && ar > 0 ? Math.min(2, Math.max(0.5, ar)) : 1
      if (Math.abs(newRate - animRate) > 1e-6) { animRate = newRate; pushAnimRate() } // 节奏倍率推给渲染页（8 秒轮询内生效，不用重启桌宠）
      balanceEnabled = cfg.balanceEnabled !== false
      clickChase = cfg.clickChase === true
      teaseChase = cfg.teaseChase === true
      // 行为层配置：总开关 + 鼠标闲置分钟数 + 禁用清单，本地缓存，读不到用默认
      const b = cfg.behavior || {}
      behaviorCfg = {
        enabled: b.enabled !== false,
        idleCursorMinutes: Math.max(1, Number(b.idleCursorMinutes) || behaviorApi.THRESHOLDS.IDLE_CURSOR_MINUTES),
        // 2026-11-01：禁用清单（面板「AI 动作表」开关）。反应层也要尊重它，
        // 不然关掉追鼠标/叼鼠标后点她、晃鼠标、鼠标闲置照样抓（用户实测的 bug）。
        disabledActions: Array.isArray(b.disabledActions) ? b.disabledActions.map(String) : [],
        configLoaded: true, // 首次配置已到，反应层可以按禁用清单跑了
      }
      // 对话框配置（快捷键注册必须放进配置刷新路径，不能只在启动做一次——面板改键后要能跟上来）
      const c = cfg.chat || {}
      chatCfg = {
        enabled: c.enabled === true,
        hotkey: String(c.hotkey || '').trim(),
        closeKeyword: String(c.closeKeyword || '').trim(),
        blurHide: c.blurHide !== false,
      }
      applyChatHotkey()
      if (changed || !win.__packPushed) { win.__packPushed = true; pushPackToRenderer() }
      // 干活状态：/config 也带当前档位（客户端重启/漏事件时靠它对一次，不弹提示、不再提醒）
      const key = `${(cfg.work && cfg.work.state) || ''}|${(cfg.work && cfg.work.task) || ''}`
      if (key !== lastWorkKey) {
        lastWorkKey = key
        applyWork({ state: (cfg.work && cfg.work.state) || '', task: (cfg.work && cfg.work.task) || '', text: '', notify: false })
      }
    }
  } catch {}
}

// ---------- 气泡 / 动画点播（P2） ----------
const BUBBLE_TAG = { test: '碎碎念', whisper: '碎碎念' }
async function showBubble(text, mood, modality, anim, playbackId, purpose, tagOverride, emotionProfile, big) {
  if (!win) return
  const secs = Math.min(30, Math.max(6.5, 4.5 + String(text).length * 0.11))
  // 标签：菜单「碎碎念」/ 定时碎碎念 / 干活结束各有各的标签，别都标成「主动来找你」
  const tag = tagOverride || BUBBLE_TAG[purpose] || ''
  const emo = emotionProfile && typeof emotionProfile === 'object' ? { valence: emotionProfile.valence ?? 0, arousal: emotionProfile.arousal ?? 0.4 } : null
  const js = `window.__bubble && window.__bubble(${JSON.stringify(String(text || ''))}, ${JSON.stringify(String(mood || 'neutral'))}, ${secs}, ${JSON.stringify(String(anim || ''))}, ${JSON.stringify(String(playbackId || ''))}, ${JSON.stringify(tag)}, ${JSON.stringify(emo)}, ${big === true ? 'true' : 'false'})`
  try {
    const played = await win.webContents.executeJavaScript(js)
    // __bubble 返回实际起播的动画与回执号（没有可用素材时 anim 为空 → 不上报）
    if (played && played.playbackId) apiPost('/playback', { playbackId: played.playbackId, anim: played.anim || '', status: 'played' })
  } catch {}
}

// ---------- 干活状态（DSH 会话事件 → 动画 + 结束提醒） ----------
const WORK_TAG = { success: '干完啦', error: '出错了', waiting: '等你确认', thinking: '思考中', working: '干活中', result: '出结果了' }
let lastNotifyAt = 0
/** 系统通知（Windows 需要 AppUserModelID 才会显示；失败静默，不影响气泡）。 */
function notifyEnd(title, body) {
  try {
    const { Notification } = require('electron')
    if (!Notification || !Notification.isSupported()) return
    if (Date.now() - lastNotifyAt < 4000) return // 多会话同时收尾别连弹
    lastNotifyAt = Date.now()
    new Notification({ title: String(title || '大肥鱼'), body: String(body || ''), silent: false }).show()
  } catch {}
}
function applyWork(e) {
  const state = String(e.state || '')
  const text = String(e.text || '')
  const task = String(e.task || '')
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript(`window.__setWork && window.__setWork(${JSON.stringify(state)}, ${JSON.stringify(task)})`).catch(() => {})
  }
  if (!text) return
  // 结束提醒：气泡（workBubble）+ 系统通知（workNotify），两个开关都来自面板设置（服务端判定后下发）
  if (e.bubble !== false) showBubble(text, '', 'text', '', '', 'work', WORK_TAG[state] || '干活状态')
  if (e.notify !== false) notifyEnd(state === 'error' ? '出错了…' : '忙完啦', text)
}
function hideBubble() {
  if (!win) return
  win.webContents.executeJavaScript('window.__hideBubble && window.__hideBubble()').catch(() => {})
}

// ---------- 长轮询主循环 ----------
let running = true
let hadError = false // 上一轮轮询失败过：重连成功后强制重推素材表（见下）
async function pollLoop() {
  let attempt = 0
  while (running) {
    const host = readHost()
    if (!host) { await sleep(5000); continue } // host.json 还没就绪（端口未知）：等插件第一次被请求
    try {
      const url = `${host.baseUrl}${host.api}/events?${new URLSearchParams({ ...(cursor != null ? { since: String(cursor) } : {}), wait: String(POLL_WAIT_MS / 1000), client: clientId })}`
      const res = await fetch(url, {
        headers: { 'x-pet-token': host.token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      attempt = 0
      const firstBoot = bootId && data.bootId !== bootId
      // 重连成功（中途断过，或插件换 bootId 重启过）：强制重推一次素材表。
      // 修「变鲸鱼后长时间不恢复」：DSH 重启窗口期渲染页可能还拿着旧端口的素材 URL，
      // 不重推的话 /config 就算正常也回不来（pack JSON 没变）；重推后渲染页换新地址并清零冷却。
      if (hadError || firstBoot) {
        hadError = false
        if (win && !win.isDestroyed()) win.__packPushed = false
      }
      bootId = data.bootId
      cursor = data.cursor
      if (firstBoot) cursor = null // 插件重启过：这一轮只对齐水位，不消费旧事件，下一轮取增量
      for (const e of data.events || []) {
        if (e.type === 'pack') { pack = null; win.__packPushed = false; refreshConfig(); continue }
        if (e.type === 'work') { applyWork(e); continue }
        if (e.type === 'behavior' && !firstBoot) { handleBehavior(e).catch((err) => console.error('行为动作执行失败：', err && err.stack ? err.stack : err)); continue } // 下发层：行为动作单
        if (e.type === 'proactive' && String(e.text || '').trim() && !firstBoot) {
          await showBubble(e.text, e.mood, e.modality, e.anim, e.playbackId, e.purpose, '', e.emotionProfile)
        } else if (e.type === 'chat' && !firstBoot) {
          // 对话框回复（对话框开着时服务端走这条；messageId 与 POST 响应同源，chat.html 自己去重）
          if (chatWin && !chatWin.isDestroyed()) {
            chatWin.webContents.executeJavaScript(`window.__chatAppend && window.__chatAppend(${JSON.stringify(String(e.text || ''))}, ${JSON.stringify(String(e.messageId || ''))})`).catch(() => {})
          }
        } else if (e.type === 'chatClose' && !firstBoot) {
          closeChatWin() // 关键字关闭（服务端兜底闸下发）
        } else if (e.type === 'focus') {
          focusOn = e.enabled === true
          if (focusOn) hideBubble()
        }
      }
      refreshConfig() // 便宜：跟着轮询节奏对齐包配置与素材路由（新放素材也能被发现）
      await sleep(50)
    } catch {
      hadError = true
      attempt++
      await sleep(Math.min(15_000, 1500 + attempt * 1500)) // 出错退避，并重读 host.json（端口可能漂了）
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 甩抛物理循环（P3：physics.throwStep，参数可被 pack 配置 physics 段覆盖） ----------
// 两个坑（都是「扔出去就卡死」的直接原因）：
//   1) 不能用 setImmediate 递归驱动：每秒会跑几千帧，每帧同步调一次 win.setPosition，
//      主进程/窗口线程被空转调用打满，桌宠看起来就定住了。这里固定 60fps。
//   2) 边界必须用真实身体盒：素材是 640×360（16:9），人物画在中下部透明框里；渲染页会按人物包围盒
//      裁切放大填满 240×240 舞台（见 index.html applyStageCrop），所以「可见身体」仍是窗口底部 240×240，
//      按舞台反推即可。若按 宽×9/16 当身体高，静止点会比屏幕底还低 183px —— 一扔就掉出屏幕外再也不回来。
const THROW_FRAME_MS = 16   // ≈60fps
const THROW_MAX_MS = 10000  // 一次抛掷最多算 10 秒，之后强制落地（兜底，绝不留半空死状态）
const BODY = { left: 20, bottom: 16, width: 240, height: 240 } // 与 index.html 的 #stage 一致（裁切后人物填满舞台）
let thrower = null          // 抛掷循环定时器句柄（非空 = 正在飞）

// ---------- 统一尺寸入口（2026-11-07 E2E 实测补）：运行时自标定，不赌平台语义 ----------
// 实测事实：dsf≠1 时 win.getSize()/setSize() 的单位语义会漂——forced 1.25 下 getSize 返回过物理
// 像素量级（463→2290 的正反馈），fit 链路 h=round(fitBaseH*curScale) 与 setSize 实际吃的单位差一档
// dsf，每 fit 放大 ~1.25 倍，最终把窗口撑爆、身体盒被放大 → 一切钳制算出的边界本身在屏外。
// 解法：sizeK = 「setSize/getSize 实际语义」与「DIP 意图」的比值。1 = 平台就是 DIP；
// ≈scaleFactor = 平台吃物理像素。所有尺寸意图一律按 DIP 表达，经这两个口子换算。
let sizeK = 1
/** 按 DIP 意图设窗高宽：内部乘 sizeK。调用后读回真实尺寸比对，偏差 >2 就重新标定 sizeK
 *  （夹到 [1,4]）——运行时自标定，不赌 getSize 语义（dsf≠1 的 Windows 上实测可能是物理像素）。 */
function setSizeDip(w, h) {
  if (!win || win.isDestroyed()) return
  try {
    win.setResizable(true) // 创建时是 resizable:false，编程改尺寸前临时放开
    win.setSize(Math.round(w * sizeK), Math.round(h * sizeK))
    win.setResizable(false)
    const read = win.getSize()
    if (read && read.length >= 2 && Math.abs(read[0] - Math.round(w * sizeK)) > 2) {
      sizeK = Math.min(4, Math.max(1, read[0] / Math.max(1, w)))
    }
  } catch {}
}
/** 读窗口尺寸并换算回「DIP 意图尺寸」（round 到整数）：所有 getSize 的消费点必须走这里。 */
function winSizeDip() {
  if (!win || win.isDestroyed()) return [BASE_W, fitBaseH]
  const s = win.getSize()
  return [Math.round((s[0] || 0) / sizeK), Math.round((s[1] || 0) / sizeK)]
}
/** 可见身体（#stage）在窗口内的盒子：offsetX/offsetY 是身体左上角相对窗口左上角的偏移。
 *  入参 w/h 必须是 winSizeDip() 的 DIP 意图尺寸。
 *  E2E 实测教训（2026-11-07）：缩放倍率不能再按「窗口宽 / 280」反推——dsf≠1 时窗口宽语义漂移
 *  （可能已是物理像素），反推出来的倍率是错的，身体盒跟着被放大、钳制边界全在屏外。
 *  现在以 /config 下发的 curScale 为唯一权威倍率（0.5~2，面板声明式配置，服务端坏值已回落）。 */
function bodyBox(w, h) {
  const s = Math.min(2, Math.max(0.5, curScale)) // 权威倍率 = /config 的 scale，别再从窗口宽反推
  const bw = Math.round(BODY.width * s)
  const bh = Math.round(BODY.height * s)
  const offX = Math.round(BODY.left * s)
  const offY = Math.round(BODY.bottom * s)
  const width = Math.min(bw, w)
  const height = Math.min(bh, Math.max(32, h - offY))
  return { width, height, offsetX: Math.max(0, Math.min(offX, w - width)), offsetY: Math.max(0, h - offY - height) }
}
function stopThrow() {
  if (thrower) { clearTimeout(thrower); thrower = null }
  stopMover() // 移动与抛掷互斥：停飞顺手也停掉行为移动循环（stopMover 见下方行为层）
}
/** 把窗口拉回工作区（历史 bug 可能已把桌宠扔到屏幕外，启动/显示时兜一下）。 */
// 窗口落位基线 lastMove + 唯一移动入口 setWinPos：
// 去重只在「窗口确实已经在这个位置」时才安全。之前只有 pet:move 更新基线，窗口被抛掷/行为移动
// 挪走后再拖回同一坐标，第一下会被当成重复吞掉（一期审查指出）；所以所有挪窗口的路统一走这里，
// 基线永远跟真实位置一致。返回 false = 窗口没了/参数异常，调用方自己决定收尾。
let lastMove = null
function setWinPos(x, y) {
  if (!win || win.isDestroyed()) return false
  try { win.setPosition(x, y) } catch { return false }
  lastMove = { x: x, y: y }
  return true
}
function clampWindowToArea() {
  if (!win || win.isDestroyed()) return
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  const area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea
  const nx = Math.round(Math.min(Math.max(wx, area.x), area.x + area.width - w))
  const ny = Math.round(Math.min(Math.max(wy, area.y), area.y + area.height - h))
  if (nx !== Math.round(wx) || ny !== Math.round(wy)) setWinPos(nx, ny)
}
/** 所有显示器 bounds 的并集（虚拟桌面）：拖拽允许跨屏走，但窗口绝不能跑出所有屏之外。
 *  （用户反馈「桌宠跑到屏幕外」的直接原因：拖拽通道原来没有任何边界钳制。） */
function virtualDesktopBounds() {
  const ds = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
  const x = Math.min(...ds.map((d) => d.bounds.x))
  const y = Math.min(...ds.map((d) => d.bounds.y))
  const r = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width))
  const b = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height))
  return { x, y, w: r - x, h: b - y }
}
// 逃生网（自愈「跑到屏幕外」，2026-11-07 改口径）：每 30s 查一次，判定对象改成**可见身体矩形**
// （窗口位置 + bodyBox 偏移）而不是整个 280×430 窗口——窗口上沿的透明气泡区越界无害，旧口径会误拉；
// 身体哪怕缺一角（看不见她本人）就必须救回。飞行/拖拽中跳过（两者都有自己的逐帧钳制）。
setInterval(() => {
  if (!win || win.isDestroyed()) return
  if (thrower || drag) return
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  // 尺寸正反馈自愈（2026-11-07 E2E 实测补）：fit 链路在平台语义漂移（sizeK 标定不及时）时可能
  // 一层层把窗口撑爆。期望尺寸 = round(BASE_W*curScale) × round(fitBaseH*curScale)，任一边偏差
  // 超过 max(40, 期望*0.25) 就直接 setSizeDip 拉回——防任何平台语义下把窗口撑爆。
  const expW = Math.round(BASE_W * curScale)
  const expH = Math.round(fitBaseH * curScale)
  const tolW = Math.max(40, expW * 0.25)
  const tolH = Math.max(40, expH * 0.25)
  if (Math.abs(w - expW) > tolW || Math.abs(h - expH) > tolH) { setSizeDip(expW, expH); return } // 尺寸刚拉回，位置下一轮再钳
  const b = bodyBox(w, h)
  const d = virtualDesktopBounds()
  const body = { x: wx + b.offsetX, y: wy + b.offsetY, width: b.width, height: b.height }
  const fixed = physics.clampBodyRect(body, d)
  if (fixed.x !== Math.round(body.x) || fixed.y !== Math.round(body.y)) {
    // 身体夹回多少，窗口就跟着挪多少（身体相对窗口的偏移不变）
    setWinPos(wx + (fixed.x - Math.round(body.x)), wy + (fixed.y - Math.round(body.y)))
  }
}, 30_000)
function startThrow(vx, vy) {
  if (!win || win.isDestroyed()) return
  stopThrow()
  stopMover()     // 甩飞时位置由物理接管：先掐掉行为移动循环
  stopMoveAnim()  // 也别踏步了——被扔出去还在原地踏步很怪
  // 2026-11-07 改绝对 DIP 坐标：st.x/y 现在是窗口左上角的**屏幕绝对值**（旧实现是工作区相对值，
  // 跨屏/窗口挪动时要二次换算，容易漏）。bounds 每帧按当前窗口中心重算工作区并经 throwBounds 的
  // areaX/areaY 入参拿到绝对边界，每步硬钳——「甩出去飞出屏幕」从机制上不可能。
  const [wx, wy] = win.getPosition()
  const [w0, h0] = winSizeDip()
  const d0 = virtualDesktopBounds()
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
  // 起点也先钳回虚拟桌面（历史 bug 已把桌宠扔出屏时，这一甩自动拉回来）
  let st = { x: clamp(wx, d0.x, d0.x + d0.w - w0), y: clamp(wy, d0.y, d0.y + d0.h - h0), vx, vy }
  const ph = effectivePhysics()
  const t0 = Date.now()
  let last = t0
  let lastPos = ''
  let squashAt = 0
  let squashCount = 0
  const finish = () => {
    stopThrow()
    if (win && !win.isDestroyed()) {
      clampWindowToArea() // 收尾兜底：把窗口贴回工作区（粗钳整窗，足够收口）
      applyFitWindow(true) // 飞行期间被跳过的窗高调整也在这里补
      win.webContents.executeJavaScript('window.__onThrowEnd && window.__onThrowEnd()').catch(() => {})
    }
  }
  const stepFrame = () => {
    thrower = null
    if (!win || win.isDestroyed()) return
    const now = Date.now()
    const dt = Math.min(0.05, Math.max((now - last) / 1000, 1e-4)) // 巨帧/同毫秒多帧都夹住
    last = now
    // 每帧按**当前窗口中心**重算工作区与身体盒：窗口跨屏/被外部挪动后边界立刻跟上
    const [cx, cy] = win.getPosition()
    const [w, h] = winSizeDip()
    const area = screen.getDisplayNearestPoint({ x: cx + w / 2, y: cy + h / 2 }).workArea
    const body = bodyBox(w, h)
    const bounds = physics.throwBounds({
      W: area.width,
      H: area.height,
      bodyW: body.width,
      bodyH: body.height,
      offsetX: body.offsetX,
      offsetY: body.offsetY,
      areaX: area.x, // 绝对边界（新入参，向后兼容缺省 0）
      areaY: area.y,
      sideAllow: Math.round(body.width * 0.08), // 身体左右各内缩一点才贴边反弹
    })
    let impact = 0
    const n = physics.throwSubsteps(st.vx, st.vy, dt)
    for (let i = 0; i < n; i++) {
      st = physics.throwStep(st, dt / n, bounds, ph)
      // 硬保险（任务书口径）：throwStep 已按当帧 bounds 反弹；若因跨屏边界突变仍越界，
      // 硬钳回并清该轴速度——宁可少弹一下也绝不飞出屏。正常单屏反弹不受影响（取舍见任务留言）。
      if (st.x < bounds.minX) { st.x = bounds.minX; st.vx = 0 }
      else if (st.x > bounds.maxX) { st.x = bounds.maxX; st.vx = 0 }
      if (st.y < bounds.minY) { st.y = bounds.minY; st.vy = 0 }
      else if (st.y > bounds.maxY) { st.y = bounds.maxY; st.vy = 0 }
      if (st.bounced && st.vy > 0) impact = Math.max(impact, Math.abs(st.vy))
      if (st.atRest) break
    }
    // 超时兜底也用当帧 bounds：直接贴到当帧地面（旧实现按首帧 area，跨屏后会把 y 钉错地方）
    if (now - t0 > THROW_MAX_MS) st = { ...st, y: bounds.maxY, vx: 0, vy: 0, atRest: true }
    const px = Math.round(st.x)
    const py = Math.round(st.y)
    const key = px + ',' + py
    if (key !== lastPos) { // 位置没变就不调原生接口：每秒几百次空搬运同样能把窗口拖死
      lastPos = key
      if (!setWinPos(px, py)) { finish(); return } // 窗口没了/参数异常：立刻收尾，不留半空状态
    }
    // 落地挤压限流：一次抛掷最多挤 2 次、间隔 400ms（原来每帧都发，渲染页会堆几十个 rAF 循环）
    if (impact > 600 && squashCount < 2 && now - squashAt > 400) {
      squashCount++
      squashAt = now
      win.webContents.executeJavaScript(`window.__squash && window.__squash(${Math.round(impact)})`).catch(() => {})
    }
    if (st.atRest) { finish(); return }
    thrower = setTimeout(stepFrame, THROW_FRAME_MS)
  }
  thrower = setTimeout(stepFrame, THROW_FRAME_MS)
}

// ---------- 行为层（执行层 + 反应层）：通用缓动移动 / 原生双路径 / 执行器接线 / 感知循环 ----------
// 通用缓动移动 moveWindowTo：复用 startThrow 的三条教训——
//   60fps 定时器驱动；位置没变不调 setPosition；真实身体盒 + clamp 工作区；与甩抛互斥（先 stopThrow）。
// getTarget：() => {x,y} —— **身体中心**应到达的屏幕点（每帧重算以支持 chase_cursor 追动目标）；null = 中止。
// 速度：匀速（以前是「每帧走剩余距离的 1/4」——屏幕上横跨 1600px 时第一帧就跳 400px，
//   实测就是「瞬移」；而且 target 被直接当窗口左上角用，身体实际落在目标右下半个身位）。
const MOVE_FRAME_MS = 16 // ≈60fps
// 速度（2026-10-30 第二次调慢，用户指定绝对值）：常规 50px/s（原来 900，改到 320 还嫌快）。
// 50px/s 意味着 16ms 一帧只走 0.8px —— 必须走**亚像素累积**（见 moveWindowTo 的 curX/curY），
// 否则每帧 round(0.8)=0，窗口一步都挪不动，表现为「完全卡住」。
const MOVE_SPEED_PX_S = 50         // 默认速度 = 散步（只有 wander 用它，其余动作由 behavior.js 传 150）
// 注意：真正跑动的速度都在 behavior.js 的 THRESHOLDS：RUN 150 / WANDER 50 / 叼鼠标 400·250。
const MOVE_MAX_MS = 90_000         // 单次移动兜底：50px/s 走满 3840 宽屏 ≈77s，留余量
let mover = null // 行为移动循环定时器句柄（非空 = 正在移动）
function stopMover() {
  if (mover) { clearTimeout(mover); mover = null }
}
// 跑动动画：移动期间循环播「原地漂浮踏步」，停下/被甩飞时收。渲染页里做循环（见 index.html）。
// 为什么要在主进程解析：渲染页的素材表键是**文件 id**（anim-021），中文名只存在于 manifest；
// 主进程手上有 manifest 与包配置，能按**与右键菜单完全同源**的方式换算。
// 用户口径：「右键 → 动作 → 待机 → 原地漂浮踏步」就是这一段，别自己猜名字。
const MOVE_ANIM_LABEL = '原地漂浮踏步'
const MOVE_ANIM_IDLE_CAT = '待机'
function moveAnimId() {
  try {
    const { manifest, cfg } = loadPackMeta()
    const pools = (pack && pack.animations) || {}
    // ① 最优：走右键菜单同一套 resolveMenu，先定位「待机」分类里的同名项
    const cats = typeof metaApi.resolveMenu === 'function' ? metaApi.resolveMenu(cfg, manifest, pools) : []
    const idleCat = cats.find((c) => c.label === MOVE_ANIM_IDLE_CAT)
    const inIdle = idleCat && idleCat.items.find((it) => it.label === MOVE_ANIM_LABEL)
    if (inIdle) return String(inIdle.id)
    // ② 分类改名了：全菜单按名字找
    for (const c of cats) {
      const hit = (c.items || []).find((it) => it.label === MOVE_ANIM_LABEL)
      if (hit) return String(hit.id)
    }
    // ③ 包配置没有 menu 段（只认三个池）：manifest 原名直查，再按「踏步」模糊兜底
    if (manifest && manifest[MOVE_ANIM_LABEL]) return String(manifest[MOVE_ANIM_LABEL])
    const fuzzy = Object.keys(manifest || {}).find((k) => k.includes('踏步'))
    return fuzzy ? String(manifest[fuzzy]) : ''
  } catch { return '' }
}
function startMoveAnim() {
  if (!win || win.isDestroyed()) return
  const id = moveAnimId()
  if (!id) return // 材料包里没有这段：静默，移动照常（不因为缺素材就报错）
  win.webContents.executeJavaScript(`window.__startMoveAnim && window.__startMoveAnim(${JSON.stringify(id)})`).catch(() => {})
}
function stopMoveAnim() {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript('window.__stopMoveAnim && window.__stopMoveAnim()').catch(() => {})
}
function bodyRect() {
  if (!win || win.isDestroyed()) return null
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  const b = bodyBox(w, h)
  return { x: wx + b.offsetX, y: wy + b.offsetY, width: b.width, height: b.height }
}
/** 匀速步进：纯函数在 behavior.js（可单测）；缺 behavior.js 时退化成「直接到位」
 *  （那种情况下行为层本来就整层不可用，移动不会被调用）。 */
function stepToward(from, to, speedPxS, dtMs) {
  if (behaviorApi && typeof behaviorApi.stepToward === 'function') return behaviorApi.stepToward(from, to, speedPxS, dtMs)
  return { x: Number(to.x), y: Number(to.y), dist: Math.hypot(to.x - from.x, to.y - from.y), step: 0 }
}
function moveWindowTo(getTarget, opts) {
  const o = opts || {}
  if (!win || win.isDestroyed()) return Promise.resolve(false)
  stopThrow() // 与甩抛互斥
  if (o.carry) ensureCursorHelper() // 叼鼠标：提前把光标助手叫醒（首次编译要 ~1s，别等第一帧）
  const t0 = Date.now()
  debugIconLog({ kind: 'move', phase: 'start', align: o.align || '', speed: o.speed || 0, stopPx: o.stopPx || 8, maxMs: o.maxMs || 0, t0 })
  return new Promise((resolve) => {
    const maxMs = o.maxMs || MOVE_MAX_MS
    const stopPx = o.stopPx || 8
    const speed = Math.max(10, Number(o.speed) || MOVE_SPEED_PX_S)
    let lastPos = ''
    let lastAt = Date.now()
    let lastDbgAt = 0 // 步级诊断采样（~600ms 一条，够对账又不刷屏）
    // 亚像素累积位置：50px/s 每帧只有 0.8px，直接用 round(整数窗口位置 + 0.8) 会永远回到原处
    // （每帧都从同一个整数起点算 0.8 → 取整 0 → 一步都走不出去）。所以位置用浮点自己攒，
    // 只在真正 setPosition 时取整；一旦发现真实窗口位置与我们的浮点差 > 2px（用户拖动/甩抛），
    // 就以真实位置为准重新对齐，不跟外部输入抢窗口。
    let curX = null
    let curY = null
    let animOn = false // 只在真的开始位移后才起跑动动画（原地不动不该踏步）
    const done = (ok) => {
      stopMover()
      debugIconLog({ kind: 'move', phase: 'done', ok, elapsed: Date.now() - t0 })
      if (animOn) { animOn = false; stopMoveAnim() }
      if (o.carry) releaseCursorClip() // 松口：无论怎么结束，都必须放开鼠标裁剪区
      resolve(ok)
    }
    const step = () => {
      mover = null
      if (!win || win.isDestroyed()) { debugIconLog({ kind: 'move', phase: 'abort', why: 'win-gone' }); return done(false) }
      const target = getTarget()
      if (!target) { debugIconLog({ kind: 'move', phase: 'abort', why: 'target-null' }); return done(false) }
      const now = Date.now()
      const [w, h] = winSizeDip()
      const [x, y] = win.getPosition()
      const b = bodyBox(w, h)
      const area = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 }).workArea
      // target 是「身体中心」的落点 → 换成窗口左上角该在的位置（位移等价：身体中心与窗口左上角
      // 的相对偏移不变，所以直接按差值推），再夹进工作区（窗口尺寸感知）。
      let gx, gy
      if (o.align === 'body') {
        // 2026-10-30（用户实测）：图标 / 窗口贴着屏幕上沿时，按窗口夹会把人物按到下面去，
        // 表现为「窗口左上角到了图标位置、人物没到」。这里改成把**身体中心**夹进工作区，
        // 允许窗口本身越出屏幕边——以人物到达为准。
        const cx = Math.round(Math.min(Math.max(Number(target.x), area.x), area.x + area.width))
        const cy = Math.round(Math.min(Math.max(Number(target.y), area.y), area.y + area.height))
        gx = Math.round(cx - (b.offsetX + b.width / 2))
        gy = Math.round(cy - (b.offsetY + b.height / 2))
      } else {
        const wantX = x + (Number(target.x) - (x + b.offsetX + b.width / 2))
        const wantY = y + (Number(target.y) - (y + b.offsetY + b.height / 2))
        gx = Math.round(Math.min(Math.max(wantX, area.x), area.x + area.width - w))
        gy = Math.round(Math.min(Math.max(wantY, area.y), area.y + area.height - h))
      }
      const dx = gx - x
      const dy = gy - y
      const dist = Math.hypot(dx, dy)
      if (now - lastDbgAt > 600) {
        lastDbgAt = now
        debugIconLog({ kind: 'move', phase: 'step', x, y, gx, gy, dist: Math.round(dist), stopPx, speed, left: maxMs - (now - t0) })
      }
      if (dist <= stopPx || now - t0 > maxMs) {
        // 收尾：把最后一小步贴上去（仍做一次位置变更检查）
        const key = gx + ',' + gy
        if (key !== lastPos) { lastPos = key; setWinPos(gx, gy) }
        debugIconLog({ kind: 'move', phase: 'snap', x, y, gx, gy, dist: Math.round(dist), timedOut: now - t0 > maxMs })
        // 叼着鼠标走：终点也要把指针按到最终身体中心，免得停在半路
        if (o.carry) pinCursorAtDip(gx + b.offsetX + b.width / 2, gy + b.offsetY + b.height / 2)
        return done(now - t0 <= maxMs)
      }
      if (!animOn) { animOn = true; startMoveAnim() } // 开始走了：循环播「原地漂浮踏步」
      // 匀速 + 时间步进：单帧最多走 speed*dt；dt 夹到 64ms，防系统卡顿后一帧跳一大截
      const dt = Math.min(64, Math.max(1, now - lastAt))
      lastAt = now
      // 与真实窗口位置对齐（差超过 2px 视为被外部移动过：甩抛/用户拖动/多会话抢窗口）
      if (curX === null || curY === null || Math.abs(Math.round(curX) - x) > 2 || Math.abs(Math.round(curY) - y) > 2) {
        curX = x
        curY = y
      }
      const stp = stepToward({ x: curX, y: curY }, { x: gx, y: gy }, speed, dt)
      curX = stp.x
      curY = stp.y
      const nx = Math.round(curX)
      const ny = Math.round(curY)
      const key = nx + ',' + ny
      if (key !== lastPos) { // 位置没变不调原生接口（startThrow 的教训）
        lastPos = key
        if (!setWinPos(nx, ny)) { debugIconLog({ kind: 'move', phase: 'abort', why: 'setpos-throw', msg: 'setPosition 失败' }); return done(false) }
      }
      // 叼着鼠标走（steal_cursor 阶段②）：每帧把指针钉在身体中心并夹住裁剪区，
      // 于是「桌宠和鼠标一起动」且用户中途拽不出去（不会出现闪回）。
      if (o.carry) pinCursorAtDip(nx + b.offsetX + b.width / 2, ny + b.offsetY + b.height / 2)
      mover = setTimeout(step, MOVE_FRAME_MS)
    }
    mover = setTimeout(step, MOVE_FRAME_MS)
  })
}
// ---------- 原生 SetCursorPos 双路径（鼠标动作）：先试 koffi（动态 require，顶层不 import），
// 没装 koffi 就回落 PowerShell Add-Type。Electron screen 是 DIP，物理像素 = DIP × scaleFactor。 ----------
let koffiUser32 = null
function loadKoffi() {
  if (koffiUser32 !== null) return koffiUser32
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
    koffiUser32 = (x, y) => Boolean(SetCursorPos(x, y))
  } catch { koffiUser32 = false } // false = koffi 不可用，走 PowerShell
  return koffiUser32
}
/** DIP → 物理像素：多显示器用所在 display 的 bounds/scaleFactor 换算（bounds 与物理原点对齐）。 */
function dipToPhysical(x, y) {
  const d = screen.getDisplayNearestPoint({ x, y })
  const sf = (d && d.scaleFactor) || 1
  const bx = (d && d.bounds ? d.bounds.x : 0)
  const by = (d && d.bounds ? d.bounds.y : 0)
  return { x: Math.round((x - bx) * sf + bx * sf), y: Math.round((y - by) * sf + by * sf) }
}
function nativeMove(x, y) {
  const p = dipToPhysical(x, y)
  const viaKoffi = loadKoffi()
  if (viaKoffi) {
    try { return Promise.resolve(Boolean(viaKoffi(p.x, p.y))) } catch {}
  }
  // PowerShell 兜底：EncodedCommand（utf16le→base64），与 openPanel 同款，失败静默
  const ps = [
    "Add-Type -Namespace W -Name C -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);'",
    `[W.C]::SetCursorPos(${p.x}, ${p.y}) | Out-Null`,
    'exit 0',
  ].join('; ')
  return new Promise((resolve) => {
    try {
      const b64 = Buffer.from(ps, 'utf16le').toString('base64')
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64], (err) => resolve(!err))
    } catch { resolve(false) }
  })
}
// ---------- 鼠标锁定（SetCursorPos + ClipCursor）：用户物理上挪不出去 ----------
// 为什么不能只靠循环 SetCursorPos（2026-10-30 用户实测的「通病」）：用户手一直在动，我们几十毫秒才拉回
// 一次，中间指针会先被拖出去、再被拽回来——看起来就是「移出去又闪现回原位」。ClipCursor 让系统层面
// 禁止指针离开矩形，才是真的按住 / 叼住。
// 安全：ClipCursor 是系统级共享状态，任何退出路径都必须释放 —— 统一走 releaseCursorClip()，
// 配合「app 退出钩子」，绝不把用户鼠标永久锁死在一个点上（助手进程自己退出也会自动解开）。
const CLIP_HALF_PX = 2 // 裁剪区半宽：4×4 的方框，挪不出去也不至于抖得难受
let koffiClipApi = null // 缓存：{ClipCursor} / false=不可用（顶层不 require）
function loadKoffiClip() {
  if (koffiClipApi !== null) return koffiClipApi
  try {
    const koffi = require('koffi')
    const u = koffi.load('user32.dll')
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const ClipCursor = u.func('bool __stdcall ClipCursor(RECT *rect)')
    koffiClipApi = { ClipCursor }
  } catch { koffiClipApi = false }
  return koffiClipApi
}
/** koffi 路径：把鼠标夹在**物理像素** (px,py) 附近；null 释放。失败静默 false。 */
function clipCursorTo(px, py) {
  const api = loadKoffiClip()
  if (!api) return false
  try {
    if (px == null || py == null) return Boolean(api.ClipCursor(null))
    return Boolean(api.ClipCursor({
      left: Math.round(px) - CLIP_HALF_PX,
      top: Math.round(py) - CLIP_HALF_PX,
      right: Math.round(px) + CLIP_HALF_PX,
      bottom: Math.round(py) + CLIP_HALF_PX,
    }))
  } catch { return false }
}

// ---------- 常驻光标助手（PowerShell + stdin 命令流）：没装 koffi 时的低延迟通道 ----------
// 为什么必须有它：单次 spawn PowerShell 实测 ≈390ms，逐帧调用根本不可能——用户把鼠标拖出去，
// 我们 390ms 才拉回一次，看起来就是「移出去又闪回」。常驻进程只在启动时 Add-Type 编译一次，
// 之后一行一条命令（个位数毫秒），才能一边走一边把指针钉在嘴边。
// 同一个进程里还挂了 DeskIcons 类，图标拖拽也走它（省掉每次 0.6s 的冷启动）。
const CURSOR_CS_SOURCE = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class Cur {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll", EntryPoint="ClipCursor")] static extern bool ClipRect(ref RECT r);',
  '  [DllImport("user32.dll", EntryPoint="ClipCursor")] static extern bool ClipPtr(IntPtr p);',
  '  public static void Pin(int x, int y, int half) {',
  '    RECT r; r.L = x - half; r.T = y - half; r.R = x + half; r.B = y + half;',
  '    ClipRect(ref r);',
  '    SetCursorPos(x, y);',
  '  }',
  '  public static void Free() { ClipPtr(IntPtr.Zero); }',
  '}',
].join('\n')
let cursorHelper = null // { proc, ready: Promise<Process|null> }
let helperIdleTimer = null
function helperScript() {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    "Add-Type -Language CSharp @'",
    CURSOR_CS_SOURCE,
    "'@",
    "Add-Type -Language CSharp @'",
    ICON_CS_SOURCE,
    "'@",
    '[Console]::Out.WriteLine("READY")',
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($null -eq $line) { break }',
    '  if ($line -eq "QUIT") { break }',
    '  try { Invoke-Expression $line | Out-Null } catch { }',
    '}',
  ].join('\n')
}
/** 启动常驻助手（首次约 0.6~1s：两次 Add-Type 编译）。失败返回 null，调用方退回慢路径。 */
function startCursorHelper() {
  return new Promise((resolve) => {
    let proc = null
    try {
      const b64 = Buffer.from(helperScript(), 'utf16le').toString('base64')
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch { return resolve(null) }
    let buf = ''
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) { try { proc.kill() } catch {} ; cursorHelper = null }
      resolve(ok ? proc : null)
    }
    const timer = setTimeout(() => finish(false), 8_000)
    proc.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('READY')) finish(true) })
    proc.on('error', () => finish(false))
    proc.on('exit', () => { if (cursorHelper && cursorHelper.proc === proc) cursorHelper = null; finish(false) })
    proc.stdin.on('error', () => {}) // 助手被杀后写管道会 EPIPE：吞掉，别炸主进程
  })
}
/** 拿到（必要时启动）助手进程；并发调用共用同一次启动。
 *  启动失败记 5 分钟内不再重试（避免每帧都去 spawn 一个注定失败的 PowerShell）。 */
let helperStarting = null
let helperRetryAfter = 0
function ensureCursorHelper() {
  if (cursorHelper && cursorHelper.proc) return Promise.resolve(cursorHelper.proc)
  if (cursorHelper === false) {
    if (Date.now() < helperRetryAfter) return Promise.resolve(null)
    cursorHelper = null
  }
  if (helperStarting) return helperStarting
  helperStarting = startCursorHelper().then((proc) => {
    helperStarting = null
    if (!proc) { cursorHelper = false; helperRetryAfter = Date.now() + 300_000; return null }
    cursorHelper = { proc }
    noteHelperIdle() // 起来的助手没活干就自己退，别长期占一个 PowerShell
    return proc
  })
  return helperStarting
}
/** 给助手写一行命令（fire-and-forget）。没有助手就返回 false。 */
function helperWrite(cmd) {
  const proc = cursorHelper && cursorHelper.proc
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false
  try { proc.stdin.write(cmd + '\n'); noteHelperIdle(); return true } catch { return false }
}
/** 助手空闲 60s 自动退（不长期占一个 PowerShell 进程）。 */
function noteHelperIdle() {
  clearTimeout(helperIdleTimer)
  helperIdleTimer = setTimeout(() => stopCursorHelper(), 60_000)
  if (helperIdleTimer.unref) helperIdleTimer.unref()
}
function stopCursorHelper() {
  clearTimeout(helperIdleTimer)
  const proc = cursorHelper && cursorHelper.proc
  cursorHelper = null
  if (!proc) return
  // 先松手再退：助手进程自己死掉不一定解开 ClipCursor（系统级共享状态），必须显式 Free 一次
  try { proc.stdin.write('[Cur]::Free()\n') } catch {}
  try { proc.stdin.write('QUIT\n') } catch {}
  setTimeout(() => { try { proc.kill() } catch {} }, 300)
}
/** 释放裁剪区：koffi / 助手两条路都放一遍。幂等，随时可调（finally / 退出钩子）。 */
function releaseCursorClip() {
  clipCursorTo(null, null)
  helperWrite('[Cur]::Free()')
}
/** 把指针钉在 DIP (x,y)：ClipCursor 夹住 + SetCursorPos 回中。返回是否走了「夹住」路径。 */
function pinCursorAtDip(x, y) {
  const p = dipToPhysical(x, y)
  const cmd = `[Cur]::Pin(${Math.round(p.x)},${Math.round(p.y)},${CLIP_HALF_PX})`
  const viaKoffi = loadKoffi()
  if (viaKoffi) {
    const clipped = clipCursorTo(p.x, p.y)
    try { viaKoffi(p.x, p.y) } catch {}
    return clipped
  }
  if (helperWrite(cmd)) return true
  ensureCursorHelper().then((proc) => { // 冷启动：这一帧赶不上，下一帧就能用上
    if (proc) helperWrite(cmd)
  })
  return false
}
/** 按住鼠标（追到后 5 秒）：夹住 + 每 40ms 回中，用户拖不出去、也不会闪回。到点必释放。
 *  通道优先级：koffi（最顺）→ 常驻助手 → 都没有就 350ms 一次的慢速 SetCursorPos（旧行为）。 */
function pinCursor(x, y, ms) {
  const total = Math.max(0, Math.min(30_000, Number(ms) || 0))
  if (!total || !Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(false)
  const p = dipToPhysical(x, y)
  const viaKoffi = loadKoffi()
  return ensureCursorHelper().then(() => new Promise((resolve) => {
    const t0 = Date.now()
    const useHelper = Boolean(cursorHelper && cursorHelper.proc)
    let timer = null
    let legacyBusy = false
    const done = () => {
      clearTimeout(timer)
      releaseCursorClip()
      resolve(true)
    }
    const tick = () => {
      if (Date.now() - t0 >= total) return done()
      if (viaKoffi) {
        clipCursorTo(p.x, p.y)
        try { viaKoffi(p.x, p.y) } catch {}
        timer = setTimeout(tick, 40)
      } else if (useHelper) {
        helperWrite(`[Cur]::Pin(${Math.round(p.x)},${Math.round(p.y)},${CLIP_HALF_PX})`)
        timer = setTimeout(tick, 40)
      } else if (!legacyBusy) { // 慢路径：一次 spawn ≈390ms，只能低频拉回（能被拖出去再拽回）
        legacyBusy = true
        nativeMove(x, y).then(() => { legacyBusy = false })
        timer = setTimeout(tick, 350)
      } else {
        timer = setTimeout(tick, 60)
      }
    }
    tick()
  }))
}
// ---------- 素材按候选名点播（叼/得逞这类动作动画）：包文件名里模糊找，找不到静默 false ----------
function playAnimByNames(cands) {
  const files = loadPackMeta().files || []
  const strip = (f) => String(f).replace(/\.webm$/i, '')
  for (const c of cands || []) {
    const hit = files.find((f) => strip(f) === c) || files.find((f) => strip(f).includes(c))
    if (hit && playAnimById(strip(hit))) return Promise.resolve(true)
  }
  return Promise.resolve(false)
}
// ---------- 桌面图标定位（只读，绝不写桌面）三级回退：
//   ① koffi：FindWindow('Progman')→FindWindowEx('SHELLDLL_DefView')→FindWindowEx('SysListView32')，
//      再用 SendMessageTimeout 发 LVM_GETITEMCOUNT / LVM_GETITEMPOSITION / LVM_GETITEMTEXTW 取名字与坐标。
//      **跨进程必须借目标进程内存**：LVM_* 都是 WM_USER 以上的消息，系统不做参数编组，
//      传本地缓冲区只会写到 explorer 自己地址空间里的同号地址（拿回来是垃圾/空）。
//      所以 OpenProcess → VirtualAllocEx 三块远端缓冲 → WriteProcessMemory 结构 → SendMessageTimeout
//      → ReadProcessMemory 读回。本机实测 29/29 图标、≈10ms。
//   ② PowerShell：同一套 Win32 算法写成 C# P/Invoke，经 EncodedCommand 跑一次（≈0.6s，含 Add-Type 编译）。
//      ※ 早先的 UIAutomation 版在本机直接找不到目标：Win11 把 SHELLDLL_DefView 挂在 **WorkerW** 下，
//        Progman 直属没有 DefView —— 两级都必须带 WorkerW 兜底循环。
//   ③ 都不行 → null（behavior.js 收到 null 直接 refused，不执行图标动作）
// 坐标：读上来的是物理像素，换算回 DIP 再给 moveWindowTo 用。
// 名字：ListView 给的是**显示名**（`Trae CN.lnk` → `Trae CN`，扩展名被 Explorer 隐藏），
//       所以后面 stat 补 isDir 时要按「原名 / 原名+.lnk / 原名+.url」三种都试一遍。 ----------
const LVM_GETITEMCOUNT = 0x1004
const LVM_GETITEMPOSITION = 0x1010
const LVM_GETITEMTEXTW = 0x1073 // = LVM_FIRST(0x1000) + 115。注意不是 0x1153（那是错的，读到空名字）
const LVM_SETITEMPOSITION = 0x100F // 真挪图标：lParam = MAKELPARAM(x, y)，客户区物理像素
const LVIF_TEXT = 1
const SMTO_ABORTIFHUNG = 0x0002
const ICON_MSG_TIMEOUT_MS = 1500 // 单条消息上限：explorer 卡死也不拖住主进程
const PROC_VM_ACCESS = 0x0008 | 0x0010 | 0x0020 | 0x0400 // VM_OPERATION|VM_READ|VM_WRITE|QUERY_INFORMATION
const MEM_COMMIT_RESERVE = 0x1000 | 0x2000
const MEM_RELEASE = 0x8000
const PAGE_READWRITE = 0x04
let koffiDesktopEnum = null // 缓存：函数 / false=koffi 不可用（顶层不 require，动态加载失败就回落 ②）
function loadKoffiDesktopEnum() {
  if (koffiDesktopEnum !== null) return koffiDesktopEnum
  try {
    const koffi = require('koffi')
    const u = koffi.load('user32.dll')
    const k = koffi.load('kernel32.dll')
    const FindWindowW = u.func('void * __stdcall FindWindowW(str16 cls, str16 title)')
    const FindWindowExW = u.func('void * __stdcall FindWindowExW(void *parent, void *after, str16 cls, str16 title)')
    const SendMessageTimeoutW = u.func('intptr __stdcall SendMessageTimeoutW(void *hwnd, uint32_t msg, uintptr_t wp, intptr_t lp, uint32_t flags, uint32_t timeout, _Out_ intptr_t *result)')
    const GetWindowThreadProcessId = u.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
    const OpenProcess = k.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
    const VirtualAllocEx = k.func('void * __stdcall VirtualAllocEx(void *proc, void *addr, size_t size, uint32_t type, uint32_t protect)')
    const VirtualFreeEx = k.func('bool __stdcall VirtualFreeEx(void *proc, void *addr, size_t size, uint32_t type)')
    const WriteProcessMemory = k.func('bool __stdcall WriteProcessMemory(void *proc, void *addr, void *buf, size_t size, _Out_ size_t *written)')
    const ReadProcessMemory = k.func('bool __stdcall ReadProcessMemory(void *proc, void *addr, void *buf, size_t size, _Out_ size_t *read)')
    const CloseHandle = k.func('bool __stdcall CloseHandle(void *handle)')
    const addrOf = (p) => { try { return koffi.address(p) } catch { return null } }
    // 桌面 ListView：Progman 直下；Win11 多桌面/壁纸软件会把 DefView 挂到某个 WorkerW 下，逐个翻
    const findList = () => {
      const progman = FindWindowW('Progman', null)
      if (progman) {
        const dv = FindWindowExW(progman, null, 'SHELLDLL_DefView', null)
        if (dv) { const lv = FindWindowExW(dv, null, 'SysListView32', null); if (lv) return lv }
      }
      let w = null
      for (let i = 0; i < 64; i++) { // 上限兜底：别在异常窗口树上死循环
        w = FindWindowExW(null, w, 'WorkerW', null)
        if (!w) return null
        const dv = FindWindowExW(w, null, 'SHELLDLL_DefView', null)
        if (dv) { const lv = FindWindowExW(dv, null, 'SysListView32', null); if (lv) return lv }
      }
      return null
    }
    koffiDesktopEnum = () => {
      const list = findList()
      if (!list) return null
      const pidOut = [0]
      GetWindowThreadProcessId(list, pidOut)
      const pid = pidOut[0]
      if (!pid) return null
      const res = [0]
      // SendMessageTimeout 的**返回值是成功标志**，真正的 LRESULT（这里的图标数）在 out 参数里
      const sent = SendMessageTimeoutW(list, LVM_GETITEMCOUNT, 0, 0, SMTO_ABORTIFHUNG, ICON_MSG_TIMEOUT_MS, res)
      const count = Number(sent) === 0 ? 0 : Number(res[0])
      if (!(count > 0) || count > 4096) return null
      const proc = OpenProcess(PROC_VM_ACCESS, false, pid)
      if (!proc) return null
      // 三块远端缓冲：POINT(16) / 名字 wchar[260](520) / LVITEMW(96)
      const ptPtr = VirtualAllocEx(proc, null, 16, MEM_COMMIT_RESERVE, PAGE_READWRITE)
      const txPtr = VirtualAllocEx(proc, null, 520, MEM_COMMIT_RESERVE, PAGE_READWRITE)
      const lvPtr = VirtualAllocEx(proc, null, 96, MEM_COMMIT_RESERVE, PAGE_READWRITE)
      // 分配失败要清干净：这些都是 explorer 地址空间里的内存，漏了会一直攒着
      if (!ptPtr || !txPtr || !lvPtr) {
        if (ptPtr) VirtualFreeEx(proc, ptPtr, 0, MEM_RELEASE)
        if (txPtr) VirtualFreeEx(proc, txPtr, 0, MEM_RELEASE)
        if (lvPtr) VirtualFreeEx(proc, lvPtr, 0, MEM_RELEASE)
        CloseHandle(proc)
        return null
      }
      const ptAddr = addrOf(ptPtr); const txAddr = addrOf(txPtr); const lvAddr = addrOf(lvPtr)
      if (ptAddr == null || txAddr == null || lvAddr == null) { CloseHandle(proc); return null }
      const x64 = process.arch === 'x64' || process.arch === 'arm64'
      const out = []
      const written = [0]
      const read = [0]
      const ptBuf = Buffer.alloc(16)
      const txBuf = Buffer.alloc(520)
      const lvBuf = Buffer.alloc(96)
      try {
        for (let i = 0; i < count; i++) {
          // 1) 坐标：POINT 写到远端，读回来
          ptBuf.fill(0)
          WriteProcessMemory(proc, ptPtr, ptBuf, 8, written)
          SendMessageTimeoutW(list, LVM_GETITEMPOSITION, i, ptAddr, SMTO_ABORTIFHUNG, ICON_MSG_TIMEOUT_MS, res)
          ReadProcessMemory(proc, ptPtr, ptBuf, 8, read)
          const px = ptBuf.readInt32LE(0)
          const py = ptBuf.readInt32LE(4)
          // 2) 名字：LVITEMW.pszText 指向远端名字缓冲，LVM_GETITEMTEXTW 拷过去
          let name = ''
          for (let attempt = 0; attempt < 2 && !name; attempt++) { // 偶发空名字重试一次（explorer 忙）
            txBuf.fill(0)
            WriteProcessMemory(proc, txPtr, txBuf, 520, written)
            lvBuf.fill(0)
            lvBuf.writeUInt32LE(LVIF_TEXT, 0)   // mask
            lvBuf.writeInt32LE(i, 4)            // iItem
            lvBuf.writeInt32LE(0, 8)            // iSubItem
            if (x64) lvBuf.writeBigUInt64LE(BigInt(txAddr.toString()), 24) // pszText（x64 偏移 24）
            else lvBuf.writeUInt32LE(Number(txAddr), 24)
            lvBuf.writeInt32LE(260, 32)         // cchTextMax
            WriteProcessMemory(proc, lvPtr, lvBuf, 96, written)
            SendMessageTimeoutW(list, LVM_GETITEMTEXTW, i, lvAddr, SMTO_ABORTIFHUNG, ICON_MSG_TIMEOUT_MS, res)
            ReadProcessMemory(proc, txPtr, txBuf, 520, read)
            // 先整体解码再按字符截断：UTF-16LE 里 ASCII 的高字节就是 0x00，按字节找 NUL 会截在第 1 个字节
            const decoded = txBuf.toString('utf16le')
            const z = decoded.indexOf('\u0000')
            name = (z >= 0 ? decoded.slice(0, z) : decoded).trim()
          }
          if (name) out.push({ name, x: px, y: py, i })
        }
      } finally {
        VirtualFreeEx(proc, ptPtr, 0, MEM_RELEASE)
        VirtualFreeEx(proc, txPtr, 0, MEM_RELEASE)
        VirtualFreeEx(proc, lvPtr, 0, MEM_RELEASE)
        CloseHandle(proc)
      }
      return out
    }
    // 真挪图标（drag_icon，2026-10-30 用户要求）：LVM_SETITEMPOSITION 的 lParam 直接带坐标，
    // 不需要跨进程内存；index 来自上面的枚举（顺序与 LVM_GETITEMPOSITION 一致）。
    // 只在这个 ListView 上挪位置，绝不改文件、绝不调 act 接口。
    koffiDesktopEnum.setPosition = (index, px, py) => {
      const list = findList()
      if (!list || !Number.isFinite(index)) return false
      const res = [0]
      const lp = (((Math.round(py) & 0xFFFF) << 16) | (Math.round(px) & 0xFFFF)) >>> 0 // MAKELPARAM
      const sent = SendMessageTimeoutW(list, LVM_SETITEMPOSITION, index, lp, SMTO_ABORTIFHUNG, ICON_MSG_TIMEOUT_MS, res)
      return Number(sent) !== 0
    }
  } catch { koffiDesktopEnum = false } // 没装 koffi / 加载失败 → 走 ②
  return koffiDesktopEnum
}
/** 物理 → DIP：找物理矩形包含该点的显示器，用它的 scaleFactor 反算（与 dipToPhysical 同一套约定）。 */
function physicalToDip(x, y) {
  let d = null
  try {
    for (const disp of screen.getAllDisplays()) {
      const sf = disp.scaleFactor || 1
      const b = disp.bounds
      if (x >= b.x * sf && x <= (b.x + b.width) * sf && y >= b.y * sf && y <= (b.y + b.height) * sf) { d = disp; break }
    }
    if (!d) d = screen.getPrimaryDisplay()
  } catch {}
  const sf = (d && d.scaleFactor) || 1
  return { x: Math.round(x / sf), y: Math.round(y / sf) }
}
// ② 的 PowerShell 源码：C# P/Invoke 版（与 ① 同一套 Win32 调用，避免 UIA 树结构差异）
const ICON_CS_SOURCE = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class DeskIcons {',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW(string c, string t);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr p, IntPtr a, string c, string t);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint pid);',
  '  [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, IntPtr s, uint t, uint pr);',
  '  [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, IntPtr s, uint t);',
  '  [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, IntPtr s, out IntPtr w);',
  '  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, IntPtr s, out IntPtr r);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '  const uint LVM_GETITEMCOUNT = 0x1004, LVM_GETITEMPOSITION = 0x1010, LVM_GETITEMTEXTW = 0x1073, LVM_SETITEMPOSITION = 0x100F;',
  '  [StructLayout(LayoutKind.Sequential)] struct LVITEMW {',
  '    public uint mask; public int iItem; public int iSubItem; public uint state; public uint stateMask;',
  '    public IntPtr pszText; public int cchTextMax; public int iImage; public IntPtr lParam;',
  '    public int iIndent; public int iGroupId; public uint cColumns; public IntPtr puColumns; public IntPtr piColFmt; public int iGroup;',
  '  }',
  '  static IntPtr FindList() {',
  '    IntPtr pm = FindWindowW("Progman", null);',
  '    if (pm != IntPtr.Zero) {',
  '      IntPtr dv = FindWindowExW(pm, IntPtr.Zero, "SHELLDLL_DefView", null);',
  '      if (dv != IntPtr.Zero) { IntPtr lv = FindWindowExW(dv, IntPtr.Zero, "SysListView32", null); if (lv != IntPtr.Zero) return lv; }',
  '    }',
  '    IntPtr w = IntPtr.Zero;',
  '    while ((w = FindWindowExW(IntPtr.Zero, w, "WorkerW", null)) != IntPtr.Zero) {',
  '      IntPtr dv = FindWindowExW(w, IntPtr.Zero, "SHELLDLL_DefView", null);',
  '      if (dv != IntPtr.Zero) { IntPtr lv = FindWindowExW(dv, IntPtr.Zero, "SysListView32", null); if (lv != IntPtr.Zero) return lv; }',
  '    }',
  '    return IntPtr.Zero;',
  '  }',
  '  public static string Read() {',
  '    IntPtr list = FindList();',
  '    if (list == IntPtr.Zero) return "ERR|no-listview";',
  '    uint pid; GetWindowThreadProcessId(list, out pid);',
  '    IntPtr res;',
  '    int count = (int)SendMessageTimeoutW(list, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero, 2, 1500, out res) == 0 ? -1 : (int)res;',
  '    if (count <= 0 || count > 4096) return "ERR|bad-count";',
  '    IntPtr proc = OpenProcess(0x438, false, pid);',
  '    if (proc == IntPtr.Zero) return "ERR|openprocess";',
  '    IntPtr ptA = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)16, 0x3000, 4);',
  '    IntPtr txA = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)520, 0x3000, 4);',
  '    IntPtr lvA = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)96, 0x3000, 4);',
  '    if (ptA == IntPtr.Zero || txA == IntPtr.Zero || lvA == IntPtr.Zero) { CloseHandle(proc); return "ERR|alloc"; }',
  '    StringBuilder sb = new StringBuilder();',
  '    IntPtr w1, r1;',
  '    int sz = Marshal.SizeOf(typeof(LVITEMW));',
  '    for (int i = 0; i < count; i++) {',
  '      byte[] pt = new byte[16];',
  '      WriteProcessMemory(proc, ptA, pt, (IntPtr)16, out w1);',
  '      SendMessageTimeoutW(list, LVM_GETITEMPOSITION, (IntPtr)i, ptA, 2, 1500, out res);',
  '      ReadProcessMemory(proc, ptA, pt, (IntPtr)16, out r1);',
  '      byte[] tx = new byte[520];',
  '      WriteProcessMemory(proc, txA, tx, (IntPtr)520, out w1);',
  '      LVITEMW it = new LVITEMW();',
  '      it.mask = 1; it.iItem = i; it.iSubItem = 0; it.pszText = txA; it.cchTextMax = 260;',
  '      byte[] lv = new byte[sz];',
  '      IntPtr tmp = Marshal.AllocHGlobal(sz);',
  '      Marshal.StructureToPtr(it, tmp, false);',
  '      Marshal.Copy(tmp, lv, 0, sz);',
  '      Marshal.FreeHGlobal(tmp);',
  '      WriteProcessMemory(proc, lvA, lv, (IntPtr)sz, out w1);',
  '      SendMessageTimeoutW(list, LVM_GETITEMTEXTW, (IntPtr)i, lvA, 2, 1500, out res);',
  '      ReadProcessMemory(proc, txA, tx, (IntPtr)520, out r1);',
  '      string name = Encoding.Unicode.GetString(tx);',
  '      int z = name.IndexOf((char)0); if (z >= 0) name = name.Substring(0, z);',
  '      name = name.Trim();',
  '      if (name.Length > 0) sb.Append("ICON|" + name + "|" + BitConverter.ToInt32(pt, 0) + "|" + BitConverter.ToInt32(pt, 4) + "\\n");',
  '    }',
  '    VirtualFreeEx(proc, ptA, IntPtr.Zero, 0x8000);',
  '    VirtualFreeEx(proc, txA, IntPtr.Zero, 0x8000);',
  '    VirtualFreeEx(proc, lvA, IntPtr.Zero, 0x8000);',
  '    CloseHandle(proc);',
  '    return sb.ToString();',
  '  }',
  '  // 真挪图标（drag_icon）：名字走 base64（命令行里不用管转义），找到 index 后 LVM_SETITEMPOSITION。',
  '  // 只改资源管理器里的图标位置，绝不碰文件本身。',
  '  public static string Move(string nameB64, int x, int y) {',
  '    string want = Encoding.UTF8.GetString(Convert.FromBase64String(nameB64)).Trim();',
  '    if (want.Length == 0) return "ERR|bad-name";',
  '    IntPtr list = FindList();',
  '    if (list == IntPtr.Zero) return "ERR|no-listview";',
  '    uint pid; GetWindowThreadProcessId(list, out pid);',
  '    IntPtr res;',
  '    int count = (int)SendMessageTimeoutW(list, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero, 2, 1500, out res) == 0 ? -1 : (int)res;',
  '    if (count <= 0 || count > 4096) return "ERR|bad-count";',
  '    IntPtr proc = OpenProcess(0x438, false, pid);',
  '    if (proc == IntPtr.Zero) return "ERR|openprocess";',
  '    IntPtr txA = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)520, 0x3000, 4);',
  '    IntPtr lvA = VirtualAllocEx(proc, IntPtr.Zero, (IntPtr)96, 0x3000, 4);',
  '    if (txA == IntPtr.Zero || lvA == IntPtr.Zero) { CloseHandle(proc); return "ERR|alloc"; }',
  '    IntPtr w1, r1;',
  '    int sz = Marshal.SizeOf(typeof(LVITEMW));',
  '    int found = -1;',
  '    for (int i = 0; i < count && found < 0; i++) {',
  '      byte[] tx = new byte[520];',
  '      WriteProcessMemory(proc, txA, tx, (IntPtr)520, out w1);',
  '      LVITEMW it = new LVITEMW();',
  '      it.mask = 1; it.iItem = i; it.iSubItem = 0; it.pszText = txA; it.cchTextMax = 260;',
  '      byte[] lv = new byte[sz];',
  '      IntPtr tmp = Marshal.AllocHGlobal(sz);',
  '      Marshal.StructureToPtr(it, tmp, false);',
  '      Marshal.Copy(tmp, lv, 0, sz);',
  '      Marshal.FreeHGlobal(tmp);',
  '      WriteProcessMemory(proc, lvA, lv, (IntPtr)sz, out w1);',
  '      SendMessageTimeoutW(list, LVM_GETITEMTEXTW, (IntPtr)i, lvA, 2, 1500, out res);',
  '      ReadProcessMemory(proc, txA, tx, (IntPtr)520, out r1);',
  '      string nm = Encoding.Unicode.GetString(tx);',
  '      int z = nm.IndexOf((char)0); if (z >= 0) nm = nm.Substring(0, z);',
  '      if (nm.Trim() == want) found = i;',
  '    }',
  '    VirtualFreeEx(proc, txA, IntPtr.Zero, 0x8000);',
  '    VirtualFreeEx(proc, lvA, IntPtr.Zero, 0x8000);',
  '    CloseHandle(proc);',
  '    if (found < 0) return "ERR|not-found";',
  '    int lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF); // MAKELPARAM（坐标都非负，不涉及符号扩展）',
  '    IntPtr sent = SendMessageTimeoutW(list, LVM_SETITEMPOSITION, (IntPtr)found, (IntPtr)lp, 2, 1500, out res);',
  '    return sent == IntPtr.Zero ? "ERR|no-send" : "OK";',
  '  }',
  '}',
].join('\n')
// ② 的解析：`ICON|名|x|y` 行 → 图标（物理像素）。名字里不会有 `|`（Windows 文件名禁用字符）。
function parseDesktopIconsText(stdout) {
  const icons = []
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const m = /^ICON\|(.+)\|(-?\d+)\|(-?\d+)$/.exec(raw.trim())
    if (m) icons.push({ name: m[1], x: Number(m[2]), y: Number(m[3]) })
  }
  return icons
}
/** 二级回退：PowerShell 跑上面的 C#（EncodedCommand，与 nativeMove/openPanel 同款），输出 `ICON|名|x|y` 行。 */
function readDesktopIconsPowerShell() {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "Add-Type -Language CSharp @'",
    ICON_CS_SOURCE,
    "'@",
    '[DeskIcons]::Read()',
    'exit 0',
  ].join('\n')
  return new Promise((resolve) => {
    try {
      const b64 = Buffer.from(ps, 'utf16le').toString('base64')
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
        { timeout: 10_000, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err && !stdout) return resolve(null)
          const icons = parseDesktopIconsText(stdout)
          resolve(icons.length ? icons : null)
        })
    } catch { resolve(null) }
  })
}
/** 给图标补 isDir/file 标记（只读；桌面可能在 OneDrive 或公共桌面）。
 *  解析顺序：① 「显示名 / +.lnk / +.url / +.exe」逐个 stat（快，覆盖绝大多数）
 *            ② 唯一子串反查：用桌面目录的真实文件清单反推（治「显示名被 Explorer 截断」）
 *  命中的真实文件名记进 `file`：服务端按磁盘名 stat，发显示名过去会 not-found。 */
function annotateDesktopIcons(icons) {
  const home = (() => { try { return require('node:os').homedir() } catch { return '' } })()
  const dirs = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', '桌面'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
  ]
  const SUFFIXES = ['', '.lnk', '.url', '.exe']
  // 只在精确匹配失败时才需要清单；先惰性读一次，避免每个图标都 readdir
  let listings = null
  const getListings = () => {
    if (listings) return listings
    listings = dirs.map((dir) => {
      try { return { dir, files: fs.readdirSync(dir) } } catch { return { dir, files: [] } }
    })
    return listings
  }
  const fuzzy = (name) => (typeof behaviorApi.matchIconByName === 'function' ? behaviorApi.matchIconByName : null)
  for (const ic of icons || []) {
    const cands = typeof behaviorApi.iconCandidatePaths === 'function'
      ? behaviorApi.iconCandidatePaths(ic.name, null, dirs, SUFFIXES)
      : dirs.map((d) => path.join(d, ic.name))
    let hit = false
    for (const p of cands) {
      let st = null
      try { st = fs.statSync(p, { throwIfNoEntry: false }) } catch { st = null }
      if (!st) continue
      ic.isDir = st.isDirectory()
      ic.file = path.basename(p) // 磁盘真名（服务端要的就是这个；可能和显示名完全不同）
      hit = true
      break
    }
    if (hit) continue
    // 精确名全落空 → 拿真实文件清单做唯一子串反查（显示名被截断时才走得通；多个候选一律放弃）
    const match = fuzzy(ic.name)
    if (!match) continue
    for (const l of getListings()) {
      const file = match(ic.name, l.files)
      if (!file) continue
      let st = null
      try { st = fs.statSync(path.join(l.dir, file), { throwIfNoEntry: false }) } catch { st = null }
      if (!st) continue
      ic.isDir = st.isDirectory()
      ic.file = file
      break
    }
    // hidden 属性 stat 拿不到（Windows 的 stat 不带属性位）：桌面上的隐藏图标要么本来不显示，
    // 要么由 behavior.js 的名单兜底（desktop.ini / thumbs.db 一类）
  }
  return icons
}
/** 三级回退入口：① koffi ② PowerShell ③ null。返回 DIP 坐标，绝不抛。 */
async function readDesktopIcons() {
  try {
    const viaKoffi = loadKoffiDesktopEnum()
    if (viaKoffi) {
      const list = viaKoffi()
      if (list && list.length) {
        return annotateDesktopIcons(list.map((i) => { const d = physicalToDip(i.x, i.y); return { name: i.name, x: d.x, y: d.y } }))
      }
    }
  } catch {}
  const viaPs = await readDesktopIconsPowerShell()
  if (viaPs) {
    return annotateDesktopIcons(viaPs.map((i) => { const d = physicalToDip(i.x, i.y); return { name: i.name, x: d.x, y: d.y } }))
  }
  return null
}
/** 真挪桌面图标（drag_icon，2026-10-30 用户要求「图标得跟着动」）：
 *  ① koffi：枚举拿 index → LVM_SETITEMPOSITION（进程内，最快）
 *  ② 常驻光标助手：`[DeskIcons]::Move("<base64 名>", x, y)`（低延迟，逐帧可跟）
 *  两条都不行 → false（behavior.js 退回「只演不真拖」，绝不每帧 spawn 一个 0.6s 的 PowerShell）。 */
async function moveDesktopIcon(name, dipX, dipY) {
  const want = String(name || '').trim()
  if (!want || !Number.isFinite(dipX) || !Number.isFinite(dipY)) return false
  const p = dipToPhysical(dipX, dipY)
  const viaKoffi = loadKoffiDesktopEnum()
  if (viaKoffi && typeof viaKoffi.setPosition === 'function') {
    let list = null
    try { list = viaKoffi() } catch { list = null }
    if (Array.isArray(list) && list.length) {
      const lower = want.toLowerCase()
      const hit = list.find((it) => it.name === want) || list.find((it) => it.name.trim().toLowerCase() === lower)
      if (hit) {
        try { if (viaKoffi.setPosition(hit.i, p.x, p.y)) return true } catch {}
      }
    }
  }
  const cmd = `[DeskIcons]::Move("${Buffer.from(want, 'utf8').toString('base64')}", ${Math.round(p.x)}, ${Math.round(p.y)})`
  if (helperWrite(cmd)) return true
  const proc = await ensureCursorHelper()
  return proc ? helperWrite(cmd) : false
}
// ---------- 窗口动作：EnumWindows 枚举 / SetWindowPos 推歪 / PostMessage WM_CLOSE ----------
// 与桌面图标同一套「PowerShell + Add-Type」通道：不引 npm 依赖，也不用会被安全策略拦的 COM。
// 铁律 3：关窗只发 WM_CLOSE（等价点右上角 X，程序自己问要不要保存），**绝不 taskkill**。
// 白名单/排除名单的判定在 behavior.js（纯函数，可单测），这里只提供「看窗口」和「碰窗口」两只手。
const WINDOW_CS_SOURCE = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class DeskWin {',
  '  delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);',
  '  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);',
  '  const uint WM_CLOSE = 0x0010;',
  '  const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;',
  '  public static string List() {',
  '    IntPtr fg = GetForegroundWindow();',
  '    StringBuilder sb = new StringBuilder();',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      try {',
  '        if (!IsWindowVisible(h)) return true;',
  '        StringBuilder t = new StringBuilder(512); GetWindowTextW(h, t, 512);',
  '        string title = t.ToString().Trim();',
  '        if (title.Length == 0) return true;',
  '        uint pid; GetWindowThreadProcessId(h, out pid);',
  '        RECT r; if (!GetWindowRect(h, out r)) return true;',
  '        int w = r.R - r.L, hh = r.B - r.T;',
  '        if (w <= 0 || hh <= 0) return true;',
  '        string proc = "";',
  '        try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}',
  '        StringBuilder c = new StringBuilder(256); GetClassNameW(h, c, 256);',
  '        string tt = title.Replace("|", "/").Replace("\\r", " ").Replace("\\n", " ");',
  '        sb.Append("WIN|" + h.ToInt64() + "|" + pid + "|" + proc + "|" + (IsZoomed(h) ? 1 : 0) + "|" + (h == fg ? 1 : 0) + "|" + c.ToString() + "|" + r.L + "|" + r.T + "|" + w + "|" + hh + "|" + tt + "\\n");',
  '      } catch {}',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return sb.ToString();',
  '  }',
  '  public static string Close(string hwnd) {',
  '    IntPtr h = (IntPtr)long.Parse(hwnd);',
  '    if (h == IntPtr.Zero || !IsWindowVisible(h)) return "ERR|not-visible";',
  '    return PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero) ? "OK" : "ERR|post-failed";',
  '  }',
  '  // 2026-10-30 用户指定「不要闪现」：在 ms 内把窗口匀速挪 (dx,dy)（物理像素，可为负）。',
  '  // 桌宠在同一段时长里以同样速度走过去，看上去就是「她推着窗口走」。',
  '  public static string Slide(string hwnd, string dx, string dy, string ms) {',
  '    IntPtr h = (IntPtr)long.Parse(hwnd);',
  '    int ddx = int.Parse(dx), ddy = int.Parse(dy), dur = int.Parse(ms);',
  '    if (dur < 1) dur = 1;',
  '    RECT r; if (!GetWindowRect(h, out r)) return "ERR|no-rect";',
  '    int sx = r.L, sy = r.T;',
  '    var sw = System.Diagnostics.Stopwatch.StartNew();',
  '    while (true) {',
  '      long el = sw.ElapsedMilliseconds;',
  '      double t = el >= dur ? 1.0 : (double)el / dur;',
  '      int nx = sx + (int)Math.Round(ddx * t);',
  '      int ny = sy + (int)Math.Round(ddy * t);',
  '      SetWindowPos(h, IntPtr.Zero, nx, ny, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);',
  '      if (t >= 1.0) break;',
  '      System.Threading.Thread.Sleep(15);',
  '    }',
  '    return "OK";',
  '  }',
  '  // 绝对归位（推完的兜底）：不管中间发生什么，窗口最终一定回到原始坐标。',
  '  public static string Place(string hwnd, string x, string y) {',
  '    IntPtr h = (IntPtr)long.Parse(hwnd);',
  '    if (h == IntPtr.Zero) return "ERR|bad-window";',
  '    return SetWindowPos(h, IntPtr.Zero, int.Parse(x), int.Parse(y), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) ? "OK" : "ERR|place-failed";',
  '  }',
  '}',
].join('\n')
/** 参数消毒：只留数字，允许一个前导负号（窗口位移会用到负数）。
 *  负数不能直接 replace(/\D/g,'')——那会把 -600 变成 600，窗口反而往反方向飞。 */
function numArg(a) {
  const raw = String(a === undefined || a === null ? '' : a).trim()
  const neg = raw.startsWith('-')
  const digits = raw.replace(/\D/g, '')
  return (neg ? '-' : '') + digits
}
/** 跑一次 DeskWin 方法。参数只允许数字（防注入）；失败返回 null。
 *  timeoutMs 默认 25s：Slide 要在脚本里匀速走完一段（最长按位移换算，调用方会传更大的超时）。 */
function runDeskWin(method, timeoutMs, ...args) {
  const safe = args.map(numArg)
  const call = safe.length ? `[DeskWin]::${method}(${safe.map((a) => `"${a}"`).join(', ')})` : `[DeskWin]::${method}()`
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "Add-Type -Language CSharp @'",
    WINDOW_CS_SOURCE,
    "'@",
    call,
    'exit 0',
  ].join('\n')
  return new Promise((resolve) => {
    try {
      const b64 = Buffer.from(ps, 'utf16le').toString('base64')
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
        { timeout: Number(timeoutMs) || 25_000, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err && !stdout) return resolve(null)
          resolve(String(stdout || ''))
        })
    } catch { resolve(null) }
  })
}
/** 可见顶层窗口清单（DIP 坐标）。读不到返回 null —— 上层据此 refused，不猜。 */
async function listWindows() {
  const out = await runDeskWin('List', 20_000)
  if (out == null) return null
  const wins = []
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split('|')
    if (p.length < 12 || p[0] !== 'WIN') continue
    const hwnd = Number(p[1])
    const px = Number(p[7]); const py = Number(p[8]); const pw = Number(p[9]); const ph = Number(p[10])
    if (!Number.isFinite(hwnd) || hwnd <= 0) continue
    const a = physicalToDip(Number.isFinite(px) ? px : 0, Number.isFinite(py) ? py : 0)
    const b = physicalToDip((Number.isFinite(px) ? px : 0) + (Number.isFinite(pw) ? pw : 0), (Number.isFinite(py) ? py : 0) + (Number.isFinite(ph) ? ph : 0))
    wins.push({
      hwnd, pid: Number(p[2]) || 0, proc: p[3] || '', title: p.slice(11).join('|'),
      cls: p[6] || '', zoomed: p[4] === '1', fg: p[5] === '1', visible: true,
      x: a.x, y: a.y, width: Math.max(0, b.x - a.x), height: Math.max(0, b.y - a.y),
    })
  }
  return wins
}
/** 只发 WM_CLOSE（优雅关闭）；返回是否发出去了。 */
async function windowClose(hwnd) {
  const out = await runDeskWin('Close', 15_000, hwnd)
  return typeof out === 'string' && /(^|\n)\s*OK\s*(\n|$)/.test(out)
}
/** 推窗口（nudge_window）：把窗口在 ms 内匀速挪 (dx, dy)（DIP 位移，可为负）。
 *  2026-10-30 用户指定「不要闪现」——桌宠在同一段时长里以同速走过去，看起来才是「她推着窗口走」。
 *  dx/dy 是**相对当前窗口位置**的位移，重复调用可累加（推出去一次、拉回来一次）。 */
async function windowSlide(hwnd, dx, dy, ms) {
  const dur = Math.max(16, Math.min(120_000, Math.round(Number(ms) || 0)))
  const a = dipToPhysical(0, 0)
  const b = dipToPhysical(Math.round(Number(dx) || 0), Math.round(Number(dy) || 0))
  const px = Math.round(b.x - a.x)
  const py = Math.round(b.y - a.y)
  if (!px && !py) return true
  const out = await runDeskWin('Slide', dur + 25_000, hwnd, px, py, dur)
  return typeof out === 'string' && /(^|\n)\s*OK\s*(\n|$)/.test(out)
}
/** 把窗口放到绝对位置（DIP）。推窗口的兜底还原：中间失败也一定把窗口摆回原处。 */
async function windowPlace(hwnd, dipX, dipY) {
  const p = dipToPhysical(Math.round(Number(dipX) || 0), Math.round(Number(dipY) || 0))
  const out = await runDeskWin('Place', 15_000, hwnd, p.x, p.y)
  return typeof out === 'string' && /(^|\n)\s*OK\s*(\n|$)/.test(out)
}
// ---------- 桌面环境上报（2026-10-30）：把「开着哪些窗口」喂给 AI 简报 ----------
// 为什么由客户端推：窗口枚举要 PowerShell + Win32（桥已经在客户端了），服务端再实现一套纯属重复。
// 只推标题/进程名/是否前台——坐标对简报没用，推上去只是噪音。服务端 10 分钟过期，所以 2 分钟一次。
let envPushing = false
async function reportEnvironment() {
  if (envPushing || !behaviorCfg.enabled) return
  if (!win || win.isDestroyed()) return
  envPushing = true
  try {
    const list = await listWindows()
    if (!Array.isArray(list)) return
    const mine = new Set([process.pid, (() => { try { return process.ppid } catch { return 0 } })()])
    const rows = list
      // 自己的窗口（桌宠/宿主）不报：AI 看得到就会想「去关那个」，而执行层本来也不许碰
      .filter((w) => w && String(w.title || '').trim() && !mine.has(Number(w.pid)))
      .sort((a, b) => (b.fg ? 1 : 0) - (a.fg ? 1 : 0) || (b.width * b.height) - (a.width * a.height))
      .slice(0, 12)
      .map((w) => ({ title: String(w.title).slice(0, 80), proc: String(w.proc || '').slice(0, 40), fg: w.fg === true }))
    if (rows.length) apiPost('/behavior/env', { windows: rows, at: Date.now() })
  } catch {} finally { envPushing = false }
}
setInterval(() => { reportEnvironment().catch(() => {}) }, 120_000)
setTimeout(() => { reportEnvironment().catch(() => {}) }, 8_000) // 起来先报一次，别等两分钟
// ---------- 执行器接线：behavior.js 的 run(params, ctx) 需要的 IO 全在这里 ----------
// 图标/走位链路诊断（2026-10-30「叼/收图标定位不对」排查）：JSONL 追加到 app 目录 debug-icon.log，
// 超 64KB 砍半保留尾部。记录的是「客户端当时看到的原始数字」，真机对账全靠它。失败静默。
function debugIconLog(obj) {
  try {
    const f = path.join(__dirname, 'debug-icon.log')
    let size = 0
    try { size = fs.statSync(f).size } catch {}
    if (size > 65536) {
      const tail = fs.readFileSync(f, 'utf8').split('\n').slice(-80).join('\n')
      fs.writeFileSync(f, tail)
    }
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n')
  } catch {}
}
const behaviorCtx = () => ({
  moveWindowTo,
  bodyRect,
  cursor: () => { try { return screen.getCursorScreenPoint() } catch { return null } }, // 鼠标指针（DIP）
  playAnimByName: playAnimByNames,
  // 自动轮播关掉后，idle 池的动画只走 AI 的 idle_anim 动作：单播一段，播完回静态立绘
  playIdleAnim: () => {
    if (!win || win.isDestroyed()) return Promise.resolve(false)
    return win.webContents
      .executeJavaScript('Boolean(window.__playIdleOnce && window.__playIdleOnce())')
      .catch(() => false)
  },
  nativeMove,
  // 追到后按住鼠标 5 秒（chase_cursor）：ClipCursor 夹住指针 + 循环回中，拖不出去也不会闪回
  pinCursor,
  say: (text) => { showBubble(text, '', 'text', '', '', 'behavior', '行为') },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pickWanderTarget: (from) => {
    if (!win || win.isDestroyed()) return null
    const [w, h] = winSizeDip()
    const b = bodyBox(w, h)
    const area = screen.getPrimaryDisplay().workArea
    // 返回的是**身体中心**的可达点（moveWindowTo 现在按身体中心对齐）：
    // 活动范围四边各内缩半个身体，from 也换算成身体中心再算「走得够不够远」
    const box = {
      x: area.x + b.width / 2,
      y: area.y + b.height / 2,
      width: Math.max(1, area.width - b.width),
      height: Math.max(1, area.height - b.height),
    }
    const center = from
      ? { x: Number(from.x) + Number(from.width || 0) / 2, y: Number(from.y) + Number(from.height || 0) / 2 }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    return behaviorApi.pickWanderTarget(box, center)
  },
  // 图标动作桥：只读桌面清单 + 图标收走 act + **真挪图标**（drag_icon 用）
  readDesktopIcons,
  iconAct: (body) => apiPostAwait('/behavior/icon/act', body),
  moveDesktopIcon,
  debugLog: debugIconLog,
  // 图标动作降级用：读不到图标时走到屏幕下沿随机位置空演一口
  workArea: () => { try { return screen.getPrimaryDisplay().workArea } catch { return null } },
  // 窗口动作桥：枚举 / 优雅关闭 / 匀速推（人物同速跟着走）/ 绝对归位。白名单判定在 behavior.js 里做。
  listWindows,
  windowClose,
  windowSlide,
  windowPlace,
  selfPids: () => {
    const p = [process.pid]
    try { if (process.ppid) p.push(process.ppid) } catch {}
    return p // 自己 + 宿主：这两个进程的窗口永远不碰
  },
})
/** 小屋动作执行：开屋（已在屋内就复用）→ 等 ready → 跳状态（key 必须是 house.js STATES 键）。 */
async function handleHouseBehavior(e) {
  const key = String(((e && e.params) || {}).key || '').trim()
  const ALLOWED = new Set(['sofa', 'cube', 'drink', 'dine', 'desk', 'kitchen', 'balcony', 'bedphone', 'sleep', 'wardrobe', 'upstairs', 'play'])
  if (key && !ALLOWED.has(key)) {
    apiPost('/playback', { playbackId: (e && e.playbackId) || '', action: 'enter_house', status: 'refused', reason: 'bad-key', detail: key })
    return { status: 'refused', reason: 'bad-key' }
  }
  openHouse()
  const ok = await houseCommandWhenReady(key ? { cmd: 'state', key } : { cmd: 'state', key: 'play' })
  const status = ok ? 'ok' : 'refused'
  apiPost('/playback', { playbackId: (e && e.playbackId) || '', action: 'enter_house', status, reason: ok ? '' : 'house-not-ready', detail: key || 'free' })
  return { status, reason: ok ? '' : 'house-not-ready' }
}
/** 下发通道统一入口（唯一执行路径）：say 先气泡，执行完回执 /playback。 */
// 这些动作自己会说话（say 用 params.text）：外面别再预弹一次，否则双气泡
const SELF_SAY_ACTIONS = new Set(['say'])
// 小屋动作：主进程拦截执行（开场景窗 + 跳状态），不走 behavior.js 纯逻辑层——
// 窗口调度本来就归主进程管，执行器只碰桌面窗自己的世界。
const HOUSE_MAIN_ACTIONS = new Set(['enter_house'])
async function handleBehavior(e) {
  const action = String((e && e.action) || '')
  if (HOUSE_MAIN_ACTIONS.has(action)) return handleHouseBehavior(e)
  // 台词优先级：AI 给的 > 动作默认台词。**每次动作都要顶气泡**——否则主人只看见她在动，
  // 不知道她要干什么（尤其面板「试一下」和本地反应层：点击/勾引/摸摸根本不经过服务端）。
  const def = behaviorApi.ACTIONS[action] || {}
  const sayText = SELF_SAY_ACTIONS.has(action)
    ? ''
    : String((e && e.say) || '').trim() || String(def.say || '').trim()
  if (sayText) showBubble(sayText, e.mood, '', '', '', 'behavior', '行为')
  // playbackId 随 params 透传（icon/act 契约要求带回执号，服务端用它对上回执）
  const params = { ...((e && e.params) || {}), playbackId: (e && e.playbackId) || '' }
  const res = await behaviorApi.execute(action, params, behaviorCtx())
  // detail：窗口动作回传「碰到的是哪个窗口」（服务端记进关窗记录，面板显示用）
  apiPost('/playback', { playbackId: (e && e.playbackId) || '', action, status: res.status, reason: res.reason || '', detail: res.detail || '' })
  return res
}
// ---------- 反应层感知循环：400ms 轮询鼠标；没动就不推样本（startThrow 教训）；
// 专注模式整层暂停；判定顺序 摸摸 > 勾引 > 闲置；点击走事件（pet:click）驱动。 ----------
let behaviorCfg = { enabled: true, idleCursorMinutes: behaviorApi.THRESHOLDS.IDLE_CURSOR_MINUTES, disabledActions: [], configLoaded: false }
/** 该动作是否被主人禁用（面板「AI 动作表」开关）：反应层与 AI 路径同口径（2026-11-01）。
 *  首次 /config 返回前 configLoaded=false：禁用清单未知，先按「不跑」处理——否则启动瞬间
 *  关掉的追鼠标/叼鼠标还会抓一下（一审 #20 唯一一条）。摸摸不受影响（不在禁用清单口径里）。 */
const behaviorActionEnabled = (a) => behaviorCfg.configLoaded && !behaviorCfg.disabledActions.includes(a)
// 互动闸（1.0.14，面板六键）：晃鼠标勾引追 / 点击扑鼠标各有独立开关（默认关）。
// 既有禁用清单闸仍先判（两个闸是「且」的关系，关任何一个都不扑）；摸摸/闲置判定完全不受影响。
const teaseChaseEnabled = () => teaseChase === true
const clickChaseEnabled = () => clickChase === true
const CURSOR_SAMPLES_MAX = 40
let cursorSamples = []     // [{x,y,t}] 升序
let lastCursorMoveAt = Date.now()
const reactionLastAt = {}  // kind → 时间戳（冷却）
function react(kind, run, detail) {
  const now = Date.now()
  if (!behaviorApi.canReact(reactionLastAt[kind], now)) return false
  reactionLastAt[kind] = now
  Promise.resolve()
    .then(() => (typeof run === 'function' ? run() : run))
    .catch(() => {})
  apiPost('/behavior/reaction', { kind, detail: detail || {} }) // 摘要喂给 AI 下一轮（服务端扩展该路由）
  return true
}
setInterval(() => {
  if (!behaviorCfg.enabled) return
  if (focusOn) { cursorSamples = []; return } // 专注模式：整个反应层暂停
  if (!win || win.isDestroyed()) return
  let p = null
  try { p = screen.getCursorScreenPoint() } catch { return }
  const now = Date.now()
  const prev = cursorSamples.length ? cursorSamples[cursorSamples.length - 1] : null
  if (!prev || prev.x !== p.x || prev.y !== p.y) {
    cursorSamples.push({ x: p.x, y: p.y, t: now })
    if (cursorSamples.length > CURSOR_SAMPLES_MAX) cursorSamples.shift()
    lastCursorMoveAt = now
  }
  const box = bodyRect()
  if (!box) return
  if (behaviorApi.isPatting(cursorSamples, box, now)) {
    // 摸摸是反应层动作，不走 behavior 事件，气泡得自己顶——不然只看见她在蹭，不知道为啥
    react('pat', () => {
      showBubble('（被摸到了…）', '', '', '', '', 'behavior', '行为')
      return playAnimByNames(['蹭', '贴贴', '摸摸', 'pat'])
    }, { dwellMs: behaviorApi.THRESHOLDS.PAT_DWELL_MS })
  } else if (teaseChaseEnabled() && behaviorActionEnabled('chase_cursor') && behaviorApi.isTeasing(cursorSamples, box, now)) {
    react('tease', () => handleBehavior({ action: 'chase_cursor' }), { note: '主人在旁边快速晃鼠标勾引' })
  } else if (behaviorActionEnabled('steal_cursor') && behaviorApi.isCursorIdle(lastCursorMoveAt, now, behaviorCfg.idleCursorMinutes)) {
    lastCursorMoveAt = now // 触发一次后重新计时，避免每轮都打
    // 2026-10-30 用户指定：闲置反应直接叼鼠标（approach_cursor 已删）
    react('idle-cursor', () => handleBehavior({ action: 'steal_cursor' }), { idleMinutes: behaviorCfg.idleCursorMinutes })
  }
}, 400)

// ---------- IPC（渲染页拖拽/甩抛 → 主进程） ----------
ipcMain.on('pet:move', (_e, { x, y }) => {
  stopThrow()
  if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return
  const [w, h] = winSizeDip()
  const d = virtualDesktopBounds()
  // 夹进虚拟桌面：窗口整体留在屏幕可及范围里（松手后甩抛/落地再把身体精确夹回工作区）
  const nx = Math.round(Math.min(Math.max(x, d.x), d.x + d.w - w))
  const ny = Math.round(Math.min(Math.max(y, d.y), d.y + d.h - h))
  // 丢弃重复坐标：渲染页已按帧合并，但同一位置仍可能连发（对齐后指针抖动等）——重复就不必再动窗口
  // lastMove 由 setWinPos 统一维护（抛掷/行为移动之后也不会变成陈数据）
  if (lastMove && lastMove.x === nx && lastMove.y === ny) return
  setWinPos(nx, ny)
})

// ---------- 主进程权威拖拽（2026-11-07 新通道 pet:drag-start/move/end；pet:move 保留向后兼容）----------
// 旧机制偏移根因：渲染页自算坐标（screenInfo + e.screenX）在 forwarded-input 穿透窗 + setZoomFactor
// 下会与真实光标错位（纯 Electron 探针已验证 e.screenX == screen.getCursorScreenPoint()，DIP 1:1）。
// 新机制：渲染页只发信号不带坐标；主进程 drag-start 记 grabOffset（光标 - 窗口左上角，全 DIP），
// 起 60fps 循环：读光标 → winPos = cursor - grabOffset → 夹虚拟桌面 → setWinPos，同时采 DIP 轨迹
// （≤64 条，trimTrail 按时间裁剪）。drag-end 用 trimTrail + estimateReleaseVelocity 算初速：
// releaseLand 关 → 停在哪就在哪；isClick → 原地掉落（等价旧 drop()，同样受 releaseLand 门控）。
const DRAG_FRAME_MS = 16   // 拖拽循环节拍 ≈60fps（与甩抛/移动循环一致；主进程没有 rAF，用定时器）
const DRAG_STALE_MS = 3000 // 心跳兜底：渲染页按住期间每 300ms 有保活心跳，3s 内任何心跳都没有才判丢失（pointerup 丢失/指针捕获异常），绝不永久拖着
const DRAG_TRAIL_MAX = 64  // 轨迹上限（与旧渲染页口径一致，时间窗口由 trimTrail 裁）
let drag = null // { grabOffset:{x,y}, trail:[{t,x,y}], lastPos, timer, lastSeen }
function stopDrag() {
  if (!drag) return
  clearTimeout(drag.timer)
  drag = null
}
/** 拖拽收尾：按 isClick / 轨迹初速决定原地掉落或甩抛（统一走 startThrow，物理口径单一来源）。 */
function endDragSession(isClick) {
  const d = drag
  stopDrag()
  if (!d) return // 孤立 drag-end（异常路径/没发生过拖拽）：不做任何收尾，更不能原地掉落
  if (!win || win.isDestroyed()) return
  if (!releaseLand) return // 松手落地关：停在哪就在哪（与旧 pet:throw 拦截口径一致）
  const trail = physics.trimTrail(d ? d.trail : [], Date.now())
  const v = isClick ? null : physics.estimateReleaseVelocity(trail, Date.now(), effectivePhysics())
  startThrow(v ? v.vx : 0, v ? v.vy : 0) // isClick / 温柔放下 = 零初速原地掉落
  applyFitWindow(true) // 收尾再贴：拖拽期间被跳过的窗高调整在这里补上（force，甩抛循环会逐帧重算 bounds 跟上）
}
function dragLoop() {
  const d = drag
  if (!d) return
  if (!win || win.isDestroyed()) { stopDrag(); return }
  let c = null
  try { c = screen.getCursorScreenPoint() } catch { c = null }
  if (!c) { stopDrag(); return } // 拿不到光标（罕见）：放弃拖拽，别空转
  const now = Date.now()
  const [w, h] = winSizeDip()
  const dd = virtualDesktopBounds()
  // 窗口整体留在所有屏并集内（松手后甩抛/落地再把身体精确夹回工作区，与旧 pet:move 同口径）
  const nx = Math.round(Math.min(Math.max(c.x - d.grabOffset.x, dd.x), dd.x + dd.w - w))
  const ny = Math.round(Math.min(Math.max(c.y - d.grabOffset.y, dd.y), dd.y + dd.h - h))
  const key = nx + ',' + ny
  if (key !== d.lastPos) { d.lastPos = key; if (!setWinPos(nx, ny)) { stopDrag(); return } }
  d.trail.push({ t: now, x: c.x, y: c.y }) // 主进程直接采 DIP 轨迹（初速估算直接可用，无需换算）
  if (d.trail.length > DRAG_TRAIL_MAX) d.trail.shift()
  if (now - d.lastSeen > DRAG_STALE_MS) { endDragSession(false); return } // 心跳断了：按普通松手兜底
  d.timer = setTimeout(dragLoop, DRAG_FRAME_MS)
}
ipcMain.on('pet:drag-start', () => {
  if (!win || win.isDestroyed()) return
  stopThrow()
  stopMover() // 与行为移动互斥（用户拖着走时别让 wander/chase 抢窗口）
  stopDrag()
  let c = null
  try { c = screen.getCursorScreenPoint() } catch { return }
  const [wx, wy] = win.getPosition()
  drag = { grabOffset: { x: c.x - wx, y: c.y - wy }, trail: [], lastPos: '', timer: null, lastSeen: Date.now() }
  dragLoop()
})
ipcMain.on('pet:drag-move', () => { if (drag) drag.lastSeen = Date.now() }) // 心跳：无坐标，只证明指针还按着
ipcMain.on('pet:drag-end', (_e, isClick) => endDragSession(isClick === true))
ipcMain.on('pet:throw', (_e, { vx, vy }) => {
  // 「松手落地」关掉：松手停在哪就在哪 —— 甩抛与原地掉落（vx=vy=0）一并拦下
  if (!releaseLand) return
  startThrow(Number(vx) || 0, Number(vy) || 0)
})
ipcMain.on('pet:throw-stop', () => stopThrow())
// 反应层①点击桌宠：渲染页单击（位移 <6px）上报 → 撒娇动画（渲染页 click 池已播）+ 追鼠标（带冷却）
// 2026-11-01：追鼠标被禁用时只保留渲染页自己的点击动画，不再追/抓鼠标。
// 1.0.14：petClickChase 开关（面板六键，默认关）也拦这条——关 = 点了只播点击动画，不扑鼠标。
ipcMain.on('pet:click', () => { if (clickChaseEnabled() && behaviorActionEnabled('chase_cursor')) react('click', () => handleBehavior({ action: 'chase_cursor' }), { note: '主人点了桌宠' }) })
// 渲染页命中检测：true=鼠标在宠物/气泡上（恢复窗口交互），false=在透明区（放行点击）
ipcMain.on('pet:hit', (_e, hit) => {
  if (!win || win.isDestroyed()) return
  try { win.setIgnoreMouseEvents(!hit, { forward: true }) } catch {}
})
// 窗口贴合内容（修「空白区域过大」）：窗口本来固定 430 高，气泡区 166px 平时全透明却真占着屏幕。
// 现在渲染页按内容上报基础高度（气泡收起=264，气泡弹出=264+12+气泡实高+8，上限 430），
// 主进程乘当前倍率后改窗高，**底边不动**（窗口向上长/向下缩，桌宠位置视觉不变）。
// 渲染页报的是缩放前的 CSS px（zoomFactor 只缩内容），这里统一乘 curScale 换算成真实窗口像素。
/** 按当前 fitBaseH/curScale 调整窗高（底边钉住）。force=true 供拖拽/飞行收尾后补贴。 */
function applyFitWindow(force) {
  if (!win || win.isDestroyed()) return
  if (!force && (drag || thrower)) return // 拖拽/飞行中跳过（原因见 pet:fit 注释）
  const minH = Math.round(REST_H * curScale)  // 气泡收起：16(底距)+240(舞台)+8(顶距)
  const maxH = Math.round(BASE_H * curScale)   // 兜底上限：6 行长文本也放得下
  const h = Math.min(maxH, Math.max(minH, Math.round(fitBaseH * curScale))) // DIP 意图，setSizeDip 负责换算
  const [w, oldH] = winSizeDip()
  if (h === oldH) return
  try {
    const [, y] = win.getPosition()
    setSizeDip(w, h)
    const ny = y + oldH - h // 高度差全补在 y 上 = 底边钉住
    win.setPosition(win.getPosition()[0], ny)
    // 窗口位置变了，移动基线也要跟上：不然拖拽去重拿陈基线会把第一帧当「重复坐标」吞掉
    lastMove = { x: win.getPosition()[0], y: ny }
    win.setResizable(false)
  } catch {}
}
ipcMain.on('pet:fit', (_e, baseH) => {
  if (!win || win.isDestroyed()) return
  // 记住「内容需要的基础高度」：applyScale 之后 /config 的 scale 变化时也按它算，别回到 430
  fitBaseH = Math.min(BASE_H, Math.max(REST_H, Math.round(Number(baseH)) || REST_H))
  applyFitWindow(false)
})
ipcMain.handle('pet:screen', () => {
  if (!win) return null
  const [x, y] = win.getPosition()
  const [w, h] = winSizeDip()
  const area = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 }).workArea
  return { W: area.width, H: area.height, x, y, areaX: area.x, areaY: area.y, size: w }
})

// ---------- 右键菜单（仿 dsh-pet 的菜单树：工具项 + 「动作」分类级联，动画显示原名） ----------
/** 读形象包配置、原名映射与素材文件表：直接读盘（packs 就在 host.json 旁边），不依赖插件版本。
 *  返回 { manifest: 原名→id, cfg: 包配置（含 menu 分类）, labels: id→原名, files: 包目录里的文件名 }。 */
function loadPackMeta() {
  const name = (pack && pack.name) || 'default'
  const dir = path.join(path.dirname(HOST_FILE), 'packs')
  const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
  const manifest = readJsonFile(`${name}-manifest.json`) || {}
  const cfg = readJsonFile(`${name}-config.json`) || {}
  let files = []
  // 菜单要列全量动画，素材文件表是唯一可靠来源（插件 /config 只回三个池）
  try { files = fs.readdirSync(path.join(dir, `${name}-animation`)) } catch {}
  return { manifest, cfg, labels: metaApi.labelsOf(manifest), files }
}
/** 点播任意动画：交给渲染页强制插播（分类子菜单 / 单项都用它）。
 *  渲染页返回 false（地址表里没有这段，通常是刚放了素材 / 端口刚漂）→ 重推一次配置再试。 */
let playRetryPending = false
async function playAnimById(id) {
  if (!win || win.isDestroyed()) return false
  const run = () => win.webContents
    .executeJavaScript(`window.__playAnim && window.__playAnim(${JSON.stringify(String(id))})`)
    .catch(() => false)
  const ok = await run()
  if (ok !== false) return ok
  if (playRetryPending) return false
  playRetryPending = true
  try {
    win.__packPushed = false // 强制重推一次素材地址表
    await refreshConfig()
  } finally { playRetryPending = false }
  return win && !win.isDestroyed() ? run() : false
}
/** 回到初始位置：停掉飞行，回主屏右下角（仿 dsh-pet 的 home）。 */
function goHome() {
  if (!win || win.isDestroyed()) return
  stopThrow()
  const [w, h] = winSizeDip()
  const area = screen.getPrimaryDisplay().workArea
  setWinPos(area.x + area.width - w - 24, area.y + area.height - h - 16)
}
// 手动碎碎念文案池（真正的碎碎念由插件按面板里的间隔/文案池生成，这里只是插件不可达时的兜底）
const WHISPERS = ['在吗在吗？', '戳戳你～', '今天也要加油鸭！', '（盯着你看）', '摸鱼一时爽～', '想你啦！']
/** 碎碎念：先请插件走自己的碎碎念流程（/whisper：会带碎碎念动画 + 现想一句）；
 *  插件不可达/没这接口时才退回「本地文案 + 本地气泡」。专注模式下插件会拒绝——那就安静。 */
function whisper() {
  const sayLocal = (text) => win?.webContents.executeJavaScript(`window.__whisper && window.__whisper(${JSON.stringify(text)})`).catch(() => {})
  const h = readHost()
  if (!h) return sayLocal(WHISPERS[Math.floor(Math.random() * WHISPERS.length)])
  fetch(`${h.baseUrl}${h.api}/whisper`, {
    method: 'POST',
    headers: { 'x-pet-token': h.token, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json()).then((d) => {
    if (d && d.ok === true) return
    if (d && d.reason === 'focus') return // 专注模式：不打扰
    sayLocal(WHISPERS[Math.floor(Math.random() * WHISPERS.length)])
  }).catch(() => sayLocal(WHISPERS[Math.floor(Math.random() * WHISPERS.length)]))
}
/** 打开面板：DSH 面板在宿主窗口/浏览器标签里（根路径要一次性 token，不能直连），
 *  所以按「含本插件端口」的窗口标题把那个窗口切到前台；找不到再退 DSH 主窗口。 */
function openPanel() {
  const h = readHost()
  // 远端直连（2026-11-02）：baseUrl 是非回环地址（面板就在服务器域名的浏览器标签里），
  // 直接用系统默认浏览器打开它，不再按端口拼 127.0.0.1 去找本机 DSH 窗口。
  let remoteBase = null
  try { const u = new URL(h ? h.baseUrl : ''); if (h && !isLoopbackHostname(u.hostname)) remoteBase = h.baseUrl } catch {}
  if (remoteBase) {
    shell.openExternal(remoteBase).catch(() => {
      win?.webContents.executeJavaScript(`window.__whisper && window.__whisper(${JSON.stringify('面板在浏览器标签 ' + remoteBase + ' 里～')})`).catch(() => {})
    })
    return
  }
  const port = h ? ((h.baseUrl.match(/:(\d+)/) || [])[1] || '') : ''
  const ps = [
    `$pat = ${JSON.stringify(port ? `*127.0.0.1:${port}*` : '*127.0.0.1*')}`,
    '$p = Get-Process | Where-Object { $_.MainWindowTitle -like $pat } | Select-Object -First 1',
    "if (-not $p) { $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '*DeepSeek*' } | Select-Object -First 1 }",
    'if (-not $p) { exit 1 }',
    "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
    '[W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
    '[W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    'exit 0',
  ].join('; ')
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64], (err) => {
    if (!err) return
    // 切不过去：至少告诉用户面板在哪
    win?.webContents.executeJavaScript(`window.__whisper && window.__whisper(${JSON.stringify('面板在浏览器标签 ' + (h ? h.baseUrl : '127.0.0.1') + ' 里～')})`).catch(() => {})
  })
}
/** 查看余额（2026-11-07 新增菜单项）：走插件 GET /ext/pet/balance（服务端带 60s 内存缓存）。
 *  契约：{ ok:true, text:'余额 ¥xx.xx（已用 ¥yy）' } 或 { ok:false, reason }。失败/没连上一律兜底文案。
 *  展示走大字气泡（big=true，少爷反馈：余额太小看不清）：第一行只留余额，「已用」换行放第二行。 */
async function showBalance() {
  let text = '余额暂时查不到'
  let big = false
  try {
    const d = await apiGet('/ext/pet/balance')
    if (d && d.ok === true && d.text) {
      text = String(d.text).replace(/（(已用[^）]*)）/g, '\n$1') // '余额 ¥x（已用 ¥y）' → '余额 ¥x\n已用 ¥y'
      big = true
    }
  } catch {}
  showBubble(text, '', 'text', '', '', 'behavior', '余额', null, big)
}
ipcMain.on('pet:menu', () => {
  if (!win || win.isDestroyed()) return
  const { manifest, cfg } = loadPackMeta()
  const pools = (pack && pack.animations) || {}
  // 「动作」：优先用包配置里的全量分类（menu 段），没有就回落 idle/speak/click 三个池
  const cats = (pack && pack.name) ? metaApi.resolveMenu(cfg, manifest, pools) : []
  const actionSub = cats.length
    ? {
        label: '动作',
        submenu: cats.map((c) => ({
          label: c.label,
          submenu: c.items.map((it) => ({ label: it.label, click: () => { playAnimById(it.id) } })),
        })),
      }
    : null
  // 行为动作下发：与面板按钮同通道 —— 走服务端 /behavior 下发后统一执行
  // 2026-10-30 移除（用户决定）：行为由 AI 决定，右键菜单不再是调试入口；
  // 调试统一走面板「行为与安全」卡的「试一下」。留个变量名方便回滚。
  // ⚠ 若要恢复：重建 BEHAVIOR_MENU（action 名与服务端 BEHAVIOR_ACTIONS 对齐）+ 模板里插回。
  const menu = Menu.buildFromTemplate([
    { label: '碎碎念', click: whisper },
    ...(chatCfg.enabled ? [{ label: chatWinAlive() ? '关闭对话框' : '打开对话框', click: toggleChat }] : []), // 与快捷键等效
    { label: houseAlive() ? '到屋外玩' : '回小屋', click: toggleHouse },
    { label: '回到初始位置', click: goHome },
    ...(actionSub ? [actionSub] : []),
    // 「查看余额」（1.0.14，petShowBalance 开才显示）：走服务端 /balance 拿 { balance, currency }，
    // 气泡展示（showBubble 是既有气泡通道）；拿不到 key / 请求失败时服务端回 ok:false，气泡显示友好文案。
    ...(balanceEnabled ? [{
      label: '查看余额',
      click: async () => {
        const r = await apiGetAny('/balance')
        if (r && r.ok) showBubble(`钱包余额：${r.balance} ${r.currency || 'CNY'}～`, 'happy', '', '', '', '', '')
        else showBubble((r && r.message) || '暂无法获取余额', 'neutral', '', '', '', '', '')
      },
    }] : []),
    { label: '收起气泡', click: hideBubble },
    ...(balanceEnabled ? [{ label: '查看余额', click: showBalance }] : []), // /config 的 balanceEnabled 控制显隐（缺省 true）
    { type: 'separator' },
    { label: '打开面板', click: openPanel },
    { label: focusOn ? '关闭专注模式' : '开启专注模式', click: () => { focusOn = !focusOn; apiPost('/focus', { enabled: focusOn, source: 'pet-menu' }) } },
    { label: '隐藏桌宠', click: () => win?.hide() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => { running = false; app.quit() } },
  ])
  menu.popup({ window: win })
})

// ---------- 对话框（petChat：主人找她聊的小窗；设计稿 docs/PET-CHAT-DESIGN.md） ----------
// 独立 BrowserWindow（pet 主窗是点击穿透的，这个要可交互）：小尺寸、无边框，锚定人物旁、出屏钳制。
// 发送链路：chat.html 输入框 → ipc 'pet:chat:send' → 关键字闸（命中直接关窗、不请求模型）→ POST /chat。
// 回复两条路都会进来（messageId 去重）：POST 响应直接画；服务端 chat 事件经 pollLoop 转发。
let chatWin = null
let chatCfg = { enabled: false, hotkey: '', closeKeyword: '', blurHide: true }
let hotkeyReg = ''            // 当前已注册的组合键（'' = 未注册）
let hotkeyState = 'unconfigured'
let hotkeyWarnedAt = 0        // 占用提醒防抖：5 分钟内只气泡提醒一次
const chatWinAlive = () => Boolean(chatWin && !chatWin.isDestroyed() && chatWin.isVisible())
function reportChatState() {
  apiPost('/chat/state', { open: chatWinAlive(), hotkey: hotkeyState, hotkeyKey: hotkeyReg || chatCfg.hotkey })
}
function positionChatWin() {
  if (!chatWin || chatWin.isDestroyed() || !win || win.isDestroyed()) return
  try {
    const [pw, ph] = winSizeDip()
    const [px, py] = win.getPosition()
    const [cw, ch] = chatWin.getSize()
    const area = screen.getDisplayNearestPoint({ x: px + pw / 2, y: py + ph / 2 }).workArea
    // 锚定人物旁（左侧），出屏钳制（复用主窗的工作区口径）
    const x = Math.round(Math.min(Math.max(px - cw - 8, area.x), area.x + area.width - cw))
    const y = Math.round(Math.min(Math.max(py + Math.round(ph * 0.15), area.y), area.y + area.height - ch))
    chatWin.setPosition(x, y)
  } catch {}
}
function closeChatWin() {
  if (!chatWin || chatWin.isDestroyed()) return
  try { chatWin.close() } catch {}
}
function pushChatHistory() {
  if (!chatWin || chatWin.isDestroyed()) return
  apiGet('/chat/history', { limit: 50 }).then((d) => { // 服务端截断后下发最近 N 条
    if (d && d.ok && chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.executeJavaScript(`window.__chatSetHistory && window.__chatSetHistory(${JSON.stringify(d.items || [])})`).catch(() => {})
    }
  }).catch(() => {})
}
function openChatWin() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return }
  chatWin = new BrowserWindow({
    width: 320, height: 420, frame: false, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false,
    // 本地小窗只加载同目录 chat.html（无远程内容），直接 nodeIntegration 省一套 preload
    webPreferences: { nodeIntegration: true, contextIsolation: false, spellcheck: false },
  })
  chatWin.setAlwaysOnTop(true, 'screen-saver')
  chatWin.loadFile(path.join(__dirname, 'chat.html'))
  // 窗口 show:false 时 chatWinAlive() 为 false；ready-to-show 里 show 之后必须补报一次 open:true，
  // 否则服务端一直以为窗没开、回复会错发到桌面气泡（一审 #18 第 1 点）。
  chatWin.once('ready-to-show', () => { positionChatWin(); chatWin.show(); chatWin.focus(); pushChatHistory(); reportChatState() })
  // Esc 关窗：无边框小窗没有菜单加速键，主进程拦按键
  chatWin.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') closeChatWin() })
  chatWin.on('blur', () => { if (chatCfg.blurHide) closeChatWin() }) // 失焦自动收起（开关可配，默认开）
  // 可见性变化一律补报：show() 返回时 isVisible() 未必已翻成 true，靠 show 事件兜底（一审 #18 第 1 点）。
  chatWin.on('show', () => reportChatState())
  chatWin.on('hide', () => reportChatState())
  chatWin.on('closed', () => { chatWin = null; reportChatState() })
  reportChatState()
}
// 服务端认为「窗口 5 分钟没续报 = 已关」；窗口一直开着就每 2 分钟续报一次，
// 否则超时后回复会错走桌面气泡（一审 #18-1）。
setInterval(() => { if (chatWinAlive()) reportChatState() }, 120_000).unref?.()
function toggleChat() {
  if (!chatCfg.enabled) return
  if (chatWinAlive()) closeChatWin()
  else openChatWin()
}
/** 快捷键（单键 toggle）：配置变更先注销旧键再注册新键；register 返回 false = 被占用 →
 *  状态记 failed（面板回显标红）、气泡提醒一次（防抖）、功能保持关闭；客户端重启后由 refreshConfig 补注册。 */
function applyChatHotkey() {
  const want = chatCfg.enabled && chatCfg.hotkey ? chatCfg.hotkey : ''
  if (want === hotkeyReg) return
  if (hotkeyReg) { try { globalShortcut.unregister(hotkeyReg) } catch {} ; hotkeyReg = '' }
  if (!want) { hotkeyState = 'unconfigured'; reportChatState(); return }
  let ok = false
  try { ok = globalShortcut.register(want, toggleChat) } catch { ok = false }
  if (ok) {
    hotkeyReg = want
    hotkeyState = 'registered'
  } else {
    hotkeyState = 'failed'
    if (Date.now() - hotkeyWarnedAt > 5 * 60_000) {
      hotkeyWarnedAt = Date.now()
      showBubble(`快捷键 ${want} 被别的程序占用了，对话框快捷键没生效（可在面板换一个）`, '', 'text', '', '', 'behavior', '对话框')
    }
  }
  reportChatState()
}
// 对话框发送（chat.html → ipc）：关键字闸在客户端先行（发送前命中 → 关窗、不请求模型；服务端 /chat 另有兜底）
ipcMain.on('pet:chat:send', async (_e, text) => {
  const t = String(text || '').trim().slice(0, 500)
  if (!t) return
  if (chatCfg.closeKeyword && t.includes(chatCfg.closeKeyword)) { closeChatWin(); return }
  const d = await apiPostAwait('/chat', { text: t })
  if (!chatWin || chatWin.isDestroyed()) return // 回复途中窗被关：服务端已改走碎碎念气泡，这里不用管
  // 支持多参：__chatAppend(text, messageId) —— 两路（POST 响应 / 服务端 chat 事件）带着同一个 id，
  // chat.html 靠它去重；只传 text 会让同一条回复显示两次（一审 #18 第 3 点）。
  const js = (fn, ...args) => chatWin.webContents.executeJavaScript(`window.${fn} && window.${fn}(${args.map((a) => JSON.stringify(String(a ?? ''))).join(',')})`).catch(() => {})
  if (d && d.ok && d.text) {
    js('__chatAppend', d.text, d.messageId)
  } else if (d && d.closed) {
    closeChatWin() // 服务端兜底关键字命中（chatClose 事件也会关一次，幂等）
  } else {
    const why = !d ? '没连上插件，稍后再试'
      : d.reason === 'thinking' ? '她在想上一句…'
      : d.reason === 'focus' ? '专注模式开着，先关掉专注吧'
      : d.reason === 'pet-offline' ? '桌宠不在线'
      : d.reason === 'plugin-off' ? '插件开关没开'
      : d.reason === 'disabled' ? '对话框开关没开（面板里打开）'
      : '现在不方便聊'
    js('__chatHint', why)
  }
})


// ---------- 小屋（复式场景窗：移植自 zizic04/dsh-pet-home，MIT；素材 CC BY-NC-SA 禁商用，自用） ----------
// 与对话框同款的第二窗模式（nodeIntegration 直连 ipc，省一套 preload）：
//   入屋 = 右键「回小屋」→ 隐藏桌面窗、打开 house.html 场景窗（query 带 base/token，素材走 /asset/house/*）；
//   出屋 = 场景内拖到窗外松手（pet:house:exit）或右键「到屋外玩」→ 桌面窗挪到光标处再显示、关场景窗。
// 桌面窗期间只是隐藏：进程、长轮询、聊天窗都照常，身份与菜单完全不变。
let houseWin = null
let houseReady = false // 渲染端 boot 完成（成功/失败都会发 pet:house:ready）后才能收 command
const houseAlive = () => Boolean(houseWin && !houseWin.isDestroyed())
const ROOM_ASPECT = 1672 / 941 // 场景世界尺寸（与服务端 manifest.json 的 world 一致）
function houseAnimTable() {
  const view = pack && pack.name ? pack : null
  if (!view) return {}
  const names = metaApi.knownAnims(view.animations, loadPackMeta().files)
  return metaApi.animUrlMap(names, (n) => assetUrl(view.name, `${n}.webm`))
}
function pushHouseAssets() {
  if (!houseAlive()) return
  const js = `window.__setAssets && window.__setAssets(${JSON.stringify(houseAnimTable())})`
  houseWin.webContents.executeJavaScript(js).catch(() => {})
}
function houseCommand(cmd) {
  if (!houseAlive()) return
  const js = `window.__houseCommand && window.__houseCommand(${JSON.stringify(cmd)})`
  houseWin.webContents.executeJavaScript(js).catch(() => {})
}
function openHouse() {
  if (houseAlive()) { houseWin.show(); houseWin.focus(); return }
  houseReady = false
  const host = readHost()
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(1180, Math.round(area.width * 0.62))
  const height = Math.round(width / ROOM_ASPECT)
  houseWin = new BrowserWindow({
    width, height, useContentSize: true,
    minWidth: 560, minHeight: Math.round(560 / ROOM_ASPECT),
    title: '肥鱼的小屋', backgroundColor: '#1d1a17',
    show: false, acceptFirstMouse: true, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, spellcheck: false },
  })
  houseWin.setAspectRatio(ROOM_ASPECT)
  houseWin.webContents.setBackgroundThrottling(false)
  houseWin.webContents.on('context-menu', (event) => event.preventDefault())
  houseWin.loadFile(path.join(__dirname, 'house.html'), {
    query: { base: host ? host.baseUrl + host.api : '', token: host ? host.token : '' },
  }).then(() => {
    // 【白屏兜底 2026-11-08】Windows 实测：隐藏首开的窗口偶发**不触发 ready-to-show**（首帧绘制
    // 被饿死，页面其实加载好了，console/did-fail-load 全程无异常），show() 永远不执行，窗口就
    // 一直「白」着藏在屏幕外。加载成功后 2.5s 检查一次，仍不可见就直接亮窗——backgroundColor
    // 已是深色 #1d1a17，最多闪一下深底，不会再白。只补第一次（isVisible 后此分支不再生效）。
    setTimeout(() => {
      try {
        if (houseAlive() && !houseWin.isVisible()) { houseWin.show(); pushHouseAssets() }
      } catch {}
    }, 2500)
  }).catch((err) => console.error('小屋页加载失败：', err && err.message ? err.message : err))
  // ---------- 小屋窗自愈（2026-11-07）：主窗同款——白屏兜底，防崩循环靠冷却 + 次数上限。
  // 实测小屋会整页没起来（页面本身加载失败/渲染进程崩溃），那种情况 house.js 里的错误层根本
  // 不存在，必须由主进程救。重试时 query 原样带 base/token（host.json 端口漂移后可能变化，
  // 每次重试都重新 readHost 拿最新值）。 ----------
  const houseQuery = () => {
    const h = readHost()
    return { base: h ? h.baseUrl + h.api : '', token: h ? h.token : '' }
  }
  let houseReloadAt = 0 // 渲染进程崩溃重载的冷却戳（10s 内只救一次）
  let houseLoadRetryLeft = 2 // 主框架加载失败的重试余量
  houseWin.webContents.on('render-process-gone', (_e, d) => {
    if (!d || d.reason === 'clean-exit' || d.reason === 'exited') return
    debugIconLog({ kind: 'house-render-gone', reason: d.reason, exitCode: d.exitCode })
    const now = Date.now()
    if (now - houseReloadAt < 10_000) return
    houseReloadAt = now
    try { houseWin.webContents.reload() } catch {}
  })
  houseWin.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = ABORTED（换源/重载主动中断），不算失败
    debugIconLog({ kind: 'house-load-fail', code, desc: String(desc || '') })
    if (houseLoadRetryLeft <= 0) return
    houseLoadRetryLeft--
    try { houseWin.loadFile(path.join(__dirname, 'house.html'), { query: houseQuery() })
      .catch((err) => console.error('小屋页重试加载失败：', err && err.message ? err.message : err)) } catch {}
  })
  houseWin.webContents.on('did-finish-load', () => { houseLoadRetryLeft = 2 }) // 加载成功：余量回满
  houseWin.once('ready-to-show', () => { houseWin.show(); pushHouseAssets() })
  // 关窗 = 出屋：桌面窗回到屏幕里（位置不变），身份菜单原样
  houseWin.on('closed', () => { houseWin = null; showPetFromHouse(null) })
  // 入屋：桌面窗藏起来（停在原位，出门时回原处）
  try { win?.hide() } catch {}
}
/** 出屋：把桌面窗显示回屏幕（point = 光标点，null = 原位），再关场景窗。 */
function showPetFromHouse(point) {
  try {
    if (win && !win.isDestroyed()) {
      if (point) {
        const [w, h] = winSizeDip()
        const area = screen.getDisplayNearestPoint(point).workArea
        const x = Math.round(Math.min(Math.max(point.x - w / 2, area.x), area.x + area.width - w))
        const y = Math.round(Math.min(Math.max(point.y - h / 2, area.y), area.y + area.height - h))
        win.setPosition(x, y)
      }
      clampWindowToArea()
      win.show()
    }
  } catch {}
  if (houseAlive()) houseWin.close()
}
const toggleHouse = () => (houseAlive() ? showPetFromHouse(screen.getCursorScreenPoint()) : openHouse())
ipcMain.on('pet:house:ready', () => { houseReady = true; pushHouseAssets() })
ipcMain.on('pet:house:exit', () => { showPetFromHouse(screen.getCursorScreenPoint()) })
ipcMain.on('pet:house:say', (_e, text) => { apiPost('/house/state', { say: String(text || '').slice(0, 200) }) })
/** 等小屋渲染端就绪再发命令（开窗到 ready 有 1~2 秒；超时 8 秒放弃，不挂死调用方）。 */
async function houseCommandWhenReady(cmd, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now()
  while (!houseReady && houseAlive() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 300))
  if (houseReady && houseAlive()) houseCommand(cmd)
  return houseReady && houseAlive()
}


// ---------- 窗口 / 托盘 ----------
function createWindow() {
  win = new BrowserWindow({
    // 窗口 280×430：16(底距) + 240(1:1 素材) + 12(缝) + 154(气泡) + 8(顶距)
    width: 280, height: 430,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 透明区域放行鼠标点击（不然 280×430 的窗口会挡住身后的一切）；
  // 渲染页检测到悬停在宠物/气泡上时发 pet:hit=true 恢复交互，离开再放行。
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  win.loadFile(path.join(__dirname, 'index.html'))
  // ---------- 白屏自愈（2026-11-07）：渲染进程崩溃 / 主框架加载失败后窗口会留着一块白板没人救，
  // 自动重载救回；防崩循环靠「冷却 + 次数上限」，两条路各有一套，互不影响。 ----------
  let lastReloadAt = 0          // 渲染进程崩溃重载的冷却戳（10s 内只救一次）
  let loadRetryLeft = 2         // 主框架加载失败的重试余量（成功后清零，见 did-finish-load）
  const reloadForWhiteScreen = () => {
    const now = Date.now()
    if (now - lastReloadAt < 10_000) return // 冷却内不重复 reload：防「崩→重载→又崩」打满 CPU
    lastReloadAt = now
    try { win.webContents.reload() } catch {}
  }
  win.webContents.on('render-process-gone', (_e, d) => {
    // clean-exit/exited 是正常退出（窗口关闭路径），不算事故；其余（crashed/oom/killed 等）都救
    if (!d || d.reason === 'clean-exit' || d.reason === 'exited') return
    debugIconLog({ kind: 'render-gone', reason: d.reason, exitCode: d.exitCode })
    reloadForWhiteScreen()
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    // 只管主框架；-3(ABORTED) 是换源/重载时主动中断的常态，不是失败
    if (!isMain || code === -3) return
    debugIconLog({ kind: 'load-fail', code, desc: String(desc || '') })
    if (loadRetryLeft <= 0) return // 次数上限：连续挂就别无限重试（素材/端口问题交给 pollLoop 重推）
    loadRetryLeft--
    try { win.loadFile(path.join(__dirname, 'index.html')) } catch {}
  })
  win.webContents.on('did-finish-load', () => { loadRetryLeft = 2 }) // 加载成功：重试余量回满
  win.once('ready-to-show', () => { clampWindowToArea(); pushPackToRenderer(); pushAnimRate() })
  win.on('show', () => { clampWindowToArea(); stopThrow() }) // 重新显示时确保回到屏幕内、且没有残留的飞行循环
  win.on('hide', () => { stopThrow(); stopDrag() }) // 隐藏/关窗时拖拽循环也要停：stopDrag 不依赖 win，先清再置 null 都安全
  win.on('closed', () => { stopThrow(); stopDrag(); win = null })
}

function createTray() {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEUlEQVR42mNk+M9Qz4AFMGETAG1hCQeukhTbAAAAAElFTkSuQmCC', 'base64'))
    tray = new Tray(img)
    tray.setToolTip('Aurabot 桌宠')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => (win ? (win.isVisible() ? win.hide() : win.show()) : createWindow()) },
      { label: houseAlive() ? '到屋外玩' : '回小屋', click: toggleHouse },
      ...(chatCfg.enabled ? [{ label: chatWinAlive() ? '关闭对话框' : '打开对话框', click: toggleChat }] : []),
      { label: '收起气泡', click: hideBubble },
      { type: 'separator' },
      { label: '退出桌宠', click: () => { running = false; app.quit() } },
    ]))
  } catch (e) { console.error('托盘创建失败（不影响气泡）：', e.message) }
}

app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
app.whenReady().then(() => {
  // Windows 上没设 AppUserModelID 时系统通知会被静默丢掉（完工提醒依赖它）
  try { app.setAppUserModelId('com.aurabot.pet') } catch {}
  createWindow()
  createTray()
  refreshConfig()
  pollLoop()
})
app.on('window-all-closed', () => {}) // 关窗不退出，从托盘退
// 退出前一定放开鼠标裁剪区 + 收掉助手进程：ClipCursor 是系统级状态，带不走就成「用户鼠标被锁死」的事故
app.on('will-quit', () => { try { releaseCursorClip(); stopCursorHelper(); globalShortcut.unregisterAll() } catch {} })
process.on('exit', () => { try { releaseCursorClip() } catch {} })
