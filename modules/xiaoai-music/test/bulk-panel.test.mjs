import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const panelSource = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
const entry = (id, title, sourceId, fields = {}) => ({
  id: id.repeat(64), title, sourceId, artists: '测试歌手', mode: 'cover', voice: '旧音色',
  duration: 120, pitch: 0, available: true, directoryIds: ['primary'], ...fields,
});
const first = entry('a', '童谣甲', '11', { pitch: 2 });
const second = entry('b', '童谣乙', '22', { pitch: -3 });
const other = entry('c', '另一首', '33', { artists: '另一位歌手', directoryIds: ['external'], readOnly: true });
const original = entry('d', first.title, first.sourceId, { mode: 'original', voice: '原曲' });
const initialLists = [
  { id: 'source', name: '妈妈流行歌曲', ids: [first.id, second.id, other.id] },
  { id: 'target', name: '目标歌单', ids: [first.id] },
];
const settle = () => new Promise(setImmediate);

async function harness(override = {}) {
  const calls = [], timers = [], slots = [], effects = [];
  let entries = override.entries || [first, second, other, original];
  let playlists = structuredClone(initialLists);
  let jobs = [];
  let nodes, cursor;
  const status = () => ({ ok: true, playlists, dailyPlaylist: override.dailyPlaylist,
    songs: { entries, jobs, directories: [{ id: 'primary', path: '主目录' }, { id: 'external', path: '外部目录' }] } });
  const React = {
    Fragment: 'Fragment',
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) {
      const i = cursor++;
      return slots[i] ??= { current: initial };
    },
    useEffect(effect, deps) {
      const i = cursor++;
      const old = slots[i];
      if (old?.length === deps.length && deps.every((value, j) => Object.is(old[j], value))) return;
      slots[i] = deps;
      effects.push(effect);
    },
  };
  const call = async (path, body) => {
    calls.push({ path, body });
    if (override[path]) return override[path](body, status, value => { jobs = value; });
    if (path === '/status' || path === '/songs/check') return status();
    if (path === '/settings/options') return { ok: true, voices: { singing: { id: '长音色名称测试', label: '长音色名称测试', configured: true }, options: [
      { id: '长音色名称测试', label: '长音色名称测试' },
      { id: 'local:example-voice', label: '示例音色（本地整曲）' },
    ] } };
    if (path === '/reminders') return { ok: true, reminders: [] };
    if (path === '/songs/delete') {
      entries = entries.filter(song => song.id !== body.id);
      playlists = playlists.map(list => ({ ...list, ids: list.ids.filter(id => id !== body.id) }));
      return status();
    }
    if (path === '/songs/playlist/add' || path === '/songs/playlist/update') {
      const previous = playlists.find(list => list.id === body.id);
      const playlist = { ...previous, ids: path.endsWith('/add') ? [...new Set([...previous.ids, ...body.ids])] : body.ids };
      playlists = playlists.map(list => list.id === body.id ? playlist : list);
      return { playlist, ...status() };
    }
    return { ok: false };
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const ui = { Btn: 'Btn', Card: 'Card', Row: 'Row', Switch: 'Switch' };
  const Panel = new Function('React', 'h', 'ui', 'call', 'setTimeout', 'setInterval', 'clearInterval', panelSource)(
    React, h, ui, call, run => { timers.push(run); }, () => 0, () => {});
  const render = () => {
    cursor = 0;
    nodes = [];
    const visit = node => { if (node?.children) { nodes.push(node); node.children.forEach(visit); } };
    visit(Panel({}));
    effects.splice(0).forEach(effect => effect());
  };
  const find = predicate => {
    const node = nodes.find(predicate);
    assert.ok(node, 'Expected panel element');
    return node;
  };
  const label = value => find(node => node.props['aria-label'] === value);
  const button = text => find(node => (node.type === 'Btn' || node.type === 'button') && node.children.includes(text));
  const click = text => { const node = button(text); assert.ok(!node.props.disabled, text); const work = node.props.onClick(); render(); return work; };
  const change = (name, value) => { label(name).props.onChange({ target: { value } }); render(); render(); };
  const rowCheckbox = row => row.children.find(node => node?.type === 'label').children.find(node => node?.props?.type === 'checkbox');
  const selectOnly = row => { rowCheckbox(row).props.onChange({ target: { checked: true } }); render(); };
  const selectAll = (checked = true) => { label('全选当前结果').props.onChange({ target: { checked } }); render(); };
  const row = id => find(node => node.props['data-song-id'] === id);
  const open = name => {
    find(node => node.type === 'button' && node.children.some(child => child?.children?.includes(name))).props.onClick();
    render(); render();
  };
  render();
  await settle();
  render();
  const requests = path => calls.filter(call => call.path === path).map(call => call.body);
  const rowOrder = () => nodes.flatMap(node => node.props['data-song-id'] || []);
  return { render, label, button, click, change, selectOnly, selectAll, rowCheckbox, row, rowOrder, open, requests, timers, find };
}

test('bulk voice switching matches saved voice identity, and only changes the saved playlist draft', async () => {
  const good = entry('e', first.title, first.sourceId, { voiceId: 'local:example-voice', voiceLabel: '示例音色（本地整曲）' });
  const sameName = entry('f', second.title, second.sourceId, { voiceId: 'local:other', voiceLabel: good.voiceLabel });
  const h = await harness({ entries: [first, second, other, original, good, sameName] });
  h.open('妈妈流行歌曲');
  h.change('搜索已保存歌曲', '童谣');
  h.change('可选音色', good.voiceId);
  await h.click('全部版本切换音色');
  assert.deepEqual(h.rowOrder(), [good.id, second.id]);
  assert.deepEqual(h.requests('/songs/generate'), []);
  assert.deepEqual(h.requests('/songs/playlist/update'), []);
  await h.click('保存修改');
  assert.deepEqual(h.requests('/songs/playlist/update').at(-1).ids, [good.id, second.id, other.id]);
});

test('bulk switching collapses duplicate playback rows in all songs and the version menu uses three columns', async () => {
  const match = entry('e', first.title, first.sourceId, { voiceId: 'local:example-voice', voiceLabel: '示例音色（本地整曲）' });
  const h = await harness({ entries: [first, original, match, other] });
  await h.click('切换版本');
  const menu = h.find(node => node.props.role === 'group' && node.props['aria-label'] === '选择歌曲版本');
  assert.equal(menu.children[0].props.style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
  h.change('可选音色', match.voiceId);
  await h.click('全部版本切换音色');
  assert.deepEqual(h.rowOrder(), [match.id, other.id]);
  await h.click('小爱播放');
  assert.deepEqual(h.requests('/songs/play'), [{ id: match.id }]);
});

test('time, title and voice ordering are display-only and daily playlist has its own speaker action', async () => {
  const alpha = { ...first, title: 'Apple', voice: 'Z', createdAt: '2026-11-18T00:00:00Z' };
  const beta = { ...second, title: 'Banana', voice: 'A', createdAt: '2026-11-20T00:00:00Z' };
  const daily = { id: '__daily_random__', name: '每日随机歌单', ids: [beta.id, alpha.id] };
  const h = await harness({ entries: [beta, alpha, other], dailyPlaylist: daily });
  h.change('搜索已保存歌曲', '测试歌手');
  h.change('歌曲排序', 'title');
  assert.deepEqual(h.rowOrder(), [alpha.id, beta.id]);
  h.change('歌曲排序', 'time');
  assert.deepEqual(h.rowOrder(), [beta.id, alpha.id]);
  h.change('歌曲排序', 'voice');
  assert.deepEqual(h.rowOrder(), [beta.id, alpha.id]);
  h.open('每日随机歌单');
  assert.deepEqual(h.rowOrder(), daily.ids);
  await h.click('小爱播放今日歌单');
  assert.deepEqual(h.requests('/songs/playlist/play'), [{ id: daily.id, mode: 'sequential' }]);
  assert.deepEqual(h.requests('/songs/playlist/update'), []);
  assert.throws(() => h.button('删除'));
});

test('a legacy playback error identifier is replaced with direct guidance in the panel', async () => {
  const h = await harness({ '/songs/check': (_body, status) => ({
    ...status(), playback: { phase: 'failed', error: { message: 'FAMILY_PLAYBACK_FAILED' } },
  }) });
  const notice = h.find(node => node.props.role === 'alert' && node.children.includes('未能播放歌曲，请检查音箱是否在线以及电脑与音箱的网络连接。'));
  assert.doesNotMatch(notice.children.join(' '), /FAMILY_/);
});

test('the panel starts in all songs and search finds titles, artists, cover voices and version kinds within the current list', async () => {
  const h = await harness();
  h.label('全部歌曲内容');
  h.row(original.id);
  h.change('搜索已保存歌曲', '童谣甲');
  h.row(first.id);
  h.row(original.id);
  assert.throws(() => h.row(second.id));

  h.change('搜索已保存歌曲', '另一位歌手');
  h.row(other.id);
  assert.throws(() => h.row(first.id));

  h.change('搜索已保存歌曲', '测试歌手 翻唱 童谣甲 旧音色');
  h.row(first.id);
  assert.throws(() => h.row(original.id));
  assert.throws(() => h.row(second.id));

  h.change('搜索已保存歌曲', '童谣甲 原曲');
  h.row(original.id);
  assert.throws(() => h.row(first.id));
  h.open('妈妈流行歌曲');
  h.change('搜索已保存歌曲', '童谣甲 原曲');
  assert.throws(() => h.row(original.id));
});

test('batch cover includes all filtered rows and uses the version and voice chosen at click time', async () => {
  let submitted = 0;
  const h = await harness({
    '/songs/generate': (_body, status, setJobs) => {
      submitted++;
      if (submitted === 1) {
        setJobs([{ id: 'job-1', state: 'ready' }]);
        return { job: { id: 'job-1', state: 'queued' }, ...status() };
      }
      return { job: { id: 'job-2', state: 'ready', reused: true }, ...status() };
    },
  });
  h.open('妈妈流行歌曲');
  h.change('搜索已保存歌曲', '童谣');
  h.selectOnly(h.row(first.id));
  h.row(first.id).children.find(child => child?.children?.some(btn => btn?.children?.includes('切换版本')))
    .children.find(child => child?.children?.includes('切换版本')).props.onClick();
  h.render();
  h.click('原曲');
  h.change('可选音色', '长音色名称测试');
  const batch = h.click('全部音色生成');
  await settle();
  assert.deepEqual(h.requests('/songs/generate'), [
    { songId: '11', pitch: 0, mode: 'cover', voice: '长音色名称测试', play: false },
  ]);
  h.timers.shift()();
  await batch;
  h.render();
  assert.deepEqual(h.requests('/songs/generate').map(job => [job.songId, job.pitch]), [['11', 0], ['22', -3]]);
  assert.match(h.find(node => node.props.role === 'status' && node.children[0]?.startsWith('全部音色生成')).children[0],
    /2\/2 · 成功 1 · 失败 0 · 跳过 1/);
});

test('stop waits for the active original and sends no more songs', async () => {
  const h = await harness({
    '/songs/generate': (_body, status, setJobs) => {
      setJobs([{ id: 'job', state: 'ready' }]);
      return { job: { id: 'job', state: 'queued' }, ...status() };
    },
  });
  h.open('妈妈流行歌曲');
  h.change('搜索已保存歌曲', '童谣');
  const batch = h.click('全部本地生成');
  await settle();
  h.click('停止后续任务');
  h.timers.shift()();
  await batch;
  h.render();
  assert.deepEqual(h.requests('/songs/generate'), [{ songId: '11', pitch: 0, mode: 'original', voice: '', play: false }]);
  assert.match(h.find(node => node.props.role === 'status' && node.children[0]?.startsWith('全部本地生成')).children[0],
    /1\/2.*已停止后续任务/);
});

test('batch local cover submits the registered voice for the original key and skips transposed versions', async () => {
  const h = await harness({
    '/songs/generate': (_body, status) => ({ job: { id: 'local-job', state: 'ready' }, ...status() }),
  });
  h.open('妈妈流行歌曲');
  h.change('搜索已保存歌曲', '童谣');
  h.row(first.id).children.find(child => child?.children?.some(btn => btn?.children?.includes('切换版本')))
    .children.find(child => child?.children?.includes('切换版本')).props.onClick();
  h.render();
  h.click('原曲');
  h.change('可选音色', 'local:example-voice');
  await h.click('全部音色生成');
  h.render();

  assert.deepEqual(h.requests('/songs/generate'), [
    { songId: '11', pitch: 0, mode: 'cover', voice: 'local:example-voice', play: false },
  ]);
  assert.match(h.find(node => node.props.role === 'status' && node.children[0]?.startsWith('全部音色生成')).children[0],
    /2\/2 · 成功 1 · 失败 0 · 跳过 1/);
  assert.ok(h.find(node => node.type === 'li' && node.children[0] === '童谣乙：本地整曲音色仅支持原调，请先切换到原调版本'));
});

test('single and batch selectors show the real default and report why a local voice is unavailable', async () => {
  const h = await harness({
    '/songs/local-voice/check': () => ({ ok: false, message: '渲染版本不匹配，请更新音色登记。' }),
  });
  for (const label of ['本次生成音色', '可选音色']) {
    assert.match(h.label(label).children.find(option => option.props.value === '').children[0], /默认翻唱音色 · 长音色名称测试/);
  }
  assert.deepEqual(h.requests('/songs/local-voice/check'), []);
  h.change('本次生成音色', 'local:example-voice');
  await settle();
  h.render();
  assert.deepEqual(h.requests('/songs/local-voice/check'), [{ voice: 'local:example-voice' }]);
  assert.equal(h.find(node => node.props.role === 'alert' && node.children[0]?.startsWith('暂不可生成')).children[0],
    '暂不可生成。渲染版本不匹配，请更新音色登记。');
  assert.deepEqual(h.requests('/songs/generate'), []);
});

test('selection follows list and search scope, and playlist removal saves references only', async () => {
  const h = await harness();
  h.open('妈妈流行歌曲');
  h.change('搜索已保存歌曲', '童谣');
  const all = () => h.label('全选当前结果');
  const checkbox = id => h.rowCheckbox(h.row(id));
  h.selectOnly(h.row(first.id));
  const control = {};
  all().props.ref(control);
  assert.equal(control.indeterminate, true);
  h.selectAll();
  assert.equal(all().props.checked, true);
  assert.equal(checkbox(second.id).props.checked, true);
  h.selectAll(false);
  assert.equal(all().props.checked, false);
  assert.equal(checkbox(first.id).props.checked, false);
  h.selectAll();
  assert.throws(() => h.row(other.id));
  h.change('加入目标歌单', 'target');
  await h.click('批量加入歌单');
  h.render();
  assert.deepEqual(h.requests('/songs/playlist/add'), [{ id: 'target', ids: [first.id, second.id] }]);
  h.selectAll();
  h.change('搜索已保存歌曲', '童谣乙');
  assert.equal(checkbox(second.id).props.checked, false);
  h.selectAll();
  h.click('批量移出');
  h.click('确认移出歌单');
  assert.deepEqual(h.requests('/songs/delete'), []);
  assert.deepEqual(h.requests('/songs/playlist/update'), []);
  await h.click('保存修改');
  h.render();
  assert.deepEqual(h.requests('/songs/playlist/update'), [{ id: 'source', name: '妈妈流行歌曲', ids: [first.id, other.id] }]);
  h.open('♫ 全部歌曲');
  assert.equal(checkbox(second.id).props.checked, false);
  h.selectOnly(h.row(second.id));
  h.selectOnly(h.row(other.id));
  h.click('批量删除');
  h.label('删除歌曲确认');
  await h.click('确认删除歌曲');
  assert.deepEqual(h.requests('/songs/delete'), [{ id: second.id, directoryId: '' }]);
});
