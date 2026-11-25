// panel.js —— 私人日记面板：状态 + 一本可以翻的日记本
// 拿到 React、h（React.createElement）、ui（面板组件）、call（调 api.route），返回一个 React 组件。
const { useState, useCallback, useEffect, useRef, useMemo } = React

const HAND_TITLE = '"ld-hand","STKaiti","华文楷体","KaiTi",serif'
const HAND_BODY = '"ld-hand","STKaiti","华文楷体","KaiTi","楷体",serif'

const fmtTime = (at) => {
  const d = new Date(Number(at) || Date.now())
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const totalChars = (items) => items.reduce((sum, x) => sum + (Number(x.chars) || 0), 0)
const dayLabel = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(day || '')
}
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']
const MAX_TABS = 5
const MOOD_ORDER = ['超开心', '心情不错', '平平常常', '有点低落', '不太开心']
const MOODS = {
  超开心: { ink: '#9a5a10', bg: '#fdeccf', dot: '#f2a65a' },
  心情不错: { ink: '#1c6f93', bg: '#d9f0fa', dot: '#4aa8d8' },
  平平常常: { ink: '#4a5578', bg: '#e6e9f2', dot: '#8a93a8' },
  有点低落: { ink: '#3f4590', bg: '#e1e3f6', dot: '#5a5fa8' },
  不太开心: { ink: '#8d3f58', bg: '#f8e1e8', dot: '#c0607a' },
}
const moodStyle = (m) => MOODS[m] || MOODS['平平常常']
// 星期几：按本地日期算，别把 2026-11-16 当成 UTC
const weekdayOf = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return '星期' + WEEK_CN[d.getDay()]
}

// **粗体** / 标题 / 列表 的极简处理：日记是 markdown，摊在纸上不该露出星号
const inline = (text) => {
  const out = []
  String(text).split('**').forEach((seg, i) => {
    if (!seg) return
    out.push(i % 2 ? h('b', { key: i, style: { fontWeight: 700 } }, seg) : seg)
  })
  return out
}
const WISH_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:愿望|心愿)[ \t]*[：:][ \t]*.+$/
// 愿望行会单独显示在下方的愿望条里，正文里就不再重复（文件本身不改）
const stripWishes = (body) => String(body || '').split(/\r?\n/).filter((l) => !WISH_LINE.test(l)).join('\n').replace(/\s+$/, '')
const blocks = (body) => String(body || '').split(/\r?\n/).map((line, i) => {
  const t = line.trim()
  if (!t) return h('div', { key: i, style: { height: 32 } })
  const hd = /^#{1,6}\s+(.*)$/.exec(t)
  if (hd) return h('div', { key: i, style: { fontSize: 22, fontWeight: 700, color: '#6f5324', letterSpacing: 1 } }, inline(hd[1]))
  const li = /^[-*+]\s+(.*)$/.exec(t)
  if (li) return h('div', { key: i }, '· ', inline(li[1]))
  return h('div', { key: i }, inline(t))
})

const CSS = `
@font-face{font-family:'ld-hand';src:url('/aurabot/api/ext/local-diary/hand.ttf') format('truetype');font-display:swap;}
.ld-wrap{min-width:0;}
.ld{position:relative;display:grid;grid-template-columns:200px minmax(0,1fr);gap:14px;background:#141a3a;border-radius:14px;padding:14px;font-family:${HAND_BODY};min-width:0;}
.ld-rail{display:flex;flex-direction:column;gap:2px;min-width:0;max-height:660px;overflow:auto;padding-right:2px;}
.ld-rail::-webkit-scrollbar{width:6px;}
.ld-rail::-webkit-scrollbar-thumb{background:#34408a;border-radius:4px;}
.ld-rt{position:relative;display:flex;gap:6px;margin-bottom:8px;}
.ld-rt button{flex:1;font-family:inherit;font-size:12.5px;padding:5px 0;border-radius:20px;color:#9fb4e8;background:transparent;border:1px solid #34408a;cursor:pointer;}
.ld-rt button.on{background:#7fc4ee;color:#10204f;border-color:#7fc4ee;font-weight:700;}
.ld-rm{font-size:11.5px;color:#6f84c8;letter-spacing:2px;padding:10px 8px 4px;}
.ld-ri{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;cursor:pointer;color:#cfdaf7;font-size:13.5px;border:0;background:transparent;font-family:inherit;text-align:left;width:100%;}
.ld-ri:hover{background:#1d2656;}
.ld-ri.on{background:#26337a;color:#fff;}
.ld-ri i{flex:0 0 auto;width:6px;height:6px;border-radius:50%;border:1.5px solid #fff;}
.ld-ri b{flex:0 0 auto;width:50px;font-weight:500;}
.ld-ri s{text-decoration:none;color:#7f93d4;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.ld-ri.on s{color:#b9c8f2;}
.ld-ri em{font-style:normal;font-size:10px;color:#e9a3b4;margin-left:auto;flex:0 0 auto;}
.ld-lg{margin-top:12px;padding:10px 8px 4px;border-top:1px solid #34408a;display:flex;flex-wrap:wrap;gap:6px 10px;font-size:11.5px;color:#8197d8;}
.ld-lg span{display:inline-flex;align-items:center;gap:4px;}
.ld-lg i{width:8px;height:8px;border-radius:50%;}
.ld-cal{position:absolute;left:14px;top:52px;z-index:30;width:236px;padding:8px 9px 10px;border-radius:12px;background:#fbfaf6;box-shadow:0 12px 26px rgba(0,0,0,.4);color:#26337a;}
.ld-cal-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:13px;}
.ld-cal-h button{border:0;background:transparent;cursor:pointer;font-size:16px;color:#3a4a8f;padding:0 6px;}
.ld-cal-g{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
.ld-cal-w{font-size:11px;color:#8d9acb;text-align:center;}
.ld-cal-d{height:26px;border-radius:8px;border:1px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#26305f;cursor:pointer;}
.ld-cal-d:disabled{color:#cdd3e6;cursor:default;}
.ld-cal-d.on{outline:2px solid #3a5fd0;outline-offset:-1px;font-weight:700;}
.ld-paper{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr);background:#fbfaf6;border-radius:12px;overflow:hidden;color:#26305f;min-width:0;}
.ld-lace{position:absolute;left:0;right:0;top:0;height:10px;z-index:2;background:radial-gradient(circle at 8px 0,#141a3a 0 5px,transparent 5.5px) 0 0/16px 10px repeat-x;}
.ld-bind{position:relative;background:#26337a;}
.ld-bind:after{content:"";position:absolute;left:10px;top:18px;bottom:18px;border-left:1.5px dashed #a9c4f5;}
.ld-bow{position:absolute;left:-3px;top:28px;width:28px;height:18px;z-index:1;}
.ld-pg{padding:26px 26px 12px 28px;display:flex;flex-direction:column;min-width:0;}
.ld-in{animation:ld-in .32s ease-out both;}
.ld-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;}
.ld-date{font-family:${HAND_TITLE};font-size:30px;line-height:1.15;color:#26337a;letter-spacing:3px;}
.ld-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 14px;}
.ld-chip{font-size:12.5px;line-height:1;padding:5px 11px;border-radius:20px;background:#e8eefb;color:#3a4a8f;}
.ld-fish{flex:0 0 auto;transform-origin:30% 60%;}
.ld-fish.wag{animation:ld-wag .6s ease-in-out;}
.ld-body{font-size:18px;line-height:30px;color:#2a3466;border-left:1.5px solid #f0b8c4;padding:0 4px 0 16px;background-image:repeating-linear-gradient(to bottom,transparent 0 29px,#e3e9f6 29px 30px);}
.ld-body div{min-height:30px;}
.ld-empty{padding:30px 10px;color:#8d9acb;font-size:17px;line-height:30px;}
.ld-wish{margin:16px 0 0;display:flex;gap:10px;align-items:baseline;padding:10px 14px;background:#fdeef1;border-radius:14px;border:1px dashed #e9a3b4;}
.ld-wish-k{flex:0 0 auto;font-family:${HAND_TITLE};font-size:12.5px;letter-spacing:2px;color:#d4637f;}
.ld-wish-t{flex:1;font-size:16px;line-height:1.65;color:#7a3f55;word-break:break-word;}
.ld-foot{position:relative;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;font-size:12.5px;color:#7f8dbd;}
.ld-flip{font-family:inherit;font-size:13px;color:#26337a;background:transparent;border:1px solid #aebce6;border-radius:20px;padding:5px 15px;cursor:pointer;}
.ld-flip:hover:not(:disabled){background:#e8eefb;}
.ld-flip:disabled{opacity:.4;cursor:default;}
.ld-path{margin-top:10px;font-size:11.5px;color:#a3aed3;word-break:break-all;}
.ld-bub{position:absolute;bottom:-4px;border-radius:50%;border:1px solid #9fcdf0;background:rgba(127,196,238,.15);pointer-events:none;opacity:0;}
@media (prefers-reduced-motion: no-preference){
.ld-bub{animation:ld-up 5s ease-in infinite;}
}
@keyframes ld-in{from{opacity:0;transform:translateX(10px);}to{opacity:1;transform:none;}}
@keyframes ld-wag{0%,100%{transform:rotate(0);}25%{transform:rotate(-14deg);}60%{transform:rotate(10deg);}}
@keyframes ld-up{0%{transform:translateY(0);opacity:0;}15%{opacity:.9;}100%{transform:translateY(-46px);opacity:0;}}
@media (prefers-reduced-motion: reduce){.ld-in,.ld-fish.wag{animation:none;}}
@media (max-width:760px){.ld{grid-template-columns:minmax(0,1fr);}.ld-rail{max-height:220px;}}
`

return function Panel({ toast, settings, draftSettings, setSettings, save }) {
  const [data, setData] = useState(null)
  const [page, setPage] = useState(0)
  const [entry, setEntry] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState('new')   // 'new' 最新几篇 / 'old' 最早几篇
  const [calOpen, setCalOpen] = useState(false)
  const [flip, setFlip] = useState(0)
  const [calMonth, setCalMonth] = useState(() => new Date())
  // 设置了但是还没保存：页面底部的浮动条常常在屏幕外面，这里也放一个按钮
  const canSave = typeof save === 'function' && draftSettings
  const draftDirty = canSave && JSON.stringify(draftSettings) !== JSON.stringify(settings || {})
  const saveNow = async () => {
    if (typeof save !== 'function') return
    try { await save(draftSettings || {}) } catch (e) { quietToast(e && e.message) }
  }
  const quietToast = (m) => { try { toast && toast(String(m || '保存失败'), 'err') } catch {} }

  const load = useCallback(async () => {
    try {
      setErr('')
      const r = await call('/status')
      if (!r || !r.ok) throw new Error((r && r.message) || '读取失败')
      setData(r)
      return r
    } catch (e) {
      setErr(String((e && e.message) || e))
      return null
    }
  }, [])

  const openSeq = useRef(0)
  const open = useCallback(async (file) => {
    const seq = ++openSeq.current
    if (!file) { setEntry(null); return }
    setLoading(true)
    try {
      const r = await call('/read', { file })
      if (seq !== openSeq.current) return   // 已经翻到别页了，旧结果不覆盖新页
      if (r && r.ok) setEntry(r)
      else setErr((r && r.message) || '读不到')
    } catch (e) {
      if (seq === openSeq.current) setErr(String((e && e.message) || e))
    } finally {
      if (seq === openSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  // 「刷新」后列表可能多了新篇，页码要跟着当前打开的那篇走，不然目录高亮和正文对不上
  const entryRef = useRef(null)
  entryRef.current = entry

  // 刷新：先让后端重扫日记目录（手写进去的、外面改动的也能看见），再对齐现在打开的那一篇。
  const lastFilesRef = useRef(null)
  const refresh = useCallback(async (manual = false) => {
    try { await call('/rescan') } catch (error) {}
    const r = await load()
    const list = (r && r.items) || []
    const prev = lastFilesRef.current
    lastFilesRef.current = new Set(list.map((x) => x.file))
    if (!list.length) { setEntry(null); return }
    const before = entryRef.current
    const cur = before && before.file ? list.find((x) => x.file === before.file) : null
    if (!cur) { await open(list[0].file); return }   // 现在这篇没了，翻到最新的一篇
    // 同一篇被改写过（字数或改动时间变了）就重读正文：只换目录的话，点刷新后正文还是旧的
    if (before.chars !== cur.chars || before.at !== cur.at) { await open(cur.file); return }
    // 手点刷新就是要看新东西：多出来的那篇直接翻过去，多篇就翻最新的一篇。
    // 一分钟一次的自动刷新不跳页，免得正看着旧日记被弹走。
    if (manual && prev) {
      const added = list.filter((x) => !prev.has(x.file))
      if (added.length) await open(added.length === 1 ? added[0].file : list[0].file)
    }
  }, [load, open])

  // 首屏那次 load 的列表当成基线，之后才分得清哪篇是刷新时新冒出来的
  useEffect(() => {
    if (lastFilesRef.current === null && data) lastFilesRef.current = new Set((data.items || []).map((x) => x.file))
  }, [data])

  // 面板开着的时候每分钟自己刷一次，不用手动点
  useEffect(() => {
    const timer = setInterval(() => { refresh() }, 60_000)
    return () => clearInterval(timer)
  }, [refresh])

  const items = (data && data.items) || []
  const dayMap = useMemo(() => {
    const m = new Map()
    items.forEach((it, i) => { if (it.day) m.set(it.day, { i, mood: it.mood || '' }) })
    return m
  }, [items])
  const firstFile = items.length > 0 ? items[0].file : ''
  useEffect(() => {
    const e = entryRef.current
    if (!e || !e.file) return
    const i = items.findIndex((x) => x.file === e.file)
    if (i >= 0) setPage(i)
  }, [items])
  useEffect(() => {
    if (!entry && firstFile) open(firstFile)
  }, [firstFile, entry, open])

  const goto = useCallback((i) => {
    const it = items[i]
    if (!it) return
    setPage(i)
    setFlip((n) => n + 1)
    open(it.file)
  }, [items, open])

  const write = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await call('/run', {})
      if (r && r.ok) {
        if (toast) toast(r.message || '写好了')
        setEntry(null)
        setPage(0)
        await load()
      } else {
        setErr((r && r.message) || '没写成')
      }
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async () => {
    try {
      const r = await call('/open')
      if (r && r.ok && toast) toast('已打开：' + r.message)
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
  }

  const today = new Date()
  const two = (n) => String(n).padStart(2, '0')
  const todayKey = `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`
  const wroteToday = items.some((x) => x.day === todayKey)
  const cur = entry || null
  const curItem = items[page] || null
  const curDay = (cur && cur.day) || (curItem && curItem.day) || ''
  const ms = moodStyle((cur && cur.mood) || (curItem && curItem.mood))
  const wishList = (() => {
    const arr = (cur && cur.wishes) || (curItem && curItem.wishes)
    if (Array.isArray(arr) && arr.length) return arr
    const one = (cur && cur.wish) || (curItem && curItem.wish) || ''
    return one ? [one] : []
  })()

  // 目录：按月份分组，order 决定新旧方向
  const railRows = (() => {
    const list = items.map((it, i) => ({ it, i }))
    if (order === 'old') list.reverse()
    const out = []
    let lastMonth = ''
    list.forEach(({ it, i }) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(it.day || ''))
      const month = m ? `${m[1]} · ${Number(m[2])} 月` : '其他'
      if (month !== lastMonth) {
        lastMonth = month
        out.push(h('div', { key: 'm' + month + i, className: 'ld-rm' }, month))
      }
      const dd = m ? `${Number(m[3])} ${weekdayOf(it.day).slice(2)}` : it.day
      const mo = moodStyle(it.mood)
      out.push(h('button', {
        key: it.file || i,
        className: 'ld-ri' + (i === page ? ' on' : ''),
        onClick: () => goto(i),
        title: `${fmtTime(it.at)}　${it.mood || ''}`,
      },
        h('i', { style: { background: mo.dot } }),
        h('b', null, dd),
        h('s', null, it.summary || ''),
        it.wish ? h('em', null, '✦') : null,
      ))
    })
    return out
  })()

  const calCells = (() => {
    const y = calMonth.getFullYear()
    const mo = calMonth.getMonth()
    const firstDow = new Date(y, mo, 1).getDay()
    const daysInMonth = new Date(y, mo + 1, 0).getDate()
    const out = []
    for (let i = 0; i < firstDow; i++) out.push(null)
    for (let d = 1; d <= daysInMonth; d++) out.push(d)
    return out
  })()

  const calendar = calOpen
    ? h('div', { className: 'ld-cal', onMouseLeave: () => setCalOpen(false) },
        h('div', { className: 'ld-cal-h' },
          h('button', { onClick: () => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1)) }, '‹'),
          h('span', null, `${calMonth.getFullYear()}年${calMonth.getMonth() + 1}月`),
          h('button', { onClick: () => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1)) }, '›'),
        ),
        h('div', { className: 'ld-cal-g' },
          WEEK_CN.map((w) => h('div', { key: w, className: 'ld-cal-w' }, w)),
          calCells.map((d, k) => {
            if (d === null) return h('div', { key: 'e' + k })
            const key = `${calMonth.getFullYear()}-${two(calMonth.getMonth() + 1)}-${two(d)}`
            const hit = dayMap.get(key)
            const hs = hit ? moodStyle(hit.mood) : null
            return h('button', {
              key,
              className: 'ld-cal-d' + (hit && hit.i === page ? ' on' : ''),
              disabled: !hit,
              title: hit ? `${key} ${hit.mood || ''}（写了）` : `${key} 没写`,
              style: hit ? { background: hs.bg, color: hs.ink, fontWeight: 700 } : null,
              onClick: () => { setCalOpen(false); if (hit.i !== page) goto(hit.i) },
            }, String(d))
          }),
        ),
      )
    : null

  const fish = h('svg', { key: 'fish' + flip, className: 'ld-fish' + (flip ? ' wag' : ''), width: 44, height: 30, viewBox: '0 0 44 30', 'aria-hidden': 'true' },
    h('path', { d: 'M4 18 C4 8 16 4 26 8 C32 10 34 14 38 12 L42 8 L41 18 L42 26 L38 22 C34 22 32 26 26 26 C14 28 4 26 4 18 Z', fill: '#cfe6f7', stroke: '#7fc4ee', strokeWidth: 1 }),
    h('circle', { cx: 12, cy: 16, r: 1.6, fill: '#26337a' }),
    h('path', { d: 'M16 4 C17 1 20 1 21 4', fill: 'none', stroke: '#7fc4ee', strokeWidth: 1 }),
  )
  const bow = h('svg', { className: 'ld-bow', viewBox: '0 0 28 18', 'aria-hidden': 'true' },
    h('path', { d: 'M14 9 L2 2 L2 16 Z', fill: '#7fc4ee' }),
    h('path', { d: 'M14 9 L26 2 L26 16 Z', fill: '#7fc4ee' }),
    h('circle', { cx: 14, cy: 9, r: 3.2, fill: '#3a5fd0' }),
  )
  const bubbles = [
    { left: '38%', size: 6, delay: '0s' },
    { left: '50%', size: 9, delay: '1.6s' },
    { left: '61%', size: 5, delay: '3.1s' },
  ].map((b, i) => h('span', { key: i, className: 'ld-bub', style: { left: b.left, width: b.size, height: b.size, animationDelay: b.delay } }))

  const page_ = items.length === 0
    ? h('div', { className: 'ld-pg' },
        h('div', { className: 'ld-hd' }, h('div', { className: 'ld-date' }, '还没有开头'), fish),
        h('div', { className: 'ld-empty' }, '这一页还空着。点上面「现在写一篇」，或者等晚上她自己写。'),
      )
    : h('div', { className: 'ld-pg' },
        h('div', { key: 'c' + flip, className: 'ld-in' },
          h('div', { className: 'ld-hd' },
            h('div', null,
              h('div', { className: 'ld-date' }, dayLabel(curDay)),
              h('div', { className: 'ld-chips' },
                ((cur && cur.mood) || (curItem && curItem.mood))
                  ? h('span', { className: 'ld-chip', style: { background: ms.bg, color: ms.ink, fontWeight: 700 } }, (cur && cur.mood) || curItem.mood)
                  : null,
                h('span', { className: 'ld-chip' }, weekdayOf(curDay)),
                cur ? h('span', { className: 'ld-chip' }, `${cur.chars || 0} 字`) : null,
                loading ? h('span', { className: 'ld-chip' }, '翻页中…') : null,
              ),
            ),
            fish,
          ),
          cur
            ? h('div', { className: 'ld-body' }, blocks(wishList.length ? stripWishes(cur.body) : cur.body))
            : h('div', { className: 'ld-empty' }, loading ? '翻页中…' : '这一页还没打开。'),
          wishList.length
            ? h('div', { className: 'ld-wish' },
                h('span', { className: 'ld-wish-k' }, '愿望'),
                h('div', { className: 'ld-wish-t' }, wishList.map((w, k) => h('div', { key: k }, wishList.length > 1 ? `${k + 1}. ${w}` : w))))
            : null,
        ),
        h('div', { className: 'ld-foot' },
          bubbles,
          h('button', { className: 'ld-flip', onClick: () => goto(Math.min(items.length - 1, page + 1)), disabled: page >= items.length - 1, title: '更早的一篇' }, '← 前一篇'),
          h('span', null, `第 ${items.length - page} / ${items.length} 篇　·　共 ${totalChars(items)} 字`),
          h('button', { className: 'ld-flip', onClick: () => goto(Math.max(0, page - 1)), disabled: page <= 0, title: '更新的一篇' }, '下一篇 →'),
        ),
        cur ? h('div', { className: 'ld-path' }, `${fmtTime(cur.at)} 写　·　${cur.file || ''}`) : null,
      )

  const rail = h('div', { className: 'ld-rail' },
    items.length > 0
      ? h('div', { className: 'ld-rt' },
          h('button', { className: order === 'new' ? 'on' : '', onClick: () => { setOrder('new'); goto(0) }, title: '新的排在前面' }, '最新'),
          h('button', { className: order === 'old' ? 'on' : '', onClick: () => { setOrder('old'); goto(items.length - 1) }, title: '最早写的排在前面' }, '最早'),
          h('button', { className: calOpen ? 'on' : '', onClick: () => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(curDay)
            if (m) setCalMonth(new Date(Number(m[1]), Number(m[2]) - 1, 1))
            setCalOpen(!calOpen)
          }, title: '按日期找：填了色的那天写了日记' }, '日历'),
        )
      : null,
    railRows,
    h('div', { className: 'ld-lg' },
      MOOD_ORDER.map((m) => h('span', { key: m }, h('i', { style: { background: MOODS[m].dot } }), m)),
      h('span', { style: { color: '#e9a3b4' } }, '✦ 有愿望'),
    ),
  )

  return h('div', { className: 'ld-wrap' },
    h('style', { key: 'ld-css' }, CSS),

    h(ui.Card, { title: '私人日记' },
      h('div', { className: 'ab-small', style: { marginBottom: 8 } },
        `下一篇：${(data && data.next) || '—'}　·　今天${wroteToday ? '写过了' : '还没写'}　·　共 ${(data && data.count) || 0} 篇`),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6, wordBreak: 'break-all' } },
        `文件夹：${(data && data.folder) || '—'}`),
      data && data.folder && data.mirrorDir && !data.folder.startsWith(data.mirrorDir)
        ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6, wordBreak: 'break-all' } },
            `备份镜像：${data.mirrorDir}`)
        : null,
      h(ui.Row, null,
        h(ui.Btn, { onClick: write, disabled: busy || (data && data.running) }, busy ? '写着…' : '现在写一篇'),
        h(ui.Btn, { onClick: () => refresh(true) }, '刷新'),
        h(ui.Btn, { onClick: openFolder }, '打开文件夹'),
        draftDirty ? h(ui.Btn, { onClick: saveNow }, '保存设置') : null,
      ),
      draftDirty
        ? h('div', { className: 'ab-small ab-note', style: { marginTop: 8 } }, '上面的设置改了还没保存，点「保存设置」或者按 Ctrl + S。')
        : null,
      err ? h('p', { className: 'ab-note', style: { marginTop: 8 } }, '出错了：' + err) : null,
    ),

    h(ui.Card, { title: '日记本' },
      h('div', { className: 'ld' },
        rail,
        calendar,
        h('div', { className: 'ld-paper' },
          h('div', { className: 'ld-lace' }),
          h('div', { className: 'ld-bind' }, bow),
          page_,
        ),
      ),
    ),
  )
}
