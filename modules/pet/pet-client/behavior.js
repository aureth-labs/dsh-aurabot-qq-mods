// Aurabot 桌宠行为执行器 + 反应层纯逻辑（模板/生成物，与 main.js 同目录）。
// 接口与设定见 docs/PET_MODULE_API.md §4.3（行为动作）。
//
// 分层约定：
//   · 本文件只放「查表执行」的骨架与「纯判定函数」，所有 IO（win/screen/动画/原生调用）
//     都通过 ctx 注入 —— 这样 node:test 可以不经 Electron 直接单测。
//   · ctx 约定（由 main.js 提供）：
//       moveWindowTo(getTarget, opts)  → Promise<boolean> 缓动移动窗口（与甩抛互斥）
//                                          getTarget 返回 null = 立即中止（超时取消就靠它）
//       cursor()                       → {x,y} 当前鼠标指针位置（Electron screen DIP 坐标）
//       bodyRect()                     → {x,y,width,height} 可见身体盒（屏幕坐标）
//       playAnimByName(cands)          → Promise<boolean> 按候选名播素材（找不到静默 false）
//       nativeMove(x, y)               → Promise<boolean> 原生 SetCursorPos（失败静默 false）
//       pinCursor(x, y, ms)            → Promise<boolean> 把指针钉在原地 ms 毫秒（可选；没有则追到不按住）
//       say(text)                      → 气泡
//       sleep(ms)                      → Promise
//       readDesktopIcons()             → Promise<[{name,x,y}] | null> 桌面图标（DIP 坐标，只读）
//       iconAct(body)                  → Promise<{ok,id?,name?,originalPath?,reason?}> 图标收走接口
//       iconTimeoutMs?                 → 测试可注入更小的图标链路总时长（线上恒用 ICON_TOTAL_MAX_MS）
//
// 返回约定：run() 一律返回 { status:'played'|'failed'|'refused', reason? }，绝不抛异常。

'use strict'

// ---------- 阈值常量（反应层，写死阈值，全部集中在这里方便调参） ----------
const THRESHOLDS = Object.freeze({
  // 勾引：鼠标在身体盒 nearPx 内、windowMs 窗口里 ≥ minReversals 次高速折返
  TEASE_NEAR_PX: 120,        // 「附近」= 距身体盒边缘 <120px
  TEASE_WINDOW_MS: 1200,     // 统计窗口
  TEASE_MIN_REVERSALS: 3,    // ≥3 次折返/秒量级
  TEASE_MIN_SPEED: 350,      // 折返时最小速度 px/s（高速才算「晃」）
  // 摸摸：鼠标停在身体盒内持续 >2s 且基本不动
  PAT_DWELL_MS: 2000,
  PAT_JITTER_PX: 26,         // 摸摸允许的抖动幅度
  // 鼠标闲置：默认 8 分钟（可被服务端 behavior.idleCursorMinutes 覆盖）
  IDLE_CURSOR_MINUTES: 8,
  // 反应冷却：同一反应 30 秒内不重复触发
  REACTION_COOLDOWN_MS: 30_000,
  // ---------- 速度（2026-10-30 用户第二次指定） ----------
  // 叼鼠标：冲刺 400、叼着走 250（这两个不动）；溜达保持 50（散步感）；其余跑动统一 150。
  RUN_SPEED_PX_S: 150,        // 追鼠标 / 叼图标 / 窗口动作的跑动速度
  WANDER_SPEED_PX_S: 50,      // 溜达：慢慢晃，才有「闲逛」的样子
  STEAL_SPEED_PX_S: 400,      // 叼鼠标阶段①：冲过去
  STEAL_CARRY_SPEED_PX_S: 250, // 叼鼠标阶段②：叼着走
  STEAL_STOP_PX: 10,          // 冲刺阶段视为「冲到」的距离（鼠标 ≈ 被叼在嘴里）
  // 追鼠标：距目标 <STOP_PX 视为追到；追到后把指针按住 CHASE_HOLD_MS 再松开
  CHASE_STOP_PX: 8,
  CHASE_HOLD_MS: 5_000,
  CHASE_SPEED_PX_S: 150,
  CHASE_MAX_MS: 60_000,       // 追鼠标单独兜底：150px/s × 60s ≈ 9000px，够横跨双屏
  MOVE_MAX_MS: 90_000,
  // 图标动作：走到图标旁 60px；整条链路总时长兜底 ≤60s（150px/s 也够横跨双屏）
  ICON_GAP_PX: 60,
  ICON_TOTAL_MAX_MS: 60_000,
  // 图标单元格的竖直中心（ListView 给的是单元格左上角；图标约 48px + 文字，取 38 当中心）
  ICON_CENTER_OFFSET_Y: 38,
  // 图标单元格尺寸估算（放下时用来把图标夹在屏幕内，别把图标丢到屏幕外）
  ICON_CELL_PX: 96,
  // 随机落点（2026-10-30 用户指定：图标 / 鼠标每次都要放到不固定的位置）：
  // 离起点至少这么远，免得看起来像「原地抖了一下」
  DROP_MIN_DIST_PX: 280,
  // 推窗口（2026-10-30 用户指定）：把窗口推到屏幕边界外只剩 keep 宽，按住 5 秒再拉回原位
  WINDOW_PUSH_KEEP_PX: 80,
  WINDOW_PUSH_HOLD_MS: 5_000,
  // 窗口动作的站位：人物**中心**距窗口边缘多远（贴上去，但不整个盖住右上角的按钮）
  WINDOW_STAND_GAP_PX: 24,
})

// ---------- 动作注册表（客户端执行部分） ----------
// 每个 entry：{ desc, run(params, ctx) }。查表执行；查不到 = refused（动作表外一律拒绝）。
const ACTIONS = {
  chase_cursor: {
    desc: '追鼠标：平滑追到鼠标指针当前位置，追到后把指针按住 5 秒再松开',
    say: '（扑过去追你的鼠标！）',
    async run(_params, ctx) {
      const p = ctx.cursor()
      if (!p) return { status: 'refused', reason: 'no-cursor' }
      const ok = await ctx.moveWindowTo(() => {
        const c = ctx.cursor()
        return c ? { x: c.x, y: c.y } : null // 每帧重读鼠标位置
      }, { stopPx: THRESHOLDS.CHASE_STOP_PX, maxMs: THRESHOLDS.CHASE_MAX_MS, speed: THRESHOLDS.CHASE_SPEED_PX_S })
      if (!ok) return { status: 'failed', reason: 'move-interrupted' }
      // 追到了：把指针按住 5 秒（主进程用 ClipCursor 夹住指针，用户物理上挪不出去；
      // 到点/进程退出自动松开，绝不永久锁死）。老 ctx 没有 pinCursor 桥就只追不按。
      if (typeof ctx.pinCursor === 'function') {
        const c = ctx.cursor()
        if (c) await ctx.pinCursor(Math.round(c.x), Math.round(c.y), THRESHOLDS.CHASE_HOLD_MS)
      }
      return { status: 'played', reason: '' }
    },
  },
  wander: {
    desc: '空闲溜达：随机走到工作区另一头',
    say: '（去那边看看）',
    async run(_params, ctx) {
      const box = ctx.bodyRect()
      const target = ctx.pickWanderTarget
        ? ctx.pickWanderTarget(box)
        : null
      if (!target) return { status: 'refused', reason: 'no-area' }
      const ok = await ctx.moveWindowTo(() => target, {
        stopPx: 6,
        maxMs: THRESHOLDS.MOVE_MAX_MS,
        speed: THRESHOLDS.WANDER_SPEED_PX_S, // 溜达保持 50px/s（散步感）
      })
      return { status: ok ? 'played' : 'failed', reason: ok ? '' : 'move-interrupted' }
    },
  },
  idle_anim: {
    desc: '自己找点事做：从 idle 池随机播一段小动作（摇尾巴、眨眼这类），不移动',
    say: '（自己找点事做）',
    async run(_params, ctx) {
      if (typeof ctx.playIdleAnim !== 'function') return { status: 'refused', reason: 'no-anim-bridge' }
      const ok = await ctx.playIdleAnim()
      return { status: ok ? 'played' : 'failed', reason: ok ? '' : 'no-idle-anim' }
    },
  },
  steal_cursor: {
    desc: '叼鼠标：快速冲到鼠标位置叼住，再带着鼠标一起同步移动一段后松口',
    say: '（叼走你的鼠标）',
    async run(params, ctx) {
      const c = ctx.cursor()
      if (!c) return { status: 'refused', reason: 'no-cursor' }
      // 阶段①：以 STEAL_SPEED_PX_S（400px/s）快速冲到鼠标位置——每帧重读，跟 chase_cursor 同款
      const ok = await ctx.moveWindowTo(() => {
        const cc = ctx.cursor()
        return cc ? { x: cc.x, y: cc.y } : null
      }, { stopPx: THRESHOLDS.STEAL_STOP_PX, maxMs: THRESHOLDS.CHASE_MAX_MS, speed: THRESHOLDS.STEAL_SPEED_PX_S })
      if (!ok) return { status: 'failed', reason: 'move-interrupted' }
      // 阶段②：叼住——主进程带着鼠标一起走（每帧 SetCursorPos + ClipCursor 把指针夹在嘴边，
      // 用户拽不出去，也就不会「移动出去又闪现回来」），250px/s 拖一段再松口。
      const body = ctx.bodyRect()
      const start = ctx.cursor()
      if (!body || !start) return { status: 'failed', reason: 'no-body' }
      const area = typeof ctx.workArea === 'function' ? ctx.workArea() : null
      // 落点（2026-10-30 用户指定）：AI 给了坐标就用它的，否则每次在工作区里随机一个点——
      // 以前是「随机角度 × 固定 180px」，每次落点都落在同一圈上，用户要求「每次都不固定」。
      const drop = pickDropPoint(start, body, area, {
        x: params && params.x,
        y: params && params.y,
        minDist: THRESHOLDS.DROP_MIN_DIST_PX,
      })
      if (!drop) return { status: 'failed', reason: 'no-area' }
      ctx.playAnimByName(['叼', '咬', '挣扎', 'steal']) // 叼住动画（找不到素材静默）
      // carry:true → 主进程每帧把鼠标钉在身体中心并锁住裁剪区，窗口与鼠标天然同步
      const ok2 = await ctx.moveWindowTo(() => drop, {
        stopPx: 4,
        maxMs: THRESHOLDS.MOVE_MAX_MS,
        speed: THRESHOLDS.STEAL_CARRY_SPEED_PX_S,
        carry: true,
      })
      return ok2 // 松口：主进程在移动结束时已经释放鼠标
        ? { status: 'played', reason: '' }
        : { status: 'failed', reason: 'carry-interrupted' }
    },
  },
  say: {
    desc: '只说话不动作（现有气泡）',
    say: '',
    async run(params, ctx) {
      const text = String((params && (params.text || params.say)) || '').trim()
      if (!text) return { status: 'refused', reason: 'empty-text' }
      ctx.say(text)
      return { status: 'played', reason: '' }
    },
  },
  // ---------- 图标动作：drag_icon / hide_icon（共用动画链骨架） ----------
  drag_icon: {
    desc: '走到桌面图标旁叼住，把图标拖到一个新位置放下（默认随机落点，也可由 params.x/y 指定）',
    say: '（这个图标我挪个地方）',
    run: (params, ctx) => iconActionRun('drag', params, ctx),
  },
  hide_icon: {
    desc: '把桌面图标收走（不给 params.icon 就随机挑一个；POST /behavior/icon/act，被安全闸拒绝时回执带原因）',
    say: '（这个我先收起来）',
    run: (params, ctx) => iconActionRun('hide', params, ctx),
  },
  // ---------- 窗口动作（只发 WM_CLOSE，绝不 taskkill） ----------
  // 2026-10-30：peek_window（探头）按用户要求删除——凑头没意义。
  nudge_window: {
    desc: '跑到窗口内侧，把窗口一路推到屏幕边界外（只剩一条边），按住 5 秒再同步拉回原位',
    say: '（把这个窗口推出去）',
    async run(params, ctx) {
      const got = await pickWindowForAction(params, ctx)
      if (got.reason) return { status: 'refused', reason: got.reason }
      const w = got.window
      const body = ctx.bodyRect()
      const area = typeof ctx.workArea === 'function' ? ctx.workArea() : null
      // 计划（纯函数）：朝更近的竖边推，人物站**窗内侧**——窗口被推出去时人物还跟得上（不会被夹在屏外）
      const plan = body ? windowPushPlan(w, body, area) : null
      if (!plan) return { status: 'refused', reason: 'no-area', detail: w.title }
      if (typeof ctx.windowSlide !== 'function') return { status: 'refused', reason: 'no-window-bridge', detail: w.title }
      // 1) 先跑到窗口内侧（align:'body'：以人物到达为准）
      const arrive = await ctx.moveWindowTo(() => plan.stand, {
        stopPx: 6, maxMs: THRESHOLDS.MOVE_MAX_MS, align: 'body', speed: THRESHOLDS.RUN_SPEED_PX_S,
      })
      if (!arrive) return { status: 'failed', reason: 'move-interrupted', detail: w.title }
      await ctx.playAnimByName(WINDOW_ANIMS.nudge)
      const home = bodyOf(ctx) || plan.stand
      const pushMs = plan.pushMs
      // 2) 推出去：窗口匀速滑走 + 人物同速跟着走（同一条 delta、同一段时长）——
      //    用户明确要求「不是窗口闪现到特定位置」，而是人物和窗口一起挪过去。
      const [petOut, winOut] = await Promise.all([
        ctx.moveWindowTo(() => ({ x: home.x + plan.deltaX, y: home.y }), {
          stopPx: 6, maxMs: pushMs + 30_000, align: 'body', speed: THRESHOLDS.RUN_SPEED_PX_S,
        }),
        ctx.windowSlide(w.hwnd, plan.deltaX, 0, pushMs),
      ])
      const pushed = Boolean(petOut) && Boolean(winOut)
      // 3) 按住 5 秒（窗口就停在屏幕外那条缝上，人物也站在边上）
      if (pushed) await ctx.sleep(THRESHOLDS.WINDOW_PUSH_HOLD_MS)
      // 4) 同步拉回原位
      await Promise.all([
        ctx.moveWindowTo(() => home, { stopPx: 6, maxMs: pushMs + 30_000, align: 'body', speed: THRESHOLDS.RUN_SPEED_PX_S }),
        ctx.windowSlide(w.hwnd, -plan.deltaX, 0, pushMs),
      ])
      // 5) 兜底：不管中间怎么失败，窗口最终一定回到原始坐标（push 是「吓一跳」，不是「弄丢窗口」）
      if (typeof ctx.windowPlace === 'function') { try { await ctx.windowPlace(w.hwnd, w.x, w.y) } catch {} }
      await ctx.playAnimByName(pushed ? WINDOW_ANIMS.win : WINDOW_ANIMS.sorry)
      return pushed
        ? { status: 'played', reason: '', detail: w.title }
        : { status: 'failed', reason: 'push-failed', detail: w.title }
    },
  },
  close_window: {
    desc: '跑到窗口右上角，把它优雅关掉（WM_CLOSE = 点右上角 X，程序自己问要不要保存）',
    say: '（这个窗口碍事，关掉）',
    async run(params, ctx) {
      // 物理闸二次校验：服务端只在「允许 AI 关闭窗口」打开时才带 windowEnabled=true 下发，
      // 明确 false（旧模板/排队期间被关掉）一律拒演——宁可不动，也不能替主人关掉窗口。
      if (params && params.windowEnabled === false) return { status: 'refused', reason: 'close-window-disabled' }
      const got = await pickWindowForAction(params, ctx)
      if (got.reason) return { status: 'refused', reason: got.reason }
      const w = got.window
      const body = ctx.bodyRect()
      // 用户指定：**人物**跑到目标窗口右上角（那里就是 X 的位置）——目标点就是人物中心要到的点
      const target = body ? windowCornerTarget(w, body, ctx) : null
      if (!target) return { status: 'refused', reason: 'no-body', detail: w.title }
      const okMove = await ctx.moveWindowTo(() => target, {
        stopPx: 6, maxMs: THRESHOLDS.MOVE_MAX_MS, align: 'body', speed: THRESHOLDS.RUN_SPEED_PX_S,
      })
      if (!okMove) return { status: 'failed', reason: 'move-interrupted', detail: w.title }
      if (typeof ctx.windowClose !== 'function') return { status: 'refused', reason: 'no-window-bridge', detail: w.title }
      const ok = await ctx.windowClose(w.hwnd) // 铁律 3：只发 WM_CLOSE
      await ctx.playAnimByName(ok ? WINDOW_ANIMS.win : WINDOW_ANIMS.sorry)
      return ok
        ? { status: 'played', reason: '', detail: w.title }
        : { status: 'failed', reason: 'close-failed', detail: w.title }
    },
  },
  // 小屋动作（三期）：实际执行在 main.js 的 handleHouseBehavior（开场景窗+跳状态），
  // 这里只登记元数据（desc/say 与服务端逐字一致，对账测试盯着）+ 兜底 run。
  enter_house: {
    desc: '回小屋：打开小屋场景窗，她进屋里过日子；可指定去哪（沙发玩手机/餐桌吃饭/书桌办公/床上睡觉/衣柜换装/阳台吹风/厨房找吃的/客厅玩耍），不指定就自由活动',
    say: '（回屋里待会儿）',
    run: notImplemented, // 不会走到这里：main.js 拦截执行；留着防漏网路径报 refused 而不是崩
  },
}
// 留作后续批次占位：新动作先登记 run: notImplemented（回执 refused:not-implemented，面板会置灰）
function notImplemented() {
  return Promise.resolve({ status: 'refused', reason: 'not-implemented' })
}

// ---------- 窗口动作纯逻辑（node:test 可单测） ----------
// ctx 新增注入（由 main.js 提供）：
//   listWindows() → Promise<[{hwnd,pid,proc,title,cls,zoomed,fg,x,y,width,height}] | null>
//     （x/y/width/height 已由客户端换算成 DIP；读不到返回 null）
//   windowClose(hwnd) → Promise<boolean>   只发 WM_CLOSE（铁律 3，绝不 taskkill）
//   windowSlide(hwnd, dx, dy, ms) → Promise<boolean>  把窗口在 ms 内匀速挪 (dx,dy)（人物同速跟着走）
//   windowPlace(hwnd, x, y) → Promise<boolean>  把窗口放到绝对坐标（推完的兜底还原）
//   moveDesktopIcon(name, x, y) → Promise<boolean>  真的挪动桌面图标（ListView LVM_SETITEMPOSITION）
//   selfPids()        → number[]           自己的进程（桌宠/宿主），永远不碰
const WINDOW_ANIMS = Object.freeze({
  nudge: ['推', '撞', '顶', 'push'],
  win: ['得逞', '得意', '开心'],
  sorry: ['道歉', '愧疚', '低头', '委屈'],
})
// 壳层/系统窗口类名（小写）：任务栏、桌面、输入法候选、开始菜单、通知气泡… 永远不碰
const SYSTEM_WINDOW_CLASSES = new Set([
  'progman', 'workerw', 'shelldll_defview', 'shell_traywnd', 'shell_secondarytraywnd',
  'windows.ui.core.corewindow', 'ime', 'default ime', 'tooltips_class32', 'notificationwnd',
  'multitaskingviewframe', 'xaml_explorer', 'tasklist_thumbr',
])
// 类名关键词（**子串**判定）：真机枚举里会出现 `wetype.statusbar.window`（输入法状态栏）这类
// 厂商自命名的壳层窗口，精确名单挡不住，用关键词兜一层。
const SYSTEM_WINDOW_CLASS_HINTS = ['statusbar', 'status_bar', 'shell_tray', 'ime', 'tooltip', 'notification', 'taskbar']
// 最小化窗口：Windows 把它挪到 -32000 附近，IsWindowVisible 仍是 true —— 必须按坐标排除，
// 否则「推窗口」会去推一个屏幕外的东西（用户什么都看不到，纯浪费一次走位）。
const MINIMIZED_COORD = -30000
// 系统/自己的进程（小写、无 .exe）：Explorer、DWM、登录界面、宿主与桌宠自己…
// 宁可多排除：关错了是不可逆的用户损失，少关一个只是没演成。
const SYSTEM_WINDOW_PROCS = new Set([
  'explorer', 'dwm', 'winlogon', 'csrss', 'smss', 'wininit', 'services', 'lsass', 'sihost', 'taskhostw',
  'searchapp', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost',
  'applicationframehost', 'systemsettings', 'lockapp', 'electron', 'node', 'aurabot', 'codebuddy', 'deepseek',
])
const winArea = (w) => Math.max(0, Number(w && w.width) || 0) * Math.max(0, Number(w && w.height) || 0)
/** 白名单：逗号/空白分隔的「标题片段或进程名」，空 = 不额外限制（只受排除名单约束）。 */
function parseWhitelist(raw) {
  return String(raw || '').split(/[,，;；\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
}
/** 挑一个可以碰的窗口（纯函数）：
 *  ① 硬性排除：无标题 / 不可见 / 全屏(zoomed) / 壳层类名 / 系统进程 / 自己的进程
 *  ② 白名单非空时只保留标题或进程名命中白名单的
 *  ③ params.title 给了标题片段时只保留命中的（找不到 → window-not-found，绝不退而求其次乱关一个）
 *  ④ 排序：前台窗口优先，其次面积最大的（最可能是主人正在用的那个）
 *  返回 { window } | { reason }（reason 直接当回执原因）。 */
function pickWindowTarget(windows, opts) {
  const o = opts || {}
  const list = (Array.isArray(windows) ? windows : []).filter((w) => w && typeof w === 'object')
  const whitelist = parseWhitelist(o.whitelist)
  const wanted = String(o.wanted || '').trim().toLowerCase()
  const selfPids = new Set((Array.isArray(o.selfPids) ? o.selfPids : []).map((p) => Number(p)).filter((p) => Number.isFinite(p)))
  const base = []
  for (const w of list) {
    const title = String(w.title || '').trim()
    if (!title) continue
    if (w.visible === false) continue
    if (w.zoomed === true) continue // 全屏/最大化：不碰（推歪会全屏抖）
    if (Number(w.x) <= MINIMIZED_COORD || Number(w.y) <= MINIMIZED_COORD) continue // 最小化到屏幕外：不碰
    const cls = String(w.cls || '').toLowerCase()
    if (SYSTEM_WINDOW_CLASSES.has(cls)) continue
    if (SYSTEM_WINDOW_CLASS_HINTS.some((k) => cls.includes(k))) continue
    const proc = String(w.proc || '').toLowerCase().replace(/\.exe$/, '')
    if (SYSTEM_WINDOW_PROCS.has(proc)) continue
    if (selfPids.has(Number(w.pid))) continue
    base.push({ ...w, title, cls, proc })
  }
  if (!base.length) return { reason: 'no-window' }
  let pool = base
  if (whitelist.length) {
    const hit = base.filter((w) => whitelist.some((k) => w.title.toLowerCase().includes(k) || w.proc.includes(k)))
    if (!hit.length) return { reason: 'window-not-whitelisted' }
    pool = hit
  }
  if (wanted) {
    const hit = pool.filter((w) => w.title.toLowerCase().includes(wanted))
    if (!hit.length) return { reason: 'window-not-found' }
    pool = hit
  }
  const sorted = [...pool].sort((a, b) => (Number(b.fg) || 0) - (Number(a.fg) || 0) || winArea(b) - winArea(a))
  return { window: sorted[0] }
}
/** 当前身体中心（人物所在点）。拿不到返回 null。 */
function bodyOf(ctx) {
  const b = ctx && typeof ctx.bodyRect === 'function' ? ctx.bodyRect() : null
  if (!b) return null
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
}
/** 把「人物中心」夹进工作区（四边各留半个身位，人物整个在屏内）。没有 area 就原样返回。 */
function clampBodyCenter(p, body, area) {
  const x = Number(p && p.x)
  const y = Number(p && p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (!area || !(Number(area.width) > 0)) return { x: Math.round(x), y: Math.round(y) }
  const halfW = Math.max(0, Number(body && body.width) || 0) / 2
  const halfH = Math.max(0, Number(body && body.height) || 0) / 2
  const loX = Number(area.x) + halfW
  const hiX = Number(area.x) + Number(area.width) - halfW
  const loY = Number(area.y) + halfH
  const hiY = Number(area.y) + Number(area.height) - halfH
  return {
    x: Math.round(Math.min(Math.max(x, loX), Math.max(loX, hiX))),
    y: Math.round(Math.min(Math.max(y, loY), Math.max(loY, hiY))),
  }
}
/** 站到窗口**右上角**（纯函数，close_window 用）：返回**人物中心**该到的点。
 *  2026-10-30 用户实测修正：「以人物到达为准」——以前返回的是「窗口边缘 + 半个身位」，
 *  于是人物中心落到了角的外侧下方，看起来像「窗口左上角到了、人物没到」。现在直接把人物中心
 *  放在「角向外 gap」处，人物就真的贴在那个角上（并轻微盖住 X 按钮，正是要按它的样子）。 */
function windowCornerTarget(w, body, ctx) {
  if (!w || !body || !(Number(w.width) > 0) || !(Number(w.height) > 0)) return null
  const gap = THRESHOLDS.WINDOW_STAND_GAP_PX
  const area = ctx && typeof ctx.workArea === 'function' ? ctx.workArea() : null
  return clampBodyCenter({ x: Number(w.x) + Number(w.width) + gap, y: Number(w.y) + gap }, body, area)
}
/** 推窗口计划（纯函数）：朝更近的那条竖边推，人物站**窗内侧**（推的反方向），
 *  窗口被推出屏幕时人物还能跟着走；推出去屏幕里只留 keepPx 宽。
 *  返回 { stand, deltaX, pushMs }（stand 是人物中心、deltaX 是窗口要走的水平距离）。 */
function windowPushPlan(w, body, area, opts) {
  if (!w || !body || !(Number(w.width) > 0)) return null
  if (!area || !(Number(area.width) > 0)) return null
  const o = opts || {}
  const keep = Number(o.keepPx) > 0 ? Number(o.keepPx) : THRESHOLDS.WINDOW_PUSH_KEEP_PX
  const gap = Number(o.gapPx) > 0 ? Number(o.gapPx) : THRESHOLDS.WINDOW_STAND_GAP_PX
  const speed = Number(o.speedPxS) > 0 ? Number(o.speedPxS) : THRESHOLDS.RUN_SPEED_PX_S
  const wl = Number(w.x)
  const ww = Number(w.width)
  const toLeft = wl + ww / 2 < Number(area.x) + Number(area.width) / 2
  const targetX = toLeft ? Number(area.x) + keep - ww : Number(area.x) + Number(area.width) - keep
  const deltaX = Math.round(targetX - wl)
  if (Math.abs(deltaX) < 40) return null // 已经贴在边上了：推不出戏剧效果，别白跑一趟
  // 人物站窗内侧：要往左推就站窗口右边，往右推就站窗口左边；纵向对齐窗口中线
  const standX = toLeft ? wl + ww + gap : wl - gap
  const stand = clampBodyCenter({ x: standX, y: Number(w.y) + Number(w.height) / 2 }, body, area)
  if (!stand) return null
  const pushMs = Math.max(120, Math.round(Math.abs(deltaX) / speed * 1000))
  return { stand, deltaX, pushMs, toLeft }
}

/** 取窗口清单 → 挑一个。桥缺失/读不到一律 refused（绝不猜）。 */
async function pickWindowForAction(params, ctx) {
  if (typeof ctx.listWindows !== 'function') return { reason: 'no-window-bridge' }
  let wins = null
  try { wins = await ctx.listWindows() } catch { wins = null }
  if (!Array.isArray(wins)) return { reason: 'windows-unavailable' }
  return pickWindowTarget(wins, {
    wanted: params && params.title,
    whitelist: params && params.whitelist,
    selfPids: typeof ctx.selfPids === 'function' ? ctx.selfPids() : [],
  })
}

/** 查表执行：未知动作 refused（铁律 1）。ctx 缺失的依赖一律 refused，绝不抛异常。 */
function execute(action, params, ctx) {
  const name = String(action || '').trim()
  const entry = ACTIONS[name]
  if (!entry || typeof entry.run !== 'function') {
    return Promise.resolve({ status: 'refused', reason: 'unknown-action' })
  }
  if (!ctx) return Promise.resolve({ status: 'refused', reason: 'no-ctx' })
  try {
    return Promise.resolve(entry.run(params || {}, ctx)).then(
      (r) => (r && r.status ? r : { status: 'failed', reason: 'bad-run-result' }),
      (err) => ({ status: 'failed', reason: 'error:' + (err && err.message || err) }),
    )
  } catch (err) {
    return Promise.resolve({ status: 'failed', reason: 'error:' + (err && err.message || err) })
  }
}

// ---------- drag_icon / hide_icon 纯逻辑辅助 + 共用动画链（node:test 可单测） ----------
// ctx 新增注入（由 main.js 提供）：
//   readDesktopIcons() → Promise<[{name,x,y,isDir?,hidden?}] | null>（DIP 坐标，读不到 null）
//   iconAct(body)      → Promise<{ok, id?, name?, originalPath?, reason?}>（POST /behavior/icon/act）
//   iconTimeoutMs?     → 测试可注入更小的总时长兜底（线上恒用 THRESHOLDS.ICON_TOTAL_MAX_MS）
// 设计铁律：只读桌面（绝不写）；只碰普通文件，文件夹/隐藏/系统图标一律不碰；全链路超时兜底绝不崩主进程。
//
// 实测提示（2026-10-30 本机验证）：桌面 ListView 返回的是**显示名**——`Trae CN.lnk` 读出来是 `Trae CN`
// （Explorer 隐藏已知扩展名）。所以服务端简报里的名字可能带 `.lnk`/`.url`，必须容错匹配。

/** 动画候选（与素材包命名约定模糊匹配）：叼起 → 得逞 / 疑惑叹气。 */
const ICON_ANIMS = Object.freeze({
  grab: ['叼', '咬', '叼起'],
  win: ['得逞', '得意', '开心'],
  doubt: ['疑惑', '叹气', '歪头'],
})

/** 系统图标名单（回收站/此电脑等绝不碰）。 */
const SYSTEM_ICON_NAMES = new Set(['回收站', '此电脑', '网络', '控制面板', '用户', '文档', '下载', '图片', '音乐', '视频',
  'Recycle Bin', 'This PC', 'Network', 'Control Panel', 'User', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'])

/** 系统/隐藏文件名（Explorer 里的 desktop.ini 等：即使显示出来也绝不碰）。 */
const SYSTEM_FILE_NAMES = new Set(['desktop.ini', 'thumbs.db'])

/** 去掉已知可执行/快捷方式扩展名，用来做「显示名 ↔ 磁盘名」的容错比较。 */
const STRIP_EXT_RE = /\.(lnk|url|exe|bat|cmd|com|msi|ps1|vbs|rdp|reg|scr)$/i

/** 系统图标（回收站/此电脑…）在资源管理器里是以 CLSID GUID 命名的，与服务端同一条规则：永远不碰。 */
const CLSID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}(\.|$)/

/** 服务端拒绝原因（英文 code）→ 面板中文。未知 code 原样带出，不吞。 */
const ICON_REASON_TEXT = Object.freeze({
  'icon-mischief-disabled': '图标恶作剧开关是关着的',
  'bad-name': '这个名字不合法',
  'hidden': '隐藏文件和临时锁不碰',
  'system-file': '系统壳层文件不碰',
  'system-icon': '系统图标不碰',
  'bad-ext': '可执行/脚本类文件不碰',
  'desktop-not-found': '找不到桌面目录',
  'not-file': '不是普通文件',
  'not-found': '桌面上已经找不到这个图标了',
  'bad-mode': '动作模式不对',
  'hide-failed': '收进隔离区失败了',
  'act-error': '图标接口出错了',
})
function iconReasonText(code) {
  const c = String(code || '').trim()
  if (!c) return ''
  return ICON_REASON_TEXT[c] || c
}

/** 只在比较用：把名字规整成「无扩展名 + 去空白 + 小写」。 */
function iconKey(name) {
  return String(name || '').trim().replace(STRIP_EXT_RE, '').trim().toLowerCase()
}

/** 单个图标是否「可碰」：普通文件（非文件夹/非隐藏/非系统图标/非系统文件/非空名）。 */
function isNormalIcon(ic) {
  if (!ic || typeof ic.name !== 'string') return false
  const raw = ic.name.trim()
  if (!raw) return false
  if (ic.isDir === true || ic.hidden === true) return false
  if (SYSTEM_ICON_NAMES.has(raw)) return false
  if (SYSTEM_FILE_NAMES.has(raw.toLowerCase())) return false
  if (CLSID_RE.test(raw)) return false // 系统图标的磁盘名（{GUID}.lnk）：服务端也会拒，这里先挡掉省一次走位
  return true
}

/** 图标清单过滤：只留「普通文件」——排除文件夹(isDir)、隐藏(hidden)、系统图标、空名。 */
function filterNormalIcons(icons) {
  return (Array.isArray(icons) ? icons : []).filter(isNormalIcon)
}

/** 从清单里随机挑一个普通文件（rng 可注入以便单测）。挑不到 → null。 */
function pickNormalIcon(icons, rng) {
  const list = filterNormalIcons(icons)
  if (!list.length) return null
  const rand = rng || Math.random
  return list[Math.floor(rand() * list.length) % list.length]
}

/** 按服务端给的文件名找图标（容错）：磁盘真名 → 精确 → 不区分大小写 → 去扩展名。
 *  为什么先比 `file`：服务端简报给 AI、以及面板回执里带回来的都是**磁盘名**
 *  （`光辉玻璃服务器 16666.rdp`），而 ListView 给的是**显示名**（`6666.rdp`）。
 *  只比 name 的话这条永远 icon-not-found —— 第三批前必须补上。 */
function resolveIconTarget(icons, wanted) {
  const list = Array.isArray(icons) ? icons : []
  const name = String(wanted || '').trim()
  if (!name) return { reason: 'no-icon' }
  const key = iconKey(name)
  const lower = name.toLowerCase()
  const sameFile = (ic) => Boolean(ic && typeof ic.file === 'string' && ic.file
    && (ic.file === name || ic.file.toLowerCase() === lower || iconKey(ic.file) === key))
  const sameName = (ic) => Boolean(ic && typeof ic.name === 'string' && ic.name.trim()
    && (ic.name.trim() === name || ic.name.trim().toLowerCase() === lower || iconKey(ic.name) === key))
  const hit = list.find(sameFile) || list.find(sameName)
  if (!hit) return { reason: 'icon-not-found' }
  if (!isNormalIcon(hit)) return { reason: 'icon-protected' } // 文件夹/隐藏/系统图标：不碰
  return { icon: hit }
}

/** 显示名 → 磁盘名（唯一子串反查，治「显示名被 Explorer 截断」）：
 *  本机 `光辉玻璃服务器 16666.rdp` 在桌面上显示成 `6666.rdp`，靠「显示名+猜后缀」永远猜不到。
 *  截断只会让显示名变短，所以只在「显示名主干是磁盘名主干的子串」这一个方向找，且**必须唯一命中**：
 *    · 命中 0 个 → 返回 ''（调用方保持 refused，不误伤）
 *    · 命中 ≥2 个 → 有歧义，返回 ''（宁可不动，也不猜错文件）
 *    · 主干短于 3 个字符 → 不模糊（"a" 这种太容易撞车）
 *  只做字符串运算，不碰文件系统，可单测。 */
function matchIconByName(name, files) {
  const wanted = iconKey(name)
  if (wanted.length < 3) return ''
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === 'string' && f && !SYSTEM_FILE_NAMES.has(f.toLowerCase()) && !CLSID_RE.test(f))
  const hits = list.filter((f) => iconKey(f).includes(wanted))
  return hits.length === 1 ? hits[0] : ''
}

/** 图标的磁盘名候选（纯函数，按优先级排序、去重）：
 *   ① 外部给的权威映射（可选，预留：koffi/COM 若将来能给出「显示名 → 磁盘全路径」就填这里）
 *   ② 「桌面目录 × 后缀」逐个猜（默认路径）
 *  调用方负责 stat 第一个存在的那个；这里只算路径，不碰文件系统，方便单测。 */
function iconCandidatePaths(name, nameMap, dirs, suffixes) {
  const raw = String(name || '').trim()
  if (!raw) return []
  const out = []
  const mapped = nameMap && typeof nameMap === 'object' ? nameMap[raw] : ''
  if (typeof mapped === 'string' && mapped) out.push(mapped)
  const list = (Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && d)
  const exts = Array.isArray(suffixes) && suffixes.length ? suffixes : ['', '.lnk', '.url', '.exe']
  for (const dir of list) {
    const sep = /[\\/]$/.test(dir) ? '' : '\\'
    for (const ext of exts) out.push(dir + sep + raw + ext)
  }
  return [...new Set(out)]
}

/** 走位目标（纯函数）：站到图标旁边，身体边缘距图标 gap 像素、纵向对齐图标**单元格中心**。
 *  2026-10-30：ListView 给的是单元格左上角，直接对齐会让角色挂在高处，这里 +ICON_CENTER_OFFSET_Y。
 *  2026-10-30 二次修正（用户实测「收图标定位不对」）：桌面图标默认就在**最左列**，一直按「站左侧」
 *  算出来的 x 是负的，被夹回屏幕边上后人物正好压在图标上。改成先看左边放不放得下（有 area 才能判），
 *  放不下就绕到右边。 */
function iconApproachTarget(icon, body, gapPx, area) {
  if (!icon || !body) return null
  const gap = Number(gapPx) > 0 ? Number(gapPx) : THRESHOLDS.ICON_GAP_PX
  const half = body.width / 2
  const y = Math.round(icon.y + THRESHOLDS.ICON_CENTER_OFFSET_Y)
  const left = { x: Math.round(icon.x - gap - half), y }
  const right = { x: Math.round(icon.x + gap + half), y }
  if (!area || !(Number(area.width) > 0)) return left
  const leftFits = left.x - half >= Number(area.x || 0)
  const rightFits = right.x + half <= Number(area.x || 0) + Number(area.width)
  if (leftFits) return left
  if (rightFits) return right
  return left // 两边都放不下（图标在极窄屏中间）：仍旧按左边，由 moveWindowTo 的 align:'body' 夹回来
}

/** 随机落点（纯函数，返回**人物中心**该到的点）：
 *  · opts.x / opts.y（AI 给的屏幕坐标，DIP）合法就用它——「每次不固定」由 AI 决定；
 *  · 否则在工作区里随机（四边各留半个身位，人物整个在屏内），且离 from 至少 minDist，
 *    免得看起来像「原地抖了一下」。
 *  拿不到工作区 → null（调用方按 no-area 拒演）。rng 可注入以便单测。 */
function pickDropPoint(from, body, area, opts) {
  const o = opts || {}
  const rand = o.rng || Math.random
  if (!area || !(Number(area.width) > 0)) return null
  const half = Math.max(0, Number(body && body.width) || 0) / 2
  const halfH = Math.max(0, Number(body && body.height) || 0) / 2
  const loX = Number(area.x) + half
  const hiX = Math.max(loX, Number(area.x) + Number(area.width) - half)
  const loY = Number(area.y) + halfH
  const hiY = Math.max(loY, Number(area.y) + Number(area.height) - halfH)
  const clampX = (v) => Math.round(Math.min(Math.max(v, loX), hiX))
  const clampY = (v) => Math.round(Math.min(Math.max(v, loY), hiY))
  const ax = Number(o.x)
  const ay = Number(o.y)
  if (Number.isFinite(ax) && Number.isFinite(ay)) return { x: clampX(ax), y: clampY(ay), source: 'ai' }
  const minDist = Number(o.minDist) > 0 ? Number(o.minDist) : THRESHOLDS.DROP_MIN_DIST_PX
  let last = null
  for (let i = 0; i < 8; i++) {
    last = { x: clampX(loX + rand() * Math.max(1, hiX - loX)), y: clampY(loY + rand() * Math.max(1, hiY - loY)) }
    if (!from || Math.hypot(last.x - Number(from.x), last.y - Number(from.y)) >= minDist) break
  }
  return { ...last, source: 'random' }
}

/** 图标链路的时间预算：deadline 到点后 cancelled=true，所有走位目标立刻返回 null（moveWindowTo 当场中止）。
 *  纯内存对象，main.js 不需要额外接口——超时取消是靠 getTarget 返回 null 实现的。 */
function iconBudget(ms) {
  const total = Number(ms) > 0 ? Number(ms) : THRESHOLDS.ICON_TOTAL_MAX_MS
  return { total, deadline: Date.now() + total, cancelled: false }
}

/** 剩余预算（至少留 120ms，免得 maxMs 为 0 让 moveWindowTo 立刻超时判失败）。 */
function remainMs(budget) {
  if (!budget) return THRESHOLDS.MOVE_MAX_MS
  return Math.max(120, budget.deadline - Date.now())
}

/** 总时长兜底：竞速一个 failed:'timeout' 哨兵，到点同时把 budget 标记 cancelled。
 *  线上 12s，测试可经 ctx.iconTimeoutMs 注入更小值。
 *  注意：输掉竞速的那条链仍在后台跑，所以必须自己接住它的异常——否则会变成
 *  未处理的 Promise rejection（Electron 主进程里可能触发 unhandledRejection）。 */
async function iconActionWithTimeout(run, ctx) {
  const ms = Number(ctx && ctx.iconTimeoutMs) > 0 ? Number(ctx.iconTimeoutMs) : THRESHOLDS.ICON_TOTAL_MAX_MS
  const budget = iconBudget(ms)
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => { budget.cancelled = true; resolve({ status: 'failed', reason: 'timeout' }) }, ms)
  })
  const chain = Promise.resolve()
    .then(() => run(budget))
    .catch((err) => ({ status: 'failed', reason: 'error:' + (err && err.message || err) }))
  try {
    return await Promise.race([chain, guard])
  } finally { clearTimeout(timer) }
}

/** 降级表演：读不到桌面图标时，走到屏幕下沿随机位置叼一口再疑惑叹气。
 *  只是表演——不读文件、不调 act、不动任何东西；拿不到工作区/身体盒就直接跳过（静默）。 */
async function degradeIconPerf(ctx, budget) {
  try {
    const body = ctx.bodyRect()
    const area = typeof ctx.workArea === 'function' ? ctx.workArea() : null
    if (!body || !area || !(area.width > 0)) return
    const rand = Math.random
    const point = {
      x: Math.round(area.x + rand() * Math.max(0, area.width - body.width)),
      y: Math.round(area.y + Math.max(0, area.height - body.height)), // 屏幕下沿
    }
    const ok = await ctx.moveWindowTo(() => (budget.cancelled ? null : point), {
      stopPx: 8, maxMs: remainMs(budget), speed: THRESHOLDS.RUN_SPEED_PX_S,
    })
    if (budget.cancelled || !ok) return
    await ctx.playAnimByName(ICON_ANIMS.grab)
    if (budget.cancelled) return
    await ctx.playAnimByName(ICON_ANIMS.doubt) // 空嘴：疑惑叹气，不当得逞
  } catch { /* 降级表演失败也不许影响回执 */ }
}

/** 共用动画链骨架：定位选标 → 走到图标旁 60px → 叼起 →（hide 调 act / drag 拖到新位置）→ 收尾。
 *  每一步都看 budget.cancelled（超时后立刻收手，绝不继续搬窗口）。
 *  2026-10-30 三次修正（用户实测反馈）：
 *    · 走位用 align:'body'——以**人物**到达为准（屏幕上沿的图标也走得到）；
 *    · drag 真拖：图标跟着身体走，最后**真的放下**（默认随机落点，也可由 params.x/y 指定）；
 *    · 只有「没走到 / 被取消」才把图标放回原位——演成功了就留在新位置（用户要的就是挪窝）。 */
async function iconActionChain(mode, params, ctx, budget) {
  const stop = { status: 'failed', reason: 'cancelled' }
  /** 走到某点：预算内缓动；取消后 getTarget 返回 null → moveWindowTo 立即中止。
   *  align:'body'：把**身体中心**夹进工作区（窗口允许越出屏幕边），人物才真的到得了图标。 */
  const moveTo = (point, stopPx, speed) => ctx.moveWindowTo(
    () => (budget.cancelled ? null : point),
    { stopPx: stopPx || 6, maxMs: remainMs(budget), align: 'body', speed: speed || THRESHOLDS.RUN_SPEED_PX_S },
  )
  // 1) 拿图标清单：桥缺失/读不到（含抛异常）一律 refused，绝不让主进程崩
  if (typeof ctx.readDesktopIcons !== 'function') return { status: 'refused', reason: 'no-desktop-bridge' }
  // drag 必须能真的搬图标：没有这个桥就别白跑一趟（用户要的是「挪窝」，不是演一下）
  if (mode === 'drag' && typeof ctx.moveDesktopIcon !== 'function') return { status: 'refused', reason: 'no-icon-bridge' }
  let icons = null
  try { icons = await ctx.readDesktopIcons() } catch { icons = null }
  if (budget.cancelled) return stop
  if (ctx.debugLog) ctx.debugLog({ phase: 'icons', count: Array.isArray(icons) ? icons.length : -1, sample: Array.isArray(icons) ? icons.slice(0, 8).map((i) => ({ name: i.name, x: i.x, y: i.y, file: i.file })) : null })
  if (!Array.isArray(icons)) {
    // 降级路径：读不到图标 → 走到屏幕下沿随机位置「空叼一口」，演完照实回执 refused
    // （绝不假装得手：没碰文件就是没碰文件）
    await degradeIconPerf(ctx, budget)
    return { status: 'refused', reason: 'desktop-icons-unavailable' }
  }
  // 2) 选目标：params.icon 指名（服务端简报给的文件名）→ 必须存在且是普通文件；否则自己随机挑
  //    （2026-10-30 用户指定：没给名字就随机收/拖一个，每次都不一样）
  let icon
  const wanted = String(params.icon || '').trim()
  if (wanted) {
    const got = resolveIconTarget(icons, wanted)
    if (!got.icon) return { status: 'refused', reason: got.reason }
    icon = got.icon
  } else {
    icon = pickNormalIcon(icons)
    if (!icon) return { status: 'refused', reason: 'no-normal-icon' }
  }
  // 3) 走到图标旁（60px gap，复用 approach 的缓动移动；与甩抛互斥由 moveWindowTo 内部保证）
  const body = ctx.bodyRect()
  const area = typeof ctx.workArea === 'function' ? ctx.workArea() : null
  const target = iconApproachTarget(icon, body, undefined, area)
  if (!target) return { status: 'refused', reason: 'no-body' }
  if (ctx.debugLog) ctx.debugLog({ phase: 'target', icon: { name: icon.name, x: icon.x, y: icon.y, file: icon.file || '' }, target, body, area })
  const ok = await moveTo(target)
  if (budget.cancelled) return stop
  if (ctx.debugLog) ctx.debugLog({ phase: 'walked', ok, body: ctx.bodyRect() })
  if (!ok) return { status: 'failed', reason: 'move-interrupted' }
  await ctx.playAnimByName(ICON_ANIMS.grab) // 叼起（找不到素材静默）
  if (budget.cancelled) return stop
  // 4) 分支
  if (mode === 'drag') {
    // 拖到新位置放下（2026-10-30 用户指定：挪窝，不是原地抖一下）
    // 落点：AI 给了坐标就用，否则随机（离起点至少 DROP_MIN_DIST_PX）
    const drop = pickDropPoint(target, body, area, { x: params.x, y: params.y, minDist: THRESHOLDS.DROP_MIN_DIST_PX, rng: ctx.rng })
    if (!drop) return { status: 'refused', reason: 'no-area' }
    // 图标相对身体中心的**叼着偏移**（2026-10-30 四次修正）：不再原样保留「站位偏移」——
    // 左列图标会从右边绕位，dx 能到 -300，叼着走时图标拖在身后半米远，看着完全脱节。
    // 改成「挂嘴边」：水平夹进身体边缘内侧 16px，垂直保持图标原高度（夹进身体上半段）。
    const carryHalf = Math.max(8, Math.round(body.width / 2) - 16)
    const dx = Math.max(-carryHalf, Math.min(carryHalf, Math.round(Number(icon.x) - Number(target.x))))
    const dy = Math.max(-Math.round(body.height / 2), Math.min(0, Math.round(Number(icon.y) - Number(target.y))))
    const cell = THRESHOLDS.ICON_CELL_PX
    // 图标别忘了夹在屏幕内：先把「图标中心」夹进工作区，再换回左上角（moveDesktopIcon 收的是左上角）
    const center = clampBodyCenter(
      { x: drop.x + dx + cell / 2, y: drop.y + dy + cell / 2 },
      { width: cell, height: cell },
      area,
    ) || { x: drop.x + dx + cell / 2, y: drop.y + dy + cell / 2 }
    const dropIcon = { x: Math.round(center.x - cell / 2), y: Math.round(center.y - cell / 2) }
    let lastAt = 0
    let lastKey = ''
    let bridgeOk = true
    /** 每帧把图标搬到「身体中心 + 固定偏移」；60ms 节流（常驻助手几毫秒一条，但不值得每帧刷）。 */
    const follow = () => {
      if (!bridgeOk) return
      const b = ctx.bodyRect()
      if (!b) return
      const x = Math.round(b.x + b.width / 2 + dx)
      const y = Math.round(b.y + b.height / 2 + dy)
      const key = x + ',' + y
      const now = Date.now()
      if (key === lastKey || now - lastAt < 60) return
      lastKey = key
      lastAt = now
      Promise.resolve(ctx.moveDesktopIcon(icon.name, x, y))
        .then((good) => { if (good === false) bridgeOk = false })
        .catch(() => { bridgeOk = false })
    }
    let arrived = false
    try {
      arrived = await ctx.moveWindowTo(
        () => { if (budget.cancelled) return null; follow(); return drop },
        { stopPx: 6, maxMs: remainMs(budget), align: 'body', speed: THRESHOLDS.RUN_SPEED_PX_S },
      )
    } finally {
      // 没走到 / 被取消 / 中途抛错：图标必须回到原位（不能留一个卡在半路的桌面）
      if (!arrived) { try { await ctx.moveDesktopIcon(icon.name, icon.x, icon.y) } catch {} }
    }
    if (budget.cancelled) return stop
    if (!arrived) return { status: 'failed', reason: 'move-interrupted' }
    // 松口：图标落在新位置（这一步失败就如实回执「挪不动」，绝不假装成功）
    const put = await ctx.moveDesktopIcon(icon.name, dropIcon.x, dropIcon.y)
    if (ctx.debugLog) ctx.debugLog({ phase: 'drop', icon: icon.name, drop, dx, dy, dropIcon, put })
    if (put === false) return { status: 'refused', reason: 'icon-move-unavailable' }
    await ctx.playAnimByName(ICON_ANIMS.win) // 得逞
    return {
      status: 'played',
      reason: '',
      detail: `${icon.name} → ${drop.x},${drop.y}（${drop.source === 'ai' ? '按指令' : '随机'}）`,
    }
  }
  // hide_icon：POST /behavior/icon/act（契约：{ok, id?, name, originalPath?, reason?}，reason 是原因 code）
  // 注意发给服务端的必须是**磁盘文件名**：ListView 给的是显示名（`Trae CN`），服务端按 `<桌面>/Trae CN`
  // 去 stat 会 not-found —— main.js 在 annotate 阶段把命中的真实文件名记在 `file` 上。
  if (typeof ctx.iconAct !== 'function') return { status: 'refused', reason: 'no-act-bridge' }
  const actName = String(icon.file || icon.name)
  let res = null
  try {
    res = await ctx.iconAct({ mode: 'hide', icon: actName, playbackId: String(params.playbackId || ''), force: true })
  } catch { res = { ok: false, reason: 'act-error' } }
  if (ctx.debugLog) ctx.debugLog({ phase: 'act', icon: icon.name, actName, res })
  if (budget.cancelled) return stop
  if (res && res.ok === true) {
    // 图标由 Explorer 变更通知自己消失；播「得逞」
    await ctx.playAnimByName(ICON_ANIMS.win)
    return { status: 'played', reason: '' }
  }
  await ctx.playAnimByName(ICON_ANIMS.doubt) // 被安全闸拒绝：播疑惑/叹气
  return { status: 'refused', reason: iconReasonText(res && res.reason) || 'icon-act-rejected' }
}
function iconActionRun(mode, params, ctx) {
  return iconActionWithTimeout((budget) => iconActionChain(mode, params || {}, ctx, budget), ctx)
}

// ---------- 反应层纯判定函数（全部无副作用，node:test 可直接测） ----------

/** 点到矩形（身体盒）边缘的最近距离；点在盒内返回 0。 */
function distToBox(px, py, box) {
  if (!box) return Infinity
  const dx = Math.max(box.x - px, 0, px - box.x - box.width)
  const dy = Math.max(box.y - py, 0, py - box.y - box.height)
  return Math.hypot(dx, dy)
}

/** 鼠标样本是否在身体盒内。 */
function inBox(px, py, box) {
  return box && px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height
}

/** 勾引判定：窗口内、身体盒附近的样本中，统计「高速折返」次数（速度方向反转）≥ 阈值。
 *  samples：[{x,y,t}] 按时间升序（约 400ms 一个）。 */
function isTeasing(samples, box, now, opts) {
  const o = { ...THRESHOLDS, ...(opts || {}) }
  const win = (samples || []).filter((s) => s && now - s.t <= o.TEASE_WINDOW_MS && distToBox(s.x, s.y, box) < o.TEASE_NEAR_PX)
  if (win.length < o.TEASE_MIN_REVERSALS + 1) return false
  let reversals = 0
  // 主轴折返：以水平为主（勾引多半左右晃）；相邻位移同号才累速度，异号且够快记一次折返
  let prevVx = 0
  for (let i = 1; i < win.length; i++) {
    const dt = Math.max(1, win[i].t - win[i - 1].t)
    const vx = (win[i].x - win[i - 1].x) / dt * 1000 // px/s
    if (prevVx !== 0 && vx !== 0 && Math.sign(vx) !== Math.sign(prevVx)) {
      const speed = Math.max(Math.abs(vx), Math.abs(prevVx))
      if (speed >= o.TEASE_MIN_SPEED) reversals++
    }
    if (vx !== 0) prevVx = vx
  }
  return reversals >= o.TEASE_MIN_REVERSALS
}

/** 摸摸判定：最近 dwell 窗口内的样本全部落在身体盒内、累计时长 ≥ dwellMs、抖动 ≤ jitterPx。 */
function isPatting(samples, box, now, opts) {
  const o = { ...THRESHOLDS, ...(opts || {}) }
  const recent = (samples || []).filter((s) => s && now - s.t <= o.PAT_DWELL_MS)
  if (recent.length < 2) return false
  const span = now - recent[0].t
  if (span < o.PAT_DWELL_MS) return false
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const s of recent) {
    if (!inBox(s.x, s.y, box)) return false // 中途出去了：不算持续摸
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x)
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y)
  }
  return (maxX - minX) <= o.PAT_JITTER_PX && (maxY - minY) <= o.PAT_JITTER_PX
}

/** 鼠标闲置判定：鼠标 lastMoveAt 之后一直没动 ≥ minutes 分钟。 */
function isCursorIdle(lastMoveAt, now, minutes) {
  const m = Number(minutes)
  if (!(m > 0)) return false
  return typeof lastMoveAt === 'number' && now - lastMoveAt >= m * 60_000
}

/** 反应冷却：距上次同类反应 ≥ cooldownMs 才允许再次触发。 */
function canReact(lastAt, now, cooldownMs) {
  const cd = cooldownMs == null ? THRESHOLDS.REACTION_COOLDOWN_MS : cooldownMs
  if (typeof lastAt !== 'number') return true
  return now - lastAt >= cd
}

/** 一步该走到哪（纯函数，moveWindowTo 每帧调）：从 from 朝 to 走 speed*dt，最多走完。
 *  为什么要它：老实现是「每帧走剩余距离的 1/4」——屏幕上横跨 1600px 时第一帧就跳 400px，
 *  实测就是「瞬移」。改成匀速后，长距离是看得出的「走」，短距离自然收尾。
 *  speedPxS：像素/秒；dtMs：这一帧过了多少毫秒（调用方负责夹上限，防卡顿后跳大步）。 */
function stepToward(from, to, speedPxS, dtMs) {
  const dx = Number(to.x) - Number(from.x)
  const dy = Number(to.y) - Number(from.y)
  const dist = Math.hypot(dx, dy)
  if (!(dist > 0)) return { x: Number(to.x), y: Number(to.y), dist: 0, step: 0 }
  const stepLen = Math.min(dist, Math.max(0, Number(speedPxS) || 0) * Math.max(0, Number(dtMs) || 0) / 1000)
  return { x: Number(from.x) + dx / dist * stepLen, y: Number(from.y) + dy / dist * stepLen, dist, step: stepLen }
}

/** wander 目标（纯函数）：在 area 内随机挑一个离 from 足够远的点（≥ 半屏），方便单测。
 *  area：{x,y,width,height}；rng：可选随机源（测试注入确定值）。 */
function pickWanderTarget(area, from, rng) {
  const rand = rng || Math.random
  if (!area || !(area.width > 0) || !(area.height > 0)) return null
  const minDist = Math.max(area.width, area.height) / 2
  for (let i = 0; i < 24; i++) {
    const x = area.x + rand() * area.width
    const y = area.y + rand() * area.height
    if (Math.hypot(x - from.x, y - from.y) >= minDist) return { x: Math.round(x), y: Math.round(y) }
  }
  // 随机 24 次都不够远（极端小屏）：退化为对角
  return { x: Math.round(area.x + area.width - from.x + area.x), y: Math.round(area.y + area.height - from.y + area.y) }
}

module.exports = { ACTIONS, THRESHOLDS, execute, stepToward, distToBox, inBox, isTeasing, isPatting, isCursorIdle, canReact, pickWanderTarget, pickDropPoint, clampBodyCenter, bodyOf, ICON_ANIMS, ICON_REASON_TEXT, iconReasonText, filterNormalIcons, isNormalIcon, pickNormalIcon, resolveIconTarget, iconKey, iconApproachTarget, iconCandidatePaths, matchIconByName, WINDOW_ANIMS, pickWindowTarget, windowCornerTarget, windowPushPlan, parseWhitelist }
