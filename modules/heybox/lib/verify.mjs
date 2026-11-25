// 扫码不可用时的浏览器兜底。只检查页面和收取 Cookie，验证由主人手动完成。
import { createBrowser } from './browser.mjs'

const HOME = 'https://www.xiaoheihe.cn/'

// 页面上看得见的安全验证 / 滑块。探测出错或结果不是字符串时不能当作通过。
export const VERIFY_PROBE = `(() => {
  if (location.protocol !== 'https:' || !/(^|\\.)xiaoheihe\\.cn$/.test(location.hostname) || document.readyState === 'loading') throw new Error('小黑盒页面尚未加载')
  const big = (n) => {
    const r = n.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    for (let p = n; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) <= 0.1) return false
    }
    return true
  }
  const nodes = [...document.querySelectorAll(
    '[class*="captcha"], [id*="captcha"], [class*="verify"], [id*="verify"], iframe[src*="captcha"], iframe[src*="verify"], .nc-container, .nc_scale'
  )]
  const hit = nodes.find(big)
  if (!hit) return ''
  return (hit.innerText || hit.className || '页面弹了验证').toString().slice(0, 80)
})()`

export function createVerifier({ profileDir, browserPath = () => '', log, browser: injected, useEgo = () => false } = {}) {
  let browser = injected || null
  let session = null
  let disposed = false
  const b = () => browser ||= createBrowser({ profileDir, browserPath, log, useEgo })
  const shot = () => b().screenshot().catch(() => '')
  async function verifyNow() {
    const why = await b().evaluate(VERIFY_PROBE)
    if (typeof why !== 'string') throw new Error('页面验证状态不明确')
    return why
  }
  async function open() {
    if (disposed) return { ok: false, message: '模块已关闭' }
    const r = await b().open()
    if (!r.ok || disposed) return disposed ? { ok: false, message: '模块已关闭' } : r
    const href = String(await b().evaluate('location.href'))
    if (!/^https:\/\/www\.xiaoheihe\.cn(?:\/|$)/.test(href)) await b().goto(HOME)
    return { ok: true }
  }
  async function begin({ visible = false } = {}) {
    session = null
    try {
      const r = await open()
      if (!r.ok) return r
      await b().show(Boolean(visible))
      const why = await verifyNow()
      const screenshot = await shot()
      if (disposed) return { ok: false, message: '模块已关闭' }
      session = { visible: Boolean(visible), shown: Boolean(visible) }
      return { ok: true, state: why ? 'waiting' : 'clear', why, shot: screenshot, visible: session.visible, message: why ? '请显示窗口并由主人手动完成验证' : '请显示窗口，由主人手动登录并检查验证' }
    } catch (error) { return { ok: false, message: '打开验证窗口失败：' + error.message } }
  }
  async function showWindow(visible = true) {
    if (disposed || !session || !browser?.connected()) return { ok: false, message: '请先开始浏览器验证' }
    try {
      await b().show(Boolean(visible))
      if (disposed || !session) return { ok: false, message: '验证已结束' }
      session.visible = Boolean(visible)
      if (visible) session.shown = true
      return { ok: true, visible: session.visible, message: visible ? '窗口已显示，请由主人手动登录并完成验证' : '窗口已收起' }
    } catch (error) { return { ok: false, message: '调整窗口失败：' + error.message } }
  }
  async function finish() {
    if (disposed || !session || !browser?.connected()) return { ok: false, verified: false, message: '请先开始浏览器验证' }
    if (!session.shown) return { ok: false, verified: false, message: '请先显示窗口，由主人手动登录并完成验证' }
    try {
      const why = await verifyNow()
      if (why) return { ok: false, verified: false, state: 'waiting', why, shot: await shot(), message: '页面上还有验证，请在窗口里完成' }
      const raw = await b().cookies()
      if (!Array.isArray(raw)) throw new Error('浏览器没有返回 Cookie 列表')
      const list = raw.filter((c) => /^(?:\.)?(?:[^.]+\.)*xiaoheihe\.cn$/i.test(String(c.domain || '')) && c.name && c.value)
      const cookie = list.map((c) => `${c.name}=${c.value}`).join('; ')
      if (!/(?:^|;\s*)(?:user_)?pkey=[^;\s]+/.test(cookie)) return { ok: false, verified: false, message: '浏览器里没有登录 Cookie，请先在窗口里登录', shot: await shot() }
      if (disposed) return { ok: false, verified: false, message: '模块已关闭' }
      return { ok: true, cookie, count: list.length, shot: await shot() }
    } catch (error) { return { ok: false, verified: false, message: '检查验证状态失败：' + error.message } }
  }
  function dispose() {
    if (disposed) return
    disposed = true
    session = null
    try { Promise.resolve(browser?.close()).catch((error) => log?.warn?.('关闭小黑盒浏览器失败：' + error.message)) }
    catch (error) { log?.warn?.('关闭小黑盒浏览器失败：' + error.message) }
  }
  return { begin, finish, showWindow, dispose }
}
