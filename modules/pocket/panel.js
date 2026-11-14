// 口袋面板：配对信息一眼可抄——地址、密钥、配对链接；顺便预设 app 端的人物色调
const { useState, useEffect } = React

// 与 app/tones.js 同一套基础色调（面板只挑 key，界面配色在 app 端）
const TONES = [
  { id: 'ocean', name: '深海蓝', a: '#54a8e6', b: '#2f6fb8' },
  { id: 'sakura', name: '樱粉', a: '#f393b2', b: '#c9537a' },
  { id: 'mint', name: '薄荷绿', a: '#57cdaa', b: '#1e8f72' },
  { id: 'grape', name: '葡萄紫', a: '#a68fea', b: '#6a52b8' },
  { id: 'sunset', name: '落日橙', a: '#f5a86b', b: '#c96a2e' },
  { id: 'moon', name: '月白', a: '#9db3cd', b: '#5d7595' },
  { id: 'abyss', name: '深海夜', a: '#5b76cf', b: '#26306b' },
  { id: 'rose', name: '陈玫', a: '#e57c90', b: '#a83349' },
]

return function Panel({ settings, save, toast }) {
  const [net, setNet] = useState(null)
  const [tunBusy, setTunBusy] = useState(false)
  const [svcBusy, setSvcBusy] = useState(false)
  const tone = TONES.some((t) => t.id === settings?.tone) ? settings.tone : 'ocean'
  const token = String(settings?.token || '')

  const reload = () => call('/net-info').then((r) => setNet(r || {})).catch(() => setNet({ ok: false }))
  useEffect(() => { reload() }, [])

  const regen = async () => {
    const strong = 'pk_' + Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 12)).join('')
    await save({ token: strong })
    toast('密钥已换，所有设备要重新配对')
  }

  const port = net?.port || 7788
  const addrs = (net?.addresses || []).map((ip) => `${ip}:${port}`)
  const svc = net?.service || {}
  const st = net?.stale || {}
  const staleNow = st.stale === true // 磁盘上的代码比正在跑的这份新 = 改过没重载
  const svcDown = net?.enabled && !svc.listening // 开关开着但没在监听 = 服务真的没起来
  const drifted = svc.listening && svc.wantPort && svc.listening !== svc.wantPort
  const svcText = !net
    ? '读取中…'
    : !net.enabled
      ? '手机接口关着'
      : svcDown
        ? `服务没起来${svc.error ? '：' + svc.error : ''}`
        : drifted
          ? `端口 ${svc.wantPort} 被占用，实际在 ${svc.listening}（手机要填新端口）`
          : `服务端口 ${svc.listening || port}${svc.ipv4Only ? '（仅 IPv4）' : ''}`
  const tun = net?.tunnel || {}
  const tunnelOrigin = tun.running && tun.url ? tun.url.replace(/^https?:\/\//, '') : ''
  const tunnelPair = tunnelOrigin ? `https://${tunnelOrigin}` : ''
  // 配对优先给隧道地址（外面也能用）；没跑隧道就用局域网第一条
  const pairBase = tunnelPair || (addrs.length ? `http://${addrs[0]}` : '')
  const pairLink = pairBase && token ? `${pairBase}/#host=${encodeURIComponent(pairBase)}&token=${encodeURIComponent(token)}` : ''
  const pairText =
    (tunnelPair ? `隧道（外面用）：${tunnelPair}\n` : '') +
    (addrs.length ? addrs.map((a) => `局域网：http://${a}`).join('\n') : '') +
    (token ? `\n密钥：${token}` : '')

  // 给每个地址标一句「什么时候填它」，免得对着三个地址不知道抄哪个
  const addrLabel = (ip) => {
    const v4 = ip.replace(/^\[|\]$/g, '')
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4)) return '家里 WiFi（和电脑连同一个路由器时用）'
      return '局域网 IPv4'
    }
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4)) return 'Tailscale（两端都要装；国内首次登录常连不上，直连失败会很慢）'
    if (v4.includes(':')) return '公网 IPv6（要求手机流量有 IPv6 + 光猫放行端口）'
    return ''
  }

  // 服务没在监听时点一下就能自愈：重新抢端口 + IPv6 监听失败自动退回 IPv4
  const restartSvc = async () => {
    setSvcBusy(true)
    try {
      const r = await call('/service', { action: 'restart' })
      if (r && r.error) toast('还是没起来：' + r.error)
      else if (r && r.listening) toast('服务已在 ' + r.listening + ' 端口')
      else toast('已重启，端口马上就好')
    } catch (e) {
      toast('重启失败：' + (e && e.message ? e.message : e))
    }
    await new Promise((r) => setTimeout(r, 800))
    await reload()
    setSvcBusy(false)
  }

  const toggleTunnel = async () => {
    setTunBusy(true)
    try {
      const r = await call('/tunnel', { action: tun.running ? 'stop' : 'start' })
      if (r && r.ok === false) toast(r.message || '隧道操作失败')
      else if (r && r.url) toast('隧道好了：' + r.url)
      else toast(r && r.message ? r.message : (tun.running ? '隧道已停' : '隧道已启动'))
    } catch (e) {
      toast('隧道操作失败：' + (e && e.message ? e.message : e))
    }
    await reload()
    setTunBusy(false)
  }

  const cell = { border: '1px solid rgba(128,128,128,.3)', borderRadius: 8, padding: '5px 10px', fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all' }
  const sw = { width: 34, height: 34, borderRadius: 10, border: '2px solid transparent', cursor: 'pointer', padding: 0 }

  return h(ui.Card, { title: '口袋aurabot' },
    h('p', { className: 'ab-note' },
      '把她的对话流开放给手机 app（app 消息走她原生流程，记忆和 QQ 端共用一套）。家里连同一个 WiFi 用局域网地址；人在外面用 4G/5G 时填公网 IPv6 地址。'),

    // 重启提示：stale 时（磁盘文件比正在跑的实例新）是实测出来的，橙色块；平时只是一行小字
    staleNow
      ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderLeft: '3px solid #d68910', background: 'rgba(214,137,16,.10)', borderRadius: 6 } },
          h('p', { className: 'ab-small', style: { margin: 0, fontWeight: 600 } },
            `模块文件已经是 v${st.disk || '新版本'}，但现在跑的还是 v${st.running}——要重启才生效`),
          h('p', { className: 'ab-small ab-muted', style: { margin: '4px 0 0', lineHeight: 1.85 } },
            'DSH 对会开端口这类模块的热重载不总生效，所以改完代码界面没有任何变化（新功能、新文案都不出现），点「重启服务」也没用——那只重开端口，不换代码。做法：把下面「启用手机接口」这个开关关一下再打开；还不行就重启 DSH。重启后这一行会自动消失。'),
          h('p', { className: 'ab-small ab-muted', style: { margin: '4px 0 0' } },
            '顺带一句：重启会停掉隧道，手机地址可能要重新填（面板上会显示新地址）。'),
        )
      : h('p', { className: 'ab-small ab-muted', style: { marginTop: 6, marginBottom: 0 } },
          '改过模块文件要重启一次才生效：把下面「启用手机接口」关一下再打开；还不行就重启 DSH。'),

    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
      h(ui.Btn, {
        onClick: () => { navigator.clipboard?.writeText(pairLink || pairText || token).then(() => toast('配对链接已复制，手机浏览器打开即可')); },
      }, '复制配对链接'),
      h(ui.Btn, { onClick: regen }, '换密钥'),
      svcDown || drifted
        ? h(ui.Btn, { onClick: restartSvc, disabled: svcBusy }, svcBusy ? '重启中…' : '重启服务')
        : null,
      h('span', { className: 'ab-small ab-muted', style: { color: svcDown ? '#c0392b' : undefined } }, svcText),
    ),

    // 服务没起来时把话说清楚：这是「127.0.0.1 也连不上」的那种情况，不是网络问题
    svcDown
      ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderLeft: '3px solid #c0392b', background: 'rgba(192,57,43,.07)', borderRadius: 6 } },
          h('p', { className: 'ab-small', style: { margin: 0, fontWeight: 600 } }, '这台电脑上的 7788 现在没在监听'),
          h('p', { className: 'ab-small ab-muted', style: { margin: '4px 0 0', lineHeight: 1.8 } },
            '手机上任何地址都会失败（连 127.0.0.1 也不通）。常见三种：① ' + (svc.wantPort || port) + ' 端口被别的程序占了；② 模块装不完整（前端文件缺失）；③ 系统禁了 IPv6 导致双栈监听失败。点「重启服务」会重新抢一次端口，并把 IPv6 监听自动退回 IPv4。'),
          svc.error ? h('p', { className: 'ab-small', style: { margin: '4px 0 0', color: '#c0392b', wordBreak: 'break-all' } }, '原始报错：' + svc.error) : null,
          // 启动流水账：能直接看到「哪次尝试、哪个端口、什么错」
          svc.tail && svc.tail.length
            ? h('div', { style: { marginTop: 6, padding: '6px 8px', background: 'rgba(127,127,127,.12)', borderRadius: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.65, wordBreak: 'break-all' } },
                svc.tail.map((l, i) => h('div', { key: i }, String(l).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, ''))))
            : null,
          h('p', { className: 'ab-small ab-muted', style: { margin: '6px 0 0' } },
            '如果是刚更新过模块：DSH 对服务类模块的热重载不总生效，要把面板上这个开关关一下再开（或重启 DSH），新代码才会跑起来。'),
        )
      : null,

    h('div', { style: { marginTop: 10 } },
      h('p', { className: 'ab-small ab-muted' }, '可用地址（手机 app 配对页填，可多个都填上、逗号隔开——中英文逗号都行，app 会自动挑能通的）：'),
      addrs.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            addrs.map((a) => h('div', { key: a, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('code', { style: cell }, `http://${a}`),
              h('span', { className: 'ab-small ab-muted' }, addrLabel(a)),
            )))
        : h('p', { className: 'ab-small ab-muted' }, net ? '没找到局域网地址（没联网？）' : '读取中…'),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '密钥：'),
      h('code', { style: cell }, token || '（还没生成，动一下开关就会生成）'),
    ),

    h('div', { style: { marginTop: 12 } },
      h('p', { className: 'ab-small', style: { fontWeight: 600 } }, '怎么用：'),
      h('ol', { className: 'ab-small ab-muted', style: { margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.8 } },
        h('li', null, '手机装好「口袋aurabot」app（或直接用手机浏览器开上面的地址也行）'),
        h('li', null, 'app 配对页把地址填进去——在家填「家里 WiFi」那条；在外面填「公网 IPv6」或「隧道」地址；拿不准就把几条都填上，逗号隔开（中英文逗号都行）'),
        h('li', null, '密钥抄下面这条（或点上面的「复制配对链接」，手机浏览器打开就自动填好）'),
        h('li', null, '点「连上她」即可；换密钥后所有设备要重新配对'),
      ),
    ),

    // ---- 外网访问：两种备用方案 ----
    h('div', { style: { marginTop: 14 } },
      h('p', { className: 'ab-small', style: { fontWeight: 600 } }, '在外面连电脑（两种方式，都能用，选顺手的）：'),
      h('ul', { className: 'ab-small ab-muted', style: { margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.8 } },
        h('li', null, h('b', null, '公网 IPv6（上面带「公网 IPv6」标注的地址）'), '：地址固定、不用额外软件；但要求手机的流量有 IPv6（很多手机套餐没有），还要在光猫/路由器里放行 ' + port + ' 端口'),
        h('li', null, h('b', null, '隧道（下面按钮）'), '：手机任何网络都能连，不用公网 IP、不碰光猫；https 地址，手机浏览器打开网页也能直接录语音。代价：免费临时域名，电脑重启后要重新点一次「启动隧道」，把新地址填回 app'),
        h('li', null, h('b', null, 'Tailscale（地址列表里 100.x.x.x 那种）'), '：两端都装、登同一账号，打洞成功时速度接近你家宽带上行。国内有三点要知道：① 它本身就是 VPN，手机上一开就占了系统唯一的 VPN 槽位，和代理/加速器不能同时开；② 控制面在境外，新设备首次登录（GitHub/Google 账号）经常连不上、要反复试；③ 官方中继没有大陆节点（最近在香港、东京），打洞失败会绕道境外，延迟 150–300ms 很慢。账号早就登好的人用它最省事，没装过就别折腾，直接用隧道'),
        h('li', null, h('b', null, '外面的 WiFi 本身也会拦'), '：公司、酒店、校园网常只放行 80/443，IPv6 直连的 ' + port + ' 就通不了；要网页登录的访客网络没登录前什么都连不上（app 会报 P30）。这种场合用隧道最省事，实在不行开自己手机热点。'),
      ),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
        '走 IPv6 还有个前置条件：Windows 防火墙也要放行 ' + port + ' 入站。这步要管理员权限，模组没权限替你做——用管理员 PowerShell 跑一条 netsh 命令就行（群里有一键脚本，或看 README「在外面用」一节）。安全软件（360/火绒）的网络防护也会拦，需要在它里面单独放行。'),

      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { onClick: toggleTunnel, disabled: tunBusy }, tunBusy ? '处理中…（首次约 10 秒）' : tun.running ? '停止隧道' : '启动隧道'),
        tun.running && tunnelPair ? h('code', { style: cell }, tunnelPair) : null,
        tun.running && tunnelPair
          ? h(ui.Btn, { onClick: () => { navigator.clipboard?.writeText(tunnelPair).then(() => toast('隧道地址已复制，填进 app 或手机浏览器打开')) } }, '复制隧道地址')
          : null,
        h('span', { className: 'ab-small ab-muted' },
          !tun.installed ? '未安装 cloudflared' : tun.running ? (tunnelPair ? '运行中' : '连接中…') : '未启动'),
      ),
      !tun.installed
        ? h('p', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
            '隧道需要 cloudflared：到 https://github.com/cloudflare/cloudflared/releases/latest 下载 cloudflared-windows-amd64.exe，放到任意位置（如 C:\\Users\\你\\auratools\\bin\\），面板会自动找到；找不到就在模块设置里把完整路径填进「cloudflaredPath」。')
        : null,
      tun.error ? h('p', { className: 'ab-small', style: { marginTop: 6, color: '#c0392b' } }, tun.error) : null,
    ),

    // ---- 连不上怎么查 ----
    h('div', { style: { marginTop: 12, padding: '8px 10px', borderLeft: '3px solid rgba(192,57,43,.45)', background: 'rgba(192,57,43,.06)', borderRadius: 6 } },
      h('p', { className: 'ab-small', style: { fontWeight: 600, margin: 0 } }, '几个地址都连不上？按这个顺序查'),
      h('ol', { className: 'ab-small ab-muted', style: { margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.8 } },
        h('li', null, '手机上的 VPN / 代理 / 网络加速先关掉（Clash、广告拦截 App 也算）。全局模式会把局域网地址和隧道域名一起接走——这是「四个地址都试过还是不行」最常见的原因'),
        h('li', null, '手机浏览器直接打开 http://电脑IP:' + port + '/api/health ：看到 {"ok":true,…} 说明网络通的，问题在 app 里地址的写法；打不开就是网络层（WiFi / 防火墙 / IPv6）'),
        h('li', null, '确认手机真的和电脑在同一个 WiFi。用手机流量时局域网地址一定不通，得走隧道或公网 IPv6'),
        h('li', null, '隧道地址只有电脑上隧道「运行中」的时候有效；电脑重启后旧地址就废了，要重新点「启动隧道」再填新地址'),
      ),
      h('p', { className: 'ab-small ab-muted', style: { margin: '6px 0 0' } },
        '电脑这边开着 VPN 时，上面列表只保留真实网卡（虚拟网卡的地址手机连不上，已自动过滤）。'),

      // 代号速查：app 端连不上时会给出 P11 这类代号，这里能直接对照
      h('details', { style: { marginTop: 6 } },
        h('summary', { className: 'ab-small', style: { cursor: 'pointer', color: 'var(--ab-muted, #888)' } }, '代号速查（app 报 P11 这类代号时对照这里）'),
        h('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 } },
          [
            ['P11', '局域网地址超时', '不在这个 WiFi / 电脑防火墙 / 手机开着 VPN'],
            ['P12', '公网 IPv6 超时', '手机没 IPv6 / 光猫没放行 / 外面 WiFi 封端口'],
            ['P13', '隧道域名超时', '电脑上隧道停了 / 代理拦了域名'],
            ['P14', '局域网地址不可达', '服务没开 / 换了网络 / 地址过期'],
            ['P15', '公网 IPv6 不可达', '手机没 IPv6 / 连的 WiFi 只给 IPv4'],
            ['P16', '隧道域名不可达', '隧道停了 / DNS 被代理带偏'],
            ['P17', '域名解析失败', '代理 / 私人 DNS / 广告拦截改了 DNS'],
            ['P18', '证书不对', '有代理或抓包软件在中间劫持'],
            ['P19', '地址格式不对', '端口写了两个 / IPv6 少方括号'],
            ['P21', '密钥不对', '和面板上那条 pk_ 的对不上'],
            ['P22', '密钥试错太多被限流', '60 秒内错 10 次，等一分钟'],
            ['P23', '电脑接口没正常响应', '端口被别的程序占了 / 服务没起来'],
            ['P24', '电脑那边出错了', '接口 5xx，看 DSH 日志'],
            ['P30', '手机当前网络本身没通', '连的 WiFi 要网页登录 / 根本没网'],
            ['P99', '未知原因', '把原始报错一起发出来'],
          ].map(([code, name, why]) =>
            h('div', { key: code, style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.7 } },
              h('code', { style: { flex: '0 0 34px', color: '#c0392b' } }, code),
              h('span', { style: { flex: '0 0 130px' } }, name),
              h('span', { className: 'ab-muted', style: { flex: 1 } }, why),
            ),
          ),
        ),
      ),
    ),

    // ---- 人物色调预设 ----
    h('div', { style: { marginTop: 14 } },
      h('p', { className: 'ab-small ab-muted' }, '人物色调预设（app 界面配色，手机端也能改）：'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
        TONES.map((t) =>
          h('button', {
            key: t.id,
            title: t.name,
            style: { ...sw, background: `linear-gradient(135deg, ${t.a}, ${t.b})`, borderColor: tone === t.id ? 'var(--ab-primary, #3f86d4)' : 'transparent', outline: tone === t.id ? '2px solid rgba(63,134,212,.35)' : 'none' },
            onClick: async () => {
              await save({ tone: t.id })
              toast(`色调预设为「${t.name}」，app 端会跟着换`)
            },
          }),
        ),
      ),
    ),

    h('p', { className: 'ab-small ab-muted', style: { marginTop: 10 } },
      'app 界面直接手机浏览器开 http://电脑IP:' + port + ' 也行；全部接口要配对密钥。消息只注入主人的私聊，发不了别人和群。'),
  )
}
