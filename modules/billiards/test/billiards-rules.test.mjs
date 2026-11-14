// billiards-rules.js 的验证（node --test 直接跑，不需要 Electron）
// 覆盖：规则状态机（开球/定组/犯规/8 号胜负/自由球）、几何合法性、AI 选杆，
// 以及一套和 arena.html/billiard.html 完全同口径的迷你物理沙盒 —— 用来证明
// AI 的力度模型（v = λ·d）在真实摩擦下真能把球送进袋，而不是只会算方向。
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 规则引擎是 UMD（浏览器上挂 window.BilliardsRules，node 上挂 module.exports）。
// 仓库根 package.json 写了 "type":"module"，直接 import 那个 .js 会被当 ESM 解析而炸，
// 所以按它自己的设计喂一个假 window 进去，再从上面取 exports。
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client', 'billiards-rules.js')
const sandbox = {}
new Function('window', readFileSync(SRC, 'utf8'))(sandbox)
const R = sandbox.BilliardsRules
assert.ok(R && typeof R.createGame === 'function', '规则引擎没挂到 window 上：检查 UMD 尾部')

const W = 1200, H = 600, BR = 20
const holeR = BR * 2 * 0.6
const inset = holeR * 0.62
const HOLES = [
  { x: inset, y: inset }, { x: W / 2, y: inset }, { x: W - inset, y: inset },
  { x: inset, y: H - inset }, { x: W / 2, y: H - inset }, { x: W - inset, y: H - inset },
].map((h) => ({ ...h, r: holeR }))

function rackCtx(over) {
  const balls = [{ n: 0, x: Math.max(BR * 1.8, W * 0.22), y: H / 2, vx: 0, vy: 0, alive: true }]
  const order = [1, 9, 2, 10, 8, 3, 11, 12, 4, 13, 5, 14, 6, 15, 7]
  const gap = BR * 2 + 2
  let idx = 1
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      balls.push({
        n: order[idx - 1] || idx,
        x: W * 0.66 + row * gap * 0.9,
        y: H / 2 + (k - row / 2) * gap,
        vx: 0, vy: 0, alive: true,
      })
      idx++
    }
  }
  const ctx = {
    balls, R: BR, holes: HOLES, W, H,
    cueSpot: { x: Math.max(BR * 1.8, W * 0.22), y: H / 2 },
    footSpot: { x: W * 0.66, y: H / 2 },
  }
  if (over) over(ctx)
  return ctx
}
function ball(ctx, n) { return R.findBall(ctx.balls, n) }
function kill(ctx, ...ns) { for (const n of ns) ball(ctx, n).alive = false }

// ---- 沙盒物理：与页面 step() 同参数 ----
function simulate(ctx, game, vx, vy) {
  const cue = ball(ctx, 0)
  cue.vx = vx; cue.vy = vy
  cue.alive = true
  let guard = 0
  while (guard++ < 40000) {
    const dt = 1 / 60
    const k = Math.pow(0.988, dt * 60)
    const maxStep = Math.max(4, BR * 0.5)
    let moving = false
    for (const b of ctx.balls) {
      if (!b.alive) continue
      const sp = Math.hypot(b.vx, b.vy)
      const n = Math.max(1, Math.ceil((sp * dt) / maxStep))
      for (let s = 0; s < n; s++) {
        b.x += (b.vx * dt) / n
        b.y += (b.vy * dt) / n
        // 墙
        if (b.x < BR) { b.x = BR; if (b.vx < 0) { b.vx = Math.abs(b.vx) * 0.88; R.noteRail(game) } }
        else if (b.x > W - BR) { b.x = W - BR; if (b.vx > 0) { b.vx = -Math.abs(b.vx) * 0.88; R.noteRail(game) } }
        if (b.y < BR) { b.y = BR; if (b.vy < 0) { b.vy = Math.abs(b.vy) * 0.88; R.noteRail(game) } }
        else if (b.y > H - BR) { b.y = H - BR; if (b.vy > 0) { b.vy = -Math.abs(b.vy) * 0.88; R.noteRail(game) } }
      }
      b.vx *= k; b.vy *= k
      if (Math.abs(b.vx) < 4) b.vx = 0
      if (Math.abs(b.vy) < 4) b.vy = 0
      if (b.vx || b.vy) moving = true
    }
    for (let i = 0; i < ctx.balls.length; i++) {
      for (let j = i + 1; j < ctx.balls.length; j++) {
        const a = ctx.balls[i], c = ctx.balls[j]
        if (!a.alive || !c.alive) continue
        const dx = c.x - a.x, dy = c.y - a.y
        const dist = Math.hypot(dx, dy), minD = BR * 2
        if (dist === 0 || dist >= minD) continue
        const nx = dx / dist, ny = dy / dist, ov = minD - dist
        a.x -= nx * ov / 2; a.y -= ny * ov / 2
        c.x += nx * ov / 2; c.y += ny * ov / 2
        const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny
        if (vn > 0) continue
        const imp = -vn
        a.vx -= imp * nx; a.vy -= imp * ny
        c.vx += imp * nx; c.vy += imp * ny
        if (a.n === 0) R.noteFirstContact(game, c.n)
        else if (c.n === 0) R.noteFirstContact(game, a.n)
      }
    }
    for (const b of ctx.balls) {
      if (!b.alive) continue
      for (const h of HOLES) {
        if (Math.hypot(b.x - h.x, b.y - h.y) < h.r * 0.68) {
          R.notePocket(game, b.n)
          if (b.n === 0) { b.vx = 0; b.vy = 0; b.x = ctx.cueSpot.x; b.y = ctx.cueSpot.y }
          else { b.alive = false; b.vx = 0; b.vy = 0 }
          break
        }
      }
    }
    drawZero(ctx)
    if (!moving) break
  }
  return guard
}
function drawZero(ctx) { for (const b of ctx.balls) if (!b.alive) { b.vx = 0; b.vy = 0 } }

// ============ 规则状态机 ============
function shot(game, potted, first, railed) {
  R.beginShot(game)
  if (first !== null && first !== undefined) R.noteFirstContact(game, first)
  if (railed) R.noteRail(game)
  for (const n of potted || []) R.notePocket(game, n)
  return R.resolveShot(game, { balls: [], R: BR, holes: HOLES, W, H, cueSpot: { x: 0, y: 0 }, footSpot: { x: 0, y: 0 } })
}

test('新建：开放台面、seat0 开球、还没定组', () => {
  const g = R.createGame()
  assert.strictEqual(g.turn, 0)
  assert.strictEqual(g.open, true)
  assert.strictEqual(g.isBreak, true)
  assert.strictEqual(g.groups[0], null)
  assert.strictEqual(R.remaining(g, 0), 7)
  assert.strictEqual(R.isOnEight(g, 0), false)
})

test('开球：碰到球堆 + 碰库即合法；未进球则换手，台面仍开放', () => {
  const g = R.createGame()
  const out = shot(g, [], 1, true)
  assert.strictEqual(out.foul, null)
  assert.strictEqual(out.turnChanged, true)
  assert.strictEqual(out.continues, false)
  assert.strictEqual(g.open, true, '开球后不该定组')
  assert.strictEqual(g.isBreak, false)
  assert.strictEqual(g.turn, 1)
})

test('开球进球：继续出杆，不定组', () => {
  const g = R.createGame()
  const out = shot(g, [3], 1, true)
  assert.strictEqual(out.foul, null)
  assert.strictEqual(out.continues, true)
  assert.strictEqual(g.turn, 0)
  assert.strictEqual(g.open, true)
})

test('开球白球落袋：犯规 + 对手自由球', () => {
  const g = R.createGame()
  const out = shot(g, [0], 1, true)
  assert.strictEqual(out.foul, 'scratch')
  assert.strictEqual(out.ballInHand, true)
  assert.strictEqual(g.turn, 1)
  assert.strictEqual(g.ballInHand, true)
})

test('开球把 8 号打进：重摆不定负', () => {
  const g = R.createGame()
  const out = shot(g, [8, 2], 1, true)
  assert.strictEqual(out.respot8, true)
  assert.strictEqual(out.over, false)
  assert.strictEqual(g.potted[8], undefined, '8 号该回到台面')
  assert.strictEqual(g.potted[2], true, '其它进球留在袋里')
})

test('开放台面：第一次合法进球定组，先落的那颗决定组别', () => {
  const g = R.createGame()
  shot(g, [], 1, true) // 开球没进
  assert.strictEqual(g.turn, 1)
  const out = shot(g, [11, 4], 4, true) // 先落 11（花色）
  assert.strictEqual(out.foul, null)
  assert.deepStrictEqual(out.groupAssigned, [1, R.STRIPE])
  assert.strictEqual(g.groups[1], R.STRIPE)
  assert.strictEqual(g.groups[0], R.SOLID)
  assert.strictEqual(out.continues, true, '进的是刚定下的自己组→该续杆')
  assert.strictEqual(g.turn, 1)
})

test('已定组：先碰对方的球 = 犯规，对手自由球', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [], 10, true)
  assert.strictEqual(out.foul, 'wrong-group')
  assert.strictEqual(g.turn, 1)
  assert.strictEqual(g.ballInHand, true)
})

test('已定组：先碰 8（自己组没清完）= 犯规', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [], 8, true)
  assert.strictEqual(out.foul, 'eight-first')
})

test('空杆：一颗没碰 = 犯规', () => {
  const g = R.createGame()
  const out = shot(g, [], null, false)
  assert.strictEqual(out.foul, 'air')
})

test('碰库规则：有第一接触、没进球、没碰库 = 犯规', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [], 3, false)
  assert.strictEqual(out.foul, 'no-rail')
  g.turn = 0 // 上一杆犯规已换手，这里把出杆权拿回来再验「碰库后不判罚」
  const out2 = shot(g, [], 3, true)
  assert.strictEqual(out2.foul, null, '碰库后就不该判罚')
  assert.strictEqual(out2.turnChanged, true)
})

test('第一接触之前的撞库不算数', () => {
  const g = R.createGame()
  R.beginShot(g)
  R.noteRail(g) // 还没接触
  assert.strictEqual(g.shot.railed, false)
  R.noteFirstContact(g, 3)
  R.noteRail(g)
  assert.strictEqual(g.shot.railed, true)
})

test('进对方的球：不犯规但换手，球留在袋里', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [10], 3, true)
  assert.strictEqual(out.foul, null)
  assert.strictEqual(out.continues, false)
  assert.strictEqual(out.turnChanged, true)
  assert.strictEqual(g.potted[10], true)
})

test('进自己的球：续杆', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [5], 5, true)
  assert.strictEqual(out.foul, null)
  assert.strictEqual(out.continues, true)
  assert.strictEqual(g.turn, 0)
  assert.strictEqual(g.stats[0].pots, 1)
})

test('犯规时打进的球照样留在袋里（WPA）', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [0, 5], 5, true)
  assert.strictEqual(out.foul, 'scratch')
  assert.strictEqual(g.potted[5], true)
  assert.strictEqual(g.turn, 1)
})

test('组没清完就打 8 进袋：直接判负', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const out = shot(g, [8], 1, true)
  assert.strictEqual(out.over, true)
  assert.strictEqual(g.winner, 1)
  assert.match(out.reason, /8 号提前落袋/)
})

test('开放台面打 8 进袋：也算提前，判负', () => {
  const g = R.createGame()
  g.isBreak = false
  const out = shot(g, [8], 3, true)
  assert.strictEqual(g.winner, 1)
})

test('清完自己组后合法打进 8：获胜', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  for (const n of [1, 2, 3, 4, 5, 6, 7]) g.potted[n] = true
  assert.strictEqual(R.isOnEight(g, 0), true)
  assert.deepStrictEqual(R.legalTargets(g, 0), [8])
  const out = shot(g, [8], 8, true)
  assert.strictEqual(out.over, true)
  assert.strictEqual(g.winner, 0)
})

test('打 8 的同时白球落袋：判负', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[1] = R.STRIPE; g.groups[0] = R.SOLID
  for (const n of [9, 10, 11, 12, 13, 14, 15]) g.potted[n] = true
  g.turn = 1 // 该打 8 号的是 seat1
  const out = shot(g, [8, 0], 8, true)
  assert.strictEqual(g.winner, 0, '犯规方是 seat1，seat0 胜')
  assert.match(out.reason, /打 8 号时犯规/)
})

test('该打 8 时先碰了别的球：犯规（不能被误判成「先碰对方球」）', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.STRIPE; g.groups[1] = R.SOLID
  for (const n of [9, 10, 11, 12, 13, 14, 15]) g.potted[n] = true
  const out = shot(g, [], 3, true)
  assert.strictEqual(out.foul, 'wrong-group')
  assert.match(out.reason, /该打 8 号/)
  // 同一局面合法打 8 → 赢
  const out2 = (function () { g.turn = 0; return shot(g, [8], 8, true) })()
  assert.strictEqual(g.winner, 0)
})

test('legalTargets：开放台面不含 8', () => {
  const g = R.createGame()
  g.isBreak = false
  const t = R.legalTargets(g, 0)
  assert.ok(t.length === 14, '1-15 去掉 8')
  assert.ok(!t.includes(8))
})

test('自由球摆位合法性：压球/出界/落洞口都不行', () => {
  const ctx = rackCtx()
  const t1 = ball(ctx, 1)
  assert.strictEqual(R.isLegalSpot(R.createGame(), ctx, t1.x, t1.y), false, '重叠')
  assert.strictEqual(R.isLegalSpot(R.createGame(), ctx, 2, 2), false, '出界')
  assert.strictEqual(R.isLegalSpot(R.createGame(), ctx, HOLES[0].x, HOLES[0].y), false, '洞口')
  assert.strictEqual(R.isLegalSpot(R.createGame(), ctx, W * 0.4, H * 0.2), true, '空地')
  const near = R.nearestLegalSpot(R.createGame(), ctx, t1.x, t1.y)
  assert.strictEqual(R.isLegalSpot(R.createGame(), ctx, near.x, near.y), true, '修正后必须合法')
})

test('requiredSpeed：越远越用力，且落在物理允许的区间内', () => {
  const ctx = rackCtx()
  const a = R.requiredSpeed(ctx, 100, 100, 1)
  const b = R.requiredSpeed(ctx, 600, 400, 1)
  assert.ok(b > a, '距离变长力度要更大')
  assert.ok(a >= R.MIN_SPEED && b <= R.MAX_SPEED)
  const thin = R.requiredSpeed(ctx, 200, 300, 0.35)
  assert.ok(thin > R.requiredSpeed(ctx, 200, 300, 1), '薄切要更用力')
})

function clearTo(cue, list) {
  // 只留白球 + list: [[n,x,y], ...]
  const ctx = rackCtx()
  for (const b of ctx.balls) b.alive = b.n === 0
  ctx.balls[0].x = cue[0]; ctx.balls[0].y = cue[1]
  for (const [n, x, y] of list) { const b = ball(ctx, n); b.alive = true; b.x = x; b.y = y }
  return ctx
}

test('瞄准预测：正对着的球一定命中，ghost 点在球心前 2R', () => {
  const g = R.createGame()
  g.isBreak = false
  const ctx = clearTo([100, 300], [[3, 500, 300]])
  const p = R.predictContact(g, ctx, 1, 0)
  assert.strictEqual(p.n, 3)
  assert.ok(Math.abs(p.t - (500 - 100 - BR * 2)) < 1e-6, 't=' + p.t)
  assert.ok(Math.abs(p.ghost.x - 460) < 1e-6 && Math.abs(p.ghost.y - 300) < 1e-6)
  assert.strictEqual(p.dirX, 1)
  assert.strictEqual(p.dirY, 0)
  assert.strictEqual(p.willFoul, false)
})

test('瞄准预测：偏出 2R 以上就打空，两球取近的', () => {
  const g = R.createGame()
  g.isBreak = false
  const ctx = clearTo([100, 300], [[1, 400, 300 + BR * 2 + 1], [5, 700, 300]])
  assert.strictEqual(R.predictContact(g, ctx, 1, 0).n, 5, '该取路径上真能碰到的那颗')
  const ctx2 = clearTo([100, 300], [[2, 300, 300], [6, 800, 300]])
  assert.strictEqual(R.predictContact(g, ctx2, 1, 0).n, 2)
  const ctx3 = clearTo([100, 300], [[2, 300, 200]])
  assert.strictEqual(R.predictContact(g, ctx3, 1, 0), null)
})

test('瞄准提示：定组后打对方球会提前标红', () => {
  const g = R.createGame()
  g.isBreak = false; g.open = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const ctx = clearTo([100, 300], [[12, 400, 300]])
  assert.strictEqual(R.predictContact(g, ctx, 1, 0).willFoul, true)
})

test('AI 选杆：开球一定打向球堆，力度与目标合法', () => {
  const g = R.createGame()
  const ctx = rackCtx()
  const s = R.pickShot(g, ctx, { noise: 0 })
  assert.ok(s, '开球必有可打线路')
  assert.ok([1, 9, 2].includes(s.target) || s.d1 > 0)
  assert.ok(s.speed > R.MIN_SPEED && s.speed <= R.MAX_SPEED)
  assert.ok(Math.hypot(s.vx, s.vy) > 0)
})

test('AI 不挑犯规线路：定组后只打自己的球', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID; g.groups[1] = R.STRIPE
  const ctx = rackCtx((c) => { c.balls[0].x = W * 0.5; c.balls[0].y = H * 0.5 })
  for (let i = 0; i < 40; i++) {
    const s = R.pickShot(g, ctx, { noise: 0 })
    if (!s) continue
    assert.ok(s.target >= 1 && s.target <= 7, '只会瞄准全色，实际 ' + s.target)
  }
})

test('AI 没线路时退回 safety：至少碰到合法目标', () => {
  const g = R.createGame()
  g.open = false; g.isBreak = false
  g.groups[0] = R.SOLID
  const ctx = rackCtx((c) => {
    // 把白球围死：四面都贴墙摆其它球，任何袋口线路都不通
    const cue = c.balls[0]
    cue.x = W * 0.5; cue.y = H * 0.5
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2
      c.balls.push({ n: 20 + a, x: cue.x + Math.cos(ang) * BR * 2.2, y: cue.y + Math.sin(ang) * BR * 2.2, vx: 0, vy: 0, alive: true })
    }
    // 清掉真正的目标球，只剩 1 号在远处
    for (const b of c.balls) if (b.n >= 2 && b.n <= 15 && b.n !== 1) b.alive = false
  })
  const s = R.pickShot(g, ctx, { noise: 0 })
  assert.ok(s, 'safety 也要给出杆')
  assert.strictEqual(s.safety, true)
  assert.strictEqual(s.target, 1)
})

// ============ 端到端：AI 对 AI 打完整局 ============
test('整局模拟：两个 AI 用同一套物理打到出胜负', () => {
  const g = R.createGame({ seats: ['A', 'B'] })
  const ctx = rackCtx()
  let shots = 0
  while (!g.over && shots < 400) {
    shots++
    if (g.ballInHand) {
      const p = R.bestCueSpot(g, ctx)
      const cue = ball(ctx, 0)
      cue.x = p.x; cue.y = p.y; cue.alive = true
      g.ballInHand = false
    }
    R.beginShot(g)
    const pick = R.pickShot(g, ctx, { noise: 0.006 })
    assert.ok(pick, '第 ' + shots + ' 杆选不出线路')
    simulate(ctx, g, pick.vx, pick.vy)
    const out = R.resolveShot(g, ctx)
    if (out.respot8) {
      const p = R.respotSpot(g, ctx)
      const e = ball(ctx, 8)
      e.alive = true; e.x = p.x; e.y = p.y; e.vx = 0; e.vy = 0
    }
    if (g.over) break
  }
  assert.strictEqual(g.over, true, '400 杆内该打完，实际打了 ' + shots + ' 杆：' + g.log.slice(-4).join(' | '))
  assert.ok([0, 1].includes(g.winner))
  assert.ok(shots > 4, '开局几杆就结束说明规则判得太松')
  assert.ok(g.log.some((l) => /定为/.test(l)), '应该发生过定组：' + g.log.join(' | '))
  assert.ok(g.shotNo <= 400)
  // 统计：AI 不该杆杆犯规，也不该一杆不进
  const total = g.stats[0].shots + g.stats[1].shots
  const fouls = g.stats[0].fouls + g.stats[1].fouls
  assert.ok(fouls / total < 0.45, '犯规率过高：' + fouls + '/' + total)
  assert.ok(g.stats[0].pots + g.stats[1].pots > 6, '进球太少，说明力度模型不成立')
})

test('整局模拟（再来一次，换 seat1 开球）：规则不偏向先手', () => {
  const g = R.createGame({ seats: ['A', 'B'] })
  g.turn = 1
  const ctx = rackCtx()
  let shots = 0
  while (!g.over && shots < 400) {
    shots++
    if (g.ballInHand) {
      const p = R.bestCueSpot(g, ctx)
      const cue = ball(ctx, 0)
      cue.x = p.x; cue.y = p.y; cue.alive = true
      g.ballInHand = false
    }
    R.beginShot(g)
    const pick = R.pickShot(g, ctx, { noise: 0.006 })
    simulate(ctx, g, pick.vx, pick.vy)
    const out = R.resolveShot(g, ctx)
    if (out.respot8) {
      const p = R.respotSpot(g, ctx)
      const e = ball(ctx, 8)
      e.alive = true; e.x = p.x; e.y = p.y
    }
  }
  assert.strictEqual(g.over, true, g.log.slice(-3).join(' | '))
})
