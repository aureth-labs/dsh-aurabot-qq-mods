// panel.js —— 毒舌模式2自定义面板：当前档位 + 三档语料路径展示 + 打开语料文件夹按钮。
// 面板执行环境提供 React / h / ui / call / settings / save / toast（见 API.md「面板」）。
return function Panel({ settings, toast }) {
  const [info, setInfo] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const loadInfo = async () => {
    try {
      const r = await call('/corpus-info', { level: settings.level })
      setInfo(r)
    } catch (e) {
      toast('读取语料信息失败：' + (e?.message || e))
    }
  }
  React.useEffect(() => { loadInfo() }, [settings.level])

  const disableAll = async () => {
    setBusy(true)
    try {
      const r = await call('/disable-all', {})
      if (r && r.ok) {
        toast(`已全部关闭毒舌模式2（${r.count || 0} 个聊天）`)
        await loadInfo()
      } else toast('关闭失败：' + ((r && r.message) || '未知错误'))
    } catch (e) {
      toast('关闭失败：' + (e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async () => {
    setBusy(true)
    try {
      const r = await call('/open-corpus-folder', {})
      if (r && r.ok) toast('已在资源管理器打开语料文件夹')
      else toast('打开失败：' + ((r && r.message) || '未知错误'))
    } finally {
      setBusy(false)
    }
  }

  const lv = Number(settings.level) || 2
  const tierText = { 1: '傲娇嘴硬 · 最轻', 2: '损友毒舌 · 中', 3: '狂暴模式 · 最强' }
  const names = { 1: '1档 傲娇嘴硬', 2: '2档 损友毒舌', 3: '3档 狂暴模式' }

  return h(ui.Card, { title: '毒舌语料 · 三档分级' },
    h('p', { className: 'ab-small ab-muted' },
      '当前档位：',
      h('strong', null, `${lv}档 ${tierText[lv] || ''}`),
      '（在上方「毒舌档位」设置里切换，档位越高语料越冲）'),
    h('p', { className: 'ab-small ab-muted' },
      '当前档位语料文件：',
      info && info.path
        ? h('code', { className: 'ab-note' }, info.path)
        : '（读取中…）'),
    h('p', { className: 'ab-small ab-muted' },
      settings.useFile
        ? '已开启「从文本文件读语料」：每个档位读各自的 corpus_N.txt，每行一句，# 开头是注释，改完保存即生效。'
        : '当前用内置三档语料；要在上方设置里打开「从文本文件读语料」才会读文件。'),
    h('p', { className: 'ab-small ab-muted' }, '三档文件：'),
    h('ul', { className: 'ab-small ab-muted' },
      [1, 2, 3].map((n) => h('li', { key: n },
        h('code', null, names[n]),
        '：',
        info && info.all && info.all[n]
          ? h('code', { className: 'ab-note' }, info.all[n].path)
          : '…'))),
    h('p', { className: 'ab-small ab-muted' },
      '关不掉？在群里发「智毒关闭 / 毒舌关闭 / 关掉毒舌模式2」都行，带 @机器人 也认；也可点下面「全部关闭」清空所有聊天的开关。'),
    h('p', { className: 'ab-small ab-muted' }, '「打开语料文件夹」按钮仅支持 Windows，其他平台请手动访问上面的路径。'),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h(ui.Btn, { onClick: openFolder, disabled: busy }, busy ? '打开中…' : '打开语料文件夹'),
      h(ui.Btn, { onClick: loadInfo }, '刷新路径'),
      h(ui.Btn, { onClick: disableAll, disabled: busy }, '全部关闭')),
  )
}
