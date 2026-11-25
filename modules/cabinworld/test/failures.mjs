// 失败场景：连接信息缺失、token 不对、（可选）游戏没打开。
// 用法：node test/failures.mjs            只测前两项
//       CABIN_OFFLINE=1 node test/failures.mjs   先把游戏关掉，再连第 3 项一起测

import fs from 'node:fs'
import { BRIDGE_JSON } from './_dirs.mjs'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from '../lib/bridge.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}
const quiet = { info() {}, warn() {}, error() {} }
const mk = (file) => createBridge({ getFile: () => file, log: quiet })

const missing = path.join(os.tmpdir(), 'cabin-missing-' + Date.now() + '.json')
const b1 = mk(missing)
const s1 = await b1.status()
ok(s1.ok === false && /读不到小屋世界连接信息/.test(String(s1.message)), '连接信息文件不存在', String(s1.message).slice(0, 60))

const fake = path.join(os.tmpdir(), 'cabin-fake-' + Date.now() + '.json')
fs.writeFileSync(fake, JSON.stringify({ url: 'http://127.0.0.1:18790', token: 'x'.repeat(48) }), 'utf8')
const b2 = mk(fake)
const s2 = await b2.callTool('cabin_status', {})
ok(s2.ok === false && /token/.test(String(s2.message)), 'token 不对', String(s2.message).slice(0, 60))
fs.rmSync(fake, { force: true })

if (process.env.CABIN_OFFLINE === '1') {
  const b3 = mk(BRIDGE_JSON)
  const s3 = await b3.callTool('cabin_go', { place: 'park' })
  ok(s3.ok === false && /游戏没打开|没连上/.test(String(s3.message)), '游戏没打开（503）', String(s3.message).slice(0, 80))
  const h = await b3.health()
  ok(h.ok === true && h.body.game === false, 'health 仍可查、game=false', JSON.stringify(h.body || null))
}
