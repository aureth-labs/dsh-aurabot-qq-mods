/**
 * nodes.mjs —— phone 模块 uiautomator XML 解析与语义化
 * 作用：把 `uiautomator dump` 的 XML 转成「模型看得懂的自然语言节点清单」。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export function parseNodes(xml, { maxNodes = 80 } = {})
 *   → { list:[{ n, text, desc, cls, center:[x,y], editable, scrollable }], brief, error? }
 *   失败 → { list:[], brief:'', error:'DUMP_EMPTY' }
 *   export function nodeCenter(list, n) // → [x,y] 或 null
 * 规则：只保留 clickable | editable | scrollable 的节点；位置按 bounds 九宫格描述；
 *      屏幕尺寸按现有最大 bounds 推算（推不出用 1080x2340 兜底）。
 */

/** 反转 XML 实体（含数字实体，如换行 &#10;）。 */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // 数字实体放最后：先还原 &#38; 之类的字符实体，再做 &amp;，避免把刚还原的 & 二次解码
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

/** 从一个节点标签里取属性值（不存在返回 ''）。 */
function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : ''
}

/** bounds="[x1,y1][x2,y2]" → {x1,y1,x2,y2}；格式坏返回 null。 */
function parseBounds(s) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s || '')
  if (!m) return null
  const [x1, y1, x2, y2] = m.slice(1).map(Number)
  if (!(x2 > x1 && y2 > y1)) return null // 越界/倒置 bounds 丢弃
  return { x1, y1, x2, y2 }
}

/**
 * 按 bounds 中心点相对屏幕给九宫格位置描述（如「左上」「底部中央」）。
 * @param {{x1:number,y1:number,x2:number,y2:number}} b
 * @param {number} sw 屏幕宽
 * @param {number} sh 屏幕高
 */
function gridPos(b, sw, sh) {
  const cx = (b.x1 + b.x2) / 2
  const cy = (b.y1 + b.y2) / 2
  const col = cx < sw / 3 ? '左' : cx > (sw * 2) / 3 ? '右' : ''
  const row = cy < sh / 3 ? '顶部' : cy > (sh * 2) / 3 ? '底部' : '中部'
  if (col === '') return row === '中部' ? '屏幕中央' : `${row}中央` // 顶部中央 / 底部中央
  return `${col}${row}` // 左上 / 右下 / 底部中央 等
}

/**
 * 输入框占位词：有些 App 的输入框根本不是 EditText，而是一个不可点击、不可聚焦的 TextView
 * （实测 DeepSeek 的「发消息或按住说话」：class=android.widget.TextView、clickable=false、
 *  focusable=false、也没有 editable）。这类节点会被「只留可交互节点」的过滤直接丢掉，
 * 模型在清单里看不见输入框，只能凭坐标瞎猜，打了字也进不去——「模型不会用 DeepSeek」就是这个原因。
 * 所以：文本命中这些占位词、本身又不可点的节点，也当「输入框」收进来（标 placeholder）。
 */
const INPUT_HINT = /发消息|按住说话|说点什么|写点什么|输入|搜索|搜一搜|添加评论|写评论|回复|有什么可以帮/

/**
 * 解析 uiautomator XML → 节点列表 + 自然语言 brief。
 * 只保留 clickable/scrollable=true 或可编辑（EditText 类或 editable 属性）的节点。
 */
export function parseNodes(xml, { maxNodes = 80 } = {}) {
  const s = String(xml || '')
  // 空 / 完全不像 uiautomator dump → DUMP_EMPTY
  if (!s.trim() || !/<hierarchy/i.test(s)) {
    return { list: [], brief: '', error: 'DUMP_EMPTY' }
  }
  // 先全量扫描一遍所有 node 的 bounds 推算屏幕尺寸（含被过滤节点，
  // 否则屏上只剩一两个小控件时会推错九宫格），推不出用 1080x2340 兜底
  let sw = 0
  let sh = 0
  const sizeRe = /<node\s+[^>]*bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/g
  let sm
  while ((sm = sizeRe.exec(s)) !== null) {
    const [, x1, y1, x2, y2] = sm.map(Number)
    if (x2 > x1 && y2 > y1) {
      sw = Math.max(sw, x2)
      sh = Math.max(sh, y2)
    }
  }
  sw = sw || 1080
  sh = sh || 2340
  // 逐个 <node .../> 标签扫描（uiautomator 的 node 标签都是自闭合）
  const tagRe = /<node\s+([^>]*)\/?>/g
  const list = []
  const readTexts = [] // 不可点但有实质文字的节点（回答正文、文章段落等）
  let m
  while ((m = tagRe.exec(s)) !== null) {
    const tag = `<node ${m[1]}>`
    const clickable = attr(tag, 'clickable') === 'true'
    const scrollable = attr(tag, 'scrollable') === 'true'
    const editable = attr(tag, 'editable') === 'true' || /EditText/.test(attr(tag, 'class'))
    // 假输入框：不可点的 TextView，但文字是「发消息/搜索/说点什么」这类占位词
    const txt = attr(tag, 'text')
    const placeholder = !editable && !clickable && Boolean(txt) && INPUT_HINT.test(txt)
    // 不可点但有实质文字的节点（回答正文、文章段落、商品标题…）不进操作清单，
    // 但要收进「页面文字」——不然模型读到的界面里根本没有回答内容，
    // 只会觉得「它没回答我」然后一遍遍重新提问（实测 DeepSeek 反复问同一句话就是这个原因）。
    if (!clickable && !scrollable && !editable && !placeholder) {
      const clean = String(txt || '').replace(/\s+/g, ' ').trim()
      if (clean.length >= 12 && !/^[\d\s.,:%;¥$￥-]+$/.test(clean)) readTexts.push(clean)
      continue
    }
    const b = parseBounds(attr(tag, 'bounds'))
    if (!b) continue // 越界/坏 bounds 的节点不要
    // 推算屏幕尺寸：取所有节点最大右/下边
    const n = list.length
    list.push({
      n,
      text: txt,
      desc: attr(tag, 'content-desc'),
      cls: attr(tag, 'class'),
      center: [Math.round((b.x1 + b.x2) / 2), Math.round((b.y1 + b.y2) / 2)],
      // 尺寸也带上：点击要做「人手抖动」，但抖多少得看按钮多大——
      // 小图标只有 50px 宽，抖 ±24 就点飞了，这正是「点了三次界面没反应」的常见原因
      size: [b.x2 - b.x1, b.y2 - b.y1],
      editable,
      scrollable,
      placeholder,
    })
    if (list.length >= maxNodes) break // 超预算截断，防 brief 过长
  }
  // 标签像 XML 但一个可用节点也没有：也按空转储处理，让上层重试
  if (list.length === 0) {
    return { list: [], brief: '', error: 'DUMP_EMPTY' }
  }
  // 自然语言 brief：[0]按钮"发布" 底部中央 | [1]输入框"说点什么..." 可输入 | ...
  const parts = list.map((nd) => {
    const kind = nd.editable || nd.placeholder ? '输入框' : nd.scrollable ? '滚动区' : '按钮'
    // 空的编辑区 text 常常只有一个换行（甚至写成 &#10;），直接丢给模型会被当成一个
    // 「可点的普通节点」，然后反复 tap 同一处（实测荣耀笔记那轮连点 12 次换行节点、界面纹丝不动）。
    // 这里把「实质为空的输入框」明确说清楚，让它知道该用 input 而不是 tap。
    const rawTxt = String(nd.text || nd.desc || '')
    const blank = rawTxt.replace(/[\s\u00a0\u3000]+/g, '') === ''
    const label = blank
      ? (nd.editable ? '空输入框（直接 input 文字，不要反复 tap）' : nd.cls.split('.').pop())
      : rawTxt
    const pos = gridPos(
      {
        x1: nd.center[0] - 1,
        y1: nd.center[1] - 1,
        x2: nd.center[0] + 1,
        y2: nd.center[1] + 1,
      },
      sw,
      sh
    )
    // 假输入框（不可点的 TextView 占位）要单独说清楚：得先 tap 它把焦点点进去，再 input
    const feats = [
      nd.editable && '可输入',
      nd.placeholder && '点一下才能打字',
      nd.scrollable && '可滚动',
    ].filter(Boolean).join('/')
    return `[${nd.n}]${kind}"${label}" ${pos}${feats ? ' ' + feats : ''}`
  })
  // 「页面文字」：把屏幕上读得到但不能点的内容也给模型看（最多 12 段、总共 1200 字）。
  // 少了这一段，模型在 DeepSeek 里看不见回答、在知乎看不见正文、在淘宝看不见商品标题，
  // 只能靠猜，于是「读不到回答 → 再问一遍」。加上之后模型才真的能「读」界面。
  let extra = ''
  if (readTexts.length) {
    const picked = []
    let budget = 1200
    for (const t of readTexts) {
      if (t.length < 12) continue
      const piece = t.length > 120 ? t.slice(0, 120) + '…' : t
      if (piece.length > budget) break
      picked.push(piece)
      budget -= piece.length
      if (picked.length >= 12) break
    }
    if (picked.length) extra = `【页面文字（读得到但点不了）】${picked.join(' ⏎ ')}`
  }
  return { list, brief: parts.join(' | '), extra }
}

/**
 * 取第 n 个节点的中心坐标，供 tap 用。
 * @param {Array<{n:number, center:[number,number]}>} list
 * @param {number} n
 * @returns {[number, number]|null}
 */
export function nodeCenter(list, n) {
  const nd = (list || []).find((x) => x.n === n)
  return nd ? nd.center : null
}
