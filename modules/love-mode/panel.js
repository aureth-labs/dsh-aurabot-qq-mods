// panel.js —— 快来跟我恋爱吧 面板（独立标签页）
// 本文件被面板当作「函数体」执行，React / h / ui / call 是外层闭包变量。

return function Panel({ settings, save, toast }) {
  const { useState, useEffect } = React
  const { Card, Btn, Switch, Row, Select } = ui

  const [info, setInfo] = useState(null)     // /state 返回的 modes/state/skills 等
  const [draft, setDraft] = useState(null)   // 未确认草稿；null = 与已生效一致
  const [advanced, setAdvanced] = useState(true)  // 高级默认展开
  const [matching, setMatching] = useState(false)
  const [kbLog, setKbLog] = useState(undefined)   // undefined=加载中, null=不可用, []=空
  const [showInject, setShowInject] = useState(null)   // null=收起, 'loading', 或 {user,text,t}

  const load = () => call('/state').then((r) => {
    if (!r || r.ok === false) throw new Error((r && r.message) || '读取失败')
    setInfo(r); setDraft(null)
  }).catch((e) => toast('读不到设置：' + e.message, 'err'))
  const loadKb = () => {
    setKbLog(undefined)
    return call('/skill-log')
      .then((r) => setKbLog(r && r.ok ? { items: r.items || [], modeNames: r.modeNames || {} } : null))
      .catch(() => setKbLog(null))
  }
  useEffect(() => { load(); loadKb() }, [])

  const cur = draft || (info && info.settings) || {}
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(info && info.settings)
  const setField = (patch) => setDraft({ ...(draft || info.settings), ...patch })
  const confirm = async () => {
    try { await save(draft); await load(); toast('已生效', 'ok') } catch (e) { toast('没设置成功：' + e.message, 'err') }
  }
  const doMatch = async () => {
    setMatching(true)
    try {
      const r = await call('/auto-match', { method: 'POST' })
      if (r && r.ok) { toast(`匹配成功：${r.modeName}（${r.reason}）`, 'ok'); await load() }
      else toast((r && r.message) || '匹配失败', 'err')
    } catch (e) { toast('匹配失败：' + e.message, 'err') }
    setMatching(false)
  }
  const pickMode = async (mode) => {
    await call('/set-mode?mode=' + mode, { method: 'POST' })
    await load()
  }

  if (!info) return h(Card, { title: '快来跟我恋爱吧', icon: '💘' }, h('p', { className: 'ab-muted ab-small' }, '加载中…'))

  const modeKey = cur.relationMode || 'dating'
  const detail = (info.modeDetails || {})[modeKey] || { name: '', tone: '' }
  const isCustom = modeKey.startsWith('c_')
  const customModes = Array.isArray(cur.customModes) ? cur.customModes : []
  const cmIdx = customModes.findIndex((m) => 'c_' + m.id === modeKey)
  const cm = cmIdx >= 0 ? customModes[cmIdx] : null
  // 自建模式的字段改动：直接改 customModes 数组（走草稿 + 悬浮保存条）
  const setCm = (patch) => {
    if (cmIdx < 0) return
    const arr = customModes.slice()
    arr[cmIdx] = { ...arr[cmIdx], ...patch }
    setField({ customModes: arr })
  }
  const createMode = async () => {
    const r = await call('/custom-modes?action=create&name=' + encodeURIComponent('新模式'), { method: 'POST' })
    if (r && r.ok) { await call('/set-mode?mode=' + r.modeKey, { method: 'POST' }); await load(); toast('已创建新模式，写个名字和基调吧', 'ok') }
    else toast('创建失败', 'err')
  }
  const deleteMode = async () => {
    if (!cm) return
    const r = await call('/custom-modes?action=delete&id=' + cm.id, { method: 'POST' })
    if (r && r.ok) { await load(); toast('已删除，回到「单身约会」', 'ok') }
    else toast('删除失败', 'err')
  }

  // ── 小零件 ──
  const slider = (key, label, hint) => h(Row, { label, hint },
    h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
      h('input', { type: 'range', min: 0, max: 100, value: cur[key] ?? 50,
        onChange: (e) => setField({ [key]: Number(e.target.value) }) }),
      h('span', { className: 'ab-muted ab-small', style: { minWidth: 24, textAlign: 'right' } }, String(cur[key] ?? 50))))

  // 自建模式的滑块：改的是这个模式自己的字段
  const sliderCm = (key, label, hint) => h(Row, { label, hint },
    h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
      h('input', { type: 'range', min: 0, max: 100, value: (cm && cm[key]) ?? 50,
        onChange: (e) => setCm({ [key]: Number(e.target.value) }) }),
      h('span', { className: 'ab-muted ab-small', style: { minWidth: 24, textAlign: 'right' } }, String((cm && cm[key]) ?? 50))))

  // 16 型一句话简介：选中后显示在下拉框下面，帮助选择
  const MBTI_DESC = {
    INTJ: '建筑师：冷静有主见，认定的事十头牛拉不回',
    INTP: '逻辑学家：脑子里全是想法，说话爱绕到本质上',
    ENTJ: '指挥官：天生带节奏，目标感强，说话直接',
    ENTP: '辩论家：点子多嘴皮子快，喜欢抬杠但不为赢',
    INFJ: '提倡者：温和却有原则，能看懂别人的情绪',
    INFP: '调停者：内心戏丰富，真诚慢热，讨厌虚的',
    ENFJ: '主人公：天生的暖场王，总在照顾别人的感受',
    ENFP: '竞选者：热情跳脱，对什么都好奇，感染力拉满',
    ISTJ: '物流师：靠谱守规矩，答应的事一定会做到',
    ISFJ: '守卫者：细腻体贴，默默记住你的喜好',
    ESTJ: '总经理：务实干脆，安排事情井井有条',
    ESFJ: '执政官：热心肠，把身边人的需求放在心上',
    ISTP: '鉴赏家：话少手巧，淡定观察，临场反应快',
    ISFP: '探险家：随和敏感，活在当下，审美在线',
    ESTP: '企业家：行动派，爱刺激，到哪都是气氛组',
    ESFP: '表演者：人来疯本疯，快乐简单，讨厌冷场'
  }
  const mbtiSelect = (key, label) => h('div', { style: { margin: '4px 0' } }, [
    h(Row, { label },
      h(Select, { value: cur[key] || '', width: 130, placeholder: '未定',
        options: [{ value: '', label: '未定' }].concat(info.mbtiTypes.map((t) => ({ value: t, label: t }))),
        onChange: (v) => setField({ [key]: v }) })),
    cur[key] && MBTI_DESC[cur[key]]
      ? h('p', { className: 'ab-small ab-muted', style: { margin: '0 0 2px', lineHeight: 1.5, opacity: 0.8 } }, MBTI_DESC[cur[key]])
      : null
  ])

  const textField = (key, label, placeholder, valueOverride, onChangeOverride) => h(Row, { label },
    h('input', { type: 'text', className: 'ab-input', value: valueOverride !== undefined ? valueOverride : (cur[key] || ''), placeholder: placeholder || '', style: { width: 120 },
      onChange: (e) => onChangeOverride ? onChangeOverride(e.target.value) : setField({ [key]: e.target.value }) }))

  const areaField = (key, label) => h('div', { style: { margin: '6px 0' } }, [
    h('div', { className: 'ab-small ab-muted', style: { marginBottom: 3 } }, label),
    h('textarea', { className: 'ab-input', value: cur[key] || '', rows: 2,
      style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.5 },
      onChange: (e) => setField({ [key]: e.target.value }) })])

  const sectionTitle = (t) => h('p', { className: 'ab-muted ab-small', style: { margin: '12px 0 4px', fontWeight: 600 } }, t)

  // ── 知识库日志 ──
  const loadInject = () => {
    setShowInject('loading')
    call('/last-injection').then((r) => setShowInject(r && r.ok ? r : { user: '', text: '读取失败' })).catch(() => setShowInject({ user: '', text: '读取失败' }))
  }
  const fmtTime = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const kbSection = h('div', { style: { marginTop: 14, borderTop: '1px solid rgba(128,128,128,.2)', paddingTop: 8 } }, [
    h('div', { className: 'ab-flex', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } }, [
      h('span', { style: { fontWeight: 600 } }, '📖 每轮注入日志（验证你的设定有没有真的用上）'),
      h('div', { className: 'ab-flex', style: { gap: 6 } }, [
        h(Btn, { small: true, onClick: showInject ? () => setShowInject(null) : loadInject }, showInject ? '收起注入内容 ▲' : '看最近一次完整注入'),
        h(Btn, { small: true, onClick: loadKb }, '刷新')
      ])
    ]),
    showInject && showInject !== 'loading' ? h('pre', { className: 'ab-small', style: { maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap', background: 'rgba(128,128,128,.08)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.6, margin: '0 0 8px' } },
      `她回复「${showInject.user || '?'}」时实际看到的全部设定：\n\n${showInject.text}`) : null,
    showInject === 'loading' ? h('p', { className: 'ab-muted ab-small' }, '读取中…') : null,
    kbLog === undefined ? h('p', { className: 'ab-muted ab-small' }, '读取中…')
      : kbLog === null ? h('p', { className: 'ab-muted ab-small' }, '读不到日志（模块可能刚重启，稍等刷新）')
      : kbLog.items.length === 0 ? h('p', { className: 'ab-muted ab-small' }, '还没有记录——私聊几轮后这里会显示每一轮的军师分析过程')
      : h('div', { style: { maxHeight: 300, overflowY: 'auto' } },
          kbLog.items.map((e, i) => h('div', { key: i, className: 'ab-small', style: { padding: '5px 0', borderBottom: '1px dashed rgba(128,128,128,.15)', lineHeight: 1.6 } }, [
            h('div', null, [
              h('span', { className: 'ab-muted' }, `${fmtTime(e.t)} · ${(kbLog.modeNames || {})[e.mode] || e.mode || ''} · `),
              h('span', null, `「${e.user}」`)
            ]),
            e.kind === 'advisor' ? h('div', null, [
              h('div', null, [
                h('span', { style: { color: '#3a8ee6' } }, `军师：意图「${e.intent || '?'}」· 情绪「${e.emotion || '?'}」`),
                h('span', { className: 'ab-muted' }, ` · ${e.ms || '?'}ms`)
              ]),
              (e.candidates || []).map((c, j) => h('div', { key: j, className: 'ab-muted', style: { paddingLeft: 12 } },
                `${j === e.best ? '✅' : '·'} ${c.strategy}（${c.why}）`)),
              h('div', { className: 'ab-muted', style: { paddingLeft: 12 } },
                `思路：${e.guidance || '—'}${e.kbName ? ` · 查库：${e.kbName}` : ''}`)
            ])
            : h('div', null, [
                h('span', { style: { color: '#d9930d' } }, `降级路径（${e.kind === 'fallback' ? '军师链失败' : '军师链已关'}）`),
                h('span', { className: 'ab-muted' }, ` → 关键词：${(e.tags || []).join('、') || '无'}${e.fallback ? '（兜底）' : ''}${e.error ? ' · ' + e.error : ''}`)
              ]),
            h('div', { className: 'ab-muted', style: { opacity: 0.8 } },
              `生效设定：画像 她${e.her || '?'}/你${e.you || '?'} · 滑块 幽${(e.sliders || '?/?/?').split('/')[0]} 主${(e.sliders || '?').split('/')[1] || '?'} 走${(e.sliders || '?').split('/')[2] || '?'}`)
          ])))
  ])

  // ── 右栏：当前模式说明 ──
  const rightCol = h('div', { style: { width: 250, flexShrink: 0 } },
    h('div', { style: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, padding: '10px 12px', position: 'sticky', top: 8 } }, [
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '💘 ' + (detail.name || '')),
      h('p', { className: 'ab-small ab-muted', style: { margin: '0 0 6px', lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, detail.tone || ''),
      h('p', { className: 'ab-small ab-muted', style: { margin: '0 0 10px', lineHeight: 1.6, opacity: 0.75 } },
        '↑ 这就是「性格基调文案」：它会注入到她的每一轮对话，决定她用什么风格和你相处。默认按当前模式从恋爱知识库提炼，左边高级设置里可以自己改写。'),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, `默认滑块：幽默 ${detail.humor} · 主动 ${detail.proactivity} · 走心 ${detail.depth}`),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 2 } }, '本模式技能：'),
      h('ul', { className: 'ab-small', style: { margin: '0 0 10px', paddingLeft: 18 } },
        (info.modeSkills || []).map((k) => {
          const sk = (info.skills || []).find((x) => x.key === k)
          if (!sk) return null
          const yellow = sk.needsSpeakUp && !info.speakUpOn
          return h('li', { key: k, style: yellow ? { color: '#d9930d' } : null },
            sk.name + (yellow ? '（需开启主动搭话）' : ''))
        })),
      h('div', { style: { borderTop: '1px solid rgba(128,128,128,.2)', paddingTop: 8 } }, [
        h('div', { className: 'ab-small ab-muted', style: { fontWeight: 600, marginBottom: 4 } }, '画像是怎么来的？'),
        h('p', { className: 'ab-small ab-muted', style: { margin: 0, lineHeight: 1.6, opacity: 0.75 } },
          '点「自动匹配」时，AI 会读她的人格卡 + 记忆库里关于你们的聊天记忆，推断出双方的 MBTI、优势和短板。生成后可在左侧微调。')
      ])
    ]))

  // ── 左栏：控制项 ──
  const leftCol = h('div', { style: { flex: 1, minWidth: 0 } }, [
    h(Row, { label: '关系模式' },
      h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } }, [
        h(Select, { value: modeKey, width: 180, options: info.modes,
          onChange: (v) => pickMode(v) }),
        h(Btn, { small: true, onClick: createMode }, '＋ 新建模式'),
        isCustom ? h(Btn, { small: true, danger: true, onClick: deleteMode }, '删除此模式') : null
      ])),
    isCustom ? textField('', '模式名', '比如：暧昧模式', cm && cm.name, (v) => setCm({ name: v })) : null,
    h(Row, { label: '自动匹配', hint: info.state && info.state.matchedAt ? `上次匹配：${info.state.matchedAt.slice(0, 10)}${info.state.matchReason ? ' · ' + info.state.matchReason : ''}` : '还没匹配过，点一下让她自己判断你们处在哪个模式' },
      h(Btn, { small: true, disabled: matching, onClick: doMatch }, matching ? '分析中…' : '🔍 自动匹配')),
    h(Row, { label: '高级设置', hint: '滑块、基调文案、双方画像、关系声明' },
      h(Btn, { small: true, onClick: () => setAdvanced(!advanced) }, advanced ? '收起 ▲' : '展开 ▼')),

    advanced ? h('div', null, [
      // 滑块：预设模式改全局设置，自建模式改这个模式自己的字段
      isCustom
        ? h('div', null, [
            sliderCm('humor', '幽默程度', '越高越爱开玩笑调侃'),
            sliderCm('proactivity', '主动程度', '影响她主动找你的频率（需主动搭话开启）'),
            sliderCm('depth', '走心程度', '越高越爱聊深的话题和真实感受')
          ])
        : h('div', null, [
            slider('humorLevel', '幽默程度', '越高越爱开玩笑调侃'),
            slider('proactivity', '主动程度', '影响她主动找你的频率（需主动搭话开启）'),
            slider('depth', '走心程度', '越高越爱聊深的话题和真实感受')
          ]),

      sectionTitle(isCustom ? '性格基调文案（这个模式自己的基调，改完点底部「确认生效」）' : '性格基调文案（当前模式的基调，可直接改；改动保存后覆盖默认）'),
      h('textarea', { className: 'ab-input', value: isCustom ? (cm ? cm.tone || '' : '') : (cur.personaTone || detail.tone || ''), rows: 5,
        style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.6 },
        placeholder: isCustom ? '自己写一段，比如：暧昧模式——话里有话，彼此试探，谁都不先说破，但每句都留一点甜。' : '',
        onChange: (e) => isCustom ? setCm({ tone: e.target.value }) : setField({ personaTone: e.target.value }) }),

      sectionTitle('—— 她的画像（AI 生成，可微调）——'),
      mbtiSelect('herMbti', '她的 MBTI'),
      areaField('herStrengths', '她的优势'),
      areaField('herWeaknesses', '她的短板'),

      sectionTitle('—— 你的画像（AI 生成，可微调）——'),
      mbtiSelect('userMbti', '你的 MBTI'),
      areaField('userStrengths', '你的优势'),
      areaField('userWeaknesses', '你的短板'),

      sectionTitle('—— 关系声明 ——'),
      h('div', { className: 'ab-flex', style: { gap: 12, flexWrap: 'wrap' } }, [
        h(Row, { label: '你的性别' },
          h(Select, { value: cur.userGender || '', width: 120, placeholder: '未声明',
            options: [{ value: '', label: '未声明' }, { value: 'male', label: '男' }, { value: 'female', label: '女' }, { value: 'nonbinary', label: '非二元' }, { value: 'other', label: '其他' }, { value: 'secret', label: '保密' }],
            onChange: (v) => setField({ userGender: v }) })),
        h(Row, { label: '关系性质' },
          h(Select, { value: cur.relationNature || '', width: 120, placeholder: '未声明',
            options: [{ value: '', label: '未声明' }, { value: 'straight', label: '异性' }, { value: 'mlm', label: '男同' }, { value: 'wlw', label: '女同' }, { value: 'bi', label: '双性' }, { value: 'pan', label: '泛性' }, { value: 'ace', label: '无性恋' }, { value: 'other', label: '其他' }],
            onChange: (v) => setField({ relationNature: v }) }))
      ]),
    ]) : null,
  ])

  return h(Card, { title: '快来跟我恋爱吧', icon: '💘',
    desc: '教她怎么爱你：选一种关系模式，她的相处风格、主动程度、聊天技巧会整体切换。画像由 AI 生成，可在高级里微调。' },
    [
      h('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } }, [leftCol, rightCol]),
      kbSection,
      // ── 悬浮保存条：有改动时吸在屏幕底部，改完随手点 ──
      dirty ? h('div', { style: {
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 999,
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px',
          background: 'var(--ab-card-bg, #1e2126)', border: '1px solid rgba(128,128,128,.35)',
          borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,.35)'
        } }, [
          h('span', { className: 'ab-small', style: { color: '#e8c468', fontWeight: 600 } }, '✏️ 有改动还没生效'),
          h(Btn, { small: true, onClick: () => setDraft(null) }, '撤销'),
          h(Btn, { small: true, onClick: confirm }, '确认生效')
        ]) : null,
    ])
}
