// 百炼语音设置面板：读 local/tts.config.json 的真实配置，就地改、能试听、能发到 QQ。
// 面板脚本返回一个组件函数。
const { useState, useEffect, useCallback } = React

const inp = 'ab-input'

function Hint({ children }) {
  return h('div', { className: 'ab-note ab-small', style: { marginTop: -4, marginBottom: 8, opacity: 0.75 } }, children)
}

function Line({ label, hint, children }) {
  return h(ui.Row, { label, hint }, children)
}

return function TtsConsole({ toast, reload }) {
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState({})
  const [text, setText] = useState('那我先撤了啊，明天再战。')
  const [audio, setAudio] = useState(null)
  const [voices, setVoices] = useState(null)
  const [files, setFiles] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await call('/get')
      if (!r || r.ok === false) throw new Error((r && r.message) || '读不到配置')
      setSt(r)
      const c = r.config || {}
      const f = c.filters || {}
      setForm({
        baseUrl: c.baseUrl || 'https://dashscope.aliyuncs.com',
        apiKey: '',
        model: c.model || '',
        voice: c.voice || '',
        speechRate: c.speechRate == null ? 1 : c.speechRate,
        sampleRate: c.sampleRate == null ? 24000 : c.sampleRate,
        maxCharsPerSegment: c.maxCharsPerSegment == null ? 300 : c.maxCharsPerSegment,
        instruction: c.instruction || '',
        seed: c.seed == null ? '' : c.seed,
        filtersEnabled: f.enabled === false ? false : true,
        preset: f.preset || 'medium',
        tailPad: f.tailPad == null ? 0 : f.tailPad,
        ffmpeg: f.ffmpeg || '',
      })
      setErr('')
    } catch (e) {
      setErr(String(e.message || e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const up = (k, v) => setForm((old) => ({ ...old, [k]: v }))

  async function saveAll() {
    setBusy('save')
    try {
      const patch = {
        baseUrl: String(form.baseUrl || '').trim(),
        apiKey: String(form.apiKey || '').trim(),
        model: String(form.model || '').trim(),
        voice: String(form.voice || '').trim(),
        speechRate: Number(form.speechRate) || 1,
        sampleRate: Number(form.sampleRate) || 24000,
        maxCharsPerSegment: Number(form.maxCharsPerSegment) || 300,
        instruction: form.instruction,
        filters: {
          enabled: Boolean(form.filtersEnabled),
          preset: form.preset,
          tailPad: Number(form.tailPad) || 0,
          ffmpeg: String(form.ffmpeg || '').trim(),
        },
      }
      if (String(form.seed).trim() !== '') patch.seed = Number(form.seed)
      const r = await call('/set', { patch })
      toast(r.message || (r.ok ? '存好了' : '没存上'), r.ok === false ? 'err' : 'ok')
      if (r.ok !== false) {
        await load()
        if (reload) reload()
      }
    } catch (e) {
      toast('保存出错：' + String(e.message || e), 'err')
    } finally {
      setBusy('')
    }
  }

  async function doTest() {
    setBusy('test')
    try {
      const r = await call('/test', { text })
      if (r.ok === false) {
        toast(r.message || '合成失败', 'err')
        return
      }
      setAudio(r)
      toast('合成了 ' + (r.seconds ? r.seconds.toFixed(1) + ' 秒' : '') + '（' + Math.round((r.bytes || 0) / 1024) + ' KB）', 'ok')
    } catch (e) {
      toast('试听出错：' + String(e.message || e), 'err')
    } finally {
      setBusy('')
    }
  }

  async function doSend() {
    setBusy('send')
    try {
      const r = await call('/send', { text })
      toast(r.message || (r.ok ? '发了' : '没发出去'), r.ok === false ? 'err' : 'ok')
    } catch (e) {
      toast('发送出错：' + String(e.message || e), 'err')
    } finally {
      setBusy('')
    }
  }

  async function doVoices() {
    setBusy('voices')
    try {
      const r = await call('/voices')
      if (r.ok === false) toast(r.message || '查不到音色', 'err')
      setVoices(r)
      if (r.ok) toast('查到 ' + (r.list || []).length + ' 个音色', 'ok')
    } catch (e) {
      toast('查音色出错：' + String(e.message || e), 'err')
    } finally {
      setBusy('')
    }
  }

  async function doFiles() {
    setBusy('files')
    try {
      setFiles(await call('/files'))
    } catch (e) {
      toast(String(e.message || e), 'err')
    } finally {
      setBusy('')
    }
  }

  if (err) return h(ui.Card, { title: '百炼语音设置' }, h('div', { className: 'ab-note err' }, err))
  if (!st) return h(ui.Card, { title: '百炼语音设置' }, h('div', { className: 'ab-muted' }, '读配置中…'))

  const c = st.config || {}

  const voiceRows = (voices && voices.list ? voices.list : []).map((v, i) => {
    const isCur = v.voice === voices.current
    const tail = isCur
      ? h('span', { className: 'ab-small', style: { color: '#4ade80' } }, '当前')
      : h(ui.Btn, { small: true, onClick: () => { up('voice', v.voice); toast('点「保存全部改动」才生效', 'ok') } }, '用这个')
    return h(
      'div',
      { key: i, style: { display: 'flex', gap: 8, padding: '3px 0', fontSize: 12, alignItems: 'center' } },
      h('span', { style: { flex: 1, wordBreak: 'break-all', opacity: isCur ? 1 : 0.72 } }, v.voice + (v.name ? ' · ' + v.name : '')),
      v.status ? h('span', { className: 'ab-muted ab-small' }, v.status) : null,
      tail,
    )
  })

  const voicesBox = voices
    ? h(
        'div',
        { style: { marginTop: 10 } },
        voices.ok === false
          ? h('div', { className: 'ab-note err' }, voices.message)
          : h(
              'div',
              null,
              h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } }, (voices.list || []).length + ' 个音色，当前用的是 ' + (voices.current || '（默认）')),
              h('div', { style: { maxHeight: 180, overflow: 'auto' } }, voiceRows),
            ),
      )
    : null

  const apiCard = h(
    ui.Card,
    { title: '百炼语音接口', desc: '配置保存在 local/tts.config.json；修改后点下方「保存全部改动」。' },
    st.ttsScript ? null : h('div', { className: 'ab-note', style: { marginTop: 10 } }, '尚未安装语音脚本。', h(ui.Btn, { small: true, onClick: async () => { const r = await call('/install', {}); toast(r.message, r.ok ? 'ok' : 'err'); await load() } }, '安装脚本')),
    st.exists ? null : h('div', { className: 'ab-note err', style: { marginTop: 10 } }, '⚠️ 没找到 tts.config.json，点保存会新建一份。'),
    h(Line, { label: '域名 baseUrl', hint: '只到 .com 为止' }, h('input', { className: inp, value: form.baseUrl, placeholder: 'https://xxx.cn-beijing.maas.aliyuncs.com', onChange: (e) => up('baseUrl', e.target.value) })),
    h(Line, { label: 'API Key', hint: '保存在本机；留空保留已有密钥' }, h('input', { className: inp, type: 'password', value: form.apiKey, placeholder: c.apiKeySet ? '已配置（不修改请留空）' : '填写百炼 API Key', onChange: (e) => up('apiKey', e.target.value) })),
    h(Line, { label: '模型 model' }, h('input', { className: inp, value: form.model, placeholder: 'qwen-audio-3.1-tts-flash', onChange: (e) => up('model', e.target.value) })),
    h(Line, { label: '音色 voice', hint: '复刻音色那一长串' }, h('input', { className: inp, value: form.voice, onChange: (e) => up('voice', e.target.value) })),
    h(
      'div',
      { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' } },
      h(ui.Btn, { small: true, disabled: busy === 'voices', onClick: doVoices }, busy === 'voices' ? '查…' : '查可用音色'),
      h('span', { className: 'ab-muted ab-small' }, 'API Key：' + (c.apiKeySet ? '已配置' : '❌ 没配')),
      h('span', { className: 'ab-muted ab-small' }, '输出格式：' + (c.format || 'wav') + ' · 缓存：' + (c.cache === false ? '关' : '开')),
    ),
    voicesBox,
  )

  const sayCard = h(
    ui.Card,
    { title: '说法', desc: '这两项决定「像不像真人在随口讲」。一次只改一个，好比较。' },
    h(Line, { label: '语速 speechRate', hint: '1 = 原速，1.05 略快' },
      h('input', { className: inp, type: 'number', step: '0.01', min: '0.5', max: '2', value: form.speechRate, onChange: (e) => up('speechRate', e.target.value) })),
    h(
      'div',
      { style: { padding: '8px 0 0' } },
      h('div', { style: { fontSize: 13, marginBottom: 4 } }, '语气基底 instruction'),
      h('textarea', { className: 'ab-textarea', rows: 4, value: form.instruction, style: { width: '100%', boxSizing: 'border-box' }, onChange: (e) => up('instruction', e.target.value) }),
      h(Hint, null, '一句中文说明怎么讲。别堆播音腔描述；情绪细分交给人格里的【语气】标记。'),
    ),
    h(Line, { label: 'seed', hint: '复刻音色下基本不影响' },
      h('input', { className: inp, type: 'number', min: '0', max: '65535', value: form.seed, onChange: (e) => up('seed', e.target.value) })),
    h(Line, { label: '分段上限', hint: '长文本按句号切段' },
      h('input', { className: inp, type: 'number', min: '50', max: '2000', value: form.maxCharsPerSegment, onChange: (e) => up('maxCharsPerSegment', e.target.value) })),
    h(Line, { label: '采样率', hint: '自适应，别乱改' },
      h('input', { className: inp, type: 'number', step: '1000', value: form.sampleRate, onChange: (e) => up('sampleRate', e.target.value) })),
  )

  const fxCard = h(
    ui.Card,
    { title: '音频层（ffmpeg 后期）', desc: '压一下塑料感、补尾巴那口气。找不到 ffmpeg 会自动跳过，不影响发语音。' },
    h(Line, { label: '开关' }, h(ui.Switch, { on: Boolean(form.filtersEnabled), onChange: (v) => up('filtersEnabled', v) })),
    h(Line, { label: '强度 preset' },
      h(ui.Select, {
        value: form.preset,
        onChange: (v) => up('preset', v),
        options: [
          { value: 'light', label: 'light（轻）' },
          { value: 'medium', label: 'medium（中，推荐）' },
          { value: 'strong', label: 'strong（重）' },
        ],
      })),
    h(Line, { label: '结尾留白 tailPad', hint: '单位秒；你说「结尾收音太快」就是它' },
      h('input', { className: inp, type: 'number', step: '0.05', min: '0', max: '2', value: form.tailPad, onChange: (e) => up('tailPad', e.target.value) })),
    h(Line, { label: 'ffmpeg 路径', hint: '留空自动找' },
      h('input', { className: inp, value: form.ffmpeg, placeholder: '（自动找 local/bin/ffmpeg/…/ffmpeg.exe）', onChange: (e) => up('ffmpeg', e.target.value) })),
  )

  const playBox = audio
    ? h(
        'div',
        { style: { marginTop: 12 } },
        h('audio', { controls: true, style: { width: '100%' }, src: 'data:' + audio.mime + ';base64,' + audio.data }),
        h('div', { className: 'ab-muted ab-small', style: { marginTop: 4 } }, (audio.seconds ? audio.seconds.toFixed(2) + ' 秒 · ' : '') + Math.round((audio.bytes || 0) / 1024) + ' KB'),
      )
    : null

  const fileRows = (files && files.files ? files.files : []).map((f, i) =>
    h('div', { key: i, className: 'ab-small ab-muted', style: { padding: '2px 0' } }, new Date(f.at).toLocaleString('zh-CN') + ' · ' + Math.round(f.size / 1024) + ' KB · ' + f.name),
  )

  const testCard = h(
    ui.Card,
    { title: '试听', desc: '只合成不发送；确认是这一版再发到 QQ。' },
    h('textarea', { className: 'ab-textarea', rows: 3, value: text, style: { width: '100%', boxSizing: 'border-box' }, onChange: (e) => setText(e.target.value) }),
    h(
      'div',
      { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' } },
      h(ui.Btn, { kind: 'primary', small: true, disabled: busy === 'test', onClick: doTest }, busy === 'test' ? '合成中…' : '合成试听'),
      h(ui.Btn, { small: true, disabled: busy === 'send', onClick: doSend }, busy === 'send' ? '发送中…' : '发到 QQ'),
      h(ui.Btn, { small: true, disabled: busy === 'save', onClick: saveAll }, busy === 'save' ? '保存中…' : '保存全部改动'),
    ),
    playBox,
    h(
      'div',
      { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h(ui.Btn, { small: true, disabled: busy === 'files', onClick: doFiles }, '看最近的成品'),
      files ? h('span', { className: 'ab-muted ab-small' }, (files.files || []).length + ' 个 · ' + files.dir) : null,
    ),
    files ? h('div', { style: { marginTop: 6, maxHeight: 140, overflow: 'auto' } }, fileRows) : null,
  )

  return h('div', null, apiCard, sayCard, fxCard, testCard)
}
