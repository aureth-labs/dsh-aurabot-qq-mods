// Aurabot 桌宠台球规则引擎（纯逻辑，零依赖）——2026-11-12 补上「真正的台球规则」。
// 之前 arena.html / billiard.html 各写了一份「15 颗全进就算清台」的伪规则，这里换成
// WCA/WPA 黑球 8-ball 的可执行子集：开球 → 开放台面 → 定组（花色/全色）→ 合法击球判定
// → 犯规（空杆 / 先碰对方球 / 先碰 8 / 白球落袋 / 无进袋无碰库）→ 自由球 → 8 号定胜负。
// 刻意省略的细则（玩具桌用不上，且没有裁判）：指定袋、球飞出台面、故意犯规判负、
// 触球后必须 4 颗碰库的开球严格线（这里退化为「碰库或进袋其一」）。
// UMD：渲染页 <script> 与 node 测试都能用；页面只负责几何与事件上报，规则全在这。
;(function (global) {
  'use strict'

  var SOLID = 'solid'
  var STRIPE = 'stripe'
  var EIGHT = 8

  // 摩擦口径来自页面物理：v *= 0.988^(dt*60)。dv/dt = -λv 且 dx/dt = v ⇒ dv/dx = -λ，
  // 即球速随「行进距离」线性衰减，λ = 60·ln(1/0.988) ≈ 0.724 px/s 每 px。
  // 所以「要走完 d 像素」需要的初速就是 λ·d —— 引擎据此给 AI 定力度，不需要试错。
  var LAMBDA = 0.7243
  var MIN_SPEED = 360
  var MAX_SPEED = 2100
  var CUT_LIMIT = 0.3 // cosθ 下限：薄于 ~72° 的切球直接放弃（物理上几乎进不了）

  function groupOf(n) {
    if (n >= 1 && n <= 7) return SOLID
    if (n >= 9 && n <= 15) return STRIPE
    return null
  }
  function otherGroup(g) { return g === SOLID ? STRIPE : g === STRIPE ? SOLID : null }

  // ---- 建局 ----
  // opts.seats: ['你','宠物']；seat 0 永远是玩家操作位，seat 1 可以是宠物或第二个人。
  function createGame(opts) {
    var o = opts || {}
    return {
      seats: o.seats || ['你', '宠物'],
      turn: 0,
      open: true, // 尚未定组
      groups: [null, null],
      potted: {}, // n -> true（含 0：白球当前在袋，页面会立刻复位）
      shotNo: 0,
      isBreak: true,
      ballInHand: false,
      inHandBy: -1,
      over: false,
      winner: -1,
      reason: '',
      log: [],
      stats: [newSeat(), newSeat()],
      shot: null,
    }
  }
  function newSeat() { return { shots: 0, pots: 0, fouls: 0 } }

  // ---- 一杆的事件采集（页面在物理循环里回调） ----
  function beginShot(g) {
    g.shotNo++
    g.stats[g.turn].shots++
    g.shot = {
      no: g.shotNo,
      seat: g.turn,
      wasBreak: g.isBreak,
      openBefore: g.open,
      groupBefore: g.groups[g.turn],
      onEightBefore: isOnEight(g, g.turn),
      firstContact: null,
      railed: false,
      potted: [],
    }
    return g.shot
  }
  // 白球第一下碰到谁——只记第一次。
  function noteFirstContact(g, n) {
    var s = g.shot
    if (!s || s.firstContact !== null || n === 0 || n === undefined) return
    s.firstContact = n
  }
  // 碰库只在「第一接触之后」才算数（先撞库再撞球是犯规）。
  function noteRail(g) {
    var s = g.shot
    if (s && s.firstContact !== null) s.railed = true
  }
  function notePocket(g, n) {
    if (g.shot) g.shot.potted.push(n)
  }

  // 本座位还剩几颗自己的球；还没定组时按「一组 7 颗」算，避免误判成打 8。
  function remaining(g, seat) {
    var grp = g.groups[seat]
    if (!grp) return 7
    var c = 0
    for (var n = 1; n <= 15; n++) {
      if (n === EIGHT) continue
      if (groupOf(n) === grp && !g.potted[n]) c++
    }
    return c
  }
  function isOnEight(g, seat) {
    return !!g.groups[seat] && remaining(g, seat) === 0
  }
  // 当前座位合法能先碰的球号集合（空 = 该打 8）
  function legalTargets(g, seat) {
    if (isOnEight(g, seat)) return [EIGHT]
    if (g.open) {
      var out = []
      for (var n = 1; n <= 15; n++) if (n !== EIGHT && !g.potted[n]) out.push(n)
      return out
    }
    var grp = g.groups[seat], list = []
    for (var m = 1; m <= 15; m++) if (groupOf(m) === grp && !g.potted[m]) list.push(m)
    return list
  }

  // ---- 结算一杆 ----
  // ctx = { balls:[{n,x,y,alive}], R, holes, W, H, cueSpot, footSpot }
  function resolveShot(g, ctx) {
    var s = g.shot
    var out = {
      foul: null, // 犯规类型（给 UI 显示）
      legal: true,
      continues: false,
      turnChanged: false,
      over: false,
      winner: -1,
      reason: '',
      groupAssigned: null, // [seat, group]
      respot8: false,
      potted: s.potted.slice(),
      seat: s.seat,
    }
    var me = s.seat
    var other = 1 - me
    var scratch = s.potted.indexOf(0) >= 0
    var objs = []
    for (var i = 0; i < s.potted.length; i++) {
      var n = s.potted[i]
      if (n !== 0 && n !== EIGHT) objs.push(n)
    }
    var eightIn = s.potted.indexOf(EIGHT) >= 0

    // 落袋记账：白球不算丢（页面复位），彩球一律留在袋里（WPA：犯规打进的球也不复位）。
    for (var j = 0; j < s.potted.length; j++) {
      var pn = s.potted[j]
      if (pn !== 0) g.potted[pn] = true
    }

    // ---- 犯规判定（按「最先被观察到的一条」报给 UI） ----
    // 先接触顺序很关键：清完自己一组后，8 号反而成了唯一合法的第一接触目标。
    var foulReason = null, foulKind = null
    if (s.firstContact === null) { foulKind = 'air'; foulReason = '空杆：白球一颗球都没碰到' }
    else if (s.onEightBefore) {
      if (s.firstContact !== EIGHT) { foulKind = 'wrong-group'; foulReason = '该打 8 号了，却先碰到 ' + s.firstContact + ' 号' }
    } else if (s.firstContact === EIGHT && !s.wasBreak) {
      foulKind = 'eight-first'; foulReason = '先碰到 8 号（还没轮到打它）'
    } else if (!s.openBefore && s.groupBefore && groupOf(s.firstContact) !== s.groupBefore) {
      foulKind = 'wrong-group'; foulReason = '先碰到对方的球：' + s.firstContact + ' 号'
    }
    if (!foulKind && scratch) { foulKind = 'scratch'; foulReason = '白球落袋' }
    if (!foulKind && s.potted.length === 0 && !s.railed) { foulKind = 'no-rail'; foulReason = '既没进球，也没有球碰库' }

    // 开球放宽：玩具桌没有裁判数「4 颗球碰库」，碰到球堆 + （进袋或碰库）就算合法开球。
    if (s.wasBreak && s.firstContact !== null && foulKind === 'no-rail') { foulKind = null; foulReason = null }

    out.foul = foulKind
    out.legal = !foulKind
    if (foulKind) { g.stats[me].fouls++; out.reason = foulReason }

    // ---- 8 号落袋：直接定胜负（开球时除外，那算重摆） ----
    if (eightIn) {
      if (s.wasBreak) {
        out.respot8 = true
        delete g.potted[EIGHT]
      } else if (!s.onEightBefore) {
        return finish(g, out, other, '8 号提前落袋（' + (g.groups[me] ? '组内还有球没清完' : '台面还没定组') + '）')
      } else if (foulKind) {
        return finish(g, out, other, '打 8 号时犯规：' + foulReason)
      } else {
        return finish(g, out, me, '合法打进 8 号，清完自己一组')
      }
    }

    // ---- 定组 / 连续击球 ----
    if (s.wasBreak) {
      g.isBreak = false
      // 开球即使进球，台面依旧开放（WPA：开球进球不定组）
      if (foulKind) {
        g.ballInHand = true
        g.inHandBy = other
        g.turn = other
        out.turnChanged = true
      } else if (objs.length > 0) out.continues = true
      else { g.turn = other; out.turnChanged = true }
      return handoff(g, out)
    }

    if (foulKind) {
      g.ballInHand = true
      g.inHandBy = other
      g.turn = other
      out.turnChanged = true
      return handoff(g, out)
    }

    if (s.openBefore) {
      // 开放台面：第一次合法进袋 = 定组（按先落袋的那颗）
      if (objs.length > 0) {
        var grp = groupOf(objs[0])
        g.open = false
        g.groups[me] = grp
        g.groups[other] = otherGroup(grp)
        out.groupAssigned = [me, grp]
        out.continues = true
        for (var z = 0; z < objs.length; z++) if (groupOf(objs[z]) === grp) g.stats[me].pots++
      } else {
        out.turnChanged = true
        g.turn = other
      }
    } else {
      var mine = 0
      for (var k = 0; k < objs.length; k++) {
        if (groupOf(objs[k]) === g.groups[me]) { mine++; g.stats[me].pots++ }
        else if (groupOf(objs[k]) === g.groups[other]) g.stats[other].pots++ // 替对方清了一颗
      }
      if (mine > 0) out.continues = true // 进自己的球才续杆；只进对方的球算不进去，换手
      else { out.turnChanged = true; g.turn = other }
    }
    g.ballInHand = false
    return handoff(g, out)
  }

  function handoff(g, out) {
    g.shot = null
    out.ballInHand = g.ballInHand
    out.turn = g.turn
    g.log.push(outSummary(g, out))
    if (g.log.length > 40) g.log.shift()
    return out
  }
  function finish(g, out, winner, reason) {
    g.over = true
    g.winner = winner
    g.reason = reason
    out.over = true
    out.winner = winner
    out.reason = reason
    out.turnChanged = winner !== g.turn
    g.turn = winner
    g.ballInHand = false
    g.shot = null
    g.log.push(outSummary(g, out))
    return out
  }

  function outSummary(g, out) {
    var s = g.seats[out.seat] || ''
    if (out.over) return s + '：' + (g.seats[g.winner] || '') + '胜 · ' + out.reason
    if (out.foul) return s + '犯规（' + out.foul + '）→ ' + g.seats[1 - out.seat] + ' 自由球'
    if (out.groupAssigned) return s + '定为' + groupName(out.groupAssigned[1])
    return s + (out.continues ? '继续' : '未进球，换手')
  }
  function groupName(grp) { return grp === SOLID ? '全色（1-7）' : grp === STRIPE ? '花色（9-15）' : '未定' }

  // ---- 几何：供自由球摆放与 AI 选杆复用 ----
  function segPointDist(ax, ay, bx, by, px, py) {
    var dx = bx - ax, dy = by - ay
    var L = dx * dx + dy * dy
    if (L <= 0) return Math.hypot(px - ax, py - ay)
    var t = ((px - ax) * dx + (py - ay) * dy) / L
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
  }
  function aliveBalls(ctx, exclude) {
    var ex = exclude || []
    var out = []
    for (var i = 0; i < ctx.balls.length; i++) {
      var b = ctx.balls[i]
      if (!b.alive) continue
      if (ex.indexOf(b.n) >= 0) continue
      out.push(b)
    }
    return out
  }
  function inPlayArea(ctx, x, y) {
    var R = ctx.R
    if (x < R + 1 || x > ctx.W - R - 1 || y < R + 1 || y > ctx.H - R - 1) return false
    for (var i = 0; i < ctx.holes.length; i++) {
      var h = ctx.holes[i]
      if (Math.hypot(x - h.x, y - h.y) < h.r + R * 0.2) return false // 洞口里不能放
    }
    return true
  }
  function isLegalSpot(g, ctx, x, y) {
    if (!inPlayArea(ctx, x, y)) return false
    var list = aliveBalls(ctx, [0])
    for (var i = 0; i < list.length; i++) {
      if (Math.hypot(x - list[i].x, y - list[i].y) < ctx.R * 2 - 0.5) return false
    }
    return true
  }
  // 找最近的合法点：原位不合法时按半径由小到大、8 方向试探。
  function nearestLegalSpot(g, ctx, x, y) {
    if (isLegalSpot(g, ctx, x, y)) return { x: x, y: y }
    for (var r = ctx.R; r <= ctx.R * 14; r += ctx.R * 0.5) {
      for (var a = 0; a < 16; a++) {
        var ang = (a / 16) * Math.PI * 2
        var nx = x + Math.cos(ang) * r, ny = y + Math.sin(ang) * r
        if (isLegalSpot(g, ctx, nx, ny)) return { x: nx, y: ny }
      }
    }
    return { x: ctx.cueSpot.x, y: ctx.cueSpot.y }
  }
  function clearLine(ctx, ax, ay, bx, by, exclude) {
    var list = aliveBalls(ctx, exclude)
    var need = ctx.R * 2 - 0.5
    for (var i = 0; i < list.length; i++) {
      if (segPointDist(ax, ay, bx, by, list[i].x, list[i].y) < need) return false
    }
    return true
  }

  // 需要的初速：走完 d1（白球独自），再以足够分量把目标球送出 d2。
  // 切球角 θ：目标球只拿到 cue 速度的 cos 分量 ⇒ v_arrive = λ·d2'/cosθ。
  function requiredSpeed(ctx, d1, d2, cut) {
    var reach = Math.max(0, d2 - ctx.R * 0.8) // 进洞口有捕获半径，不用真走到洞心
    var c = Math.max(0.45, cut)
    var v = LAMBDA * (d1 + reach / c)
    return Math.max(MIN_SPEED, Math.min(MAX_SPEED, v * 1.28 + 260))
  }

  // ---- AI：为当前座位挑一杆 ----
  // 返回 { vx, vy, speed, target, pocket, ghost, score } 或 null（无好球 ⇒ safety）。
  function pickShot(g, ctx, opts) {
    var o = opts || {}
    var noise = o.noise === undefined ? 0.022 : o.noise
    var cue = findCue(ctx)
    if (!cue) return null
    var targets = legalTargets(g, g.turn)
    var balls = ctx.balls
    var best = null
    for (var ti = 0; ti < targets.length; ti++) {
      var t = findBall(balls, targets[ti])
      if (!t || !t.alive) continue
      for (var hi = 0; hi < ctx.holes.length; hi++) {
        var hole = ctx.holes[hi]
        var tx = hole.x - t.x, ty = hole.y - t.y
        var d2 = Math.hypot(tx, ty)
        if (d2 < 1) continue
        var ux = tx / d2, uy = ty / d2
        var gx = t.x - ux * ctx.R * 2, gy = t.y - uy * ctx.R * 2
        if (!inPlayArea(ctx, gx, gy)) continue
        var d1 = Math.hypot(gx - cue.x, gy - cue.y)
        if (d1 < 1) continue
        var cut = ((gx - cue.x) / d1) * ux + ((gy - cue.y) / d1) * uy
        if (cut < CUT_LIMIT) continue
        if (!clearLine(ctx, cue.x, cue.y, gx, gy, [0])) continue
        if (!clearLine(ctx, t.x, t.y, hole.x, hole.y, [0, t.n])) continue
        var score = cut * 1000 - d1 * 0.55 - d2 * 0.45 + (d2 < ctx.R * 8 ? 120 : 0)
        if (!best || score > best.score) {
          best = {
            score: score, target: t.n, pocket: hi, cut: cut, d1: d1, d2: d2,
            aimX: (gx - cue.x) / d1, aimY: (gy - cue.y) / d1,
            ghost: { x: gx, y: gy },
            speed: requiredSpeed(ctx, d1, d2, cut),
          }
        }
      }
    }
    if (!best) return safetyShot(g, ctx, cue, targets)
    // 加一点准头误差：宠物不该杆杆清台
    var ang = Math.atan2(best.aimY, best.aimX) + (Math.random() * 2 - 1) * noise
    best.vx = Math.cos(ang) * best.speed
    best.vy = Math.sin(ang) * best.speed
    best.noise = ang - Math.atan2(best.aimY, best.aimX)
    return best
  }
  // 没有可打的袋口线路：朝最近的合法目标轻轻碰一下，尽量满足「碰库」要求。
  function safetyShot(g, ctx, cue, targets) {
    var pick = null, pd = Infinity
    for (var i = 0; i < targets.length; i++) {
      var b = findBall(ctx.balls, targets[i])
      if (!b || !b.alive) continue
      var d = Math.hypot(b.x - cue.x, b.y - cue.y)
      if (d < pd) { pd = d; pick = b }
    }
    if (!pick) return null
    var ux = (pick.x - cue.x) / (pd || 1), uy = (pick.y - cue.y) / (pd || 1)
    var speed = requiredSpeed(ctx, pd, ctx.W * 0.4, 1)
    return {
      score: -1, target: pick.n, pocket: -1, cut: 1, d1: pd, d2: ctx.W * 0.4,
      aimX: ux, aimY: uy, ghost: { x: pick.x, y: pick.y }, speed: speed,
      vx: ux * speed, vy: uy * speed, safety: true,
    }
  }
  // 自由球时给 AI 挑一个最好摆位（粗网格 + 现有摆位）
  function bestCueSpot(g, ctx) {
    var base = { x: ctx.cueSpot.x, y: ctx.cueSpot.y }
    var bestScore = -Infinity, best = null
    var stepX = ctx.W / 18, stepY = ctx.H / 12
    for (var ix = 1; ix < 18; ix++) {
      for (var iy = 1; iy < 12; iy++) {
        var x = ix * stepX, y = iy * stepY
        if (!isLegalSpot(g, ctx, x, y)) continue
        var sc = spotScore(g, ctx, x, y)
        if (sc > bestScore) { bestScore = sc; best = { x: x, y: y, score: sc } }
      }
    }
    if (!best) return nearestLegalSpot(g, ctx, base.x, base.y)
    return best
  }
  function spotScore(g, ctx, x, y) {
    var cue = { n: 0, x: x, y: y, alive: true }
    var ctx2 = { balls: ctx.balls.map(function (b) { return b.n === 0 ? cue : b }), R: ctx.R, holes: ctx.holes, W: ctx.W, H: ctx.H, cueSpot: ctx.cueSpot, footSpot: ctx.footSpot }
    var targets = legalTargets(g, g.turn)
    var best = -Infinity
    for (var ti = 0; ti < targets.length; ti++) {
      var t = findBall(ctx2.balls, targets[ti])
      if (!t) continue
      for (var hi = 0; hi < ctx2.holes.length; hi++) {
        var hole = ctx2.holes[hi]
        var tx = hole.x - t.x, ty = hole.y - t.y
        var d2 = Math.hypot(tx, ty)
        if (d2 < 1) continue
        var ux = tx / d2, uy = ty / d2
        var gx = t.x - ux * ctx2.R * 2, gy = t.y - uy * ctx2.R * 2
        var d1 = Math.hypot(gx - x, gy - y)
        if (d1 < 1) continue
        var cut = ((gx - x) / d1) * ux + ((gy - y) / d1) * uy
        if (cut < CUT_LIMIT) continue
        if (!clearLine(ctx2, x, y, gx, gy, [0])) continue
        if (!clearLine(ctx2, t.x, t.y, hole.x, hole.y, [0, t.n])) continue
        var sc = cut * 1000 - d1 * 0.55 - d2 * 0.45
        if (sc > best) best = sc
      }
    }
    return best === -Infinity ? -1e6 : best
  }

  function findCue(ctx) { return findBall(ctx.balls, 0) }
  function findBall(balls, n) {
    for (var i = 0; i < balls.length; i++) if (balls[i].n === n) return balls[i]
    return null
  }
  // 白球沿 (dx,dy) 走，第一次会撞上的球 + 撞击瞬间白球所在点（ghost 点）。
  // 给页面画瞄准线用：有了真正的犯规规则，玩家必须能提前看到「我会先碰到谁」。
  function predictContact(g, ctx, dx, dy) {
    var cue = findCue(ctx)
    if (!cue) return null
    var len = Math.hypot(dx, dy)
    if (!cue.alive || len < 1e-6) return null
    var ux = dx / len, uy = dy / len
    var best = null
    for (var i = 0; i < ctx.balls.length; i++) {
      var b = ctx.balls[i]
      if (!b.alive || b.n === 0) continue
      var ox = cue.x - b.x, oy = cue.y - b.y
      var oDotU = ox * ux + oy * uy
      var disc = oDotU * oDotU - (ox * ox + oy * oy - ctx.R * ctx.R * 4)
      if (disc < 0) continue
      var t = -oDotU - Math.sqrt(disc)
      if (t <= 0) continue
      if (!best || t < best.t) best = { n: b.n, t: t, ghost: { x: cue.x + ux * t, y: cue.y + uy * t }, ball: b }
    }
    if (!best) return null
    // 第一接触之后目标球会往哪走：ghost→球心的连线方向（等质量弹性的标准结论）
    var tx = best.ball.x - best.ghost.x, ty = best.ball.y - best.ghost.y
    var tl = Math.hypot(tx, ty) || 1
    best.dirX = tx / tl
    best.dirY = ty / tl
    var tg = legalTargets(g, g.turn)
    best.willFoul = !g.isBreak && tg.indexOf(best.n) < 0 // 只做提示，判罚仍以 resolveShot 为准
    return best
  }

  // 8 号在开球时落袋 → 摆回摆球点（页面负责真的搬 DOM）
  function respotSpot(g, ctx) {
    return nearestLegalSpot(g, ctx, ctx.footSpot.x, ctx.footSpot.y)
  }

  var api = {
    VERSION: '1.0.0',
    SOLID: SOLID, STRIPE: STRIPE, EIGHT: EIGHT,
    LAMBDA: LAMBDA, MIN_SPEED: MIN_SPEED, MAX_SPEED: MAX_SPEED,
    groupOf: groupOf, groupName: groupName, otherGroup: otherGroup,
    createGame: createGame,
    beginShot: beginShot, noteFirstContact: noteFirstContact, noteRail: noteRail, notePocket: notePocket,
    resolveShot: resolveShot,
    remaining: remaining, isOnEight: isOnEight, legalTargets: legalTargets,
    pickShot: pickShot, bestCueSpot: bestCueSpot, isLegalSpot: isLegalSpot, nearestLegalSpot: nearestLegalSpot,
    respotSpot: respotSpot, requiredSpeed: requiredSpeed, clearLine: clearLine,
    predictContact: predictContact,
    findBall: findBall,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.BilliardsRules = api
})(typeof window !== 'undefined' ? window : globalThis)
