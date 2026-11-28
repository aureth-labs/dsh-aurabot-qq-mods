// 启动脚本子进程：不用 shell，参数逐项传；超时/输出上限到了就杀掉整棵进程树。
import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { buildEnv, normalizeArgs, normalizeName, permissionFlagFor, scriptPath, ScriptError } from './policy.mjs'

function missingRuntime(config) {
  if (config.runtime === 'powershell') {
    return `找不到 PowerShell：现在用的是「${config.powershellPath}」。装 PowerShell 7，或者在面板把「PowerShell 路径」填成完整路径；也可以把运行时改成 Node（不需要 PowerShell）。`
  }
  return '找不到 Node 来跑脚本（一般是 Aurabot 的运行环境不对）'
}

function killTree(child) {
  if (!child || child.exitCode != null) return
  try {
    child.kill('SIGKILL')
  } catch {}
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {})
    } catch {}
  }
}

export function createRunner(getConfig, { log } = {}) {
  let active = null
  let starts = []
  let disposed = false
  // 先占坑再 await：否则两个 run 会同时通过 active 检查。
  let busy = false

  async function run(nameInput, { args, input = '' } = {}) {
    if (disposed) throw new ScriptError('模块正在停止，跑不了')
    if (busy || active) throw new ScriptError('上一个脚本还在跑，等它结束再来')
    busy = true
    try {
      const config = getConfig()
      const name = normalizeName(nameInput)
      const file = scriptPath(config, name)
      const stat = await lstat(file).catch((error) => {
        if (error.code === 'ENOENT') throw new ScriptError(`没有叫「${name}」的脚本，先写一个`)
        throw new ScriptError(`读不了「${name}」：${error.message}`)
      })
      if (stat.isSymbolicLink()) throw new ScriptError(`「${name}」是符号链接，不跑`)
      if (!stat.isFile()) throw new ScriptError(`「${name}」不是文件`)
      if (stat.size > config.maxScriptBytes) {
        throw new ScriptError(`「${name}」超过 ${config.maxScriptBytes / 1024} KB 上限`)
      }
      if (disposed) throw new ScriptError('模块正在停止，跑不了')

      const now = Date.now()
      starts = starts.filter((time) => now - time < 3600_000)
      if (starts.length >= config.maxRunsPerHour) {
        throw new ScriptError(`一小时最多跑 ${config.maxRunsPerHour} 次，等一会儿再来`)
      }
      const argv = normalizeArgs(args)
      const stdin = String(input ?? '')
      if (stdin.length > 8000) throw new ScriptError('input 最多 8000 个字')
      if (stdin.includes('\u0000')) throw new ScriptError('input 里不能有 NUL 字符')

      let command
      let commandArgs
      if (config.runtime === 'node') {
        command = process.execPath
        commandArgs = config.nodeSandbox
          ? [permissionFlagFor(process.versions.node), `--allow-fs-read=${config.scriptDir}`, `--allow-fs-write=${config.scriptDir}`, file, ...argv]
          : [file, ...argv]
      } else {
        command = config.powershellPath
        commandArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...argv]
      }

      const startedAt = Date.now()
      let child
      try {
        child = spawn(command, commandArgs, {
          cwd: config.scriptDir,
          env: buildEnv(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        })
      } catch (error) {
        throw new ScriptError(`启动失败：${error.message}`)
      }

      active = { child, startedAt }
      starts.push(startedAt)
      log?.info?.(`[game-scripts] 跑 ${name}（${config.runtime}，${config.timeoutMs} ms）`)

      return await new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let bytes = 0
        let truncated = false
        let timedOut = false
        let settled = false
        let spawnError = null

        const timer = setTimeout(() => {
          timedOut = true
          killTree(child)
        }, config.timeoutMs)

        const finish = (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (active?.child === child) active = null
          const durationMs = Date.now() - startedAt
          const ok = !spawnError && !timedOut && !truncated && code === 0 && !signal
          const parts = []
          if (spawnError) {
            parts.push(spawnError.code === 'ENOENT' ? missingRuntime(config) : `启动失败：${spawnError.message}`)
          } else {
            parts.push(`退出码 ${code == null ? '无' : code}${signal ? `，信号 ${signal}` : ''}，耗时 ${durationMs} ms`)
            if (timedOut) parts.push(`超时：超过 ${config.timeoutMs / 1000} 秒，已经停掉`)
            if (truncated) parts.push(`输出超过 ${config.maxOutputBytes / 1024} KB，后面的没要`)
          }
          if (stdout.trim()) parts.push(`stdout：\n${stdout.trimEnd()}`)
          if (stderr.trim()) parts.push(`stderr：\n${stderr.trimEnd()}`)
          if (!spawnError && !stdout.trim() && !stderr.trim()) parts.push('（脚本没有输出）')
          resolve({
            ok,
            name,
            file,
            code,
            signal,
            timedOut,
            truncated,
            durationMs,
            stdout,
            stderr,
            message: parts.join('\n'),
          })
        }

        const collect = (chunk, target) => {
          if (settled) return
          const left = config.maxOutputBytes - bytes
          if (left <= 0) {
            truncated = true
            killTree(child)
            return
          }
          const part = chunk.length > left ? chunk.subarray(0, left) : chunk
          if (target === 'out') stdout += part.toString('utf8')
          else stderr += part.toString('utf8')
          bytes += part.length
          if (part.length < chunk.length) {
            truncated = true
            killTree(child)
          }
        }

        child.stdout?.on('data', (chunk) => collect(chunk, 'out'))
        child.stderr?.on('data', (chunk) => collect(chunk, 'err'))
        child.stdin?.on('error', () => {})
        child.on('error', (error) => {
          spawnError = error
          finish(null, null)
        })
        child.on('close', (code, signal) => finish(code, signal))
        try {
          child.stdin.end(stdin || undefined)
        } catch {}
      })
    } finally {
      busy = false
    }
  }

  function dispose() {
    disposed = true
    if (active?.child) killTree(active.child)
  }

  return { run, dispose }
}
