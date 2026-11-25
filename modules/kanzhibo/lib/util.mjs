// lib/util.mjs —— 纯工具：版本、URL/房间键、睡眠、找浏览器、CDP 连接类。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const VERSION = '1.3.0'

// 点完之后等证据的时间（ms）。放在这里，失败文案里的秒数也从它算，避免又写死一个 12。
export const EVIDENCE_WAIT_MS = 20_000

export const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // 2026-11-09 加：Chrome / Chromium 的「用户级安装」默认落在 LOCALAPPDATA（很常见），
  //   光查 Program Files 会误报「找不到浏览器，先装一个」。
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe') : '',
].filter(Boolean)

// 2026-11-09：抖音直播间有两种地址，都要认：
//   https://live.douyin.com/<房间号>
//   https://www.douyin.com/follow/live/<房间号>?anchor_id=...（关注页点进来的）
export const LIVE_RE = /^https:\/\/(?:live\.douyin\.com|(?:www|m)\.douyin\.com\/(?:[a-z-]+\/)*live)\/\d+/i

/** 从两种直播间地址里取房间号；取不到返回 ''。 */
export const liveRoomId = (u) => {
  const s = String(u || '')
  const m = /^https?:\/\/(?:live\.douyin\.com|(?:www|m)\.douyin\.com\/(?:[a-z-]+\/)*live)\/(\d+)/i.exec(s)
  return m ? m[1] : ''
}

/** 房间的唯一标识：能取出房间号就用房间号，取不到退回整条地址。 */
export const roomKeyOf = (u) => liveRoomId(u) || String(u || '')

/**
 * 1.0.2：灯牌「今天已放弃自动」的标记要不要继续生效。
 * 原来它只按天记账 —— 晚上换了个直播间/换了个主播，标记还在，整晚都静默跳过
 * （表现就是「送灯牌没启动」）。所以给标记绑上房间号：房间变了就当它过期。
 */
export const giveUpRoomsDiffer = (giveUpDay, giveUpRoom, today, curRoom) =>
  Boolean(giveUpDay && today && giveUpRoom && curRoom) && giveUpDay === today && giveUpRoom !== curRoom

/** 这个地址看起来是「直播间」，而不是主播主页 / 别的页面。 */
export const isLiveUrl = (u) => LIVE_RE.test(String(u || ''))
export const isLiveTarget = (u) => {
  const s = String(u || '')
  if (isLiveUrl(s)) return true
  // 用户可能只贴了房间号
  return /^\d{6,}$/.test(s.trim())
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找浏览器：面板里填了路径就先用它（填错/不存在会明确说出来），否则按 BROWSERS 顺序自动找。 */
export function findBrowser(custom) {
  const want = String(custom || '').trim()
  if (want) return existsSync(want) ? want : ''
  return BROWSERS.find((p) => existsSync(p)) || ''
}

export async function getJson(url, ms = 3000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    // 2026-11-09 加：连接断开后 ws.send() 是静默丢弃的（不抛错），挂起的请求只能干等
    //   20 秒超时才失败 —— 断线后一轮 tick 里每个 evalJs 都要白卡 20s。
    //   close 事件置位，send 里直接拒绝。
    this.closed = false
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
      else p.resolve(msg.result || {})
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('浏览器连接断了')) }
      this.pending.clear()
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连 CDP 超时')), 8000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连不上 CDP')) })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    // 2026-11-09 修：断开（或还没连上）就直接失败，别把 20 秒超时当成报错方式。
    if (this.closed || (this.ws.readyState !== undefined && this.ws.readyState !== 1)) {
      return Promise.reject(new Error('浏览器连接已断开（' + method + '）'))
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws.close() } catch {}
  }
}
