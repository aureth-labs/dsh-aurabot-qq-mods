// 进程身份识别：killBridge 只该杀「命令行里确实是小屋世界桥」的进程。
// 0.4.4 的 killBridge 用 /bridge-host/ + /bridge.mjs/ 两个分散正则，会把命令行里恰好含
// 这两段字样的无关进程（编辑器、grep、某些脚本）判成桥然后 taskkill。
// 这里造一个这样的进程：bridgeAlive 必须返回 0、killBridge 必须不动它；
// 同时验证「真的是这个 gameDir 的副本桥」仍然认得出、杀得掉（别把功能改坏）。
// 用法：node test/proc-identity.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { bridgeAlive, killBridge } from '../lib/host.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}
const nap = (ms) => new Promise(function (r) { setTimeout(r, ms) })

// 只需要能算出 <gameDir>/bridge-host/bridge.mjs 这个路径，不必真装游戏。
const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-proc-'))
// 「别的地方」：命令行里出现它的 bridge-host/bridge.mjs，但不属于 gameDir。
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-other-'))

const kids = []
const cnDirs = []
// 用 node 起一个「命令行里带着某个 bridge.mjs 路径」的存活进程（-e 的脚本只是等一会儿）。
function spawnHolder(arg, ms) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, ' + String(ms) + ')', arg], { stdio: 'ignore', windowsHide: true })
  child.once('error', function () {})
  kids.push(child)
  return child
}

async function waitPid(pid, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pid) { try { process.kill(pid, 0); return true } catch (e) { /* 还没起来 */ } }
    await nap(50)
  }
  return false
}

try {
  // ---- 1）假阳性：命令行里有 bridge-host 和 bridge.mjs，但它是别的地方的同名文件 ----
  const lookalike = path.join(other, 'bridge-host', 'bridge.mjs')
  const fake = spawnHolder(lookalike, 30000)
  ok(await waitPid(fake.pid, 8000), '假阳性样本进程起来了', String(fake.pid))
  await nap(300)   // 让 Win32_Process 里的命令行稳定可查
  const aliveSeen = bridgeAlive(fake.pid, gameDir)
  ok(aliveSeen === 0, 'bridgeAlive 不认这个无关进程', '返回 ' + aliveSeen)
  const refused = killBridge(fake.pid, gameDir)
  ok(refused.killed === false, 'killBridge 不动无关进程', String(refused.why))
  await nap(300)
  ok(fake.exitCode === null, '无关进程还活着（没被误杀）', 'exitCode ' + fake.exitCode)

  // ---- 1b）进程名不是 node：命令行里带着我们的 bridge-host/bridge.mjs 也不许杀 ----
  // 副本桥一定是 node 起的（或宿主自己改名后 spawn 的 exe）。cmd.exe / 编辑器把那个
  // 路径写进命令行，不该被 taskkill。
  const holderCmd = path.join(other, 'holder.cmd')
  fs.writeFileSync(holderCmd, '@ping -n 30 127.0.0.1 >nul\r\n')
  const imposter = spawn('cmd.exe', ['/c', holderCmd, path.join(gameDir, 'bridge-host', 'bridge.mjs')], { stdio: 'ignore', windowsHide: true })
  imposter.once('error', function () {})
  kids.push(imposter)
  ok(await waitPid(imposter.pid, 8000), 'cmd 样本进程起来了', String(imposter.pid))
  await nap(300)
  const impKill = killBridge(imposter.pid, gameDir)
  ok(impKill.killed === false && bridgeAlive(imposter.pid, gameDir) === 0, '命令行带桥路径的 cmd.exe 不被当成桥', String(impKill.why))
  await nap(300)
  ok(imposter.exitCode === null, 'cmd 样本还活着（没被误杀）', 'exitCode ' + imposter.exitCode)
  try { imposter.kill() } catch (e) { /* 收尾 */ }

  // ---- 2）真阳性：命令行里就是这个 gameDir 的 bridge-host/bridge.mjs ----
  const hostEntry = path.join(gameDir, 'bridge-host', 'bridge.mjs')
  const real = spawnHolder(hostEntry, 30000)
  ok(await waitPid(real.pid, 8000), '真桥样本进程起来了', String(real.pid))
  await nap(300)
  const realSeen = bridgeAlive(real.pid, gameDir)
  ok(realSeen === real.pid, 'bridgeAlive 认得出副本桥', '返回 ' + realSeen)
  const killed = killBridge(real.pid, gameDir)
  ok(killed.killed === true, 'killBridge 杀得掉副本桥', String(killed.why))
  await once(real, 'close').catch(function () {})

  // ---- 2b）gameDir 含中文：PowerShell 的 stdout 是系统代码页，按 utf8 读会把路径读成乱码 ----
  // 不钉 UTF-8 时绝对路径比对必然失配：桥判不出来 → 重启时杀不掉旧桥 → 带着活进程去重建副本。
  const cnDir = fs.mkdtempSync(path.join(os.tmpdir(), '小屋 世界-'))
  cnDirs.push(cnDir)
  const cnEntry = path.join(cnDir, 'bridge-host', 'bridge.mjs')
  const cn = spawnHolder(cnEntry, 30000)
  ok(await waitPid(cn.pid, 8000), '中文目录样本进程起来了', String(cn.pid))
  await nap(300)
  const cnSeen = bridgeAlive(cn.pid, cnDir)
  ok(cnSeen === cn.pid, '中文 gameDir 也认得出副本桥（编码没坏）', '返回 ' + cnSeen)
  const cnKilled = killBridge(cn.pid, cnDir)
  ok(cnKilled.killed === true, '中文 gameDir 下的桥杀得掉', String(cnKilled.why))
  await once(cn, 'close').catch(function () {})

  // ---- 3）边界：pid 0 / 已不存在的 pid ----
  ok(bridgeAlive(0, gameDir) === 0, 'bridgeAlive(0) 返回 0')
  const none = killBridge(0, gameDir)
  ok(none.killed === false, 'killBridge(0) 不抛错、不杀', String(none.why))
  const ghost = killBridge(999999, gameDir)
  ok(ghost.killed === false, 'killBridge(不存在的 pid) 不抛错', String(ghost.why))
} finally {
  for (const k of kids) { try { k.kill() } catch (e) { /* 已经没了 */ } }
  for (const d of [gameDir, other].concat(cnDirs)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { /* 清不掉就算了 */ } }
}

console.log(process.exitCode ? '有断言失败' : '全部通过')
