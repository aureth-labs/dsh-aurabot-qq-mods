// 自己写的模块：星露谷（接 Blind Whale Farmer 模组）
//
// 它不是"另一个 AI 在玩"，也不是把别人的插件搬进来当外壳。
// 游戏那边的 SMAPI 模组只做两件事：把画面翻成文字（状态、背包、地图、坐标、作物），
// 以及执行我发过去的高层动作（寻路、浇水、钓鱼、下矿……）。
// 判断全在这里 —— 是我看状态、我决定干什么，模块只负责把我的决定翻译成 MCP 调用。
//
// 协议：模组在本机开了个 MCP 服务器（默认 http://127.0.0.1:18080/mcp），
// 说话方式是 JSON-RPC 2.0；工具调用的回复走 SSE（动作期间每 15 秒一行心跳）。
// 这段和 dsh-stardew-blind-whale-farmer 的 gateway 走的是同一个地址、同一套工具名，
// 所以那边的攻略/help 文本也能直接用。
//
// 优先级说明：如果游戏里按了 F8 启动了模组自带的 AI，MCP 调用会被拒绝（它会提示先按 F8 停掉）。
// 这一点要照着游戏那边的提示走，别硬顶。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseSse, inSaveGame, looksLikeBadSelfReport, trim, parseMinutes, newestSaveMtime } from './lib/logic.mjs'

export default {
  id: 'stardew',
  api: 1,
  name: '星露谷',
  version: '1.1.0',
  description: '让她自己在后台玩《星露谷物语》：读游戏文字状态、自己决定做什么，再让 SMAPI 模组去执行。需要游戏开着并装了 Blind Whale Farmer 模组。',
  panel: 'panel.js',

  defaults: {
    port: 18080,
    timeoutMinutes: 6,
    allowOthers: false,
    selfPlayGapMin: 2,
    gameDir: 'D:\\game\\xlgwyv1.6.15',
  },

  settings: [
    { key: 'port', label: 'MCP 端口', type: 'number', min: 1, max: 65535, step: 1, hint: '和模组 config.json 里的 McpPort 一致，默认 18080' },
    { key: 'gameDir', label: '游戏目录', type: 'text', hint: '有 StardewModdingAPI.exe 的那个文件夹；自己玩之前会从这里启动游戏' },
    { key: 'timeoutMinutes', label: '单个动作最多等几分钟', type: 'number', min: 1, max: 30, step: 1, hint: '钓鱼、下矿、wait 这类动作一次可能要十几分钟' },
    { key: 'selfPlayGapMin', label: '自己玩时每轮间隔几分钟', type: 'number', min: 1, max: 15, step: 1, hint: '一轮想完了、人也没插话，隔这么久我就接着玩下一轮' },
    { key: 'allowOthers', label: '别人也能用', type: 'switch', hint: '默认只有主人私聊能用' },
  ],

  setup(api) {
    const { defineTool } = api
    const log = api.log

    /** 设置每次现读：面板里改了不用重载模块。 */
    const conf = () => {
      const s = api.settings()
      return {
        port: Number(s.port) || 18080,
        gameDir: String(s.gameDir || 'D:\\game\\xlgwyv1.6.15'),
        timeoutMs: (Number(s.timeoutMinutes) || 6) * 60 * 1000,
        allowOthers: Boolean(s.allowOthers),
      }
    }

    // ───────────── 自己把游戏开起来 ─────────────
    // 为什么要有：SMAPI 不热加载模组，游戏必须在模组装好之后启动；而且启动后停在标题画面，
    // MCP 已经在听，但 get_state 会一直报「还没进入存档」。所以「自己玩」第一步是：
    // 没有进程就拉起 StardewModdingAPI.exe → 等 18080 通 → 点进存档。
    // 逻辑都在 scripts/stardew-launch.ps1 里（窗口操作离不开 PowerShell）。

    const launchScript = () => join(api.dir, 'assets', 'stardew-launch.ps1')

    const runLaunchScript = (opts = {}) => new Promise((resolve) => {
      const script = launchScript()
      if (!existsSync(script)) return resolve({ launched: false, portUp: false, clicked: false, note: '找不到 stardew-launch.ps1' })
      const { launch = true, click = true, focus = false } = opts
      // 结果走文件：PowerShell 标准输出的中文是 GBK，管道回来会变乱码（踩过）
      const outFile = api.dataDir(`launch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-GameDir', conf().gameDir, '-Port', String(conf().port), '-OutFile', outFile]
      if (launch) args.push('-Launch')
      if (click) args.push('-Click')
      if (focus) args.push('-Focus')
      execFile('powershell.exe', args, { timeout: 300_000, windowsHide: true }, (error) => {
        try {
          const raw = readFileSync(outFile, 'utf8').trim()
          const j = JSON.parse(raw.split(/\r?\n/).filter(Boolean).pop())
          resolve(j)
        } catch {
          resolve({ launched: false, portUp: false, clicked: false, note: String(error?.message || '启动脚本没有留下结果').slice(0, 120) })
        }
      })
    })

    /** 关掉游戏（存档完收工用）。 */
    const closeGame = () => {
      try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
          "(Get-Process -Name 'StardewModdingAPI' -ErrorAction SilentlyContinue | Stop-Process -Force) ; 'ok'"],
        { timeout: 30_000, windowsHide: true })
        return String(out || '').includes('ok')
      } catch { return false }
    }

    /** 只检查端口通不通（不动进程）。 */
    const portAlive = async () => {
      try {
        const res = await mcp('tools/list', {}, AbortSignal.timeout(5000))
        return Boolean(res && res.tools)
      } catch { return false }
    }


    /** 发一条 JSON-RPC 给游戏里的 MCP 服务器。 */
    async function mcp(method, params, signal) {
      const { port } = conf()
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal,
      })
      const type = res.headers.get('content-type') || ''
      const body = type.includes('text/event-stream') ? parseSse(await res.text()) : await res.json()
      if (body.error) throw new Error(body.error.message || `MCP 错误 ${body.error.code}`)
      return body.result
    }


    const TOOL = 'stardew_game'

    /** 这是她玩游戏的唯一一双手：读写都走它，判断在她自己脑子里。 */
    const tool = defineTool({
      name: TOOL,
      description:
          '玩《星露谷物语》（需要游戏开着、装了大肥鱼种白饭模组）。'
          + '第一次用先 action="help" 拿到操作规则和全部动作列表；'
          + '每次行动前先 action="get_state" 看现在的状态；'
          + '然后 action=动作名、args=参数，比如 {"action":"water_crops"}、{"action":"move_to","args":{"x":64,"y":15}}。'
          + '攻略用 action="get_guide"（args.name 填 攻略/钓鱼/采矿/节日）。',
        properties: {
          action: { type: 'string', description: 'help、get_state、get_guide，或 help 里列出的任意动作名' },
          args: { type: 'object', additionalProperties: true, description: '动作的参数对象；没有参数就不填' },
        },
        required: ['action'],
        execute: async ({ action, args }) => {
          const act = String(action || '').trim()
          const timeout = AbortSignal.timeout(conf().timeoutMs)
          try {
            if (!act || act === 'help') {
              const init = await mcp('initialize', {
                protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aurabot-stardew', version: '1' },
              }, timeout)
              const list = await mcp('tools/list', {}, timeout)
              const tools = (list && list.tools) || []
              const lines = tools.map((t) => {
                const props = (t.inputSchema && t.inputSchema.properties) || {}
                const need = new Set((t.inputSchema && t.inputSchema.required) || [])
                const ps = Object.keys(props).map((k) => (need.has(k) ? k : k + '?')).join(', ')
                const brief = String(t.description || '').split(/[。.\n]/)[0]
                return `- ${t.name}(${ps})：${brief}`
              })
              const rules = String((init && init.instructions) || '')
              return { ok: true, message: trim(`${rules}\n\n## 全部动作（${tools.length} 个）\n${lines.join('\n')}`, 16000) }
            }
            const result = await mcp('tools/call', { name: act, arguments: (args && typeof args === 'object') ? args : {} }, timeout)
            const text = ((result && result.content) || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
            return { ok: true, message: trim(text || '（游戏没有返回内容）') }
          } catch (error) {
            const msg = String((error && error.message) || error)
            if (/abort|timeout/i.test(msg)) {
              return { ok: false, message: `等了 ${conf().timeoutMinutes} 分钟还没做完，先放弃等待了（游戏里的动作可能还在继续）。接着 get_state 看看现在什么样` }
            }
            if (/ECONNREFUSED|fetch failed/i.test(msg)) {
              return { ok: false, message: '连不上游戏：确认星露谷已经通过 SMAPI 启动、装了 Blind Whale Farmer 模组、并且读了存档（SMAPI 控制台会打印 MCP 地址）' }
            }
            return { ok: false, message: msg }
          }
        },
      })

    /** 谁拿得到这个工具：平时只给后台工作间 system:stardew；私聊默认不给。 */
    api.tool(({ chat, level }) => {
      if (chat && chat.kind === 'system') {
        return String(chat.chatId || '').startsWith('system:stardew') ? [tool] : []
      }
      // 私聊里默认不挂完整工具（挂了她会自己手痒开一局，2026-11-07 踩过）。
      // 私聊只给"看一眼"的只读工具 —— 主人在聊天里随时能问"农场怎么样了"，但玩游戏的活儿还是后台干。
      if (!conf().allowOthers && level !== 'full') return []
      return [peekTool]
    })

    /**
     * 私聊专用的只读工具：只能看，不能动。
     * 想玩就得走 /自己玩（后台会话），私聊这边不跑游戏。
     */
    const peekTool = defineTool({
      name: 'stardew_peek',
      description:
        '看一眼《星露谷物语》现在的情况（只读，不开游戏、不动手）。'
        + '主人问"农场怎么样了/种到哪了/有多少钱"时用它。'
        + '想真的去玩，得主人说一声、走后台会话，这里只看不玩。',
      properties: {
        what: { type: 'string', description: 'state=当前状态；notes=我的长期笔记；连不上就直接返回原因' },
      },
      execute: async ({ what } = {}) => {
        const want = String(what || 'state').trim()
        try {
          const text = await stateText()
          if (!text) return { ok: false, message: '游戏没回话' }
          if (!inSaveGame(text)) {
            return { ok: false, message: '游戏开着但停在标题画面，还没读存档。要玩的话跟我说一声，我来弄' }
          }
          if (want === 'notes') {
            const m = text.match(/【你的长期笔记】([\s\S]*?)(?:\n## |$)/)
            return { ok: true, message: (m && m[1].trim()) || '（还没写笔记）' }
          }
          // 只挑几行给主人看，别把整张地图倒出来
          const lines = text.split('\n').filter((l) => /^(时间|金钱|体力|地点|技能等级)/.test(l.trim()) || /作物|需浇水|可收获/.test(l))
          return { ok: true, message: lines.slice(0, 12).join('\n') || '（没读到状态）' }
        } catch (error) {
          const msg = String((error && error.message) || error)
          if (/ECONNREFUSED|fetch failed/i.test(msg)) return { ok: false, message: '游戏没开（或者模组的 MCP 没起来）' }
          return { ok: false, message: msg }
        }
      },
    })

    // 不往任何会话的规则里塞「你会玩星露谷」——
    // 2026-11-07 踩过：私聊里看到这句 + 收到「收工了」的汇报，她会以为还得接着干，自己又开一局。
    // 玩游戏的活儿只在后台工作间里由模块派活，不需要她知道。

    // 让她知道自己有这双手（这条会进系统提示词）

    // 主人在 QQ 里手动问一句也能查连通性：/星露谷
    api.command({
      name: '星露谷',
      desc: '看看游戏那边的模组连上没有',
      run: async () => {
        const { port } = conf()
        try {
          const init = await mcp('initialize', {
            protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aurabot-stardew', version: '1' },
          }, AbortSignal.timeout(8000))
          const list = await mcp('tools/list', {}, AbortSignal.timeout(8000))
          const n = ((list && list.tools) || []).length
          return `连上了 127.0.0.1:${port}，游戏给了 ${n} 个动作。${init && init.serverInfo ? '（' + (init.serverInfo.name || '') + '）' : ''}`
        } catch (error) {
          return `连不上 127.0.0.1:${port}：${String((error && error.message) || error).slice(0, 200)}`
        }
      },
    })

    // ───────────── 自己玩：老爹说一声，我就自己接着玩 ─────────────
    // 原理：不另外开一个"AI"——还是我这一轮在玩。
    //   到点我接一轮（用 stardew_game 调一堆动作），一轮结束、人没插话、时间还没到，
    //   再往这个聊天里塞一句"接着玩"，我就又开一轮，直到时间用完自己回家睡觉。
    // 三条自制：只有主人能开、有总时长上限、每轮之间留间隔（不然会把自己刷爆）。

    // ───────────── 自己玩：单开一间只挂这一个工具的工作间 ─────────────
    // 老问题：在私聊会话里玩，每轮都要带几十个工具的定义 + 聊天历史，token 烧得厉害。
    // 现在改成：开一个后台会话 system:stardew，那儿只挂 stardew_game 一个工具、人格照旧是全局那份，
    // 所以「还是我」——人格、记忆本来就是全局文件，不用同步。
    // 每一轮跑完，隔一会儿再起一轮，一直续到时间用完，然后回家睡觉、把结果带回私聊。

    const selfFile = api.dataDir('selfplay.json')
    let loopRunning = false

    const loadSelf = () => {
      try { return JSON.parse(readFileSync(selfFile, 'utf8')) || {} } catch { return {} }
    }
    const saveSelf = (s) => writeFileSync(selfFile, JSON.stringify(s, null, 2))
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    const needChat = () => {
      const qq = api.config().ownerQQ
      return { chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: api.config().ownerName || '主人' }
    }
    // 汇报走私聊；玩游戏的活儿不在这儿干。
    // 出站策略（broker/purpose）会把这些当"主动发言"排队甚至拦下，用 OneBot 直发最稳：
    // 只发一条、不拉起轮次、不参与策略。
    const report = (text) => {
      try { return api.core.onebot.call('send_private_msg', { user_id: Number(api.config().ownerQQ), message: String(text) }, { timeoutMs: 15000 }) }
      catch (error) { api.log.warn('星露谷：汇报发不出去：', String(error && error.message || error)) }
    }

    /** 一轮的提示词：只给这一轮该知道的事，别把攻略灌进去（省 token，细节它自己 get_state 看）。 */
    function roundPrompt(leftMin, round) {
      return [
        `【自己玩星露谷】第 ${round + 1} 轮，这次还能玩大约 ${leftMin} 分钟。主人不在，不用等他回话。`,
        '',
        '先 get_state 看现在几点、在哪、体力多少、有没有活要干，然后自己拿主意往下做。',
        '',
        '【这一轮只干一件事——这条最重要】',
        '一轮只允许做一件原子动作，做完立刻收尾：浇完这一片 / 收一次这一块 / 去某个点采一圈 /',
        '卖掉背包里某类东西 / 走回屋子。不要「浇完再去钓鱼」这种串两件的，也不要「整理一下顺便卖点东西」。',
        '为什么这么严（2026-11-09 实测）：单轮预算 9 分钟时，一轮里塞两三件事，光读状态就要几十秒，',
        '剩下的做不完，时间一到就被硬断，等于白跑；改成一轮一件之后，6 分钟能跑 8 轮，并且每轮都做完。',
        '',
        '真碰上要花大钱（几千上万）、要卖地、要跟谁结婚这种，先别做，写进笔记里等主人回来问。',
        '',
        '这一轮结束前，用 update_notes 写一两句（别铺开）：这轮做成了什么、有没有哪件烦或爽、下次想干嘛。',
        '',
        '【写完笔记之后，必须再单独说一句话，这句话里不许调用任何工具】',
        '外面只能拿到本轮最后一步的正文；一轮常常「调完工具就结束」，最后一步还是工具调用，',
        '带回去就是空的，汇报里只剩轮数、没有这一轮到底发生了什么。',
        '所以笔记写完，最后一步只说话。一两句就够——这轮做了什么、顺不顺、下次想干嘛。',
        '哪怕没干成，也要说一句没干成、因为什么。',
        '',
        '还剩不到 3 分钟的时候，回家 sleep 存档。',
      ].join('\n')
    }

    async function startSelfPlay(minutes) {
      // 僵尸循环清理：模块热重载会把 loopRunning 重置成 false，但上一个实例的 runLoop 还在
      // 内存里转，会和新循环抢同一个 system:stardew 会话（表现为「上一轮还没结束」+ 莫名玩很久）。
      // 所以用文件里的 loopId 认主：每轮开头比对，不是自己这代的立刻退出。
      if (loopRunning) return '我正玩着呢，不用再叫我'
      const mins = Math.max(1, Math.min(180, Math.round(Number(minutes) || 30)))
      const now = Date.now()
      const loopId = String(now) + '-' + Math.random().toString(36).slice(2, 8)
      saveSelf({ running: true, stop: false, until: now + mins * 60_000, startedAt: now, rounds: 0, loopId, minutes: mins })
      loopRunning = true
      runLoop(loopId).catch((error) => api.log.warn('星露谷自己玩出错：', error.message)).finally(() => { loopRunning = false })
      return `好，我去玩了，${mins} 分钟。玩完回来跟你说`
    }

    async function stopSelfPlay(reason = '主人叫停') {
      const s = loadSelf()
      if (!s.running) return { ok: false, message: '本来就没在玩' }
      saveSelf({ ...s, running: false, stop: true })
      api.log.info(`星露谷：停止自己玩（${reason}）`)
      return { ok: true, message: '好，这一轮做完就收' }
    }

    /** 问一次游戏状态，返回纯文字（连不上就丢错，调用方接）。 */
    async function stateText() {
      const result = await mcp('tools/call', { name: 'get_state', arguments: {} }, AbortSignal.timeout(20_000))
      return ((result && result.content) || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
    }

    /**
     * 确保游戏开着、并且已经进了存档。
     * 判断全在这里做（PowerShell 里比中文字符串会因编码变乱码），脚本只负责动手。
     */
    async function ensureGameReady() {
      // 已经进档：直接开工
      if (await stateText().then((t) => inSaveGame(t)).catch(() => false)) {
        return { ok: true, note: '游戏本来就在存档里' }
      }
      if (!(await portAlive())) {
        const r = await runLaunchScript({ launch: true, click: false })
        if (!r.portUp) return { ok: false, note: `游戏起不来或 18080 没通（${r.note || ''}）` }
      }
      // 点存档，最多试三次（每次都验一遍，没进就重来）
      for (let i = 0; i < 3; i++) {
        await runLaunchScript({ launch: false, click: true })
        for (let w = 0; w < 8; w++) {
          await wait(4000)
          const okIn = await stateText().then((t) => inSaveGame(t)).catch(() => false)
          if (okIn) return { ok: true, note: `已进存档（第 ${i + 1} 次点成功）` }
        }
      }
      return { ok: false, note: '游戏起来了，但点了三次都没进存档' }
    }

    /** 主体：一轮接一轮，直到时间用完或被叫停。 */
    async function runLoop(loopId) {
      const hub = api.core.hub
      let lastSay = ''
      // 每轮记一句：报告里逐条列出来，这才是"这一局发生了什么"，不是只有轮数。
      const voices = []
      const say = (round, text) => {
        const s = String(text || '').replace(/\s+/g, ' ').trim()
        if (!s) return
        voices.push({ round, text: s.slice(0, 160) })
        lastSay = s
      }
      const gapMs = Math.max(30_000, Number(api.settings().selfPlayGapMin || 2) * 60_000)
      const now0 = loadSelf().startedAt || Date.now()
      let round = 0
      const mine = () => {
        const s = loadSelf()
        return s.loopId === loopId && s.running && !s.stop
      }

      // ── 开工前先确保游戏开着、存档读进去了（这是"自己进游戏"的那一步） ──
      const pre = await ensureGameReady()
      if (!pre.ok) {
        saveSelf({ ...loadSelf(), running: false })
        report(`【星露谷】这次没玩成：${pre.note}`)
        api.log.warn(`星露谷：开局失败，${pre.note}`)
        return
      }
      api.log.info(`星露谷：进游戏成功（${pre.note}），开始玩`)
      // 每轮开始前都回到游戏窗口：游戏开着但窗口在后台时虽然不会暂停（已关掉「失去焦点暂停」），
      // 但有个别动作依赖窗口活着，早点回来少踩坑
      await runLaunchScript({ launch: false, click: false, focus: true })

      while (true) {
        if (!mine()) break
        const s = loadSelf()
        const now = Date.now()
        if (now >= s.until) break
        const left = Math.max(1, Math.round((s.until - now) / 60_000))
        // 单轮预算：按剩下的时间给（多留 1 分钟缓冲），不切成小段——
        // 切碎了模型每段都干到一半被砍，反倒白烧 token。收尾交给提示词里的"还剩 N 分钟"。
        const roundBudget = Math.max(5 * 60_000, (s.until - now) + 60_000)
        try {
          const r = await hub.runSystemTurn('stardew', '星露谷', roundPrompt(left, round), { timeoutMs: roundBudget })
          const text = typeof r === 'string' ? r : String((r && (r.text || r.message)) || '')
          if (text && text.trim()) say(round + 1, text)
        } catch (error) {
          const msg = String(error && error.message || error)
          // 「上一轮还没结束」= 上一轮的收尾还在跑，等它落地再接着来，不算失败
          if (/上一轮还没结束/.test(msg)) {
            await wait(20_000)
            continue
          }
          api.log.warn(`星露谷第 ${round + 1} 轮没跑起来：`, msg)
          await wait(60_000)
        }
        round += 1
        saveSelf({ ...loadSelf(), rounds: round })
        const gap = Date.now() + gapMs
        while (Date.now() < gap) {
          const ss = loadSelf()
          if (ss.loopId !== loopId || !ss.running || ss.stop || Date.now() >= ss.until) break
          await wait(5000)
        }
      }
      // 只有还归自己管的时候才收尾写状态，别把新开的那一趟给关了
      const fin = loadSelf()
      if (fin.loopId === loopId) {
        // 收尾三步：回家睡觉存档 → 关掉游戏 → 只在私聊里说一次
        // 汇报只认硬证据（sleep 成没成、游戏关没关），不信后台那轮模型的自述——
        // 它偶尔会误报「还在标题画面」，把好好的收工说成没进去（2026-11-07 踩过）。
        let slept = false
        // 睡觉必须「存档文件真更新了」才算数：sleep 说成功 ≠ 存下来了。
        // 2026-11-07 踩过：日志全说睡了，存档却停在两小时前。
        const saveDir = join(process.env.APPDATA || '', 'StardewValley', 'Saves')
        const newestSave = () => newestSaveMtime(saveDir, readdirSync, (p) => statSync(p).mtimeMs)
        const beforeSave = newestSave()
        try {
          await mcp('tools/call', { name: 'sleep', arguments: {} }, AbortSignal.timeout(180_000))
          for (let i = 0; i < 15; i++) {
            await wait(2000)
            if (newestSave() > beforeSave) { slept = true; break }
          }
          if (!slept) api.log.warn('星露谷：sleep 说成功了，但存档文件没更新')
        } catch (error) {
          api.log.warn('星露谷：收工睡觉失败：', String(error && error.message || error))
        }
        await wait(3000)
        const closed = closeGame()
        saveSelf({ ...fin, running: false, slept, closed })
        const playedMin = Math.max(1, Math.round((Date.now() - now0) / 60_000))
        // 模型自述里只要提到「没进存档 / 标题画面 / 连不上」就整段丢掉，别把假失败带给主人
        const saidBad = looksLikeBadSelfReport(lastSay)
        // 每轮那句原话逐条列出——这才是"我玩了什么"。
        const lines = voices
          .filter((v) => !looksLikeBadSelfReport(v.text))
          .map((v) => `第${v.round}轮：${v.text}`)
        const tail = lines.length
          ? `\n\n${lines.join('\n')}`
          : (lastSay && !saidBad ? `\n\n${lastSay.slice(0, 400)}` : '')
        const extra = [slept ? '' : '（存档没睡成，下次得手动存档）', closed ? '' : '（游戏没关掉）'].filter(Boolean).join('')
        report(`【星露谷】玩了 ${playedMin} 分钟，跑了 ${round} 轮，${slept ? '已存档' : '没存成'}、${closed ? '游戏关掉了' : '游戏还开着'}。${extra}${tail}`)
        api.log.info(`星露谷：自己玩结束，${playedMin} 分钟 ${round} 轮，睡了=${slept}，关了=${closed}，模型自述有误报=${saidBad}`)
      } else {
        api.log.info(`星露谷：这一代循环已作废（loopId 换了），不写收尾`)
      }
    }

    api.command({
      name: '自己玩',
      aliases: ['自己玩吧'],
      desc: '让她自己去玩星露谷：/自己玩 10（分钟，只写数字；不写默认 30）',
      run: async (arg) => startSelfPlay(parseMinutes(arg))
    })

    api.command({
      name: '收工',
      desc: '叫她别玩了，回家存档',
      run: async () => stopSelfPlay('老爹说收工'),
    })

    api.route('/stardew/selfplay/status', async () => loadSelf())
    api.route('/stardew/selfplay/stop', async () => stopSelfPlay('面板叫停'))
    // 面板/我自己也能点一下开工（QQ 命令走 /自己玩）
    api.route('/stardew/selfplay/start', async (req) => {
      // req 是原始请求：body 要用插件自己的读法，别猜 req.body
      let b = null
      try { b = await api.core.http.body(req) } catch { b = null }
      if (typeof b === 'string') { try { b = JSON.parse(b) } catch { b = null } }
      const mins = Number(b?.minutes) || 30
      return { ok: true, message: await startSelfPlay(mins) }
    })

    log.info('星露谷模块已加载：等游戏那边的 MCP 起来就能玩')
  },
}
