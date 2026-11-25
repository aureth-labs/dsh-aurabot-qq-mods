// 记忆总库面板：收件箱 + 消化记录 + 判定规则速查。
// 契约同其他模块：整份源码给面板执行（React/h/ui/call 四个入参），最后 return 一个组件函数。
// call('/path') 走 /ext/memory-grade/<path>，和 index.mjs 里 api.route 注册的对上。

return function MemoryGradePanel({ toast }) {
  const [inbox, setInbox] = React.useState(null)
  const [stats, setStats] = React.useState(null)
  const [wrap, setWrap] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  // 2026-11-24 加的：记忆浏览/编辑
  const [mem, setMem] = React.useState({ items: [], total: 0, offset: 0 })
  const [memBusy, setMemBusy] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [cls, setCls] = React.useState('')
  const [openId, setOpenId] = React.useState('')
  const [editText, setEditText] = React.useState('')
  const [editTags, setEditTags] = React.useState('')
  const [editCls, setEditCls] = React.useState('')

  const load = () => {
    call('/inbox/stats').then(setStats).catch(() => setStats(null))
    call('/wrap/status').then(setWrap).catch(() => setWrap(null))
  }
  React.useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  const PAGE = 20
  const loadMem = async (offset = 0) => {
    setMemBusy(true)
    try {
      const p = []
      p.push('limit=' + PAGE)
      p.push('offset=' + offset)
      if (q.trim()) p.push('q=' + encodeURIComponent(q.trim()))
      if (cls) p.push('cls=' + cls)
      const r = await call('/mem/list?' + p.join('&'))
      if (r.ok) setMem({ items: r.items || [], total: r.total || 0, offset })
      else toast(r.message || '读不了记忆', 'err')
    } catch (e) {
      toast(e.message, 'err')
    }
    setMemBusy(false)
  }

  const openItem = async (id) => {
    if (openId === id) {
      setOpenId('')
      return
    }
    try {
      const r = await call('/mem/get?id=' + encodeURIComponent(id))
      if (!r.ok) {
        toast(r.message || '读不出来', 'err')
        return
      }
      const it = r.item || {}
      setOpenId(id)
      setEditText(String(it.text || ''))
      setEditTags((it.tags || []).join(','))
      setEditCls(String(it.cls || ''))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const saveItem = async () => {
    if (!openId) return
    setMemBusy(true)
    try {
      const body = { id: openId, text: editText, cls: editCls }
      const tags = editTags
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      if (tags.length) body.tags = tags
      const r = await call('/mem/update', { method: 'POST', body })
      if (r.ok) {
        toast('改好了' + (r.synced ? '，已同步' : ''), 'ok')
        setOpenId('')
        loadMem(mem.offset)
      } else toast(r.message || '没改成', 'err')
    } catch (e) {
      toast(e.message, 'err')
    }
    setMemBusy(false)
  }

  const fmt = (ts) =>
    ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

  const dryRun = async () => {
    setBusy('dry')
    try {
      const r = await call('/inbox/absorb?dry=1')
      if (r.ok) {
        const by = Object.entries(r.bySrc || {}).map(([k, v]) => k + ' ' + v).join('、')
        toast('待消化 ' + r.pending + ' 条' + (by ? '（' + by + '）' : ''), 'ok')
      } else toast(r.message || '没查成', 'err')
    } catch (e) {
      toast(e.message, 'err')
    }
    setBusy('')
  }

  const absorb = async () => {
    setBusy('run')
    try {
      const r = await call('/inbox/absorb')
      toast(r.ok ? r.message || '消化完了' : '没消化成：' + (r.message || '未知原因'), r.ok ? 'ok' : 'err')
      load()
    } catch (e) {
      toast(e.message, 'err')
    }
    setBusy('')
  }

  // 2026-11-24 修：/inbox/stats 返回的字段是 total 和 undone，原来这里找 pending，
  // 永远是 null，面板就一直卡在「加载中…」。改成读 undone（没处理完的条数）。
  const pending = stats && typeof stats.undone === 'number' ? stats.undone : (stats && typeof stats.total === 'number' ? stats.total : null)
  const history = (stats && stats.history) || []

  return h('div', { className: 'ab-grid' },

    // ---- 记忆库（查看 / 筛选 / 编辑）----
    h(ui.Card, {
      title: '记忆库',
      desc: '分页看全库，能按密级筛、按关键词搜。点一条展开全文，改完保存就写回库。置顶的那几条不给改，要改先解除置顶。',
    },
      h('div', { className: 'ab-flex', style: { gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input',
          placeholder: '搜关键词…',
          value: q,
          onChange: (e) => setQ(e.target.value),
          style: { flex: 1, minWidth: 140 },
        }),
        h('select', {
          className: 'ab-input',
          value: cls,
          onChange: (e) => setCls(e.target.value),
          style: { width: 120 },
        },
          h('option', { value: '' }, '全部密级'),
          h('option', { value: 'secret' }, '秘密'),
          h('option', { value: 'internal' }, '内部'),
          h('option', { value: 'public' }, '公开')),
        h(ui.Btn, { small: true, onClick: () => loadMem(0), disabled: memBusy }, '查'),
        h(ui.Btn, { small: true, onClick: () => loadMem(mem.offset + PAGE), disabled: memBusy }, '下一页'),
        h(ui.Btn, { small: true, onClick: () => loadMem(Math.max(0, mem.offset - PAGE)), disabled: memBusy || mem.offset === 0 }, '上一页')),

      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } },
        '共 ' + mem.total + ' 条，当前第 ' + (mem.offset + 1) + ' 到 ' + Math.min(mem.offset + PAGE, mem.total) + ' 条'),

      mem.items.length === 0
        ? h(ui.Empty, { icon: '🗂', text: '点「查」读一下，或者换个词再搜。' })
        : h('div', null,
            mem.items.map((it) => {
              const isOpen = openId === it.id
              const clsColor = it.cls === 'secret' ? '#c62828' : it.cls === 'public' ? '#2e7d32' : '#666'
              return h('div', {
                key: it.id,
                style: { borderBottom: '1px solid var(--ab-border, #eee)', padding: '6px 0' },
              },
                h('div', {
                  className: 'ab-small',
                  style: { cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'baseline' },
                  onClick: () => openItem(it.id),
                },
                  it.pin ? h('span', { style: { color: '#f57c00' } }, '📌') : null,
                  h('span', { style: { color: clsColor, flexShrink: 0 } }, '[' + (it.cls || '?') + ']'),
                  h('span', { style: { flex: 1 } }, it.text),
                  h('span', { className: 'ab-muted', style: { flexShrink: 0 } },
                    it.full > 60 ? '…展开' : '')),

                isOpen
                  ? h('div', { style: { marginTop: 8, paddingLeft: 10 } },
                      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } },
                        '来源 ' + (it.source || '?') + ' · ' +
                        (it.chatId || '无会话') + ' · ' +
                        fmt(it.at) + ' · 重要度 ' + it.imp),
                      it.pin
                        ? h('div', { className: 'ab-small', style: { color: '#f57c00' } }, '置顶的不给改')
                        : h('div', null,
                            h('textarea', {
                              className: 'ab-input',
                              value: editText,
                              onChange: (e) => setEditText(e.target.value),
                              rows: 4,
                              style: { width: '100%', marginBottom: 6 },
                            }),
                            h('div', { className: 'ab-flex', style: { gap: 6, marginBottom: 6 } },
                              h('input', {
                                className: 'ab-input',
                                value: editTags,
                                placeholder: '标签，逗号分隔',
                                onChange: (e) => setEditTags(e.target.value),
                                style: { flex: 1 },
                              }),
                              h('select', {
                                className: 'ab-input',
                                value: editCls,
                                onChange: (e) => setEditCls(e.target.value),
                                style: { width: 110 },
                              },
                                h('option', { value: 'secret' }, '秘密'),
                                h('option', { value: 'internal' }, '内部'),
                                h('option', { value: 'public' }, '公开'))),
                            h(ui.Btn, { small: true, onClick: saveItem, disabled: memBusy }, '保存'),
                            ' ',
                            h(ui.Btn, { small: true, onClick: () => setOpenId(''), disabled: memBusy }, '取消')))
                    : null)
            }))),

    // ---- 收件箱 ----
    h(ui.Card, {
      title: '收件箱',
      desc: '外面平台（B站、抖音、贴吧、小黑盒、热榜、空间日记、工具产出）进来的东西先攒在这儿，每天 4:10 和 16:10 各消化一次，提炼成记忆写进库。聊天本身不走这儿——插件自己会提炼。',
    },
      pending === null
        ? h(ui.Empty, { icon: '⏳', text: '加载中…' })
        : h('div', null,
            h('div', { className: 'ab-small', style: { marginBottom: 8 } },
              '现在攒着 ', h('strong', null, pending), ' 条'),
            h('div', { className: 'ab-flex', style: { gap: 8 } },
              h(ui.Btn, { small: true, onClick: dryRun, disabled: busy !== '' },
                busy === 'dry' ? '查着呢…' : '看看有什么'),
              h(ui.Btn, { small: true, onClick: absorb, disabled: busy !== '' || !pending },
                busy === 'run' ? '消化中…' : '现在消化一次')),
            // 待消化的前几条，直接列出来
            (stats && stats.sample && stats.sample.length)
              ? h('div', { style: { marginTop: 10 } },
                  h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } },
                    '前 ' + stats.sample.length + ' 条预览：'),
                  stats.sample.map((it, i) =>
                    h('div', {
                      key: i,
                      className: 'ab-small',
                      style: { padding: '4px 0', borderBottom: '1px solid var(--ab-border, #eee)' },
                    },
                      h('span', { className: 'ab-muted' }, '[' + (it.src || '?') + '] '),
                      it.text)))
              : null)),

    // ---- 消化记录 ----
    h(ui.Card, {
      title: '消化记录',
      desc: '每消化一次留一条：进了多少条、从哪来、写进库几条。只留最近 20 次。',
    },
      history.length === 0
        ? h(ui.Empty, { icon: '📥', text: '还没消化过。' })
        : history.slice(0, 20).map((rec, i) =>
            h('div', {
              key: rec.at || i,
              className: 'ab-small',
              style: { padding: '6px 0', borderBottom: '1px solid var(--ab-border, #eee)' },
            },
              h('span', { className: 'ab-muted' }, fmt(rec.at) + '  '),
              '收了 ' + (rec.rows || 0) + ' 条，写进 ' + (rec.added || 0) + ' 条',
              rec.bySrc && Object.keys(rec.bySrc).length
                ? h('span', { className: 'ab-muted' }, '（' + Object.entries(rec.bySrc).map(([k, v]) => k + ' ' + v).join('、') + '）')
                : null))),

    // ---- 自动盖章状态 ----
    h(ui.Card, {
      title: '自动盖章',
      desc: '模块启动时把插件的 memory.add 包一层，写库前自动规整标签、补重要度。不改插件源码，升级也不受影响。',
    },
      wrap === null
        ? h(ui.Empty, { icon: '⏳', text: '加载中…' })
        : h('div', { className: 'ab-small', style: { lineHeight: 1.9 } },
            h('div', null,
              '接管状态：',
              wrap.wrapped
                ? h('strong', { style: { color: '#2e7d32' } }, '已接管')
                : h('strong', { style: { color: '#c62828' } }, '没接管上')),
            wrap.wrapped
              ? h('div', { className: 'ab-muted' }, '写入时自动规整标签、补重要度、判密级——全在模块这边做，插件那边七个开关都已关掉，不再自己判。')
              : h('div', { className: 'ab-muted' }, '模块没接管到插件的写入入口。可能插件版本变了，或者模块没启动。'),
            h('div', { className: 'ab-muted', style: { marginTop: 4 } },
              '想在设置里关掉：找到「写库前自动盖章」开关。'))),

    // ---- 判定规则速查 ----
    h(ui.Card, {
      title: '判定规则速查',
      desc: '不用记，出问题时来这儿对一眼。',
    },
      h('div', { className: 'ab-small', style: { lineHeight: 1.9 } },
        h('div', null, h('strong', null, '密级')),
        h('div', { className: 'ab-muted', style: { paddingLeft: 12 } },
          'secret ← 家里人真名 / 家人 QQ / 机密词 / 带「家人」标签',
          h('br'), 'secret ← 家人私聊里说的「爸爸」「妈妈」这类称呼（群里说的不算）',
          h('br'), 'public ← 带「知识」标签 / 看来的东西 / 群聊来源',
          h('br'), 'internal ← 其余',
          h('br'), h('br'),
          '纠正原则：只往上调不往下压。已经判严的不会被判松，空了才补。'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '红线是干嘛的')),
        h('div', { className: 'ab-muted', style: { paddingLeft: 12 } },
          '记忆一条不漏，对话全都会想起来。密级不是锁住记性，是标明哪条能往外说。',
          h('br'), '就像人不会屏蔽自己的记忆，但知道什么话能对谁讲。',
          h('br'), h('br'),
          '三道兜底：',
          h('br'), '· 召回时逐条标「机密」，提醒这句只能和主人说；',
          h('br'), '· 实时大脑跨会话注入时按密级筛，secret 的不带出去；',
          h('br'), '· 群里和外人面前，secret 的一律不提。'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '时效')),
        h('div', { className: 'ab-muted', style: { paddingLeft: 12 } },
          '不过期 ← 置顶 / 规矩·事实·长期印象·约定 / 知识 / 空间日记 / 科普实测 / 历史事件 / 做过的事 / 已完成 / 定下来的决定 / 群友的事 / 现状条件 / 看过的内容',
          h('br'), '会过期 ← 身体状态（3/7/30天/5年四档）、日程 7 天、行情 3 天、位置 1 天、心情 1 天'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '重要度')),
        h('div', { className: 'ab-muted', style: { paddingLeft: 12 } },
          '置顶固定 1；其余按内容给 0~1，模型没给就用时效建议值。'))),
    // ---- 实时大脑（记录 + 注入，合成一栏说明）----
    h(ui.Card, {
      title: '实时大脑',
      desc:
        '把「刚才各会话发生了什么」实时记下来，再按需带进上下文。' +
        '分两半：记录在设置里是「实时大脑 · 记录」，注入是「实时大脑 · 注入」。',
    },
      h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.9 } },
        h('div', null, h('strong', null, '怎么运转')),
        h('div', { style: { paddingLeft: 12 } },
          '1. 每条原话进实时库时，当场盖密级（秘密 / 内部 / 公开）；',
          h('br'), '2. 过了「保留天数」一律清掉，不管有没有提炼进总库；',
          h('br'), '3. 注入时只取「回看分钟」内的活跃会话，字数超了截断；',
          h('br'), '4. 秘密的那几条只在原会话里留，绝不跨会话带出去。'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '为什么要盖密级')),
        h('div', { style: { paddingLeft: 12 } },
          '不然在群里聊天时，可能把私聊里的话带出来。',
          '盖了密级就有一道兜底：能想起来，但知道在哪不能说。'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '建议')),
        h('div', { style: { paddingLeft: 12 } },
          '先把「家里人叫什么」「家人 QQ」填好，再打开注入。',
          '不填密级判不准，这道兜底就形同虚设。'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '与其他插件的重复')),
        h('div', { style: { paddingLeft: 12 } },
          '插件自带的「跨会话感知」做的是同一件事。两个都开就会重复注入，',
          '建议只留一个：用模块这套就把插件的关掉。'))),

    // ---- 说明（放最末，别挡在前面）----
    h(ui.Card, {
      title: '这套在管什么',
      desc: '想了解原理再看，平时不用管这儿。',
    },
      h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.8 } },
        '记忆写进来的时候，自动判密级（能不能往外说）、贴标签（是哪一类）、算时效（多久之后算「当时」）。',
        h('br'), '置顶注入、当前时间、短句检索、实时大脑、去重加固、过目不忘——原来分散在插件补丁里，现在都收拢到模块这边，插件升级冲不掉。',
        h('br'), h('br'),
        '· 密级三档：secret（只能和主人私聊说）/ internal（内部）/ public（能公开）；',
        h('br'), '· 过了保质期不删，只标「当时：」，该想起来还是想得起来；',
        h('br'), '· 置顶的那几条一律机密、永久有效、重要度固定 1，不参与时效判定。'),
        h('div', { style: { marginTop: 8 } }, h('strong', null, '谁负责删')),
        h('div', { className: 'ab-muted', style: { paddingLeft: 12 } },
          '这个模块只管整理，不管删除。该休眠的转休眠、该归档的转归档，一条都不删。',
          h('br'), '真正的删除由 aurabot 插件自己完成——它在每天整理时按自己的遗忘曲线清掉该清的。',
          h('br'), '所以想彻底留住什么，就把它置顶，或者让它带上「知识」标签（配合「过目不忘」开关）。')),

  )
}
