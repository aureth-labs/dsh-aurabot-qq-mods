/* global React, h, ui, call, toast, confirm, window */
const { useState, useEffect, useRef } = React;

const LABEL = { support: ['支持', 'ab-note'], degrade: ['降级', 'ab-muted'], unsupported: ['不可用', 'ab-small'] };

function Card({ title, children, aside }) {
  return h(ui.Card, { title },
    aside ? h('div', { className: 'ab-muted ab-small' }, aside) : null,
    children,
  );
}
function Btn({ onClick, children, disabled }) { return h(ui.Btn, { onClick, disabled }, children); }

return function RoostBridgePanel({ settings, toast: toastFn }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [cred, setCred] = useState({ appId: '', appSecret: '', selfUin: '', token: '', botToken: '', accessKey: '' });
  const [log, setLog] = useState([]);
  const [diag, setDiag] = useState(null);
  const [qr, setQr] = useState(null);       // { taskId, qrUrl, qrSvg, status }
  const [panelUrls, setPanelUrls] = useState(null);
  const [qrBusy, setQrBusy] = useState(false);
  const qrTimer = useRef(null);
  const qrSettled = useRef(false);
  const notify = toastFn || toast;
  useEffect(() => () => { if (qrTimer.current) clearInterval(qrTimer.current); }, []);

  async function refresh() {
    try {
      const r = await call('/status');
      if (r.ok) {
        setStatus(r);
        // 已持久化的机器人 QQ 号回填到输入框（仅当前为空时，不覆盖正在输入的）
        if (r.state?.selfUin) setCred((c) => ({ ...c, selfUin: c.selfUin || r.state.selfUin }));
        if (r.roostAlive) call('/panel-urls').then((u) => setPanelUrls(u.ok ? u : null)).catch(() => {});
        else setPanelUrls(null);
      } else notify(r.error || '读状态失败');
    } catch (e) { notify(String(e.message || e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function act(path, body, label, onOK) {
    setBusy(path);
    try {
      const r = await call(path, body || {});
      if (r.ok) {
        notify(r.message || `${label}完成`);
        if (r.message) setLog((p) => [...p, r.message].slice(-20));
        onOK?.(r);
      } else {
        notify(r.error || `${label}失败`);
        if (r.error) setLog((p) => [...p, '错误：' + r.error].slice(-20));
      }
      await refresh();
      return r;
    } catch (e) { notify(String(e.message || e)); await refresh(); return { ok: false }; }
    finally { setBusy(''); }
  }

  async function qrStart() {
    qrSettled.current = false;
    setQrBusy(true);
    try {
      const r = await call('/qr/start', {});
      if (!r.ok) { notify(r.error || '生成二维码失败'); setQrBusy(false); return; }
      const deadline = Date.now() + 10 * 60 * 1000; // 官方绑定任务 10 分钟
      setQr({ taskId: r.taskId, qrUrl: r.qrUrl, qrSvg: r.qrSvg, status: 'pending' });
      setLog((p) => [...p, '二维码已生成，10 分钟内有效'].slice(-20));
      if (qrTimer.current) clearInterval(qrTimer.current);
      qrTimer.current = setInterval(async () => {
        if (qrSettled.current) return;
        if (Date.now() > deadline) {
          qrSettled.current = true;
          clearInterval(qrTimer.current); qrTimer.current = null;
          setQrBusy(false);
          setQr((q) => q ? { ...q, status: 'expired' } : q);
          notify('二维码已过期，请重新生成');
          return;
        }
        try {
          const p = await call('/qr/poll', { taskId: r.taskId });
          if (qrSettled.current) return; // 在途 poll 回来时已经结束，不能再触发一次 finalize
          if (p.status === 'done') {
            qrSettled.current = true;
            clearInterval(qrTimer.current); qrTimer.current = null;
            setQr({ taskId: r.taskId, qrUrl: '', qrSvg: '', status: p.ok ? 'done' : 'error' });
            if (!p.ok) {
              setQrBusy(false);
              notify(p.error || '扫码成功但凭证没拿到，请重新生成二维码');
              if (p.error) setLog((prev) => [...prev, '错误：' + p.error].slice(-20));
              await refresh();
              return;
            }
            setLog((prev) => [...prev, p.message || '扫码成功，正在写入凭证'].slice(-20));
            notify(p.message || '扫码成功，正在写入凭证并重启 roost…');
            try {
              const fin = await call('/qr/finalize', {});
              const msg = fin.ok ? fin.message : (fin.error || '写入凭证失败');
              notify(msg);
              setLog((prev) => [...prev, msg].slice(-20));
            } catch (e) {
              notify(String(e.message || e));
              setLog((prev) => [...prev, String(e.message || e)].slice(-20));
            }
            setQr(null);
            setQrBusy(false);
            await refresh();
          } else if (p.status === 'expired' || p.status === 'error') {
            qrSettled.current = true;
            clearInterval(qrTimer.current); qrTimer.current = null; setQrBusy(false);
            setQr((q) => q ? { ...q, status: p.status } : q);
            notify(p.message || p.error || '二维码失效，请重新生成');
            await refresh();
          }
        } catch (_) { /* 轮询抖动，下次再来 */ }
      }, 2000);
    } catch (e) { notify(String(e.message || e)); setQrBusy(false); }
  }

  const steps = status?.steps || [];
  const doneCount = steps.filter((s) => s.done).length;
  const caveats = status?.caveats || [];
  const caps = status?.capabilities || [];
  const why = status?.whyRoost || [];
  const st = status?.state || {};
  const compat = status?.compat || { support: 0, degrade: 0, unsupported: 0 };

  return h('div', { className: 'roost-bridge' },
    h('p', { className: 'ab-note' },
      '把大肥鱼接到 QQ 官方机器人：roost 负责官方接口，它的 OneBot 兼容层让大肥鱼几乎零改动连上来。',
      h('br'),
      'roost 用模块自带那份，启动前整份复制到数据目录（不联网、不改框架源码）。启动后点「生成二维码」，手机 QQ 扫码就能建机器人——不用自己去开放平台抄 AppID/AppSecret。',
    ),

    status?.needRefill?.length ? h(Card, { title: '重启后要重填' },
      h('p', { className: 'ab-muted ab-small' }, '这些内容只存内存，重启后按实际情况重填；如果 roost 已经在跑、配置也好了，可不用重填：'),
      ...status.needRefill.map((m, i) => h('div', { key: i, className: 'ab-small' }, `· ${m}`)),
    ) : null,

    h(Card, { title: '进度', aside: `${doneCount}/${steps.length} 步` },
      ...steps.map((s) => h('div', { key: s.id, className: 'ab-small', style: { marginBottom: 6 } },
        h('span', null, s.done ? '✓ ' : '· '),
        h('span', { style: { opacity: s.done ? 0.65 : 1 } }, s.label),
        h('div', { className: 'ab-muted ab-small', style: { paddingLeft: 16 } }, s.hint),
      )),
      h('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Btn, { onClick: refresh, disabled: Boolean(busy) }, '刷新'),
        h(Btn, { onClick: () => act('/diagnose', {}, '诊断', (x) => setDiag(x)), disabled: Boolean(busy) }, '一键诊断'),
      ),
    ),

    diag ? h(Card, { title: '诊断结果' },
      ...diag.checks.map((c, i) => h('div', { key: i, className: 'ab-small', style: { marginBottom: 4 } },
        h('span', null, c.ok ? '✓ ' : '× '), c.label,
        h('span', { className: 'ab-muted' }, ' — ' + c.detail),
      )),
    ) : null,

    h(Card, { title: '1 · roost 就绪（复制到数据目录）' },
      h('p', { className: 'ab-muted ab-small' },
        '模块自带 roost（含 ws / silk-wasm）会整份复制到数据目录再运行，不联网、不改框架源码。这样她写 ports.json、建插件目录都不会碰模块文件夹，也就不会触发反复热重载。运行副本：' + (status?.codeDir || ''),
      ),
      h(Btn, { onClick: () => act('/install', {}, '就绪检查'), disabled: Boolean(busy) },
        busy === '/install' ? '检查中…' : '检查 / 准备就绪',
      ),
    ),

    h(Card, { title: '2 · 启动 roost', aside: status?.roostAlive ? '运行中' : '未运行' },
      h('p', { className: 'ab-muted ab-small' },
        '先启动 roost，扫码接口由它提供。面板端口被占会自动顺延，模块会自动找到真实端口，不用你改配置。',
      ),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Btn, {
          onClick: () => act(status?.roostAlive ? '/restart' : '/start', {}, status?.roostAlive ? '重启' : '启动'),
          disabled: Boolean(busy),
        }, busy === '/restart' ? '重启中…' : busy === '/start' ? '启动中…' : (status?.roostAlive ? '重启 roost' : '启动 roost')),
        status?.roostAlive ? h(Btn, {
          onClick: () => {
            if (typeof confirm === 'function' && !confirm('确定关闭 roost 吗？关闭后大肥鱼会断开官方机器人，直到再次启动。')) return;
            return act('/stop', {}, '关闭 roost');
          },
          disabled: Boolean(busy),
        }, busy === '/stop' ? '关闭中…' : '关闭 roost') : null,
      ),
      h('p', { className: 'ab-muted ab-small' },
        '自动拉起：' + (status?.autoStart ? '已开' : '关闭（默认）') + '。在下方「设置」里可打开；打开后只在「已配置完成 + 网关指向兼容层 + roost 没在跑」时自动起一次。',
      ),
      st.autoStartResult ? h('p', { className: 'ab-note' }, '上次自动拉起：' + st.autoStartResult) : null,
    ),

    h(Card, { title: '3 · 扫码建机器人' },
      h('p', { className: 'ab-muted ab-small' },
        '点生成二维码 → 用手机 QQ 扫 → 在手机上确认。凭证由官方直接给到 roost（模块不接触 bindKey）。成功后模块会先关闭 roost、把凭证写进配置、再重新启动（约十几秒，面板会短暂打不开）；写完才去做后面的兼容层配置。二维码 10 分钟有效。',
      ),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Btn, { onClick: qrStart, disabled: qrBusy || Boolean(busy) || !status?.roostAlive },
          qrBusy ? '扫码中…' : (qr ? '重新生成二维码' : '生成二维码'),
        ),
      ),
      !status?.roostAlive ? h('p', { className: 'ab-note' }, '先点上面「启动 roost」，扫码接口要它提供。') : null,
      qr?.qrSvg ? h('div', {
        className: 'ab-note',
        style: { marginTop: 10, padding: 12, background: '#fff', borderRadius: 8, display: 'flex', justifyContent: 'center' },
        dangerouslySetInnerHTML: { __html: qr.qrSvg },
      }) : null,
      qr?.qrUrl && !qr.qrSvg ? h('p', { className: 'ab-small', style: { marginTop: 10, wordBreak: 'break-all' } }, '扫码链接：' + qr.qrUrl) : null,
      qr?.status === 'expired' ? h('p', { className: 'ab-note' }, '二维码已过期，点「重新生成二维码」。') : null,
      qr?.status === 'pending' ? h('p', { className: 'ab-muted ab-small' }, '等待扫码…（每 2 秒自动查一次）') : null,
      st.appIdSet || st.botWritten ? h('p', { className: 'ab-note' },
        st.botWritten
          ? `凭证已写入 roost（AppID ${st.appId || '已写入'}），机器人正在上线。`
          : `已拿到 AppID ${st.appId || '—'}，但还没写进 roost；完成扫码后会自动写入并重启。`
      ) : null,

      h('details', { style: { marginTop: 10 } },
        h('summary', { className: 'ab-small' }, '手填 AppID/AppSecret（扫码失败时用）'),
        h('div', { style: { marginTop: 8 } },
          h('div', { className: 'ab-row' },
            h('input', { className: 'ab-input', placeholder: 'AppID', value: cred.appId, onChange: (e) => setCred({ ...cred, appId: e.target.value }) }),
            h('input', { className: 'ab-input', placeholder: 'AppSecret', type: 'password', value: cred.appSecret, onChange: (e) => setCred({ ...cred, appSecret: e.target.value }) }),
          ),
          h('div', { className: 'ab-row', style: { marginTop: 8 } },
            h('input', { className: 'ab-input', placeholder: '机器人 QQ 号', value: cred.selfUin, onChange: (e) => setCred({ ...cred, selfUin: e.target.value }) }),
            h('input', { className: 'ab-input', placeholder: '兼容层 token（留空自动生成）', type: 'password', value: cred.token, onChange: (e) => setCred({ ...cred, token: e.target.value }) }),
          ),
          h('div', { className: 'ab-row', style: { marginTop: 8 } },
            h('input', { className: 'ab-input', placeholder: '机器人 Token（可选）', type: 'password', value: cred.botToken, onChange: (e) => setCred({ ...cred, botToken: e.target.value }) }),
            h('input', { className: 'ab-input', placeholder: 'roost 面板 accessKey（没设留空）', type: 'password', value: cred.accessKey, onChange: (e) => setCred({ ...cred, accessKey: e.target.value }) }),
          ),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Btn, { onClick: () => act('/credentials', cred, '保存凭证'), disabled: Boolean(busy) }, '保存凭证'),
            h(Btn, { onClick: () => act('/create-bot', {}, '写机器人配置'), disabled: Boolean(busy) }, '写进 roost'),
          ),
          h('p', { className: 'ab-muted ab-small' },
            `AppID ${st.appIdSet ? '已填' : '未填'} / 密钥 ${st.appSecretSet ? '已暂存' : '未填'} / accessKey ${st.accessKeySet ? '已暂存' : '未设'} / token ${st.tokenSet ? '已暂存' : '未生成'}`,
          ),
        ),
      ),
    ),

    h(Card, { title: '4 · 接入前要做的准备（按顺序，别急着接入）' },
      h('p', { className: 'ab-muted ab-small' },
        '这几步在 roost 面板里做，做完再点下面的「接入大肥鱼」。点按钮会打开对应页面。',
      ),
      h('div', { style: { marginTop: 10 } },
        ...(status?.manualSteps || []).map((m, i) => h('div', { key: i, className: 'ab-small', style: { marginBottom: 4 } }, `${i + 1}. ${m}`)),
      ),
      h('p', { className: 'ab-muted ab-small', style: { marginTop: 8 } },
        '要改机器人头像 / 昵称 / 简介：这些走开放平台后台，不是 OneBot 能力。先在 roost 面板「开放平台」页扫码登录开发者后台，否则会报「还没登录开放平台」。扫码建机器人只给 AppID/AppSecret，不等于开放平台登录态。',
      ),
      panelUrls?.links?.length ? h('div', { style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } },
        ...panelUrls.links.map((l) => h(Btn, {
          key: l.url,
          onClick: () => { try { window.open(l.url, '_blank', 'noopener'); } catch (e) { notify(String(e.message || e)); } },
          title: l.desc,
        }, '打开 · ' + l.label)),
      ) : h('p', { className: 'ab-muted ab-small', style: { marginTop: 10 } }, '启动 roost 后这里会出现快捷按钮（打开 roost 面板对应页面）。'),
    ),

    h(Card, { title: '5 · 配置兼容层并接入' },
      h('p', { className: 'ab-note' },
        '先填机器人 QQ 号再配置。官方接口不提供这个号——去 QQ 机器人资料里找（或看你扫码建的那个机器人）。不填兼容层起不来。',
      ),
      h('div', { className: 'ab-row', style: { marginTop: 8 } },
        h('input', {
          className: 'ab-input', placeholder: '机器人 QQ 号（5–12 位数字）',
          value: cred.selfUin,
          onChange: (e) => setCred({ ...cred, selfUin: e.target.value.replace(/\D/g, '') }),
        }),
        h(Btn, {
          onClick: () => act('/credentials', { selfUin: cred.selfUin }, '保存机器人 QQ 号'),
          disabled: Boolean(busy) || !cred.selfUin,
        }, '保存'),
      ),
      st.selfUin ? h('p', { className: 'ab-muted ab-small' }, '机器人 QQ 号已保存：' + st.selfUin) : null,
      status?.aurabot && !status.aurabot.qqMatched && (status.aurabot.botQQ || status.aurabot.selfUin)
        ? h('p', { className: 'ab-note', style: { marginTop: 6 } },
          `注意：aurabot 里的机器人 QQ 号还是 ${status.aurabot.botQQ || '空'}，模块里是 ${status.aurabot.selfUin || '空'}。点「接入大肥鱼」会同步；不同步的话 aurabot 核对登录号失败，会连上后立刻断开。截图那张卡片「用什么接 QQ → 接我已有的 OneBot 机器人」本身就是 gateway=onebot，接入时会一起选好；这里说的是它下面的「机器人 QQ 号」输入框。`)
        : null,
      status?.aurabot && (!status.aurabot.enabled || status.aurabot.dryRun)
        ? h('p', { className: 'ab-muted ab-small', style: { marginTop: 6 } },
          `aurabot 当前：总开关${status.aurabot.enabled ? '已开' : '关着'}、试运行${status.aurabot.dryRun ? '开着（消息只截不下发）' : '已关'}。接入后还不通就去 aurabot 面板确认这两项。`)
        : null,
      status?.aurabot ? h('p', { className: 'ab-muted ab-small', style: { marginTop: 6 } },
        `空间能力：日记${status.aurabot.diary ? '开' : '关'}、互动${status.aurabot.qzoneSocial ? '开' : '关'}。它们依赖 QQ 空间私有协议，接官方机器人时会暂关、退回原网关时还原。`)
        : null,
      h('p', { className: 'ab-note', style: { marginTop: 8 } },
        '想让大肥鱼在群里认出谁是谁、换机器人后还接得上旧记忆？去 roost 面板「身份」页把 QQ 号 / 群号和 openid 绑定。更省事的办法：先在 roost 面板「通知」页配好 SMTP 邮箱，让常用用户自己发 /绑定QQ <QQ号>（验证码发到「QQ号@qq.com」），再发 /QQ验证码 <6位码> 就绑好了；主人也可用 /绑定群号、/绑定成员 代绑。1.1.5 起独占模式也放行这些绑定命令。不绑定也能聊，只是群友多是合成号、记忆对不上真号。',
      ),
      h('p', { className: 'ab-note', style: { marginTop: 10 } },
        h('b', null, '建议顺序：先别急着点「接入大肥鱼」。'),
        ' 让 roost 先跑一会儿、群里正常聊天（此时大肥鱼还连着旧网关，不受影响）→ 去 roost 面板「身份」页会看到未识别的常用用户 → 按上面的方法把他们的 QQ 号绑定好 → 最后再接入。这样切过来记忆直接对上真号，不用事后补绑、也不会把旧记忆串成合成号。',
      ),
      h('p', { className: 'ab-muted ab-small', style: { marginTop: 8 } },
        '开 OneBot 兼容层 → 把大肥鱼的网关指过去。同一个端口同时提供 WS（收消息）和 HTTP（发接口），可以一起用；ws 已随内置 roost 装好。模式在当前设置里选（推荐独占）。',
      ),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Btn, { onClick: () => act('/bridge-status', {}, '检查兼容层'), disabled: Boolean(busy) }, '检查兼容层'),
        h(Btn, { onClick: () => act('/configure', {}, '配置'), disabled: Boolean(busy) }, '一键配置'),
        h(Btn, {
          onClick: () => {
            if (typeof confirm === 'function' && !confirm('建议先让 roost 收一批消息、在「身份」页绑定常用用户的 QQ 号，再接入——这样记忆直接对上真号。确定现在就接入吗？')) return;
            return act('/link', {}, '接入');
          },
          disabled: Boolean(busy),
        }, '接入大肥鱼'),
      ),
      st.port ? h('div', { className: 'ab-note', style: { marginTop: 10 } },
        h('div', null, `OneBot 兼容层端口：${st.port}（这不是 WebUI 面板端口）`),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, `收消息 WS：ws://127.0.0.1:${st.port}`),
        h('div', { className: 'ab-small ab-muted' }, `发接口 HTTP：http://127.0.0.1:${st.port}（同一端口，两个可以同时用）`),
      ) : null,
    ),

    h(Card, { title: '为什么用 roost（而不是裸官方接口）' },
      ...why.map((w, i) => h('div', { key: i, style: { marginBottom: 10 } },
        h('div', { className: 'ab-small' }, `${i + 1}. ${w.title}`),
        h('div', { className: 'ab-muted ab-small', style: { paddingLeft: 16 } }, w.body),
      )),
    ),

    h(Card, { title: '官方机器人限制与兼容说明' },
      h('p', { className: 'ab-note' },
        `支持 ${compat.support} 项 / 降级 ${compat.degrade} 项 / 不可用 ${compat.unsupported} 项`,
      ),
      ...caveats.map((c, i) => h('div', { key: i, style: { marginBottom: 10 } },
        h('div', { className: 'ab-small' }, `${i + 1}. ${c.title}`),
        h('div', { className: 'ab-muted ab-small', style: { paddingLeft: 16 } }, c.body),
      )),
      h('details', null,
        h('summary', { className: 'ab-small' }, '展开完整能力表'),
        h('div', { style: { marginTop: 8 } },
          ...caps.map((c) => h('div', { key: c.action, className: 'ab-small', style: { display: 'flex', gap: 8, marginBottom: 4 } },
            h('code', null, c.action),
            h('span', { className: LABEL[c.avail]?.[1] || 'ab-small' }, LABEL[c.avail]?.[0] || c.avail),
            h('span', { className: 'ab-muted' }, c.onAurabot),
          )),
        ),
      ),
    ),

    h(Card, { title: '退出与操作记录' },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Btn, { onClick: () => act('/unlink', {}, '恢复'), disabled: Boolean(busy) }, '一键改回原网关'),
      ),
      h('p', { className: 'ab-muted ab-small' }, '改回后重启一次 DSH 生效；roost 本身不会被卸载。'),
      h('p', { className: 'ab-note', style: { marginTop: 8 } },
        '停用 / 卸载本模块前，请先点「一键改回原网关」。模块被停用时会自动尝试恢复网关（热重载不会误触发），但 DSH 进程直接退出的场景无法保证，手动点一次最稳。',
      ),
      log.length ? h('div', null, ...log.map((l, i) => h('div', { key: i, className: 'ab-small ab-muted' }, l)))
        : h('div', { className: 'ab-muted ab-small' }, '还没有操作'),
    ),

    h('p', { className: 'ab-muted ab-small' },
      '所有操作都在上面这个页面完成：启动 roost → 扫码 → 接入前准备 → 配置兼容层 → 接入，最后重启一次 DSH 生效。',
    ),
  );
};
