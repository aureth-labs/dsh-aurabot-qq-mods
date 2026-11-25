
return function TellOwnerPanel(props) {
  var toast = props.toast;
  var rowsState = React.useState(null);
  var rows = rowsState[0];
  var setRows = rowsState[1];
  var perState = React.useState(2);
  var perUser = perState[0];
  var setPerUser = perState[1];
  var busyState = React.useState('');
  var busy = busyState[0];
  var setBusy = busyState[1];
  var savingState = React.useState(false);
  var saving = savingState[0];
  var setSaving = savingState[1];

  function load() {
    call('/board')
      .then(function (r) {
        setRows((r && r.rows) || []);
        setPerUser(typeof (r && r.perUserPerDay) === 'number' ? r.perUserPerDay : 2);
      })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  React.useEffect(function () { load(); }, []);

  function saveLimit(n) {
    setPerUser(n);
    setSaving(true);
    call('/set-limit', { perUserPerDay: n })
      .then(function (r) {
        toast((r && r.message) || (r && r.ok ? '已保存' : '保存失败'), r && r.ok ? 'ok' : 'err');
        if (r && typeof r.perUserPerDay === 'number') setPerUser(r.perUserPerDay);
        setSaving(false);
      })
      .catch(function (e) { toast(e.message, 'err'); setSaving(false); });
  }

  function doReset(userId) {
    setBusy(userId);
    call('/reset', { userId: userId })
      .then(function (r) {
        toast((r && r.message) || (r && r.ok ? '已重置' : '重置失败'), r && r.ok ? 'ok' : 'err');
        load();
        setBusy('');
      })
      .catch(function (e) { toast(e.message, 'err'); setBusy(''); });
  }

  var thStyle = { padding: '8px 6px', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap', textAlign: 'left' };
  var tdStyle = { padding: '8px 6px', verticalAlign: 'top', maxWidth: 320 };

  var limitRow = h(ui.Row, {
    label: '每个用户每天最多几条',
    hint: '按用户算（不分群、不分私聊），当天超过就不让再提交。拖动滑块调整（1~10，默认 2）',
  },
    h(ui.Range, {
      min: 1, max: 10, step: 1, value: perUser,
      onChange: function (v) { saveLimit(v); },
      fmt: function (v) { return v + ' 条'; },
    }),
    saving ? h('span', { className: 'ab-small ab-muted' }, ' 保存中…') : null);

  var limitCard = h(ui.Card, { title: '每日限额', desc: '限制每个人每天能给主人带几句话。' }, limitRow);

  var title = '反馈次数看板';
  var desc = '按发起人汇总：谁、在哪个群、反馈了什么主题、今天已经反馈几次。每人每天上限 ' +
    (perUser > 0 ? perUser + ' 条' : '不限') + '；需要给某人再放额度，点对应行的「重置今日」。';

  var body;
  if (!rows) {
    body = h(ui.Empty, { icon: '⏳', text: '加载中…' });
  } else if (!rows.length) {
    body = h(ui.Empty, { icon: '📋', text: '还没有任何反馈记录' });
  } else {
    var headerCells = ['发起者名称（ID）', '群组名称 / ID', '主题', '今日反馈次数', '操作'].map(function (c) {
      return h('th', { key: c, style: thStyle }, c);
    });

    var trs = rows.map(function (r) {
      var nameCell = h('td', { style: tdStyle },
        h('b', null, r.nickname || '（未知昵称）'),
        h('span', { className: 'ab-small ab-muted' }, ' (' + r.userId + ')'));

      var groupCell = h('td', { style: tdStyle },
        h('span', { className: 'ab-small', style: { wordBreak: 'break-all' } }, r.groups || '—'));

      var topicCell = h('td', { style: tdStyle },
        h('span', { className: 'ab-small' }, r.topics || '—'));

      var over = perUser > 0 && r.todayCount >= perUser;
      var countCell = h('td', { style: { padding: '8px 6px', verticalAlign: 'top', whiteSpace: 'nowrap' } },
        h('b', { style: { color: over ? 'var(--ab-danger, #c62828)' : '#2e7d32' } }, String(r.todayCount)),
        h('span', { className: 'ab-small ab-muted' }, ' / 累计 ' + r.totalCount));

      var resetBtn = h(ui.Btn, {
        small: true,
        disabled: busy === r.userId || r.todayCount === 0,
        onClick: function () { doReset(r.userId); },
      }, busy === r.userId ? '重置中…' : '重置今日');
      var opCell = h('td', { style: { padding: '8px 6px', verticalAlign: 'top', whiteSpace: 'nowrap' } }, resetBtn);

      return h('tr', { key: r.userId, style: { borderTop: '1px solid #eee' } },
        nameCell, groupCell, topicCell, countCell, opCell);
    });

    body = h('div', null,
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, '共 ' + rows.length + ' 位发起者'),
      h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
        h('thead', null, h('tr', null, headerCells)),
        h('tbody', null, trs)));
  }

  return h('div', { className: 'ab-grid' },
    limitCard,
    h(ui.Card, { title: title, desc: desc }, body));
};
