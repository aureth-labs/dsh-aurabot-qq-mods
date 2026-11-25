// 面板：星露谷模块的控制台。
// 面板脚本是「函数体」（插件用 new Function(body) 跑，整文件就是一个函数），最后 return 一个 React 组件。
// 只做三件事：看当前状态、手动开工、叫停。

const { useState, useEffect } = React

return function StardewPanel({ settings, save, toast }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [minutes, setMinutes] = useState(10)

  const refresh = async () => {
    try {
      const r = await call('/stardew/selfplay/status')
      setState(r || null)
    } catch (error) {
      setState({ error: String(error && error.message || error) })
    }
  }

  useEffect(() => { refresh() }, [])

  const act = async (path) => {
    setBusy(true)
    try {
      const r = await call(path, path.endsWith('start') ? { minutes: Number(minutes) || 10 } : undefined)
      toast(r?.message || '好了')
      await refresh()
    } catch (error) {
      toast('没成功：' + String(error && error.message || error))
    } finally {
      setBusy(false)
    }
  }

  const running = Boolean(state && state.running)
  const round = state && Number(state.rounds)
  const left = state && state.until > Date.now() ? Math.round((state.until - Date.now()) / 60000) : 0

  return h('div', null,
    h(ui.Card, { title: '状态' },
      h(ui.Row, null, h('span', { className: 'ab-muted' }, '现在'), ' ', running ? `在玩（第 ${(round || 0) + 1} 轮）` : '没在玩'),
      running && left ? h(ui.Row, null, h('span', { className: 'ab-muted' }, '还剩'), ' ', `约 ${left} 分钟`) : null,
      state && state.slept !== undefined
        ? h(ui.Row, null, h('span', { className: 'ab-muted' }, '上次收工'), ' ',
            `${state.slept ? '已存档' : '没存成'}、${state.closed ? '游戏关掉了' : '游戏还开着'}`)
        : null,
      state && state.error ? h('p', { className: 'ab-small' }, '读状态失败：' + state.error) : null,
      h(ui.Btn, { onClick: refresh, disabled: busy }, '刷新'),
    ),

    h(ui.Card, { title: '让她玩一会儿' },
      h('p', { className: 'ab-note' }, '点了就去后台玩，玩完只在私聊发一条汇报。玩的时候这边不会被她打扰。'),
      h(ui.Row, null,
        h('input', {
          className: 'ab-input',
          type: 'number',
          min: 1,
          max: 180,
          value: minutes,
          onChange: (e) => setMinutes(Number(e.target.value) || 1),
          style: { width: 90 },
        }),
        h('span', { className: 'ab-muted' }, '分钟'),
      ),
      h(ui.Row, null,
        h(ui.Btn, { onClick: () => act('/stardew/selfplay/start'), disabled: busy || running }, running ? '正在玩' : '开始'),
        h(ui.Btn, { onClick: () => act('/stardew/selfplay/stop'), disabled: busy || !running }, '叫停'),
      ),
    ),

    h(ui.Card, { title: '怎么连上游戏' },
      h('p', { className: 'ab-note' }, '游戏侧要先装 SMAPI 和 BlindWhaleFarmer 模组（仓库见模块 README）。'),
      h('p', { className: 'ab-small' }, '游戏设置里把「窗口不活动时暂停」关掉，否则窗口被挡住时游戏会整个冻住，看着在玩其实时间不动。'),
      h('p', { className: 'ab-small' }, '模组自带的 AI 是按 F8 启动的，和这边抢操作，玩之前别按它。'),
    ),
  )
}
