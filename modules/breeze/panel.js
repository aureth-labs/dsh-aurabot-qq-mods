// Breeze 语音：这张卡里的设置都写进面板的草稿，跟原生表单一起用底部「保存设置」。
// 面板会给 React / h / ui / call / settings / draftSettings / setSettings / toast。
const { useState, useEffect, useRef } = React
return function BreezePanel({ settings, draftSettings, setSettings, toast }) {
  const d = draftSettings || settings || {}
  const [busy, setBusy] = useState('')
  const [st, setSt] = useState(null)
  const [confirmOut, setConfirmOut] = useState(false)
  const timer = useRef(0)
  const alive = useRef(true)

  const load = () => {
    call('/status').then((r) => { if (r && r.ok) setSt(r) }).catch(() => {})
  }
  useEffect(() => {
    load()
    // 切走页面时清掉计时器、标记已卸载，别去动已经不存在的组件
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])

  const upd = (k, v) => setSettings({ [k]: v })

  const LANGS = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: '英语' },
    { value: 'ja', label: '日语' },
    { value: 'ko', label: '韩语' },
    { value: 'fr', label: '法语' },
    { value: 'de', label: '德语' },
    { value: 'es', label: '西班牙语' },
    { value: 'ru', label: '俄语' },
  ]
  const langsFor = (model) =>
    String(model || '').includes('multilingual') ? LANGS : LANGS.filter((x) => x.value === 'zh' || x.value === 'en')
  const multi = String(d.model || '').includes('multilingual')
  const langOptions = langsFor(d.model)

  const setModel = (v) => {
    const langs = langsFor(v)
    const keep = langs.some((x) => x.value === d.language) ? d.language : 'zh'
    setSettings({ model: v, language: keep })
  }

  const doLogin = async () => {
    setBusy('login')
    try {
      const r = await call('/login')
      toast(r.message || 'ok')
    } catch (e) {
      toast('开不了浏览器：' + e.message)
    } finally {
      setBusy('')
      setTimeout(() => { if (alive.current) load() }, 1500)
    }
  }

  const doCheckin = async () => {
    setBusy('checkin')
    try {
      const r = await call('/checkin')
      toast(r.message || 'ok')
    } catch (e) {
      toast('签到失败：' + e.message)
    } finally {
      setBusy('')
      load()
    }
  }

  const doLogout = async () => {
    if (!confirmOut) {
      setConfirmOut(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setConfirmOut(false), 4000)
      return
    }
    clearTimeout(timer.current)
    setConfirmOut(false)
    setBusy('logout')
    try {
      const r = await call('/logout')
      toast(r.message || 'ok')
    } catch (e) {
      toast('退出失败：' + e.message)
    } finally {
      setBusy('')
      setTimeout(() => { if (alive.current) load() }, 800)
    }
  }

  const input = (props) => h('input', { className: 'ab-input', style: { width: '100%' }, ...props })
  const hasLogin = Boolean(st && st.hasLogin)
  const last = st && st.checkin ? st.checkin.lastResult : ''

  return h(ui.Card, {
    title: 'Breeze 语音',
    desc: '在线文字转语音：填好 key 和音色，她的语音条就走 Breeze；合成失败会自动退回 edge / Windows 语音。',
    right: h(ui.Switch, { on: d.on !== false, onChange: (v) => upd('on', v) }),
  },
    h(ui.Row, { label: '登录', hint: '点下面登录一次，之后每天签到都靠它，只有掉登录了才需要再点' },
      h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { small: true, disabled: busy === 'login', onClick: doLogin },
          busy === 'login' ? '正在开…' : '登录'),
        h(ui.Btn, { small: true, disabled: busy === 'checkin', onClick: doCheckin },
          busy === 'checkin' ? '正在领…' : '手动签到'),
        h(ui.Btn, { small: true, disabled: busy === 'logout' || !hasLogin, onClick: doLogout },
          busy === 'logout' ? '正在退…' : confirmOut ? '再点一次就退出' : '退出登录'),
      ),
      h('div', { className: 'ab-muted ab-small', style: { marginTop: 6 } },
        hasLogin ? '登录态已建好' : '还没登录',
        last ? ' ｜ 上次签到：' + last : '',
        ' ｜ 登完我会自己抓，不用点第二下',
        ' ｜ 想换号就先退出登录，再点「登录」重新登'),
    ),

    h(ui.Row, { label: 'API Key', hint: 'breezeblue.ai 后台的 key，形如 brz_…；清空就会退回 edge / Windows 语音' },
      input({
        type: 'password',
        placeholder: 'brz_…',
        value: d.apiKey || '',
        onChange: (e) => setSettings({ apiKey: e.target.value === '' ? null : e.target.value }),
      })),

    h(ui.Row, { label: '音色 ID' },
      input({
        value: d.voiceId || '',
        placeholder: 'voc_xxxxxxxx',
        onChange: (e) => upd('voiceId', e.target.value),
      })),

    h(ui.Row, { label: '模型', hint: '两个价格一样；说中文用第一个就够，要多语言再换第二个' },
      h(ui.Select, {
        value: d.model || 'breeze-tts-2',
        width: 260,
        options: [
          { value: 'breeze-tts-2', label: 'breeze-tts-2（中英）' },
          { value: 'breeze-tts-2-multilingual', label: 'breeze-tts-2-multilingual（多语言）' },
        ],
        onChange: setModel,
      })),

    h(ui.Row, { label: '语言', hint: multi ? '多语言版支持上面这些' : '这个模型只支持中文和英语；要别的语言先把上面的模型换成多语言版' },
      h(ui.Select, {
        value: langOptions.some((x) => x.value === d.language) ? d.language : 'zh',
        width: 200,
        options: langOptions,
        onChange: (v) => upd('language', v),
      })),

    h(ui.Row, { label: '风格指令', hint: '可以留空，比如「语气活泼一点」' },
      h('textarea', {
        className: 'ab-textarea',
        rows: 2,
        style: { width: '100%' },
        value: d.instructions || '',
        onChange: (e) => upd('instructions', e.target.value),
      })),

    h(ui.Row, { label: '浏览器路径', hint: '留空就自己找 Chrome / Edge；找不到再手填 exe 的完整路径' },
      input({
        value: d.browserPath || '',
        placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        onChange: (e) => upd('browserPath', e.target.value),
      })),

    h(ui.Row, { label: '每天自动签到领积分', hint: '到点试一次；那时候 DSH 没开的话，下次启动时补一次' },
      h(ui.Switch, { on: d.checkinOn !== false, onChange: (v) => upd('checkinOn', v) })),

    h(ui.Row, { label: '签到时间' },
      h('input', {
        type: 'time',
        className: 'ab-input',
        style: { width: 140 },
        value: d.checkinTime || '08:10',
        onChange: (e) => upd('checkinTime', e.target.value),
      })),

    h(ui.Row, { label: '领到积分就私聊告诉我', hint: '关掉就只记日志，不打扰你' },
      h(ui.Switch, { on: d.notifyCheckin !== false, onChange: (v) => upd('notifyCheckin', v) })),
  )
}
