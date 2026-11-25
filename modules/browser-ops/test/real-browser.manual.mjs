// real-browser.manual.mjs —— 真机层测试（手动跑，不进 npm test / 打包）
// 用法：node --import ./scripts/plugin-env.mjs modules/browser-ops/test/real-browser.manual.mjs
// 作用：真实启动 CDP 专用浏览器（登录资料只用临时 dataDir 的 browser-profile，绝不碰
//       日常浏览器），走 runTask 指令注入的真实路径：launch → navigate example.com →
//       snapshot(dom/a11y) → 搜索页 clickSelector/input/pressEnter → screenshot → close，
//       并验证 close 后我们启动的浏览器进程树无残留。
// 契约：只输出实测结果，不写模块源码目录的任何数据；profileDir 由环境变量
//       BROWSER_OOPS_DATA_DIR 覆盖（缺省用系统临时目录）。

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import mod from '../index.mjs'

// ---- 临时 dataDir（等同插件数据目录语义，与主人日常环境完全隔离）----
const dataDir = process.env.BROWSER_OOPS_DATA_DIR || mkdtempSync(join(tmpdir(), 'browser-ops-real-'))

// 记录真机启动前的 msedge/chrome 进程数（对照用；只强校验「我们启动的那个 pid」无残留）
const listBrowserPids = (name) => {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/).filter((l) => l.startsWith(`"${name}"`)).length
  } catch { return -1 }
}
const before = { edge: listBrowserPids('msedge.exe'), chrome: listBrowserPids('chrome.exe') }
console.log(`[真机] 启动前浏览器进程数：msedge=${before.edge} chrome=${before.chrome}（含主人自己开的，只对照不强校验）`)

// ---- 最小 fake api（同单测的装配方式，但底下是真 createBrowser、真网络）----
const routes = {}
const api = {
  dataDir: (f) => (f ? join(dataDir, f) : dataDir),
  settings: () => ({ ...mod.defaults, enabled: true }),
  log: { info: (t) => console.log('[log]', t), warn: (t) => console.log('[warn]', t), error: (t) => console.log('[error]', t) },
  route: (p, fn) => { routes[p] = fn },
  command: () => {},
  tool: () => {},
  defineTool: (t) => t,
  onDispose: () => {},
  core: { hub: { turnSendersAllOwner: () => true }, http: { body: async () => ({}) } },
}
const face = mod.setup(api)

const results = []
const step = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ step: name, ok: true, detail })
    console.log(`✅ ${name}${detail ? ' —— ' + detail : ''}`)
    return detail
  } catch (e) {
    results.push({ step: name, ok: false, detail: e.message })
    console.log(`❌ ${name} —— ${e.message}`)
    throw e
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ourPid = 0

try {
  // 1. launch：真启动专用浏览器（屏幕外窗口）
  await step('① launch 真实启动专用浏览器', async () => {
    const r = await face.launch('真机测试')
    if (!r.ok) throw new Error(r.message)
    const st = face.status()
    ourPid = st.pid
    if (!st.connected || !st.port || !st.pid) throw new Error(`状态不对：${JSON.stringify(st)}`)
    return `已连接，端口 ${st.port}，主进程 pid ${st.pid}，资料目录 ${st.profileDir}`
  })

  // 2. runTask 走真实注入路径：navigate example.com + 快照 + 指引注入核对
  const task = await step('② runTask(https://example.com) 指引注入+快照', async () => {
    const t = await face.runTask({ goal: '读一下这个页面讲了什么', url: 'https://example.com' })
    if (!t.ok) throw new Error(t.message)
    if (!t.message.startsWith('【总纲 · 主流程】')) throw new Error('返回顶部没有注入总纲')
    if (!t.guide.includes('【读页 · 场景手册】')) throw new Error('没有按目标挑中读页手册：' + t.guide.slice(0, 80))
    if (!t.text.includes('Example Domain')) throw new Error('快照里没有读到 Example Domain：' + t.text.slice(0, 200))
    return `message 长度 ${t.message.length}，注入 ${t.guide.length} 字指引，快照含「Example Domain」`
  })

  // 3. snapshot a11y：无障碍树也要真实读回
  await step('③ snapshot(a11y) 无障碍树', async () => {
    const s = await face.snapshot({ mode: 'a11y', maxChars: 2000 })
    if (!s.ok) throw new Error('a11y 快照失败')
    if (!s.text.includes('Example Domain')) throw new Error('a11y 树没读到 Example Domain：' + s.text.slice(0, 200))
    return `树文本 ${s.text.length} 字，含「Example Domain」`
  })

  // 4. 搜索页：navigate → clickSelector 输入框 → input → pressEnter
  await step('④ 搜索页 clickSelector/input/pressEnter', async () => {
    const nav = await face.navigate('https://www.bing.com')
    if (!nav.ok) throw new Error('打不开必应：' + (nav.message || ''))
    const clicked = await face.clickSelector('textarea[name="q"], input[name="q"]')
    if (!clicked.ok || !clicked.found) throw new Error('没找到搜索框')
    await face.input('Example Domain')
    await face.pressEnter()
    await sleep(4000) // 等结果页加载
    const s = await face.snapshot({ mode: 'dom', maxChars: 3000 })
    if (!s.ok || s.text.length < 100) throw new Error('结果页快照异常：' + s.text.slice(0, 120))
    return `搜索已提交，结果页快照 ${s.text.length} 字（首行：${s.text.split('\n')[0]}）`
  })

  // 5. screenshot：dataURL 非空
  const shot = await step('⑤ screenshot 截屏', async () => {
    const data = await face.screenshot()
    if (!data.startsWith('data:image/png;base64,')) throw new Error('截图 dataURL 异常：' + data.slice(0, 60))
    return `dataURL ${data.length} 字节`
  })

  // 6. close：进程树清干净（只校验我们启动的主进程 pid）
  await step('⑥ close 并确认无残留进程', async () => {
    await face.close()
    const st = face.status()
    if (st.connected) throw new Error('close 后仍显示已连接')
    await sleep(1500) // 给 taskkill 进程树一点时间
    const alive = (() => {
      try {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${ourPid}`, '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
        return out.includes(`"${ourPid}"`)
      } catch { return true }
    })()
    if (alive) throw new Error(`主进程 pid ${ourPid} 还活着，进程树没清干净`)
    return `状态归零，主进程 pid ${ourPid} 已退出`
  })

  console.log('\n=== 真机层全部通过 ===')
  console.log(JSON.stringify(results, null, 2))
  void shot; void task
} catch {
  console.log('\n=== 真机层存在失败步骤 ===')
  console.log(JSON.stringify(results, null, 2))
  // 失败也要尽力关浏览器，不留半死进程
  try { await face.close() } catch { /* 已关或没开 */ }
  process.exitCode = 1
}
