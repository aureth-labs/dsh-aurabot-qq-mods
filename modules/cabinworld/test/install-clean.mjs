// copyPackage 的顶层清理：装完只删「官方包会有的旧残留」，
// 用户自建的任何东西、模块自己的 bridge-host、以及安装锁 .installing 都必须留着。
// 用法：node test/install-clean.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyPackage } from '../lib/install.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-install-'))
const pkg = path.join(tmp, 'pkg')   // 模拟解压出来的官方包
const dir = path.join(tmp, 'game')  // 模拟游戏目录
const w = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
// 用户改过的数据目录 + 用户自建的目录：升级时必须活下来（分别验证「不覆盖」与「不删除」）。
w(path.join(dir, 'cabinworld.ini'), 'data=D:/MySave')
w(path.join(dir, 'tools', 'mine.ps1'), 'my script')

// 包内容：只有 bridge/ 和 game/ 和新版 CHANGELOG
w(path.join(pkg, 'bridge', 'bridge.mjs'), 'new bridge')
w(path.join(pkg, 'game', 'main.gd'), 'new game')
w(path.join(pkg, 'CHANGELOG-1.1.md'), 'new changelog')
w(path.join(pkg, 'cabinworld.ini'), 'data=data')   // 包内示例：只该用于全新安装

// 游戏目录现状
w(path.join(dir, 'bridge', 'bridge.mjs'), 'old bridge')      // 包内 → 覆盖
w(path.join(dir, 'game', 'main.gd'), 'old game')             // 包内 → 覆盖
w(path.join(dir, 'data', 'save.json'), '{}')                 // KEEP_TOP → 保留
w(path.join(dir, 'bridge', 'bridge.config.json'), '{}')      // KEEP_REL → 保留
w(path.join(dir, 'bridge-host', 'bridge.mjs'), 'host')       // 模块产物 → 保留（这次修的）
w(path.join(dir, '.installing'), '1234')                     // 安装锁 → 保留（这次修的）
w(path.join(dir, '我的存档', 'slot1.sav'), 'mine')            // 用户自建目录 → 保留（这次修的）
w(path.join(dir, 'notes.txt'), 'my notes')                   // 用户自建文件 → 保留（这次修的）
w(path.join(dir, 'update.cmd'), 'old updater')               // 上游残留、包内没有 → 删
w(path.join(dir, 'CHANGELOG-0.9.md'), 'ancient')             // 上游残留（前缀匹配）→ 删
w(path.join(dir, 'PATCH-20250101.json'), '{}')               // 上游残留（前缀匹配）→ 删
w(path.join(dir, 'stale-mod.cmd'), 'third party')            // 不认识 → 当成用户数据，保留

copyPackage(pkg, dir)

const has = (rel) => fs.existsSync(path.join(dir, rel))

// 装进去的
ok(has(path.join('bridge', 'bridge.mjs')) && fs.readFileSync(path.join(dir, 'bridge', 'bridge.mjs'), 'utf8') === 'new bridge', '包内文件被覆盖成新版')
ok(has(path.join('CHANGELOG-1.1.md')), '包内新文件被装上')

// 必须保留的
ok(has(path.join('data', 'save.json')), '保留 data/（用户存档）')
ok(has(path.join('bridge', 'bridge.config.json')) && fs.readFileSync(path.join(dir, 'bridge', 'bridge.config.json'), 'utf8') === '{}', '保留 bridge.config.json 原内容')
ok(has(path.join('bridge-host', 'bridge.mjs')), '保留 bridge-host/（补丁失败时的兜底副本）')
ok(has('.installing'), '保留 .installing（并发安装锁）')
ok(has(path.join('我的存档', 'slot1.sav')), '保留用户自建目录 我的存档/')
ok(has('notes.txt'), '保留用户自建文件 notes.txt')
ok(has('stale-mod.cmd'), '保留不认识的第三方条目 stale-mod.cmd')
ok(fs.readFileSync(path.join(dir, 'cabinworld.ini'), 'utf8') === 'data=D:/MySave', '用户的 cabinworld.ini 没被包内示例覆盖')
ok(has(path.join('tools', 'mine.ps1')), '用户自建目录 tools/ 原样保留')

// 必须删掉的
ok(!has('update.cmd'), '删掉上游已移除的 update.cmd')
ok(!has('CHANGELOG-0.9.md'), '删掉旧版 CHANGELOG-0.9.md')
ok(!has('PATCH-20250101.json'), '删掉旧版 PATCH-20250101.json')
ok(has(path.join('CHANGELOG-1.1.md')), '新版 CHANGELOG-1.1.md 没被误删')

// ---- 场景 2：包里没有 bridge/（挑错了包）----
// 这时绝不能进清理阶段，否则整份 bridge/ 连 bridge.config.json 会被删掉。
const pkg2 = path.join(tmp, 'pkg2')
const dir2 = path.join(tmp, 'game2')
fs.mkdirSync(pkg2, { recursive: true })
fs.writeFileSync(path.join(pkg2, 'start.cmd'), 'stub')
fs.mkdirSync(path.join(dir2, 'bridge'), { recursive: true })
fs.writeFileSync(path.join(dir2, 'bridge', 'bridge.config.json'), '{"displayName":"漪漪凛"}')
let threw = ''
try { copyPackage(pkg2, dir2) } catch (e) { threw = String((e && e.message) || e) }
ok(threw.indexOf('bridge') >= 0, '包里没有 bridge/ → 抛错中止', threw.slice(0, 40))
ok(fs.existsSync(path.join(dir2, 'bridge', 'bridge.config.json')), '中止后 bridge.config.json 还在')

// ---- 场景 3：有 bridge/ 但没有 bridge.mjs（增量补丁包 / 别人打的包）----
// 光看目录不够：ensureHost 的安装判据就是 bridge/bridge.mjs，这种包会静默掺入不同版本的桥。
const pkg3 = path.join(tmp, 'pkg3')
const dir3 = path.join(tmp, 'game3')
fs.mkdirSync(path.join(pkg3, 'bridge', 'lib'), { recursive: true })
fs.writeFileSync(path.join(pkg3, 'bridge', 'bridge.config.json'), '{"displayName":"包里的示例"}')
fs.writeFileSync(path.join(pkg3, 'start.cmd'), 'stub')
fs.mkdirSync(path.join(dir3, 'bridge'), { recursive: true })
fs.writeFileSync(path.join(dir3, 'bridge', 'bridge.mjs'), 'good bridge')
fs.writeFileSync(path.join(dir3, 'bridge', 'bridge.config.json'), '{"displayName":"漪漪凛"}')
let threw3 = ''
try { copyPackage(pkg3, dir3) } catch (e) { threw3 = String((e && e.message) || e) }
ok(threw3.indexOf('bridge.mjs') >= 0, '有 bridge/ 但缺 bridge.mjs → 抛错中止', threw3.slice(0, 50))
ok(fs.readFileSync(path.join(dir3, 'bridge', 'bridge.mjs'), 'utf8') === 'good bridge', '中止后原有的桥没被动过')
ok(fs.readFileSync(path.join(dir3, 'bridge', 'bridge.config.json'), 'utf8').indexOf('漪漪凛') >= 0, '中止后 bridge.config.json 没被包内示例覆盖')

// ---- 场景 4：全新安装（空目录）必须装出 bridge/bridge.config.json ----
// 「已有才跳过」如果写成「一律跳过」，全新安装就没有这份配置：startHost 直接报
// 「桥配置不存在」，而 isInstalled() 只看 start.cmd + exe，面板还会显示「已安装」。
const pkg4 = path.join(tmp, 'pkg4')
const dir4 = path.join(tmp, 'game4')
fs.mkdirSync(path.join(pkg4, 'bridge'), { recursive: true })
fs.writeFileSync(path.join(pkg4, 'bridge', 'bridge.mjs'), 'new bridge')
fs.writeFileSync(path.join(pkg4, 'bridge', 'bridge.config.json'), '{"displayName":"漪漪凛"}')
copyPackage(pkg4, dir4)
ok(fs.existsSync(path.join(dir4, 'bridge', 'bridge.config.json')), '全新安装装出了 bridge/bridge.config.json')

// ---- 场景 5：包里只有 example 时也要生成本地配置 ----
const pkg5 = path.join(tmp, 'pkg5')
const dir5 = path.join(tmp, 'game5')
fs.mkdirSync(path.join(pkg5, 'bridge'), { recursive: true })
fs.writeFileSync(path.join(pkg5, 'bridge', 'bridge.mjs'), 'new bridge')
fs.writeFileSync(path.join(pkg5, 'bridge', 'bridge.config.example.json'), '{"displayName":"示例"}')
copyPackage(pkg5, dir5)
ok(fs.existsSync(path.join(dir5, 'bridge', 'bridge.config.json')), '包里只有 example 时也生成了 bridge.config.json')

fs.rmSync(tmp, { recursive: true, force: true })
