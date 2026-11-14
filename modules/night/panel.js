const { useState, useEffect } = React

const STAGE_COLORS = {
  n1: '#8d9bb0',
  n2: '#5b7fa6',
  n3: '#2f4f7a',
  rem: '#7d5ba6',
}

const MODE_TEXT = { awake: '醒着', asleep: '睡着', waking: '正在醒' }

function clock(ts) {
  if (!ts) return '--:--'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function stamp(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(ts)}`
}

return function Panel({ settings, draftSettings, setSettings, save, toast }) {
  const s = draftSettings || settings || {}
  const [state, setState] = useState(null)
  const [dreams, setDreams] = useState([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const patch = (p) => (setSettings ? setSettings(p) : save(p))

  async function refresh() {
    try {
      const r = await call('/state')
      setState(r || null)
    } catch (error) {
      setState(null)
      setHint('读取状态失败：' + (error && error.message ? error.message : error))
    }
    try {
      const r = await call('/dreams')
      setDreams(Array.isArray(r && r.items) ? r.items : [])
    } catch {
      setDreams([])
    }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => clearInterval(timer)
  }, [])

  async function act(path, body) {
    setBusy(true)
    setHint('')
    try {
      const r = body ? await call(path, body) : await call(path)
      setHint((r && r.message) || (r && r.ok ? '好了' : '没成功'))
      await refresh()
    } catch (error) {
      setHint('操作失败：' + (error && error.message ? error.message : error))
    } finally {
      setBusy(false)
    }
  }

  const mode = state ? state.mode : ''
  const asleep = mode === 'asleep'
  const energy = state ? Number(state.energy) || 0 : 0
  const max = state ? Number(state.energyMax) || 100 : 100
  const percent = Math.max(0, Math.min(100, Math.round((energy / max) * 100)))
  const seq = state && Array.isArray(state.stageSeq) ? state.stageSeq : []
  const span = seq.length ? seq[seq.length - 1].end - seq[0].start : 0

  return h(ui.Card, { title: '长夜如梦' },
    h(ui.Row, { style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px' } },
      h('div', null,
        h('div', { style: { fontWeight: 600 } },
          state ? `${MODE_TEXT[mode] || mode}` : '读取中…',
          state && state.fatigue ? h('span', { className: 'ab-small ab-muted' }, `　疲劳期（${state.fatigue === 'noon' ? '午间' : '夜间'}）`) : null
        ),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: '4px' } },
          state
            ? `精力 ${Math.round(energy)}/${max}　起床点 ${state.wakeTime} ±${state.wakeJitter} 分　可唤醒 ${state.wakeMode === 'never' ? '谁都不叫' : state.wakeMode === 'both' ? '私聊+群聊' : '只有私聊'}　${state.timeZone || ''} ${state.nowClock || ''}`
            : '-'
        )
      ),
      h(ui.Row, { style: { gap: '8px' } },
        h(ui.Btn, { onClick: refresh, disabled: busy }, '刷新'),
        h(ui.Btn, { onClick: () => act('/wake'), disabled: busy || !asleep }, '叫醒'),
        h(ui.Btn, { onClick: () => act('/sleep', { kind: 'night' }), disabled: busy || asleep }, '去睡'),
        h(ui.Btn, { onClick: () => act('/sleep', { kind: 'noon' }), disabled: busy || asleep }, '午睡'),
        state && state.muted
          ? h(ui.Btn, { onClick: () => act('/unmute'), disabled: busy }, '解除闭嘴')
          : null
      )
    ),

    h('div', { style: { marginTop: '10px' } },
      h('div', { style: { height: '10px', background: '#e6e9ef', borderRadius: '6px', overflow: 'hidden' } },
        h('div', {
          style: {
            width: percent + '%', height: '100%',
            background: percent <= 25 ? '#c62828' : percent <= 55 ? '#ef8a2b' : '#2e7d32',
            transition: 'width .3s',
          },
        })
      ),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: '4px' } }, `精力 ${percent}%`)
    ),

    asleep && state
      ? h('div', { style: { marginTop: '12px' } },
        h('div', { className: 'ab-small', style: { marginBottom: '6px' } },
          `预计 ${state.wakeDayLabel || ''}${state.wakeAtClock || clock(state.wakeAt)} 醒　剩余 ${state.remainingText || ''}　${state.stageText || ''}`
        ),
        h('div', { style: { display: 'flex', height: '16px', borderRadius: '6px', overflow: 'hidden', background: '#f0f2f6' } },
          seq.map((seg, index) => {
            const width = span ? ((seg.end - seg.start) / span) * 100 : 0
            return h('div', {
              key: index,
              title: `${seg.label} ${clock(seg.start)}-${clock(seg.end)}`,
              style: {
                width: width + '%',
                background: STAGE_COLORS[seg.key] || '#999',
                opacity: seg.active ? 1 : 0.55,
                borderRight: index === seq.length - 1 ? 'none' : '1px solid #fff',
              },
            })
          })
        ),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: '4px' } },
          seq.length
            ? `深度 ${state.stageStats ? state.stageStats.n3 : 0} 分　REM ${state.stageStats ? state.stageStats.rem : 0} 分　当前阶段还剩 ${state.stageRemainingText || '-'}`
            : '睡眠阶段关着'
        ),
        state.pendingCrawl
          ? h('div', { className: 'ab-small ab-muted', style: { marginTop: '4px' } }, `醒来要爬 ${state.pendingCrawl} 个会话`)
          : null
      )
      : null,

    mode === 'waking' && state
      ? h('div', { className: 'ab-note', style: { marginTop: '10px' } },
        `正在醒：待爬 ${state.pendingCrawl || 0} 个会话，${Math.round((state.wakingLeft || 0) / 60000)} 分钟后自动算醒`
      )
      : null,

    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '14px' } },
      h('label', { className: 'ab-small' }, '起床点（HH:MM）',
        h('input', {
          className: 'ab-input', value: s.wakeTime || '08:00',
          onChange: (e) => patch({ wakeTime: e.target.value }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '起床浮动（±分钟）',
        h('input', {
          className: 'ab-input', type: 'number', min: 0, max: 90, value: s.wakeJitterMinutes ?? 40,
          onChange: (e) => patch({ wakeJitterMinutes: Number(e.target.value) }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '夜间疲劳时段',
        h('input', {
          className: 'ab-input', value: s.nightFatigue || '23:30-07:00',
          onChange: (e) => patch({ nightFatigue: e.target.value }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '午间疲劳时段',
        h('input', {
          className: 'ab-input', value: s.noonFatigue || '13:00-14:30',
          onChange: (e) => patch({ noonFatigue: e.target.value }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '最晚睡觉时间',
        h('input', {
          className: 'ab-input', value: s.latestSleepTime || '02:30',
          onChange: (e) => patch({ latestSleepTime: e.target.value }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '作息时区',
        h('input', {
          className: 'ab-input', value: s.timeZone || 'Asia/Shanghai',
          onChange: (e) => patch({ timeZone: e.target.value }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '谁能叫醒她',
        h('select', {
          className: 'ab-input', value: s.wakeMode || 'private_only',
          onChange: (e) => patch({ wakeMode: e.target.value }),
          style: { width: '100%', marginTop: '4px' },
        },
          h('option', { value: 'never' }, '谁都不叫'),
          h('option', { value: 'private_only' }, '只有私聊'),
          h('option', { value: 'both' }, '私聊 + 群聊（要 @）')
        )
      ),
      h('label', { className: 'ab-small' }, '疲劳期每条消息扣精力',
        h('input', {
          className: 'ab-input', type: 'number', min: 0, max: 20, value: s.energyPerMessage ?? 4,
          onChange: (e) => patch({ energyPerMessage: Number(e.target.value) }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '睡眠周期（分钟）',
        h('input', {
          className: 'ab-input', type: 'number', min: 20, max: 180, value: s.stageCycleMinutes ?? 90,
          onChange: (e) => patch({ stageCycleMinutes: Number(e.target.value) }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '叫醒：第几条开始掷骰',
        h('input', {
          className: 'ab-input', type: 'number', min: 1, max: 20, value: s.wakeStartCount ?? 2,
          onChange: (e) => patch({ wakeStartCount: Number(e.target.value) }),
          style: { width: '100%', marginTop: '4px' },
        })
      ),
      h('label', { className: 'ab-small' }, '叫醒：再几条必醒',
        h('input', {
          className: 'ab-input', type: 'number', min: 0, max: 20, value: s.wakeStepCount ?? 4,
          onChange: (e) => patch({ wakeStepCount: Number(e.target.value) }),
          style: { width: '100%', marginTop: '4px' },
        })
      )
    ),

    h(ui.Row, { style: { gap: '14px', marginTop: '12px', flexWrap: 'wrap' } },
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.allowSleep), onChange: (e) => patch({ allowSleep: e.target.checked }) }),
        ' 允许真睡'
      ),
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.stageEnabled), onChange: (e) => patch({ stageEnabled: e.target.checked }) }),
        ' 睡眠阶段'
      ),
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.dreamEnabled), onChange: (e) => patch({ dreamEnabled: e.target.checked }) }),
        ' 做梦'
      ),
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.dreamInRemOnly), onChange: (e) => patch({ dreamInRemOnly: e.target.checked }) }),
        ' 只在 REM 做梦'
      ),
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.farewellEnabled), onChange: (e) => patch({ farewellEnabled: e.target.checked }) }),
        ' 睡前道别'
      ),
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.farewellUseLlm), onChange: (e) => patch({ farewellUseLlm: e.target.checked }) }),
        ' 道别用模型'
      ),
      h('label', { className: 'ab-small' },
        h('input', { type: 'checkbox', checked: Boolean(s.morningGreeting), onChange: (e) => patch({ morningGreeting: e.target.checked }) }),
        ' 醒来给主人发早安'
      )
    ),

    hint ? h('div', { className: 'ab-small', style: { marginTop: '10px' } }, hint) : null,

    h('div', { style: { marginTop: '16px' } },
      h(ui.Row, { style: { justifyContent: 'space-between', alignItems: 'center' } },
        h('div', { style: { fontWeight: 600 } },
          '梦境',
          state && state.dreams ? h('span', { className: 'ab-small ab-muted' }, `　记得住 ${state.dreams.living} 段 / 共 ${state.dreams.total} 段`) : null
        ),
        h(ui.Row, { style: { gap: '8px' } },
          h(ui.Btn, { onClick: () => act('/dream', { force: true }), disabled: busy }, '现在做一段梦'),
          h(ui.Btn, { onClick: refresh }, '刷新')
        )
      ),
      dreams.length
        ? h('div', { style: { marginTop: '8px', display: 'grid', gap: '8px' } },
          dreams.map((d) => h('div', {
            key: d.id,
            style: { border: '1px solid #e3e6ec', borderRadius: '8px', padding: '10px' },
          },
            h(ui.Row, { style: { justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
              h('div', { className: 'ab-small' },
                h('span', { style: { color: '#7d5ba6', fontWeight: 600 } }, d.stars),
                `　${stamp(d.createdAt)}　${(d.tags || []).join('、')}　记忆强度 ${d.strength}%`
              ),
              h(ui.Row, { style: { gap: '6px' } },
                h(ui.Btn, { onClick: () => act('/dreams/pin', { id: d.id, pinned: !d.pinned }), disabled: busy }, d.pinned ? '取消置顶' : '置顶'),
                h(ui.Btn, { onClick: () => act('/dreams/delete', { id: d.id }), disabled: busy }, '删掉')
              )
            ),
            h('div', { className: 'ab-small', style: { marginTop: '6px', whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, d.text)
          ))
        )
        : h('div', { className: 'ab-note', style: { marginTop: '8px' } }, '还没有记得住的梦。她睡着以后会在 REM 阶段做梦，醒来按强度决定记得多少。')
    )
  )
}
