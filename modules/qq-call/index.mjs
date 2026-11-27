// QQ语音通话 · 插件本体
// 把合成语音送进 QQ 语音通话：自动接听 → 抓对方声音 → 识别 → 大模型 → 合成 → 播回通话
// 运行时代码在 modules-data/qq-call/runtime（Python），面板在 panel.js
//
// 进程管理用 pid 文件（modules-data/qq-call/run/*.pid），不用纯内存句柄：
// 模块热重载时旧实例的子进程可能还活着，靠 pid 文件才能认出它们、避免重复拉起。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let disposed = false
// 版本只有这一处：module.json 里也写同一个，运行时部署戳用它判断「要不要覆盖脚本」
const VERSION = '0.3.2'

// ---------- 子进程退出：分类 / 退避 / 降级 ----------
// 下面三个是纯函数，测试直接 import；计数状态在 setup 里按进程名维护。
export const RUNTIME_NAMES = ['bridge', 'loop', 'answer']
const DEGRADED_AFTER = 3

/** 退出码 → 结局：0 是正常收工；null 是被信号杀掉；其余都算异常 */
export function classifyExit(code) {
  if (code === 0) return 'ok'
  return code == null ? 'signal' : 'crash'
}

/** 连续失败 n 次后，下次重启前至少等多久：1s → 3s → 9s，封顶 60s（每次 ×3，够本机 python 缓过来） */
export function backoffMs(failures) {
  const n = Math.max(1, Number(failures) || 1)
  return Math.min(60000, 1000 * 3 ** (n - 1))
}

/** 连续失败到 DEGRADED_AFTER 次就标降级：不再当偶发，通话链路视为不可用 */
export function isDegraded(failures, limit = DEGRADED_AFTER) {
  return Number(failures) >= limit
}

/** 记账：正常收工清零，异常 +1。返回新对象，不改原状态（测试可直接跑序列） */
export function failureUpdate(state, name, code) {
  const next = { ...state }
  next[name] = classifyExit(code) === 'ok' ? 0 : (Number(next[name]) || 0) + 1
  return next
}

export default {
  id: 'qq-call',
  name: 'QQ语音通话',
  version: VERSION,
  api: 1,
  description: '接入 QQ 语音通话：自动接听、实时识别对方说话、模型开口回答',
  defaults: {
    on: true,
    autoAnswer: true,
    engine: 'piper',
    greeting: '喂？是我呀。你怎么突然想起给我打电话了。',
    idle: true,
    silentFirst: true,
    silentOpenSec: 30,
    llmUrl: 'http://127.0.0.1:9000/v1/chat/completions',
    llmModel: 'deepseek-flash',
    port: 47660,
    py: 'python',
  },
  settings: [
    { key: 'on', label: '启用通话能力', type: 'switch' },
    { key: 'autoAnswer', label: '自动接听', type: 'switch', hint: '来电时自动点接听，不用手点' },
    {
      key: 'engine',
      label: '说话用的引擎',
      type: 'select',
      options: [
        { value: 'piper', label: '本地 Piper（快，音色中性）' },
        { value: 'breeze', label: 'Breeze 云端（要自己填 voiceId / key，慢一点）' },
      ],
      hint: 'GPT-SoVITS 和 RVC 在纯 CPU 上要 4~8 秒一句，暂不放进实时对话',
    },
    { key: 'greeting', label: '兜底开场白（她自己想不出来时才用）', type: 'text' },
    { key: 'silentFirst', label: '接通后允许她先只听不说', type: 'switch', hint: '她自己决定是先开口还是先安静听着' },
    { key: 'silentOpenSec', label: '对面一直不出声，多少秒后她先开口', type: 'number', min: 5, max: 180, step: 1 },
    { key: 'llmUrl', label: '对话模型接口（OpenAI 兼容）', type: 'text', hint: '面板里可以直接从本机探测出来的模型里挑' },
    { key: 'llmModel', label: '对话模型名', type: 'text' },
    { key: 'idle', label: '你不出声时催话', type: 'switch' },
    { key: 'port', label: '本地桥接端口', type: 'number', min: 10000, max: 65000, step: 1 },
  ],
  panel: 'panel.js',

  setup(api) {
    disposed = false   // 热重载 / 测试里重新装载：上一次卸载的标记不能带到这一轮
    const runtimeDir = () => join(api.dataDir(), 'runtime')
    // 每个运行时候选进程的异常退出计数：面板 /status 里能看见，连续 3 次就标降级
    const crash = { bridge: 0, loop: 0, answer: 0 }
    const lastExit = {}
    const killedPids = new Set()      // 我们自己喊停的，不算异常退出
    const degradedNotified = new Set()

    // 从模块文件夹把 Python 脚本铺到 modules-data（安装包里不带 85MB 模型，脚本也就几十 KB）。
    // 内容一样就跳过；不一样就覆盖，覆盖前把旧版存进 .bak-<版本>/，自己改过的也找得回来。
    const MODEL_NEED = [
      ['models/zh_CN-huayan-medium.onnx', 'Piper 中文女声'],
      ['models/zh_CN-huayan-medium.onnx.json', 'Piper 配置'],
      ['models/sherpa-zh/encoder-epoch-99-avg-1.int8.onnx', 'sherpa 流式识别'],
      ['models/sherpa-zh/decoder-epoch-99-avg-1.onnx', 'sherpa 流式识别'],
      ['models/sherpa-zh/joiner-epoch-99-avg-1.int8.onnx', 'sherpa 流式识别'],
      ['models/sherpa-zh/tokens.txt', 'sherpa 词表'],
    ]

    function deployRuntime() {
      const src = join(api.dir, 'runtime')
      const dst = runtimeDir()
      mkdirSync(dst, { recursive: true })   // 「启用通话」关着时也得先有目录，不然一个脚本都铺不下来
      const stamp = join(dst, '.deployed.json')
      let deployed = ''
      try { deployed = String(JSON.parse(readFileSync(stamp, 'utf8')).version || '') } catch {}
      let added = 0
      let replaced = 0
      const put = (name) => {
        const from = join(src, name)
        const target = join(dst, name)
        let same = false
        try { same = readFileSync(target).equals(readFileSync(from)) } catch {}
        if (same) return
        if (existsSync(target)) {
          // 升级覆盖前先把旧脚本留一份（自己改过的话还找得回来）
          try {
            const bak = join(dst, `.bak-${deployed || 'unknown'}`)
            mkdirSync(bak, { recursive: true })
            if (!existsSync(join(bak, name))) writeFileSync(join(bak, name), readFileSync(target))
          } catch {}
          replaced += 1
        } else added += 1
        writeFileSync(target, readFileSync(from))
      }
      try {
        for (const name of readdirSync(src)) {
          if (!name.endsWith('.py') && name !== 'requirements.txt') continue
          put(name)
        }
      } catch (e) {
        api.log.warn(`[qq-call] 铺运行时代码失败：${e?.message || e}`)
      }
      try { writeFileSync(stamp, JSON.stringify({ version: VERSION, at: Date.now(), added, replaced }, null, 2)) } catch {}
      if (added || replaced) api.log.info(`[qq-call] 运行时已铺到 ${dst}（新增 ${added}，更新 ${replaced}）`)
      return added + replaced
    }

    /** 缺哪些模型文件：缺了 piper/sherpa 起不来，要在面板上直接说清楚，别只留一行报错。 */
    function missingModels() {
      return MODEL_NEED.filter(([rel]) => !existsSync(join(runtimeDir(), rel))).map(([file, why]) => ({ file, why }))
    }

    // 首次启动铺一次脚本；模型不铺，缺了只提示（README 里写了放哪、从哪来）
    deployRuntime()
    api.route('/runtime', async () => ({ ok: true, dir: runtimeDir(), missing: missingModels() }))

    const runDir = () => {
      const d = api.dataDir('run')
      mkdirSync(d, { recursive: true })
      return d
    }
    const logDir = () => {
      const d = api.dataDir('logs')
      mkdirSync(d, { recursive: true })
      return d
    }
    const pidFile = (name) => join(runDir(), `${name}.pid`)
    const pyExe = () => String(api.settings().py || 'python')
    const port = () => Number(api.settings().port) || 47660

    function readPid(name) {
      try {
        const n = Number(readFileSync(pidFile(name), 'utf8').trim())
        return Number.isInteger(n) && n > 0 ? n : 0
      } catch {
        return 0
      }
    }

    function alive(pid) {
      if (!pid) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    function isRunning(name) {
      return alive(readPid(name))
    }

    function killPid(pid) {
      if (!pid) return
      killedPids.add(pid)
      try {
        process.kill(pid)
      } catch {}
      // Windows 上 py 起子进程偶尔僵一下，补一刀
      setTimeout(() => {
        if (alive(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }, 1200)
    }

    function stopOne(name) {
      const pid = readPid(name)
      killPid(pid)
      try {
        if (existsSync(pidFile(name))) unlinkSync(pidFile(name))
      } catch {}
      if (pid) api.log.info(`[qq-call] 已停 ${name}（pid=${pid}）`)
    }

    function stopAll() {
      for (const name of ['bridge', 'loop', 'answer']) stopOne(name)
    }

    function ensure(name, script, args = []) {
      const old = readPid(name)
      if (alive(old)) return old
      const out = openSync(join(logDir(), `${name}.log`), 'a')
      const child = spawn(pyExe(), ['-u', script, ...args], {
        cwd: runtimeDir(),
        env: {
          ...process.env,
          CALL_TTS_ENGINE: api.settings().engine || 'piper',
          QQ_CALL_GREETING: String(api.settings().greeting || ''),
          QQ_CALL_IDLE: api.settings().idle === false ? '0' : '1',
          QQ_CALL_SILENT_FIRST: api.settings().silentFirst === false ? '0' : '1',
          QQ_CALL_SILENT_OPEN_SEC: String(Number(api.settings().silentOpenSec) || 30),
          QQ_CALL_LLM_URL: String(api.settings().llmUrl || ''),
          QQ_CALL_LLM_MODEL: String(api.settings().llmModel || ''),
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', out, out],
        windowsHide: true,
      })
      child.on('exit', (code) => {
        if (readPid(name) === child.pid) {
          try {
            unlinkSync(pidFile(name))
          } catch {}
        }
        const kind = classifyExit(code)
        const byUs = killedPids.delete(child.pid)
        lastExit[name] = { code, kind, at: Date.now() }
        if (disposed) return
        // 面板点了停 / 重启：我们自己喊的停，不记成故障
        if (byUs) {
          api.log.info(`[qq-call] ${name} 已停（code=${code}）`)
          return
        }
        if (kind === 'ok') {
          Object.assign(crash, failureUpdate(crash, name, code))
          degradedNotified.delete(name)
          api.log.info(`[qq-call] ${name} 正常退出（code=0）`)
          return
        }
        Object.assign(crash, failureUpdate(crash, name, code))
        const n = crash[name]
        api.log.warn(`[qq-call] ${name} 异常退出（code=${code}，连续 ${n} 次）${isDegraded(n) ? '：已降级，不再自动重启' : `：下次启动前至少等 ${Math.round(backoffMs(n) / 1000)}s`}`)
        // 降级只报一次，别把日志刷成一片红
        if (isDegraded(n) && !degradedNotified.has(name)) {
          degradedNotified.add(name)
          api.log.error(`[qq-call] ${name} 连续 ${n} 次异常退出，通话链路不可用（原因看 ${join(logDir(), `${name}.log`)}）`)
        }
      })
      child.on('error', (e) => {
        Object.assign(crash, failureUpdate(crash, name, null))
        lastExit[name] = { code: null, kind: 'spawn-error', at: Date.now() }
        api.log.error(`[qq-call] ${name} 启动失败：${e?.message || e}（设置里的 python 是「${pyExe()}」，确认它存在）`)
      })
      try {
        writeFileSync(pidFile(name), String(child.pid || 0))
      } catch {}
      api.log.info(`[qq-call] ${name} 已启动 pid=${child.pid}`)
      return child.pid
    }

    async function bridgeHealth() {
      try {
        const r = await fetch(`http://127.0.0.1:${port()}/health`, { signal: AbortSignal.timeout(2500) })
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
        return { ok: true, ...(await r.json()) }
      } catch (e) {
        return { ok: false, error: e?.message || String(e) }
      }
    }

    async function startAll() {
      if (disposed) return
      // 用户主动「全部启动」就是一次干净重试：把之前的失败计数清掉
      for (const n of RUNTIME_NAMES) {
        crash[n] = 0
        degradedNotified.delete(n)
      }
      syncPersona()
      const s = api.settings()
      const health = await bridgeHealth()
      if (!health.ok) ensure('bridge', 'call_bridge.py', ['serve', String(port())])
      ensure('loop', 'call_loop.py', [])
      if (s.autoAnswer !== false) ensure('answer', 'auto_answer.py', [])
      else stopOne('answer')
    }

    const miss = missingModels()
    if (miss.length) api.log.warn(`[qq-call] 缺 ${miss.length} 个模型文件（第一个是 ${miss[0].file}），piper / sherpa 会起不来；把模型放进 ${join(runtimeDir(), 'models')}`)

    if (api.settings().on !== false) {
      mkdirSync(join(runtimeDir(), 'out'), { recursive: true })
      startAll().catch((e) => api.log.error(`[qq-call] 启动异常：${e?.message || e}`))
    }

    // 没有看门狗：进程掉了不会自动拉起，也不做定时体检。
    // 改引擎 / 开场白 / 催话后，点面板「全部启动」按新设置重启才会生效（会先停再起）。

    // 把当前人格写进运行时，回路生成开场白时用（面板这边的模型接口不一定通，交给本机模型出话）
    function syncPersona() {
      try {
        const p = String((api.core.personas.current && api.core.personas.current()) || '').trim()
        if (!p) return
        writeFileSync(join(api.dataDir('runtime', 'out'), 'persona.txt'), p, 'utf8')
        api.log.info(`[qq-call] 已同步人格（${p.length} 字）给回路`)
      } catch (e) {
        api.log.warn(`[qq-call] 同步人格失败：${e?.message || e}`)
      }
    }

    api.onDispose(() => {
      disposed = true
      stopAll()
      api.log.info('[qq-call] 已停止全部子进程')
    })

    // ---------- 面板接口 ----------
    api.route('/status', async () => {
      const health = await bridgeHealth()
      return {
        ok: true,
        bridge: health,
        loop: { running: isRunning('loop') },
        answer: { running: isRunning('answer') },
        engine: api.settings().engine || 'piper',
        port: port(),
        modelMissing: missingModels(),
        // 子进程异常退出：连续几次、要不要退避、是不是已经降级
        runtime: {
          failures: { ...crash },
          lastExit: { ...lastExit },
          degraded: RUNTIME_NAMES.filter((n) => isDegraded(crash[n] || 0)),
          backoffMs: Object.fromEntries(RUNTIME_NAMES.map((n) => [n, backoffMs((crash[n] || 0) + 1)])),
        },
      }
    })

    api.route('/start', async () => {
      await startAll()
      return { ok: true, message: '已启动' }
    })

    api.route('/restart', async () => {
      stopAll()
      await new Promise((r) => setTimeout(r, 1600))
      await startAll()
      return { ok: true, message: '已按当前设置重启' }
    })

    api.route('/stop', async () => {
      stopAll()
      return { ok: true, message: '已停止' }
    })

    api.route('/models', async () => {
      // 探测本机能用的 OpenAI 兼容接口，把模型列出来让人自己选
      const bases = ['http://127.0.0.1:9000', 'http://127.0.0.1:11434']
      const cur = String(api.settings().llmUrl || '').trim()
      const origin = cur.match(/^(https?:\/\/[^/]+)/i)
      if (origin && !bases.includes(origin[1])) bases.push(origin[1])
      const items = []
      const errors = []
      for (const base of bases) {
        try {
          const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const j = await r.json()
          for (const d of j.data || []) {
            if (!d || !d.id) continue
            if (/embed|bge/i.test(String(d.id))) continue  // 向量模型不能拿来对话
            items.push({
              key: `${base}|${d.id}`,
              label: `${d.id} · ${base.replace(/^https?:\/\//, '')}`,
              url: `${base}/v1/chat/completions`,
              model: String(d.id),
            })
          }
        } catch (e) {
          errors.push(`${base.replace(/^https?:\/\//, '')}: ${e?.message || e}`)
        }
      }
      return {
        ok: true,
        items,
        errors,
        current: { url: api.settings().llmUrl || '', model: api.settings().llmModel || '' },
      }
    })

    api.route('/say', async (req) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const text = (u.searchParams.get('text') || '').trim()
      if (!text) return { ok: false, message: '没有文字' }
      try {
        const r = await fetch(`http://127.0.0.1:${port()}/say?text=${encodeURIComponent(text)}`, {
          signal: AbortSignal.timeout(120000),
        })
        return { ok: true, ...(await r.json()) }
      } catch (e) {
        return { ok: false, message: `桥接服务没响应：${e?.message || e}` }
      }
    })

    api.route('/tone', async (req) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const sec = Number(u.searchParams.get('sec') || 3) || 3
      try {
        const r = await fetch(`http://127.0.0.1:${port()}/tone?sec=${sec}`, { signal: AbortSignal.timeout(30000) })
        const j = await r.json().catch(() => ({ ok: true }))
        return { ok: true, message: `放了 ${sec} 秒测试音`, ...j }
      } catch (e) {
        return { ok: false, message: `桥接服务没响应：${e?.message || e}` }
      }
    })

    api.route('/greet', async () => {
      const text = String(api.settings().greeting || '').trim()
      if (!text) return { ok: false, message: '开场白是空的' }
      try {
        await fetch(`http://127.0.0.1:${port()}/say?text=${encodeURIComponent(text)}`, {
          signal: AbortSignal.timeout(120000),
        })
        return { ok: true, message: '已把开场白推进通话' }
      } catch (e) {
        return { ok: false, message: `桥接服务没响应：${e?.message || e}` }
      }
    })

    // 在 QQ 里发 /通话 xxx —— 把这句话直接说进电话里
    api.command({
      name: '通话',
      desc: '把一句话说进当前的 QQ 语音通话（电脑麦克风已经接到模块的声音通道）',
      run: async (arg) => {
        const text = String(arg || '').trim()
        if (!text) return '用法：/通话 你要说的话'
        try {
          const r = await fetch(`http://127.0.0.1:${port()}/say?text=${encodeURIComponent(text)}`, {
            signal: AbortSignal.timeout(120000),
          })
          const j = await r.json()
          return j.ok ? `已经说进通话了（${j.first_audio_s ?? j.synth_s ?? '?'} 秒开口）` : '桥接返回失败'
        } catch (e) {
          return `桥接服务没响应：${e?.message || e}`
        }
      },
    })

    return {
      startAll,
      stopAll,
      status: async () => ({ bridge: await bridgeHealth(), loop: isRunning('loop'), answer: isRunning('answer') }),
    }
  },
}
