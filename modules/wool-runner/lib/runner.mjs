import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { cronMatches, extractCron, parseCron } from './cron.mjs'

const MAX_LOG = 1024 * 1024
const SAFE_SYSTEM_ENV = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
const taskId = (subscriptionId, file) => createHash('sha1').update(`${subscriptionId}:${file}`).digest('hex').slice(0, 16)
const safeRegex = (source) => { try { return source ? new RegExp(source, 'i') : null } catch { return null } }
const slash = (s) => s.split(sep).join('/')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function safeSystemEnv() {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) if (SAFE_SYSTEM_ENV.has(key.toUpperCase())) out[key] = value
  return out
}

function execute(command, args, { cwd, timeout = 120_000, env } = {}) {
  return new Promise((resolvePromise) => {
    let output = ''
    let child
    try { child = spawn(command, args, { cwd, env: env || safeSystemEnv(), shell: false, windowsHide: true }) }
    catch (error) { return resolvePromise({ code: -1, output: error.message }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeout)
    child.stdout?.on('data', (b) => { if (output.length < MAX_LOG) output += String(b) })
    child.stderr?.on('data', (b) => { if (output.length < MAX_LOG) output += String(b) })
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: -1, output: output + error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }) })
  })
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.aurabot-cache'].includes(entry.name)) continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else if (entry.isFile()) out.push(slash(relative(root, full)))
  }
  return out
}

function redact(text, secrets = []) {
  let out = String(text || '')
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[已隐藏]')
  return out.replace(/(pt_key|token|cookie|authorization|password|secret|access_token)[^\s;&]{0,24}[=:][^\s;&]{1,}/gi, '$1=[已隐藏]')
}

export function createRunner({ store, log, settings }) {
  const runtime = new Map()
  const syncing = new Map()
  const repoDir = (id) => join(store.root, 'repos', id)
  const inside = (root, target) => target === root || target.startsWith(root + sep)
  const subscription = (id) => {
    const item = store.state().subscriptions.find((s) => s.id === id)
    if (!item) throw new Error('订阅不存在')
    return item
  }
  const task = (id) => {
    const item = store.state().tasks.find((t) => t.id === id)
    if (!item) throw new Error('任务不存在')
    return item
  }
  const scriptPath = (item) => {
    const root = realpathSync(resolve(repoDir(item.subscriptionId)))
    const candidate = resolve(root, item.file)
    if (!inside(root, candidate)) throw new Error('脚本路径越界')
    const file = realpathSync(candidate)
    if (!inside(root, file) || !statSync(file).isFile()) throw new Error('脚本路径越界或不是普通文件')
    return file
  }

  /** 审批绑定完整来源和脚本内容；commit 可覆盖本地依赖变化，SHA-256 可覆盖工作区脚本篡改。 */
  function fingerprint(id) {
    const item = task(id)
    const sub = subscription(item.subscriptionId)
    const file = scriptPath(item)
    const hash = sha256(readFileSync(file))
    const source = { url: sub.url, branch: sub.branch, commit: sub.commit || '', file: item.file, sha256: hash }
    return { source, file, sub, fingerprint: sha256(JSON.stringify(source)) }
  }

  function authorize(id) {
    const snap = fingerprint(id)
    const approval = { fingerprint: snap.fingerprint, source: snap.source, approvedAt: new Date().toISOString() }
    store.upsertTask({ ...task(id), approval, revokedReason: '' })
    return { ...snap, approval }
  }

  function revoke(item, reason) {
    store.upsertTask({ ...item, enabled: false, approval: null, revokedReason: reason })
  }

  async function sync(id) {
    if (syncing.has(id)) return syncing.get(id)
    const job = (async () => {
      const item = subscription(id)
      if (!item.enabled) throw new Error('订阅已停用，请先编辑并启用')
      const dir = repoDir(id)
      mkdirSync(dirname(dir), { recursive: true })
      let result
      const signature = `${item.url}#${item.branch}`
      const signatureFile = join(store.root, 'repos', `${id}.source`)
      let previous = ''
      try { previous = readFileSync(signatureFile, 'utf8') } catch {}
      if (existsSync(join(dir, '.git')) && previous === signature) {
        result = await execute('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 180_000 })
      } else {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        result = await execute('git', ['clone', '--depth', '1', '--branch', item.branch, '--', item.url, dir], { timeout: 240_000 })
      }
      let offline = false
      if (result.code !== 0) {
        // 拉取失败（断网、GitHub 不可达等）：若本地已有可用源码，仍按现有源码登记定时任务，
        // 避免「网络问题」把用户已经下载好的脚本挡在任务列表之外。同步状态会标记为离线。
        const hasLocal = existsSync(join(dir, '.git'))
        if (!hasLocal) {
          store.updateSubscription(id, { lastSyncAt: new Date().toISOString(), lastSyncStatus: 'error', lastSyncMessage: result.output.slice(-1500) })
          throw new Error('拉取失败：' + result.output.slice(-600))
        }
        offline = true
      }
      if (!offline) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(signatureFile, signature, 'utf8')
      }
      const commit = await execute('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])
      const nextCommit = commit.code === 0 ? commit.output.trim() : ''
      if (item.commit && nextCommit && item.commit !== nextCommit) store.revokeTasks(id, '订阅已更新到新 commit，旧审批失效，任务已停用')
      const discovered = discover(id)
      let added = 0
      let updated = 0
      let removed = 0
      if (item.autoAddCron) {
        for (const script of discovered.filter((x) => x.cron)) {
          const tid = taskId(id, script.file)
          const existing = store.state().tasks.find((t) => t.id === tid)
          if (!existing) {
            store.upsertTask({ id: tid, subscriptionId: id, file: script.file, name: script.file, cron: script.cron, enabled: false, envNames: [], approval: null })
            added++
          } else if (existing.cron !== script.cron) {
            // 脚本里的 Cron 变了：只更新表达式，审批仍需重新确认（enabled 保持原状由审批门控）
            store.upsertTask({ ...existing, cron: script.cron })
            updated++
          }
        }
      }
      if (item.autoDelCron !== false) {
        // 同步即对齐：本订阅里已经不存在的脚本，其定时任务一并删除，避免残留跑空的旧任务。
        // 只清理本订阅的任务，且先停进程再删记录，不影响其它订阅。
        const existing = new Set(discovered.map((x) => x.file))
        for (const t of [...store.state().tasks]) {
          if (t.subscriptionId !== id) continue
          if (existing.has(t.file)) continue
          await stop(t.id, '脚本已从订阅消失，同步时清理')
          store.removeTask(t.id)
          removed++
        }
      }
      const detail = [
        `发现 ${discovered.length} 个脚本`,
        `新增 ${added} 个任务`,
        removed ? `清理 ${removed} 个失效任务` : '',
        updated ? `更新 ${updated} 个 Cron` : '',
      ].filter(Boolean).join('，')
      store.updateSubscription(id, {
        lastSyncAt: new Date().toISOString(), lastSyncStatus: offline ? 'offline' : 'ok',
        lastSyncMessage: `${offline ? '网络不可用，使用本地已有源码：' : ''}${detail}（新任务默认停用，需审批后启用）`,
        commit: nextCommit,
      })
      return {
        ok: true,
        offline,
        added, updated, removed,
        scripts: discovered.length,
        tasks: store.state().tasks.filter((t) => t.subscriptionId === id).length,
        message: `${offline ? '网络不可用，已按本地源码处理：' : '同步完成：'}${detail}；新任务默认停用，需在任务列表确认审批后启用`,
        scripts: discovered.length, added, updated, tasks: store.state().tasks.filter((t) => t.subscriptionId === id).length,
      }
    })().finally(() => syncing.delete(id))
    syncing.set(id, job)
    return job
  }

  function discover(id) {
    const item = subscription(id)
    const dir = repoDir(id)
    if (!existsSync(dir)) return []
    const white = safeRegex(item.whitelist)
    const black = safeRegex(item.blacklist)
    const extensions = new Set(String(item.extensions || 'js py sh').split(/\s+/).map((x) => x.replace(/^\./, '').toLowerCase()))
    return walk(dir).filter((file) => {
      const ext = file.split('.').pop().toLowerCase()
      return extensions.has(ext) && (!white || white.test(file)) && (!black || !black.test(file))
    }).map((file) => {
      let cron = ''
      let hash = ''
      try { const content = readFileSync(join(dir, file)); cron = extractCron(content.toString('utf8')); hash = sha256(content) } catch {}
      return { id: taskId(id, file), file, name: file.split('/').pop(), cron, sha256: hash, subscribed: store.state().tasks.some((t) => t.id === taskId(id, file)) }
    }).sort((a, b) => a.file.localeCompare(b.file, 'zh-CN'))
  }

  async function run(id, trigger = 'manual', options = {}) {
    const cfg = settings()
    if (cfg.enabled !== true) throw new Error('薅羊毛任务中心总开关未打开')
    if (runtime.get(id)?.status === 'running') throw new Error('这个任务正在运行')
    const maxConcurrent = Math.min(4, Math.max(1, Number(cfg.maxConcurrent || 2)))
    if ([...runtime.values()].filter((x) => x.status === 'running').length >= maxConcurrent) throw new Error(`最多同时运行 ${maxConcurrent} 个任务`)
    let item = task(id)
    const sub = subscription(item.subscriptionId)
    if (!sub.enabled) throw new Error('任务所属订阅已停用')
    if (trigger === 'schedule' && !item.enabled) throw new Error('任务定时未启用')
    const snap = fingerprint(id)
    if (trigger === 'manual' && options.confirm !== true) return { ok: false, needsConfirmation: true, message: '执行前必须确认来源与脚本内容', source: snap.source }
    if (item.approval?.fingerprint !== snap.fingerprint) {
      if (trigger === 'manual' && options.confirm === true) {
        authorize(id)
        item = task(id)
      } else {
        revoke(item, '脚本内容或来源已变化，旧审批失效，任务已停用')
        throw new Error('脚本内容或来源已变化，必须重新审查并确认')
      }
    }
    const file = snap.file
    const ext = file.split('.').pop().toLowerCase()
    let command = process.execPath
    const memoryMb = Math.min(2048, Math.max(64, Number(cfg.memoryMb || 256)))
    let args = [`--max-old-space-size=${memoryMb}`, file]
    // 不继承 DSH/Electron 的账号、API Key 等环境；只注入用户明确授权给此任务的变量。
    const envNames = Array.isArray(item.envNames) ? item.envNames : []
    const env = { ...safeSystemEnv(), ...store.envValues(envNames), ELECTRON_RUN_AS_NODE: '1', QL_DIR: repoDir(sub.id), QL_SCRIPTS_DIR: repoDir(sub.id) }
    if (ext === 'py') { command = cfg.pythonPath || 'python'; args = [file] }
    else if (ext === 'sh') { command = cfg.bashPath || 'bash'; args = [file] }
    else if (!['js', 'mjs', 'cjs'].includes(ext)) throw new Error('不支持这个脚本类型')
    if (cfg.nodePath && ['js', 'mjs', 'cjs'].includes(ext)) command = cfg.nodePath
    const runId = randomUUID()
    const at = new Date()
    const logDir = join(store.root, 'logs', id)
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, `${at.toISOString().replace(/[:.]/g, '-')}.log`)
    const runRecord = { id: runId, taskId: id, taskName: item.name, trigger, startedAt: at.toISOString(), status: 'running', logPath, approvedAt: item.approval.approvedAt, sourceCommit: sub.commit || '' }
    store.addRun(runRecord)
    store.upsertTask({ ...item, lastRunAt: at.toISOString(), lastStatus: 'running' })
    const child = spawn(command, args, { cwd: dirname(file), env, shell: false, windowsHide: true, detached: process.platform !== 'win32' })
    const current = { status: 'running', pid: child.pid, child, runId, logPath }
    runtime.set(id, current)
    const stream = createWriteStream(logPath, { encoding: 'utf8', mode: 0o600 })
    stream.write(`## 开始执行 ${at.toLocaleString()}\n## ${item.name}\n## 来源 ${sub.url}#${sub.branch}@${sub.commit || 'unknown'}\n## 脚本 SHA-256 ${snap.source.sha256}\n\n`)
    let size = 0
    let truncated = false
    const write = (chunk) => {
      const text = redact(String(chunk), store.envSecrets())
      if (size + text.length > MAX_LOG) {
        if (!truncated) { stream.write('\n[日志超过 1 MiB，后续输出已截断]\n'); truncated = true }
        size = MAX_LOG + 1
        return
      }
      stream.write(text); size += text.length
    }
    child.stdout?.on('data', write); child.stderr?.on('data', write)
    const timeout = setTimeout(() => stop(id, '任务超时'), Math.max(60_000, Number(cfg.timeoutMinutes || 30) * 60_000))
    child.on('error', (error) => write(`\n启动失败：${error.message}\n`))
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      const status = current.status === 'stopping' ? 'stopped' : code === 0 ? 'success' : 'error'
      // 先等日志流真正落盘（finish 事件），再更新运行状态——否则读取方可能看到「已结束」但日志还是空的
      stream.end(`\n## 执行结束 ${new Date().toLocaleString()}，退出码 ${code ?? ''} ${signal || ''}\n`)
      const settle = () => {
        runtime.delete(id)
        store.updateRun(runId, { status, code, signal: signal || '', finishedAt: new Date().toISOString(), logTruncated: truncated })
        const latest = store.state().tasks.find((t) => t.id === id)
        if (latest) store.upsertTask({ ...latest, lastStatus: status, lastExitCode: code, lastFinishedAt: new Date().toISOString() })
        log?.[status === 'success' ? 'info' : 'warn'](`薅羊毛任务「${item.name}」：${status}`)
      }
      stream.once('finish', settle)
      stream.once('error', settle)
    })
    return { ok: true, message: '任务已按已确认的来源与内容启动', runId, pid: child.pid }
  }

  async function stop(id, reason = '手动停止') {
    const current = runtime.get(id)
    if (!current) return { ok: true, message: '任务没有在运行' }
    current.status = 'stopping'
    try {
      if (process.platform === 'win32') await execute('taskkill', ['/pid', String(current.pid), '/T', '/F'], { timeout: 10_000 })
      else process.kill(-current.pid, 'SIGTERM')
    } catch { try { current.child.kill('SIGTERM') } catch {} }
    store.updateRun(current.runId, { stopReason: reason })
    return { ok: true, message: '已发送停止指令' }
  }

  function tick(now = new Date()) {
    if (settings().enabled !== true) return
    for (const item of store.state().tasks) {
      if (!item.enabled || runtime.has(item.id)) continue
      try {
        if (!item.approval || !subscription(item.subscriptionId).enabled) { revoke(item, '缺少有效审批或订阅已停用'); continue }
        const key = `${Math.floor(now.getTime() / 1000)}`
        if (item.lastScheduleKey === key) continue
        if (cronMatches(parseCron(item.cron), now)) {
          store.upsertTask({ ...item, lastScheduleKey: key })
          run(item.id, 'schedule').catch((error) => log?.warn(`定时任务 ${item.name}：${error.message}`))
        }
      } catch (error) { log?.warn(`任务「${item.name}」调度失败：${error.message}`) }
    }
  }

  async function readLog(runId) {
    const item = store.runs().find((r) => r.id === runId)
    if (!item) throw new Error('运行记录不存在')
    let content = ''
    try { content = readFileSync(item.logPath, 'utf8') } catch { content = '日志文件不存在或已清理' }
    return { ...item, content: redact(content.slice(-MAX_LOG), store.envSecrets()) }
  }

  function dispose() { for (const id of [...runtime.keys()]) stop(id, '模块停止') }
  return { runtime, sync, discover, run, stop, tick, readLog, dispose, repoDir, fingerprint, authorize }
}
