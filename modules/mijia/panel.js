// panel.js —— 米家智控面板（一张卡管全）：扫码登录在上、设备列表与手动开关在下
// 由面板宿主执行：拿到 React、h（createElement）、ui（自带组件）、call（调模块路由），
// 最后 return 一个 React 组件。路由实现在 index.mjs 的 /qr/start、/qr/poll、/qr/state、
// /devices、/control。登录全程无账号密码：米家 APP 扫二维码即可。

const { useState, useEffect, useCallback, useRef } = React

const TYPE_ICON = { light: '💡', switch: '🔌', ac: '❄️', curtain: '🪟', fan: '🌀', sensor: '📡', hub: '🎥', other: '📦' }

return function Panel({ settings, draftSettings, setSettings, save, toast }) {
  // ---- 设置：全部走宿主草稿（draftSettings / setSettings），与页面底部「保存设置」同一条链路 ----
  // 为什么要这样：面板自己 useState 存一份草稿时，改动只活在组件内部——既不会同步进宿主的
  // draft.ext.mijia（底部「有改动还没保存」不出现、切标签页组件重挂就全丢），而这个面板本身
  // 又没有保存按钮，于是「授权名单、仅私聊、缓存秒数」改了跟没改一样。旧面板宿主不提供
  // setSettings 时才退回本地草稿 + 面板自带的「保存设置」按钮（见下面 saveNow）。
  const editable = typeof setSettings === 'function'
  const [local, setLocal] = useState({})
  const base = { ...(settings || {}), ...(draftSettings || {}) }
  const cfg = editable ? base : { ...base, ...local }
  const set = (k, v) => {
    if (editable) return setSettings({ [k]: v })
    setLocal((d) => ({ ...d, [k]: v }))
  }
  // 旧宿主兜底：直接把整份配置交给宿主写盘（新宿主不走这条路）
  const saveNow = () => save(cfg)

  const [devices, setDevices] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyDid, setBusyDid] = useState('')
  // 筛选：房间 / 类型（「全部」= 不筛）
  const [roomFilter, setRoomFilter] = useState('全部')
  const [typeFilter, setTypeFilter] = useState('全部')
  // 家庭：面板上临时只看哪一家（'全部' = 不限）；不落盘，改设置里的「默认只看」用 draft.homeName
  const [homeFilter, setHomeFilter] = useState('全部')
  const [homes, setHomes] = useState([])

  // ---- 扫码登录状态机：idle → qr（二维码已就绪，等待/轮询中）→ done ----
  const [qr, setQr] = useState(null) // { qr: 图片URL, loginUrl: 跳转链接 }
  const [qrBusy, setQrBusy] = useState(false)
  const [qrMessage, setQrMessage] = useState('')
  const pollAbort = useRef(false)

  const persist = async (skipToast) => {
    try {
      await saveNow()
      if (!skipToast) toast('设置已保存')
      return true
    } catch (e) {
      toast('保存失败：' + String((e && e.message) || e))
      return false
    }
  }

  // ---- 设备列表 ----
  // 当前状态列：did -> { on, brightness, colorTemp }
  const [states, setStates] = useState({})
  const statesBusy = useRef(false)

  const loadStates = useCallback(async (items) => {
    const targets = items.filter((d) => d.isOnline && d.controllable)
    if (!targets.length || statesBusy.current) return
    statesBusy.current = true
    try {
      const r = await call('/state', { dids: targets.map((d) => d.did) })
      if (r && r.ok) {
        setStates(r.states || {})
        // 规格控件表跟着状态一起回来：状态列不用等点「调节」才有语义可显示
        if (r.specs) setSpecMap((m) => ({ ...m, ...r.specs }))
      }
    } catch { /* 状态列尽力而为：失败就留空 */ }
    finally { statesBusy.current = false }
  }, [])

  const load = useCallback(async (refresh, homeArg) => {
    setLoading(true)
    setError('')
    try {
      const homeNow = homeArg === undefined ? homeFilter : homeArg
      const qs = []
      if (refresh) qs.push('refresh=1')
      if (homeNow && homeNow !== '全部') qs.push('home=' + encodeURIComponent(homeNow))
      const r = await call('/devices' + (qs.length ? '?' + qs.join('&') : ''))
      if (r && r.ok) {
        if (r.homes) setHomes(r.homes)
        setDevices(r.devices || [])
        loadStates(r.devices || []) // 拉完列表顺手查真实状态
        if (refresh) toast(`已刷新，共 ${(r.devices || []).length} 台设备`)
      } else {
        setError((r && r.message) || '设备列表拉取失败')
      }
    } catch (e) {
      setError(String((e && e.message) || e))
    } finally {
      setLoading(false)
    }
  }, [homeFilter])

  const control = async (d, on) => {
    setBusyDid(d.did)
    try {
      const r = await call('/control', { did: d.did, on })
      toast((r && r.message) || '指令已下发')
      if (r && r.ok) {
        // 乐观更新状态列：写到该型号规格里第一个开关控件的 key 上
        const toggle = (specMap[d.model]?.controls || []).find((c) => c.kind === 'toggle')
        setStates((s) => ({ ...s, [d.did]: { ...s[d.did], ...(toggle ? { [toggle.key]: on } : {}) } }))
      }
    } catch (e) {
      toast(String((e && e.message) || e))
    } finally {
      setBusyDid('')
    }
  }

  const logoutReq = async () => {
    if (!window.confirm('确定退出登录吗？本机登录凭证会被清除，下次控制设备前需重新扫码。')) return
    pollAbort.current = true // 若正在等扫码，先停掉轮询
    setQr(null)
    try {
      const r = await call('/logout', {})
      if (r && r.ok) {
        setDevices(null)
        setStates({})
        setQrMessage(r.message || '已退出登录')
        toast(r.message || '已退出登录')
      } else {
        toast((r && r.message) || '退出失败')
      }
    } catch (e) {
      toast(String((e && e.message) || e))
    }
  }

  // ---- 扫码登录：领码 → 展示 → 长轮询等扫（/qr/poll 会挂住最多 ~120 秒）----
  const qrStartReq = async () => {
    setQrBusy(true)
    setQrMessage('')
    try {
      const r = await call('/qr/start', {})
      if (r && r.ok && r.refreshed) {
        setQr(null)
        setQrMessage(r.message || '登录凭证仍有效')
        toast(r.message || '登录凭证仍有效')
        load(false)
        return
      }
      if (r && r.ok) {
        setQr({ qr: r.qr || '', loginUrl: r.loginUrl || '' })
        setQrMessage('请用米家 APP 扫一扫（手机端也可点下方链接确认）')
        pollLoop()
      } else {
        setQrMessage((r && r.message) || '领取二维码失败')
      }
    } catch (e) {
      setQrMessage(String((e && e.message) || e))
    } finally {
      setQrBusy(false)
    }
  }

  /** 长轮询循环：一次挂 120 秒，超时自动重领码再等；组件卸载或登录成功即停 */
  const pollLoop = async () => {
    pollAbort.current = false
    while (!pollAbort.current) {
      try {
        const r = await call('/qr/poll', {})
        if (r && r.ok) {
          setQr(null)
          setQrMessage(r.message || '扫码登录成功')
          toast('扫码登录成功')
          load(false)
          return
        }
        if (r && r.timeout) {
          // 挂满一轮没扫：自动再领一张新码接着等
          const s = await call('/qr/start', {})
          if (s && s.ok && !s.refreshed && s.qr) {
            setQr({ qr: s.qr, loginUrl: s.loginUrl || '' })
            setQrMessage('二维码已刷新，请继续扫')
            continue
          }
          setQrMessage('等待超时，请重新点「扫码登录」')
          return
        }
        setQrMessage((r && r.message) || '扫码未完成')
        return
      } catch (e) {
        if (pollAbort.current) return
        setQrMessage(String((e && e.message) || e))
        return
      }
    }
  }

  useEffect(() => {
    // 进面板先探登录态：已登录直接拉设备
    call('/qr/state', {}).then((r) => {
      if (r && r.ok && r.loggedIn) load(false)
    }).catch(() => {})
    return () => { pollAbort.current = true }
  }, [])

  // ---- 小件 ----
  const field = (label, node, hint) =>
    h('div', { style: { marginBottom: 10 } },
      h('label', { className: 'ab-small ab-muted', style: { display: 'block', marginBottom: 2 } }, label),
      node,
      hint && h('div', { className: 'ab-small ab-muted' }, hint))

  // ---- 设备表：表头 + 斑马纹行 + 大按钮命中区；灯类可展开「调节」滑条 ----
  const list = devices || []
  const online = list.filter((d) => d.isOnline)
  const offline = list.filter((d) => !d.isOnline)
  // 筛选项从设备列表现算（去重排序）；类型用 /devices 路由附带的 label（型号分类）
  const homeOptions = ['全部', ...homes.map((hm) => hm.name)]
  const homeLabel = (name) => {
    const hm = homes.find((x) => x.name === name)
    return hm && hm.shared ? `${name}（共享）` : name
  }
  const roomOptions = ['全部', ...Array.from(new Set(list.map((d) => d.roomName || '未分配'))).sort()]
  const typeOptions = ['全部', ...Array.from(new Set(list.map((d) => d.label || '其他'))).sort()]
  const filtered = list.filter((d) =>
    (roomFilter === '全部' || (d.roomName || '未分配') === roomFilter) &&
    (typeFilter === '全部' || (d.label || '其他') === typeFilter))
  const fOnline = filtered.filter((d) => d.isOnline)
  const fOffline = filtered.filter((d) => !d.isOnline)
  const select = (value, options, onChange, label) =>
    h('label', { className: 'ab-small ab-muted', style: { display: 'flex', alignItems: 'center', gap: 4 } },
      label,
      h('select', { className: 'ab-input', value, onChange: (e) => onChange(e.target.value), style: { width: 130 } },
        options.map((o) => h('option', { key: o, value: o }, o))))

  // 调节展开行的状态：型号规格缓存（规格驱动，不分设备类型）+ 每设备控件临时值
  const [expandedDid, setExpandedDid] = useState(null)
  const [specMap, setSpecMap] = useState({}) // model -> { controls: [...] }
  const [ctlVals, setCtlVals] = useState({}) // did -> { [control.key]: 临时值 }
  const specBusy = useRef(false)

  const ensureSpec = async (model) => {
    if (specMap[model] || specBusy.current) return specMap[model] || null
    specBusy.current = true
    try {
      const r = await call('/spec?model=' + encodeURIComponent(model))
      if (r && r.ok) {
        setSpecMap((m) => ({ ...m, [model]: r.props }))
        return r.props
      }
      toast((r && r.message) || '查规格失败')
    } catch (e) {
      toast(String((e && e.message) || e))
    } finally {
      specBusy.current = false
    }
    return null
  }

  const toggleExpand = async (d) => {
    if (expandedDid === d.did) { setExpandedDid(null); return }
    setExpandedDid(d.did)
    const props = await ensureSpec(d.model)
    if (props?.controls?.length) {
      // 控件初值：优先用查到的真实状态，滑条没有状态值时取量程中点，下拉取第一档
      setCtlVals((v) => ({
        ...v,
        [d.did]: Object.fromEntries(props.controls.map((c) => [
          c.key,
          states[d.did]?.[c.key] ??
            (c.kind === 'slider' ? Math.round((c.min + c.max) / (2 * (c.step || 1))) * (c.step || 1) : null),
        ])),
      }))
    }
  }

  const sendProp = async (d, control, value) => {
    try {
      const r = await call('/prop', { did: d.did, key: control.key, value })
      toast((r && (r.ok ? r.message : r.message)) || '已调整')
      if (r && r.ok) setStates((s) => ({ ...s, [d.did]: { ...s[d.did], [control.key]: value } })) // 乐观更新状态列
    } catch (e) {
      toast(String((e && e.message) || e))
    }
  }

  // 表格布局：grid 六列（名称 | 房间 | 类型/型号 | 在线 | 当前状态 | 操作）
  const COLS = 'minmax(120px,1.3fr) minmax(70px,0.8fr) minmax(110px,1fr) 48px 150px 158px'
  const cell = (node, opts = {}) =>
    h('div', { style: { display: 'flex', alignItems: 'center', minHeight: 30, ...opts } }, node)
  const headerRow = () =>
    h('div', { style: { display: 'grid', gridTemplateColumns: COLS, gap: 6, padding: '6px 8px', color: '#666', fontSize: 12, borderBottom: '2px solid rgba(0,0,0,0.10)' } },
      cell('设备'), cell('房间'), cell('类型 / 型号'), cell('在线'), cell('当前状态'), cell('操作'))
  // 当前状态列：只报核心参数——开关永远第一，其余最多挑 2 项核心（亮度/色温/音量/温度/风速等）
  const stateText = (d) => {
    const controls = specMap[d.model]?.controls || []
    const st = states[d.did]
    if (!st || !Object.keys(st).length) return controls.length ? '…' : '—'
    const label = (c) => c.zh || c.name
    const toggle = controls.find((c) => c.kind === 'toggle')
    const bits = []
    if (toggle) bits.push(st[toggle.key] === false ? '关' : '开')
    const cores = controls.filter((c) => c !== toggle && c.core && c.kind !== 'toggle').slice(0, 2)
    for (const c of cores) {
      const v = st[c.key]
      if (v === undefined || v === null || v === '') continue
      if (c.kind === 'select') {
        const opt = (c.options || []).find((o) => o.value === v)
        bits.push(`${label(c)} ${opt ? opt.label : v}`)
      } else if (c.kind === 'slider') {
        bits.push(`${label(c)} ${v}${c.unit || ''}`)
      }
    }
    return bits.join(' · ') || '—'
  }
  const devBtn = (label, onClick, disabled, primary) =>
    h('button', {
      onClick,
      disabled,
      style: {
        minWidth: 48, padding: '6px 10px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid ' + (primary ? '#2563eb' : '#d0d5dd'),
        background: primary ? '#2563eb' : '#fff',
        color: primary ? '#fff' : '#333',
      },
    }, label)
  const devRow = (d, idx) => {
    const zebra = idx % 2 === 0 ? 'rgba(0,0,0,0.028)' : 'transparent'
    const expanded = expandedDid === d.did
    const rows = [
      h('div', {
        key: d.did,
        style: {
          display: 'grid', gridTemplateColumns: COLS, gap: 6, padding: '8px 8px',
          background: zebra, borderBottom: '1px solid rgba(0,0,0,0.06)', borderRadius: expanded ? '6px 6px 0 0' : 0,
        },
      },
        cell(h('span', { style: { fontWeight: 500 } }, (TYPE_ICON[d.type] || TYPE_ICON.other) + ' ' + d.name)),
        cell(h('span', { className: 'ab-muted', style: { fontSize: 12 } }, d.roomName || '未分配')),
        cell(h('span', { className: 'ab-muted', style: { fontSize: 12 } }, d.label + ' · ' + d.model)),
        cell(h('span', { style: { fontSize: 12, color: d.isOnline ? '#16a34a' : '#98a2b3' } }, d.isOnline ? '在线' : '离线')),
        cell(h('span', {
          style: { fontSize: 12, color: '#2563eb', fontWeight: 500 },
          title: '设备真实状态（按型号规格里查到的当前值）',
        }, stateText(d))),
        cell(h('span', { style: { display: 'flex', gap: 6 } },
          d.isOnline && d.controllable
            ? h('span', { style: { display: 'flex', gap: 6 } },
                devBtn('开', () => control(d, true), busyDid === d.did, true),
                devBtn('关', () => control(d, false), busyDid === d.did, false))
            : h('span', { className: 'ab-muted', style: { fontSize: 12 } }, d.isOnline ? '仅查看' : '—'),
          d.isOnline && d.controllable
            ? devBtn(expanded ? '收起' : '调节', () => toggleExpand(d), false, false)
            : null)),
      ),
    ]
    // 展开的调节行：按型号规格渲染全部控件——
    //   bool → 开/关按钮；数值(value-range) → 滑条（松手才下发）；枚举(value-list) → 下拉。
    // 灯出亮度/色温、风扇出风量/摆头、空调出温度/模式、窗帘出位置……规格说了算。
    if (expanded && d.isOnline) {
      const controls = specMap[d.model]?.controls || []
      const vals = ctlVals[d.did] || {}
      if (!controls.length) {
        rows.push(h('div', { key: d.did + '-adj', style: { background: zebra, borderBottom: '1px solid rgba(0,0,0,0.06)', padding: '6px 12px' },
          className: 'ab-small ab-muted' }, '这个型号在规格库里没有可调项，只有上面的开关。'))
      } else {
        // 展开区：固定标签宽的多列网格，中文标签（字典没收录才留英文原文）
        rows.push(h('div', {
          key: d.did + '-adj',
          style: {
            background: zebra, borderBottom: '1px solid rgba(0,0,0,0.06)', padding: '10px 12px',
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '10px 24px',
          },
        },
          controls.map((c) => {
            const val = vals[c.key]
            const lab = h('span', {
              title: c.name, // 悬停看规格原文
              style: { width: 76, flex: '0 0 76px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#555' },
            }, c.zh || c.name)
            if (c.kind === 'toggle') {
              const on = val !== false
              return h('div', { key: c.key, style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 } },
                lab,
                devBtn(on ? '关' : '开', () => {
                  const nv = !on
                  setCtlVals((v) => ({ ...v, [d.did]: { ...v[d.did], [c.key]: nv } }))
                  sendProp(d, c, nv)
                }, false, on))
            }
            if (c.kind === 'slider') {
              const v = typeof val === 'number' ? val : c.min
              return h('div', { key: c.key, style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 } },
                lab,
                h('input', {
                  type: 'range', min: c.min, max: c.max, step: c.step || 1, value: v,
                  onChange: (e) => setCtlVals((s) => ({ ...s, [d.did]: { ...s[d.did], [c.key]: Number(e.target.value) } })),
                  onMouseUp: (e) => sendProp(d, c, Number(e.target.value)),
                  onTouchEnd: (e) => sendProp(d, c, Number(e.target.value)),
                  style: { flex: 1 },
                }),
                h('span', { className: 'ab-muted', style: { width: 64, textAlign: 'right', fontSize: 12 } }, `${v}${c.unit || ''}`))
            }
            if (c.kind === 'select') {
              return h('div', { key: c.key, style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 } },
                lab,
                h('select', {
                  className: 'ab-input', style: { flex: 1, width: 'auto' },
                  value: val ?? (c.options?.[0]?.value ?? ''),
                  onChange: (e) => {
                    const nv = Number(e.target.value)
                    setCtlVals((s) => ({ ...s, [d.did]: { ...s[d.did], [c.key]: nv } }))
                    sendProp(d, c, nv)
                  },
                },
                (c.options || []).map((o) => h('option', { key: o.value, value: o.value }, o.label))))
            }
            return null
          })))
      }
    }
    return rows
  }
  const table = (items, startIndex = 0) =>
    h('div', { style: { border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, overflow: 'hidden', marginTop: 6 } },
      headerRow(),
      items.map((d, i) => devRow(d, startIndex + i)).flat())
  return h(ui.Card, {
    title: '💡 米家智控',
    right: h('span', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
      h('span', { className: 'ab-small ab-muted' }, '总开关'),
      // 总开关即切即存：它是「她能不能碰设备」的安全开关，不能等底部保存，免得以为关了其实没关。
      // 新宿主直接写 ext.mijia；旧宿主（无 setSettings）退回整份 save + 本地面板按钮。
      h(ui.Switch, {
        on: cfg.enabled === true,
        title: '总开关',
        onChange: () => {
          const v = !(cfg.enabled === true)
          set('enabled', v)
          if (!editable) save({ ...cfg, enabled: v })
        },
      })),
  },

    // ======== 扫码登录（无需账号密码）========
    h('div', null,
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' } },
        h(ui.Btn, { disabled: qrBusy, onClick: qrStartReq }, qrBusy ? '领取中…' : '扫码登录'),
        h(ui.Btn, { onClick: logoutReq }, '退出登录'),
        h('span', { className: 'ab-small ab-muted' }, '用米家 APP 扫二维码登录，无需账号密码与短信验证')),
      qrMessage && h('div', { className: 'ab-note', style: { margin: '4px 0' } }, qrMessage),
      qr && h('div', { style: { margin: '8px 0', textAlign: 'center' } },
        qr.qr
          ? h('img', { src: qr.qr, alt: '米家登录二维码', width: 180, height: 180, style: { background: '#fff', padding: 6, borderRadius: 8 } })
          : null,
        qr.loginUrl && h('div', { style: { marginTop: 6 } },
          h('a', { href: qr.loginUrl, target: '_blank', className: 'ab-small' }, '手机打不开扫码？点这个链接确认登录')),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, '等待扫码中，超时会自动换新码…'))),

    // ======== 其他设置 ========
    h('div', { style: { marginTop: 12 } },
      field('授权名单（每行一个 QQ 号，主人永远放行）',
        h('textarea', { className: 'ab-input', rows: 2, value: cfg.whitelist || '', onChange: (e) => set('whitelist', e.target.value), style: { width: '100%' } })),
      h('div', { style: { display: 'flex', gap: 16, alignItems: 'center' } },
        field('仅私聊可用',
          h('label', null,
            h('input', { type: 'checkbox', checked: cfg.privateOnly !== false, onChange: (e) => set('privateOnly', e.target.checked) }),
            ' 开')),
        field('设备缓存秒数',
          h('input', { className: 'ab-input', type: 'number', min: 30, max: 3600, step: 30, value: cfg.cacheSeconds ?? 300, onChange: (e) => set('cacheSeconds', e.target.value), style: { width: 120 } }))),
      // 默认只看哪个家（上游 1.1.1 新增；改走宿主草稿链路 cfg，不再用本地 draft）
      field('默认只看哪个家（空=全部家庭；房间/设备会按这个家限定）',
        h('select', {
          className: 'ab-input',
          value: cfg.homeName || '',
          style: { width: 220 },
          onChange: (e) => set('homeName', e.target.value),
        }, ['', ...homes.map((hm) => hm.name)].map((o) => h('option', { key: o || 'all', value: o }, o ? homeLabel(o) : '全部家庭')),
          homes.length ? null : h('option', { key: 'none', value: '' }, '（先扫码登录后才列得出家庭）')),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } }, '只影响 QQ 消息与工具调用；面板筛选随时可切。')),
      // 新宿主：改动进宿主草稿，靠页面底部「保存设置」统一落盘（与其它模块一致）。
      editable ? null : h('div', { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
        h(ui.Btn, { kind: 'primary', onClick: () => persist(false) }, '保存设置'),
        h('span', { className: 'ab-small ab-muted' }, '当前面板没有宿主草稿接口，改完要点这里保存'))),

    // ======== 设备列表（房间 / 类型筛选）========
    h('div', { style: { marginTop: 12 } },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { className: 'ab-small ab-muted' },
          `设备：共 ${list.length} 台 · 在线 ${online.length} · 离线 ${offline.length}` +
          (filtered.length !== list.length ? ` · 筛出 ${filtered.length} 台` : '')),
        h('span', { style: { flex: 1 } }),
        // 家庭下拉：切换后立刻按该家重新拉设备（服务端还会回一份家庭清单）
        h('label', { className: 'ab-small ab-muted', style: { display: 'flex', alignItems: 'center', gap: 4 } },
          '家庭',
          h('select', {
            className: 'ab-input',
            value: homeFilter,
            style: { width: 150 },
            onChange: (e) => {
              const v = e.target.value
              setHomeFilter(v)
              setRoomFilter('全部') // 换家后房间选项会变，先清零
              load(false, v)
            },
          }, homeOptions.map((o) => h('option', { key: o, value: o }, o === '全部' ? '全部家庭' : homeLabel(o)))),
          homes.length > 1 && h('span', { className: 'ab-small ab-muted' }, `（${homes.length} 个）`)),
        select(roomFilter, roomOptions, setRoomFilter, '房间'),
        select(typeFilter, typeOptions, setTypeFilter, '类型'),
        h(ui.Btn, { disabled: loading, onClick: () => load(true) }, loading ? '刷新中…' : '刷新设备列表')),
      error && h('p', { className: 'ab-note' }, '⚠ ' + error + '（先在上面扫码登录）'),
      !devices && !error && h('p', { className: 'ab-note' }, loading ? '正在拉取设备…' : '扫码登录后，设备会列在这里。'),
      devices && !list.length && h('p', { className: 'ab-note' }, '米家账号下没有设备。'),
      devices && list.length && !filtered.length && h('p', { className: 'ab-note' }, '当前筛选条件下没有设备。'),
      fOnline.length > 0 && table(fOnline, 0),
      fOffline.length > 0 && h('div', { style: { marginTop: 10 } },
        h('p', { className: 'ab-small ab-muted', style: { margin: '2px 0' } }, '—— 离线 ——'),
        table(fOffline, fOnline.length)),
      list.length > 0 && h('p', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
        '灯类设备点「调节」展开亮度/色温滑条（松手才下发）；同一设备指令间隔 1.2 秒防风控。')))
}
