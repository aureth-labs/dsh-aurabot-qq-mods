const { useState, useEffect } = React
return function NewsPanel({ toast }) {
  const [status, setStatus] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    try { const data = await call('/status'); if (data.ok) setStatus(data) }
    catch (error) { toast(error.message || '读取状态失败') }
  }
  useEffect(() => { refresh() }, [])
  const generate = async () => {
    setBusy(true)
    try {
      const result = await call('/preview', {})
      if (!result.ok) throw new Error(result.message || '生成失败')
      setPreview(result)
      toast('一图流已生成，预览不会发送到QQ')
    } catch (error) { toast(error.message || '预览失败，请查看日志') }
    finally { setBusy(false); refresh() }
  }
  return h(ui.Card, { title: '新闻一图流试用' },
    h('p', { className: 'ab-note' }, '读取近期新闻 → 整理事实摘要 → 调用生图功能。预览会使用模型和生图额度，需要几分钟，不会发到QQ。'),
    h('p', null, status ? `自动播报${status.daily ? '开启' : '关闭'} · 北京时间 ${status.time} · ${status.busy ? '制作中' : '空闲'}` : '读取状态中…'),
    status?.lastError ? h('p', { role: 'alert' }, `最近错误：${status.lastError}`) : null,
    h(ui.Btn, { onClick: generate, disabled: busy || status?.busy }, busy ? '正在采集新闻并画图…' : '生成预览（不发送）'),
    h(ui.Btn, { onClick: refresh }, '刷新状态'),
    h('p', { className: 'ab-note' }, '主人在QQ发送 /news 或 /新闻，会生成并发送到当前聊天；/news 状态 查看自动任务。'),
    preview ? h('div', null,
      h('img', { src: preview.image, alt: '每日新闻一图流预览', style: { display: 'block', maxWidth: '100%', maxHeight: '1100px', marginTop: '16px', objectFit: 'contain' } }),
      h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' } }, preview.text)) : null)
}
