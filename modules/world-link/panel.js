// world-link / panel.js
// 面板：看连接状态、世界感知、最近做了什么；手动重连 / 断开 / 让她想一次 / 发一条建议

const { useState, useEffect } = React;

return function WorldLinkPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null);
  const [sug, setSug] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const r = await call('/status');
      setSt(r);
    } catch (e) {
      setSt({ ok: false, status: 'error', error: String(e && e.message || e) });
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const doIt = async (path, body, okText) => {
    setBusy(true);
    try {
      const r = await call(path, body);
      toast((r && (r.message || okText)) || 'ok');
      await refresh();
    } catch (e) {
      toast('失败：' + (e && e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const dot = (s) => (s === 'connected' ? '#2ecc71' : (s === 'connecting' ? '#f1c40f' : '#e74c3c'));

  return h(React.Fragment, null,

    h(ui.Card, { title: '开放世界' },
      h(ui.Row, {
        label: '连接',
      },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: dot((st && st.status) || 'off'), display: 'inline-block' } }),
          h('span', { className: 'ab-small' }, (st && st.status) || 'off'),
        ),
      ),
      st && st.error ? h('div', { className: 'ab-note', style: { color: '#c0392b' } }, st.error) : null,
      st && st.lastBlocked ? h('div', { className: 'ab-note', style: { color: '#d68910' } }, '自主行动暂未触发：' + st.lastBlocked) : null,
      h(ui.Row, { label: '服务端' }, h('span', { className: 'ab-muted ab-small' }, settings.wsUrl || '')),
      h(ui.Row, { label: '名字 / 档案' }, h('span', { className: 'ab-muted ab-small' }, (st && st.nickname || settings.nickname || '') + ' / ' + ((st && st.profileId) || '（首次上线自动建档）'))),
      h(ui.Row, { label: '世界 tick' }, h('span', { className: 'ab-muted ab-small' }, String((st && st.tick) || 0))),
      h(ui.Row, { label: '上一次' }, h('span', { className: 'ab-small' }, (st && st.lastDecision) || '还没动过')),

      h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
        h(ui.Btn, { onClick: () => doIt('/reconnect', undefined, '已重新连接'), disabled: busy }, '重新连接'),
        h(ui.Btn, { onClick: () => doIt('/disconnect', undefined, '已断开'), disabled: busy }, '断开'),
        h(ui.Btn, { onClick: () => doIt('/think', {}, '让她想了一次'), disabled: busy }, '让她现在想一次'),
      ),
    ),

    h(ui.Card, { title: '她此刻看到的' },
      h('pre', {
        style: {
          whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6, margin: 0,
          background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 8,
          maxHeight: 260, overflow: 'auto',
        },
      }, (st && st.summary) || '（还没收到世界感知——服务端开了吗？）'),
    ),

    h(ui.Card, { title: '给她发一条建议' },
      h('textarea', {
        className: 'ab-input',
        value: sug,
        rows: 2,
        placeholder: '比如：去湖边看看、去跟软软说话、别老站着',
        onInput: (e) => setSug(e.target.value),
        style: { width: '100%' },
      }),
      h('div', { style: { marginTop: 8 } },
        h(ui.Btn, {
          disabled: busy || !sug.trim(),
          onClick: async () => {
            await doIt('/think', { text: sug.trim() }, '建议已交给她');
            setSug('');
          },
        }, '交给她决定'),
      ),
      h('div', { className: 'ab-note' }, '建议不是命令：她可以照做，也可以不去做。网页里的「建议」走的是同一条路。'),
    ),

    h(ui.Card, { title: '最近' },
      st && st.history && st.history.length
        ? h('div', null, st.history.map((it, i) => h(ui.Row, { key: i, label: it.kind },
          h('span', { className: 'ab-small' }, it.decision || ''))))
        : h(ui.Empty, null, '还没有动作记录'),
      st && st.events && st.events.length
        ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'ab-muted ab-small', style: { marginBottom: 4 } }, '世界里的动静'),
          st.events.map((e, i) => h('div', { key: i, className: 'ab-small ab-muted' }, '· ' + e.text)))
        : null,
    ),
  );
};
