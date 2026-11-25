// 语音点歌：搜原唱 → 主模型挑一首 → 下载 → 抽成 mp3 发语音条。

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { searchBili, resolveBili, downloadTo } from './providers/bilibili.js'
import { searchNetease, songUrlNetease } from './providers/netease.js'
import { findFfmpeg, extractAudio } from './audio/ffmpeg.js'
import { PlayCache, cacheKey, type PlaySource } from './cache/store.js'
import { resolveProxy } from './utils/fetch-race.js'

/** 插件扩展接口里用到的那部分，够用即可。 */
interface Api {
  id: string
  dir: string
  log: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void }
  config(): any
  settings(): Record<string, any>
  saveSettings(patch: Record<string, any>): Record<string, any>
  dataDir(...parts: string[]): string
  sendVoiceFile(chatId: string, file: string, note?: string): Promise<any>
  sendSegments(chatId: string, segments: any[], note?: string): Promise<any>
  onebot(action: string, params?: any, opts?: { timeoutMs?: number }): Promise<any>
  isOwner(userId: string | number): boolean
  tool(builder: any): () => void
  defineTool(spec: any): any
  rule(fn: any): () => void
  route(path: string, handler: (req: any, res?: any) => any): () => void
  on(event: string, fn: (...args: any[]) => any): () => void
  core: any
}

interface Settings {
  enabled: boolean
  source: PlaySource
  targetMinutes: number
  proxy: string
  ownerOnly: boolean
  commandEnabled: boolean
  commandName: string
  prompt: string
}

/** 默认的「给 AI 的提示词」。{{变量}} 运行时替换；用户可在面板里自己改。 */
const DEFAULT_PROMPT = [
  '你会点歌（只点原唱，不做翻唱/变声），当前搜索来源：{{source}}。',
  '有人想听歌（说「点歌 xxx / 放一首 xxx / 来首 xxx」）时：',
  '① 先调用 {{searchTool}}，song 填歌名（可带歌手）；',
  '② 拿到一张或多张候选表格后，你判断最像「原唱」的那一条，判断维度包括时长、发布者、标题/歌名，',
  '   调用 {{sendTool}}，传 platform（bilibili 或 netease，用英文名）和它的 id（哔哩哔哩填 BV 号，网易云填歌曲数字 id）；',
  '③ 插件会自动下载、转码并发语音条，下载通常要几十秒，期间可告诉对方稍等。',
  '用户直接给了 BV 号或网易云歌曲 id 时，可跳过搜索而直接 {{sendTool}}。一次只点一首。',
].join('\n')

const DEFAULTS: Settings = {
  enabled: true,
  source: 'both',
  targetMinutes: 10,
  proxy: '',
  ownerOnly: false,
  commandEnabled: true,
  commandName: 'music',
  prompt: DEFAULT_PROMPT,
}

const SOURCE_LABEL: Record<PlaySource, string> = {
  bilibili: '仅哔哩哔哩',
  netease: '仅网易云',
  both: '哔哩哔哩 + 网易云',
}

/** mm:ss 展示。 */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

/** 把文本里的 | 和换行处理掉，避免撑坏 Markdown 表格。 */
function esc(text: string): string {
  return String(text == null ? '' : text)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

export default {
  id: 'shangxue-playmusic',
  name: '语音点歌',
  version: '1.0.0',
  api: 1,
  description:
    '点歌：按配置在哔哩哔哩 / 网易云搜原唱，挑最优一首下载后抽成 mp3 发语音条（这是省算力的点歌通道，不占用唱歌/翻唱）',
  defaults: { ...DEFAULTS },
  settings: [
    {
      key: 'enabled',
      label: '总开关',
      type: 'switch',
      hint: '关掉后就没有「点歌」相关工具了',
    },
    {
      key: 'source',
      label: '搜索来源',
      type: 'select',
      options: [
        { value: 'bilibili', label: '仅哔哩哔哩' },
        { value: 'netease', label: '仅网易云' },
        { value: 'both', label: '哔哩哔哩 + 网易云' },
      ],
      hint: '决定去哪个平台搜原唱。每个平台最多返回 5 条，「哔哩+网易云」合计最多 10 条。',
    },
    {
      key: 'targetMinutes',
      label: '语音条最长时长（分钟）',
      type: 'number',
      hint: '截断到多少分钟（4~30，默认 10）。超过这个长度的歌只发前面这段。',
    },
    {
      key: 'proxy',
      label: '代理地址（可选）',
      type: 'text',
      hint:
        '留空 = 用内置 apifox 网络代理（https://web-proxy.apifox.cn）。插件会把「直连」和「走代理」两条路同时发出，' +
        '谁先返回有效结果就用谁。填 direct 表示只直连；填其它地址则用你自己的代理（apifox 地址走 POST 包装，其它地址按「代理前缀 + 原始完整网址」拼）。',
    },
    {
      key: 'ownerOnly',
      label: '仅主人可用',
      type: 'switch',
      hint: '默认关闭（谁都能点）。打开后只有主人能点歌。',
    },
    {
      key: 'commandEnabled',
      label: '注册单独的点歌指令',
      type: 'switch',
      hint: '打开后可以用「/指令名 歌名」直接点歌（不用等 AI）。默认开。',
    },
    {
      key: 'commandName',
      label: '点歌指令名',
      type: 'text',
      hint: '斜杠后面的词，默认 music（即 /music 晴天）。只填英文/数字，不带斜杠。',
    },
    {
      key: 'prompt',
      label: '给 AI 的提示词',
      type: 'textarea',
      hint:
        '可以自己改机器人点歌时给 AI 的说明。用 {{变量}} 替换，支持的变量：{{source}}（当前搜索来源，如「哔哩哔哩 + 网易云」）、' +
        '{{searchTool}}（搜索工具名）、{{sendTool}}（发送工具名）、{{perLimit}}（每平台返回条数，默认 5）。',
    },
  ],

  setup(api: Api) {
    const log = api.log
    const s = (): Settings => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const cache = new PlayCache(api.dataDir())

    /** 校验并取当前生效的参数（会夹到合法范围）。 */
    function effective(): { source: PlaySource; targetSec: number; proxy: string } {
      const st = s()
      const source: PlaySource = (['bilibili', 'netease', 'both'] as PlaySource[]).includes(st.source)
        ? st.source
        : 'both'
      const minutes = Math.max(4, Math.min(30, Math.round(Number(st.targetMinutes) || 10)))
      const targetSec = minutes * 60
      const proxy = String(st.proxy || '').trim()
      return { source, targetSec, proxy }
    }

    const PER_LIMIT = 5

    /** 按来源搜候选，分平台收集，方便各自渲染成一张表。 */
    async function searchAll(song: string): Promise<{
      bili: Awaited<ReturnType<typeof searchBili>>
      netease: Awaited<ReturnType<typeof searchNetease>>
      errors: string[]
    }> {
      const { source, proxy } = effective()
      const errors: string[] = []
      let bili: Awaited<ReturnType<typeof searchBili>> = []
      let netease: Awaited<ReturnType<typeof searchNetease>> = []
      const wantBili = source === 'bilibili' || source === 'both'
      const wantNetease = source === 'netease' || source === 'both'
      // 两个平台同时搜，每个平台内部再由 fetch-race 竞速直连与代理。
      const jobs: Array<Promise<void>> = []
      if (wantBili) {
        jobs.push(
          searchBili(song, { limit: PER_LIMIT, proxy }).then(
            (rows) => {
              bili = rows
            },
            (error) => {
              errors.push('哔哩：' + ((error && (error as Error).message) || error))
            },
          ),
        )
      }
      if (wantNetease) {
        jobs.push(
          searchNetease(song, { limit: PER_LIMIT, proxy }).then(
            (rows) => {
              netease = rows
            },
            (error) => {
              errors.push('网易云：' + ((error && (error as Error).message) || error))
            },
          ),
        )
      }
      await Promise.all(jobs)
      return { bili, netease, errors }
    }

    /** 把候选渲染成 Markdown 表格（哔哩：视频名称/UP主/时长/BV号；网易云：歌曲名称/作者/时长/id）。 */
    function renderBiliTable(rows: Awaited<ReturnType<typeof searchBili>>): string {
      const head = '| # | 视频名称 | UP主 | 时长 | BV号 |\n|---|---|---|---|---|'
      const body = rows
        .map((r, i) => `| ${i + 1} | ${esc(r.title)} | ${esc(r.author)} | ${fmtDur(r.duration)} | ${r.bvid} |`)
        .join('\n')
      return `${head}\n${body}`
    }

    function renderNeteaseTable(rows: Awaited<ReturnType<typeof searchNetease>>): string {
      const head = '| # | 歌曲名称 | 作者 | 时长 | id |\n|---|---|---|---|---|'
      const body = rows
        .map(
          (r, i) =>
            `| ${i + 1} | ${esc(r.name + (r.alias ? `（${r.alias}）` : ''))} | ${esc(r.artists)} | ${fmtDur(r.durationSec)} | ${r.id} |`,
        )
        .join('\n')
      return `${head}\n${body}`
    }

    /** 用 {{变量}} 替换用户可编辑的提示词。 */
    function renderPrompt(): string {
      const st = s()
      const tpl = String(st.prompt || DEFAULT_PROMPT)
      const src = SOURCE_LABEL[effective().source]
      return tpl
        .replace(/\{\{\s*source\s*\}\}/g, src)
        .replace(/\{\{\s*searchTool\s*\}\}/g, 'shangxue_playmusic_search')
        .replace(/\{\{\s*sendTool\s*\}\}/g, 'shangxue_playmusic_sendsong')
        .replace(/\{\{\s*perLimit\s*\}\}/g, String(PER_LIMIT))
    }

    if (!findFfmpeg()) {
      log.warn('[点歌] 没找到 ffmpeg，点歌会失败。设 PLAYMUSIC_FFMPEG 环境变量或把 ffmpeg 放进 PATH')
    }
    log.info('[点歌] 已启动，缓存目录：' + cache.dir)

    api.tool(({ chat, level }: any) => {
      if (!chat || chat.kind === 'system') return []
      const st = s()
      if (!st.enabled) return []
      if (st.ownerOnly && !(level === 'full' || api.isOwner(chat.userId))) return []
      return api.defineTool({
        name: 'shangxue_playmusic_search',
        description:
          '点歌第一步：按「歌名（可带歌手）」去配置好的平台（哔哩哔哩 / 网易云）搜原唱候选，只搜不下载。' +
          '每个平台最多返回 5 条，「哔哩+网易云」合计最多 10 条，以 Markdown 表格返回（哔哩：视频名称/UP主/时长/BV号；网易云：歌曲名称/作者/时长/id）。' +
          '拿到表格后，你判断最像用户想听的「原唱」那一条，调用 shangxue_playmusic_sendsong，传 platform（bilibili 或 netease）和它的 id（BV号 / 网易云歌曲id）去下载。' +
          '如果用户直接给了 BV 号（BV 开头）或网易云歌曲 id，可以跳过本工具，直接 sendsong。',
        properties: {
          song: { type: 'string', description: '歌名，可带歌手，例如「多幸运 韩雪」' },
        },
        required: ['song'],
        execute: async (args: any) => {
          const song = String((args && args.song) || '').trim()
          if (!song) return { ok: false, message: '没给歌名' }
          const { bili, netease, errors } = await searchAll(song)
          const total = bili.length + netease.length
          if (!total) {
            return {
              ok: false,
              message: `没搜到「${song}」的原唱候选` + (errors.length ? '（' + errors.join('；') + '）' : ''),
              errors,
            }
          }
          const parts: string[] = [`为「${song}」找到以下候选，挑最像原唱的那一条，把 platform 和它的 id 传给 shangxue_playmusic_sendsong：`]
          if (bili.length) {
            parts.push(`\n【哔哩哔哩】platform=bilibili（id 用 BV号）\n${renderBiliTable(bili)}`)
          }
          if (netease.length) {
            parts.push(`\n【网易云】platform=netease（id 用歌曲数字id）\n${renderNeteaseTable(netease)}`)
          }
          if (errors.length) parts.push(`\n（部分来源失败：${errors.join('；')}）`)
          return {
            ok: true,
            message: parts.join('\n'),
            bilibili: bili.length ? renderBiliTable(bili) : '',
            netease: netease.length ? renderNeteaseTable(netease) : '',
            errors,
          }
        },
      })
    })

    api.tool(({ chat, level }: any) => {
      if (!chat || chat.kind === 'system') return []
      const st = s()
      if (!st.enabled) return []
      if (st.ownerOnly && !(level === 'full' || api.isOwner(chat.userId))) return []
      return api.defineTool({
        name: 'shangxue_playmusic_sendsong',
        description:
          '点歌第二步：按 platform + id 下载这首歌（哔哩哔哩传 BV 号，网易云传歌曲数字 id），抽成 mp3 当语音条发到当前聊天。' +
          '一般先用 shangxue_playmusic_search 搜到候选、挑最合适的再把它的 platform 和 id 传进来。' +
          '下载+转换通常要几十秒。成功会返回歌名/歌手，并且语音条已经发到聊天里。',
        properties: {
          platform: { type: 'string', enum: ['bilibili', 'netease'], description: '哪个平台：bilibili 或 netease（英文名）' },
          id: { type: 'string', description: '哔哩哔哩填 BV 号（BV 开头）；网易云填歌曲数字 id' },
          title: { type: 'string', description: '可选，展示用歌名（不传就用解析出来的标题）' },
        },
        required: ['platform', 'id'],
        execute: async (args: any) => {
          const platform = String((args && args.platform) || '').trim() as 'bilibili' | 'netease'
          let key = String((args && args.id) || '').trim()
          if (platform !== 'bilibili' && platform !== 'netease') {
            return { ok: false, message: 'platform 只能是 bilibili 或 netease' }
          }
          if (!key) return { ok: false, message: '没给 id（BV 号 / 网易云歌曲 id）' }
          if (platform === 'bilibili') {
            const m = key.match(/BV[0-9A-Za-z]{10}/)
            if (m) key = m[0]
          }
          return playSong(api, cache, chat.chatId, platform, key, String((args && args.title) || ''), effective)
        },
      })
    })

    if (typeof (api as any).on === 'function') {
      try {
        api.on('message', async (msg: any) => {
          const st = s()
          if (!st.enabled || !st.commandEnabled) return false
          if (!msg || msg.kind === 'system') return false
          const name = String(st.commandName || 'music').trim().replace(/^[/／]/, '')
          if (!name) return false
          const text = String(msg.text || '').trim()
          const m = text.match(new RegExp('^[/／]\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([\\s\\S]*)$', 'i'))
          if (!m) return false
          const isOwnerNow = msg.kind === 'private' || api.isOwner(msg.userId)
          if (st.ownerOnly && !isOwnerNow) return false
          const song = String(m[1] || '').trim()
          if (!song) {
            await sendText(api, msg.chatId, `点歌用法：/${name} 歌名（可带歌手），例如 /${name} 晴天 周杰伦`)
            return true
          }
          await sendText(api, msg.chatId, `收到，去找《${song}》的原唱，下载要几十秒，稍等～`)
          const { bili, netease } = await searchAll(song)
          const pick = bili[0] || netease[0]
          if (!pick) {
            await sendText(api, msg.chatId, `没找到《${song}》的原唱，换个歌名再试试～`)
            return true
          }
          let r: any
          if (bili[0]) r = await playSong(api, cache, msg.chatId, 'bilibili', bili[0].bvid, bili[0].title, effective)
          else r = await playSong(api, cache, msg.chatId, 'netease', String(netease[0].id), `${netease[0].name} ${netease[0].artists}`.trim(), effective)
          if (r && r.ok === false) await sendText(api, msg.chatId, r.message || '点歌失败')
          return true
        })
      } catch (error) {
        log.warn('[点歌] 注册点歌指令失败：' + ((error && (error as Error).message) || error))
      }
    }

    try {
      api.rule((kind: string) => {
        const st = s()
        if (!st.enabled) return ''
        if (kind === 'social' && st.ownerOnly) return ''
        return renderPrompt()
      })
    } catch {
      /* 老接口没有 rule 就算了 */
    }

    try {
      api.route('/status', async () => {
        const bin = findFfmpeg()
        const eff = effective()
        return {
          ok: true,
          ffmpeg: bin || null,
          ffmpegOk: Boolean(bin),
          source: eff.source,
          sourceLabel: SOURCE_LABEL[eff.source],
          targetSec: eff.targetSec,
          targetMinutes: Math.round(eff.targetSec / 60),
          proxy: eff.proxy || null,
          proxyMode: resolveProxy(eff.proxy).kind,
          proxyChannels: resolveProxy(eff.proxy).channels,
          commandEnabled: Boolean(s().commandEnabled),
          commandName: String(s().commandName || 'music'),
        }
      })
    } catch (error) {
      log.warn('[点歌] 注册面板路由失败：' + ((error && (error as Error).message) || error))
    }

    return {
      /** 供测试 / 调试 */
      _cache: cache,
    }
  },
}

/** 给会话发一条纯文本（用于指令的提示语）。 */
async function sendText(api: Api, chatId: string, text: string): Promise<any> {
  try {
    if (typeof api.sendSegments === 'function') {
      const r = await api.sendSegments(chatId, [{ type: 'text', data: { text } }], '点歌')
      if (r) return r
    }
    if (chatId.startsWith('group:')) {
      await api.onebot('send_group_msg', { group_id: Number(chatId.slice(6)), message: [{ type: 'text', data: { text } }] })
    } else if (chatId.startsWith('private:')) {
      await api.onebot('send_private_msg', { user_id: Number(chatId.slice(8)), message: [{ type: 'text', data: { text } }] })
    }
    return true
  } catch (error) {
    api.log.warn('[点歌] 发文本失败：' + ((error && (error as Error).message) || error))
    return null
  }
}

/**
 * 核心：按 platform + id 下载并抽音发语音条到 chatId。
 * 工具和指令共用。返回 { ok, message, ... }。
 */
async function playSong(
  api: Api,
  cache: PlayCache,
  chatId: string,
  platform: 'bilibili' | 'netease',
  key: string,
  title: string,
  effective: () => { source: PlaySource; targetSec: number; proxy: string },
): Promise<any> {
  const { targetSec, proxy } = effective()
  const ck = cacheKey({ platform, key, targetSec, startSec: 0 })
  const hit = cache.get(ck)
  if (hit) {
    const sent = await sendVoice(api, chatId, hit, title)
    if (sent) return { ok: true, file: hit, cached: true, platform, key, title: title || '', message: '这首歌之前点过，直接发给你了' }
    return { ok: false, message: '语音条没发出去（可能网关没连上）' }
  }

  const out = cache.pathFor(ck)
  const { mkdirSync } = await import('node:fs')
  try {
    mkdirSync(join(out, '..'), { recursive: true })
  } catch {
    /* ignore */
  }
  const work = join(tmpdir(), 'shangxue-playmusic', randomUUID())
  try {
    let downloadUrl: string
    let resolvedTitle = String(title || '').trim()
    if (platform === 'bilibili') {
      const info = await resolveBili(key, { proxy })
      downloadUrl = info.url
      resolvedTitle = resolvedTitle || info.title
    } else {
      const info = await songUrlNetease(key)
      if (!info.url) {
        return { ok: false, message: '没拿到网易云的下载地址（完整音源的 Meting 后端暂时都不可用，稍后再试）' }
      }
      downloadUrl = info.url
    }
    const ext = platform === 'netease' ? '.mp3' : '.mp4'
    const srcFile = join(work, key.replace(/[^0-9A-Za-z]/g, '') + ext)
    await downloadTo(downloadUrl, srcFile)
    await extractAudio(srcFile, out, { startSec: 0, targetSec })
    const sent = await sendVoice(api, chatId, out, resolvedTitle)
    if (!sent) return { ok: false, message: '下载好了但语音条没发出去（可能网关没连上）' }
    return {
      ok: true,
      file: out,
      platform,
      key,
      title: resolvedTitle,
      message: `点歌成功：${resolvedTitle || key}，语音条已发到聊天`,
    }
  } catch (error) {
    return { ok: false, message: '点歌失败：' + ((error && (error as Error).message) || error) }
  } finally {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 把 mp3 当语音条发到会话；优先 sendVoiceFile（内部转 base64 发 record 段）。 */
async function sendVoice(api: Api, chatId: string, file: string, title?: string): Promise<any> {
  const note = title ? `[点歌] ${title}` : '[点歌]'
  try {
    if (typeof api.sendVoiceFile === 'function') {
      const r = await api.sendVoiceFile(chatId, file, note)
      if (r) return r
    }
    const { readFileSync } = await import('node:fs')
    const b64 = readFileSync(file).toString('base64')
    const seg = [{ type: 'record', data: { file: 'base64://' + b64 } }]
    if (chatId.startsWith('group:')) {
      await api.onebot('send_group_msg', { group_id: Number(chatId.slice(6)), message: seg }, { timeoutMs: 120000 })
    } else if (chatId.startsWith('private:')) {
      await api.onebot('send_private_msg', { user_id: Number(chatId.slice(8)), message: seg }, { timeoutMs: 120000 })
    }
    return true
  } catch (error) {
    api.log.warn('[点歌] 发语音条失败：' + ((error && (error as Error).message) || error))
    return null
  }
}
