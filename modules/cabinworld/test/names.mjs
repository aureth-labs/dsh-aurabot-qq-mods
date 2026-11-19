// 桥配置读写 + 名字来源解析（不改真实配置，不重启桥）。
// 用法：node test/names.mjs

import fs from 'node:fs'
import { GAME_DIR } from './_dirs.mjs'
import os from 'node:os'
import path from 'node:path'
import { bridgeConfigInfo, writeBridgeConfig } from '../lib/bridgecfg.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}
const GAME = GAME_DIR

const real = bridgeConfigInfo(GAME)
ok(!!real.displayName && !!real.resident, '读到桥配置', 'displayName=' + real.displayName + ' resident=' + real.resident)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cabincfg-'))
fs.mkdirSync(path.join(tmp, 'bridge'), { recursive: true })
fs.copyFileSync(path.join(GAME, 'bridge', 'bridge.config.json'), path.join(tmp, 'bridge', 'bridge.config.json'))

const wrote = writeBridgeConfig(tmp, { displayName: '测试名', port: 19001 })
const after = bridgeConfigInfo(tmp)
ok(after.displayName === '测试名', '改名生效', after.displayName)
ok(after.port === 19001, '改端口生效', String(after.port))
ok(after.resident === real.resident, 'resident 没被动', after.resident)
ok(after.dataDir === real.dataDir, 'dataDir 没被动', after.dataDir)
ok(fs.existsSync(wrote.backup), '写了备份', wrote.backup ? path.basename(wrote.backup) : '')

fs.rmSync(tmp, { recursive: true, force: true })
