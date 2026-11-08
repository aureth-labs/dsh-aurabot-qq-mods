// lib/find.mjs —— 页面里跑的「找元素 / 命中校验 / 高亮」脚本，加上几个纯函数。
// 2026-11-06：抖音现在会把粉丝团面板塞进「同源 iframe + 影子树」，所以查找要同时穿 iframe 和 shadow root，
// 坐标统一换成「主页面坐标」；点击仍然用主坐标（浏览器会把事件路由进 iframe/影子树）。

/** 可搜索的根：主文档 + 同源 iframe + 影子树（都带主轴偏移）。 */
const ROOTS_SRC = `
  // 2026-11-09 加：这些标签绝不可能是要点的目标，也养不出影子树 ——
  //   直播页上千节点里它们占三四成，跳过能省一大截扫描时间。
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1, TEMPLATE: 1, SVG: 1, PATH: 1, USE: 1, G: 1, DEFS: 1, STOP: 1, CIRCLE: 1, RECT: 1, LINEARGRADIENT: 1 }
  var roots = []
  var addRoot = function (root, ox, oy, depth) {
    if (!root) return
    var doc = root.ownerDocument || root
    roots.push({ root: root, doc: doc, ox: ox, oy: oy })
    if (depth <= 0) return
    var els
    try { els = root.querySelectorAll('*') } catch (e) { return }
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (SKIP[el.tagName]) continue
      if (el.shadowRoot) addRoot(el.shadowRoot, ox, oy, depth - 1)
    }
    var frames
    try { frames = root.querySelectorAll('iframe') } catch (e) { return }
    for (var f = 0; f < frames.length; f++) {
      var cd = null
      try { cd = frames[f].contentDocument } catch (e) { cd = null }
      if (!cd) continue
      var fr
      try { fr = frames[f].getBoundingClientRect() } catch (e) { continue }
      if (fr.width < 40 || fr.height < 40) continue
      addRoot(cd, ox + fr.left, oy + fr.top, depth - 1)
    }
  }
  addRoot(document, 0, 0, 3)
`;

export const FIND_SRC = `(function (spec) {
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim() }
  var hit
  try { hit = new RegExp(spec.text, spec.flags || 'u') } catch (e) { return { error: '正则写错：' + String(e), total: 0, list: [] } }
  ${ROOTS_SRC}
  var vw = innerWidth, vh = innerHeight
  var R = spec.region || { top: 0, left: 0, right: 1, bottom: 1 }
  var x1 = R.left * vw, y1 = R.top * vh, x2 = R.right * vw, y2 = R.bottom * vh
  var maxTextLen = spec.maxTextLen || 24
  var maxW = spec.maxWidth || vw * 0.5
  var maxH = spec.maxHeight || vh * 0.3
  var minW = spec.minWidth || 10, minH = spec.minHeight || 10
  var up = spec.up == null ? 4 : spec.up

  var styleOf = function (el) {
    try { return (el.ownerDocument.defaultView || window).getComputedStyle(el) } catch (e) { return null }
  }
  var visible = function (el) {
    if (!el.getClientRects || !el.getClientRects().length) return false
    var cs = styleOf(el)
    if (!cs) return false
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false
    var r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  }
  var clicks = function (el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return true
    var role = el.getAttribute('role')
    if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab') return true
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true
    if (el.onclick) return true
    var cs = styleOf(el)
    if (cs && cs.cursor === 'pointer') return true
    return false
  }
  var plainText = function (el) { return norm(el.textContent || '') }
  var ancHit = null
  try { if (spec.ancestorText) ancHit = new RegExp(spec.ancestorText, spec.flags || 'u') } catch (e) { ancHit = null }
  // parentElement 在影子树顶端会断掉，要跳到宿主继续往上找
  var parentOf = function (el) {
    var p = el.parentElement
    if (p) return p
    try {
      var root = el.getRootNode && el.getRootNode()
      if (root && root.host) return root.host
    } catch (e) {}
    return null
  }
  // 祖先里得有一段「像那块面板」的文字：挡住「同一个词出现在别处」的误选（比如观众列表里的点亮）
  var ancestorMatches = function (el) {
    if (!ancHit) return true
    var cur = parentOf(el)
    for (var i = 0; i < 6 && cur; i++) {
      var txt = plainText(cur)
      if (txt.length > 0 && txt.length <= 600 && ancHit.test(txt)) return true
      cur = parentOf(cur)
    }
    return false
  }
  var ancestorClickable = function (el) {
    var cur = el
    for (var i = 0; i <= up && cur; i++) {
      if (clicks(cur) && visible(cur)) return cur
      cur = parentOf(cur)
    }
    return null
  }
  var sigOf = function (el) {
    var cls = ''
    try { cls = Array.prototype.slice.call(el.classList, 0, 3).join('.') } catch (e) {}
    var anc = ''
    var p = parentOf(el)
    for (var i = 0; i < 3 && p; i++) {
      anc += '>' + p.tagName.toLowerCase() + (p.getAttribute('data-e2e') ? '[' + p.getAttribute('data-e2e') + ']' : '')
      p = parentOf(p)
    }
    return (el.tagName.toLowerCase() + (cls ? '.' + cls : '') + anc + '|' + plainText(el).slice(0, 24)).slice(0, 160)
  }

  var marks = document.querySelectorAll('[data-ab-pick]')
  for (var k = 0; k < marks.length; k++) marks[k].removeAttribute('data-ab-pick')

  var pairs = []
  for (var ri = 0; ri < roots.length; ri++) {
    var root = roots[ri]
    var all
    try { all = root.root.querySelectorAll('*') } catch (e) { continue }
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (SKIP[el.tagName]) continue
      var t = plainText(el)
      if (!t || t.length > maxTextLen) continue
      if (!hit.test(t)) continue
      if (!visible(el)) continue
      var target = spec.raw ? el : (ancestorClickable(el) || el)
      if (!target) continue
      if (!ancestorMatches(target)) continue
      var dup = false
      for (var j = 0; j < pairs.length; j++) if (pairs[j].target === target) { dup = true; break }
      if (dup) continue
      var r = target.getBoundingClientRect()
      var rect = { left: r.left + root.ox, top: r.top + root.oy, width: r.width, height: r.height, right: r.right + root.ox, bottom: r.bottom + root.oy }
      if (rect.width < minW || rect.height < minH || rect.width > maxW || rect.height > maxH) continue
      if (rect.left < x1 - 2 || rect.top < y1 - 2 || rect.right > x2 + 2 || rect.bottom > y2 + 2) continue
      pairs.push({ target: target, text: plainText(el).slice(0, 30), rect: rect, sig: sigOf(target), clickable: clicks(target), depth: root.ox !== 0 || root.oy !== 0 ? 'frame' : 'doc' })
    }
  }
  pairs.sort(function (a, b) { return a.rect.width * a.rect.height - b.rect.width * b.rect.height })
  pairs = pairs.slice(0, 20)
  var list = []
  for (var n = 0; n < pairs.length; n++) {
    var p = pairs[n]
    try { p.target.setAttribute('data-ab-pick', String(n)) } catch (e) {}
    list.push({
      text: p.text,
      sig: p.sig,
      tag: p.target.tagName.toLowerCase(),
      clickable: p.clickable,
      where: p.depth,
      area: Math.round(p.rect.width * p.rect.height),
      rect: {
        left: Math.round(p.rect.left), top: Math.round(p.rect.top),
        right: Math.round(p.rect.right), bottom: Math.round(p.rect.bottom),
        width: Math.round(p.rect.width), height: Math.round(p.rect.height),
      },
    })
  }
  return { vw: vw, vh: vh, dpr: devicePixelRatio, roots: roots.length, total: list.length, list: list }
})`;

/** 命中校验：在元素所在的根里做 9 点采样（影子树里 elementFromPoint 返回宿主，用 shadowRoot.contains 判）。 */
export const HIT_SRC = `(function (pick) {
  ${ROOTS_SRC}
  var pickEl = null
  var pickRoot = null
  for (var i = 0; i < roots.length && !pickEl; i++) {
    var found = null
    try { found = roots[i].root.querySelector('[data-ab-pick="' + Number(pick) + '"]') } catch (e) { found = null }
    if (found) { pickEl = found; pickRoot = roots[i] }
  }
  if (!pickEl) return { ok: false, reason: '目标不见了（页面刷新或被关掉）', points: [] }
  var r = pickEl.getBoundingClientRect()
  if (!r || r.width < 4 || r.height < 4) return { ok: false, reason: '目标尺寸异常', points: [] }
  var doc = pickEl.ownerDocument
  var inside = function (node) {
    if (!node) return false
    if (node === pickEl || pickEl.contains(node)) return true
    try { if (node.shadowRoot && node.shadowRoot.contains(pickEl)) return true } catch (e) {}
    return false
  }
  var inset = Math.max(3, Math.min(6, Math.round(r.width / 6)))
  var xs = [r.left + inset, r.left + r.width / 2, r.right - inset]
  var ys = [r.top + inset, r.top + r.height / 2, r.bottom - inset]
  var points = []
  for (var yi = 0; yi < ys.length; yi++) {
    for (var xi = 0; xi < xs.length; xi++) {
      var lx = Math.round(xs[xi]), ly = Math.round(ys[yi])
      var node = null
      try { node = doc.elementFromPoint(lx, ly) } catch (e) { node = null }
      points.push({
        x: Math.round(lx + pickRoot.ox), y: Math.round(ly + pickRoot.oy),
        ok: inside(node),
        hit: node ? (((node.textContent || '').trim().slice(0, 18)) || node.tagName) : '（空）',
      })
    }
  }
  var good = 0
  for (var g = 0; g < points.length; g++) if (points[g].ok) good++
  return {
    ok: good >= 5,
    good: good,
    rect: { left: Math.round(r.left + pickRoot.ox), top: Math.round(r.top + pickRoot.oy), width: Math.round(r.width), height: Math.round(r.height) },
    points: points,
  }
})`;

/** 在页面上把候选框出来（截图给人看的时候用），不做任何点击。 */
export const MARK_SRC = `(function (pick) {
  ${ROOTS_SRC}
  for (var i = 0; i < roots.length; i++) {
    var el = null
    try { el = roots[i].root.querySelector('[data-ab-pick="' + Number(pick) + '"]') } catch (e) { el = null }
    if (!el) continue
    var r = el.getBoundingClientRect()
    var old = document.getElementById('ab-mark')
    if (old) old.parentNode.removeChild(old)
    var d = document.createElement('div')
    d.id = 'ab-mark'
    // 用 absolute（页面坐标）而不是 fixed：截图裁剪是按页面坐标来的，fixed 元素会漂/被漏掉。
    var sx = window.scrollX || 0, sy = window.scrollY || 0
    d.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;border:3px solid #ff2d55;border-radius:6px;background:rgba(255,45,85,.16);left:' +
      Math.round(r.left + roots[i].ox + sx - 4) + 'px;top:' + Math.round(r.top + roots[i].oy + sy - 4) + 'px;width:' + Math.round(r.width + 8) + 'px;height:' + Math.round(r.height + 8) + 'px'
    document.body.appendChild(d)
    return { left: Math.round(r.left + roots[i].ox), top: Math.round(r.top + roots[i].oy), width: Math.round(r.width), height: Math.round(r.height) }
  }
  return null
})`;

export const UNMARK_SRC = `(function () {
  var d = document.getElementById('ab-mark')
  if (d) d.parentNode.removeChild(d)
  var marks = document.querySelectorAll('[data-ab-pick]')
  for (var i = 0; i < marks.length; i++) marks[i].removeAttribute('data-ab-pick')
  return true
})`;

/**
 * 整页文字：主文档 + 同源 iframe + 影子树。
 * 「充值提示」「今日任务」「抖币余额」这些可能不在主文档里（抖音把面板放进 iframe），
 * 只看 document.body.innerText 会漏。
 */
export const PAGE_TEXT_SRC = "(function (max) {\n  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1, TEMPLATE: 1, SVG: 1, PATH: 1, USE: 1, G: 1, DEFS: 1, STOP: 1, CIRCLE: 1, RECT: 1, LINEARGRADIENT: 1 }\n  var roots = []\n  var addRoot = function (root, ox, oy, depth) {\n    if (!root) return\n    var doc = root.ownerDocument || root\n    roots.push({ root: root, doc: doc, ox: ox, oy: oy })\n    if (depth <= 0) return\n    var els\n    try { els = root.querySelectorAll('*') } catch (e) { return }\n    for (var i = 0; i < els.length; i++) {\n      var el = els[i]\n      if (SKIP[el.tagName]) continue\n      if (el.shadowRoot) addRoot(el.shadowRoot, ox, oy, depth - 1)\n    }\n    var frames\n    try { frames = root.querySelectorAll('iframe') } catch (e) { return }\n    for (var f = 0; f < frames.length; f++) {\n      var cd = null\n      try { cd = frames[f].contentDocument } catch (e) { cd = null }\n      if (!cd) continue\n      var fr\n      try { fr = frames[f].getBoundingClientRect() } catch (e) { continue }\n      if (fr.width < 40 || fr.height < 40) continue\n      addRoot(cd, ox + fr.left, oy + fr.top, depth - 1)\n    }\n  }\n  addRoot(document, 0, 0, 3)\n  // 2026-11-09 修：原来每段都 slice(0,max)，前面的站点 footer（几百字）会把配额吃光，\n  //   真正的直播内容（今日任务 / 灯牌 / +100）在后面就进不来了。\n  //   现在：先收每段全文，最后按「整段拼接后从末尾往前取 max」——直播内容在文档后半部分。\n  var parts = []\n  for (var i = 0; i < roots.length; i++) {\n    try {\n      var node = roots[i].root\n      var t = ''\n      if (node.body) t = node.body.innerText || node.body.textContent || ''\n      else t = node.textContent || ''\n      t = String(t).replace(/[ \\\\t]+/g, ' ').trim()\n      if (t && t.length > 2) parts.push(t)\n    } catch (e) {}\n  }\n  var all = parts.join('\\n')\n  var lim = max || 20000\n  // 取末尾：直播间关键信息（任务/余额/礼物）都在正文靠后，footer 在最前\n  var text = all.length > lim ? all.slice(all.length - lim) : all\n  return { roots: roots.length, text: text, full: all.length }\n})"

/** 页面滚了多少（截图裁剪要用页面坐标，不是视口坐标）。 */
export const SCROLL_SRC = `(function () { return { x: Math.round(scrollX || 0), y: Math.round(scrollY || 0) } })`;

/** 把外面的 spec 补成页面里能用的形状（region 用 0~1 的比例，别写死像素）。 */
export function normalizeSpec(spec) {
  const s = spec || {}
  const region = s.region || { top: 0, left: 0, right: 1, bottom: 1 }
  return {
    text: String(s.text || ''),
    flags: s.flags || 'u',
    region: {
      top: Number(region.top) || 0,
      left: Number(region.left) || 0,
      right: region.right == null ? 1 : Number(region.right),
      bottom: region.bottom == null ? 1 : Number(region.bottom),
    },
    maxTextLen: s.maxTextLen || 24,
    ancestorText: s.ancestorText ? String(s.ancestorText) : '',
    maxWidth: s.maxWidth || 0,
    maxHeight: s.maxHeight || 0,
    minWidth: s.minWidth || 10,
    minHeight: s.minHeight || 10,
    up: s.up == null ? 4 : Number(s.up),
    raw: Boolean(s.raw),
    unique: s.unique !== false,
  }
}

/**
 * 从 9 个采样点里挑一个可点的点：中心优先，其次离中心最近的好点。
 * 好点不足 5 个（或没有）就返回 null —— 交给上层「不点」。
 */
export function choosePoint(points) {
  const list = Array.isArray(points) ? points : []
  const good = list.filter((p) => p && p.ok)
  if (good.length < 5) return null
  const center = list[4]
  if (center && center.ok) return { x: center.x, y: center.y }
  const cx = center ? center.x : good[0].x
  const cy = center ? center.y : good[0].y
  let best = null
  let bestD = Infinity
  for (const p of good) {
    const d = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)
    if (d < bestD) { bestD = d; best = p }
  }
  return best ? { x: best.x, y: best.y } : null
}

/** 同一个文字、矩形几乎重合的候选（内层 span 和外层按钮）算一个：留最里面那个。 */
export function collapseNested(list) {
  const arr = [...(Array.isArray(list) ? list : [])].sort((a, b) => (a.area || 0) - (b.area || 0))
  const out = []
  const overlap = (a, b) => {
    const r = a.rect || {}
    const q = b.rect || {}
    const wr = r.right == null ? r.left + r.width : r.right
    const hr = r.bottom == null ? r.top + r.height : r.bottom
    const wq = q.right == null ? q.left + q.width : q.right
    const hq = q.bottom == null ? q.top + q.height : q.bottom
    const iw = Math.max(0, Math.min(wr, wq) - Math.max(r.left, q.left))
    const ih = Math.max(0, Math.min(hr, hq) - Math.max(r.top, q.top))
    const small = Math.min(Math.max(1, (r.width || 0) * (r.height || 0)), Math.max(1, (q.width || 0) * (q.height || 0)))
    return (iw * ih) / small
  }
  for (const c of arr) {
    const dup = out.some((k) => String(k.text || '') === String(c.text || '') && overlap(k, c) >= 0.8)
    if (!dup) out.push(c)
  }
  return out
}

/** 候选唯一性：只允许一个候选；多个就是「分不清」，宁可不动。 */
export function pickUnique(list) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length === 0) return { ok: false, reason: '没有候选' }
  if (arr.length > 1) {
    const names = arr.slice(0, 3).map((x) => String(x.text || '').slice(0, 12)).join(' / ')
    return { ok: false, reason: '同时找到 ' + arr.length + ' 个可能的按钮（' + names + '），分不清该点哪个，这次不点', list: arr }
  }
  return { ok: true, cand: arr[0] }
}

/** 元素签名比对：确认这一下点的还是刚才准备的那个东西。 */
export function sameSig(a, b) {
  return String(a || '') === String(b || '') && String(a || '') !== ''
}

/**
 * 从整页文字里读「今日任务 X/3」的进度。
 * 抖音的写法有 "今日任务0/3"、"今日任务 1/3"、"今日任务1/3" 几种，中间可能夹空格；
 * 认不出就返回 null（交给上层当「读不到」，不要瞎猜成 0）。
 */
export function taskProgressFromText(text) {
  const t = String(text || '')
  const m = /今日任务\s*([0-3])\s*\/\s*3/.exec(t)
  if (m) return Number(m[1])
  return null
}

/**
 * 页面文字里有没有出现粉丝团面板的特征。
 * 抖音这里有两种面板，都要认：
 *   A. 正常续灯牌：「送1个基础灯牌 / 今日第32位送灯牌，连续2天 / +100」，按钮「送灯牌」
 *   B. 勋章熄了要恢复：「点亮粉丝团恢复勋章 / 今日已暂存50亲密度，点亮后可继续做任务升级」，按钮「点亮 (1钻)」
 * 2026-11-08：主人要求 B 这种情况也要能点「点亮」。
 */
export function badgeHintsFromText(text) {
  const t = String(text || '')
  return {
    hasOneCoin: /1\s*钻/.test(t),
    hasIntimacy: /(可得\s*)?100\s*亲密度/.test(t),
    // B 类：恢复勋章面板
    hasRestoreMedal: /点亮粉丝团恢复勋章|恢复勋章|勋章已熄灭/.test(t),
    hasStash: /已暂存\s*\d+\s*亲密度/.test(t),
  }
}

/**
 * 面板里有没有出现「+100」（送灯牌后亲密度的增量）。
 * 2026-11-08 主人给的判据：**只有面板里出现 +100 才算送出成功**。
 * 半角 +100、全角 ＋100、中间带空格都能认；页面里可能同时出现多个，返回个数。
 */
export function plus100FromText(text) {
  const t = String(text || '')
  const m = t.match(/[+＋]\s*100(?![0-9])/g)
  return { hit: Boolean(m && m.length), count: m ? m.length : 0 }
}

/**
 * 聊天区里有没有「<自己昵称>：送出了 粉丝团灯牌 × N」这种系统提示。
 * 2026-11-09 真机踩到的坑：粉丝团面板是 Lynx 渲染的 iframe，body.textContent 长度是 0，
 * 面板里的「送1个基础灯牌 / +100」读不到；但**聊天区（主文档）一定会播报**这条，
 * 所以它是比面板文字更可靠的成功证据。
 * @param {string} text 整页文字
 * @param {string} nick 自己的昵称（可以为空：那时只要求形如「某昵称：送出了 粉丝团灯牌」）
 */
export function badgeSentInChat(text, nick) {
  const t = String(text || '')
  const name = String(nick || '').trim()
  const pat = name
    ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[：:]\\s*送出了\\s*粉丝团灯牌')
    : /[^\s：:]{1,24}\s*[：:]\s*送出了\s*粉丝团灯牌/
  const m = pat.exec(t)
  return { hit: Boolean(m), snippet: m ? m[0].slice(0, 40) : '' }
}

/**
 * 直接读「聊天列表」这个容器，而不是整页 innerText 快照。
 * 为什么要单独读：
 *   · 整页 innerText 是一瞬间的可见文字，消息一滚走就没了；聊天容器里的子节点是结构化的，
 *     可以直接按「新出现的行」比较。
 *   · 不依赖滚动位置，也不受「被页面大小挡住」影响 —— 容器在 DOM 里就能读。
 * 返回最近 max 条消息原文（按 DOM 顺序，末尾最新）。
 */
export const CHAT_LINES_SRC = "(function (max) {\n  var norm = function (x) { return String(x == null ? '' : x).replace(/[\\\\u200b\\\\u200c\\\\u200d\\\\ufeff]/g, '').replace(/[ \\\\t]+/g, ' ').trim() }\n  // 2026-11-09：抖音每条弹幕就是一个 [class*=\"webcast-chatroom___item\"] 元素，\n  //   textContent 恰好是一条完整消息（含昵称和内容）。这是最稳的锚点，不用猜容器。\n  var items = document.querySelectorAll('[class*=\"webcast-chatroom___item\"]')\n  var lines = []\n  var containers = 0\n  var seen = {}\n  for (var i = 0; i < items.length; i++) {\n    var el = items[i]\n    // 只要最内层那个（外层 wrapper 文本一样，会重复）\n    if (el.querySelector('[class*=\"webcast-chatroom___item\"]')) continue\n    var r = el.getBoundingClientRect()\n    if (r.width < 20 || r.height < 8) continue\n    containers++\n    var t = norm(el.textContent || '')\n    if (!t || t.length < 2) continue\n    var key = t.slice(0, 50)\n    if (seen[key]) continue\n    seen[key] = 1\n    lines.push(t.slice(0, 140))\n  }\n  // 兜底：老版式没有 ___item 时，仍按「多数子节点含冒号」找容器\n  if (!lines.length) {\n    var best = null\n    var all = document.querySelectorAll('div,ul,ol')\n    for (var m = 0; m < all.length; m++) {\n      var ch = all[m].children\n      if (!ch || ch.length < 3) continue\n      var hit = 0\n      for (var j = 0; j < Math.min(ch.length, 60); j++) {\n        var tt = ch[j].textContent || ''\n        if (tt.length < 200 && /[：:]/.test(tt)) hit++\n      }\n      if (hit >= 3 && (!best || ch.length > best.n)) best = { el: all[m], n: ch.length }\n    }\n    if (best) {\n      containers = Math.max(containers, 1)\n      for (var k = 0; k < best.n; k++) {\n        var txt = norm(best.el.children[k].textContent || '')\n        if (txt && txt.length >= 2 && txt.length <= 200) lines.push(txt.slice(0, 140))\n      }\n    }\n  }\n  if (lines.length > (max || 80)) lines = lines.slice(-(max || 80))\n  return { found: lines.length > 0, lines: lines, total: lines.length, containers: containers }\n})"

/** 主播下播了没有：抖音下播后 URL 还是 /live/xxx，只能看页面文字。 */
export function endedFromText(text) {
  const t = String(text || '')
  if (/直播已结束|主播已下播|直播已经结束/.test(t)) return '直播已结束'
  if (/主播离开了|直播暂时中断/.test(t)) return '主播离开了'
  return ''
}

/** 灯牌任务行：「送1个基础灯牌」「今日第32位送灯牌，连续2天」这种。 */
export function badgeTaskRowFromText(text) {
  return /送\s*1\s*个[^\n]{0,8}灯牌/.test(String(text || ''))
}

/** 把命中校验结果写成一句人话，进日志和私聊。 */
export function describeHit(hit) {
  if (!hit) return '没做命中校验'
  if (hit.ok) return '命中校验过了（' + hit.good + '/9 个采样点落在目标上）'
  const covered = (hit.points || []).filter((p) => !p.ok).slice(0, 2).map((p) => p.hit).join('、')
  return '命中校验没过（只有 ' + (hit.good || 0) + '/9 点命中' + (covered ? '，挡在上面的是：' + covered : '') + '）'
}
