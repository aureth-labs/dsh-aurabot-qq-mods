// Electron 运行时的定位与启动参数（纯函数，除 path.join 外不碰磁盘，方便单测）。
//
// 这个模块不自己下载运行时，按顺序找现成的：
//   1. 本模块数据目录里装过的（面板「安装 Electron」用本机 npm 装的）
//   2. 桌宠模块装过的（同一台机器多半已经有，白捡，零下载）
// 两处都没有 → 面板提示装一次。代码里没有任何联网下载，装运行时是 npm 子进程干的活。

import { dirname, join } from 'node:path'

export const ELECTRON_VERSION = '45.1.0' // 客户端按这版验证过；装的时候钉住，别跟着 latest 漂
export const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/electron/'

/** 镜像地址：面板留空或写了不像 URL 的东西，回落内置默认；末尾一定带 /。 */
export function mirrorUrl(raw = '') {
  const base = /^https?:\/\//i.test(String(raw).trim()) ? String(raw).trim() : DEFAULT_MIRROR
  return base.endsWith('/') ? base : base + '/'
}

export function electronRelExe(platform = process.platform) {
  if (platform === 'win32') return ['dist', 'electron.exe']
  if (platform === 'darwin') return ['dist', 'Electron.app', 'Contents', 'MacOS', 'Electron']
  return ['dist', 'electron']
}

/**
 * 候选运行时：[{ dir, source }]，dir 是 node_modules/electron 的位置。
 * petDir 传桌宠的数据目录（没装桌宠就传空）。
 */
export function electronCandidates({ appDir, petDir }) {
  const rel = ['node_modules', 'electron']
  const out = [{ dir: join(appDir, ...rel), source: 'billiards' }]
  if (petDir) out.push({ dir: join(petDir, 'app', ...rel), source: 'pet' })
  return out
}

/** npm-cli.js 的候选位置：跟着当前 Node 走，找不到说明这台机器没有可用的 npm（返回空数组）。 */
export function npmCliCandidates(execPath) {
  return [
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
}

/** 启动 Electron 前的 env：ELECTRON_RUN_AS_NODE 会把 electron.exe 变成 node，窗口永远起不来。 */
export function cleanElectronEnv(env = process.env) {
  const out = { ...env }
  delete out.ELECTRON_RUN_AS_NODE
  delete out.ELECTRON_NO_ATTACH_CONSOLE
  return out
}
