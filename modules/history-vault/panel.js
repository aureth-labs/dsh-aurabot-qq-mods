// 跨会话历史库 · 自定义面板
// 拿到 React、h、ui（面板自带组件）、call（调模块接口），最后 return 一个 React 组件。
// 数据来自 /stats、/chats、/read，写操作只有「压缩一次」和「清空某聊天」，都不碰原文内容。

const { useState } = React

/**
 * 把面板上填的文字归一成库里真实的 chatId。
 * 支持这些写法（都是用户自然会想到的）：
 *   private:10001 / group:123456   ← 标准
 *   私聊:10001 / 群:123456 / 群聊:123456
 *   10001（纯号码，按私聊处理）
 *   带空格、全角冒号的：私聊：10001
 * 认不出来返回空串（调用方提示，而不是拿错 id 去查）。
 */
function normalizeChatId(raw) {
  const s = String(raw ?? '').trim().replace(/：/g, ':').replace(/\s+/g, '')
  if (!s) return ''
  const m = s.match(/^(private|group|私聊|群聊|群)?:?(\d{4,})$/) // eslint-disable-line no-useless-escape
  if (!m) return ''
  const kind = m[1]
  const id = m[2]
  return `${kind === 'group' || kind === '群' || kind === '群聊' ? 'group' : 'private'}:${id}`
}

return function Panel({ settings, save, toast }) {
  const [stats, setStats] = useState(null)
  const [chats, setChats] = useState(null)
  const [dump, setDump] = useState(null)
  const [chatId, setChatId] = useState('')
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState('')

  const loadStats = async () => {
    try { setStats(await call('/stats')) } catch (e) { toast('读取统计失败：' + e.message) }
  }
  const loadChats = async () => {
    try { setChats(await call('/chats')) } catch (e) { toast('读取聊天列表失败：' + e.message) }
  }
  if (!stats) { loadStats() }
  if (!chats) { loadChats() }

  // 「列出全部内容」：把整库三层一次性摊开（只读，不动任何数据）
  const loadDump = async () => {
    setBusy('dump')
    try {
      setDump(await call('/dump?lines=300'))
    } catch (e) { toast('列出内容失败：' + e.message) }
    setBusy('')
  }

  const loadDetail = async () => {
    // 面板输入常被填成「私聊:QQ号」这种口语格式，而库里存的是 private:/group: 前缀。
    // 这里先归一化，省得用户因为格式不对而永远查不到（0.1.3 之前就是这样：填中文前缀一律「无归档」）。
    const id = normalizeChatId(chatId)
    if (!id) { toast('先填聊天 ID，比如 private:10001 或 group:123456') ; return }
    setBusy('read')
    try { setDetail(await call('/read?chatId=' + encodeURIComponent(id) + '&lines=20')) } catch (e) { toast('读取失败：' + e.message) }
    setBusy('')
  }

  const compressOnce = async () => {
    setBusy('compress')
    try {
      const r = await call('/compress', {})
      toast(r.ok ? `压缩完成：原文 ${r.lines} 条，日摘要 ${r.days} 天，月印象 ${r.months} 月，今日调用 ${r.calls?.n ?? '?'} 次` : '压缩失败')
      loadStats()
      loadChats()
    } catch (e) { toast('压缩失败：' + e.message) }
    setBusy('')
  }

  const forget = async () => {
    const id = normalizeChatId(chatId)
    if (!id) { toast('先填要清空的聊天 ID，比如 private:10001') ; return }
    if (!confirm(`确定清空 ${id} 的全部历史？删了找不回来。`)) return
    setBusy('forget')
    try {
      const r = await call('/forget', { chatId: id })
      toast(r.message || '已清空')
      setDetail(null)
      loadStats()
      loadChats()
    } catch (e) { toast('清空失败：' + e.message) }
    setBusy('')
  }

  return h(ui.Card, { title: '跨会话记忆' },
    h('p', { className: 'ab-note' },
      '三层归档：L0 原文 → L1 日摘要 → L2 月印象。压缩带指纹，同一批内容只花一次模型调用。'),
    h('p', { className: 'ab-note' },
      '她聊天时会自动带「最近摘要」备忘，更早的细节用 recall_history 工具查。'),

    h('div', { className: 'ab-note', style: { margin: '8px 0' } },
      stats
        ? `当前库：原文 ${stats.lines} 条 · 日摘要 ${stats.days} 天 · 月印象 ${stats.months} 月 · 今日压缩调用 ${(stats.calls && stats.calls.n) || 0} 次`
        : '统计加载中……'),
    h(ui.Btn, { onClick: loadStats, style: { marginRight: 8 } }, '刷新统计'),
    h(ui.Btn, { onClick: () => { loadStats(); loadChats() }, style: { marginRight: 8 } }, '刷新聊天列表'),
    h(ui.Btn, { onClick: compressOnce, disabled: busy === 'compress' }, busy === 'compress' ? '压缩中……' : '手动压缩一次'),

    // ---- 列出全部内容（只读，一眼看全三层，不用先知道 chatId）----
    h('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 } },
      h(ui.Btn, { onClick: loadDump, disabled: busy === 'dump' }, busy === 'dump' ? '读取中……' : (dump ? '重新列出全部内容' : '列出全部内容')),
      dump
        ? h('span', { className: 'ab-note' },
            `原文共 ${dump.stats?.lines ?? 0} 条 · 日摘要 ${dump.stats?.days ?? 0} 天 · 月印象 ${dump.stats?.months ?? 0} 月` +
            (dump.shown < (dump.stats?.lines ?? 0) ? `（下面显示最近 ${dump.shown} 条）` : ''))
        : h('span', { className: 'ab-note' }, '点一下，把库里所有内容摊开看（只看不改）'),
    ),
    dump && h('div', {
      className: 'ab-note',
      style: { marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto', lineHeight: 1.75 },
    },
      dump.months?.length
        ? '【月印象】\n' + dump.months.map((m) => `${m.chatId} ${m.month}：${m.abstract}`).join('\n') + '\n\n'
        : '',
      dump.days?.length
        ? '【日摘要】\n' + dump.days.map((d) => `${d.chatId} ${d.day}：${d.abstract}`).join('\n') + '\n\n'
        : '',
      dump.lines?.length
        ? `【原文（${dump.lines.length} 条，按时间正序）】\n` + dump.lines.map((l) =>
            `${l.day} ${new Date(l.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ` +
            `[${l.dir === 'out' ? '她' : '收'}] ${l.who || '?'}：${l.text}`).join('\n')
        : '库里还没有任何内容。',
    ),

    h('h4', { style: { margin: '14px 0 4px' } }, '按聊天查看 / 清空'),
    h('p', { className: 'ab-note', style: { margin: '0 0 6px' } },
      '聊天 ID 就是她聊天的「门牌号」，格式是「类型:号码」：私聊填 private:QQ号（比如 private:10001），群聊填 group:群号（比如 group:123456）。'),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h('input', {
        className: 'ab-input',
        placeholder: 'private:QQ号 或 group:群号（如 private:10001）',
        value: chatId,
        onChange: (e) => setChatId(e.target.value),
        style: { flex: 1 },
      }),
      h(ui.Btn, { onClick: loadDetail, disabled: busy === 'read' }, '查看'),
      h(ui.Btn, { onClick: forget, disabled: busy === 'forget' }, busy === 'forget' ? '清空中……' : '清空'),
    ),
    // 不知道填什么的用户：把库里真实存在的聊天列出来，点一下就填进输入框（省去背 chatId 格式）
    chats && chats.length
      ? h('div', { style: { marginTop: 6 } },
          h('span', { className: 'ab-note', style: { marginRight: 6 } }, '库里的聊天：'),
          ...chats.slice(0, 12).map((c) =>
            h(ui.Btn, {
              key: c.chatId,
              style: { marginRight: 6, marginTop: 4 },
              onClick: () => { setChatId(c.chatId); setDetail(null) },
            }, `${c.chatId}（${c.lines}）`)))
      : null,
    detail && h('div', { className: 'ab-note', style: { marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' } },
      detail.months?.length
        ? '【月印象】\n' + detail.months.map((m) => `${m.month}：${m.abstract}`).join('\n') + '\n\n'
        : '',
      detail.days?.length
        ? '【日摘要】\n' + detail.days.map((d) => `${d.day}：${d.abstract}`).join('\n') + '\n\n'
        : '',
      detail.lines?.length
        ? `【原文片段（最近 ${detail.lines.length} 条）】\n` + detail.lines.map((l) => `${new Date(l.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${l.who || '?'}：${l.text}`).join('\n')
        : '',
      // 三层都没有才算真的没有；只有原文时不能再显示「还没有归档记录」（0.1.3 修的就是这个误报）
      !detail.months?.length && !detail.days?.length && !detail.lines?.length
        ? '这个聊天还没有归档记录。'
        : null,
      detail.days?.length && detail.lines?.length === 0
        ? h('div', { style: { marginTop: 6 } },
            '想看具体说了什么？再填个日期（比如 2026-11-06）或关键词一起查，就能看到当天的原文。')
        : null,
    ),

    h('h4', { style: { margin: '16px 0 4px' } }, '使用教程'),
    h('div', { className: 'ab-note', style: { lineHeight: 1.9 } },
      h('div', null, '① 它记什么：她和每个聊天的每一句话（收到的、发出去的）都会自动存进本机数据库，不用你做任何事。'),
      h('div', null, '② 三层存储：原文（每句话）→ 日摘要（一天一段）→ 月印象（一月一段）。旧内容会被慢慢压缩，但压缩前原文永远留在库里，细节不丢。'),
      h('div', null, '③ 怎么省钱：压缩带「指纹」——同一段内容只压缩一次，重复整理、会话重开都不会再花模型调用。'),
      h('div', null, '④ 她怎么用：聊天时会自动带上最近几天的摘要备忘；你问「上次说的那家店」「之前约了什么」，她会用 recall_history 工具自己去翻更早的摘要和原文。'),
      h('div', null, '⑤ 会话重开也不怕：DSH 会话归档、上下文被压缩，历史库里都在。新会话第一次聊天时她能立刻接上之前的话题。'),
      h('div', null, '⑥ 查找：QQ 里发 /史库 关键词 可以按词搜所有日摘要；面板这里按聊天 ID 看全文。'),
      h('div', null, '⑦ 隐私与容量：历史按聊天隔离；群太吵可以在设置里关「记录群聊」，或用群/私聊白名单只录指定聊天；想彻底删掉某个聊天的记录，填上它的聊天 ID 点「清空」即可，删了找不回。'),
    ),
  )
}
