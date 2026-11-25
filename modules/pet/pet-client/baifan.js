/**
 * 内置玩法「吃白饭」：演出导演 + 米饭层。
 *
 * 移植自 dsh-pet 新版（src/client/baifan.ts / baifan/show.ts / baifan/scene.ts /
 * baifan/geometry.ts / baifan/constants.ts，MIT License）。
 *
 * 移植时**改了架构，不是照抄**，三处差异必须知道：
 *   ① dsh-pet 的宠物是网页里一个 <video>，页面=整屏，所以米饭能从屏幕顶掉到屏幕底。
 *      我们是 502×284 的独立透明窗口，舞台只有 462×260，所以这一层是**窗口内**覆盖层：
 *      米饭从窗口上沿掉到人物脚边。整屏掉落做不到，这是窗口架构的硬限制，不是没做。
 *   ② dsh-pet 用 HTTP（/position、/anim、/playback、/lock、/broadcast）跟宿主说话；
 *      我们只有单窗口单进程，这些全部换成直接调本地函数/Promise，不绕 HTTP。
 *   ③ dsh-pet 的「相位等待」靠 /playback 回执；我们直接 await 渲染页自己的播完回调。
 *
 * 对外只暴露 createBaifan(deps) → { start, halt, isRunning }，由 index.html 挂到 window.__baifan。
 * 素材槽位按位置对应（与 dsh-pet 的契约一致）：
 *   ① 跑向屏幕底部 ② 追饭时的侧身跑 ③ 到位后等开饭 ④ 吃到碗饭 ⑤ 吃饭团
 *
 * @module aurabot/pet/baifan
 */
'use strict'

/** 全部可调节奏（照 dsh-pet 的 CFG，凡涉及「视口」的量都按我们的舞台重新标定）。 */
const CFG = {
  // 掉落台阶：我们的「地面」是舞台底边往上一点点，不是 innerHeight - 26
  groundOffset: 6,
  prepMs: 1500,          // 开场下蹲时间（dsh-pet 是 2100，我们的窗口短，压一点）
  travelMs: 2600,        // 「跑向底部」的位移时长
  runSpeed: 290,         // 追饭侧身跑速度（px/s）
  spawnMs: 4200,         // 每隔多久掉一份
  bowlRatio: 0.38,       // 碗饭占比，其余是饭团
  maxRice: 2,            // 场上最多几份
  eatPx: 40,             // 走到多近算「到嘴了」
  arrivePx: 12,          // 位移到点多近算到
  tripMaxMs: 4500,       // 单次追饭最长位移
  idleMs: 140,           // 已在目标点时的空转（防死循环）
  backTurnPenalty: 1.8,  // 身后那份的代价倍数（换朝向要重开一段，尽量不换）
  preRollSec: 0.35,      // 动画播到最后这么多秒就算「播完」，提前接下一段
  waitBudgetMs: 30000,   // 单次动画等待上限
  bubbleMs: 2400,        // 台词气泡停留
  footRatio: 0.894,      // 脚底在素材 640×360 画布里的 y 比例（dsh-pet 实测）
  mouthRatio: 0.63,      // 嘴在同一条线上的比例
  mouthDx: -0.03,        // 嘴相对中心的横向偏移（朝右时为正）
  refWidth: 462,         // 基准宽（我们的舞台宽），不是 dsh-pet 的 498
  maxPoints: 999,        // 分数上限保护
}

/** 台词池：每个节拍说一句，其余时间闭嘴（否则气泡会糊在演出上）。 */
const LINES = {
  start: ['开饭了——', '白饭时间到！', '饿了饿了饿了'],
  down: ['等我下去……', '下面有饭香', '让一让，我下去了'],
  expect: ['饭呢？饭呢？', '快点快点', '……还没好吗'],
  drop: ['掉下来了！', '接住！', '来了来了'],
  bowl: ['碗饭最香', '这个碗我要了', '再来一碗'],
  ball: ['饭团饭团', '一口一个', '捏得刚好'],
  full: ['嗝——还能吃！', '这点不够塞牙缝', '再来十份'],
}

/** 从池子里随机取一句。 */
function lineOf(pool) {
  if (!pool || !pool.length) return ''
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 等一会儿（可被中止）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 造一个玩法实例。
 *
 * @param {object} deps 依赖注入（全部由 index.html 提供，便于单测与解耦）
 * @param {() => object|null} deps.config 取当前玩法配置：{ slots:[5 个 id], pics:{...} }；null = 不可用
 * @param {() => {width:number,height:number}} deps.stageRect 舞台在窗口内的尺寸
 * @param {(name:string, opts:object) => Promise<boolean>} deps.play 播一段动画并等它播完
 * @param {(name:string) => boolean} deps.playLoop 循环播一段（不等待）
 * @param {(on:boolean) => void} deps.hold 让位开关：开 = 随机链/工作档位/说话都别抢台
 * @param {() => void} deps.stopVisual 收掉循环中的画面（侧身跑用 loop 档，必须显式停）
 * @param {(text:string, ms:number) => void} deps.say 只弹气泡、不切动画
 * @param {(toCenterX:number, opts:object) => Promise<boolean>} deps.walkTo 让窗口走过去（身体中心到屏幕 x）
 * @param {() => {cx:number, cy:number, facing:'left'|'right'}} deps.pose 当前人物在窗口内的中心点与朝向
 * @param {(on:boolean) => void} deps.face 设置朝向
 * @param {(why:string) => void} deps.log 诊断日志
 * @param {() => boolean} deps.isInterrupted 外部中断检查（被拖动/专注模式/窗口要关）
 * @returns {{start:()=>Promise<void>, halt:(why?:string)=>Promise<void>, isRunning:()=>boolean}}
 */
function createBaifan(deps) {
  const layer = document.getElementById('bf-layer')
  const toastEl = document.getElementById('bf-toast')

  /** 场上的饭。 */
  let items = []
  /** 落体 rAF 句柄；0 = 没在跑。 */
  let frame = 0
  /** 上一帧时间戳（秒）。 */
  let lastMs = 0
  /** 提示条淡出定时器。 */
  let toastTimer = 0
  /** 这一场是否在跑（菜单用它避免重复开演）。 */
  let running = false
  /** 场次代次：每次 halt 或重开都 +1，旧的异步链在下一个 await 后自弃。 */
  let gen = 0
  /** 当前相位（自检用）：'idle' | 'walk' | 'expect' | 'chase' | 'eat'。 */
  let phase = 'idle'
  /** 吃掉的份数。 */
  let eaten = 0
  /** 掉落定时器。 */
  let spawnTimer = 0
  /** 侧身跑接力令牌（换朝向/开始吃/收场都 +1）。 */
  let sideToken = 0

  /** 底部居中提示条，1.8 秒后自己淡掉。 */
  function toast(text) {
    if (!toastEl) return
    toastEl.textContent = text
    toastEl.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800)
  }

  /** 建一个元素。 */
  function el(tag) { return document.createElement(tag) }

  /** 地面线（窗口内像素，从顶边算）：舞台底边往上一点。 */
  function groundLineY() {
    const r = deps.stageRect()
    return r.height - CFG.groundOffset
  }

  /** 按当前坐标写样式。 */
  function layout(item) {
    item.el.style.left = item.x - item.w / 2 + 'px'
    item.el.style.top = item.y - item.h + 'px'
    item.el.style.transform = 'rotate(' + item.rot + 'deg)'
  }

  /**
   * 从窗口上沿掉一份饭。
   *
   * @param {number} scale 相对基准宽的缩放
   * @returns {object|null} 新的一份；场上已满时 null
   */
  function spawn(scale) {
    const cfg = deps.config()
    if (!cfg || items.length >= CFG.maxRice) return null
    const isBowl = Math.random() < CFG.bowlRatio
    const w = (isBowl ? 124 : 110) * scale
    const img = el('img')
    img.className = 'bf-rice'
    img.src = isBowl ? cfg.pics['bowl-full'] : cfg.pics['rice-ball']
    img.alt = ''
    img.draggable = false
    img.style.width = w + 'px'
    img.style.height = w + 'px'
    const sw = deps.stageRect().width
    const item = {
      el: img,
      x: 70 + Math.random() * Math.max(10, sw - 140),
      y: -w - 20,
      w: w,
      h: w,
      type: isBowl ? 'bowl' : 'ball',
      vy: 170 + Math.random() * 60,
      rot: 0,
      spin: isBowl ? 0 : (Math.random() < 0.5 ? -1 : 1) * 90,
      state: 'falling',
    }
    layer.appendChild(img)
    items.push(item)
    layout(item)
    return item
  }

  /** 落体循环：只在还有东西在天上时才跑 rAF。 */
  function fallTick(ts) {
    frame = 0
    if (!lastMs) lastMs = ts
    const dt = Math.min((ts - lastMs) / 1000, 0.05)
    lastMs = ts
    let falling = false
    const line = groundLineY()
    for (const item of items) {
      if (item.state !== 'falling') {
        if (item.rot !== 0) { item.rot = 0; layout(item) }
        continue
      }
      falling = true
      item.y += item.vy * dt
      item.rot += item.spin * dt
      if (item.y >= line) {
        item.y = line
        item.state = 'ground'
        item.el.animate(
          [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.92)' }, { transform: 'scaleY(1)' }],
          { duration: 160, easing: 'ease-out' }
        )
      }
      layout(item)
    }
    if (falling && frame === 0) frame = requestAnimationFrame(fallTick)
  }

  /** 按需拉起落体循环。 */
  function kick() { if (frame === 0) frame = requestAnimationFrame(fallTick) }

  /**
   * 场上离得最近的、已经落地的饭。
   * 「最近」带朝向偏好：身后那份要打折才算数——换朝向就要重开一段跑步动画（新视频要解码），
   * 那一下必然有空档，能不换就不换。
   */
  function nearest(petPx, facing) {
    let best = null
    let bestScore = Infinity
    for (const item of items) {
      if (item.state !== 'ground') continue
      const distance = Math.abs(item.x - petPx)
      const ahead = facing === 'right' ? item.x > petPx : item.x < petPx
      const score = ahead ? distance : distance * CFG.backTurnPenalty
      if (score < bestScore) { bestScore = score; best = item }
    }
    return best
  }

  /** 把一份饭从场上摘掉（元素交给调用方决定什么时候删）。 */
  function detach(item) {
    const i = items.indexOf(item)
    if (i >= 0) items.splice(i, 1)
  }

  /**
   * 吃掉一份：飞到嘴边，随咀嚼缩小，到点自己删元素。
   *
   * @param {object} item 被吃的那份（调用方应已 detach）
   * @param {number} mouthX 嘴部窗口 x
   * @param {number} mouthY 嘴部窗口 y
   * @param {number} durationMs 飞行时长（用真实片长，才与咀嚼同步）
   */
  function flyToMouth(item, mouthX, mouthY, durationMs) {
    const dx = mouthX - item.x
    const dy = mouthY - (item.y - item.h / 2)
    item.el.style.zIndex = '5'
    // 末段把食物缩到 0.12：整份原尺寸怼在脸上会把眼睛盖住。
    // transform-origin 是 50% 100%（底边），所以缩放是「从下往上收」，不会越缩越高。
    item.el.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.72)', opacity: 1, offset: 0.16 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.68)', opacity: 1, offset: 0.55 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.12)', opacity: 0, offset: 1 },
      ],
      { duration: durationMs, easing: 'ease-in-out', fill: 'forwards' }
    )
    setTimeout(() => item.el.remove(), durationMs + 80)
  }

  /**
   * 空碗：从嘴边掉到地上，弹两下，然后淡出。
   * 我们窗口只有 260px 舞台高，碗可能掉出窗口被裁 —— 移植代价，见文件头注释。
   */
  function dropEmptyBowl(x, fromY, scale) {
    const cfg = deps.config()
    if (!cfg) return
    const w = 124 * scale
    const img = el('img')
    img.className = 'bf-rice'
    img.src = cfg.pics['bowl-empty']
    img.alt = ''
    img.draggable = false
    img.style.width = w + 'px'
    img.style.height = w + 'px'
    img.style.left = x - w / 2 + 'px'
    img.style.top = fromY - w + 'px'
    layer.appendChild(img)
    const drop = Math.max(0, groundLineY() - fromY)
    img.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.48, easing: 'ease-in' },
        { transform: 'translateY(' + (drop - 42 * scale) + 'px)', offset: 0.62, easing: 'ease-out' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.74, easing: 'ease-in' },
        { transform: 'translateY(' + (drop - 14 * scale) + 'px)', offset: 0.82, easing: 'ease-out' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.9 },
        { transform: 'translateY(' + drop + 'px)', offset: 1 },
      ],
      { duration: 820, easing: 'linear' }
    )
    setTimeout(() => {
      img.style.transition = 'opacity .9s ease'
      img.style.opacity = '0'
      setTimeout(() => img.remove(), 950)
    }, 900)
  }

  /**
   * 头顶分数气泡：图标随刚吃下的那份饭变（碗饭 / 饭团）。
   */
  function popScore(value, type, geom) {
    const cfg = deps.config()
    if (!cfg) return
    const isBowl = type === 'bowl'
    const node = el('div')
    node.className = 'bf-score'
    node.innerHTML =
      '<img class="' + (isBowl ? 'bowl' : 'ball') + '" src="' +
      (isBowl ? cfg.pics['bowl-full'] : cfg.pics['rice-ball']) + '" alt="">' +
      '<span class="num">' + value + '</span><span class="plus">+1</span>'
    node.style.left = geom.cx + 'px'
    node.style.top = Math.max(4, geom.top + geom.h * 0.09) + 'px'
    layer.appendChild(node)
    node.animate(
      [
        { transform: 'translate(-50%,0) scale(.6)', opacity: 0, offset: 0 },
        { transform: 'translate(-50%,-14px) scale(1.08)', opacity: 1, offset: 0.18 },
        { transform: 'translate(-50%,-22px) scale(1)', opacity: 1, offset: 0.72 },
        { transform: 'translate(-50%,-40px) scale(.96)', opacity: 0, offset: 1 },
      ],
      { duration: 1300, easing: 'ease-out', fill: 'forwards' }
    )
    setTimeout(() => node.remove(), 1400)
  }

  /** 清场景：0.5 秒淡出后摘干净。 */
  function clear() {
    try { if (frame) cancelAnimationFrame(frame) } catch {}
    frame = 0
    lastMs = 0
    const all = items.slice()
    items = []
    for (const item of all) {
      try {
        item.el.style.transition = 'opacity .5s ease'
        item.el.style.opacity = '0'
        setTimeout(() => item.el.remove(), 600)
      } catch { try { item.el.remove() } catch {} }
    }
    if (toastEl) toastEl.classList.remove('show')
  }

  /**
   * 由当前朝向与舞台尺寸算这一帧的几何量（全部窗口内像素）。
   * 我们不像 dsh-pet 那样去 DOM 里找 video 量尺寸 —— 舞台尺寸是确定的，
   * 人物按 contain 铺满舞台，所以直接按舞台算，比量 DOM 更稳。
   */
  function geometry() {
    const r = deps.stageRect()
    const w = r.width
    const h = r.height
    const faceLeft = deps.pose().facing === 'left'
    return {
      w: w,
      h: h,
      top: 0,
      feet: h * CFG.footRatio,
      cx: w / 2,
      cy: h / 2,
      // 嘴：x 相对中心偏一点点，朝左时反号（dsh-pet 的 mouthDx 语义）
      mouthX: w / 2 + (faceLeft ? 1 : -1) * CFG.mouthDx * w,
      mouthY: h * CFG.mouthRatio,
      scale: Math.max(0.5, Math.min(2, w / CFG.refWidth)),
    }
  }

  /**
   * 窗口位移后，把场上所有道具反向平移，让它们在**世界坐标**里不动。
   *
   * 这是移植里最关键的一处修正：dsh-pet 的宠物是页面里的元素，页面不跟着它走，
   * 所以米饭掉在哪就是哪。我们的宠物是整窗跟着走的——窗口一动，窗口内的米饭也跟着动，
   * 宠物永远追不上（实测就是 dist 恒为 0、原地踏步到收场）。
   * 所以每走一步都要把道具按 -movedX 反向搬一次，等效于「米饭钉在桌面上」。
   *
   * @param {number} movedX 窗口（身体中心）的屏幕水平位移
   * @param {number} movedY 同上，垂直
   */
  function rebaseItems(movedX, movedY) {
    if (!movedX && !movedY) return
    const r = deps.stageRect()
    for (const item of items) {
      item.x -= movedX
      item.y -= movedY
      // 横向跑出窗口的道具直接摘掉：窗口窄，留在外面既看不见也吃不到
      if (item.x < -item.w || item.x > r.width + item.w) {
        detach(item)
        try { item.el.remove() } catch {}
        continue
      }
      // 纵向：被搬出可视区的夹回来（掉落相位不该发生，防御性处理）
      if (item.y > r.height + item.h) item.y = r.height - CFG.groundOffset
      layout(item)
    }
  }

  /**
   * 侧身跑：把「追饭跑步」这一段挂成循环，一直演到被换掉为止。
   *
   * 为什么是 loop 而不是「播完再点播」：我们的 A/B 双缓冲靠 `pendingSwap.anim === name` 判重，
   * 同名连续点播不会重新赋 src（否则 currentTime 归零、肉眼跳帧），所以「播完再来一遍」这条路
   * 反而拿不到新的一轮。直接让 `<video loop>` 无限循环最干净（这也是 dsh-pet 单候选档位的做法）。
   * 收场时由 deps.stopVisual() 把循环停掉。
   */
  function runSide() {
    const cfg = deps.config()
    if (!cfg) return
    sideToken++
    deps.playLoop(cfg.slots[1])
  }

  /** 停侧身跑接力（只是让令牌失效，画面由 stopVisual 收）。 */
  function stopSide() { sideToken++ }

  /**
   * 开一场。重复调用等于重开（先彻底收掉上一场）。
   *
   * @returns {Promise<void>}
   */
  async function start() {
    const cfg = deps.config()
    if (!cfg) { toast('这个形象包没有「吃白饭」的素材'); return }
    await halt('restart')
    running = true
    const myGen = ++gen
    const alive = () => running && gen === myGen && !deps.isInterrupted()
    eaten = 0
    deps.hold(true)
    deps.log('baifan start')

    try {
      // ---- 相位 1：开场下蹲 + 跑向底部 ----
      phase = 'walk'
      deps.say(lineOf(LINES.start), CFG.bubbleMs)
      await deps.play(cfg.slots[0], { kind: 'baifan' })
      if (!alive()) return
      deps.say(lineOf(LINES.down), CFG.bubbleMs)
      // 「跑到底部」：我们的窗口本来就在屏幕底部附近，位移只有几十 px。
      // 所以这里改成「往当前屏的工作区底部挪」——目标是底边对齐，位移多少由主进程算。
      await deps.walkTo(null, { align: 'bottom', maxMs: CFG.travelMs, speed: 120, owner: 'baifan' })
      if (!alive()) return

      // ---- 相位 2：期待开饭 ----
      phase = 'expect'
      deps.say(lineOf(LINES.expect), CFG.bubbleMs)
      await deps.play(cfg.slots[2], { kind: 'baifan' })
      if (!alive()) return

      // ---- 相位 3：追着吃 ----
      phase = 'chase'
      // 掉饭：立刻来一份，之后每 spawnMs 一份，场上最多 maxRice
      const spawnOnce = () => {
        if (!alive()) return
        const made = spawn(geometry().scale)
        if (made) { kick(); deps.say(lineOf(LINES.drop), CFG.bubbleMs) }
      }
      spawnOnce()
      spawnTimer = setInterval(spawnOnce, CFG.spawnMs)

      // 主循环：找最近的一份 → 走过去 → 吃掉 → 再来
      while (alive()) {
        const geom = geometry()
        const pose = deps.pose()
        const petPx = geom.cx
        const target = nearest(petPx, pose.facing)
        if (!target) { await sleep(200); continue }

        const dist = Math.abs(target.x - petPx)
        if (dist <= CFG.eatPx) {
          // 够近了：直接吃
          phase = 'eat'
          await eatOne(target, alive)
          continue
        }
        // 还得走过去：朝目标方向开侧身跑，同时让窗口横移。
        // ⚠ 关键：宠物和饭都在**同一个窗口坐标系**里，窗口一动饭也跟着动。
        // 所以位移之后必须把道具反向平移（rebaseItems），否则距离恒定、永远走不到（实测 dist 恒 0）。
        deps.face(target.x < petPx)
        runSide(gen) // 不 await：跑动接力与位移并行
        const moved = await deps.walkTo(target.x - petPx, {
          maxMs: CFG.tripMaxMs,
          speed: CFG.runSpeed,
          owner: 'baifan',
        })
        rebaseItems(moved && moved.movedX, moved && moved.movedY)
        if (!moved || !moved.ok) {
          // 被边界夹住 / 被别的动作占用：这一份吃不到了，摘掉换个目标，别原地打转
          if (Math.abs(target.x - petPx) <= CFG.eatPx) continue
          await sleep(CFG.idleMs)
        }
        // 走完若还没贴到（被边界夹住），等下一轮重挑
        await sleep(CFG.idleMs)
      }
    } catch (error) {
      deps.log('baifan error: ' + String(error && error.message || error))
    } finally {
      if (gen === myGen) await halt('end')
    }
  }

  /** 吃掉一份（内部函数，由 start 的主循环调）。 */
  async function eatOne(item, alive) {
    const cfg = deps.config()
    if (!cfg) return
    stopSide()
    detach(item)
    const geom = geometry()
    // 边播吃动画边飞过去：飞多久由真实片长决定，所以先拿到片长
    const playPromise = deps.play(item.type === 'bowl' ? cfg.slots[3] : cfg.slots[4], { kind: 'baifan' })
    const clipMs = await deps.clipMs(item.type === 'bowl' ? cfg.slots[3] : cfg.slots[4])
    flyToMouth(item, geom.mouthX, geom.mouthY, clipMs)
    // 碗饭：飞到最后一点时把空碗丢下去
    if (item.type === 'bowl') {
      setTimeout(() => { if (running) dropEmptyBowl(geom.mouthX, geom.mouthY, geom.scale) }, Math.max(0, clipMs - 120))
    }
    await playPromise
    if (!running) return
    eaten = Math.min(CFG.maxPoints, eaten + 1)
    popScore(eaten, item.type, geom)
    deps.say(lineOf(item.type === 'bowl' ? LINES.bowl : LINES.ball), CFG.bubbleMs)
    // 每 5 份补一句
    if (eaten > 0 && eaten % 5 === 0) setTimeout(() => { if (running) deps.say(lineOf(LINES.full), CFG.bubbleMs) }, 900)
    if (alive) await sleep(120)
  }

  /**
   * 收场：停一切、清干净、放锁。幂等。
   *
   * @param {string} why 收场原因（诊断日志用）
   * @returns {Promise<void>}
   */
  async function halt(why) {
    if (!running && !items.length && !spawnTimer) { gen++; return }
    running = false
    gen++
    sideToken++
    if (spawnTimer) { clearInterval(spawnTimer); spawnTimer = 0 }
    stopSide()
    try { deps.stopVisual() } catch {}
    clear()
    try { deps.hold(false) } catch {}
    deps.log('baifan halt: ' + String(why || ''))
  }

  return {
    start: start,
    halt: halt,
    isRunning: () => running,
    /** 自检快照：相位、场上几份饭、吃了几份。查「点了没反应/只说不吃」先看这个。 */
    info: () => ({
      running: running,
      phase: phase,
      items: items.length,
      falling: items.filter((i) => i.state === 'falling').length,
      ground: items.filter((i) => i.state === 'ground').length,
      eaten: eaten,
      facing: deps.pose().facing,
      geom: (() => { const g = geometry(); return { cx: Math.round(g.cx), cy: Math.round(g.cy), mouthX: Math.round(g.mouthX), mouthY: Math.round(g.mouthY), scale: Number(g.scale.toFixed(2)) } })(),
    }),
  }
}

// 给 Node 侧单测留出口；渲染页里直接当全局函数用。
if (typeof module !== 'undefined' && module.exports) module.exports = { createBaifan, CFG, LINES }
