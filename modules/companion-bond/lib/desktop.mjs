import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

export const DESKTOP_DEFAULTS = { desktopEnabled: true, desktopIdleEnabled: true, desktopHeight: 300, desktopPreviewStage: 'auto' }
export const CHARACTER_NAMES = { low: '低级 · Q 版', middle: '中级 · 精细版', high: '高级 · 简约版' }
export function desktopSettings(raw = {}) {
  const n = Number(raw.desktopHeight ?? 300)
  return {
    desktopEnabled: raw.desktopEnabled !== false,
    desktopIdleEnabled: raw.desktopIdleEnabled !== false,
    desktopHeight: Number.isFinite(n) ? Math.round(Math.min(600, Math.max(140, n))) : 300,
    desktopPreviewStage: ['low', 'middle', 'high'].includes(raw.desktopPreviewStage) ? raw.desktopPreviewStage : 'auto',
  }
}
export function characterFor(bond) {
  const n = Number(bond) || 0
  return n >= 600 ? 'high' : n >= 100 ? 'middle' : 'low'
}

// 只启动随包分发、由公开 Swift 源码构建的显示程序。非 Apple Silicon Mac 不启动进程。
export function createDesktop({ moduleDir, dataDir, getSettings, getState, saveSettings, log,
  platform = process.platform, arch = process.arch, spawnFn = spawn, now = Date.now }) {
  const bridge = join(dataDir, 'desktop-state.json')
  const request = join(dataDir, 'desktop-request.json')
  const app = join(moduleDir, 'assets', 'desktop', `macos-${arch}`, 'CompanionBond.app')
  const exe = join(app, 'Contents', 'MacOS', 'CompanionBond')
  const session = randomUUID()
  const supported = platform === 'darwin' && arch === 'arm64'
  let child = null, stopped = false, lastAttempt = -Infinity, lastWrite = -Infinity, signature = '', error = ''
  function stop() {
    if (child) { const old = child; child = null; old.kill('SIGTERM') }
  }
  function write(value) {
    const tmp = bridge + '.tmp'
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    renameSync(tmp, bridge)
  }
  function handleRequest() {
    if (!existsSync(request)) return
    try {
      const r = JSON.parse(readFileSync(request, 'utf8'))
      unlinkSync(request)
      if (r.session !== session) return
      if (r.action === 'idle' && typeof r.enabled === 'boolean') saveSettings({ desktopIdleEnabled: r.enabled })
      if (r.action === 'hide') saveSettings({ desktopEnabled: false })
      if (r.action === 'preview' && ['auto', 'low', 'middle', 'high'].includes(r.stage)) saveSettings({ desktopPreviewStage: r.stage })
    } catch (e) { log.warn('读取桌面立绘操作失败：' + e.message) }
  }
  function info() {
    const cfg = desktopSettings(getSettings())
    const stage = cfg.desktopPreviewStage === 'auto' ? characterFor(getState().bond) : cfg.desktopPreviewStage
    return { ...cfg, supported, available: supported && existsSync(exe), running: Boolean(child), stage,
      stageName: CHARACTER_NAMES[stage], preview: cfg.desktopPreviewStage !== 'auto', error }
  }
  function sync() {
    if (stopped) return
    handleRequest()
    const s = info()
    const frame = {
      session, enabled: s.desktopEnabled && supported, height: s.desktopHeight, stage: s.stage,
      stageName: s.stageName, preview: s.preview, bond: Math.round(getState().bond),
      assetPath: join(moduleDir, 'assets', 'characters', s.stage + '.png'),
      parentPid: process.pid, idleEnabled: s.desktopIdleEnabled,
      idleBlinkPath: join(moduleDir, 'assets', 'animations', `idle-${s.stage}-closed.png`),
    }
    const nextSignature = JSON.stringify(frame)
    if (signature !== nextSignature || now() - lastWrite > 4000) {
      write({ ...frame, updatedAt: now() })
      signature = nextSignature; lastWrite = now()
    }
    if (!s.desktopEnabled || !supported) { stop(); return }
    if (!s.available) { error = '桌面程序缺失，请重新安装完整的模块发布包。'; return }
    if (child || now() - lastAttempt < 10_000) return
    lastAttempt = now()
    try {
      chmodSync(exe, 0o755)
      const next = spawnFn('/usr/bin/open', ['-W', '-n', '-a', app, '--args', bridge], { stdio: 'ignore', windowsHide: true })
      child = next; error = ''
      next.on('error', e => { if (child === next) { child = null; error = e.message; log.warn('桌面立绘启动失败：' + e.message) } })
      next.on('exit', code => { if (child === next) { child = null; if (code) error = '桌面程序退出，代码 ' + code } })
    } catch (e) { child = null; error = e.message; log.warn('桌面立绘启动失败：' + e.message) }
  }
  function dispose() {
    if (stopped) return
    stopped = true
    // 关闭启动器的同时写停用状态。窗口还会检查宿主 PID、本次会话和心跳自行退出。
    try { write({ session, enabled: false, parentPid: process.pid, updatedAt: now() }) } catch { /* 宿主正在退出 */ }
    stop()
  }
  return { sync, info, dispose }
}
