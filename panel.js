// real-loc 控制面板：一个接口一把 key，一把备用接口一把备用 key。
const { useState, useEffect } = React

return function Panel({ save, toast, reload }) {
  const [st, setSt] = useState(null)
  const [form, setForm] = useState({ primary: '', backup: '', tdt: '' })
  const [busy, setBusy] = useState('')
  const [check, setCheck] = useState(null)
  const [err, setErr] = useState('')

  const load = () => call('/key').then(setSt).catch((e) => setErr(e.message || String(e)))

  useEffect(() => { load() }, [])

  const set = (slot) => (e) => setForm((f) => ({ ...f, [slot]: e.target.value }))

  const saveAll = async () => {
    const patch = {}
    if (form.primary.trim()) patch.amapKey = form.primary.trim()
    if (form.backup.trim()) patch.amapKeyBackup = form.backup.trim()
    if (form.tdt.trim()) patch.tdtTk = form.tdt.trim()
    if (!Object.keys(patch).length) return toast('没填新值，什么都没改', 'err')
    setBusy('save')
    try {
      await save(patch)
      // 面板写的是模块设置；把数据目录里的旧文件删掉，免得两个地方各存一把、互相打架
      for (const slot of Object.keys(patch).map((k) => (k === 'amapKey' ? 'primary' : k === 'amapKeyBackup' ? 'backup' : 'tdt'))) {
        try { await call('/key?clearfile=1&slot=' + slot) } catch {}
      }
      setForm({ primary: '', backup: '', tdt: '' })
      await load()
      toast('保存好了，立刻生效', 'ok')
    } catch (e) {
      toast('保存失败：' + (e.message || e), 'err')
    }
    setBusy('')
  }

  const clearOne = async (slot, label) => {
    if (!confirm('清掉' + label + '？清掉后这条接口就没 key 了。')) return
    setBusy('clear-' + slot)
    try {
      await call('/key?clear=1&slot=' + slot)
      await load()
      toast(label + ' 清掉了', 'ok')
    } catch (e) {
      toast('清不掉：' + (e.message || e), 'err')
    }
    setBusy('')
  }

  const selfCheck = async () => {
    setBusy('check')
    setCheck(null)
    try {
      const r = await call('/selfcheck')
      setCheck(r)
      toast('自检跑完了，看下面结果', 'ok')
    } catch (e) {
      toast('自检失败：' + (e.message || e), 'err')
    }
    setBusy('')
  }

  const tailOf = (slot) => {
    const s = st && st.slots && st.slots[slot]
    return s && s.set ? '已保存（不改就留空）· 后四位 ' + s.tail : '没有就留空'
  }
  const sourceName = (src) => (src === 'settings' ? '面板' : src === 'env' ? '环境变量' : src === 'file' ? '数据文件' : '')

  const row = (slot, label, hint) => h(ui.Row, { label, hint },
    h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
      h('input', {
        className: 'ab-input',
        style: { width: 280 },
        type: 'password',
        autoComplete: 'off',
        spellCheck: false,
        value: form[slot],
        placeholder: tailOf(slot),
        onChange: set(slot),
      }),
      h(ui.Btn, {
        small: true,
        kind: 'ghost',
        disabled: !(st && st.slots && st.slots[slot] && st.slots[slot].set),
        onClick: () => clearOne(slot, label),
      }, '清空'),
    ),
  )

  const lineOf = (slot, label) => {
    const s = st && st.slots && st.slots[slot]
    if (!s || !s.set) return null
    return h('div', { className: 'ab-small ab-muted' }, label + '：' + s.tail + '（来自 ' + sourceName(s.source) + '）')
  }

  const resOf = (name, label) => {
    const r = check && check.slots && check.slots[name]
    if (!r) return null
    const text = r.ok
      ? '通' + (r.count !== undefined ? '（' + r.count + ' 条结果' + (r.first ? '：' + r.first : '') + '）' : '') + (r.level ? '（精度 ' + r.level + '｜' + r.point + '）' : '')
      : r.skipped ? '没填，跳过' : '不通：' + (r.error || '未知原因')
    return h('div', { className: 'ab-small', style: { color: r.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, label + ' ' + text)
  }

  return h('div', { className: 'ab-grid' },
    h(ui.Card, {
      title: '定位接口与 Key',
      desc: '一个接口一把 key：高德主接口、高德备用接口各一把，天地图作为高德全不通时的备用接口再一把。只存在本机，面板不回显明文。',
    },
      err ? h('div', { className: 'ab-note err' }, '读状态失败：' + err) : null,
      row('primary', '高德 Key（主接口）', '去 lbs.amap.com → 控制台 → 应用管理 → 我的应用 → 添加 Key，服务平台选「Web 服务」。查地名、门牌号、坐标都靠它。'),
      row('backup', '高德 Key（备用接口）', '还是 Web 服务类型的新 Key。主接口失效、超额或被限流时自动换它顶上，一把配一把。'),
      row('tdt', '天地图 tk（备用接口）', '去 tianditu.gov.cn 注册拿 tk，类型必须选「服务器端」。高德主、备都不通时才用它，精度一般只到道路，不会冒充门牌。'),
      h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 12 } },
        h(ui.Btn, { onClick: saveAll, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'),
        h(ui.Btn, { kind: 'ghost', onClick: selfCheck, disabled: busy === 'check' }, busy === 'check' ? '自检中…' : '三把一起自检'),
      ),
      st ? h('div', { style: { marginTop: 10 } },
        lineOf('primary', '主接口'),
        lineOf('backup', '备用接口'),
        lineOf('tdt', '天地图'),
        !(st.hasKey || st.hasBackup || st.hasTdt) ? h('div', { className: 'ab-small ab-muted' }, '三处都还没填 key：现在只能发内置的 16 个成都点位。') : null,
      ) : h('div', { className: 'ab-small ab-muted' }, '读状态中…'),
    ),
    check ? h(ui.Card, { title: '自检结果', desc: '拿「' + check.city + check.keywords + '」分别问三条接口，只看通不通，不发任何消息。' },
      resOf('primary', '高德主'),
      resOf('backup', '高德备用'),
      resOf('tdt', '天地图'),
    ) : null,
  )
}
