import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getVoiceOptions } from '../lib/companion/settings.mjs';
import { readLocalSongVoices, localVoicesFile, validLocalVoiceId, LOCAL_VOICE_PREFIX } from '../lib/songs/local-voices.mjs';

async function harness(t, registration) {
  const dataDir = await mkdtemp(join(tmpdir(), 'family-local-voices-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  if (registration !== undefined) await writeFile(join(dataDir, '本地整曲音色.json'), JSON.stringify(registration), 'utf8');
  const api = { dataDir: () => dataDir,
    config: () => ({ voice: { enabled: true, engine: 'edge', voice: 'Synthetic voice' }, song: { voice: '' } }),
    use: id => id === 'song' ? { status: () => ({ voices: [{ id: 'bb_mother_v1' }] }) } : null };
  return { api, dataDir };
}

test('missing registration file reads as an empty list without side effects', async t => {
  const h = await harness(t);
  const registry = readLocalSongVoices(h.api);
  assert.deepEqual(registry, { file: join(h.dataDir, '本地整曲音色.json'), entries: [], error: '' });
  const options = getVoiceOptions(h.api);
  assert.deepEqual(options.options.map(item => item.id), ['', 'bb_mother_v1']);
});

test('valid entries join the cover voice dropdown as local:<id> and never touch dialogue options', async t => {
  const h = await harness(t, [
    { id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-v1' },
    { id: 'qiqi', label: '七七', renderVersion: 'ddsp63-v2' },
    { id: '妈妈', label: '妈妈', renderVersion: 'example-rvc-v1' },
  ]);
  const options = getVoiceOptions(h.api);
  assert.deepEqual(options.options.map(item => item.id), ['', 'bb_mother_v1', 'local:宵宫', 'local:qiqi', 'local:妈妈']);
  assert.equal(options.options[1].label, '妈妈');
  assert.equal(options.options[2].label, '宵宫（本地整曲）');
  assert.equal(options.options[4].label, '妈妈（本地混音）');
  assert.equal(options.localVoices.entries.length, 3);
  assert.equal(options.localVoices.error, '');
  // 对话选项不受本地整曲登记影响
  assert.equal(options.dialogue.label, 'AuraBot表达模块的当前声音');
  assert.equal(JSON.stringify(options.options).includes('local:qiqi'), true);
  assert.equal(options.dialogue.label.includes('宵宫'), false);
});

test('invalid entries are skipped with a clear notice and the file path is reported', async t => {
  const h = await harness(t, [
    { id: '宵宫', label: '宵宫', renderVersion: 'ddsp63-v1' },
    { id: 'bad id!', label: 'Bad', renderVersion: 'v' },
    { id: 'nover', label: 'No version', renderVersion: '' },
    'not-an-object',
  ]);
  const options = getVoiceOptions(h.api);
  assert.deepEqual(options.options.map(item => item.id), ['', 'bb_mother_v1', 'local:宵宫']);
  assert.match(options.localVoices.error, /有 3 条登记格式无效/);
  assert.equal(options.localVoices.file, join(h.dataDir, '本地整曲音色.json'));
});

test('unreadable registration degrades to an empty list with an error message', async t => {
  const h = await harness(t, null);
  await writeFile(localVoicesFile(h.api), '{ not json', 'utf8');
  const options = getVoiceOptions(h.api);
  assert.deepEqual(options.options.map(item => item.id), ['', 'bb_mother_v1']);
  assert.match(options.localVoices.error, /不是有效 JSON/);
});

test('local voice prefix and id validation are stable', () => {
  assert.equal(LOCAL_VOICE_PREFIX, 'local:');
  assert.equal(validLocalVoiceId('宵宫'), true);
  assert.equal(validLocalVoiceId('qiqi_v2.1-x'), true);
  assert.equal(validLocalVoiceId('bad id'), false);
  assert.equal(validLocalVoiceId(''), false);
});
