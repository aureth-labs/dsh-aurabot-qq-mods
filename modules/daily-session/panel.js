const { useState, useEffect } = React
const { Card, Btn, Empty } = ui

return function Panel({ settings, save, toast }) {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmSplit, setConfirmSplit] = useState(false)

  const refresh = async () => {
    try {
      const r = await call('/status')
      if (r && r.ok) setInfo(r)
      else toast((r && r.message) || '读取状态失败')
    } catch (e) {
      toast(String((e && e.message) || e))
    }
  }

  useEffect(() => { refresh() }, [])

  const runNow = async () => {
    setBusy(true)
    try {
      const r = await call('/run-now')
      if (r && r.ok) toast(`检查完成：重置 ${r.reset || 0} 个，摘要 ${r.digests || 0} 个`)
      else toast((r && r.message) || '执行失败')
      await refresh()
    } catch (e) {
      toast(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }

  const clearDigest = async () => {
    try {
      const r = await call('/clear-digest')
      toast(`已清空 ${r && r.cleared ? r.cleared : 0} 条摘要`)
      await refresh()
    } catch (e) {
      toast(String((e && e.message) || e))
    }
  }

  // 强制拆分影响所有聊天，点一次先进入确认态，5 秒内再点才执行
  const splitNow = async () => {
    if (!confirmSplit) {
      setConfirmSplit(true)
      toast('再点一次「确认拆分全部」执行；5 秒内有效')
      setTimeout(() => setConfirmSplit(false), 5000)
      return
    }
    setConfirmSplit(false)
    setBusy(true)
    try {
      const r = await call('/split-now')
      if (r && r.ok) {
        toast(`已拆分 ${r.split || 0} 个会话，备好 ${r.digests || 0} 条摘要${r.dryRun ? '（试运行，未真重置）' : ''}`)
      } else {
        toast((r && r.message) || '执行失败')
      }
      await refresh()
    } catch (e) {
      toast(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }

  return h(Card, { title: '每日会话拆分' },
    h('div', { className: 'ab-note' }, '每天给会话收口：到点开新会话，昨日对话提炼后只在新会话首轮注入一次，省下越攒越长的上下文。'),

    h('div', { className: 'ab-row' },
      h('label', null,
        '开启每日拆分：',
        h('input', {
          type: 'checkbox',
          checked: !!settings.enabled,
          onChange: (e) => save({ enabled: e.target.checked }),
        }),
      ),
    ),
    h('div', { className: 'ab-row' },
      h('label', null,
        '每天几点后重置（本机时间）：',
        h('input', {
          className: 'ab-input',
          type: 'number', min: 0, max: 23, step: 1,
          value: settings.resetHour === undefined ? 0 : settings.resetHour,
          onChange: (e) => save({ resetHour: Number(e.target.value) }),
        }),
      ),
    ),
    h('div', { className: 'ab-row' },
      h('label', null,
        '作用范围：',
        h('select', {
          className: 'ab-input',
          value: settings.scope || 'all',
          onChange: (e) => save({ scope: e.target.value }),
        },
          h('option', { value: 'all' }, '所有聊天'),
          h('option', { value: 'group' }, '仅群聊'),
          h('option', { value: 'private' }, '仅私聊'),
        ),
      ),
    ),
    h('div', { className: 'ab-row' },
      h('label', null,
        '注入昨日摘要：',
        h('input', {
          type: 'checkbox',
          checked: !!settings.injectDigest,
          onChange: (e) => save({ injectDigest: e.target.checked }),
        }),
      ),
    ),
    h('div', { className: 'ab-row' },
      h('label', null,
        '摘要字数上限：',
        h('input', {
          className: 'ab-input',
          type: 'number', min: 60, max: 2000, step: 20,
          value: settings.digestMaxChars === undefined ? 600 : settings.digestMaxChars,
          onChange: (e) => save({ digestMaxChars: Number(e.target.value) }),
        }),
      ),
    ),
    h('div', { className: 'ab-row' },
      h('label', null,
        '试运行（只记日志，不真的重置）：',
        h('input', {
          type: 'checkbox',
          checked: !!settings.dryRun,
          onChange: (e) => save({ dryRun: e.target.checked }),
        }),
      ),
    ),

    h('div', { className: 'ab-row' },
      h(Btn, { onClick: splitNow, disabled: busy }, confirmSplit ? '确认拆分全部' : '立即拆分'),
      h(Btn, { onClick: runNow, disabled: busy }, busy ? '检查中…' : '立即检查'),
      h(Btn, { onClick: refresh }, '刷新'),
      h(Btn, { onClick: clearDigest }, '清空摘要'),
    ),

    info
      ? h('div', null,
        h('p', { className: 'ab-small ab-muted' },
          `当前周期 ${info.period} · 下次重置 ${new Date(info.nextResetAt).toLocaleString()}`),
        info.chats && info.chats.length
          ? h('ul', null, info.chats.map((c) => h('li', { key: c.chatId },
            `${c.chatId} · 上次 ${c.lastPeriod || '未记录'} · 摘要 ${c.digestDay || '无'}${c.digestChars ? `（${c.digestChars} 字）` : ''}`,
          )))
          : h(Empty, null, '还没有聊天记录'),
      )
      : h('p', { className: 'ab-muted' }, '加载中…'),

    h('p', { className: 'ab-small ab-muted' },
      '日志判据：面板「日志」页应出现「每日会话拆分：…已重置 …」和「…注入 … 摘要」。看不到就去查注册、派发、契约、逻辑这四层，别只看模块自己的埋点。'),
  )
}
