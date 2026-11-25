// 安装器：建 venv、装 rapidocr、铺脚本。
//
// 安全边界（重点）：
//   · 只在「目录是空的 / 是本模块铺过的」时候才往里面写东西
//   · 只在「venv 有 .shitu-owned 标记」时才认为那是自己的环境
//   · 系统 python 里已经装好的 rapidocr 只借用，不升级、不写入
//   · 每一步都可重复跑：中途失败留下的半成品会被补齐，不会重复下载
//
// 只在 env.state === 'missing' 时才真正动手；ready / borrowed / blocked 一律不装。

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OWNED_MARKER,
  VERSION_FILE,
  dirUsable,
  findPython,
  inspect,
  probePython,
  run,
  venvDirOf,
  venvOwnedByShitu,
  venvPython,
} from './env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'assets')
const SCRIPT_FILES = ['ocr_core.py', 'ocr_run.py', 'ocr_mcp.py', 'selftest.png']

/** 部署脚本的版本：assets 里的 py 改了就把这个数改大，已部署的会自动覆盖。 */
export const ASSETS_VERSION = '1.0.0'

export const PIP_PACKAGES = ['rapidocr-onnxruntime', 'pillow', 'numpy']

const LOCK_NAME = '.shitu-installing'
const LOCK_STALE_MS = 30 * 60_000

/**
 * 跨实例的安装锁。模块被文件监听重载时会出现好几个实例，
 * 每个都起了 pip 就会互相抢同一个 .venv 里的 .pyd（WinError 5）。
 * @returns {{ ok: boolean, reason?: string, release: Function }}
 */
function acquireLock(dirPath) {
  const file = join(dirPath, LOCK_NAME)
  try {
    mkdirSync(dirPath, { recursive: true })
    // 陈旧锁（进程崩了 / 被杀）直接清掉
    try {
      const st = statSync(file)
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) rmSync(file, { force: true })
    } catch {}
    const fd = openSync(file, 'wx')
    closeSync(fd)
    writeFileSync(file, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
    return {
      ok: true,
      release: () => {
        try {
          rmSync(file, { force: true })
        } catch {}
      },
    }
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, reason: '另一个实例正在安装', release() {} }
    return { ok: false, reason: String(error.message || error), release() {} }
  }
}

/**
 * @param {{ log, settings:()=>object, dataDir:(...p:string[])=>string, onState?:Function }} deps
 */
export function createInstaller({ log, settings, dataDir, onState } = {}) {
  const state = {
    phase: 'idle', // idle | blocked | scripts | venv | pip | selftest | ready | error
    step: '',
    detail: '',
    percent: 0,
    startedAt: 0,
    finishedAt: 0,
    error: '',
    engine: '',
    python: '',
    dir: '',
    running: false,
  }
  let inflight = null

  const emit = (patch) => {
    Object.assign(state, patch)
    try {
      onState?.(state)
    } catch {}
  }

  function dir() {
    const custom = String((settings() || {}).dir || '').trim()
    return custom || dataDir('ocr')
  }

  /**
   * 把 assets 里的脚本铺到目标目录（内容不同才写）。
   *
   * 开工前先过 dirUsable：不是我们的目录就一个字节都不写。
   * 这条是防「用户把 dir 指到自己已有的 OCR 工程」——那种情况下写进去
   * 等于覆盖人家正在用的 ocr_core.py。
   */
  function deployScripts(target) {
    const usable = dirUsable(target)
    if (!usable.ok) return { wrote: [], blocked: usable.reason }
    mkdirSync(target, { recursive: true })
    const wrote = []
    for (const name of SCRIPT_FILES) {
      const src = join(ASSETS, name)
      const dst = join(target, name)
      if (!existsSync(src)) continue
      const a = readFileSync(src)
      if (existsSync(dst)) {
        const b = readFileSync(dst)
        if (a.length === b.length && a.equals(b)) continue
      }
      copyFileSync(src, dst)
      wrote.push(name)
    }
    writeFileSync(join(target, VERSION_FILE), ASSETS_VERSION + '\n', 'utf8')
    return { wrote, blocked: '' }
  }

  /** 给自己建的 venv 打归属标记；老版本建的要先确认来源再认领。 */
  function markVenvOwned(target) {
    const vd = venvDirOf(target)
    if (!existsSync(vd)) return false
    if (existsSync(join(vd, OWNED_MARKER))) return true
    if (!venvOwnedByShitu(target)) return false
    try {
      writeFileSync(
        join(vd, OWNED_MARKER),
        `created=${new Date().toISOString()}\nassets=${ASSETS_VERSION}\nby=shitu\n`,
        'utf8',
      )
      log?.info('认领了旧版本的虚拟环境（补写归属标记，不用重装）')
      return true
    } catch (error) {
      log?.warn('写归属标记失败：', error.message)
      return false
    }
  }

  /** 用 selftest.png 跑一次真实识别，确认模型能加载、中文能读出来。 */
  async function selfTest(target, python, args = []) {
    const img = join(target, 'selftest.png')
    if (!existsSync(img)) return { ok: false, message: '缺少 selftest.png' }
    return selfTestFile(target, python, img, args)
  }

  /** 用任意一张本机图片跑一次识别（面板「测一张」也走这里）。 */
  async function selfTestFile(target, python, imgPath, args = []) {
    const b64 = readFileSync(imgPath).toString('base64')
    const payload = JSON.stringify({ images: [{ id: 't', data: b64 }] })
    const r = await run(python, [...args, join(target, 'ocr_run.py')], {
      cwd: target,
      timeoutMs: 180_000,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      input: payload,
    })
    if (r.code !== 0) return { ok: false, message: (r.err || r.out || `退出码 ${r.code}`).slice(-900) }
    let data
    try {
      const last = String(r.out).trim().split('\n').filter(Boolean).pop()
      data = JSON.parse(last)
    } catch {
      return { ok: false, message: '输出不是 JSON：' + String(r.out).slice(-400) }
    }
    const one = data?.results?.[0]
    if (!one?.ok) return { ok: false, message: one?.error || '识别失败' }
    const lines = (one.lines || []).length
    if (!lines) return { ok: false, message: '图里没读出任何文字，模型可能没下全', elapsedMs: one.elapsedMs }
    return {
      ok: true,
      message: `${lines} 行，${one.elapsedMs}ms`,
      text: one.text,
      lines,
      elapsedMs: one.elapsedMs,
      engine: data.engine || '',
    }
  }

  async function ensure({ force = false } = {}) {
    if (inflight) return inflight
    inflight = (async () => {
      const target = dir()
      const s = settings() || {}
      emit({
        running: true,
        phase: 'checking',
        step: '检查环境',
        detail: '',
        percent: 2,
        error: '',
        dir: target,
        startedAt: Date.now(),
        finishedAt: 0,
      })

      // ── 0. 先探，再决定要不要动 ──────────────────────────
      const before = await inspect({ dir: target, python: String(s.python || ''), log })

      // 已经好了（自有环境就绪，或借用系统环境跑得通）：什么都不做
      if (!force && (before.state === 'ready' || before.state === 'borrowed')) {
        // 顺手认领：老版本建的 venv 没有标记，补一个，以后判断更快也更准。
        // 幂等，且只对「确实是我们的」生效。
        if (before.owned) markVenvOwned(target)
        emit({
          phase: 'ready',
          step: '已就绪',
          detail: before.reason || `引擎 ${before.rapidocr || '?'}`,
          engine: before.rapidocr || '',
          python: before.python || '',
          percent: 100,
          finishedAt: Date.now(),
          running: false,
        })
        return state
      }

      // 明确不该装的四种情况：别人的目录、别人的 venv、没 python
      if (before.state === 'blocked') {
        emit({
          phase: 'blocked',
          step: '不会自动安装',
          error: before.reason,
          percent: 0,
          finishedAt: Date.now(),
          running: false,
        })
        return state
      }

      const lock = acquireLock(target)
      if (!lock.ok) {
        emit({
          phase: 'idle',
          step: '已有一个安装在进行',
          detail: lock.reason || '',
          running: false,
          percent: state.percent,
        })
        return state
      }

      try {
        // ── 1. 铺脚本（已确认目录是我们的 / 空的）────────────
        emit({ phase: 'scripts', step: '铺装脚本', percent: 6 })
        const dep = deployScripts(target)
        if (dep.blocked) {
          emit({
            phase: 'blocked',
            step: '目录不能写',
            error: dep.blocked,
            percent: 0,
            finishedAt: Date.now(),
            running: false,
          })
          return state
        }
        if (dep.wrote.length) log?.info(`铺了 ${dep.wrote.length} 个脚本：${dep.wrote.join(', ')}`)

        // ── 2. 再探一次：脚本刚铺好，可能已经能借用系统环境了 ──
        emit({ step: '检查引擎', percent: 10 })
        const env = await inspect({ dir: target, python: String(s.python || ''), log })

        // 自有 venv + 脚本都齐了
        if (env.state === 'ready') {
          emit({
            phase: 'ready',
            step: '已就绪',
            detail: `引擎 ${env.rapidocr || '?'}`,
            engine: env.rapidocr || '',
            python: env.python || '',
            percent: 100,
            finishedAt: Date.now(),
            running: false,
          })
          return state
        }

        // 系统里本来就有 rapidocr：只自检一下，不建 venv、不装包
        if (env.state === 'borrowed' || (env.engineReady && !env.venvExists)) {
          emit({ phase: 'selftest', step: '自检（借用系统环境）', percent: 80, engine: env.rapidocr || '', python: env.python || '' })
          const r = await selfTest(target, env.python, env.prefix || [])
          emit(
            r.ok
              ? {
                  phase: 'ready',
                  step: '已就绪',
                  percent: 100,
                  detail: `${r.message} · 借用系统 rapidocr，未改动它`,
                  engine: env.rapidocr || '',
                  python: env.python || '',
                  finishedAt: Date.now(),
                  running: false,
                }
              : {
                  phase: 'error',
                  step: '借用系统环境自检失败',
                  error: r.message + '\n\n可以在设置里把「引擎目录」指到一个空目录，让模块建一份独立的。',
                  percent: 100,
                  finishedAt: Date.now(),
                  running: false,
                },
          )
          return state
        }

        // ── 3. 找 python ────────────────────────────────────
        const found =
          env.python && env.canInstall
            ? { python: env.python, prefix: env.prefix || [], version: env.version }
            : await findPython({ configured: String(s.python || ''), log })
        if (!found) {
          emit({
            phase: 'error',
            step: '缺 Python',
            error: '本机找不到可用的 python。装一个 Python 3.9+ 并勾选 Add to PATH，或在设置里填 python.exe 的绝对路径。',
            percent: 100,
            finishedAt: Date.now(),
            running: false,
          })
          return state
        }
        emit({ python: found.python, detail: `python ${found.version}`, percent: 15 })

        // ── 4. 建 venv（已存在且是我们的就复用）──────────────
        const vp = venvPython(target)
        const existingOwned = existsSync(vp) && venvOwnedByShitu(target)
        if (!existingOwned) {
          if (existsSync(vp)) {
            // 走到这里说明 venv 存在但不是我们的 —— 上面 blocked 应该已经拦住了，
            // 这里是第二道闸：绝不删别人的环境。
            emit({
              phase: 'blocked',
              step: '虚拟环境不是本模块建的',
              error: `${venvDirOf(target)} 已存在且不是本模块创建，不会覆盖它。请换一个空目录。`,
              percent: 0,
              finishedAt: Date.now(),
              running: false,
            })
            return state
          }
          emit({ phase: 'venv', step: '建虚拟环境', percent: 22 })
          mkdirSync(target, { recursive: true })
          const r = await run(found.python, [...found.prefix, '-m', 'venv', venvDirOf(target)], {
            timeoutMs: 5 * 60_000,
            env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          })
          if (r.code !== 0 || !existsSync(vp)) {
            emit({
              phase: 'error',
              step: '建 venv 失败',
              error: (r.err || r.out || '未知错误').slice(-1000),
              percent: 100,
              finishedAt: Date.now(),
              running: false,
            })
            return state
          }
          markVenvOwned(target)
        } else {
          emit({ step: '复用已有虚拟环境', percent: 22 })
          markVenvOwned(target)
        }

        // ── 5. venv 里得有 pip；没有就 ensurepip ─────────────
        const pipOk = await run(vp, ['-m', 'pip', '--version'], { timeoutMs: 60_000 })
        if (pipOk.code !== 0) {
          emit({ step: '补装 pip', percent: 26 })
          await run(vp, ['-m', 'ensurepip', '--upgrade'], { timeoutMs: 3 * 60_000 })
        }

        // ── 6. 装引擎前再看一眼：import 得到就跳过 pip ────────
        const already = await probePython(vp, { wantRapid: true })
        if (already.ok) {
          emit({ step: '引擎已在，跳过下载', percent: 80, engine: already.rapidocr || '' })
        } else {
          emit({
            phase: 'pip',
            step: '装识别引擎（首次约 320MB）',
            detail: 'pip install rapidocr-onnxruntime',
            percent: 30,
          })
          const extra = ['-U', ...PIP_PACKAGES]
          const index = String(s.pipIndex || '').trim()
          if (index) extra.push('-i', index)
          const pr = await run(vp, ['-m', 'pip', 'install', ...extra], {
            timeoutMs: 20 * 60_000,
            env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
          })
          if (pr.code !== 0) {
            // pip 偶尔在 Windows 上因为文件被占用（杀软扫描 / 别的实例在用）报 WinError 5，
            // 但包其实已经装好了。先复核一次，能用就继续，别让用户看到一个假失败。
            const after = await probePython(vp, { wantRapid: true })
            if (!after.ok) {
              emit({
                phase: 'error',
                step: 'pip 装包失败',
                error: (pr.err || pr.out || '未知错误').slice(-1400),
                percent: 100,
                finishedAt: Date.now(),
                running: false,
              })
              return state
            }
            log?.warn('pip 报错但包已经可用，继续自检：' + (pr.err || '').trim().slice(-200))
          }
        }

        // ── 7. 复核 import + 自检 ───────────────────────────
        emit({ step: '复核引擎', percent: 85 })
        const again = await probePython(vp, { wantRapid: true })
        if (!again.ok) {
          emit({
            phase: 'error',
            step: '装了但 import 不到',
            error: again.reason || '',
            percent: 100,
            finishedAt: Date.now(),
            running: false,
          })
          return state
        }
        emit({ phase: 'selftest', step: '自检', percent: 90, engine: again.rapidocr || '', python: vp })
        const sr = await selfTest(target, vp)
        emit(
          sr.ok
            ? {
                phase: 'ready',
                step: '已就绪',
                percent: 100,
                detail: sr.message + (sr.engine ? ` · ${sr.engine}` : ''),
                engine: sr.engine || again.rapidocr || '',
                python: vp,
                finishedAt: Date.now(),
                running: false,
              }
            : { phase: 'error', step: '自检失败', error: sr.message, percent: 100, finishedAt: Date.now(), running: false },
        )
        return state
      } catch (error) {
        emit({
          phase: 'error',
          step: '安装出错',
          error: String(error?.message || error).slice(0, 1400),
          percent: 100,
          finishedAt: Date.now(),
          running: false,
        })
        return state
      } finally {
        lock.release()
        inflight = null
      }
    })()
    return inflight
  }

  return {
    state,
    dir,
    ensure,
    selfTest,
    selfTestFile,
    deployScripts,
    /** 只读探针：不触发安装。 */
    async status() {
      const target = dir()
      const env = await inspect({ dir: target, python: String((settings() || {}).python || ''), log })
      return { ...env, running: state.running, phase: state.phase, progress: state }
    },
  }
}
