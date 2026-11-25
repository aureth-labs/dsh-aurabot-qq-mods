// 一键安装的三个环节单独验证：查最新版本、下载到磁盘、解压并找到 start.cmd。
// 用法：node test/install-check.mjs [已有zip路径]
// 不会覆盖游戏目录，不会启动游戏。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { latestRelease, unzip, pickRoot, nodeTooOld } from '../lib/install.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}
const zip = process.argv[2] || path.join(os.tmpdir(), 'CabinWorld-win64.zip')
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cabincheck-'))

try {
  const node = nodeTooOld()
  ok(node.tooOld === false, 'Node 版本', node.version)

  // GitHub 接口限流 / 断网时 latestRelease 会直接 throw，不能让它把整个测试崩掉。
  let rel = null
  try {
    rel = await latestRelease({})
  } catch (e) {
    // 这个文件测的是真实下载，需要网络和 GitHub 可达性；默认套件里当跳过，
    // 设 CABIN_NET_TEST=1 时才把「查不到 Release」当失败。
    // 退出前先清临时目录（finally 会被 process.exit 跳过，以前每次 SKIP 都在 %TEMP% 留一个 cabincheck-*）。
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    if (process.env.CABIN_NET_TEST === '1') {
      console.error('FAIL 查不到 GitHub Release（' + ((e && e.message) || e) + '）')
      process.exit(1)
    }
    console.log('SKIP 查不到 GitHub Release（' + ((e && e.message) || e) + '）；设 CABIN_NET_TEST=1 可要求它必须通过')
    // 用 exitCode 而不是 0：前面已经失败的断言不能被这次 SKIP 洗掉。
    process.exit(process.exitCode || 0)
  }
  ok(!!rel.tag && !!rel.asset.url, '查到最新版本', rel.tag + ' / ' + rel.asset.name + ' / ' + (rel.asset.size / 1048576).toFixed(1) + ' MB')

  // 下载：用一个小文件验证「流式写盘 + 进度回调」这条路径
  const small = path.join(tmp, 'small.json')
  let ticks = 0
  const bytes = await (async () => {
    const res = await fetch('https://api.github.com/repos/BabyBus2022/cabin-world', {
      headers: { 'user-agent': 'aurabot-cabinworld-installer', accept: 'application/vnd.github+json' },
    })
    ok(res.ok, '下载小文件 HTTP', String(res.status))
    const out = fs.createWriteStream(small)
    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    let n = 0
    const body = Readable.fromWeb(res.body)
    body.on('data', c => { n += c.length; ticks++ })
    await pipeline(body, out)
    return n
  })()
  ok(bytes > 100 && ticks > 0, '流式下载写盘', bytes + ' 字节 / ' + ticks + ' 次回调')

  if (fs.existsSync(zip)) {
    const dest = path.join(tmp, 'unpack')
    const how = await unzip(zip, dest)
    const root = pickRoot(dest)
    const hasStart = fs.existsSync(path.join(root, 'start.cmd'))
    const hasExe = fs.existsSync(path.join(root, 'CabinWorld.exe'))
    ok(hasStart && hasExe, '解压并定位 start.cmd', how + ' → ' + root)
  } else {
    console.log('SKIP 没有本地 zip 可测解压：' + zip)
  }
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
