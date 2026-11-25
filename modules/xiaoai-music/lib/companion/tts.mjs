// Synthesis branches adapted from AuraBot 1.1.24 src/voice/tts.js.
// Family output stays in the supplied turn directory. No installer, shared
// cache, global converter or fallback changes the requested voice.
import { spawn } from 'node:child_process';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const messages = {
  DIALOGUE_VOICE_CONFIG: '当前对话音色配置不可用。',
  DIALOGUE_ENGINE_UNAVAILABLE: '当前对话语音引擎不可用，未改用其他声音。',
  DIALOGUE_TTS_FAILED: '当前音色合成失败，未改用其他声音。',
  DIALOGUE_LOCAL_TTS_UNSUPPORTED: '当前本地语音脚本尚不支持家庭独立输出目录，请先在家庭模块完成适配。',
  DIALOGUE_RVC_FAILED: '选定的对话变声音色未完成，未改用其他声音。',
  DIALOGUE_AUDIO_INVALID: '对话音频或时长未通过检查。',
  DIALOGUE_WORK_FAILED: '对话临时目录不可用。',
  DIALOGUE_CLEANUP_FAILED: '对话临时文件未能清理。',
};

export class DialogueSpeechError extends Error {
  constructor(code) { super(messages[code] || messages.DIALOGUE_TTS_FAILED); this.code = code; }
}

export function runSpeechProcess(command, args, { input, timeoutMs = 60000, captureOutput = false, readDuration = false } = {}) {
  return new Promise(resolve => {
    let child;
    let out = '';
    let duration = null;
    let metadata = '';
    try {
      child = spawn(command, args, { windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    } catch { resolve({ code: -1, out }); return; }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', data => { if (captureOutput) out = (out + data).slice(0, 4096); });
    child.stderr.on('data', data => {
      if (!readDuration || duration !== null) return;
      const chunk = metadata + data;
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)(?:,|\s)/.exec(chunk);
      if (match) { duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]); metadata = ''; }
      else metadata = chunk.slice(-128);
    });
    child.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, duration }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input, 'utf8');
  });
}

export function createIsolatedTTS(api, { run = runSpeechProcess, fetchImpl = fetch, platform = process.platform } = {}) {
  async function saveAudio(bytes, sampleRate, dir) {
    const buffer = Buffer.from(bytes);
    if (buffer.length < 400) throw new DialogueSpeechError('DIALOGUE_TTS_FAILED');
    const isWav = buffer.toString('ascii', 0, 4) === 'RIFF';
    const isMp3 = buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
    const isOgg = buffer.toString('ascii', 0, 4) === 'OggS';
    let audio = buffer;
    if (!isWav && !isMp3 && !isOgg) {
      const { buildWav } = api.lib('voice/wav.js');
      audio = buildWav(new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2)), sampleRate);
    }
    const file = join(dir, 'tts.' + (isMp3 ? 'mp3' : isOgg ? 'ogg' : 'wav'));
    await writeFile(file, audio);
    return file;
  }
  async function fetchAudio(url, init) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new DialogueSpeechError('DIALOGUE_TTS_FAILED');
    return response.arrayBuffer();
  }
  return async function synthesize(text, config, dir) {
    try {
      const requested = String(config.engine || 'auto');
      let engine = requested;
      let edge;
      if (requested === 'edge' || requested === 'auto') {
        edge = api.lib('voice/tts.js');
        if (requested === 'auto') engine = edge.edgeInstalled() ? 'edge' : 'windows';
      }
      let file;
      if (engine === 'edge') {
        if (!edge.edgeInstalled()) throw new DialogueSpeechError('DIALOGUE_ENGINE_UNAVAILABLE');
        const python = platform === 'win32' ? join(edge.PYENV_DIR, 'Scripts', 'python.exe') : join(edge.PYENV_DIR, 'bin', 'python');
        file = join(dir, 'tts.mp3');
        const input = join(dir, 'speech.txt');
        await writeFile(input, text, 'utf8');
        const args = ['-I', '-m', 'edge_tts', '--voice', config.voice || 'zh-CN-XiaoyiNeural', '--file', input, '--write-media', file];
        if (config.rate && config.rate !== '+0%') args.push('--rate=' + config.rate);
        if (config.pitch && config.pitch !== '+0Hz') args.push('--pitch=' + config.pitch);
        if ((await run(python, args)).code !== 0) throw new DialogueSpeechError('DIALOGUE_TTS_FAILED');
      } else if (engine === 'windows') {
        if (platform !== 'win32') throw new DialogueSpeechError('DIALOGUE_ENGINE_UNAVAILABLE');
        file = join(dir, 'tts.wav');
        const script = '[Console]::InputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Speech;' +
          '$t=[Console]::In.ReadToEnd();$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
          "$zh=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;" +
          'if($zh){$s.SelectVoice($zh.VoiceInfo.Name)};' +
          "$s.SetOutputToWaveFile('" + file.replace(/'/g, "''") + "');$s.Speak($t);$s.Dispose()";
        if ((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: text })).code !== 0) {
          throw new DialogueSpeechError('DIALOGUE_TTS_FAILED');
        }
      } else if (engine === 'cosyvoice') {
        const c = config.cosyvoice || {};
        const base = String(c.url || '').replace(/\/+$/, '');
        if (!base) throw new DialogueSpeechError('DIALOGUE_VOICE_CONFIG');
        const instruct = c.mode === 'instruct' && c.instruct;
        const form = new URLSearchParams({ tts_text: text, spk_id: c.spkId || '中文女' });
        if (instruct) form.set('instruct_text', c.instruct);
        file = await saveAudio(await fetchAudio(base + '/' + (instruct ? 'inference_instruct' : 'inference_sft'), {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
        }), c.sampleRate || 22050, dir);
      } else if (engine === 'gptsovits') {
        const c = config.gptsovits || {};
        const base = String(c.url || '').replace(/\/+$/, '');
        if (!base) throw new DialogueSpeechError('DIALOGUE_VOICE_CONFIG');
        const q = new URLSearchParams({ text, text_lang: c.textLang || 'zh', ref_audio_path: c.refAudio || '',
          prompt_text: c.promptText || '', prompt_lang: c.promptLang || 'zh', media_type: 'wav' });
        file = await saveAudio(await fetchAudio(base + '/tts?' + q, { method: 'GET' }), 32000, dir);
      } else if (engine === 'http') {
        const template = String(config.http?.urlTemplate || '');
        if (!template.includes('{text}')) throw new DialogueSpeechError('DIALOGUE_VOICE_CONFIG');
        file = await saveAudio(await fetchAudio(template.split('{text}').join(encodeURIComponent(text)), { method: 'GET' }), 24000, dir);
      } else throw new DialogueSpeechError('DIALOGUE_VOICE_CONFIG');
      if ((await stat(file)).size < 400) throw new DialogueSpeechError('DIALOGUE_TTS_FAILED');
      return { file, engine };
    } catch (error) {
      throw error instanceof DialogueSpeechError ? error : new DialogueSpeechError('DIALOGUE_TTS_FAILED');
    }
  };
}
