// Aurabot 桌宠 · 多开（第二只及以后）。
//
// 为什么单独一个文件：main.js 里有 200 多处引用全局 `win`（主宠物的窗口），
// 把那些全部改成「按窗口查表」是一次高风险重构，收益却只有多开。
// 所以这里的策略是**不相干**：
//   · 主宠物仍然走 main.js 那套全局 win（一个字节都不用改）
//   · 额外的宠物各自有独立的 win/物理循环/穿透状态，只复用同一份渲染页与一组 IPC
//   · 两边唯一的交汇点是 petRegistry（碰撞 broker），它们本来就已经在里面了
//
// 每只额外宠物都跑一条**独立的**抛掷循环，互不干涉；碰撞在各自的循环里查 broker 里的别人。

'use strict'

const path = require('node:path')

/** 额外宠物的上限：再多就纯属互相打架了，也给主进程留点余地。 */
const MAX_EXTRA_PETS = 4

/**
 * 造多开能力。
 *
 * @param {object} deps
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWin - 主宠物窗口（父窗口，用于托盘/菜单归属）
 * @param {object} deps.els - element / BrowserWindow / screen / nativeImage / Menu 等私有依赖
 * @param {(x:number, y:number) => any} deps.bodyBox - 舞台盒换算（与主宠物同一份）
 * @param {(body:any) => {left:number,right:number}} deps.sideInsetOf - 左右可见余量
 * @param {(now:number) => any} deps.getPhysics - 物理参数（主进程已合并 pack.physics）
 * @param {any} deps.physics - physics.js 模块
 * @param {(petId:string, w:any) => void} deps.registerPetWindow
 * @param {(petId:string) => void} deps.dropPetState
 * @param {(petId:string, partial:any) => void} deps.updatePetState
 * @param {() => Map<string, any>} deps.getPetRegistry - 碰撞 broker
 * @param {(level:string, msg:string) => void} deps.log
 * @param {number} deps.baseW - 窗口基准宽（502）
 * @param {number} deps.restH - 气泡收起时的窗口高（284）
 * @param {number} deps.stageW - 舞台宽（462）
 * @param {number} deps.stageH - 舞台高（260）
 * @param {number} deps.hitBoxX0 - 命中框（640×360 口径）
 * @returns 多开控制器
 */
function createMultiPets(deps) {
  const {
    getMainWin, els, bodyBox, sideInsetOf, getPhysics, physics,
    registerPetWindow, dropPetState, updatePetState, getPetRegistry, log,
    baseW, restH, stageW, stageH, hitBoxX0, getPackScript, isTopCorner,
    /** 气泡往哪边长（true = 在人物脚下往下长）。按**这一只此刻在屏幕的位置**算，
     *  不是按出生点 —— 出生点只决定启动摆位，之后她会走会掉会被甩。
     *  主进程传进来的这个函数对每只都适用（它内部按 bodyScreenRect 现算）。 */
    bubbleGrowsDown,
  } = deps
  const { BrowserWindow, screen } = els

  /** 给这只宠物推素材表（形象包换了主宠物会重推，这里也要跟上）。
   *  rec.pack 有值时用它自己的包，否则跟主宠物同一份。
   *  上沿/下沿布局不用单独推：packScript 里已经带了 atTop，__setPack 会自己翻。 */
  function pushPack(rec) {
    if (!rec || !rec.win || rec.win.isDestroyed()) return
    let js = ''
    try { js = typeof getPackScript === 'function' ? String(getPackScript(rec.pack || '') || '') : '' } catch { js = '' }
    if (!js) return
    rec.win.webContents.executeJavaScript(js).catch(() => {})
  }
  /** 全部额外宠物重推一次素材表（换形象包时由主进程调用）。 */
  function pushPackAll() { for (const rec of pets.values()) pushPack(rec) }

  /** petId -> { id, slot, pack, scale, win, state:{x,y,vx,vy,size,bottomPad}, thrower, ignoreNow, busy, ... } */
  const pets = new Map()
  /** 槽位上限：与服务端的 EXTRA_MAX 同为 4（id 固定 pet-1..pet-4）。 */
  const MAX_EXTRA_PETS = 4

  /** 当前缩放倍率：与主宠物同源（窗口宽 / 基准宽）。 */
  function scaleOf(w) {
    return Math.min(2, Math.max(0.5, Number(w) / baseW))
  }

  /**
   * 这只宠物该占的窗口尺寸。
   *
   * 高度不再是「气泡收起」的定值了：额外那几只也会冒气泡（各自的人格），
   * 所以要跟主宠物一样按「气泡是否显示 + 气泡实高」上报来长高（pet:extra:fit）。
   * 这里返回的是**最低**高度（气泡收起时的 REST_H），真正的高度在 rec.fitBaseH 里。
   */
  function sizeOf(scale, fitBaseH) {
    const base = Math.max(restH, Math.round(Number(fitBaseH) || restH))
    return {
      w: Math.round(baseW * scale),
      h: Math.round(base * scale),
    }
  }

  /**
   * 给一只宠物挑初始位置：贴着主宠物旁边排开，整块可见，不互相压住。
   *
   * @param {number} w - 窗口宽
   * @param {number} h - 窗口高
   * @param {number} idx - 第几只额外宠物（0 起）
   */
  function homeFor(w, h, idx) {
    const main = getMainWin()
    let ax = null, ay = null, aw = 0, ah = 0
    if (main && !main.isDestroyed()) {
      try {
        const b = main.getBounds()
        ax = b.x; ay = b.y; aw = b.width; ah = b.height
      } catch {}
    }
    const area = ax === null
      ? screen.getPrimaryDisplay().workArea
      : screen.getDisplayNearestPoint({ x: Math.round(ax + aw / 2), y: Math.round(ay + ah / 2) }).workArea
    if (ax === null) {
      return { x: area.x + area.width - w - 24, y: area.y + area.height - h - 16 }
    }
    // 主宠物左侧依次排开（left of main），排不下就换到右边，再不行就叠一点
    const gap = 6
    const tryX = ax - w - gap - idx * (w + gap)
    let x = tryX
    if (x < area.x) x = ax + aw + gap + (idx - 1) * (w + gap)
    if (x + w > area.x + area.width) x = area.x + area.width - w - 16
    if (x < area.x) x = area.x + 8
    const y = Math.min(Math.max(ay + (ah - h), area.y), area.y + area.height - h)
    return { x: Math.round(x), y: Math.round(y) }
  }

  /** 这只宠物按当前状态该不该穿透（简化版：只在身体上才可交互，其余全穿透）。 */
  function setIgnore(rec, ignore) {
    if (!rec.win || rec.win.isDestroyed()) return
    if (rec.ignoreNow === ignore) return
    rec.ignoreNow = ignore
    try { rec.win.setIgnoreMouseEvents(ignore, { forward: true }) } catch {}
  }

  /**
   * 建一只额外的宠物。
   *
   * 槽位（slot）是**按位置的身份**：id 固定 pet-1..pet-4，与插件侧的槽位表一一对应。
   * 这样「把第二只换成别的形象」只是重建那一只，另外三只原地不动、id 也不变（面板的卡不会错位）。
   *
   * @param {{ slot?: number, scale?: number, pack?: string, x?: number, y?: number }} [opts]
   * @returns {{ ok:boolean, id?:string, message?:string }}
   */
  function create(opts = {}) {
    // 槽位：显式给了就按它（面板/配置驱动）。没给就找第一个空槽（右键「多养一只」走这条）。
    let slot = Number(opts.slot)
    if (!Number.isFinite(slot) || slot < 0 || slot >= MAX_EXTRA_PETS) {
      slot = 0
      while (slot < MAX_EXTRA_PETS && pets.has(`pet-${slot + 1}`)) slot += 1
    }
    const id = `pet-${slot + 1}`
    const existing = pets.get(id)
    if (existing) return { ok: false, message: `第 ${slot + 2} 只已经开着了` }
    if (pets.size >= MAX_EXTRA_PETS) {
      return { ok: false, message: `最多再开 ${MAX_EXTRA_PETS} 只` }
    }
    const main = getMainWin()
    // 缩放：显式给的优先，否则跟主宠物一样大
    let scale = Number(opts.scale)
    if (!Number.isFinite(scale) || scale <= 0) {
      scale = 1
      if (main && !main.isDestroyed()) {
        try { scale = scaleOf(main.getSize()[0]) } catch {}
      }
    }
    scale = Math.min(2, Math.max(0.5, scale))
    const { w, h } = sizeOf(scale, restH)
    const home = Number.isFinite(opts.x) && Number.isFinite(opts.y)
      ? { x: Math.round(opts.x), y: Math.round(opts.y) }
      : homeFor(w, h, slot)

    const win = new BrowserWindow({
      width: w, height: h,
      x: home.x, y: home.y,
      transparent: true, frame: false, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
        // 每只一个独立会话（内存态，不落盘）。
        // 为什么必须这样：Electron 的 zoomFactor 是**按 origin** 存的，不是按窗口。
        // 所有桌宠都加载同一个 file://.../index.html，共用一个默认会话 —— 于是
        // 「pet-1 是 0.9×、pet-2 设成 0.6×」后两者会互相覆盖：实测 pet-2 窗口已经是
        // 302×182（0.6 倍），zoomFactor 却被 pet-1 的 0.9 顶掉，CSS 视口只剩 335×202
        // 而舞台仍是 462×260 → 人物溢出窗口、看起来缩在右下角还被切掉。
        // 分会话之后 zoom 各自独立，互不影响。
        partition: `pet-extra-${slot + 1}`,
        // 这个开关让 preload 把 pet:fit / pet:hit / pet:busy 走 pet:extra:* 通道。
        // 不加的话，小只拖拽会去改大只的窗口（那几个 handler 只认全局 win）。
        // 槽位也一并带过去：渲染页要知道「我是第几只」，气泡才只长在自己身上。
        additionalArguments: ['--pet-extra=1', `--pet-slot=${slot}`],
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}

    const rec = {
      id, slot,
      pack: String(opts.pack || ''),
      scale,
      fitBaseH: restH,
      win,
      state: { x: home.x, y: home.y, vx: 0, vy: 0, size: w, bottomPad: 0 },
      thrower: null, ignoreNow: true, busy: false, lastPos: '',
      lastFlightReport: 0, dragOffset: null, dragging: false,
    }
    pets.set(id, rec)
    registerPetWindow(id, win)

    win.loadFile(path.join(__dirname, 'index.html'))
    win.webContents.on('console-message', (event, ...rest) => {
      try {
        const level = Number(event && event.level !== undefined ? event.level : rest[0]) || 0
        const message = String((event && event.message) ?? rest[1] ?? '')
        if (level >= 3 && !/Electron Security Warning/.test(message)) {
          log('warn', `[${id}] ${message.slice(0, 300)}`)
        }
      } catch {}
    })
    win.webContents.on('render-process-gone', (_e, d) => log('warn', `[${id}] 渲染进程退出：${d && d.reason}`))
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) { win.show(); }
      clampToArea(rec)
      // zoomFactor 必须与 scale 对齐：渲染页按 zoom 布局，不对齐时窗口宽高与 CSS 尺寸不符，
      // 内容溢出会把窗口顶大（实测 473×273 一路涨到 714×510，人还飞出屏幕）。
      try {
        if (Math.abs((win.webContents.getZoomFactor() || 1) - scale) > 0.01) win.webContents.setZoomFactor(scale)
      } catch {}
      // 先推素材表再落地：不然首帧只有静态兜底形象，人物看起来是「一个蓝圆点」
      pushPack(rec)
      startThrow(rec, 0, 0)
    })
    // 尺寸守卫：额外宠物不允许被任何来源改尺寸（主宠物的守卫在 main.js 里只认全局 win）。
    win.on('resize', () => {
      if (win.isDestroyed()) return
      try {
        const { w, h } = sizeOf(rec.scale, rec.fitBaseH)
        const [cw, ch] = win.getSize()
        if (Math.abs(cw - w) > 2 || Math.abs(ch - h) > 2) {
          log('info', `[${rec.id}] resize 事件抓到 ${cw}x${ch}（期望 ${w}x${h}）`)
        }
      } catch {}
      enforceSize(rec)
    })
    win.on('closed', () => {
      stopThrow(rec)
      pets.delete(id)
      dropPetState(id)
      log('info', `额外桌宠 ${id} 已关闭，剩 ${pets.size} 只`)
    })
    log('info', `额外桌宠 ${id}（槽位 ${slot}，包 ${rec.pack || '跟随主宠物'}，${scale}× 大小）已在 (${home.x},${home.y}) 开出来`)
    return { ok: true, id, slot }
  }

  /** 换这只的形象包（空 = 跟随主宠物）：重推素材表即可，不用重建窗口。 */
  function setPack(rec, packName) {
    if (!rec || !rec.win || rec.win.isDestroyed()) return false
    const next = String(packName || '')
    if (next === rec.pack) return false
    rec.pack = next
    pushPack(rec)
    log('info', `[${rec.id}] 形象包 → ${next || '跟随主宠物'}`)
    return true
  }

  /** 换这只的大小：窗口尺寸跟 zoom 一起改，底边（或顶边，看出生点）保持不动。
   *  改完必须重置素材裁切 —— 渲染页按新 zoom 重新量舞台，不重置会留着旧裁切。 */
  function setScale(rec, nextScale) {
    if (!rec || !rec.win || rec.win.isDestroyed()) return false
    const v = Math.min(2, Math.max(0.5, Number(nextScale) || 0))
    if (!Number.isFinite(v) || v <= 0) return false
    if (Math.abs(v - rec.scale) < 0.01) return false
    rec.scale = v
    try { rec.win.webContents.setZoomFactor(v) } catch {}
    enforceSize(rec, true)
    pushPack(rec) // 新 zoom 下重新量一遍舞台（__setPack 会重置裁切）
    invalidateSpace(rec)
    return true
  }

  /** 把这只的素材表/尺寸一次性对齐到配置（面板改完就走这条）。 */
  function applySlot(spec) {
    const rec = pets.get(`pet-${Number(spec && spec.slot) + 1}`)
    if (!rec) return false
    let changed = false
    if (spec.pack !== undefined) changed = setPack(rec, spec.pack) || changed
    if (Number.isFinite(Number(spec.scale)) && Number(spec.scale) > 0) {
      changed = setScale(rec, Number(spec.scale)) || changed
    }
    return changed
  }

  /** 抛掷空间缓存作废（尺寸/缩放变了，边界得按新尺寸重算）。 */
  function invalidateSpace(rec) {
    if (!rec) return
    rec.spaceCache = null
    rec.spaceKey = ''
  }

  /** 把它拉回「该有的尺寸」：宽恒为 baseW×scale，高按气泡上报的 fitBaseH 走。 */
  function enforceSize(rec, force) {
    if (!rec.win || rec.win.isDestroyed()) return
    const { w, h } = sizeOf(rec.scale, rec.fitBaseH)
    try {
      const [cw, ch] = rec.win.getSize()
      if (!force && Math.abs(cw - w) <= 2 && Math.abs(ch - h) <= 2) return
      const now = Date.now()
      if (!force && now - (rec.lastSizeFixAt || 0) < 1000) return
      rec.lastSizeFixAt = now      // 底边钉住（人不动，气泡往上长）；上沿出生点则钉顶边。与 main.js 的 pet:fit 同口径。
      const [px, py] = rec.win.getPosition()
      const [, oldH] = rec.win.getSize()
      rec.win.setResizable(true)
      rec.win.setSize(w, h)
      const atTop = typeof bubbleGrowsDown === 'function' ? Boolean(bubbleGrowsDown(rec))
        : (typeof isTopCorner === 'function' ? Boolean(isTopCorner()) : false)
      const ny = atTop ? py : py + oldH - h
      if (ny !== py) { try { rec.win.setPosition(px, ny) } catch {} }
      rec.state.x = px
      rec.state.y = ny
      rec.win.setResizable(false)
      updatePetState(rec.id, { x: px, y: ny, vx: rec.state.vx || 0, vy: rec.state.vy || 0, size: w, bottomPad: 0 })
      if (Math.abs(cw - w) > 2 || Math.abs(ch - h) > 2) {
        log('info', `[${rec.id}] 尺寸纠正 ${cw}x${ch} → ${w}x${h}`)
      }
    } catch {}
  }

  /** 渲染页上报「贴合内容需要的基础高度」（缩放前 px）：与主宠物 pet:fit 同一套语义。
   *
   *  ⚠ 这里**不能**在 baseH 没变时提前 return。踩过一次：
   *  fitBaseH 已经是 284（气泡收起值），但窗口因为上一口气泡还停在 296 ——
   *  渲染页再报 284 时被「值没变」挡回去，窗口就永远缩不回来了（人底下多出一截空白）。
   *  正确的判据是「窗口尺寸对不对」，那件事由 enforceSize 自己判（它已经有不一致才动的检查），
   *  所以这里只负责更新 fitBaseH，然后无条件交给它去收敛。 */
  function fitWindow(petId, baseH) {
    const rec = pets.get(String(petId))
    if (!rec || !rec.win || rec.win.isDestroyed()) return
    const BUBBLE_BOTTOM = 226
    const BUBBLE_MAX_CSS = 280
    const H_MAX_BASE = Math.max(restH, BUBBLE_BOTTOM + BUBBLE_MAX_CSS + 8)
    const next = Math.min(H_MAX_BASE, Math.max(restH, Math.round(Number(baseH)) || restH))
    // 诊断：把渲染页每次上报的原值记下来（查「窗口被自己撑大」用）
    if (Math.abs(next - rec.fitBaseH) >= 1) {
      log('info', `[${rec.id}] fit ${rec.fitBaseH} → ${next}（渲染页报 ${baseH}，窗口现在 ${JSON.stringify(rec.win.getSize())}）`)
    }
    rec.fitBaseH = next
    enforceSize(rec, true)
    invalidateSpace(rec)
  }

  /** 尺寸巡检：把所有额外宠物都拉回该有的尺寸。
   *  主宠物有 60ms 光标轮询里的 watchdog（main.js startPointerFallback），
   *  额外那几只没有那条通道，所以由这里补一个低频巡检 —— 任何来源把窗口搞大
   *  （DPI 竞态 / setZoomFactor 与 setSize 交互 / 气泡收起时的那一帧）都会自己收敛回来。 */
  function sweepSizes() {
    for (const rec of pets.values()) {
      try { enforceSize(rec) } catch {}
    }
  }

  /** 让某一只说一句话（气泡长在它自己身上；与主宠物完全同一套渲染页）。 */
  function bubble(petId, text, mood, secs, anim, playbackId, tag) {
    const rec = pets.get(String(petId))
    if (!rec || !rec.win || rec.win.isDestroyed()) return false
    const js = `window.__bubble && window.__bubble(${JSON.stringify(String(text || ''))}, ${JSON.stringify(String(mood || 'neutral'))}, ${Number(secs) || 8}, ${JSON.stringify(String(anim || ''))}, ${JSON.stringify(String(playbackId || ''))}, ${JSON.stringify(String(tag || ''))})`
    rec.win.webContents.executeJavaScript(js).catch(() => {})
    return true
  }

  /** 把窗口拉回某块工作区内（与主宠物 clampWindowToArea 同口径，但只按窗口盒夹）。 */
  function clampToArea(rec) {
    if (!rec.win || rec.win.isDestroyed()) return
    try {
      const b = rec.win.getBounds()
      const area = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }).workArea
      const x = Math.min(Math.max(b.x, area.x), area.x + area.width - b.width)
      const y = Math.min(Math.max(b.y, area.y), area.y + area.height - b.height)
      if (x !== b.x || y !== b.y) rec.win.setPosition(x, y)
      rec.state.x = x
      rec.state.y = y
      updatePetState(rec.id, { x, y, vx: 0, vy: 0, size: b.width, bottomPad: 0 })
    } catch {}
  }

  /** 这只宠物的抛掷空间（每帧建太浪费，缓存在 rec 上）。 */
  function spaceOf(rec) {
    if (!rec.win || rec.win.isDestroyed()) return null
    // 与 startThrow 同口径：用期望尺寸，不用读回来的尺寸（被撑大时会算错边界）
    const sz = sizeOf(rec.scale, rec.fitBaseH)
    const w = sz.w, h = sz.h
    const key = `${w}x${h}@${rec.scale}`
    if (rec.spaceCache && rec.spaceKey === key) return rec.spaceCache
    const ds = screen.getAllDisplays ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
    const body = bodyBox(w, h)
    const reach = sideInsetOf(body)
    const space = physics.throwSpace({
      areas: ds.map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height })),
      panels: ds.map((d) => ({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height })),
      bodyW: body.width, bodyH: body.height,
      offsetX: body.offsetX, offsetY: body.offsetY,
      winW: w, winH: h,
      reachLeft: reach.left, reachRight: reach.right,
    })
    rec.spaceCache = space
    rec.spaceKey = key
    return space
  }

  /** 停掉这只宠物的抛掷循环。 */
  function stopThrow(rec) {
    if (rec.thrower) { clearTimeout(rec.thrower); rec.thrower = null }
  }

  /**
   * 起一次抛掷（也用来做「落地」：初速 0 时它自己会掉到地面并静止）。
   *
   * @param {object} rec - 宠物记录
   * @param {number} vx - 初速 px/s
   * @param {number} vy - 初速 px/s
   */
  function startThrow(rec, vx, vy) {
    if (!rec.win || rec.win.isDestroyed()) return
    stopThrow(rec)
    const space = spaceOf(rec)
    if (!space || !space.areas.length) return
    let pos = [rec.state.x, rec.state.y]
    try { pos = rec.win.getPosition() } catch {}
    // 用「该有的尺寸」而不是读回来的尺寸：窗口万一被撑大，读回来的宽会把边界一起算错，
    // 表现就是人越飞越远、最后停在三屏之外（实测 x=6693）。
    const expect = sizeOf(rec.scale, rec.fitBaseH)
    let st = { x: pos[0], y: pos[1], vx: Number(vx) || 0, vy: Number(vy) || 0 }
    {
      const i0 = physics.screenOfBox(space, st.x, st.y)
      const b0 = space.bounds[i0]
      if (b0) {
        st.x = Math.min(Math.max(st.x, b0.minX), b0.maxX)
        st.y = Math.min(Math.max(st.y, b0.minY), b0.maxY)
      }
    }
    const ph = getPhysics()
    const T0 = Date.now()
    let last = T0
    const FRAME_MS = 16
    const MAX_MS = 10000

    const step = () => {
      rec.thrower = null
      if (!rec.win || rec.win.isDestroyed()) return
      const now = Date.now()
      const dt = Math.min(0.05, Math.max((now - last) / 1000, 1e-4))
      last = now
      const n = physics.throwSubsteps(st.vx, st.vy, dt)
      for (let i = 0; i < n; i++) {
        st = physics.throwStepRegion(st, dt / n, space, ph)
        if (st.atRest) break
      }
      if (now - T0 > MAX_MS) {
        const bi = physics.screenOfBox(space, st.x, st.y)
        const bb = space.bounds[bi]
        st = bb ? { ...st, y: bb.maxY, vx: 0, vy: 0, atRest: true } : { ...st, vx: 0, vy: 0, atRest: true }
      }
      // 与别的宠物互撞（含主宠物）：几何口径与 main.js 那份完全一致
      if (ph.petCollision !== false) st = collide(rec, st, space)
      if (now - rec.lastFlightReport > 30) {
        rec.lastFlightReport = now
        updatePetState(rec.id, { x: st.x, y: st.y, vx: st.vx, vy: st.vy, size: expect.w, bottomPad: 0 })
      }
      const px = Math.round(st.x), py = Math.round(st.y)
      const key = px + ',' + py
      if (key !== rec.lastPos) {
        rec.lastPos = key
        try { rec.win.setPosition(px, py) } catch { return }
      }
      rec.state.x = px
      rec.state.y = py
      if (st.atRest) { stopThrow(rec); return }
      rec.thrower = setTimeout(step, FRAME_MS)
    }
    rec.thrower = setTimeout(step, FRAME_MS)
  }

  /**
   * 一次宠物间碰撞结算（overlapPush 分离 + collidePet 动量），与 main.js 同一套口径。
   * 抽成共用实现是为了两只不会用两套几何：主宠物在它自己的循环里也调这里。
   *
   * @param {object} rec - 自己
   * @param {object} st - 当前物理状态 {x,y,vx,vy}
   * @param {object} space - 自己的抛掷空间（用于夹回）
   * @returns 结算后的状态
   */
  function collide(rec, st, space) {
    const reg = getPetRegistry()
    if (!reg) return st
    const selfSz = sizeOf(rec.scale, rec.fitBaseH)
    const selfW = selfSz.w
    const myBody0 = bodyBox(selfSz.w, selfSz.h)
    const HIT_BOX = { x0: hitBoxX0, y0: 50, x1: 440, y1: 335 }
    const myBody = physics.bodyPixelBox({
      x: st.x + myBody0.offsetX, y: st.y + myBody0.offsetY,
      size: myBody0.width, bottomPad: 0, hitBox: HIT_BOX,
    })
    for (const [oid, other] of reg) {
      if (oid === rec.id || !other.alive) continue
      const o = other.state
      if (!o || !o.size) continue
      const oBody0 = bodyBox(o.size, Math.round(o.size * (restH / baseW)))
      const otherBody = physics.bodyPixelBox({
        x: o.x + oBody0.offsetX, y: o.y + oBody0.offsetY,
        size: oBody0.width, bottomPad: o.bottomPad || 0, hitBox: HIT_BOX,
      })
      if (!physics.rectsOverlap(myBody, otherBody)) continue
      const push = physics.overlapPush(myBody, otherBody)
      if (push) {
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
        { x: st.x, y: st.y, vx: st.vx, vy: st.vy, size: selfW },
        { x: o.x, y: o.y, vx: o.vx || 0, vy: o.vy || 0, size: o.size },
      )
      if (!hit) break
      st = { ...st, vx: hit.fvx, vy: hit.fvy }
      if (other.win && !other.win.isDestroyed()) {
        try { other.win.webContents.send('pet:collide-hit', { vx: hit.hvx, vy: hit.hvy }) } catch {}
      }
      break
    }
    return st
  }

  /** 把一只宠物甩出去（供右键菜单 / 外部调用）。 */
  function fling(petId, vx, vy) {
    const rec = pets.get(String(petId))
    if (!rec) return { ok: false, message: '没有这只宠物' }
    startThrow(rec, vx, vy)
    return { ok: true }
  }

  /** 关掉一只 / 全部。 */
  function close(petId) {
    const rec = pets.get(String(petId))
    if (!rec) return { ok: false, message: '没有这只宠物' }
    stopThrow(rec)
    try { rec.win.close() } catch {}
    return { ok: true }
  }
  function closeAll() {
    const n = pets.size
    for (const rec of [...pets.values()]) {
      stopThrow(rec)
      try { rec.win.close() } catch {}
    }
    pets.clear()
    return n
  }

  /** 当前有几只额外宠物 + 每只的位置/包/大小，供菜单/状态展示。 */
  function list() {
    return [...pets.values()].map((rec) => {
      let b = null
      try { b = rec.win.getBounds() } catch {}
      let zoom = null, vp = null
      try { zoom = rec.win.webContents.getZoomFactor() } catch {}
      return { id: rec.id, slot: rec.slot, pack: rec.pack, scale: rec.scale, bounds: b, flying: Boolean(rec.thrower), zoom, fitBaseH: rec.fitBaseH, vp }
    })
  }

  /** 拖拽支持：把窗口挪到指定位置（简单夹取，不做弹簧）。 */
  function moveTo(petId, x, y) {
    const rec = pets.get(String(petId))
    if (!rec || !rec.win || rec.win.isDestroyed()) return false
    stopThrow(rec)
    try {
      const b = rec.win.getBounds()
      const area = screen.getDisplayNearestPoint({ x: Math.round(x + b.width / 2), y: Math.round(y + b.height / 2) }).workArea
      const nx = Math.round(Math.min(Math.max(x, area.x - 40), area.x + area.width - b.width + 40))
      const ny = Math.round(Math.min(Math.max(y, area.y - 20), area.y + area.height - b.height + 20))
      rec.win.setPosition(nx, ny)
      rec.state.x = nx
      rec.state.y = ny
      updatePetState(rec.id, { x: nx, y: ny, vx: 0, vy: 0, size: b.width, bottomPad: 0 })
      return true
    } catch { return false }
  }

  return {
    create, close, closeAll, list, fling, moveTo, collide,
    stopThrow, startThrow, pets, pushPackAll,
    fitWindow, bubble, setPack, setScale, applySlot, enforceSize, sweepSizes,
    get: (id) => pets.get(String(id)),
    size: () => pets.size,
    MAX_EXTRA_PETS,
  }
}

module.exports = { createMultiPets, MAX_EXTRA_PETS }
