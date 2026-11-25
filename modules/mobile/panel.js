// 模块自带面板；连接选项与设备凭据统一由 service 的 devices.json 管理。
const { useState, useEffect } = React
const { Card, Row, Btn, Switch, Empty } = ui
return function Panel({ toast }) {
  const [s, setS] = useState(null), [pair, setPair] = useState(null), [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false), [clock, setClock] = useState(Date.now())
  const [risk, setRisk] = useState(false)
  const load = () => call('/status').then((r) => { if (r.ok === false) { toast(r.message); return }; setS(r); setForm((f) => f || r.options) })
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const r = await call('/status')
        if (alive) {
          if (r.ok === false) { toast(r.message); return }
          setS(r); setForm((f) => f || r.options || {}); setClock(Date.now())
        }
      } catch (e) { if (alive) toast('读取手机端状态失败：' + e.message) }
    }
    refresh()
    const t = setInterval(refresh, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const act = async (path, body = {}) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await call('/' + path, body)
      if (r.ok === false) toast(r.message, 'err')
      else { if (path === 'pairing') setPair(r); else setPair(null); await load() }
      return r
    } catch (e) { toast('操作失败：' + e.message, 'err') }
    finally { setBusy(false) }
  }
  if (!s || !form) return h(Empty, { text: '正在读取手机端状态…' })
  const field = (key, label, hint, type) => h(Row, { label, hint }, h('input', { className: 'ab-input wide', type: type || 'text', value: form[key] == null ? '' : form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) }))
  const expired = !pair || pair.expiresAt <= clock
  return h('div', { className: 'ab-grid' },
    h(Card, {
      title: '手机端',
      right: h('span', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
        h('span', { className: 'ab-small ab-muted' }, '总开关'),
        h(Switch, { on: s.options.enabled === true, disabled: busy, onChange: () => act(s.options.enabled ? 'disable' : 'pairing') }),
        h('span', { className: 'ab-badge mine' }, 'mobile')),
      desc: '手机和电脑连同一个局域网。手机共用她现有的会话和记忆，回复也会发到原来的 QQ 聊天。',
    },
      h('p', null, '用手机相机或 App 扫都行，浏览器打开后可以「添加到主屏幕」。'),
      h('p', null, s.running ? '手机接口已开启' : '手机接口未开启', ' · ', s.chats || 0, ' 个现有聊天'),
      s.error ? h('div', { className: 'ab-note err' }, s.error) : null,
      h(Btn, { kind: 'primary', disabled: busy, onClick: () => act('pairing') }, s.running ? '刷新配对二维码' : '开启并生成二维码'),
      s.options.enabled ? h(Btn, { disabled: busy, onClick: () => act('disable') }, '关闭手机入口') : null,
      pair ? h('div', { style: { marginTop: 12 } },
        expired ? h('p', null, '配对码已过期，请刷新二维码。') : h('img', { src: pair.qr, alt: '手机配对二维码', width: 245, height: 245 }),
        h('p', null, '地址：', h('code', { style: { userSelect: 'all', overflowWrap: 'anywhere' } }, pair.url)),
        h('p', null, '配对码：', h('code', { style: { userSelect: 'all' } }, pair.code)),
        h('p', { className: 'ab-small ab-muted' }, '一次有效，', Math.max(0, Math.ceil((pair.expiresAt - clock) / 1000)), ' 秒后过期。刷新会使旧码失效。'),
        h('details', null, h('summary', null, '二维码文字（可复制到另一块屏幕扫码）'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all' } }, pair.payload))) : null,
      h('p', { className: 'ab-note' }, '当前 App 的手输“保存”不会发起配对，请使用扫码。若提示不允许 HTTP，需要配置手机信任的 HTTPS 证书或 HTTPS 反代；自签名证书不会自动受信任。'),
      !s.chats ? h('p', null, '还没有聊天：先从 QQ 给她发一句话建立原会话，再刷新 App。') : null),
    h(Card, { title: '已配对设备', desc: '每台手机拥有主人身份。丢失或不再使用时立即撤销；撤销会同时断开事件连接。' },
      !(s.devices || []).length ? h('p', null, '还没有配对设备') : (s.devices || []).map((d) => h('div', { key: d.id, className: 'ab-row' },
        h('div', { style: { flex: 1 } }, h('b', null, d.name), h('div', { className: 'ab-small ab-muted' }, new Date(d.pairedAt).toLocaleString(), ' · ', d.address, ' · ', d.id.slice(-8))),
        h(Btn, { disabled: busy, onClick: () => act('revoke', { id: d.id }) }, '撤销')))),
    h(Card, { title: '连接地址与远程访问', desc: '默认只允许局域网。更改以下选项后点“应用连接设置”；已配对手机的地址也要相应更新。' },
      field('port', '监听端口', '默认 32180，需允许电脑防火墙的局域网入站连接。', 'number'),
      field('publicUrl', '手机可达地址', '留空自动选择局域网地址；多网卡时可从下面的地址复制。'),
      h('p', { className: 'ab-small', style: { overflowWrap: 'anywhere' } }, (s.addresses || []).join(' / ')),
      field('tlsCert', 'TLS 证书路径（.crt）', '电脑上的 PEM 证书绝对路径，例如 C:\\Aurabot\\certs\\电脑名.tailnet.ts.net.crt。证书需受手机信任并匹配手机可达地址中的域名。'),
      field('tlsKey', 'TLS 私钥路径（.key）', '配套私钥的电脑绝对路径；与证书同时填写。应用前会检查是否可读和匹配。'),
      h('p', { className: 'ab-note' }, '网页录音、相机和系统通知需要可信 HTTPS。HTTP 仍可聊天，会明确提示开启证书。证书续期后重新应用连接设置，重新加载证书。'),
      h('details', null, h('summary', null, '推荐：使用 Tailscale 证书开启 HTTPS'),
        h('ol', null,
          h('li', null, '电脑与手机安装 Tailscale，加入同一 tailnet 并保持连接。在 Tailscale 管理台 DNS 中启用 MagicDNS 和 HTTPS certificates。'),
          h('li', null, '在电脑的证书目录打开终端，运行 ', h('code', null, 'tailscale cert 电脑名.tailnet名.ts.net'), '，得到同名 .crt 与 .key。域名请复制电脑实际的完整 Tailscale 域名。'),
          h('li', null, '将生成文件的绝对路径分别填入上方证书和私钥框，手机可达地址填 ', h('code', null, 'https://电脑名.tailnet名.ts.net:32180'), '（端口与上方监听端口一致）。'),
          h('li', null, 'Tailscale 的 100.x 地址不属于默认局域网范围，需要开启下方“允许远程访问”并确认，再点“应用连接设置”。防火墙只放行所需的 Tailscale 网络/设备即可，无需公网端口映射。'),
          h('li', null, '刷新配对二维码，用手机重新打开 HTTPS 地址并配对。允许麦克风和通知；iPhone / iPad 的通知需先“添加到主屏幕”后打开。'),
          h('li', null, '证书到期前重新运行 tailscale cert 续期，保存到相同路径后点“应用连接设置”重载证书。请保护 .key，不要粘贴证书或私钥内容到网页。'))),
      h(Row, { label: '允许远程访问', hint: '公网/反代来源默认拒绝；即使有 token 也一样。' }, h(Switch, { on: form.remoteAccess === true, disabled: busy, onChange: (v) => { setForm({ ...form, remoteAccess: v }); setRisk(false) } })),
      form.remoteAccess ? h('div', { className: 'ab-note err' },
        h('p', null, '风险：手机令牌等同主人权限，泄漏后可读取聊天、指挥她操作电脑。远程必须使用可信 HTTPS/WSS，并保护反向代理和电脑。'),
        h('label', null, h('input', { type: 'checkbox', checked: risk, onChange: (e) => setRisk(e.target.checked) }), ' 我了解风险，仍允许远程访问')) : null,
      h(Btn, { disabled: busy || (form.remoteAccess && !risk), onClick: async () => { const r = await act('configure', { ...form, port: Number(form.port), confirmRisk: risk }); if (r && r.options) setForm(r.options) } }, '应用连接设置')))
}
