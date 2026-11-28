/**
 * 扩展模块「人格素材库」（persona-corpus）
 *
 * 要解决的问题很具体：群里有人说「你这句太人机了，收进反面素材」，
 * 她只能嘴上答应一句「好我记下了」，实际什么都没留下 —— 下次照样犯。
 *
 * 这个模块给她一本真能写、真能翻、别人也能用的素材本：
 *   原话（照抄）+ 为什么不对 + 换成她会怎么说
 * 落在主人指定的目录里（不填就是插件数据目录），旁边带一份给人看的 md 镜像。
 *
 * 分工：
 *   · 主人自己要求收的 —— 直接入库
 *   · 群里别人要求收的 —— 先进待审，主人过了才算入库（默认开，可关）
 *   · 不自动认人机味（那是 anti-bot 的活），这里只收「被点名的那一句」
 *
 * 文件结构：这个文件只放定义和接线，实现都在 lib/。
 */

import {
  KIND_LABEL,
  KINDS,
  MAX_PENDING,
  addEntry,
  makeEntry,
  normalizeKind,
  pickEntries,
  removeEntries,
  renderDigest,
  renderMarkdown,
  short,
  summarize,
} from './lib/corpus.js'
import { makeRing } from './lib/history.js'
import {
  filesIn,
  readCorpus,
  readPending,
  resolveDir,
  statOf,
  writeCorpus,
  writePending,
  writeText,
} from './lib/store.js'

/** 每轮塞给她的规则：她得知道「收了」这两个字后面必须有一次真的工具调用 */
const RULE = [
  '【人格素材】',
  '你有一本素材库。被人点名「这局人机味」「收录成反面」的时候，用 corpus_save 把那句原话收下来，别只在嘴上答应。',
  '一条素材三件事：原话（text，照抄不改）、为什么不对（note）、换成你会怎么说（fix）。fix 填了下次才真的用得上。',
  '主人要的收了就进库；群里别人要的会先进待审，主人过了才算数 —— 照工具返回的说法讲，别自己编条数。',
].join('\n')

const HELP = [
  '素材库用法：',
  '/素材 —— 看统计和待审',
  '/素材 过 all | 过 id1,id2 —— 通过待审',
  '/素材 删 id —— 删一条',
  '/素材 列出 [反面|正面|观察] —— 看最近 10 条',
  '/素材 目录 —— 素材存在哪、文件多大',
].join('\n')

export default {
  id: 'persona-corpus',
  name: '人格素材库',
  version: '1.0.0',
  api: 1,
  description: '把被人点名的人机味原话收成素材（原话 / 为什么 / 换成什么），落在主人指定的目录里，供自我反思时翻查',
  author: 'Aurabot contributors',
  license: 'MIT',

  defaults: {
    enabled: true,
    dir: '',
    maxEntries: 200,
    allowMemberAsk: true,
    injectDigest: true,
    digestLimit: 3,
  },
  settings: [
    { key: 'enabled', label: '素材库', type: 'switch', hint: '关掉以后工具只回「没开」，不写盘' },
    { key: 'dir', label: '素材目录', type: 'text', placeholder: 'D:\\aurabot-corpus', hint: '留空 = 插件数据目录。填绝对路径就写到那儿，不存在会自动建；填相对路径会回落到数据目录' },
    { key: 'maxEntries', label: '最多保留几条', type: 'number', min: 20, max: 2000, step: 20, hint: '超了从最旧的开始丢，默认 200' },
    { key: 'allowMemberAsk', label: '群友也能要求收录', type: 'switch', hint: '开着的时候群友的要求先进待审；关掉就只有主人能收' },
    { key: 'injectDigest', label: '每轮带素材提要', type: 'switch', hint: '只塞给主人那一轮（群聊不塞），带最近几条反面素材和待审数' },
    { key: 'digestLimit', label: '提要里列几条', type: 'number', min: 0, max: 10, step: 1, hint: '0 = 只报数字，默认 3' },
  ],

  setup(api) {
    const ring = makeRing({ limit: 15 })
    const settings = () => api.settings() || {}
    const enabled = () => settings().enabled !== false
    const isDryRun = () => Boolean(api.config()?.dryRun)
    const maxEntries = () => {
      const n = Number(settings().maxEntries)
      return Number.isFinite(n) ? Math.max(20, Math.min(2000, Math.trunc(n))) : 200
    }

    /** 素材往哪写：主人填了绝对路径用那个，否则插件数据目录。note 留着给 `/素材 目录` 解释为什么 */
    const where = () => resolveDir(settings().dir, api.dataDir())
    const files = () => {
      const f = filesIn(where().dir)
      return { dir: f.dir, corpusFile: f.corpus, pendingFile: f.pending, mirrorFile: f.mirror }
    }
    /** 每次都从磁盘读：主人可能手动改了 jsonl，或者另一个进程刚写过 */
    const readState = () => {
      const f = files()
      return { ...f, entries: readCorpus(f.corpusFile), pending: readPending(f.pendingFile) }
    }

    const writeMirror = (entries, pending) => {
      try {
        writeText(files().mirrorFile, renderMarkdown(entries, { pending: pending.length }))
      } catch (error) {
        // 镜像写不出来不该影响正本已经落盘这件事
        api.log.warn('写素材镜像失败：', error?.message || String(error))
      }
    }

    /**
     * 「这一轮是不是主人」—— 决定直接入库还是先进待审，也决定提要塞不塞。
     * 用 hub.turnSendersAllOwner：群里主人插了一句话也不会被群友带偏。
     */
    const ownerTurn = (sessionId) => {
      if (!sessionId) return false
      try {
        return api.core?.hub?.turnSendersAllOwner?.(sessionId) === true
      } catch {
        return false
      }
    }
    const ownerOf = (exec) => ownerTurn(exec?.sessionId || exec?.agent?.session?.id)

    const formatItem = (e) => ({
      id: e.id,
      kind: normalizeKind(e.kind),
      kindLabel: KIND_LABEL[normalizeKind(e.kind)],
      at: e.at || null,
      text: e.text,
      note: e.note || '',
      fix: e.fix || '',
      tags: Array.isArray(e.tags) ? e.tags : [],
      who: e.source?.who || 'member',
    })

    /**
     * 收一条的完整流程：校验 → 去重 → 分工（入库 / 待审 / 拒绝）。
     * 所有「写盘」都只发生在这里，工具和命令共用同一条路。
     */
    const record = (input, { owner, via = 'tool' } = {}) => {
      if (!enabled()) return { ok: false, message: '素材库现在关着（设置里打开「素材库」才能收）' }
      const entry = makeEntry({ ...input, via })
      if (!entry) return { ok: false, message: '没有原文就收不了：把那句话原样给我，或者给我消息 id' }

      const state = readState()
      const dup = [...state.entries, ...state.pending].find((e) => e.id === entry.id)
      if (dup) {
        const inLib = state.entries.some((e) => e.id === entry.id)
        return {
          ok: true,
          duplicate: true,
          id: entry.id,
          message: `这条${inLib ? '库里早就有' : '已经在待审里'}了（${KIND_LABEL[entry.kind]}素材），没重复收`,
        }
      }
      if (!owner && settings().allowMemberAsk === false) {
        return { ok: false, message: '主人没开群友收录，这条我不记' }
      }
      // 演练模式不落盘：不然模拟测试里的假消息会混进真素材
      if (isDryRun()) return { ok: false, dryRun: true, message: '现在是演练模式，这条只验了一遍，没落盘' }

      if (!owner) {
        const pending = [...state.pending, entry].slice(-MAX_PENDING)
        writePending(state.pendingFile, pending)
        return {
          ok: true,
          pending: true,
          id: entry.id,
          message: `先搁在待审里了（现在 ${pending.length} 条），主人过了才算入库`,
        }
      }

      const result = addEntry(state.entries, entry, { max: maxEntries() })
      writeCorpus(state.corpusFile, result.list)
      writeMirror(result.list, state.pending)
      const sameKind = result.list.filter((e) => normalizeKind(e.kind) === entry.kind).length
      const tail = result.dropped ? `（库满，丢掉了 ${result.dropped} 条最旧的）` : ''
      return {
        ok: true,
        id: entry.id,
        total: result.list.length,
        message: `收好了：「${short(entry.text, 40)}」 ${KIND_LABEL[entry.kind]}第 ${sameKind} 条${tail}`,
      }
    }

    /** 过审：待审里点名的那几条（或全部）进库 */
    const approve = (ids) => {
      const state = readState()
      if (!state.pending.length) return { ok: true, message: '待审是空的，没有要过的' }
      const all = ids.includes('all') || ids.includes('全部')
      const targets = all ? state.pending : state.pending.filter((e) => ids.includes(e.id))
      if (!targets.length) return { ok: false, message: `待审里没有这几条：${ids.join('、')}` }

      let list = state.entries
      let added = 0
      let dropped = 0
      for (const entry of targets) {
        const result = addEntry(list, entry, { max: maxEntries() })
        list = result.list
        dropped += result.dropped || 0
        if (result.ok) added += 1
      }
      const left = state.pending.filter((e) => !targets.includes(e))
      writeCorpus(state.corpusFile, list)
      writePending(state.pendingFile, left)
      writeMirror(list, left)
      return {
        ok: true,
        added,
        left: left.length,
        message: `过了 ${added} 条${dropped ? `，库满丢掉了 ${dropped} 条最旧的` : ''}；还剩 ${left.length} 条待审`,
      }
    }

    const drop = (ids) => {
      const state = readState()
      const all = ids.includes('all') || ids.includes('全部')
      const want = all ? state.pending.map((e) => e.id) : ids
      const result = removeEntries(state.pending, want)
      if (!result.removed) return { ok: false, message: '待审里没有这几条' }
      writePending(state.pendingFile, result.list)
      return { ok: true, removed: result.removed, message: `扔掉了 ${result.removed} 条；还剩 ${result.list.length} 条待审` }
    }

    // ---------- 最近消息：让她能说「就刚才那句」 ----------
    const offs = [
      api.on('message', (msg) => {
        if (!msg || !msg.chatId) return
        ring.push(msg.chatId, {
          who: 'in',
          text: msg.text,
          messageId: msg.messageId,
          userId: msg.userId,
          nickname: msg.nickname,
        })
      }),
      api.on('activity', (event) => {
        if (!event || event.kind !== 'out' || !event.chatId) return
        ring.push(event.chatId, { who: 'out', text: event.text })
      }),
    ].filter((off) => typeof off === 'function')
    if (offs.length) {
      api.onDispose?.(() => {
        for (const off of offs) {
          try {
            off()
          } catch {}
        }
      })
    }

    // ---------- 每轮提要（只给主人那一轮） ----------
    api.context(({ sessionId } = {}) => {
      if (!enabled() || settings().injectDigest === false) return ''
      if (!ownerTurn(sessionId)) return ''
      const limit = Number(settings().digestLimit)
      const state = readState()
      return renderDigest(state.entries, state.pending, { limit: Number.isFinite(limit) ? limit : 3 })
    })

    api.rule(RULE)

    // ---------- 工具 ----------
    api.tool(() => [
      api.defineTool({
        name: 'corpus_save',
        description:
          '把一句原话收进人格素材库：人机味/套话收成反面，好句子收成正面，顺手记下「为什么」和「换成你会怎么说」。被人点名收录时用它。',
        properties: {
          text: { type: 'string', description: '原话，照抄，别改写' },
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'negative 反面（别这么说）/ positive 正面（像她、值得学）/ note 观察。默认 negative',
          },
          note: { type: 'string', description: '为什么收它：人机味出在哪、好在哪' },
          fix: { type: 'string', description: '换成你会怎么说。反面素材填了这个，下次才用得上' },
          tags: { type: 'string', description: '标签，逗号或空格分开，最多 5 个' },
          messageId: { type: 'string', description: '可选：从最近消息里按 id 取原文（懒得抄的时候用）' },
          fromLast: { type: 'boolean', description: '可选：true 表示收这个聊天里最近一条' },
        },
        execute: async (args, exec) => {
          const chatId = String(exec?.chat?.chatId ?? '')
          let source = null
          let text = String(args?.text ?? '').trim()
          if (!text && args?.messageId) {
            source = ring.findByMessageId(chatId, args.messageId)
            if (!source) {
              return { ok: false, message: '最近消息里没有这个 id。把原话发给我，我照抄收进去' }
            }
            text = source.text
          }
          if (!text && args?.fromLast) {
            source = ring.at(chatId, 0)
            if (!source) return { ok: false, message: '这个聊天里我还没看到最近的消息，把原话发给我吧' }
            text = source.text
          }
          const owner = ownerOf(exec)
          return record(
            {
              kind: args?.kind,
              text,
              note: args?.note,
              fix: args?.fix,
              tags: args?.tags,
              source: {
                chatId,
                who: source ? (source.who === 'out' ? 'self' : 'member') : owner ? 'owner' : 'member',
                userId: source?.userId,
                nickname: source?.nickname,
              },
            },
            { owner, via: 'tool' },
          )
        },
      }),

      api.defineTool({
        name: 'corpus_list',
        description: '翻人格素材库（只有主人能用）：按类型或关键词找，做自我反思前先看看收过哪些反面。',
        properties: {
          kind: { type: 'string', enum: KINDS, description: '只看某一类' },
          q: { type: 'string', description: '关键词：原话、为什么、换成、标签都算' },
          limit: { type: 'number', description: '最多几条，默认 10，上限 50' },
        },
        execute: async (args, exec) => {
          if (!ownerOf(exec)) return { ok: false, message: '素材库只有主人能翻（里面有别人的原话）' }
          const state = readState()
          const items = pickEntries(state.entries, { kind: args?.kind, q: args?.q, limit: args?.limit })
          const summary = summarize(state.entries, state.pending)
          return {
            ok: true,
            total: summary.total,
            pending: summary.pending,
            count: items.length,
            items: items.map(formatItem),
            message: items.length ? `翻到 ${items.length} 条（库里共 ${summary.total} 条）` : '没翻到符合的素材',
          }
        },
      }),

      api.defineTool({
        name: 'corpus_review',
        description: '待审素材（只有主人能用）：list 列出来、approve 通过进库、drop 扔掉。群友要求收录的都先落在这里。',
        properties: {
          action: { type: 'string', enum: ['list', 'approve', 'drop'], description: '要做什么，默认 list' },
          ids: { type: 'string', description: 'approve / drop 时给 id，逗号分开；写 all 表示全部' },
        },
        execute: async (args, exec) => {
          if (!ownerOf(exec)) return { ok: false, message: '待审只有主人能处理' }
          const action = String(args?.action || 'list')
          if (action === 'list') {
            const state = readState()
            return {
              ok: true,
              pending: state.pending.length,
              items: state.pending.map(formatItem),
              message: state.pending.length ? `待审 ${state.pending.length} 条` : '待审是空的',
            }
          }
          const ids = String(args?.ids ?? '')
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
          if (!ids.length) return { ok: false, message: '要给 ids：一条或多条 id，写 all 表示全部' }
          return action === 'drop' ? drop(ids) : approve(ids)
        },
      }),
    ])

    // ---------- 主人命令 ----------
    api.command({
      name: '素材',
      aliases: ['corpus'],
      desc: '人格素材库：统计、待审、删条、看目录',
      run: (arg) => {
        const raw = String(arg ?? '').trim()
        const [verb, ...rest] = raw.split(/\s+/)
        const idsOf = (text) =>
          String(text ?? '')
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)

        if (!verb) {
          const state = readState()
          const summary = summarize(state.entries, state.pending)
          const lines = [
            `素材库：${summary.total} 条（反面 ${summary.negative} · 正面 ${summary.positive} · 观察 ${summary.note}），待审 ${summary.pending}`,
          ]
          if (!summary.total && !summary.pending) {
            lines.push('还空着。被人点名收录的时候她就往里写了。')
          } else {
            for (const entry of pickEntries(state.entries, { limit: 3 })) {
              lines.push(`· ${KIND_LABEL[normalizeKind(entry.kind)]} ${short(entry.text, 40)}`)
            }
            if (summary.pending) lines.push('待审：' + short(state.pending.slice(-1)[0]?.text, 40) + '（/素材 过 all 全过）')
          }
          lines.push('其它用法：/素材 过 | 删 | 列出 | 目录')
          return lines.join('\n')
        }

        if (verb === '过' || verb === '通过') {
          const ids = idsOf(rest.join(' '))
          if (!ids.length) return '要过哪几条？给 id，或者 /素材 过 all'
          return approve(ids).message
        }
        if (verb === '删' || verb === '删掉') {
          const ids = idsOf(rest.join(' '))
          if (!ids.length) return '要删哪条？给 id（/素材 列出 反面 里能看到）'
          const state = readState()
          const inLib = removeEntries(state.entries, ids)
          const inPending = removeEntries(state.pending, ids)
          if (!inLib.removed && !inPending.removed) return `没找到这几条：${ids.join('、')}`
          if (inLib.removed) {
            writeCorpus(state.corpusFile, inLib.list)
            writeMirror(inLib.list, inPending.list)
          }
          if (inPending.removed) writePending(state.pendingFile, inPending.list)
          return `删了 ${inLib.removed + inPending.removed} 条`
        }
        if (verb === '列出' || verb === '列表') {
          const word = String(rest[0] ?? '').trim()
          const kind = KINDS.find((k) => KIND_LABEL[k] === word || k === word)
          if (word && !kind) return '只认 反面 / 正面 / 观察（也可以写 negative / positive / note）'
          const state = readState()
          const items = pickEntries(state.entries, { kind, limit: 10 })
          if (!items.length) return '这一类还是空的'
          return items
            .map((e) => `· ${e.id} ${KIND_LABEL[normalizeKind(e.kind)]} ${short(e.text, 30)}${e.fix ? ` → ${short(e.fix, 20)}` : ''}`)
            .join('\n')
        }
        if (verb === '目录' || verb === '导出' || verb === '在哪') {
          const state = readState()
          const info = where()
          if (verb === '导出') writeMirror(state.entries, state.pending)
          const mirror = statOf(state.mirrorFile)
          const lines = [
            `素材目录：${info.dir}`,
            `（${info.note}）`,
            `corpus.jsonl：${state.entries.length} 条`,
            `pending.json：${state.pending.length} 条待审`,
            `corpus.md：${mirror ? `${Math.round(mirror.bytes / 1024 * 10) / 10} KB，刚重写过` : '还没生成（/素材 导出）'}`,
          ]
          return lines.join('\n')
        }
        return HELP
      },
    })

    // ---------- 给别的模块用 ----------
    const boot = readState()
    api.log.info(`人格素材库起来了：${boot.entries.length} 条素材 / ${boot.pending.length} 条待审，目录 ${boot.dir}`)

    return {
      /** 翻库：别的模块要反思素材时用这个 */
      list: ({ kind, q, limit } = {}) => pickEntries(readState().entries, { kind, q, limit: limit || 20 }),
      recent: (limit = 5) => pickEntries(readState().entries, { limit }),
      digest: (limit = 3) => {
        const state = readState()
        return renderDigest(state.entries, state.pending, { limit })
      },
      summary: () => {
        const state = readState()
        return summarize(state.entries, state.pending)
      },
      /** 程序化收录（别的模块替她收）：走和工具同一条路，按主人要求的处理 */
      save: (input) => record(input, { owner: true, via: 'module' }),
      info: () => ({ ...files(), note: where().note }),
    }
  },
}
