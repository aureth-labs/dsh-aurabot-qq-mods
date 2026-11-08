// lib/ax.mjs —— CDP 无障碍树（AX）通道：读「canvas 画出来的文字」+ 它在页面上的坐标。
//
// 为什么需要它（2026-11-10 真机实测抖音直播页）：
//   抖音的粉丝团面板是 **Lynx canvas** 渲染的：
//     · 面板容器 DIV#__living_right_panel_id → data-e2e="sslocal://lynxview?…" → 一个 blob: iframe
//     · 那个 iframe 里只有 32 个节点（html/body/lynx-view/script），**一个文本节点都没有**
//     · document.body.innerText 里也读不到「加入粉丝团」「送灯牌」这些字
//   但是 Chrome 的无障碍树里**有**：实测能读到
//     「粉丝团 / 星守护 / 粉丝团专属权益 / 加入粉丝团 / （1钻石）/ 酷炫勋章 / 点亮成员 2840 …」
//   而且 `DOM.getBoxModel` 给的坐标**就是页面坐标**（实测「加入粉丝团」= [1756,1156,87,27]，
//   和截图里那个红按钮的位置对得上）。
//   所以 AX 是 Lynx 面板唯一能读懂、能定位的通道。
//
// 另外两个实测结论（也写在这儿，免得以后又踩）：
//   · 面板的 AX 树**不在根 frame 的树里**，必须按 frame 逐个取
//     （`Accessibility.getFullAXTree({depth:-1, frameId})`）。只查根 frame 的话一条都读不到。
//   · Lynx 占位元素的 DOM 矩形是 0×0（display:contents），所以**没法**像普通 DOM 那样做
//     elementFromPoint 命中校验。改用「谁盖在上面」来判断：命中点必须落在包着它的那个 iframe 上。

/** AX 节点的名字。 */
export function axName(node) {
  if (!node) return ''
  const v = node.name && node.name.value
  return typeof v === 'string' ? v.trim() : ''
}

/** AX 节点的角色（button / StaticText / tooltip …）。 */
export function axRole(node) {
  const v = node.role && node.role.value
  return typeof v === 'string' ? v : ''
}

/**
 * 从一棵 AX 树里挑出「有名字」的节点。
 * @param {Array} nodes  Accessibility.getFullAXTree 返回的 nodes
 * @param {string} want  只挑名字里含这个关键词的（空 = 全要）
 * @param {number} limit 最多几个
 */
export function pickAxNodes(nodes, want, limit = 60) {
  const list = Array.isArray(nodes) ? nodes : []
  const kw = want == null ? '' : String(want)
  const out = []
  const seen = new Set()
  for (const n of list) {
    if (!n || n.ignored) continue
    const name = axName(n)
    if (!name) continue
    if (kw && name.indexOf(kw) < 0) continue
    const role = axRole(n)
    const key = role + '|' + name
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, role, frameId: n.frameId, backendNodeId: n.backendDOMNodeId })
    if (out.length >= limit) break
  }
  return out
}

/** CDP 的四点框 → { x, y, w, h }（x/y 是左上角）。 */
export function axRectFromQuad(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  let x0 = xs[0], x1 = xs[0], y0 = ys[0], y1 = ys[0]
  for (let i = 1; i < 4; i++) {
    if (xs[i] < x0) x0 = xs[i]
    if (xs[i] > x1) x1 = xs[i]
    if (ys[i] < y0) y0 = ys[i]
    if (ys[i] > y1) y1 = ys[i]
  }
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
}

/** 候选签名：两次读到的签名一样，才算「按钮没动过」。 */
export function axSig(item) {
  if (!item) return ''
  return String(item.role || '') + '|' + String(item.name || '') + '|' +
    [item.x, item.y, item.w, item.h].join(',')
}

/**
 * 页面里跑的命中校验：给一个页面坐标的矩形，看这块位置是不是真的露在最上层。
 *
 * 判据（和 DOM 通道的 9 点采样一个思路）：
 *   · 先找到「包着这个矩形的 iframe」——粉丝团面板 / 主播资料卡都是 iframe 覆盖层；
 *   · 然后在主文档里对这块矩形采 9 个点，每个点 elementFromPoint 必须命中那个 iframe。
 *     如果有别的遮罩盖在上面（弹窗、蒙层），elementFromPoint 会返回遮罩 → 判定不通过 → 不点。
 */
export const AX_HIT_SRC = `(function (r) {
  var vw = innerWidth, vh = innerHeight
  var sx = window.scrollX || 0, sy = window.scrollY || 0
  // AX 给的是**页面坐标**（DOM.getBoxModel 的口径），点击和 elementFromPoint 用的是**视口坐标**。
  // 页面滚过就要减掉滚动量；两种解释都试，先试减过滚动的（只有它和 getBoundingClientRect
  // 在同一个坐标系里，「是不是落在某个 iframe 上」这个判断才有意义），再试不减的。
  var tries = [
    { x: r.x - sx, y: r.y - sy, tag: 'viewport' },
    { x: r.x, y: r.y, tag: 'page' },
  ]
  var frames = []
  var fs = document.querySelectorAll('iframe')
  for (var i = 0; i < fs.length; i++) {
    var b = fs[i].getBoundingClientRect()
    if (!b.width || !b.height) continue
    frames.push({ i: i, el: fs[i], left: b.left, top: b.top, right: b.right, bottom: b.bottom })
  }
  var pick = null
  for (var t = 0; t < tries.length; t++) {
    var c = tries[t]
    if (c.x < -1 || c.y < -1 || c.x + r.w > vw + 1 || c.y + r.h > vh + 1) continue
    for (var f = 0; f < frames.length; f++) {
      var fr = frames[f]
      if (c.x >= fr.left - 2 && c.x + r.w <= fr.right + 2 && c.y >= fr.top - 2 && c.y + r.h <= fr.bottom + 2) {
        pick = { c: c, fr: fr }
        break
      }
    }
    if (pick) break
  }
  if (!pick) {
    return { ok: false, reason: '这块位置不在任何面板/卡片上（面板可能没打开、或者位置变了）', good: 0, points: [] }
  }
  var inset = Math.max(2, Math.min(6, Math.round(Math.min(r.w, r.h) / 6)))
  var xs = [pick.c.x + inset, pick.c.x + r.w / 2, pick.c.x + r.w - inset]
  var ys = [pick.c.y + inset, pick.c.y + r.h / 2, pick.c.y + r.h - inset]
  var points = []
  var good = 0
  for (var yi = 0; yi < ys.length; yi++) {
    for (var xi = 0; xi < xs.length; xi++) {
      var px = Math.round(xs[xi]), py = Math.round(ys[yi])
      var node = null
      try { node = document.elementFromPoint(px, py) } catch (e) { node = null }
      var ok = false, hit = '（空）'
      if (node) {
        hit = node.tagName
        if (node.className && typeof node.className === 'string') hit += '.' + node.className.split(' ').slice(0, 2).join('.')
        ok = (node === pick.fr.el || pick.fr.el.contains(node) || node.contains(pick.fr.el))
      }
      if (ok) good++
      points.push({ x: px, y: py, ok: ok, hit: hit })
    }
  }
  return { ok: good >= 5, good: good, points: points, coord: pick.c.tag, owner: pick.fr.i }
})`

/**
 * AX 读取器：把 CDP 的无障碍树包装成「读文字 / 按名字定位 / 命中校验」三件事。
 * 依赖从外面注入（send / evalJs / note），所以离线测试能拿假的 CDP 跑。
 */
export function createAxReader({ send, evalJs, note }) {
  const log = (t, l) => { try { note(t, l) } catch {} }
  let enabled = false
  let cache = { at: 0, items: [] }

  async function enable() {
    if (enabled) return
    try { await send('Accessibility.enable'); enabled = true } catch (e) { log('开无障碍树失败：' + String((e && e.message) || e), 'debug') }
  }

  /** 页面里所有 frame（面板是 blob: iframe，必须按 frame 逐个查）。 */
  async function frames() {
    let tree = null
    try { tree = await send('Page.getFrameTree') } catch (e) { return [] }
    const out = []
    const walk = (n, depth) => {
      if (!n || !n.frame || depth > 5) return
      out.push({ id: n.frame.id, url: String(n.frame.url || '') })
      if (n.childFrames) for (const c of n.childFrames) walk(c, depth + 1)
    }
    if (tree && tree.frameTree) walk(tree.frameTree, 0)
    return out
  }

  /**
   * 所有 frame 里「有名字」的 AX 节点（不带坐标 —— 取坐标要一个一个 getBoxModel，很贵）。
   * 500ms 内共享一次扫描。
   */
  async function names({ maxFrames = 16, limit = 1500, ttl = 500 } = {}) {
    if (Date.now() - cache.at < ttl && cache.items.length) return cache.items
    await enable()
    const fs = await frames()
    const out = []
    for (const f of fs.slice(0, maxFrames)) {
      let ax = null
      try { ax = await send('Accessibility.getFullAXTree', { depth: -1, frameId: f.id }) } catch (e) { continue }
      const nodes = (ax && ax.nodes) || []
      for (const n of nodes) {
        if (n.ignored) continue
        const name = axName(n)
        if (!name) continue
        out.push({ name, role: axRole(n), frameId: f.id, backendNodeId: n.backendDOMNodeId })
        if (out.length >= limit) break
      }
      if (out.length >= limit) break
    }
    cache = { at: Date.now(), items: out }
    return out
  }

  /** 全部 AX 文字拼成一段（面板里的字只能这么读）。 */
  async function text(opts) {
    const list = await names(opts)
    return list.map((n) => n.name).join('\n')
  }

  /** 按名字找，并取页面坐标。 */
  async function find(match, { limit = 24, ttl = 0 } = {}) {
    const list = await names({ limit: 2000, ttl })
    const re = match instanceof RegExp ? match : new RegExp(String(match || ''))
    const hits = list.filter((n) => re.test(n.name)).slice(0, limit)
    const out = []
    for (const h of hits) {
      if (!h.backendNodeId) continue
      let rect = null
      try {
        const b = await send('DOM.getBoxModel', { backendNodeId: h.backendNodeId })
        rect = axRectFromQuad(b.model && b.model.border)
      } catch (e) { continue }
      if (!rect || !rect.w || !rect.h) continue
      out.push({ ...h, ...rect })
    }
    return out
  }

  /** 命中校验：这块位置是不是真的露在最上层。 */
  async function hit(cand) {
    if (!cand) return { ok: false, reason: '没有目标', good: 0, points: [] }
    try {
      const r = await evalJs('(' + AX_HIT_SRC + ')(' + JSON.stringify({ x: cand.x, y: cand.y, w: cand.w, h: cand.h }) + ')')
      return r || { ok: false, reason: '命中校验没返回', good: 0, points: [] }
    } catch (e) {
      return { ok: false, reason: '命中校验出错：' + String((e && e.message) || e), good: 0, points: [] }
    }
  }

  return { names, text, find, hit, frames }
}
