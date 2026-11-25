import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 点歌来源：仅哔哩 / 仅网易云 / 哔哩+网易云。 */
export type PlaySource = 'bilibili' | 'netease' | 'both'

/** 一条统一的候选（搜索阶段用，两个平台归一成同一种形状给主模型挑）。 */
export interface Candidate {
  /** 平台：bilibili / netease */
  platform: 'bilibili' | 'netease'
  /** 平台内唯一 key：BV 号 / 网易云歌曲 id */
  key: string
  title: string
  /** 歌手 / UP 主 */
  artist: string
  /** 时长（秒） */
  duration: number
  /** 播放量（bili）/ 0（netease） */
  play?: number
  /** 内部打分（不一定要展示） */
  score?: number
}

export interface PlayResult {
  ok: boolean
  file?: string
  title?: string
  artist?: string
  platform?: 'bilibili' | 'netease'
  key?: string
  cached?: boolean
  message?: string
}

export interface CacheKeyOptions {
  platform: string
  key: string
  targetSec: number
  startSec: number
}

/** 缓存键：md5(platform|key|targetSec|startSec)。 */
export function cacheKey(o: CacheKeyOptions): string {
  return createHash('md5')
    .update(`${o.platform}|${o.key}|${o.targetSec}|${o.startSec}`)
    .digest('hex')
}

/** 缓存目录管理。 */
export class PlayCache {
  readonly dir: string
  constructor(baseDir: string) {
    this.dir = join(baseDir, 'playmusic', 'cache')
    mkdirSync(this.dir, { recursive: true })
  }

  /** 命中返回文件绝对路径，否则 null。 */
  get(key: string): string | null {
    const p = join(this.dir, `${key}.mp3`)
    return existsSync(p) ? p : null
  }

  /** 产出文件的目标路径。 */
  pathFor(key: string): string {
    return join(this.dir, `${key}.mp3`)
  }
}
