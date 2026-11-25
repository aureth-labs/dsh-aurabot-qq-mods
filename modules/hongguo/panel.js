// 红果短剧面板（模块自带，官方 panel.js 机制）
const { useState, useEffect } = React

// 展示墙：竖版海报网格（640×914，2:3 卡片）
const HG_KIND = { watch: '看过', share: '分享给你' }
const HG_CSS = `
.ab-hgwall{display:grid;grid-template-columns:repeat(auto-fill,minmax(124px,1fr));gap:10px;align-items:stretch}
.ab-hgcard{display:flex;flex-direction:column;height:100%;border:1px solid var(--ab-line);border-radius:10px;overflow:hidden;background:var(--ab-card);text-decoration:none;color:inherit;transition:border-color .15s ease, transform .15s ease}
.ab-hgcard:hover{border-color:var(--ab-sea);transform:translateY(-1px)}
.ab-hgcard .cv{position:relative;aspect-ratio:2/3;flex:none;background:var(--ab-card-2);overflow:hidden}
.ab-hgcard .cv img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.ab-hgcard .cv.empty{background:linear-gradient(135deg,var(--ab-foam),var(--ab-card-2))}
.ab-hgcard .cv .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:700;color:var(--ab-sea);opacity:.55}
.ab-hgcard .cv i{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.58);color:#fff;font-size:11px;font-style:normal;line-height:1.7;padding:0 7px;border-radius:999px}
.ab-hgcard .cv i.share{background:var(--ab-sea)}
.ab-hgcard .cv b.sc{position:absolute;right:6px;top:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;font-weight:600;font-style:normal;line-height:1.7;padding:0 6px;border-radius:999px;backdrop-filter:blur(2px)}
.ab-hgcard .cv b.sc.good{background:var(--ab-sea)}
.ab-hgcard .tt{padding:6px 8px 0;margin-bottom:2px;font-size:12px;line-height:1.45;height:2.9em;overflow:hidden;word-break:break-all}
.ab-hgcard .tx{padding:0 8px;margin-bottom:7px;font-size:11px;line-height:1.4;height:2.8em;overflow:hidden;color:var(--ab-sub);word-break:break-all}
`

return function HongguoPanel ({ toast }) {
  const [login, setLogin] = useState(null) // { loggedIn, shot, me }
  const [busy, setBusy] = useState('')
  const [recent, setRecent] = useState(null)
  const [vt, setVt] = useState(null) // 看图自检结果

  // 宿主把接口异常也包成 HTTP 200 + ok:false：必须看 ok，否则会显示成「还没刷过」
  const loadRecent = () => call('/hongguo/state?limit=60').then((r) => {
    if (r && r.ok === false) { setRecent(null); toast('读取记录失败：' + (r.message || '接口没通'), 'err'); return }
    setRecent((r && r.recent) || [])
  }).catch((e) => { setRecent(null); toast('读取记录失败：' + e.message, 'err') })

  useEffect(() => { loadRecent() }, [])

  // 登录轮询：二维码出来后每 2.5 秒看一眼。接口出错时安静跳过，别抛未处理的 rejection
  const polling = Boolean(login) && !login.loggedIn
  useEffect(() => {
    if (!polling) return undefined
    let ticks = 0
    const t = setInterval(async () => {
      // 浏览器打不开时接口会一直返回「未登录」：给个上限，别让面板开着就一直打
      if (++ticks > 120) { clearInterval(t); toast('登录没等到结果，先停了，需要再点「开始登录」', 'err'); return }
      const r = await call('/hongguo/login/poll').catch(() => null)
      if (!r) return
      if (r.loggedIn) { setLogin(r); toast('登录成功：' + ((r.me && r.me.nickname) || '')); clearInterval(t) } else if (r.shot) setLogin(r)
    }, 2500)
    return () => clearInterval(t)
  }, [polling])

  const startLogin = async () => {
    setBusy('login')
    const r = await call('/hongguo/login/start').catch((e) => ({ ok: false, message: e.message }))
    setBusy('')
    if (!r.ok) return toast(r.message || '打不开浏览器', 'err')
    setLogin(r)
    if (r.loggedIn) toast('已经是登录状态')
  }

  const runOnce = async () => {
    setBusy('run')
    const r = await call('/hongguo/run').catch((e) => ({ ok: false, message: e.message }))
    setBusy('')
    toast(r.message || (r.ok ? '刷完了' : '没刷成'), r.ok ? 'ok' : 'err')
    loadRecent()
  }

  // 显示 / 收起浏览器窗口。收起只是把窗口挪到屏幕外，刷剧照跑，不占屏幕。
  const showWindow = async (visible) => {
    setBusy('win')
    const r = await call('/hongguo/show', { visible }).catch((e) => ({ ok: false, message: e.message }))
    setBusy('')
    toast(r.message || (visible ? '浏览器已经调出来了' : '窗口收起来了'), r.ok === false ? 'err' : 'ok')
  }

  // 自检：真播十几秒抓一帧，问她画面里有什么。能不能看懂图，一按就知道。
  const visionTest = async () => {
    setBusy('vt')
    setVt(null)
    const r = await call('/hongguo/vision-test').catch((e) => ({ ok: false, message: e.message }))
    setBusy('')
    setVt(r)
    toast(r.ok ? '她能看懂画面' : (r.message || '看不懂画面'), r.ok ? 'ok' : 'err')
  }

  // 补封面：展示墙之前刷的老记录没有海报，一部部去详情页取（一次 12 部）
  const fillCovers = async () => {
    setBusy('fill')
    const r = await call('/hongguo/backfill-covers', {}).catch((e) => ({ ok: false, message: e.message }))
    setBusy('')
    toast(r.message || (r.ok ? '补完了' : '没补成'), r.ok ? 'ok' : 'err')
    loadRecent()
  }

  // 一部剧可能既「看过」又「分享给你」—— 合成一张卡，角标取更重要的那个（分享 > 看过）
  const wallOf = (list) => {
    const map = new Map()
    for (const x of list || []) {
      if (!x || !x.href) continue
      const cur = map.get(x.href)
      if (!cur) {
        map.set(x.href, {
          href: x.href, title: x.title, cover: x.cover || '', kinds: [x.kind], text: x.text || '',
          score: x.score || 0, good: !!x.good, plot: x.plot || '', saw: !!x.saw, sec: x.sec || 0
        })
        continue
      }
      if (!cur.cover && x.cover) cur.cover = x.cover
      if (!cur.title && x.title) cur.title = x.title
      if (x.kind && !cur.kinds.includes(x.kind)) cur.kinds.push(x.kind)
      if (!cur.text && x.text) cur.text = x.text
      if (!cur.plot && x.plot) cur.plot = x.plot
      // 分数与「金标」必须来自同一条记录，否则会出现「金标 + 低分」
      if ((x.score || 0) > (cur.score || 0)) { cur.score = x.score || 0; cur.good = !!x.good }
      else if ((x.score || 0) === (cur.score || 0) && x.good) cur.good = true
      if (x.saw) cur.saw = true
      if (!cur.sec && x.sec) cur.sec = x.sec
    }
    return [...map.values()]
  }

  // 一张海报卡片：封面 + 角标（看过 / 分享给你）+ 评分 + 剧名 + 她说的话（没话就显示她看到的剧情）
  const hgCell = (x, i) => {
    const title = x.title || '未命名'
    const shared = (x.kinds || []).includes('share')
    const kind = HG_KIND[shared ? 'share' : (x.kinds || ['watch'])[0]] || '看过'
    const tip = [
      title,
      x.score ? `她打了 ${x.score} 分` : '',
      x.saw ? `看了 ${x.sec || 0} 秒画面` : (x.sec ? `播了 ${x.sec} 秒（没看成画面）` : ''),
      x.plot ? `剧情：${x.plot}` : '',
      x.text ? `她的话：${x.text}` : ''
    ].filter(Boolean).join('\n')
    return h('a', {
      key: x.href || i,
      className: 'ab-hgcard',
      href: x.href || 'https://hongguoduanju.com/',
      target: '_blank',
      rel: 'noreferrer',
      title: tip
    },
    h('div', { className: 'cv' + (x.cover ? '' : ' empty') },
      x.cover
        ? h('img', { src: x.cover, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
        : h('span', { className: 'ph' }, title.slice(0, 1)),
      h('i', { className: shared ? 'share' : null }, kind),
      x.score ? h('b', { className: 'sc' + (x.good ? ' good' : '') }, String(x.score)) : null),
    h('div', { className: 'tt' }, title),
    h('div', { className: 'tx' }, x.text || x.plot || '')) // 没话说也留这一块，卡片才等高
  }

  return h(React.Fragment, null,
    h('style', null, HG_CSS),
    h(ui.Card, { title: '她真的看得懂吗', desc: '真播十几秒抓一帧，问她画面里有什么。确认当前模型能不能看懂画面 —— 看不懂就只会照简介瞎写。' },
      h(ui.Btn, { disabled: !!busy, onClick: visionTest }, busy === 'vt' ? '正在试（要播十几秒）…' : '试一下她能不能看懂画面'),
      vt && vt.ok ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
        `《${vt.title}》播了 ${vt.seconds} 秒，她看到：${vt.saw}${vt.genre ? `（${vt.genre}）` : ''}`) : null,
      vt && !vt.ok ? h('div', { className: 'ab-small', style: { marginTop: 8, color: 'var(--ab-danger, #d9534f)' } }, vt.message || '没试成') : null
    ),
    h(ui.Card, { title: '登录', desc: '扫一次码，登录状态存在专用浏览器里，之后不用再登。' },
      h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { kind: 'primary', disabled: !!busy, onClick: startLogin }, busy === 'login' ? '正在打开…' : '开始登录 / 打开浏览器'),
        h(ui.Btn, { disabled: !!busy, onClick: () => showWindow(true) }, '显示浏览器窗口'),
        h(ui.Btn, { disabled: !!busy, onClick: () => showWindow(false) }, '收起窗口'),
        h(ui.Btn, { disabled: !!busy, onClick: runOnce }, busy === 'run' ? '正在刷…' : '现在刷一轮')),
      login && !login.loggedIn && login.shot ? h('div', { style: { marginTop: 10 } },
        h('div', { className: 'ab-small ab-muted' }, '用红果 App 扫码登录（浏览器窗口里也能直接操作）：'),
        h('img', { src: login.shot, alt: '红果登录', style: { maxWidth: 320, width: '100%', border: '1px solid var(--ab-line)', borderRadius: 8, marginTop: 6 } })) : null,
      login && login.loggedIn ? h('div', { className: 'ab-note', style: { marginTop: 8 } }, '已登录：' + ((login.me && login.me.nickname) || '（没拿到昵称）')) : null,
      !login ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '点「开始登录」会开一个专用浏览器窗口，登录状态单独存，不碰你平时的浏览器；扫码成功后窗口会自动收起。') : null
    ),
    h(ui.Card, { title: '她刷过什么', right: h('div', { className: 'ab-flex' },
      h(ui.Btn, { small: true, kind: 'ghost', onClick: loadRecent }, '刷新'),
      h(ui.Btn, { small: true, kind: 'ghost', disabled: !!busy, onClick: fillCovers }, busy === 'fill' ? '补封面中…' : '补封面')) },
    recent === null ? h(ui.Empty, { icon: '⏳', text: '加载中…' })
      : recent.length === 0 ? h(ui.Empty, { icon: '📺', text: '还没刷过。点上面「现在刷一轮」试试。' })
        : h('div', { className: 'ab-hgwall' }, wallOf(recent).map(hgCell)))
  )
}
