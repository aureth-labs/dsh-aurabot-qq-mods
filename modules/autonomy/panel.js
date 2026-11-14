// 自主生活面板：看她都干了什么、下次什么时候醒、还能手动叫醒一次
// 拿到 React / h / ui(Card,Btn,Switch,Row,Empty,Select) / call
const { useState, useEffect, useCallback } = React

// 路由可能挂在两个位置：扩展模块是 /aurabot/api/ext/autonomy/*，
// 而同名内置模块被替换时是 /aurabot/api/autonomy/*。都试一遍，谁通用谁。
const API_BASES = ['/aurabot/api/ext/autonomy', '/aurabot/api/autonomy', '/aurabot/api']
const api = async (p, body) => {
  const opts =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  for (const base of API_BASES) {
    try {
      const r = await fetch(base + p, opts)
      const j = await r.json()
      if (j && j.moduleOff) continue
      return j
    } catch (e) {
      /* 试下一个 */
    }
  }
  return { ok: false, message: '接口没找到' }
}

const ACTION_LABEL = {
  idle: '发呆',
  think: '想事情',
  speak: '找主人',
  bili: '刷B站',
  diary: '写日记',
  draw: '画画',
  free: '自由发挥',
}

const ACTION_COLOR = {
  idle: '#8a8a8a',
  think: '#7b8a9a',
  speak: '#e060a8',
  bili: '#1b5fd8',
  diary: '#2e9e44',
  draw: '#7b2fc0',
  free: '#1bb8c4',
}

function fmtTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

return function Panel({ settings, save, toast }) {
  const [state, setState] = useState(null)
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await api('/state')
      if (s && s.ok) setState(s)
      const a = await api('/activity')
      if (a && a.ok) setLog(a.items || [])
    } catch (e) {
      /* 接口还没起来 */
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 20000)
    return () => clearInterval(t)
  }, [refresh])

  async function wakeNow() {
    setBusy(true)
    try {
      const r = await api('/wake')
      if (r && r.ok) {
        toast(r.result && r.result.ok ? `她做了：${ACTION_LABEL[r.result.action] || r.result.action}` : (r.result && r.result.message) || '没醒成')
      }
      await refresh()
    } catch (e) {
      toast('叫醒失败：' + e.message)
    } finally {
      setBusy(false)
    }
  }

  const today = state && Array.isArray(state.done) ? state.done : []
  const counts = {}
  for (const x of log) counts[x.action] = (counts[x.action] || 0) + 1

  const statRow = (label, value) => h(ui.Row, { label }, h('span', { className: 'ab-note' }, String(value)))

  // 顶部快捷调节：常用的几个参数直接改，不用滚到页面下方的设置表单
  const numField = (label, key) =>
    h(
      'label',
      { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 } },
      label,
      h('input', {
        type: 'number',
        className: 'ab-input',
        style: { width: 64 },
        value: settings && settings[key] !== undefined ? settings[key] : '',
        onChange: (e) => save({ [key]: Number(e.target.value) }),
      }),
    )

  const P_LEVELS = ['low', 'medium', 'high']
  const pIdx = Math.max(0, P_LEVELS.indexOf((settings && settings.playfulness) || 'medium'))

  // ---------- 权限：默认什么都没有，一项一项开 ----------
  const RISK_COLOR = { 高: '#e060a8', 中: '#e0a020', 低: '#2e9e44' }
  const grants = (state && Array.isArray(state.grants)) ? state.grants : []
  const grantedCount = grants.filter((g) => g.granted).length
  const setGrant = (id, on) => {
    const cur = (settings && settings.grants) || {}
    save({ grants: { ...cur, [id]: !!on } })
  }

  const grantCard = h(ui.Card, { title: '权限（默认一项都没给）' },
    h('div', { className: 'ab-note ab-small', style: { marginBottom: 10 } },
      grantedCount === 0
        ? '现在什么都没授权。她只能发呆、想事情、歇着——不会调模型、也碰不到手机。要用哪一项，在下面单独打开。'
        : `已经开了 ${grantedCount} / ${grants.length} 项。没用到的保持关闭最安全。`,
    ),
    grants.length
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          grants.map((g, i) => {
            const on = !!(settings && settings.grants && settings.grants[g.id])
            return h('div', {
              key: g.id,
              style: {
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid ' + (on ? 'rgba(46,158,68,.35)' : 'rgba(127,127,127,.18)'),
                background: on ? 'rgba(46,158,68,.06)' : 'transparent',
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
                h('span', { className: 'ab-muted ab-small', style: { minWidth: 18 } }, `${i + 1}.`),
                h('span', { style: { fontWeight: 600, fontSize: 13, flex: 1 } }, g.title),
                h('span', {
                  style: {
                    fontSize: 11,
                    padding: '1px 7px',
                    borderRadius: 999,
                    color: RISK_COLOR[g.risk] || '#888',
                    background: (RISK_COLOR[g.risk] || '#888') + '22',
                    whiteSpace: 'nowrap',
                  },
                }, '风险 ' + g.risk),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: on,
                    onChange: (e) => setGrant(g.id, e.target.checked),
                  }),
                  on ? '已授权' : '未授权',
                ),
              ),
              h('div', { className: 'ab-small', style: { lineHeight: 1.6, color: 'rgba(127,127,127,.9)' } }, g.detail),
              h('div', { className: 'ab-muted ab-small', style: { marginTop: 6 } },
                '对应声明：' + g.capability,
              ),
            )
          }),
        )
      : h(ui.Empty, null, '读取中…'),
  )

  return h('div', null,
    grantCard,
    h(ui.Card, { title: '调节奏（改完立即生效）' },
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' } },
        numField('最短(分)', 'minInterval'),
        numField('最长(分)', 'maxInterval'),
        numField('每天上限', 'maxWakesPerDay'),
        numField('醒着从', 'awakeFrom'),
        numField('到', 'awakeTo'),
      ),
      h('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 } },
        h('span', { className: 'ab-small', style: { minWidth: 56 } }, '调皮程度'),
        h('input', {
          type: 'range',
          min: 0,
          max: 2,
          step: 1,
          value: pIdx,
          style: { flex: 1, maxWidth: 180 },
          onChange: (e) => save({ playfulness: P_LEVELS[Number(e.target.value)] }),
        }),
        h('span', { className: 'ab-muted ab-small' }, ['乖一点', '正常', '皮一点'][pIdx]),
      ),
      h('div', { className: 'ab-note ab-small', style: { marginTop: 8 } },
        '时段活跃度、手机玩耍倾向在页面下方的设置里。',
      ),
    ),

    h(ui.Card, { title: '现在的状态' },
      state
        ? h('div', null,
            statRow('今天醒了', `${state.used} 次`),
            statRow('下次醒来', state.nextWakeIn === null ? '还没排' : `${state.nextWakeIn} 分钟后`),
            statRow('当前时段倍率', `${state.rateNow}${state.rateNow < 1 ? '（活跃）' : state.rateNow > 1 ? '（安静）' : ''}`),
            statRow('今天计划', state.plan && state.plan.length ? state.plan.join('、') : '还没定'),
            statRow('性格（人格卡）', (state.mbti || '-') + ' · 调皮度 ' + ((state.config && state.config.playfulness) || 'medium')),
            statRow('心情', state.mood || '-'),
            state.note ? statRow('她留给自己的话', state.note) : null,
          )
        : h(ui.Empty, null, '读取中…'),
      h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } },
        h(ui.Btn, { onClick: wakeNow, disabled: busy }, busy ? '叫她起来…' : '现在叫醒她一次'),
        h(ui.Btn, { onClick: refresh }, '刷新'),
      ),
    ),

    h(ui.Card, { title: '今天做了什么' },
      today.length
        ? h('div', null, today.map((x, i) =>
            h('div', {
              key: i,
              style: { display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,.06)', alignItems: 'baseline' },
            },
              h('span', { className: 'ab-muted ab-small', style: { minWidth: 44 } }, fmtTime(x.at)),
              h('span', {
                style: {
                  minWidth: 62,
                  color: ACTION_COLOR[x.action] || '#aaa',
                  fontWeight: 600,
                  fontSize: 12,
                },
              }, ACTION_LABEL[x.action] || x.action),
              h('span', { className: 'ab-small', style: { flex: 1, wordBreak: 'break-all' } }, x.note || ''),
            ),
          ))
        : h(ui.Empty, null, '今天还没醒过'),
    ),

    h(ui.Card, { title: '活动流水（长期记录）' },
      log.length
        ? h('div', null,
            h('div', { className: 'ab-note ab-small', style: { marginBottom: 8 } },
              Object.keys(counts).map((k) => `${ACTION_LABEL[k] || k} ${counts[k]}`).join(' · '),
            ),
            log.slice(0, 60).map((x, i) =>
              h('div', { key: i, style: { padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,.05)' } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { className: 'ab-muted ab-small', style: { minWidth: 44 } }, fmtTime(x.at)),
                  h('span', { style: { color: ACTION_COLOR[x.action] || '#aaa', fontSize: 12, minWidth: 62 } }, ACTION_LABEL[x.action] || x.action),
                  h('span', { className: 'ab-small', style: { flex: 1 } }, x.note || ''),
                ),
                x.why ? h('div', { className: 'ab-muted ab-small', style: { paddingLeft: 114 } }, '理由：' + x.why) : null,
                x.output ? h('pre', {
                  className: 'ab-small',
                  style: { paddingLeft: 114, margin: '2px 0 0', whiteSpace: 'pre-wrap', opacity: 0.75, maxHeight: 80, overflow: 'hidden' },
                }, x.output.slice(0, 300)) : null,
              ),
            ),
          )
        : h(ui.Empty, null, '还没有记录'),
    ),
  )
}
