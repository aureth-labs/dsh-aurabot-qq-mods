// QQ语音通话 · 面板
// 状态是实时的（每 3 秒问一次模块接口），设置项走 draftSettings，跟底部「保存设置」一起提交。
const { useState, useEffect } = React
const { Card, Btn, Switch, Select } = ui

const dot = (on) => ({
  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
  background: on ? '#2ecc71' : '#666', marginRight: 8,
  boxShadow: on ? '0 0 6px rgba(46,204,113,.8)' : 'none',
})

function StateRow({ on, label, extra }) {
  return h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 6, fontSize: 13 } },
    h('span', { style: dot(on) }),
    h('span', { style: { minWidth: 92 } }, label),
    h('span', { className: 'ab-muted ab-small', style: { opacity: 0.7 } }, on ? (extra || '在线') : '离线'))
}

return function QQCallPanel({ settings, draftSettings, setSettings, toast }) {
  const d = draftSettings || settings || {}
  const [st, setSt] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [models, setModels] = useState([])
  const [modelsErr, setModelsErr] = useState('')

  const loadModels = async () => {
    try {
      const r = await call('/models')
      setModels((r && r.items) || [])
      setModelsErr(((r && r.errors) || []).join(' / '))
    } catch (e) {
      setModels([])
      setModelsErr(String(e && e.message || e))
    }
  }

  const refresh = async () => {
    try {
      const r = await call('/status')
      setSt(r)
    } catch (e) {
      setSt({ error: String(e && e.message || e) })
    }
  }

  useEffect(() => {
    refresh()
    loadModels()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [])

  const upd = (k, v) => setSettings({ [k]: v })
  const on = d.on !== false
  const auto = d.autoAnswer !== false
  const idle = d.idle !== false
  const engine = d.engine || 'piper'
  const silentFirst = d.silentFirst !== false
  const silentSec = Number.isFinite(Number(d.silentOpenSec)) ? Number(d.silentOpenSec) : 30

  const bridgeOn = Boolean(st && st.bridge && st.bridge.ok)
  const loopOn = Boolean(st && st.loop && st.loop.running)
  const answerOn = Boolean(st && st.answer && st.answer.running)

  const act = async (path, label) => {
    setBusy(label)
    try {
      const r = await call(path)
      toast((r && r.message) || '好了')
      await refresh()
    } catch (e) {
      toast('操作失败：' + String(e && e.message || e))
    } finally {
      setBusy('')
    }
  }

  const push = async () => {
    const t = text.trim()
    if (!t) { toast('先写一句要说的话'); return }
    setBusy('say')
    try {
      const r = await call('/say?text=' + encodeURIComponent(t))
      if (r && r.ok) toast(`已经说进通话了${r.first_audio_s ? '（' + r.first_audio_s + ' 秒开口）' : ''}`)
      else toast((r && r.message) || '推送失败')
    } catch (e) {
      toast('推送失败：' + String(e && e.message || e))
    } finally {
      setBusy('')
    }
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    // ① 状态
    h(Card, { title: '通话链路状态' },
      h(StateRow, { on: bridgeOn, label: '声音桥接', extra: bridgeOn ? `端口 ${st.bridge.port || d.port || 47660} · 引擎 ${st.bridge.engine || engine}` : (st && st.bridge && st.bridge.error) || '未启动' }),
      h(StateRow, { on: loopOn, label: '听与说', extra: loopOn ? '在听对方说话' : '没跑' }),
      h(StateRow, { on: answerOn, label: '自动接听', extra: answerOn ? '盯着来电窗口' : (auto ? '没跑' : '开关是关的') }),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
        h(Btn, { onClick: () => act('/start', 'start'), disabled: !!busy }, busy === 'start' ? '启动中…' : '全部启动'),
        h(Btn, { onClick: () => act('/restart', 'restart'), disabled: !!busy }, busy === 'restart' ? '重启中…' : '重启生效'),
        h(Btn, { onClick: () => act('/stop', 'stop'), disabled: !!busy }, busy === 'stop' ? '停止中…' : '全部停止'),
        h(Btn, { onClick: refresh, disabled: !!busy }, '刷新状态')),
      h('p', { className: 'ab-note', style: { marginTop: 8, marginBottom: 0 } },
        '没有自动看护：哪个进程掉了不会自己回来，要手动点「全部启动」。改了引擎 / 开场白 / 催话之后点「重启生效」，新设置才会作用到进程上。'),
      h('p', { className: 'ab-note', style: { marginTop: 6, marginBottom: 0 } },
        '链路：QQ 来电 → 自动点接听 → 抓 QQ 播出的声音 → 识别成文字 → 模型想好怎么回 → 合成语音 → 通过虚拟声卡 CABLE Input 送进 QQ 麦克风。'),
      (st && Array.isArray(st.modelMissing) && st.modelMissing.length)
        ? h('p', { className: 'ab-note', style: { marginTop: 6, marginBottom: 0, color: '#d14343' } },
            `缺 ${st.modelMissing.length} 个模型文件：${st.modelMissing.slice(0, 3).map((x) => x.file).join('、')}${st.modelMissing.length > 3 ? ' 等' : ''}。放到 modules-data/qq-call/runtime/models/ 下再点「全部启动」，README 里有下载地址。`)
        : null

    ),
    // ② 设置
    h(Card, { title: '通话设置' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h(Switch, { on, onChange: (v) => upd('on', Boolean(v)), title: '启用' }),
        h('span', { className: 'ab-note', style: { margin: 0 } },
          on ? '开着：DSH 启动时自动拉起桥接、回路和接听' : '关着：插件不碰任何音频进程')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h(Switch, { on: auto, onChange: (v) => upd('autoAnswer', Boolean(v)), title: '自动接听' }),
        h('span', { className: 'ab-note', style: { margin: 0 } }, auto ? '来电自己接' : '来电报铃声，你手点接听')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h(Switch, { on: idle, onChange: (v) => upd('idle', Boolean(v)), title: '催话' }),
        h('span', { className: 'ab-note', style: { margin: 0 } }, idle ? '你沉默十几秒她会主动找话说' : '你不说话，她也不说话')),
      h('div', { style: { marginBottom: 4, fontSize: 12, opacity: 0.75 } }, '说话的声音'),
      h(Select, {
        value: engine,
        options: [
          { value: 'piper', label: '本地 Piper —— 开口快，音色中性' },
          { value: 'breeze', label: 'Breeze 云端 —— 需在设置里填 voiceId / key，每句慢 3~4 秒' },
        ],
        onChange: (v) => upd('engine', v),
        ariaLabel: '语音引擎',
      }),
      h('p', { className: 'ab-note', style: { marginTop: 8, marginBottom: 0 } },
        '纯 CPU 的机器上，GPT-SoVITS 一句要 7 秒、RVC 转 2 秒音频要 15 秒，所以实时对话里先不给这两个选项；有显卡了自己加进引擎列表。'),
      h('p', { className: 'ab-note', style: { marginTop: 6, marginBottom: 0 } },
        '接通后第一句她自己现想：用她现成的人格编，每次都不一样，也可能是“先不吭声、只听”。她一时说不出话时会从几句随机的话里挑一句；这格留作最底线的备用。'),
      h('div', { style: { marginTop: 12, marginBottom: 4, fontSize: 12, opacity: 0.75 } }, '兜底开场白（只在生成失败时用）'),
      h('input', {
        className: 'ab-input', type: 'text', value: d.greeting || '',
        placeholder: '喂？是我呀。',
        onChange: (e) => upd('greeting', e.target.value),
        style: { width: '100%' },
      }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 } },
        h(Switch, { on: silentFirst, onChange: (v) => upd('silentFirst', Boolean(v)), title: '先听后说' }),
        h('span', { className: 'ab-note', style: { margin: 0 } },
          silentFirst ? '接通后她可以先只听不说，什么时候开她自己定' : '接通就先出声，不让她安静')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 12, opacity: 0.75 } }, '她最多安静'),
        h('input', {
          className: 'ab-input', type: 'number', min: 5, max: 180, value: silentSec,
          onChange: (e) => upd('silentOpenSec', Number(e.target.value)),
          style: { width: 76 },
        }),
        h('span', { style: { fontSize: 12, opacity: 0.75 } }, '秒；到点对方还没出声，她先递一句（会先判断对面是想有人陪，还是需要被安慰）')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 4, flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 12, opacity: 0.75 } }, '对话模型（本机探测到的）'),
        h(Btn, { onClick: () => loadModels(), small: true }, '重新探测')),
      models.length
        ? h(Select, {
            value: (d.llmUrl || '') + '|' + (d.llmModel || ''),
            options: models.map((m) => ({ value: m.key, label: m.label })),
            onChange: (v) => {
              const it = models.find((x) => x.key === v)
              if (it) setSettings({ llmUrl: it.url, llmModel: it.model })
            },
            ariaLabel: '对话模型',
          })
        : h('p', { className: 'ab-note', style: { margin: 0 } }, '这个接口没探到模型，下面手动填接口地址和模型名也能用。'),
      modelsErr ? h('p', { className: 'ab-note', style: { marginTop: 6, marginBottom: 0, opacity: 0.7 } }, '没探通的接口：' + modelsErr) : null,
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input', type: 'text', value: d.llmUrl || '',
          placeholder: '接口地址，如 http://127.0.0.1:9000/v1/chat/completions',
          onChange: (e) => upd('llmUrl', e.target.value),
          style: { flex: 1, minWidth: 220 },
        }),
        h('input', {
          className: 'ab-input', type: 'text', value: d.llmModel || '',
          placeholder: '模型名',
          onChange: (e) => upd('llmModel', e.target.value),
          style: { width: 160 },
        })),
      h('p', { className: 'ab-note', style: { marginTop: 6, marginBottom: 0 } }, '换完模型点上面的「重启生效」，回路才会换成新模型说话。')
    ),
    // ③ 调试
    h(Card, { title: '往通话里说一句' },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('input', {
          className: 'ab-input', type: 'text', value: text,
          placeholder: '比如：听得见吗，我这边一切正常',
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') push() },
          style: { flex: 1 },
        }),
        h(Btn, { onClick: push, disabled: !!busy || !bridgeOn }, busy === 'say' ? '说…' : '说进通话')),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
        h(Btn, { onClick: () => act('/greet', 'greet'), disabled: !!busy || !bridgeOn }, '推开场白'),
        h(Btn, {
          onClick: async () => {
            if (!bridgeOn) { toast('桥接没起来'); return }
            setBusy('tone')
            try {
              const r = await call('/tone')
              toast((r && r.message) || '放了测试音')
            } catch (e) { toast('放测试音失败：' + String(e && e.message || e)) }
            finally { setBusy('') }
          },
          disabled: !!busy || !bridgeOn,
        }, busy === 'tone' ? '放音…' : '测试音（3 秒）')),
      h('p', { className: 'ab-note', style: { marginTop: 8, marginBottom: 0 } },
        '这一句只在桥接在线时能推；推之前先确认 QQ 通话是接通状态，否则声音进不了通道。')
    )
  )
}
