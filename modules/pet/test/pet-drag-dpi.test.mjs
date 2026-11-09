// pet-drag-dpi.test.mjs —— 2026-11-07 拖拽/DPI 修复轮回归测试（task-3 QA）
// 覆盖：
//   · physics.js 纯函数：throwBounds 新 areaX/areaY 绝对边界（缺省 0 与旧口径一致）、
//     clampBodyRect 身体盒夹回屏幕并集（单屏/多屏/身体大于屏/负坐标屏/NaN 输入）、
//     甩抛 + 每帧钳制组合模拟（随机初速 × 多种屏配置）、estimateReleaseVelocity 吃 16ms DIP 轨迹。
//   · main.js / index.html / preload.js 源码契约（readFileSync + 正则，照 pet-behavior-client 的写法）：
//     拖拽三桥、主进程权威拖拽循环、startThrow 绝对边界重算 + 硬钳、捏（pinch）单次触发、__setAnimRate。
// 说明：worktree 根 package.json 是 type:module，直接 require physics.js 拿不到 exports，
//       一律用 new Function 以 CommonJS 形态求值（同 pet.test.mjs 的 loadPhysics 写法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'pet-client')

function loadPhysics() {
  const code = readFileSync(join(CLIENT, 'physics.js'), 'utf8')
  const m = { exports: {} }
  new Function('module', 'exports', code)(m, m.exports) // UMD：以 CommonJS 形态求值
  return m.exports
}
const src = (f) => readFileSync(join(CLIENT, f), 'utf8')

// ---------- physics.js：throwBounds 新 areaX/areaY 绝对边界 ----------

test('throwBounds areaX/areaY：缺省 0 与旧口径完全一致；传了以后边界整体平移', () => {
  const P = loadPhysics()
  const o = { W: 1920, H: 1080, bodyW: 240, bodyH: 240, offsetX: 20, offsetY: 174, sideAllow: 30 }
  const oldB = P.throwBounds(o)
  // 缺省 areaX/areaY = 0：与旧口径（工作区相对坐标）逐字段一致，老测试不能受影响
  assert.equal(oldB.areaX, undefined, '不新增多余字段')
  assert.deepEqual(oldB, P.throwBounds({ ...o, areaX: 0, areaY: 0 }), '显式传 0 与缺省完全一致')
  // 平移正确：边界 = 旧边界 + (areaX, areaY)
  const moved = P.throwBounds({ ...o, areaX: -1536, areaY: -240 }) // 左侧副屏（负坐标）场景
  assert.equal(moved.minX, oldB.minX - 1536)
  assert.equal(moved.maxX, oldB.maxX - 1536)
  assert.equal(moved.minY, oldB.minY - 240)
  assert.equal(moved.maxY, oldB.maxY - 240)
  // 只传一个轴：另一个轴不动（主进程只知工作区左上角，两轴同传是常态，但要防写串）
  const half = P.throwBounds({ ...o, areaY: 120 })
  assert.equal(half.minY, oldB.minY + 120)
  assert.equal(half.maxY, oldB.maxY + 120)
  assert.deepEqual({ minX: half.minX, maxX: half.maxX }, { minX: oldB.minX, maxX: oldB.maxX }, 'x 轴不受 areaY 影响')
})

// ---------- physics.js：clampBodyRect 身体盒夹回屏幕并集 ----------

test('clampBodyRect：单屏 / 多屏并集 / 身体大于屏 / 负坐标屏 / NaN 全收敛且无 NaN', () => {
  const P = loadPhysics()
  // 单屏：身体完整夹回
  const screen1 = { x: 0, y: 0, w: 1920, h: 1040 }
  const body = { width: 240, height: 240 }
  assert.deepEqual(P.clampBodyRect({ x: 500, y: 500, ...body }, screen1), { x: 500, y: 500, width: 240, height: 240 }, '屏内原样返回')
  assert.deepEqual(P.clampBodyRect({ x: 99999, y: -50, ...body }, screen1), { x: 1680, y: 0, width: 240, height: 240 }, '越界夹回右/上边缘')
  // 多屏并集（主屏 0,0 1920×1080 + 左侧副屏 -1536,-240 1536×824）：跨屏坐标要相对并集钳
  const uni = { x: -1536, y: -240, w: 1536 + 1920, h: 824 + 1080 }
  const r = P.clampBodyRect({ x: -3000, y: 3000, ...body }, uni)
  assert.equal(r.x, uni.x, '左/下越界夹回并集左/上边缘')
  assert.ok(r.y >= uni.y && r.y <= uni.y + uni.h - 240)
  assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), '无 NaN')
  // 身体比屏幕还大：贴左/上边缘，绝不产生负空间或 NaN
  const big = P.clampBodyRect({ x: 100, y: 100, width: 5000, height: 4000 }, screen1)
  assert.deepEqual(big, { x: 0, y: 0, width: 5000, height: 4000 }, '身体大于屏 → 贴左上边缘（b.w 被 max(w,…) 抬到身体尺寸）')
  // 负坐标屏 + NaN 输入：收敛成合法值
  const nan = P.clampBodyRect({ x: NaN, y: NaN, width: NaN, height: -5 }, { x: -1536, y: -240, w: 3456, h: 1904 })
  assert.ok(Number.isFinite(nan.x) && Number.isFinite(nan.y) && Number.isFinite(nan.width) && Number.isFinite(nan.height), 'NaN/负尺寸输入不产生 NaN')
  assert.ok(nan.width >= 1 && nan.height >= 1, '尺寸最小 1')
  assert.ok(nan.x >= -1536 && nan.x <= -1536 + 3456 - nan.width, 'x 在并集内')
  // null/undefined 输入也不炸
  const n1 = P.clampBodyRect(null, screen1)
  assert.ok(Number.isFinite(n1.x) && Number.isFinite(n1.y), 'null rect 不炸、收敛进屏')
  assert.deepEqual(P.clampBodyRect(body, null), { x: 0, y: 0, width: 240, height: 240 }, 'null bounds 按原点屏处理')
})

// ---------- physics.js：甩抛 + 每帧钳制组合模拟（随机初速 × 多种屏配置） ----------

test('throwBounds+throwStep 组合：随机初速 × 多种屏配置，任意帧身体都在并集内、有限帧内 atRest', () => {
  const P = loadPhysics()
  // 可复现的伪随机（LCG）：测试要稳定，不用 Math.random
  let seed = 20261107
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  // 主进程同一口径：绝对边界（areaX/areaY = 工作区左上角），身体盒贴窗口底部
  const screens = [
    { x: 0, y: 0, w: 1920, h: 1040 },                       // 单屏
    { x: 0, y: 0, w: 2560, h: 1400 },                       // 大屏
    { x: -1536, y: -240, w: 1536 + 1920, h: 824 + 1080 },   // 左副屏并集（负坐标）
    { x: 0, y: 0, w: 1366, h: 728 },                        // 小笔记本屏
  ]
  for (const s of screens) {
    const b = P.throwBounds({ W: s.w, H: s.h, bodyW: 240, bodyH: 240, offsetX: 20, offsetY: s.h - 16 - 240 - s.h + (s.h - 256), sideAllow: 19, areaX: s.x, areaY: s.y })
    // offsetY 取贴底姿态：窗口高 256（小屏时），身体高 240、距底 16
    const bb = P.throwBounds({ W: s.w, H: 256, bodyW: 240, bodyH: 240, offsetX: 8, offsetY: 0, sideAllow: 19, areaX: s.x, areaY: s.y })
    void b
    for (let i = 0; i < 40; i++) {
      const vx = (rnd() * 2 - 1) * 3600
      const vy = -(rnd() * 3600) // 向上甩才有抛物线
      let st = { x: s.x + rnd() * (s.w - 240), y: s.y + rnd() * Math.max(1, s.h - 240), vx, vy }
      let frames = 0
      while (!st.atRest && frames < 1200) {
        st = P.throwStep(st, 1 / 60, bb, P.DEFAULT_PHYSICS)
        frames++
        assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y), `坐标有限（屏 ${s.w}×${s.h}，初速 ${vx.toFixed(0)},${vy.toFixed(0)}，第 ${frames} 帧）`)
        // 每帧硬约束：窗口左上角必在边界内（主进程每子步还做了硬钳，这里验证物理层自身不越界）
        assert.ok(st.x >= bb.minX - 1e-6 && st.x <= bb.maxX + 1e-6, `x 不越界：${vx.toFixed(0)},${vy.toFixed(0)} 第${frames}帧`)
        assert.ok(st.y >= bb.minY - 1e-6 && st.y <= bb.maxY + 1e-6, `y 不越界：${vx.toFixed(0)},${vy.toFixed(0)} 第${frames}帧`)
      }
      assert.ok(st.atRest, `屏 ${s.w}×${s.h} 初速 (${vx.toFixed(0)},${vy.toFixed(0)}) 在 1200 帧内静止，实际 ${frames} 帧`)
      assert.equal(st.y, bb.maxY, '最终落在地面（不会悬空半屏）')
    }
  }
})

// ---------- physics.js：estimateReleaseVelocity 吃主进程 DIP 轨迹（16ms 采样） ----------

test('estimateReleaseVelocity：16ms DIP 轨迹方向与量级正确；慢拖不误抛', () => {
  const P = loadPhysics()
  const now = Date.now()
  // 主进程拖拽循环 16ms 采样一条：400ms 内匀加速向右下甩（DIP 坐标）
  const trail = []
  for (let i = 0; i < 25; i++) trail.push({ t: now - 400 + i * 16, x: i * i * 0.35, y: i * i * 0.18 })
  const v = P.estimateReleaseVelocity(P.trimTrail(trail, now), now, P.DEFAULT_PHYSICS)
  assert.ok(v, '快速甩出可估算')
  assert.ok(v.vx > 0 && v.vy > 0, `方向 = 右下（vx=${v.vx.toFixed(0)}, vy=${v.vy.toFixed(0)}）`)
  assert.ok(v.vy / v.vx > 0.3 && v.vy / v.vx < 1.2, '方向斜率与轨迹一致（约 0.18/0.35≈0.51）')
  assert.ok(Math.hypot(v.vx, v.vy) <= 3600, '量级在软钳上限内')
  assert.ok(Math.hypot(v.vx, v.vy) > 800, '快速甩出的量级超过死区（会真的抛出去）')
  // 慢拖（16ms 采样、每帧挪 1px）：低于死区 → null（温柔放下，不误抛）
  const slow = []
  for (let i = 0; i < 20; i++) slow.push({ t: now - 320 + i * 16, x: i * 1, y: i * 0.5 })
  assert.equal(P.estimateReleaseVelocity(P.trimTrail(slow, now), now, P.DEFAULT_PHYSICS), null, '慢拖 → null（不抛）')
  // trimTrail 只保留 200ms 窗口：老采样被剔，方向以最近的轨迹为准
  const mixed = [...Array.from({ length: 10 }, (_, i) => ({ t: now - 2000 + i * 16, x: -i * 50, y: 0 })), ...trail]
  const vm = P.estimateReleaseVelocity(P.trimTrail(mixed, now), now, P.DEFAULT_PHYSICS)
  assert.ok(vm && vm.vx > 0, '2000ms 前的向左轨迹被剔掉，方向不被污染')
})

// ---------- 源码契约：preload.js 三桥 ----------

test('preload：暴露 dragStart/dragMove/dragEnd 且保留旧 API（moveTo/screenInfo/throwWith 等）', () => {
  const s = src('preload.js')
  for (const fn of ['dragStart', 'dragMove', 'dragEnd']) {
    assert.ok(new RegExp(`\\b${fn}\\s*:`).test(s), `petBridge.${fn} 存在`)
    assert.ok(s.includes(`'pet:drag-${{ dragStart: 'start', dragMove: 'move', dragEnd: 'end' }[fn]}'`), `${fn} 对应 pet:drag-* IPC 通道`)
  }
  for (const old of ['moveTo', 'screenInfo', 'throwWith']) {
    assert.ok(new RegExp(`\\b${old}\\s*:`).test(s), `旧 API ${old} 保留（旧渲染页/兼容路径不炸）`)
  }
})

// ---------- 源码契约：index.html 拖拽段 ----------

test('index.html：拖拽只发信号三桥，不再出现 e.screenX / screenInfo 自算坐标；捏单次触发', () => {
  const s = src('index.html')
  // 三桥齐全
  for (const fn of ['dragStart()', 'dragMove()', 'dragEnd(']) assert.ok(s.includes(fn), `渲染页调用 petBridge.${fn}`)
  // 旧自算坐标路径已删：拖拽段不许再出现 e.screenX / petBridge.screenInfo 调用（拖拽偏移根因）。
  // 注释里允许保留「旧机制已删」的说明文字，所以剥掉 // 行注释后再断言（只查真实代码）。
  const code = s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/e\.screenX/.test(code), '不再用 e.screenX（穿透窗 + setZoomFactor 下会错位）')
  assert.ok(!/petBridge\s*\.\s*screenInfo\s*\(/.test(code), '不再调 screenInfo() 自算窗口目标')
  // 捏（pinch）：静止超时触发 __squash + 气泡；一次按住最多一次（pinched 标记）
  assert.match(s, /PINCH_DELAY_MS\s*=\s*450/, '捏触发时长 450ms（任务书默认值）')
  assert.match(s, /dragging\.pinched\s*=\s*true/, '触发后置 pinched 标记')
  assert.match(s, /if\s*\(!dragging\s*\|\|\s*dragging\.moved\s*\|\|\s*dragging\.pinched\)\s*return/, '守卫：移动过/已触发不再触发（一次按住最多一次）')
  assert.match(s, /__squash\s*&&\s*(window\.)?__squash\(300\)/, '捏触发走 __squash（轻捏冲击档）')
  assert.match(s, /__bubble\(/, '捏伴随气泡文案')
  // 松手/拖动/取消都要清捏定时器
  const clearCount = (s.match(/pinchTimer\s*=\s*null/g) || []).length
  assert.ok(clearCount >= 3, `松手/拖动/取消三条路径都清 pinchTimer（实测 ${clearCount} 处）`)
  // 旧回调保留可用
  for (const hook of ['__squash', '__onThrowEnd', '__playClick', '__setAnimRate']) assert.ok(s.includes(hook), `旧渲染钩子 ${hook} 保留`)
})

// ---------- 源码契约：main.js 主进程权威拖拽 ----------

test('main.js：权威拖拽循环（pet:drag-start + getCursorScreenPoint）、startThrow 绝对边界硬钳、收尾钳回', () => {
  const s = src('main.js')
  // 拖拽通道与光标循环
  assert.ok(s.includes("ipcMain.on('pet:drag-start'"), '注册 pet:drag-start')
  assert.ok(s.includes("'pet:drag-move'") && s.includes("'pet:drag-end'"), 'pet:drag-move / pet:drag-end 通道齐全')
  assert.ok(s.includes('getCursorScreenPoint'), '拖拽循环读真实光标（主进程权威，不再信渲染页坐标）')
  // startThrow：每帧按窗口中心重算工作区，throwBounds 吃绝对坐标 areaX/areaY
  assert.match(s, /areaX:\s*area\.x/, 'throwBounds 传绝对 areaX（每帧重算的工作区）')
  assert.match(s, /areaY:\s*area\.y/, 'throwBounds 传绝对 areaY')
  assert.ok(/invalidateThrowSpace|recomputeBounds|重算|缓存作废/.test(s), '边界每帧重算 / 缓存作废')
  // 越界硬钳 + 清轴速（宁可少弹一下不飞出屏）
  assert.ok(/invalidateThrowSpace|clampWindowToArea|clampBodyRect/.test(s), '有边界钳制逻辑（本地合并版用 invalidateThrowSpace + clampWindowToArea）')
  // 收尾钳回：finish 里 clampWindowToArea
  assert.match(s, /clampWindowToArea\(\)/, 'finish/收尾调用 clampWindowToArea 把窗口贴回工作区')
  // 甩抛初速与拖拽同口径：drag-end 用 trimTrail + estimateReleaseVelocity + effectivePhysics
  assert.match(s, /estimateReleaseVelocity\(trail,\s*Date\.now\(\),\s*effectivePhysics\(\)\)/, 'drag-end 初速估算走 effectivePhysics 同口径')
  // 心跳兜底：拖拽中渲染页失联 1.5s 自动收尾
  assert.match(s, /1500|1\.5/, '心跳丢失兜底（1.5s）')
  // /config 消费 physics/animRate/balanceEnabled，缺字段兜底
  assert.match(s, /DEFAULT_PHYSICS/, 'physics 缺省回落 DEFAULT_PHYSICS')
  assert.match(s, /animRate/, '消费 animRate')
  assert.match(s, /balanceEnabled/, '消费 balanceEnabled')
})

// ---------- 二轮修复：尺寸单位自标定（sizeK / setSizeDip / winSizeDip，2026-11-07 E2E 补） ----------

/** 从 main.js 源码里按花括号配平提取 `function <name>` 的整段函数体（含声明行）。
 *  别全局 grep 一刀切：裸 getSize 这种检查必须知道「它出现在哪个函数里」才有意义。 */
function extractFn(s, name) {
  const start = s.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `main.js 里有 function ${name}`)
  let depth = 0, i = s.indexOf('{', start)
  const begin = i
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') { depth--; if (depth === 0) return { text: s.slice(start, i + 1), start, end: i + 1 } }
  }
  assert.fail(`function ${name} 花括号没配平`)
}

test('尺寸自标定：sizeK/setSizeDip/winSizeDip 齐全，setSizeDip 内有读回偏差>2 重标定逻辑', () => {
  const s = src('main.js')
  for (const name of ['sizeK', 'setSizeDip', 'winSizeDip']) assert.ok(s.includes(name), `main.js 有 ${name}`)
  const setFn = extractFn(s, 'setSizeDip').text
  assert.match(setFn, /win\.setSize\(Math\.round\(w \* sizeK\), Math\.round\(h \* sizeK\)\)/, 'setSize 前 DIP 意图乘 sizeK')
  assert.match(setFn, /win\.getSize\(\)/, 'setSize 后读回真实尺寸')
  assert.match(setFn, /Math\.abs\(read\[0\] - Math\.round\(w \* sizeK\)\) > 2/, '读回偏差 >2 才重标定（小误差不抖）')
  assert.match(setFn, /sizeK = Math\.min\(4, Math\.max\(1,/, '重标定夹到 [1,4]')
  const getFn = extractFn(s, 'winSizeDip').text
  assert.match(getFn, /\/ sizeK/, 'winSizeDip 读回后除回 sizeK（DIP 意图尺寸）')
})

test('bodyBox：倍率来自 curScale（0.5~2 钳制），不再从窗口宽 BASE_W 反推', () => {
  const s = src('main.js')
  const fn = extractFn(s, 'bodyBox').text
  assert.match(fn, /s = Math\.min\(2, Math\.max\(0\.5, curScale\)\)/, '权威倍率 = /config 的 curScale（0.5~2 钳制）')
  assert.ok(!/BASE_W/.test(fn), 'bodyBox 内不再出现窗口宽反推（dsf≠1 时窗口宽语义漂移，反推必错）')
})

test('裸 win.getSize() 只出现在 setSizeDip/winSizeDip 内部；chatWin.getSize() 不受影响', () => {
  const s = src('main.js')
  const a = extractFn(s, 'setSizeDip')
  const b = extractFn(s, 'winSizeDip')
  // 抠掉这两个函数段落后，全文件不允许再有任何裸 win.getSize()——所有消费点必须走 winSizeDip()。
  // 先剥掉注释：顶部机制说明注释里允许提到 win.getSize() 这个名字，只查真实代码。
  const rest = (s.slice(0, a.start) + s.slice(a.end, b.start) + s.slice(b.end))
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/win\.getSize\(/.test(rest), '两函数之外不再有裸 win.getSize()（语义漂移防扩散）')
  assert.ok(/chatWin\.getSize\(\)/.test(s), '对话框窗口 chatWin.getSize() 不在统一口径内，保留')
})

test('逃生网：30s 自愈带尺寸正反馈拉回（偏差超 max(40, 期望*0.25) 直接 setSizeDip）', () => {
  const s = src('main.js')
  assert.match(s, /const tolW = Math\.max\(40, expW \* 0\.25\)/, '宽阈值 max(40, 期望宽*0.25) 在位')
  assert.match(s, /const tolH = Math\.max\(40, expH \* 0\.25\)/, '高阈值 max(40, 期望高*0.25) 在位')
  assert.match(s, /Math\.abs\(w - expW\) > tolW \|\| Math\.abs\(h - expH\) > tolH.*setSizeDip\(expW, expH\)/s, '任一边超阈值 → 直接按期望尺寸 setSizeDip 拉回')
  assert.match(s, /const expW = Math\.round\(BASE_W \* curScale\)/, '期望宽 = round(BASE_W*curScale)')
  assert.match(s, /const expH = Math\.round\(fitBaseH \* curScale\)/, '期望高 = round(fitBaseH*curScale)')
})

// ---------- 三轮增量：按住微捏（.hold-squash，2026-11-07） ----------

/** 抠出 index.html 的 <style> 块（CSS 契约只查样式区，别把正文里的类名字符串也算进来）。 */
function styleBlock(s) {
  const m = s.match(/<style>[\s\S]*?<\/style>/)
  assert.ok(m, 'index.html 有 <style> 块')
  return m[0]
}

test('hold 微捏 CSS：.hold-squash 规则在位；#anim/#pet 常态 transform-origin: 50% 100%', () => {
  const css = styleBlock(src('index.html'))
  assert.match(css, /\.hold-squash[^}]*transform:\s*scale\(1\.08,\s*\.5\)/, '.hold-squash 微捏形变（2026-11-07 二次微调：横鼓 8%、下压 50%）')
  // 微调后的过渡时长：捏上/松开的形变带 .05s 平滑（原来没有 transition，会突跳）
  assert.match(css, /transition:\s*transform\s*\.05s ease-out/, 'hold/挤压形变带 .05s 过渡')
  // transform-origin 挪成常态（原来只挂在 .squashing 上）：#anim 与 #pet 的基础规则都要带
  assert.ok(/(#anim|\.anim-slot)[^{}]*\{[^}]*transform-origin:\s*50%\s*100%/.test(css), '动画层常态规则带底部原点（本地合并版是 .anim-slot）')
  assert.match(css, /#pet[^{}]*\{[^}]*transform-origin:\s*50%\s*100%/, '#pet 常态规则带底部原点')
  assert.match(css, /原来只挂在 \.squashing 上/, '常态原点的改动说明注释在位')
})

test('hold 微捏 JS：pointerdown 加类；pointerup 与 pointercancel 两路都经 shared 收尾移除', () => {
  const s = src('index.html')
  const down = s.slice(s.indexOf("stage.addEventListener('pointerdown'"))
  assert.match(down, /classList\.add\('hold-squash'\)/, 'pointerdown 路径加 .hold-squash（按住全程微捏）')
  // shared 收尾函数 releaseHold：pointerup / pointercancel 共用，函数体内移除类
  const rel = s.match(/const releaseHold\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\}/)
  assert.ok(rel, '有 shared 收尾函数 releaseHold')
  assert.match(rel[0], /classList\.remove\('hold-squash'\)/, 'releaseHold 内移除 .hold-squash')
  const callCount = (s.match(/releaseHold\(\)/g) || []).length
  assert.ok(callCount >= 2, `pointerup 与 pointercancel 两路都调用 releaseHold()（实测 ${callCount} 处调用）`)
})

test('450ms 捏捏契约仍在位：__squash + 气泡、一次按住最多一次，未被 hold 微捏改动碰掉', () => {
  const s = src('index.html')
  assert.match(s, /PINCH_DELAY_MS\s*=\s*450/, '捏触发时长 450ms（任务书默认值）')
  assert.match(s, /if\s*\(!dragging\s*\|\|\s*dragging\.moved\s*\|\|\s*dragging\.pinched\)\s*return/, '守卫：移动过/已触发不再触发')
  assert.match(s, /__squash\s*&&\s*(window\.)?__squash\(300\)/, '捏触发走 __squash（轻捏冲击档）')
  assert.match(s, /__bubble\(/, '捏伴随气泡文案')
  const clearCount = (s.match(/pinchTimer\s*=\s*null/g) || []).length
  assert.ok(clearCount >= 3, `松手/拖动/取消三条路径都清 pinchTimer（实测 ${clearCount} 处）`)
})

// ---------- 四轮增量：白屏自愈（render-process-gone / did-fail-load，2026-11-07） ----------

test('白屏自愈①：render-process-gone 挂钩 + reload 冷却（10s 内只救一次），正常退出不救', () => {
  const s = src('main.js')
  assert.match(s, /webContents\.on\('render-process-gone'/, '渲染进程崩溃挂钩在位')
  // 冷却：reloadForWhiteScreen 内先查 10s 冷却戳再 reload
  const fn = s.match(/const reloadForWhiteScreen\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\n  \}/)
  assert.ok(fn, '有 reloadForWhiteScreen 收口函数')
  assert.match(fn[0], /lastReloadAt < 10_000/, '10s 冷却戳在位（崩→重载→又崩不打满 CPU）')
  assert.match(fn[0], /lastReloadAt = now/, '进冷却')
  assert.match(fn[0], /webContents\.reload\(\)/, '冷却外才 reload')
  // 正常退出（clean-exit/exited）不算事故，不触发 reload
  assert.match(s, /d\.reason === 'clean-exit' \|\| d\.reason === 'exited'/, 'clean-exit/exited 正常退出放行不救')
  assert.match(s, /kind:\s*'render-gone'/, '崩溃救回走 debugIconLog 留痕')
})

test('白屏自愈②：did-fail-load 主框架重试 ≤2、-3 放行、did-finish-load 清计数', () => {
  const s = src('main.js')
  // 段落截到 did-finish-load 前（回调里有 debugIconLog({…}) 的 })，lazy 匹配会提前截断）
  const fail = s.match(/win\.webContents\.on\('did-fail-load'[\s\S]*?did-finish-load/)
  assert.ok(fail, 'did-fail-load 挂钩在位')
  assert.match(fail[0], /!isMain \|\| code === -3/, '只管主框架；-3(ABORTED) 主动中断放行')
  assert.match(fail[0], /loadRetryLeft <= 0\) return/, '重试余量耗尽就停（≤2，不无限重试）')
  assert.match(fail[0], /loadRetryLeft--/, '重试一次扣一次')
  assert.match(fail[0], /win\.loadFile\(/, '失败重试走 loadFile')
  assert.match(s, /win\.webContents\.on\('did-finish-load', \(\) => \{ loadRetryLeft = 2 \}\)/, 'did-finish-load 成功后计数回满')
  assert.match(s, /let loadRetryLeft = 2/, '初始重试余量 = 2')
  assert.match(s, /kind:\s*'load-fail'/, '加载失败走 debugIconLog 留痕')
})

// ---------- 五轮增量：小屋白屏兜底（house.html/house.js manifest 重试，2026-11-07） ----------

test('小屋兜底① house.js：manifest 拉取失败亮错误层 + 3s×20 次重试，成功收层，耗尽改口停机', () => {
  const s = readFileSync(join(CLIENT, 'house.js'), 'utf8')
  assert.match(s, /const BOOT_RETRY_MS = 3000/, '重试间隔 3s')
  assert.match(s, /const BOOT_RETRY_MAX = 20/, '重试上限 20 次')
  // boot 循环：失败 → showFatal 重试提示（带 attempt/上限计数）→ 3s 后再试；耗尽 → 改口 + break 停
  const boot = s.match(/async function boot\(\) \{[\s\S]*?\n\}/)
  assert.ok(boot, '有 boot() 启动重试循环')
  assert.match(boot[0], /loadPoses\(\)/, '循环里拉的就是 manifest（loadPoses → manifest.json）')
  assert.match(boot[0], /attempt >= BOOT_RETRY_MAX/, '重试计数与上限比较在位')
  assert.match(boot[0], /正在重试…（第 \$\{attempt\}\/\$\{BOOT_RETRY_MAX\} 次）/, '重试期错误层带 第 N/20 次计数文案')
  assert.match(boot[0], /showFatal\('小屋连不上插件，把桌宠关掉重开试试'\)/, '耗尽改口「重开试试」并停（不再打网络）')
  assert.match(boot[0], /hideFatal\(\)/, '任何一次成功就收掉错误层正常渲染')
})

test('小屋兜底② house.html：错误层元素（#fatal/#fatal-text）与样式在位；showFatal/hideFatal 有元素可操作', () => {
  const html = readFileSync(join(CLIENT, 'house.html'), 'utf8')
  assert.match(html, /<div id="fatal"><div class="card" id="fatal-text"><\/div><\/div>/, '错误层元素在位（box + 文案节点）')
  assert.match(html, /素材未就绪 \/ 加载失败的居中提示/, '错误层样式注释在位')
  // JS 侧 getElementById 与 HTML 的 id 对得上（对不上时 showFatal 直接 return，错误层永远不亮）
  const js = readFileSync(join(CLIENT, 'house.js'), 'utf8')
  assert.match(js, /getElementById\('fatal'\)/, 'showFatal/hideFatal 找得到 #fatal')
  assert.match(js, /getElementById\('fatal-text'\)/, 'showFatal 找得到 #fatal-text')
})

// ---------- 七轮增量：大字气泡 + 小屋加载幕 + 小屋窗自愈（2026-11-07） ----------

test('大字气泡：__bubble/showBubble 带 big 参数，#bubble.big 17px，余额传 big、hide 移除类', () => {
  const s = src('index.html')
  // 渲染侧：__bubble 收 big，toggle 到 #bubble.big；hide 时移除（大字号不漏给下一条普通气泡）
  assert.match(s, /__bubble = \(t, mood, secs, anim, playbackId, tag, emo, big\)/, '__bubble 第 8 参 big')
  assert.match(s, /bubble\.classList\.toggle\('big', big === true\)/, 'big===true 才进大字模式（不传不变）')
  assert.match(s, /bubble\.classList\.remove\('big'\)/, '气泡 hide 时移除 big 类')
  const css = styleBlock(s)
  assert.match(css, /#bubble\.big\s*\{\s*font-size:\s*17px/, '#bubble.big 大字号 17px')
  assert.match(css, /#bubble\.big #bubbleText\s*\{[^}]*-webkit-line-clamp:\s*4/, '大字模式放宽到 4 行截断')
  // 主进程侧：showBubble 透传 big；showBalance（余额）传 true
  const m = src('main.js')
  assert.match(m, /async function showBubble\(text, mood, modality, anim, playbackId, purpose, tagOverride[^)]*, big\)/, 'showBubble 末位参数 big（本地合并版中间还有 audio/voiceVolume）')
  assert.match(m, /big === true \? 'true' : 'false'/, '注入渲染页的 __bubble 调用透传 big')
  // 本地合并版没有独立的 showBalance 函数：余额播报写在右键菜单的 click 里
  const balIdx = m.indexOf("'余额', '', '', true)")
  assert.ok(balIdx > 0, '余额播报走 showBubble 且末位传 big=true')
})

test('小屋加载幕：house.html 默认 #boot「小屋加载中…」，house.js hideBoot 在成功/失败两路收幕', () => {
  const html = readFileSync(join(CLIENT, 'house.html'), 'utf8')
  assert.match(html, /<div id="boot"><div class="card">小屋加载中…<\/div><\/div>/, '默认加载幕元素在位（防止 JS 挂了留纯白屏）')
  assert.match(html, /#boot\s*\{/, '加载幕样式在位')
  const js = readFileSync(join(CLIENT, 'house.js'), 'utf8')
  const fn = js.match(/function hideBoot\(\) \{[\s\S]*?\n\}/)
  assert.ok(fn, '有 hideBoot 收幕函数')
  assert.match(fn[0], /getElementById\('boot'\)/, 'hideBoot 找得到 #boot（与 HTML id 对齐）')
  const boot = js.match(/async function boot\(\) \{[\s\S]*?\n\}/)
  assert.ok(boot, 'boot() 循环在位')
  assert.match(boot[0], /hideBoot\(\)/, 'boot 出结果就收幕')
  const calls = (boot[0].match(/hideBoot\(\)/g) || []).length
  assert.ok(calls >= 2, `成功与失败两路都收幕（实测 boot 内 ${calls} 处 hideBoot）`)
})

test('小屋窗自愈：openHouse 给 houseWin 挂 render-process-gone / did-fail-load，同主窗口径（冷却+重试≤2+留痕）', () => {
  const m = src('main.js')
  const seg = m.slice(m.indexOf("houseWin.webContents.on('render-process-gone'"), m.indexOf("houseWin.once('ready-to-show'"))
  assert.ok(seg.length > 0, '小屋窗自愈挂钩段落在位')
  assert.match(seg, /houseReloadAt < 10_000/, '崩溃 reload 走 10s 冷却')
  assert.match(seg, /houseWin\.webContents\.reload\(\)/, '冷却外 reload')
  assert.match(seg, /!isMainFrame \|\| code === -3/, '只管主框架；-3(ABORTED) 放行')
  assert.match(seg, /houseLoadRetryLeft <= 0\) return/, '加载失败重试 ≤2（余量耗尽就停）')
  assert.match(seg, /houseLoadRetryLeft--/, '重试扣计数')
  assert.match(seg, /houseWin\.loadFile\(/, '失败重试 loadFile')
  assert.match(seg, /houseQuery\(\)/, '重试 query 重新 readHost（端口漂移后拿最新 base/token）')
  assert.match(seg, /houseLoadRetryLeft = 2/, 'did-finish-load 成功后余量回满')
  assert.match(seg, /kind:\s*'house-render-gone'/, '崩溃留痕 house-render-gone')
  assert.match(seg, /kind:\s*'house-load-fail'/, '加载失败留痕 house-load-fail')
})
