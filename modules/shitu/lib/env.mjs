// 环境探针：找 python、判引擎归属与可用性。只读不写，安装动作在 install.mjs。
//
// 为什么要分「归属」：
//   用户机器上可能本来就装着 rapidocr（自己项目里、或 DSH 运行时里）。
//   直接借用会让模块受制于别人的环境（被卸载、被升级、被别的程序锁住），
//   往别人环境里 pip install 更是会改坏用户已有的东西。
//   所以只有两种合法用法：
//     · 我们自己在 <dir>/.venv 建的环境（有归属标记）—— 可以随便装、随便改
//     · 系统 python 里本来就有 rapidocr —— 只读借用，不装、不写
//
// state 四态（install.mjs 只在 missing 时动手）：
//   ready     自有 venv + 脚本齐全 + 能 import    → 可以跑，也可以修
//   borrowed  系统 python 能 import rapidocr      → 能跑，但不接管、不安装
//   missing   有 python，但没有可用的引擎          → 可以装
//   blocked   目录被占 / 没有 python / venv 不是我们的 → 什么都不做，只报原因

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const isWin = process.platform === 'win32'

/** venv 目录里的归属标记（由本模块写入）。有它 = 这个 venv 是我们的，可以随便改。 */
export const OWNED_MARKER = '.shitu-owned'

/** 脚本目录里的版本标记（模块第一次往这个目录铺脚本时写入）。 */
export const VERSION_FILE = '.shitu-ver'

/** 跑一个命令，拿到 stdout / stderr / code。超时强杀，不抛。 */
export function run(cmd, args, { cwd, timeoutMs = 30_000, env, input } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    let proc
    try {
      proc = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      return finish({ code: -1, out: '', err: String(error.message || error) })
    }
    const out = []
    const err = []
    timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      finish({ code: -9, out: Buffer.concat(out).toString('utf8'), err: '超时 ' + timeoutMs + 'ms' })
    }, timeoutMs)
    proc.stdout?.on('data', (d) => out.push(d))
    proc.stderr?.on('data', (d) => err.push(d))
    proc.on('error', (e) => finish({ code: -1, out: '', err: String(e.message || e) }))
    proc.on('close', (code) =>
      finish({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }),
    )
    if (input !== undefined) {
      try {
        proc.stdin.end(input)
      } catch {}
    }
  })
}

/** 目录里的 python 解释器路径（win: .venv/Scripts/python.exe，其它: .venv/bin/python）。 */
export function venvPython(dir) {
  return isWin ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python')
}

export function venvDirOf(dir) {
  return join(dir, '.venv')
}

/**
 * 这个 venv 是不是我们自己建的。
 *
 * 两道判据，满足其一就算：
 *   1. 有 .shitu-owned 标记 —— 新版本建的
 *   2. 老版本建的没有标记，但 pyvenv.cfg 的 command 行里记着 venv 路径落在
 *      ...\modules-data\shitu\ocr\.venv —— 升级时认领回来，不用重装 320MB
 *
 * 用户自己 `python -m venv` 出来的目录两道都不满足，所以不会被误认为我们的。
 */
export function venvOwnedByShitu(dir) {
  const vd = venvDirOf(dir)
  if (existsSync(join(vd, OWNED_MARKER))) return true
  const cfg = join(vd, 'pyvenv.cfg')
  if (!existsSync(cfg)) return false
  try {
    const text = readFileSync(cfg, 'utf8')
    const line = text.split(/\r?\n/).find((l) => /^command\s*=/i.test(l)) || ''
    const m = line.match(/command\s*=\s*(.+)$/i)
    if (!m) return false
    // command 里必须真的指向「这个 .venv 的完整路径」，才算我们的。
    // 只判 includes('.venv') 太松：D:\other\shitu\ocr\.venv-别的 也含 '.venv'。
    const fromCfg = m[1].trim().replace(/["']/g, '')
    const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return /[\\/]shitu[\\/]/i.test(fromCfg) && norm(fromCfg).endsWith(norm(vd))
  } catch {
    return false
  }
}

/** 读归属标记里的内容（创建时间、版本），没有就返回空对象。 */
export function readOwnedMarker(dir) {
  try {
    const raw = readFileSync(join(venvDirOf(dir), OWNED_MARKER), 'utf8')
    const out = {}
    for (const line of raw.split(/\r?\n/)) {
      const [k, ...rest] = line.split('=')
      if (k && rest.length) out[k.trim()] = rest.join('=').trim()
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 这个目录能不能让我们铺脚本 / 建 venv。
 *
 * 允许：不存在、空的、或者有 .shitu-ver（我们之前铺过）。
 * 拒绝：有别的文件但没有我们的标记 —— 那是用户的目录，一个字节都不动。
 */
export function dirUsable(dir) {
  if (!existsSync(dir)) return { ok: true, fresh: true }
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch (error) {
    return { ok: false, reason: `目录读不了：${error.message}` }
  }
  if (entries.length === 0) return { ok: true, fresh: true }
  if (existsSync(join(dir, VERSION_FILE))) return { ok: true, fresh: false, ours: true }
  // 只有一个空的 .venv 也不算别人的（建到一半失败留下的）
  const meaningful = entries.filter((n) => n !== '.venv')
  if (meaningful.length === 0) return { ok: true, fresh: true, partial: true }
  return {
    ok: false,
    reason:
      `目录里已经有别的东西，又不像是本模块铺的：${dir}\n` +
      `里面看到：${meaningful.slice(0, 5).join('、')}${meaningful.length > 5 ? '…' : ''}\n` +
      '为了不动到你已有的文件，这里不会写入任何东西。请在设置里换一个空目录。',
  }
}

/** 一个 python 候选够不够用：能跑 -V，且（wantRapid 时）import 得到 rapidocr。 */
export async function probePython(python, { wantRapid = false, args = [], timeoutMs = 20_000 } = {}) {
  const v = await run(python, [...args, '-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs })
  if (v.code !== 0) return { ok: false, python, reason: (v.err || v.out || '无法运行').trim().slice(0, 200) }
  const version = v.out.trim()
  if (!wantRapid) return { ok: true, python, version }
  const r = await run(
    python,
    [...args, '-c', 'import rapidocr_onnxruntime,importlib.metadata as m;print(m.version("rapidocr-onnxruntime"))'],
    { timeoutMs },
  )
  if (r.code !== 0) return { ok: false, python, version, reason: '没装 rapidocr-onnxruntime' }
  return { ok: true, python, version, rapidocr: r.out.trim() }
}

/** 找可用的系统 python。按可靠性排序，第一个能跑 -V 的就用。 */
export async function findPython({ configured = '', log } = {}) {
  const cands = []
  if (configured) cands.push(configured)
  if (isWin) {
    // DSH 自带的运行时 python 最稳（用户机器上确定存在，且不会被 Store 版别名坑）
    cands.push(
      join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    )
    cands.push('py')
    cands.push('python')
    cands.push('python3')
  } else {
    cands.push('/usr/bin/python3', '/usr/local/bin/python3', 'python3')
  }
  for (const c of cands) {
    if (c.includes('/') || c.includes('\\')) {
      if (!existsSync(c)) continue
    }
    const prefix = c === 'py' ? ['-3'] : []
    const r = await run(c, [...prefix, '-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: 15_000 })
    if (r.code === 0) {
      if (log) log.debug(`找到 python：${c} (${r.out.trim()})`)
      return { python: c, prefix, version: r.out.trim() }
    }
  }
  return null
}

/**
 * 一份完整的环境状态。
 *
 * @returns {{
 *   state:'ready'|'borrowed'|'missing'|'blocked',
 *   ready:boolean, engineReady:boolean, borrowed:boolean, blocked:boolean,
 *   canInstall:boolean, owned:boolean, dirUsable:boolean,
 *   python:string, version:string, rapidocr:string,
 *   venvExists:boolean, runScript:boolean, scriptVersion:string,
 *   dir:string, reason:string
 * }}
 */
export async function inspect({ dir, python: configured = '', log } = {}) {
  const out = {
    dir,
    state: 'missing',
    ready: false,
    engineReady: false,
    borrowed: false,
    blocked: false,
    canInstall: false,
    owned: false,
    dirOk: true,
    python: '',
    version: '',
    rapidocr: '',
    venvExists: false,
    runScript: false,
    scriptVersion: '',
    reason: '',
  }

  // ── 1. 目录先过一遍：别人的目录一律不碰 ──────────────────
  const usable = dirUsable(dir)
  out.dirOk = usable.ok
  out.scriptVersion = readVersionFile(dir)
  out.runScript = existsSync(join(dir, 'ocr_run.py'))
  if (!usable.ok) {
    out.state = 'blocked'
    out.blocked = true
    out.reason = usable.reason
    return out
  }

  // ── 2. 我们自己的 venv ───────────────────────────────────
  const vp = venvPython(dir)
  out.venvExists = existsSync(vp)
  if (out.venvExists) {
    out.owned = venvOwnedByShitu(dir)
    if (!out.owned) {
      // 目录里有 venv 但不是我们建的：不认领、不安装、不覆盖
      out.state = 'blocked'
      out.blocked = true
      out.reason =
        `这个目录里已经有一个不是本模块建的虚拟环境：${venvDirOf(dir)}\n` +
        '为避免装坏你已有的环境，这里不会动它。请在设置里换一个空目录。'
      return out
    }
    const p = await probePython(vp, { wantRapid: true })
    out.python = vp
    out.version = p.version || ''
    out.rapidocr = p.rapidocr || ''
    if (p.ok) {
      out.engineReady = true
      out.ready = Boolean(out.runScript)
      out.state = out.ready ? 'ready' : 'missing'
      if (!out.runScript) out.reason = '缺 ocr_run.py，点一下修复就会补上'
      return out
    }
    // 我们的 venv 但坏了：可以修（重建 / 重装）
    out.state = 'missing'
    out.canInstall = true
    out.reason = `自有环境不可用：${p.reason}`
  }

  // ── 3. 没有自有 venv：看看系统 python 里有没有现成的 ──────
  const found = await findPython({ configured, log })
  if (!found) {
    if (out.state !== 'missing') out.state = 'blocked'
    out.blocked = true
    out.reason = out.reason || '本机找不到可用的 python'
    return out
  }
  out.python = found.python
  out.version = found.version
  out.prefix = found.prefix
  out.canInstall = true

  const p = await probePython(found.python, { wantRapid: true, args: found.prefix })
  out.rapidocr = p.rapidocr || ''
  if (p.ok && out.runScript) {
    // 系统里本来就有：只读借用，不改它、不往里装东西
    out.state = 'borrowed'
    out.engineReady = true
    out.borrowed = true
    out.ready = true
    out.reason = '借用系统里已装的 rapidocr（不改动它；想更稳可以装一份独立的）'
    return out
  }
  if (p.ok && !out.runScript) {
    // 有引擎但缺脚本 —— 铺脚本就能用，不用装 320MB
    out.state = 'missing'
    out.canInstall = true
    out.reason = '系统里已有 rapidocr，只差脚本'
    return out
  }

  out.state = 'missing'
  out.canInstall = true
  out.reason = out.reason || '还没装识别引擎'
  return out
}

export function readVersionFile(dir) {
  try {
    return readFileSync(join(dir, VERSION_FILE), 'utf8').trim()
  } catch {
    return ''
  }
}
