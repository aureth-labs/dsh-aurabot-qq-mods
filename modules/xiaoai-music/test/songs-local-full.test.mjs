import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
globalThis.aurabot = { src: new URL('../', import.meta.url), lib: key => {
  if (key === 'core/store.js') return { dataDir: () => { throw new Error('Must use the private work directory'); }, readJson: () => [], writeJson: () => {} };
  if (key === 'song/netease.js') return { searchSongs: async () => [], songUrl: async () => { throw new Error('No network in isolated test'); }, account: async () => ({}) };
  if (key === 'song/zip.js') return { readZip: () => [] };
  throw new Error('Unexpected internal dependency');
} };
const { SongLibrary } = await import('../lib/songs/library.mjs');
const { resourcePaths } = await import('../lib/songs/storage.mjs');
const { LOCAL_FULL_SONG_TASK } = await import('../lib/songs/studio.mjs');
const { createFamilySongs } = await import('../lib/songs/runtime.mjs');

const GOLDEN_MOTHER_ID = 'a900d6844b2ff5ddc756b9ecc7c72fa40c198fe4be28a84a88a9596fc92bee14';

function fakeLocal({ active = true, describeResult, describeError, render } = {}) {
  const calls = [];
  return {
    calls,
    active: slot => slot === 'song' && active,
    call: async (slot, args) => {
      calls.push({ slot, args });
      if (args?.task !== LOCAL_FULL_SONG_TASK) throw new Error('unexpected slot call: ' + slot);
      if (args.describe) {
        if (describeError) throw new Error(describeError);
        return typeof describeResult === 'function' ? describeResult(args) : describeResult;
      }
      return render ? render(args) : null;
    },
  };
}

async function familyHarness(t, { registration, local, motherVoice = '', models = true, separatorModel = 'synthetic.onnx' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'family-local-full-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'family-local-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const modelsDir = join(root, 'models');
  if (models) {
    await mkdir(modelsDir, { recursive: true });
    await writeFile(join(modelsDir, 'synthetic-mother.pth'), 'isolated-mother-pth');
    await writeFile(join(modelsDir, 'synthetic-mother.index'), 'isolated-mother-index');
  }
  if (registration !== undefined) {
    await writeFile(join(dataDir, '本地整曲音色.json'), JSON.stringify(registration), 'utf8');
  }
  const api = {
    dataDir: () => dataDir,
    settings: () => ({ motherVoice, resourceRoot: root }),
    config: () => ({ song: { root, separatorModel, voice: '', vocalVolume: 1, instVolume: 0.8 } }),
    use: () => ({ search: async () => [] }),
    core: { local },
  };
  const family = await createFamilySongs(api, resourcePaths(root));
  const source = { id: 'synthetic-source', title: '隔离儿歌', artists: '隔离歌手', durationSec: 180 };
  family.library.addSources([source]);
  return { root, dataDir, family, source };
}

const describeCover = (family, source, voice, pitch = 0) =>
  family.library.primary.describe(source, pitch, { mode: 'cover', voice });

test('a registered local voice gets a dedicated identity and the hook sees the versioned task marker', async t => {
  const local = fakeLocal({ describeResult: { kind: 'describe', voiceId: '宵宫', renderVersion: 'ddsp63-x',
    params: { engine: 'ddsp', step: 50 } } });
  const h = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local });
  const recipe = await describeCover(h.family, h.source, 'local:宵宫');
  assert.deepEqual(recipe.identity, {
    version: 'family-local-full-song-v1',
    source: { provider: 'netease', id: 'synthetic-source' },
    voice: { role: 'local', id: '宵宫', renderVersion: 'ddsp63-x' },
    parameters: { pitch: 0, separatorModel: 'synthetic.onnx', params: { engine: 'ddsp', step: 50 } },
  });
  assert.equal(recipe.voiceName, '宵宫');
  assert.equal(local.calls.length, 1);
  assert.equal(local.calls[0].args.task, LOCAL_FULL_SONG_TASK);
  assert.equal(local.calls[0].args.describe, true);
  assert.equal(local.calls[0].args.voiceId, '宵宫');
  assert.equal(local.calls[0].args.renderVersion, 'ddsp63-x');
});

test('explicit selection wins over the saved default in both directions', async t => {
  const local = fakeLocal({ describeResult: { kind: 'describe', voiceId: '宵宫', renderVersion: 'ddsp63-x', params: {} } });
  const registration = [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }];
  // 保存默认是本地整曲、本次显式选 RVC 模型 → 仍走妈妈 Applio 分支，钩子零调用
  const explicitMother = await familyHarness(t, { registration, local, motherVoice: 'local:宵宫' });
  const motherRecipe = await describeCover(explicitMother.family, explicitMother.source, 'synthetic-mother');
  assert.equal(motherRecipe.identity.voice.role, 'mother');
  assert.equal(local.calls.length, 0);
  // 保存默认是 RVC 模型、本次显式选本地整曲 → 走本地整曲分支
  const explicitLocal = await familyHarness(t, { registration, local, motherVoice: 'synthetic-mother' });
  const localRecipe = await describeCover(explicitLocal.family, explicitLocal.source, 'local:宵宫');
  assert.equal(localRecipe.identity.voice.role, 'local');
  assert.equal(localRecipe.identity.voice.id, '宵宫');
});

test('unregistered local voice fails clearly without touching the hook', async t => {
  const local = fakeLocal({});
  const h = await familyHarness(t, { registration: [], local });
  await assert.rejects(describeCover(h.family, h.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_VOICE_UNAVAILABLE');
    assert.match(error.message, /「宵宫」未登记或已不可用/);
    assert.match(error.message, /登记文件：/);
    return true;
  });
  assert.equal(local.calls.length, 0);
});

test('non-zero pitch is rejected before enqueue with a clear prompt', async t => {
  const local = fakeLocal({ describeResult: { kind: 'describe', voiceId: '宵宫', renderVersion: 'ddsp63-x', params: {} } });
  const h = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local });
  await assert.rejects(describeCover(h.family, h.source, 'local:宵宫', 3), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_PITCH_UNSUPPORTED');
    assert.match(error.message, /只支持原调/);
    return true;
  });
  assert.equal(local.calls.length, 0);
});

test('a closed hook fails clearly and never falls back to Applio', async t => {
  const local = fakeLocal({ active: false });
  const h = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local });
  await assert.rejects(describeCover(h.family, h.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_HOOK_OFF');
    assert.match(error.message, /本地整曲钩子未开启/);
    return true;
  });
  assert.equal(local.calls.length, 0);
});

test('a failing or malformed hook describe gives a concrete hook error', async t => {
  const throwing = fakeLocal({ describeError: 'synthetic describe failure' });
  const throwingHarness = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local: throwing });
  await assert.rejects(describeCover(throwingHarness.family, throwingHarness.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_HOOK_ERROR');
    assert.match(error.message, /钩子检查失败：synthetic describe failure/);
    return true;
  });
  const malformed = fakeLocal({ describeResult: { kind: 'master', voiceId: '宵宫', renderVersion: 'ddsp63-x' } });
  const malformedHarness = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local: malformed });
  await assert.rejects(describeCover(malformedHarness.family, malformedHarness.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_HOOK_ERROR');
    assert.match(error.message, /未按约定返回音色描述/);
    return true;
  });
});

test('hook voice-availability failures are reported as unavailable before enqueue', async t => {
  const missingModel = fakeLocal({ describeError: '本地整曲音色不可用：「宵宫」缺少 model 配置（cover.json 的 voices 表里要写明权重路径）' });
  const missingModelHarness = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local: missingModel });
  await assert.rejects(describeCover(missingModelHarness.family, missingModelHarness.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_VOICE_UNAVAILABLE');
    assert.match(error.message, /「宵宫」缺少 model 配置/);
    return true;
  });
  const missingPth = fakeLocal({ describeError: '本地整曲音色不可用：「七七」缺少 pth 配置（cover.json 的 voices 表里要写明权重路径）' });
  const missingPthHarness = await familyHarness(t, { registration: [{ id: '七七', label: '七七', renderVersion: 'rvc-x' }], local: missingPth });
  await assert.rejects(describeCover(missingPthHarness.family, missingPthHarness.source, 'local:七七'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_VOICE_UNAVAILABLE');
    assert.match(error.message, /「七七」缺少 pth 配置/);
    return true;
  });
  const noFile = fakeLocal({ describeError: '本地整曲音色不可用：「宵宫」权重不存在（D:/no/such/model.pt）' });
  const noFileHarness = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local: noFile });
  await assert.rejects(describeCover(noFileHarness.family, noFileHarness.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_VOICE_UNAVAILABLE');
    assert.match(error.message, /权重不存在/);
    return true;
  });
});

test('the separator model actually used is part of the local cache identity', async t => {
  const describeResult = () => ({ kind: 'describe', voiceId: '宵宫', renderVersion: 'ddsp63-x', params: { engine: 'ddsp' } });
  const modelA = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }],
    local: fakeLocal({ describeResult }), separatorModel: 'model-bs-roformer-a.ckpt' });
  const modelB = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }],
    local: fakeLocal({ describeResult }), separatorModel: 'model-bs-roformer-b.ckpt' });
  const a = await describeCover(modelA.family, modelA.source, 'local:宵宫');
  const b = await describeCover(modelB.family, modelB.source, 'local:宵宫');
  assert.equal(a.identity.parameters.separatorModel, 'model-bs-roformer-a.ckpt');
  assert.equal(b.identity.parameters.separatorModel, 'model-bs-roformer-b.ckpt');
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  const idOf = recipe => createHash('sha256').update(JSON.stringify(stable(recipe.identity))).digest('hex');
  assert.notEqual(idOf(a), idOf(b));
});

test('a render version mismatch is a clear pre-enqueue failure', async t => {
  const local = fakeLocal({ describeResult: { kind: 'describe', voiceId: '宵宫', renderVersion: 'ddsp63-changed', params: {} } });
  const h = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local });
  await assert.rejects(describeCover(h.family, h.source, 'local:宵宫'), error => {
    assert.equal(error.code, 'FAMILY_LOCAL_VERSION_MISMATCH');
    assert.match(error.message, /登记 ddsp63-x，钩子实际 ddsp63-changed/);
    return true;
  });
});

test('mother RVC identity stays field-by-field identical even with local.song active', async t => {
  const local = fakeLocal({});
  const h = await familyHarness(t, { registration: [{ id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-x' }], local });
  const recipe = await describeCover(h.family, h.source, 'synthetic-mother');
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const identity = stable(recipe.identity);
  assert.deepEqual(identity, {
    engine: 'c817f1f83f689ef72e0dfeb1c17ae990b9248506',
    parameters: { f0: 'rmvpe', indexRate: 0.5, instVolume: 0.8, pitch: 0, protect: 0.33, separatorModel: 'synthetic.onnx', vocalVolume: 1 },
    source: { id: 'synthetic-source', provider: 'netease' },
    version: 'family-full-song-v1',
    voice: { digest: 'a12b67560e94606043a1088547436537d8fd0f4e52ae3e107c575ee30a526700', role: 'mother' },
  });
  assert.equal(createHash('sha256').update(JSON.stringify(identity)).digest('hex'), GOLDEN_MOTHER_ID);
  assert.equal(local.calls.length, 0);
});

test('local entries persist, reuse and validate their voice id and render version on read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'family-local-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let renders = 0;
  const describe = async source => ({
    identity: { version: 'family-local-full-song-v1', source: { provider: 'netease', id: source.id },
      voice: { role: 'local', id: '宵宫', renderVersion: 'ddsp63-x' }, parameters: { pitch: 0 } },
    voiceName: '宵宫',
    render: async work => {
      renders++;
      const sourceFile = join(work, 'source.mp3'); const file = join(work, 'full.mp3');
      await writeFile(sourceFile, 'isolated full source'); await writeFile(file, 'isolated full converted audio');
      return { source: sourceFile, file, sourceDuration: 180, duration: 180.1 };
    },
  });
  const create = () => new SongLibrary({ root: join(root, 'library'), workRoot: join(root, 'work'), describe });
  const library = create();
  await library.open();
  library.addSources([{ id: 'synthetic-source', title: '隔离儿歌', artists: '隔离歌手', durationSec: 180 }]);
  const job = await library.request('synthetic-source', { mode: 'cover' });
  const entry = await library.wait(job.id);
  assert.match(entry.file, /隔离儿歌.*隔离歌手.*翻唱 宵宫.*\.mp3$/);
  assert.equal(entry.voiceName, '宵宫');
  assert.equal(renders, 1);
  const reopened = create();
  await reopened.open();
  const reused = await reopened.request('synthetic-source', { mode: 'cover' });
  assert.equal(reused.reused, true);
  assert.equal(reused.id, job.id);
  assert.equal(renders, 1);
  // 篡改渲染版本 → 读取校验拒绝，不覆盖原文件
  const metadata = JSON.parse(await readFile(join(library.metadataRoot, job.id + '.json'), 'utf8'));
  metadata.identity.voice.renderVersion = 'ddsp63-tampered';
  await writeFile(join(library.metadataRoot, job.id + '.json'), JSON.stringify(metadata), 'utf8');
  await assert.rejects(reopened.request('synthetic-source', { mode: 'cover' }), { code: 'FAMILY_CACHE_INVALID' });
});
