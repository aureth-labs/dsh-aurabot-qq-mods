// lib/discover.mjs —— 局域网发现（拓竹打印机的 SSDP 广播）。
//
// 拓竹打印机在局域网里监听 UDP 2021，接受这样的探测包：
//     M-SEARCH * HTTP/1.1
//     HOST: 239.255.255.250:1990
//     MX: 1
//     MAN: "ssdp:discover"
//     ST: urn:bambulab-com:device:3dprinter:1
//
// 打印机回一个 HTTP/1.1 200 OK，头里带 USN / Location 之类，以及它自己拼的
//     DevModel.bambu.com / DevName.bambu.com / DevSignal.bambu.com / DevConnect.bambu.com
// 更关键的是响应体（或某些固件放在头的 `DevSerial`）里带序列号和 IP。
//
// **重要安全事实**：广播里**没有访问码**。访问码（LAN Access Code）是打印机屏幕上
// 那 8 位字符，拓竹故意不广播它 —— 否则同网段任何人扫一下就能控制别人的打印机。
// 所以发现模式只能帮你把「序列号 + IP + 名字 + 型号」填好，访问码仍然必须手工输。
//
// 本文件只做「发探测 → 收响应 → 解析成设备列表」，不碰任何凭据、不落盘。

import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/** 拓竹的发现端口与组播地址 */
export const DISCOVERY_PORT = 2021
export const DISCOVERY_HOST = '239.255.255.250'
export const DISCOVERY_ST_PORT = 'urn:bambulab-com:device:3dprinter:1'
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 3000

/** 探测包：和 Bambu Studio / Orca 用的一样，固件只认这个形状。 */
export function discoveryProbe () {
  return [
    'M-SEARCH * HTTP/1.1',
    'HOST: ' + DISCOVERY_HOST + ':1990',
    'MX: 1',
    'MAN: "ssdp:discover"',
    'ST: ' + DISCOVERY_ST_PORT,
    '',
    ''
  ].join('\r\n')
}

/**
 * 解析一条响应文本。固件之间格式不统一，所以两种都认：
 *  - 头部形式：`DevSerial.bambu.com: 01S00A...` / `DevName.bambu.com: A1`
 *  - JSON 形式：{"dev_serial":"...","dev_ip":"...","dev_name":"...","dev_model":"..."}
 * 返回 { serial, ip, name, model, signal }，缺的字段给空串（绝不编造）。
 */
export function parseDiscoveryResponse (text, fromIp = '') {
  const raw = String(text || '')
  const out = { serial: '', ip: String(fromIp || ''), name: '', model: '', signal: '' }
  if (!raw.trim()) return out

  // 1) JSON 体（有些固件在 body 里给 JSON）
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const obj = JSON.parse(raw.slice(jsonStart))
      if (obj && typeof obj === 'object') {
        out.serial = firstText(obj.dev_serial, obj.devSerial, obj.serial)
        out.ip = firstText(obj.dev_ip, obj.devIp, obj.ip) || out.ip
        out.name = firstText(obj.dev_name, obj.devName, obj.name)
        out.model = firstText(obj.dev_model, obj.devModel, obj.model, obj.product_name)
        out.signal = firstText(obj.dev_signal, obj.devSignal, obj.signal)
        return out
      }
    } catch {
      /* 不是 JSON，继续按头部解析 */
    }
  }

  // 2) 头部形式：`Key: value` 一行一个
  const headers = {}
  for (const line of raw.split(/\r?\n/)) {
    const cut = line.indexOf(':')
    if (cut <= 0) continue
    const key = line.slice(0, cut).trim().toLowerCase()
    const value = line.slice(cut + 1).trim()
    if (key && value) headers[key] = value
  }
  out.serial = firstText(headers['devserial.bambu.com'], headers['dev_serial'], headers['usn'] && /([A-Za-z0-9]{8,})/.exec(headers['usn'])?.[1])
  out.name = firstText(headers['devname.bambu.com'], headers['dev_name'])
  out.model = firstText(headers['devmodel.bambu.com'], headers['dev_model'], headers['devproduct.bambu.com'])
  out.signal = firstText(headers['devsignal.bambu.com'], headers['dev_signal'])
  const located = firstText(headers['location'], headers['dev_ip'], headers['devip.bambu.com'])
  if (located) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(located)
    if (m) out.ip = m[1]
  }
  if (out.serial) out.serial = String(out.serial).trim()
  return out
}

function firstText (...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

/** 本机所有 IPv4 广播地址（没有就不发广播，只发组播）。 */
function broadcastAddresses () {
  const list = []
  const nets = networkInterfaces() || {}
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue
      const addr = String(entry.address || '')
      const mask = String(entry.netmask || '')
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(addr) || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mask)) continue
      const a = addr.split('.').map(Number)
      const m = mask.split('.').map(Number)
      const bcast = a.map((oct, i) => (oct & m[i]) | (~m[i] & 255)).join('.')
      if (bcast && !list.includes(bcast)) list.push(bcast)
    }
  }
  return list
}

/**
 * 扫一遍局域网。
 * @param {{timeoutMs?:number, port?:number, socketFactory?:Function, broadcastList?:string[]}} opts
 * @returns {Promise<{ok:true, devices:Array}>}
 *
 * 注入 `socketFactory` 是为了测试：它要返回一个和 dgram.Socket 形状一致的假对象。
 */
export function discoverPrinters (opts = {}) {
  const timeoutMs = Math.min(15000, Math.max(500, Number(opts.timeoutMs) || DEFAULT_DISCOVERY_TIMEOUT_MS))
  const port = Number(opts.port) || DISCOVERY_PORT
  const factory = typeof opts.socketFactory === 'function' ? opts.socketFactory : createSocket
  const probe = discoveryProbe()

  return new Promise((resolve) => {
    const found = new Map() // serial||ip -> device
    let socket = null
    let done = false
    let timer = null

    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { socket && socket.close() } catch { /* 已经关了 */ }
      resolve({ ok: true, devices: [...found.values()] })
    }

    try {
      socket = factory({ type: 'udp4', reuseAddr: true })
    } catch (error) {
      resolve({ ok: false, code: 'SOCKET_FAILED', message: '建不了发现用的 UDP socket：' + ((error && error.message) || error), devices: [] })
      return
    }

    const record = (text, fromIp) => {
      const device = parseDiscoveryResponse(text, fromIp)
      if (!device.serial && !device.ip) return
      // 同一台可能被收两次（组播 + 广播）：按序列号（没有就用 IP）去重，保留字段更全的那份
      const key = device.serial || device.ip
      const previous = found.get(key)
      if (!previous) { found.set(key, device); return }
      found.set(key, {
        serial: device.serial || previous.serial,
        ip: device.ip || previous.ip,
        name: device.name || previous.name,
        model: device.model || previous.model,
        signal: device.signal || previous.signal,
      })
    }

    socket.on('message', (msg, rinfo) => {
      try { record(String(msg), rinfo && rinfo.address) } catch { /* 单条解析失败不影响其它设备 */ }
    })
    socket.on('error', () => finish())

    const sendAll = () => {
      const payload = Buffer.from(probe, 'utf8')
      // 组播一次
      try { socket.send(payload, 0, payload.length, 1990, DISCOVERY_HOST, () => {}) } catch { /* 某些系统不允许组播 */ }
      // 每个网段的广播再来一次：有的固件只回广播
      const list = Array.isArray(opts.broadcastList) ? opts.broadcastList : broadcastAddresses()
      for (const addr of list) {
        try { socket.send(payload, 0, payload.length, port, addr, () => {}) } catch { /* 忽略单个网段 */ }
      }
    }

    try {
      socket.bind(0, () => {
        socket.setBroadcast?.(true)
        sendAll()
        // 再补一轮：UDP 丢了就漏设备，隔 700ms 重发成本很低
        setTimeout(() => { if (!done) sendAll() }, 700)
      })
    } catch {
      finish()
      return
    }

    // 注意：这里的超时**不能** unref。扫描本身就是「等这一下」，
    // unref 掉的话当它是进程里唯一的待处理任务时，promise 会永远不 resolve。
    timer = setTimeout(finish, timeoutMs)
  })
}
