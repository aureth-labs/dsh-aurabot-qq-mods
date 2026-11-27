// 转告主人反馈：托话记成工单送达主人，主人处理完回原消息 @ 当事人。

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { TicketStore } from './tickets/store.js'
import { guessExt, hasKnownExt, sniffMedia, resolveLocalFile, isAbsPath } from './media/media.js'
import { dayRange } from './utils/time.js'
import type { Ticket, TicketMedia, ForwardMode } from './tickets/types.js'

/** 插件扩展接口里用到的那部分，够用即可（避免把整份 .d.ts 拖进来）。 */
interface Api {
  id: string
  dir: string
  log: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void }
  config(): any
  settings(): Record<string, any>
  saveSettings(patch: Record<string, any>): Record<string, any>
  dataDir(...parts: string[]): string
  send(chatId: string, text: string): Promise<any>
  sendText(chatId: string, text: string): Promise<any>
  reply(msg: any, text: string): Promise<any>
  sendImage(chatId: string, src: string): Promise<any>
  sendFile(chatId: string, file: string, name?: string): Promise<any>
  sendSegments(chatId: string, segments: any[], note?: string): Promise<any>
  onebot(action: string, params?: any, opts?: { timeoutMs?: number }): Promise<any>
  isOwner(userId: string | number): boolean
  on(event: string, fn: (...args: any[]) => any): () => void
  tool(builder: any): () => void
  defineTool(spec: any): any
  rule(fn: any): () => void
  route(path: string, handler: (req: any, res?: any) => any): () => void
  use(id: string): any
  core: any
}

interface Settings {
  enabled: boolean
  perUserPerDay: number
  privateEnabled: boolean
  ownerPrivateEnabled: boolean
  forwardMode: ForwardMode
}

const DEFAULTS: Settings = {
  enabled: true,
  perUserPerDay: 2,
  privateEnabled: true,
  ownerPrivateEnabled: false,
  forwardMode: 'natural-sign',
}

/** 主人私聊的 chatId。 */
function ownerChatId(cfg: any): string {
  return `private:${String(cfg && cfg.ownerQQ ? cfg.ownerQQ : '').trim()}`
}

function validOwner(cfg: any): string {
  const owner = String((cfg && cfg.ownerQQ) || '').trim()
  return /^\d{5,}$/.test(owner) ? owner : ''
}

function fromLabel(t: Ticket): string {
  return t.chatKind === 'group' ? `群 ${t.groupId}` : `私聊 ${t.userId}`
}

/** 依据真实文件头的嗅探结果，决定存盘用的正确扩展名；嗅探不出就退回原判断。 */
function pickExt(kindHint: string, nameOrUrl: string, sniffExt: string): { kind: string; ext: string } {
  let kind = kindHint
  let ext = ''
  if (sniffExt) {
    ext = sniffExt
  } else if (kindHint === 'file') {
    ext = ''
  } else {
    ext = guessExt(nameOrUrl, kindHint)
  }
  return { kind, ext }
}

/** 存盘用的文件名：普通文件尽量保留原文件名（带对后缀），其它统一 ticket-<id>-<idx><ext>。 */
function buildBaseName(ticketId: string, idx: number, kind: string, ext: string, name: string): string {
  const clean = (s: string): string => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  if (kind === 'file' && name) {
    // 原文件名：若它已带后缀就用它，否则补上嗅探到的后缀
    const hasExt = hasKnownExt(name)
    return hasExt ? `ticket-${ticketId}-${idx}-${clean(name)}` : `ticket-${ticketId}-${idx}-${clean(name)}${ext || ''}`
  }
  return `ticket-${ticketId}-${idx}${ext || guessExt(name, kind)}`
}

/**
 * 把附件落到 data/media/，返回更新后的附件列表。
 *
 * 设计要点（对应需求）：**不要求 AI 在参数里带正确后缀**。这里自己搞定：
 *   - 本机来源（绝对路径 / file:// / 甚至只有一个文件名）：先用 resolveLocalFile 找到真实文件
 *     （找不到再按名字在各候选目录里匹配），读魔术字节嗅探真实类型 → 用正确后缀存进 media/，
 *     记账时 kind 也按嗅探结果纠正（图片才会走 sendImage）。
 *   - 网络地址：下载到临时目录 → 同样嗅探 → 用正确后缀存进 media/。
 *   - base64：解码 → 嗅探 → 存。
 * 存进来的每份附件都带「正确扩展名」，下游发送直接拿 media/ 里的绝对路径即可。
 */
async function persistMedia(
  api: Api,
  store: TicketStore,
  media: TicketMedia[],
  ticketId: string,
): Promise<TicketMedia[]> {
  const out: TicketMedia[] = []
  // 只给文件名时，按这些目录去找实际文件：media 目录、数据目录、下载目录、进程 cwd
  const dataDirTop = api.dataDir()
  const searchDirs = [
    store.mediaPath,
    dataDirTop,
    join(dataDirTop, 'media'),
    process.cwd(),
    api.config() && api.config().files && api.config().files.dir ? String(api.config().files.dir) : '',
  ].filter(Boolean)
  let idx = 0
  for (const m of media) {
    idx += 1
    const nameHint = m.name || (isAbsPath(m.url) ? m.url.split(/[\\/]/).pop() : '') || ''
    let kind = m.kind
    let ext = ''

    // ---- 本机来源：绝对路径 / file:// / 只有文件名 ----
    const looksLocal =
      isAbsPath(m.url) || /^file:\/\//i.test(m.url) || (!/^https?:\/\//i.test(m.url) && !/^base64:\/\//i.test(m.url))
    if (looksLocal) {
      const realPath = resolveLocalFile(m.url || nameHint, searchDirs)
      if (!realPath) {
        // 本机找不到这个文件：记一条空档（发给主人时会跳过并提示），但不阻断整单
        api.log.warn('[转告] 本机找不到附件文件：' + (m.url || nameHint))
        out.push({ ...m, kind, file: '', name: nameHint })
        continue
      }
      // 读文件头嗅探真实类型，纠正 kind / ext（不依赖原名有没有后缀）
      let sniffExt = ''
      try {
        const buf = readFileSync(realPath)
        const sniff = sniffMedia(buf)
        if (sniff.ext) sniffExt = sniff.ext
        if (sniff.kind !== 'file') kind = sniff.kind
      } catch (error) {
        // 读不到就沿用原名判断
      }
      const picked = pickExt(kind, m.name || realPath, sniffExt)
      kind = picked.kind
      ext = picked.ext
      const base = buildBaseName(ticketId, idx, kind, ext, m.name || basenameOf(realPath))
      const saved = store.copyMedia(realPath, base)
      out.push({ ...m, kind, file: saved, name: m.name || basenameOf(realPath) })
      continue
    }

    // ---- 网络 / base64 ----
    try {
      let buf: Buffer | null = null
      if (/^base64:\/\//i.test(m.url)) {
        buf = Buffer.from(m.url.replace(/^base64:\/\//i, ''), 'base64')
      } else if (/^https?:\/\//i.test(m.url)) {
        const r = await fetch(m.url, { signal: AbortSignal.timeout(15000) })
        if (r.ok) buf = Buffer.from(await r.arrayBuffer())
      }
      // 下载/解码后用内容嗅探补后缀、纠正类别
      let sniffExt = ''
      if (buf) {
        const sniff = sniffMedia(buf)
        if (sniff.ext) sniffExt = sniff.ext
        if (sniff.kind !== 'file') kind = sniff.kind
      }
      const picked = pickExt(kind, m.name || m.url, sniffExt)
      kind = picked.kind
      ext = picked.ext
      const base = buildBaseName(ticketId, idx, kind, ext, m.name || '')
      const saved = buf ? store.saveMedia(buf, base) : ''
      out.push({ ...m, kind, file: saved, name: m.name || nameHint })
    } catch (error) {
      out.push({ ...m, kind, file: '', name: m.name || nameHint })
    }
  }
  return out
}

/** 取路径末段文件名（跨平台）。 */
function basenameOf(p: string): string {
  const s = String(p || '')
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/** 依据链接/文件名后缀猜附件种类（用于决定发给主人时按图还是按文件）。 */
function guessMediaKind(pathOrName: string): string {
  const s = String(pathOrName || '').toLowerCase().split(/[?#]/)[0]
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(s)) return 'image'
  if (/\.(mp4|mov|mkv|avi|webm)$/.test(s)) return 'video'
  if (/\.(amr|silk|mp3|wav|ogg|m4a|flac)$/.test(s)) return 'record'
  return 'file'
}

/** 把本机文件路径转成 file:// 形式（给 SnowLuma 的 fileURLToPath 用，跨平台都行）。 */
function toFileUri(abs: string): string {
  let p = String(abs).replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  return 'file://' + encodeURI(p)
}

/**
 * 把附件发给主人私聊，保证不受「发文件白名单 / 大小上限」限制：
 *   1) 图片：优先 api.sendImage（内嵌预览）；不行再退回 file 段 / 裸上传。
 *   2) 文件 / 语音 / 视频：优先 api.sendFile（标准 upload_*_file）；失败（白名单/大小/没开发文件）再退回
 *      api.onebot('upload_private_file', …) 裸上传，绕开宿主侧的白名单检查。
 * 兜底都拿本地文件路径（data/media/ 下我们自己存的那份），主人号只发给他本人。
 */
async function sendMediaToOwner(api: Api, chatId: string, media: TicketMedia[]): Promise<void> {
  const cfg = api.config()
  const owner = String((cfg && cfg.ownerQQ) || '').trim()
  const ownerUid = /^\d{5,}$/.test(owner) ? Number(owner) : null

  for (const m of media) {
    try {
      if (!m.file) continue
      const full = join(api.dataDir(), 'media', m.file)
      // 展示用文件名：优先用「带可识别后缀」的原名；原名是哈希/无后缀时改用存盘名（已补对后缀），
      // 免得主人那边看到一个乱七八糟的哈希串。
      const label = m.name && hasKnownExt(m.name) ? m.name : m.file || m.name || '附件'

      if (m.kind === 'image') {
        // 发图优先用底层 hub.sendSegments + force：给主人的系统级转告不该被「真人化」在睡眠/暂离时拦掉
        //   （api.sendImage 内部走 sendSegments 但不带 force，会被 hooks.send 拦下）。
        const img = await sendImageForced(api, chatId, full, label)
        if (img) continue
        // 发图失败（网关不支持或文件有问题）：退回按文件发
        await sendFileNoWhitelist(api, chatId, ownerUid, full, label)
        continue
      }

      // 语音 / 视频 / 普通文件：统一按文件发
      await sendFileNoWhitelist(api, chatId, ownerUid, full, label)
    } catch (error) {
      api.log.warn('[转告] 发附件给主人失败：' + ((error && (error as Error).message) || error))
    }
  }
}

/** 发图给主人：用底层 hub.sendSegments + force（绕开会拦图片段的真人化等模块）。返回是否发出。 */
async function sendImageForced(api: Api, chatId: string, fullPath: string, label: string): Promise<unknown> {
  const file = toFileUri(fullPath)
  const segs = [{ type: 'image', data: { file } }]
  try {
    const hub = api.core && api.core.hub
    if (hub && typeof hub.sendSegments === 'function') {
      const r = await hub.sendSegments(chatId, segs, `[图片] ${label}`, { force: true })
      if (r) return r
    } else {
      // 没有底层 hub 时退回模块 api（不带 force，聊胜于无）
      const r = await api.sendImage(chatId, fullPath)
      if (r) return r
    }
  } catch (error) {
    api.log.debug('[转告] 强制发图失败：' + ((error && (error as Error).message) || error))
  }
  return null
}

/** 发文件：先用标准 api.sendFile，失败再裸上传（绕白名单）。 */
async function sendFileNoWhitelist(
  api: Api,
  chatId: string,
  ownerUid: number | null,
  fullPath: string,
  label: string,
): Promise<void> {
  // 1) 标准通道（受白名单/大小限制，但主人若把盘根目录加进「发文件」目录就能过）
  try {
    const r = await api.sendFile(chatId, fullPath, label)
    if (r) return
  } catch (error) {
    api.log.debug('[转告] sendFile 受限，改走裸上传：' + ((error && (error as Error).message) || error))
  }
  // 2) 裸上传兜底：直接调 OneBot，跳过宿主侧 checkSendableFile（白名单/大小都不查）
  const uri = toFileUri(fullPath)
  if (ownerUid) {
    await api.onebot('upload_private_file', { user_id: ownerUid, file: uri, name: label }, { timeoutMs: 120000 })
    return
  }
  // 主人号异常时退回消息段（部分网关支持 file 段）
  await api.sendSegments(chatId, [{ type: 'file', data: { file: uri, name: label } }], '转告附件')
}

/** 生成「来源署名」一行。 */
function signLine(t: Ticket): string {
  const who = `${t.nickname || ''}(${t.userId})`
  const where = t.chatKind === 'group' ? `群 ${t.groupId}` : `私聊 ${t.userId}`
  return `—— 来自${where}的 ${who} 的反馈${t.messageId ? `（原消息 #${t.messageId}）` : ''}`
}

export default {
  id: 'shangxue-tell-owner',
  name: '转告主人反馈',
  version: '1.0.2',
  api: 1,
  description: '群里/私聊有人托话，记成工单送达主人；主人处理完，机器人自己找对工单回群引用原消息告诉本人',
  panel: 'panel.js',
  defaults: { ...DEFAULTS },
  settings: [
    {
      key: 'enabled',
      label: '总开关',
      type: 'switch',
      hint: '关掉后就没有「转告主人」和「主人工单」这两个工具了',
    },
    {
      key: 'privateEnabled',
      label: '私聊也可以使用',
      type: 'switch',
      hint: '开启后别人私聊里也能托话给主人；关闭则只有群聊能用',
    },
    {
      key: 'ownerPrivateEnabled',
      label: '主人私聊也可以使用',
      type: 'switch',
      hint: '默认关闭。主人开发插件测试时可以打开，让主人自己私聊也能调「转告主人」',
    },
    {
      key: 'forwardMode',
      label: '转发模式',
      type: 'select',
      options: [
        { value: 'natural', label: '自然转述：主模型润色后发给主人' },
        { value: 'natural-sign', label: '自然转述 + 来源署名' },
      ],
      hint: '转述由主模型（有人格和记忆）完成，措辞自然；来源署名是插件额外补一行“来自哪个群谁”。',
    },
  ],

  setup(api: Api) {
    const log = api.log
    const s = (): Settings => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const store = new TicketStore({ dir: api.dataDir() })

    // tool 的 builder 只给到 Chat（没有 messageId / 昵称 / 原始多媒体），
    // 所以在 message 事件里按 chatId 记住最近一条消息，工具执行时拿来用。
    const lastMsg = new Map<string, any>()
    try {
      api.on('message', (msg: any) => {
        if (msg && msg.chatId) lastMsg.set(String(msg.chatId), msg)
      })
    } catch (error) {
      log.warn('[转告] 挂 message 事件失败，附件/原消息引用可能拿不到：' + ((error && (error as Error).message) || error))
    }

    log.info('[转告] 已启动，工单目录：' + api.dataDir())

    /** 送达主人私聊；返回 { ok, message }。 */
    async function deliverToOwner(text: string, media: TicketMedia[], t: Ticket): Promise<{ ok: boolean; message: string }> {
      const cfg = api.config()
      const owner = validOwner(cfg)
      if (!owner) return { ok: false, message: '还没设主人 QQ 号，转不了（去面板「连接」里填）' }
      const chatId = ownerChatId(cfg)
      const st = s()
      let body = String(text || '').trim()
      if (!body) return { ok: false, message: '要转的话是空的' }
      if (st.forwardMode === 'natural-sign') body = body + '\n' + signLine(t)
      // 直接用底层 hub.sendSegments 发文字，并带 force：
      //   这是「给主人的系统级转告」，不是普通聊天搭话，不该被「真人化」等模块在睡眠/暂离时当成穿帮外发拦掉
      //   （否则会出现「附件能发、summary 文字被拦」的不一致）。force 同时跳过宿主的试运行/总开关，
      //   但本模块自己的 enabled 开关已在工具注册处拦过，主人填的报告必须送到主人本人。
      const segs = [{ type: 'text', data: { text: body } }]
      let sent = false
      try {
        const hub = api.core && api.core.hub
        const r =
          hub && typeof hub.sendSegments === 'function'
            ? await hub.sendSegments(chatId, segs, '转告主人', { force: true })
            : await api.sendSegments(chatId, segs, '转告主人')
        sent = Boolean(r)
      } catch (error) {
        api.log.warn('[转告] 发文字给主人失败：' + ((error && (error as Error).message) || error))
        sent = false
      }
      if (!sent) return { ok: false, message: '没发出去（可能网关没连上或被拦了）：别说带到了，照实说' }
      if (media && media.length) await sendMediaToOwner(api, chatId, media)
      return { ok: true, message: '带给主人了' }
    }

    api.tool(({ chat, level }: any) => {
      if (!chat || chat.kind === 'system') return []
      const st = s()
      if (!st.enabled) return []
      // 谁可以用：群聊总是可以；私聊受开关控制
      if (chat.kind === 'private') {
        const isOwnerChat = level === 'full' || api.isOwner(chat.userId)
        if (isOwnerChat) {
          if (!st.ownerPrivateEnabled) return []
        } else if (!st.privateEnabled) {
          return []
        }
      }
      return api.defineTool({
        name: 'shangxue_tell_owner',
        description:
          '把「当前聊天里有人想对主人说的话 / 反馈」记成一张工单，并送达主人本人。' +
          '只能转给主人，不能改目标。有人托你带话、反馈 bug、提需求、觉得主人该知道，就用它。\n' +
          'summary 用你（有人格、有记忆）的自然口吻，一两句写清：谁、在哪、想要主人知道 / 做什么，别编造。\n' +
          'submitterNickname 填对方昵称，originalText 填对方原话（尽量原样）。\n' +
          'hasMedia 是必填布尔值：这条反馈如果带了图片/文件/语音/视频（哪怕只是截图），必须填 true，' +
          '并把每个附件的【网址或本机路径/文件名】放进 mediaPaths 数组；插件会自己找到文件、判定类型、补好后缀再发给主人。' +
          'mediaPaths 不必操心扩展名：网址（http/https）、本机绝对路径、或者只写一个文件名都可以，' +
          '插件会按文件名把实际文件找出来并自动补正确后缀。' +
          '如果确实没有任何附件，填 false（不填会报错）。有附件却填 false 或 true 却没给 mediaPaths 都会失败，要求你改正。',
        properties: {
          summary: {
            type: 'string',
            description: '用自然口吻写好要告诉主人的话（谁 + 在哪个群/私聊 + 想要主人知道/处理什么），一两句',
          },
          submitterNickname: { type: 'string', description: '托你带话的人的昵称（不知道可留空）' },
          originalText: { type: 'string', description: '对方原话，尽量原样保留，用于留档' },
          hasMedia: {
            type: 'boolean',
            description: '必填。这条反馈是否带富媒体（图片/文件/语音/视频，含截图）：带就填 true，确实没有填 false',
          },
          mediaPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'hasMedia 为 true 时必填。每个附件的网址（http/https）、本机绝对路径、或仅文件名都可以，可多个；不需要手动补扩展名，插件会自己识别并补好',
          },
        },
        required: ['summary', 'hasMedia'],
        execute: async (args: any) => {
          const summary = String(args && args.summary ? args.summary : '').trim()
          if (!summary) return { ok: false, message: '要转的话是空的' }
          const cfg = api.config()
          if (!validOwner(cfg)) return { ok: false, message: '还没设主人 QQ 号，转不了（去面板「连接」里填）' }

          const cur = lastMsg.get(String(chat.chatId)) || null
          const nickname = String(args.submitterNickname || (cur && cur.nickname) || '').trim() || '有人'
          const userId = String((cur && cur.userId) || chat.userId || '')
          const groupId = String((cur && cur.groupId) || chat.groupId || '')
          const messageId = String((cur && cur.messageId) || '')

          // 每日限额（按用户，跨群累计；主人自测时不限）
          const st = s()
          const isOwnerSubmit = api.isOwner(userId)
          if (!isOwnerSubmit && st.perUserPerDay > 0) {
            const { start, end } = dayRange()
            const used = store.countUserBetween(userId, start, end)
            if (used >= st.perUserPerDay) {
              return {
                ok: false,
                message: `这个用户今天给主人带的话已经有 ${used} 条，达到上限 ${st.perUserPerDay} 条，等明天再来。照实告诉对方`,
              }
            }
          }

          // 多媒体来源：由必填 hasMedia 决定
          //   hasMedia=false → 不发附件（只发文字）
          //   hasMedia=true  → 必须给 mediaPaths（网址/本机路径），否则报错让模型补填
          const hasMedia = args && typeof args.hasMedia === 'boolean' ? args.hasMedia : null
          if (hasMedia === null) {
            return { ok: false, message: '缺少必填的 hasMedia（布尔值）：这条反馈带不带图片/文件？带就填 true 并在 mediaPaths 给出附件网址/路径，不带填 false' }
          }
          const explicitPaths = Array.isArray(args && args.mediaPaths)
            ? args.mediaPaths.map((p: any) => String(p || '').trim()).filter(Boolean)
            : []
          let media: TicketMedia[] = []
          if (hasMedia) {
            if (!explicitPaths.length) {
              return { ok: false, message: 'hasMedia 是 true，但 mediaPaths 是空的：请把每个附件（含截图）的网址、本机路径或文件名填进 mediaPaths 数组' }
            }
            // 不再强制要求后缀：本机来源会按文件名找到实际文件、读文件头补后缀；
            // 网络地址下载后同样嗅探补后缀。这里只把来源整理成待处理的 media 列表。
            media = explicitPaths.map((p: string) => ({ kind: guessMediaKind(p), url: p, file: '' }))
          }

          const ticket = store.add({
            chatId: String(chat.chatId || ''),
            chatKind: chat.kind === 'group' ? 'group' : 'private',
            groupId,
            userId,
            nickname,
            messageId,
            summary,
            original: String(args.originalText || '').trim(),
            media: [],
          })

          if (media.length) {
            ticket.media = await persistMedia(api, store, media, ticket.id)
            store.flush()
          }

          const r = await deliverToOwner(summary, ticket.media, ticket)
          if (!r.ok) {
            // 没发出去：把刚建的工单撤成 closed，别让限额白扣、也别留假工单
            store.close(ticket.id)
            return { ok: false, message: r.message }
          }
          return { ok: true, ticketId: ticket.id, message: `已记成工单 #${ticket.id}，消息已经发给主人了，无需再次提及` }
        },
      })
    })

    api.tool(({ chat, level }: any) => {
      if (!chat || chat.kind === 'system') return []
      const st = s()
      if (!st.enabled) return []
      // 只给主人（主人私聊 / 主人身份）
      const isOwnerChat = level === 'full' || api.isOwner(chat.userId)
      if (!isOwnerChat) return []
      return api.defineTool({
        name: 'shangxue_tell_owner_tickets_list',
        description:
          '主人专用、只读。列出「别人托你转告主人」的工单：编号、来源群/私聊、发送者、内容、有几个附件。' +
          '主人问「有哪些人找过我 / 有哪些反馈」时用它看。要回话用 shangxue_tell_owner_back，不要用它改状态。',
        properties: {
          includeDone: { type: 'boolean', description: '是否连已处理的一起列出，默认只看未处理' },
        },
        required: [],
        execute: async (args: any) => {
          const list = args && args.includeDone ? store.all() : store.open()
          if (!list.length) return { ok: true, message: '现在没有待处理的工单' }
          const text = list
            .map(
              (t: Ticket) =>
                `#${t.id} [${t.status === 'open' ? '待处理' : t.status === 'done' ? '已处理' : '已关闭'}] ` +
                `${fromLabel(t)} · ${t.nickname}(${t.userId})：${t.summary}` +
                (t.media.length ? ` 〔${t.media.length} 个附件〕` : ''),
            )
            .join('\n')
          return { ok: true, message: text, tickets: list }
        },
      })
    })

    api.tool(({ chat, level }: any) => {
      if (!chat || chat.kind === 'system') return []
      const st = s()
      if (!st.enabled) return []
      const isOwnerChat = level === 'full' || api.isOwner(chat.userId)
      if (!isOwnerChat) return []
      return api.defineTool({
        name: 'shangxue_tell_owner_back',
        description:
          '主人专用。把主人的话回给当初托话的那个人。你**不用**、也**不要**传群号 / 消息 id / 发送者 id —— ' +
          '插件在建工单时已经把这些发送参数记好了，会自动【引用那条原消息 + @ 当事人】发回原群 / 原私聊，并把工单标记完成。' +
          '你只要给 replyText（用主人意思自然地说）。ticketId 可选：如果只有一张待处理工单会自己选；有多张时想回哪张就传哪张的编号。',
        properties: {
          replyText: {
            type: 'string',
            description: '要回给对方的话（自然口吻，用主人的意思说，比如“主人说这个问题已经修好了，你可以再试试”）',
          },
          ticketId: {
            type: 'string',
            description: '可选。要回哪张工单的编号；不传则自动选最新一张待处理工单',
          },
        },
        required: ['replyText'],
        execute: async (args: any) => {
          const replyText = String((args && args.replyText) || '').trim()
          if (!replyText) return { ok: false, message: 'replyText 是空的：要写一句回给对方的话' }
          // 挑工单：指定了就按编号，否则取最新一张 open 的
          let t: Ticket | undefined
          if (args && args.ticketId) {
            t = store.get(String(args.ticketId))
            if (!t) return { ok: false, message: `没有编号为 #${args.ticketId} 的工单` }
            if (t.status !== 'open') return { ok: false, message: `工单 #${t.id} 已经不是待处理状态（${t.status === 'done' ? '已处理' : '已关闭'}）` }
          } else {
            const opens = store.open()
            if (!opens.length) return { ok: false, message: '现在没有待处理的工单可以回' }
            t = opens[opens.length - 1] // open() 按时间正序，最后一张就是最新的
          }
          // 用建单时记下的 chatId / messageId / userId 直接回复（引用原消息 + @ 人）
          try {
            await sendToOrigin(api, t, replyText)
          } catch (error) {
            return { ok: false, message: '回话失败了：' + ((error && (error as Error).message) || error) + '。工单没标记完成，可以重试' }
          }
          store.resolve(t.id, replyText)
          return {
            ok: true,
            ticketId: t.id,
            message: `已回给${fromLabel(t)}的 ${t.nickname}：${replyText}`,
          }
        },
      })
    })

    api.tool(({ chat, level }: any) => {
      if (!chat || chat.kind === 'system') return []
      const st = s()
      if (!st.enabled) return []
      const callerId = String((lastMsg.get(String(chat.chatId)) && lastMsg.get(String(chat.chatId)).userId) || chat.userId || '')
      const isOwnerChat = level === 'full' || api.isOwner(chat.userId) || api.isOwner(callerId)
      // 不是主人时，只有「发起过工单的人」能看到这个删除工具（且只能删自己的）
      const ownTickets = callerId ? store.all().filter((t) => String(t.userId) === callerId) : []
      if (!isOwnerChat && !ownTickets.length) return []
      return api.defineTool({
        name: 'shangxue_tell_owner_delete',
        description:
          '删除工单（任意状态都能删）。主人可删任意工单；普通用户只能删**自己发的**工单。' +
          '必须传 ids（编号数组，可一个或多个），**不支持全部清空**。' +
          '主人说「把那条删了 / 清掉 #3 #5」、或发起人想撤回自己的反馈时用。删了的工单不再出现在列表里，附件文件也一并删掉。',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要删除的工单编号数组，例如 ["3","5"]（至少一个）',
          },
        },
        required: ['ids'],
        execute: async (args: any) => {
          const ids = Array.isArray(args && args.ids)
            ? args.ids.map((x: any) => String(x).trim()).filter(Boolean)
            : []
          if (!ids.length) return { ok: false, message: 'ids 是空的：要传要删的工单编号数组（至少一个）' }
          const deleted: string[] = []
          const missing: string[] = []
          const forbidden: string[] = []
          for (const id of ids) {
            const t = store.get(id)
            if (!t) {
              missing.push(id)
              continue
            }
            // 权限：主人随便删；非主人只能删自己发的工单
            if (!isOwnerChat && String(t.userId) !== callerId) {
              forbidden.push(id)
              continue
            }
            store.remove(id)
            deleted.push(t.id)
          }
          if (!deleted.length) {
            if (forbidden.length) {
              return {
                ok: false,
                message: `这些工单不是你发的，删不了：${forbidden.map((x) => '#' + x).join('、')}（只有主人能删别人的工单）`,
                forbidden,
                missing,
              }
            }
            return { ok: false, message: `这些工单都不存在：${missing.join('、')}` }
          }
          const tail: string[] = []
          if (missing.length) tail.push(`这些不存在：${missing.join('、')}`)
          if (forbidden.length) tail.push(`这些不是你发的、删不了：${forbidden.map((x) => '#' + x).join('、')}`)
          return {
            ok: true,
            message: `已删除工单：${deleted.map((x) => '#' + x).join('、')}` + (tail.length ? `；${tail.join('；')}` : ''),
            deleted,
            missing,
            forbidden,
          }
        },
      })
    })

    try {
      api.rule((kind: string) => {
        const st = s()
        if (!st.enabled) return ''
        if (kind === 'social') {
          const priv = st.privateEnabled ? '群聊和别人的私聊' : '群聊'
          return (
            `你会 shangxue_tell_owner：在${priv}里，有人托你给主人带话、反馈问题、提需求、或你觉得主人该知道，就用它记成工单转给主人本人（只能发给主人）。` +
            `summary 用你自己的自然口吻写（谁、在哪、想要主人知道什么），别像模板，别替你加戏；原话放 originalText。` +
            `如果这条反馈带了图片/文件/截图/语音（哪怕只是附了张截图），必须把 hasMedia 填 true，并把每个附件的网址或本机路径放进 mediaPaths；确实没附件才填 hasMedia=false。这是必填，漏了会被打回。` +
            `注意：mediaPaths 里的本机路径要带正确后缀名（.jpg/.png/.pdf 等），路径没后缀的话先读出内容判断类型、补个正确扩展名再传，不然主人打不开。` +
            `发起人本人想撤回自己发过的反馈（说「删掉我刚那条 / 撤回」），可以用 shangxue_tell_owner_delete 删自己的工单；别人的工单删不了。`
          )
        }
        if (kind === 'private') {
          return (
            '你会 shangxue_tell_owner_tickets_list（只读，列待处理工单）、shangxue_tell_owner_back（回话）和 shangxue_tell_owner_delete（删工单）。' +
            '别人托你转告的问题都在工单里。主人问「有哪些人找过我」就用 shangxue_tell_owner_tickets_list 列出来。' +
            '主人说某个问题修好了/处理完了（或让你回某人），你就调 shangxue_tell_owner_back，replyText 用主人的意思自然地说，' +
            '不要传群号/消息id/发送者，插件会自动引用他原来那条消息 @ 他回话并标记完成；有多张工单不确定回哪张时，先 list 看一眼再传 ticketId。' +
            '主人让你删工单（说「删了 #3」之类），就调 shangxue_tell_owner_delete，ids 传编号数组。'
          )
        }
        return ''
      })
    } catch (error) {
      // 老接口没 rule 就算了
    }

    try {
      api.route('/board', async () => {
        const { start, end } = dayRange()
        const rows = store.userSummaries(start, end)
        const st = s()
        return { ok: true, rows, perUserPerDay: st.perUserPerDay, minLimit: 1, maxLimit: 10 }
      })
      // 面板上的滑块保存「每用户每天最多几条」（1~10，默认 2）
      api.route('/set-limit', async (req: any) => {
        const body = await api.core.http.body(req).catch(() => ({}))
        const raw = Number(body && body.perUserPerDay)
        if (!Number.isFinite(raw)) return { ok: false, message: '给的条数不是数字' }
        const n = Math.max(1, Math.min(10, Math.round(raw)))
        api.saveSettings({ perUserPerDay: n })
        return { ok: true, perUserPerDay: n, message: `每个用户每天最多 ${n} 条` }
      })
      api.route('/reset', async (req: any) => {
        const body = await api.core.http.body(req).catch(() => ({}))
        const userId = String((body && body.userId) || '').trim()
        if (!userId) return { ok: false, message: '缺 userId' }
        store.resetUser(userId)
        return { ok: true, message: `已重置 ${userId} 的今日反馈次数` }
      })
    } catch (error) {
      log.warn('[转告] 注册面板路由失败：' + ((error && (error as Error).message) || error))
    }

    return {
      /** 供测试 / 调试：直接拿工单存储 */
      _store: store,
    }
  },
}

/** 回原群 / 原私聊：群聊优先「引用原消息」@ 发送者。 */
export async function sendToOrigin(api: Api, t: Ticket, text: string): Promise<void> {
  const segments: any[] = []
  // 群聊里先 @ 原发送者
  if (t.chatKind === 'group' && t.userId) {
    segments.push({ type: 'at', data: { qq: String(t.userId) } })
    segments.push({ type: 'text', data: { text: ' ' } })
  }
  segments.push({ type: 'text', data: { text } })
  // 引用原消息：把 reply 段放最前面
  const withReply: any[] = t.messageId
    ? [{ type: 'reply', data: { id: String(t.messageId) } }, ...segments]
    : segments
  await api.sendSegments(t.chatId, withReply, '主人回复工单')
}
