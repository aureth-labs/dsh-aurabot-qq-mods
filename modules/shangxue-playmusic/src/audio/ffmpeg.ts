// ffmpeg 定位顺序：环境变量 → 常见路径 → PATH。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 候选可执行文件（第一个存在的就用；'ffmpeg' 表示走 PATH）。 */
function candidates(): string[] {
  return [
    process.env.PLAYMUSIC_FFMPEG,
    process.env.AURABOT_FFMPEG,
    'F:/server/software_apps/ffmpeg/bin/ffmpeg.exe',
    'D:/server/RVA-aurabot/bin/ffmpeg.exe',
    'D:/server/RVC-aurabot/bin/ffmpeg.exe',
    'D:/server/rvc-cover/bin/ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ].filter((p): p is string => Boolean(p))
}

let cached: string | null | undefined

/** 找到 ffmpeg 可执行文件；找不到返回 null。结果缓存。 */
export function findFfmpeg(): string | null {
  if (cached !== undefined) return cached
  cached = candidates().find((p) => p === 'ffmpeg' || existsSync(p)) || null
  return cached
}

/** 清掉缓存（测试时用）。 */
export function resetFfmpegCache(): void {
  cached = undefined
}

/** 跑一条 ffmpeg 命令；成功 resolve，失败 reject（带最后一段 stderr）。 */
export function runFfmpeg(bin: string, args: string[], timeoutMs = 180_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      reject(new Error('ffmpeg 超时'))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`ffmpeg 失败（${code}）：${err.slice(-300)}`))
    })
  })
}

export interface ExtractOptions {
  /** 从第几秒开始截（跳过片头口播），默认 0 */
  startSec?: number
  /** 截断到多少秒，默认 240 */
  targetSec?: number
}

/**
 * 把一个视频/音频文件抽成单声道 mp3（44100Hz / 128kbps）。
 * @returns 产出文件路径（即 output）
 */
export async function extractAudio(input: string, output: string, opts: ExtractOptions = {}): Promise<string> {
  const bin = findFfmpeg()
  if (!bin) throw new Error('找不到 ffmpeg，设 PLAYMUSIC_FFMPEG 环境变量指过去（或者装到 PATH 里）')
  const startSec = Math.max(0, Number(opts.startSec || 0))
  const targetSec = Math.max(10, Math.min(600, Number(opts.targetSec || 240)))
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (startSec > 0) args.push('-ss', String(startSec))
  args.push('-t', String(targetSec), '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', output)
  await runFfmpeg(bin, args)
  if (!existsSync(output)) throw new Error('ffmpeg 没有产出音频')
  return output
}
