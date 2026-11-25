return function Panel() {
  return h(ui.Card, { title: '星图' },
    h('div', { className: 'ab-note', style: { marginBottom: '10px' } },
      '数据来自 Aurabot 自己的记忆库（memory.sqlite）。点星星看正文，搜索框可以找记忆。'
    ),
    h('iframe', {
      src: '/aurabot/api/ext/starmap/page',
      style: { width: '100%', height: '78vh', border: '0', borderRadius: '10px', background: '#05070f' },
      title: '星图',
    })
  )
}
