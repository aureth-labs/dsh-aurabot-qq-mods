// 一键安装小屋世界：从 GitHub Release 下载 CabinWorld-win64.zip，解压到游戏目录，
// 保留已有的 data/（存档）。Windows 专用（游戏是 Windows x64 原生程序）。
//
// 只用 Node 标准库 + 系统自带 tar.exe / PowerShell。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { killBridge, hostPidFile, ensureHost, startHost, killGame, hostBridgeAlive, waitBridge, PATCHES } from './host.mjs'
import { exePath, readJsonFile, configPath } from './exe.mjs'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'BabyBus2022/cabin-world'
const UA = 'aurabot-cabinworld-installer'
const API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest'
const ZIP_RE = /\.zip$/i
const WIN_RE = /win64|windows|win-x64/i
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com']
// 装法：包里有的一律装，只有这几样必须留着用户自己的 ——
// 白名单式的“只装认识的”会漏掉新版本新增的文件（1.0 时代的白名单就漏了 1.1 的
// update.cmd、PATCH-CHOICES.json 等 6 个），以后上游再加东西也不会漏。
// 解压单个 tar 的上限。287 MB 在慢盘上可能要好几分钟，但挂住不动基本就是出错了。
const UNZIP_TIMEOUT_MS = 20 * 60 * 1000
// 列目录是秒级操作，挂住基本就是出错了，不该让用户干等 20 分钟。
const LIST_TIMEOUT_MS = 2 * 60 * 1000
// 装完重新起桥要等多久才算「连上」。和 restartBridge（25 秒）、waitGame（默认 20 秒）取同一个量级：
// 桥通常 3-10 秒连上，慢盘/杀软下更久，太短会让装成功也报「没连上」。
const WAIT_BRIDGE_MS = 20000

const KEEP_TOP = new Set(['data', 'backups', '__download', '__unpack', '.git', '.gitignore', '.github', 'node_modules', 'bridge-host', '.installing'])
// 官方包会带的顶层条目：清理旧版本残留时只碰这些。
// 注意这和上面的 KEEP_TOP 是两种方向的白名单，不要混：
//   - 装包：包里有什么就装什么（新版本新增的文件不会被漏掉）
//   - 清理：只删这张表里的（用户自建的东西一概不碰）
// CHANGELOG-1.x.md / PATCH-日期.* 会随版本改名，所以用前缀匹配。
const UPSTREAM_TOP = new Set(['bridge', 'docs', 'examples', 'game', 'third-party', 'tools',
  'CabinWorld.exe', 'INSTALL-AI.md', 'LICENSE', 'LICENSE-NOTES.md', 'README.md',
  'SOURCE.txt', 'cabinworld.ini', 'selfcheck.cmd', 'start.cmd', 'update.cmd', 'PATCH-CHOICES.json'])
// 前缀要贴着上游的真实命名，不能用宽前缀：用户自己在游戏根目录放一个
// 「PATCH-笔记.txt」或「CHANGELOG-草稿.md」，宽前缀会把它当旧残留删掉。
const UPSTREAM_PREFIX_RE = [/^CHANGELOG-\d+\.\d+\.md$/, /^PATCH-\d{8}\.(json|md)$/]
function isUpstreamTop(name) {
  if (UPSTREAM_TOP.has(name)) return true
  return UPSTREAM_PREFIX_RE.some(function (re) { return re.test(name) })
}
// 桥配置要保留（displayName、hostName、端口、dataDir 都在里面），官方升级说明也要求不得用包内示例覆盖。
const KEEP_REL = new Set([path.join('bridge', 'bridge.config.json')])

function assertAssetUrl(url) {
  let parsed
  try { parsed = new URL(String(url || '')) } catch (e) { throw new Error('下载地址不对：' + String(url || '(空)')) }
  const host = parsed.hostname.toLowerCase()
  const ok = parsed.protocol === 'https:' && (ASSET_HOSTS.indexOf(host) >= 0 || host.endsWith('.githubusercontent.com'))
  if (!ok) throw new Error('不从 ' + host + ' 下载：只允许 GitHub 的下载地址')
}

/** 找 release 里该下的那个 zip：先认游戏名，再退到 win64，最后才拿第一个。 */
export function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const zips = assets.filter(a => a && ZIP_RE.test(String(a.name || '')) && Number(a.size) > 0)
  if (!zips.length) return null
  // 同一个 release 里还挂着 CharacterStudio 的 win64 包（158 MB）和增量补丁包
  // （CabinWorld-1.1-usage-patch-incremental.zip.zip，也叫 CabinWorld 但不带 win64），
  // 所以两个条件都要满足才算游戏包；退路是「带 win64」，最后才拿第一个。
  return zips.find(a => /cabinworld/i.test(String(a.name)) && WIN_RE.test(String(a.name)))
    || zips.find(a => WIN_RE.test(String(a.name)))
    || zips[0]
}

/** 问 GitHub 最新 release；失败抛错，消息可以直接给人看。 */
export async function latestRelease({ timeoutMs = 20000 } = {}) {
  let res
  try {
    res = await fetch(API_LATEST, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const why = error?.name === 'TimeoutError' ? '连接 GitHub 超时' : (error?.message || String(error))
    throw new Error('查最新版本失败：' + why + '（可以手动下载：https://github.com/' + REPO + '/releases/latest）')
  }
  if (res.status === 401) throw new Error('GitHub 返回 401（未授权）。可以手动下载 https://github.com/' + REPO + '/releases/latest 解压到游戏目录。')
  if (res.status === 403) throw new Error('GitHub 接口被限流了（403，同一出口 IP 每小时 60 次）：等一会儿再试，或手动下载 https://github.com/' + REPO + '/releases/latest 解压到游戏目录。')
  if (res.status === 404) throw new Error('仓库或 Release 不存在（404）：' + REPO)
  if (!res.ok) throw new Error('查最新版本失败：HTTP ' + res.status)
  const rel = await res.json()
  const asset = pickAsset(rel)
  if (!asset) throw new Error('这个 release 里没有可下载的 zip：' + (rel?.tag_name || ''))
  return {
    tag: String(rel.tag_name || ''),
    name: String(rel.name || rel.tag_name || ''),
    publishedAt: String(rel.published_at || ''),
    // GitHub 对新 Release 会给 digest（sha256:…）；老 Release 没有，那就退化成不校验。
    asset: { name: String(asset.name), size: Number(asset.size) || 0, url: String(asset.browser_download_url), digest: String(asset.digest || '').indexOf('sha256:') === 0 ? String(asset.digest).slice(7) : '' },
  }
}

/** 跑一个子进程，等到结束；非 0 退出就抛错（带 stderr 尾巴）。导出是为了能直接测超时逻辑。 */
export function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let out = ''
    let err = ''
    let timer = null
    let graceTimer = null
    let abort = null
    const done = function () {
      if (timer) { clearTimeout(timer); timer = null }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null }
    }
    // tar 卡住（磁盘满、磁盘错误、杀软拦）时没有超时会一直挂着：
    // 锁靠 mtime 判活，挂住的进程看着像活着，第二次安装就被永久挡住。
    if (timeoutMs) {
      timer = setTimeout(function () {
        timer = null
        // 文案按量级选单位：真实场景（20 分钟）说分钟，测试里的短超时（几百毫秒）说秒，
        // 免得出现「超过 0 分钟没结束」这种读起来像 bug 的话。
        const span = timeoutMs >= 60000 ? Math.round(timeoutMs / 60000) + ' 分钟' : Math.max(1, Math.round(timeoutMs / 1000)) + ' 秒'
        abort = new Error(file + ' 超过 ' + span + '没结束，已中止')
        let killed = false
        try { killed = child.kill() } catch (e) { killed = false }
        // 必须等 close 再 reject：reject 之后调用方会 rm -rf 它正在写的目录（__unpack），
        // 进程还没真退出时两边会抢同一批文件。杀不掉（killed=false）时给更长的硬上限，
        // 免得「杀不掉又不退出」把安装永久挂住——锁心跳会一直刷，第二次安装全被挡。
        graceTimer = setTimeout(function () { graceTimer = null; done(); reject(abort) }, killed ? 5000 : 30000)
      }, timeoutMs)
    }
    child.stdout?.on('data', d => { out += String(d) })
    child.stderr?.on('data', d => { err += String(d) })
    child.once('error', e => { done(); reject(new Error(file + ' 跑不起来：' + e.message)) })
    child.once('close', code => {
      done()
      // 超时路径：说「哪一步超时了」比「退出码 null」有用得多，也不用等 grace 到点。
      if (abort) { reject(abort); return }
      if (code === 0) { resolve({ out, err }); return }
      reject(new Error(file + ' 退出码 ' + code + '：' + (err || out || '').slice(-400)))
    })
  })
}

function systemTar() {
  const win = process.env.SystemRoot || 'C:\\Windows'
  const p = path.join(win, 'System32', 'tar.exe')
  return fs.existsSync(p) ? p : 'tar'
}

/** 解压 zip：Windows 自带 tar.exe；条目名越界（.. / 绝对路径）直接报错。 */
export async function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const listed = await run(systemTar(), ['-tf', zip], LIST_TIMEOUT_MS)
  for (const name of String(listed.out || '').split(/\r?\n/)) {
    const entry = name.trim()
    if (!entry) continue
    if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).indexOf('..') >= 0) throw new Error('压缩包里有越界条目：' + entry)
  }
  await run(systemTar(), ['-xf', zip, '-C', dest], UNZIP_TIMEOUT_MS)
  return 'tar'
}

/** 压缩包里常带一层同名目录；找到真正放 start.cmd 的那一层。 */
export function pickRoot(dir) {
  if (fs.existsSync(path.join(dir, 'start.cmd'))) return dir
  const items = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('__'))
  for (const e of items) {
    if (!e.isDirectory()) continue
    const sub = path.join(dir, e.name)
    if (fs.existsSync(path.join(sub, 'start.cmd'))) return sub
  }
  return dir
}

/** 只保留 Node 18+ 的提示（游戏要求，桥要跑在 Node 上）。 */
export function nodeTooOld() {
  const major = Number(String(process.versions.node || '0').split('.')[0])
  return { tooOld: !(major >= 18), version: process.versions.node }
}

/** 桥的 data 目录。和 bridgecfg.bridgeDataDir 同义，但那边依赖本文件，import 会成环。 */
function dataDirOf(dir) {
  try {
    const json = readJsonFile(path.join(String(dir).trim(), 'bridge', 'bridge.config.json')).json
    return path.resolve(path.join(String(dir).trim(), 'bridge'), String(json.dataDir || '../data'))
  } catch (e) {
    return path.join(String(dir).trim(), 'data')
  }
}

/** 装之前先关掉游戏和桥：exe 被占用时覆盖会失败，留下半新半旧的目录。 */
function stopGameAndBridge(dir, log) {
  const stopped = []
  const killPid = function (pid, label) {
    if (!pid) return
    // 传 gameDir：killBridge 要按绝对路径核对身份，别把命令行里恰好带 bridge 字样的进程杀掉。
    const r = killBridge(pid, dir)
    if (r.killed) stopped.push(label)
    else if (log && r.why) log.info('小屋世界：' + r.why)
  }
  try { killPid(Number(fs.readFileSync(hostPidFile(dir), 'utf8')) || 0, '副本桥') } catch (e) { /* 没有 host.pid */ }
  try { killPid(Number(JSON.parse(fs.readFileSync(path.join(dataDirOf(dir), 'bridge.json'), 'utf8')).pid) || 0, '桥') } catch (e) { /* 没在跑 */ }
  // 不要先 tasklist 探活：超时或权限不足时会误报「没在跑」，于是该杀的没杀，
  // 覆盖 exe 时才报 EPERM，留下一半新一半旧的目录。直接杀，杀不到就当没开。
  try { if (killGame(dir)) stopped.push('游戏') } catch (e) { /* 关不掉就继续，覆盖时会报错 */ }
  return stopped
}

/** 装之前关掉的桥和游戏，装完（或装失败）都拉回来，返回要追加到消息里的那一句。withSynced：装成功时连副本桥的抱怨一起带上。 */
async function relaunchStopped(dir, log, okText, failText, withSynced) {
  try {
    // 桥还开着的时候 doSync 的 rename 必然 EPERM，而它会降级成 {ok:true, degraded:true}，
    // 于是这里判成功、再 startHost 就是两个桥抢同一个端口。先确认桥真死了。
    const stillUp = hostBridgeAlive(dir)
    // 这句会拼在「装好了：…」后面，所以不能借用 failText（那会读出「装好了…启动桥失败…再装」）。
    if (stillUp) return '；桥没停干净（pid ' + stillUp + '）：先点一次「重启小屋世界」再装。'
    const synced = await ensureHost({ gameDir: dir, patchesScript: PATCHES, log: log || console })
    const started = startHost({ gameDir: dir, configPath: configPath(dir), log: log || console })
    // 桥没起来的时候，副本重建失败的原因也要带上：否则用户只看到「启动桥失败」，
    // 而真正的原因（补丁锚点对不上之类）藏在 synced.message 里。
    const why = synced.ok ? '' : '（副本桥：' + synced.message + '）'
    if (!started.ok) return failText + started.message + why
    // 起进程不等于连上游戏：装完立刻报「桥已重新启动」，而桥通常要 3-10 秒才连上，
    // 端口被占或配置坏时还会当场崩。等一下再报结论。
    let seen = ''
    const waited = await waitBridge(async function () {
      try {
        const info = readJsonFile(path.join(dataDirOf(dir), 'bridge.json')).json
        if (!String(info.url || '')) return null
        seen = String(info.url)
        const res = await fetch(seen + '/v1/health', { signal: AbortSignal.timeout(3000) })
        const body = await res.json()
        return { row: body, done: !!(body && body.ok === true) }
      } catch (e) { return null }
    }, WAIT_BRIDGE_MS)
    if (!waited.hit) return okText + '（桥起来了但 ' + Math.round(WAIT_BRIDGE_MS / 1000) + ' 秒内没连上：看 bridge-host/host.log 末尾有没有报错，或端口被占）' + why
    return withSynced && !synced.ok ? okText + why : okText
  } catch (error) {
    return (withSynced ? '；自动启动失败：' : '；重新打开失败：') + ((error && error.message) || error)
  }
}

/**
 * 把解压出来的包放进游戏目录：包里有的一律装，data/backups 和桥配置留着不动。
 * 装完再清理一遍顶层：包里已经没有、又不是用户数据的条目，说明是旧版本残留，删掉。
 * 只删顶层、只删不在 KEEP_TOP 里的，data / backups / bridge.config.json 都动不到。
 */
export function copyPackage(root, dir, log = console) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const incoming = new Set(entries.map(function (e) { return e.name }))
  // 包里必须有 bridge/。缺了说明挑错了包（pickAsset 最后会退回 zips[0]，可能是增量补丁包），
  // 这时清理会把整份 bridge/ 连同 bridge.config.json（displayName/端口/dataDir）一起删掉。
  // 光有 bridge/ 不够：增量补丁包或别人打的包也可能带这个目录，但没有 bridge.mjs。
  // ensureHost 的安装判据恰好就是 bridge/bridge.mjs，这里不查会静默装出混合版本的桥。
  if (!incoming.has('bridge') || !fs.existsSync(path.join(root, 'bridge', 'bridge.mjs'))) {
    throw new Error('下载到的不是小屋世界游戏包（里面没有 bridge/bridge.mjs）：重新点一次安装，它会重新下载。')
  }
  const copied = []
  for (const e of entries) {
    if (KEEP_TOP.has(e.name)) continue
    fs.cpSync(path.join(root, e.name), path.join(dir, e.name), {
      recursive: true, force: true,
      filter: function (src) {
        const rel = path.relative(root, src)
        if (!rel) return true
        // 用户已有的配置一律保留（displayName / hostName / 端口 / dataDir / 存档路径都在里面），
        // 但目标没有时必须装包里那份：一律不覆盖会让全新安装根本没有 bridge.config.json，
        // 桥起不来；cabinworld.ini 同理，缺了游戏就不知道数据目录在哪。
        if (KEEP_REL.has(rel) || rel === 'cabinworld.ini') return !fs.existsSync(path.join(dir, rel))
        return !KEEP_TOP.has(rel.split(path.sep)[0])
      },
    })
    copied.push(e.name)
  }
  // 包里可能只带 bridge.config.example.json（上游 INSTALL-AI.md：「没有配置时先按示例建立配置」）。
  // 装完必须让 bridge/bridge.config.json 真的存在，否则面板显示已安装、点启动报「桥配置不存在」。
  const bridgeCfg = path.join(dir, 'bridge', 'bridge.config.json')
  if (!fs.existsSync(bridgeCfg)) {
    const example = path.join(dir, 'bridge', 'bridge.config.example.json')
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, bridgeCfg)
      copied.push(path.join('bridge', 'bridge.config.json'))
    }
  }
  // 旧版本残留：包里没有、又不是用户数据、且确认是官方包会有的顶层条目。搬不动/删不掉只警告，不阻断安装。
  // 不认识的条目按用户数据处理跳过——宁可留一个旧文件，也不能删掉用户的存档。
  const existing = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of existing) {
    if (incoming.has(e.name) || KEEP_TOP.has(e.name)) continue
    if (!isUpstreamTop(e.name)) continue
    try {
      // 只删文件：tools/ docs/ game/ 这些目录名用户也会自己建，撞名就等于删他的东西；
      // 目录留着不影响游戏（包里没有的目录没人读），比误删便宜。
      if (!e.isDirectory()) fs.rmSync(path.join(dir, e.name), { force: true })
    } catch (err) {
      log.warn('小屋世界安装：删不掉旧条目 ' + e.name + '：' + ((err && err.message) || err))
    }
  }
  return copied
}

/**
 * 创建一个安装器。状态在内存里，面板轮询 getState()。
 * stages: checking → downloading → unzipping → installing → done / error
 */
export function createInstaller({ gameDir, log = console }) {
  let state = {
    phase: 'idle',
    percent: 0,
    message: '',
    tag: '',
    bytes: 0,
    total: 0,
    at: 0,
    error: '',
    doneAt: 0,
  }
  let lockBeat = null
  let running = false

  function set(patch) {
    state = { ...state, ...patch, at: Date.now() }
  }

  const LOCK_STALE_MS = 20 * 60 * 1000
  /** 现在能不能开始装？'' 表示可以，否则是给用户看的原因。install() 和面板/命令共用这一份判据。 */
  function precheck() {
    if (running) return '正在装了（' + (state.percent || 0) + '%）'
    try {
      const file = path.join(dirNow(), '.installing')
      // 不判 age >= 0：刚写完锁时 mtime 可能比 Date.now() 大一点点（NTFS 时间戳精度），
      // 那样会被当成「没有锁」放行——正是「点两次装两个」的那个窗口。
      const age = Date.now() - Number(fs.statSync(file).mtimeMs)
      if (Number.isFinite(age) && age < LOCK_STALE_MS) {
        return '上一次安装还没结束（' + Math.max(1, Math.round(age / 60000)) + ' 分钟前开始的，可能是半路关掉了 DSH）。过几分钟再试，或删掉 ' + file + ' 后重试。'
      }
    } catch (e) { /* 没有锁就是可以装 */ }
    return ''
  }

  function dirNow() {
    const d = String(gameDir() || '').trim()
    if (!d) throw new Error('没设置游戏目录')
    return d
  }

  function isInstalled() {
    try {
      return fs.existsSync(path.join(dirNow(), 'start.cmd')) && fs.existsSync(exePath(dirNow()))
    } catch { return false }
  }

  function getState() {
    return { ...state, running, installed: isInstalled() }
  }

  async function download(url, dest, onTick, expectSha256) {
    assertAssetUrl(url)
    let res
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    } catch (error) {
      throw new Error('下载失败：' + (error?.name === 'TimeoutError' ? '10 分钟没下完，已中止' : (error?.message || String(error))))
    }
    if (!res.ok || !res.body) throw new Error('下载失败：HTTP ' + res.status)
    // redirect: 'follow' 会跟着 3xx 走到别的主机——最终地址必须再验一次，否则「只从 GitHub 下载」只是句空话。
    assertAssetUrl(res.url)
    const total = Number(res.headers.get('content-length') || 0)
    const out = fs.createWriteStream(dest)
    let received = 0
    let last = 0
    const body = Readable.fromWeb(res.body)
    // 计数放进 pipeline 里的 Transform：body 上挂 data 监听会把它切成 flowing，
    // 首批 chunk 可能在 pipe 建立前就被吃掉，落盘比 content-length 短而 pipeline 照样 resolve。
    // 边下边算 sha256：下载的文件要以宿主 Node 的权限跑起来，得能证明它就是 GitHub 上那一个。
    const hash = expectSha256 ? crypto.createHash('sha256') : null
    const counter = new Transform({
      transform(chunk, enc, cb) {
        received += chunk.length
        if (hash) hash.update(chunk)
        const now = Date.now()
        if (now - last > 400) { last = now; onTick(received, total) }
        cb(null, chunk)
      },
    })
    await pipeline(body, counter, out)
    onTick(received, total)
    // pipeline 在「连接正常关闭但字节不够」时照样 resolve：不问一句就会拿半个 zip 去解压。
    if (total > 0 && received !== total) {
      await fsp.rm(dest, { force: true }).catch(() => {})
      throw new Error('下载不完整（收到 ' + (received / 1048576).toFixed(1) + ' MB，应该是 ' + (total / 1048576).toFixed(1) + ' MB），已删掉没装。检查网络后重试。')
    }
    if (hash) {
      const got = hash.digest('hex').toLowerCase()
      if (got !== String(expectSha256).toLowerCase()) {
        await fsp.rm(dest, { force: true }).catch(() => {})
        throw new Error('下载回来的文件和 GitHub 公布的对不上（sha256 不符），已删掉没装。可能是网络被劫持，或上游刚替换了包，重试一次；一直这样就别装了。')
      }
    }
    return { received, total, verified: Boolean(hash) }
  }

  async function install() {
    if (running) return { ok: false, message: '已经在装了，等这次装完。' }
    const node = nodeTooOld()
    if (node.tooOld) return { ok: false, message: '小屋世界要 Node.js 18+，你现在是 ' + node.version + '。' }
    // 内存里的 running 挡不住「装到一半模块被热重载」——新实例的 running 又是 false，
    // 用户以为卡住了再点一次就会两条安装同时写同一个 zip 和同一个游戏目录。
    // 磁盘上留个锁：第二下会被挡住；超过 20 分钟当陈旧锁（进程崩了留下的）。
    // dirNow() 抛错（gameDir 配置成空）时原来只进 api.log.warn，面板照样回「开始下载并安装」，
    // 用户看到开始、然后什么都不发生。先它取出来，让它掉进下面的 try 走失败路径。
    // 预检放在最前面：上次装在下载中关掉 DSH，锁会留 20 分钟，这时点安装原来「看起来开始了、
    // 其实什么都没做」，面板要空等 22 分钟才超时。现在直接把原因回给调用方。
    const why = precheck()
    if (why) { set({ phase: 'error', error: why, message: why }); return { ok: false, message: why } }
    const dir = dirNow()
    const lockFile = path.join(dir, '.installing')
    try {
      // 第一次安装时游戏目录还不存在，mkdir 之前写锁必然 ENOENT 被吞掉，等于首装完全没有并发保护。
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(lockFile, String(Date.now()))
      // 心跳：光靠 mtime 判「上一次安装还活着」的话，一轮超过 20 分钟的慢装会被当成陈旧锁放行，
      // 于是第二个安装进来抢同一个 zip 和同一个游戏目录。装多久就刷多久。
      lockBeat = setInterval(function () {
        try { const now = new Date(); fs.utimesSync(lockFile, now, now) } catch (e) { /* 刷不动就交给 20 分钟判据 */ }
      }, 60000)
      lockBeat.unref()
    } catch { /* 锁写不下去就别拦着装了 */ }
    running = true
    // 提在 try 外面：失败时 catch 也要知道装之前是不是关过游戏/桥（关过就得拉回来）。
    let stopped = []
    set({ phase: 'checking', percent: 0, message: '正在查最新版本…', error: '', doneAt: 0 })
    try {
      const dir = dirNow()
      const tmp = path.join(dir, '__download')
      const unpack = path.join(dir, '__unpack')
      fs.mkdirSync(dir, { recursive: true })
      const rel = await latestRelease()
      set({ tag: rel.tag, message: '最新版本 ' + rel.tag + '（' + (rel.asset.size / 1048576).toFixed(1) + ' MB），开始下载…' })
      stopped = stopGameAndBridge(dir, log)
      if (stopped.length) set({ message: '已先关掉' + stopped.join('、') + '，正在下载 ' + rel.tag + '…' })
      await new Promise(function (r) { setTimeout(r, 1500) })
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
      await fsp.mkdir(tmp, { recursive: true })
      const zip = path.join(tmp, 'CabinWorld.zip')
      set({ phase: 'downloading', percent: 0 })
      // rel.asset.digest 为空（老 Release 没给 digest）时 download 内部会跳过校验。
      const got = await download(rel.asset.url, zip, (received, total) => {
        const pct = total > 0 ? Math.round(received * 100 / total) : 0
        set({ phase: 'downloading', percent: pct, bytes: received, total, message: '正在下载 ' + (received / 1048576).toFixed(1) + ' / ' + (total ? (total / 1048576).toFixed(1) : '?') + ' MB' })
      }, rel.asset.digest)
      set({ phase: 'unzipping', percent: 100, message: '下载完了（' + (got.received / 1048576).toFixed(1) + ' MB）' + (got.verified ? '，sha256 已核对' : '') + '，正在解压…' })
      await fsp.rm(unpack, { recursive: true, force: true }).catch(() => {})
      const how = await unzip(zip, unpack)
      const root = pickRoot(unpack)
      // release 里挑错 asset（比如挑中源码包）时这里会落空：先确认解出来的真是游戏，再往游戏目录铺。
      if (!fs.existsSync(path.join(root, 'start.cmd'))) {
        await fsp.rm(unpack, { recursive: true, force: true }).catch(() => {})
        throw new Error('下载到的不是游戏包（解压后没有 start.cmd）。可能 Release 里挑错了文件，手动下载吧：https://github.com/' + REPO + '/releases/latest')
      }
      set({ phase: 'installing', percent: 100, message: '正在放到 ' + dir + '（保留 data 存档）…' })
      const kept = fs.existsSync(path.join(dir, 'data')) ? 1 : 0
      const copied = copyPackage(root, dir, log)
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(unpack, { recursive: true, force: true }).catch(() => {})
      // 装之前关掉的桥和游戏，装完自动拉回来，不用用户自己再点一次。
      const relaunched = stopped.length ? await relaunchStopped(dir, log, '；桥已重新启动', '；启动桥失败：', true) : ''
      set({ phase: 'done', percent: 100, doneAt: Date.now(), error: '', message: '装好了：' + rel.tag + '（解压方式 ' + how + '）' + (kept ? '；保留了原有 data 存档' : '') + (copied.length ? '；装入 ' + copied.length + ' 项' : '') + relaunched })
      log.info('小屋世界安装完成：' + rel.tag + ' → ' + dir)
      return { ok: true, message: state.message, tag: rel.tag }
    } catch (error) {
      const message = error?.message || String(error)
      // 临时文件必须清：不清的话下次重试要先再下一遍 287 MB 才能清 __unpack，
      // 磁盘紧的时候就成了永远装不上的死循环。
      const d = dirNow()
      await fsp.rm(path.join(d, '__download'), { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(d, '__unpack'), { recursive: true, force: true }).catch(() => {})
      // 安装前关掉的游戏和桥，失败也得拉回来——否则用户会觉得「点了一下安装，游戏没了」。
      const back = stopped.length ? await relaunchStopped(d, log, '；桥已重新启动', '；重新打开失败：', false) : ''
      const full = message + back
      set({ phase: 'error', error: message, message: '安装失败：' + full })
      log.error('小屋世界安装失败：' + full)
      return { ok: false, message: full }
    } finally {
      running = false
      if (lockBeat) { clearInterval(lockBeat); lockBeat = null }
      try { fs.rmSync(lockFile, { force: true }) } catch { /* 删不掉就等它自己过期 */ }
    }
  }

  return { install, getState, isInstalled, precheck }
}
