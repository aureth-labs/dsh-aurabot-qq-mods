// rich-input 的面板：在自动表单之外，加「试一下」按钮和模型健康状态。
// 面板会执行这段函数体，最后 return 一个 React 组件。改了它切一下标签页就是新的。
const { useState, useEffect } = React

return function Panel ({ settings, toast }) {
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [state, setState] = useState(null)
  const [probe, setProbe] = useState(null) // 批量体检结果

  const reload = async () => {
    try { setState(await call('/state')) } catch (error) { /* 面板接口没起来就先不显示 */ }
  }
  useEffect(() => { reload() }, [])

  const run = async (path, label) => {
    setBusy(label)
    setResult(null)
    try {
      const r = await call(path)
      setResult({ ok: r.ok !== false, label, text: r.message || JSON.stringify(r) })
      toast(r.ok === false ? '没成：' + (r.message || '') : label + '通了', r.ok === false ? 'err' : 'ok')
    } catch (error) {
      setResult({ ok: false, label, text: String(error && error.message ? error.message : error) })
      toast('没成：' + (error && error.message ? error.message : error), 'err')
    } finally { setBusy(''); reload() }
  }

  // 一口气把所有能看图的模型试一遍：一个一个来，边试边出结果，方便挑出能用的
  const probeAll = async () => {
    const list = (state && state.models) || []
    if (!list.length) { toast('没有能看图的模型可试', 'err'); return }
    setBusy('体检')
    setProbe(list.map((m) => ({ model: m.value, label: m.label, status: 'wait', text: '' })))
    for (const m of list) {
      setProbe((prev) => (prev || []).map((x) => (x.model === m.value ? { ...x, status: 'busy' } : x)))
      try {
        const r = await call('/test-model?m=' + encodeURIComponent(m.value))
        setProbe((prev) => (prev || []).map((x) => (x.model === m.value
          ? { ...x, status: r.ok ? 'ok' : 'bad', text: (r.message || '').replace(/^[^：]*：/, '') , ms: r.ms }
          : x)))
      } catch (error) {
        setProbe((prev) => (prev || []).map((x) => (x.model === m.value ? { ...x, status: 'bad', text: String(error && error.message ? error.message : error) } : x)))
      }
    }
    setBusy('')
    toast('体检完了', 'ok')
    reload()
  }

  const broken = (state && state.broken) || []
  const note = { marginTop: 8, whiteSpace: 'pre-wrap' }
  const preferred = state && state.preferred
  const swapped = Boolean(preferred && state && state.visionModel && preferred !== state.visionModel)
  const fw = state && state.forwards
  const fwPending = (fw && fw.pending) || []
  const ago = (sec) => (sec == null ? '' : sec < 60 ? '刚刚' : sec < 3600 ? `${Math.round(sec / 60)} 分钟前` : `${Math.round(sec / 3600)} 小时前`)

  return h('div', null,
    h(ui.Card, {
      title: '合并转发',
      desc: '插件只在「这条正好叫到她」时才展开转发；群里没人叫她的时候，转发她根本看不到。' +
        '本模块收到转发就先把正文拉下来存好，等她下一次真的说话时补上。'
    },
      h(ui.Row, { label: '现在的状态', hint: fw && fw.on === false ? '「展开合并转发」关着 —— 这里的事情都不会发生' : '' },
        h('span', { className: 'ab-small ab-muted' },
          fw
            ? `已拉到手 ${fw.expanded} 条\n` + (fw.catchUp === false ? '「补上她没看到的转发」关着：只展开这一轮正文里的' : `等她下次说话时补上：${fwPending.length} 条`)
            : '（模块还没起来）')),
      fwPending.length
        ? h('div', { className: 'ab-note', style: note },
          '已经拉到手、还没补给她看的：\n' +
          fwPending.map((p) => `· ${p.who || '某人'}（${ago(p.agoSec)}，${p.ready}/${p.total} 个转发已就绪）`).join('\n') +
          '\n\n她下一次在这个群里说话时就会看到这些内容。')
        : h('div', { className: 'ab-note ab-muted', style: note }, '没有攒着的转发。'),
      h('div', { className: 'ab-row', style: { marginTop: 8 } },
        h(ui.Btn, { disabled: Boolean(busy), onClick: reload }, '刷新状态'))),
    h(ui.Card, { title: '看图的两个模型', desc: '目标模型看不了图时，先用「看图模型」把图片转成文字；它出错（报错、超时、没真看到图）就换「回退模型」再试一次。两个都不行才退回图片块。' },
    h('div', { className: 'ab-row' },
      h(ui.Btn, { disabled: Boolean(busy), onClick: () => run('/test-vision', '看图模型') }, busy === '看图模型' ? '试…' : '试一下看图模型'),
      h(ui.Btn, { disabled: Boolean(busy), onClick: () => run('/test-fallback', '回退模型') }, busy === '回退模型' ? '试…' : '试一下回退模型'),
      h(ui.Btn, { disabled: Boolean(busy), onClick: probeAll }, busy === '体检' ? '体检中…' : '把能看图的模型都试一遍'),
      h(ui.Btn, { disabled: Boolean(busy), onClick: reload }, '刷新状态')),
    h(ui.Row, { label: '现在会用', hint: settings.describe === false ? '「看不了图就转成文字」关着 —— 图片只会原样塞进去' : '' },
      h('span', { className: 'ab-small ab-muted' },
        (state && state.visionModel ? state.visionModel : (settings.visionModel || '主：自动挑一个能看图的')) +
        '　→　' +
        (state && state.fallbackModel ? state.fallbackModel : (settings.fallbackModel || '回退：自动挑一个不同的')))),
    swapped
      ? h('div', { className: 'ab-note err', style: note },
        '你在面板里选的是 ' + preferred + '，它刚失败过，所以现在临时用 ' + state.visionModel + ' 顶上。\n想固定用它的话，把上面「用哪个模型看图」改成它。')
      : null,
    broken.length
      ? h('div', { className: 'ab-note err', style: note },
        '最近失败过的模型（自动挑的时候会先躲开它们；超时过的躲久一点）：\n' +
        broken.map((b) => `· ${b.model} —— ${b.reason}${b.hits > 1 ? `（连续 ${b.hits} 次）` : ''}${b.agoSec > 60 ? `（${Math.round(b.agoSec / 60)} 分钟前）` : '（刚刚）'}`).join('\n') +
        '\n\n如果首选一直是坏的，就在上面把「用哪个模型看图」手动换成能用的那个。')
      : null,
    probe && probe.length
      ? h('div', { className: 'ab-note', style: note },
        '体检结果：\n' + probe.map((p) => {
          const mark = p.status === 'ok' ? '✔' : p.status === 'bad' ? '✘' : p.status === 'busy' ? '…' : '·'
          const tail = p.status === 'wait' ? '' : (p.ms ? `（${(p.ms / 1000).toFixed(1)} 秒）` : '')
          return `${mark} ${p.model}${tail}${p.status === 'ok' ? '' : p.text ? ' — ' + p.text.slice(0, 60) : ''}`
        }).join('\n'))
      : null,
    result
      ? h('div', { className: result.ok ? 'ab-note' : 'ab-note err', style: note }, result.label + '：' + result.text)
      : null))
}
