// 通话模块的小面板：显示耳朵/嘴的状态，给一个进通话页的入口
// 注意：面板里的 window.open 会被宿主拦掉，所以用真链接 + 复制地址两条路
const { useState, useEffect } = React

return function Panel({ settings, save, toast }) {
  const [st, setSt] = useState(null)
  const [url, setUrl] = useState('')
  const [lan, setLan] = useState(null)
  const [frame, setFrame] = useState(true)

  const reload = () => {
    call('/state').then(setSt).catch(() => setSt({ ok: false }))
    call('/link').then((r) => setUrl(r?.url || '')).catch(() => {})
    call('/lan').then(setLan).catch(() => setLan({ ok: false }))
  }
  useEffect(() => { reload() }, [])

  const copy = async (text, tip) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast && toast(tip || '已复制')
    } catch (error) {
      window.prompt('复制这个地址：', text)
    }
  }

  const asr = st?.asr
  const line = (label, ok, text) =>
    h(ui.Row, { key: label, label },
      h('span', { className: ok ? '' : 'ab-muted' }, (ok ? '✓ ' : '· ') + text))

  const linkStyle = {
    display: 'inline-block',
    padding: '6px 12px',
    borderRadius: 8,
    background: 'var(--ab-accent, #3b82f6)',
    color: '#fff',
    textDecoration: 'none',
    fontSize: 13,
    lineHeight: '20px',
  }

  return h(ui.Card, { title: '通话' },
    h('p', { className: 'ab-note' }, '不用按住：开口说话自动断句，本地识别 + 她本人思考 + 她的声音念出来。不花钱，也不进出 QQ。'),
    st === null
      ? h('p', { className: 'ab-muted' }, '读状态中…')
      : st.ok === false
        ? h('p', { className: 'ab-muted' }, '读不到状态，模块可能刚重启')
        : h('div', null,
            line('耳朵', asr?.ready, asr?.ready ? (asr.provider || '本地识别') : (asr?.why || '不可用')),
            line('嘴', st.tts, st.tts ? (st.mouth?.provider || st.engine || '本地合成') : (st.mouth?.why || '不可用，只能用浏览器念')),
            line('垫话', (st.fillers || 0) > 0, `${st.fillers || 0} 句已备好`),
          ),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' } },
      h(ui.Btn, { onClick: () => setFrame(!frame) }, frame ? '收起通话页' : '在这里直接通话'),
      h('a', {
        href: url || '/aurabot/api/ext/voicecall/page',
        target: '_blank',
        rel: 'noopener noreferrer',
        style: linkStyle,
      }, '新窗口打开'),
      h(ui.Btn, { onClick: () => copy(url, '地址已复制，粘到浏览器就能打开') }, '复制地址'),
      h(ui.Btn, { onClick: reload }, '刷新状态'),
    ),
    frame
      ? h('div', { style: { marginTop: 10 } },
          h('iframe', {
            src: url || '/aurabot/api/ext/voicecall/page',
            allow: 'microphone; autoplay; clipboard-write',
            style: { width: '100%', height: '78vh', border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, background: '#14161a' },
          }))
      : null,
    h('div', { style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(128,128,128,.18)' } },
      h('p', { className: 'ab-note' }, '手机上用（同一 Wi-Fi）'),
      lan === null
        ? h('p', { className: 'ab-muted' }, '检查中…')
        : lan.ok
          ? h('div', null,
              h('p', { className: 'ab-small', style: { wordBreak: 'break-all' } }, lan.url),
              h('p', { className: 'ab-small ab-muted' }, '链接里的 t= 是会话令牌，等于钥匙：别发群里，泄露了点「换新链接」'),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
                h(ui.Btn, { onClick: () => copy(lan.url, '手机地址已复制，发到手机上打开') }, '复制手机地址'),
                h(ui.Btn, {
                  onClick: () => {
                    call('/lan?reset=1').then((x) => { setLan(x); copy(x.url, '已换成新链接，旧链接作废') }).catch(() => {})
                  },
                }, '换新链接'),
              ),
              h('p', { className: 'ab-small ab-muted' },
                '第一次打开会提示证书不受信任，点「高级 / 继续前往」就行（自签证书，只在这台电脑上生效）。'),
            )
          : h('p', { className: 'ab-small ab-muted' }, '没开起来：' + (lan.why || '未知原因')),
    ),
    url ? h('p', { className: 'ab-small ab-muted', style: { wordBreak: 'break-all', marginTop: 6 } }, url) : null,
  )
}
