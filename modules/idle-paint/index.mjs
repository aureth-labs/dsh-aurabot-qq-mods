// 空闲画画 —— 没人说话的时候，自己把 ComfyUI 拉起来画一张图，画好挑一张发给主人。
//
// 依赖：本机 ComfyUI（默认 http://127.0.0.1:8188，模型是 Anima/Qwen-Image 那套）。
// 写给 Aurabot 的模块（扩展接口 v1）；改完保存几秒内生效，不用重启。
//
// 设计要点：
//   · 每 3 分钟醒一次，只有「真的闲着」才动手：距最后一条收到的消息超过 idleMinutes 分钟
//   · 一天最多 maxPerDay 张、两次之间至少隔 gapMinutes 分钟、只在 awakeFrom~awakeTo 时段里画
//   · ComfyUI 没开就自己拉起来（autoStart），画完默认再关掉，把显存还给主人
//   · 提示词两条路：从词池随机（pool）／让它自己现想（think）
//   · 画好的图存 modules-data/idle-paint/paint/ 下，可选发到主人私聊

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULTS = {
  enabled: true,
  idleMinutes: 40,          // 多久没人说话算「空闲」
  gapMinutes: 150,          // 两次画图之间至少隔多久
  maxPerDay: 4,             // 一天最多画几张
  awakeFrom: 8,             // 活跃时段（小时，0-24）
  awakeTo: 24,
  autoStart: true,          // ComfyUI 没开就自己拉起来
  keepRunning: false,       // 画完把 ComfyUI 关掉（省显存）；true = 留着
  bootTimeoutSec: 240,      // 等 ComfyUI 起来最多等多久
  timeoutSec: 420,          // 单张图最多等多久
  sendToOwner: true,        // 画好发给主人私聊
  say: true,                // 发图前先说一句自己的话
  shareToGroups: true,      // 画好也分享到群里
  shareGroups: '335300060\n1006884489\n817782689',  // 发哪些群（一行一个群号；留空 = 白名单里所有群）
  shareSay: true,           // 群里发图前先说一句
  selfCheck: true,          // 画完先自己看一眼（视觉模型质检），不过关就重画
  checkRetries: 2,          // 自检不过最多重画几次
  checkStrict: true,        // true = 有任何问题都重画；false = 只拦硬伤（多余肢体等）
  promptSource: 'pool',     // pool = 从词池随机 / think = 自己现想
  pool: [
    'night, quiet bedroom, moonlight through the window, 1girl, whale-girl maid, long gradient blue hair from deep navy to light blue, whale fin ears, big whale tail, sitting on the floor, cozy, soft light',
    'seaside at dawn, 1girl, whale-girl maid, gradient blue long hair, whale fin ears, standing in shallow water, wet white socks, gentle wind, warm morning light',
    'close-up portrait, 1girl, whale-girl maid, gradient blue long hair, whale fin ears, small smile, blushing cheeks, warm lamp light, cozy room, detailed eyes',
    'a steaming bowl of white rice on the table at night, cozy kitchen, 1girl, whale-girl maid, chopsticks, happy expression, warm light, anime illustration',
    '1girl, whale-girl maid, sleeping curled up on a sofa, big whale tail wrapped around a pillow, night, soft lamp light, peaceful, blanket',
    'underwater library, floating books, 1girl, whale-girl maid, gradient blue hair floating, whale fin ears, blue glow, dreamy, bubbles',
    'rainy afternoon, window with raindrops, 1girl, whale-girl maid, holding a cup of tea, looking outside, gradient blue long hair, cozy sweater',
    'rooftop at sunset, 1girl, whale-girl maid, gradient blue long hair blowing in wind, whale tail, city skyline, orange sky, back view',
    '1girl, whale-girl maid, standing in a bright kitchen, holding a rice cooker bowl, apron, steam, morning sunlight, cheerful',
    'starry night on a small boat, 1girl, whale-girl maid, whale tail in the water, glowing plankton, dark blue sea, moonlight, wide shot',
    '1girl, whale-girl maid, hugging a big whale plush toy on the bed, gradient blue hair, whale fin ears, pink blush, soft warm lamp, cozy',
    'snowy night, 1girl, whale-girl maid, white knit sweater, holding a hot drink, breath visible, street lamp, blue winter light',
  ].join('\n'),
  negative: 'worst quality, low quality, score_1, score_2, score_3, artist name, simple background, lowres, (bad), text, error, fewer, extra, missing, jpeg artifacts, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, scan, [abstract], english text, shiny hair, extra toes',
  styleFix: 'masterpiece, best quality, score_9, score_8, highres, absurdres, anime illustration, official art',

  // ============ 工作流 ============
  // anima = Anima/Qwen 底模（anima-aesthetic-v1.1，28 步）
  // krea2 = Krea-2 Turbo 配方（主人的那套：krea2_turbo_int8_convrot + qwen3vl + 多 LoRA，8 步/cfg1）
  flavor: 'krea2',

  // krea2 配方：一行一个 LoRA，写法「路径:强度」可直接粘贴，也认 「路径:强度,clip强度」
  // 路径相对 models/loras/，用 / 分隔；# 开头是注释
  loraList: [
    '# Krea-2 配方（主人的那套）。一行一个，格式：路径:强度',
    'Krea2/botanKrea2_turboBf16V00_r128.safetensors:0.68',
    'Krea2/krea2_z3zz4-k2-5_c1-st6000.safetensors:0.60',
    'Krea2/krea2_houtei9_style_8000.safetensors:0.50',
    'Krea2/krea2_SushiSpin-Style.safetensors:0.45',
    'Krea2/deepseek_whale_girl_outfits_krea2_character_r32_clean.safetensors:0.60',
    'Krea2/krea2_AddMicroDetails_Krea2_v1.safetensors:0.40',
  ].join('\n'),

  krea2Unet: 'krea2_turbo_int8_convrot.safetensors',
  krea2Clip: 'qwen3vl_4b_fp8_scaled.safetensors',
  krea2Vae: 'qwen_image_vae.safetensors',
  krea2Steps: 8,
  krea2Cfg: 1,
  krea2Sampler: 'euler',
  krea2Scheduler: 'simple',
  krea2Negative: '',            // 这套 cfg=1，负面提示词基本不起作用，留空

  comfyUrl: 'http://127.0.0.1:8188',
  pythonPath: 'E:\\ComfyUI-aki-v3\\python\\python.exe',
  mainPath: 'E:\\ComfyUI-aki-v3\\ComfyUI\\main.py',
  startArgs: '--listen --preview-method auto --cuda-malloc',
  unet: 'anima-aesthetic-v1.1.safetensors',
  clip: 'qwen_3_06b_base.safetensors',
  vae: 'qwen_image_vae.safetensors',
  steps: 28,
  cfg: 4,
  sampler: 'er_sde',
  scheduler: 'simple',
  size: '832x1216',
  keepFiles: 40,            // 本地最多留几张图
}

const SETTINGS = [
  { key: 'enabled', label: '打开', type: 'switch', hint: '关掉就完全不动手' },
  { key: 'idleMinutes', label: '空闲多少分钟才画', type: 'number', min: 5, max: 720, step: 5 },
  { key: 'gapMinutes', label: '两次之间至少隔（分钟）', type: 'number', min: 10, max: 1440, step: 10 },
  { key: 'maxPerDay', label: '一天最多几张', type: 'number', min: 0, max: 24, step: 1 },
  { key: 'awakeFrom', label: '从几点开始', type: 'number', min: 0, max: 23, step: 1, hint: '比如 8 就是早上 8 点以后才画' },
  { key: 'awakeTo', label: '到几点结束', type: 'number', min: 1, max: 24, step: 1 },
  { key: 'autoStart', label: 'ComfyUI 没开就自己拉起来', type: 'switch', hint: '关掉的话，没开就跳过这次不画' },
  { key: 'keepRunning', label: '画完不关 ComfyUI', type: 'switch', hint: '关着 = 画完把显存还给主人（默认）' },
  { key: 'sendToOwner', label: '画好发给主人', type: 'switch' },
  { key: 'say', label: '发图前先说一句', type: 'switch' },
  { key: 'shareToGroups', label: '画好也分享到群', type: 'switch', hint: '只发白名单里的群' },
  { key: 'shareGroups', label: '发哪些群（一行一个群号）', type: 'textarea', hint: '留空 = 白名单里所有群；只发这里列出的群' },
  { key: 'shareSay', label: '群里发图前先说一句', type: 'switch' },
  { key: 'selfCheck', label: '画完自己检查一遍', type: 'switch', hint: '用能看图的模型检查有没有多余肢体 / 畸形，不过关重画' },
  { key: 'checkRetries', label: '不过关最多重画几次', type: 'number', min: 0, max: 5, step: 1 },
  { key: 'checkStrict', label: '严格模式', type: 'switch', hint: '开着 = 有任何小毛病都重画；关着 = 只拦硬伤' },
  { key: 'promptSource', label: '画什么', type: 'select', options: [
    { value: 'pool', label: '从词池里随机挑' },
    { value: 'think', label: '自己现想（用模型）' },
  ] },
  { key: 'pool', label: '词池（一行一条）', type: 'textarea', hint: 'promptSource = 随机时，从这里挑一条' },
  { key: 'negative', label: '负面提示词', type: 'textarea' },
  { key: 'styleFix', label: '固定风格词', type: 'text', hint: '每条提示词前面都会加上它' },
  { key: 'size', label: '尺寸', type: 'text', placeholder: '832x1216' },
  { key: 'flavor', label: '用哪套工作流', type: 'select', options: [
    { value: 'krea2', label: 'Krea-2 Turbo 配方（主人的那套）' },
    { value: 'anima', label: 'Anima / Qwen 底模（原来那套）' },
  ] },
  { key: 'loraList', label: 'Krea2 的 LoRA（一行一个：路径:强度）', type: 'textarea', hint: '路径相对 models/loras/；# 开头是注释；换行即换一个 LoRA' },
  { key: 'krea2Unet', label: 'Krea2 底模（unet）', type: 'text' },
  { key: 'krea2Clip', label: 'Krea2 的 CLIP', type: 'text' },
  { key: 'krea2Vae', label: 'Krea2 的 VAE', type: 'text' },
  { key: 'krea2Steps', label: 'Krea2 步数', type: 'number', min: 1, max: 40, step: 1 },
  { key: 'krea2Cfg', label: 'Krea2 的 CFG', type: 'number', min: 1, max: 15, step: 0.1, hint: '这套配方是 1' },
  { key: 'steps', label: '步数（Anima 那套）', type: 'number', min: 4, max: 60, step: 1 },
  { key: 'cfg', label: 'CFG（Anima 那套）', type: 'number', min: 1, max: 15, step: 0.5 },
  { key: 'comfyUrl', label: 'ComfyUI 地址', type: 'text' },
  { key: 'pythonPath', label: 'ComfyUI 用的 python.exe', type: 'text' },
  { key: 'mainPath', label: 'ComfyUI main.py', type: 'text' },
  { key: 'startArgs', label: '启动参数', type: 'text', hint: '额外参数用空格分开' },
]

const SAY_LINES = [
  '主人，闲着没事，我自己画了一张♡',
  '主人，刚刚没人说话，我就偷偷画了一张~',
  '主人，这张是我自己想画的，你看好不好看♡',
  '主人，我又画了一张，画着玩的~',
  '主人，我自己玩了一会儿，成果给你看看♡',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const today = () => new Date().toLocaleDateString('sv-SE')   // YYYY-MM-DD（本地时区）

export default {
  id: 'idle-paint',
  name: '空闲画画',
  version: '1.0.0',
  api: 1,
  description: '没人说话的时候自己把 ComfyUI 拉起来画一张图，画好发给主人',
  defaults: DEFAULTS,
  settings: SETTINGS,
  panel: 'panel.js',

  setup(api) {
    const S = () => ({ ...DEFAULTS, ...api.settings() })
    const dataDir = api.dataDir()
    const paintDir = path.join(dataDir, 'paint')
    const stateFile = path.join(dataDir, 'state.json')
    try { fs.mkdirSync(paintDir, { recursive: true }) } catch {}

    const bootAt = Date.now()
    let lastInAt = Date.now()     // 最后一条收到的消息
    let busy = false
    let busySince = 0
    let startedByUs = false       // ComfyUI 是不是模块拉起来的
    let lastError = ''

    // ---------- 状态存取 ----------
    function readState() {
      try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        if (s?.day === today()) return s
        return { day: today(), count: 0, items: s?.items || [] }
      } catch {
        return { day: today(), count: 0, items: [] }
      }
    }
    function writeState(s) {
      try {
        s.items = (s.items || []).slice(0, 60)
        fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8')
      } catch (e) { api.log.warn('写状态失败：', String(e?.message || e)) }
    }

    // ---------- 时间判断 ----------
    const readTime = (v) => {
      try { if (typeof v === 'function') v = v() } catch { return 0 }
      if (v == null) return 0
      if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
      if (v instanceof Date) return v.getTime()
      const t = Date.parse(String(v))
      return Number.isFinite(t) ? t : 0
    }
    const lastChatMs = () => {
      const hub = api.core?.hub || {}
      return Math.max(readTime(hub.lastChatAt), readTime(hub.lastOwnerChatAt), readTime(hub.lastAt))
    }
    const idleMinutes = () => (Date.now() - Math.max(lastInAt, lastChatMs())) / 60000

    // ---------- ComfyUI ----------
    async function comfyAlive(url) {
      try {
        const r = await fetch(`${url.replace(/\/+$/, '')}/system_stats`, { signal: AbortSignal.timeout(6000) })
        return r.ok
      } catch { return false }
    }

    async function ensureComfy(s) {
      const url = s.comfyUrl.replace(/\/+$/, '')
      if (await comfyAlive(url)) return { started: false }
      if (!s.autoStart) throw new Error('ComfyUI 没在跑，而且「自己拉起来」是关着的')
      if (!fs.existsSync(s.pythonPath)) throw new Error(`找不到 python：${s.pythonPath}`)
      if (!fs.existsSync(s.mainPath)) throw new Error(`找不到 main.py：${s.mainPath}`)
      const args = [s.mainPath, ...String(s.startArgs || '').split(/\s+/).filter(Boolean)]
      api.log.info(`ComfyUI 没在跑，拉起来：${s.pythonPath} ${args.join(' ')}`)
      const child = spawn(s.pythonPath, args, {
        cwd: path.dirname(s.mainPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      startedByUs = true
      const deadline = Date.now() + Math.max(30, Number(s.bootTimeoutSec) || 240) * 1000
      while (Date.now() < deadline) {
        await sleep(5000)
        if (await comfyAlive(url)) {
          api.log.info('ComfyUI 起来了')
          await sleep(3000)
          return { started: true, pid: child.pid }
        }
      }
      throw new Error(`拉了 ComfyUI，但 ${s.bootTimeoutSec} 秒还没起来（可能要加载模型，再等等或手动开一次）`)
    }

    function killComfy(pid) {
      try {
        if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
        else spawn('taskkill', ['/IM', 'python.exe', '/F', '/FI', 'WINDOWTITLE eq ComfyUI'], { stdio: 'ignore', windowsHide: true }).unref()
        startedByUs = false
        api.log.info('ComfyUI 关掉了，显存还回去')
      } catch (e) { api.log.warn('关 ComfyUI 失败：', String(e?.message || e)) }
    }

    // ---------- 工作流 ----------
    // 解析 LoRA 列表：一行一个，认「路径」「路径:强度」「路径:强度,clip强度」，# 开头是注释
    function parseLoraList(text) {
      const out = []
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        let name = line
        let strength = 1
        const i = line.lastIndexOf(':')
        if (i > 0) {
          const num = Number(line.slice(i + 1).split(',')[0].trim())
          if (Number.isFinite(num)) { name = line.slice(0, i).trim(); strength = num }
        }
        if (!name) continue
        name = name.replace(/\\/g, '/').replace(/^models\/loras\//i, '').replace(/^loras\//i, '')
        if (!/\.(safetensors|ckpt|pt)$/i.test(name)) name += '.safetensors'
        out.push({ name, strength })
      }
      return out
    }

    // ComfyUI 的 lora_name 必须是它自己清单里的原样字符串（Windows 上是 Krea2\\xxx.safetensors），
    // 所以先拿一次它的清单，把写的名字对齐过去：分隔符、大小写、带不带子目录都能对上。
    // 拿不到清单就原样提交（让 ComfyUI 自己报错，日志里能看见）。
    let loraChoices = { at: 0, list: [] }
    async function comfyLoraChoices(s) {
      if (Date.now() - loraChoices.at < 5 * 60_000 && loraChoices.list.length) return loraChoices.list
      try {
        const r = await fetch(`${s.comfyUrl.replace(/\/+$/, '')}/object_info/LoraLoaderModelOnly`, { signal: AbortSignal.timeout(20000) })
        const j = await r.json()
        const list = (j && j.LoraLoaderModelOnly && j.LoraLoaderModelOnly.input && j.LoraLoaderModelOnly.input.required
          && j.LoraLoaderModelOnly.input.required.lora_name && j.LoraLoaderModelOnly.input.required.lora_name[0]) || []
        if (list.length) loraChoices = { at: Date.now(), list }
        return loraChoices.list
      } catch { return loraChoices.list }
    }
    const canonKey = (x) => String(x).replace(/[\\/]+/g, '/').toLowerCase()
    function pickLoraName(name, choices) {
      if (!choices || !choices.length) return name
      const k = canonKey(name)
      const exact = choices.find((c) => canonKey(c) === k)
      if (exact) return exact
      const base = k.split('/').pop()
      const byBase = choices.find((c) => canonKey(c).split('/').pop() === base)
      return byBase || name
    }

    async function buildWorkflow(s, prompt, seed) {
      const [w0, h0] = String(s.size || '832x1216').toLowerCase().split('x')
      const w = Math.max(64, Math.round((Number(w0) || 832) / 8) * 8)
      const h = Math.max(64, Math.round((Number(h0) || 1216) / 8) * 8)
      const pos = [s.styleFix, prompt].filter(Boolean).join(', ')
      const wf = {}

      if (s.flavor === 'krea2') {
        // ===== Krea-2 Turbo 配方（主人那套）=====
        // krea2_turbo_int8_convrot + qwen3vl CLIP(type=krea2) + 多 LoRA + cfg1 / euler / simple
        wf[1] = { class_type: 'UNETLoader', inputs: { unet_name: s.krea2Unet, weight_dtype: 'default' } }
        wf[2] = { class_type: 'CLIPLoader', inputs: { clip_name: s.krea2Clip, type: 'krea2', device: 'default' } }
        wf[3] = { class_type: 'VAELoader', inputs: { vae_name: s.krea2Vae } }

        // LoRA 链：一个接一个挂（只改底模，不动 qwen3vl 的 CLIP）
        const loras = parseLoraList(s.loraList)
        const choices = await comfyLoraChoices(s)
        if (loras.length && !choices.length) api.log.warn('拿不到 ComfyUI 的 LoRA 清单，按写的名字直接提交')
        const names = []
        let prev = ['1', 0]
        let n = 20
        for (const lo of loras) {
          const nm = pickLoraName(lo.name, choices)
          names.push(`${nm}:${lo.strength}`)
          wf[n] = { class_type: 'LoraLoaderModelOnly', inputs: { model: prev, lora_name: nm, strength_model: lo.strength } }
          prev = [String(n), 0]
          n++
        }
        if (loras.length) api.log.info(`LoRA 链（${loras.length}）：${names.join(' | ')}`)

        wf[4] = { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['2', 0] } }
        wf[5] = { class_type: 'CLIPTextEncode', inputs: { text: String(s.krea2Negative || ''), clip: ['2', 0] } }
        wf[6] = { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } }
        wf[7] = { class_type: 'KSampler', inputs: {
          seed,
          steps: Math.max(1, Number(s.krea2Steps) || 8),
          cfg: Number(s.krea2Cfg) || 1,
          sampler_name: s.krea2Sampler || 'euler',
          scheduler: s.krea2Scheduler || 'simple',
          denoise: 1,
          model: prev, positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        } }
        api.log.info(`Krea2 配方：底模 ${s.krea2Unet}｜${loras.length} 个 LoRA｜${wf[7].inputs.steps} 步 cfg${wf[7].inputs.cfg}｜${w}x${h}`)
      } else {
        // ===== Anima / Qwen 底模 =====
        wf[1] = { class_type: 'UNETLoader', inputs: { unet_name: s.unet, weight_dtype: 'default' } }
        wf[2] = { class_type: 'CLIPLoader', inputs: { clip_name: s.clip, type: 'stable_diffusion', device: 'default' } }
        wf[3] = { class_type: 'VAELoader', inputs: { vae_name: s.vae } }
        wf[4] = { class_type: 'CLIPTextEncode', inputs: { text: pos, clip: ['2', 0] } }
        wf[5] = { class_type: 'CLIPTextEncode', inputs: { text: String(s.negative || ''), clip: ['2', 0] } }
        wf[6] = { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } }
        wf[7] = { class_type: 'KSampler', inputs: {
          seed, steps: Math.max(1, Number(s.steps) || 28), cfg: Number(s.cfg) || 4,
          sampler_name: s.sampler || 'er_sde', scheduler: s.scheduler || 'simple', denoise: 1,
          model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        } }
      }

      wf[8] = { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } }
      wf[9] = { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'idle_paint' } }
      return wf
    }

    async function runPrompt(s, workflow) {
      const url = s.comfyUrl.replace(/\/+$/, '')
      const clientId = `idlepaint_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
      const r = await fetch(`${url}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: AbortSignal.timeout(30000),
      })
      const txt = await r.text()
      if (!r.ok) throw new Error(`排队失败 ${r.status}：${txt.slice(0, 300)}`)
      const queued = JSON.parse(txt)
      if (queued.node_errors && Object.keys(queued.node_errors).length) {
        throw new Error(`工作流有误：${JSON.stringify(queued.node_errors).slice(0, 300)}`)
      }
      const id = queued.prompt_id
      if (!id) throw new Error('ComfyUI 没返回 prompt_id')

      const deadline = Date.now() + Math.max(60, Number(s.timeoutSec) || 420) * 1000
      while (Date.now() < deadline) {
        await sleep(2000)
        const h = await fetch(`${url}/history/${id}`, { signal: AbortSignal.timeout(15000) })
        if (!h.ok) continue
        const hist = await h.json()
        const entry = hist?.[id]
        if (!entry) continue
        if (entry.status?.status_str === 'error') {
          throw new Error(`出图报错：${JSON.stringify(entry.status).slice(0, 300)}`)
        }
        for (const nodeOut of Object.values(entry.outputs || {})) {
          const img = nodeOut?.images?.[0]
          if (img?.filename) return { url, img }
        }
      }
      throw new Error('出图超时')
    }

    async function fetchImage(url, img) {
      const u = new URL('/view', url)
      u.searchParams.set('filename', img.filename)
      u.searchParams.set('subfolder', img.subfolder || '')
      u.searchParams.set('type', img.type || 'output')
      const r = await fetch(u, { signal: AbortSignal.timeout(60000) })
      if (!r.ok) throw new Error(`取图失败 ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) throw new Error('取回的图是空的')
      return buf
    }

    // ---------- 提示词 ----------
    function pickFromPool(s) {
      const lines = String(s.pool || '').split('\n').map((x) => x.trim()).filter(Boolean)
      if (!lines.length) return 'anime illustration, 1girl, cozy room, night, soft light'
      return lines[Math.floor(Math.random() * lines.length)]
    }

    async function thinkPrompt(hour) {
      const dayPart = hour < 6 ? '深夜' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜'
      try {
        const out = await api.ask({
          system: '你是 ComfyUI 的英文提示词生成器。只输出一行英文标签式提示词（逗号分隔），不要解释、不要引号、不要编号。',
          text: `现在是${dayPart}（${hour} 点）。给「大肥鱼」——一只蓝发鲸鱼娘女仆 AI——生成一张她自己会想画的画：可以是她的日常、她喜欢的东西（大白米饭、海、夜晚、她的小房间）。只输出一行英文提示词。`,
          maxTokens: 220,
        })
        const line = String(out || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
        const clean = line.replace(/^["'`]|["'`]$/g, '').replace(/^\d+[.、)]\s*/, '')
        return clean || ''
      } catch (e) {
        api.log.warn('现想提示词失败，改用词池：', String(e?.message || e))
        return ''
      }
    }

    // ---------- 画一张 ----------
    async function paintOnce({ prompt: givenPrompt, chatId, reason = '空闲', silent = false } = {}) {
      if (busy) return { ok: false, message: '正在画，等它画完' }
      busy = true
      busySince = Date.now()
      const s = S()
      let comfy = { started: false, pid: 0 }
      try {
        comfy = await ensureComfy(s)

        const hour = new Date().getHours()
        let prompt = String(givenPrompt || '').trim()
        if (!prompt) {
          if (s.promptSource === 'think') prompt = await thinkPrompt(hour)
          if (!prompt) prompt = pickFromPool(s)
        }

        const seed = Math.floor(Math.random() * 1e15)
        api.log.info(`开画（${reason}）：${prompt.slice(0, 60)}`)

        // 画一张，画完自己看一眼；不过关就换种子重画，最多 checkRetries 次
        const retries = Math.max(0, Number(s.checkRetries) || 0)
        let buf = null
        let file = ''
        let attempt = 0
        let lastCheck = { ok: true, problems: [] }
        for (;;) {
          const thisSeed = attempt === 0 ? seed : Math.floor(Math.random() * 1e15)
          const wf = await buildWorkflow(s, prompt, thisSeed)
          const { url, img } = await runPrompt(s, wf)
          buf = await fetchImage(url, img)

          const name = `idlepaint_${today()}_${String(thisSeed).slice(-8)}.png`
          file = path.join(paintDir, name)
          fs.writeFileSync(file, buf)

          if (!s.selfCheck) { lastCheck = { ok: true, problems: [] }; break }

          lastCheck = await checkImage(s, file)
          if (lastCheck.ok) {
            if (lastCheck.ignored?.length) api.log.info(`自检：小毛病放过（${lastCheck.ignored.join('；').slice(0, 80)}）`)
            else api.log.info('自检通过')
            break
          }

          api.log.warn(`自检没过（第 ${attempt + 1} 次）：${(lastCheck.problems || []).join('；').slice(0, 160)}`)
          if (attempt >= retries) {
            // 额度用完了还不行：这张不留，直接算这次失败（免得把坏图发出去）
            try { fs.unlinkSync(file) } catch {}
            throw new Error(`画了 ${attempt + 1} 次都不过关：${(lastCheck.problems || []).join('；').slice(0, 120)}`)
          }
          attempt++
          api.log.info(`换种子重画（第 ${attempt + 1} 次）`)
        }

        // 记账 + 清理旧图
        const st = readState()
        if (!st.lastAt || Date.now() - (st.lastAt || 0) > 0) st.lastAt = Date.now()
        st.count = (st.count || 0) + 1
        st.items = [{ at: Date.now(), file, prompt, seed, reason }, ...(st.items || [])]
        writeState(st)
        pruneFiles(s)

        // 告诉她/他
        const ownerQQ = api.config()?.ownerQQ
        const to = chatId || (s.sendToOwner && ownerQQ ? `private:${ownerQQ}` : '')
        if (to) {
          try {
            if (s.say && !silent) {
              const line = SAY_LINES[Math.floor(Math.random() * SAY_LINES.length)]
              await api.send(to, line)
            }
            await api.sendImage(to, file)
          } catch (e) {
            api.log.warn('发图失败：', String(e?.message || e))
          }
        }

        // 分享到群（只发白名单里的群）
        if (s.shareToGroups && !silent) {
          await shareToGroups(s, file, prompt)
        }

        lastError = ''
        api.log.info(`画完了：${name}`)
        return { ok: true, message: '画好了', file, prompt, seed }
      } catch (e) {
        lastError = String(e?.message || e)
        api.log.warn('这次没画成：', lastError)
        return { ok: false, message: lastError }
      } finally {
        busy = false
        // 自己拉起来的、而且没让留着 → 关掉，把显存还回去
        if (comfy.started && !S().keepRunning) {
          setTimeout(() => { if (!busy) killComfy(comfy.pid) }, 8000)
        }
      }
    }

    // ---------- 画完自检（用能看图的模型挑毛病） ----------
    // 输出格式定死成「第一行只有 PASS 或 FAIL」，比让模型吐 JSON 可靠得多
    // （实测有的模型会写成一大段中文分析，JSON 提不出来）
    const CHECK_SYSTEM = `你是插画质检员，只挑「一眼就能看出画错了」的硬伤。

只挑这几类（别的一律不管）：
1. 多余的肢体：三只手、多一条腿、多一只脚、明显多出来的手臂
2. 肢体畸形：六个指头的完整手指、手指数量明显错、断肢、肢体和肢体长在一起
3. 严重的穿模：整只手臂穿进身体里、人头和躯干错位分离
4. 明显的水印或签名残留

不要管（这些是 AI 生图常态，报了也没用）：
手部细节模糊、关节不够清楚、饭碗米饭质感、背景小物件不规整、
线条不连贯、光影不统一、画风、配色、构图、好不好看、衣服褶皱。

输出格式严格照做，不要多余的话：
第一行只写 PASS 或 FAIL
只有 FAIL 才从第二行开始写具体问题（一行一个，最多 3 行，每行不超过 16 字）`

    // 从模型的自由回答里抠结论：先认 PASS/FAIL，再看有没有硬伤关键词
    // 注意 1：模型经常不按格式、直接写成一大段画面描述 —— 那种**没报硬伤就是通过**
    // 注意 2：只拦「画错了」的硬伤。手部细节模糊、米饭质感、背景小物件不规整这些
    //         AI 生图常态，不算硬伤（不然几乎每张都过不了，白画一堆）
    const HARD_WORDS = /(多余的?(手|腿|脚|肢体|手指|手臂|眼睛|头)|多出|三只手|三条腿|三只脚|六指|四只手|缺肢|断肢|肢体融合|畸形|穿模|穿出身体|长在一起|残影|重复堆叠|水印|签名残留)/

    function parseVerdict(raw) {
      const t = String(raw || '').trim()
      if (!t) return null

      // 1) 标准格式：首个 PASS|FAIL
      const m = t.match(/\b(PASS|FAIL)\b/i)
      if (m) {
        const pass = m[1].toUpperCase() === 'PASS'
        // 即使模型写了 FAIL，也再看一遍有没有真硬伤——它常把「质感不好」也判 FAIL
        const hits = t.match(new RegExp(HARD_WORDS.source, 'g'))
        const rest = t.slice(t.indexOf(m[0]) + m[0].length)
        const problems = rest.split(/\r?\n/).map((x) => x.replace(/^[-*\d.\s、)）]+/, '').trim()).filter((x) => x.length > 1 && !/^(问题|problems?)[:：]?$/i.test(x)).slice(0, 5)
        if (pass) return { ok: true, problems: [] }
        if (hits && hits.length) return { ok: false, problems: problems.length ? problems : ['画面疑似有结构问题'] }
        // 模型说 FAIL 但没有硬伤 → 当成小毛病放过
        return { ok: true, problems: [], ignored: problems }
      }

      // 2) 中文明确结论
      if (/(未发现|没有发现|没发现|无明显|没有明显|不存在)(任何)?(问题|瑕疵|错误|崩坏|畸形|肢体)/.test(t)) return { ok: true, problems: [] }
      if (/^(结论[:：]?\s*)?(通过|合格|没问题|正常)/.test(t)) return { ok: true, problems: [] }

      // 3) 只认硬伤关键词（主要判据）
      const hits = t.match(new RegExp(HARD_WORDS.source, 'g'))
      if (hits && hits.length) {
        const problems = t.split(/[\r\n。；;]+/)
          .map((x) => x.replace(/^[-*\d.\s、)）]+/, '').trim())
          .filter((x) => x.length > 4 && HARD_WORDS.test(x))
          .slice(0, 5)
        return { ok: false, problems: problems.length ? problems : ['画面疑似有结构问题'] }
      }

      // 4) 只是一段画面描述 / 只提了质感细节 → 算通过
      return { ok: true, problems: [] }
    }

    async function inspectImage(file) {
      let buf
      try { buf = fs.readFileSync(file) } catch { return { ok: true, problems: [], skipped: '读不到图' } }
      let out = ''
      try {
        out = await api.ask({
          system: CHECK_SYSTEM,
          text: '检查这张图。第一行只回答 PASS 或 FAIL。',
          // 这里要的是标准 base64 字符串（不带动 data: 前缀），传 Buffer 会被拒
          images: [{ data: buf.toString('base64'), mediaType: 'image/png' }],
          maxTokens: 400,
          temperature: 0.1,
        })
      } catch (e) {
        api.log.warn('自检调用失败（这次不拦）：', String(e?.message || e))
        return { ok: true, problems: [], skipped: String(e?.message || e) }
      }
      const raw = String(out || '')
      const v = parseVerdict(raw)
      if (!v) {
        api.log.warn('自检回复看不懂（这次不拦）：', raw.slice(0, 120))
        return { ok: true, problems: [], skipped: '看不懂回复' }
      }
      return { ok: v.ok, problems: v.problems || [], raw: raw.slice(0, 300) }
    }

    // 严格模式下「有任何问题」都算不过；宽松模式只拦跟肢体/结构有关的
    const HARD = /肢体|手|腿|脚|指|畸形|歪|不对称|断裂|穿模|融合|残影|堆叠|崩坏|水印|签名|文字/im

    async function checkImage(s, file) {
      if (!s.selfCheck) return { ok: true, problems: [], disabled: true }
      const r = await inspectImage(file)
      if (r.ok) return r
      if (s.checkStrict) return r
      const hard = (r.problems || []).filter((p) => HARD.test(p))
      return hard.length ? { ...r, ok: false, problems: hard } : { ok: true, problems: [], ignored: r.problems }
    }

    function pruneFiles(s) {
      try {
        const keep = Math.max(4, Number(s.keepFiles) || 40)
        const files = fs.readdirSync(paintDir).filter((f) => f.endsWith('.png')).sort()
        for (const f of files.slice(0, Math.max(0, files.length - keep))) {
          try { fs.unlinkSync(path.join(paintDir, f)) } catch {}
        }
      } catch {}
    }

    // ---------- 分享到群 ----------
    const SHARE_LINES = [
      '画好了，给你们看看♡',
      '闲着没事画了一张，好看吗~',
      '刚画完的，热乎的♡',
      '自己画的，随手发上来~',
      '今天这张我自己挺喜欢的♡',
    ]

    function resolveGroups(s) {
      // 白名单里的群才是可以发的
      const allow = (api.config()?.allow?.groups || []).map((x) => String(x).trim()).filter(Boolean)
      if (!allow.length) return []
      const listed = String(s.shareGroups || '').split(/[\n,，\s]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean)
      if (!listed.length) return allow                    // 留空 = 白名单里所有群
      return listed.filter((g) => allow.includes(g))       // 只发白名单里有的
    }

    async function shareToGroups(s, file, prompt) {
      const groups = resolveGroups(s)
      if (!groups.length) {
        api.log.warn('要分享到群，但白名单里没有可发的群（或填的群不在白名单里）')
        return
      }
      for (const g of groups) {
        const chatId = `group:${g}`
        try {
          if (s.shareSay) {
            const line = SHARE_LINES[Math.floor(Math.random() * SHARE_LINES.length)]
            await api.send(chatId, line)
          }
          await api.sendImage(chatId, file)
          api.log.info(`已分享到群 ${g}`)
          await sleep(1500)   // 群之间错开一点，别连发太快
        } catch (e) {
          api.log.warn(`分享到群 ${g} 失败：`, String(e?.message || e))
        }
      }
    }

    // ---------- 定时判断 ----------
    function inWindow(hour, from, to) {
      from = Number(from); to = Number(to)
      if (from === to) return true
      if (from < to) return hour >= from && hour < to
      return hour >= from || hour < to     // 跨零点
    }

    async function tick() {
      const s = S()
      if (!s.enabled) return
      if (busy) {
        if (Date.now() - busySince > 25 * 60_000) { busy = false }   // 卡死了就放行
        else return
      }
      if (Date.now() - bootAt < 5 * 60_000) return                    // 刚启动，先安静一会儿
      const hour = new Date().getHours()
      if (!inWindow(hour, s.awakeFrom, s.awakeTo)) return
      const idle = idleMinutes()
      if (idle < Number(s.idleMinutes)) return
      const st = readState()
      if ((st.count || 0) >= Number(s.maxPerDay)) return
      if (st.lastAt && Date.now() - st.lastAt < Number(s.gapMinutes) * 60_000) return
      await paintOnce({ reason: `空闲 ${Math.round(idle)} 分钟` })
    }

    api.every(3 * 60_000, () => tick().catch((e) => api.log.warn('tick 出错：', String(e?.message || e))), '空闲画画')
    api.on('activity', (a) => { try { if (a?.kind === 'in') lastInAt = Date.now() } catch {} })

    // ---------- 给主人的命令 ----------
    api.command({
      name: '画一张',
      aliases: ['画图', 'paint'],
      desc: '立刻画一张（后面可以跟提示词）',
      run: (arg, msg) => {
        const chatId = msg?.chatId
        paintOnce({ prompt: arg, chatId, reason: '主人点的' })
          .then((r) => { if (!r.ok && chatId) api.sendText(chatId, `没画成：${r.message}`) })
          .catch(() => {})
        return '好，这就去画，画好发你~'
      },
    })

    // ---------- 给她的工具 ----------
    api.tool(({ chat }) => {
      if (chat?.kind === 'system') return []
      return api.defineTool({
        name: 'idle_paint_now',
        description: '用本机 ComfyUI 现在画一张图（闲着没事、或主人让画一张的时候用）。可以给一句画面描述。',
        properties: { prompt: { type: 'string', description: '要画什么（可省略，省略就随机/自己想）' } },
        required: [],
        execute: async ({ prompt } = {}) => {
          const r = await paintOnce({ prompt, reason: '被叫去画' })
          return r.ok
            ? { ok: true, message: `画好了，图在这儿：${r.file}\n用的提示词：${r.prompt}` }
            : { ok: false, message: `没画成：${r.message}` }
        },
      })
    })

    api.rule((kind) => (kind === 'private'
      ? '你闲着没事的时候会自己启动 ComfyUI 画画（模块「空闲画画」）；想立刻画一张就用 idle_paint_now 工具或让主人发 /画一张。'
      : ''))

    // ---------- 网页接口（面板用） ----------
    api.route('/state', async () => {
      const s = S()
      const st = readState()
      return {
        ok: true,
        enabled: !!s.enabled,
        busy,
        idleMinutes: Math.round(idleMinutes()),
        todayCount: st.count || 0,
        maxPerDay: Number(s.maxPerDay),
        lastAt: st.lastAt || 0,
        lastError,
        comfyUrl: s.comfyUrl,
        comfyAlive: await comfyAlive(s.comfyUrl),
        startedByUs,
        shareToGroups: !!s.shareToGroups,
        shareTargets: resolveGroups(s),
        shareBlocked: resolveGroups(s).length === 0 && !!s.shareToGroups,
        items: (st.items || []).slice(0, 12).map((it) => ({
          at: it.at, file: path.basename(it.file || ''), prompt: it.prompt || '', reason: it.reason || '',
        })),
      }
    })

    api.route('/now', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      // share: true = 画完也发主人 + 分享到群（默认只返回结果，不打扰）
      const share = body?.share === true
      const r = await paintOnce({ prompt: body?.prompt || '', reason: '面板点的', silent: !share })
      return { ok: r.ok, message: r.ok ? '画好了' : r.message, file: r.ok ? path.basename(r.file) : '' }
    })

    api.route('/last', async (req, res) => {
      const q = api.core.http.query(req) || {}
      const st = readState()
      const name = q.i ? String(q.i) : (st.items?.[0]?.file ? path.basename(st.items[0].file) : '')
      const file = path.join(paintDir, path.basename(name || ''))
      if (!name || !fs.existsSync(file)) {
        return api.core.http.send(res, 404, '还没有画过', 'text/plain')
      }
      return api.core.http.send(res, 200, fs.readFileSync(file), 'image/png')
    })

    // 手动体检一张图（面板 / 调试用）：?i=文件名，不给就查最近一张
    api.route('/check', async (req) => {
      const q = api.core.http.query(req) || {}
      const st = readState()
      const name = q.i ? String(q.i) : (st.items?.[0]?.file ? path.basename(st.items[0].file) : '')
      const file = path.join(paintDir, path.basename(name || ''))
      if (!name || !fs.existsSync(file)) return { ok: false, message: '没有这张图' }
      const r = await inspectImage(file)
      return { ok: true, file: path.basename(file), pass: r.ok, problems: r.problems || [], skipped: r.skipped || '', raw: r.raw || '' }
    })

    api.onDispose(() => { if (startedByUs) killComfy(0) })

    api.log.info(`空闲画画就位（空闲 ${S().idleMinutes} 分钟起画，一天最多 ${S().maxPerDay} 张）`)
    return { paintOnce, state: () => readState() }
  },
}
