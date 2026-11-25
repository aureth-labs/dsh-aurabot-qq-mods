// Todo 待办面板：固定高度的计时区和记录区。
const { useState, useEffect, useCallback } = React

return function Panel({ settings, draftSettings, setSettings, save, toast }) {
  const cur = draftSettings || settings || {}
  const patch = (p) => {
    if (setSettings) setSettings(p)
    else save(p)
  }
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    try {
      const r = await call('/status')
      setData(r || null)
    } catch (e) {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const poll = setInterval(() => {
      setNow(Date.now())
      load()
    }, 1000)
    return () => clearInterval(poll)
  }, [load])

  const active = (data && data.active) || []
  const items = (data && data.items) || []
  const formatRemaining = (task) => {
    const total = Math.ceil(Math.max(0, Number(task.at || 0) - now) / 1000)
    if (total < 60) return total + ' 秒后'
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    if (minutes < 60) return minutes + ' 分 ' + String(seconds).padStart(2, '0') + ' 秒后'
    return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分后'
  }
  const formatAt = (at) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'
  const scrollBox = { height: 260, overflowY: 'auto', overflowX: 'hidden' }
  const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left' }
  const textStyle = { minWidth: 0, flex: 1, textAlign: 'left' }
  const actionStyle = { flex: '0 0 52px', width: 52 }

  const cancel = async (id) => {
    try {
      const r = await call('/cancel', { id })
      toast((r && r.message) || '已撤回')
      load()
    } catch (e) {
      toast('失败：' + String((e && e.message) || e))
    }
  }

  const renderTask = (t, activeTask = false) => h('div', { key: t.id, style: { ...rowStyle, boxSizing: 'border-box', padding: '8px 0', borderBottom: '1px solid var(--ab-border, #ddd)' } },
    h('div', { style: textStyle },
      h('div', { className: 'ab-input', style: { textAlign: 'left', wordBreak: 'break-word' } },
        activeTask ? formatRemaining(t) + ' · ' + formatAt(t.at) : formatAt(t.at) + ' · ' + t.to
      ),
      h('div', { className: 'ab-note ab-muted', style: { textAlign: 'left', wordBreak: 'break-word' } },
        t.thought + (activeTask ? '' : '（' + (t.state === 'done' ? '已完成' : t.times === -1 ? '每天' : '还剩 ' + t.times + ' 次') + '）')
      )
    ),
    t.state === 'open' ? h('div', { style: actionStyle }, h(ui.Btn, { onClick: () => cancel(t.id) }, '撤回')) : null
  )

  const greetingSettings = (period, title, hours) => {
    const enabledKey = 'greetings' + period + 'Enabled'
    const candidatesKey = 'greetings' + period + 'Candidates'
    const minKey = 'greetings' + period + 'Min'
    const maxKey = 'greetings' + period + 'Max'
    const numberInput = (key, fallback, label) => h('label', { style: { flex: 1, minWidth: 0, textAlign: 'left' } }, label, ' ',
      h('input', { className: 'ab-input', type: 'number', min: 0, max: 20, step: 1, style: { width: 70 }, value: cur[key] ?? fallback,
        onChange: (e) => patch({ [key]: e.target.value === '' ? '' : Math.max(0, Math.min(20, Math.floor(Number(e.target.value)))) }) }))
    const enabled = (cur[enabledKey] ?? cur.greetingsEnabled) === true
    return h(ui.Card, { title },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: enabled ? 12 : 0 } },
        h(ui.Switch, { on: enabled, onChange: (v) => patch({ [enabledKey]: !!v }), title: title }),
        h('span', null, enabled ? '已开启' : '已关闭')
      ),
      enabled ? h('div', null,
        h('p', { className: 'ab-note', style: { textAlign: 'left' } }, hours),
        h('label', { htmlFor: candidatesKey, style: { display: 'block', textAlign: 'left' } }, '候选名单'),
        h('textarea', { id: candidatesKey, className: 'ab-input',
          style: { display: 'block', width: '100%', minHeight: 72, boxSizing: 'border-box', textAlign: 'left' },
          placeholder: '每行一个 QQ 号或 private:QQ号', value: String(cur[candidatesKey] ?? cur.greetingsCandidates ?? ''),
          onChange: (e) => patch({ [candidatesKey]: e.target.value }) }),
        h('p', { className: 'ab-note', style: { textAlign: 'left' } }, '留空则从最近两天聊过的私聊中抽取；对象须在私聊白名单中。'),
        h('div', { style: { display: 'flex', gap: 12 } }, numberInput(minKey, 1, '最少人数'), numberInput(maxKey, 3, '最多人数'))
      ) : null
    )
  }

  return h('div', null,
    h(ui.Card, { title: '自主待办' },
      h(ui.Switch, { on: cur.autonomousEnabled === true, onChange: v => patch({ autonomousEnabled: !!v }) }),
      h('p', { className: 'ab-note' }, '开启后，AI 可在各种对话中自主决定后续事项及联系时间，不要求用户指定时间；仍须尊重勿扰意愿和权限。修改、完成或撤回需用户确认。')
    ),
    greetingSettings('Morning', '早安问候', '每天 0 点生成，8:00–10:00 随机触发'),
    greetingSettings('Evening', '晚安问候', '每天 0 点生成，20:00–22:00 随机触发'),
    h(ui.Card, { title: '正在计时' },
      h('p', { className: 'ab-note' }, active.length ? '下一次触发时间' : '现在没有正在计时的待办'),
      h('div', { style: scrollBox }, active.length ? active.map((t) => renderTask(t, true)) : h(ui.Empty, null, loading ? '读取中…' : '没有计时任务'))
    ),

    h(ui.Card, { title: '待办记录' },
      h('div', { style: scrollBox }, items.length ? items.map((t) => renderTask(t)) : h(ui.Empty, null, loading ? '读取中…' : '现在没有待办记录'))
    ),

    h(ui.Card, { title: '格式说明' },
      h('p', { className: 'ab-note' }, '一条一行，竖线分开六段，第六段可省略：'),
      h('div', { style: { textAlign: 'left', overflowWrap: 'anywhere', lineHeight: 1.6 } },
        h('div', null, '来源对话 | 念头和原因 | 目的对话 | 时间(HH:MM) | 次数 | 重复间隔分钟'),
        h('div', { className: 'ab-muted' }, '例：private:123 | 想起来问问他作业写完没，怕他熬夜 | private:456 | 14:30 | 3 | 5')
      ),
      h('p', { className: 'ab-note ab-muted' }, '无指定时间的跨轮或跨聊天任务，时间填 0 表示立即安排执行。多次提醒时可填写第六段间隔分钟，省略默认 1 分钟。')
    )
  )
}
