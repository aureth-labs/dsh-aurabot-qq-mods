// 热榜巡游面板：简介卡 + 手动逛一轮 + 巡游记录。
// 契约（见插件 client.js ExtPanel）：整份源码交给面板的受限作用域执行（React/h/ui/call 四个入参），
// 最后 return 一个组件函数；call('/path') 自动 GET/POST 模块路由 /ext/tophub< path >。
// 设置表单走模块 settings 声明自动生成（index.mjs），这里只负责简介与记录。

return function TophubPanel({ toast }) {
  const [state, setState] = React.useState(null)
  const [history, setHistory] = React.useState(null)
  const [busy, setBusy] = React.useState('')

  const load = () => {
    call('/state').then(setState).catch((e) => toast(e.message, 'err'))
    call('/history').then((r) => setHistory(r.items || [])).catch(() => setHistory([]))
  }
  React.useEffect(() => { load() }, [])

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

  const runNow = async () => {
    setBusy('run')
    try {
      const r = await call('/run')
      toast(r.ok ? r.message : '这轮没逛成：' + (r.message || '未知原因'), r.ok ? 'ok' : 'err')
      load()
    } catch (e) { toast(e.message, 'err') }
    setBusy('')
  }

  const touring = state && state.touring

  return h('div', { className: 'ab-grid' },
    // ---- 简介 ----
    h(ui.Card, { title: '什么是热榜巡游', desc: 'ta会像刷 B 站一样定时「逛」全网热榜：从榜单里挑几个感兴趣的（微博热搜、抖音热点、知乎热榜……），看完说说自己的感受，把可能合你胃口的热点私聊分享给你，并且把这轮经历写进记忆——之后聊天里聊到相关话题，ta能自然接上。全程只看不发言：不评论、不发帖、不用登录任何账号。' },
      h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.8 } },
        '· 数据来源：tophub.today 直连为主，打不开时自动换 60s 聚合接口兜底，结果缓存半小时，不会高频骚扰对方站点；',
        h('br'), '· 分享只会发给主人的 QQ 私聊，每场最多几条在下面设置里调（0 = 只看不分享）；',
        h('br'), '· 每轮逛完都会记进「记忆」（整理记忆时归为ta的经历）和本页的「巡游记录」；',
        h('br'), '· 聊天里也可以随口问ta「现在微博热搜有什么」「XX 今天热吗」，ta会用热榜工具现查现答。'),
      h('div', { className: 'ab-flex', style: { marginTop: 8 } },
        h(ui.Btn, { small: true, onClick: runNow, disabled: busy === 'run' || touring },
          busy === 'run' || touring ? '正在逛…' : '现在逛一轮'),
        state && state.lastTour ? h('span', { className: 'ab-small ab-muted' }, '上一轮 ' + fmt(state.lastTour) + ' 逛完：' + (state.recent || []).join('、')) : null)),
    // ---- 巡游记录 ----
    h(ui.Card, { title: '巡游记录', desc: '每轮逛完留一条：逛了哪些榜、当天热点、ta的感受、分享了什么。只留最近 50 轮。' },
      history === null ? h(ui.Empty, { icon: '⏳', text: '加载中…' })
        : history.length === 0 ? h(ui.Empty, { icon: '🔥', text: '还没逛过。点上面的「现在逛一轮」试试。' })
          : history.map((rec, i) => h(ui.Card, { key: rec.at || i, title: fmt(rec.at) + ' · ' + (rec.boards || []).join('、') },
              h('div', { className: 'ab-small', style: { lineHeight: 1.8 } },
                rec.feeling ? h('div', null, h('strong', null, '感受：'), rec.feeling) : null,
                (rec.shared || []).map((s, j) => h('div', { key: j, style: { marginTop: 4 } }, h('strong', null, '分享：'), s.text)),
                (rec.tops || []).map((t) => h('div', { key: t.node, className: 'ab-muted', style: { marginTop: 4 } }, t.node + '：' + (t.titles || []).join('、')))))),
      state && state.seenCount ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '已去重记住 ' + state.seenCount + ' 条分享，同一条不会打扰你两次。') : null),
  )
}
