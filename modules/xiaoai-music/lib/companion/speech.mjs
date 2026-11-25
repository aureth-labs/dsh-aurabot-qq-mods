import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createIsolatedTTS, DialogueSpeechError, runSpeechProcess } from './tts.mjs';
export { DialogueSpeechError } from './tts.mjs';

const within = (root, file) => {
  const path = relative(root, file);
  return Boolean(path) && !isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../');
};

export function createDialogueSpeech(api, { workRoot, run = runSpeechProcess, fetchImpl = fetch,
  platform = process.platform, synthesize, probeDuration } = {}) {
  const root = workRoot ? resolve(workRoot) : null;
  const synth = synthesize || createIsolatedTTS(api, { run, fetchImpl, platform });
  function ffmpegFor(songConfig) {
    const { pathsOf, defaultRoot } = api.lib('song/studio.js');
    return pathsOf(songConfig.root || defaultRoot()).ffmpeg;
  }
  async function durationOf(file, songConfig) {
    try {
      if (probeDuration) return await probeDuration(file);
      const ffmpeg = ffmpegFor(songConfig);
      const probe = join(dirname(ffmpeg), platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      let hasProbe = false;
      try { hasProbe = (await stat(probe)).isFile(); } catch {}
      if (!hasProbe) {
        // AuraBot's installed song studio also reads metadata through ffmpeg.
        // The executor returns only the parsed numeric Duration, never stderr.
        const result = await run(ffmpeg, ['-hide_banner', '-i', file], { timeoutMs: 30000, readDuration: true });
        if (![0, 1].includes(result.code)) throw new Error();
        return result.duration;
      }
      const result = await run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeoutMs: 30000, captureOutput: true });
      if (result.code !== 0) throw new Error();
      return Number(String(result.out || '').trim());
    } catch { throw new DialogueSpeechError('DIALOGUE_AUDIO_INVALID'); }
  }
  return {
    async prepare(text, { leadInMs = 0 } = {}) {
      const clean = String(text || '').trim();
      if (!clean) throw new DialogueSpeechError('DIALOGUE_VOICE_CONFIG');
      if (!root) throw new DialogueSpeechError('DIALOGUE_WORK_FAILED');
      const config = api.config();
      const voice = structuredClone(config.voice || {});
      const songConfig = { root: config.song?.root || '' };
      const voiceId = String(voice.songVoice || '');
      let song;
      if (api.core?.local?.active?.('tts')) throw new DialogueSpeechError('DIALOGUE_LOCAL_TTS_UNSUPPORTED');
      if (voiceId) {
        try {
          song = api.use('song');
          if (typeof song?.convertSpeech !== 'function' || song.status().voices.filter(item => item.id === voiceId).length !== 1) throw new Error();
        } catch { throw new DialogueSpeechError('DIALOGUE_RVC_FAILED'); }
      }
      let dir;
      let realRoot;
      async function cleanup() {
        if (!dir) return;
        try {
          let target;
          try { target = await realpath(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
          if (!within(realRoot, target)) throw new Error();
          await rm(target, { recursive: true, force: true });
        } catch { throw new DialogueSpeechError('DIALOGUE_CLEANUP_FAILED'); }
      }
      try {
        try {
          await mkdir(root, { recursive: true });
          realRoot = await realpath(root);
          dir = await mkdtemp(join(realRoot, 'turn-'));
        } catch { throw new DialogueSpeechError('DIALOGUE_WORK_FAILED'); }
        const result = await synth(clean, voice, dir);
        let file = result.file;
        let conversion = 'not-requested';
        if (voiceId) {
          try {
            const rvcDir = join(dir, 'rvc');
            await mkdir(rvcDir);
            const converted = await song.convertSpeech(file, { voice: voiceId, pitch: Number(voice.songPitch) || 0, outDir: rvcDir });
            if (resolve(converted) === resolve(file)) throw new Error();
            file = converted;
            conversion = 'rvc';
          } catch { throw new DialogueSpeechError('DIALOGUE_RVC_FAILED'); }
        }
        try {
          file = await realpath(file);
          if (!within(dir, file) || (await stat(file)).size < 400) throw new Error();
        } catch { throw new DialogueSpeechError('DIALOGUE_AUDIO_INVALID'); }
        if (leadInMs > 0) {
          const padded = join(dir, 'leadin.wav');
          const result = await run(ffmpegFor(songConfig), ['-nostdin', '-hide_banner', '-loglevel', 'error',
            '-i', file, '-af', 'adelay=' + leadInMs + ':all=1', '-c:a', 'pcm_s16le', padded], { timeoutMs: 30000 });
          if (result.code !== 0 || (await stat(padded)).size < 400) throw new DialogueSpeechError('DIALOGUE_AUDIO_INVALID');
          file = padded;
        }
        const duration = await durationOf(file, songConfig);
        if (!Number.isFinite(duration) || duration <= 0) throw new DialogueSpeechError('DIALOGUE_AUDIO_INVALID');
        return { file, duration, requestedEngine: String(voice.engine || 'auto'), engine: result.engine,
          fallback: false, conversion, cleanup };
      } catch (error) {
        await cleanup();
        throw error instanceof DialogueSpeechError ? error : new DialogueSpeechError('DIALOGUE_TTS_FAILED');
      }
    },
  };
}
