// 识图面板：状态 / 试一张 / 最近识别。
// 执行方式：插件把这份文件当函数体用 Function 构造器跑一遍 → return 一个组件。
//
// 注意：所有设置项都由 module.json 的 settings 自动渲染在同一页下方，
// 这里一个开关都不放，免得「总开关」出现两次。
const { useState, useEffect, useRef, useCallback } = React

const dim = (t) => h('span', { className: 'ab-small ab-muted' }, t)
const ok = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)' } }, t)
const warn = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, t)
const err = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-err)' } }, t)

const fmtTime = (at) => {
  const d = new Date(Number(at) || 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const pre = (text, max) =>
  h(
    'pre',
    {
      className: 'ab-small',
      style: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: max || 220,
        overflow: 'auto',
        margin: '6px 0 0',
        padding: '8px 10px',
        borderRadius: 6,
        background: 'rgba(128,128,128,.08)',
      },
    },
    text,
  )

return function Panel({ toast, settings, draftSettings }) {
  // 只读设置（不在这里改，开关都在下方自动生成的表单里）
  const s = draftSettings || settings || {}
  const [st, setSt] = useState(null)
  const [prog, setProg] = useState(null)
  const [describeTarget, setDescribeTarget] = useState(null)
  const [chatCanSee, setChatCanSee] = useState(null)
  const [recent, setRecent] = useState([])
  const [cache, setCache] = useState(null)

  const [path, setPath] = useState('')
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
  const timer = useRef(null)

  const pull = useCallback(async (fresh) => {
    try {
      const r = await call('/status' + (fresh ? '?fresh=1' : ''))
      setSt(r.status)
      setProg(r.progress)
      setDescribeTarget(r.describeTarget || null)
      setChatCanSee(typeof r.chatCanSee === 'boolean' ? r.chatCanSee : null)
      setRecent(r.recent || [])
      setCache(r.cache || null)
    } catch (e) {}
  }, [])

  useEffect(() => {
    pull(false)
    timer.current = setInterval(() => pull(false), 3000)
    return () => clearInterval(timer.current)
  }, [pull])

  const install = async () => {
    setInstalling(true)
    try {
      await call('/install')
      toast('开始安装，进度会自动刷新')
      pull(true)
    } catch (e) {
      toast('启动安装失败：' + (e && e.message ? e.message : e))
    } finally {
      setInstalling(false)
    }
  }

  // 试一张：走和线上完全相同的处理链，返回「她实际会看到什么」
  const runTest = async (payload) => {
    setBusy(true)
    setRes(null)
    try {
      const r = await call('/test', payload || { path: path.trim() || undefined })
      setRes(r)
      if (!r.ok) toast(r.message || '没读到东西')
      else if (!r.substantive && !r.described) toast('没字，也没能描述画面')
      else toast(r.described ? '没字，已补画面描述' : `读到 ${r.lines} 行`)
    } catch (e) {
      toast('测试失败：' + (e && e.message ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = String(reader.result || '').split(',')[1] || ''
      setPath(f.name)
      runTest({ base64: b64 })
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  const clearCache = async () => {
    await call('/cache/clear', {})
    toast('缓存清了')
    pull(true)
  }

  const ready = Boolean(st && st.ready)
  const running = Boolean(prog && prog.running)
  const phase = prog && prog.phase
  const percent = (prog && prog.percent) || 0

  // 引擎四态：ready 自有环境 / borrowed 借系统 / missing 能装 / blocked 不能碰
  const engineState = st ? st.state || (st.blocked ? 'blocked' : st.ready ? 'ready' : 'missing') : 'missing'

  const statusText = running
    ? `安装中 · ${prog.step || ''} ${percent}%`
    : engineState === 'ready'
      ? '就绪'
      : engineState === 'borrowed'
        ? '就绪（借用系统环境）'
        : engineState === 'blocked'
          ? '不自动安装'
          : st && st.engineReady
            ? '有引擎，缺脚本'
            : st && st.canInstall
              ? '有 Python，缺引擎'
              : '还没装'

  const statusNode = running
    ? warn(statusText)
    : engineState === 'ready'
      ? ok(statusText)
      : engineState === 'blocked'
        ? err(statusText)
        : warn(statusText)

  return h(
    'div',
    null,

    // ── 状态 ────────────────────────────────────────────────
    // 文字分工：desc 只讲这个模块是什么；每行 hint 只讲那一行是什么；
    // 花钱的事只说一次（下面那个橙色块），别再散在 desc / hint / 设置 label 里。
    h(
      ui.Card,
      { title: '识图 · 本地 OCR', desc: '给看不了图的模型配一双只认字的眼睛。' },
      h(
        ui.Row,
        { label: '引擎' },
        statusNode,
        st && st.rapidocr ? dim(`  rapidocr ${st.rapidocr} · python ${st.version || '?'}`) : null,
      ),

      // 借用别人的环境：能用，但说明白为什么不建议长期这样
      engineState === 'borrowed'
        ? h(
            'div',
            {
              style: {
                margin: '4px 0 8px',
                padding: '8px 12px',
                borderRadius: 6,
                borderLeft: '3px solid var(--ab-warn, #e6a23c)',
                background: 'rgba(230,162,60,.08)',
              },
            },
            h('div', { style: { fontWeight: 700, fontSize: 12.5 } }, '用的是系统里已经装的 rapidocr'),
            h(
              'div',
              { className: 'ab-small ab-muted', style: { marginTop: 3, lineHeight: 1.5 } },
              '模块没往里写任何东西，但它被卸载或升级时这里会一起坏。',
              '想要稳的，把「引擎目录」指到一个空目录，再点「安装引擎」建一份独立的（约 320MB）。',
            ),
          )
        : null,

      // 明确不装的时候，把原因说清楚，别让人以为是坏了
      engineState === 'blocked'
        ? h(
            'div',
            {
              style: {
                margin: '4px 0 8px',
                padding: '8px 12px',
                borderRadius: 6,
                borderLeft: '3px solid var(--ab-err)',
                background: 'rgba(220,80,80,.08)',
              },
            },
            h('div', { style: { fontWeight: 700, fontSize: 12.5 } }, '这里不会自动装'),
            h(
              'div',
              { className: 'ab-small ab-muted', style: { marginTop: 3, lineHeight: 1.5 } },
              '为了不动到你已有的文件：目录里有别的东西、或者已经有一个不是本模块建的虚拟环境时，模块一个字节都不写。',
              '把「引擎目录」换成一个空目录就能装。',
            ),
            st && st.reason ? pre(st.reason, 140) : null,
          )
        : null,

      h(
        ui.Row,
        { label: '她现在看得见图吗' },
        chatCanSee === null
          ? dim('不知道（模型没声明）')
          : chatCanSee
            ? ok('看得见，原图会一起给她')
            : warn('看不见，只靠这里读出来的字'),
      ),

      h(
        ui.Row,
        { label: '没字时谁来描述画面' },
        describeTarget ? dim(`${describeTarget.provider} / ${describeTarget.model}`) : warn('没有可用的看图模型'),
      ),

      // 花钱只在这一个地方说清楚，加粗橙色
      s.describeFallback !== false && describeTarget
        ? h(
            'div',
            {
              style: {
                margin: '10px 0 4px',
                padding: '9px 12px',
                borderRadius: 6,
                borderLeft: '3px solid var(--ab-warn, #e6a23c)',
                background: 'rgba(230,162,60,.10)',
              },
            },
            h(
              'div',
              { style: { fontWeight: 700, fontSize: 13 } },
              `⚠ 图里没字时会调一次 ${describeTarget.model}`,
            ),
            h(
              'div',
              { className: 'ab-small ab-muted', style: { marginTop: 4, lineHeight: 1.55 } },
              '每张没字的图算一次模型调用，按它的倍率扣。想省这笔就关掉「补一句画面描述」；读字本身不花钱。',
            ),
          )
        : null,

      h(
        ui.Row,
        { label: '缓存' },
        cache ? dim(`${cache.count} / ${cache.max} 张，只存文字不存图`) : dim('—'),
      ),

      // 安装进度条
      running
        ? h(
            'div',
            { style: { margin: '10px 0 4px' } },
            h(
              'div',
              { style: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,.2)', overflow: 'hidden' } },
              h('div', {
                style: {
                  height: '100%',
                  width: `${Math.max(2, Math.min(100, percent))}%`,
                  background: 'var(--ab-accent, #4a9eff)',
                  transition: 'width .4s ease',
                },
              }),
            ),
            h(
              'div',
              { className: 'ab-small ab-muted', style: { marginTop: 6 } },
              prog.step || '',
              prog.detail ? ` · ${prog.detail}` : '',
            ),
          )
        : null,

      phase === 'error' ? h('div', null, h('p', { className: 'ab-note' }, err(prog.step || '安装失败')), pre(prog.error, 160)) : null,

      h(
        ui.Row,
        null,
        h(
          ui.Btn,
          {
            onClick: install,
            // blocked 时按钮仍然可点：用户可能刚把目录改成空的，点一下就该能装
            disabled: busy || running || installing,
          },
          running ? '安装中…' : engineState === 'blocked' ? '再试一次' : ready ? '重新检查 / 修复' : '安装引擎',
        ),
        h(ui.Btn, { onClick: () => pull(true) }, '刷新'),
        h(ui.Btn, { onClick: clearCache }, '清缓存'),
      ),

      // 装好了就不提下载体积了；还没装才提醒
      engineState === 'ready' || engineState === 'borrowed'
        ? null
        : dim('首次装约 320MB，几分钟。装完运行期不再联网。'),
    ),

    // ── 试一张 ──────────────────────────────────────────────
    // 这里不再复述处理链（上面已经说过一次），只讲「试了会怎样」。
    h(
      ui.Card,
      { title: '试一张', desc: '跑一遍她收到这张图时会经历的处理，不发消息。' },
      h(
        ui.Row,
        null,
        h('input', {
          className: 'ab-input',
          style: { flex: 1, minWidth: 200 },
          placeholder: '本机图片绝对路径，留空 = 用自带测试图',
          value: path,
          onChange: (e) => setPath(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !busy && ready) runTest()
          },
        }),
        h(ui.Btn, { onClick: () => runTest(), disabled: busy || !ready }, busy ? '处理中…' : '识别'),
        h(
          'label',
          { className: 'ab-btn', style: { cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5 } },
          '选文件',
          h('input', {
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            disabled: busy || !ready,
            onChange: pickFile,
          }),
        ),
      ),

      res
        ? h(
            'div',
            { style: { marginTop: 12 } },
            // 结论：一目了然，读不出字就说清为什么
            h(
              'div',
              { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 8 } },
              res.error
                ? err('识别出错')
                : res.substantive
                  ? ok(`读出 ${res.lines} 行字`)
                  : res.described
                    ? ok('没字，已改看画面')
                    : warn('没字，也没描述'),
              dim(`${res.elapsedMs}ms${res.cached ? ' · 缓存' : ''}`),
            ),

            res.error ? pre(res.error, 120) : null,

            // 她实际收到的东西，就是唯一要看的正文
            res.preview
              ? h('div', null, dim('她会收到：'), pre(res.preview, 320))
              : h('div', null, warn('什么都没读出来，原样放行——她只会看到图片本身')),
          )
        : null,
    ),

    // ── 最近识别 ────────────────────────────────────────────
    h(
      ui.Card,
      { title: '最近识别' },
      recent.length === 0
        ? h(ui.Empty, null, '还没处理过图片')
        : h(
            'div',
            null,
            recent.map((r, i) =>
              h(
                'div',
                {
                  key: `${r.at}-${i}`,
                  className: 'ab-small',
                  style: {
                    padding: '5px 0',
                    borderBottom: '1px solid rgba(128,128,128,.12)',
                    display: 'flex',
                    gap: 10,
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                  },
                },
                dim(fmtTime(r.at)),
                h('span', { style: { minWidth: 128 } }, r.chatId || '—'),
                h('span', null, `${r.images} 张`),
                r.chars ? ok(`${r.chars} 有字`) : null,
                r.described ? ok(`${r.described} 描画面`) : null,
                dim(`${r.ms}ms${r.cached ? ` · 缓存${r.cached}` : ''}`),
                r.ok ? null : warn(r.note || '没结果'),
              ),
            ),
          ),
      recent.length ? dim('只在内存里，重启清空。') : null,
    ),
  )
}
