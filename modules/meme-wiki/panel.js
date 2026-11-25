// 梗库面板：统计、开关、试查都放一张卡里
const { useState, useEffect } = React

return function MemeWikiPanel({ settings, save, toast }) {
  const [stat, setStat] = useState(null)
  const [busy, setBusy] = useState('')
  const [cfg, setCfg] = useState({ ...settings })
  // 数字框先存草稿，别一边打字一边把值弹回去
  const [draft, setDraftNum] = useState({ maxHints: settings.maxHints ?? 2, hintChars: settings.hintChars ?? 300, toolChars: settings.toolChars ?? 1600, syncHours: settings.syncHours ?? 12 })
  const editNum = (key, raw) => setDraftNum((d) => ({ ...d, [key]: raw }))
  const commitNum = (key, min, max, fallback) => {
    const n = Number(draft[key])
    const v = Math.min(max, Math.max(min, Number.isFinite(n) && n !== 0 ? n : fallback))
    setDraftNum((d) => ({ ...d, [key]: v }))
    put({ [key]: v })
  }
  const [q, setQ] = useState('')
  const [ans, setAns] = useState('')
  // 手动补词条
  const [nt, setNt] = useState('')
  const [na, setNa] = useState('')
  const [nx, setNx] = useState('')
  // 我加的梗条（只列 manual = 1 的）
  const [manual, setManual] = useState([])
  // 词条导入（模块不带词库，第一次要自己拉）
  const [imp, setImp] = useState(null)
  const loadImp = async () => {
    try { setImp(await call('/import-status')) } catch (e) { /* 忽略 */ }
  }
  const [confirmDel, setConfirmDel] = useState('')

  const loadManual = async () => {
    try { const r = await call('/manual'); setManual(r.items || []) } catch (e) { /* 忽略 */ }
  }

  const load = async () => {
    try { setStat(await call('/stats')) } catch (e) { toast('读统计失败：' + e.message) }
  }
  useEffect(() => { load(); loadManual(); loadImp() }, [])
  // 保存后父级会把新设置传下来，这里跟着更新，别再用挂载时的旧值
  useEffect(() => { setCfg({ ...settings }) }, [JSON.stringify(settings)])
  // 导入中每 3 秒刷进度
  useEffect(() => {
    if (!(imp && imp.running)) return
    const id = setInterval(async () => { await loadImp(); await load() }, 3000)
    return () => clearInterval(id)
  }, [imp && imp.running])

  const put = async (patch) => {
    const next = { ...cfg, ...patch }
    setCfg(next)
    await save(patch)
  }

  const HINT_MIN = 20
  const HINT_MAX = 4000
  const hintChars = Math.min(HINT_MAX, Math.max(HINT_MIN, Number(cfg.hintChars) || 300))

  const box = (label, value, note) => h('div', { style: { minWidth: 110 } },
    h('div', { className: 'ab-small ab-muted' }, label),
    h('div', { style: { fontSize: 19, fontWeight: 600 } }, value),
    note ? h('div', { className: 'ab-small ab-muted' }, note) : null)

  const row = (label, hint, control) => h(ui.Row, { label, hint }, control)

  return h(ui.Card, { title: '梗百科', desc: '命中就塞进上下文，用不上就当没看见' },
    stat ? h('div', { className: 'ab-flex', style: { gap: 18, flexWrap: 'wrap', marginBottom: 12 } },
      box('条目', stat.total, '条'),
      box('中位', stat.p50 + ' 字', '最长 ' + stat.maxLen),
      box('九成在', stat.p90 + ' 字', '单条全貌'),
      box('实际注入', hintChars + ' 字', '超出就截断'),
      box('关键词', stat.keywords, '标题+别名')
    ) : h('div', { className: 'ab-small ab-muted' }, '读统计中…'),

    row('开梗库', '关掉就不匹配、不注入', h(ui.Switch, { on: cfg.enabled !== false, onChange: (v) => put({ enabled: v }) })),
    row('一条消息最多给几个梗', '1~6，默认 2', h('input', {
      className: 'ab-input', type: 'number', min: 1, max: 6, value: draft.maxHints,
      style: { width: 80 },
      onChange: (e) => editNum('maxHints', e.target.value),
      onBlur: () => commitNum('maxHints', 1, 6, 2),
      onKeyDown: (e) => { if (e.key === 'Enter') commitNum('maxHints', 1, 6, 2) },
    })),
    row('每个梗最多给多少字', '默认 700；20~4000；库里中位 ' + ((stat && stat.p50) || '?') + '、九成 ' + ((stat && stat.p90) || '?') + '、最长 ' + ((stat && stat.maxLen) || '?'), h('input', {
      className: 'ab-input', type: 'number', min: HINT_MIN, max: HINT_MAX, step: 20, value: draft.hintChars,
      style: { width: 90 },
      onChange: (e) => editNum('hintChars', e.target.value),
      onBlur: () => commitNum('hintChars', HINT_MIN, HINT_MAX, 300),
      onKeyDown: (e) => { if (e.key === 'Enter') commitNum('hintChars', HINT_MIN, HINT_MAX, 300) },
    })),
    row('工具返回最多多少字', '用户问来历/细节时她自己会调工具查；给太长会占上下文', h('input', {
      className: 'ab-input', type: 'number', min: 40, max: 4000, step: 100, value: draft.toolChars,
      style: { width: 90 },
      onChange: (e) => editNum('toolChars', e.target.value),
      onBlur: () => commitNum('toolChars', 40, 4000, 1600),
      onKeyDown: (e) => { if (e.key === 'Enter') commitNum('toolChars', 40, 4000, 1600) },
    })),
    row('自动补新梗', '发现新词条会自动重建索引', h(ui.Switch, { on: cfg.autoSync !== false, onChange: (v) => put({ autoSync: v }) })),
    row('隔几小时补一次', '1~720', h('input', {
      className: 'ab-input', type: 'number', min: 1, max: 720, value: draft.syncHours,
      style: { width: 80 },
      onChange: (e) => editNum('syncHours', e.target.value),
      onBlur: () => commitNum('syncHours', 1, 720, 12),
      onKeyDown: (e) => { if (e.key === 'Enter') commitNum('syncHours', 1, 720, 12) },
    })),

    h('div', { className: 'ab-small ab-muted', style: { marginTop: 10 } },
      '上次补新：' + (stat && stat.lastSync ? new Date(stat.lastSync).toLocaleString('zh-CN') : '还没补过')),

    h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 12, flexWrap: 'wrap' } },
      h(ui.Btn, { small: true, onClick: load }, '刷新统计'),
      h(ui.Btn, {
        small: true,
        onClick: async () => {
          setBusy('sync')
          try {
            const r = await call('/sync')
            toast(r.added ? ('补了 ' + r.added + ' 条') : '没有新梗')
            await load()
          } catch (e) { toast('补新失败：' + e.message) }
          setBusy('')
        },
      }, busy === 'sync' ? '正在补…' : '立刻补新梗')
    ),

    h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 14 } },
      h('input', {
        className: 'ab-input', placeholder: '试查一个梗，比如 破防', value: q,
        style: { flex: 1 }, onChange: (e) => setQ(e.target.value),
      }),
      h(ui.Btn, {
        small: true,
        onClick: async () => {
          if (!q.trim()) return
          try { const r = await call('/peek?q=' + encodeURIComponent(q.trim())); setAns(r.text || '库里没有') }
          catch (e) { setAns('查失败：' + e.message) }
        },
      }, '查')
    ),
    ans ? h('div', { className: 'ab-small', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, ans) : null,

    h('div', { style: { marginTop: 18, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.08)' } },
      h('div', { className: 'ab-small ab-muted' }, '词条库'),
      (stat && stat.total)
        ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
          '库里 ' + stat.total + ' 条' + (imp && imp.importedAt ? '；上次导入 ' + new Date(imp.importedAt).toLocaleString('zh-CN') : ''))
        : h('div', { className: 'ab-small', style: { marginTop: 6 } },
          '模块不自带词库（词条来自公开梗站，不便随模块分发）。第一次使用请导入一次，约 2 分钟。'),
      h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h(ui.Btn, {
          small: true,
          onClick: async () => {
            try {
              const r = await call('/import', {})
              toast(r.message || '开始导入')
              await loadImp()
            } catch (e) { toast('导入失败：' + e.message) }
          },
        }, (imp && imp.running) ? '正在导入…' : ((stat && stat.total) ? '重新全量导入' : '从梗站导入词条')),
        h(ui.Btn, { small: true, onClick: async () => { await loadImp(); await load(); toast('已刷新') } }, '看进度')
      ),
      (imp && imp.progress)
        ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
          '已拉 ' + (imp.progress.fetched || 0) + ' 条（' + (imp.progress.pages || 0) + ' 页）' + (imp.running ? '，导入中…' : '，导入结束'))
        : null
    ),

    h('div', { style: { marginTop: 18, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,.08)' } },
      h('div', { className: 'ab-small ab-muted' }, '补一条梗（只写进本地库，不联网）'),
      h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input', placeholder: '标题，比如 他急了', value: nt, style: { flex: '1 1 180px' },
          onChange: (e) => setNt(e.target.value),
        }),
        h('input', {
          className: 'ab-input', placeholder: '别名，逗号分隔（可空）', value: na, style: { flex: '1 1 180px' },
          onChange: (e) => setNa(e.target.value),
        })
      ),
      h('textarea', {
        className: 'ab-input', placeholder: '正文：这个梗什么意思、怎么用', value: nx,
        style: { width: '100%', minHeight: 70, marginTop: 8 },
        onChange: (e) => setNx(e.target.value),
      }),
      h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8 } },
        h(ui.Btn, {
          small: true,
          onClick: async () => {
            if (!nt.trim() || !nx.trim()) { toast('标题和正文都要填'); return }
            setBusy('add')
            try {
              const r = await call('/add', { title: nt.trim(), aliases: na.trim(), text: nx.trim() })
              toast(r.message || (r.ok ? '已加入' : '没加成功'))
              if (r.ok) { setNt(''); setNa(''); setNx(''); await load(); await loadManual() }
            } catch (e) { toast('加失败：' + e.message) }
            setBusy('')
          },
        }, busy === 'add' ? '正在加…' : '加到库里')
      ),
      // 我加的梗条：只列 manual = 1 的，带二次确认删除
      manual.length
        ? h('div', { style: { marginTop: 12 } },
          h('div', { className: 'ab-small ab-muted' }, '我加的（' + manual.length + ' 条，只有这些能删）'),
          manual.map((it) => h('div', { key: it.title, className: 'ab-flex', style: { gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
              h('div', { style: { fontSize: 14 } }, it.title),
              h('div', { className: 'ab-small ab-muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.preview || '（无正文）')
            ),
            confirmDel === it.title
              ? h('div', { className: 'ab-flex', style: { gap: 6 } },
                h(ui.Btn, {
                  small: true,
                  onClick: async () => {
                    try {
                      const r = await call('/del', { title: it.title })
                      toast(r.message || '已删')
                      if (r.ok) { setConfirmDel(''); await loadManual() }
                    } catch (e) { toast('删失败：' + e.message) }
                  },
                }, '真删'),
                h(ui.Btn, { small: true, onClick: () => setConfirmDel('') }, '取消')
              )
              : h(ui.Btn, { small: true, onClick: () => setConfirmDel(it.title) }, '删')
          ))
        )
        : h('div', { className: 'ab-small ab-muted', style: { marginTop: 10 } }, '还没手动加过词条'),
      h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 8 } },
        h(ui.Btn, { small: true, onClick: loadManual }, '刷新我加的')
      )
    )
  )
}
