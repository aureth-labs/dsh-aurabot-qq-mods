import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { createDialogueSpeech, DialogueSpeechError } from '../lib/companion/speech.mjs';

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'family-dialogue-speech-'));
  t.after(async () => {
    const path = relative(tmpdir(), dir);
    assert.ok(path && !isAbsolute(path) && !path.startsWith('..'));
    await rm(dir, { recursive: true, force: true });
  });
  const workRoot = join(dir, 'work');
  const config = { voice: { engine: 'edge', voice: 'isolated-tts', rate: '+0%', pitch: '+0Hz', songVoice: '', songPitch: 0 }, song: { root: join(dir, 'engine') } };
  await mkdir(join(config.song.root, 'bin'), { recursive: true });
  await writeFile(join(config.song.root, 'bin', 'ffprobe.exe'), 'isolated fake tool');
  const settings = {};
  const calls = [];
  const conversions = [];
  const voices = [{ id: 'wrong-first' }, { id: 'isolated-mother' }, { id: 'isolated-sister' }];
  const song = {
    status: () => ({ voices }),
    convertSpeech: async (input, selected) => {
      conversions.push({ input, ...selected });
      if (options.rvcFailure) throw new Error('private upstream path');
      const file = join(selected.outDir, 'output.wav');
      await writeFile(file, Buffer.alloc(600));
      return file;
    },
  };
  const api = {
    config: () => config, settings: () => settings, use: id => { assert.equal(id, 'song'); return song; },
    core: { local: { active: () => options.localActive === true } },
    lib: path => {
      if (path === 'voice/tts.js') return { PYENV_DIR: join(dir, 'python'), edgeInstalled: () => true,
        voiceConverters: [() => { throw new Error('shared converter must not run'); }] };
      if (path === 'song/studio.js') return { pathsOf: root => ({ ffmpeg: join(root, 'bin', 'ffmpeg.exe') }), defaultRoot: () => join(dir, 'unused') };
      throw new Error('unexpected library');
    },
  };
  const run = async (command, args, extra = {}) => {
    calls.push({ command, args, ...extra });
    if (args.includes('edge_tts')) {
      if (options.ttsFailure) throw new Error('https://private-service.invalid/secret');
      const file = args[args.indexOf('--write-media') + 1];
      await writeFile(file, Buffer.alloc(600));
    } else if (args.includes('adelay=750:all=1')) {
      await writeFile(args.at(-1), Buffer.alloc(800));
    } else if (command.endsWith('ffprobe.exe')) return { code: options.probeFailure ? 1 : 0, out: '1.25\n' };
    else throw new Error('unexpected process');
    return { code: 0, out: '' };
  };
  const speech = createDialogueSpeech(api, { workRoot, platform: 'win32', run, ...options.deps });
  return { dir, workRoot, config, settings, calls, conversions, voices, speech, api, run };
}

test('dialogue follows the default TTS without using a singing voice or global converter', async t => {
  const h = await harness(t);
  h.settings.dialogueVoice = 'retired-missing-family-model';
  const before = structuredClone(h.config);
  const result = await h.speech.prepare('隔离对话');
  assert.deepEqual({ requestedEngine: result.requestedEngine, engine: result.engine, fallback: result.fallback, conversion: result.conversion, duration: result.duration },
    { requestedEngine: 'edge', engine: 'edge', fallback: false, conversion: 'not-requested', duration: 1.25 });
  assert.deepEqual(h.config, before);
  assert.equal(h.conversions.length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(await readFile(join(dirname(result.file), 'speech.txt'), 'utf8'), '隔离对话');
  await result.cleanup();
  await result.cleanup();
  assert.deepEqual(await readdir(h.workRoot), []);
});

test('a wake acknowledgement measures the padded output that will be played', async t => {
  const h = await harness(t);
  const result = await h.speech.prepare('我在', { leadInMs: 750 });
  assert.equal(result.file, h.calls[1].args.at(-1));
  assert.equal(result.file, h.calls[2].args.at(-1));
  assert.match(result.file, /leadin\.wav$/);
  await result.cleanup();
});

test('a selected engine failure is fixed and cannot fall back to another engine or leak details', async t => {
  const h = await harness(t, { ttsFailure: true });
  await assert.rejects(h.speech.prepare('隔离失败'), error => {
    assert.ok(error instanceof DialogueSpeechError);
    assert.equal(error.code, 'DIALOGUE_TTS_FAILED');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.includes('edge_tts'), true);
  assert.deepEqual(await readdir(h.workRoot), []);
});

test('dialogue always follows the exact expression voice and ignores a legacy family override', async t => {
  const h = await harness(t);
  h.config.voice.songVoice = 'isolated-mother';
  h.config.voice.songPitch = 3;
  const before = structuredClone(h.config);
  const first = await h.speech.prepare('隔离默认');
  assert.equal(first.conversion, 'rvc');
  assert.equal(h.conversions[0].voice, 'isolated-mother');
  assert.equal(h.conversions[0].pitch, 3);
  h.settings.dialogueVoice = 'isolated-sister';
  const second = await h.speech.prepare('隔离妹妹');
  assert.equal(h.conversions[1].voice, 'isolated-mother');
  assert.notEqual(h.conversions[0].outDir, h.conversions[1].outDir);
  assert.deepEqual(h.config, before);
  await Promise.all([first.cleanup(), second.cleanup()]);
});

test('missing or failed RVC cannot silently use the first model or plain TTS', async t => {
  const missing = await harness(t);
  missing.config.voice.songVoice = 'not-installed';
  await assert.rejects(missing.speech.prepare('隔离缺失'), { code: 'DIALOGUE_RVC_FAILED' });
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.conversions.length, 0);
  const failed = await harness(t, { rvcFailure: true });
  failed.config.voice.songVoice = 'isolated-sister';
  await assert.rejects(failed.speech.prepare('隔离变声失败'), { code: 'DIALOGUE_RVC_FAILED' });
  assert.deepEqual(await readdir(failed.workRoot), []);
});

test('concurrent dialogue jobs use separate directories and cleanup leaves other resources intact', async t => {
  const h = await harness(t);
  await mkdir(h.workRoot, { recursive: true });
  const unrelated = join(h.workRoot, 'existing-resource.txt');
  await writeFile(unrelated, 'keep');
  const [a, b] = await Promise.all([h.speech.prepare('隔离甲'), h.speech.prepare('隔离乙')]);
  assert.notEqual(dirname(a.file), dirname(b.file));
  await a.cleanup();
  await access(b.file);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  await b.cleanup();
  assert.deepEqual(await readdir(h.workRoot), ['existing-resource.txt']);
});

test('unreadable audio duration cleans the job instead of claiming a playable result', async t => {
  const h = await harness(t, { probeFailure: true });
  await assert.rejects(h.speech.prepare('隔离时长'), { code: 'DIALOGUE_AUDIO_INVALID' });
  assert.deepEqual(await readdir(h.workRoot), []);
});

test('an active local TTS script is not executed or silently bypassed', async t => {
  const h = await harness(t, { localActive: true });
  await assert.rejects(h.speech.prepare('隔离本地'), { code: 'DIALOGUE_LOCAL_TTS_UNSUPPORTED' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.conversions.length, 0);
});

test('remote TTS branches retain their configured request and use only the turn directory', async t => {
  for (const engine of ['cosyvoice', 'gptsovits', 'http']) {
    const requests = [];
    const h = await harness(t, { deps: { fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(600)]), { status: 200 });
    } } });
    h.config.voice.engine = engine;
    h.config.voice[engine] = engine === 'http' ? { urlTemplate: 'http://127.0.0.1/isolated?text={text}' } : { url: 'http://127.0.0.1', spkId: 'isolated-speaker' };
    const result = await h.speech.prepare('隔离远程');
    assert.equal(result.engine, engine);
    assert.equal(result.fallback, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.method, engine === 'cosyvoice' ? 'POST' : 'GET');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].command.endsWith('ffprobe.exe'), true);
    await result.cleanup();
  }
});

test('an explicitly selected Windows engine passes text on stdin and reports Windows without fallback', async t => {
  const executions = [];
  const h = await harness(t, { deps: { run: async (command, args, options) => {
    executions.push({ command, args, options });
    if (command.endsWith('ffprobe.exe')) return { code: 0, out: '2' };
    assert.equal(command, 'powershell.exe');
    assert.equal(options.input, '隔离Windows');
    const script = args.at(-1);
    assert.equal(script.includes('隔离Windows'), false);
    const output = /SetOutputToWaveFile\('([^']+)'\)/.exec(script)[1];
    await writeFile(output, Buffer.alloc(600));
    return { code: 0, out: '' };
  } } });
  h.config.voice.engine = 'windows';
  const result = await h.speech.prepare('隔离Windows');
  assert.equal(result.engine, 'windows');
  assert.equal(result.fallback, false);
  assert.equal(executions.length, 2);
  await result.cleanup();
});

test('an in-flight voice uses its configuration snapshot and cannot overwrite later settings', async t => {
  const h = await harness(t);
  h.config.voice.songVoice = 'isolated-mother';
  h.config.voice.songPitch = 2;
  const speech = createDialogueSpeech(h.api, { workRoot: h.workRoot, platform: 'win32', run: async (...args) => {
    const result = await h.run(...args);
    if (args[1].includes('edge_tts')) {
      h.config.voice.songVoice = 'wrong-first';
      h.config.voice.songPitch = 12;
    }
    return result;
  } });
  const result = await speech.prepare('隔离快照');
  assert.equal(h.conversions[0].voice, 'isolated-mother');
  assert.equal(h.conversions[0].pitch, 2);
  assert.equal(h.config.voice.songVoice, 'wrong-first');
  assert.equal(h.config.voice.songPitch, 12);
  await result.cleanup();
});

test('an installation without ffprobe reuses ffmpeg numeric duration metadata without changing the voice engine', async t => {
  const h = await harness(t);
  await rm(join(h.config.song.root, 'bin', 'ffprobe.exe'));
  const speech = createDialogueSpeech(h.api, { workRoot: h.workRoot, platform: 'win32', run: async (command, args, options) => {
    if (command.endsWith('ffmpeg.exe')) {
      assert.equal(options.readDuration, true);
      assert.deepEqual(args.slice(0, 2), ['-hide_banner', '-i']);
      return { code: 1, duration: 2.5, out: '' };
    }
    return h.run(command, args, options);
  } });
  const result = await speech.prepare('隔离兼容');
  assert.equal(result.duration, 2.5);
  assert.equal(result.engine, 'edge');
  assert.equal(result.fallback, false);
  await result.cleanup();
});
