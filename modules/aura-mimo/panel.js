// aura-mimo · 模块面板
// 作者：zcx1021
//
// 面板注入：React、h、ui（自带组件）、call（调本模块路由）、settings、save、toast。
// 注意：设置保存统一走 /save 接口（内部调 api.saveSettings），
// 不依赖 setSettings —— 后者在实测里没把值写进去。

const { useState, useEffect, useRef } = React

const SAMPLE = '你好呀，我是大肥鱼。今天也要开开心心的。'

return function Panel({ settings, save, toast }) {
  const s = settings || {}
  const [status, setStatus] = useState(null)
  const [presets, setPresets] = useState([])
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState('')
  const [text, setText] = useState(SAMPLE)
  const [audioSrc, setAudioSrc] = useState('')
  const [refSrc, setRefSrc] = useState('')
  const fileRef = useRef(null)

  // 本地表单状态
  const [form, setForm] = useState({
    apiKey: s.apiKey || '',
    apiBase: s.apiBase || 'https://api.xiaomimimo.com/v1',
    model: s.model || 'mimo-v2.5-tts-voiceclone',
    format: s.format || 'wav',
    stylePrompt: s.stylePrompt || '',
    seedText: s.seedText || '',
    timeout: Number(s.timeout) || 180,
    autoVoice: Boolean(s.autoVoice),
    voiceChance: Number(s.voiceChance ?? 0.35),
    maxChars: Number(s.maxChars ?? 120),
  })
  const [dirty, setDirty] = useState(false)

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setDirty(true)
  }

  async function load() {
    try {
      const [a, b] = await Promise.all([call('/status'), call('/presets')])
      setStatus(a || null)
      setPresets(Array.isArray(b?.presets) ? b.presets : [])
    } catch (e) {
      setHint('读取状态失败：' + (e?.message || e))
    }
  }

  async function loadRef() {
    try {
      const r = await call('/ref-audio')
      if (r && r.ok) setRefSrc(`data:${r.mime};base64,${r.audio}`)
    } catch {
      /* 没参考音频 */
    }
  }

  useEffect(() => {
    load()
    loadRef()
  }, [])

  async function doSave() {
    setBusy('save')
    try {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(form)) q.set(k, String(v))
      const r = await call('/save?' + q.toString())
      if (r && r.ok) {
        toast('设置已保存')
        setDirty(false)
        await load()
      } else {
        setHint('保存失败：' + (r?.message || '未知错误'))
      }
    } catch (e) {
      setHint('保存失败：' + (e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function preview() {
    const t = String(text || '').trim()
    if (!t) return toast('先写点要念的文字')
    if (!form.apiKey && !status?.configured) return toast('先填 MiMo API Key 并保存')
    setBusy('preview')
    setAudioSrc('')
    setHint('正在合成…MiMo 可能要 40~90 秒，请稍等')
    try {
      const r = await call('/preview?text=' + encodeURIComponent(t.slice(0, 300)))
      if (r && r.ok) {
        setAudioSrc(`data:${r.mime};base64,${r.audio}`)
        setHint(`合成成功：${Math.round(r.bytes / 1024)} KB`)
      } else {
        setHint('合成失败：' + (r?.message || '未知错误'))
      }
    } catch (e) {
      setHint('合成失败：' + (e?.message || e))
    } finally {
      setBusy('')
    }
  }

  function pickFile() {
    fileRef.current?.click()
  }

  async function upload(file) {
    if (!file) return
    if (file.size > 15 * 1024 * 1024) return toast('文件超过 15 MB')
    setBusy('upload')
    setHint('正在上传…')
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result || ''))
        fr.onerror = () => reject(new Error('读不了这个文件'))
        fr.readAsDataURL(file)
      })
      const b64 = dataUrl.replace(/^data:[^,]*,/, '')
      const r = await call('/upload-ref', { name: file.name, data: b64 })
      if (r && r.ok) {
        setHint(`已上传：${r.name}（${Math.round(r.size / 1024)} KB）`)
        toast('参考音频已更新，换音频就是换音色')
        await load()
        await loadRef()
      } else {
        setHint('上传失败：' + (r?.message || '未知错误'))
      }
    } catch (e) {
      setHint('上传失败：' + (e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function usePreset(file) {
    if (!file) return
    setBusy('preset')
    try {
      const r = await call('/use-preset?preset=' + encodeURIComponent(file.replace(/^preset:/, '')))
      if (r && r.ok) {
        toast('已切到预设：' + r.name)
        await load()
        await loadRef()
      } else {
        setHint('切换失败：' + (r?.message || '未知错误'))
      }
    } catch (e) {
      setHint('切换失败：' + (e?.message || e))
    } finally {
      setBusy('')
    }
  }

  async function selfTest() {
    setBusy('test')
    setHint('正在合成并发送到主人私聊…')
    try {
      const r = await call('/selftest')
      if (r && r.ok) setHint(`已发出一条语音（${Math.round(r.bytes / 1024)} KB）到 ${r.sentTo}，去 QQ 看看`)
      else setHint('自检失败：' + (r?.message || '未知错误'))
    } catch (e) {
      setHint('自检失败：' + (e?.message || e))
    } finally {
      setBusy('')
    }
  }

  const dot = (ok) =>
    h('span', {
      style: {
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        marginRight: '6px',
        background: ok ? '#3fb950' : '#d29922',
      },
    })

  const field = (label, node, tip) =>
    h(
      'div',
      { style: { display: 'grid', gap: '4px', marginBottom: '10px' } },
      h('label', { className: 'ab-small', style: { fontWeight: 600 } }, label),
      node,
      tip ? h('span', { className: 'ab-small ab-muted' }, tip) : null,
    )

  const input = (key, props) =>
    h('input', {
      className: 'ab-input',
      value: form[key],
      onChange: (e) => set(key, e.target.value),
      ...props,
    })

  return h(
    'div',
    { style: { display: 'grid', gap: '12px' } },

    // ---- 状态 ----
    h(
      ui.Card,
      { title: '运行状态' },
      status
        ? h(
            'div',
            { className: 'ab-small', style: { display: 'grid', gap: '6px' } },
            h('div', {}, dot(status.configured), status.configured ? 'API Key 已配置' : '还没填 API Key'),
            h(
              'div',
              {},
              dot(status.ref),
              status.ref
                ? `参考音频：${status.ref.name}（${Math.round(status.ref.size / 1024)} KB${status.ref.isPreset ? '，内置预设' : '，自定义'}）`
                : '没有参考音频，请上传',
            ),
            h('div', {}, dot(true), `模型：${status.model} · 格式：${status.format}`),
            h(
              'div',
              {},
              dot(status.ffmpeg || status.format !== 'mp3'),
              `ffmpeg：${status.ffmpeg ? '已安装' : '未安装'}${status.format === 'mp3' ? '（MP3 需要它，否则自动回退 WAV）' : ''}`,
            ),
            h('div', {}, dot(true), status.autoVoice ? `自动语音已开，概率 ${Math.round(status.voiceChance * 100)}%` : '自动语音已关（只有她主动用工具时才发语音）'),
            h('div', {}, dot(true), `已缓存 ${status.cached ?? 0} 条合成结果`),
          )
        : '正在读取…',
      h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h(ui.Btn, { onClick: load }, '刷新状态'),
        h(ui.Btn, { onClick: selfTest, disabled: busy === 'test' }, busy === 'test' ? '发送中…' : '发一条语音自检'),
      ),
    ),

    // ---- 接口设置 ----
    h(
      ui.Card,
      { title: '接口设置' },
      field('MiMo API Key', input('apiKey', { type: 'password', placeholder: 'sk-...' }), '小米 MiMo 开放平台创建'),
      field('API 地址', input('apiBase'), '一般不用改，要以 /v1 结尾'),
      field(
        '合成模型',
        h(
          'select',
          { className: 'ab-input', value: form.model, onChange: (e) => set('model', e.target.value) },
          h('option', { value: 'mimo-v2.5-tts-voiceclone' }, '音色克隆（要参考音频）'),
          h('option', { value: 'mimo-v2.5-tts-voicedesign' }, '文字造音色（用描述）'),
        ),
        '音色克隆会照着参考音频还原真人音色，效果最像',
      ),
      field(
        '音频格式',
        h(
          'select',
          { className: 'ab-input', value: form.format, onChange: (e) => set('format', e.target.value) },
          h('option', { value: 'wav' }, 'WAV（音质最好）'),
          h('option', { value: 'mp3' }, 'MP3（体积小，需 ffmpeg）'),
          h('option', { value: 'pcm16' }, 'PCM16（自动封装 WAV）'),
        ),
      ),
      field('风格提示词', input('stylePrompt', { placeholder: '比如：温柔、语速稍慢' }), '会作为 <style> 标签加在文字前，控制语气'),
      field('种子文本', input('seedText', { placeholder: '可留空' }), '对话上下文，帮助稳定音色'),
      field(
        '超时（秒）',
        h('input', {
          className: 'ab-input',
          type: 'number',
          min: 30,
          max: 300,
          step: 10,
          value: form.timeout,
          onChange: (e) => set('timeout', Number(e.target.value)),
        }),
        'MiMo 单次合成常要 40~90 秒，别设太小',
      ),
    ),

    // ---- 参考音频 ----
    h(
      ui.Card,
      { title: '参考音频（换音频 = 换音色）' },
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h(ui.Btn, { onClick: pickFile, disabled: busy === 'upload' }, busy === 'upload' ? '上传中…' : '上传音频'),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'audio/*,.mp3,.wav,.m4a,.flac,.ogg',
          style: { display: 'none' },
          onChange: (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            upload(f)
          },
        }),
        presets.length > 0
          ? h(
              'select',
              {
                className: 'ab-input',
                value: String(s.refAudio || '').startsWith('preset:') ? s.refAudio : '',
                onChange: (e) => usePreset(e.target.value),
                disabled: busy === 'preset',
                style: { maxWidth: '240px' },
              },
              h('option', { value: '' }, '选内置预设…'),
              ...presets.map((p) =>
                h('option', { key: p.file, value: p.file }, `${p.name}（${Math.round((p.size || 0) / 1024)} KB）`),
              ),
            )
          : null,
      ),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: '8px' } },
        '支持 mp3 / wav / m4a / flac / ogg，单个不超过 15 MB。建议 5～20 秒清晰人声，无背景音乐。'),
      refSrc ? h('audio', { src: refSrc, controls: true, style: { width: '100%', marginTop: '8px' } }) : null,
    ),

    // ---- 试音 ----
    h(
      ui.Card,
      { title: '试音间' },
      h('textarea', {
        value: text,
        onChange: (e) => setText(e.target.value),
        rows: 3,
        className: 'ab-input',
        style: { width: '100%', resize: 'vertical' },
        placeholder: '写点想让她念的话…',
      }),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
        h(ui.Btn, { onClick: preview, disabled: busy === 'preview' }, busy === 'preview' ? '合成中…' : '生成语音'),
        h('span', { className: 'ab-small ab-muted' }, `${String(text || '').length} 字`),
      ),
      audioSrc ? h('audio', { src: audioSrc, controls: true, autoPlay: true, style: { width: '100%', marginTop: '8px' } }) : null,
    ),

    // ---- 语音策略 ----
    h(
      ui.Card,
      { title: '语音策略' },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
        h('input', {
          type: 'checkbox',
          checked: Boolean(form.autoVoice),
          onChange: (e) => set('autoVoice', e.target.checked),
        }),
        h('span', { className: 'ab-small' }, '自动挑一句话用语音说'),
      ),
      h('p', { className: 'ab-small ab-muted' },
        `开了之后，每轮回复约有 ${Math.round(form.voiceChance * 100)}% 概率把其中一条不超过 ${form.maxChars} 字的短句换成语音条。关掉后只有她主动调用工具时才发语音。`),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
        h('span', { className: 'ab-small' }, '概率'),
        h('input', {
          type: 'range',
          min: 0,
          max: 1,
          step: 0.05,
          value: form.voiceChance,
          onChange: (e) => set('voiceChance', Number(e.target.value)),
          style: { flex: '1 1 120px' },
        }),
        h('span', { className: 'ab-small' }, `${Math.round(form.voiceChance * 100)}%`),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
        h('span', { className: 'ab-small' }, '最长字数'),
        h('input', {
          className: 'ab-input',
          type: 'number',
          min: 10,
          max: 500,
          step: 10,
          value: form.maxChars,
          onChange: (e) => set('maxChars', Number(e.target.value)),
          style: { width: '100px' },
        }),
      ),
    ),

    // ---- 保存 ----
    h(
      'div',
      { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h(ui.Btn, { onClick: doSave, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : dirty ? '保存设置 · 有未保存修改' : '保存设置'),
      dirty ? h('span', { className: 'ab-small', style: { color: '#d29922' } }, '改了还没保存') : null,
    ),

    hint ? h('p', { className: 'ab-small', style: { color: '#d29922' } }, hint) : null,

    // ---- 用法 ----
    h(
      ui.Card,
      { title: '怎么用' },
      h(
        'ul',
        { className: 'ab-small', style: { margin: 0, paddingLeft: '18px', lineHeight: '1.8' } },
        h('li', {}, h('b', {}, '她主动说语音：'), '跟她说「用语音说晚安」，她会调 mimo_say 工具真发一条语音条。'),
        h('li', {}, h('b', {}, '你手动让她说：'), '在 QQ 里发 /语音 你好呀'),
        h('li', {}, h('b', {}, '自动语音：'), '打开上面「自动挑一句话用语音说」，她回复时按概率自己换成语音。'),
        h('li', {}, h('b', {}, '全局替换语音引擎：'), '把模块文件夹改名成 voice 就行（id 取自文件夹名），她所有语音都会走 MiMo。代价是内置的语音识别会一起消失。'),
      ),
    ),

    // ---- 署名 ----
    h(
      'p',
      { className: 'ab-small', style: { opacity: 0.55, margin: '4px 0 0' } },
      'aura-mimo · 作者 zcx1021',
    ),
  )
}
