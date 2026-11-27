import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import definition from '../index.mjs';
import { setupOnboarding, prepareStorage } from '../lib/companion/onboarding.mjs';
import { resourcePaths } from '../lib/songs/storage.mjs';
import { FamilyReminders } from '../lib/companion/reminders.mjs';

globalThis.aurabot = { src: new URL('../', import.meta.url), lib: () => ({}) };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoai-first-use-'));
  const settings = {}, routes = new Map(), disposers = [], patches = [], timers = [];
  const api = { id: definition.id, settings: () => settings, config: () => ({}), dataDir: () => join(root,'default'),
    saveSettings: async patch => { patches.push(patch); Object.assign(settings,patch); },
    route: (path,handler) => routes.set(path,handler), every: (_,fn) => timers.push(fn), on() {}, onDispose: fn => disposers.push(fn),
    tool() {}, rule() {}, defineTool: value => value, use: () => ({ search() {}, status: () => ({ voices: [] }) }),
    core: { http: { body: async req => req.body } } };
  const req = { method:'POST', socket:{remoteAddress:'127.0.0.1'}, headers:{host:'127.0.0.1:3080','content-type':'application/json'} };
  t.after(async () => { for(const fn of disposers) await fn();
    const part=relative(tmpdir(),root); assert.ok(part&&!isAbsolute(part)&&!part.startsWith('..')); await rm(root,{recursive:true,force:true}); });
  return {root,api,settings,routes,patches,timers,disposers,post:(path,body={})=>routes.get(path)({...req,body}),get:path=>routes.get(path)({...req,method:'GET'})};
}

for (const store of ['listener', 'wake', 'reminders']) {
  test('isolates damaged ' + store + ' storage and preserves its original bytes', async t => {
    const h = await fixture(t);
    h.settings.resourceRoot = h.root;
    const paths = resourcePaths(h.root);
    const file = { listener: paths.listenerFile, wake: join(dirname(paths.listenerFile), '家庭称呼.json'),
      reminders: paths.remindersFile }[store];
    await mkdir(dirname(file), { recursive: true });
    const damaged = Buffer.alloc(51);
    await writeFile(file, damaged);
    if (store === 'wake') await writeFile(paths.listenerFile, '{"schema":1,"enabled":true}');
    const ticks = t.mock.method(FamilyReminders.prototype, 'tick');
    const service = await definition.setup(h.api);
    assert.equal((await h.post('/songs/check')).ok, true);
    await h.timers[0]();
    const state = service.status();
    assert.equal(state.listener.active, false);
    assert.deepEqual(await readFile(file), damaged);
    const reminder = { text: '测试', schedule: { frequency: 'daily', time: '09:00' } };
    if (store === 'reminders') {
      assert.equal(ticks.mock.callCount(), 0);
      for (const result of [await h.get('/reminders'), await h.post('/reminders/create', reminder),
        await service.remind({ action: 'cancel', id: 'test' })]) {
        assert.equal(result.ok, false);
        assert.equal(result.code, 'FAMILY_REMINDER_INVALID');
      }
      assert.equal((await h.get('/speaker/wake')).ok, true);
      assert.deepEqual(await readFile(file), damaged);
      for (const dispose of h.disposers.splice(0)) await dispose();
      await writeFile(file, '{"schema":1,"reminders":[]}');
      await definition.setup(h.api);
      assert.equal((await h.post('/reminders/create', reminder)).ok, true);
      return;
    }
    assert.equal(ticks.mock.callCount(), 1);
    assert.equal((await h.post('/reminders/create', reminder)).ok, true);
    if (store === 'listener') {
      assert.equal(state.listener.enabled, false);
      assert.equal(state.listener.error.code, 'PREFERENCE_INVALID');
      assert.equal((await h.post('/speaker/end')).ok, true);
      assert.equal(service.status().listener.error, null);
      assert.equal(JSON.parse(await readFile(file)).enabled, false);
    } else {
      assert.equal(state.listener.enabled, true);
      assert.equal(state.onboarding.wakeSaved, false);
      for (const route of ['/speaker/arm', '/speaker/listener/start', '/speaker/history/read']) {
        assert.equal((await h.post(route)).code, 'PREFERENCE_INVALID');
      }
      assert.deepEqual(await readFile(file), damaged);
      assert.equal((await h.post('/speaker/wake/save', { names: ['小伴'], greetingNames: [] })).ok, true);
      assert.equal(service.status().onboarding.wakeSaved, true);
      assert.equal(service.status().listener.wakeError, undefined);
      assert.deepEqual(JSON.parse(await readFile(file)).names, ['小伴']);
    }
    const backups = (await readdir(dirname(file))).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(join(dirname(file), backups[0])), damaged);
  });
}

test('music routes retain a malformed directory index and accept the restored index on retry', async t => {
  const h = await fixture(t);
  h.settings.resourceRoot = h.root;
  const { directoriesFile } = resourcePaths(h.root);
  await mkdir(dirname(directoriesFile), { recursive: true });
  await writeFile(directoriesFile, 'null');
  await definition.setup(h.api);
  assert.equal((await h.post('/songs/check')).ok, false);
  assert.equal(await readFile(directoriesFile, 'utf8'), 'null');
  assert.equal((await h.get('/reminders')).ok, true);
  const primary = join(h.root, 'music');
  await mkdir(primary);
  await writeFile(directoriesFile, JSON.stringify({ schema: 1,
    directories: [{ id: 'primary', path: primary, records: [], phase: 'ready' }] }));
  assert.equal((await h.post('/songs/check')).ok, true);
  assert.equal(JSON.parse(await readFile(directoriesFile)).directories[0].path, primary);
});

test('a filesystem read error keeps wake settings unavailable without attempting corrupt-file recovery', async t => {
  const h = await fixture(t);
  h.settings.resourceRoot = h.root;
  const speakerDir = dirname(resourcePaths(h.root).listenerFile);
  const wakeFile = join(speakerDir, '家庭称呼.json');
  await mkdir(wakeFile, { recursive: true });
  await definition.setup(h.api);
  assert.equal((await h.get('/speaker/wake')).error.code, 'PREFERENCE_READ');
  assert.equal((await h.post('/speaker/wake/save', { names: ['小伴'], greetingNames: [] })).ok, false);
  assert.deepEqual(await readdir(speakerDir), ['家庭称呼.json']);
  assert.equal((await h.post('/songs/check')).ok, true);
});

test('fresh actual module waits for storage without creating default library or starting work', async t => {
  const h=await fixture(t); const instance=await definition.setup(h.api);
  assert.deepEqual(await readdir(h.root),[]);
  assert.equal(instance.status().onboarding.complete,false);
  assert.equal((await instance.execute({action:'catalog'})).ok,false);
  assert.equal(h.timers.length,0); assert.equal(h.routes.has('/speaker/login/start'),false);
  for (const route of ['/speaker/listener/start','/speaker/arm']) {
    assert.equal((await h.post(route)).code,'XIAOAI_SETUP_REQUIRED');
  }
  const chosen=join(h.root,'chosen');
  const result=await h.post('/onboarding/storage',{root:chosen});
  assert.equal(result.ok,true); assert.equal(result.onboarding.storageReady,true); assert.equal(result.onboarding.complete,false);
  assert.equal(h.settings.resourceRoot,chosen); assert.equal(h.settings.setupComplete,false);
  assert.deepEqual(await readdir(h.root),['chosen']);
  assert.equal((await h.post('/songs/check')).code,'XIAOAI_SETUP_REQUIRED');
  for (const route of ['/speaker/listener/start','/speaker/arm']) {
    assert.equal((await h.post(route)).code,'XIAOAI_SETUP_REQUIRED');
  }
  assert.equal((await h.post('/onboarding/complete')).ok,false);
  assert.equal((await h.post('/onboarding/storage',{root:join(h.root,'other')})).ok,false);
  assert.equal(h.settings.resourceRoot,chosen);
});

test('review confirms the existing location before opening saved settings and keeps the playlist intact', async t => {
  const h = await fixture(t);
  const paths = resourcePaths(h.root);
  Object.assign(h.settings, { resourceRoot: h.root, networkInterface: 'synthetic', setupComplete: false, setupReviewStep: 'storage' });
  const playlist = join(h.root, 'AuraBot-Family', 'Playlists', '家庭歌单.json');
  const wake = join(dirname(paths.listenerFile), '家庭称呼.json');
  await mkdir(dirname(playlist), { recursive: true });
  await mkdir(dirname(wake), { recursive: true });
  const saved = JSON.stringify({ schema: 1, playlists: [] });
  await writeFile(playlist, saved);
  await writeFile(wake, JSON.stringify({ schema: 1, names: ['小伴'], greetingNames: [] }));
  const instance = await definition.setup(h.api);
  assert.equal(instance.status().onboarding.confirmExisting, true);
  assert.equal(instance.status().onboarding.storageReady, false);
  assert.equal(h.timers.length, 0);
  assert.equal((await h.post('/onboarding/storage', { root: join(h.root, 'other') })).ok, false);
  assert.equal((await h.post('/speaker/listener/start')).code, 'XIAOAI_SETUP_REQUIRED');
  assert.deepEqual(h.patches, []);
  const next = await h.post('/onboarding/storage', { root: h.root });
  assert.equal(next.onboarding.storageReady, true);
  assert.equal(next.onboarding.speakerVerified, false);
  assert.equal(next.onboarding.wakeSaved, false);
  assert.equal((await h.post('/onboarding/complete')).ok, false);
  assert.deepEqual((await h.get('/speaker/wake')).wake.names, ['小伴']);
  assert.deepEqual(h.patches, [{ setupReviewStep: 'connection' }]);
  assert.equal(await readFile(playlist, 'utf8'), saved);
});

test('existing implicit data root is reused without rewriting configuration', async t => {
  const h=await fixture(t); await mkdir(join(h.root,'default','song DB'),{recursive:true});
  await writeFile(join(h.root,'default','song DB','synthetic-retained.txt'),'synthetic');
  const instance=await definition.setup(h.api);
  assert.equal(instance.status().onboarding.complete,true);
  assert.equal(instance.status().storage.root,join(h.root,'default'));
  assert.deepEqual(h.patches,[]);
});

test('empty directories from an unused old installation do not bypass first-use setup', async t => {
  const h=await fixture(t); await mkdir(join(h.root,'default','AuraBot-Family','Speaker'),{recursive:true});
  const instance=await definition.setup(h.api);
  assert.equal(instance.status().onboarding.complete,false);
  assert.equal(instance.status().onboarding.storageReady,false);
  assert.deepEqual(await readdir(join(h.root,'default','AuraBot-Family','Speaker')),[]);
});

test('unfinished setup resumes its chosen location and saved name but requires a new connection check', async t => {
  const h=await fixture(t); const chosen=join(h.root,'chosen');
  h.settings.resourceRoot=chosen; h.settings.setupComplete=false;
  await mkdir(join(chosen,'AuraBot-Family','Speaker'),{recursive:true});
  await writeFile(join(chosen,'AuraBot-Family','Speaker','家庭称呼.json'),JSON.stringify({schema:1,names:['小伴'],greetingNames:[]}));
  const instance=await definition.setup(h.api); const state=instance.status();
  assert.equal(state.onboarding.storageReady,true); assert.equal(state.onboarding.complete,false);
  assert.equal(state.onboarding.wakeSaved,true); assert.equal(state.onboarding.speakerVerified,false);
  assert.equal((await h.post('/onboarding/complete')).ok,false); assert.deepEqual(h.patches,[]);
});

test('first-use completion requires connection and names; original playback does not require AI or singing', async t => {
  const h=await fixture(t); let ticks=0;
  const fakeRuntime=async api=>{
    const status=()=>({ok:true,storage:{root:api.settings().resourceRoot},listener:{enabled:false}});
    api.route('/status',async()=>status());
    api.route('/speaker/check',async()=>({ok:true,historyReadable:true}));
    api.route('/speaker/wake/save',async()=>({ok:true,wake:{names:['小伴']}}));
    api.every(1000,()=>{ticks++});
    return {status,execute:async()=>({ok:true}),remind:async()=>({ok:true})};
  };
  const instance=await setupOnboarding(h.api,fakeRuntime,{localPost:r=>r.method==='POST',localRequest:()=>true});
  await h.post('/onboarding/storage',{root:join(h.root,'chosen')});
  await h.timers[0](); assert.equal(ticks,0);
  await h.post('/speaker/check'); assert.equal((await h.post('/onboarding/complete')).ok,false);
  await h.post('/speaker/wake/save');
  h.settings.networkInterface='changed'; assert.equal((await h.post('/onboarding/complete')).ok,false);
  await h.post('/speaker/check');
  const result=await h.post('/onboarding/complete'); assert.equal(result.ok,true);
  assert.equal(h.settings.setupComplete,true); assert.equal(result.onboarding.features.original,true);
  assert.equal(result.onboarding.features.dialogue,false); assert.equal(result.onboarding.features.singing,false);
  assert.equal((await instance.execute({action:'catalog'})).ok,true);
  await h.timers[0](); assert.equal(ticks,1);
});

test('storage checks reject relative paths and existing module data and remove only their write probe', async t => {
  const h=await fixture(t); await assert.rejects(prepareStorage('relative'),/完整/);
  const folder=join(h.root,'new'); assert.equal(await prepareStorage(folder),folder);
  assert.deepEqual(await readdir(folder),[]);
  await mkdir(join(folder,'song DB'));
  await assert.rejects(prepareStorage(folder),/已有模块数据/);
  assert.deepEqual(await readdir(folder),['song DB']);
});

test('onboarding refuses remote storage writes and cannot start after disposal', async t => {
  const h=await fixture(t); await definition.setup(h.api);
  assert.equal((await h.routes.get('/onboarding/storage')({method:'POST',socket:{remoteAddress:'192.0.2.1'},headers:{}})).ok,false);
  await h.disposers[0]();
  assert.equal((await h.post('/onboarding/storage',{root:join(h.root,'chosen')})).ok,false);
  assert.deepEqual(await readdir(h.root),[]);
});


test('in-flight connection check cannot approve a different saved network', async t => {
  const h = await fixture(t);
  let checked;
  const gate = new Promise(resolve => { checked = resolve; });
  let first = true;
  let starts = 0;
  const runtime = async api => {
    api.route('/speaker/check', async () => {
      if (first) { first = false; await gate; }
      return { ok: true, historyReadable: true };
    });
    api.route('/speaker/wake/save', async () => ({ ok: true, wake: { names: ['小伴'] } }));
    api.route('/speaker/listener/start', async () => { starts++; return { ok: true }; });
    return { status: () => ({ ok: true }), execute() {}, remind() {} };
  };
  const instance = await setupOnboarding(h.api, runtime, { localPost: r => r.method === 'POST', localRequest: () => true });
  await h.post('/onboarding/storage', { root: join(h.root, 'chosen') });
  await h.post('/speaker/wake/save');
  h.settings.networkInterface = 'Synthetic A';
  const checking = h.post('/speaker/check');
  h.settings.networkInterface = 'Synthetic B';
  checked();
  assert.equal((await checking).ok, false);
  assert.equal(instance.status().onboarding.speakerVerified, false);
  assert.equal((await h.post('/onboarding/complete')).ok, false);
  assert.equal((await h.post('/speaker/listener/start')).code, 'XIAOAI_SETUP_REQUIRED');
  assert.equal(starts, 0);
  await h.post('/speaker/check');
  assert.equal((await h.post('/onboarding/complete')).ok, true);
  assert.equal((await h.post('/speaker/listener/start')).ok, true);
  assert.equal(starts, 1);
});
