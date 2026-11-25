// travel 面板：概览 / 行程与票 / 定位与 Key / 引擎与路径 / 出门与活动 / 自检
// 可用：React、h、ui（Card / Btn / Switch / Row / Select）、call(路径, 请求体?)
const { useState, useEffect } = React

const TABS = ['概览', '行程与票', '定位与 Key', '引擎与路径', '出门与活动', '自检']

const box = { padding: '7px 0' }
const lab = { color: '#888', width: 132, display: 'inline-block' }
const inp = { padding: '6px 8px', border: '1px solid #444', borderRadius: 6, background: 'transparent', color: 'inherit', width: 260 }
const small = { fontSize: 12, color: '#999', lineHeight: 1.6 }
const mono = { fontFamily: 'monospace', fontSize: 12, color: '#9ad', wordBreak: 'break-all' }

function KV({ k, v }) {
  return h('div', { style: box }, h('span', { style: lab }, k), h('span', null, String(v == null || v === '' ? '-' : v)))
}
function Field({ label, value, onChange, placeholder, type }) {
  return h('div', { style: box },
    h('span', { style: lab }, label),
    h('input', { value: value || '', placeholder, type: type || 'text', autoComplete: 'off', spellCheck: false, onChange: (e) => onChange(e.target.value), style: inp }))
}
function NumField({ label, value, onChange, min, max }) {
  return h('div', { style: box },
    h('span', { style: lab }, label),
    h('input', { value: value == null ? '' : value, type: 'number', min, max, onChange: (e) => onChange(Number(e.target.value)), style: inp }))
}
function SelField({ label, value, onChange, options }) {
  return h('div', { style: box },
    h('span', { style: lab }, label),
    h('select', { value: value || '', onChange: (e) => onChange(e.target.value), style: inp },
      options.map((o) => h('option', { key: o.value, value: o.value }, o.label))))
}
function SwField({ label, value, onChange, hint }) {
  return h('div', { style: box },
    h('span', { style: lab }, label),
    h(ui.Switch, { checked: !!value, onChange: (v) => onChange(!!v) }),
    hint ? h('div', { style: { ...small, marginLeft: 136 } }, hint) : null)
}

return function Panel({ settings, save, toast }) {
  const st = settings || {}
  const [tab, setTab] = useState('概览')
  const [busy, setBusy] = useState(false)
  const [ov, setOv] = useState(null)
  const [msg, setMsg] = useState('')
  const [pos, setPos] = useState(null)
  const [cl, setCl] = useState(null)
  const [out, setOut] = useState(null)
  const [key, setKey] = useState(null)
  const [sc, setSc] = useState(null)
  const [tok, setTok] = useState('')

  const [cfg, setCfg] = useState({ mode: 'train', from: '成都东', to: '重庆北', date: '', code: '', city: '', note: '' })
  const [retDate, setRetDate] = useState('')
  const [newDate, setNewDate] = useState('')
  const [form, setForm] = useState({ amap: '', backup: '', tdt: '', flight: '' })

  const patchCfg = (p) => setCfg((c) => ({ ...c, ...p }))

  async function run(fn) {
    setBusy(true)
    try { await fn() } catch (e) { toast('出错了：' + (e && e.message ? e.message : e)) } finally { setBusy(false) }
  }
  const q = (obj) => Object.entries(obj).filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')

  async function loadOverview() {
    const r = await call('/hub/overview')
    if (r && r.token) setTok(r.token)
    setOv(r)
    return r
  }
  async function tokOrLoad() {
    const r = await call('/hub/overview')
    if (r && r.token) setTok(r.token)
    if (r) setOv(r)
    return (r && r.token) || ''
  }
  useEffect(() => { if (!ov) loadOverview() }, [])
  useEffect(() => { call('/real/key').then(setKey).catch(() => {}) }, [])

  // 设置保存：一次一个键，宿主负责落 config
  const setOne = async (k, v) => {
    try { await save({ [k]: v }); toast('已保存：' + k, 'ok') } catch (e) { toast('保存失败：' + (e.message || e), 'err') }
  }
  const saveKeys = async () => {
    const p = {}
    if (form.amap.trim()) p.real_amapKey = form.amap.trim()
    if (form.backup.trim()) p.real_amapKeyBackup = form.backup.trim()
    if (form.tdt.trim()) p.real_tdtTk = form.tdt.trim()
    if (form.flight.trim()) p.trip_flightKey = form.flight.trim()
    if (!Object.keys(p).length) return toast('没填新值，什么都没改', 'err')
    setBusy(true)
    try {
      await save(p)
      setForm({ amap: '', backup: '', tdt: '', flight: '' })
      await call('/real/key').then(setKey).catch(() => {})
      toast('保存好了，立刻生效（旧的数据文件若存在会被忽略，以这里为准）', 'ok')
    } catch (e) { toast('保存失败：' + (e.message || e), 'err') }
    setBusy('')
  }

  const header = h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
    TABS.map((t) => h(ui.Btn, { key: t, onClick: () => setTab(t), style: t === tab ? { fontWeight: 700 } : {} }, t)))

  let body = null

  if (tab === '概览') {
    body = h(ui.Card, { title: '现在的状态', desc: '只读。行程是唯一事实源，出门和定位卡片只作对照。' },
      ov ? h('div', null,
        h(KV, { k: '引擎', v: ov.engineReady ? '正常（内部 trip 引擎已就绪）' : '没加载' }),
        h(KV, { k: '行程', v: ov.trip ? ov.trip.line : '没有行程' }),
        h(KV, { k: '当前地点', v: ov.place ? ov.place.id : '-' }),
        h(KV, { k: '出门', v: ov.outings ? (ov.outings.trip ? '出门中 / ' + ov.outings.placeId : '没在出门') : '未读' }),
        h(KV, { k: '航班源', v: ov.flight && ov.flight.configured ? '已接（尾号 ' + ov.flight.keyTail + '）' : '留空：飞机不可用' }),
        ov.conflict ? h('div', { style: { marginTop: 8, color: '#e07a5f' } }, '⚠ ' + (ov.conflictNote || '行程与其它模块冲突，以行程为准')) : null,
      ) : h('div', null, '正在读取…'),
      h('div', { style: { marginTop: 10 } }, h(ui.Btn, { onClick: () => run(loadOverview), disabled: busy }, '刷新')))
  }

  if (tab === '行程与票') {
    body = h('div', null,
      h(ui.Card, { title: '规划 / 出发', desc: '按 12306（火车）或高德（同城）排；出票在「去出票」里单独一步，取不到真价就拒绝出票。' },
        h(SelField, { label: '方式', value: cfg.mode, onChange: (v) => patchCfg({ mode: v }), options: [
          { value: 'train', label: '火车 / 高铁（12306）' }, { value: 'transit', label: '公交地铁（高德）' },
          { value: 'drive', label: '开车（高德）' }, { value: 'walk', label: '走路（高德）' },
          { value: 'bike', label: '骑车（高德）' }, { value: 'flight', label: '飞机（需航班源）' }] }),
        h(Field, { label: '出发地', value: cfg.from, onChange: (v) => patchCfg({ from: v }), placeholder: '成都东 / 合江亭' }),
        h(Field, { label: '目的地', value: cfg.to, onChange: (v) => patchCfg({ to: v }), placeholder: '重庆北 / 德阳' }),
        h(Field, { label: '日期', value: cfg.date, onChange: (v) => patchCfg({ date: v }), placeholder: '2026-11-23（火车必填）' }),
        h(Field, { label: '车次', value: cfg.code, onChange: (v) => patchCfg({ code: v }), placeholder: '可选，如 Z316' }),
        h(Field, { label: '城市', value: cfg.city, onChange: (v) => patchCfg({ city: v }), placeholder: '公交要填，如 成都' }),
        h(Field, { label: '附一句', value: cfg.note, onChange: (v) => patchCfg({ note: v }), placeholder: '卡片上带的话（可选）' }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const r = await call('/hub/plan?' + q(cfg)); setMsg(r.message || r.error || JSON.stringify(r)) }) }, '只看看方案'),
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const t = await tokOrLoad(); const r = await call('/hub/go?' + q({ ...cfg, confirm: t })); setMsg(r.message || r.error || JSON.stringify(r)); await loadOverview() }) }, '出发'),
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const t = await tokOrLoad(); const r = await call('/hub/end?' + q({ confirm: t })); setMsg(r.message); await loadOverview() }) }, '结束行程')),
        msg ? h('div', { style: { marginTop: 10, lineHeight: 1.6 } }, msg) : null),

      h(ui.Card, { title: '往返 / 改签 / 退票', desc: '往返两段各一张票；改签后旧票号作废；退票不作废行程。' },
        h(Field, { label: '回程日期', value: retDate, onChange: setRetDate, placeholder: '2026-11-24' }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const t = await tokOrLoad(); const r = await call('/hub/roundtrip?' + q({ ...cfg, return_date: retDate, confirm: t })); setMsg(r.message || r.error || JSON.stringify(r)); await loadOverview() }) }, '排往返')),
        h(Field, { label: '改签日期', value: newDate, onChange: setNewDate, placeholder: '2026-11-24' }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' } },
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const t = await tokOrLoad(); const r = await call('/hub/rebook?' + q({ date: newDate, code: cfg.code, confirm: t })); setMsg(r.message || r.error || JSON.stringify(r)); await loadOverview() }) }, '改签'),
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const t = await tokOrLoad(); const r = await call('/hub/refund?' + q({ confirm: t })); setMsg(r.message || r.error || JSON.stringify(r)); await loadOverview() }) }, '退票'))),

      h(ui.Card, { title: '出票', desc: '真实票价只从 12306 取；取不到就拒绝出票，绝不编价。票面是纪念票。' },
        h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const r = await call('/book'); setMsg(r.message || r.error || JSON.stringify(r)) }) }, '出票（票面落盘，不代发聊天）')),
      msg ? h('div', { style: { marginTop: 10, whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, msg) : null,

      h(ui.Card, { title: '航班数据源', desc: '没填 Key 就不排飞机段，也不编航班号。' },
        h(SelField, { label: '数据源', value: st.trip_flightProvider, onChange: (v) => setOne('trip_flightProvider', v), options: [
          { value: '', label: '未接（飞机不可用）' }, { value: 'variflight', label: '飞常准' }, { value: 'other', label: '其他' }] }),
        h(Field, { label: 'Key', value: form.flight, onChange: (v) => setForm((f) => ({ ...f, flight: v })), placeholder: st.trip_flightKey ? '已保存（不改就留空）' : '没填就留空', type: 'password' })))
  }

  if (tab === '定位与 Key') {
    body = h('div', null,
      h(ui.Card, { title: '她现在在线路的哪一点', desc: '这里只显示推算；真要发给他，让她在聊天里用 travel_where（行程）或 loc_send（点位）。' },
        pos && pos.position ? h('div', null,
          h(KV, { k: '位置', v: pos.position.name }),
          h(KV, { k: '进度', v: Math.round((pos.position.progress || 0) * 100) + '%' }),
          h(KV, { k: '坐标', v: pos.position.lat + ', ' + pos.position.lon }),
          h(KV, { k: '地址', v: pos.position.addr || '-' }),
          h(KV, { k: '下一站', v: pos.position.next_station ? pos.position.next_station + ' ' + pos.position.next_arrive + ' 到' : '-' }),
        ) : h('div', null, pos && pos.state ? (pos.state === 'not_started' ? '还没出发，在起点。' : '已经到终点了。') : '没有行程或还没算。'),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } },
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => setPos(await call('/hub/here'))) }, '算一下'))),

      h(ui.Card, { title: '定位接口与 Key', desc: '一个接口一把 key：高德主、高德备、天地图。只存在本机 config，面板不回显明文，只显示后四位。' },
        h(Field, { label: '高德 Key（主）', value: form.amap, onChange: (v) => setForm((f) => ({ ...f, amap: v })), placeholder: tailOf(key, 'primary') || '去 lbs.amap.com → 控制台 → 应用管理 → 我的应用 → 添加 Key（Web 服务）', type: 'password' }),
        h(Field, { label: '高德 Key（备）', value: form.backup, onChange: (v) => setForm((f) => ({ ...f, backup: v })), placeholder: tailOf(key, 'backup') || '同样 Web 服务类型的新 Key', type: 'password' }),
        h(Field, { label: '天地图 tk', value: form.tdt, onChange: (v) => setForm((f) => ({ ...f, tdt: v })), placeholder: tailOf(key, 'tdt') || 'tianditu.gov.cn，类型选「服务器端」', type: 'password' }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          h(ui.Btn, { onClick: saveKeys, disabled: busy }, busy ? '保存中…' : '保存这几把 Key'),
          h(ui.Btn, { kind: 'ghost', disabled: busy, onClick: () => run(async () => { setSc(await call('/real/selfcheck')); toast('三把一起自检跑完了', 'ok') }) }, '三把一起自检')),
        key ? h('div', { style: { marginTop: 8 } },
          h('div', { style: small }, '主接口：' + srcLine(key, 'primary')),
          h('div', { style: small }, '备用接口：' + srcLine(key, 'backup')),
          h('div', { style: small }, '天地图：' + srcLine(key, 'tdt'))) : null,
        sc ? h('div', { style: { marginTop: 8 } }, Object.entries(sc.slots || {}).map(([k, r]) => {
          const line = r.ok ? '通（' + (r.count || 0) + ' 条）' : (r.skipped ? '没填，跳过' : '不通：' + (r.error || ''))
          return h('div', { key: k, style: { ...small, color: r.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, k + '：' + line)
        })) : null))
  }

  if (tab === '引擎与路径') {
    body = h('div', null,
      h(ui.Card, { title: '引擎进程', desc: '这两项改错会直接排不出车次；默认值就是这台机器上能跑的那套。' },
        h(Field, { label: 'Python 路径', value: st.trip_pythonPath, onChange: (v) => setOne('trip_pythonPath', v), placeholder: '留空或 runtime\\python.exe（包自带）' }),
        h(Field, { label: '引擎脚本', value: st.trip_enginePath, onChange: (v) => setOne('trip_enginePath', v), placeholder: '留空＝用包自带 engine\\tripgeo.py' }),
        h(KV, { k: '引擎状态', v: ov ? (ov.engineReady ? '正常' : '没加载') : '未读' })),
      h(ui.Card, { title: '只读项（面板改不了）', desc: '这些是运行时事实，写错会直接坏账，所以只显示不允许改。' },
        h(KV, { k: '车站表', v: '3413 站（.stations.json）' }),
        h(KV, { k: '12306 限流', v: '10 分钟 30 次（.rail-calls.json）' }),
        h(KV, { k: '票号登记', v: 'ticket-registry.json（只由出票流程写）' }),
        h(KV, { k: '票面目录', v: 'modules-data/travel/trip/tickets（只增不手改）' }),
        h(KV, { k: '出门照片', v: 'modules-data/travel/out/photos（只增不删）' })),
      h(ui.Card, { title: '活动计时', desc: '「刷 10 分钟」这类到点提醒，打开会主动发一句，怕打扰所以默认关。' },
        h(SwField, { label: '到点主动提醒', value: st.trip_stayNotify, onChange: (v) => setOne('trip_stayNotify', v) })))
  }

  if (tab === '出门与活动') {
    body = h('div', null,
      h(ui.Card, { title: '出门开关与限额', desc: '关掉后她不能出门、不看天时、也不发定位（行程照旧）。' },
        h(SwField, { label: '出门开关', value: st.out_enabled, onChange: (v) => setOne('out_enabled', v) }),
        h(NumField, { label: '每天远门上限', value: st.out_farLimitPerDay, min: 1, max: 6, onChange: (v) => setOne('out_farLimitPerDay', v) }),
        h(NumField, { label: '旅游最多住几晚', value: st.out_tripMaxDays, min: 1, max: 7, onChange: (v) => setOne('out_tripMaxDays', v) }),
        h(SwField, { label: '允许自己出远门', value: st.out_allowAutoTrip, onChange: (v) => setOne('out_allowAutoTrip', v) }),
        h(SelField, { label: '发定位用哪个位置', value: st.out_locSource, onChange: (v) => setOne('out_locSource', v), options: [
          { value: 'authorized', label: '主人授权的真实位置（优先）' }, { value: 'spot', label: '当前点的坐标' }] })),
      h(ui.Card, { title: '出门状态', desc: '只读。' },
        h(ui.Btn, { disabled: busy, onClick: () => run(async () => setOut(await call('/out/status'))) }, '读取'),
        out ? h('div', { style: { marginTop: 8 } },
          h(KV, { k: '地点', v: out.state ? out.state.placeId : '-' }),
          h(KV, { k: '在出门', v: out.state && out.state.trip ? '是' : '否' }),
          h(KV, { k: '今日计划', v: out.state ? (out.state.plan || []).length + ' 条' : '-' }),
          h('pre', { style: mono }, JSON.stringify(out.settings || {}, null, 2))) : h('div', null, '没读。')),
      h(ui.Card, { title: '面板改行程权限', desc: '关掉面板只能看，发出行/结束只能在 QQ 里发 /行程。' },
        h(SwField, { label: '允许面板改行程', value: st.hub_panelWrite, onChange: (v) => setOne('hub_panelWrite', v) }),
        h(SwField, { label: '概览带出门状态', value: st.hub_showOutings, onChange: (v) => setOne('hub_showOutings', v) })))
  }

  if (tab === '自检') {
    body = h('div', null,
      h(ui.Card, { title: '引擎 / 高德 / 12306 / 航班源', desc: '会真的调一次高德规划 + 一次 12306 查询。' },
        sc && sc.checks ? Object.entries(sc.checks).map(([k, v]) => h(KV, { key: k, k, v: (v.ok ? '✔ ' : '✘ ') + (v.detail || '') })) : h('div', null, '还没跑。'),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => setSc(await call('/hub/selfcheck'))) }, '跑一次'),
          sc && sc.totalMs ? h('span', { style: small }, '耗时 ' + sc.totalMs + ' ms') : null)),
      h(ui.Card, { title: '定位接口三把 key', desc: '高德主 / 高德备 / 天地图，只测通不通，不发消息。' },
        h(ui.Btn, { disabled: busy, onClick: () => run(async () => setSc(await call('/real/selfcheck'))) }, '单独跑定位自检')),
      h(ui.Card, { title: '重复插件清理', desc: '把 modules/ 里重复、名字对不上的文件夹归档到 modules-removed，并停掉「文件夹已删但还在跑」的模块——面板上多出来的按钮会跟着一起消失。不碰内置模块、不碰数据、不碰 Key。' },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => setCl(await call('/clean/scan'))) }, '扫一遍（不动文件）'),
          h(ui.Btn, { disabled: busy, onClick: () => run(async () => { const r = await call('/clean/run'); setCl(r); toast('清理完成', 'ok') }) }, '清理并归档')),
        cl ? h('div', { style: { marginTop: 10 } },
          h('div', { style: small }, cl.ok
            ? (cl.apply === false ? '只扫描：要归档 ' + (cl.move || []).length + ' 个文件夹、停 ' + (cl.stop || []).length + ' 个残留模块'
              : '已归档 ' + (cl.move || []).length + ' 个文件夹、停了 ' + (cl.stopped || []).length + ' 个残留模块；保留 ' + (cl.keep || []).length + ' 个')
            : '失败：' + (cl.message || '未知原因')),
          (cl.move || []).slice(0, 8).map((m, i) => h('div', { key: 'm' + i, style: mono }, '→ ' + m.folder + '：' + m.reason)),
          (cl.stop || []).slice(0, 8).map((s, i) => h('div', { key: 's' + i, style: mono }, '× ' + s.id + '：' + s.reason)),
          cl.trash ? h('div', { style: small }, '归档到了：' + cl.trash) : null,
          (cl.keep || []).length ? h('div', { style: small }, '保留：' + cl.keep.map((k) => k.folder).join('、')) : null,
          (cl.failed || []).length ? h('div', { style: mono }, '失败的：' + cl.failed.map((f) => f.folder + '(' + f.error + ')').join('、')) : null
        ) : h('div', { style: small }, '首次装好会在约 12 秒后自动清一次，结果写在 modules-data/travel/cleanup/last-report.json；以后想再清就点上面的按钮。')))
  }

  return h('div', null, header, body)
}

function tailOf(key, slot) {
  const s = key && key.slots && key.slots[slot]
  return s && s.set ? '已保存 · 后四位 ' + s.tail : ''
}
function srcLine(key, slot) {
  const s = key && key.slots && key.slots[slot]
  if (!s || !s.set) return '没有'
  const src = s.source === 'settings' ? '面板' : s.source === 'env' ? '环境变量' : s.source === 'file' ? '数据文件' : s.source
  return s.tail + '（来自 ' + src + '）'
}
