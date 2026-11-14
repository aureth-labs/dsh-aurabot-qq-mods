// 过日子面板：她的生活页——今天干了什么、为什么没醒、乐子开关、连载进度
const { useState, useEffect } = React

const fmt = (t) => t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
const ago = (t) => t ? `${Math.max(1, Math.round((Date.now() - t) / 60000))}分钟前` : '还没'

const GATE_DOT = {
  done: { text: '做了', color: 'var(--color-success, #2e7d32)' },
  failed: { text: '没做成', color: 'var(--color-danger, #c62828)' },
  share: { text: '', color: 'var(--color-info, #1565c0)' },
  skipped: { text: '没醒', color: 'var(--color-text-tertiary, #9e9e9e)' },
}

return function Panel({ toast }) {
  const [state, setState] = useState(null)
  const [history, setHistory] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = () => {
    call('/state').then((s) => { if (s?.ok) setState(s); else setErr('state 接口不对') }).catch((e) => setErr(String(e.message || e)))
    call('/history').then((r) => setHistory(r?.ok ? r.history || [] : [])).catch(() => {})
  }
  useEffect(() => { reload(); const t = setInterval(reload, 30000); return () => clearInterval(t) }, [])

  const setEnabled = async (on) => {
    setBusy(true)
    try {
      const r = await call('/enabled', { on })
      if (r?.ok) { toast(on ? '她的日子开起来了' : '先让她歇着'); reload() } else toast(r?.message || '没切成功')
    } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy(false)
  }

  const toggle = async (id) => {
    try {
      const r = await call('/pool/toggle', { id })
      if (r?.ok) { toast(r.on ? '记回来了' : '先歇了这项'); reload() } else toast(r?.message || '没切成功')
    } catch (e) { toast('出错了：' + (e.message || e)) }
  }

  const setNovelMode = async (mode) => {
    try {
      const r = await call('/novel/mode', { mode })
      if (r?.ok) { toast(mode === 'long' ? '长篇：一章一个 Word，她每轮先翻书架' : '短篇：一整个 Word 文档'); reload() } else toast(r?.message || '没切成功')
    } catch (e) { toast('出错了：' + (e.message || e)) }
  }

  const infoStyle = { fontSize: 13, color: 'var(--color-text-secondary, inherit)' }
  const rowStyle = { display: 'flex', gap: 8, alignItems: 'baseline', borderBottom: '1px dashed rgba(128,128,128,.25)', padding: '3px 0' }

  const shareText = (it) => it.state === 'sent' ? '分享了' : it.state === 'failed' ? '分享失败' : '偷着乐，没发'

  return h(ui.Card, { title: '她的日子' },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' } },
      h('button', {
        onClick: () => setEnabled(!state?.enabled),
        disabled: busy || !state,
        style: {
          fontSize: 14, padding: '6px 16px', borderRadius: 999, cursor: 'pointer',
          border: '1px solid ' + (state?.enabled ? 'rgba(46,125,50,.5)' : 'rgba(128,128,128,.4)'),
          background: state?.enabled ? 'rgba(46,125,50,.12)' : 'transparent',
          color: 'inherit', whiteSpace: 'nowrap',
        },
      }, busy ? '切换中…' : state?.enabled ? '⏸ 暂停她的日子' : '▶ 让她自己过日子'),
      h('span', { className: 'ab-small ab-muted', style: { flex: 1, minWidth: 200 } },
        state?.enabled
          ? `开着 · 今天自己玩了 ${state.today.done}/${state.today.max} 次 · 下次醒来 ${state.nextWakeAt ? fmt(state.nextWakeAt) + '（' + state.nextWakeBy + '）' : '还没定'}`
          : '关着——开了她才会在主人不在的空档自己找乐子；每道闸的判定都记在下面的痕迹里。'),
    ),
    err && h('p', { className: 'ab-small ab-muted' }, '加载失败：' + err),

    state && h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
      h('div', { style: { flex: '1 1 160px', background: 'rgba(128,128,128,.08)', borderRadius: 10, padding: '8px 12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('div', { className: 'ab-small ab-muted', style: { flex: 1 } }, '小说'),
          h('button', { onClick: () => setNovelMode(state.novel.mode === 'long' ? 'short' : 'long'), style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' } },
            state.novel.mode === 'long' ? '切短篇' : '切长篇')),
        h('div', { style: infoStyle },
          state.novel.mode === 'long'
            ? (state.novel.chapters ? `长篇《${state.novel.longTitle || state.novel.title || '未定'}》${state.novel.chapters} 章 · 一章一个 Word` : '长篇 · 还没动笔')
            : (state.novel.parts ? `短篇《${state.novel.title || '未定'}》${state.novel.parts} 段 · 一整个 Word` : '短篇 · 还没动笔')),
        state.novel.last && h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } }, `…${state.novel.last}`)),
      h('div', { style: { flex: '1 1 160px', background: 'rgba(128,128,128,.08)', borderRadius: 10, padding: '8px 12px' } },
        h('div', { className: 'ab-small ab-muted' }, '肚子'),
        h('div', { style: infoStyle }, state.hunger == null ? '喂食模块没在跑' : `饿度 ${state.hunger}/100`)),
    ),

    state && h('div', { style: { marginBottom: 10 } },
      h('p', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, '乐子清单（点「歇了」让她今天别碰这项）'),
      state.joys.map((j) => h('div', { key: j.id, style: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(128,128,128,.08)', borderRadius: 8, padding: '5px 10px', marginBottom: 4 } },
        h('span', { style: { flex: 1, fontSize: 13 } }, j.name, j.ok === false && h('span', { className: 'ab-small ab-muted', style: { marginLeft: 6 } }, '（对应模块没装，不会出现在她的清单里）')),
        h('span', { className: 'ab-small ab-muted' }, `兴趣 ${j.weight} · 上次 ${ago(j.lastAt)}`),
        h('button', { onClick: () => toggle(j.id), style: { fontSize: 12, padding: '2px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '歇了'),
      ))),

    h('p', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, '她这一天的痕迹（每道闸的判定都在，能回答"她今天为什么没醒"）'),
    !history.length && h('p', { className: 'ab-small ab-muted' }, '还没有痕迹——她可能还在睡'),
    h('div', { style: { maxHeight: 320, overflowY: 'auto' } },
      history.map((it, i) => {
        const dot = it.event === 'share' ? shareText(it) : (GATE_DOT[it.event]?.text || it.event)
        const color = GATE_DOT[it.event]?.color
        return h('div', { key: i, style: rowStyle },
          h('span', { className: 'ab-small ab-muted', style: { flexShrink: 0 } }, fmt(it.at)),
          h('span', { style: { color, flexShrink: 0, fontSize: 13 } }, dot),
          h('span', { className: 'ab-small', style: { color: 'var(--color-text-secondary, inherit)' } },
            [it.joy, it.gate && `（${it.gate}）`, it.detail && `：${String(it.detail).slice(0, 60)}`].filter(Boolean).join('') || ''))
      })))
}
