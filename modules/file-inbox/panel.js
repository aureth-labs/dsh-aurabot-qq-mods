// panel.js —— 私聊收件箱面板：文件清单 + 接收记录
// 拿到 React、h（React.createElement）、ui（面板自带组件）、call（调 api.route 的接口），返回一个 React 组件。
const { useState, useCallback, useEffect } = React

const fmtSize = (n) => {
  const b = Number(n) || 0
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB'
  return b + ' B'
}
const fmtTime = (at) => new Date(Number(at)).toLocaleString('zh-CN', { hour12: false })

return function Panel() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      setErr('')
      const r = await call('/inbox')
      if (!r || !r.ok) throw new Error(r?.message || '读取失败')
      setData(r)
    } catch (e) {
      setErr(String(e && e.message ? e.message : e))
    }
  }, [])

  useEffect(() => { load() }, [load])

  const items = (data && data.items) || []
  const records = (data && data.records) || []

  return h('div', null,
    h(ui.Btn, { onClick: load, style: { marginBottom: 10 } }, '刷新'),
    err ? h('p', { className: 'ab-note' }, '读取出错：' + err) : null,
    // 文件清单
    h(ui.Card, { title: `收件箱文件（${items.length}）` },
      items.length === 0
        ? h(ui.Empty, null, '收件箱空空的，还没收到过文件')
        : h('div', null, items.map((it, i) => h('div', { key: it.id || i, style: { padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,.15)' } },
            h('div', null, `${i + 1}. [${it.cat || '其他'}]《${it.name}》 ${fmtSize(it.size)}`),
            h('div', { className: 'ab-small ab-muted' }, `${fmtTime(it.at)} 收 · ${it.path || ''}`),
          )))),
    // 接收记录
    h(ui.Card, { title: `接收记录（最近 ${records.length} 条）` },
      records.length === 0
        ? h(ui.Empty, null, '还没有记录')
        : h('div', null, records.map((r, i) => h('div', { key: i, className: 'ab-small', style: { padding: '4px 0' } },
            h('span', null, `${fmtTime(r.at)} 【${r.action || '?'}】`),
            h('span', { style: { marginLeft: 6 } }, `《${r.name || '?'}》`),
            r.size ? h('span', { style: { marginLeft: 6 } }, fmtSize(r.size)) : null,
            r.reason ? h('span', { className: 'ab-muted', style: { marginLeft: 6 } }, '原因：' + r.reason) : null,
          )))),
  )
}
