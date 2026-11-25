// Aurabot 桌宠预加载脚本（模板/生成物）：给渲染页开一个极小的受控桥。
// 只暴露拖拽/抛掷需要的四样东西，不给 Node 能力（contextIsolation 保持开着）。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  /** 主进程权威拖拽·开始（2026-11-07 新增）：渲染页 pointerdown 只发信号不传坐标——
   *  主进程自己读 screen.getCursorScreenPoint() 记 grabOffset 并起 60fps 挪窗循环。
   *  旧渲染页自算坐标（screenInfo + e.screenX）在穿透窗 + setZoomFactor 下会错位（拖拽偏移根因）。 */
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  /** 拖拽·心跳（新增）：pointermove 按 rAF 节流发一次，不带坐标，只证明「指针还按着」。
   *  真实挪窗与轨迹采样全在主进程循环里，渲染页不再参与几何计算。 */
  dragMove: () => ipcRenderer.send('pet:drag-move'),
  /** 拖拽·结束（新增）：isClick=true 表示原地轻点（位移 <6px），主进程原地掉落（受 releaseLand 门控）；
   *  false 则由主进程用 DIP 轨迹估初速决定甩抛或温柔放下。 */
  dragEnd: (isClick) => ipcRenderer.send('pet:drag-end', Boolean(isClick)),
  /** 把窗口挪到绝对位置（拖拽时按指针位移换算出的左上角）。旧通道保留：兼容老渲染页/调试脚本。 */
  moveTo: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  /** 甩抛：主进程接管物理循环，落定后回调 __onThrowEnd。 */
  throwWith: (vx, vy) => ipcRenderer.send('pet:throw', { vx, vy }),
  /** 当前工作区与窗口几何：{W,H,x,y,size}（renderer 算拖拽边界/初速参考系用）。 */
  screenInfo: () => ipcRenderer.invoke('pet:screen'),
  /** 停住主进程的抛掷循环（例如用户在飞行中又按住）。 */
  stopThrow: () => ipcRenderer.send('pet:throw-stop'),
  /** 窗口贴合内容：渲染页按「气泡是否显示/气泡实际高度」上报需要的基础高度（缩放前 px），
   *  主进程按当前倍率换算后向上长高/向下缩回，避免 430 高的透明空白常驻（底边不动，桌宠不跳）。 */
  fitWindow: (baseH) => ipcRenderer.send('pet:fit', Number(baseH) || 0),
  /** 命中检测上报：true=悬停在宠物/气泡上（窗口恢复交互），false=在透明区（点击穿透）。 */
  setHit: (hit) => ipcRenderer.send('pet:hit', Boolean(hit)),
  /** 右键菜单：渲染页 contextmenu → 主进程弹原生菜单（仿 dsh-pet 的右键菜单）。 */
  showMenu: () => ipcRenderer.send('pet:menu'),
  /** 反应层①点击桌宠上报：渲染页单击（非拖拽）时调用，主进程触发「撒娇+追鼠标」。 */
  reportClick: () => ipcRenderer.send('pet:click'),
  /** 主动连上插件问一次配置/状态（菜单项「换个动作」等需要确认在线时用，可选）。 */
  ping: () => ipcRenderer.send('pet:ping'),
})
