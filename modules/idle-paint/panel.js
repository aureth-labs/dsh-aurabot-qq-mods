// 空闲画画 · 面板（自绘）
// 拿到 React、h（React.createElement）、ui（面板自带组件）、call（调本模块接口）
const { useState, useEffect, useCallback } = React

return function IdlePaintPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await call('/state')
      setSt(r)
      setErr('')
    } catch (e) {
      setErr(String(e && e.message ? e.message : e))
    }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])

  const paintNow = async () => {
    setBusy(true)
    try {
      const r = await call('/now', { prompt: '' })
      toast(r && r.ok ? '画好了，下面能看到' : '没画成：' + ((r && r.message) || '未知原因'))
      await load()
    } catch (e) {
      toast('出错了：' + String(e && e.message ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const fmt = (t) => {
    if (!t) return '还没画过'
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const items = (st && st.items) || []

  return h('div', null,
    h(ui.Card, { title: '空闲画画' },
      h(ui.Row, null,
        h('span', { className: 'ab-note' },
          st
            ? (st.enabled ? '开着' : '关着')
              + ' · 今天画了 ' + st.todayCount + '/' + st.maxPerDay + ' 张'
              + ' · 现在空闲 ' + st.idleMinutes + ' 分钟'
              + ' · ComfyUI ' + (st.comfyAlive ? '在跑' : '没开')
            : (err ? '读不到状态：' + err : '读取中…')),
      ),
      h(ui.Row, null,
        h(ui.Btn, { onClick: paintNow, disabled: busy || !!(st && st.busy) },
          busy || (st && st.busy) ? '正在画…' : '现在就画一张'),
        h(ui.Btn, { onClick: load }, '刷新'),
      ),
      h('p', { className: 'ab-muted ab-small' },
        '上一次：' + fmt(st && st.lastAt)
        + (st && st.lastError ? '　最近一次出错：' + st.lastError : '')),
    ),

    h(ui.Card, { title: '最近画的' },
      items.length === 0
        ? h(ui.Empty, null, '还没有作品，空闲下来它自己会画')
        : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
          items.map((it) => h('div', { key: it.file, style: { width: '160px' } },
            h('img', {
              src: '/aurabot/api/ext/idle-paint/last?i=' + encodeURIComponent(it.file),
              loading: 'lazy',
              style: { width: '160px', borderRadius: '8px', display: 'block', background: '#111' },
            }),
            h('div', { className: 'ab-muted ab-small', style: { marginTop: '4px' } }, fmt(it.at)),
            h('div', { className: 'ab-small', style: { opacity: 0.75, maxHeight: '2.6em', overflow: 'hidden' } },
              String(it.prompt || '').slice(0, 60)),
          ))),
    ),
  )
}
