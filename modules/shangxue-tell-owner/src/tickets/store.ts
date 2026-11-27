import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Ticket, TicketMedia } from './types.js'

export interface TicketStoreOptions {
  /** api.dataDir() 的路径 */
  dir: string
}

function safeMkdir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

/** 把任意文本转义成 md 里安全的一行（去掉换行，避免撑破表格）。 */
function oneLine(s: string): string {
  return String(s == null ? '' : s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()
}

function kindLabel(kind: string): string {
  if (kind === 'image') return '图片'
  if (kind === 'file') return '文件'
  if (kind === 'record') return '语音'
  if (kind === 'video') return '视频'
  if (kind === 'face') return '表情'
  return kind || '附件'
}

function statusLabel(status: Ticket['status']): string {
  if (status === 'done') return '✅ 已处理'
  if (status === 'closed') return '🔒 已关闭'
  return '🟡 待处理'
}

export class TicketStore {
  private dir: string
  private jsonPath: string
  private mdPath: string
  private mediaDir: string
  private tickets: Ticket[]
  private resetsPath: string
  private userResets: Record<string, number>

  constructor(opts: TicketStoreOptions) {
    this.dir = opts.dir
    safeMkdir(this.dir)
    this.mediaDir = join(this.dir, 'media')
    safeMkdir(this.mediaDir)
    this.jsonPath = join(this.dir, 'tickets.json')
    this.mdPath = join(this.dir, 'tickets.md')
    this.resetsPath = join(this.dir, 'feedback-resets.json')
    this.tickets = this.load()
    this.userResets = this.loadResets()
    // 启动时把 md 同步一遍，保证文件存在且格式正确
    this.flush()
  }

  get mediaPath(): string {
    return this.mediaDir
  }

  private load(): Ticket[] {
    if (existsSync(this.jsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.jsonPath, 'utf8'))
        if (Array.isArray(raw)) return raw as Ticket[]
      } catch (error) {
        // json 坏了就当作空，别让整个模块起不来
      }
    }
    return []
  }

  /** 下一个自增 id（按现有最大数字 +1）。 */
  nextId(): string {
    let max = 0
    for (const t of this.tickets) {
      const n = parseInt(t.id, 10)
      if (Number.isFinite(n) && n > max) max = n
    }
    return String(max + 1)
  }

  add(input: Omit<Ticket, 'id' | 'createdAt' | 'status'>): Ticket {
    const ticket: Ticket = {
      id: this.nextId(),
      createdAt: Date.now(),
      status: 'open',
      ...input,
    }
    this.tickets.push(ticket)
    this.flush()
    return ticket
  }

  get(id: string): Ticket | undefined {
    return this.tickets.find((t) => t.id === String(id))
  }

  /** 所有工单（按时间正序）。 */
  all(): Ticket[] {
    return this.tickets.slice()
  }

  /**
   * 面板用：按发起人聚合，列出每个发起者的今日反馈次数与来源信息。
   * dayStart/dayEnd 为当天 0 点与次日 0 点毫秒时间戳。
   */
  userSummaries(dayStart: number, dayEnd: number): Array<{
    userId: string
    nickname: string
    groups: string
    topics: string
    todayCount: number
    totalCount: number
    lastAt: number
  }> {
    const map = new Map<string, {
      userId: string
      nickname: string
      groupSet: Set<string>
      topics: string[]
      todayCount: number
      totalCount: number
      lastAt: number
    }>()
    for (const t of this.tickets) {
      const uid = String(t.userId)
      let agg = map.get(uid)
      if (!agg) {
        agg = { userId: uid, nickname: t.nickname || '', groupSet: new Set<string>(), topics: [], todayCount: 0, totalCount: 0, lastAt: 0 }
        map.set(uid, agg)
      }
      if (t.nickname) agg.nickname = t.nickname
      agg.groupSet.add(t.chatKind === 'group' ? `群 ${t.groupId}` : `私聊 ${t.userId}`)
      if (t.summary && agg.topics.length < 5) agg.topics.push(t.summary)
      agg.totalCount += 1
      if (t.createdAt > agg.lastAt) agg.lastAt = t.createdAt
    }
    const out: Array<{
      userId: string
      nickname: string
      groups: string
      topics: string
      todayCount: number
      totalCount: number
      lastAt: number
    }> = []
    for (const agg of map.values()) {
      const resetAt = this.userResets[agg.userId] || 0
      // 重置时刻用「严格大于」：同一毫秒内提交的工单也算重置之前，避免归零后仍显示 1 条。
      agg.todayCount = this.tickets.filter(
        (t) =>
          String(t.userId) === agg.userId &&
          t.createdAt >= dayStart &&
          t.createdAt < dayEnd &&
          (!resetAt || t.createdAt > resetAt),
      ).length
      out.push({
        userId: agg.userId,
        nickname: agg.nickname,
        groups: Array.from(agg.groupSet).join('、'),
        topics: agg.topics.join(' / '),
        todayCount: agg.todayCount,
        totalCount: agg.totalCount,
        lastAt: agg.lastAt,
      })
    }
    // 今日次数多的排前面，其次按最近活跃
    out.sort((a, b) => b.todayCount - a.todayCount || b.lastAt - a.lastAt)
    return out
  }

  /** 未处理的工单。 */
  open(): Ticket[] {
    return this.tickets.filter((t) => t.status === 'open')
  }

  /** 标记已处理：回群并回执。 */
  resolve(id: string, replyText: string): Ticket | undefined {
    const t = this.get(id)
    if (!t) return undefined
    t.status = 'done'
    t.resolvedAt = Date.now()
    t.replyText = replyText
    this.flush()
    return t
  }

  /** 关闭（不回复）。 */
  close(id: string): Ticket | undefined {
    const t = this.get(id)
    if (!t) return undefined
    t.status = 'closed'
    t.resolvedAt = Date.now()
    this.flush()
    return t
  }

  /**
   * 删除一张工单（任意状态都能删），并尽量清掉它的多媒体文件。
   * 返回被删掉的工单；不存在返回 undefined。
   */
  remove(id: string): Ticket | undefined {
    const idx = this.tickets.findIndex((t) => t.id === String(id))
    if (idx < 0) return undefined
    const [t] = this.tickets.splice(idx, 1)
    // 清 media 里的实体文件（清不掉也不影响工单删除）
    for (const m of t.media || []) {
      if (m.file) {
        try {
          const p = join(this.mediaDir, m.file)
          if (existsSync(p)) unlinkSync(p)
        } catch (error) {
          // 忽略删除失败
        }
      }
    }
    this.flush()
    return t
  }

  /**
   * 统计某用户在某自然日提交了几张工单（用于每日限额）。
   * 按用户（跨群）统计，dayStart/dayEnd 是当天 0 点与次日 0 点的毫秒时间戳。
   * 若对该用户做过「重置反馈次数」，重置时间之后的工单才计入。
   */
  countUserBetween(userId: string, dayStart: number, dayEnd: number): number {
    const resetAt = this.userResets[String(userId)] || 0
    return this.tickets.filter(
      (t) =>
        String(t.userId) === String(userId) &&
        t.createdAt >= dayStart &&
        t.createdAt < dayEnd &&
        (!resetAt || t.createdAt > resetAt),
    ).length
  }

  /** 重置某用户「今日已反馈次数」：记下重置时刻，之前的不再计入今天额度。 */
  resetUser(userId: string): void {
    this.userResets[String(userId)] = Date.now()
    this.flush()
  }

  private loadResets(): Record<string, number> {
    if (existsSync(this.resetsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.resetsPath, 'utf8'))
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, number>
      } catch (error) {
        // 坏了就当空
      }
    }
    return {}
  }

  /** 保存一个多媒体文件到 media/ 目录。返回保存后的文件名；失败返回空串。 */
  saveMedia(buffer: Buffer, filename: string): string {
    try {
      const target = join(this.mediaDir, filename)
      writeFileSync(target, buffer)
      return filename
    } catch (error) {
      return ''
    }
  }

  /** 从别处把已有文件复制进 media/。返回保存后的文件名；失败返回空串。 */
  copyMedia(sourcePath: string, filename: string): string {
    try {
      const target = join(this.mediaDir, filename)
      copyFileSync(sourcePath, target)
      return filename
    } catch (error) {
      return ''
    }
  }

  /** 生成 tickets.md 的 markdown 文本（人可读镜像）。 */
  renderMarkdown(): string {
    const lines: string[] = []
    lines.push('# 工单列表')
    lines.push('')
    lines.push('> 本文件由「转告主人反馈」插件自动维护，请勿手动修改；程序以同目录的 tickets.json 为准。')
    lines.push('')
    if (!this.tickets.length) {
      lines.push('（暂无工单）')
      lines.push('')
      return lines.join('\n')
    }
    const openCount = this.tickets.filter((t) => t.status === 'open').length
    lines.push(`共 ${this.tickets.length} 张，待处理 ${openCount} 张。`)
    lines.push('')
    lines.push('| # | 状态 | 时间 | 来源 | 发送者 | 内容 | 多媒体 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const t of this.tickets) {
      const time = new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })
      const from = t.chatKind === 'group' ? `群 ${t.groupId}` : `私聊 ${t.userId}`
      const who = `${oneLine(t.nickname || '')}(${t.userId})`
      const mediaText = t.media && t.media.length ? t.media.map((m) => kindLabel(m.kind)).join('、') : '—'
      lines.push(
        `| #${t.id} | ${statusLabel(t.status)} | ${oneLine(time)} | ${from} | ${who} | ${oneLine(t.summary || t.original)} | ${mediaText} |`,
      )
    }
    lines.push('')
    // 详细区：多媒体与处理回执
    const withDetail = this.tickets.filter(
      (t) => (t.media && t.media.length) || t.status === 'done' || t.original,
    )
    if (withDetail.length) {
      lines.push('## 详情')
      lines.push('')
      for (const t of withDetail) {
        lines.push(`### #${t.id} · ${statusLabel(t.status)}`)
        if (t.original && t.original !== t.summary) lines.push(`- 原话：${oneLine(t.original)}`)
        if (t.media && t.media.length) {
          for (const m of t.media) {
            lines.push(`- ${kindLabel(m.kind)}：${m.file ? `media/${m.file}` : oneLine(m.url)}`)
          }
        }
        if (t.status === 'done' && t.replyText) {
          const at = t.resolvedAt ? new Date(t.resolvedAt).toLocaleString('zh-CN', { hour12: false }) : ''
          lines.push(`- 处理回执（${at}）：${oneLine(t.replyText)}`)
        }
        lines.push('')
      }
    }
    return lines.join('\n')
  }

  /** 落盘：json（程序用）+ md（人看）。md 用「写临时再改名」避免半个文件。 */
  flush(): void {
    try {
      writeFileSync(this.jsonPath, JSON.stringify(this.tickets, null, 2), 'utf8')
    } catch (error) {
      // 写不进去也别抛，避免影响主流程
    }
    try {
      writeFileSync(this.resetsPath, JSON.stringify(this.userResets, null, 2), 'utf8')
    } catch (error) {
      // 忽略
    }
    try {
      const tmp = this.mdPath + '.tmp'
      writeFileSync(tmp, this.renderMarkdown(), 'utf8')
      renameSync(tmp, this.mdPath)
    } catch (error) {
      // 忽略
    }
  }
}
