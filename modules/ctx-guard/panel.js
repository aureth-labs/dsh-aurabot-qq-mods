// panel.js —— 上下文守门面板：看各会话 token 用量，调提醒线
const { useState, useEffect, useCallback } = React

const fmtK = (n) => {
  if (n === null || n === undefined) return '—'
  return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n)
}
const fmtTime = (at) => {
  if (!at) return '—'
  const d = new Date(Number(at))
  const two = (n) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const shortId = (chatId) => {
  const s = String(chatId || '')
  if (s.startsWith('group:')) return '群 ' + s.slice(6)
  if (s.startsWith('private:')) return '私聊 ' + s.slice(8, 13) + '…'
  return s
}

function NumField({ label, hint, value, min, max, step, onSave }) {
  const [v, setV] = useState(String(value ?? ''))
  useEffect(() => { setV(String(value ?? '')) }, [value])
  const commit = () => {
    const n = Number(v)
    if (!Number.isFinite(n)) { setV(String(value ?? '')); return }
    const clamped = Math.min(max || 1e9, Math.max(min || 0, n))
    if (clamped !== value) onSave(clamped)
    setV(String(clamped))
  }
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontSize: 13 } }, label),
      hint ? h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.35 } }, hint) : null),
    h('input', {
      type: 'number', value: v, min, max, step,
      onChange: (e) => setV(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => { if (e.key === 'Enter') commit() },
      style: {
        width: 96, padding: '5px 7px', borderRadius: 6, fontSize: 13, textAlign: 'right',
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
      },
    }))
}

function Row({ it, onMeasure, onNotify, busy }) {
  const pct = it.ratio === null ? 0 : Math.round(it.ratio * 100)
  const color = pct >= 100 ? '#d9534f' : pct >= 70 ? '#e0a132' : '#3a8ee6'
  return h('div', { style: { padding: '10px 0', borderTop: '1px solid rgba(128,128,128,.18)' } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 } },
      h('div', { style: { flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        shortId(it.chatId)),
      h('div', { style: { fontSize: 13, color, fontVariantNumeric: 'tabular-nums' } },
        fmtK(it.tokens), h('span', { className: 'ab-muted', style: { fontSize: 11 } }, ' / ' + fmtK(it.line)))),
    h('div', { style: { height: 5, borderRadius: 3, background: 'rgba(128,128,128,.2)', overflow: 'hidden' } },
      h('div', { style: { width: Math.min(100, pct) + '%', height: '100%', background: color, transition: 'width .3s' } })),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap' } },
      it.window ? h('span', null, `窗口 ${fmtK(it.window)}`) : null,
      it.avgDelta ? h('span', { style: { color: it.avgDelta > 4000 ? '#d9534f' : 'inherit' } },
        `近 ${it.samples} 轮平均 +${fmtK(it.avgDelta)}/轮`) : null,
      it.lastNotify ? h('span', null, `上次提醒 ${fmtTime(it.lastNotify)}`) : null),
    h('div', { style: { marginTop: 7, display: 'flex', gap: 6 } },
      h(ui.Btn, { small: true, disabled: busy, onClick: () => onMeasure(it.chatId) }, '测一次'),
      h(ui.Btn, { small: true, disabled: busy, onClick: () => onNotify(it.chatId) }, '试发提醒')))
}

return function Panel({ settings, save, toast }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [diag, setDiag] = useState(null)
  const [pool, setPool] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await call('/state'))
      setErr('')
    } catch (e) { setErr(String(e?.message || e)) }
  }, [])

  useEffect(() => { load(); doLoadPool() }, [load])
  useEffect(() => {
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [load])

  const set = (patch) => { save(patch); toast?.('已保存') }

  const doLoadPool = async () => {
    try { setPool(await call('/pool')) } catch (e) { toast?.('读取失败') }
  }
  const doGrow = async () => {
    setBusy(true)
    try {
      const r = await call('/grow', { n: 3 })
      toast?.(r?.added ? `新写了 ${r.added} 条，现在共 ${r.total} 条` : '没写出合格的（看日志）')
      await doLoadPool()
    } finally { setBusy(false) }
  }

  const doMeasure = async (chatId) => {
    setBusy(true)
    try {
      const r = await call('/measure', { chatId })
      toast?.(r?.ok ? `${shortId(chatId)}：${fmtK(r.tokens)}${r.window ? ' / ' + fmtK(r.window) : ''}` : (r?.message || '测不到'))
      await load()
    } finally { setBusy(false) }
  }

  const doNotify = async (chatId) => {
    setBusy(true)
    try {
      const r = await call('/notify', { chatId })
      toast?.(r?.message || (r?.ok ? '已发' : '发送失败'))
    } finally { setBusy(false) }
  }

  const doDiag = async () => {
    setBusy(true)
    try { setDiag(await call('/diag')) } catch (e) { setDiag({ steps: [], error: String(e?.message || e) }) }
    finally { setBusy(false) }
  }

  const items = data?.items || []

  return h('div', null,
    h(ui.Card, { title: '上下文守门' },
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 10, lineHeight: 1.5 } },
        '盯着每个聊天的 token 用量，到线就私聊提醒你。'),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 10, lineHeight: 1.5 } },
        '只提醒、不自动压缩——DSH 的压缩服务在模块侧取不到，压缩那步得你在 DSH 界面点 /compact。'),

      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' } },
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: 13 } }, '启用'),
          h('div', { className: 'ab-small ab-muted' }, '关掉就完全不检查')),
        h('input', {
          type: 'checkbox', checked: settings.enabled !== false,
          onChange: (e) => set({ enabled: e.target.checked }),
          style: { width: 18, height: 18 },
        })),
    ),

    h(ui.Card, { title: '各会话用量' },
      err ? h('div', { className: 'ab-small', style: { color: '#d9534f' } }, err) : null,
      items.length
        ? items.map((it) => h(Row, { key: it.chatId, it, busy, onMeasure: doMeasure, onNotify: doNotify }))
        : h('div', { className: 'ab-small ab-muted' }, data ? '还没有可测的会话（她说过话之后这里才会有）' : '读取中…'),
      h('div', { style: { marginTop: 10, display: 'flex', gap: 6 } },
        h(ui.Btn, { small: true, disabled: busy, onClick: load }, '刷新'),
        h(ui.Btn, { small: true, disabled: busy, onClick: doDiag }, '诊断')),
      diag
        ? h('div', { style: {
            marginTop: 10, padding: '8px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.7,
            background: 'rgba(128,128,128,.08)', fontFamily: 'ui-monospace,monospace',
          } },
            (diag.steps || []).map((s, i) => h('div', { key: i, style: { color: s.ok ? 'inherit' : '#d9534f' } },
              (s.ok ? '✅ ' : '❌ ') + s.name + '：' + (typeof s.value === 'object' ? JSON.stringify(s.value) : String(s.value)))),
            diag.error ? h('div', { style: { color: '#d9534f', marginTop: 4 } }, '错误：' + diag.error) : null)
        : null,
    ),

    h(ui.Card, { title: '提醒文案' },
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8, lineHeight: 1.5 } },
        `共 ${(pool?.base?.length || 0) + (pool?.generated?.length || 0)} 条。固定池 ${pool?.base?.length || 0} 条，模型扩写 ${pool?.generated?.length || 0} 条。`),
      h('div', { style: { marginBottom: 10, display: 'flex', gap: 6 } },
        h(ui.Btn, { small: true, disabled: busy, onClick: doLoadPool }, '刷新文案'),
        h(ui.Btn, { small: true, disabled: busy, onClick: doGrow }, '让模型再写几条')),
      (pool?.base || []).concat(pool?.generated || []).map((t, i) => h('div', {
        key: i,
        style: {
          padding: '7px 9px', marginBottom: 5, borderRadius: 6, fontSize: 12, lineHeight: 1.6,
          background: i >= (pool?.base?.length || 0) ? 'rgba(58,142,230,.08)' : 'rgba(128,128,128,.06)',
          whiteSpace: 'pre-wrap',
        },
      }, t)),
    ),

    h(ui.Card, { title: '提醒设置' },
      h(NumField, {
        label: '私聊提醒线', hint: '到这个 token 数就私聊告诉你。实测私聊一般 30k~133k',
        value: settings.notifyTokens, min: 10000, max: 900000, step: 5000,
        onSave: (n) => set({ notifyTokens: n }),
      }),
      h(NumField, {
        label: '群聊提醒线', hint: '群聊上下文价值低，通常设得比私聊低',
        value: settings.groupNotifyTokens, min: 10000, max: 900000, step: 5000,
        onSave: (n) => set({ groupNotifyTokens: n }),
      }),
      h(NumField, {
        label: '同一会话提醒间隔（分钟）', hint: '防止同一个会话反复提醒你',
        value: settings.notifyCooldownMin, min: 30, max: 1440, step: 30,
        onSave: (n) => set({ notifyCooldownMin: n }),
      }),
      h(NumField, {
        label: '每天最多提醒几次', hint: '全局上限，防刷屏',
        value: settings.dailyMax, min: 1, max: 20,
        onSave: (n) => set({ dailyMax: n }),
      }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid rgba(128,128,128,.15)', marginTop: 6 } },
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: 13 } }, '文案语气'),
          h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.35 } },
            '你和你那边的 bot 怎么相处，选贴合的。默认中性，谁用都不出戏')),
        h('select', {
          value: settings.tone || 'neutral',
          onChange: (e) => set({ tone: e.target.value }),
          style: { width: 150, padding: '5px 7px', borderRadius: 6, fontSize: 13,
            border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' },
        },
          h('option', { value: 'neutral' }, '中性（默认）'),
          h('option', { value: 'close' }, '亲近'),
          h('option', { value: 'plain' }, '极简'))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' } },
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: 13 } }, '让模型扩充文案'),
          h('div', { className: 'ab-small ab-muted' }, '每次提醒顺手多写几条存起来')),
        h('input', {
          type: 'checkbox', checked: settings.growByModel !== false,
          onChange: (e) => set({ growByModel: e.target.checked }),
          style: { width: 18, height: 18 },
        })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 6, lineHeight: 1.5 } },
        '称呼取自 AuraBot 的「主人昵称」设置。没填或填「你」时不带称呼。'),
    ),
  )
}
