// 小屋世界桥客户端：只连 127.0.0.1，读 data/bridge.json 拿 url + token。
// 桥每次启动都会换新 token，所以这里带缓存 + 401 时强制重读一次。

import fs from 'node:fs'

const CACHE_MS = 3000
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/

function bridgeDown(message) {
  const err = new Error(message)
  err.bridgeDown = true
  return err
}

export function createBridge({ getFile }) {
  let cache = null // { url, token, at, file }

  // 连接信息文件由调用方给（模块那边默认跟着游戏目录）。这里不留写死的兜底路径：
  // 拿不到就明确报错，别去读一个早就搬走的旧目录。
  function file() {
    const want = String(getFile?.() || '').trim()
    if (!want) throw bridgeDown('没有设置小屋世界的连接信息文件（<游戏目录>/data/bridge.json）')
    return want
  }

  function info(force = false) {
    const f = file()
    const at = Date.now()
    if (!force && cache && cache.file === f && at - cache.at < CACHE_MS) return cache
    let row
    try {
      row = JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch (error) {
      const why = error?.code === 'ENOENT'
        ? '文件还不存在（桥没启动过）'
        : (error?.message || String(error))
      throw bridgeDown('读不到小屋世界连接信息 ' + f + '：' + why)
    }
    const url = String(row?.url || '').replace(/\/+$/, '')
    const token = String(row?.token || '')
    if (!LOCAL.test(url)) throw bridgeDown('小屋世界连接信息里的地址不对：' + (url || '(空)'))
    if (token.length < 16) throw bridgeDown('小屋世界连接信息里没有有效的 token')
    cache = { url, token, at, file: f }
    return cache
  }

  function forget() { cache = null }

  async function request(pathname, { method = 'GET', body, token, timeoutMs = 60000 } = {}) {
    let info2
    try {
      info2 = token ? { url: info().url, token } : info()
    } catch (error) {
      return { ok: false, status: 0, message: error?.message || String(error) }
    }
    const headers = { 'content-type': 'application/json' }
    if (token !== '') headers.authorization = 'Bearer ' + info2.token
    let res
    try {
      res = await fetch(info2.url + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const name = error?.name || ''
      const cause = error?.cause?.code || error?.code || ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, status: 0, message: '小屋世界的桥在等游戏回话，但超时了（' + Math.round(timeoutMs / 1000) + ' 秒）。可以用 cabin_task 查，或把等待时间调短。' }
      }
      if (cause === 'ECONNREFUSED' || cause === 'ECONNRESET' || cause === 'ENOTFOUND' || cause === 'EHOSTUNREACH') {
        return { ok: false, status: 0, message: '小屋世界桥没在运行（' + (cause || '连不上') + '）：用 /小屋 启动（模块会拉起 bridge-host 副本桥和游戏），然后再试。' }
      }
      return { ok: false, status: 0, message: '连小屋世界桥失败：' + (error?.message || String(error)) }
    }
    let body2 = null
    try { body2 = await res.json() } catch { body2 = null }
    return { ok: true, status: res.status, body: body2 }
  }

  async function call(pathname, opts = {}) {
    const first = await request(pathname, opts)
    if (!first.ok) return first
    // 401 要单独处理（token 可能过期）；200 放行；其余状态一律当失败。
    // 否则 /v1/events 返回 500 时会被当成「一件都没做完」——那是在编造事实。
    if (first.status !== 401) {
      if (first.status === 200) return first
      return { ok: false, status: first.status, body: first.body, message: explain(first.status, first.body) }
    }
    // token 过期（桥重启过）：重读 bridge.json 再试一次
    forget()
    try { info(true) } catch (error) { return { ok: false, status: 401, message: error.message } }
    const second = await request(pathname, opts)
    if (!second.ok) return second
    if (second.status === 401) {
      return { ok: false, status: 401, message: '小屋世界的 token 仍然不对：点面板上的「重启小屋世界」重新起一次（别用官方 start.cmd，那会换成没打补丁的桥）。' }
    }
    // 重试这一次也要过同一套状态判定：只判 ok 不判 status 的话，403/409/500 会被当成成功
    // 带回 executeTool（body 里没有 status:"done"，于是成了「ok:true + 一段原始 JSON」）。
    if (second.status !== 200) return { ok: false, status: second.status, body: second.body, message: explain(second.status, second.body) }
    return second
  }

  function explain(status, body2) {
    const text = String(body2?.error || body2?.message || '').trim()
    if (status === 503) return '游戏没打开或还没连上：在面板点「启动小屋世界」（或直接双击游戏目录里的 CabinWorld.exe），等窗口里出现画面再试。'
    if (status === 409) return '她正在做别的事，先做完这一件：' + (text || '稍等一会儿，或者用 cabin_stop 停下。')
    // 401（token 过期）在 call() 里已经重读并重试过了，走到 403 时 token 基本不是原因。
    // 别建议删 data/bridge.json：文件一缺，读连接信息那步会直接报「文件还不存在」，更难恢复。
    if (status === 403) return '桥拒绝了这次调用（403）：点面板上的「重启小屋世界」重新握手。'
    if (status === 404) return text || '没有这个接口或工具。'
    if (status === 400) return text || '这个动作游戏不接受（参数不对）。'
    if (status >= 500) return '小屋世界桥出错了：' + (text || status)
    return text || ('小屋世界返回了 HTTP ' + status)
  }

  async function health() {
    const got = await request('/v1/health', { token: '' })
    if (!got.ok) return got
    if (!got.body || got.body.ok !== true) return { ok: false, status: got.status, message: explain(got.status, got.body) }
    return { ok: true, status: got.status, body: got.body }
  }

  async function callTool(name, args = {}, { waitMs = 30000 } = {}) {
    const payload = { ...(args || {}) }
    if (Number.isFinite(waitMs) && waitMs > 0) payload.waitMs = Math.round(waitMs)
    // 桥里可能还在排队，模块这边别比 waitMs 先放弃。
    const got = await call('/v1/tool', { method: 'POST', body: { name, arguments: payload }, timeoutMs: Math.max(60000, Math.round(waitMs) + 15000) })
    if (!got.ok) return got
    if (!got.body || got.body.ok === false) {
      // 桥把「游戏为什么没做成」放在 result.outcome（例如「已经在床上了」），只读 error 会把它整句丢掉。
      const b = got.body || {}
      const r = b.result || {}
      return { ok: false, status: got.status, body: got.body, message: String(b.error || r.outcome || r.error || '小屋世界没有执行这个动作。') }
    }
    return { ok: true, status: 200, body: got.body }
  }

  async function status() {
    const got = await call('/v1/status')
    if (!got.ok) return got
    if (!got.body || got.body.ok === false) return { ok: false, status: got.status, message: explain(got.status, got.body) }
    return { ok: true, status: 200, body: got.body }
  }

  return { info, forget, call, health, callTool, status, file }
}
