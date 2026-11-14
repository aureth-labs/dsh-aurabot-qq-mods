import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function harness({ firstUse = false, dialogue = false, music = { entries: [] }, playlists = [] } = {}) {
  const source = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
  const states = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, effectCursor = 0, timerId = 0, nodes = [], jobs = [];
  let phase = 'idle', failStatus = false, failStart = false;
  let root = '', complete = false, checked = false, wakeSaved = false;
  const status = () => ({ ok: true, ...(firstUse ? { onboarding: { resourceRoot: root, storageReady: Boolean(root), complete,
    speakerVerified: checked, wakeSaved, features: { original: true, model: false, dialogue, singing: false } } } : {}),
    login: { phase, message: '状态：' + phase }, playback: { phase: 'idle' }, listener: { enabled: false }, songs: music, playlists });
  const call = async (path, body) => {
    requests.push({ path, body });
    if (path === '/songs/missing/clear') { playlists = playlists.map(list => ({ ...list, ids: list.ids.filter(id => music.entries.some(entry => entry.id === id)) })); return { ...status(), removed: 1, affectedPlaylists: 0 }; }
    if (path.startsWith('/songs/directories')) return status();
    if (firstUse) {
      if (path === '/onboarding/storage') { root = body.root; return status(); }
      if (path === '/onboarding/networks') return { ok: true, networks: [{ name: 'Synthetic LAN', addresses: ['192.0.2.1'] }] };
      if (path === '/speaker/check') { checked = true; return { ok: true, historyReadable: true }; }
      if (path === '/speaker/wake') return { ok: true, wake: { names: ['小伴'] } };
      if (path === '/speaker/wake/save') { wakeSaved = true; return { ok: true, wake: body }; }
      if (path === '/reminders') return { ok: true, reminders: [] };
      if (path === '/settings/options') return { ok: true, voices: { options: [{ id: '', label: '跟随宿主' }] } };
      if (path === '/onboarding/complete') { assert.ok(checked && wakeSaved); complete = true; return status(); }
    }
    if (path === '/speaker/login/start') { if (failStart) throw Error('synthetic-secret'); phase = 'waiting'; return { ok: true, login: status().login }; }
    if (path === '/status' && failStatus) throw Error('synthetic-secret');
    if (path === '/status' || path === '/songs/check') return status();
    return { ok: false };
  };
  const React = {
    useState(initial) { const n = cursor++; if (!(n in states)) states[n] = initial; return [states[n], value => { states[n] = typeof value === 'function' ? value(states[n]) : value; }]; },
    useRef() { return { current: null }; },
    useEffect(fn, deps) { const n = effectCursor++; const old = effects[n]; if (!old || deps.some((d, i) => !Object.is(d, old.deps[i]))) { effects[n] = { deps, cleanup: null }; jobs.push(() => { old?.cleanup?.(); effects[n].cleanup = fn(); }); } },
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const ui = new Proxy({}, { get: (_, key) => key });
  const Panel = new Function('React', 'h', 'ui', 'call', 'setInterval', 'clearInterval', source)(React, h, ui, call,
    fn => { const id = ++timerId; timers.set(id, fn); return id; }, id => timers.delete(id));
  function render() { cursor = 0; effectCursor = 0; nodes = []; jobs = []; const walk = x => { if (!x || typeof x !== 'object') return; nodes.push(x); x.children?.forEach(walk); }; walk(Panel({})); jobs.forEach(fn => fn()); }
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); render(); };
  render(); await settle();
  return {
    render, settle, requests, timers,
    nodes: () => nodes,
    button: label => nodes.find(n => n.type === 'Btn' && n.children.includes(label)),
    image: () => nodes.find(n => n.type === 'img' && n.props.alt === '小米音箱登录二维码'),
    setPhase: value => { phase = value; },
    failStatus: value => { failStatus = value; }, failStart: value => { failStart = value; },
    tick: async () => { for (const fn of [...timers.values()]) await fn(); await settle(); },
    close: () => effects.forEach(e => e.cleanup?.()),
  };
}

const musicFixture = () => ({ directories: [
  { id: 'primary', path: '/synthetic-primary', primary: true, count: 1, phase: 'ready' },
  { id: 'external', path: '/synthetic-external', count: 1, phase: 'missing' },
], entries: [
  { id: 'a'.repeat(64), title: 'Generated track', artists: '', sourceId: 'a', mode: 'cover', voice: 'Synthetic', directoryIds: ['primary'], available: true },
  { id: 'b'.repeat(64), title: 'External track', artists: '', sourceId: 'b', mode: 'local', voice: '本地音乐', directoryIds: ['external'], available: false, readOnly: true },
] });

test('directory UI keeps add and one-click cleanup, with no relocation controls', async t => {
  const h = await harness({ music: musicFixture() }); t.after(h.close);
  const label = name => h.nodes().find(n => n.props['aria-label'] === name);
  h.button('添加 / 管理目录').props.onClick(); h.render();
  label('添加音乐目录路径').props.onChange({target:{value:'/synthetic-added'}}); h.render();
  await h.button('添加目录').props.onClick(); h.render();
  assert.deepEqual(h.requests.find(r => r.path === '/songs/directories/add').body,{path:'/synthetic-added'});
  assert.equal(label('音乐目录新位置'),undefined); assert.equal(h.button('核验新位置'),undefined);
  await h.button('一键清除失效歌曲').props.onClick(); h.render();
  assert.equal(h.requests.filter(r => r.path === '/songs/missing/clear').length,1);
  assert.ok(h.nodes().some(n => n.children.some(c => typeof c === 'string' && c.includes('不删除磁盘文件'))));
});

test('a song shared with the primary cannot be deleted while viewing an external directory', async t => {
  const music = musicFixture(); music.entries = [{...music.entries[0],directoryIds:['primary','external'],readOnly:false}];
  const h = await harness({ music }); t.after(h.close);
  const select = () => h.nodes().find(n => n.props['aria-label'] === '查看音乐目录');
  select().props.onChange({target:{value:'external'}}); h.render(); assert.equal(h.button('删除').props.disabled,true);
  select().props.onChange({target:{value:'primary'}}); h.render(); assert.equal(h.button('删除').props.disabled,false);
});

test('unmatched playlist ids are visible and cleanup refreshes the currently open playlist', async t => {
  const h = await harness({ music: musicFixture(), playlists: [{id:'synthetic-list',name:'Synthetic playlist',ids:['c'.repeat(64)]}] }); t.after(h.close);
  assert.ok(h.nodes().some(n => n.children.includes('找不到的歌曲（找不到或无法读取，请重新添加）')));
  await h.button('一键清除失效歌曲').props.onClick(); h.render();
  assert.equal(h.nodes().some(n => n.children.includes('找不到的歌曲（找不到或无法读取，请重新添加）')),false);
  assert.equal(h.button('保存修改').props.disabled,true);
});

test('directory manager precedes all songs; folder selection filters rows and external files cannot be deleted', async t => {
  const h = await harness({ music: musicFixture() }); t.after(h.close);
  const label = name => h.nodes().find(n => n.props['aria-label'] === name);
  assert.ok(h.nodes().indexOf(label('音乐目录管理')) < h.nodes().indexOf(label('全部歌曲内容')));
  label('查看音乐目录').props.onChange({ target: { value: 'external' } }); h.render();
  assert.ok(h.nodes().some(n => n.children.includes('External track（找不到或无法读取，请重新添加）')));
  assert.equal(h.nodes().some(n => n.children.includes('Generated track')), false);
  assert.equal(h.button('删除').props.disabled, true);
  assert.ok(h.nodes().some(n => n.children.some(c => typeof c === 'string' && c.includes('目录已离线或搬走'))));
});





test('QR appears inline only after click; poll verification and success then hide QR and stop polling', async t => {
  const h = await harness(); t.after(h.close);
  assert.equal(h.image(), undefined);
  assert.equal(h.nodes().some(n => n.type === 'a' && n.props.href?.endsWith('/speaker/login')), false);
  await h.button('扫码登录 / 更新登录').props.onClick(); h.render();
  assert.ok(h.image().props.src.includes('/speaker/login/qr?v='));
  const nodes = h.nodes(); assert.ok(nodes.indexOf(h.image()) > nodes.findIndex(n => n.props.label === '小米账号登录'));
  assert.equal(h.button('扫码登录 / 更新登录').props.disabled, true); assert.equal(h.timers.size, 1);
  h.setPhase('verifying'); await h.tick(); assert.equal(h.image(), undefined); assert.equal(h.timers.size, 1);
  h.setPhase('saved'); await h.tick(); assert.equal(h.image(), undefined); assert.equal(h.timers.size, 0);
  assert.ok(h.nodes().some(n => n.props.role === 'status' && n.children.includes('状态：saved')));
});

test('first-use panel gates music until storage, connection and names, with optional AI and singing', async t => {
  const h = await harness({ firstUse: true, dialogue: true }); t.after(h.close);
  const label = name => h.nodes().find(n => n.props['aria-label'] === name);
  const notice = () => h.nodes().find(n => n.props.role === 'alert' && n.props.className === 'ab-note err');
  const switchProps = () => h.nodes().map(n => n.props.right?.props).find(props => props?.title === '小爱音响接入开关');
  assert.equal(h.nodes()[1], notice());
  assert.match(notice().children[0], /确认保存位置/);
  assert.ok(label('首次保存目录'));
  assert.equal(h.requests.some(r => r.path === '/songs/check'), false);
  assert.equal(h.nodes().some(n => n.props.title === '歌曲与歌单'), false);
  label('首次保存目录').props.onChange({ target: { value: '/synthetic-chosen-root' } }); h.render();
  await h.button('确认位置并继续').props.onClick(); await h.settle(); await h.settle();
  assert.equal(label('首次保存目录'), undefined);
  assert.equal(h.nodes()[1], notice());
  assert.match(notice().children[0], /检查登录与连接/);
  assert.equal(switchProps().disabled, true);
  assert.ok(label('可用网卡')); assert.ok(label('主要称呼'));
  assert.equal(h.button('完成配置，进入模块').props.disabled, true);
  assert.equal(h.button('AI 补足同音词').props.disabled, true);
  await h.button('检查登录与连接').props.onClick(); h.render();
  assert.match(notice().children[0], /保存主要称呼/);
  assert.equal(switchProps().disabled, true);
  await h.button('保存称呼').props.onClick(); h.render();
  assert.equal(h.button('完成配置，进入模块').props.disabled, false);
  assert.match(notice().children[0], /完成配置，进入模块/);
  assert.equal(switchProps().disabled, true);
  await h.button('完成配置，进入模块').props.onClick(); h.render();
  assert.equal(h.button('完成配置，进入模块'), undefined);
  assert.equal(notice(), undefined);
  assert.equal(switchProps().disabled, false);
  assert.ok(h.nodes().some(n => n.props.title === '歌曲与歌单'));
  assert.equal(h.requests.some(r => r.path === '/speaker/listener/start'), false);
  assert.equal(h.requests.some(r => r.path === '/speaker/wake/suggest'), false);
});

test('expired, failed and extra-verification states show status and allow regeneration', async t => {
  for (const phase of ['expired', 'failed', 'verification-required']) {
    const h = await harness(); t.after(h.close);
    await h.button('扫码登录 / 更新登录').props.onClick(); h.render();
    h.setPhase(phase); await h.tick();
    assert.equal(h.image(), undefined); assert.equal(h.timers.size, 0);
    assert.equal(h.button('重新生成二维码').props.disabled, false);
    await h.button('重新生成二维码').props.onClick(); h.render(); assert.ok(h.image());
  }
});

test('image and transport failures provide inline feedback without exposing raw errors', async t => {
  const h = await harness(); t.after(h.close);
  h.failStart(true); await h.button('扫码登录 / 更新登录').props.onClick(); h.render();
  assert.equal(h.image(), undefined); assert.ok(h.button('重新生成二维码'));
  h.failStart(false); await h.button('重新生成二维码').props.onClick(); h.render();
  h.image().props.onError(); h.render(); assert.equal(h.image(), undefined); assert.equal(h.button('重新生成二维码').props.disabled, false);
  assert.ok(h.nodes().some(n => n.props.role === 'alert'));
  h.failStatus(true); await h.tick(); assert.ok(h.nodes().some(n => n.children.includes('暂时无法获取登录状态，正在重试。')));
  assert.equal(JSON.stringify(h.nodes()).includes('synthetic-secret'), false);
  h.failStatus(false); h.setPhase('expired'); await h.tick(); assert.equal(h.timers.size, 0);
});
