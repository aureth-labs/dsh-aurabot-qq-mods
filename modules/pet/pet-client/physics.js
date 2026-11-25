// Aurabot 桌宠拖拽物理（纯逻辑，零依赖）—— 从 dsh-pet（MIT License，
// https://github.com/PC2005-cloud/dsh-pet 的 src/shared/physics/{spring,throw,release,squash,constants}.ts）
// 去 TypeScript 化移植的单文件版；只保留单屏场景用得上的部分：
//   · springStep / softClampSpeed   跟手弹簧与软钳速
//   · throwBounds / throwStep       抛掷边界与「重力积分 + 地面/侧壁反弹」单步积分
//   · estimateReleaseVelocity / trimTrail   拖拽轨迹 → 松手初速
//   · landingSquash / squashScale   落地挤压幅度与 Q 弹曲线
// 本文件是模板/生成物（由 pet 模块 POST /client/install 拷进数据目录）。
// UMD：Electron 主进程 require('./physics.js')、渲染页 <script> 与 node:test 都能用。
// 形象/动画素材的许可与代码无关（dsh-pet 代码 MIT；宠物形象素材 CC BY-NC-SA 4.0，用户自备）。
// 完整第三方署名见仓库根 THIRD-PARTY-NOTICES.md。
;(function (global) {
  'use strict'

  // ---- 常量（与 dsh-pet src/shared/physics/constants.ts 一致的默认值；可被 pack 配置 physics 段覆盖） ----
  var SPRING_K = 200            // 拖拽弹簧刚度
  var SPRING_C = 30             // 拖拽弹簧阻尼（过阻尼，不 overshoot）
  var TRAIL_KEEP_MS = 200       // 拖拽轨迹保留窗口
  var RELEASE_WINDOW_MS = 150   // 初速估算窗口
  var RELEASE_STALE_MS = 150    // 松手前停顿超过它 = 温柔放下
  var MIN_SPAN_MS = 20          // 窗口太短视为不可估算
  var SEG_MIN_DT_MS = 8         // 分段速度的最小 dt（防高回报率鼠标抖动放大）
  var DEAD_ZONE_SPEED = 500     // 低于此速度不抛（原地放下）
  var MAX_THROW_SPEED = 3600    // 甩出速度软上限
  var PEAK_WEIGHT = 0.5         // 端点均值与窗口峰值的加权
  var ACCEL_REF = 8000          // 参考加速度
  var ACCEL_GAIN_MAX = 0.6      // 加速度增益上限
  var REST_VY = 40              // 落地 |vy| 小于它直接停竖直
  var REST_VX = 15              // 地面 |vx| 小于它认为已静止
  var MAX_STEP_DT = 0.05        // 单步最大 dt（防巨帧跳变）
  var SQ_SQUASH = 0.55          // 默认下压幅度
  var SQ_SOFT_SPEED = 300       // 轻落基准
  var SQ_HARD_SPEED = 1500      // 重砸上限
  var SQ_MAX_SQUASH = 0.55      // 最大下压幅度
  var THROW_SPEED_ANCHOR = 1200 // power=1 的参考初速
  var SUBSTEP_PX = 8            // 单步最大位移（超过拆步）
  var SUBSTEP_MAX = 64          // 单帧最多拆几步
  var DEFAULT_THROW_POWER = 1

  var DEFAULT_PHYSICS = {
    gravity: 1400,        // 重力 px/s²
    restitution: 0.78,    // 碰边恢复系数
    groundFriction: 2.5,  // 地面水平摩擦 /s
    ceilingBounce: true,  // 顶部要不要弹
    throwPower: 1,        // 总力度（K/C 与初速同乘）
    petCollision: true,   // 多只桌宠互撞（collide.ts 移植）
  }

  // ---- collide.ts（宠物之间的碰撞：包围盒换算、重叠判定与一次弹性分离）----
  // 不做多体求解，也不改渲染；只回答「撞没撞、撞后速度多少」。
  // 必须始终成立：只算一次分离，不迭代求解。
  var PET_BOUNCE_E = 0.995      // 多宠物碰撞恢复系数：能量损失约 0.5%，接近完全弹性
  /** 身体包围盒（命中框比例换算到像素）：碰撞相交检测的几何。
   *  box = 宠物包围盒左上角；bottomPad = 舞台脚底垫高。
   *  hitBox 是素材 640×360 里的命中框 {x0,y0,x1,y1}，缺省用整幅。
   *  注意 x/y/size 必须同系：dsh-pet 的窗口 = 宠物包围盒，直接传窗口坐标；
   *  Aurabot 窗口比舞台大一圈，调用方要先把坐标平移到舞台左上角、size 传舞台宽。 */
  function bodyPixelBox(o) {
    var hb = o.hitBox || { x0: 0, y0: 0, x1: 640, y1: 360 }
    var h = (o.size * 9) / 16
    var pad = o.bottomPad || 0
    return {
      left: o.x + (hb.x0 / 640) * o.size,
      top: o.y + pad + (hb.y0 / 360) * h,
      right: o.x + (hb.x1 / 640) * o.size,
      bottom: o.y + pad + (hb.y1 / 360) * h,
    }
  }
  /** 两矩形是否相交。 */
  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  }
  /** 飞行中的宠物撞到另一只：近乎弹性碰撞（动量守恒 + 恢复系数 0.995），质量 ∝ size²。
   *  法向 = 两包围盒中心连线，法向速度按一维动量公式重分配，切向分量各自保留（无切向摩擦）。
   *  返回 null = 中心重合定不出法向，或两者正在分离（避免重叠帧反复弹跳抖动）。
   *  impactSpeed 是法向相对速度，供挤压强度换算。 */
  function collidePet(fly, hit) {
    var hf = ((fly.size * 9) / 16) / 2
    var hh = ((hit.size * 9) / 16) / 2
    var cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2)
    var cy = hit.y + hh - (fly.y + hf)
    var dist = Math.sqrt(cx * cx + cy * cy)
    if (dist < 1e-6) return null        // 中心重合：无法定碰撞法向，跳过本帧
    var nx = cx / dist
    var ny = cy / dist
    // 相对速度在法向的投影（碰撞方向 = fly → hit，正 = 正在接近）
    var vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny
    if (vrel <= 0) return null          // 正在分离：不再弹（避免重叠帧反复触发）
    var e = PET_BOUNCE_E
    var m1 = fly.size * fly.size
    var m2 = hit.size * hit.size
    var v1n = fly.vx * nx + fly.vy * ny
    var v2n = hit.vx * nx + hit.vy * ny
    var v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2)
    var v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2)
    // 组合：切向分量（原速度 − 法向分量）不变 + 新法向分量
    return {
      fvx: fly.vx - v1n * nx + v1n2 * nx,
      fvy: fly.vy - v1n * ny + v1n2 * ny,
      hvx: hit.vx - v2n * nx + v2n2 * nx,
      hvy: hit.vy - v2n * ny + v2n2 * ny,
      impactSpeed: vrel,
    }
  }
  /** 两个身体框重叠时的最短推出位移：只算几何、不碰速度。
   *  速度交换在两者正在分离时返回 null，光靠它会让已经插在一起的两只直接穿过去；
   *  补这一个纯位移量才能把它们推开。返回推 a 离 b 的位移（各让一半）；不重叠时返回 null。 */
  function overlapPush(a, b) {
    var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    if (ox <= 0 || oy <= 0) return null
    var alongX = ox <= oy
    var sign = alongX
      ? ((a.left + a.right) / 2 >= (b.left + b.right) / 2 ? 1 : -1)
      : ((a.top + a.bottom) / 2 >= (b.top + b.bottom) / 2 ? 1 : -1)
    return alongX ? { dx: (sign * ox) / 2, dy: 0 } : { dx: 0, dy: (sign * oy) / 2 }
  }

  // ---- spring.ts ----
  /** 过阻尼弹簧单轴速度步进：调用方随后 x += v*dt。 */
  function springStep(v, x, target, dt, power) {
    var p = power == null ? DEFAULT_THROW_POWER : power
    return v + ((target - x) * SPRING_K - v * SPRING_C) * p * dt
  }
  /** 软钳速：cap×(1-e^(-s/cap))，任意速度下单调可区分、渐近不超过 cap。 */
  function softClampSpeed(speed) {
    if (speed <= 0) return 0
    return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED))
  }

  // ---- contact.ts（接触面求解：法向反弹 + 切向摩擦） ----
  // 从 dsh-pet 的 shared/physics/contact.ts 移植。法向统一约定为「指向离开接触面的一侧」，
  // 四条边因此共用同一套公式，只算速度，位置夹回仍由 throwStep 负责。
  var REST_NORMAL = 40       // 法向速度低于它直接贴住（否则重力每帧反弹一次 = 贴面抖动）
  var REST_TANGENT = 15      // 切向速度低于它认为已静止
  var REST_NORMAL_EPS = 1    // 判「已经贴住」时法向的容差（比 REST_NORMAL 严得多）
  var CONTACT_NORMALS = {
    left: { nx: 1, ny: 0 },
    right: { nx: -1, ny: 0 },
    ceiling: { nx: 0, ny: 1 },
    floor: { nx: 0, ny: -1 },
  }
  /** 求一次接触后的速度：法向按恢复系数反弹（低于阈值归零），切向只按摩擦衰减。
   *  返回 {vx,vy,normalSpeed,tangentSpeed}；后两项供 isRestingOnContacts 判静止。 */
  function resolveContact(speed, edge, physics, dt) {
    var ph = physics || DEFAULT_PHYSICS
    var n = CONTACT_NORMALS[edge]
    var tx = -n.ny
    var ty = n.nx
    var vn = speed.vx * n.nx + speed.vy * n.ny
    var vt = speed.vx * tx + speed.vy * ty
    // 法向低于阈值就归零：否则重力持续压向同一面时每帧都被反弹回去，表现为贴面抖动。
    var normalSpeed = Math.abs(vn) < REST_NORMAL ? 0 : Math.abs(vn) * ph.restitution
    // 切向只衰减、不改方向：撞墙时它是 vy，落地与撞顶时它是 vx。
    var tangentSpeed = vt * Math.max(0, 1 - ph.groundFriction * dt)
    return {
      vx: normalSpeed * n.nx + tangentSpeed * tx,
      vy: normalSpeed * n.ny + tangentSpeed * ty,
      normalSpeed: normalSpeed,
      tangentSpeed: tangentSpeed,
    }
  }
  /** 本步接触是否都已静止：每个接触面的法向≈0 且切向低于阈值。 */
  function isRestingOnContacts(edges, speed) {
    if (!edges || edges.length === 0) return false
    for (var i = 0; i < edges.length; i++) {
      var n = CONTACT_NORMALS[edges[i]]
      var normal = Math.abs(speed.vx * n.nx + speed.vy * n.ny)
      var tangent = Math.abs(speed.vx * -n.ny + speed.vy * n.nx)
      if (!(normal < REST_NORMAL_EPS && tangent < REST_TANGENT)) return false
    }
    return true
  }

  // ---- 逐屏 AABB（多显示器） ----
  // dsh-pet 的关键教训：**每块屏一套 AABB，而不是整个桌面一个大 AABB**。
  // 不规则多屏布局下外接矩形含空洞，用它当边界会让桌宠飞进不可见区域。
  var rectRight = function (r) { return r.x + r.width }
  var rectBottom = function (r) { return r.y + r.height }
  /** 点落在哪块矩形里：返回下标，都不在返回 -1。 */
  function indexAtPoint(rects, px, py) {
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i]
      if (px >= r.x && px < rectRight(r) && py >= r.y && py < rectBottom(r)) return i
    }
    return -1
  }
  /** 离哪个矩形中心最近（落在空洞里时用）。 */
  function nearestIndex(rects, px, py) {
    var best = -1, bestD = Infinity
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i]
      var dx = px - (r.x + r.width / 2)
      var dy = py - (r.y + r.height / 2)
      var d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }
  /** 由工作区列表构造抛掷空间。
   *  边界一律按**可见身体盒**算（不是整个窗口）：贴底 = 身体底边落在工作区底边，
   *  贴左/右 = 身体左右缘可以越出屏幕 `allow` 像素（dsh-pet 的 sideAllow 语义）。
   *
   *  2026-11-05 修不对称：以前 minX 用 `a.x - offX - allow`、maxX 用
   *  `rectRight(a) - winW + allow`，而 winW 里已经含了 offX、bodyW 和右边距 20。
   *  结果左边能出屏 allow=37px、右边只能出屏 37-20=17px —— 拖到右边会比左边早停，
   *  在 2.5K 屏上肉眼能看到「右边贴不住、左边贴得住」。
   *  现在两边都按 `身体缘 ∓ allow` 对称算，与 throwBounds（单屏版）同一套公式。
   *
   *  纵向仍按**窗口整体**：窗口底边贴工作区底边。因为窗口在舞台下方还有 16px 底距，
   *  把 bottomGap 掺进 maxY 会让窗口底部伸进任务栏，看起来就是「越过屏幕底」。
   *
   *  2026-11-05 二次改（跟进 dsh-pet 新版的 reachInset）：允许量改成**左右分开**。
   *  旧版只有一个 sideAllow，暗含「身体居中」的假设；dsh-pet 新版按命中区与可见下限
   *  （MIN_REACHABLE_PX）分别算左右，命中区不居中时也不会算错。单值 sideAllow 仍然兼容
   *  （左右都用它），老调用与单测不用改。 */
  function throwSpace(o) {
    var areas = o.areas || []
    var panels = (o.panels && o.panels.length === areas.length) ? o.panels : areas
    var offX = o.offsetX || 0
    var offY = o.offsetY || 0
    var bodyW = o.bodyW
    var bodyH = o.bodyH
    var allowBoth = o.sideAllow || 0
    var allowL = o.reachLeft == null ? allowBoth : o.reachLeft
    var allowR = o.reachRight == null ? allowBoth : o.reachRight
    var allow = Math.max(allowL, allowR)
    var winW = o.winW || (offX + bodyW)
    var winH = o.winH || (offY + bodyH)
    var bounds = areas.map(function (a) {
      // 身体右缘相对窗口左缘的偏移 = offX + bodyW
      var bodyRight = offX + bodyW
      return {
        // 窗口左上角的允许范围。身体左缘 = x + offX，允许它到 a.x - allowL
        minX: a.x - offX - allowL,
        minY: a.y,
        // 身体右缘 = x + bodyRight，允许它到 屏右 + allowR
        maxX: rectRight(a) - bodyRight + allowR,
        maxY: rectBottom(a) - winH,
      }
    })
    return {
      bounds: bounds, areas: areas, panels: panels,
      bodyW: bodyW, bodyH: bodyH, offsetX: offX, offsetY: offY,
      winW: winW, winH: winH, sideAllow: allow,
    }
  }
  /** 身体中心落在哪块屏；在空洞里取最近的。 */
  function screenOfBox(space, x, y) {
    var cx = x + space.offsetX + space.bodyW / 2
    var cy = y + space.offsetY + space.bodyH / 2
    var hit = indexAtPoint(space.areas, cx, cy)
    return hit >= 0 ? hit : nearestIndex(space.areas, cx, cy)
  }
  /** 多屏抛掷步进：边界取自身体中心所在屏，越界后先问越界侧有没有别的屏——
   *  有就原样放行（自然跨屏飞行），没有才按该边反弹。
   *  探测用完整面板 panels 而不是 workArea：任务栏位于屏缝时 workArea 之间会空出一条带，
   *  按工作区探测会把接缝当墙，桌宠永远穿不过去。
   *  返回 {x,y,vx,vy,screen,bounced,atRest,hit,contacts}。 */
  function throwStepRegion(s, dtRaw, space, physics, lockScreen, gravity) {
    var ph = physics || DEFAULT_PHYSICS
    var dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT)
    var gx = gravity && gravity.gx != null ? gravity.gx : 0
    var gy = gravity && gravity.gy != null ? gravity.gy : ph.gravity
    var x = s.x, y = s.y, vx = s.vx, vy = s.vy
    vx += gx * dt
    vy += gy * dt
    x += vx * dt
    y += vy * dt
    if (!space.areas.length) return { x: x, y: y, vx: vx, vy: vy, screen: -1, bounced: false, atRest: false, hit: null, contacts: [] }
    var bounced = false
    var hit = null
    var contacts = []
    var record = function (edge, speed) {
      contacts.push(edge)
      if (hit === null || speed > hit.speed) hit = { edge: edge, speed: speed }
    }
    var locked = typeof lockScreen === 'number' && lockScreen >= 0 && lockScreen < space.areas.length
    var pick = function (i) { return locked ? lockScreen : i }

    // ---- 横向 ----
    var cur = screenOfBox(space, x, y)
    var bi = pick(cur)
    var b = space.bounds[bi]
    var pa = space.panels[bi] || space.areas[bi]
    var cy = y + space.offsetY + space.bodyH / 2
    if (x < b.minX) {
      if (locked || indexAtPoint(space.panels, pa.x - 1, cy) < 0) {
        record('left', Math.abs(vx))
        x = b.minX
        var oL = resolveContact({ vx: vx, vy: vy }, 'left', ph, dt)
        vx = oL.vx; vy = oL.vy
        bounced = true
      }
    } else if (x > b.maxX) {
      if (locked || indexAtPoint(space.panels, rectRight(pa), cy) < 0) {
        record('right', Math.abs(vx))
        x = b.maxX
        var oR = resolveContact({ vx: vx, vy: vy }, 'right', ph, dt)
        vx = oR.vx; vy = oR.vy
        bounced = true
      }
    }

    // ---- 纵向（横向若被夹回，身体中心可能已换屏，重新定位）----
    cur = screenOfBox(space, x, y)
    bi = pick(cur)
    b = space.bounds[bi]
    pa = space.panels[bi] || space.areas[bi]
    var cx = x + space.offsetX + space.bodyW / 2
    if (y < b.minY) {
      // ceilingBounce=false：顶部无边界，不夹不弹——飞出去靠重力落回
      if (ph.ceilingBounce && (locked || indexAtPoint(space.panels, cx, pa.y - 1) < 0)) {
        record('ceiling', Math.abs(vy))
        y = b.minY
        var oC = resolveContact({ vx: vx, vy: vy }, 'ceiling', ph, dt)
        vx = oC.vx; vy = oC.vy
        bounced = true
      }
    } else if (y >= b.maxY) {
      // 下方还有一块屏（上下排布的桌面）⇒ 不当地面，继续往下掉
      if (locked || indexAtPoint(space.panels, cx, rectBottom(pa)) < 0) {
        record('floor', Math.abs(vy))
        y = b.maxY
        var oF = resolveContact({ vx: vx, vy: vy }, 'floor', ph, dt)
        vx = oF.vx; vy = oF.vy
        bounced = true
      }
    }

    cur = pick(screenOfBox(space, x, y))
    return {
      x: x, y: y, vx: vx, vy: vy,
      screen: cur, bounced: bounced,
      atRest: isRestingOnContacts(contacts, { vx: vx, vy: vy }),
      hit: hit, contacts: contacts,
    }
  }

  // ---- 点击穿透兜底判定（pointer-target.ts 移植） ----
  // dsh-pet 的核心教训：窗口默认整窗穿透，常规链路只有 Electron 的 forward 鼠标钩子一个入口，
  // 而**该钩子在 Windows 上会静默失效**——失效后悬浮、拖拽、点击与右键全无反应。
  // 所以主进程必须自己轮询光标位置做兜底判定，不能只依赖渲染页上报。
  var POINTER_POLL_MS = 60        // 光标轮询间隔
  var OFF_BODY_RELEASE_MS = 400   // 光标停在窗口余量区的最长保持时间，超过即恢复穿透
  /** 光标相对窗口的分区：'outside' | 'body' | 'margin'。
   *  bodyRect 是宠物身体在**屏幕坐标**下的矩形（由主进程算好传进来）。 */
  function pointerZone(bounds, point, bodyRect) {
    var inWindow =
      point.x >= bounds.x && point.x < bounds.x + bounds.width &&
      point.y >= bounds.y && point.y < bounds.y + bounds.height
    if (!inWindow) return 'outside'
    if (!bodyRect) return 'margin'
    var inBody = point.x >= bodyRect.left && point.x <= bodyRect.right &&
      point.y >= bodyRect.top && point.y <= bodyRect.bottom
    return inBody ? 'body' : 'margin'
  }
  /** 该不该让窗口保持穿透（setIgnoreMouseEvents 的第一个参数）。
   *  busy 期间位置完全不参与：拖拽时宠物滞后于光标，按位置判定会断掉正在用的 pointermove/pointerup，
   *  表现为「拖到一半突然不动了」。 */
  function decideWindowIgnore(bounds, point, ignoring, busy, offBodyMs, bodyRect) {
    if (busy) return false // 拖拽租约：绝不因位置判定被打断
    var zone = pointerZone(bounds, point, bodyRect)
    if (zone === 'outside') return true   // 窗外：恢复穿透
    if (zone === 'body') return false     // 宠物身上：可交互
    if ((offBodyMs || 0) >= OFF_BODY_RELEASE_MS) return true // 余量区停留超时：恢复穿透
    return ignoring // 余量区：保持现状（菜单/弹窗由 busy 覆盖）
  }

  // ---- throw.ts ----
  /** 由屏幕区尺寸与宠物包围盒算抛掷边界（返回的是**窗口左上角**允许范围）。
   *  o: { W, H, size?, bodyW?, bodyH?, offsetX?, offsetY?, sideAllow? }
   *  · 只给 size 时按旧的 16:9 身体、贴窗口左上角（兼容老调用与单测）。
   *  · 真实场景要传 bodyW/bodyH（可见身体尺寸）与 offsetX/offsetY（身体左上角相对窗口左上角的偏移）：
   *    窗口是 280×340，宠物画在窗口底部，用窗口高当身体高会让静止点掉到屏幕外 183px。
   */
  function throwBounds(o) {
    var bodyW = o.bodyW == null ? o.size : o.bodyW
    var bodyH = o.bodyH == null ? (o.size * 9) / 16 : o.bodyH
    var offX = o.offsetX || 0
    var offY = o.offsetY || 0
    var allow = o.sideAllow || 0
    // 2026-11-07：新增 areaX/areaY（工作区左上角的屏幕绝对 DIP 坐标，缺省 0）。
    // 传了以后返回的边界就是**绝对坐标**（主进程甩抛每帧按当前窗口中心重算工作区时用），
    // 缺省 0 与旧口径（工作区相对坐标）完全一致，老测试不受影响。
    var areaX = o.areaX || 0
    var areaY = o.areaY || 0
    return {
      minX: areaX - offX - allow,
      minY: areaY - offY,
      maxX: areaX + o.W - offX - bodyW + allow,
      maxY: areaY + o.H - offY - bodyH,
    }
  }
  /** 把「身体矩形」夹回屏幕并集（主进程拖拽钳制 / 甩抛收尾 / 30s 逃生网共用，2026-11-07）。
   *  rect: {x,y,width,height}（可见身体矩形，绝对 DIP）；b: {x,y,w,h}（虚拟桌面 bounds 并集）。
   *  返回夹回后的 {x,y,width,height}（整数）：身体完整落在并集内；身体比屏幕还大时贴左/上边缘；
   *  非法输入（NaN/负尺寸）一律收敛成合法值，绝不产生 NaN。 */
  function clampBodyRect(rect, b) {
    var w = Math.max(1, Math.round(Number(rect && rect.width) || 1))
    var h = Math.max(1, Math.round(Number(rect && rect.height) || 1))
    var bx = Math.round(Number(b && b.x) || 0)
    var by = Math.round(Number(b && b.y) || 0)
    var bw = Math.max(w, Math.round(Number(b && b.w) || w))
    var bh = Math.max(h, Math.round(Number(b && b.h) || h))
    var x = Number(rect && rect.x)
    var y = Number(rect && rect.y)
    if (!Number.isFinite(x)) x = bx
    if (!Number.isFinite(y)) y = by
    return {
      x: Math.round(Math.min(Math.max(x, bx), bx + bw - w)),
      y: Math.round(Math.min(Math.max(y, by), by + bh - h)),
      width: w,
      height: h,
    }
  }
  /** 抛体单步积分与边界反弹。返回 {x,y,vx,vy,bounced,atRest,hit,contacts}。
   *  反弹走 contact.ts 的**法向/切向分解**（法向按恢复系数弹、切向按摩擦衰减），
   *  而不是旧实现的「按轴翻转 vx/vy」——旧写法撞墙时把竖直速度也一起抹掉，
   *  斜着撞墙会突然垂直下坠，手感很怪。 */
  function throwStep(s, dtRaw, b, physics) {
    var ph = physics || DEFAULT_PHYSICS
    var dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT)
    var x = s.x, y = s.y, vx = s.vx, vy = s.vy
    vy += ph.gravity * dt
    x += vx * dt
    y += vy * dt
    var bounced = false
    var hit = null
    var contacts = []
    var record = function (edge, speed) {
      contacts.push(edge)
      // 同一步撞到两条边（角落）时 hit 留更重的那个，手感只按主撞击算
      if (hit === null || speed > hit.speed) hit = { edge: edge, speed: speed }
    }
    if (x < b.minX) {
      record('left', Math.abs(vx)); x = b.minX
      var oL = resolveContact({ vx: vx, vy: vy }, 'left', ph, dt); vx = oL.vx; vy = oL.vy
      bounced = true
    } else if (x > b.maxX) {
      record('right', Math.abs(vx)); x = b.maxX
      var oR = resolveContact({ vx: vx, vy: vy }, 'right', ph, dt); vx = oR.vx; vy = oR.vy
      bounced = true
    }
    if (y < b.minY) {
      // ceilingBounce=false：顶部无边界，不夹不弹——飞出去靠重力落回（y 保持越界）
      if (ph.ceilingBounce) {
        record('ceiling', Math.abs(vy)); y = b.minY
        var oC = resolveContact({ vx: vx, vy: vy }, 'ceiling', ph, dt); vx = oC.vx; vy = oC.vy
        bounced = true
      }
    } else if (y >= b.maxY) {
      record('floor', Math.abs(vy)); y = b.maxY
      var oF = resolveContact({ vx: vx, vy: vy }, 'floor', ph, dt); vx = oF.vx; vy = oF.vy
      bounced = true
    }
    // 静止判定：所有接触面都贴住且切向低速（contact.ts 同口径）。
    // 旧实现只看「贴近地面 + |vy|<1」，会在半空蹭墙后误判静止 → 桌宠悬空卡死。
    var atRest = isRestingOnContacts(contacts, { vx: vx, vy: vy })
    if (atRest) { vx = 0; vy = 0 }
    return { x: x, y: y, vx: vx, vy: vy, bounced: bounced, atRest: atRest, hit: hit, contacts: contacts }
  }
  /** 一帧该积几步（整数 ≥ 1）：位移超过 SUBSTEP_PX 就拆步，防跳过落地/反弹帧。 */
  function throwSubsteps(vx, vy, dt) {
    var travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT)
    if (!(travel > SUBSTEP_PX)) return 1
    return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX))
  }

  // ---- release.ts ----
  /** 剔除保留窗口外的旧采样。 */
  function trimTrail(trail, now) {
    var cutoff = now - TRAIL_KEEP_MS
    var i = 0
    while (i < trail.length && trail[i].t < cutoff) i++
    return i === 0 ? trail : trail.slice(i)
  }
  /** 由拖拽轨迹估算松手初速 {vx,vy} px/s；返回 null = 温柔放下（不抛）。 */
  function estimateReleaseVelocity(trail, now, physics) {
    var ph = physics || DEFAULT_PHYSICS
    if (!trail || trail.length === 0) return null
    var last = trail[trail.length - 1]
    if (now - last.t > RELEASE_STALE_MS) return null
    var win = trail.filter(function (s) { return now - s.t <= RELEASE_WINDOW_MS })
    if (win.length < 2) return null
    var t0 = win[0].t, x0 = win[0].x, y0 = win[0].y
    var t1 = win[win.length - 1].t, x1 = win[win.length - 1].x, y1 = win[win.length - 1].y
    var spanMs = t1 - t0
    if (spanMs < MIN_SPAN_MS) return null
    var baseVx = ((x1 - x0) / spanMs) * 1000
    var baseVy = ((y1 - y0) / spanMs) * 1000
    var baseSpeed = Math.hypot(baseVx, baseVy)
    if (baseSpeed < 1e-6) return null
    var segSpeeds = []
    var px = x0, py = y0, pt = t0
    for (var i = 1; i < win.length; i++) {
      var s = win[i]
      var dt = s.t - pt
      if (dt >= SEG_MIN_DT_MS) {
        segSpeeds.push({ speed: (Math.hypot(s.x - px, s.y - py) / dt) * 1000, tEnd: s.t })
        px = s.x; py = s.y; pt = s.t
      }
    }
    var peakSpeed = segSpeeds.length ? Math.max.apply(null, segSpeeds.map(function (v) { return v.speed })) : baseSpeed
    var accel = 0
    if (segSpeeds.length >= 2) {
      var lastSeg = segSpeeds[segSpeeds.length - 1]
      var firstSeg = segSpeeds[0]
      accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000)
    }
    var speedBeforeClamp =
      ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) *
      (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX)
    var speed = softClampSpeed(speedBeforeClamp) * (ph.throwPower == null ? 1 : ph.throwPower)
    if (speed < DEAD_ZONE_SPEED) return null
    return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed }
  }

  // ---- squash.ts ----
  /** 落地冲击速度 → 下压幅度（速度越大压得越狠）。 */
  function landingSquash(impactSpeed) {
    var t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1)
    return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH))
  }
  /** Q 弹挤压曲线：u∈[0,1] 进度 → scaleY（下压段 ease-in，回弹段 easeOutBack 约 4% 过冲）。 */
  function squashScale(u, squash) {
    var sq = squash == null ? SQ_SQUASH : squash
    if (u < 0.45) {
      var p = u / 0.45
      return 1 - (1 - sq) * p * p
    }
    var p2 = (u - 0.45) / 0.55
    var c1 = 1.70158
    var c3 = c1 + 1
    var f = 1 + c3 * Math.pow(p2 - 1, 3) + c1 * Math.pow(p2 - 1, 2)
    return Math.min(1.12, sq + (1 - sq) * Math.max(f, 0))
  }

  var api = {
    // 常量（pack 配置可参考）
    DEFAULT_PHYSICS: DEFAULT_PHYSICS,
    DEFAULT_THROW_POWER: DEFAULT_THROW_POWER,
    THROW_SPEED_ANCHOR: THROW_SPEED_ANCHOR,
    SQ_SQUASH: SQ_SQUASH,
    SQ_DURATION_MS: 220,
    // 函数
    springStep: springStep,
    softClampSpeed: softClampSpeed,
    throwBounds: throwBounds,
    clampBodyRect: clampBodyRect,
    throwStep: throwStep,
    throwSubsteps: throwSubsteps,
    trimTrail: trimTrail,
    estimateReleaseVelocity: estimateReleaseVelocity,
    landingSquash: landingSquash,
    squashScale: squashScale,
    // ↓ 从 dsh-pet 补搬：接触面分解 / 逐屏边界 / 穿透兜底判定
    resolveContact: resolveContact,
    isRestingOnContacts: isRestingOnContacts,
    // ↓ collide.ts：宠物互撞
    bodyPixelBox: bodyPixelBox,
    rectsOverlap: rectsOverlap,
    collidePet: collidePet,
    overlapPush: overlapPush,
    PET_BOUNCE_E: PET_BOUNCE_E,
    throwSpace: throwSpace,
    throwStepRegion: throwStepRegion,
    screenOfBox: screenOfBox,
    indexAtPoint: indexAtPoint,
    nearestIndex: nearestIndex,
    pointerZone: pointerZone,
    decideWindowIgnore: decideWindowIgnore,
    POINTER_POLL_MS: POINTER_POLL_MS,
    OFF_BODY_RELEASE_MS: OFF_BODY_RELEASE_MS,
    REST_NORMAL: REST_NORMAL,
    REST_TANGENT: REST_TANGENT,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.PetPhysics = api
})(typeof window !== 'undefined' ? window : globalThis)
