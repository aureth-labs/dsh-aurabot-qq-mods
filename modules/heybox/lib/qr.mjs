// 扫码登录只由面板主动发起；与普通请求共用客户端的限速和风控状态。
import { encodeQrPng } from './qrpng.mjs'

export function mergeSetCookies(cookies, setCookies) {
  const out = { ...cookies }
  for (const raw of setCookies || []) {
    const first = String(raw).split(';', 1)[0]
    const i = first.indexOf('=')
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim()
  }
  return out
}

export const cookieHeader = (cookies) => Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
const keepCookies = (cookies) => Object.fromEntries(Object.entries(cookies).filter(([k]) => /^(pkey|user_pkey|x_xhh_tokenid|heybox_id|user_heybox_id|_user_token)$/.test(k)))

export async function startQrLogin(client) {
  const { data, setCookies } = await client.request({ path: '/account/get_qrcode_url', params: { app: 'web' }, cookie: '', captureCookies: true })
  const qrUrl = data?.result?.qr_url
  if (!qrUrl) throw new Error('接口没有返回二维码地址')
  let token
  try { token = new URL(qrUrl).searchParams.get('qr') } catch { /* 地址格式不对 */ }
  if (!token) throw new Error('二维码地址里没有 qr token')
  return { qrUrl, token, expire: Number(data.result.expire) || 120, png: encodeQrPng(qrUrl), cookies: mergeSetCookies({}, setCookies) }
}

// 有效账号必须明确返回账号 ID；空结果不能当作验证通过。
export async function verifyCookie(client, cookie, riskToken) {
  const data = await client.request({ path: '/account/restore_login', cookie, allowCooldownRisk: riskToken })
  const r = data.result || {}
  const profile = r.profile || r.account_detail || {}
  const heyboxId = String(profile.heybox_id ?? profile.userid ?? r.heybox_id ?? r.account_detail?.userid ?? '').trim()
  return { verified: Boolean(heyboxId), heyboxId, nickname: String(profile.username ?? profile.nickname ?? '') }
}

export async function pollQrLogin(client, token, sessionCookies) {
  const { data, setCookies } = await client.request({ path: '/account/qr_state', params: { app: 'web', qr: token }, cookie: cookieHeader(sessionCookies), captureCookies: true })
  const cookies = mergeSetCookies(sessionCookies, setCookies)
  const result = data.result || {}
  const state = String(result.error || 'unknown')
  if (state !== 'ok') return { state, cookies }
  if (result.pkey) cookies.pkey = String(result.pkey)
  if (result.user_pkey) cookies.user_pkey = String(result.user_pkey)
  const id = String(result.profile?.heybox_id ?? result.account_detail?.userid ?? result.heybox_id ?? '')
  if (id) { cookies.heybox_id = id; cookies.user_heybox_id = id }
  const kept = keepCookies(cookies)
  const cookie = cookieHeader(kept)
  if (!kept.pkey && !kept.user_pkey) return { state, cookies, hasPkey: false, verified: false }
  try {
    // captureCookies：这一步的 Set-Cookie 以前整个被丢掉（没开 capture），
    // 顺手打开 —— 虽然实测它不下发 x_xhh_tokenid，但别的 cookie 不该白丢。
    const check = await client.request({ path: '/account/restore_login', cookie, captureCookies: true })
    const restored = mergeSetCookies(kept, check.setCookies)
    const merged = cookieHeader(keepCookies(restored))
    const r = check.data.result || {}
    const profile = r.profile || r.account_detail || {}
    const heyboxId = String(profile.heybox_id ?? profile.userid ?? r.heybox_id ?? r.account_detail?.userid ?? '').trim()
    return { state, cookies: restored, cookie: merged, hasPkey: true, verified: Boolean(heyboxId), heyboxId, nickname: String(profile.username ?? profile.nickname ?? '') }
  } catch (error) {
    return { state, cookies, cookie, hasPkey: true, verified: false, verifyError: error.message }
  }
}

/**
 * 用拿到的 pkey 打开一次网页，把前端种下的 `x_xhh_tokenid` 取回来。
 *
 * 为什么必须这么绕：扫码登录全程只走 HTTP 接口（get_qrcode_url → qr_state →
 * restore_login），而 `x_xhh_tokenid` **不在任何一步的 Set-Cookie 里** —— 实测它是
 * 小黑盒网页前端自己的 JS 种进浏览器的（README 也写着它「不是 HttpOnly」）。
 * 所以扫码只能拿到 pkey，写操作（点赞/评论/发帖）就会被拒。这里补上取 token 的通道：
 * 把 pkey 灌进浏览器 → 打开首页 → 等前端种 cookie → 读回 x_xhh_tokenid。
 *
 * 失败不抛（扫码本身已经成功，不能用「取不到 token」把它整体判死）：
 * 返回 { ok:false, reason }，调用方保留只有 pkey 的 Cookie 并如实提示。
 */
export async function fetchWebToken({ browser, cookie, waitMs = 12000, log } = {}) {
  if (!browser) return { ok: false, reason: '浏览器不可用' }
  const parsed = parseCookiePairs(cookie)
  if (!parsed.length) return { ok: false, reason: '没有可灌入的 Cookie' }
  try {
    const n = await browser.setCookies(parsed).catch(() => 0)
    if (!n) return { ok: false, reason: 'Cookie 没灌进浏览器' }
    await browser.goto('https://www.xiaoheihe.cn/')
    // 前端种 cookie 是异步的（实测首页加载后 3~6 秒出现），轮询等它
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const list = await browser.cookies().catch(() => [])
      const hit = list.find((c) => c && c.name === 'x_xhh_tokenid' && String(c.value || '').trim())
      if (hit) {
        log?.info?.('扫码登录：已从网页取回 x_xhh_tokenid（长度 ' + String(hit.value).length + '）')
        return { ok: true, token: String(hit.value), all: list }
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    return { ok: false, reason: '网页里没等到 x_xhh_tokenid（' + Math.round(waitMs / 1000) + ' 秒）' }
  } catch (e) {
    return { ok: false, reason: '取 token 出错：' + e.message }
  }
}

/** "a=1; b=2" → [{name,value}]（给 CDP setCookies 用） */
export function parseCookiePairs(text) {
  return String(text || '').split(';').map((kv) => {
    const i = kv.indexOf('=')
    if (i <= 0) return null
    const name = kv.slice(0, i).trim()
    const value = kv.slice(i + 1).trim()
    return name ? { name, value } : null
  }).filter(Boolean)
}
