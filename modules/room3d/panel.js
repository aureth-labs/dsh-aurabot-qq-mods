return function Panel() {
  return h(ui.Card, { title: '房间' },
    h('div', { className: 'ab-note', style: { marginBottom: '10px' } },
      '房间页面、3D 资产和房间状态都由 Aurabot 自己托管。屋里一开始是空的，'
      + '右上角「✎ 家具」可以自己摆放。默认管理密码见模块说明，记得改掉。'
    ),
    h('iframe', {
      src: '/aurabot/api/ext/room3d/page',
      style: { width: '100%', height: '80vh', border: '0', borderRadius: '10px', background: '#05070f' },
      title: '房间',
    })
  )
}
