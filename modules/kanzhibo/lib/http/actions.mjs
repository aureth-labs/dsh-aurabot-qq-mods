// lib/http/actions.mjs —— 需要动浏览器的面板动作：/login、/window。
// 具体动作由入口注入（内部已经过 withBusy）。
export function registerActionRoutes(api, { login, window }) {
  api.route('/login', async () => {
    try { return await login() } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
  })
  api.route('/window', async (req) => {
    const q = api.core.http.query(req) || {}
    const show = String(q.show == null ? '1' : q.show) !== '0'
    try { return await window(show) } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
  })
}
