// 台球：把桌宠里的「肥鱼台球」拆成独立模块（八球规则 + 整个桌面当球桌）。
//
// 结构：
//   lib/client/    Electron 客户端模板（页面 + 规则引擎 + 主进程），生成到数据目录 app/ 再跑
//   lib/anims.mjs  球面皮肤：读桌宠素材包的 idle 动画，换成 file:/// 地址（纯函数）
//   lib/electron.mjs 运行时的定位与启动参数（纯函数）
//
// 数据全写 api.dataDir()，模块文件夹本身只读。渲染页零网络：素材是本地文件，规则在页面里。
// 不自动下载任何东西：Electron 先用桌面上现成的（本模块装过的 > 桌宠装过的），
// 两处都没有就在面板点「安装 Electron」，由本机 npm 装一次；不点就什么都不发生。

import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAnims, packNames, pickPack } from './lib/anims.mjs'
import {
  ELECTRON_VERSION, cleanElectronEnv, electronCandidates, electronRelExe, mirrorUrl, npmCliCandidates,
} from './lib/electron.mjs'

const CLIENT_FILES = ['main.js', 'arena-preload.js', 'arena.html', 'billiards-rules.js']

export const DEFAULTS = {
  ballSkin: 'pack',          // pack = 球面披桌宠素材包的动画；plain = 普通色球
  electronMirror: '',        // 装 Electron 的镜像；留空用内置默认（npmmirror）
}

export default {
  id: 'billiards',
  name: '台球',
  version: '1.0.0',
  api: 1,
  description: '桌宠那台台球桌搬出来了：拖白球出杆打八球，整个桌面当球桌，球桌以外照常点东西。',
  panel: 'panel.js',
  defaults: DEFAULTS,
  settings: [
    { key: 'ballSkin', label: '球面', type: 'select', options: [{ value: 'pack', label: '桌宠素材（每颗球一只小鲸鱼）' }, { value: 'plain', label: '普通球面' }], hint: '装了桌宠模块才有素材可借；没装或没找到就是普通球面，不影响打球' },
    { key: 'electronMirror', label: 'Electron 安装镜像', type: 'text', placeholder: 'https://npmmirror.com/mirrors/electron/', hint: `只在面板点「安装 Electron」时用到（本模块不会自己下载）。留空用 npmmirror；慢了就换 https://github.com/electron/electron/releases/download/。装的是钉死的 ${ELECTRON_VERSION} 版` },
  ],

  setup(api) {
    const s = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    // 测试钩子：注入假 spawn / kill / 存活探测 / exists，就能验开收窗的分支而不真起 Electron
    const hooks = api.__billiardsTestHooks || {}
    const spawnFn = hooks.spawn || nodeSpawn
    const exists = hooks.exists || existsSync
    const isAlive = hooks.alive || ((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
    const killFn = hooks.kill || ((pid) => process.kill(pid))

    const appDir = () => api.dataDir('app')
    const petDir = () => join(api.dataDir(), '..', 'pet')
    const procFile = () => api.dataDir('process.json')

    const readJson = (file, fallback = null) => {
      try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
    }
    const hash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12)

    // ---------- 客户端落位：模板 → 数据目录 app/（只补缺的和过期的，不碰用户手改的） ----------
    function syncClient() {
      mkdirSync(appDir(), { recursive: true })
      const srcDir = join(api.dir, 'lib', 'client')
      const copied = []
      const missing = []
      for (const name of CLIENT_FILES) {
        const from = join(srcDir, name)
        const to = join(appDir(), name)
        if (!exists(from)) { missing.push(name); continue }
        let same = false
        try { same = exists(to) && hash(readFileSync(to)) === hash(readFileSync(from)) } catch { same = false }
        if (same) continue
        try { copyFileSync(from, to); copied.push(name) } catch { missing.push(name) }
      }
      // 数据目录里那份 package.json：没有 type 字段 = main.js 按 CommonJS 走（Electron 要的就是这个）
      if (!exists(join(appDir(), 'package.json'))) {
        try { writeFileSync(join(appDir(), 'package.json'), JSON.stringify({ private: true, version: '1.0.0' }, null, 2)) } catch {}
      }
      return { copied, missing, ready: missing.length === 0 }
    }

    // ---------- 球面皮肤：借桌宠素材包，落成 file:/// 地址表 ----------
    function writeAnims() {
      const conf = s()
      mkdirSync(appDir(), { recursive: true })
      let result = { pack: '', urls: [] }
      if (conf.ballSkin === 'pack') {
        try {
          const packsDir = join(petDir(), 'packs')
          const names = packNames(exists(packsDir)
            ? readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
            : [])
          const pet = typeof api.use === 'function' ? api.use('pet') : null
          const pack = pickPack(names, String((pet && typeof pet.activePack === 'function' ? pet.activePack() : '') || ''))
          const dir = join(packsDir, `${pack}-animation`)
          if (pack && exists(dir)) {
            const files = readdirSync(dir)
            const prefer = (pet && pet.packView && pet.packView()?.animations?.idle) || []
            result = buildAnims({ pack, dir, files, prefer })
          }
        } catch (error) { api.log.warn('读桌宠素材包失败，这局用普通球面：', String(error?.message || error)) }
      }
      try { writeFileSync(join(appDir(), 'anims.json'), JSON.stringify(result, null, 2)) } catch {}
      return { pack: result.pack, count: result.urls.length }
    }

    // ---------- 运行时 ----------
    function locateElectron() {
      const rel = electronRelExe()
      for (const c of electronCandidates({ appDir: appDir(), petDir: exists(petDir()) ? petDir() : '' })) {
        const exe = join(c.dir, ...rel)
        if (exists(exe)) return { exe, source: c.source }
      }
      return null
    }
    function recorded() {
      const p = readJson(procFile(), null)
      if (!p || !Number.isInteger(p.pid) || p.pid <= 0) return null
      if (!isAlive(p.pid)) {
        try { unlinkSync(procFile()) } catch {}
        return null
      }
      return p
    }
    function stopProcess() {
      const p = recorded()
      if (!p) return { ok: false, message: '台球没在运行' }
      try { killFn(p.pid) } catch (error) {
        if (String(error?.code) !== 'ESRCH') return { ok: false, message: '停止失败：' + String(error?.message || error).slice(0, 120) }
      }
      try { unlinkSync(procFile()) } catch {}
      api.log.info(`台球已停止（pid ${p.pid}）`)
      return { ok: true, pid: p.pid, message: `台球已停止（pid ${p.pid}）` }
    }

    function openArena() {
      const client = syncClient()
      if (!client.ready) return { ok: false, message: `客户端文件不全（缺 ${client.missing.join('、')}）：模块文件夹被动过，重装一次` }
      const anims = writeAnims()
      const running = recorded()
      // 已经开着就别再起第二个 Electron：两副球桌会抢同一把单实例锁，后起的那个直接自杀
      if (running) return { ok: true, alreadyRunning: true, pid: running.pid, message: '球桌已经开着了，要重开先点「关掉台球」' }
      const found = locateElectron()
      if (!found) return { ok: false, message: '还没装 Electron：先在面板点「安装 Electron」（或装好桌宠复用它的运行时）' }
      try {
        const child = spawnFn(found.exe, ['main.js'], {
          cwd: appDir(),
          env: cleanElectronEnv(),
          detached: true, stdio: 'ignore', windowsHide: true,
        })
        // 没人听 error 事件就是未捕获异常，会带走整个 DSH 进程
        child.on?.('error', (error) => api.log.warn('台球启动失败：', error.message))
        child.unref?.()
        const rec = { pid: child.pid, startedAt: Date.now() }
        try { writeFileSync(procFile(), JSON.stringify(rec)) } catch {}
        api.log.info(`台球已启动（桌面球桌，pid ${child.pid}，素材 ${anims.count} 段）`)
        return { ok: true, pid: child.pid, anims, exe: found.exe, message: '桌面球桌已打开：收工点 HUD 上的「退出台球」（这窗口不抢键盘，Esc 不起作用）' }
      } catch (error) {
        return { ok: false, message: '启动失败：' + String(error?.message || error).slice(0, 160) }
      }
    }

    async function electronInstall() {
      const found = locateElectron()
      if (found) return { ok: true, alreadyInstalled: true, exe: found.exe, source: found.source, message: `已经有 Electron 了（${found.source === 'pet' ? '桌宠装的那份' : '本模块装的那份'}），不用重复装` }
      syncClient()
      // 测试注入 npmCli='' 就能走「没有 npm」的分支，绝不去真跑一次 npm install
      const cli = 'npmCli' in hooks ? hooks.npmCli : npmCliCandidates(process.execPath).find((c) => exists(c))
      if (!cli) return { ok: false, message: `这台机器上没找到可用的 npm。手动装一次即可（只需一次）：在 ${appDir()} 运行 npm install -D electron@${ELECTRON_VERSION}` }
      const mirror = mirrorUrl(s().electronMirror)
      const out = await new Promise((resolve) => {
        let tail = ''
        let child = null
        try {
          child = spawnFn(process.execPath, [cli, 'install', '-D', `electron@${ELECTRON_VERSION}`], {
            cwd: appDir(), env: { ...process.env, ELECTRON_MIRROR: mirror }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) { return resolve({ code: -1, tail: String(error?.message || error) }) }
        child.stdout?.on?.('data', (d) => { tail = (tail + String(d)).slice(-2000) })
        child.stderr?.on?.('data', (d) => { tail = (tail + String(d)).slice(-2000) })
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve({ code: -1, tail, timeout: true }) }, 10 * 60_000)
        child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, tail: tail + String(error?.message || error) }) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, tail }) })
      })
      const now = locateElectron()
      if (out.code === 0 && now) return { ok: true, installed: true, exe: now.exe, message: `Electron ${ELECTRON_VERSION} 装好了（镜像 ${mirror}）` }
      const why = out.timeout ? 'npm 安装超时（10 分钟）' : `npm 退出码 ${out.code}`
      api.log.warn('Electron 安装失败：', why, String(out.tail || '').slice(-200))
      return { ok: false, exitCode: out.code, message: `${why}，没装上。${String(out.tail || '').slice(-200) || '看看是不是镜像连不上，可在设置里换一个。'}` }
    }

    function status() {
      const client = { ready: true, missing: [] }
      for (const name of CLIENT_FILES) if (!exists(join(appDir(), name))) client.missing.push(name)
      client.ready = client.missing.length === 0
      const found = locateElectron()
      const anim = writeAnims() // 面板每次看状态都重算：换素材包/改 ballSkin 当场看得出来
      const running = recorded()
      return {
        ok: true,
        client,
        electron: found ? { exe: found.exe, source: found.source } : null,
        anims: anim,
        running: Boolean(running), pid: running?.pid || null,
        appDir: appDir(),
        message: !client.ready ? `客户端还没生成齐（缺 ${client.missing.join('、')}）`
          : !found ? '还没装 Electron：点「安装 Electron」'
            : running ? `台球运行中（桌面球桌，pid ${running.pid}）`
              : '待命：点「桌面球桌」',
      }
    }

    // ---------- 路由（面板 call 用；都是无参 GET，不读请求体） ----------
    api.route('/status', () => status())
    api.route('/open-arena', () => openArena())
    api.route('/close', () => stopProcess())
    api.route('/electron-install', async () => electronInstall())

    // 开机把模板铺好（纯本地复制），面板第一次打开就能看到状态
    try { syncClient() } catch (error) { api.log.warn('台球客户端生成失败：', String(error?.message || error)) }
  },
}
