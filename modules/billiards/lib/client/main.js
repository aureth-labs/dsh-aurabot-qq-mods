// 台球客户端主进程：只开窗，不做规则。规则与画面都在 arena.html 里。
// 由 billiards 模块以 `electron main.js` 分离进程启动。
const { app, BrowserWindow, screen, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')

const ANIMS_FILE = path.join(__dirname, 'anims.json')

// 先给自己一个独立身份，再谈开窗。不写这两行的话 app name 就是默认的 "Electron"，
// userData 落到 %APPDATA%\Electron —— 桌宠那份 app/ 里没有 package.json，名字一模一样，
// 于是两边抢同一把单实例锁：台球进程 requestSingleInstanceLock() 拿不到 → app.quit()，
// 窗都开不出来（面板还会以为起来了），顺带把桌宠的 second-instance 触发得它自己弹一下。
app.setName('aurabot-billiards')
app.setPath('userData', path.join(app.getPath('appData'), 'aurabot-billiards'))

/** 球面动画地址：模块侧每次启动前重写 anims.json，这里只读，不做任何网络请求。 */
function ballAnims() {
  try {
    const j = JSON.parse(fs.readFileSync(ANIMS_FILE, 'utf8'))
    return Array.isArray(j.urls) ? j.urls.filter((u) => typeof u === 'string' && u) : []
  } catch {
    return [] // 没素材包 / 文件读不了：普通球面，照样能打
  }
}

let arenaWin = null
const arenaAlive = () => Boolean(arenaWin && !arenaWin.isDestroyed())

// 桌面台球：球桌之外的地方一律点穿（窗口初始就是穿透的，页面把命中态报回来才吃鼠标）
ipcMain.on('arena:hit', (_e, hit) => {
  if (!arenaAlive()) return
  try { arenaWin.setIgnoreMouseEvents(!hit, { forward: true }) } catch {}
})
ipcMain.on('arena:exit', () => { if (arenaAlive()) arenaWin.close() })
ipcMain.on('billiards:anims', (e) => { e.returnValue = ballAnims() })

function openArena() {
  if (arenaAlive()) { arenaWin.show(); return }
  const area = screen.getPrimaryDisplay().workArea
  arenaWin = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'arena-preload.js'),
    },
  })
  arenaWin.setAlwaysOnTop(true, 'screen-saver')
  try { arenaWin.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  // 后台节流必须关：窗口一旦被挡住，Chromium 把 rAF 降到 1fps，台球物理变慢动作
  try { arenaWin.webContents.setBackgroundThrottling(false) } catch {}
  arenaWin.once('ready-to-show', () => { try { arenaWin.show() } catch {} })
  arenaWin.on('closed', () => { arenaWin = null })
  arenaWin.loadFile(path.join(__dirname, 'arena.html'))
    .catch((e) => console.error('桌面台球加载失败：', e && e.message))
}

// 面板连点两次「打开」应该回到已有窗口，而不是再起一个 Electron（两副球桌会打起来）
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => openArena())
  app.whenReady().then(() => openArena())
}
app.on('window-all-closed', () => app.quit())
