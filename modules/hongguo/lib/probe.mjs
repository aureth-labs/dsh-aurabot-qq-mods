// 通用验证码探测：页面里出现「验证 / 滑块 / 拖动」相关的容器就认为有验证。
// 不同站点各有自己的容器类名；这份先按常见关键词匹配，宁可多报（多报只是停一停，不会误发）。
export const VERIFY_PROBE_GENERIC = `(() => {
  const hits = document.querySelectorAll(
    '[id*="captcha" i], [class*="captcha" i], [class*="verify" i], [class*="slider" i], [class*="geetest" i], [class*="yidun" i], [class*="nc_" i], [iframe][src*="captcha" i], [iframe][src*="verify" i]'
  )
  for (const n of hits) {
    const r = n.getBoundingClientRect()
    const shown = n.offsetParent !== null || getComputedStyle(n).position === 'fixed'
    if (shown && r.width > 60 && r.height > 60) return '出现了验证（' + (n.id || n.className || 'captcha').toString().slice(0, 40) + '），要主人在浏览器里处理'
  }
  return ''
})()`
