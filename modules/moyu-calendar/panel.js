// panel.js —— 摸鱼人日历的面板：看今天实际从哪一路取的图，需要时清除已获取的图让模块重新取。
// 数据全部来自 /status 和 /clear，面板自己不存东西。设置表单还是宿主按 settings 自动生成的那一份。
const { useEffect, useRef, useState } = React

// 和模块里的 sourceLabel 保持一致。面板是单独执行的，引不了模块里的代码。
const SOURCE_LABEL = { rss: 'RSS', album: '合集', sogou: '搜狗', cache: '缓存' }
const PROGRESS = { sent: '已发送', none: '无更新', pending: '未完成' }
const sourceLabel = code => SOURCE_LABEL[code] || code || '未知'
const cut = (text, max) => {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max) + '…' : value
}
const paragraph = (className, style, text) => h('p', { className, style: Object.assign({ margin: 0 }, style || {}) }, text)

return function Panel({ toast }) {
  const [info, setInfo] = useState(null)
  const [message, setMessage] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const load = async () => {
      try {
        const r = await call('/status')
        if (alive.current && r && r.ok) setInfo(r)
      } catch (e) { /* 面板静默刷新，失败就等下一轮 */ }
    }
    load()
    const timer = setInterval(load, 15000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])

  // 清除会让定时任务重新取图、再发一次，所以要点两下；过一会儿没点第二下就恢复。
  useEffect(() => {
    if (!asking) return
    const timer = setTimeout(() => setAsking(false), 8000)
    return () => clearTimeout(timer)
  }, [asking])

  const clear = async () => {
    if (busy) return
    if (!asking) { setAsking(true); return }
    setBusy(true)
    setAsking(false)
    setMessage('')
    try {
      const r = await call('/clear', { confirm: true })
      if (!r || !r.ok) {
        const text = (r && r.message) || '清除失败'
        if (alive.current) setMessage(text)
        if (toast) toast(text)
        return
      }
      if (alive.current) setInfo(r)
      if (toast) toast(r.removed ? '已清除，模块会重新获取今天的图' : '今天没有缓存的图，今天的进度已清零')
    } catch (e) {
      if (alive.current) setMessage('清除失败：' + ((e && e.message) || e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const button = (text, kind, onClick, disabled) => (ui && ui.Btn)
    ? h(ui.Btn, { small: true, kind, onClick, disabled }, text)
    : h('button', { type: 'button', className: 'ab-btn', onClick, disabled }, text)

  if (!info) {
    return h(ui.Card, { title: '今天的取图情况' },
      paragraph('ab-muted ab-small', null, '正在读取…'))
  }

  return h(ui.Card, { title: '今天的取图情况' },
    h('div', { style: { display: 'grid', gap: 6 } },
      paragraph(null, null, '今天：' + (PROGRESS[info.today] || info.today || '未知')),
      paragraph(null, null, '实际来源：' + (info.busy ? '获取中…' : info.fetched ? `${sourceLabel(info.source)}（${info.fetched}）` : '还没取过')),
      info.title ? paragraph('ab-muted ab-small', null, info.title) : null,
      info.lastError ? paragraph('ab-small', null, '最近错误：' + cut(info.lastError, 160)) : null,
      paragraph('ab-muted ab-small', null, '每次取图的来源也会写进日志；没重新取之前发的都是缓存里的图。'),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
        // 平时用面板默认样式的按钮，和设置表单里的按钮一致；进入确认状态才变红。
        button(
          busy ? '清除中…' : asking ? '再点一次，确认清除' : '清除已获取',
          asking ? 'danger' : undefined,
          clear,
          busy,
        ),
        paragraph('ab-muted ab-small', null, asking
          ? '会删掉今天缓存的图，定时任务会重新取图并再发一次'
          : '删掉今天缓存的图，让模块重新获取')),
      message ? h('p', { role: 'alert', className: 'ab-small', style: { margin: 0 } }, message) : null))
}
