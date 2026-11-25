// 通话（Aurabot 原生模块）v0.4
// 链路：浏览器 VAD 自动断句（不用按住）→ 录 16k 单声道 PCM → POST /turn/stream
//       → 耳朵：适配层识别（本地 faster-whisper / OpenAI 兼容 / 自定义 HTTP）
//       → api.think()（她本人：人格、记忆、心情、房间感知都在）
//       → 嘴巴：适配层合成（本地 GPT-SoVITS / CosyVoice、线上 edge / OpenAI 兼容 / 自定义 HTTP）
//       → SSE 按句推流，页面边收边播；先垫一句「嗯？」盖住思考的空白
// 换个平台当「嘴」只需要在设置里填地址和密钥，见 lib/providers.js 与 PROVIDERS.md。
// 不经过 DSH 聊天管道，也不进出 QQ；音频和状态都写在 dataDir。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, unlinkSync, copyFileSync, createWriteStream } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { once } from 'node:events'
import * as providers from './lib/providers.mjs'
import * as selfcert from './lib/selfcert.mjs'

const MAX_AUDIO_BYTES = 16 * 1024 * 1024 // 一段话的上限，16MB 够说十分钟
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.html': 'text/html; charset=utf-8',
}

/** 裸 PCM16 单声道 → 加个 WAV 头（DSH 的识别只吃 16k 单声道 PCM16 WAV） */
function pcmToWav(pcm, sampleRate = 16000) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // 单声道
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

const isWav = (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'

export default {
  id: 'voicecall',
  name: '通话',
  version: '1.0.0',
  api: 1,
  description: '免按住通话：VAD 自动断句，她用自己的声音边想边念。耳朵和嘴都能换成本地服务或任意线上平台。',
  panel: 'panel.js',
  defaults: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '',
    maxChars: 120,
    lanHttps: false,
    httpsPort: 8443,
    asrProvider: 'local',
    asrLang: 'zh',
    ttsProvider: 'follow',
    ttsFormat: 'pcm',
    ttsSampleRate: 24000,
  },
  settings: [
    { key: 'asrProvider', label: '耳朵：语音识别', type: 'select', options: [
      { value: 'local', label: '本地 faster-whisper（默认，不花钱）' },
      { value: 'openai', label: 'OpenAI 兼容接口（线上）' },
      { value: 'http', label: '自定义 HTTP（任意平台）' },
    ], hint: '换哪家都只改这里，不用改代码' },
    { key: 'asrUrl', label: '识别接口地址', type: 'text', placeholder: 'https://api.openai.com/v1', hint: '本地留空即可（默认 127.0.0.1:8000）；线上填到 /v1 为止，也可以直接填完整的 /audio/transcriptions' },
    { key: 'asrKey', label: '识别 API Key', type: 'password', hint: '本地服务不用填' },
    { key: 'asrModel', label: '识别模型', type: 'text', placeholder: 'small / whisper-1', hint: '本地填 small、medium；线上按平台填，如 whisper-1、FunAudioLLM/SenseVoiceSmall' },
    { key: 'asrLang', label: '识别语言', type: 'text', placeholder: 'zh', hint: '中文填 zh；不填默认 zh' },
    { key: 'asrPrompt', label: '识别热词（可选）', type: 'text', hint: '把常说的名字、地名、行话写进来，能明显少出错' },
    { key: 'asrTemplate', label: '自定义转写模板（JSON）', type: 'textarea', hint: '只有耳朵选「自定义 HTTP」才用。见模块目录 PROVIDERS.md 的示例' },
    { key: 'ttsProvider', label: '嘴：语音合成', type: 'select', options: [
      { value: 'follow', label: '跟随「语音」页设置（默认）' },
      { value: 'gptsovits', label: '本地 GPT-SoVITS（流式，首句最快）' },
      { value: 'cosyvoice', label: '本地 CosyVoice' },
      { value: 'edge', label: '微软 edge-tts（线上，免费）' },
      { value: 'openai', label: 'OpenAI 兼容接口（线上）' },
      { value: 'http', label: '自定义 HTTP（任意平台）' },
      { value: 'windows', label: 'Windows 自带语音（离线兜底）' },
    ], hint: '默认沿用插件「语音」页的引擎，老配置零改动' },
    { key: 'ttsUrl', label: '合成接口地址', type: 'text', placeholder: 'https://api.openai.com/v1', hint: '填到 /v1 为止，也可以直接填完整的 /audio/speech' },
    { key: 'ttsKey', label: '合成 API Key', type: 'password', hint: '本地服务不用填' },
    { key: 'ttsModel', label: '合成模型', type: 'text', placeholder: 'tts-1 / FunAudioLLM/CosyVoice2-0.5B' },
    { key: 'ttsVoice', label: '音色（voice）', type: 'text', placeholder: 'alloy / zh-CN-XiaoxiaoNeural', hint: '线上平台大多要填，具体看平台文档' },
    { key: 'ttsFormat', label: '返回格式', type: 'text', placeholder: 'pcm', hint: 'pcm 能边合成边播（默认，最快）；平台不支持就填 mp3' },
    { key: 'ttsSpeed', label: '语速', type: 'text', placeholder: '1.0 或 +10%', hint: 'OpenAI 兼容填 0.5–2 的数字；edge 填 +10% 这种' },
    { key: 'ttsSampleRate', label: 'PCM 采样率', type: 'number', min: 8000, max: 48000, step: 1000, hint: 'OpenAI 兼容接口通常 24000，不确定就保持默认' },
    { key: 'ttsTemplate', label: '自定义合成模板（JSON）', type: 'textarea', hint: '只有嘴选「自定义 HTTP」才用。见 PROVIDERS.md 的示例' },
    { key: 'maxChars', label: '一次最多说多少字', type: 'number', min: 20, max: 500, step: 10, hint: '电话里话别太长，长了反而不像人' },
    { key: 'lanHttps', label: '局域网 HTTPS（手机用）', type: 'switch', hint: '默认关闭。打开后只放行通话模块自己的接口，且必须带会话令牌（面板「复制手机地址」里含令牌）；不需要手机通话就别开' },
    { key: 'httpsPort', label: '局域网 HTTPS 端口', type: 'number', min: 1024, max: 65535, step: 1, hint: '默认 8443，被占用就换一个' },
  ],

  setup(api) {
    const dataDir = api.dataDir()
    const audioDir = join(dataDir, 'audio')
    mkdirSync(audioDir, { recursive: true })
    const log = api.log
    const settings = () => api.settings() || {}

    // 打断：页面按住说话时置位，本轮后面的合成/返回就作废
    let interrupted = false
    let busy = false

    // 顺手清掉两小时前的音频，别把磁盘塞满
    const sweep = () => {
      try {
        for (const name of readdirSync(audioDir)) {
          const p = join(audioDir, name)
          if (Date.now() - statSync(p).mtimeMs > 2 * 3600_000) unlinkSync(p)
        }
      } catch (error) {
        /* 清理失败不影响通话 */
      }
    }
    sweep()

    // ---- 手机访问：局域网 HTTPS 反向代理 ----
    // 宿主只监听 127.0.0.1，手机连不上；而且 http 下浏览器不给麦克风。
    // 这里自己起一个 https，把请求原样转给本机宿主端口（含 SSE 和音频流）。
    const tlsDir = join(dataDir, 'tls')
    let hostPort = 0
    let lanServer = null
    let lanPort = 0

    const lanIp = () => {
      for (const list of Object.values(networkInterfaces())) {
        for (const n of list || []) {
          if (n.family === 'IPv4' && !n.internal && !String(n.address).startsWith('169.254.')) return n.address
        }
      }
      return ''
    }
    const learnHost = (req) => {
      const m = String((req && req.headers && req.headers.host) || '').match(/:(\d+)$/)
      if (m) hostPort = Number(m[1]) || hostPort
      return hostPort
    }
    // ---- 手机入口的安全边界 ----
    // 反代只做一件事：把「通话模块自己的 8 个接口」转给本机宿主，别的路径一律 404。
    // 光靠 Origin 校验挡不住局域网里的其他人，所以再加一层会话令牌：
    // 令牌在 dataDir 里随机生成，链接形如 /page?t=<令牌>，首次访问种成 HttpOnly Cookie。
    const ALLOW_PATHS = new Set([
      '/aurabot/api/ext/voicecall/page',
      '/aurabot/api/ext/voicecall/state',
      '/aurabot/api/ext/voicecall/fillers',
      '/aurabot/api/ext/voicecall/filler',
      '/aurabot/api/ext/voicecall/turn',
      '/aurabot/api/ext/voicecall/turn/stream',
      '/aurabot/api/ext/voicecall/say',
      '/aurabot/api/ext/voicecall/hangup',
    ])
    const ALLOW_METHODS = new Set(['GET', 'POST'])
    const COOKIE_NAME = 'vc_lan'

    const tokenFile = join(dataDir, 'lan-token.txt')
    let tokenCache = ''
    const lanToken = (reset) => {
      try {
        if (!reset && tokenCache) return tokenCache
        if (!reset && existsSync(tokenFile)) {
          const t = readFileSync(tokenFile, 'utf8').trim()
          if (t.length >= 32) { tokenCache = t; return t }
        }
        const t = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
        writeFileSync(tokenFile, t, 'utf8')
        tokenCache = t
        if (reset) log.info('手机访问令牌已重置，旧链接立即失效')
        return t
      } catch (error) {
        log.warn('令牌存取失败：' + (error.message || error))
        return tokenCache || ''
      }
    }

    // 令牌猜错太多次就凉一会儿，别让人在局域网里慢慢试
    let tokenFails = 0
    let tokenCoolUntil = 0

    const deny = (res, code, msg) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(msg)
    }

    const cookieToken = (req) => {
      const raw = String((req.headers && req.headers.cookie) || '')
      for (const part of raw.split(';')) {
        const i = part.indexOf('=')
        if (i < 0) continue
        if (part.slice(0, i).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(i + 1).trim())
      }
      return ''
    }

    const proxyToHost = (req, res) => {
      const port = hostPort || Number(api?.dsh?.webServer?.port) || 0
      let url
      try { url = new URL(req.url, 'https://lan.invalid') } catch (error) { return deny(res, 400, '地址不合法') }
      const path = url.pathname

      // 1) 路由白名单：只有通话模块自己的接口能过，插件的其它 API 一概不转
      if (!ALLOW_PATHS.has(path)) return deny(res, 404, '这个地址不在通话模块的白名单里')
      if (!ALLOW_METHODS.has(req.method || 'GET')) return deny(res, 405, '只支持 GET / POST')

      // 2) 令牌：?t= 或 Cookie，二者其一
      const now = Date.now()
      if (now < tokenCoolUntil) return deny(res, 429, '试错次数太多，稍后再试')
      const want = lanToken()
      if (!want) return deny(res, 503, 'token 没生成出来，去面板看看日志')
      const fromQuery = url.searchParams.get('t') || ''
      const got = fromQuery || cookieToken(req)
      if (got !== want) {
        tokenFails += 1
        if (tokenFails > 20) { tokenCoolUntil = now + 5 * 60_000; tokenFails = 0 }
        return deny(res, 401, '访问令牌不对或已失效。请在电脑面板重新点「复制手机地址」，用带令牌的新链接打开。')
      }
      tokenFails = 0

      // 3) 转发时把令牌从 URL 里摘掉，别让它出现在宿主的访问日志里
      url.searchParams.delete('t')
      const search = url.searchParams.toString()
      const target = path + (search ? '?' + search : '')

      // 4) 手机浏览器 POST 会带 Origin: https://<局域网 IP>:<端口>，宿主只认自家 Origin → 403。
      //    现在路径已经限定在通话模块的 8 个接口内，剥掉 Origin/Referer 最多只影响这几个接口，
      //    碰不到插件的其它能力。
      const fwd = { ...req.headers, host: `127.0.0.1:${port}` }
      delete fwd.origin
      delete fwd.referer
      const up = httpRequest({
        host: '127.0.0.1',
        port,
        path: target,
        method: req.method,
        headers: fwd,
      }, (r) => {
        const headers = { ...r.headers }
        // 5) 用 ?t= 打开页面时把令牌种成 HttpOnly Cookie，之后页面里的请求自动带上
        if (fromQuery && path === '/aurabot/api/ext/voicecall/page') {
          const prev = headers['set-cookie']
          const mine = `${COOKIE_NAME}=${encodeURIComponent(want)}; Path=/aurabot/api/ext/voicecall; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
          headers['set-cookie'] = prev ? [].concat(prev, mine) : [mine]
        }
        res.writeHead(r.statusCode || 502, headers)
        r.pipe(res)
      })
      up.setTimeout(0)
      up.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        try { res.end('上游出错：' + error.message) } catch (e) { /* 已经断了 */ }
      })
      req.pipe(up)
    }
    // 证书自己签：别人的机器上没有 openssl，也不会手动准备 pem 文件。
    // 证书里的 SAN 要覆盖当前局域网 IP，换网段/换路由后自动重签一次。
    const ensureCert = () => {
      const certPath = join(tlsDir, 'cert.pem')
      const keyPath = join(tlsDir, 'key.pem')
      const ip = lanIp()
      const need = [ip, '127.0.0.1'].filter(Boolean)
      try {
        if (existsSync(certPath) && existsSync(keyPath)) {
          const now = readFileSync(certPath, 'utf8')
          if (!ip || selfcert.certCoversIps(now, [ip])) return { ok: true, cert: now, key: readFileSync(keyPath, 'utf8') }
          log.info(`局域网 IP 变成 ${ip}，重签一张证书`)
        }
        mkdirSync(tlsDir, { recursive: true })
        const made = selfcert.makeSelfSignedCert({ ips: need, days: 825, commonName: 'aurabot-call' })
        writeFileSync(certPath, made.cert, 'utf8')
        writeFileSync(keyPath, made.key, 'utf8')
        log.info(`已生成自签证书（${made.sans.join('、')}，825 天）`)
        return { ok: true, cert: made.cert, key: made.key }
      } catch (error) {
        log.warn('证书没弄出来：' + (error.message || error))
        return { ok: false, why: '证书生成失败：' + (error.message || error) }
      }
    }

    const startLan = () => {
      if (lanServer) return { ok: true, port: lanPort }
      if (settings().lanHttps !== true) return { ok: false, why: '局域网 HTTPS 默认关闭，需要先在设置里打开' }
      const tls = ensureCert()
      if (!tls.ok) return { ok: false, why: tls.why }
      const want = Number(settings().httpsPort) || 8443
      try {
        lanServer = createHttpsServer({ cert: tls.cert, key: tls.key }, proxyToHost)
        lanServer.requestTimeout = 0
        lanServer.headersTimeout = 0
        lanServer.timeout = 0
        lanServer.on('error', (error) => {
          log.warn('局域网 HTTPS 起不来：' + error.message)
          lanServer = null
        })
        lanServer.listen(want, '0.0.0.0', () => {
          lanPort = want
          log.info(`局域网 HTTPS 已开（端口 ${want}，仅放行通话模块接口，需带会话令牌）；手机地址在面板「复制手机地址」取`)
        })
        return { ok: true, port: want }
      } catch (error) {
        log.warn('局域网 HTTPS 起不来：' + error.message)
        lanServer = null
        return { ok: false, why: error.message }
      }
    }
    try { api.onDispose(() => { try { lanServer && lanServer.close() } catch (error) { /* 已经关了 */ } }) } catch (error) { /* 老版本没有这接口 */ }
    startLan()

    // ---- 垫话：用她的声音预生成几句短的，你一停口就先出声，把思考的空白盖住 ----
    const fillerDir = join(dataDir, 'fillers')
    mkdirSync(fillerDir, { recursive: true })
    const FILLER_TEXT = ['嗯？', '我在呢', '我在，你说', '怎么了？']
    const FILLER_EXT = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac']
    let filling = false
    // 引擎不同，音频容器也不同（GPT-SoVITS 给 wav、edge/OpenAI 给 mp3），按实际扩展名找
    const fillerOne = (i) => FILLER_EXT.map((e) => join(fillerDir, `f${i}.${e}`)).find((p) => existsSync(p)) || ''
    const fillerFiles = () => FILLER_TEXT.map((_, i) => fillerOne(i)).filter(Boolean)

    // 换了引擎/音色，旧垫话就是别人的声音了：整批作废重做
    const fillerSigFile = join(fillerDir, 'sig.txt')
    const voiceSig = () => {
      const c = ttsCfg()
      return [c.provider, c.model, c.voice, c.format, c.gptsovits.url, c.gptsovits.refAudio].join('|')
    }
    const syncFillers = () => {
      try {
        const sig = voiceSig()
        const old = existsSync(fillerSigFile) ? readFileSync(fillerSigFile, 'utf8').trim() : ''
        if (old === sig) return
        for (let i = 0; i < FILLER_TEXT.length; i++) {
          const p = fillerOne(i)
          if (p) {
            try { unlinkSync(p) } catch (error) { /* 删不掉就算了 */ }
          }
        }
        writeFileSync(fillerSigFile, sig, 'utf8')
        log.info(`语音引擎变成 ${ttsCfg().provider}，垫话缓存清空重做`)
      } catch (error) {
        /* 签名失败不影响通话 */
      }
    }

    const ensureFillers = async () => {
      if (filling) return
      filling = true
      syncFillers()
      try {
        for (let i = 0; i < FILLER_TEXT.length; i++) {
          if (fillerOne(i)) continue
          const a = await synth(FILLER_TEXT[i])
          const dst = join(fillerDir, `f${i}${extname(a.name) || '.wav'}`)
          copyFileSync(join(audioDir, a.name), dst)
          try { unlinkSync(join(audioDir, a.name)) } catch (error) { /* 清不掉也没事 */ }
        }
        log.info(`垫话备好 ${fillerFiles().length}/${FILLER_TEXT.length} 句`)
      } catch (error) {
        log.warn('垫话没合成出来（不影响通话）：' + error.message)
      } finally {
        filling = false
      }
    }

    // ---- 耳朵：走适配层，本地 faster-whisper / OpenAI 兼容 / 自定义 HTTP 三选一 ----
    // （换哪家都只改设置，不动代码；see lib/providers.js）
    const asrCfg = () => providers.asrConfig(settings())

    const sttInfo = async () => {
      const info = await providers.probeStt(asrCfg())
      return { ...info, id: asrCfg().provider }
    }

    const transcribe = async (wav) => {
      const r = await providers.transcribe(asrCfg(), wav)
      return r.text
    }

    // ---- 大脑：她本人 ----
    // 电话里要快，就别让这一轮去调工具；顺手把 Markdown 和 emoji 去掉，念出来才自然
    const spoken = (s) => String(s || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>~]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/（[^）]{0,30}）/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    // 把回复切成句子：一句一个流，第一句开口就能出声
    // （合成本身走流式透传，所以不用再按逗号切小块——切太碎反而会在句子之间留缝）
    const splitSentences = (text) => {
      const clean = String(text || '').replace(/\s+/g, ' ').trim()
      if (!clean) return []
      const raw = clean.match(/[^。！？!?…~～；;\n]+[。！？!?…~～；;]*/g) || [clean]
      const out = []
      for (const part of raw) {
        const s = part.trim()
        if (!s) continue
        // 太碎的（"嗯。"这种）并进上一句，别一句两个字地念
        if (out.length && (s.length < 6 || out[out.length - 1].length < 6)) out[out.length - 1] += s
        else out.push(s)
      }
      return out.length ? out : [clean]
    }

    // ---- 记忆：memory 模块对 system 会话是直接跳过的（上下文和自动召回都 return 空），
    //      所以打电话时她什么都想不起来，通话内容也不会进 chatlog 被提炼。
    //      这里自己补两头：说之前先想起相关旧事，挂断时再把这一通聊的写回记忆库。
    const CALL_CHAT = 'system:ext-voicecall'
    let callLog = []        // 这一通说过的话：{ who: 'master' | 'me', text, at }
    let callStartAt = 0

    // 称呼别写死：用插件里主人自己的设定，没设就叫「主人」
    const ownerName = () => {
      try {
        return String(api.config().ownerName || '').trim() || '主人'
      } catch (error) {
        return '主人'
      }
    }

    const memoryOf = () => {
      try { return api.use('memory') || null } catch (error) { return null }
    }

    // 主人视角检索：where 不是 private:/group: 的 id，记忆模块按主人视角处理，全库捞
    const memoryHint = async (text) => {
      const mem = memoryOf()
      if (!mem || typeof mem.recall !== 'function') return ''
      try {
        const hits = (await Promise.resolve(mem.recall(text, { limit: 4, where: CALL_CHAT }))) || []
        const lines = hits
          .map((h) => String((h && (h.it ? h.it.text : h.text)) || '').trim())
          .filter(Boolean)
          .slice(0, 4)
        if (!lines.length) return ''
        log.info(`通话里想起 ${lines.length} 条旧事`)
        return `（你脑子里浮现的旧事，只是让你心里有数，别照着念出来：\n${lines.join('；')}）`
      } catch (error) {
        return ''
      }
    }

    const noteSaid = (who, text) => {
      const t = String(text || '').trim()
      if (!t) return
      // 上一通没挂断就接着打（隔了半小时以上）：先把旧的收尾，别混成一通
      const last = callLog[callLog.length - 1]
      if (last && Date.now() - last.at > 30 * 60_000) flushCallSafe()
      if (!callStartAt) callStartAt = Date.now()
      callLog.push({ who, text: t, at: Date.now() })
      if (callLog.length > 200) callLog.shift()
    }

    // 挂断时让她自己用一句话记住这一通（模型不行就退回流水拼装，绝不丢）
    const summarizeCall = async (rows) => {
      const lines = rows.slice(-16).map((x) => `${x.who === 'master' ? '对方' : '我'}：${x.text}`).join('\n')
      const prompt = [
        '（这是一通刚挂断的电话，下面是你和主人的原话记录，识别可能有错字，按意思理解）',
        lines.slice(0, 4000),
        '用一句话（第一人称、不超过 90 字）记下这通电话：优先记具体的事——他做了什么、在哪、说了哪些关键信息、有没有约定或要记住的事；再带一句他的状态或心情。',
        '只输出这一句：不要引号、不要「记录：」这种前缀、不要 Markdown、不要 emoji、不要旁白。',
      ].join('\n')
      const r = await api.think(prompt, { title: '通话', timeoutMs: 60000, noTools: true })
      return String(r || '').replace(/[\r\n]+/g, ' ').replace(/^["「『]|["」』]$/g, '').trim().slice(0, 120)
    }

    // 挂断时把这一通写进她的记忆（一条，不按句堆）
    const flushCall = async () => {
      if (!callLog.length) { callStartAt = 0; return { ok: true, wrote: 0 } }
      const logRows = callLog
      callLog = []
      const start = callStartAt || logRows[0].at
      callStartAt = 0
      const mem = memoryOf()
      if (!mem || typeof mem.add !== 'function') return { ok: false, why: '记忆模块没开着', wrote: 0 }
      const hm = (t) => new Date(t).toTimeString().slice(0, 5)
      const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
      const span = `${hm(start)}–${hm(logRows[logRows.length - 1].at)}`
      let gist = ''
      try {
        gist = await summarizeCall(logRows)
      } catch (error) {
        log.warn('通话总结没出来，退回流水：' + (error.message || error))
      }
      let body
      if (gist) {
        // 光存概括，之后问「刚才聊了什么细节」时关键词对不上；带上几句原话才召回得动
        const mine = logRows.filter((x) => x.who === 'master').map((x) => x.text).slice(-3)
        body = `通话（${span}）：${gist}` + (mine.length ? '\n他的原话：' + mine.map((x) => `「${cut(x, 26)}」`).join('') : '')
      } else {
        const mine = logRows.filter((x) => x.who === 'master').map((x) => x.text).slice(-4)
        const hers = logRows.filter((x) => x.who === 'me').map((x) => x.text).slice(-3)
        body = [
          `和${ownerName()}通了个电话（${span}，${logRows.filter((x) => x.who === 'master').length} 轮）`,
          mine.length ? `${ownerName()}说：${mine.map((s) => `「${cut(s, 30)}」`).join('')}` : '',
          hers.length ? `我答：${hers.map((s) => `「${cut(s, 30)}」`).join('')}` : '',
        ].filter(Boolean).join('；')
      }
      try {
        const r = mem.add({ text: cut(body, 300), tags: ['通话'], importance: gist ? 0.65 : 0.5, source: 'tool', chatId: CALL_CHAT })
        if (r && r.ok === false) {
          log.warn('通话记忆没写进去：' + (r.message || '被拒'))
          return { ok: false, why: r.message || '', wrote: 0 }
        }
        log.info('通话记忆已写入：' + cut(body, 50))
        return { ok: true, wrote: 1, summarized: Boolean(gist), text: body }
      } catch (error) {
        log.warn('通话记忆写不进去：' + (error.message || error))
        return { ok: false, why: error.message, wrote: 0 }
      }
    }
    const flushCallSafe = () => { flushCall().catch(() => {}) }

    // 页面直接关掉、没点挂断的：10 分钟没有新的一句就自己收尾
    const flushTimer = setInterval(() => {
      if (callLog.length && Date.now() - callLog[callLog.length - 1].at > 10 * 60_000) flushCallSafe()
    }, 60_000)
    try { api.onDispose(() => { clearInterval(flushTimer); flushCallSafe() }) } catch (error) { /* 老版本没有这接口 */ }

    const think = async (text) => {
      const max = Number(settings().maxChars) || 120
      const hint = await memoryHint(text)
      const prompt = [
        '（你们正在打电话，不是打字；对方是你主人，刚开口说的这句话被识别成了文字）',
        hint,
        `他刚说：「${text}」`,
        `现在直接说你要说的话：口语、一到两句、最多 ${max} 字。`,
        '不要 Markdown、不要括号里的动作旁白、不要 emoji、不要「某某：」这种前缀，只输出你要念出来的话。',
        '如果识别出来的话明显不通顺，就按你听到的大概意思自然接一句，别追问「你说什么」。',
      ].filter(Boolean).join('\n')
      const r = await api.think(prompt, { title: '通话', timeoutMs: 120000, noTools: true })
      return spoken(r)
    }

    // ---- 嘴：走适配层（本地 GPT-SoVITS / CosyVoice、线上 edge / OpenAI 兼容 / 自定义 HTTP）----
    const ttsOf = () => {
      try {
        return api.lib('voice/tts.js')
      } catch (error) {
        log.warn('拿不到语音合成模块：' + error.message)
        return null
      }
    }

    // 插件自带的合成能力交给适配层做兜底（edge / cosyvoice / windows）
    const ttsCtx = {
      log,
      builtin: {
        textToSpeech: (text, opt, lg) => {
          const mod = ttsOf()
          if (!mod?.textToSpeech) throw new Error('语音合成模块不可用（插件版本太旧？）')
          return mod.textToSpeech(text, opt, lg)
        },
        edgeInstalled: () => {
          try {
            return ttsOf()?.edgeInstalled?.()
          } catch (error) {
            return false
          }
        },
      },
    }

    const globalVoice = () => {
      try {
        return api.config().voice || {}
      } catch (error) {
        return {}
      }
    }
    const ttsCfg = () => providers.ttsConfig(settings(), globalVoice())
    const engineOf = () => ttsCfg().provider

    const EXT_OF_MIME = {
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/flac': '.flac',
    }

    // 合成一段存成文件（垫话缓存、/turn 这种一次性返回的接口用）
    const synth = async (text) => {
      const r = await providers.openTts(ttsCfg(), text, ttsCtx)
      const ext = EXT_OF_MIME[r.contentType] || '.mp3'
      const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
      const dst = join(audioDir, name)
      const ws = createWriteStream(dst)
      for await (const chunk of r.iter) {
        if (!ws.write(chunk)) await once(ws, 'drain')
      }
      await new Promise((resolve, reject) => ws.end((error) => (error ? reject(error) : resolve())))
      if (!existsSync(dst) || statSync(dst).size < 400) throw new Error('合成出来的音频是空的')
      return { name, engine: r.provider }
    }

    // ---- 接口 ----
    api.route('/page', async (req, res) => {
      try {
        const html = readFileSync(join(api.dir, 'lib', 'call.html'), 'utf8')
        api.core.http.send(res, 200, html, AUDIO_MIME['.html'])
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    // 面板拿这个拼出能直接点的绝对地址（面板里的 window.open 会被宿主拦掉）
    api.route('/link', async (req) => {
      learnHost(req)
      const host = (req && req.headers && req.headers.host) || '127.0.0.1'
      return { ok: true, url: `http://${host}/aurabot/api/ext/voicecall/page` }
    })

    // 手机用：局域网 https 地址（自签证书，第一次要在手机上点「继续访问」）
    api.route('/lan', async (req) => {
      learnHost(req)
      const q = api.core.http.query(req)
      const reset = String(q.reset || '') === '1'
      const s = startLan()
      const port = lanPort || Number(settings().httpsPort) || 8443
      const ip = lanIp()
      // 地址里带会话令牌：没有它，同一个 Wi-Fi 下的别人也打不开、也发不了请求
      const token = reset ? lanToken(true) : lanToken()
      return {
        ok: Boolean(lanServer),
        ip,
        port,
        https: Boolean(lanServer),
        url: ip && token ? `https://${ip}:${port}/aurabot/api/ext/voicecall/page?t=${token}` : '',
        token: Boolean(token),
        why: s.why || '',
      }
    })

    api.route('/state', async (req) => {
      learnHost(req)
      const s = settings()
      const ttsCfgNow = ttsCfg()
      const [asrInfo, ttsInfo] = await Promise.all([
        sttInfo(),
        providers.probeTts(ttsCfgNow, ttsCtx),
      ])
      return {
        ok: true,
        asr: asrInfo,
        tts: Boolean(ttsInfo?.ready),
        mouth: ttsInfo,
        engine: ttsCfgNow.provider,
        follow: ttsCfgNow.follow,
        fillers: fillerFiles().length,
        vad: true,
        settings: { voice: s.voice || '', maxChars: s.maxChars || 120 },
        busy,
      }
    })

    // 一段话：body 是裸 PCM16（16k 单声道）或者 WAV
    api.route('/turn', async (req) => {
      if (req.method !== 'POST') return { ok: false, err: 'POST only' }
      if (busy) return { ok: false, err: '上一句还没说完' }
      busy = true
      interrupted = false
      const t0 = Date.now()
      try {
        const raw = await api.core.http.raw(req, MAX_AUDIO_BYTES)
        if (!raw.length) return { ok: false, err: '没收到声音' }
        const wav = isWav(raw) ? raw : pcmToWav(raw)
        if (wav.length < 44 + 16000 * 2 * 0.25) return { ok: false, err: '太短了，没听清' }

        const tAsr = Date.now()
        const text = await transcribe(wav)
        if (!text) return { ok: false, err: '没听清，再说一遍？', ms: { asr: Date.now() - tAsr } }
        if (interrupted) return { ok: false, err: '被打断了', text }

        const tThink = Date.now()
        const reply = await think(text)
        if (!reply) return { ok: false, err: '她没说话', text }
        if (interrupted) return { ok: false, err: '被打断了', text, reply }

        const tTts = Date.now()
        let audio = null
        try {
          audio = await synth(reply)
        } catch (error) {
          log.warn('合成失败，只回文字：' + error.message)
        }
        return {
          ok: true,
          text,
          reply,
          audio: audio ? { url: `/aurabot/api/ext/voicecall/audio?name=${encodeURIComponent(audio.name)}`, engine: audio.engine } : null,
          ms: { asr: tThink - tAsr, think: tTts - tThink, tts: Date.now() - tTts, total: Date.now() - t0 },
        }
      } catch (error) {
        log.warn('通话这一句失败：' + (error.message || error))
        return { ok: false, err: String(error.message || error) }
      } finally {
        busy = false
      }
    })

    // 流式一轮：SSE 推 asr / reply / audio 分段 / done，页面边收边播
    // 结构上跟 /turn 一样，只是把「合成完再一次性返回」换成「合成一句推一句」
    api.route('/turn/stream', async (req, res) => {
      if (req.method !== 'POST') return { ok: false, err: 'POST only' }
      if (busy) return { ok: false, err: '上一句还没说完' }
      let raw = null
      try {
        raw = await api.core.http.raw(req, MAX_AUDIO_BYTES)
      } catch (error) {
        return { ok: false, err: '没收全声音：' + (error.message || error) }
      }
      if (!raw || !raw.length) return { ok: false, err: '没收到声音' }
      const wav = isWav(raw) ? raw : pcmToWav(raw)
      if (wav.length < 44 + 16000 * 2 * 0.25) return { ok: false, err: '太短了，没听清' }

      busy = true
      interrupted = false
      const t0 = Date.now()
      const ms = { asr: 0, think: 0, tts: 0, total: 0 }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const emit = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch (error) { /* 页面关了 */ }
      }
      // 页面那头一挂断（挂电话 / 插话重连），剩下的合成就不用做了
      res.on('close', () => { interrupted = true })

      try {
        const tAsr = Date.now()
        const text = await transcribe(wav)
        ms.asr = Date.now() - tAsr
        if (!text) { emit('error', { err: '没听清，再说一遍？', ms }); return }
        emit('asr', { text, ms })
        noteSaid('master', text)
        if (interrupted) return

        const tThink = Date.now()
        const reply = await think(text)
        ms.think = Date.now() - tThink
        if (!reply) { emit('error', { err: '她没说话', text }); return }
        emit('reply', { text: reply, ms })
        noteSaid('me', reply)
        if (interrupted) return

        // 不再等服务端合成：直接把「按句念」的地址推给页面，页面一边拉一边播
        const parts = splitSentences(reply)
        const engine = engineOf()
        for (let i = 0; i < parts.length; i++) {
          if (interrupted) break
          emit('audio', {
            index: i,
            text: parts[i],
            engine,
            stream: true,
            url: `/aurabot/api/ext/voicecall/say?text=${encodeURIComponent(parts[i])}`,
          })
        }
        ms.total = Date.now() - t0
        emit('done', { interrupted, parts: parts.length, ms })
      } catch (error) {
        log.warn('通话流失败：' + (error.message || error))
        emit('error', { err: String(error.message || error) })
      } finally {
        try { res.write('event: end\ndata: {}\n\n') } catch (error) { /* ignore */ }
        try { res.end() } catch (error) { /* ignore */ }
        busy = false
      }
    })

    // 念一句：哪家引擎都从适配层拿流。能流式的（GPT-SoVITS、OpenAI 兼容 pcm）边合成边推，
    // 只能整段回的（edge / 自定义 HTTP）也是拿到就推，页面不用等整段。
    api.route('/say', async (req, res) => {
      const q = api.core.http.query(req)
      const text = String(q.text || '').trim().slice(0, 400)
      if (!text) {
        api.core.http.send(res, 400, '要念什么？', 'text/plain; charset=utf-8')
        return
      }
      let open = null
      try {
        open = await providers.openTts(ttsCfg(), text, ttsCtx)
      } catch (error) {
        api.core.http.send(res, 502, '合成不出来：' + (error.message || error), 'text/plain; charset=utf-8')
        return
      }
      res.writeHead(200, {
        'Content-Type': open.contentType,
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Voice-Provider': open.provider,
      })
      let gone = false
      // 页面一挂断（插话、关页面、切下一句）就把上游也断掉，别白烧算力/积分
      res.on('close', () => { gone = true })
      try {
        while (!gone) {
          const { value, done } = await open.iter.next()
          if (done) break
          if (value && value.length) res.write(value)
        }
      } catch (error) {
        /* 客户端断开或上游中断，不用报 */
      }
      try { await open.iter.return?.() } catch (error) { /* ignore */ }
      try { res.end() } catch (error) { /* ignore */ }
    })

    // 垫话清单：页面一开就拉一次，说话前先放着
    api.route('/fillers', async () => {
      const list = fillerFiles().map((p) => `/aurabot/api/ext/voicecall/filler?name=${encodeURIComponent(basename(p))}`)
      if (!list.length) ensureFillers()
      return { ok: true, list, total: FILLER_TEXT.length }
    })

    api.route('/filler', async (req, res) => {
      try {
        const q = api.core.http.query(req)
        const name = String(q.name || '').replace(/[^\w.\-]/g, '')
        const file = join(fillerDir, name)
        if (!name || !existsSync(file)) {
          api.core.http.send(res, 404, '没有这句垫话', 'text/plain; charset=utf-8')
          return
        }
        api.core.http.send(res, 200, readFileSync(file), AUDIO_MIME[extname(file).toLowerCase()] || 'audio/wav')
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    api.route('/audio', async (req, res) => {
      try {
        const q = api.core.http.query(req)
        const name = String(q.name || '').replace(/[^\w.\-]/g, '')
        const file = join(audioDir, name)
        if (!name || !existsSync(file)) {
          api.core.http.send(res, 404, '没有这段音频', 'text/plain; charset=utf-8')
          return
        }
        const type = AUDIO_MIME[extname(file).toLowerCase()] || 'application/octet-stream'
        api.core.http.send(res, 200, readFileSync(file), type)
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    // 打断：她还在想/还在合成，主人先开口了
    // 顺手把 busy 放开，页面立刻说下一句时不会被「上一句还没说完」挡住
    // （被打断的那一轮会在下一个检查点自己收摊，收摊时再置一次 false，无副作用）
    api.route('/interrupt', async () => {
      interrupted = true
      busy = false
      return { ok: true }
    })

    // 挂断：让这一段对话先收尾，再让她用一句话把这通电话记下来
    api.route('/hangup', async (req) => {
      if (req.method !== 'POST') return { ok: false, err: 'POST only' }
      interrupted = true
      busy = false
      try {
        return await flushCall()
      } catch (error) {
        return { ok: false, why: String(error.message || error), wrote: 0 }
      }
    })

    // 起来之后在后台把垫话合成好（不挡通话，失败了下一轮再试）
    setTimeout(() => { ensureFillers().catch(() => {}) }, 5000)
  },
}
