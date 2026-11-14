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
  throw new Error('Unexpected internal dependency');
} };
const { createSongStudio } = await import('../lib/songs/studio.mjs');

async function harness(t, fullLength) {
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
    log: { info() {}, warn() {}, debug() {} }, sendVoiceFile: async () => sent(), sendText: async () => {} });
  return { studio, commands, config, input: join(root, 'input.mp3'), delivered };
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
