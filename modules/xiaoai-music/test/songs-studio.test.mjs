import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

globalThis.aurabot = { src: new URL('../', import.meta.url), lib: key => {
  if (key === 'core/store.js') return {
    dataDir: () => { throw new Error('Must use the private work directory'); },
    readJson: (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback(),
    writeJson: (file, value) => writeFileSync(file, JSON.stringify(value)),
  };
  if (key === 'song/netease.js') return { searchSongs: async () => [], songUrl: async () => { throw new Error('No network in isolated test'); }, account: async () => ({}) };
  if (key === 'song/zip.js') return { readZip: () => [] };
  if (key === 'local/local.js') return { fileOf: r => (typeof r === 'string' ? r : r?.file || r?.output || '') };
  throw new Error('Unexpected internal dependency');
} };
const { createSongStudio, LOCAL_FULL_SONG_TASK } = await import('../lib/songs/studio.mjs');

async function harness(t, fullLength, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'family-studio-isolated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['env/Scripts/python.exe', 'env/Scripts/audio-separator.exe', 'Applio/core.py', 'bin/ffmpeg.exe',
    'Applio/rvc/models/predictors/rmvpe.pt', 'Applio/rvc/models/embedders/contentvec/pytorch_model.bin',
    'models/synthetic-mother.pth', 'separator-models/synthetic.onnx', 'input.mp3'];
  for (const name of files) { const file = join(root, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'isolated'); }
  const commands = [];
  t.mock.method(childProcess, 'spawn', (command, args) => {
    commands.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      if (command.endsWith('ffmpeg.exe') && !args.includes('-y')) {
        child.stderr.emit('data', Buffer.from(args.includes('volumedetect') ? 'mean_volume: -12.0 dB' : 'Duration: 00:03:30.00'));
      } else if (command.endsWith('audio-separator.exe')) {
        const dir = args[args.indexOf('--output_dir') + 1];
        writeFileSync(join(dir, 'synthetic_(Vocals).wav'), 'isolated vocals');
        writeFileSync(join(dir, 'synthetic_(Instrumental).wav'), 'isolated instrumental');
      } else {
        const output = command.endsWith('python.exe') ? args[args.indexOf('--output-path') + 1] : args.at(-1);
        writeFileSync(output, 'isolated converted audio');
      }
      child.emit('exit', 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const config = { song: { root, enabled: true, separatorModel: 'synthetic.onnx', voice: 'synthetic-mother',
    maxVoiceSec: 5, clipStart: 'head', pitch: 0, vocalVolume: 1, instVolume: 0.8, keepWork: true } };
  let sent;
  const delivered = new Promise(resolve => { sent = resolve; });
  const studio = createSongStudio({ getConfig: () => config, fullLength, workDir: join(root, 'private-work'),
    log: { info() {}, warn() {}, debug() {} }, sendVoiceFile: async () => sent(), sendText: async () => {}, ...extra });
  return { studio, commands, config, input: join(root, 'input.mp3'), delivered, root };
}

test('full family generation skips clipping, uses the explicit mother model and never sends QQ', async t => {
  const h = await harness(t, true);
  const before = JSON.stringify(h.config);
  const result = await h.studio.makeFull({ file: h.input, song: '隔离儿歌', voice: 'synthetic-mother', pitch: 0 });
  assert.equal(result.sourceDuration, 210);
  assert.equal(h.commands.some(value => value.args.includes('-ss') || value.args.includes('-t')), false);
  const conversion = h.commands.find(value => value.command.endsWith('python.exe'));
  assert.equal(conversion.args[conversion.args.indexOf('--pth-path') + 1].endsWith('synthetic-mother.pth'), true);
  assert.equal(JSON.stringify(h.config), before);
  await assert.rejects(h.studio.makeFull({ file: h.input, voice: 'missing-mother' }), /指定的家庭音色/);
});

test('the fork default request retains the original short QQ behavior', async t => {
  const h = await harness(t, false);
  assert.equal(h.studio.request({ file: h.input, voice: 'synthetic-mother', chatId: 'isolated-not-qq' }).ok, true);
  await h.delivered;
  const clipping = h.commands.find(value => value.args.includes('-ss'));
  assert.equal(clipping.args[clipping.args.indexOf('-t') + 1], '5');
});

function localHook({ active = true, result }) {
  const calls = [];
  return {
    calls,
    active: slot => slot === 'song' && active,
    call: async (slot, args) => {
      calls.push({ slot, args });
      if (args?.task === LOCAL_FULL_SONG_TASK) {
        if (result) return result(args);
        writeFileSync(args.output, Buffer.alloc(4096, 7));
        return { kind: 'master', file: args.output, voiceId: args.voiceId, renderVersion: args.renderVersion, params: { engine: 'ddsp', step: 50 } };
      }
      writeFileSync(args.output, 'isolated classic converted audio');
      return args.output;
    },
  };
}

test('local full generation uses the task marker, keeps the instrumental untouched and encodes the master once', async t => {
  const local = localHook({});
  const h = await harness(t, true, { local });
  const result = await h.studio.makeLocalFull({ file: h.input, song: '隔离儿歌', voiceId: '宵宫', renderVersion: 'ddsp63-x', pitch: 0 });
  assert.equal(result.sourceDuration, 210);
  assert.equal(result.duration, 210);
  assert.match(result.file, /master\.mp3$/);
  assert.equal(local.calls.length, 1);
  const args = local.calls[0].args;
  assert.equal(args.task, LOCAL_FULL_SONG_TASK);
  assert.equal(args.voiceId, '宵宫');
  assert.equal(args.renderVersion, 'ddsp63-x');
  assert.equal(args.pitch, 0);
  assert.equal(args.refSong, h.input);
  assert.match(args.vocal, /synthetic_\(Vocals\)\.wav$/);
  assert.match(args.inst, /synthetic_\(Instrumental\)\.wav$/);
  assert.match(args.output, /master\.wav$/);
  assert.equal(args.output.startsWith(result.file.replace(/master\.mp3$/, '')), true);
  // 没有 Applio 换声、没有小爱二次混音；只有一次 master.wav → master.mp3 编码
  assert.equal(h.commands.some(value => value.command.endsWith('python.exe') && value.args.includes('core.py')), false);
  assert.equal(h.commands.some(value => value.args.includes('amix')), false);
  const encodes = h.commands.filter(value => value.args.includes('-b:a') && value.args.at(-1) === result.file);
  assert.equal(encodes.length, 1);
});

test('non-master results, wrong voice, wrong version and outside files all fail the local branch', async t => {
  for (const [name, result, pattern] of [
    ['converted kind', () => ({ kind: 'converted', file: 'x' }), /未返回标记为 master/],
    ['wrong voice', args => { writeFileSync(args.output, Buffer.alloc(4096, 7)); return { kind: 'master', file: args.output, voiceId: 'other', renderVersion: 'ddsp63-x' }; }, /音色不一致/],
    ['wrong version', args => { writeFileSync(args.output, Buffer.alloc(4096, 7)); return { kind: 'master', file: args.output, voiceId: '宵宫', renderVersion: 'ddsp63-y' }; }, /渲染版本不匹配/],
  ]) {
    const local = localHook({ result });
    const h = await harness(t, true, { local });
    await assert.rejects(h.studio.makeLocalFull({ file: h.input, song: '隔离儿歌', voiceId: '宵宫', renderVersion: 'ddsp63-x', pitch: 0 }), pattern, name);
  }
  const outside = localHook({ result: args => {
    const outside = join(dirname(dirname(args.output)), 'outside.wav');
    writeFileSync(outside, Buffer.alloc(4096, 7));
    return { kind: 'master', file: outside, voiceId: '宵宫', renderVersion: 'ddsp63-x' };
  } });
  const h = await harness(t, true, { local: outside });
  await assert.rejects(h.studio.makeLocalFull({ file: h.input, song: '隔离儿歌', voiceId: '宵宫', renderVersion: 'ddsp63-x', pitch: 0 }), /成品不在任务目录内/);
});

test('non-zero pitch and a closed hook stop the local branch before calling the hook', async t => {
  const pitched = localHook({});
  const pitchHarness = await harness(t, true, { local: pitched });
  await assert.rejects(pitchHarness.studio.makeLocalFull({ file: pitchHarness.input, song: '隔离儿歌', voiceId: '宵宫', renderVersion: 'ddsp63-x', pitch: 3 }), /只支持原调/);
  assert.equal(pitched.calls.length, 0);
  const closed = localHook({ active: false });
  const closedHarness = await harness(t, true, { local: closed });
  await assert.rejects(closedHarness.studio.makeLocalFull({ file: closedHarness.input, song: '隔离儿歌', voiceId: '宵宫', renderVersion: 'ddsp63-x', pitch: 0 }), /钩子未开启/);
  assert.equal(closed.calls.length, 0);
});

test('a full generation with an active local hook keeps the classic hook call shape without a task marker', async t => {
  const local = localHook({});
  const h = await harness(t, true, { local });
  const result = await h.studio.makeFull({ file: h.input, song: '隔离儿歌', voice: 'synthetic-mother', pitch: 0 });
  assert.equal(result.sourceDuration, 210);
  assert.equal(local.calls.length, 1);
  const args = local.calls[0].args;
  assert.equal('task' in args, false);
  assert.equal(args.voice, 'synthetic-mother');
  assert.match(args.input, /synthetic_\(Vocals\)\.wav$/);
  assert.equal(args.voiceFile.endsWith('synthetic-mother.pth'), true);
  assert.equal(args.pitch, 0);
  // 走本地换声时不再调用 Applio python
  assert.equal(h.commands.some(value => value.command.endsWith('python.exe') && value.args.includes('core.py')), false);
});
