// 桥的状态判定：token 过期（401）会重读 bridge.json 再试一次，
// 但「重试这一次」如果拿到的还是非 200，必须当失败——否则 0.4.4 删掉 callTool 里的
// status 检查后，会把「403 + {error:...}」这种体子当成成功返回给模型。
// 用一个本机假桥精确模拟「401 → 403」和「200」两条路。
// 用法：node test/bridge-auth.mjs
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from '../lib/bridge.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

const scripts = [
  { status: 401, body: { error: 'token 过期' } },   // 第 1 次：逼出重读重试
  { status: 403, body: { error: 'token 不对' } },   // 第 2 次：重试仍然不对
  { status: 200, body: { ok: true, status: 'done', label: '走去公园', result: { ok: true, happened: ['走到了公园'] } } },
]
let hits = 0
const server = http.createServer(function (req, res) {
  const step = scripts[Math.min(hits, scripts.length - 1)]
  hits += 1
  res.writeHead(step.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(step.body))
})

const file = path.join(os.tmpdir(), 'cabin-auth-' + process.pid + '-' + Date.now() + '.json')
try {
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r) })
  const port = server.address().port
  fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:' + port, token: 'x'.repeat(48) }), 'utf8')
  const bridge = createBridge({ getFile: () => file })

  // ---- 401 → 403：必须失败 ----
  const first = await bridge.callTool('cabin_go', { place: 'park' })
  ok(first.ok === false, '401 重试后拿到 403 → 判成失败', JSON.stringify(first.ok) + ' / ' + String(first.message))
  ok(first.status === 403, '状态码带出来是 403', String(first.status))
  ok(String(first.message).indexOf('403') >= 0, '错误文案提到 403', String(first.message).slice(0, 60))
  ok(String(first.message).indexOf('重启小屋世界') >= 0, '403 的文案指向「重启小屋世界」', String(first.message).slice(0, 60))

  // ---- 200：正常路径不能被上面的收紧弄坏 ----
  const second = await bridge.callTool('cabin_go', { place: 'park' })
  ok(second.ok === true, '200 + ok:true → 成功', JSON.stringify(second.ok))
  ok(second.ok && second.body && second.body.status === 'done', 'body 原样带回', JSON.stringify(second.body && second.body.status))
} finally {
  try { server.close() } catch (e) { /* 关不掉就算了 */ }
  try { fs.rmSync(file, { force: true }) } catch (e) { /* 没有就算了 */ }
}

console.log(process.exitCode ? '有断言失败' : '全部通过')
