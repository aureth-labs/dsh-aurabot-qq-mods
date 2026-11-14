// panel.js —— 毒舌模式自定义面板：语料路径展示 + 「打开语料文件夹」按钮。
// 面板执行环境提供 React / h / ui / call / settings / save / toast（见 API.md「面板」）。
return function Panel({ settings, toast }) {
  const [info, setInfo] = React.useState(null)

  const loadInfo = async () => {
    try {
      const r = await call('/corpus-info')
      setInfo(r)
    } catch (e) {
      toast('读取语料信息失败：' + (e?.message || e))
    }
  }
  React.useEffect(() => { loadInfo() }, [])

  const openFolder = async () => {
    const r = await call('/open-corpus-folder', {})
    if (r && r.ok) toast('已在资源管理器打开语料文件夹')
    else toast('打开失败：' + ((r && r.message) || '未知错误'))
  }

  return h(ui.Card, { title: '毒舌语料' },
    h('p', { className: 'ab-small ab-muted' },
      '当前语料文件：',
      info && info.path
        ? h('code', { className: 'ab-note' }, info.path)
        : '（读取中…）'),
    h('p', { className: 'ab-small ab-muted' },
      settings.useFile
        ? '已开启「从文本文件读语料」：每行一句，# 开头的行是注释，改完保存即生效。'
        : '当前用的是内置预设语料；要在面板设置里打开「从文本文件读语料」才会读上面的文件。'),
    h('p', { className: 'ab-small ab-muted' }, '「打开语料文件夹」按钮仅支持 Windows，其他平台请手动访问上面的路径。'),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h(ui.Btn, { onClick: openFolder }, '打开语料文件夹'),
      h(ui.Btn, { onClick: loadInfo }, '刷新路径')),
  )
}
