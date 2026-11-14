// lib/click.mjs —— 所有「找 + 验 + 点」都收在这里，模块里只调 clickOnce / clickExpr。
// 依赖从外面注入（evalJs / send / sleep / note），所以能拿假的 CDP 做离线测试。

import { FIND_SRC, HIT_SRC, MARK_SRC, UNMARK_SRC, SCROLL_SRC, normalizeSpec, choosePoint, pickUnique, describeHit, sameSig, collapseNested } from './find.mjs'

const call = (evalJs, src, arg) => evalJs('(' + src + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')')

export function createClicker({ evalJs, send, sleep, note }) {
  const log = (t, l) => { try { note(t, l) } catch {} }

  async function find(spec) {
    const s = normalizeSpec(spec)
    try {
      const r = await call(evalJs, FIND_SRC, s)
      return r || { total: 0, list: [] }
    } catch (e) {
      return { total: 0, list: [], error: String((e && e.message) || e) }
    }
  }

  /** 等「同一个结果连续两帧不变」：元素在动画/懒加载里挪位时别急着点。 */
  async function stableFind(spec, { tries = 8, gap = 250 } = {}) {
    let prev = ''
    let last = null
    for (let i = 0; i < tries; i++) {
      last = await find(spec)
      const first = (last.list || [])[0]
      const key = first ? [first.sig, first.rect.left, first.rect.top, first.rect.width, first.rect.height, last.total].join('|') : 'none'
      if (first && key === prev) return last
      prev = key
      await sleep(gap)
    }
    return last || { total: 0, list: [] }
  }

  async function hit(pick) {
    try {
      const r = await call(evalJs, HIT_SRC, pick)
      return r || { ok: false, reason: '命中校验没返回', points: [] }
    } catch (e) {
      return { ok: false, reason: '命中校验出错：' + String((e && e.message) || e), points: [] }
    }
  }

  async function mark(pick) { try { return await call(evalJs, MARK_SRC, pick) } catch { return null } }
  /**
   * 2026-11-09 加：直接按候选的 rect 画红框，不依赖 data-ab-pick 序号。
   * 半自动截图（askOwner）改用它：合并扫描之后 0 号标记不一定是要点的那个候选。
   */
  async function markRect(rect) {
    if (!rect) return null
    const r = { left: Math.round(rect.left) || 0, top: Math.round(rect.top) || 0, width: Math.round(rect.width) || 0, height: Math.round(rect.height) || 0 }
    try {
      return await evalJs(`(() => {
        var old = document.getElementById('ab-mark')
        if (old) old.parentNode.removeChild(old)
        var d = document.createElement('div')
        d.id = 'ab-mark'
        var sx = window.scrollX || 0, sy = window.scrollY || 0
        d.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;border:3px solid #ff2d55;border-radius:6px;background:rgba(255,45,85,.16);left:' +
          (${r.left} + sx - 4) + 'px;top:' + (${r.top} + sy - 4) + 'px;width:' + (${r.width} + 8) + 'px;height:' + (${r.height} + 8) + 'px'
        document.body.appendChild(d)
        return { left: ${r.left}, top: ${r.top}, width: ${r.width}, height: ${r.height} }
      })()`)
    } catch { return null }
  }
  async function unmark() { try { return await call(evalJs, UNMARK_SRC, null) } catch { return null } }
  async function scroll() { try { return (await call(evalJs, SCROLL_SRC, null)) || { x: 0, y: 0 } } catch { return { x: 0, y: 0 } } }

  async function clickAt(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => {})
    await sleep(60)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => {})
    await sleep(40)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
    await sleep(90)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
  }

  /**
   * 一步到底：找 → 唯一性 → 命中校验 → 真点。
   * 任何一关不过就返回 ok:false（宁可不点）。
   */
  async function clickOnce({ label, spec, settleMs = 900, allowMultiple = false, tries = 8 } = {}) {
    const found = await stableFind(spec, { tries })
    if (found.error) return { ok: false, reason: '找「' + label + '」出错：' + found.error }
    if (!found.list || !found.list.length) return { ok: false, reason: '没找到「' + label + '」' }
    const list = collapseNested(found.list)
    let cand = list[0]
    if (!allowMultiple) {
      const u = pickUnique(list)
      if (!u.ok) return { ok: false, reason: '「' + label + '」' + u.reason, list }
      cand = u.cand
    }
    const h = await hit(0)
    if (!h.ok) return { ok: false, reason: '「' + label + '」' + describeHit(h), hit: h, cand }
    const pt = choosePoint(h.points)
    if (!pt) return { ok: false, reason: '「' + label + '」找不到可点位置', hit: h, cand }
    await clickAt(pt.x, pt.y)
    log('点了' + label + '：' + cand.text + ' @' + pt.x + ',' + pt.y, 'debug')
    if (settleMs) await sleep(settleMs)
    return { ok: true, point: pt, cand, hit: h, found }
  }

  /**
   * 半自动的第一段：只找 + 验 + 留着，不点。
   * 确认时用同一个 spec 再找一遍，签名对不上就作废（页面可能已经变了）。
   */
  async function prepare({ label, spec, allowMultiple = false, tries = 8 } = {}) {
    const found = await stableFind(spec, { tries })
    if (found.error) return { ok: false, reason: '找「' + label + '」出错：' + found.error }
    if (!found.list || !found.list.length) return { ok: false, reason: '没找到「' + label + '」' }
    const list = collapseNested(found.list)
    let cand = list[0]
    if (!allowMultiple) {
      const u = pickUnique(list)
      if (!u.ok) return { ok: false, reason: '「' + label + '」' + u.reason, list }
      cand = u.cand
    }
    const h = await hit(0)
    if (!h.ok) return { ok: false, reason: '「' + label + '」' + describeHit(h), hit: h, cand }
    const pt = choosePoint(h.points)
    if (!pt) return { ok: false, reason: '「' + label + '」找不到可点位置', hit: h, cand }
    return { ok: true, label, spec: normalizeSpec(spec), allowMultiple, cand, hit: h, point: pt, desc: describeHit(h) }
  }

  /** 半自动的第二段：重新找一遍，签名必须和准备时一致，再验一次命中，然后点。 */
  async function commit(prepared, { settleMs = 900 } = {}) {
    if (!prepared || !prepared.ok) return { ok: false, reason: '没有可执行的动作' }
    const found = await stableFind(prepared.spec, { tries: 5 })
    if (!found.list || !found.list.length) return { ok: false, reason: '等你确认这会，目标不见了' }
    const list = collapseNested(found.list)
    let cand = list[0]
    if (!prepared.allowMultiple) {
      const u = pickUnique(list)
      if (!u.ok) return { ok: false, reason: u.reason }
      cand = u.cand
    }
    if (!sameSig(cand.sig, prepared.cand.sig)) {
      return { ok: false, reason: '等你确认这会，目标换了（' + prepared.cand.text + ' → ' + cand.text + '），这次不点' }
    }
    const h = await hit(0)
    if (!h.ok) return { ok: false, reason: describeHit(h), hit: h }
    const pt = choosePoint(h.points)
    if (!pt) return { ok: false, reason: '找不到可点位置' }
    await clickAt(pt.x, pt.y)
    log('确认后点了' + prepared.label + '：' + cand.text + ' @' + pt.x + ',' + pt.y, 'info')
    if (settleMs) await sleep(settleMs)
    return { ok: true, point: pt, cand, hit: h }
  }

  /**
   * 老接口：直接给一段「返回元素」的表达式（评论框、发送按钮这些）。
   * 保留原来的选择器，但补上标记 → 命中校验 → 真坐标点。
   */
  async function clickExpr(expr, label, { settleMs = 0 } = {}) {
    const info = await evalJs(`(() => {
      let el = null
      try { el = (${expr}) } catch (e) { return { err: String((e && e.message) || e) } }
      if (!el) return null
      const old = document.querySelectorAll('[data-ab-pick]')
      for (const x of old) x.removeAttribute('data-ab-pick')
      el.setAttribute('data-ab-pick', '0')
      const r = el.getBoundingClientRect()
      if (!r || r.width < 2 || r.height < 2) return null
      return {
        rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        text: ((el.innerText || '') + ' | ' + (el.getAttribute('aria-label') || '')).trim().slice(0, 50),
      }
    })()`).catch(() => null)
    if (!info) { log('没找到：' + label, 'debug'); return null }
    if (info.err) { log('找 ' + label + ' 出错：' + info.err, 'warn'); return null }
    const h = await hit(0)
    if (!h.ok) { log('不点' + label + '：' + describeHit(h), 'warn'); return { blocked: true, hit: h, text: info.text } }
    const pt = choosePoint(h.points)
    if (!pt) { log('不点' + label + '：没有可用采样点', 'warn'); return { blocked: true, hit: h, text: info.text } }
    await clickAt(pt.x, pt.y)
    log('点了' + label + '：' + info.text, 'debug')
    if (settleMs) await sleep(settleMs)
    return { point: pt, text: info.text, hit: h }
  }

  return { find, stableFind, hit, mark, markRect, unmark, scroll, clickAt, clickOnce, prepare, commit, clickExpr }
}
