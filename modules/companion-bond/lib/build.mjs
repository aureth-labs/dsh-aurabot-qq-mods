// 构建时才运行：macOS 从公开 Swift 源码编译显示程序；Linux 打包 job 验证并使用同一次 CI 的 Mac 构建产物。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cache = join(root, '.runtime', 'native')
const app = join(cache, 'CompanionBond.app')
const sourceFiles = ['CompanionBond.swift', 'GazeTracking.swift', 'IdleMotion.swift']
const inputs = ['module.json', 'lib/build.mjs', 'lib/native/Info.plist', ...sourceFiles.map(f => `lib/native/${f}`)]
const hash = b => createHash('sha256').update(b).digest('hex')
const fingerprint = () => hash(Buffer.concat(inputs.sort().flatMap(f => [Buffer.from(f + '\0'), readFileSync(join(root, f))])))
function regularFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw new Error('构建产物不允许符号链接')
    const path = prefix + e.name
    return e.isDirectory() ? regularFiles(join(dir, e.name), path + '/') : [path]
  }).sort()
}
function buildNative() {
  if (process.platform !== 'darwin') throw new Error('原生显示程序必须在 macOS 构建')
  rmSync(cache, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  cpSync(join(root, 'lib', 'native', 'Info.plist'), join(app, 'Contents', 'Info.plist'))
  const exe = join(app, 'Contents', 'MacOS', 'CompanionBond')
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macosx13.0', '-framework', 'AppKit', '-framework', 'CoreImage', ...sourceFiles.map(f => join(root, 'lib', 'native', f)), '-o', exe], { stdio: 'inherit' })
  chmodSync(exe, 0o755)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', app], { stdio: 'inherit' })
  const files = Object.fromEntries(regularFiles(app).map(f => [f, hash(readFileSync(join(app, f)))]))
  writeFileSync(join(cache, 'build.json'), JSON.stringify({ sourceFingerprint: fingerprint(), architecture: 'arm64', files }, null, 2) + '\n')
}
function verifyNative() {
  const metadata = join(cache, 'build.json')
  if (!existsSync(metadata)) throw new Error('缺少本次源码的 Mac 构建产物；先在 macOS 运行 npm run build:native，或从同一次 CI 的 native-macos job 下载产物')
  const m = JSON.parse(readFileSync(metadata, 'utf8'))
  if (m.architecture !== 'arm64' || m.sourceFingerprint !== fingerprint()) throw new Error('Mac 构建产物与当前源码不匹配')
  const files = regularFiles(app)
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(m.files).sort())) throw new Error('Mac 构建文件清单不匹配')
  for (const f of files) if (hash(readFileSync(join(app, f))) !== m.files[f]) throw new Error(`Mac 构建文件校验失败：${f}`)
}
if (process.platform === 'darwin') buildNative()
else verifyNative()
if (!process.argv.includes('--native-only')) {
  verifyNative()
  const out = join(root, '.build')
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
  for (const f of ['module.json', 'index.mjs', 'panel.js', 'README.md', 'LICENSE', 'package.json', 'lib', 'assets', 'docs']) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(out, f), { recursive: true })
  }
  mkdirSync(join(out, 'assets', 'desktop', 'macos-arm64'), { recursive: true })
  cpSync(app, join(out, 'assets', 'desktop', 'macos-arm64', 'CompanionBond.app'), { recursive: true })
  console.log('companion-bond 1.0.1 构建完成：三档待机与眼睛，无 Finder 控制或额外动作试作。')
}
