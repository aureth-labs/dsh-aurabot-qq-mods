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
//   · 窗口：置顶、透明无边框、JS 拖拽 + 甩抛（physics.js，P3）、托盘退出、单实例锁。

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
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
// 多开（第二只及以后）。容错：缺了就退化成单宠物，绝不因此起不来。
let multiApi = null
let createMultiPets = null
try { ({ createMultiPets } = require('./multi.js')) } catch (e) { console.error('缺少 multi.js，只能养一只：', e.message) }
const metaApi = packmeta || {
  knownAnims: (pools) => Object.values(pools || {}).flat(),
  animUrlMap: (names, makeUrl) => Object.fromEntries((names || []).map((n) => [n, makeUrl(n)]).filter(([, u]) => u)),
  labelsOf: (m) => Object.fromEntries(Object.entries(m || {}).filter(([, id]) => typeof id === 'string' && id).map(([o, id]) => [id, o])),
  resolveMenu: () => [],
}

const HOST_FILE = process.env.AURABOT_PET_HOST || path.join(__dirname, '..', 'host.json')
const POLL_WAIT_MS = 25_000
// 连续这么多轮连不上插件就自退（DSH 关掉后桌宠不能变成孤儿留在屏幕上）
const ORPHAN_MAX_ATTEMPTS = 12
const FETCH_TIMEOUT_MS = 40_000

if (!app.requestSingleInstanceLock()) app.quit() // 单实例锁

// 启动期任何未捕获异常都落盘：否则进程静默退出时只能靠猜。
process.on('uncaughtException', (e) => {
  try { fs.appendFileSync(path.join(__dirname, 'startup-error.log'), `[${new Date().toISOString()}] uncaught: ${e && e.stack || e}\n`) } catch {}
})
process.on('unhandledRejection', (e) => {
  try { fs.appendFileSync(path.join(__dirname, 'startup-error.log'), `[${new Date().toISOString()}] rejection: ${e && (e.stack || e.message) || e}\n`) } catch {}
})

let win = null
let tray = null
let cursor = null      // 事件游标（null = 首次连接只取水位）
let bootId = ''
let focusOn = false
let clientId = 'pet-' + Math.random().toString(16).slice(2, 10)
let pack = null        // 当前形象包视图（/config 的 pack 字段）
let apiBase = null     // { baseUrl, api, token }

// ---------- 多桌宠：窗口注册表 + 碰撞 broker ----------
// dsh-pet 的做法：每只宠物一个窗口，主进程汇总所有宠物状态（broker）后广播给每个窗口，
// 窗口在飞行时用别人的实时位置做跨窗碰撞检测。
// 这里保持向后兼容：`win` 仍是**主窗口**（旧代码全部只认它），额外窗口放 extraWins。
// 只有开第二只时才会有跨窗碰撞，单只时 broker 只有自己、碰撞自然不触发。
const PET_ID = 'main'
/** petId -> { id, win, state:{x,y,vx,vy,size,bottomPad}, alive } */
const petRegistry = new Map()
function registerPetWindow(petId, w) {
  const id = String(petId || 'main')
  petRegistry.set(id, { id, win: w, state: { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 }, alive: true })
  broadcastPetStates()
}
function dropPetState(petId) {
  const rec = petRegistry.get(String(petId))
  if (rec) { rec.alive = false; petRegistry.delete(String(petId)) }
  broadcastPetStates()
}
/** 更新某只宠物的实时状态并广播（节流交给调用方：飞行中 ~30ms 一次）。 */
function updatePetState(petId, partial) {
  const rec = petRegistry.get(String(petId))
  if (!rec) return
  Object.assign(rec.state, partial || {})
  broadcastPetStates()
}
/** 把所有宠物的状态广播给每个窗口（含自己：渲染页据此做碰撞检测）。 */
function broadcastPetStates() {
  const states = {}
  for (const [id, rec] of petRegistry) {
    if (!rec.alive) continue
    states[id] = { ...rec.state }
  }
  for (const rec of petRegistry.values()) {
    const w = rec.win
    if (!w || w.isDestroyed()) continue
    try { w.webContents.send('pet:flight-states', states) } catch {}
  }
}

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
function apiPost(pathname, body) {
  const host = readHost()
  if (!host) return
  fetch(`${host.baseUrl}${host.api}${pathname}`, {
    method: 'POST',
    headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).catch(() => {})
}
/** 诊断日志落盘（只给排查用，正常路径不写，失败也不影响任何功能）。 */
function appendDebugLog(obj) {
  try {
    fs.appendFileSync(path.join(__dirname, 'debug-crop.log'), JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n')
  } catch {}
}
/** 主人明确要关掉桌宠（托盘 / 右键菜单的「退出桌宠」）。
 *  先通知插件记下「不想开着」——否则下次 DSH 启动的自动拉起会把她又放出来，等于没退掉。
 *  只等最多 800ms：插件连不上也必须能退出，绝不能因为服务端不来而卡住不退。
 *  注意这条路和「连不上插件自退」是两回事：自退不调这里，意图标记保持原样，下次照样自动拉起。 */
async function quitByUser(from) {
  running = false
  try {
    const host = readHost()
    if (host) {
      await Promise.race([
        fetch(`${host.baseUrl}${host.api}/intent/quit`, {
          method: 'POST',
          headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
          body: JSON.stringify({ from: String(from || '') }),
        }).catch(() => {}),
        new Promise((r) => setTimeout(r, 800)),
      ])
    }
  } catch {}
  try { app.quit() } catch { process.exit(0) }
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
/** 「吃白饭」的三张图：名字 → 带 token 的地址（走 /pic/baifan/<名字>.png，与梗图同一套拼法）。
 *  玩法没配（view.baifan 为空）时返回空对象，渲染页据此不显示菜单入口。 */
function baifanPicMap(view) {
  const host = readHost()
  if (!host) return null
  const v = view || pack
  if (!v || !Array.isArray(v.baifan) || v.baifan.length !== 5) return null
  const out = {}
  for (const n of ['bowl-empty', 'bowl-full', 'rice-ball']) {
    out[n] = `${host.baseUrl}${host.api}/pic/baifan/${encodeURIComponent(n)}.png?token=${host.token}`
  }
  return out
}
/** 梗图 / 音效地址表：名字 → 带 token 的 URL（从 dsh-pet 搬来的能力）。 */
function memeUrlMap() {
  const host = readHost()
  if (!host) return {}
  const out = {}
  const memes = (pack && Array.isArray(pack.memes)) ? pack.memes : []
  for (const m of memes) {
    const name = typeof m === 'string' ? m : (m && m.name)
    if (!name) continue
    out[name] = `${host.baseUrl}${host.api}/pic/memes/${encodeURIComponent(name)}.png?token=${host.token}`
  }
  // 点击音效：素材目录里有就给它一个地址，没有就不响
  if (pack && pack.clickSound) {
    out.__clickSound = `${host.baseUrl}${host.api}/sound/${encodeURIComponent(pack.clickSound)}?token=${host.token}`
  }
  // 自定义字体：同理
  if (pack && pack.font) {
    out.__font = `${host.baseUrl}${host.api}/fonts/${encodeURIComponent(pack.font)}?token=${host.token}`
  }
  return out
}
/** 把当前形象包推给渲染页：素材地址表 + 池 + 权重 + 物理参数。 */
/** 素材表下发脚本（纯构造，不认窗口）：主宠物与多开的额外宠物共用同一份。 */
function packScript(packName) {
  // packName：多开时那一只自己绑的形象包（/config 的 extraSlots[i].pack）。
  // 传了就临时切到那份视图；没传/没这份包就还是主宠物当前那份。
  let view = pack && pack.name ? pack : null
  if (packName) {
    const own = extraPackViews.get(String(packName))
    if (own && own.name) view = own
  }
  let anims = {}
  if (view) {
    // 关键：右键「动作」菜单能列出的动画远多于三个池（default 包 106 段里只有 26 段在池里）。
    // 地址表只按池建 → 菜单里另外 80 段点下去查不到 URL，渲染页静默 return false，
    // 桌宠就"一直在播自己的动画"。所以这里按「池 ∪ 包目录里的全部 webm」建表。
    const names = metaApi.knownAnims(view.animations, loadPackMeta(view.name).files)
    anims = metaApi.animUrlMap(names, (n) => assetUrl(view.name, `${n}.webm`))
  }
  return `window.__setPack && window.__setPack(${JSON.stringify({
    anims,
    memes: memeUrlMap(), // 梗图名 → 带 token 的地址（含 __clickSound 音效）
    pools: view ? view.animations : { idle: [], speak: [], click: [] },
    weights: view ? view.weights : {},
    events: view ? view.events : {},
    workStatus: view ? (view.workStatus || {}) : {}, // 干活状态 → 动画（服务端按命名约定/包配置解析好）
    // 内置玩法「吃白饭」（2026-11-05 跟进 dsh-pet 新版）：5 个槽位的素材 id + 三张图的地址。
    // 槽位是**按位置**的契约：① 跑向底部 ② 追饭侧身跑 ③ 等开饭 ④ 吃碗饭 ⑤ 吃饭团。
    baifan: view ? (view.baifan || []) : [],
    baifanPics: baifanPicMap(view),
    // 随机链骰子（2026-11-05，照 dsh-pet 的 rollKind）：{ weights, categories:[{id,weight,noMirror,actions}] }
    roll: view ? (view.roll || null) : null,
    // 素材 id → 中文原名（菜单/日志用；随机链只在调试面板里显示分类名）
    labels: view ? (view.labels || {}) : {},
    physics: view ? view.physics : null,
    atTop: bubbleGrowsDown(), // 气泡往哪边长（按她此刻在屏幕的位置算，见 bubbleGrowsDown）
    // 宠物数值（饱腹 / 精力 / 亲密度）：右键喂食子菜单和悬停状态卡都靠这一块。
    // 只下发「状态卡要不要显示」这类客户端要用的开关，数值本身每次现查 /life（数值会变，缓存没意义）。
    life: { enabled: Boolean(view && view.life && view.life.enabled), statusCard: Boolean(view && view.life && view.life.statusCard), feedEnabled: Boolean(view && view.life && view.life.feedEnabled) },
  })})`
}
/** 多开时每只自己绑的形象包视图（包名 → packView），由 /config 的 extraPackViews 下发。
 *  不重新解析、不重复读盘：服务端已经把它算好了，这里只按名字取。 */
const extraPackViews = new Map()
/** 额外宠物上限：与服务端 EXTRA_MAX / multi.js 的 MAX_EXTRA_PETS 同为 4。 */
const MULTI_MAX = 4
function pushPackToRenderer() {
  if (!win || win.isDestroyed()) return
  const js = packScript()
  win.webContents.executeJavaScript(js).catch(() => {})
}
/** 给多开的额外宠物也推一份素材表（它们没有气泡，但要有动画）。 */
function pushPackToExtras() {
  if (!multiApi) return
  const js = packScript()
  for (const rec of multiApi.pets.values()) {
    if (!rec.win || rec.win.isDestroyed()) continue
    rec.win.webContents.executeJavaScript(js).catch(() => {})
  }
}
/** 出生点四个角。 */
const CORNERS = { 'bottom-right': 1, 'bottom-left': 1, 'top-right': 1, 'top-left': 1 }
/** 「要不要重推素材表」的指纹：剔掉 atTop（它只影响布局翻转，由 __setCorner 单独下发）。
 *  不剔的话，改出生点会被误判成换素材包 → 重推整表 → __setPack 重置裁切 + 重播动画 → 闪一下。 */
function packSig(p) {
  if (!p) return ''
  const { atTop, ...rest } = p
  return JSON.stringify(rest)
}
/** 出生点指纹：角落 + 两个边距，任何一项变了都算「主人改了出生点」。 */
function cornerKey(p) {
  const o = (p && p.position) || {}
  const c = CORNERS[o.corner] ? o.corner : 'bottom-right'
  const mx = Number.isFinite(Number(o.marginX)) ? Number(o.marginX) : 24
  const my = Number.isFinite(Number(o.marginY)) ? Number(o.marginY) : 16
  return `${c}|${mx}|${my}`
}
let positionApplied = false // 启动后是否已按面板设置摆过位（之后只听「出生点有没有被改」）
/**
 * 气泡该往哪边长 —— **按她此刻在屏幕上的位置算，不是按配置的出生角落**。
 *
 * 踩过的坑（2026-11-06）：原来这里返回的是「出生点是不是 top-*」。出生点只决定
 * **启动时把她摆在哪**，之后她会走路、会被拖、会被甩。用户把出生点设成 top-left，
 * 但人早就掉到屏幕底部了（实测 y=1070 / 屏高 1360），于是：
 *   · 布局以为「人在屏幕上方」，把气泡画到人物**下方**；
 *   · 可她已经在屏幕底了，气泡往下长 = 跑到她下面，还差点出屏。
 * 用户看到的就是「气泡在角色下方，应该在头上」。
 *
 * 现在的判据是「头顶还剩多少地方」：
 *   · 人物上方够放气泡（默认按最大气泡高估）→ 气泡在头上（atTop=false）
 *   · 上方不够、下方够 → 翻到脚下（atTop=true）
 *   · 都放不下 → 选空间大的那边
 * 返回 true 表示 atTop（气泡在人物下方往下长）。
 */
const BUBBLE_SPACE_NEED = 300 // 估一个「典型气泡」的高度（含内边距/梗图），和 BUBBLE_MAX_CSS 同量级
/**
 * @param {object|null} rec 多开时那一只的 rec（{win}）；不传 = 主宠物。
 *   额外那几只也要按各自的位置判断，不能共用主宠物的结论（它们在屏幕别处）。
 */
function bubbleGrowsDown(rec = null) {
  const w = rec && rec.win && !rec.win.isDestroyed() ? rec.win : win
  if (!w || w.isDestroyed()) return isTopCorner() // 拿不到窗口：退回旧判据，别让布局乱掉
  try {
    const body = rec ? (() => {
      // 额外那几只没有 bodyScreenRect 的全局版本，就地按 bodyBox 算
      const [wx, wy] = w.getPosition()
      const [ww, wh] = w.getSize()
      const b = bodyBox(ww, wh)
      return { left: wx + b.offsetX, top: wy + b.offsetY, right: wx + b.offsetX + b.width, bottom: wy + b.offsetY + b.height }
    })() : bodyScreenRect()
    if (!body) return isTopCorner()
    const area = screen.getDisplayNearestPoint({
      x: Math.round((body.left + body.right) / 2),
      y: Math.round((body.top + body.bottom) / 2),
    }).workArea
    const above = body.top - area.y          // 头顶到屏幕上沿还有多少
    const below = area.y + area.height - body.bottom // 脚底到屏幕下沿还有多少
    // 头顶放得下就放头上（这是默认、也是最自然的位置）
    if (above >= BUBBLE_SPACE_NEED) return false
    // 头顶放不下、脚下放得下 → 翻到脚下
    if (below >= BUBBLE_SPACE_NEED) return true
    // 都放不下：选空间大的那边（宁可挤一点，也别顶出屏幕）
    return below > above
  } catch { return isTopCorner() }
}
/** 出生点是不是上沿（只用于「启动摆位」和「初始布局」，不参与运行时气泡方向）。 */
function isTopCorner() {
  const p = (pack && pack.position) || {}
  return CORNERS[p.corner] ? p.corner.startsWith('top') : false
}
/** 只推「气泡往哪边长」这一个布尔给渲染页（翻布局用）。
 *  千万不能顺手推整份素材表：__setPack 会重置裁切并重播待机动画，表现就是画面一闪一闪。 */
let lastGrowsDown = null
function pushCornerToRenderer() {
  if (!win || win.isDestroyed()) return
  const down = bubbleGrowsDown()
  // 只在**方向真的变了**时推：每次推都会触发渲染页 refitWindow（重新量气泡高度 + 改窗口高），
  // 位置一动就推的话，她走路时窗口会一直抖。
  if (down === lastGrowsDown) return
  lastGrowsDown = down
  win.webContents.executeJavaScript(`window.__setCorner && window.__setCorner(${down})`).catch(() => {})
}
/** 位置变了就重算「气泡往哪边」——她走动 / 掉下来 / 被拖到屏幕上下边缘时都要跟着翻。 */
function watchBubbleSide() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    try { pushCornerToRenderer() } catch {}
  }, 300).unref?.()
}
let lastWorkKey = ''
// 人物大小倍率（服务端 /config 的 scale，0.5~2.0）：整窗等比缩放 = setSize + setZoomFactor，
// 布局（舞台/气泡/字体）随 zoom 一起缩，物理身体盒由 bodyBox 按窗口宽反推，天然对上。
// 2026-11-05 改成 dsh-pet 的 16:9 口径：舞台 462×260（= 462 × 9/16），窗口宽 502 = 20 左边距 + 462 舞台 + 20 右边距。
// 以前是 280 宽 + 240×360 竖版舞台，靠裁切放大把人物撑满；那个做法会把素材里留给特效的
// 画布切掉（见 index.html 顶部舞台注释），所以整包改成「画布同比例 + contain 铺满」。
const BASE_W = 502, BASE_H = 430 // createWindow 的原始窗口尺寸（缩放的基准；BASE_H 只是「气泡全开」的上限，见 H_MAX_BASE）
let curScale = 1
// 当前「贴合内容」所需的基础高度（缩放前 px，由渲染页按气泡是否显示上报，见 pet:fit）。
// applyScale 必须乘它、而不是 BASE_H：否则 /config 的 scale 一到达就把窗口按 430 重设，
// 刚缩掉的上方空白又被加回来（实测过：窗口先 290 后跳回 473）。
// 舞台高度 260：与素材 640×360 同比例（462 × 9/16 = 259.875 ≈ 260）。
// 渲染页的 #stage 高度必须与这里一致。
const STAGE_W_CSS = 462
const STAGE_H_CSS = 260
const REST_H = 16 + STAGE_H_CSS + 8 // 16(底距)+260(舞台)+8(顶距) = 284
let fitBaseH = REST_H
// 窗口尺寸守卫：真实尺寸必须恒等于「期望尺寸」。
// 实测故障：窗口被撑到 2081×1008 DIP（期望 252×346），人物钉在窗口底边，
// 于是人一路沉到任务栏下面；同时边界按期望高度算，物理上永远夹不住。
// 任何来源（DPI 缩放竞态 / setZoomFactor 与 setSize 交互 / 外部程序）改了尺寸，
// 都在这里拉回来。resizingSelf 防自激：我们自己 setSize 触发的那次 resize 直接放行。
let resizingSelf = false
// 容差：Windows 在 150% 缩放下 setSize(DIP) 会因物理像素取整读回 ±2px（252↔254）。
// 按 ±1 判会让守卫和这个舍入反复对打（实测每 20ms 一次 setSize，窗口一直在抖），
// 所以只纠正**明显**偏离（> SIZE_TOLERANCE），舍入抖动直接放行。
const SIZE_TOLERANCE = 8
// 冷却：真出问题时也别每帧都 setSize，1s 最多纠一次，避免自己把窗口线程打满。
let lastSizeFixAt = 0
function expectedWinSize() {
  return {
    w: Math.round(BASE_W * curScale),
    h: Math.round(fitBaseH * curScale),
  }
}
function enforceWindowSize(why) {
  if (!win || win.isDestroyed() || resizingSelf) return
  try {
    const { w: ew, h: eh } = expectedWinSize()
    const [w, h] = winSizeDip()
    if (Math.abs(w - ew) <= SIZE_TOLERANCE && Math.abs(h - eh) <= SIZE_TOLERANCE) return
    const now = Date.now()
    if (now - lastSizeFixAt < 1000) return
    lastSizeFixAt = now
    appendDebugLog({ kind: 'size-fix', why: String(why || ''), from: [w, h], to: [ew, eh], fitBaseH, curScale })
    resizingSelf = true
    try {
      win.setResizable(true)
      setSizeDip(ew, eh)
      win.setResizable(false)
    } finally { resizingSelf = false }
    // 尺寸变了，抛掷空间缓存必须作废（边界是按窗口高算的）
    invalidateThrowSpace()
  } catch {}
}
// 松手后落地开关（服务端 /config 的 releaseLand）：开 = 按甩出速度抛出去并落回地面（原行为）；
// 关 = 拖到哪松手就停在哪（不抛也不落，连「温柔放下」的原地掉落也一并停掉）。
// 拦截点放主进程 pet:throw 一处：渲染页的甩抛（pet:throw）和原地掉落（throwWith(0,0)）都走这条通道。
let releaseLand = true
// 上游 1.0.14：右键「查看余额」显隐 / 动画节奏倍率。缺省值与上游一致（余额默认开、节奏 1 = 正常）。
let balanceEnabled = true
let animRate = 1
let lastAnimRate = 1
// 上游 1.0.12：小屋开关（右键「回小屋」显隐；素材没放时进屋会提示「素材未就绪」）
let houseEnabled = true
/** 把动画节奏倍率推给渲染页：渲染页 scheduleIdle 的间隔 ÷ 它（>1 更活泼）。
 *  独立于 pushPackToRenderer —— 包没变、只改节奏时也要即时生效（9 秒轮询的配置刷新路径）。 */
function pushAnimRate() {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`window.__setAnimRate && window.__setAnimRate(${JSON.stringify(animRate)})`).catch(() => {})
}
function applyScale(s) {
  if (!win || win.isDestroyed()) return
  const v = Math.min(2, Math.max(0.5, Number(s) || 1))
  // zoom 每次都要对齐：窗口尺寸可能已被 pet:fit 改成 v 倍，
  // 而 zoomFactor 若没跟上（例如只走了改尺寸那条路），人物就会比窗口「大一圈」，
  // 视觉上像卡住/错位。这里强制同步，不再依赖 curScale 的差值判断。
  try {
    if (Math.abs((win.webContents.getZoomFactor() || 1) - v) > 0.01) win.webContents.setZoomFactor(v)
  } catch {}
  if (Math.abs(v - curScale) < 0.01) return
  curScale = v
  resizingSelf = true
  try {
    // 高度跟当前贴合值走，别按 430 撑回原样；尺寸意图一律 DIP，经 setSizeDip 换算（上游 2026-11-07）
    setSizeDip(Math.round(BASE_W * v), Math.round(fitBaseH * v))
  } catch {} finally { resizingSelf = false }
  invalidateThrowSpace() // 尺寸变了，边界缓存作废
}
async function refreshConfig() {
  try {
    const cfg = await apiGet('/config')
    if (cfg && cfg.ok) {
      // 比较时剔掉 atTop：它只影响翻不翻布局，由 __setCorner 单独处理。
      // 留着它会让「改出生点」被误判成「换素材包」→ 重推整份素材表 → __setPack 重置裁切并重播动画 → 闪一下。
      const changed = packSig(pack) !== packSig(cfg.pack || null)
      const prevCorner = cornerKey(pack)
      pack = cfg.pack || null
      focusOn = cfg.focus === true
      applyScale(cfg.scale)
      // 出生点：① 启动后第一次拿到 /config —— 摆到面板设定的角落；
      //         ② 之后面板改了角落/边距 —— 立刻挪过去（这是主人明确要求改的，不能被「只做一次」挡住）；
      //         ③ 其余轮询一律不动她，主人自己拖到哪儿就是哪儿。
      // cornerKey 每次现算：pack 对象每 9 秒被整个换掉，挂在 pack 上的标记活不过一轮。
      const nowCorner = cornerKey(pack)
      if (!positionApplied || nowCorner !== prevCorner) {
        positionApplied = true
        // 注意：这里**不能**再调 pushPackToRenderer()。__setPack 会 resetStageCrop + playStill，
        // 等于把动画从头重播一遍——每 9 秒一轮配置就会「闪」一次。
        // atTop 只需要翻布局，下面单独推一个轻量标记就够了。
        pushCornerToRenderer()
        try { goHome() } catch {}
      }
      releaseLand = cfg.releaseLand !== false
      // 上游 1.0.14 / 1.0.12：互动开关与节奏（缺省值 = 老行为，配置没下发时零退化）
      balanceEnabled = cfg.balanceEnabled !== false
      houseEnabled = cfg.houseEnabled !== false
      // 抓鼠标两闸：`=== true` 口径（默认关，与服务端 petClickChase()/petTeaseChase() 完全同口径）
      clickChase = cfg.clickChase === true
      teaseChase = cfg.teaseChase === true
      animRate = (() => {
        const v = Number(cfg.animRate)
        return Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(0.5, v)) : 1
      })()
      if (animRate !== lastAnimRate) { lastAnimRate = animRate; pushAnimRate() }
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
      // 待办配置（同一条路径：面板改键后要能跟上来，不能只在启动注册一次）
      const td = cfg.todo || {}
      todoCfg = {
        enabled: td.enabled !== false,
        hotkey: String(td.hotkey || '').trim(),
        pending: (td.pending && typeof td.pending === 'object') ? td.pending : { local: 0, dsh: 0, total: 0 },
      }
      applyTodoHotkey()
      // 多开：按面板「再养几只」补齐 / 收掉差额。
      // 只在数量真的对不上时才动，且不在这里做「重建」——把多余的收掉、缺的补上，
      // 已经开着的那几只保持原位不动（每次 refreshConfig 重建会让它们满屏乱跳）。
      // 每只的形象包 / 大小（extraSlots）走 applySlot：能就地换的（换包、改缩放）绝不重建窗口。
      {
        const want = Math.max(0, Math.min(MULTI_MAX, Math.round(Number(cfg.extraPets) || 0)))
        const slots = Array.isArray(cfg.extraSlots) ? cfg.extraSlots : []
        // 每只自己那个包的完整视图（服务端算好的）：先灌进查询表，下面 pushPack 才取得到
        if (cfg.extraPackViews && typeof cfg.extraPackViews === 'object') {
          extraPackViews.clear()
          for (const [name, view] of Object.entries(cfg.extraPackViews)) {
            if (view && view.name) extraPackViews.set(String(name), view)
          }
        }
        const api = want > 0 ? initMultiPets() : multiApi
        if (api) {
          const have = api.size()
          if (want > have) {
            // 补差额时按**缺的槽位**建，不是按数量建：槽位是身份，插在中间的那个空档要能补上
            for (const s of slots.slice(0, want)) {
              if (!api.get(`pet-${s.slot + 1}`)) api.create({ slot: s.slot, pack: s.pack, scale: s.scale })
            }
          } else if (want < have) {
            // 从槽位大的开始收，保留前面原位的那几只
            const ids = api.list().filter((p) => p.slot >= want).map((p) => p.id)
            for (const id of ids) api.close(id)
          }
          // 已经在的那几只：就地换包 / 改大小（面板改完立刻生效，不必重启）
          for (const s of slots) {
            const rec = api.get(`pet-${s.slot + 1}`)
            if (!rec) continue
            api.applySlot({ slot: s.slot, pack: s.pack, scale: s.scale })
          }
        }
      }
      // 按住说话配置（开关 + 识别后去向）
      const hr = cfg.hear || {}
      hearCfg = { enabled: hr.enabled !== false, sendToChat: hr.sendToChat !== false }
      if (changed || !win.__packPushed) { win.__packPushed = true; pushPackToRenderer(); pushPackToExtras() }
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
/**
 * 播放语音（从 dsh-pet 的 voiceEnabled 搬来）：渲染页里用 Audio 播，主进程只管把地址递过去。
 * 失败一律静默——语音出不来不该影响气泡本身。
 */
async function playVoice(audio, volume) {
  if (!win || win.isDestroyed()) return
  const url = audio && (audio.url || audio) ? (audio.url || audio) : ''
  if (!url) return
  // 相对地址（/aurabot/api/audio/xxx）要补上 host，渲染页是 file:// 页面，拿不到相对路径
  let full = String(url)
  if (!/^https?:\/\//i.test(full)) {
    const host = readHost()
    if (!host) return
    full = `${host.baseUrl}${full.startsWith('/') ? '' : '/'}${full}`
  }
  const vol = Number.isFinite(Number(volume)) ? Math.max(0, Math.min(1, Number(volume))) : 1
  try {
    await win.webContents.executeJavaScript(`window.__playVoice && window.__playVoice(${JSON.stringify(full)}, ${vol})`)
  } catch {}
}
async function showBubble(text, mood, modality, anim, playbackId, purpose, tagOverride, audio, voiceVolume, big) {
  if (!win) return
  const secs = Math.min(30, Math.max(6.5, 4.5 + String(text).length * 0.11))
  // 标签：菜单「碎碎念」/ 定时碎碎念 / 干活结束各有各的标签，别都标成「主动来找你」
  const tag = tagOverride || BUBBLE_TAG[purpose] || ''
  // big（上游 1.0.15）：余额这类「一句话要看清」的内容走大字模式；不传就是普通气泡
  const js = `window.__bubble && window.__bubble(${JSON.stringify(String(text || ''))}, ${JSON.stringify(String(mood || 'neutral'))}, ${secs}, ${JSON.stringify(String(anim || ''))}, ${JSON.stringify(String(playbackId || ''))}, ${JSON.stringify(tag)}, '', ${big === true ? 'true' : 'false'})`
  try {
    const played = await win.webContents.executeJavaScript(js)
    // __bubble 返回实际起播的动画与回执号（没有可用素材时 anim 为空 → 不上报）
    if (played && played.playbackId) apiPost('/playback', { playbackId: played.playbackId, anim: played.anim || '', status: 'played' })
  } catch {}
  // 语音：气泡先出，声音跟上（不等它，避免 TTS 慢把气泡拖住）
  if (audio) playVoice(audio, voiceVolume).catch(() => {})
}
/** 让**某一只额外宠物**说一句话（与 showBubble 同一套时长/标签口径）。
 *  语音不跟：额外那几只一律纯文字（服务端也不给它们合成 TTS）。 */
function showBubbleOn(petId, text, mood, anim, playbackId, purpose, tagOverride) {
  if (!multiApi) return
  const secs = Math.min(30, Math.max(6.5, 4.5 + String(text).length * 0.11))
  const tag = tagOverride || BUBBLE_TAG[purpose] || ''
  multiApi.bubble(petId, text, mood, secs, anim, playbackId, tag)
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
        if (e.type === 'pack') { pack = null; win.__packPushed = false; refreshConfig(); if (multiApi) multiApi.pushPackAll(); continue }
        if (e.type === 'work') { applyWork(e); continue }
        if (e.type === 'behavior' && !firstBoot) { handleBehavior(e); continue } // 下发层：行为动作单
        if (e.type === 'proactive' && String(e.text || '').trim() && !firstBoot) {
          // 气泡投给谁：事件里带 petId 的（多开时每只各自的人格碎碎念）只投给那一只；
          // 不带的（主动搭话 / 干活提示 / 待办，全都有 QQ 语义）照旧投给主宠物。
          const targetId = String(e.petId || 'main')
          // 说话让路：记下「主气泡挂到什么时候」，攒着的话要等它收起来才补（口径与 showBubble 的时长一致）
          if (targetId === 'main') bubbleUntilLocal = Date.now() + Math.min(30, Math.max(6.5, 4.5 + String(e.text || '').length * 0.11)) * 1000
          if (targetId !== 'main' && multiApi && multiApi.get(targetId)) {
            showBubbleOn(targetId, e.text, e.mood, e.anim, e.playbackId, e.purpose, '', e.audio, e.voiceVolume)
          } else {
            await showBubble(e.text, e.mood, e.modality, e.anim, e.playbackId, e.purpose, '', e.audio, e.voiceVolume)
          }
        } else if (e.type === 'life' && !firstBoot) {
          // 数值事件（饿 / 困 / 升级）：刷新一下缓存，让状态卡下次弹就是新的；
          // 气泡本身由服务端 saySoon 统一发，这里不重复冒。
          lifecycleCache = null
          if (e.event === 'bond.levelUp' || e.event === 'life.snack') lifecycleCache = null
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
        } else if (e.type === 'debugCrop') {
          // 诊断：插件侧要「人物包围盒 vs 舞台」的真实数据（查动画被切掉用）
          let r = null
          try { r = await debugCrop() } catch (err) { r = { threw: String(err && err.message || err) } }
          appendDebugLog({ kind: 'debugCrop', askId: e.askId, r })
          apiPost('/debug/report', { kind: 'crop', id: e.askId, result: r })
        } else if (e.type === 'debugMeasure') {
          let r = null
          try { r = await debugMeasure(e.anim, e.samples) } catch (err) { r = { threw: String(err && err.message || err) } }
          appendDebugLog({ kind: 'debugMeasure', askId: e.askId, r })
          apiPost('/debug/report', { kind: 'measure', id: e.askId, result: r })
        } else if (e.type === 'debugProbe') {
          let r = null
          try { r = await debugProbe(e.x, e.y) } catch (err) { r = { threw: String(err && err.message || err) } }
          apiPost('/debug/report', { kind: 'probe', id: e.askId, result: r })
        } else if (e.type === 'debugSnapshot') {
          let r = null
          try { r = await debugSnapshot() } catch (err) { r = { threw: String(err && err.message || err) } }
          apiPost('/debug/report', { kind: 'snapshot', id: e.askId, result: r })
        } else if (e.type === 'debugIpc') {
          // 诊断：让主进程做只有它才能做的事（开关待办小窗这类）。渲染页管不到这些窗口。
          let r = null
          try {
            const act = String(e.act || '')
            if (act === 'todo-open') { openTodoWin(); r = { open: true } }
              // 对话框开/关 + 位置回读：面板「试一下」和回归测试都要能不动键盘验证定位。
              // 为什么需要它：Alt+P 是全局快捷键，脚本/CI 里按不出来，而定位对不对
              // （尤其「对话框跑到人物下面」那个 bug）只能靠**真实窗口坐标**验证。
              else if (act === 'chat-open') { if (!chatWinAlive()) openChatWin(); r = { open: chatWinAlive() } }
              else if (act === 'chat-close') { closeChatWin(); r = { open: false } }
              else if (act === 'chat-bounds') {
                if (!chatWin || chatWin.isDestroyed()) r = { open: false, exists: false }
                else {
                  const [cx, cy] = chatWin.getPosition()
                  const [cw, ch] = chatWin.getSize()
                  const b = bodyScreenRect()
                  r = {
                    open: chatWinAlive(), exists: true,
                    chat: { x: cx, y: cy, width: cw, height: ch },
                    body: b ? { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) } : null,
                    // 判定：对话框不该压在人物身上（水平上要么在右、要么在左）
                    clear: b ? (cx >= b.right || cx + cw <= b.left) : null,
                  }
                }
              }
            else if (act === 'todo-close') { closeTodoWin(); r = { open: false } }
            else if (act === 'todo-state') r = (() => {
              if (!todoWin || todoWin.isDestroyed()) return { open: false, exists: false }
              return {
                open: todoWinAlive(), exists: true,
                visible: todoWin.isVisible(), destroyed: todoWin.isDestroyed(),
                bounds: todoWin.getBounds(), opacity: todoWin.getOpacity(),
                focused: todoWin.isFocused(), alwaysOnTop: todoWin.isAlwaysOnTop(),
                boundsScreen: screen.getDisplayMatching(todoWin.getBounds()).workArea,
              }
            })()
            // 多开（诊断 / 面板入口）：开一只、收一只、收全部、查状态
            else if (act === 'pet-add') r = { id: addExtraPet(), count: multiApi ? multiApi.size() : 0 }
            else if (act === 'pet-close-all') r = { closed: multiApi ? multiApi.closeAll() : 0, count: multiApi ? multiApi.size() : 0 }
            else if (act === 'pet-list') r = { count: multiApi ? multiApi.size() : 0, list: multiApi ? multiApi.list() : [], max: multiApi ? multiApi.MAX_EXTRA_PETS : 0 }
            // 面板改完某只的名字/形象包/大小 → 立刻就地生效（不重建窗口、不动位置）
            else if (act === 'pet-apply-slots') {
              const slots = Array.isArray(e.slots) ? e.slots : []
              const api = slots.length ? initMultiPets() : multiApi
              if (api) for (const s of slots) api.applySlot(s)
              r = { applied: slots.length, count: multiApi ? multiApi.size() : 0 }
            }
            // 面板直接设只数：与 refreshConfig 同一套「补差额、不重建」逻辑
            else if (act === 'pet-set-count') {
              const want = Math.max(0, Math.min(MULTI_MAX, Math.round(Number(e.count) || 0)))
              const api = want > 0 ? initMultiPets() : multiApi
              if (api) {
                const have = api.size()
                if (want > have) for (let i = have; i < want; i++) api.create({})
                else if (want < have) {
                  // 槽位大的先收（保留前面原位那几只）
                  const ids = api.list().filter((p) => p.slot >= want).map((p) => p.id)
                  for (const id of ids) api.close(id)
                }
              }
              // 收/放是异步的（窗口 close 走事件），等一下再报实际数量
              await new Promise((r) => setTimeout(r, 600))
              r = { count: multiApi ? multiApi.size() : 0, want }
            }
            // 诊断：量某只额外宠物渲染页里的真实几何（视口/舞台/视频盒/zoom）
            else if (act === 'pet-fix-size') {
              const rec = multiApi && multiApi.get(e.petId || '')
              if (!rec || !rec.win || rec.win.isDestroyed()) r = { error: '没有这只宠物' }
              else {
                const before = rec.win.getBounds()
                const expect = { w: Math.round(502 * rec.scale), h: Math.round(Math.max(284, rec.fitBaseH) * rec.scale) }
                multiApi.enforceSize(rec, true)
                const right = rec.win.getBounds()
                await new Promise((res) => setTimeout(res, 900))
                const later = rec.win.getBounds()
                r = { id: rec.id, scale: rec.scale, fitBaseH: rec.fitBaseH, zoom: rec.win.webContents.getZoomFactor(), before, expect, right, later }
              }
            }
            // 诊断：量某只额外宠物渲染页里的真实几何（视口/舞台/视频盒/zoom）
            else if (act === 'pet-info') {
              const rec = multiApi && multiApi.get(e.petId || '')
              r = (rec && rec.win && !rec.win.isDestroyed())
                ? rec.win.webContents.executeJavaScript(`(() => {
                    const st = document.getElementById('stage')
                    const v = document.querySelector('.anim-slot.is-front') || document.querySelector('.anim-slot')
                    const rr = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
                    return {
                      innerW: window.innerWidth, innerH: window.innerHeight,
                      dpr: window.devicePixelRatio,
                      zoom: (window.outerWidth && window.innerWidth) ? +(window.outerWidth / window.innerWidth).toFixed(3) : null,
                      stage: rr(st), video: rr(v),
                      stageCss: st ? { left: getComputedStyle(st).left, top: getComputedStyle(st).top, w: getComputedStyle(st).width, h: getComputedStyle(st).height } : null,
                      vp: { bodyW: document.body.clientWidth, bodyH: document.body.clientHeight },
                    }
                  })()`).then((x) => ({ ...x, bounds: rec.win.getBounds(), zoomFactor: rec.win.webContents.getZoomFactor() }))
                : { error: '没有这只宠物' }
            }
            // 诊断：把某只额外宠物自己抓一张（capturePage 不受别的窗口遮挡影响）
            else if (act === 'pet-snap') {
              const rec = multiApi && multiApi.get(e.petId || '')
              r = rec && rec.win && !rec.win.isDestroyed()
                ? rec.win.webContents.capturePage().then((img) => ({ dataUrl: img.isEmpty() ? '' : img.toDataURL(), bounds: rec.win.getBounds(), visible: rec.win.isVisible() }))
                : { error: '没有这只宠物' }
            }
            else if (act === 'pet-fling') r = { ok: Boolean(multiApi && multiApi.fling(e.petId || '', Number(e.vx) || 600, Number(e.vy) || -400)) }
            // 诊断：直接挪某只额外宠物（等价于它自己拖自己），用来验证「拖小只不会把大只带走」
            else if (act === 'pet-move') r = { ok: Boolean(multiApi && multiApi.moveTo(e.petId || '', Number(e.x), Number(e.y))) }
            // 诊断：主宠物当前窗口位置（验证隔离用）
            else if (act === 'main-bounds') r = (win && !win.isDestroyed()) ? { bounds: win.getBounds() } : { bounds: null }
            // 诊断/测试：把**主宠物**挪到绝对坐标（验证气泡方向用）。
            // pet-move 只认额外那几只（走 multiApi），主宠物没有入口 ——
            // 脚本里就没法把她摆到屏幕底去验证「气泡会不会翻回头上」。
            else if (act === 'main-move') {
              if (!win || win.isDestroyed()) r = { ok: false, why: 'no-window' }
              else {
                const mx = Math.round(Number(e.x)); const my = Math.round(Number(e.y))
                if (!Number.isFinite(mx) || !Number.isFinite(my)) r = { ok: false, why: 'bad-coord' }
                else { win.setPosition(mx, my); r = { ok: true, bounds: win.getBounds() } }
              }
            }
            else r = { threw: '未知的 act：' + act }
          } catch (err) { r = { threw: String(err && err.message || err) } }
          try { r = await r } catch (err) { r = { threw: String(err && err.message || err) } }
          appendDebugLog({ kind: 'debugIpc', act: e.act, r: (r && r.dataUrl) ? { ...r, dataUrl: '<img ' + String(r.dataUrl).length + 'b>' } : r })
          apiPost('/debug/report', { kind: 'ipc', id: e.askId, result: r })
        } else if (e.type === 'debugBubble') {
          // 气泡预览（调样式用）：直接写一条气泡，不走载体判定、不占碎碎念配额。
          let r = null
          try {
            const text = String(e.text || '测试气泡')
            const secs = Math.max(3, Number(e.secs) || 60)
            r = await win.webContents.executeJavaScript(
              `(() => {
                 window.__bubble(${JSON.stringify(text)}, 'neutral', ${secs}, '', '', ${JSON.stringify(String(e.tag || ''))});
                 const b = document.getElementById('bubble');
                 const rc = b.getBoundingClientRect();
                 return { w: Math.round(rc.width), h: Math.round(rc.height),
                          maxW: getComputedStyle(b).maxWidth,
                          fontSize: getComputedStyle(b).fontSize,
                          winH: window.innerHeight };
               })()`
            )
          } catch (err) { r = { threw: String(err && err.message || err) } }
          apiPost('/debug/report', { kind: 'bubble', id: e.askId, result: r })
        } else if (e.type === 'debugAlpha') {
          // alpha 修正开关（诊断）：开/关各拍一张，用像素统计证明透明区真的归零了。
          // 关掉时 WebM 的「透明」区会以 alpha=1/255 合成，浅色壁纸上就是一层淡灰矩形。
          let r = null
          try {
            const on = e.on === true
            const applied = await win.webContents.executeJavaScript(`window.__setAlphaFix && window.__setAlphaFix(${on ? 'true' : 'false'})`)
            r = { on, applied: Boolean(applied) }
          } catch (err) { r = { threw: String(err && err.message || err) } }
          apiPost('/debug/report', { kind: 'alpha', id: e.askId, result: r })
        } else if (e.type === 'debugBaifan') {
          // 玩法自检（2026-11-05）：报当前能不能开演、5 个槽位解析成什么、现在在不在跑。
          // 没有这条就只能靠肉眼点菜单，出问题分不清「素材没下发」还是「导演没跑起来」。
          // e.act === 'start' / 'halt' 时兼作开演/收场按钮（面板与自动化都走这条）。
          let r = null
          try {
            if (e.act === 'start') toggleBaifan()
            else if (e.act === 'halt') interruptBaifan('debug')
            r = await win.webContents.executeJavaScript('window.__bfInfo ? window.__bfInfo() : null')
          } catch (err) { r = { threw: String(err && err.message || err) } }
          appendDebugLog({ kind: 'debugBaifan', askId: e.askId, r })
          apiPost('/debug/report', { kind: 'baifan', id: e.askId, result: r })
        } else if (e.type === 'debugShot') {
          // 点播指定动画 → 等它真出画 → 截图。用来逐个核对「这段有没有被切」。
          let r = null
          try { r = await debugShot(e.anim, Number(e.waitMs) || 0) } catch (err) { r = { threw: String(err && err.message || err) } }
          apiPost('/debug/report', { kind: 'shot', id: e.askId, result: r })
        } else if (e.type === 'debugDump') {
          // 导出原始画布帧（带红框标画布边界）：判断「被切」是素材本身还是我们裁的
          let r = null
          try {
            r = await win.webContents.executeJavaScript(`window.__dumpFrame ? window.__dumpFrame(${JSON.stringify(String(e.anim || ''))}, ${Number(e.at) || 0}) : null`)
          } catch (err) { r = { threw: String(err && err.message || err) } }
          if (r && r.ok && r.dataUrl) {
            // 落盘成 png，别把几百 KB base64 塞进 HTTP
            try {
              const b64 = String(r.dataUrl).replace(/^data:image\/png;base64,/, '')
              const f = path.join(__dirname, `frame-${String(e.anim || 'x')}.png`)
              fs.writeFileSync(f, Buffer.from(b64, 'base64'))
              r.file = f
            } catch (err) { r.writeError = String(err && err.message || err) }
            delete r.dataUrl
          }
          apiPost('/debug/report', { kind: 'dump', id: e.askId, result: r })
        } else if (e.type === 'debugAudit') {
          // 全量裁切自检：渲染页里逐段量包围盒（读真实 DOM 几何，不手算）
          let r = null
          try { r = await win.webContents.executeJavaScript(`window.__cropAudit ? window.__cropAudit(${Number(e.limit) || 0}) : null`) } catch (err) { r = { threw: String(err && err.message || err) } }
          appendDebugLog({ kind: 'cropAudit', ok: !!(r && r.checked), overCount: r && r.overCount })
          apiPost('/debug/report', { kind: 'audit', id: e.askId, result: r })
        }
      }
      refreshConfig() // 便宜：跟着轮询节奏对齐包配置与素材路由（新放素材也能被发现）
      await sleep(50)
    } catch {
      hadError = true
      attempt++
      // 父进程守护：插件（DSH）关掉之后，没有人会来停这个小窗，
      // 它会一直重连、一直留在屏幕上。连续失败超过上限就自己退出——
      // 12 次 × 平均 9 秒 ≈ 两分钟，够 DSH 重启（换端口）而不至于变成孤儿。
      if (attempt >= ORPHAN_MAX_ATTEMPTS) {
        console.error(`[pet] 连续 ${attempt} 次连不上插件，判定 DSH 已退出，桌宠自行关闭`)
        try { app.quit() } catch { process.exit(0) }
        return
      }
      await sleep(Math.min(15_000, 1500 + attempt * 1500)) // 出错退避，并重读 host.json（端口可能漂了）
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 甩抛物理循环（P3：physics.throwStep，参数可被 pack 配置 physics 段覆盖） ----------
// 两个坑（都是「扔出去就卡死」的直接原因）：
//   1) 不能用 setImmediate 递归驱动：每秒会跑几千帧，每帧同步调一次 win.setPosition，
//      主进程/窗口线程被空转调用打满，桌宠看起来就定住了。这里固定 60fps。
//   2) 边界必须用真实身体盒：素材是 640×360（16:9），人物画在中下部透明框里；
//      2026-11-05 起舞台改成同比例 462×260 + contain，整块画布都在框内，
//      所以「可见身体」就是舞台外框本身（不再有裁切放大）。
//      按舞台反推即可。若按 宽×9/16 当身体高，静止点会比屏幕底还低 183px —— 一扔就掉出屏幕外再也不回来。
const THROW_FRAME_MS = 16   // ≈60fps
const THROW_MAX_MS = 10000  // 一次抛掷最多算 10 秒，之后强制落地（兜底，绝不留半空死状态）
// 舞台外框（2026-11-05：462×260，与素材 640×360 同比例）。
// 注意：这是「舞台」而不是「可见身体」—— contain 下人物只占舞台中间一块，
// 但拖拽/命中/物理都按舞台算最省事，也和 dsh-pet 的「盒 = 舞台」口径一致
// （它的 .dsh-pet-stage 就是 462×260，命中框 HIT_BOX 按 640×360 的百分比换算）。
const BODY = { left: 20, bottom: 16, width: 462, height: 260 } // 与 index.html 的 #stage 一致
let thrower = null          // 抛掷循环定时器句柄（非空 = 正在飞）

/** 可见身体（#stage）在窗口内的盒子：offsetX/offsetY 是身体左上角相对窗口左上角的偏移。
 *  入参 w/h 必须是 winSizeDip() 的 DIP 意图尺寸。
 *
 *  E2E 实测教训（上游 2026-11-07）：缩放倍率不能再按「窗口宽 / 280」反推——dsf≠1 时
 *  win.getSize() 的单位语义会漂（可能已是物理像素），反推出来的倍率是错的，身体盒跟着被放大、
 *  钳制边界全落在屏外，表现就是「拖不动 / 掉到任务栏下面」。
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

// ---------- 尺寸单位自标定（上游 2026-11-07 E2E 补的，DPI 错位这一族的另一半）----------
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
// ---------- 身体左右透明边余量（dsh-pet 的 sideAllow）----------
// 命中区 = 人物的紧包围盒，坐标沿用 dsh-pet 的 640×360 素材画布（HIT_BOX）。
// 舞台里人物居中，左右各留一块透明区；边界要**按身体贴边**而不是按舞台贴边，
// 所以允许量正好等于这块透明区的宽度（dsh-pet 的 sideAllow = HIT_BOX.x0/640 × size，
// 我们命中区居中，左右相同）。
//
// ⚠ 这里有个坑，踩过一次：dsh-pet 还有另一个量 reachInset（命中区至少留 MIN_REACHABLE_PX 在屏内），
// 那是给**网页版 clampReachableBox / Linux 窗口落位**用的，允许多挂出去上百 px；
// 抛掷、漫游、拖拽用的都是 sideAllow。两者别混 —— 混了就会「身体离屏幕边差一大截」或者「半只挂出屏幕」。
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 }
/** 命中区在身体盒内的像素矩形（body = bodyBox() 的结果）。 */
function hitBoxOf(body) {
  return {
    x: (HIT_BOX.x0 / 640) * body.width,
    y: (HIT_BOX.y0 / 360) * body.height,
    w: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * body.width,
    h: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * body.height,
  }
}
/** 左右透明边余量：身体左右缘各留这么多才是人物本体。
 *  边界按「身体缘 ∓ 这个值」算，人物边缘就正好能贴到屏幕上。 */
function sideInsetOf(body) {
  const hit = hitBoxOf(body)
  return {
    left: Math.max(0, Math.round(hit.x)),
    right: Math.max(0, Math.round(body.width - (hit.x + hit.w))),
  }
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
/** 把窗口拉回**可见的**工作区。
 *  必须按**窗口整体**判，不能只看左上角：左上角在屏内、窗口下半截伸到屏幕外，
 *  用户看到的就是「人跑到屏幕下面去了」。
 *  规则：窗口完全落在某块屏工作区内就原样不动；否则夹进最近的那块。 */
function clampWindowToArea() {
  if (!win || win.isDestroyed()) return
  // 先纠正尺寸：夹取必须按真实窗口算，尺寸错了怎么夹都还是会出界。
  enforceWindowSize('clamp')
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  const ds = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
  const areas = ds.map((d) => d.workArea)
  let bestX = Math.round(wx)
  let bestY = Math.round(wy)
  let bestD = Infinity
  for (const a of areas) {
    const cx = Math.round(Math.min(Math.max(wx, a.x), a.x + Math.max(0, a.width - w)))
    const cy = Math.round(Math.min(Math.max(wy, a.y), a.y + Math.max(0, a.height - h)))
    if (cx === Math.round(wx) && cy === Math.round(wy)) { bestX = cx; bestY = cy; bestD = 0; break }
    // 横向跨缝允许（窗口横跨两块屏是正常的），纵向严格夹住。
    // 只有一块屏时绝不能走这条，否则 overlapsX 恒真、横向就完全不受限了。
    const overlapsX = wx + w > a.x && wx < a.x + a.width
    const touchesNeighbor = areas.some((o) => o !== a &&
      (Math.abs(o.x - (a.x + a.width)) <= 1 || Math.abs(a.x - (o.x + o.width)) <= 1))
    if (touchesNeighbor && overlapsX && cy === Math.round(wy)) { bestX = Math.round(wx); bestY = cy; bestD = 0; break }
    const dx = wx - cx
    const dy = wy - cy
    const d2 = dx * dx + dy * dy
    if (d2 < bestD) { bestD = d2; bestX = cx; bestY = cy }
  }
  if (bestX !== Math.round(wx) || bestY !== Math.round(wy)) setWinPos(bestX, bestY)
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
// 逃生网（自愈「跑到屏幕外」）：每 30s 查一次，两件事——
//   ① 尺寸正反馈拉回（上游 2026-11-07）：窗口被撑得远超期望尺寸时，直接按期望尺寸 setSizeDip。
//      只做「可见面积不足就挪位置」是不够的：窗口被撑大时人是钉在底边的，挪回屏内也还是看不见。
//   ② 可见面积不足 20%（基本看不见了）才拉回最近工作区。正常的贴边摆放/跨屏/压任务栏不受打扰。
setInterval(() => {
  if (!win || win.isDestroyed()) return
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  // ① 尺寸正反馈：任一边偏离期望超过 max(40, 期望*0.25) 就按期望改回去
  const expW = Math.round(BASE_W * curScale)
  const expH = Math.round(fitBaseH * curScale)
  const tolW = Math.max(40, expW * 0.25)
  const tolH = Math.max(40, expH * 0.25)
  if (Math.abs(w - expW) > tolW || Math.abs(h - expH) > tolH) {
    appendDebugLog({ kind: 'escape-size', from: [w, h], to: [expW, expH], curScale })
    resizingSelf = true
    try { setSizeDip(expW, expH) } finally { resizingSelf = false }
    invalidateThrowSpace()
  }
  // ② 可见面积：重新读一次（上面可能刚改过尺寸）
  const [w2, h2] = winSizeDip()
  const d = virtualDesktopBounds()
  const visW = Math.max(0, Math.min(wx + w2, d.x + d.w) - Math.max(wx, d.x))
  const visH = Math.max(0, Math.min(wy + h2, d.y + d.h) - Math.max(wy, d.y))
  if (visW * visH < w2 * h2 * 0.2) clampWindowToArea()
}, 30_000)
// 多开的尺寸巡检：主宠物的尺寸守卫在上面那条 60ms 光标轮询里（enforceWindowSize），
// 额外那几只没有光标轮询，所以每 2 秒各查一次。气泡收起后只要有一条 fit 没送到，
// 窗口就会留着一截多出来的高度（人底下空一块）—— 这条就是它的兜底。
setInterval(() => {
  try { if (multiApi && multiApi.sweepSizes) multiApi.sweepSizes() } catch {}
}, 2_000).unref?.()
// 显示器热更新（dsh-pet 的 display-sync）：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。
// 之前只在启动时算一次，运行期永不更新 —— 拔掉一块屏或改分辨率后，桌宠的边界就永远错着，
// 表现成「贴着不存在的边弹回来」或「掉进空洞里看不见」。事件会连发，去抖后只处理一次。
let displayTimer = null
/** 上一次的屏工作区快照：拓扑变化时用来做「世界坐标守恒」换算。 */
let prevAreas = null
function snapshotAreas() {
  try {
    const ds = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
    return ds.map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height }))
  } catch { return null }
}
/** 显示器拓扑变化后就地重挂（dsh-pet 的 relayout）：
 *  - 拖拽中不动（用户正握着）
 *  - 飞行中不动（下一帧物理会按新边界夹取）
 *  - 其余情况：窗口**世界坐标守恒**地搬过去，只有真的落在空洞里才夹到最近屏。
 *  为什么不能直接 clamp：屏拓扑平移时，直接拿旧坐标去夹会让桌宠每次开合屏都漂一次。 */
function relayout(oldAreas) {
  if (!win || win.isDestroyed()) return
  invalidateThrowSpace()
  // 拖拽/飞行中不插手：位置由输入或物理驱动。
  // 注意 hitBusy 声明在后面（let 有暂时性死区），所以用 typeof 安全读。
  const busy = (typeof hitBusy !== 'undefined') && hitBusy
  if (busy || thrower) return
  const newAreas = snapshotAreas()
  if (!newAreas || !newAreas.length) return
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  // 世界坐标守恒（dsh-pet 的 rebaseCenter）：窗口左上角是**绝对屏幕坐标**，
  // 显示器拓扑变化不改变它的世界位置，所以「守恒」就是原地不动。
  // 只有两种情况需要动：
  //   ① 视口原点平移（多屏时外接矩形左上角变了）：此时绝对坐标本来就该跟着平移
  //   ② 真的不落在任何新屏里（屏被拔掉/分辨率变小）：夹进最近的屏
  let tx = wx
  let ty = wy
  if (Array.isArray(oldAreas) && oldAreas.length && newAreas.length) {
    const oldX = Math.min(...oldAreas.map((a) => a.x))
    const oldY = Math.min(...oldAreas.map((a) => a.y))
    const newX = Math.min(...newAreas.map((a) => a.x))
    const newY = Math.min(...newAreas.map((a) => a.y))
    // 原点平移量：屏布局整体挪动时，窗口跟着挪同样的量，视觉上才「没动」
    tx = wx + (newX - oldX)
    ty = wy + (newY - oldY)
  }
  const inAny = newAreas.some((a) => tx + w > a.x && tx < a.x + a.width && ty + h > a.y && ty < a.y + a.height)
  if (inAny) {
    // 可见：只在原点平移时挪（平移量为 0 就一点都不动，这就是守恒）
    if (tx !== wx || ty !== wy) setWinPos(Math.round(tx), Math.round(ty))
    return
  }
  // 落在空洞/已拔掉的屏上：夹进最近的屏
  clampWindowToArea()
}
const onDisplayChange = () => {
  if (displayTimer) clearTimeout(displayTimer)
  displayTimer = setTimeout(() => {
    displayTimer = null
    const old = prevAreas
    prevAreas = snapshotAreas()
    // 抛掷中先收尾，免得用旧空间继续积分飞到不存在的地方
    stopThrow()
    // 按世界坐标守恒重挂（拖拽/飞行中它会自己跳过）
    relayout(old)
    try { appendDebugLog({ kind: 'displays-changed', geo: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, work: d.workArea })) }) } catch {}
  }, 300)
  displayTimer.unref?.()
}
try {
  screen.on('display-metrics-changed', onDisplayChange)
  screen.on('display-added', onDisplayChange)
  screen.on('display-removed', onDisplayChange)
} catch {}
/** 构造抛掷空间（dsh-pet 的 throwSpace）：**逐屏一套 AABB**，而不是整个桌面一个大框。
 *  为什么必须逐屏：不规则多屏布局下外接矩形含大片不属于任何屏的空洞，
 *  拿外接矩形当边界会把桌宠扔进用户看不见的地方（这正是「跑到屏幕外」的根因之一）。
 *  panels 用 display.bounds（含任务栏区），areas 用 workArea：
 *  越界侧有没有邻屏必须按 panels 探测——任务栏位于屏缝时 workArea 之间会空出一条带，
 *  按 workArea 探测会把接缝当墙，桌宠永远穿不过去。 */
/** 抛掷空间缓存（dsh-pet 的 throwSpaceOf）：飞行中每帧重建是浪费，
 *  只在「屏拓扑 / 窗口尺寸 / 缩放」变化时重建。键用这些值的拼接。 */
let throwSpaceCache = null
let throwSpaceKey = ''
function buildThrowSpace(w, h) {
  const ds = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
  // 边界必须按**真实窗口高**算，不能用期望的 baseH。
  // 用 baseH 时若窗口被撑大（实测会到 1008 DIP），maxY 会按 346 算出来，
  // 窗口底边就落到 1014+1008=2022，整整沉到任务栏下面 —— 这正是「停下后慢慢超出屏幕底部」。
  const realH = Math.round(Number(h) || 0) || Math.round(REST_H * curScale)
  // 缓存键：屏拓扑 + 窗口尺寸 + 缩放。任何一项变了才重建。
  const key = ds.map((d) => `${d.workArea.x},${d.workArea.y},${d.workArea.width},${d.workArea.height}|${d.bounds.width}x${d.bounds.height}`).join(';')
    + `#${w}x${realH}@${curScale}`
  if (throwSpaceCache && throwSpaceKey === key) return throwSpaceCache
  const body = bodyBox(w, h)
  const reach = sideInsetOf(body)
  const areas = ds.map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height }))
  const panels = ds.map((d) => ({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }))
  const space = physics.throwSpace({
    areas,
    panels,
    bodyW: body.width,
    bodyH: body.height,
    offsetX: body.offsetX,
    offsetY: body.offsetY,
    winW: w,
    winH: realH,
    // 越界允许量按**命中区 + 可见下限**算（dsh-pet 新版 reachInset），不再是「舞台宽 × 8%」。
    // 旧口径 37px 是按舞台算的，而人物只占舞台中间一块，身体离屏幕边永远差 100 多 px 的透明空隙。
    reachLeft: reach.left,
    reachRight: reach.right,
  })
  // 注：参考实现的 `minY -= size * topInsetRatio` 只在 macOS 生效
  // （desktop-geometry.js: platform === 'darwin' ? ... : 0）。
  // Windows 上该值为 0，照搬会让窗口能顶出屏幕顶 13~21px，所以这里不做顶部内缩。
  throwSpaceCache = space
  throwSpaceKey = key
  return space
}
/** 屏拓扑变了：缓存作废。 */
function invalidateThrowSpace() {
  throwSpaceCache = null
  throwSpaceKey = ''
}
function startThrow(vx, vy) {
  if (!win || win.isDestroyed()) return
  stopThrow()
  stopMover()     // 甩飞时位置由物理接管：先掐掉行为移动循环
  stopMoveAnim()  // 也别踏步了——被扔出去还在原地踏步很怪
  const [wx, wy] = win.getPosition()
  const [w, h] = winSizeDip()
  // 逐屏抛掷空间（不是单屏 throwBounds）：跨屏飞行、屏缝穿越、空洞回避全靠它
  const space = buildThrowSpace(w, h)
  if (!space.areas.length) return
  const ph = { ...physics.DEFAULT_PHYSICS, ...(pack && pack.physics ? pack.physics : {}) }
  // 起始状态用**屏幕绝对坐标**（与 space 的 areas 同系），不再减 area.x/area.y：
  // 逐屏方案要能在多块屏之间换算，减掉某一块屏的原点会让跨屏时整体偏移。
  let st = { x: wx, y: wy, vx, vy }
  // 起点先夹进最近那块屏的边界：上次若被扔到屏幕外，这一次甩就自动把桌宠拉回来
  {
    const i0 = physics.screenOfBox(space, st.x, st.y)
    const b0 = space.bounds[i0]
    if (b0) {
      st.x = Math.min(Math.max(st.x, b0.minX), b0.maxX)
      st.y = Math.min(Math.max(st.y, b0.minY), b0.maxY)
    }
  }
  const t0 = Date.now()
  let last = t0
  let lastPos = ''
  let squashAt = 0
  let squashCount = 0
  let lastFlightReport = 0
  const finish = () => {
    stopThrow()
    // 落地后最后一道防线：尺寸被撑大时人已经沉下去了，这里拉回来并重新贴地。
    enforceWindowSize('throw-end')
    clampWindowToArea() // 缩回正常尺寸后，位置可能仍然偏低，按真实尺寸再夹一次
    // 落定后把自己的最终位置报给 broker（速度归零），别的宠物才不会拿陈速度做碰撞
    updatePetState(PET_ID, { x: st.x, y: st.y, vx: 0, vy: 0, size: w, bottomPad: 0 })
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__onThrowEnd && window.__onThrowEnd()').catch(() => {})
  }
  const stepFrame = () => {
    thrower = null
    if (!win || win.isDestroyed()) return
    const now = Date.now()
    const dt = Math.min(0.05, Math.max((now - last) / 1000, 1e-4)) // 巨帧/同毫秒多帧都夹住
    last = now
    let impact = 0
    const n = physics.throwSubsteps(st.vx, st.vy, dt)
    for (let i = 0; i < n; i++) {
      st = physics.throwStepRegion(st, dt / n, space, ph)
      if (st.bounced && st.vy > 0) impact = Math.max(impact, Math.abs(st.vy))
      if (st.atRest) break
    }
    if (now - t0 > THROW_MAX_MS) {
      // 超时兜底：直接落回当前屏底部，别留半空死状态
      const iEnd = physics.screenOfBox(space, st.x, st.y)
      const bEnd = space.bounds[iEnd]
      st = bEnd ? { ...st, y: bEnd.maxY, vx: 0, vy: 0, atRest: true } : { ...st, vx: 0, vy: 0, atRest: true }
    }
    // ---- 多桌宠碰撞（dsh-pet 的 collidePet + overlapPush 接入）----
    // 只在 petCollision 开启、且确实有别的宠物时才跑。
    //
    // 两块分开算，顺序不能换（对齐 dsh-pet 的 client/pet/motion/pet-collision.ts）：
    //   ① overlapPush：纯位移，把「已经叠在一起」的两只按最短轴各推一半。不碰速度。
    //   ② collidePet：速度交换。两者正在分离时它会返回 null —— 这正是①存在的理由：
    //      只靠②的话，已经插住的两只会一直保持重叠，直到某帧速度重新变成接近才突然弹开。
    // ①的位移取「整段」（push.dx * 2）：另一半由被撞方自己下一帧从它那侧再推一次，合起来正好分开。
    if (ph.petCollision !== false) {
      // 碰撞盒按**人物的紧包围盒**算（HIT_BOX），不是整个舞台（dsh-pet 的 collide.ts 就是这口径）。
      // 坐标系要点：bodyPixelBox 的 x/y/size 必须同系（它内部按 size 归一 HIT_BOX）。
      //   · st.x/st.y 是**窗口**左上角；舞台在窗口里还有左 20 / 底 16 余量
      //   · 所以先平移到舞台左上角，size 传舞台宽（不是窗口宽）
      // 不这么平移的话碰撞盒整体偏左上，两只明明没挨着就弹。
      const myBody0 = bodyBox(w, Math.round(Number(h) || 0) || Math.round(REST_H * curScale))
      const myBody = physics.bodyPixelBox({
        x: st.x + myBody0.offsetX, y: st.y + myBody0.offsetY,
        size: myBody0.width, bottomPad: 0, hitBox: HIT_BOX,
      })
      for (const [oid, rec] of petRegistry) {
        if (oid === PET_ID || !rec.alive) continue
        const o = rec.state
        if (!o || !o.size) continue
        // 对方的状态里没有 offset（broker 只存 x/y/vx/vy/size），按同一套比例反推它的舞台盒
        const oBody = bodyBox(o.size, Math.round(o.size * (REST_H / BASE_W)))
        const otherBody = physics.bodyPixelBox({
          x: o.x + oBody.offsetX, y: o.y + oBody.offsetY,
          size: oBody.width, bottomPad: o.bottomPad || 0, hitBox: HIT_BOX,
        })
        if (!physics.rectsOverlap(myBody, otherBody)) continue
        const push = physics.overlapPush(myBody, otherBody)
        if (push) {
          // 推开后可能把自己顶出屏幕（挤在边上时尤其容易）：按当前屏的合法范围夹回来。
          // 不夹的话下一帧 throwStepRegion 会把它夹到边界上，视觉上等于白推一次、两只继续叠着。
          const si = physics.screenOfBox(space, st.x, st.y)
          const sb = space.bounds[si]
          if (sb) {
            st = {
              ...st,
              x: Math.min(Math.max(st.x + push.dx * 2, sb.minX), sb.maxX),
              y: Math.min(Math.max(st.y + push.dy * 2, sb.minY), sb.maxY),
            }
          } else {
            st = { ...st, x: st.x + push.dx * 2, y: st.y + push.dy * 2 }
          }
        }
        const hit = physics.collidePet(
          { x: st.x, y: st.y, vx: st.vx, vy: st.vy, size: w },
          { x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0, size: o.size },
        )
        // 正在分离（重叠之后的几帧）：只推位置、不改速度，否则同一对碰撞会被每帧反复注入动量。
        if (!hit) break
        // 自己按动量结果弹开
        st = { ...st, vx: hit.fvx, vy: hit.fvy }
        // 被撞方：把它的新初速转发过去，让它自己起飞
        const targetRec = petRegistry.get(oid)
        if (targetRec && targetRec.win && !targetRec.win.isDestroyed()) {
          try { targetRec.win.webContents.send('pet:collide-hit', { vx: hit.hvx, vy: hit.hvy }) } catch {}
        }
        break // 一帧只处理一次碰撞，避免连锁抖动
      }
    }
    // 上报飞行状态给 broker（~30ms 节流）：别的宠物据此做跨窗碰撞
    if (now - lastFlightReport > 30) {
      lastFlightReport = now
      updatePetState(PET_ID, { x: st.x, y: st.y, vx: st.vx, vy: st.vy, size: w, bottomPad: 0 })
    }
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
/** 当前这次移动是被谁发起的：'' = 没人；'behavior' = AI 行为；'self' = 渲染页随机链的 move 档。
 *  dsh-pet 里 AI 行为和随机链是两套驱动，共用一个窗口，所以必须让它们互斥，
 *  否则两条 rAF/定时器会同时 setPosition，画面就是「一顿一顿往回拽」。 */
let moverOwner = ''
function stopMover() {
  if (mover) { clearTimeout(mover); mover = null }
  // 发起者标记**无条件**清：step 里会把 mover 置 null（表示「这一步在跑」），
  // 只在有句柄时清会让下一个调用方误判「还有人在走」。
  moverOwner = ''
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
  // 互斥（2026-11-05）：AI 行为（wander/chase/steal）和渲染页随机链的 move 档
  // 都调这个函数。两条线同时跑会互相 setPosition，画面就是一顿一顿往回拽。
  // 已经有人在走：新来的这次直接拒绝，让调用方自己退让（渲染页会改掷原地动作）。
  if (mover && moverOwner && moverOwner !== String(o.owner || '')) {
    return Promise.resolve(false)
  }
  stopThrow() // 与甩抛互斥
  if (o.carry) ensureCursorHelper() // 叼鼠标：提前把光标助手叫醒（首次编译要 ~1s，别等第一帧）
  moverOwner = String(o.owner || '')
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
      moverOwner = ''
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
/** 下发通道统一入口（唯一执行路径）：say 先气泡，执行完回执 /playback。 */
// 这些动作自己会说话（say 用 params.text）：外面别再预弹一次，否则双气泡
const SELF_SAY_ACTIONS = new Set(['say'])
// 小屋动作（上游 1.0.12）：主进程拦截执行（开场景窗 + 跳状态），不走 behavior.js 纯逻辑层——
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
// 互动闸（上游 1.0.14 面板六键）：晃鼠标勾引追 / 点击扑鼠标各有独立开关（默认关）。
// 与既有禁用清单闸是「且」的关系——关任何一个都不扑；摸摸/闲置判定完全不受影响。
// 服务端 behaviorSettings() 在任一为 false 时已把 chase_cursor 塞进禁用清单，这里是客户端侧的
// 第二道闸（面板刚改、/config 还没轮询到时也不至于立刻扑上去）。
let clickChase = false
let teaseChase = false
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
  // 状态卡判定必须走在这一小段最前面：它是独立功能，不该被「行为层关掉 / 专注模式 / 没拿到身体盒」连累。
  // （以前把这一段写在 react 串后面，把行为大脑一关，状态卡也跟着没了。）
  {
    let cp = null
    try { cp = screen.getCursorScreenPoint() } catch {}
    if (cp) { try { statusHoverTick(cp, bodyRect(), Date.now()) } catch {} }
  }
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
    hideStatusCard() // 开始摸头 = 不是悬停，卡收起来（照 Astra Pet 的分工）
    react('pat', () => {
      showBubble('（被摸到了…）', '', '', '', '', 'behavior', '行为')
      apiPost('/life/touch', { kind: 'pat' }) // 数值体系：摸摸 +心情 +经验
      return playAnimByNames(['蹭', '贴贴', '摸摸', 'pat'])
    }, { dwellMs: behaviorApi.THRESHOLDS.PAT_DWELL_MS })
  } else if (behaviorActionEnabled('chase_cursor') && teaseChaseEnabled() && behaviorApi.isTeasing(cursorSamples, box, now)) {
    react('tease', () => handleBehavior({ action: 'chase_cursor' }), { note: '主人在旁边快速晃鼠标勾引' })
  } else if (behaviorActionEnabled('steal_cursor') && behaviorApi.isCursorIdle(lastCursorMoveAt, now, behaviorCfg.idleCursorMinutes)) {
    lastCursorMoveAt = now // 触发一次后重新计时，避免每轮都打
    // 2026-10-30 用户指定：闲置反应直接叼鼠标（approach_cursor 已删）
    react('idle-cursor', () => handleBehavior({ action: 'steal_cursor' }), { idleMinutes: behaviorCfg.idleCursorMinutes })
  }
}, 400)

// ---------- 状态卡（悬停 1 秒弹头顶小卡片；学 Astra Pet 的 design/pet-life/03 §3）----------
// 为什么放主进程而不是渲染页：判定「鼠标在人物身上」用的是主进程的全局光标 + bodyRect()，
// 和摸摸 / 勾引同一套（已经在跑的 400ms 循环里，不另开定时器）。渲染页只管画。
//
// 和摸头的分工（照 Astra Pet 的口径）：**悬停不动**才弹卡，一开始来回划就当摸头、卡立刻收起。
// 拖拽中、正在说话（气泡挂着）时都不弹——那两个时刻她本来就在动，再弹个卡挡着更乱。
const STATUS_HOVER_MS = 1000      // 停多久弹卡
const STATUS_HIDE_MS = 500        // 光标离开多久收卡
let hoverInside = false
let hoverSince = 0
let hoverLeftAt = 0
let statusCardOn = false          // 渲染页当前是不是显示着卡
let lifecycleCache = null          // { at, data }：1 秒内不重复打 /life
function statusCardEnabled() {
  try { return Boolean(pack && pack.life && pack.life.statusCard) } catch { return false }
}
async function statusCardData() {
  const now = Date.now()
  if (lifecycleCache && now - lifecycleCache.at < 1000) return lifecycleCache.data
  try {
    const r = await apiGet('/life', { pet: 'main' })
    const data = r && r.ok ? r.life : null
    lifecycleCache = { at: now, data }
    return data
  } catch { return null }
}
function showStatusCard() {
  if (!win || win.isDestroyed()) return
  statusCardData().then((data) => {
    if (!data || !win || win.isDestroyed()) return
    // 气泡还挂着就别弹（她的原话更重要）
    if (bubbleUntilLocal && Date.now() < bubbleUntilLocal) return
    statusCardOn = true
    // 名字由主进程带上（服务端 /life 不知道主人给这只起的昵称）
    const payload = { ...data, petName: String((pack && pack.title) || '大肥鱼').slice(0, 20) }
    win.webContents.executeJavaScript(`window.__statusCard && window.__statusCard(${JSON.stringify(payload)})`).catch(() => {})
  }).catch(() => {})
}
function hideStatusCard() {
  if (!statusCardOn) return
  statusCardOn = false
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript('window.__statusCard && window.__statusCard(null)').catch(() => {})
}
/** 主进程侧记的「气泡挂到什么时候」—— 渲染页收起时由 hide 事件清零。 */
let bubbleUntilLocal = 0
/**
 * 状态卡的悬停判定。由 400ms 循环调（见下），纯逻辑 + 一次 IPC。
 * @param {{x:number,y:number}} cursor 全局光标
 * @param {object|null} box 人物身体盒
 */
function statusHoverTick(cursor, box, now = Date.now()) {
  if (!statusCardEnabled() || !box) { if (hoverInside) { hoverInside = false; hideStatusCard() } ; return }
  if (focusOn || hitBusy || inputRegions.dragging) { // 专注 / 拖拽中：不弹
    hoverInside = false
    hideStatusCard()
    return
  }
  const inBox = cursor && cursor.x >= box.x && cursor.x < box.x + box.width
    && cursor.y >= box.y && cursor.y < box.y + box.height
  if (inBox) {
    hoverLeftAt = 0
    if (!hoverInside) { hoverInside = true; hoverSince = now }
    else if (!statusCardOn && now - hoverSince >= STATUS_HOVER_MS) {
      // 摸头时鼠标是来回划的，悬停计时会被指针移动打断——这里靠「位置一直在动」区分：
      // 只要这一秒内光标没离开过这个盒子，就当悬停。
      showStatusCard()
    }
  } else {
    const was = hoverInside
    hoverInside = false
    hoverSince = 0
    if (was && !hoverLeftAt) hoverLeftAt = now
    if (statusCardOn && hoverLeftAt && now - hoverLeftAt >= STATUS_HIDE_MS) hideStatusCard()
  }
}

// ---------- IPC（渲染页拖拽/甩抛 → 主进程） ----------
ipcMain.on('pet:move', (_e, { x, y }) => {
  stopThrow()
  if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return
  // 拖拽前先纠正尺寸：尺寸被撑大时 w/h 是错的，夹取会算出错误的边界，
  // 结果就是「拖到屏幕下沿、人却还是掉到任务栏下面」。
  enforceWindowSize('drag-move')
  const [w, h] = winSizeDip()
  // 拖拽夹取（2026-11-05 改：与甩抛同一套「身体盒」语义）。
  //
  // 以前这里按**窗口整体**夹进 workArea，要求 502×284 完整装进去 ——
  // 于是拖动比甩抛少走一大截：甩抛允许身体出屏 37px，拖动却连窗口右边距的 20px 都不放过，
  // 表现就是「拖不到屏幕边、也贴不住任务栏」。窗口比身体大（左右各 20 底距 16），
  // 按窗口夹等于永远差这一圈。
  //
  // 现在的规则与 throwSpace 完全一致：**按身体透明边余量**（dsh-pet 的 sideAllow）
  //   · 身体左右缘各留 sideInset（= 命中区外的透明区宽）才是人物本体，边界按「人物边缘贴屏」算
  //   · 身体底边贴 workArea 底边（任务栏之上）—— 这就是「到得了任务栏边界」
  //   · 身体顶边贴 workArea 顶边
  // 换成窗口左上角坐标就是把身体偏移减回去，见下面的 toWin()。
  const ds = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
  const areas = ds.map((d) => d.workArea)
  const body = bodyBox(w, h)
  const reach = sideInsetOf(body)
  // 窗口左上角 → 身体盒左上角
  const toBody = (wx, wy) => ({ x: wx + body.offsetX, y: wy + body.offsetY })
  // 身体盒左上角 → 窗口左上角
  const toWin = (bx, by) => ({ x: bx - body.offsetX, y: by - body.offsetY })
  // 身体盒在一个工作区里的合法范围（与 physics.throwSpace 的 bounds 同源）
  const bodyRange = (a) => ({
    minX: a.x - reach.left,
    maxX: a.x + a.width - body.width + reach.right,
    minY: a.y,
    maxY: a.y + a.height - body.height,
  })
  const target = toBody(x, y)
  let bestBX = target.x
  let bestBY = target.y
  let bestD = Infinity
  for (const a of areas) {
    const r = bodyRange(a)
    const cx = Math.min(Math.max(target.x, r.minX), r.maxX)
    const cy = Math.min(Math.max(target.y, r.minY), r.maxY)
    // 身体盒已经完全落在该屏合法范围内：直接用
    if (cx === target.x && cy === target.y) { bestBX = cx; bestBY = cy; bestD = 0; break }
    // 跨屏：身体盒横向与这块屏有交集、纵向合法、且确实有邻屏接壤 → 放行
    const overlapsX = target.x + body.width > a.x && target.x < a.x + a.width
    const touchesNeighbor = areas.some((o) => o !== a &&
      (Math.abs(o.x - (a.x + a.width)) <= 1 || Math.abs(a.x - (o.x + o.width)) <= 1))
    if (touchesNeighbor && overlapsX && cy === target.y) { bestBX = target.x; bestBY = cy; bestD = 0; break }
    const dx = target.x - cx
    const dy = target.y - cy
    const d2 = dx * dx + dy * dy
    if (d2 < bestD) { bestD = d2; bestBX = cx; bestBY = cy }
  }
  const winPos = toWin(bestBX, bestBY)
  const nx = Math.round(winPos.x)
  const ny = Math.round(winPos.y)
  // 丢弃重复坐标：渲染页已按帧合并，但同一位置仍可能连发（对齐后指针抖动等）——重复就不必再动窗口
  // lastMove 由 setWinPos 统一维护（抛掷/行为移动之后也不会变成陈数据）
  if (lastMove && lastMove.x === nx && lastMove.y === ny) return
  setWinPos(nx, ny)
  // 拖拽中也要把自己的位置报给 broker：别的宠物飞行时要用我的实时位置做碰撞
  updatePetState(PET_ID, { x: nx, y: ny, vx: 0, vy: 0, size: w, bottomPad: 0 })
})
ipcMain.on('pet:throw', (_e, { vx, vy }) => {
  // 「松手落地」关掉：松手停在哪就在哪 —— 甩抛与原地掉落（vx=vy=0）一并拦下
  if (!releaseLand) return
  startThrow(Number(vx) || 0, Number(vy) || 0)
})
ipcMain.on('pet:throw-stop', () => stopThrow())

// ---------- 主进程权威拖拽（上游 1.0.15 的 pet:drag-start/move/end；pet:move 保留向后兼容）----------
// 旧机制偏移根因：渲染页自算坐标（screenInfo + e.screenX）在 forwarded-input 穿透窗 + setZoomFactor
// 下会与真实光标错位（上游纯 Electron 探针已验证 e.screenX == screen.getCursorScreenPoint()，DIP 1:1）。
// 新机制：渲染页只发信号不带坐标；主进程 drag-start 记 grabOffset（光标 - 窗口左上角，全 DIP），
// 起 60fps 循环：读光标 → winPos = cursor - grabOffset → 夹虚拟桌面 → setWinPos，同时采 DIP 轨迹
// （≤64 条，trimTrail 按时间裁剪）。drag-end 用 trimTrail + estimateReleaseVelocity 算初速：
// releaseLand 关 → 停在哪就在哪；isClick → 原地掉落（等价旧 drop()，同样受 releaseLand 门控）。
// 多开的那几只走 pet:extra:drag-*，本文件下方给 extra 窗口另注册同一套 handler。
const DRAG_FRAME_MS = 16   // 拖拽循环节拍 ≈60fps（与甩抛/移动循环一致；主进程没有 rAF，用定时器）
const DRAG_STALE_MS = 3000 // 心跳兜底：渲染页按住期间每 300ms 有保活心跳，3s 内任何心跳都没有才判丢失，绝不永久拖着
const DRAG_TRAIL_MAX = 64  // 轨迹上限（与旧渲染页口径一致，时间窗口由 trimTrail 裁）
let drag = null // { grabOffset:{x,y}, trail:[{t,x,y}], lastPos, timer, lastSeen }
function stopDrag() {
  if (!drag) return
  clearTimeout(drag.timer)
  drag = null
}
/** 松手初速估算用的物理参数：与 startThrow 同一口径（内置默认 ← 素材包）。 */
function effectivePhysics() {
  return { ...physics.DEFAULT_PHYSICS, ...(pack && pack.physics ? pack.physics : {}) }
}
/** 拖拽收尾：按 isClick / 轨迹初速决定原地掉落或甩抛（统一走 startThrow，物理口径单一来源）。 */
function endDragSession(isClick) {
  const d = drag
  stopDrag()
  if (!d) return // 孤立 drag-end（异常路径/没发生过拖拽）：不做任何收尾，更不能原地掉落
  if (!win || win.isDestroyed()) return
  if (!releaseLand) return // 松手落地关：停在哪就在哪（与旧 pet:throw 拦截口径一致）
  const trail = physics.trimTrail(d.trail, Date.now())
  const v = isClick ? null : physics.estimateReleaseVelocity(trail, Date.now(), effectivePhysics())
  startThrow(v ? v.vx : 0, v ? v.vy : 0) // isClick / 温柔放下 = 零初速原地掉落
}
function dragLoop() {
  const d = drag
  if (!d) return
  if (!win || win.isDestroyed()) { stopDrag(); return }
  let c = null
  try { c = screen.getCursorScreenPoint() } catch { c = null }
  if (!c) { stopDrag(); return } // 拿不到光标（罕见）：放弃拖拽，别空转
  const now = Date.now()
  // 尺寸守卫：窗口被撑大时 w/h 是错的，夹取会算出错误边界（同 pet:move 的坑）
  enforceWindowSize('drag-loop')
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
// ---------- 渲染页自截图（诊断「动画有没有被切」）----------
// capturePage 抓的是这个渲染进程合成出来的画面（含透明 alpha），不会混进桌面壁纸 ——
// 从屏幕坐标 CopyFromScreen 抓透明窗口会把底下的浏览器/壁纸一起抓进来，看不到真实效果。
// 由主进程的 pollLoop 收到 /debug/snapshot 指令后调用，落盘到 app/ 下再回给插件。
async function debugSnapshot() {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' }
  try {
    const img = await win.webContents.capturePage()
    if (!img || img.isEmpty()) return { ok: false, reason: 'empty' }
    const f = path.join(__dirname, 'shot.png')
    fs.writeFileSync(f, img.toPNG())
    const s = img.getSize()
    return { ok: true, file: f, size: [s.width, s.height], anim: null }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) }
  }
}
/** 点播一段 → 等它真出画 → 截图。用于逐个核对大场面段有没有被切。
 *  waitMs 缺省 1500（等解码 + 首帧），调用方可按需加大。 */
async function debugShot(anim, waitMs) {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' }
  const id = String(anim || '')
  if (!id) return { ok: false, reason: 'no-anim' }
  const played = await playAnimById(id)
  if (played === false) return { ok: false, reason: 'play-failed' }
  await new Promise((r) => setTimeout(r, Math.max(400, Math.min(6000, waitMs || 1500))))
  const shot = await debugSnapshot()
  if (shot.ok) shot.anim = id
  return shot
}
// ---------- 自主走位（2026-11-05，dsh-pet 的 move 档）----------
// 渲染页掷骰掷到「走位」时走这条：挑一个近处落点、匀速走过去，途中自动播踏步动画。
// 与 AI 行为（wander/chase/steal）互斥：已经在走就直接回 busy，让渲染页改掷原地动作。
// dsh-pet 的 walk.ts 是「按视频播放时间插值 + leadSec/tailSec 起收脚」，窗口在浏览器里；
// 我们的窗口在 Electron 主进程，位置只能用 setPosition 推，所以复用现成的 moveWindowTo
// （它已经有亚像素累积、工作区夹取、被外部移动后重新对齐这些坑的解法）。
ipcMain.handle('pet:walk', async (_e, opts) => {
  const o = opts || {}
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' }
  // 同一个 owner 的连续走位不算冲突：玩法「吃白饭」是一趟一趟地追饭，每一趟都要新起点，
  // 上一趟已经收尾（mover 清空）才进来，这里只挡**别人**。
  if (mover && moverOwner !== String(o.owner || '')) return { ok: false, reason: 'busy' }
  if (thrower) return { ok: false, reason: 'flying' }
  if (focusOn) return { ok: false, reason: 'focus' } // 专注模式：她也别乱跑
  const [w, h] = winSizeDip()
  const [wx, wy] = win.getPosition()
  const b = bodyBox(w, h)
  const area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea

  // ---- 玩法「吃白饭」的两条专用走位（2026-11-05）----
  // 语义与随机链的「随机挪一小步」完全不同：这是**有明确目的地**的位移，
  //   · o.dx 是数字：目标 = 当前身体中心 + dx（追饭时横着走）
  //   · o.align === 'bottom'：目标 = 工作区底部（「跑向屏幕底部」那一相位）
  // 两条都按身体盒夹进工作区，和拖拽/抛掷同一套边界。
  if (o.dx !== undefined || o.align === 'bottom') {
    const from = { x: wx + b.offsetX + b.width / 2, y: wy + b.offsetY + b.height / 2 }
    // 身体盒中心的可达范围：左右按 sideInset（透明边余量 = 人物边缘贴屏），上下按身体高
    const reach = sideInsetOf(b)
    const minCX = area.x - reach.left + b.width / 2
    const maxCX = area.x + area.width + reach.right - b.width / 2
    const minCY = area.y + b.height / 2
    const maxCY = area.y + area.height - b.height / 2
    let targetX = from.x + (Number.isFinite(Number(o.dx)) ? Number(o.dx) : 0)
    let targetY = from.y
    if (o.align === 'bottom') targetY = maxCY // 身体底边贴工作区底边 = 压住任务栏上沿
    targetX = Math.min(Math.max(targetX, minCX), maxCX)
    targetY = Math.min(Math.max(targetY, minCY), maxCY)
    if (Math.hypot(targetX - from.x, targetY - from.y) < 1) return { ok: true, movedX: 0, movedY: 0 }
    const okWalk = await moveWindowTo(() => ({ x: targetX, y: targetY }), {
      owner: String(o.owner || 'baifan'),
      align: 'body',
      speed: Math.max(20, Number(o.speed) || 120),
      stopPx: 6,
      maxMs: Math.max(1000, Number(o.maxMs) || 20_000),
    })
    // 回实际走了多远（世界坐标）：玩法靠它把窗口内的道具换算回「世界固定」。
    // 不做这一步，道具会跟着窗口一起挪，宠物永远追不上 —— 米饭与宠物同一个坐标系是这个玩法的核心陷阱。
    let movedX = 0
    let movedY = 0
    if (win && !win.isDestroyed()) {
      const [ax, ay] = win.getPosition()
      movedX = (ax + b.offsetX + b.width / 2) - from.x
      movedY = (ay + b.offsetY + b.height / 2) - from.y
    }
    return okWalk ? { ok: true, movedX, movedY } : { ok: false, reason: 'interrupted', movedX, movedY }
  }

  // 中心可达区：四边各内缩半个身体
  const box = {
    x: area.x + b.width / 2,
    y: area.y + b.height / 2,
    width: Math.max(1, area.width - b.width),
    height: Math.max(1, area.height - b.height),
  }
  const from = { x: wx + b.offsetX + b.width / 2, y: wy + b.offsetY + b.height / 2 }
  // 近处落点（dsh-pet 的 minDist/maxDist：60~240 × 尺寸比）：自走位是「挪一小步」，
  // 不是 wander 那种「走到另一头」。太远会像被拖着走，也更容易和用户操作打架。
  const scale = Math.max(0.4, Math.min(2.5, (w / 280) || 1))
  const minD = 60 * scale
  const maxD = 240 * scale
  let target = null
  for (let i = 0; i < 16; i++) {
    const ang = Math.random() * Math.PI * 2
    const d = minD + Math.random() * Math.max(1, maxD - minD)
    const tx = Math.min(Math.max(from.x + Math.cos(ang) * d, box.x), box.x + box.width)
    const ty = Math.min(Math.max(from.y + Math.sin(ang) * d, box.y), box.y + box.height)
    // 太近就是「原地抖一下」，不值得走
    if (Math.hypot(tx - from.x, ty - from.y) >= minD * 0.6) { target = { x: tx, y: ty }; break }
  }
  if (!target) return { ok: false, reason: 'no-target' }
  // 走位动作名：优先用面板/包里的「原地漂浮踏步」，与 AI 走位同一套换算
  startMoveAnim()
  const ok = await moveWindowTo(() => target, {
    owner: 'self',
    align: 'body',
    speed: 90,        // 自走位比 wander 的 50 快一点：它更短、是为了演一段动作
    stopPx: 6,
    maxMs: 20_000,    // 240px / 90px·s⁻¹ ≈ 2.7s，20s 足够兜底
  })
  return ok ? { ok: true } : { ok: false, reason: 'interrupted' }
})
// ---------- 多桌宠碰撞 broker ----------
/** 窗口上报自己的实时位置/速度（飞行中 ~30ms 一次，静止时由 pet:move 顺带报）。
 *  dsh-pet 的 report-flight：broker 汇总后广播，别的窗口据此判断「我撞到它了没」。 */
ipcMain.on('pet:flight', (e, payload) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const id = petIdOfWin(w)
  if (!id) return
  const s = payload || {}
  const nums = [s.x, s.y, s.vx, s.vy, s.size, s.bottomPad].map(Number)
  if (!nums.every(Number.isFinite)) return
  updatePetState(id, { x: nums[0], y: nums[1], vx: nums[2], vy: nums[3], size: nums[4], bottomPad: nums[5] })
})
/** 碰撞结果转发：飞行方算完动量，把被撞方的新初速转发给它，让它自己 startThrow。
 *  注意通道名用 pet:collide-hit，不能复用 pet:hit（那个是渲染页→主进程的命中上报，方向相反）。 */
ipcMain.on('pet:collide', (e, payload) => {
  const targetId = String((payload && payload.targetId) || '')
  const vx = Number(payload && payload.vx)
  const vy = Number(payload && payload.vy)
  if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return
  const rec = petRegistry.get(targetId)
  if (rec && rec.win && !rec.win.isDestroyed()) {
    try { rec.win.webContents.send('pet:collide-hit', { vx, vy }) } catch {}
  }
})
/** 窗口 → petId 反查。 */
function petIdOfWin(w) {
  for (const [id, rec] of petRegistry) if (rec.win === w) return id
  return ''
}
// ---------- 额外宠物的 IPC 前置路由 ----------
// 原有一整套 handler（pet:move / pet:throw / pet:hit / pet:busy / pet:fit / pet:screen…）全是
// 只认全局 `win` 的：`ipcMain.on('pet:move', (_e, {x,y}) => { ...win... })`，根本没看事件是谁发的。
// 额外宠物一旦发同样的通道，就会去改**主宠物**的窗口 —— 拖小只会把大只拖走。
//
// 这里不改那些 handler 的实现（改动面太大、且主宠物那条链已经调稳了），
// 而是给多开宠物单独挂一组通道：渲染页对额外宠物发 'pet:extra:*'，由 multiApi 处理。
// 好处是零风险：主宠物通道一个字节没动，额外宠物走自己的路。
function extraRecOf(w) {
  if (!multiApi) return null
  for (const rec of multiApi.pets.values()) if (rec.win === w) return rec
  return null
}
ipcMain.on('pet:extra:move', (e, payload) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (!rec) return
  const x = Number(payload && payload.x)
  const y = Number(payload && payload.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  multiApi.moveTo(rec.id, x, y)
})
ipcMain.on('pet:extra:throw', (e, payload) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (!rec) return
  const vx = Number(payload && payload.vx)
  const vy = Number(payload && payload.vy)
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return
  multiApi.startThrow(rec, vx, vy)
})
ipcMain.on('pet:extra:throw-stop', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (rec) multiApi.stopThrow(rec)
})
// 额外宠物的主进程权威拖拽（与主宠物同一套口径，只是挂在各自的 rec 上）：
// 每只 rec 自带 extraDrag 状态，循环里读系统光标 → 夹虚拟桌面 → multiApi.moveTo。
function extraDragLoop(rec) {
  const d = rec && rec.extraDrag
  if (!d) return
  const w = rec.win
  if (!w || w.isDestroyed()) { rec.extraDrag = null; return }
  let c = null
  try { c = screen.getCursorScreenPoint() } catch { c = null }
  if (!c) { rec.extraDrag = null; return }
  const now = Date.now()
  const [ww, wh] = w.getSize()
  const dd = virtualDesktopBounds()
  const nx = Math.round(Math.min(Math.max(c.x - d.grabOffset.x, dd.x), dd.x + dd.w - ww))
  const ny = Math.round(Math.min(Math.max(c.y - d.grabOffset.y, dd.y), dd.y + dd.h - wh))
  const key = nx + ',' + ny
  if (key !== d.lastPos) {
    d.lastPos = key
    try { w.setPosition(nx, ny) } catch { rec.extraDrag = null; return }
    rec.state = { ...(rec.state || {}), x: nx, y: ny, vx: 0, vy: 0 }
  }
  d.trail.push({ t: now, x: c.x, y: c.y })
  if (d.trail.length > DRAG_TRAIL_MAX) d.trail.shift()
  if (now - d.lastSeen > DRAG_STALE_MS) { rec.extraDrag = null; return }
  d.timer = setTimeout(() => extraDragLoop(rec), DRAG_FRAME_MS)
}
ipcMain.on('pet:extra:drag-start', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (!rec) return
  try { multiApi.stopThrow(rec) } catch {}
  if (rec.extraDrag) { clearTimeout(rec.extraDrag.timer); rec.extraDrag = null }
  let c = null
  try { c = screen.getCursorScreenPoint() } catch { return }
  const [wx, wy] = w.getPosition()
  rec.extraDrag = { grabOffset: { x: c.x - wx, y: c.y - wy }, trail: [], lastPos: '', timer: null, lastSeen: Date.now() }
  extraDragLoop(rec)
})
ipcMain.on('pet:extra:drag-move', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (rec && rec.extraDrag) rec.extraDrag.lastSeen = Date.now()
})
ipcMain.on('pet:extra:drag-end', (e, isClick) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (!rec) return
  const d = rec.extraDrag
  rec.extraDrag = null
  if (d) clearTimeout(d.timer)
  if (!d || !releaseLand) return // 死拖/松手落地关：停在哪就在哪
  const trail = physics.trimTrail(d.trail, Date.now())
  const v = isClick === true ? null : physics.estimateReleaseVelocity(trail, Date.now(), effectivePhysics())
  try { multiApi.startThrow(rec, v ? v.vx : 0, v ? v.vy : 0) } catch {}
})
ipcMain.on('pet:extra:hit', (e, hit) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (!rec) return
  rec.busy = hit === true
  try { w.setIgnoreMouseEvents(hit !== true, { forward: true }) } catch {}
})
// 额外宠物也冒气泡（各自人格），所以它的「贴合内容高度」必须跟主宠物一样真的改窗口高。
// 以前这里是空实现（额外宠物不说话，高度恒为气泡收起值）；现在转发给 multiApi.fitWindow，
// 底边/顶边钉法与 main.js 的 pet:fit 完全同口径（见 multi.js 的 enforceSize）。
ipcMain.on('pet:extra:fit', (e, baseH) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed() || !multiApi) return
  const rec = extraRecOf(w)
  if (rec) multiApi.fitWindow(rec.id, baseH)
})
ipcMain.handle('pet:extra:screen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed() || !extraRecOf(w)) return null
  try {
    const b = w.getBounds()
    const area = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }).workArea
    const body = bodyBox(b.width, b.height)
    return { W: b.width, H: b.height, x: b.x, y: b.y, area, body, extra: true }
  } catch { return null }
})
// ---------- 悬停热键 / 拖图 ----------
/** 悬停时按键（dsh-pet 的 onHotkey）：只在光标停在人物身上时才由渲染页发出。
 *  sleep-toggle 走插件的睡眠状态机；chat/todo 走各自开关；hear 按住说话。 */
ipcMain.on('pet:hotkey', (_e, action) => {
  const a = String(action || '')
  try {
    if (a === 'sleep-toggle') {
      // 睡眠状态机在 sleep 模块里，桌宠这边只负责把意图发过去
      const h = readHost()
      if (!h) return
      fetch(`${h.baseUrl}${h.api}/sleep/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .catch(() => {})
      return
    }
    if (a === 'chat-toggle') { toggleChat(); return }
    if (a === 'todo-toggle') { toggleTodoWin(); return }
    if (a === 'hear-start') { hearStart(); return }
    if (a === 'hear-stop') { hearStop(); return }
  } catch (e) { appendDebugLog({ kind: 'hotkey-error', action: a, msg: String(e && e.message || e) }) }
})
/** 拖图到桌宠身上：把图片路径记下来并打开对话框（dsh-pet 的 showChatFromMenu(file)）。
 *  当前对话框还不支持挂图，所以先落地一个提示 + 打开对话框。 */
ipcMain.on('pet:drop-image', (_e, filePath) => {
  const p = String(filePath || '')
  appendDebugLog({ kind: 'drop-image', path: p })
  try {
    if (chatCfg.enabled && !chatWinAlive()) toggleChat()
    sayLocal('图收到啦（挂图发送还没接上）')
  } catch {}
})
// 反应层①点击桌宠：渲染页单击（位移 <6px）上报 → 撒娇动画（渲染页 click 池已播）+ 追鼠标（带冷却）
// 2026-11-01：追鼠标被禁用时只保留渲染页自己的点击动画，不再追/抓鼠标。
ipcMain.on('pet:click', () => {
  apiPost('/life/touch', { kind: 'click' }) // 数值体系：点一下 +心情 +经验（服务端有节流与每日上限）
  if (behaviorActionEnabled('chase_cursor') && clickChaseEnabled()) react('click', () => handleBehavior({ action: 'chase_cursor' }), { note: '主人点了桌宠' })
})
// 渲染页命中检测：true=鼠标在宠物/气泡上（恢复窗口交互），false=在透明区（放行点击）
let ignoreNow = true          // 当前是否穿透（镜像，避免与渲染页通道失步）
let hitBusy = false           // 渲染页正在用鼠标（拖拽中）：绝不因位置判定改穿透
let offBodyMs = 0             // 光标停在窗口余量区的连续时长
function setWindowIgnore(ignore) {
  if (!win || win.isDestroyed()) return
  try { win.setIgnoreMouseEvents(ignore, { forward: true }) } catch { return }
  ignoreNow = ignore
}
ipcMain.on('pet:hit', (_e, hit) => {
  if (!win || win.isDestroyed()) return
  setWindowIgnore(!hit)
})
// 拖拽租约：渲染页按下时说 busy=true，松开说 false。
// 拖拽期间宠物滞后于光标，按位置判定会断掉正在用的 pointermove/pointerup（拖到一半突然不动）。
ipcMain.on('pet:busy', (_e, busy) => {
  const on = busy === true
  hitBusy = on
  // 开始拖拽 = 外部打断：玩法必须当场收场。它的走位循环（setTimeout）和渲染页的拖拽弹簧（rAF）
  // 会同时 setPosition，画面就是「一顿一顿往回拽」，而且松手后人也跟着跑掉。
  if (on) interruptBaifan('drag')
})
// 多开宠物的租约通道：preload 对 extra 窗口发 pet:extra:busy，只影响那一只（主宠物的 hitBusy 不动）。
ipcMain.on('pet:extra:busy', (e, busy) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  const rec = extraRecOf(w)
  if (!rec) return
  rec.draggingLease = busy === true
})
/** 控件矩形（dsh-pet 的 inputRegions）：菜单/对话框这类浮层长在窗口余量区，
 *  光标离开身体就穿透、点不到。busy 期间按这些矩形判定「这里也算可交互」。 */
let inputRegions = { dragging: false, rects: [] }
ipcMain.on('pet:input-regions', (_e, input) => {
  const rects = Array.isArray(input && input.rects)
    ? input.rects.filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0)
    : []
  inputRegions = { dragging: !!(input && input.dragging), rects }
})
// 诊断通道：渲染页把拖拽链路各环节状态打过来，落盘到 debug-crop.log
ipcMain.on('pet:diag', (_e, payload) => {
  try { appendDebugLog({ kind: 'diag', tag: payload && payload.tag, data: payload && payload.data }) } catch {}
})
// ---------- 光标轮询兜底（从 dsh-pet 的 pointer-target.ts / windows.js 搬来）----------
// 为什么必须有这条：窗口默认整窗穿透，常规链路只有 Electron 的 forward 鼠标钩子一个入口，
// 而**该钩子在 Windows 上会静默失效**——失效后渲染页收不到任何 mousemove，
// 表现出「桌宠点不动、拖不动、右键没反应」，而面板一切正常，极难查。
// 这里由主进程自己每 60ms 取一次光标位置做判定，不依赖渲染页上报。
const POINTER_POLL_MS = 60
const OFF_BODY_RELEASE_MS = 400
/** 宠物**身体**在屏幕上的矩形（不是整个窗口）：窗口还包含气泡和四周透明余量，
 *  照窗口判定会让整个 280 宽的区域都吃鼠标，挡住身后一切。 */
function bodyScreenRect() {
  if (!win || win.isDestroyed()) return null
  try {
    const [wx, wy] = win.getPosition()
    const [w, h] = winSizeDip()
    const body = bodyBox(w, h)
    return {
      left: wx + body.offsetX,
      top: wy + body.offsetY,
      right: wx + body.offsetX + body.width,
      bottom: wy + body.offsetY + body.height,
      // 气泡也算可交互（点气泡不等于点人，但至少不能穿透）
      bubbleTop: wy,
      bubbleLeft: wx,
      bubbleRight: wx + w,
      bubbleBottom: wy + Math.max(0, body.offsetY),
    }
  } catch { return null }
}
let pointerTimer = null
let sizeWatchTick = 0
function startPointerFallback() {
  if (pointerTimer) return
  pointerTimer = setInterval(() => {
    // 尺寸巡检（每 ~1.2s 一次，不必每 60ms）：窗口被任何来源撑大都要拉回来。
    // resize 事件是主路径，这里是兜底 —— 有些撑大走的是 setContentSize / 外部 DPI 变更，
    // resize 事件会到，但可能来不及在下一帧落地前纠正。
    if (++sizeWatchTick >= 20) { sizeWatchTick = 0; enforceWindowSize('watchdog') }
    // 兜底 try：轮询里任何一次异常都会让穿透状态永久卡死。
    // 之前这里写成 P.pointerZone 而 P 根本没定义，ReferenceError 每 60ms 抛一次，
    // setWindowIgnore(false) 永远执行不到 —— 表现就是「桌宠完全拖不动、也点不动」。
    try {
    if (!win || win.isDestroyed()) return
    // 拖拽租约（busy）期间：
    //   · 正在拖（inputRegions.dragging）→ 整窗可交互，绝不能把正在拖的手断掉
    //   · 只是菜单/对话框开着 → 只有光标在登记的控件矩形上才保持可交互，矩形外继续穿透
    if (hitBusy) {
      if (inputRegions.dragging || !inputRegions.rects.length) {
        if (ignoreNow) setWindowIgnore(false)
        return
      }
      let inControl = false
      try {
        const b = win.getBounds()
        const cp = screen.getCursorScreenPoint()
        inControl = inputRegions.rects.some((r) =>
          cp.x >= b.x + r.x && cp.x < b.x + r.x + r.width &&
          cp.y >= b.y + r.y && cp.y < b.y + r.y + r.height)
      } catch {}
      const want = !inControl
      if (want !== ignoreNow) setWindowIgnore(want)
      return
    }
    let p = null
    try { p = screen.getCursorScreenPoint() } catch { return }
    let bounds = null
    try { bounds = win.getBounds() } catch { return }
    if (!bounds || bounds.width < 8 || bounds.height < 8) return
    const zone = physics.pointerZone(bounds, p, bodyScreenRect())
    const body = bodyScreenRect()
    // 气泡区域也当身体（可点）；否则气泡弹出时点气泡会穿透到桌面，看起来像“卡住”
    let inBubble = false
    if (body) inBubble = p.x >= body.bubbleLeft && p.x < body.bubbleRight && p.y >= body.bubbleTop && p.y < body.bubbleBottom
    const effZone = inBubble ? 'body' : zone
    if (effZone === 'margin') offBodyMs += POINTER_POLL_MS
    else offBodyMs = 0
    const next = effZone === 'body' ? false
      : effZone === 'outside' ? true
        : (offBodyMs >= OFF_BODY_RELEASE_MS ? true : ignoreNow)
    if (next !== ignoreNow) setWindowIgnore(next)
    } catch (e) {
      appendDebugLog({ kind: 'pointer-poll-error', msg: String(e && e.message || e) })
    }
  }, POINTER_POLL_MS)
  pointerTimer.unref?.()
}
function stopPointerFallback() {
  if (pointerTimer) { clearInterval(pointerTimer); pointerTimer = null }
}
// 窗口贴合内容（修「空白区域过大」）：窗口本来固定 430 高，气泡区 166px 平时全透明却真占着屏幕。
// 现在渲染页按内容上报基础高度（气泡收起=REST_H=284，气泡弹出=284+12+气泡实高+8），
// 主进程乘当前倍率后改窗高，**底边不动**（窗口向上长/向下缩，桌宠位置视觉不变）。
// 渲染页报的是缩放前的 CSS px（zoomFactor 只缩内容），这里统一乘 curScale 换算成真实窗口像素。
ipcMain.on('pet:fit', (_e, baseH) => {
  if (!win || win.isDestroyed()) return
  // 气泡高度上限（CSS px）。**必须与渲染页的 BUBBLE_MAX_H 一致**（各存一份，改一处要同步）。
  // 2026-11-06 从 154 提到 280：154 是按旧版 12.5px 小字算的，气泡字号现在默认 21px，
  // 6 行要 200+px，按 154 夹就会把气泡上沿切掉。
  const BUBBLE_MAX_CSS = 280
  // 气泡底边在窗口底往上 226px（渲染页的 BUBBLE_BOTTOM）：舞台顶 276 减去压入量 50。
  // 窗口高 = 这个底边 + 气泡实高 + 顶距；上限同理。
  const BUBBLE_BOTTOM = 226
  const H_MAX_BASE = Math.max(BASE_H, BUBBLE_BOTTOM + BUBBLE_MAX_CSS + 8)
  fitBaseH = Math.min(H_MAX_BASE, Math.max(REST_H, Math.round(Number(baseH)) || REST_H))
  const minH = Math.round(REST_H * curScale)  // 气泡收起：16(底距)+260(舞台)+8(顶距)
  const maxH = Math.round(H_MAX_BASE * curScale) // 兜底上限：长文本也放得下
  const h = Math.min(maxH, Math.max(minH, Math.round(fitBaseH * curScale)))
  const { w: ew } = expectedWinSize()
  const [w, oldH] = winSizeDip()
  // 宽度也必须守：宽度被撑大时人物在窗口里的横向位置同样错位。
  // 但高度差要用容差判：Windows 150% 下 setSize 会读回 ±2px，按严格相等会变成
  // 「每帧都判成变了 → 每帧 setSize → 窗口永远在抖」。只在**真的需要变**时才动。
  if (Math.abs(h - oldH) <= 1 && Math.abs(w - ew) <= SIZE_TOLERANCE) return
  try {
    const [, y] = win.getPosition()
    resizingSelf = true
    try {
      win.setResizable(true) // 创建时是 resizable:false，编程改尺寸前临时放开
      setSizeDip(ew, h)
    } finally { resizingSelf = false }
    // 钉哪条边 = **气泡往哪边长**（不是出生点）：
    //   · 气泡在头上（growsDown=false）→ 钉底边，窗口往上长，人物不动；
    //   · 气泡在脚下（growsDown=true）→ 钉顶边，窗口往下长，人物不动。
    // 两种都是「人物不动」，这正是我们要的：气泡伸缩不该把人物顶来顶去。
    const ny = bubbleGrowsDown() ? y : y + oldH - h
    win.setPosition(win.getPosition()[0], ny)
    // 窗口位置变了，移动基线也要跟上：不然拖拽去重拿陈基线会把第一帧当「重复坐标」吞掉
    lastMove = { x: win.getPosition()[0], y: ny }
    win.setResizable(false)
    invalidateThrowSpace() // 高度变了，边界要按新窗口高重算
  } catch {}
})
ipcMain.handle('pet:screen', () => {
  if (!win) return null
  const [x, y] = win.getPosition()
  const [w, h] = winSizeDip()
  const area = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 }).workArea
  return { W: area.width, H: area.height, x, y, areaX: area.x, areaY: area.y, size: w }
})
// 诊断：让渲染页把「人物包围盒 vs 舞台」的真实数据吐回来（查「动画被切掉」用）。
// 由主进程的 pollLoop 收到 /debug/crop 指令后调用，返回给插件侧。
async function debugCrop() {
  if (!win || win.isDestroyed()) return null
  try {
    const info = await win.webContents.executeJavaScript('window.__cropInfo ? window.__cropInfo() : null')
    const names = await win.webContents.executeJavaScript('window.__playAnimInfo ? window.__playAnimInfo() : null')
    const hits = await win.webContents.executeJavaScript('window.__hitStats || null')
    const flick = await win.webContents.executeJavaScript('window.__flickInfo ? window.__flickInfo() : null')
    const idleLoop = await win.webContents.executeJavaScript('window.__idleLoopInfo ? window.__idleLoopInfo() : null')
    // 随机链骰子配置 + 最近一次掷骰（2026-11-05）：查「包里那 90 多段到底进没进池」
    const roll = await win.webContents.executeJavaScript('window.__rollInfo ? window.__rollInfo() : null')
    return {
      crop: info, play: names, hits, flick, idleLoop, roll,
      winSize: winSizeDip(),
      winPos: win.getPosition(),
      // 主进程内部状态：排查「窗口被撑大 / 点不动」时看这几个数对不对
      internal: {
        BASE_W, REST_H, fitBaseH, curScale,
        expectW: Math.round(BASE_W * curScale),
        expectH: Math.round(fitBaseH * curScale),
        ignoreMouse: win.__ignoreMouse === true,
        lastMove,
        resizable: (() => { try { return win.isResizable() } catch { return null } })(),
        zoom: (() => { try { return win.webContents.getZoomFactor() } catch { return null } })(),
      },
    }
  } catch (e) { return { error: String(e && e.message || e) } }
}
/** 诊断：在窗口内某点做命中检测（判断「点不中她」是 DOM 命中问题还是窗口位置问题）。 */
async function debugProbe(x, y) {
  if (!win || win.isDestroyed()) return null
  try { return await win.webContents.executeJavaScript(`window.__probeHit ? window.__probeHit(${Number(x) || 0}, ${Number(y) || 0}) : null`) } catch (e) { return { error: String(e && e.message || e) } }
}
async function debugMeasure(name, samples) {
  if (!win || win.isDestroyed()) return null
  const arg = Array.isArray(samples) && samples.length
    ? `${JSON.stringify(String(name))}, ${JSON.stringify(samples)}`
    : JSON.stringify(String(name))
  try { return await win.webContents.executeJavaScript(`window.__measureAnim ? window.__measureAnim(${arg}) : null`) } catch (e) { return { error: String(e && e.message || e) } }
}

// ---------- 右键菜单（仿 dsh-pet 的菜单树：工具项 + 「动作」分类级联，动画显示原名） ----------
/** 读形象包配置、原名映射与素材文件表：直接读盘（packs 就在 host.json 旁边），不依赖插件版本。
 *  packName 省略 = 主宠物当前那个包；多开时传那一只自己的包名。
 *  返回 { manifest: 原名→id, cfg: 包配置（含 menu 分类）, labels: id→原名, files: 包目录里的文件名 }。 */
function loadPackMeta(packName) {
  const name = packName || (pack && pack.name) || 'default'
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
/** 出生点：面板「初始位置」选的角落 + 两个边距（pack.position，服务端 /config 下发）。
 *  dsh-pet 有这张表，搬过来时服务端发了、客户端却一直没读——所以以前怎么改都还是右下角。
 *  缺字段/坏值一律回落右下角 24/16，与旧行为完全一致。
 *  算出窗口左上角该在哪（按当前尺寸，工作区优先当前所在屏，屏幕都拔了就用主屏）。 */
function homePos() {
  if (!win || win.isDestroyed()) return null
  const [w, h] = winSizeDip()
  let area = null
  try {
    const [wx, wy] = win.getPosition()
    area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea
  } catch { area = null }
  if (!area) area = screen.getPrimaryDisplay().workArea
  const p = (pack && pack.position) || {}
  const corner = CORNERS[p.corner] ? p.corner : 'bottom-right'
  const mx = Math.max(0, Math.min(2000, Number(p.marginX)))
  const my = Math.max(0, Math.min(2000, Number(p.marginY)))
  const marginX = Number.isFinite(mx) ? mx : 24
  const marginY = Number.isFinite(my) ? my : 16
  const right = corner.endsWith('right')
  const bottom = corner.startsWith('bottom')
  // 边距按**窗口整体**量（不是人物脚底）：窗口 = 可见区域的全部，它的边就是屏幕上的边。
  // 把 CSS #stage 的 16px 留白掺进来会让窗口底部伸进任务栏 —— 那正是「越过屏幕底」的来源。
  // 人物脚底自然停在窗口底上方 16px，这是「站在地面上」的正常留白，不需要补偿。
  const x = right ? area.x + area.width - w - marginX : area.x + marginX
  const y = bottom ? area.y + area.height - h - marginY : area.y + marginY
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - w))),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - h))),
  }
}
/** 回到初始位置：停掉飞行，回面板设定的出生点（仿 dsh-pet 的 home）。 */
function goHome() {
  if (!win || win.isDestroyed()) return
  stopThrow()
  const p = homePos()
  if (p) setWinPos(p.x, p.y)
}
// 手动碎碎念文案池（真正的碎碎念由插件按面板里的间隔/文案池生成，这里只是插件不可达时的兜底）
const WHISPERS = ['在吗在吗？', '戳戳你～', '今天也要加油鸭！', '（盯着你看）', '摸鱼一时爽～', '想你啦！']
/** 直接在气泡里说一句（不走插件）。热键提示、拖图提示等本地反馈都用它。 */
function sayLocal(text) {
  try {
    win?.webContents.executeJavaScript(`window.__whisper && window.__whisper(${JSON.stringify(String(text || ''))})`).catch(() => {})
  } catch {}
}
/** 碎碎念：先请插件走自己的碎碎念流程（/whisper：会带碎碎念动画 + 现想一句）；
 *  插件不可达/没这接口时才退回「本地文案 + 本地气泡」。专注模式下插件会拒绝——那就安静。 */
function whisper() {
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
  // 喂食（数值体系，2026-11-06）：子菜单列出食物，冷却中/没有零食的置灰并写明原因。
  // 「点了没反应」是最差的体验，所以每一项都要说清楚现在能不能喂。
  const feedSub = (pack && pack.life && pack.life.feedEnabled)
    ? {
        label: '喂食',
        submenu: (pack.life.foods || []).map((f) => {
          const nowMs = Date.now()
          const cold = Number(f.readyAt || 0) > nowMs
          const noStock = f.snack && !(f.have > 0)
          const full = Number(pack.life.satiety) >= 95
          const why = full ? '（已经吃饱了）' : cold ? `（还要等 ${Math.max(1, Math.ceil((f.readyAt - nowMs) / 60000))} 分钟）`
            : noStock ? '（还没攒到）' : ''
          return {
            label: `${f.icon} ${f.name}${f.snack ? ` ×${f.have}` : ''}${why}`,
            enabled: !cold && !noStock && !full,
            click: () => feedPet(f.id),
          }
        }),
      }
    : null
  /** 喂一只：走服务端 /life/feed（它负责数值、冷却、台词和气话），失败原因用气泡说出来。 */
  async function feedPet(foodId) {
    try {
      const r = await apiPostAwait('/life/feed', { food: foodId })
      if (!r) return
      if (r.ok) { lifecycleCache = null; return }
      const why = r.reason === 'full' ? '吃不下啦～肚子圆滚滚的'
        : r.reason === 'cooldown' ? `还没饿呢，再等 ${Math.max(1, Math.ceil((r.waitMs || 0) / 60000))} 分钟`
          : r.reason === 'no-snack' ? '这个零食还没攒到，你先专心干会儿活嘛'
            : r.reason === 'feed-off' ? '喂食被关掉了（面板里能开）'
              : '现在喂不了'
      showBubble(why, '', '', '', '', 'feed', '喂食')
    } catch {}
  }
  const menu = Menu.buildFromTemplate([
    { label: '碎碎念', click: whisper },
    ...(chatCfg.enabled ? [{ label: chatWinAlive() ? '关闭对话框' : '打开对话框', click: toggleChat }] : []), // 与快捷键等效
    // 待办：开关关着就不摆入口（和对话框同一口径）。计数直接写进菜单，一眼看见还剩几件。
    ...(todoCfg.enabled ? [{
      label: (todoWinAlive() ? '关闭待办' : '待办') +
        (todoCfg.pending && todoCfg.pending.total ? `（${todoCfg.pending.total}）` : ''),
      click: toggleTodoWin,
    }] : []),
    { label: '回到初始位置', click: goHome },
    // 「查看余额」（上游 1.0.14，petShowBalance 开才显示）：走模块自己的 /balance（带 DeepSeek key 的
    // 本地实现，比上游的诚实降级版能真拿到数），GET 读缓存、POST 强制刷一次。
    ...(balanceEnabled ? [{
      label: '查看余额',
      click: async () => {
        try {
          const r = await apiGet('/balance')
          const view = r && r.view
          const c = r && r.result
          if (view && view.say) showBubble(view.say, 'happy', '', view.anim || '', '', 'balance', '余额', '', '', true) // big=true：余额播报用大字气泡
          else if (c && c.ok === false) {
            const why = c.reason === 'credential-missing' ? '还没填 DeepSeek API Key（面板「余额播报」里填）'
              : (c.message || '查不到')
            showBubble(`余额查不到：${why}`, '', '', '', '', 'balance', '余额', '', '')
          } else showBubble('余额还没查过，去面板里点一次刷新吧', '', '', '', '', 'balance', '余额', '', '')
        } catch (e) {
          showBubble('余额查询失败了，过会儿再试试吧', '', '', '', '', 'balance', '余额', '', '')
        }
      },
    }] : []),
    // 多开：第二只及以后。上限到了就置灰（摆一个点了没反应的入口比不摆更难解释）
    ...(multiApi || createMultiPets ? [{
      label: petCountLabel(),
      enabled: !multiApi || multiApi.size() < multiApi.MAX_EXTRA_PETS,
      click: () => { addExtraPet() },
    }] : []),
    ...((multiApi && multiApi.size()) ? [{
      label: '收掉多养的',
      click: () => {
        const n = multiApi.closeAll()
        sayLocal(n ? `收掉了 ${n} 只` : '没有多养的')
      },
    }] : []),
    ...(actionSub ? [actionSub] : []),
    ...(feedSub ? [feedSub] : []),
    // 内置玩法「吃白饭」（2026-11-05 跟进 dsh-pet 新版）：素材没配齐就没有这一项 ——
    // 摆一个点了没反应的入口，比不摆更难解释。
    ...(pack && Array.isArray(pack.baifan) && pack.baifan.length === 5
      ? [{ label: baifanBusy ? '让白饭停一下' : '吃白饭', click: () => toggleBaifan() }]
      : []),
    { label: '收起气泡', click: hideBubble },
    { type: 'separator' },
    // 睡 / 醒：睡眠状态机在 sleep 模块，这里只把意图发过去
    { label: '叫她睡觉 / 叫醒', click: () => toggleSleepFromMenu() },
    // 显示位置：直接挪到对应角落（dsh-pet 的 setPetDisplay）
    {
      label: '换个位置',
      submenu: [
        { label: '右下角', click: () => moveToCorner('bottom-right') },
        { label: '左下角', click: () => moveToCorner('bottom-left') },
        { label: '右上角', click: () => moveToCorner('top-right') },
        { label: '左上角', click: () => moveToCorner('top-left') },
      ],
    },
    { type: 'separator' },
    // 小屋（上游 1.0.12，petHouseEnabled 开才显示）：在屋内外切换
    ...(houseEnabled ? [{ label: houseAlive() ? '到屋外玩' : '回小屋', click: toggleHouse }] : []),
    { label: '打开面板', click: openPanel },
    { label: focusOn ? '关闭专注模式' : '开启专注模式', click: () => { focusOn = !focusOn; apiPost('/focus', { enabled: focusOn, source: 'pet-menu' }) } },
    { label: '隐藏桌宠', click: () => win?.hide() },
    { type: 'separator' },
    // 明确的「我不干了」：先告诉插件记下来（下次 DSH 启动不再自动拉起），再退
    { label: '退出桌宠', click: () => quitByUser('menu') },
  ])
  menu.popup({ window: win })
})
// ---------- 内置玩法「吃白饭」的主进程侧接线（2026-11-05 跟进 dsh-pet 新版）----------
// 主进程只负责三件事：开演/收场、与别的动作互斥、被拖动时打断。
// 演出本体（相位机、米饭层）全在渲染页的 baifan.js —— 它在窗口里，天然知道人物在哪、在播什么。
/** 玩法是否在跑（镜像渲染页状态，菜单文案与互斥都用它）。 */
let baifanBusy = false
/** 开演 / 收场。渲染页没回话（离线/没素材）就不改状态。 */
function toggleBaifan() {
  if (!win || win.isDestroyed()) return
  if (baifanBusy) {
    baifanBusy = false
    stopMover()
    win.webContents.executeJavaScript('window.__bfHalt && window.__bfHalt("menu")').catch(() => {})
    sayLocal('那不吃了')
    return
  }
  // 互斥：飞行中/正在走位/专注模式都不开演。玩法自己也会抢 moverOwner='baifan'，
  // 两者同时跑会互相 setPosition，画面就是一顿一顿往回拽。
  if (thrower) stopThrow()
  if (mover) stopMover()
  if (focusOn) { sayLocal('专注模式里不吃白饭'); return }
  win.webContents.executeJavaScript('window.__bfStart && window.__bfStart()')
    .then((r) => {
      if (r && r.ok) { baifanBusy = true; return }
      baifanBusy = false
      const why = r && r.why
      sayLocal(why === 'no-config' ? '这个形象包没有「吃白饭」的素材' : '现在开不了饭…')
    })
    .catch(() => { baifanBusy = false })
}
/** 外部打断（拖动 / 甩飞 / 专注模式 / 隐藏 / 关窗）：玩法必须当场收场，
 *  否则它的走位会和拖拽弹簧同时 setPosition，变成「一顿一顿往回拽」。 */
function interruptBaifan(why) {
  if (!baifanBusy) return
  baifanBusy = false
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`window.__bfHalt && window.__bfHalt(${JSON.stringify(String(why || 'interrupt'))})`).catch(() => {})
}
/** 菜单「叫她睡觉 / 叫醒」：把意图发给插件，由 sleep 模块的状态机决定实际动作。 */
function toggleSleepFromMenu() {
  const h = readHost()
  if (!h) return sayLocal('插件没连上，先开 DSH 吧')
  fetch(`${h.baseUrl}${h.api}/sleep/toggle`, {
    method: 'POST',
    headers: { 'x-pet-token': h.token, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'pet-menu' }),
  }).then((r) => r.json()).then((d) => {
    if (d && d.ok === false) sayLocal(String(d.message || '睡眠模块没开'))
  }).catch(() => sayLocal('叫不动她…'))
}
/** 菜单「换个位置」：直接挪到指定角落（用面板配的边距）。 */
function moveToCorner(corner) {
  if (!win || win.isDestroyed()) return
  stopThrow()
  const [w, h] = winSizeDip()
  let area = null
  try {
    const [wx, wy] = win.getPosition()
    area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea
  } catch { area = null }
  if (!area) area = screen.getPrimaryDisplay().workArea
  const p = (pack && pack.position) || {}
  const mx = Number.isFinite(Number(p.marginX)) ? Number(p.marginX) : 24
  const my = Number.isFinite(Number(p.marginY)) ? Number(p.marginY) : 16
  const right = String(corner).endsWith('right')
  const bottom = String(corner).startsWith('bottom')
  const x = right ? area.x + area.width - w - mx : area.x + mx
  const y = bottom ? area.y + area.height - h - my : area.y + my
  setWinPos(
    Math.round(Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - w))),
    Math.round(Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - h))),
  )
  // 上沿/下沿布局要跟着翻（气泡往哪边长）
  pushCornerToRenderer()
}

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
/**
 * 把对话框摆到**人物本体**旁边，而不是窗口旁边。
 *
 * 为什么不能用窗口坐标（原来那版的 bug）：主窗比人物大一圈——上面是气泡留白、
 * 左右各 20px 透明边、下面 16px 底距。而且气泡弹出时窗口会**向上长高**
 * （钉底边，见 pet:fit），窗口顶边会一路顶到气泡上方去。
 * 所以「py + ph*0.15」算出来的位置会随着气泡高度乱跑：
 *   · 出生点在下沿时，窗口被气泡撑高 → y 算出来越来越小 → 对话框往上飘；
 *   · 出生点在上沿（top-left/top-right）时更糟：窗口钉的是**顶边**，
 *     人物其实在窗口**下方**，而 py 是窗口顶 → 算出来的 y 落在人物**上面**，
 *     气泡一长高还会越过人物头顶。用户看到的就是「对话框跑到桌宠下方」。
 *
 * 现在按人物屏幕矩形（bodyScreenRect）锚定：
 *   · 优先放人物**右侧**（人物右缘 + 8px），右边放不下就放左侧；
 *   · 竖直方向对齐人物**顶部**（不是窗口顶），再夹进工作区；
 *   · 人物贴着屏幕上沿时，往下让一点，别让标题栏被屏幕切掉。
 */
function positionChatWin() {
  if (!chatWin || chatWin.isDestroyed() || !win || win.isDestroyed()) return
  try {
    const body = bodyScreenRect()
    if (!body) return
    const [cw, ch] = chatWin.getSize()
    const area = screen.getDisplayNearestPoint({
      x: Math.round((body.left + body.right) / 2),
      y: Math.round((body.top + body.bottom) / 2),
    }).workArea
    const GAP = 8
    // 水平：右边放得下就放右边，否则左边，都放不下就贴右边缘
    let x
    if (body.right + GAP + cw <= area.x + area.width) x = body.right + GAP
    else if (body.left - GAP - cw >= area.x) x = body.left - GAP - cw
    else x = area.x + area.width - cw
    // 竖直：对齐**人物顶**（不是窗口顶），再夹进工作区
    let y = body.top
    y = Math.min(Math.max(y, area.y), area.y + area.height - ch)
    x = Math.min(Math.max(x, area.x), area.x + area.width - cw)
    chatWin.setPosition(Math.round(x), Math.round(y))
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
// 对话框跟着人物走：拖动、被甩、走路、气泡伸缩（窗口长高）、缩放变化都要重摆。
// 为什么不能只在打开时摆一次：桌宠会自己走路，也会被拖走；气泡一弹窗口就长高，
// 而对话框如果钉在旧位置，就变成「人在左边、对话框还在右边」或者干脆压到人物身上。
// 用一个 60ms 的轮询兜住所有情况——比给每个 setPosition 调用点都插一句更可靠
// （主窗移动有十几条路径：拖拽、甩抛、wander、chase、召唤、吸附……逐个插必漏）。
let lastChatAnchor = ''
setInterval(() => {
  if (!chatWinAlive()) { lastChatAnchor = ''; return }
  const b = bodyScreenRect()
  if (!b) return
  // 只有人物矩形真的变了才重摆（否则每 60ms 都 setPosition 一次会让窗口抖）
  const key = `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)}`
  if (key === lastChatAnchor) return
  lastChatAnchor = key
  positionChatWin()
}, 60).unref?.()
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
ipcMain.on('pet:chat:send', (_e, text) => { sendChatText(text) })
/**
 * 真正发一句话进对话框：两条入口共用（手打 / 按住说话转出来的字）。
 * 让语音走同一条路是必须的——关键字关闭、并发锁、失败提示都只在这一处，
 * 另开一条会把「说『再见』就关窗」这类行为悄悄绕掉。
 */
async function sendChatText(text) {
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
}


// ---------- 待办小窗（todo.html：独立 BrowserWindow，和对话框同一套路） ----------
// 为什么不塞进桌宠气泡：主窗只有 ~460 宽，一张可编辑清单会把窗口顶到 700 高、还把人物挤走。
// 数据全走插件：GET /todos（DSH 那边的只读 + 本地自记的合并视图）、POST /todos、/todos/patch、/todos/remove。
let todoWin = null
let todoCfg = { enabled: true, hotkey: '', pending: { local: 0, dsh: 0, total: 0 } }
let todoHotkeyReg = ''
let todoHotkeyState = 'unconfigured'
let todoHotkeyWarnedAt = 0
const todoWinAlive = () => Boolean(todoWin && !todoWin.isDestroyed() && todoWin.isVisible())
function positionTodoWin() {
  if (!todoWin || todoWin.isDestroyed() || !win || win.isDestroyed()) return
  try {
    const [pw, ph] = winSizeDip()
    const [px, py] = win.getPosition()
    const [cw, ch] = todoWin.getSize()
    const area = screen.getDisplayNearestPoint({ x: px + pw / 2, y: py + ph / 2 }).workArea
    // 和对话框错开：待办放右侧（对话框占左侧），两边同时开着也不叠
    const x = Math.round(Math.min(Math.max(px + pw + 8, area.x), area.x + area.width - cw))
    const y = Math.round(Math.min(Math.max(py + Math.round(ph * 0.12), area.y), area.y + area.height - ch))
    todoWin.setPosition(x, y)
  } catch {}
}
function closeTodoWin() {
  if (!todoWin || todoWin.isDestroyed()) return
  try { todoWin.close() } catch {}
}
/** 整张清单塞进窗口（服务端为准，本地不猜结果）。 */
function pushTodoList() {
  if (!todoWin || todoWin.isDestroyed()) return
  apiGet('/todos').then((d) => {
    if (!todoWin || todoWin.isDestroyed()) return
    if (d && d.ok && Array.isArray(d.todos)) {
      todoWin.webContents.executeJavaScript(`window.__todoRender && window.__todoRender(${JSON.stringify(d.todos)})`).catch(() => {})
    } else {
      todoWin.webContents.executeJavaScript(`window.__todoError && window.__todoError('清单没拉到，稍后再试试')`).catch(() => {})
    }
  }).catch(() => {
    if (todoWin && !todoWin.isDestroyed()) {
      todoWin.webContents.executeJavaScript(`window.__todoError && window.__todoError('没连上插件，稍后再试')`).catch(() => {})
    }
  })
}
function openTodoWin() {
  if (todoWin && !todoWin.isDestroyed()) { todoWin.show(); todoWin.focus(); pushTodoList(); return }
  todoWin = new BrowserWindow({
    width: 340, height: 460, frame: false, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false,
    // 本地小窗只加载同目录 todo.html（无远程内容），直接 nodeIntegration 省一套 preload
    webPreferences: { nodeIntegration: true, contextIsolation: false, spellcheck: false },
  })
  todoWin.setAlwaysOnTop(true, 'screen-saver')
  todoWin.loadFile(path.join(__dirname, 'todo.html'))
  todoWin.webContents.on('did-finish-load', () => pushTodoList())
  todoWin.once('ready-to-show', () => {
    positionTodoWin()
    // showInactive 再 focus：裸 show() 在无边框 + 透明主窗还在的同进程里偶尔不真正翻可见
    // （实测 isVisible() 一直 false，窗口对象和 bounds 都在，就是没画出来）。
    try { todoWin.show() } catch {}
    try { todoWin.moveTop() } catch {}
    todoWin.focus()
    pushTodoList()
  })
  todoWin.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') closeTodoWin() })
  // 失焦收起：只在「它真的拿到过焦点」之后才生效。
  // 否则 show() 之后到 focus() 落地之间会先来一发 blur，窗口刚开就被自己关掉（实测踩过）。
  let todoEverFocused = false
  todoWin.on('focus', () => { todoEverFocused = true })
  todoWin.on('blur', () => {
    appendDebugLog({ kind: 'todo-blur', everFocused: todoEverFocused })
    if (todoEverFocused) closeTodoWin()
  })
  todoWin.webContents.on('render-process-gone', (_e, d) => appendDebugLog({ kind: 'todo-crash', detail: String(d && d.reason || '') }))
  todoWin.webContents.on('did-fail-load', (_e, code, desc) => appendDebugLog({ kind: 'todo-loadfail', code, desc: String(desc || '') }))
  // console-message 的新签名是 (event) → event.message/level；旧的多参形式已废弃且会抛错。
  todoWin.webContents.on('console-message', (event, ...rest) => {
    try {
      const level = Number(event && event.level !== undefined ? event.level : rest[0]) || 0
      const message = String((event && event.message) ?? rest[1] ?? '')
      if (level >= 2 && !/Electron Security Warning/.test(message)) {
        appendDebugLog({ kind: 'todo-console', level, message: message.slice(0, 300) })
      }
    } catch {}
  })
  todoWin.on('closed', () => {
    appendDebugLog({ kind: 'todo-closed' })
    todoWin = null
  })
  todoWin.on('hide', () => appendDebugLog({ kind: 'todo-hide' }))
}
function toggleTodoWin() {
  if (!todoCfg.enabled) return
  if (todoWinAlive()) closeTodoWin()
  else openTodoWin()
}
/** 待办快捷键：和对话框同一套注册/占用提醒；配置变更先注销旧键。 */
function applyTodoHotkey() {
  const want = todoCfg.enabled && todoCfg.hotkey ? todoCfg.hotkey : ''
  if (want === todoHotkeyReg) return
  if (todoHotkeyReg) { try { globalShortcut.unregister(todoHotkeyReg) } catch {} ; todoHotkeyReg = '' }
  if (!want) { todoHotkeyState = 'unconfigured'; return }
  let ok = false
  try { ok = globalShortcut.register(want, toggleTodoWin) } catch { ok = false }
  if (ok) { todoHotkeyReg = want; todoHotkeyState = 'registered' } else {
    todoHotkeyState = 'failed'
    if (Date.now() - todoHotkeyWarnedAt > 5 * 60_000) {
      todoHotkeyWarnedAt = Date.now()
      showBubble(`快捷键 ${want} 被别的程序占用了，待办快捷键没生效（可在面板换一个）`, '', 'text', '', '', 'todo', '待办')
    }
  }
}
// 小窗 → 主进程：三件事都先标忙碌、成功后整份重拉（以服务端为准）
ipcMain.on('pet:todo:add', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const text = String(p.text || '').trim().slice(0, 200)
  if (!text) return
  const send = (fn, ...args) => { if (todoWin && !todoWin.isDestroyed()) todoWin.webContents.executeJavaScript(`window.${fn} && window.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`).catch(() => {}) }
  send('__todoBusy', true)
  const r = await apiPostAwait('/todos', { text, dueAt: p.dueAt === undefined ? null : p.dueAt })
  if (r && r.ok) { send('__todoAdded'); pushTodoList() } else send('__todoError', (r && r.message) || '没加上，稍后再试')
})
ipcMain.on('pet:todo:patch', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (!p.id) return
  const body = { id: String(p.id) }
  if (p.done !== undefined) body.done = Boolean(p.done)
  if (p.text !== undefined) body.text = String(p.text)
  const r = await apiPostAwait('/todos/patch', body)
  if (todoWin && !todoWin.isDestroyed()) {
    if (r && r.ok) pushTodoList()
    else todoWin.webContents.executeJavaScript(`window.__todoError && window.__todoError(${JSON.stringify((r && r.message) || '改不动，稍后再试')})`).catch(() => {})
  }
})
ipcMain.on('pet:todo:remove', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (!p.id) return
  const r = await apiPostAwait('/todos/remove', { id: String(p.id) })
  if (todoWin && !todoWin.isDestroyed()) {
    if (r && r.ok) pushTodoList()
    else todoWin.webContents.executeJavaScript(`window.__todoError && window.__todoError(${JSON.stringify((r && r.message) || '删不掉，稍后再试')})`).catch(() => {})
  }
})
ipcMain.on('pet:todo:close', () => closeTodoWin())


// ---------- 按住说话（本地语音识别：渲染页录音 → 插件转文字） ----------
// 分三段的理由：麦克风只有渲染进程（有 getUserMedia）拿得到，原生 addon 只有主/插件进程加载得了。
// 所以渲染页录音并拼成 16kHz 单声道 PCM16 WAV（base64）→ ipc 给主进程 → POST /voice/hear → 文字。
let hearBusy = false
/** 起录：让渲染页开麦克风（渲染页那边维护录音器本身）。 */
function hearStart() {
  if (!win || win.isDestroyed()) return
  if (hearBusy) return
  if (hearCfg.enabled === false) { sayLocal('按住说话关着（面板里打开）'); return }
  hearBusy = true
  win.webContents.executeJavaScript('window.__hearStart && window.__hearStart()').catch(() => {})
}
/** 结录：渲染页停下并把 WAV 交回来（走 pet:hear 通道），这里不再做别的。 */
function hearStop() {
  if (!win || win.isDestroyed()) return
  if (!hearBusy) return
  win.webContents.executeJavaScript('window.__hearStop && window.__hearStop()').catch(() => {})
}
let hearCfg = { enabled: true, sendToChat: true }
ipcMain.on('pet:hear-state', (_e, state) => {
  const st = String(state || '')
  if (st === 'listening') { hearBusy = true; sayLocal('在听…'); return }
  if (st === 'empty') { hearBusy = false; sayLocal('没听到声音呀'); return }
  if (st === 'short') { hearBusy = false; return } // 误碰（几十毫秒）：不吭声
  if (st === 'cancelled') { hearBusy = false; return }
})
// 渲染页录完 → 识别 → 送对话框
ipcMain.handle('pet:hear', async (_e, base64) => {
  const audio = String(base64 || '')
  hearBusy = false
  if (!audio) return { ok: false, message: '没录到音频' }
  const r = await apiPostAwait('/voice/hear', { audio })
  if (!r) return { ok: false, message: '没连上插件，稍后再试' }
  if (!r.ok) {
    const why = r.reason === 'disabled' ? '按住说话关着（面板里打开）'
      : r.reason === 'unsupported' ? (r.message || '没有语音识别模型')
      : r.reason === 'bad-request' ? (r.message || '音频不对')
      : (r.message || '没听清，再说一次？')
    sayLocal(why)
    return { ok: false, message: why }
  }
  if (r.empty) { sayLocal('没听清，再说一次？'); return { ok: false, message: '没听清' } }
  const text = String(r.text || '').trim()
  if (!text) { sayLocal('没听清，再说一次？'); return { ok: false, message: '没听清' } }
  // 去向：开「直接发送」就当成一句话发进对话框（她马上回）；关掉只填进输入框让人自己确认
  if (!chatWin || chatWin.isDestroyed()) { if (chatCfg.enabled) openChatWin() }
  if (chatWin && !chatWin.isDestroyed()) {
    const js = (fn, ...args) => chatWin.webContents.executeJavaScript(`window.${fn} && window.${fn}(${args.map((a) => JSON.stringify(String(a ?? ''))).join(',')})`).catch(() => {})
    if (hearCfg.sendToChat !== false) {
      // 走同一条发送链路（含关键字闸）：先画上用户那句，再发
      chatWin.webContents.executeJavaScript(`window.__chatUser && window.__chatUser(${JSON.stringify(text)})`).catch(() => {})
      sendChatText(text)
      sayLocal('听到了：' + text.slice(0, 30))
    } else {
      js('__chatFill', text)
    }
  }
  return { ok: true, text }
})


// ---------- 小屋（上游 1.0.12 复式场景窗：移植自 zizic04/dsh-pet-home，MIT；素材 CC BY-NC-SA 禁商用，自用） ----------
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
  const names = metaApi.knownAnims(view.animations, loadPackMeta(view.name).files)
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
    // 【白屏兜底】Windows 实测：隐藏首开的窗口偶发**不触发 ready-to-show**（首帧绘制被饿死，
    // 页面其实加载好了，console/did-fail-load 全程无异常），show() 永远不执行，窗口一直白着。
    // 加载成功后 2.5s 检查一次，仍不可见就直接亮窗——backgroundColor 已是深色 #1d1a17，最多闪一下深底。
    setTimeout(() => {
      try {
        if (houseAlive() && !houseWin.isVisible()) { houseWin.show(); pushHouseAssets() }
      } catch {}
    }, 2500)
  }).catch((err) => console.error('小屋页加载失败：', err && err.message ? err.message : err))
  // ---------- 小屋窗自愈：主窗同款——白屏兜底，防崩循环靠冷却 + 次数上限 ----------
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
  try { if (win && !win.isDestroyed()) win.hide() } catch {}
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

// ---------- 窗口 / 托盘 ----------
// 白屏自愈的两个共享状态（上游 2026-11-07）：
//   · lastReloadAt：渲染进程崩溃重载的冷却戳（10s 内只救一次，防「崩→重载→又崩」打满 CPU）
//   · loadRetryLeft：主框架加载失败的重试余量（≤2，成功后由 did-finish-load 回满）
let lastReloadAt = 0
let loadRetryLeft = 2
/** 渲染进程崩溃后的白屏自愈：10s 冷却内只重载一次，冷却外才真的 reload。 */
const reloadForWhiteScreen = () => {
  const now = Date.now()
  if (now - lastReloadAt < 10_000) return // 冷却内不重复 reload
  lastReloadAt = now
  try { win && !win.isDestroyed() && win.webContents.reload() } catch {}
}
function createWindow() {
  win = new BrowserWindow({
    // 初始高度先按「气泡收起」的 REST_H（284）；气泡一弹出，pet:fit 会按实高往上长。
    // 宽 502 = 20(左距) + 462(舞台) + 20(右距)，舞台与素材 640×360 同比例
    width: BASE_W, height: REST_H,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 透明区域放行鼠标点击（不然窗口会挡住身后的一切）。
  // 两条通道并存：渲染页悬停上报 + 主进程光标轮询兜底（forward 钩子在 Windows 上会静默失效）。
  ignoreNow = true
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  win.loadFile(path.join(__dirname, 'index.html'))
  // 渲染页的 JS 报错不会进 stderr：接住它并落盘，否则「整个脚本没跑起来」只能靠猜。
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) appendDebugLog({ kind: 'console', level, message: String(message).slice(0, 500), line, source: String(source || '').slice(-60) })
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    appendDebugLog({ kind: 'renderer-gone', details })
    // 白屏自愈（上游 2026-11-07）：崩溃后窗口会留着一块白板没人救，自动重载救回。
    // clean-exit/exited 是正常退出路径，不算事故，不救（否则退出时还会闪一下重载）。
    if (!details || details.reason === 'clean-exit' || details.reason === 'exited') return
    debugIconLog({ kind: 'render-gone', reason: details.reason, exitCode: details.exitCode })
    reloadForWhiteScreen()
  })
  win.webContents.on('preload-error', (_e, p, err) => appendDebugLog({ kind: 'preload-error', p, err: String(err && err.message || err) }))
  // 白屏自愈②：主框架加载失败（页面根本没起来）。
  // -3 = ABORTED（换源/重载主动中断）不算失败；重试余量 ≤2，成功后由 did-finish-load 回满。
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return
    debugIconLog({ kind: 'load-fail', code, desc: String(desc || '') })
    if (loadRetryLeft <= 0) return
    loadRetryLeft--
    try { win.loadFile(path.join(__dirname, 'index.html')) } catch {}
  })
  win.webContents.on('did-finish-load', () => { loadRetryLeft = 2 }) // 加载成功：余量回满
  win.once('ready-to-show', () => { clampWindowToArea(); pushPackToRenderer(); startPointerFallback() })
  win.on('show', () => { clampWindowToArea(); stopThrow(); startPointerFallback() }) // 重新显示时确保回到屏幕内、且没有残留的飞行循环
  win.on('hide', () => { interruptBaifan('hide'); stopThrow(); stopPointerFallback() })
  win.on('closed', () => { interruptBaifan('closed'); stopThrow(); stopPointerFallback(); win = null; dropPetState(PET_ID) })
  // 诊断 + 守卫：谁在改窗口尺寸。
  // 期望尺寸是 252×346（scale 0.9），实测会被撑到 2081×1008，人物因此沉到任务栏下面。
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return
    try {
      const [w, h] = winSizeDip()
      const { w: ew, h: eh } = expectedWinSize()
      // 容差内视为正常（Windows 150% 下读回会差 ±2px），不刷日志也不纠正
      if (Math.abs(w - ew) <= SIZE_TOLERANCE && Math.abs(h - eh) <= SIZE_TOLERANCE) return
      appendDebugLog({ kind: 'win-resize', size: [w, h], expect: [ew, eh], fitBaseH, curScale, resizable: win.isResizable(), self: resizingSelf })
      enforceWindowSize('resize-event')
    } catch {}
  })
  registerPetWindow(PET_ID, win)
}

// ---------- 多开（第二只及以后） ----------
// 策略见 multi.js 顶部注释：额外宠物与主宠物完全隔离，只共用渲染页、broker 与 IPC。
// 这里只负责把 main.js 里的既有能力（bodyBox / sideInsetOf / 物理参数 / broker）递给它。
function initMultiPets() {
  if (!createMultiPets || multiApi) return multiApi
  try {
    multiApi = createMultiPets({
      getMainWin: () => win,
      els: { BrowserWindow, screen },
      bodyBox,
      sideInsetOf,
      getPhysics: () => ({ ...physics.DEFAULT_PHYSICS, ...(pack && pack.physics ? pack.physics : {}) }),
      physics,
      registerPetWindow,
      dropPetState,
      updatePetState,
      getPetRegistry: () => petRegistry,
      log: (level, msg) => appendDebugLog({ kind: 'multi-' + level, msg: String(msg || '') }),
      baseW: BASE_W,
      restH: REST_H,
      stageW: STAGE_W_CSS,
      stageH: STAGE_H_CSS,
      hitBoxX0: HIT_BOX.x0,
      // 额外宠物也要动画素材：建窗就绪 / 换形象包时各推一次。
      // 不推的话它只能显示静态兜底形象（实测：一只蓝色圆形图标，人物根本没出来）。
      // 参数是那一只自己绑的包名（空 = 跟随主宠物）。
      getPackScript: (packName) => packScript(packName),
      // 气泡长高时钉哪条边：与主宠物 isTopCorner() 同源（上沿出生点钉顶边，否则钉底边）
      // 气泡长高时钉哪条边：**按那一只此刻的位置**算（不是出生点）。
      // 传 rec 进去让它按自己的窗口算，别共用主宠物的结论。
      bubbleGrowsDown: (rec) => bubbleGrowsDown(rec || null),
      isTopCorner: () => isTopCorner(),
    })
  } catch (e) {
    appendDebugLog({ kind: 'multi-init-error', msg: String(e && e.message || e) })
    multiApi = null
  }
  return multiApi
}
/** 加一只：开出来之后让它从当前窗口顶上一路落到地面（有个「登场」的动作，不然像凭空贴住）。
 *  槽位按「第一个空的」补：右键菜单/托盘点一下应该补上最近的空档，而不是硬塞到最后。 */
function addExtraPet() {
  const api = initMultiPets()
  if (!api) { sayLocal('多开模块没装上，只能养一只'); return null }
  const r = api.create({})
  if (!r.ok) { sayLocal(r.message || '开不出来'); return null }
  sayLocal('又生了一只～')
  return r.id
}
function petCountLabel() {
  const extra = multiApi ? multiApi.size() : 0
  return extra ? `多养一只（现在 ${extra + 1} 只）` : '多养一只'
}

function createTray() {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEUlEQVR42mNk+M9Qz4AFMGETAG1hCQeukhTbAAAAAElFTkSuQmCC', 'base64'))
    tray = new Tray(img)
    tray.setToolTip('Aurabot 桌宠')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => (win ? (win.isVisible() ? win.hide() : win.show()) : createWindow()) },
      ...(chatCfg.enabled ? [{ label: chatWinAlive() ? '关闭对话框' : '打开对话框', click: toggleChat }] : []),
      { label: '收起气泡', click: hideBubble },
      { type: 'separator' },
      // 多开：托盘里也给一个入口（右键菜单走的是渲染页命中区，桌宠穿透时点不到）
      ...(createMultiPets ? [{
        label: petCountLabel(),
        enabled: !multiApi || multiApi.size() < multiApi.MAX_EXTRA_PETS,
        click: () => { addExtraPet() },
      }] : []),
      ...((multiApi && multiApi.size()) ? [{ label: '收掉多养的', click: () => { multiApi.closeAll() } }] : []),
      { type: 'separator' },
      { label: '退出桌宠', click: () => quitByUser('tray') },
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
  watchBubbleSide() // 位置变了就把气泡翻到该在的那一边（她走动/掉下来/被拖都要跟）
  // 注意：不要在这里用 process.ppid 做父子探活。
  // 实测（2026-11-04）：Electron 被 spawn 出来后 ppid 并不可靠（中间可能隔了一层，
  // 也可能指向已经退出的启动器），process.kill(ppid, 0) 会立刻误判"父进程已退出"而自杀。
  // 孤儿问题交给 pollLoop 里的「连续 N 次连不上插件就自退」——那个判据是真实业务信号，不会误杀。
})
// 父进程（DSH）守护：插件是被 DSH spawn 出来的，DSH 一关，父 pid 就变成孤儿（Windows 上不会回收）。
// 插件自己在 will-quit 里也会尝试杀 Electron，但 DSH 被强关 / 崩溃时那条路径走不到，所以要自检。
app.on('window-all-closed', () => {}) // 关窗不退出，从托盘退
// 退出前一定放开鼠标裁剪区 + 收掉助手进程：ClipCursor 是系统级状态，带不走就成「用户鼠标被锁死」的事故
app.on('will-quit', () => { try { releaseCursorClip(); stopCursorHelper(); globalShortcut.unregisterAll() } catch {} })
process.on('exit', () => { try { releaseCursorClip() } catch {} })
