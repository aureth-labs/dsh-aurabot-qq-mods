const { useState, useEffect, useRef } = React

const emptySource = { id: '', name: '', url: 'https://github.com/', branch: 'main', whitelist: '', blacklist: '', dependences: '', extensions: 'js py sh', enabled: true, autoAddCron: true, autoDelCron: false }
const inputStyle = { width: '100%', boxSizing: 'border-box', marginBottom: 6 }
const rowStyle = { borderTop: '1px solid var(--ab-border, #e5e7eb)', padding: '10px 0' }

return function Panel({ toast, settings, save }) {
  const [tab, setTab] = useState('subscriptions')
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const [source, setSource] = useState(null)
  const [scripts, setScripts] = useState(null)
  const [scriptSub, setScriptSub] = useState('')
  const [envForm, setEnvForm] = useState({ name: 'JD_COOKIE', value: '', remarks: '' })
  const [qr, setQr] = useState(null)
  const [log, setLog] = useState(null)
  const alive = useRef(true)

  const load = async () => {
    try { const r = await call('/state'); if (alive.current) setData(r) } catch (e) { toast(e.message, 'err') }
  }
  useEffect(() => {
    alive.current = true; load()
    const timer = setInterval(load, 3000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])
  const act = async (name, path, body, message) => {
    setBusy(name)
    try {
      const r = await call(path, body)
      if (!r || r.ok === false) toast((r && r.message) || '操作失败', 'err')
      else { toast(message || r.message || '完成', 'ok'); await load() }
      return r
    } catch (e) { toast(e.message, 'err'); return null } finally { setBusy('') }
  }
  const tabs = [['subscriptions', '订阅源'], ['tasks', '定时任务'], ['env', '环境变量'], ['logs', '运行日志']]
  const field = (key, label, type = 'text') => h('label', { style: { display: 'block', marginBottom: 6 } },
    h('span', { className: 'ab-small ab-muted' }, label),
    type === 'textarea'
      ? h('textarea', { className: 'ab-textarea', style: inputStyle, value: source[key] || '', onChange: (e) => setSource({ ...source, [key]: e.target.value }) })
      : h('input', { className: 'ab-input', style: inputStyle, value: source[key] ?? '', onChange: (e) => setSource({ ...source, [key]: e.target.value }) }))
  const boolField = (key, label, hint) => h('label', { className: 'ab-small', style: { display: 'block', margin: '5px 0' } },
    h('input', { type: 'checkbox', checked: source[key] === true, onChange: (e) => setSource({ ...source, [key]: e.target.checked }), style: { marginRight: 6 } }), label,
    hint ? h('span', { className: 'ab-muted', style: { marginLeft: 5 } }, hint) : null)

  const sourceEditor = source && h(ui.Card, { title: source.id && (data?.subscriptions || []).some((s) => s.id === source.id) ? '编辑订阅源' : '添加订阅源', desc: '切换 Git 地址或分支后，下次同步会重新拉取；已有任务默认保留并停用自动新增。' },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8 } },
      field('id', '订阅 ID（小写字母/数字/-）'), field('name', '显示名称'), field('url', 'Git 仓库地址（https://… .git）'), field('branch', '分支'), field('extensions', '文件后缀（空格分隔）')),
    field('whitelist', '脚本白名单正则'), field('blacklist', '脚本黑名单正则'), field('dependences', '依赖文件正则（仅记录，不执行）'),
    boolField('enabled', '启用订阅'), boolField('autoAddCron', '同步后自动写入定时任务', '识别到 Cron 的脚本会立即出现在任务列表；新任务默认停用，需逐条审批后启用'), boolField('autoDelCron', '同步后删除已消失的脚本任务'),
    h('div', { className: 'ab-flex' },
      h(ui.Btn, { kind: 'primary', small: true, disabled: busy === 'source-save', onClick: async () => {
        const exists = (data?.subscriptions || []).some((s) => s.id === source.id)
        const r = await act('source-save', exists ? '/subscription/update' : '/subscription/add', source, '订阅已保存')
        if (r?.ok) setSource(null)
      } }, '保存订阅'),
      h(ui.Btn, { small: true, onClick: () => setSource(null) }, '取消')))

  const subscriptions = h(ui.Card, { title: '脚本订阅', desc: '内置三个参考源；拉库只下载源码，不执行 sub_after、不自动安装依赖，也不自动运行脚本。',
    right: h(ui.Btn, { small: true, kind: 'primary', onClick: () => setSource({ ...emptySource }) }, '添加订阅') },
    h('div', { className: 'ab-note', style: { marginBottom: 8 } }, '第三方脚本可能访问账号、发表内容或触发风控。请先审查源码与许可证，再逐条启用任务。'),
    (data?.subscriptions || []).map((s) => h('div', { key: s.id, style: rowStyle },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
        h('div', { style: { minWidth: 220, flex: 1 } },
          h('strong', null, s.name), ' ', h('span', { className: 'ab-badge' }, s.id),
          h('div', { className: 'ab-small ab-muted', style: { wordBreak: 'break-all' } }, s.url, ' · ', s.branch),
          h('div', { className: 'ab-small' }, s.lastSyncStatus === 'ok' ? `已同步 ${s.commit || ''} · ${s.lastSyncMessage}` : s.lastSyncStatus === 'error' ? `同步失败：${s.lastSyncMessage}` : '尚未同步')),
        h('div', { className: 'ab-flex' },
          h(ui.Btn, { small: true, kind: 'primary', disabled: busy === 'sync-' + s.id, onClick: async () => {
            const r = await act('sync-' + s.id, '/subscription/sync', { id: s.id })
            if (r?.ok) {
              const parts = [`发现 ${r.scripts ?? 0} 个脚本`]
              if (r.added) parts.push(`新增 ${r.added} 个定时任务`)
              if (r.updated) parts.push(`更新 ${r.updated} 个 Cron`)
              if (r.tasks) parts.push(`当前共 ${r.tasks} 个任务`)
              toast(parts.join('，') + '（新任务默认停用，需审批后启用）', 'ok')
              if (r.added) setTab('tasks')
            }
          } }, busy === 'sync-' + s.id ? '同步中…' : '立即同步'),
          h(ui.Btn, { small: true, onClick: () => setSource({ ...s }) }, '切换源 / 编辑'),
          h(ui.Btn, { small: true, onClick: () => { setScriptSub(s.id); setScripts(null); setTab('tasks'); call('/scripts?id=' + encodeURIComponent(s.id)).then((r) => setScripts(r.items || [])) } }, '浏览脚本'),
          h(ui.Btn, { small: true, kind: 'ghost', onClick: async () => {
            if (!window.confirm('删除这个订阅及关联任务？本地源码默认保留。')) return
            await act('del-sub-' + s.id, '/subscription/delete', { id: s.id, purge: false })
          } }, '删除'))))),
    !data?.subscriptions?.length ? h(ui.Empty, { icon: '☁️', text: '还没有订阅，点右上角添加' }) : null)

  const confirmTask = (t, action) => {
    const s = (data?.subscriptions || []).find((x) => x.id === t.subscriptionId)
    return window.confirm(`${action}「${t.name}」？\n\n来源：${s?.url || t.subscriptionId}\n分支：${s?.branch || ''}\nCommit：${s?.commit || '未同步'}\n脚本：${t.file}\n\n审批将绑定当前来源、commit 和脚本 SHA-256。源码更新后旧审批自动失效。`)
  }
  const tasks = h(ui.Card, { title: '定时任务', desc: '任务默认停用、未审批且不注入凭据。手动运行和启用定时都需逐次确认；源码或来源变化会自动撤销审批。' },
    h('div', { className: 'ab-flex', style: { marginBottom: 8 } },
      h('select', { className: 'ab-input', value: scriptSub, onChange: (e) => { setScriptSub(e.target.value); setScripts(null) } },
        h('option', { value: '' }, '选择订阅以添加脚本'), (data?.subscriptions || []).map((s) => h('option', { key: s.id, value: s.id }, s.name))),
      h(ui.Btn, { small: true, disabled: !scriptSub, onClick: async () => { const r = await call('/scripts?id=' + encodeURIComponent(scriptSub)); setScripts(r.items || []); if (r.ok === false) toast(r.message, 'err') } }, '读取脚本')),
    scripts && h('div', { style: { marginBottom: 12, maxHeight: 260, overflow: 'auto', border: '1px solid var(--ab-border,#e5e7eb)', borderRadius: 6, padding: 6 } },
      h('div', { className: 'ab-small ab-muted' }, `发现 ${scripts.length} 个脚本，点击添加到任务列表`),
      scripts.map((s) => h('div', { key: s.id, className: 'ab-flex', style: { justifyContent: 'space-between', borderBottom: '1px dashed #ddd', padding: '4px 0' } },
        h('span', { className: 'ab-small', style: { wordBreak: 'break-all' } }, s.file, s.cron ? ` · ${s.cron}` : ' · 未识别 Cron'),
        h(ui.Btn, { small: true, disabled: s.subscribed, onClick: async () => {
          const cron = s.cron || window.prompt('这个脚本没有识别到 Cron，请输入 5 或 6 字段表达式', '0 8 * * *')
          if (!cron) return
          const r = await act('add-task-' + s.id, '/task/add', { subscriptionId: scriptSub, scriptId: s.id, cron }, '任务已添加（默认停用）')
          if (r?.ok) setScripts(scripts.map((x) => x.id === s.id ? { ...x, subscribed: true } : x))
        } }, s.subscribed ? '已添加' : '添加')))),
    (data?.tasks || []).map((t) => h('div', { key: t.id, style: rowStyle },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('div', { style: { flex: 1, minWidth: 220 } },
          h('strong', null, t.name), t.running ? h('span', { className: 'ab-badge', style: { marginLeft: 6 } }, '运行中') : null,
          h('div', { className: 'ab-small ab-muted' }, t.file), h('div', { className: 'ab-small' }, 'Cron：', t.cron, ' · 最近：', t.lastStatus || '未运行'),
          h('div', { className: 'ab-small' }, t.approval ? '✅ 已审批当前来源与内容' : '🔒 未审批', ' · 凭据：', t.envNames?.length ? t.envNames.join('、') : '不注入'),
          t.revokedReason ? h('div', { className: 'ab-note warn' }, t.revokedReason) : null),
        h(ui.Switch, { on: t.enabled === true, onChange: (v) => {
          if (v && !confirmTask(t, '确认当前源码并启用定时')) return
          act('toggle-' + t.id, '/task/update', { id: t.id, enabled: v, confirm: v }, v ? '已审批并启用定时' : '定时已停用')
        } }),
        h(ui.Btn, { small: true, kind: 'primary', disabled: t.running || settings.enabled !== true, onClick: () => {
          if (!confirmTask(t, '确认当前源码并手动运行')) return
          act('run-' + t.id, '/task/run', { id: t.id, confirm: true })
        } }, '确认并运行'),
        h(ui.Btn, { small: true, disabled: t.running, onClick: async () => {
          const available = (data?.env || []).map((x) => x.name)
          const value = window.prompt(`输入允许注入此任务的变量名，逗号分隔；留空表示不注入任何自定义凭据。\n可用：${available.join('、') || '暂无'}`, (t.envNames || []).join(','))
          if (value === null) return
          await act('env-task-' + t.id, '/task/env', { id: t.id, names: value.split(/[,，\s]+/).filter(Boolean) })
        } }, '变量授权'),
        t.running ? h(ui.Btn, { small: true, onClick: () => act('stop-' + t.id, '/task/stop', { id: t.id }) }, '停止') : null,
        h(ui.Btn, { small: true, onClick: async () => {
          const cron = window.prompt('修改 Cron（5 或 6 字段）', t.cron)
          if (cron && cron !== t.cron) await act('cron-' + t.id, '/task/update', { id: t.id, cron }, 'Cron 已修改')
        } }, '改 Cron'),
        h(ui.Btn, { small: true, kind: 'ghost', onClick: async () => { if (window.confirm('删除这个任务？订阅源码会保留。')) await act('del-task-' + t.id, '/task/delete', { id: t.id }) } }, '删除')))),
    !data?.tasks?.length ? h(ui.Empty, { icon: '⏱️', text: '还没有任务，从上方选择订阅并添加脚本' }) : null)

  const startQr = async () => {
    const r = await act('jd-qr', '/qr/jd/start', {}, '二维码已生成')
    if (r?.ok) setQr({ session: r.session, image: r.image, status: 'waiting' })
  }
  useEffect(() => {
    if (!qr?.session || qr.status === 'confirmed' || qr.status === 'expired') return
    const timer = setInterval(async () => {
      const r = await call('/qr/jd/poll', { session: qr.session })
      if (r.status === 'confirmed') { setQr({ ...qr, status: 'confirmed', message: r.message }); toast(r.message, 'ok'); load() }
      else if (r.status === 'expired') setQr({ ...qr, status: 'expired', message: r.message })
      else setQr((old) => old ? { ...old, status: r.status || 'waiting', message: r.message } : old)
    }, 2500)
    return () => clearInterval(timer)
  }, [qr?.session, qr?.status])

  const env = h(ui.Card, { title: '环境变量', desc: '同名变量在运行时用 & 连接，兼容青龙多账号写法；值只写本机，面板与日志均不回显。',
    right: h(ui.Btn, { small: true, kind: 'primary', onClick: startQr }, '京东扫码获取') },
    qr && h('div', { className: 'ab-note', style: { marginBottom: 10, textAlign: 'center' } },
      qr.image && qr.status !== 'confirmed' ? h('img', { src: qr.image, alt: '京东登录二维码', style: { width: 220, height: 220, display: 'block', margin: '0 auto 8px' } }) : null,
      h('div', null, qr.status === 'confirmed' ? '✅ ' : '', qr.message || '请使用京东 App 扫码并确认登录'),
      qr.status === 'expired' ? h(ui.Btn, { small: true, onClick: startQr }, '重新获取二维码') : null),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr 1fr auto', gap: 6, marginBottom: 12 } },
      h('input', { className: 'ab-input', placeholder: '变量名', value: envForm.name, onChange: (e) => setEnvForm({ ...envForm, name: e.target.value }) }),
      h('input', { className: 'ab-input', type: 'password', placeholder: '变量值（保存后不回显）', value: envForm.value, onChange: (e) => setEnvForm({ ...envForm, value: e.target.value }) }),
      h('input', { className: 'ab-input', placeholder: '备注', value: envForm.remarks, onChange: (e) => setEnvForm({ ...envForm, remarks: e.target.value }) }),
      h(ui.Btn, { small: true, kind: 'primary', onClick: async () => {
        const r = await act('env-save', '/env/save', envForm, '环境变量已保存')
        if (r?.ok) setEnvForm({ name: envForm.name, value: '', remarks: '' })
      } }, '添加')),
    (data?.env || []).map((item) => h('div', { key: item.id, className: 'ab-flex', style: { ...rowStyle, justifyContent: 'space-between' } },
      h('div', null, h('strong', null, item.name), h('span', { className: 'ab-badge', style: { marginLeft: 8 } }, '已配置'), h('div', { className: 'ab-small ab-muted' }, item.remarks || '无备注')),
      h(ui.Btn, { small: true, kind: 'ghost', onClick: async () => { if (window.confirm(`删除 ${item.name} 这条环境变量？`)) await act('env-del-' + item.id, '/env/delete', { id: item.id }) } }, '删除'))),
    !data?.env?.length ? h(ui.Empty, { icon: '🔐', text: '尚未配置环境变量，可扫码或手动添加' }) : null)

  const logs = h(ui.Card, { title: '运行日志', desc: '保留最近 100 条运行记录；Cookie、Token 与环境变量值会在写入和读取日志时脱敏。' },
    (data?.runs || []).map((r) => h('div', { key: r.id, className: 'ab-flex', style: { ...rowStyle, justifyContent: 'space-between' } },
      h('div', null, h('strong', null, r.taskName), h('span', { className: 'ab-badge', style: { marginLeft: 8 } }, r.status), h('div', { className: 'ab-small ab-muted' }, r.startedAt, r.code !== undefined ? ` · 退出码 ${r.code}` : '')),
      h(ui.Btn, { small: true, onClick: async () => { const result = await call('/log?id=' + encodeURIComponent(r.id)); setLog(result) } }, '查看日志'))),
    !data?.runs?.length ? h(ui.Empty, { icon: '📄', text: '还没有运行记录' }) : null,
    log && h('div', { style: { marginTop: 12 } },
      h('div', { className: 'ab-flex', style: { justifyContent: 'space-between' } }, h('strong', null, log.taskName), h(ui.Btn, { small: true, onClick: () => setLog(null) }, '关闭')),
      h('pre', { className: 'ab-small', style: { maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--ab-code-bg,#111827)', color: 'var(--ab-code-text,#e5e7eb)', padding: 12, borderRadius: 6 } }, log.content || '（空日志）')))

  return h('div', { className: 'ab-grid' },
    h(ui.Card, { title: '薅羊毛任务中心', desc: '订阅管理 · 青龙式 Cron · 环境变量 · 扫码登录 · 日志' },
      settings.enabled !== true ? h('div', { className: 'ab-note warn', style: { marginBottom: 8 } }, '⚠️ 脚本执行总开关处于关闭状态：可以管理订阅和环境变量，但任何任务（手动或定时）都不会运行。确认风险后在下方打开。') : h('div', { className: 'ab-note', style: { marginBottom: 8 } }, '✅ 脚本执行总开关已打开：任务仍需逐条审批后才能运行。'),
      h(ui.Row, { label: '允许执行脚本（总开关）', hint: '第三方脚本以本机权限运行，可能访问账号或触发风控，请确认后再打开' },
        h(ui.Switch, { on: settings.enabled === true, onChange: async (v) => {
          if (v && !window.confirm('打开总开关后，已审批的任务可以被手动运行，启用定时的任务会按计划自动执行。\n\n审批绑定当前来源与脚本内容，源码更新后必须重新确认。\n\n确认打开？')) return
          await save({ enabled: v })
          toast(v ? '总开关已打开' : '总开关已关闭', 'ok')
        } })),
      h('div', { className: 'ab-flex' }, tabs.map(([id, label]) => h(ui.Btn, { key: id, small: true, kind: tab === id ? 'primary' : 'ghost', onClick: () => setTab(id) }, label)))),
    sourceEditor,
    tab === 'subscriptions' ? subscriptions : tab === 'tasks' ? tasks : tab === 'env' ? env : logs)
}
