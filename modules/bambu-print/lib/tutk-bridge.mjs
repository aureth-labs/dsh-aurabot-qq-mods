// lib/tutk-bridge.mjs —— 调用我们自己的 C 桥（assets/tutk-bridge/bambu-tutk-bridge[.exe]）抓 TUTK 帧。
//
// 它和用户自带的桥（设置里换的那个）做同一件事（URL 只进临时文件 → 抓样本 →
// H.264 交给 ffmpeg），区别只是可执行文件不同：
//   * 本模块自带的 bambu-tutk-bridge：单文件 C，运行时动态加载用户已安装的
//     BambuSource.dll / libBambuSource.so（也就是 OBN 产物），不需要 .NET / Node / npm。
//   * 自定义桥（用户在设置里换的）：可能是沿用旧约定的程序 —— stdin 一行 JSON
//     `{url, serial, format}`、stdout 一张 JPEG。review P2/P3-2 之后这条路径是**真的实现了**，
//     不再是只有文档声明：新协议（--url-file/--dump/--seconds）失败且看起来「不认识这些参数」时
//     （退出码 1/2 + usage 提示，或没产出样本，或程序退出码 64/70/78 之类），自动回退到旧协议。
//     注意：旧协议只能把 URL 写进 stdin（仍然不进 argv），但对方的输出上限 / 脱敏由对方决定。
//
// 安全约定：凭据只写进 0600 临时文件、不进 argv、错误文本脱敏。

import { createHash } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { access, chmod, constants, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const BRIDGE_MAX_BYTES = 16 * 1024 * 1024
export const BRIDGE_DEFAULT_SECONDS = 8
/** review P3-3：面板允许 3000~60000ms，桥以前夹到 30s，31~60s 的配置等于没生效。现在和设置上限保持一致。 */
export const BRIDGE_MAX_SECONDS = 60
export const BRIDGE_MIN_SECONDS = 2
/** BambuSource 是 OBN 的产物（AGPL），本模块不打包，只提示去哪下。 */
export const BAMBUSOURCE_URL = 'https://github.com/ClusterM/open-bamboo-networking/releases'

export const BAMBUSOURCE_FILE = platformAsset(process.platform, process.arch).libName
/** 一句人话：这个东西从哪来、要取哪个文件（各平台只提自己的）。 */
export const BAMBUSOURCE_ADVICE = '需要一份 BambuSource 库（OBN 的产物，本模块不打包）：从 ' + BAMBUSOURCE_URL + ' 下载 ' +
  (platformAsset(process.platform, process.arch).ok
    ? (process.platform === 'win32'
        ? 'obn-windows-x64.zip，取里面的 lib/v02.09.01/BambuSource.dll；'
        : 'obn-linux-x64.tar.gz，取里面的 lib/libBambuSource.so；')
    : '对应平台的 OBN 产物（当前平台没有预编译包，需要自己编，见 docs/TUTK.md）；')

const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max))

/**
 * 桥产物的 sha256 清单校验。
 *
 * 为什么要有：模块里带的是**预编译二进制**，审核者和用户没法一眼看出它和 bambu-tutk-bridge.c
 * 是不是同一个东西。assets/tutk-bridge/SHA256SUMS 里同时记着两个产物和源码的哈希；
 * 启动桥之前核对一次，文件对不上就拒绝执行并说清楚。
 *
 * 只校验「模块自带的那份」（= 默认路径）。用户在设置里换成自己的桥，属于他自己的选择，
 * 我们不去拦——那份的哈希本来就不在清单里。
 *
 * 清单缺了 / 读不出来时返回 ok:true 并带 note：老版本模块没带这个文件时不要让画面直接坏掉。
 */
export async function verifyBridgeHash (bridgePath, opts = {}) {
  const p = str(bridgePath, 500)
  if (!p) return { ok: false, code: 'NO_BRIDGE', message: '没有配置 TUTK 抓帧桥' }
  const sumsPath = str(opts.sumsPath, 500) || path.join(path.dirname(p), 'SHA256SUMS')
  let text = ''
  try {
    text = await readFile(sumsPath, 'utf8')
  } catch {
    return { ok: true, skipped: true, note: '没有 SHA256SUMS，跳过校验（重装模块可以补上）' }
  }
  const name = path.basename(p)
  const want = (() => {
    for (const line of String(text).split(/\r?\n/)) {
      // 标准 sha256sum 格式：<64 位小写十六进制><空格><空格或 *><文件名>
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
      if (m && m[2] === name) return m[1].toLowerCase()
    }
    return ''
  })()
  if (!want) return { ok: true, skipped: true, note: '清单里没有 ' + name + '，跳过校验（自定义桥？）' }
  let got = ''
  try {
    got = createHash('sha256').update(await readFile(p)).digest('hex')
  } catch (err) {
    return { ok: false, code: 'BRIDGE_UNREADABLE', message: '读不了抓帧桥：' + String((err && err.message) || err) }
  }
  if (got === want) return { ok: true, expected: want, actual: got }
  return {
    ok: false,
    code: 'BRIDGE_HASH_MISMATCH',
    expected: want,
    actual: got,
    message: '抓帧桥和模块自带的不一致（可能被改过或损坏）：期望 sha256 ' + want + '，实际 ' + got +
      '。确认是你自己换的桥就把它放到别处、在设置里填那条路径；否则删掉重装模块。',
  }
}

/**
 * 平台 → 桥可执行文件 / 库文件名（review P3-2）。
 * 以前「非 Windows 一律 Linux x64」，macOS 与 linux arm64 会静默选错架构。
 * 这里做成纯函数，方便单测注入 platform/arch。
 * @returns {{ok:boolean, platform:string, arch:string, bridge:string, libName:string, code?:string, error?:string}}
 */
export function platformAsset (platform = process.platform, arch = process.arch) {
  const p = String(platform || '')
  const a = String(arch || '')
  if (p === 'win32' && a === 'x64') return { ok: true, platform: p, arch: a, bridge: 'bambu-tutk-bridge.exe', libName: 'BambuSource.dll' }
  if (p === 'linux' && a === 'x64') return { ok: true, platform: p, arch: a, bridge: 'bambu-tutk-bridge-linux-x64', libName: 'libBambuSource.so' }
  return {
    ok: false,
    code: 'UNSUPPORTED_PLATFORM',
    platform: p,
    arch: a,
    bridge: '',
    libName: p === 'win32' ? 'BambuSource.dll' : p === 'darwin' ? 'libBambuSource.dylib' : 'libBambuSource.so',
    error: '没有适用于 ' + (p || '未知') + '/' + (a || '未知') + ' 的预编译抓帧桥：模块只带 Windows x64 与 Linux x64 两个产物。'
      + ' 请按 docs/TUTK.md「自己编译」编译一份 bambu-tutk-bridge，再在设置里填它的路径（BambuSource 库也要自己编）。',
  }
}

function isJpeg (buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 &&
    buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff &&
    buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9
}

/** 收尾：确认是 JPEG 再返回，并标明走的哪条通道（args = --url-file 新协议，legacy = stdin/stdout 旧协议）。 */
function finishJpeg (buf, via, protocol) {
  if (!isJpeg(buf)) {
    // 尾部没写 EOI 的也认（有些桥只 flush 了 SOI~数据），但要确保开头是 SOI
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]))
      if (end > 0) buf = buf.subarray(0, end + 2)
    }
    if (!isJpeg(buf)) return { ok: false, code: 'BAD_JPEG', error: '桥返回的不是有效 JPEG' }
  }
  const out = { ok: true, jpeg: buf, via }
  if (protocol) out.protocol = protocol
  return out
}

function scrub (text, secrets) {
  let out = String(text == null ? '' : text)
  for (const secret of secrets) {
    const s = typeof secret === 'string' ? secret : ''
    if (s && out.includes(s)) out = out.split(s).join('••••')
  }
  return out
}

function run (cmd, args, { timeoutMs, spawnImpl = nodeSpawn, secrets = [], stdinText = null, collectStdout = false, maxStdout = BRIDGE_MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    let child
    const stdio = collectStdout ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe']
    try {
      child = spawnImpl(cmd, args, { stdio, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, code: 'SPAWN_FAILED', error: '启动桥接程序失败', detail: scrub((err && err.message) || err, secrets) })
      return
    }
    let stderr = ''
    let stdout = Buffer.alloc(0)
    let stdoutOverflow = false
    let settled = false
    // 不 unref：注入的假子进程不会真的挂住事件循环，unref 掉定时器时 Node 会提前退出，
    // 这个 promise 永远不 settle。finish() 里 clearTimeout，不会拖住进程。
    const timer = timeoutMs > 0 ? setTimeout(() => finish({ ok: false, code: 'TIMEOUT', error: 'TUTK 桥超时（' + timeoutMs + 'ms）' }), timeoutMs) : null
    function finish (result) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { child.kill?.('SIGKILL') } catch { /* 已退出 */ }
      resolve(result)
    }
    child.on?.('error', (err) => finish({ ok: false, code: 'SPAWN_FAILED', error: '启动桥接程序失败', detail: scrub((err && err.message) || err, secrets) }))
    child.stderr?.on?.('data', (chunk) => {
      stderr += scrub(String(chunk), secrets)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    if (collectStdout) {
      child.stdout?.on?.('data', (chunk) => {
        if (stdoutOverflow) return
        stdout = Buffer.concat([stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))])
        if (stdout.length > maxStdout) { stdoutOverflow = true; stdout = Buffer.alloc(0) }
      })
    }
    if (stdinText != null) {
      try {
        child.stdin?.on?.('error', () => {})
        child.stdin?.write?.(stdinText)
        child.stdin?.end?.()
      } catch { /* 对方没有 stdin：继续等它自己退出 */ }
    }
    child.on?.('close', (code) => {
      if (code === 0) finish({ ok: true, stdout: stdoutOverflow ? null : stdout, overflow: stdoutOverflow })
      // 3 = 找不到 / 加载不了 BambuSource；8 = 库连上了但没拿到画面
      else finish({ ok: false, code: code === 3 ? 'NO_BAMBUSOURCE' : 'EXIT', exitCode: code, stdout: stdoutOverflow ? null : stdout, error: '桥接程序退出码 ' + String(code), detail: stderr.replace(/\s+/g, ' ').slice(0, 400) })
    })
  })
}

/**
 * 退出码像「不认识这些参数」吗？（review P2/P3-2）
 * 1/2 = 一般 CLI 的用法错误；64/70/78 是 sysexits 里的 USAGE/SOFTWARE/CONFIG。
 * 另外 stderr 里出现 usage / unknown option 之类也算。
 */
function looksLikeUnknownArgs (r) {
  if (!r || r.ok) return false
  if (r.code !== 'EXIT') return false
  const code = Number(r.exitCode)
  if ([1, 2, 64, 70, 78].includes(code)) return true
  return /usage|unknown (option|argument|flag)|unrecognized|invalid option|--url-file/i.test(String(r.detail || ''))
}


/**
 * 桥程序默认位置：模块自带 assets/tutk-bridge/ 下，按平台选文件名。
 * review P3-2：不支持的平台返回 ''（而不是静默拼一个 Linux x64 的路径），
 * 面板那边可以用 platformAsset() 拿到具体原因。
 */
export function defaultBridgePath (moduleDir, platform = process.platform, arch = process.arch) {
  const dir = str(moduleDir, 500)
  if (!dir) return ''
  const target = platformAsset(platform, arch)
  if (!target.ok) return ''
  return path.join(dir, 'assets', 'tutk-bridge', target.bridge)
}

/**
 * 抓一帧。
 * @param {{url:string, bridgePath:string, libPath?:string, ffmpegPath?:string, seconds?:number,
 *   timeoutMs?:number, spawnImpl?:Function, dir?:string, serial?:string}} opts
 * @returns {Promise<{ok:true, jpeg:Buffer, via:'mjpeg'|'h264', protocol?:'args'|'legacy'}|{ok:false, code:string, error:string}>}
 */
export async function captureViaBridge (opts = {}) {
  const url = str(opts.url, 4096)
  const bridgePath = str(opts.bridgePath, 500)
  if (!url) return { ok: false, code: 'NO_URL', error: '缺少 TUTK 地址' }
  if (!bridgePath) return { ok: false, code: 'NO_BRIDGE', error: '没有配置 TUTK 抓帧桥路径' }

  let dir = ''
  try {
    dir = opts.dir || await mkdtemp(path.join(tmpdir(), 'bambu-tutk-b-'))
  } catch (err) {
    return { ok: false, code: 'TEMP_FAILED', error: '创建临时目录失败：' + String((err && err.message) || err) }
  }
  const urlFile = path.join(dir, 'url.txt')
  const dumpFile = path.join(dir, 'samples.bin')
  // review P3-3：上限 60s，和面板的 tutkTimeoutMs（3000~60000ms）对齐；C 桥端也是 2~60s。
  const seconds = Math.min(BRIDGE_MAX_SECONDS, Math.max(BRIDGE_MIN_SECONDS, Number(opts.seconds) || BRIDGE_DEFAULT_SECONDS))
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : nodeSpawn
  const ffmpegPath = str(opts.ffmpegPath, 500) || 'ffmpeg'
  const timeoutMs = Math.min(120000, Math.max(5000, Number(opts.timeoutMs) || (seconds + 25) * 1000))
  const secrets = []
  for (const m of url.matchAll(/[?&]([^=&]+)=([^&]+)/g)) secrets.push(decodeURIComponent(m[2]), m[2])

  try {
    await writeFile(urlFile, url + '\n', { encoding: 'utf8', mode: 0o600 })
    await chmod(urlFile, 0o600).catch(() => {})

    const args = ['--url-file', urlFile, '--dump', dumpFile, '--seconds', String(seconds)]
    const lib = str(opts.libPath, 500)
    if (lib) args.push('--lib', lib)
    // 打包成 zip 时文件模式的位不保留（scripts/lib.mjs 的 makeZip 不写 external attributes），
    // 所以在 Linux / macOS 上解出来的桥是 0644，spawn 会直接 EACCES。这里补一次 +x：
    // 只加执行位、不改别的位；加不上（只读挂载 / 别人的安装目录）就不管，
    // 让 spawn 自己报错，错误信息里已经写了「检查桥路径与执行权限」。
    if (process.platform !== 'win32') await chmod(bridgePath, 0o755).catch(() => {})
    // 预编译二进制先对哈希：对不上就一个字都不执行（见 verifyBridgeHash 的注释）
    const hash = await verifyBridgeHash(bridgePath, { sumsPath: opts.sumsPath })
    if (!hash.ok) return { ok: false, code: hash.code, error: hash.message }
    const bridge = await run(bridgePath, args, { timeoutMs, spawnImpl, secrets })

    // ---- 旧协议回退：stdin JSON → stdout JPEG（review P2/P3-2，已实现而非只写文档） ----
    // 只有「看起来不认识新参数」或「新参数跑通了但没产出样本」才回退，免得多跑一次。
    let dump = null
    if (!bridge.ok) {
      if (bridge.code === 'TIMEOUT') return { ok: false, code: 'TIMEOUT', error: 'TUTK 抓帧失败：' + (bridge.detail || '桥超时') }
      if (bridge.code === 'NO_BAMBUSOURCE') {
        return {
          ok: false,
          code: 'NO_BAMBUSOURCE',
          error: '没有找到 BambuSource 库（云端画面要用它）。' + BAMBUSOURCE_ADVICE +
            '放到抓帧桥同目录（' + path.dirname(bridgePath) + '）即可。' + (bridge.detail ? ' 桥自检：' + bridge.detail : ''),
        }
      }
      if (bridge.code === 'SPAWN_FAILED') {
        return { ok: false, code: 'BRIDGE_FAILED', error: 'TUTK 抓帧失败（检查桥路径与执行权限）' + (bridge.detail ? '：' + bridge.detail : '') }
      }
      if (!looksLikeUnknownArgs(bridge)) {
        return { ok: false, code: 'BRIDGE_FAILED', error: 'TUTK 抓帧失败' + (bridge.detail ? '：' + bridge.detail : '') }
      }
      // 落到下面走旧协议
    } else {
      let wroteFile = false
      try {
        const info = await stat(dumpFile)
        wroteFile = true
        if (info.size > BRIDGE_MAX_BYTES) return { ok: false, code: 'TOO_LARGE', error: '桥输出的样本过大' }
        if (!info.size) return { ok: false, code: 'EMPTY_DUMP', error: '桥没有输出样本（云画面没开、ttcode 过期，或 BambuSource 版本不匹配）' }
        dump = await readFile(dumpFile)
      } catch (err) {
        // 只有「文件根本不存在」才可能是旧桥不认识 --dump；其它读失败按原样报。
        if (wroteFile) return { ok: false, code: 'NO_DUMP', error: '读不到桥输出的样本' }
      }
    }

    if (!dump) {
      // 新协议没产出样本（退出码像用法错误，或 0 但没写 --dump 文件）→ 试一次旧协议。
      const payload = JSON.stringify({ url, serial: str(opts.serial, 200), format: 'jpeg' }) + '\n'
      const legacy = await run(bridgePath, [], { timeoutMs, spawnImpl, secrets, stdinText: payload, collectStdout: true })
      if (!legacy.ok) {
        const hint = legacy.code === 'SPAWN_FAILED' ? '（检查桥路径与执行权限）' : ''
        return { ok: false, code: legacy.code === 'TIMEOUT' ? 'TIMEOUT' : 'BRIDGE_FAILED', error: 'TUTK 抓帧失败' + hint + (legacy.detail ? '：' + legacy.detail : '') }
      }
      if (legacy.overflow) return { ok: false, code: 'TOO_LARGE', error: '桥的 stdout 输出超过 ' + Math.round(BRIDGE_MAX_BYTES / 1048576) + 'MB' }
      if (!legacy.stdout || !legacy.stdout.length) {
        return { ok: false, code: 'EMPTY_DUMP', error: '桥没有输出画面（云画面没开、ttcode 过期，或桥的协议不匹配）' }
      }
      return finishJpeg(legacy.stdout, 'mjpeg', 'legacy')
    }

    if (isJpeg(dump)) return finishJpeg(dump, 'mjpeg')
    if (dump.length > 4 && dump[0] === 0xff && dump[1] === 0xd8) {
      const end = dump.indexOf(Buffer.from([0xff, 0xd9]))
      if (end > 0) return finishJpeg(dump.subarray(0, end + 2), 'mjpeg')
    }

    const ffFile = path.join(dir, 'frame.jpg')
    const ff = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'h264', '-i', dumpFile,
      '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', ffFile,
    ], { timeoutMs: 30000, spawnImpl, secrets })
    if (!ff.ok) {
      const hint = ff.code === 'SPAWN_FAILED' ? '（X1/H2/P2S 的 H.264 需要本机 ffmpeg）' : ''
      return { ok: false, code: 'FFMPEG_FAILED', error: 'H.264 转 JPEG 失败' + hint + (ff.detail ? '：' + ff.detail : '') }
    }
    const jpeg = await readFile(ffFile).catch(() => null)
    if (!jpeg || !isJpeg(jpeg)) return { ok: false, code: 'BAD_JPEG', error: 'ffmpeg 没有产出有效 JPEG' }
    return { ok: true, jpeg, via: 'h264' }
  } catch (err) {
    return { ok: false, code: 'FAILED', error: 'TUTK 抓帧失败：' + String((err && err.message) || err) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 桥程序是否可用（面板自检）。顺带检查同目录有没有 BambuSource；
 * 桥能用但缺库时 ok=true、libOk=false，让面板能分别提示。
 */
export async function checkBridgeBinary (bridgePath, opts = {}) {
  const p = str(bridgePath, 500)
  if (!p) return { ok: false, code: 'NO_BRIDGE', message: '没有配置 TUTK 抓帧桥' }
  try {
    const info = await stat(p)
    if (!info.isFile()) return { ok: false, code: 'NOT_FILE', message: 'TUTK 抓帧桥路径不是文件' }
    if (process.platform !== 'win32') await access(p, constants.X_OK)
  } catch {
    return { ok: false, code: 'MISSING', message: '找不到 TUTK 抓帧桥（或没有执行权限）' }
  }
  // 预编译二进制对哈希：面板自检就要说清楚「这份桥不是模块自带的那份」，
  // 别等到用户点拍照才报错。
  const hash = await verifyBridgeHash(p, { sumsPath: opts.sumsPath })
  if (!hash.ok) return { ok: false, code: hash.code, message: hash.message }
  // review P3-1：C 桥自己还会看 BAMBU_SOURCE_LIB；预检也必须认这条路径，
  // 否则「只在环境变量里配了库」时面板会说缺库，而桥其实能加载。
  // 判定规则跟 C 桥的 resolve_lib 保持一致：显式指定（--lib / 设置项）是**硬选**，
  // 文件不在就直接算缺；没显式指定时才依次看 BAMBU_SOURCE_LIB、桥同目录。
  const envPath = str(opts.envLibPath, 500) || str(process.env.BAMBU_SOURCE_LIB, 500)
  const configured = str(opts.libPath, 500)
  if (configured) {
    // 显式配置了就只认它：C 桥拿到 --lib 但文件不在时是直接失败（不会偷偷换一个），
    // 预检必须同样硬失败，否则会回报「库 OK」而抓帧时报 NO_BAMBUSOURCE。
    const lib = await checkBambuSource(configured)
    return lib.ok
      ? { ok: true, path: p, libPath: lib.path || configured, libOk: true, libSource: 'configured', libMessage: lib.message || '' }
      : { ok: true, path: p, libPath: configured, libOk: false, libSource: 'configured', libMessage: 'configured：' + (lib.message || lib.code) }
  }
  const candidates = [
    { source: 'env', p: envPath },
    { source: 'sibling', p: path.join(path.dirname(p), BAMBUSOURCE_FILE) },
  ].filter((c) => c.p)
  const tried = []
  for (const c of candidates) {
    const lib = await checkBambuSource(c.p)
    if (lib.ok) return { ok: true, path: p, libPath: lib.path || c.p, libOk: true, libSource: c.source, libMessage: lib.message || '' }
    tried.push(c.source + '：' + (lib.message || lib.code))
  }
  const last = candidates.length ? candidates[candidates.length - 1] : null
  return {
    ok: true,
    path: p,
    libPath: last ? last.p : '',
    libOk: false,
    // 全都没找到时给出「最先该修的位置」：显式配置了就是配置项，否则是桥同目录。
    libSource: last ? last.source : '',
    libMessage: tried.length ? tried.join('；') : '没有配置 BambuSource 路径',
  }
}

/** BambuSource 库是否存在（只查文件，不加载；加载由桥自己做）。 */
export async function checkBambuSource (libPath) {
  const p = str(libPath, 500)
  if (!p) return { ok: false, code: 'NO_LIB', message: '没有配置 BambuSource 路径' }
  try {
    const info = await stat(p)
    if (!info.isFile()) return { ok: false, code: 'NOT_FILE', path: p, message: 'BambuSource 路径不是文件' }
    if (info.size < 64 * 1024) return { ok: false, code: 'TOO_SMALL', path: p, message: 'BambuSource 文件太小，可能没下载完整' }
    return { ok: true, path: p }
  } catch {
    return { ok: false, code: 'MISSING', path: p, message: '同目录没有 ' + BAMBUSOURCE_FILE + '（云端画面需要它）' }
  }
}
