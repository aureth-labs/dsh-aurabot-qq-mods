/**
 * env.mjs —— phone 模块环境自动化：确保 adb 可用
 * 作用：按「配置路径 → PATH 探测 → 自动下载 platform-tools」三级策略找到/装好 adb（Windows/Linux 通吃）。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export async function ensureAdb({ adbPath = '', dataDir, log = () => {} })
 *   → { adbPath: string, installed: boolean, source: 'config'|'path'|'auto'|'missing' }
 * 来源：Google 官方 zip → 腾讯镜像依次尝试；用系统自带 tar 解压到 dataDir/platform-tools/；
 *      临时 zip 下载完即删。全程零 npm 依赖（node: 内置 + 全局 fetch）。
 * 平台化（B2-1，手机逛逛隧道方案）：按 process.platform 选对应 platform-tools 包与官方 sha256，
 *      unix 侧解压后补可执行位（tar/解压器偶发丢 mode 位）。hooks 参数仅供测试注入，生产不用传。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** 运行一条命令，失败返回 null（探测用，不抛）。 */
async function tryRun(cmd, args) {
  try {
    const r = await execFileP(cmd, args, { timeout: 15000, windowsHide: true })
    return r
  } catch {
    return null
  }
}

/** 验证某个 adb 路径是否可用（能跑 `adb version`）。 */
async function adbWorks(adbPath) {
  const r = await tryRun(adbPath, ['version'])
  return r !== null
}

/** 下载到本地文件。失败抛错，由调用方换下一个镜像。
 *  坑：Node 18+ 的 fetch 响应体是 Web ReadableStream，没有 .pipe()，
 *  必须经 Readable.fromWeb 转 Node 流再 pipeline（曾经两个镜像全卡在这一步）。 */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  if (!res.body) throw new Error(`下载失败（无响应体）: ${url}`)
  const out = createWriteStream(dest)
  await pipeline(Readable.fromWeb(res.body), out)
}

/** 边读边算 sha256（zip ~6MB，流式读不用整个进内存）。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (c) => h.update(c))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

/** 在目录里递归找 adb 可执行文件（zip 解压后位置可能带 platform-tools/ 一层或不带）。
 *  两平台文件名都认（本平台的排前）：linux 包里叫 adb、windows 包里叫 adb.exe，
 *  兼容「zip 布局与运行平台不一致」的边界，也方便测试在任意宿主上注入 fake 布局。 */
function findAdbIn(dir) {
  const names = process.platform === 'win32' ? ['adb.exe', 'adb'] : ['adb', 'adb.exe']
  const queue = [dir]
  while (queue.length) {
    const cur = queue.shift()
    let entries
    try { entries = readdirSync(cur) } catch { continue }
    for (const ent of entries) {
      const p = join(cur, ent)
      try {
        const st = statSync(p)
        if (st.isDirectory()) queue.push(p)
        else if (names.includes(ent.toLowerCase()) && st.isFile()) return p
      } catch { /* 单个条目读不了就跳过 */ }
    }
  }
  return ''
}

/**
 * 三级探测/自动安装。任何一级成功即返回；全失败返回 source:'missing'（不抛）。
 * @param {{adbPath?: string, dataDir: string, log?: Function, hooks?: object}} o
 *   hooks（仅测试注入，照 __phoneTestHooks 先例）：{ platform, download, sha256File, exec, chmod, adbWorks }，
 *   不传全部走真实实现（platform 默认 process.platform）。
 */
export async function ensureAdb({ adbPath = '', dataDir, log = () => {}, hooks = {} } = {}) {
  // 1) 配置里给了路径：验证能跑就用
  if (adbPath) {
    if (await adbWorks(adbPath)) {
      log('info', `adb 使用配置路径: ${adbPath}`)
      return { adbPath, installed: false, source: 'config' }
    }
    log('warn', `配置的 adbPath 不可用，继续探测 PATH: ${adbPath}`)
  }
  // 2) PATH 里探测：Windows 用 where，其他平台用 which
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const found = await tryRun(probe, ['adb'])
  if (found && found.stdout.trim()) {
    // where 可能回多行，取第一行
    const p = found.stdout.trim().split(/\r?\n/)[0]
    if (await adbWorks(p)) {
      log('info', `adb 在 PATH 中找到: ${p}`)
      return { adbPath: p, installed: false, source: 'path' }
    }
  }
    // 3) 都没有 → 自动下载 platform-tools（国内镜像在前，Google 官方殿后）
    const dir = join(dataDir, 'platform-tools')
    try {
      mkdirSync(dir, { recursive: true })
      // 已装过（上次下载成功）就直接用：不猜布局，递归找出 adb，避免重复下载
      const existing = findAdbIn(dir)
      if (existing && (await adbWorks(existing))) {
        return { adbPath: existing, installed: false, source: 'auto' }
      }
      // 按平台取钉死的包名与官方 sha256（平台不认识直接抛可读错误，落到 catch 返回 missing）
      const pt = platformToolsFor(hooks.platform)
      const zip = join(dataDir, `platform-tools-tmp-${Date.now()}.zip`)
      let ok = false
      const errs = []
      for (const url of pt.mirrors) {
        try {
          log('info', `尝试下载 platform-tools: ${url}`)
          await (hooks.download || download)(url, zip)
          // 哈希对不上就删掉换下一个镜像——镜像被篡改/塞了别的包也过不了这关
          const got = await (hooks.sha256File || sha256File)(zip)
          if (got !== pt.sha256) throw new Error(`sha256 不匹配：拿到 ${got.slice(0, 12)}…，期望 ${pt.sha256.slice(0, 12)}…`)
          ok = true
          break
        } catch (e) {
          rmSync(zip, { force: true }) // 坏包立刻清掉
          errs.push(`${new URL(url).host}: ${e.message}`)
          log('warn', `下载失败，换下一个镜像: ${e.message}`)
        }
      }
      if (!ok) {
        rmSync(zip, { force: true }) // 失败也清掉 0 字节残留
        throw Object.assign(new Error(errs.join('；') || '全部镜像下载失败'), { mirrors: errs })
      }
      // 用系统自带 tar 解压（Win10+ 与常见 Linux 发行版都内置，均支持 zip）
      await (hooks.exec || execFileP)('tar', ['-xf', zip, '-C', dir], { timeout: 120000, windowsHide: true })
      rmSync(zip, { force: true }) // 临时 zip 用完即删
      // 不猜解压布局：直接在解压目录里递归找出 adb（zip 有的带 platform-tools/ 一层，有的不带）
      const finalPath = findAdbIn(dir)
      if (!finalPath) throw new Error(`解压后没找到 adb: ${dir}`)
      // unix 侧补可执行位（B2-1）：解压/搬移偶发丢 mode 位，宁可多 chmod 一次；
      // 平台取注入值（hooks.platform），否则 Windows 上跑不起 linux 分支的这条路径
      const plat = hooks.platform || process.platform
      if (plat !== 'win32') {
        try { (hooks.chmod || chmodSync)(finalPath, 0o755) } catch (e) { log('warn', `adb 可执行位补授失败（可忽略）: ${e.message}`) }
      }
      if (!(await (hooks.adbWorks || adbWorks)(finalPath))) throw new Error(`解压后 adb 不可用: ${finalPath}`)
      log('info', `platform-tools 自动安装完成: ${finalPath}`)
      return { adbPath: finalPath, installed: true, source: 'auto' }
    } catch (e) {
      log('error', `adb 自动安装失败: ${e.message}`)
      return { adbPath: '', installed: false, source: 'missing', error: e.message }
    }
}

/**
 * platform-tools 按平台钉死版本 + 官方 sha256（P1-1 + B2-1，复审要求）：不用「latest」——版本一变哈希就废。
 * 两个平台的包都经「dl.google.com / googledownloads.cn / 腾讯镜像」三源实测逐字节一致（2026-11-02 各下载一份比对，
 * windows 与 linux 三源 Content-Length 均一致）。
 * 升级 platform-tools：换 PT_VERSION + 下载对应平台的 zip 重算 sha256 改下表。
 */
const PT_VERSION = 'r34.0.5'
const PT_BY_PLATFORM = {
  // Windows 版（既有钉版，勿动哈希）
  win32: {
    zip: `platform-tools_${PT_VERSION}-windows.zip`,
    sha256: '3f8320152704377de150418a3c4c9d07d16d80a6c0d0d8f7289c22c499e33571',
  },
  // Linux 版（服务器部署路径，2026-11-02 从 dl.google.com 下载实算：6333075 字节）
  linux: {
    zip: `platform-tools_${PT_VERSION}-linux.zip`,
    sha256: '362f8f6218af0f4c61e5aaafb8e255a426c7a0ee00127dfab7371775081d3124',
  },
  // darwin 有官方包，按需补（本模块暂只服务 win/linux，先给个明确的错）
}
/** 按平台取 { zip, mirrors, sha256 }；没钉版的平台直接抛可读错误。 */
export function platformToolsFor(platform = process.platform) {
  const hit = PT_BY_PLATFORM[platform]
  if (!hit) throw new Error(`暂不支持的平台自动安装：${platform}（请手动安装 adb 并在面板配置 adbPath）`)
  return {
    zip: hit.zip,
    sha256: hit.sha256,
    mirrors: [
      `https://mirrors.cloud.tencent.com/AndroidSDK/${hit.zip}`,
      `https://googledownloads.cn/android/repository/${hit.zip}`,
      `https://dl.google.com/android/repository/${hit.zip}`,
    ],
  }
}
