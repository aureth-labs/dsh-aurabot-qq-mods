const { useEffect, useRef, useState } = React
const { Card, Row, Btn, Switch, Select } = ui
const speedOptions = [
  { value: 'slow', label: '慢' }, { value: 'normal', label: '正常' }, { value: 'fast', label: '快' },
  { value: 'very-fast', label: '很快' }, { value: 'fastest', label: '最快' },
]

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读不到参考音频'))
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.readAsDataURL(file)
  })
}

return function Panel({ settings, draftSettings = settings, setSettings, toast, reload }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [voiceText, setVoiceText] = useState('')
  const [audio, setAudio] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [image, setImage] = useState('')
  const picker = useRef(null)

  async function refresh() {
    const result = await call('/status')
    if (!result?.ok) throw new Error(result?.message || '读取模块状态失败')
    setStatus(result)
    return result
  }

  useEffect(() => {
    refresh().catch((error) => toast(error.message))
  }, [
    settings.voiceEnabled, settings.mimoKeySet, settings.referenceFile, settings.attachVoice,
    settings.imageEnabled, settings.modelScopeTokenSet, settings.imageModels, settings.imageDefaultModel, settings.attachImage,
  ])

  async function run(path, body, success) {
    setBusy(true)
    try {
      const request = await body
      const result = await call(path, request)
      if (!result?.ok) throw new Error(result?.message || '操作失败')
      if (success) success(result)
      if (result.message) toast(result.message)
      if (path.startsWith('/reference') || path === '/local') {
        const state = await refresh()
        await reload?.()
        // 宿主在有未保存改动时会保留草稿，合并本次操作避免随后保存覆盖。
        if (path.startsWith('/reference')) {
          setSettings?.({
            references: state.references.filter(({ bundled }) => !bundled),
            referenceFile: state.currentReference?.id,
          })
        } else {
          const preference = request.slot === 'tts' ? 'attachVoice' : 'attachImage'
          setSettings?.({ [preference]: state.local[request.slot].enabled })
        }
      }
    } catch (error) {
      toast(error.message)
    } finally {
      setBusy(false)
    }
  }

  function upload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 7 * 1024 * 1024) return toast('参考音频最大 7 MB')
    const body = asBase64(file).then((base64) => ({ base64, name: file.name }))
    return run('/reference', body, () => setAudio(''))
  }

  function feature(slot, title, key) {
    const current = status?.local?.[slot]
    const value = Boolean(draftSettings[key])
    const setupHint = slot === 'tts' ? '保存 MiMo API Key 并选好参考音频后自动接管。' : '保存魔搭 Token 并选好默认模型后自动接管。'
    return h(Row, {
      label: title,
      hint: current?.conflict ? '检测到已有的本地脚本，请先到「本地接口」页处理。' :
        current?.enabled && !current.ready && value ? setupHint : undefined,
    }, h(Switch, {
      on: value, title, disabled: busy,
      onChange: (on) => setSettings({ [key]: on }),
    }), h(Btn, {
      small: true, disabled: busy || !current || (current.conflict && !current.enabled),
      onClick: () => run('/local', { slot, enabled: !current.enabled }),
    }, current?.enabled ? '关闭接管' : '启用接管'))
  }

  function input(key, label, { multiline = false, password = false, placeholder } = {}) {
    return h(multiline ? 'textarea' : 'input', {
      className: multiline ? 'ab-textarea' : 'ab-input',
      ...(multiline ? {} : { type: password ? 'password' : 'text' }),
      ...(password ? { autoComplete: 'new-password' } : {}),
      value: draftSettings[key] ?? '',
      'aria-label': label,
      placeholder,
      onChange: (event) => setSettings({ [key]: event.target.value }),
    })
  }

  function credential(key, label, href, linkLabel) {
    const configured = Boolean(settings[key + 'Set'])
    return h(Row, { label },
      input(key, label, { password: true, placeholder: configured ? '已保存（不改就留空）' : undefined }),
      h('a', {
        href, target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'var(--ab-sea, #2563eb)', textDecoration: 'underline' },
      }, linkLabel),
      !configured && h('span', { className: 'ab-small', style: { color: 'var(--ab-warn, #b45309)', whiteSpace: 'nowrap' } },
        h('i', { className: 'ab-dot warn', 'aria-hidden': true, style: { display: 'inline-block', marginRight: 5 } }), '未配置'))
  }

  const models = status?.models || []
  const references = status?.references || []
  const currentReference = status?.currentReference
  return h(React.Fragment, null,
    h(Card, { title: 'MiMo 语音与魔搭生图' },
      feature('tts', '启用 MiMo 语音', 'voiceEnabled'),
      credential('mimoKey', 'MiMo API Key', 'https://platform.xiaomimimo.com/#/console/api-keys', '申请 MiMo API Key'),
      h(Row, { label: 'MiMo 语速' },
        h(Select, { value: draftSettings.voiceSpeed, options: speedOptions, ariaLabel: 'MiMo 语速', onChange: (voiceSpeed) => setSettings({ voiceSpeed }) })),
      feature('image', '启用魔搭生图', 'imageEnabled'),
      credential('modelScopeToken', '魔搭 Token', 'https://modelscope.cn/my/myaccesstoken', '申请魔搭 Token'),
      h(Row, { label: '魔搭模型', hint: '每行一个模型 ID，格式为 组织/模型。' }, input('imageModels', '魔搭模型', { multiline: true })),
      h(Row, { label: '默认模型 ID', hint: '留空或该模型未列出时，使用列表第一项。' }, input('imageDefaultModel', '默认模型 ID'))),
    h(Card, { title: 'MiMo 试听' },
      h(Row, { label: '当前参考音频', hint: status && !currentReference ? 'WAV 或 MP3，最大 7 MB。' : undefined },
        h('strong', { style: { overflowWrap: 'anywhere' } }, currentReference?.name || (status ? '未选择' : '正在读取')),
        h('input', { type: 'file', ref: picker, hidden: true, accept: '.wav,.mp3,audio/wav,audio/mpeg', onChange: upload }),
        h(Btn, { small: true, disabled: busy, onClick: () => picker.current?.click() }, '选择文件')),
      references.length > 0 && h('details', null,
        h('summary', { className: 'ab-small', style: { cursor: 'pointer', padding: '6px 0' } }, '参考音频列表（' + references.length + '）'),
        ...references.map((reference) => {
          const selected = reference.id === currentReference?.id
          return h(Row, { key: reference.id, label: reference.name, hint: reference.bundled ? '随模块提供' : undefined },
            h(Btn, {
              small: true, disabled: busy || selected,
              onClick: () => run('/reference/select', { id: reference.id }, () => setAudio('')),
            }, selected ? '使用中' : '使用'))
        })),
      h(Row, { label: '朗读内容' },
        h('textarea', { className: 'ab-textarea', value: voiceText, maxLength: 300, 'aria-label': '朗读内容', onChange: (event) => setVoiceText(event.target.value) }),
        h(Btn, { disabled: busy || !voiceText.trim(), onClick: () => run('/preview-voice', { text: voiceText }, (result) => setAudio(result.url)) }, '生成试听')),
      audio && h('audio', { controls: true, src: audio, 'aria-label': 'MiMo 试听音频' })),
    h(Card, { title: '魔搭试画', desc: '保存魔搭设置后，可以在这里试用列表里的模型。' },
      h(Row, { label: '本次模型' },
        h('select', { className: 'ab-input', value: models.includes(model) ? model : '', 'aria-label': '试画模型', onChange: (event) => setModel(event.target.value) },
          h('option', { value: '' }, status?.defaultModel ? '默认 · ' + status.defaultModel : '默认模型'),
          ...models.map((id) => h('option', { key: id, value: id }, id)))),
      h(Row, { label: '画面描述' },
        h('textarea', { className: 'ab-textarea', value: prompt, maxLength: 1999, 'aria-label': '画面描述', onChange: (event) => setPrompt(event.target.value) }),
        h(Btn, { disabled: busy || !prompt.trim(), onClick: () => run('/preview-image', { prompt, model: models.includes(model) ? model : '' }, (result) => setImage(result.url)) }, '试画')),
      image && h('img', { src: image, alt: '魔搭试画结果', style: { display: 'block', maxWidth: '100%', maxHeight: 440, objectFit: 'contain' } })),
  )
}
