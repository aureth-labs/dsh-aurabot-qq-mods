// panel.js —— 心情看板的面板卡片：「打开看板窗口」按钮。
// 桌面端面板跑在 Electron 壳里，window.open / <a target=_blank> 都会被壳吞掉（MEMORY.md §3.7），
// 所以按钮改为调模块的 /open 接口：模块在 Node 侧用 rundll32 拉起系统默认浏览器（codex-auth 同款）。
const { useState } = React
return function Panel({ toast }) {
  const [busy, setBusy] = useState(false)
  return h(ui.Card, { title: '心情看板' },
    h('p', { className: 'ab-muted ab-small' },
      '用系统默认浏览器打开一个实时看板窗口：她的心情与起伏历史、目的引擎的驱力和心情向量（含为 0 的项）、记忆里的相处经验与说话方式。窗口大小随意拉，页面自适应；数据每几秒自动刷新。'),
    h(ui.Btn, {
      disabled: busy,
      onClick: async () => {
        setBusy(true)
        try {
          const r = await call('/open')
          toast(r.message || (r.ok ? '已打开' : '打开失败'))
        } catch (e) {
          toast('打开失败：' + (e && e.message || e))
        } finally {
          setBusy(false)
        }
      },
    }, busy ? '正在打开…' : '打开看板窗口'))
}
