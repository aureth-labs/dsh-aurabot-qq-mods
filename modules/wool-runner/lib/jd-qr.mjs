import { randomUUID } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
const sessions = new Map()

function cookiesOf(response) {
  const rows = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return rows.map((row) => row.split(';')[0]).filter(Boolean)
}
function cookieHeader(jar) { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
function saveCookies(jar, response) {
  for (const row of cookiesOf(response)) {
    const i = row.indexOf('=')
    if (i > 0) jar.set(row.slice(0, i), row.slice(i + 1))
  }
}
async function request(url, jar, options = {}) {
  const response = await fetch(url, {
    redirect: 'manual', signal: AbortSignal.timeout(20_000), ...options,
    headers: { 'user-agent': UA, referer: 'https://passport.jd.com/new/login.aspx', cookie: cookieHeader(jar), ...(options.headers || {}) },
  })
  saveCookies(jar, response)
  return response
}
function jsonp(text) {
  const match = String(text).match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/)
  return JSON.parse(match ? match[1] : text)
}

export function createJdQr({ store }) {
  async function start() {
    const jar = new Map()
    const response = await request(`https://qr.m.jd.com/show?appid=133&size=300&t=${Date.now()}`, jar)
    if (!response.ok) throw new Error(`京东二维码接口返回 ${response.status}`)
    const image = Buffer.from(await response.arrayBuffer())
    const token = jar.get('wlfstk_smdl')
    if (!token || image.length < 100) throw new Error('没有取得京东二维码，请稍后重试')
    const id = randomUUID()
    sessions.set(id, { jar, token, createdAt: Date.now(), status: 'waiting' })
    return { ok: true, session: id, image: `data:image/png;base64,${image.toString('base64')}`, status: 'waiting' }
  }

  async function validate(session, ticket) {
    const response = await request(`https://passport.jd.com/uc/qrCodeTicketValidation?t=${encodeURIComponent(ticket)}`, session.jar)
    const text = await response.text()
    let result = {}
    try { result = jsonp(text) } catch {}
    if (result.returnCode != null && Number(result.returnCode) !== 0) throw new Error(`京东票据校验失败（${result.returnCode}）`)
    if (Number(result.riskCode || 0) !== 0) throw new Error('京东要求进行额外安全验证，请在官方页面完成后再试')
    const targets = [response.headers.get('location'), result.url].filter(Boolean)
    for (const target of targets.slice(0, 3)) {
      try {
        const url = new URL(target, 'https://passport.jd.com/')
        if (url.protocol !== 'https:' || !/(^|\.)jd\.com$/i.test(url.hostname)) continue
        const next = await request(url, session.jar)
        await next.arrayBuffer()
      } catch {}
    }
    const ptKey = session.jar.get('pt_key')
    const ptPin = session.jar.get('pt_pin') || session.jar.get('pin') || ''
    if (!ptKey) throw new Error('扫码已确认，但京东未下发 pt_key；请重试，或改用手动添加 Cookie')
    store.upsertEnv({ name: 'JD_COOKIE', value: `pt_key=${ptKey};pt_pin=${ptPin};`, remarks: '京东扫码登录' })
    return { ok: true, status: 'confirmed', message: 'JD_COOKIE 已保存到本机环境变量' }
  }

  async function poll(id) {
    const session = sessions.get(id)
    if (!session) return { ok: false, status: 'expired', message: '二维码会话不存在或已完成' }
    if (Date.now() - session.createdAt > 180_000) { sessions.delete(id); return { ok: false, status: 'expired', message: '二维码已过期，请重新获取' } }
    const response = await request(`https://qr.m.jd.com/check?appid=133&token=${encodeURIComponent(session.token)}&callback=jsonpCallback&_=${Date.now()}`, session.jar)
    const result = jsonp(await response.text())
    const code = Number(result.code)
    if (code === 200) {
      const confirmed = await validate(session, result.ticket)
      sessions.delete(id)
      return confirmed
    }
    if (code === 202) return { ok: true, status: 'scanned', message: '已扫码，请在京东 App 中确认登录' }
    if (code === 203 || code === 204 || code === 205) { sessions.delete(id); return { ok: false, status: 'expired', message: code === 205 ? '已取消登录' : '二维码已过期' } }
    return { ok: true, status: 'waiting', message: '等待京东 App 扫码' }
  }
  function cancel(id) { sessions.delete(id); return { ok: true } }
  return { start, poll, cancel }
}
