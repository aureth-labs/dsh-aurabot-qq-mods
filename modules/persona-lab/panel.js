// 人格实验室 · 备份看板：列出每次自动备份，可一键恢复/撤销。
// 面板会传入 React、h、ui、call、toast；这里只读备份列表，恢复前会再备份当前版本。
const { useState } = React

return function PersonaLabPanel({ toast }) {
  const [list, setList] = useState(null)
  const [styles, setStyles] = useState(null)
  const [stylesOpen, setStylesOpen] = useState(false)
  const [busy, setBusy] = useState('')

  const load = async () => {
    try {
      const r = await call('/backups')
      setList(r?.items || [])
    } catch (e) { toast('读取备份失败：' + e.message) }
  }
  const loadStyles = async () => {
    try {
      const r = await call('/styles')
      setStyles(r?.items || [])
    } catch (e) { toast('读取样本失败：' + e.message) }
  }
  if (!list) load()
  if (!styles) loadStyles()

  const restore = async (name) => {
    if (!confirm(`恢复「${name}」？当前人格会先自动备份一份。`)) return
    setBusy(name)
    try {
      const r = await call('/restore', { name })
      toast(r.message || '已恢复')
      await load()
    } catch (e) { toast('恢复失败：' + e.message) }
    setBusy('')
  }

  const remove = async (name) => {
    if (!confirm(`删除备份「${name}」？删了找不回来。`)) return
    setBusy(name)
    try {
      const r = await call('/delete-backup', { name })
      toast(r.message || '已删除')
      await load()
    } catch (e) { toast('删除失败：' + e.message) }
    setBusy('')
  }

  const clearStyles = async () => {
    if (!confirm('清空所有群友的说话样本？人格和备份不会动。')) return
    setBusy('styles')
    try {
      const r = await call('/clear-styles', {})
      toast(r.message || '已清空群友说话样本')
      await loadStyles()
    } catch (e) { toast('清空失败：' + e.message) }
    setBusy('')
  }

  const removeStyle = async (it) => {
    if (!confirm(`删除「${it.name}」的说话样本？`)) return
    setBusy('style:' + it.key)
    try {
      const r = await call('/delete-style', { key: it.key })
      toast(r.message || '已删除')
      await loadStyles()
    } catch (e) { toast('删除失败：' + e.message) }
    setBusy('')
  }

  const items = list || []
  return h(ui.Card, { title: '人格备份与撤销' },
    h('p', { className: 'ab-note' },
      '她每次自主改人格前，都会先把当前版本备份到这里。恢复前也会再备份一次当前版本，所以恢复本身也能反悔。'),
    h('div', { style: { display: 'flex', gap: 8, margin: '8px 0' } },
      h(ui.Btn, { onClick: load, disabled: busy !== '' }, '刷新备份'),
      items[0]
        ? h(ui.Btn, { onClick: () => restore(items[0].name), disabled: busy !== '' }, busy ? '处理中……' : '撤销最近一次')
        : null,
      h('span', { className: 'ab-note', style: { alignSelf: 'center' } },
        items.length ? `共 ${items.length} 份备份` : '还没有备份'),
    ),
    items.length
      ? items.map((it) => h('div', {
          key: it.name,
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, padding: '8px 0', borderTop: '1px solid rgba(255,255,255,.08)',
          },
        },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: 13, wordBreak: 'break-all' } }, it.name),
            h('div', { className: 'ab-note', style: { marginTop: 2 } },
              `${new Date(it.at).toLocaleString()} · ${Math.round(it.size / 1024)} KB`),
          ),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(ui.Btn, { onClick: () => restore(it.name), disabled: busy !== '' },
              busy === it.name ? '恢复中……' : '恢复'),
            h(ui.Btn, { onClick: () => remove(it.name), disabled: busy !== '' }, '删除'),
          ),
        ))
      : h('p', { className: 'ab-note' }, '她改过一次人格后，这里就会出现第一份备份。'),
    h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.08)' } },
      h('p', { className: 'ab-note', style: { marginBottom: 8 } },
        '这里只显示归纳后的群友说话样本，不展示聊天原文。清空或删除只影响「学习群友说话方式」，人格和人格备份不会动。'),
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        h(ui.Btn, { onClick: loadStyles, disabled: busy !== '' }, '刷新样本'),
        h(ui.Btn, { onClick: () => setStylesOpen((v) => !v), disabled: busy !== '' }, stylesOpen ? '折叠样本' : '展开样本'),
        h(ui.Btn, { onClick: clearStyles, disabled: busy !== '' }, busy === 'styles' ? '清空中……' : '清空群友说话样本'),
        h('span', { className: 'ab-note', style: { alignSelf: 'center' } },
          styles ? `共 ${styles.length} 位群友` : '加载中……'),
      ),
      stylesOpen
        ? (styles?.length
          ? styles.map((it) => h('div', {
              key: it.key,
              style: { padding: '8px 0', borderTop: '1px solid rgba(255,255,255,.08)' },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                h('div', { style: { fontSize: 13 } }, `${it.name} · 群 ${it.groupId} · ${it.count} 条样本`),
                h(ui.Btn, { onClick: () => removeStyle(it), disabled: busy !== '' },
                  busy === 'style:' + it.key ? '删除中……' : '删除'),
              ),
              h('div', { className: 'ab-note', style: { marginTop: 4, whiteSpace: 'pre-wrap' } }, it.summary || '样本不足'),
            ))
          : h('p', { className: 'ab-note' }, styles ? '还没有学到群友说话样本。' : '加载中……'))
        : h('p', { className: 'ab-note' }, '已折叠。点「展开样本」查看归纳结果。'),
    ),
  )
}
