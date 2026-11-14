return function Panel({ toast }) {
  const { useEffect, useState } = React
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')

  const refresh = () => call('/status').then(setSt).catch(() => setSt(null))
  useEffect(() => { refresh() }, [])

  const run = async (path, label) => {
    setBusy(label)
    try {
      const r = await call(path)
      toast((r && r.message) || '做完了')
    } catch (error) {
      toast('失败了：' + String(error?.message || error))
    }
    setBusy('')
    refresh()
  }

  const btn = (path, label, kind) => h(ui.Btn, {
    key: label,
    disabled: Boolean(busy),
    onClick: () => run(path, label),
    style: kind === 'danger' ? { marginLeft: 'auto' } : null,
  }, busy === label ? '处理中…' : label)

  return h(ui.Card, { title: '台球' },
    h('div', { className: 'ab-note', style: { marginBottom: '10px' } },
      '两个座位都能打：你拖白球出杆，第二个人类玩家轮流拖，也可以让电脑接管。',
      h('br', null),
      '「桌面球桌」把整个屏幕当桌子，球桌以外照常点东西；收工点窗里的「退出台球」（这窗口不吃键盘，按 Esc 没用）。',
      h('br', null),
      '画面是 Electron 窗口，不在浏览器里 —— 这个按钮开的是本机程序。'),
    h(ui.Row, null,
      btn('/open-arena', '桌面球桌'),
      !st || st.electron ? null : btn('/electron-install', '安装 Electron'),
      st && st.running ? btn('/close', '关掉台球', 'danger') : null,
      h(ui.Btn, { onClick: refresh, disabled: Boolean(busy) }, '刷新')),
    h('div', { className: 'ab-muted ab-small', style: { marginTop: '10px' } },
      st ? [
        h('div', null, '状态：' + st.message),
        h('div', null, '运行时：' + (st.electron
          ? (st.electron.source === 'pet' ? '借用桌宠装好的 Electron' : '本模块装的 Electron')
          : '未安装（点「安装 Electron」，只装一次）')),
        h('div', null, '球面：' + (st.anims.count ? st.anims.pack + '（' + st.anims.count + ' 段动画）' : '普通球面（没找到桌宠素材包）')),
        h('div', null, '客户端目录：' + st.appDir),
      ] : '还没读到状态，点「刷新」'),
    h('div', { className: 'ab-note', style: { marginTop: '10px' } },
      '打得怎么样：按住白球往后拖，拖得越远力度越大，松手出杆。八球规则（开球 → 定组 → 犯规 → 自由球 → 8 号定胜负）都在本地算，不联网。')
  )
}
