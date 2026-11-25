/**
 * roast-mode —— 毒舌模式
 * 作用：主人发关键字开/关某个聊天的「毒舌模式」；开着时按设定接管消息，
 *      从语料抽一句损友式吐槽回过去（引用回复）。语料默认内置预设，
 *      可打开「读文本文件」开关改读数据目录的 corpus.txt（每行一句）。
 * 契约：扩展接口 v1（api: 1）；capabilities: filesystem（读写语料文件）+ process（面板按钮调资源管理器打开语料文件夹）。
 * 数据：状态存 api.dataDir('state.json')，语料文件 api.dataDir('corpus.txt')。
 *      模块源码目录不写任何运行数据。
 * 风格：只做损友式调侃/优雅毒舌，不产辱骂、脏话与针对性攻击内容。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 内置预设语料：损友式吐槽，健康向 */
const DEFAULT_LINES = [
  '你这脑子今天是不是忘记充电了？',
  '就这？我还以为能听到点新鲜的呢。',
  '你这发言，评论区看了都要叹气。',
  '行行行，你说得都对，下次继续。',
  '你这操作我愿称之为「迷惑行为大赏」冠军。',
  '别说了，再说下去我都要替你尴尬了。',
  '你这水平，建议回炉重造，记得带保修。',
  '我沉默不是无话可说，是不知道从哪吐槽起。',
  '你这逻辑跳跃得，刘翔看了都想拜师。',
  '好好好，这么玩是吧，我记小本本上了。',
  '你这话说得，连 Siri 都想装听不见。',
  '建议把这条消息裱起来，警示后人。',
  '你这不叫想法，叫一闪而过的念头。',
  '我的嘴替今日休息，先给你记一笔账。',
  '就你这战术水平，团战第一个倒下的就是你。',
  '你这波操作，反向教学都不配上镜。',
  '听得进去就改，听不进去……那你也改。',
  '你这脑回路，导航都得重新规划路线。',
  '别急，让子弹再飞一会儿，反正也打不中。',
  '你这发言，建议自带降噪耳机再发一遍。',
]

/** 语料文件模板（首次自动写到数据目录，用户可随便改） */
const CORPUS_TEMPLATE = [
  '# 毒舌模式语料：每行一句，# 开头的行是注释会被忽略，空行忽略。',
  '# 文件位置由面板显示；改完保存即可，模块每次发言前都会重新读。',
  ...DEFAULT_LINES,
].join('\n') + '\n'

/** 语料文件上限：超过 1MB 拒绝读入（防一个巨大的语料文件拖垮内存），回落内置预设 */
const MAX_CORPUS_BYTES = 1024 * 1024
/** 单行长度上限：超长行截断（防单行灌满上下文） */
const MAX_LINE_CHARS = 500
/** 总行数上限：超出部分丢弃（防行数爆炸） */
const MAX_LINES = 5000

/** 模块设置表单（面板自动生成） */
const SETTINGS = [
  { key: 'onKeyword', label: '开启关键字', type: 'text', hint: '在这个聊天里发它就开毒舌模式', placeholder: '毒舌开启' },
  { key: 'offKeyword', label: '关闭关键字', type: 'text', hint: '发它就关', placeholder: '毒舌关闭' },
  { key: 'ownerOnly', label: '只有主人能开关', type: 'switch', hint: '开着时别人发关键字无效' },
  { key: 'useFile', label: '从文本文件读语料', type: 'switch', hint: '关=用内置预设；开=读数据目录的 corpus.txt（每行一句）' },
  { key: 'cooldownSec', label: '冷却秒数', type: 'number', min: 0, max: 600, step: 5, hint: '两次毒舌之间的最小间隔；开着=全接管，冷却期内消息吞掉不回也不给鱼鱼' },
]

/** 导出给别的模块 / 测试用的纯函数 */
export function parseCorpus(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

export function pickLine(lines, lastLine) {
  const pool = lines.filter((l) => l !== lastLine)
  const list = pool.length ? pool : lines
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

export default {
  id: 'roast-mode',
  name: '毒舌模式',
  version: '1.0.4',
  api: 1,
  description: '主人发关键字开关的损友式吐槽模式：开着时整段接管该聊天，语料可改读文本文件（每行一句）',
  defaults: {
    onKeyword: '毒舌开启',
    offKeyword: '毒舌关闭',
    ownerOnly: true,
    useFile: false,
    cooldownSec: 10,
  },
  settings: SETTINGS,
  panel: 'panel.js',

  setup(api) {
    const dataDir = api.dataDir()
    const corpusPath = join(dataDir, 'corpus.txt')
    const statePath = join(dataDir, 'state.json')

    // ── 状态：每个聊天是否开着 ─────────────────────────────
    let enabled = new Set()
    try {
      if (existsSync(statePath)) {
        const arr = JSON.parse(readFileSync(statePath, 'utf8'))
        if (Array.isArray(arr)) enabled = new Set(arr.filter((x) => typeof x === 'string'))
      }
    } catch (e) {
      api.log.warn('读取毒舌开关状态失败，按全关处理：', e?.message || e)
    }
    const saveState = () => {
      try {
        writeFileSync(statePath, JSON.stringify([...enabled], null, 2), 'utf8')
      } catch (e) {
        api.log.warn('保存毒舌开关状态失败：', e?.message || e)
      }
    }

    // ── 语料：首次落一份模板到数据目录；带 mtime 缓存读文件 ──
    try {
      if (!existsSync(corpusPath)) writeFileSync(corpusPath, CORPUS_TEMPLATE, 'utf8')
    } catch (e) {
      api.log.warn('写语料模板失败：', e?.message || e)
    }
    let fileCache = { mtime: 0, lines: [] }
    const fileLines = () => {
      try {
        const st = statSync(corpusPath)
        if (st.size > MAX_CORPUS_BYTES) {
          // 超过大小上限：拒绝读入并回落内置预设（提示用户自己精简）
          api.log.warn(`语料文件 ${(st.size / 1024 / 1024).toFixed(2)}MB 超过 1MB 上限，本次改用内置预设；请精简 corpus.txt（最多 ${MAX_LINES} 行、每行 ${MAX_LINE_CHARS} 字）`)
          return DEFAULT_LINES
        }
        const mtime = st.mtimeMs
        if (mtime !== fileCache.mtime) {
          const raw = parseCorpus(readFileSync(corpusPath, 'utf8'))
          // 行数与单行长度上限：超限截断，日志提示
          let lines = raw
          if (lines.length > MAX_LINES) {
            api.log.warn(`语料 ${lines.length} 行超过 ${MAX_LINES} 行上限，超出部分丢弃`)
            lines = lines.slice(0, MAX_LINES)
          }
          lines = lines.map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l))
          fileCache = { mtime, lines }
        }
        return fileCache.lines
      } catch (e) {
        api.log.warn('读语料文件失败，本次用内置预设：', e?.message || e)
        return []
      }
    }
    const linesNow = () => (api.settings().useFile ? fileLines() : DEFAULT_LINES)

    // ── 冷却 / 防重复（按聊天隔离：各聊天的冷却与「不重复上一句」互不影响） ──
    const lastFireAt = new Map() // chatId -> 时间戳
    const lastLine = new Map() // chatId -> 上一句毒舌

    const fireRoast = async (msg) => {
      const now = Date.now()
      const cd = Math.max(0, Number(api.settings().cooldownSec) || 0) * 1000
      const last = lastFireAt.get(msg.chatId) || 0
      if (now - last < cd) return true // 冷却期内：吞掉不回，也不给鱼鱼（开着=全接管）
      const line = pickLine(linesNow(), lastLine.get(msg.chatId) || null)
      if (!line) return true
      lastFireAt.set(msg.chatId, now)
      lastLine.set(msg.chatId, line)
      await api.reply(msg, line)
      return true
    }

    // ── 开关核心：关键字匹配 + 工具共用 ────────────────────
    const squash = (t) => String(t || '').replace(/\s+/g, '') // 去掉所有空白再比，容错「毒舌 开启」
    const setChat = async (msg, on, note) => {
      if (on) enabled.add(msg.chatId)
      else {
        enabled.delete(msg.chatId)
        // 关掉时顺手清掉该聊天的冷却/防重复记录，Map 不无限增长
        lastFireAt.delete(msg.chatId)
        lastLine.delete(msg.chatId)
      }
      saveState()
      api.log.info(`毒舌模式${on ? '开启' : '关闭'} ${msg.chatId}（触发：${note}）`)
      const text = on ? '毒舌模式已开启，说话小心点哦～' : '毒舌模式已关闭，恢复温柔模式。'
      try {
        await api.reply(msg, text) // 有原消息时引用回复
      } catch {
        await api.send(msg.chatId, text) // 工具拨开关时没有原消息，直接发
      }
    }

    // ── 消息入口 ─────────────────────────────────────────
    api.on('message', async (msg) => {
      const s = api.settings()
      const text = squash(msg.text)

      // 1) 开关关键字：去空白后整句等于，或「包含关键字且长度不超关键字+6」容忍前后缀（如「毒舌模式开启」）
      const onKw = squash(s.onKeyword)
      const offKw = squash(s.offKeyword)
      const isOn = text === onKw || (onKw && text.includes(onKw) && text.length <= onKw.length + 6)
      const isOff = !isOn && (text === offKw || (offKw && text.includes(offKw) && text.length <= offKw.length + 6))
      if (isOn || isOff) {
        if (s.ownerOnly && !api.isOwner(msg.userId)) return false // 别人发关键字当没看见
        await setChat(msg, isOn, '关键字')
        return true
      }

      // 2) 开着的聊天：整段接管，每条都归毒舌模块，绝不漏给鱼鱼
      if (!enabled.has(msg.chatId)) return false
      return fireRoast(msg)
    })

    // ── 给她感知：规则 + 开关工具（少爷自然语言说「开毒舌」她就能拨） ──
    api.rule(() => '毒舌模式：主人让你开/关「毒舌模式」时，用 roast_mode_toggle 工具在当前聊天拨开关；开着时你会被模块抢答毒舌，不必自己回复。')

    api.tool(({ chat, sessionId }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'roast_mode_toggle',
        description: '在当前聊天开启/关闭/查询毒舌模式。主人要求开或关毒舌（毒舌模式）时使用。',
        properties: {
          action: { type: 'string', description: 'on=开启 off=关闭 status=查询', enum: ['on', 'off', 'status'] },
        },
        required: ['action'],
        execute: async ({ action }) => {
          // 只认主人：这一轮说话的人全是主人才放行（别用 turnHasOwner，H01 的教训）
          if (!api.core.hub.turnSendersAllOwner(sessionId)) {
            return { ok: false, message: '只有主人能开关毒舌模式。' }
          }
          if (action === 'status') {
            return { ok: true, message: enabled.has(chat.chatId) ? '当前聊天毒舌模式开着。' : '当前聊天毒舌模式没开。' }
          }
          const on = action === 'on'
          const fakeMsg = { chatId: chat.chatId, userId: chat.userId || '' }
          await setChat(fakeMsg, on, '工具(roast_mode_toggle)')
          return { ok: true, message: on ? '毒舌模式已开启。' : '毒舌模式已关闭。' }
        },
      })
    })

    api.onDispose(() => saveState())

    // ── 面板接口：打开语料所在文件夹（资源管理器） ──────────
    api.route('/corpus-info', async () => {
      return { ok: true, path: corpusPath, dir: dataDir, exists: existsSync(corpusPath) }
    })
    api.route('/open-corpus-folder', async () => {
      try {
        // 测试钩子：api.__roastTestHooks.spawn 可注入假 spawn（对齐 __petTestHooks 模式），不打真进程
        const spawnFn = api.__roastTestHooks?.spawn
        // 「explorer」是 Windows 专属：非 Windows 平台（含上游 Linux CI）直接拒绝并提示路径，除非测试注入了假 spawn
        if (!spawnFn && process.platform !== 'win32') {
          return { ok: false, message: '该按钮仅支持 Windows；请手动访问上面显示的语料文件夹路径。' }
        }
        const child = spawnFn
          ? spawnFn('explorer', [dataDir], { detached: true, stdio: 'ignore' })
          : (await import('node:child_process')).spawn('explorer', [dataDir], { detached: true, stdio: 'ignore' })
        child?.unref?.()
        return { ok: true }
      } catch (e) {
        api.log.warn('打开语料文件夹失败：', e?.message || e)
        return { ok: false, message: String(e?.message || e) }
      }
    })

    // ── 导出：面板/别的模块可查状态 ───────────────────────
    return {
      status() {
        return { chats: [...enabled], corpusPath, useFile: api.settings().useFile }
      },
      corpusPath,
    }
  },
}
