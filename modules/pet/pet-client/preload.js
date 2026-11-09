// Aurabot 桌宠预加载脚本（模板/生成物）：给渲染页开一个极小的受控桥。
// 只暴露拖拽/抛掷需要的四样东西，不给 Node 能力（contextIsolation 保持开着）。
const { contextBridge, ipcRenderer } = require('electron')

// 多开实例（第二个及以后的桌宠）走自己的通道前缀：主宠物的 pet:* 那套 handler 只认主窗口，
// 复用同一组会去改主宠物的窗口（拖小只会把大只拖走）。main.js 建额外窗口时带 --pet-extra=1。
const EXTRA = (() => {
  try {
    const q = String(process.argv.find((a) => a.startsWith('--pet-extra=')) || '')
    if (q) return 'pet:extra:'
    return ''
  } catch { return '' }
})()
// 槽位（0 起）：额外那几只按位置固定成 pet-1..pet-4，渲染页要知道「我是哪一只」——
// 插件推来的气泡带 petId，只有对上的那只才在自身上长气泡。
const SLOT = (() => {
  try {
    const q = String(process.argv.find((a) => a.startsWith('--pet-slot=')) || '')
    if (!q) return -1
    const n = Number(q.split('=')[1])
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : -1
  } catch { return -1 }
})()
const CH = (name) => (EXTRA ? 'pet:extra:' + name.replace(/^pet:/, '') : name)

contextBridge.exposeInMainWorld('petBridge', {
  /** 是不是多开出来的第二只（渲染页据此关掉托盘/右键菜单这些「只有一只该有」的能力）。 */
  isExtra: Boolean(EXTRA),
  /** 第几只额外宠物（-1 = 主宠物）。气泡、素材表都按它区分。 */
  slot: SLOT,
  /** 这只宠物自己的 id，与主进程 petRegistry / 插件事件里的 petId 完全同源。 */
  petId: EXTRA && SLOT >= 0 ? `pet-${SLOT + 1}` : 'main',
  /** 主进程权威拖拽·开始（上游 1.0.15）：渲染页 pointerdown 只发信号不传坐标——
   *  主进程自己读 screen.getCursorScreenPoint() 记 grabOffset 并起 60fps 挪窗循环。
   *  旧渲染页自算坐标（screenInfo + e.screenX）在穿透窗 + setZoomFactor 下会错位（拖拽偏移根因）。
   *  多开的那几只走 CH() 前缀：主进程给 extra 窗口单独注册了 pet:extra:drag-*。 */
  dragStart: () => ipcRenderer.send(CH('pet:drag-start')),
  /** 拖拽·心跳：pointermove 按 rAF 节流发一次，不带坐标，只证明「指针还按着」。
   *  真实挪窗与轨迹采样全在主进程循环里，渲染页不再参与几何计算。 */
  dragMove: () => ipcRenderer.send(CH('pet:drag-move')),
  /** 拖拽·结束：isClick=true 表示原地轻点（位移 <6px），主进程原地掉落（受 releaseLand 门控）；
   *  false 则由主进程用 DIP 轨迹估初速决定甩抛或温柔放下。 */
  dragEnd: (isClick) => ipcRenderer.send(CH('pet:drag-end'), Boolean(isClick)),
  /** 把窗口挪到绝对位置（拖拽时按指针位移换算出的左上角）。旧通道保留：兼容老渲染页/调试脚本。 */
  moveTo: (x, y) => ipcRenderer.send(CH('pet:move'), { x, y }),
  /** 甩抛：主进程接管物理循环，落定后回调 __onThrowEnd。 */
  throwWith: (vx, vy) => ipcRenderer.send(CH('pet:throw'), { vx, vy }),
  /** 当前工作区与窗口几何：{W,H,x,y,size}（renderer 算拖拽边界/初速参考系用）。 */
  screenInfo: () => ipcRenderer.invoke(CH('pet:screen')),
  /** 停住主进程的抛掷循环（例如用户在飞行中又按住）。 */
  stopThrow: () => ipcRenderer.send(CH('pet:throw-stop')),
  /** 窗口贴合内容：渲染页按「气泡是否显示/气泡实际高度」上报需要的基础高度（缩放前 px），
   *  主进程按当前倍率换算后向上长高/向下缩回，避免 430 高的透明空白常驻（底边不动，桌宠不跳）。 */
  fitWindow: (baseH) => ipcRenderer.send(CH('pet:fit'), Number(baseH) || 0),
  /** 命中检测上报：true=悬停在宠物/气泡上（窗口恢复交互），false=在透明区（点击穿透）。 */
  setHit: (hit) => ipcRenderer.send(CH('pet:hit'), Boolean(hit)),
  /** 拖拽租约上报：true=正在拖（主进程在此期间绝不改穿透），false=松手了。
   *  不加这条的话，光标轮询兜底会在拖拽中途按位置判定把窗口翻成穿透，
   *  导致 pointermove/pointerup 断掉——表现就是「拖到一半突然不动了」。 */
  setBusy: (busy) => ipcRenderer.send(CH('pet:busy'), Boolean(busy)),
  /** 右键菜单：渲染页 contextmenu → 主进程弹原生菜单（仿 dsh-pet 的右键菜单）。 */
  showMenu: () => ipcRenderer.send('pet:menu'),
  /** 反应层①点击桌宠上报：渲染页单击（非拖拽）时调用，主进程触发「撒娇+追鼠标」。 */
  reportClick: () => ipcRenderer.send('pet:click'),
  /** 主动连上插件问一次配置/状态（菜单项「换个动作」等需要确认在线时用，可选）。 */
  ping: () => ipcRenderer.send('pet:ping'),
  /** 诊断：把渲染页里的拖拽链路状态写到主进程日志（查「拖不动」用）。 */
  diag: (tag, data) => ipcRenderer.send('pet:diag', { tag: String(tag), data }),

  // ---------- 多桌宠碰撞（dsh-pet 的 broker 协议）----------
  /** 上报自己的实时位置/速度：主进程汇总后广播给所有窗口，别的窗口据此做碰撞检测。
   *  单位是**屏幕物理像素**（与 broker 一致），渲染页负责 ×scale。 */
  reportFlight: (state) => ipcRenderer.send('pet:flight', state),
  /** 告诉主进程「我撞到了 targetId，它的新初速是 vx/vy」：主进程转发给被撞方窗口。 */
  reportCollide: (targetId, vx, vy) => ipcRenderer.send('pet:collide', { targetId, vx, vy }),
  /** 订阅其它宠物的实时状态：{ petId: {x,y,vx,vy,size,bottomPad} }。 */
  onFlightStates: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const h = (_e, states) => { try { cb(states) } catch {} }
    ipcRenderer.on('pet:flight-states', h)
    return () => ipcRenderer.removeListener('pet:flight-states', h)
  },
  /** 订阅「我被别的宠物撞了」：主进程把动量结果推过来，自己 startThrow 接住。 */
  onCollideHit: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const h = (_e, v) => { try { cb(v) } catch {} }
    ipcRenderer.on('pet:collide-hit', h)
    return () => ipcRenderer.removeListener('pet:collide-hit', h)
  },
  /** 悬停热键：sleep-toggle / chat-toggle / todo-toggle / hear-start / hear-stop。 */
  hotkey: (action) => ipcRenderer.send('pet:hotkey', String(action)),
  /** 按住说话：把录好的 WAV（base64，16kHz/单声道/PCM16）交给主进程转文字。
   *  返回 {ok, text} 或 {ok:false, message}；识别成功后的去向（发对话框 / 只填输入框）由主进程决定。 */
  hear: (base64) => ipcRenderer.invoke('pet:hear', String(base64 || '')),
  /** 录音期视觉反馈：起录 / 结录时通知主进程（气泡提示「在听…」之类）。 */
  hearState: (state) => ipcRenderer.send('pet:hear-state', String(state || '')),
  /** 拖图到桌宠身上：把图片路径交给主进程（打开对话框并挂成待发送图）。 */
  dropImage: (filePath) => ipcRenderer.send('pet:drop-image', String(filePath || '')),
  /** 控件矩形上报（dsh-pet 的 syncInputRegions）：菜单/对话框这类浮层平时长在
   *  窗口的透明余量区里，光标离开身体就会穿透，导致点不到。把它们的矩形报给主进程，
   *  主进程在 busy 期间按矩形判定「这里也算可交互」。 */
  setInputRegions: (input) => ipcRenderer.send('pet:input-regions', input || { dragging: false, rects: [] }),
  /** 自己走位（2026-11-05，dsh-pet 的 move 档）：渲染页掷骰掷到「走位」时调它，
   *  主进程按工作区挑一个近处的落点、匀速走过去，途中自动播踏步动画。
   *  返回 Promise<{ok, reason}>：busy = AI 行为正在移动，这一次让给它。
   *  opts 还可以带「有明确目的地」的两个玩法参数（吃白饭用）：
   *    · dx: 数字 → 目标 = 当前身体中心 + dx（追饭时横着走）
   *    · align: 'bottom' → 目标 = 工作区底部（跑向屏幕底部那一相位）
   *    · speed / maxMs / owner → 速度、超时与互斥归属。 */
  walk: (opts) => ipcRenderer.invoke('pet:walk', opts || {}),
  /** 自截图（诊断「动画有没有被切」用）：返回 data URL。
   *  走 capturePage 抓的是渲染进程自己的画面，透明背景不会混进桌面壁纸；
   *  比从屏幕坐标 CopyFromScreen 靠谱（后者会把底下的浏览器窗口一起抓进来）。 */
  snapshot: () => ipcRenderer.invoke('pet:snapshot'),
})
