import { TONES, toneOf, applyTone, DEFAULT_TONE } from './tones.js'

// ---------- 本地状态 ----------
const LS = {
  host: 'pocket.host',
  token: 'pocket.token',
  tone: 'pocket.tone',
  toneLocal: 'pocket.tone.local',
  tunnel: 'pocket.tunnel',
}

const S = {
  // 过一遍 normalizeHost：老版本存的是 192.168.1.5:7788 这种没协议的，升级后自动补成 http://…
  hosts: String(localStorage.getItem(LS.host) || '')
    .split(/[,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => normalizeHost(x))
    .filter(Boolean),
  host: '',
  token: localStorage.getItem(LS.token) || '',
  tone: localStorage.getItem(LS.tone) || DEFAULT_TONE,
  toneLocal: localStorage.getItem(LS.toneLocal) === '1',
  seq: 0,
  msgs: [],
  pending: 0,
  polling: null,
  online: true,
  state: null,
  playing: null,
  srvVersion: '', // 电脑端模块版本（/api/health 给的，界面功能都跟它走）
  appVersion: window.__pocketApp || '', // 壳版本（安卓端注入；浏览器打开时为空）
  img: null, // 待发送的图片 { dataUrl, b64 }
  recording: false,
  recStart: 0,
  playingText: '',
}
S.host = S.hosts[0] || ''

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

// 从地址栏接管密钥/地址（扫码或 APK 首启带过来）
function takeFromUrl() {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  const token = h.get('token') || q.get('token')
  const host = h.get('host') || q.get('host')
  if (host) {
    const list = hostList(host)
    if (list.length) {
      const clean = list.join(',')
      localStorage.setItem(LS.host, clean)
      S.hosts = list
      S.host = list[0]
    }
  }
  if (token) {
    localStorage.setItem(LS.token, token)
    S.token = token
  }
  if (token || host) {
    try {
      history.replaceState(null, '', location.pathname)
    } catch {}
  }
}

/**
 * 把用户填的东西变成完整 origin（含协议），比如：
 *   192.168.1.5            → http://192.168.1.5:7788
 *   100.88.1.2:7788        → http://100.88.1.2:7788
 *   [240e:3b0::12]:7788    → http://[240e:3b0::12]:7788   （IPv6 直连，手机 4G/5G 也能通）
 *   https://pocket.xx.com  → https://pocket.xx.com        （Cloudflare Tunnel 之类给的域名）
 */
function normalizeHost(v) {
  let s = String(v || '').trim()
  if (!s) return ''
  // 中文输入法容易打出全角符号（：．。 以及首尾的全角空格），先归一化，不然会被当成路径拼出废地址
  s = s.replace(/[\u3000]/g, ' ').replace(/：/g, ':').replace(/[．。]/g, '.').trim()
  let scheme = ''
  const m = s.match(/^(https?):\/\//i)
  if (m) {
    scheme = m[1].toLowerCase()
    s = s.slice(m[0].length)
  }
  s = s.replace(/\/+$/, '')
  if (!s) return ''
  // 手打的逗号/冒号残渣：[240e::1]: → [240e::1]；240e::1: → 240e::1（但不碰合法的 ::）
  if (s.endsWith(']:')) s = s.slice(0, -1)
  if (!s.endsWith(']') && s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1)
  // 裸 IPv6（冒号两个以上又没方括号）→ 补方括号
  if (!s.startsWith('[') && (s.match(/:/g) || []).length >= 2) s = '[' + s + ']'
  const hasPort = /^\[[^\]]+\]:\d+$/.test(s) || /^[^[\]]+:\d+$/.test(s)
  // https 域名（Cloudflare Tunnel 之类）走 443，不加端口；其余默认补 7788
  if (!hasPort && scheme !== 'https') s += ':7788'
  return `${scheme || 'http'}://${s}`
}

/** 地址框里的多个地址（逗号/空格隔开）→ 数组；家里填局域网地址，外面填 IPv6 / 域名 / Tailscale，全都填上就自动挑能通的 */
function hostList(v) {
  return String(v || '')
    .split(/[,，;；\s]+/)
    .map((x) => normalizeHost(x))
    .filter(Boolean)
}

/** S.host 存的是完整 origin，直接用 */
const base = () => (S.host ? S.host.replace(/\/+$/, '') : location.origin)

/**
 * 电脑那边会主动告诉我们它现在的公网地址（/api/state 的 endpoints.tunnel）。
 * 临时隧道每次重启都会换域名，让用户自己去抄新地址不现实 —— 所以只要手机连上过一次
 * （在家连 WiFi 就够），就把新地址悄悄记进候选列表，出门直接用。
 * 用户完全不需要知道「隧道域名」是什么东西。
 */
function syncEndpoints(st) {
  const ep = st && st.endpoints
  if (!ep || !ep.tunnel) return
  const next = normalizeHost(ep.tunnel)
  if (!next) return
  const prev = localStorage.getItem(LS.tunnel) || ''
  if (prev === next) return
  // 旧隧道域名已经作废，从候选里摘掉，免得堆一串永远不通的地址
  const rest = S.hosts.filter((h) => h !== prev && h !== next)
  const lan = rest.filter((h) => !/^https:\/\//i.test(h))
  const https = rest.filter((h) => /^https:\/\//i.test(h))
  S.hosts = [...lan, next, ...https]
  // 正在用的就是那条作废的旧域名时，切回第一条（通常是家里的局域网地址）
  if (S.host === prev) S.host = S.hosts[0] || ''
  localStorage.setItem(LS.host, S.hosts.join(','))
  localStorage.setItem(LS.tunnel, next)
  // 第一次记下来不打扰；之后地址真的变了才轻提示一下
  if (prev && prev !== next) {
    try {
      toast('出门地址已更新')
    } catch {}
  }
}

/** 当前地址连不上时，挨个试其它候选，谁通用谁（家里 WiFi ↔ 外面 4G/5G 自动切换） */
async function switchHost() {
  for (const cand of S.hosts) {
    if (cand === S.host) continue
    try {
      const r = await fetch(`${cand}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (r.ok) {
        S.host = cand
        S.hosts = [cand, ...S.hosts.filter((x) => x !== cand)]
        localStorage.setItem(LS.host, S.hosts.join(','))
        return true
      }
    } catch {}
  }
  return false
}

/**
 * 连不上代号表（自查 + 报障用）。编号有规律：
 *   P1x 连接层根本没通（手机 → 电脑）
 *   P2x 通了但被电脑拒（密钥 / 端口 / 服务）
 *   P3x 手机当前这个网络本身有问题
 *   P99 其他
 * 报障时报代号（比如「P13」）比自己描述快得多。
 */
const CODES = {
  P11: {
    t: '局域网地址超时',
    side: '手机 / 电脑',
    why: '手机不在这台 WiFi 上；或电脑防火墙没放行端口；或手机开着 VPN / 代理把它接走了',
    fix: '手机连回同一个 WiFi；关掉 VPN 和代理；电脑上放行 7788 入站',
  },
  P12: {
    t: '公网 IPv6 超时',
    side: '运营商 / 路由器 / 当前 WiFi',
    why: '手机的流量没有 IPv6；或光猫 / 路由器没放行端口；或你现在连的这个 WiFi（公司、酒店、校园网）封了 7788 这类高位端口',
    fix: '手机浏览器开 test-ipv6.com 看是不是 0/10；封端口的环境（外面的 WiFi 常见）只能走隧道，隧道走 443 一般能过',
  },
  P13: {
    t: '隧道域名超时',
    side: '电脑 / 代理',
    why: '电脑上的隧道已经停了（重启电脑后最常见）；或代理把 trycloudflare 域名拦了',
    fix: '新版电脑端会自己把挂掉的隧道拉起来（一分钟内），稍等再试；还不行就回家连一次 WiFi，app 会自动换成新地址。手动的话：让电脑面板看隧道是否「运行中」，停了就点「启动隧道」',
  },
  P14: {
    t: '局域网地址不可达',
    side: '手机 / 电脑',
    why: '这个地址现在没有服务在听：模块开关关着、换过网络、或地址是旧的',
    fix: '确认面板上「口袋aurabot」的开关是开的，地址从面板重新抄一遍',
  },
  P15: {
    t: '公网 IPv6 不可达',
    side: '运营商 / 路由器 / 当前 WiFi',
    why: '这台 IPv6 当前不可路由：手机没 IPv6、连的 WiFi 只给 IPv4、或地址变了',
    fix: '改走隧道；长期要用就在路由器里给电脑做固定的 DHCPv6 分配',
  },
  P16: {
    t: '隧道域名不可达',
    side: '电脑',
    why: '隧道重启过、域名已经换了（旧地址永久失效）；或域名解析被代理带偏',
    fix: '回家连一次 WiFi，app 会自动把地址换成新的；人在外面就打不开电脑面板了，可以让家里电脑前的人把「复制隧道地址」发给你。关掉代理再试也有用',
  },
  P17: {
    t: '域名解析失败',
    side: '手机当前网络',
    why: 'DNS 被代理 / 广告拦截 / 私人 DNS 改过，解析不出这个域名',
    fix: '关掉 VPN、代理、私人 DNS 再试',
  },
  P18: {
    t: '证书不对（疑似被劫持）',
    side: '中间人',
    why: '有代理或抓包软件在中间解 TLS，看到的证书不是 Cloudflare 的',
    fix: '关掉代理 / 抓包工具，或把这个域名加进直连白名单',
  },
  P19: {
    t: '地址格式不对',
    side: '填写',
    why: '这一条解析不出有效地址：端口写了两个、IPv6 少了方括号、多了斜杠或空格',
    fix: '照面板原样复制；多条用逗号隔开（中英文逗号都行）',
  },
  P21: {
    t: '密钥不对',
    side: '填写',
    why: '网络是通的，但配对密钥和电脑上的对不上',
    fix: '抄面板「口袋aurabot」页那条 pk_ 开头的；换过密钥要重新配对',
  },
  P22: {
    t: '密钥试错太多，被限流',
    side: '安全机制',
    why: '同一来源 60 秒内错了 10 次，服务暂时不受理',
    fix: '等一分钟，再用正确的密钥连',
  },
  P23: {
    t: '电脑接口没正常响应',
    side: '电脑',
    why: '地址通了，但那个端口回的不是口袋的接口（被别的程序占了，或服务没起来）',
    fix: '面板看「服务端口」有没有报错；确认没别的程序占着这个端口',
  },
  P24: {
    t: '电脑那边出错了',
    side: '电脑',
    why: '接口返回 5xx，服务内部报错',
    fix: '看 DSH 日志里 pocket 相关的报错，重开一次模块',
  },
  P30: {
    t: '手机当前网络本身没通',
    side: '手机当前 WiFi',
    why: '这个 WiFi 需要网页登录才能上网（酒店、机场、商场、公司访客网都很常见），或者根本没联网、信号是假的',
    fix: '先用手机浏览器随便打开一个网页：能上网再回来配对；公共 WiFi 记得点「同意 / 登录」那一步',
  },
  P99: {
    t: '未知原因',
    side: '—',
    why: '浏览器给的错误没法归到上面任何一类',
    fix: '把原始报错和代号一起发出来',
  },
}

/** 一条地址为什么连不上 → 代号 */
function failCode(cand, e) {
  const https = /^https:\/\//.test(cand)
  const v6 = /^https?:\/\/\[/.test(cand)
  const name = (e && e.name) || ''
  const msg = String((e && e.message) || e || '')
  if (/CERT|certificate|SSL|TLS|证书/i.test(msg)) return 'P18'
  if (/NAME_NOT_RESOLVED|Name not resolved|getaddrinfo|ENOTFOUND|dns/i.test(msg)) return 'P17'
  if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(msg)) return https ? 'P13' : v6 ? 'P12' : 'P11'
  if (/Failed to fetch|NetworkError|Load failed|fetch|网络/i.test(msg)) return https ? 'P16' : v6 ? 'P15' : 'P14'
  return 'P99'
}

/** 手机当前这个网络到底能不能上网——把「整个网络不通」和「到电脑的路不通」分开（P30 vs P1x） */
async function netBaseline(ms = 4000) {
  const urls = ['https://www.baidu.com/favicon.ico', 'https://cp.cloudflare.com/generate_204']
  for (const u of urls) {
    try {
      await fetch(`${u}${u.includes('?') ? '&' : '?'}_=${Date.now()}`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: AbortSignal.timeout(ms),
      })
      return true
    } catch {}
  }
  return false
}

/** 并行探一遍所有候选地址，谁先通用谁；全不通时逐条给代号，并顺手判断是不是手机自己没网 */
async function probeAll(list, ms = 6000) {
  const out = await Promise.all(
    list.map(async (cand) => {
      try {
        const h = await fetch(`${cand}/api/health`, { signal: AbortSignal.timeout(ms) })
        if (h.ok) return { cand, ok: true, code: '' }
        // 端口通了但回的不是口袋：401/403 当作密钥问题，429 是限流，其余算接口没起来
        const code = h.status === 401 || h.status === 403 ? 'P21' : h.status === 429 ? 'P22' : 'P23'
        return { cand, ok: false, code, status: h.status }
      } catch (e) {
        return { cand, ok: false, code: failCode(cand, e) }
      }
    }),
  )
  const good = out.find((x) => x.ok)
  if (good) return { ok: good.cand, code: '', detail: '', selfDown: false, results: out }

  // 全都不通：先看手机自己有没有网，再看每条地址
  const selfDown = !(await netBaseline())
  const lines = out.map((x) => `· ${x.code} ${CODES[x.code].t} —— ${x.cand}`)
  return { ok: null, code: selfDown ? 'P30' : out[0].code, detail: lines.join('\n'), selfDown, results: out }
}

async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const one = async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const res = await fetch(base() + path, {
        method,
        signal: ctl.signal,
        headers: {
          'x-pocket-token': S.token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (res.status === 401) {
        const e = new Error('密钥不对')
        e.code = 401
        throw e
      }
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) return res
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    return await one()
  } catch (e) {
    // 网络不通（不是密钥错）：先换个地址试一次，还在家/在外网不同地址间自动切换
    if (e.code === 401) throw e
    if (S.hosts.length > 1 && (await switchHost())) return await one()
    throw e
  }
}

// ---------- 视图 ----------
function show(view) {
  for (const v of $$('.view')) v.hidden = v.id !== 'view-' + view
  $('#tabbar').hidden = view === 'pair'
  if (view !== 'pair') {
    for (const b of $$('#tabbar button')) b.classList.toggle('on', b.dataset.tab === view)
  }
}

// ---------- 配色（只改界面，不动图标） ----------
const AVATAR = 'icons/avatar.png'

function paintTone(id, { persist = false } = {}) {
  const t = applyTone(id)
  S.tone = t.id
  $$('.tone').forEach((b) => b.classList.toggle('on', b.dataset.tone === t.id))
  if (persist) {
    localStorage.setItem(LS.tone, t.id)
    if (!S.toneLocal && S.token) api('/api/tone', { method: 'POST', body: { tone: t.id } }).catch(() => {})
  }
}

function buildToneGrid() {
  const grid = $('#tone-grid')
  grid.innerHTML = ''
  for (const t of TONES) {
    const b = document.createElement('button')
    b.className = 'tone'
    b.dataset.tone = t.id
    b.innerHTML = `<span class="sw" style="background:linear-gradient(135deg,${t.gradA},${t.gradB})"></span><span>${t.name}</span>`
    b.onclick = () => paintTone(t.id, { persist: true })
    grid.appendChild(b)
  }
  $('#tone-local').checked = S.toneLocal
  $('#tone-local').onchange = (e) => {
    S.toneLocal = e.target.checked
    localStorage.setItem(LS.toneLocal, S.toneLocal ? '1' : '0')
  }
}

// ---------- 聊天 ----------
function fmtTime(ts) {
  const d = new Date(ts || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return '今天'
  const y = new Date(today.getTime() - 86400000)
  if (same(d, y)) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 她的话里可能带 <voice> / <sticker:名字> / [voice] 占位 / [沉默]，拆干净 */
function parseReply(text) {
  let t = String(text || '')
  const hasVoice = /<voice>/i.test(t)
  t = t.replace(/<voice>[\s\S]*?<\/voice>/gi, '').replace(/<\/?voice>/gi, '')
  t = t.replace(/<sticker:[^>]*>/gi, '')
  t = t.replace(/\[(sticker|表情|voice)\]/gi, '')
  t = t.replace(/\[沉默\]/g, '')
  return { text: t.trim(), hasVoice }
}

const nearBottom = () => {
  const el = $('#chat-list')
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90
}
function scrollBottom(force) {
  const el = $('#chat-list')
  if (force || nearBottom()) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
}

function addMsg({ who, text, at, voice, image, audio, audioMime }, { animate = true } = {}) {
  const list = $('#chat-list')
  const el = document.createElement('div')
  el.className = 'msg ' + (who === 'me' ? 'me' : 'her')

  if (who !== 'me') {
    const ava = document.createElement('img')
    ava.className = 'ava'
    ava.src = AVATAR
    el.appendChild(ava)
  }
  const b = document.createElement('div')
  b.className = 'bubble'
  if (image) {
    const im = document.createElement('img')
    im.className = 'bubble-img'
    im.src = image
    im.alt = '图片'
    im.onclick = () => window.open(image, '_blank')
    b.appendChild(im)
  }
  if (text) b.appendChild(document.createTextNode(text))
  if (audio) {
    const vb = document.createElement('button')
    vb.className = 'voice-btn'
    vb.textContent = '▶ 语音条'
    vb.onclick = () => playBlob(b, vb, audio)
    b.appendChild(vb)
  } else if (voice && who !== 'me') {
    const vb = document.createElement('button')
    vb.className = 'voice-btn'
    vb.textContent = '🔊 听她说'
    vb.onclick = () => playVoice(b, text)
    b.appendChild(vb)
  }
  const st = document.createElement('span')
  st.className = 'stamp'
  st.textContent = fmtTime(at)
  b.appendChild(st)
  el.appendChild(b)
  if (!animate) el.style.animation = 'none'
  list.appendChild(el)
  return el
}

function pushMsg(m) {
  S.msgs.push(m)
  addMsg(m)
  scrollBottom()
}

async function loadHistory() {
  try {
    const r = await api('/api/history?days=7')
    if (!r || !r.ok) return
    const list = r.list || []
    let lastDay = ''
    for (const m of list) {
      const d = dayLabel(m.at)
      if (d !== lastDay) {
        lastDay = d
        const div = document.createElement('div')
        div.className = 'day-divider'
        div.textContent = d
        $('#chat-list').appendChild(div)
      }
      S.msgs.push(m)
      addMsg({ ...m, text: parseReply(m.text).text }, { animate: false })
    }
    scrollBottom(true)
  } catch (e) {
    handleErr(e)
  }
}

async function send() {
  const input = $('#chat-input')
  const text = input.value.trim()
  const img = S.img
  if (!text && !img) return
  input.value = ''
  autoGrow()
  clearImgPreview()
  $('#emoji-panel').hidden = true // 发出去了就把面板收起来
  const at = Date.now()
  addMsg({ who: 'me', text, image: img && img.dataUrl, at })
  S.msgs.push({ who: 'me', text: text || (img ? '[图片]' : ''), at })
  scrollBottom(true)
  S.pending = at
  $('#typing').hidden = false
  try {
    const r = await api('/api/message', { method: 'POST', body: { text, image: img ? img.b64 : undefined }, timeout: 30000 })
    if (r && r.ok === false) throw new Error(r.message || '发不出去')
  } catch (e) {
    S.pending = 0
    $('#typing').hidden = true
    addSysToast('没送到她那儿：' + (e.message || '网络不通'))
    handleErr(e)
  }
}

async function playVoice(bubbleEl, text) {
  // 正在放的是同一条 → 停掉就行
  if (S.playing && S.playingText === text) {
    S.playing.pause()
    if (S.stopPlaying) S.stopPlaying()
    return
  }
  stopPlaying()
  const btn = bubbleEl.querySelector('.voice-btn')
  const old = btn.textContent
  btn.textContent = '…合成中'
  try {
    const res = await fetch(`${base()}/api/voice?text=${encodeURIComponent(text)}&token=${encodeURIComponent(S.token)}`)
    if (!res.ok || !(res.headers.get('content-type') || '').includes('audio')) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.message || '语音没合成出来')
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    S.playing = audio
    S.playingText = text
    bubbleEl.classList.add('playing')
    btn.textContent = '■ 播放中'
    audio.onended = cleanupPlaying
    audio.onerror = cleanupPlaying
    S.stopPlaying = cleanupPlaying
    await audio.play()
    function cleanupPlaying() {
      bubbleEl.classList.remove('playing')
      btn.textContent = old
      S.playing = null
      S.playingText = ''
      S.stopPlaying = null
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    btn.textContent = old
    addSysToast(e.message || '语音失败')
  }
}

/** 停掉当前在放的那条（不营是真实语音条还是合成的），并把它的按钮恢复 */
function stopPlaying() {
  if (S.playing) {
    try { S.playing.pause() } catch {}
    S.playing = null
  }
  if (S.stopPlaying) {
    const f = S.stopPlaying
    S.stopPlaying = null
    f()
  }
}

/** 放她发来的真实语音条（send 钩子抓的原始音频，data:URL）；按钮状态跟 playVoice 一致 */
function playBlob(bubbleEl, btn, src) {
  if (S.playing && S.playingSrc === src) {
    S.playing.pause()
    if (S.stopPlaying) S.stopPlaying()
    return
  }
  stopPlaying()
  const old = btn.textContent
  const audio = new Audio(src)
  S.playing = audio
  S.playingSrc = src
  S.playingText = ''
  bubbleEl.classList.add('playing')
  btn.textContent = '■ 播放中'
  const cleanup = () => {
    bubbleEl.classList.remove('playing')
    btn.textContent = old
    if (S.playing === audio) {
      S.playing = null
      S.playingSrc = ''
    }
    S.stopPlaying = null
  }
  S.stopPlaying = cleanup
  audio.onended = cleanup
  audio.onerror = () => {
    cleanup()
    addSysToast('这条语音放不出来')
  }
  audio.play().catch(() => {})
}

/** 屏幕下方的浮动提示（设置页也能看见，不像聊天里的系统气泡） */
let toastTimer = 0
function toast(text) {
  let el = $('#toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast glass'
    $('#app').appendChild(el)
  }
  el.textContent = text
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200)
}

// ---------- 换她的形象（从相册） ----------
function pickAvatar() {
  $('#avatar-file').click()
}

async function onAvatarPicked(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  toast('正在处理这张图…')
  try {
    const r = await compressAvatar(f)
    const res = await api('/api/avatar', { method: 'POST', body: { image: r.dataUrl }, timeout: 60000 })
    if (!res || res.ok === false) throw new Error((res && res.message) || '没换成功')
    refreshAvatars()
    toast('形象换好啦')
  } catch (err) {
    toast('这张换不了：' + (err.message || err))
  }
}

/** 压到 1024px、转 jpeg：图片不会太大，透明 PNG 铺白底免得变黑 */
function compressAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const MAX = 1024
        let w = img.naturalWidth
        let h = img.naturalHeight
        if (!w || !h) throw new Error('读不到尺寸')
        if (Math.max(w, h) > MAX) {
          const k = MAX / Math.max(w, h)
          w = Math.round(w * k)
          h = Math.round(h * k)
        }
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const g = c.getContext('2d')
        g.fillStyle = '#ffffff'
        g.fillRect(0, 0, w, h)
        g.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        resolve({ dataUrl: c.toDataURL('image/jpeg', 0.9) })
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('不是能读的图片'))
    }
    img.src = url
  })
}

/** 换完给所有头像加个时间戳，绕过缓存 */
function refreshAvatars() {
  const v = Date.now()
  for (const im of $$('img')) {
    const s = im.getAttribute('src') || ''
    if (s.indexOf('icons/avatar.png') === 0) im.src = 'icons/avatar.png?v=' + v
  }
}

async function resetAvatar() {
  try {
    const res = await api('/api/avatar', { method: 'DELETE' })
    if (!res || res.ok === false) throw new Error((res && res.message) || '没恢复成')
    refreshAvatars()
    toast('换回默认形象了')
  } catch (e) {
    toast('没恢复成：' + (e.message || e))
  }
}

function addSysToast(text) {
  const el = document.createElement('div')
  el.className = 'day-divider'
  el.textContent = text
  $('#chat-list').appendChild(el)
  scrollBottom()
  setTimeout(() => el.remove(), 6000)
}

// ---------- 发图片 ----------
function pickImage() { $('#chat-file').click() }

function onFilePicked(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  compressImage(f)
    .then((r) => {
      S.img = r
      const im = $('#img-preview-img')
      im.src = r.dataUrl
      $('#img-preview-size').textContent = kb(r.b64.length) + ' · 点发送一起发出去'
      $('#img-preview').hidden = false
      scrollBottom(true) // 预览条占了一块高度，把最后一条消息顶上去
    })
    .catch((err) => addSysToast('图片读不出来：' + (err.message || err)))
}

const kb = (b64len) => {
  const n = Math.round((b64len * 3) / 4 / 1024)
  return n > 1024 ? (n / 1024).toFixed(1) + ' MB' : n + ' KB'
}

/** 压到 1280px / jpeg 0.85，手机照片也不会超过几百 KB */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const MAX = 1280
        let w = img.naturalWidth, h = img.naturalHeight
        if (Math.max(w, h) > MAX) {
          const k = MAX / Math.max(w, h)
          w = Math.round(w * k)
          h = Math.round(h * k)
        }
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').drawImage(img, 0, 0, w, h)
        const dataUrl = c.toDataURL('image/jpeg', 0.85)
        URL.revokeObjectURL(url)
        resolve({ dataUrl, b64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('不是能读的图')) }
    img.src = url
  })
}

function clearImgPreview() {
  S.img = null
  $('#img-preview').hidden = true
  $('#img-preview-img').removeAttribute('src')
  scrollBottom(true)
}

// ---------- 语音条（按住说话） ----------
let rec = null
// 装在手机里时，网页跑在 http://192.168.x.x 这种非安全上下文上，没有 getUserMedia，
// 所以优先用安卓壳里的原生录音（PocketMic），浏览器里再回退到 MediaRecorder。
const NATIVE_MIC = !!(window.PocketMic && typeof window.PocketMic.start === 'function')

function nativeMicStart() {
  let onDone = null
  window.__pocketMicDone = (b64) => {
    const fn = onDone
    onDone = null
    if (fn) fn(String(b64 || ''))
  }
  let r = 'ok'
  try {
    r = String(window.PocketMic.start() || '')
  } catch (e) {
    r = String((e && e.message) || e)
  }
  if (r !== 'ok') {
    delete window.__pocketMicDone
    return { error: r }
  }
  return {
    wait: (cb) => {
      onDone = cb
    }
  }
}

function b64ToBuf(b64) {
  const s = atob(b64)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u.buffer
}

async function startRec() {
  if (S.recording || rec) return
  if (NATIVE_MIC) {
    const h = nativeMicStart()
    if (h.error) {
      addSysToast('拿不到麦克风：' + h.error)
      return
    }
    rec = { native: true, onDone: h.wait }
    S.recording = true
    S.recStart = Date.now()
    $('#rec-indicator').hidden = false
    $('#chat-mic').classList.add('recording')
    if (navigator.vibrate) navigator.vibrate(12)
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mr = new MediaRecorder(stream)
    mr._stream = stream // 太短的录音要自己关麦，onstop 会被摘掉
    const chunks = []
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
      blob.arrayBuffer().then((ab) => sendVoiceNote(ab, blob.type)).catch(() => {})
    }
    mr.start()
    rec = mr
    S.recording = true
    S.recStart = Date.now()
    $('#rec-indicator').hidden = false
    $('#chat-mic').classList.add('recording')
    if (navigator.vibrate) navigator.vibrate(12)
  } catch {
    addSysToast('拿不到麦克风（检查权限）')
  }
}

function stopRec() {
  if (!rec) return
  $('#rec-indicator').hidden = true
  $('#chat-mic').classList.remove('recording')
  S.recording = false
  const mr = rec
  const dur = Date.now() - (S.recStart || 0)
  rec = null
  S.recStart = 0

  if (mr.native) {
    if (dur < 700) {
      try { window.PocketMic.cancel() } catch {}
      delete window.__pocketMicDone
      addSysToast('按住话筒别松手，说完再松开')
      return
    }
    mr.onDone((b64) => {
      if (!b64) {
        addSysToast('这条语音没录上，再试一次')
        return
      }
      sendVoiceNote(b64ToBuf(b64), 'audio/mp4')
    })
    try { window.PocketMic.stop() } catch {}
    return
  }

  if (dur < 700) {
    // 误触：不往外发，自己把麦克风关掉
    mr.onstop = null
    mr.ondataavailable = null
    try { mr.stop() } catch {}
    try { mr._stream && mr._stream.getTracks().forEach((t) => t.stop()) } catch {}
    addSysToast('按住话筒别松手，说完再松开')
    return
  }
  try { mr.stop() } catch {}
}

async function sendVoiceNote(ab, mime) {
  const m = mime || 'audio/webm'
  const b64 = bufToB64(ab)
  const at = Date.now()
  addMsg({ who: 'me', text: '', audio: 'data:' + m + ';base64,' + b64, audioMime: m, at })
  S.msgs.push({ who: 'me', text: '[语音]', at })
  scrollBottom(true)
  try {
    const r = await api('/api/voice-note', { method: 'POST', body: { audio: b64 }, timeout: 150000 })
    if (r && r.ok === false) addSysToast(r.message || '她没听清这条语音')
  } catch (e) {
    addSysToast('语音没送到：' + (e.message || e))
  }
}

function bufToB64(buf) {
  const u = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
  return btoa(s)
}

// ---------- emoji 面板（emoji 就是文字，走同一条消息） ----------
const EMOJIS = '😀 😁 😂 🤣 😊 😍 🥰 😘 😜 🤪 😎 🥳 😭 😢 😡 🤬 😱 😴 🤤 🥺 😏 🤔 🤗 🙈 🐶 🐱 🐟 🍚 🍜 🍰 🧋 🍦 🌊 🌙 ⭐ 💕 💖 💘 ✨ 🌸 🍀'.split(/\s+/).filter(Boolean)

function buildEmoji() {
  const panel = $('#emoji-panel')
  panel.innerHTML = ''
  for (const em of EMOJIS) {
    const b = document.createElement('button')
    b.className = 'emoji-item'
    b.textContent = em
    b.onclick = () => {
      insertAtCursor(em)
      panel.hidden = true
    }
    panel.appendChild(b)
  }
}

function insertAtCursor(t) {
  const el = $('#chat-input')
  const st = el.selectionStart ?? el.value.length
  const en = el.selectionEnd ?? st
  el.value = el.value.slice(0, st) + t + el.value.slice(en)
  el.selectionStart = el.selectionEnd = st + t.length
  el.focus()
  autoGrow()
}

// 轮询她的话
async function poll() {
  try {
    const r = await api('/api/events?after=' + S.seq, { timeout: 8000 })
    setOnline(true)
    if (!r || !r.ok) return
    S.seq = r.seq || S.seq
    for (const e of r.list || []) {
      if (e.type === 'her') {
        const p = parseReply(e.text)
        if (!p.text) continue
        S.pending = 0
        $('#typing').hidden = true
        pushMsg({ who: 'her', text: p.text, at: e.at, voice: p.hasVoice })
      } else if (e.type === 'her-media') {
        // 她发的图片 / 表情包 / 语音条（send 钩子抓的原始段）
        S.pending = 0
        $('#typing').hidden = true
        if (e.kind === 'image' && e.data) {
          pushMsg({ who: 'her', text: e.text || '', image: `data:${e.mime || 'image/png'};base64,${e.data}`, at: e.at })
        } else if (e.kind === 'voice' && e.data) {
          pushMsg({ who: 'her', text: '', audio: `data:${e.mime || 'audio/wav'};base64,${e.data}`, audioMime: e.mime, at: e.at })
        }
      } else if (e.type === 'qq-state') {
        renderStatus(e.state === 'connected')
      }
    }
    if (S.pending && Date.now() - S.pending > 120000) {
      S.pending = 0
      $('#typing').hidden = true
    }
  } catch (e) {
    if (e.code === 401) return toPair('密钥不对，重新输一下')
    setOnline(false)
  }
}

function setOnline(ok) {
  if (S.online === ok) return
  S.online = ok
  let bar = $('#offline')
  if (!ok) {
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'offline'
      bar.textContent = '电脑那边连不上，在重试…'
      $('#app').appendChild(bar)
    }
    bar.hidden = false
  } else if (bar) {
    bar.hidden = true
  }
}

function personaName(id) {
  const map = { dafeiyu: '鲸汐汐' }
  return map[String(id || '')] || (id ? String(id) : '她')
}

function renderStatus(qqOnline) {
  const st = S.state || {}
  const nm = personaName(st.persona)
  $('#chat-name').textContent = nm
  $('#mo-name').textContent = nm + '的空间'
  const parts = [qqOnline ? '在线' : '离线']
  if (st.moodLabel) parts.push(st.moodLabel)
  $('#chat-status').textContent = parts.join(' · ')
  $('#set-qq').textContent = qqOnline ? '在线' : '离线'
  $('#set-host').textContent = S.host || location.host || '本机'
  // 出门用的地址由电脑自动同步过来（隧道换域名时手机自己就更新了，不用人记）
  const away = (st.endpoints && st.endpoints.tunnel) || localStorage.getItem(LS.tunnel) || ''
  $('#set-away').textContent = away ? away.replace(/^https:\/\//, '') : '只在局域网'
  // 域名长，界面上会被省略号截断，完整值放 title（长按能看到）
  $('#set-away').title = away || '没开隧道时只能在家连'
  $('#set-token').textContent = S.token ? S.token.slice(0, 5) + '…' : '–'
  $('#set-mem').textContent = st.memoryCount != null ? st.memoryCount + ' 条' : '–'
  // 显示电脑端模块版本：界面和功能都跟着它走，apk 只是外壳（1.0.x）
  $('#set-ver').textContent = S.srvVersion
    ? `模块 ${S.srvVersion} · ${S.appVersion ? 'App ' + S.appVersion : '网页版'}`
    : '–'
}

// ---------- 空间 ----------
function visibilityLabel(v) {
  const map = { public: '公开', private: '仅自己', friends: '好友可见', owner: '只给主人看', qzone: '空间' }
  return map[String(v || '')] || ''
}

function renderMoments(data) {
  const list = $('#moments-list')
  list.innerHTML = ''
  const items = (data && data.list) || []
  if (!items.length) {
    list.innerHTML = '<div class="empty">这里还空着<br>她在电脑那边写了日记就会出现在这儿</div>'
  } else {
    for (const it of items) {
      const card = document.createElement('article')
      card.className = 'moment'
      const when = document.createElement('div')
      when.className = 'when'
      const t = document.createElement('span')
      t.textContent = `${dayLabel(it.at)} ${fmtTime(it.at)}`
      when.appendChild(t)
      const body = document.createElement('div')
      body.className = 'body'
      body.textContent = it.text
      card.append(when, body)
      const vl = visibilityLabel(it.visibility)
      if (vl) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = vl
        card.appendChild(tag)
      }
      list.appendChild(card)
    }
  }
  drawMood((data && data.mood) || [])
}

function guessMood() {
  return [62, 70, 74, 66, 80, 78, 84]
}

function drawMood(points) {
  const svg = $('#mood-chart')
  const vals = (points || []).map((p) => Number(p && typeof p === 'object' ? (p.value ?? p.mood) : p)).filter((n) => Number.isFinite(n))
  const data = vals.length ? vals : []
  const w = 320
  const h = 80
  const pad = 8
  svg.innerHTML = ''
  if (data.length < 2) {
    const v = data.length === 1 ? data[0] : Number(S.state?.mood)
    $('#mood-value').textContent = Number.isFinite(v) ? Math.round(v) : '–'
    if (Number.isFinite(v)) {
      const y = h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2)
      svg.innerHTML = `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${w - pad}" y2="${y.toFixed(1)}" stroke="var(--primary)" stroke-width="2" stroke-dasharray="4 6" opacity=".6"/><circle cx="${w - pad}" cy="${y.toFixed(1)}" r="3.6" fill="var(--primary)"/>`
    }
    return
  }
  $('#mood-value').textContent = Math.round(data[data.length - 1])
  const step = (w - pad * 2) / (data.length - 1)
  const xy = data.map((v, i) => [pad + i * step, h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2)])
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${h - pad} L${pad},${h - pad} Z`
  svg.innerHTML = `
    <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--primary)" stop-opacity=".35"/>
      <stop offset="1" stop-color="var(--primary)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#mg)"/>
    <path d="${line}" fill="none" stroke="var(--primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${xy[xy.length - 1][0].toFixed(1)}" cy="${xy[xy.length - 1][1].toFixed(1)}" r="3.4" fill="var(--primary)"/>`
}

async function loadMoments() {
  try {
    const r = await api('/api/moments')
    if (r && r.ok) renderMoments(r)
  } catch (e) {
    handleErr(e)
  }
}

// ---------- 宠物 ----------
const FOOD_ICON = { rice: '🍚', fish: '🐟', hotpot: '🍲', milktea: '🧋', cake: '🍰', ice: '🍨' }

function renderPet(st) {
  if (!st) return
  const set = (bar, val, v) => {
    const el = $(bar)
    el.style.width = v + '%'
    el.classList.toggle('low', v < 30)
    $(val).textContent = v
  }
  set('#bar-satiety', '#val-satiety', st.satiety)
  set('#bar-mood', '#val-mood', st.mood)
  set('#bar-intimacy', '#val-intimacy', st.intimacy)
  const mascot = $('#pet-mascot')
  mascot.classList.toggle('sleepy', !!st.sleepy)
  $('#pet-sub').textContent = st.hungry ? '她饿了，快投喂！' : st.sleepy ? '她困了，让她早点睡' : '她在里面游来游去'
}

function buildFoods(foods) {
  const grid = $('#food-grid')
  grid.innerHTML = ''
  for (const f of foods && foods.length ? foods : [{ id: 'rice', name: '白米饭' }]) {
    const b = document.createElement('button')
    b.className = 'food'
    b.innerHTML = `<span class="ico">${FOOD_ICON[f.id] || '🍚'}</span><span>${f.name}</span>`
    b.onclick = () => petAct('feed', f.id)
    grid.appendChild(b)
  }
}

function petBubble(text, ms = 4200) {
  const el = $('#pet-bubble')
  el.textContent = text
  el.hidden = false
  clearTimeout(petBubble._t)
  petBubble._t = setTimeout(() => (el.hidden = true), ms)
}

function petFx(emojis) {
  const box = $('#pet-fx')
  for (let i = 0; i < (emojis || 6); i++) {
    const s = document.createElement('span')
    s.className = 'fx-emoji'
    s.textContent = ['💗', '✨', '🫧', '🐟', '🍚'][Math.floor(Math.random() * 5)]
    s.style.left = 30 + Math.random() * 40 + '%'
    s.style.top = 55 + Math.random() * 20 + '%'
    s.style.animationDelay = Math.random() * 0.35 + 's'
    box.appendChild(s)
    setTimeout(() => s.remove(), 1600)
  }
}

async function petAct(action, food) {
  const mascot = $('#pet-mascot')
  try {
    const r = await api('/api/pet', { method: 'POST', body: { action, food } })
    if (!r) return
    if (r.reply) petBubble(r.reply)
    if (r.ok) {
      petFx()
      mascot.classList.remove('happy', 'shake')
      void mascot.offsetWidth
      mascot.classList.add(action === 'pet' ? 'shake' : 'happy')
    } else if (r.refused) {
      mascot.classList.remove('shake')
      void mascot.offsetWidth
      mascot.classList.add('shake')
    }
    if (r.state) {
      renderPet(r.state)
      buildFoods(r.state.foods)
    }
  } catch (e) {
    handleErr(e)
  }
}

// ---------- 设置 ----------
function renderSettings() {
  const st = S.state || {}
  renderStatus(st.qqOnline)
}

// ---------- 代号速查（配对页折叠表，只建一次） ----------
function renderCodes() {
  const box = $('#pair-codes')
  if (!box || box.dataset.done) return
  box.dataset.done = '1'
  const rows = Object.entries(CODES)
    .map(([k, v]) => `<details class="code-row" data-code="${k}"><summary><b>${k}</b> ${v.t}</summary><p><i>${v.side}</i> · 原因：${v.why}</p><p>怎么办：${v.fix}</p></details>`)
    .join('')
  box.innerHTML = `<details class="code-wrap"><summary>代号速查（连不上时对照这里）</summary>${rows}</details>`
}

/** 报错时把命中的那几条展开高亮，其余收着，省得手动翻 */
function openCodes(codes = []) {
  const box = $('#pair-codes')
  if (!box || !codes.length) return
  renderCodes()
  const wrap = box.querySelector('.code-wrap')
  if (wrap) wrap.open = true
  box.querySelectorAll('.code-row').forEach((d) => {
    const hit = codes.includes(d.dataset.code)
    d.classList.toggle('hit', hit)
    d.open = hit
  })
  // 不自动滚动：红色错误正文比表格更重要，滚下去会把结论推出屏幕
}

function showPairErr(text, codes = []) {
  const el = $('#pair-err')
  el.textContent = text
  el.hidden = false
  openCodes(codes)
}

function toPair(reason, codes) {
  clearInterval(S.polling)
  S.polling = null
  if (reason) showPairErr(reason, codes || [])
  else {
    $('#pair-err').hidden = true
    $('#pair-err').textContent = ''
  }
  renderCodes()
  $('#pair-host').value = (S.hosts.length ? S.hosts.join(',') : S.host) || localStorage.getItem(LS.host) || ''
  $('#pair-token').value = ''
  show('pair')
}

async function doPair() {
  const err = $('#pair-err')
  const raw = String($('#pair-host').value || '').trim()
  const hosts = hostList(raw)
  const token = $('#pair-token').value.trim()
  err.hidden = true
  if (!hosts.length) {
    if (raw) return showPairErr(`[P19] 地址格式不对：${raw}\n照面板原样复制；多条用逗号隔开（中英文逗号都行）。`, ['P19'])
    return showPairErr('先填电脑地址（面板上有；家里 / 外面两个地址都用逗号填上）')
  }
  if (!token) return showPairErr('先填配对密钥')
  const btn = $('#pair-go')
  btn.disabled = true
  btn.textContent = '正在连…'
  try {
    // 并行探活，谁通用谁（多地址时其余的留着做备用）；都不通就把每条的原因摊开成代号
    const probe = await probeAll(hosts)
    if (!probe.ok) {
      const codes = probe.results.map((x) => x.code)
      if (probe.selfDown) codes.unshift('P30')
      const tip = probe.selfDown
        ? '[P30] 手机现在这个网络本身没通\n先用浏览器随便打开一个网页：能上网再回来配对（公共 WiFi 常要先点「同意 / 登录」这一步）。\n\n这几条地址也都试了，同样不通：\n' +
          probe.detail
        : '这几条都不通：\n' + probe.detail + '\n\n点下面「代号速查」看每条怎么修；报障把代号发我（比如 P11）就够。'
      throw Object.assign(new Error(tip), { plain: true, codes })
    }
    const ok = probe.ok
    S.host = ok
    S.hosts = [ok, ...hosts.filter((x) => x !== ok)]
    S.token = token
    const r = await api('/api/state', { timeout: 6000 })
    if (!r || !r.ok) throw new Error((r && r.message) || '密钥不对')
    localStorage.setItem(LS.host, S.hosts.join(','))
    localStorage.setItem(LS.token, token)
    boot()
  } catch (e) {
    if (e.code === 401) {
      showPairErr('[P21] 密钥不对\n网络是通的，密钥和电脑上的对不上：抄面板「口袋aurabot」页那条 pk_ 开头的，注意别带空格。', ['P21'])
    } else if (e.plain) {
      showPairErr(e.message, e.codes || [])
    } else {
      const c = failCode(S.host || hosts[0], e)
      showPairErr(`[${c}] ${CODES[c].t}\n${CODES[c].fix}`, [c])
    }
  } finally {
    btn.disabled = false
    btn.textContent = '连上她'
  }
}

// ---------- 启动 ----------
function autoGrow() {
  const el = $('#chat-input')
  el.style.height = 'auto'
  el.style.height = Math.min(108, el.scrollHeight) + 'px'
}

async function boot() {
  takeFromUrl()
  paintTone(S.tone)
  buildToneGrid()
  $('#btn-repair').onclick = () => toPair()
  $('#pair-go').onclick = doPair
  renderCodes()
  $('#chat-send').onclick = send
  $('#btn-scroll-down').onclick = () => scrollBottom(true)
  $('#chat-emoji').onclick = () => {
    const p = $('#emoji-panel')
    p.hidden = !p.hidden
    if (!p.hidden) scrollBottom(true)
  }
  $('#chat-img').onclick = pickImage
  $('#chat-file').addEventListener('change', onFilePicked)
  $('#img-preview-del').onclick = clearImgPreview
  // 换她的形象：小窝那颗相机按钮 + 设置页两个按钮
  $('#pet-avatar-btn').onclick = pickAvatar
  $('#btn-avatar-pick').onclick = pickAvatar
  $('#btn-avatar-reset').onclick = resetAvatar
  $('#avatar-file').addEventListener('change', onAvatarPicked)
  const mic = $('#chat-mic')
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try { mic.setPointerCapture(e.pointerId) } catch {}
    startRec()
  })
  // 手指滑出按钮、来电、切后台都要兜底停掉，不然会一直「按着」
  window.addEventListener('pointerup', stopRec)
  window.addEventListener('pointercancel', stopRec)
  window.addEventListener('blur', stopRec)
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopRec() })
  buildEmoji()
  $('#chat-input').addEventListener('input', autoGrow)
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  for (const b of $$('#tabbar button')) {
    b.onclick = () => {
      show(b.dataset.tab)
      if (b.dataset.tab === 'moments') loadMoments()
      if (b.dataset.tab === 'pet' && S.state) renderPet(S.state.pet)
      if (b.dataset.tab === 'settings') renderSettings()
    }
  }
  for (const b of $$('.pet-btns [data-action]')) b.onclick = () => petAct(b.dataset.action)

  if (!S.token) return toPair()

  try {
    const st = await api('/api/state', { timeout: 8000 })
    if (!st || !st.ok) throw new Error((st && st.message) || '连不上')
    S.state = st
    S.seq = 0
    // 顺手把电脑当前的公网地址记下来（隧道换了域名也不用用户管）
    syncEndpoints(st)
    // 版本号（设置页显示「模块 x · App y」）：health 不需要密钥，失败也不影响主流程
    fetch(base() + '/api/health', { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json())
      .then((j) => {
        S.srvVersion = (j && j.version) || ''
        renderSettings()
      })
      .catch(() => {})
    renderStatus(st.qqOnline)
    renderPet(st.pet)
    buildFoods(st.pet && st.pet.foods)
    // 服务器上有色调设置、本地没改过 → 跟服务器走
    if (st.tone && !localStorage.getItem(LS.tone) ) paintTone(st.tone)
    show('chat')
    await loadHistory()
    clearInterval(S.polling)
    S.polling = setInterval(poll, 1600)
    poll()
  } catch (e) {
    if (e.code === 401) return toPair('[P21] 密钥不对\n抄面板「口袋aurabot」页那条 pk_ 开头的，重新输一下。', ['P21'])
    const list = S.hosts.length ? S.hosts : S.host ? [S.host] : []
    const p = list.length ? await probeAll(list).catch(() => null) : null
    if (p && !p.ok) {
      const codes = p.selfDown ? ['P30', ...p.results.map((x) => x.code)] : p.results.map((x) => x.code)
      return toPair(
        (p.selfDown ? '[P30] 手机现在这个网络本身没通\n' : '连不上电脑：\n') + p.detail + '\n报障把代号发我（比如 P11）就够。',
        codes,
      )
    }
    const c = failCode(S.host || list[0] || '', e)
    toPair(`[${c}] ${CODES[c].t}\n${CODES[c].fix}`, [c])
  }
}

boot()
