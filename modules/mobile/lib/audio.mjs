import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { failure } from './auth.mjs'

// Android records M4A; browsers also record WebM/Ogg. Choose a bounded set of
// demuxers from the bytes, keeping the existing ffmpeg protocol whitelist and
// controlled temporary path (never the filename supplied by the phone).
export function audioFormat(bytes) {
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'mov'
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska'
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'ogg'
  throw failure(400, 'invalid_audio', '需要 M4A、WebM、Ogg 或 WAV 语音')
}
export async function voiceWav(bytes, media, uploadDir) {
  if (bytes.subarray(0, 4).toString() === 'RIFF') {
    try {
      const wav = media.parseWav(bytes)
      if (!wav.data.length || wav.channels < 1 || wav.channels > 8 || wav.rate < 8000 || wav.rate > 192000 || wav.data.length / (2 * wav.channels * wav.rate) > 120) throw new Error()
      return media.toMono16k(bytes)
    } catch { throw failure(400, 'invalid_audio', 'WAV 格式不合法或超过 120 秒') }
  }
  const format = audioFormat(bytes)
  const ffmpeg = media.ffmpegPath()
  if (!ffmpeg) throw failure(503, 'audio_decoder_missing', '手机语音需要 ffmpeg，请在电脑配置现有 ffmpeg 路径')
  const dir = mkdtempSync(join(uploadDir, 'voice-'))
  const input = join(dir, 'audio.' + ({ mov: 'm4a', matroska: 'webm', ogg: 'ogg' })[format])
  try {
    writeFileSync(input, bytes, { mode: 0o600 })
    return await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input, '-t', '120', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks = []; let total = 0, settled = false
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(result) }
      const timer = setTimeout(() => { child.kill(); finish(failure(503, 'audio_timeout', '语音转换超时')) }, 15_000)
      child.stdout.on('data', (b) => { total += b.length; if (total > 4 * 1024 * 1024) { child.kill(); finish(failure(413, 'audio_too_long', '语音太长')) } else chunks.push(b) })
      child.stderr.on('data', () => {})
      child.on('error', () => finish(failure(503, 'audio_decoder_failed', '语音转换器无法启动')))
      child.on('close', (code) => finish(code || total < 44 ? failure(400, 'invalid_audio', '无法读取这段语音') : null, Buffer.concat(chunks)))
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
