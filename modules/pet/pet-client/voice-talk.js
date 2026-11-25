// Aurabot 桌宠 · 免界面语音对讲（voice-talk.js）—— 本文件是模板/生成物：
// 由插件「桌宠」模块生成到 <数据目录>/modules-data/pet/app/，与 main.js 同目录运行。
// 设计权威：docs/VOICE-TALK-DESIGN.md。跑在 show:false 的隐藏窗里（nodeIntegration 直连 ipcRenderer），
// 只做两件事：录音、播放。没有任何可见 UI / 呼叫挂断窗，绝不 alwaysOnTop——从形态上杜绝卡死事故。
//
// 触发：主进程全局热键 toggle → window.__voiceToggle()：
//   第 1 下：getUserMedia(麦克风 deviceId) + MediaRecorder.start() → 报 listening；
//   第 2 下：MediaRecorder.stop() → base64 wav → ipc 'voice:request' → POST /voice/talk { audio }
//           → 返回 {audioB64, mime, replyText, heard, error} → new Audio(data) + setSinkId(扬声器) 播放。
//
// 绝不卡死的四道保险（每一步都有超时与失败恢复，热键可随时再次触发）：
//   ① getUserMedia：Promise.race 8s 超时（无权限/被占用/无设备时不会悬住）；
//   ② 录音：60s 自动停（防止用户按一下就忘了再按，麦克风永久占用）；
//   ③ 网络请求：30s Promise.race 超时（主进程 fetch 侧也有 30s AbortSignal.timeout 双保险）；
//   ④ 播放：Audio.play() 15s 兜底 + onerror/onended 都收尾；任何异常必经 finally → voice:done 解锁热键。

const { ipcRenderer } = require('electron')

/* ===== 常量 ===== */
const MIC_TIMEOUT_MS = 8_000      // ① getUserMedia 超时
const REC_MAX_MS = 60_000         // ② 单次录音上限（超时自动收口并送出）
const NET_TIMEOUT_MS = 30_000     // ③ 网络请求超时
const PLAY_TIMEOUT_MS = 15_000    // ④ 播放兜底超时
const RATE = 16000                // 目标采样率（16k 单声道，服务端识别口径）

/* ===== 状态 ===== */
let cfg = { enabled: true, hotkey: 'Alt+Space', micDeviceId: '', speakerDeviceId: '' }
let stream = null                 // 当前麦克风 MediaStream
let recorder = null               // 当前 MediaRecorder
let chunks = []                   // 录音数据块（Blob）
let recording = false             // 是否正在录音
let micTimer = null               // getUserMedia 超时定时器
let recTimer = null               // 录音上限定时器
let recHeartbeat = null           // 录音期心跳（喂主进程看门狗）
let playTimer = null              // 播放兜底定时器
let curAudio = null               // 当前 Audio 实例
let phase = 'idle'                // 'idle' | 'recording' | 'working'（thinking/speaking）—— 只有 working 时吞热键
let round = 0                     // 回合作废号：stop/出错后 ++，在途响应直接丢弃

/* ===== 上报 ===== */
function state(s) { ipcRenderer.send('voice:state', s) }
function done() { ipcRenderer.send('voice:done') }
/** 错误码 → 人话提示（服务端给 error，这里兜底一层翻译）+ 状态气泡 + 解锁热键。 */
function fail(code, message) {
  const MAP = {
    'mic-timeout': '麦克风没响应（8 秒内没打开）：看看是不是被别的程序占用了，或者没给录音权限',
    'mic-denied': '麦克风权限被拒绝了，请在系统设置里允许桌宠使用麦克风',
    'mic-not-found': '没找到可用的麦克风，插上麦克风再试',
    'no-device': '没有检测到录音设备',
    'rec-error': '录音出错了，再按一下热键重试',
    'network-timeout': '网络超时了，再按一下热键重试',
    'network-error': '没连上插件，检查网络后再试',
    'asr-not-ready': '语音识别还没配好，去插件面板看一下识别地址',
    'no-audio': '没听清（没收到声音），再靠近麦克风说一次',
    'tts-failed': '她这次没发出声音来，再试一下',
    'host-not-ready': '桌宠还没连上插件，稍等一下再试',
  }
  // 主进程 voice:state('error') 只负责复位录音标志；具体原因走 voice:message 显示一条带人话的气泡。
  state('error')
  ipcRenderer.send('voice:message', MAP[code] || message || '语音对讲出了点问题，再按一下热键试试')
}
/** 收尾：释放所有定时器/媒体资源，复位状态并解锁热键（任何路径必经）。 */
function teardown() {
  if (micTimer) { clearTimeout(micTimer); micTimer = null }
  if (recTimer) { clearTimeout(recTimer); recTimer = null }
  if (recHeartbeat) { clearInterval(recHeartbeat); recHeartbeat = null }
  if (recording) { recording = false }
  try { if (recorder && recorder.state !== 'inactive') recorder.onstop = null, recorder.stop() } catch {}
  recorder = null
  chunks = []
  if (stream) { for (const t of stream.getAudioTracks()) { try { t.stop() } catch {} } stream = null }
  phase = 'idle'
  done()
}

/* ===== 主进程配置下发 ===== */
window.__voiceCfg = (c) => {
  if (!c || typeof c !== 'object') return
  cfg = {
    enabled: c.enabled !== false,
    hotkey: String(c.hotkey || 'Alt+Space'),
    micDeviceId: String(c.micDeviceId || ''),
    speakerDeviceId: String(c.speakerDeviceId || ''),
  }
  reportMics()
}
/** 枚举麦克风 → 主进程上报服务端存 micDeviceId（沿面板配置通道）。
 *  设备 label 需要媒体权限才看得到：首次拒绝时静默（下次授权后再报），不打扰用户。 */
async function reportMics() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return
    const list = await navigator.mediaDevices.enumerateDevices()
    const mics = list.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label }))
    ipcRenderer.send('voice:mics', mics)
  } catch {}
}

/* ===== ① 取麦（8s Promise.race 超时，三类失败分别提示） ===== */
async function openMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error('这个环境不给录音权限')
    e.code = 'mic-not-found'
    throw e
  }
  const constraints = {
    audio: {
      echoCancellation: true,   // 把她自己的外放从麦克风里减掉（免界面被动外放场景仍建议开）
      noiseSuppression: false,  // 强降噪会吃掉辅音，识别靠它们
      autoGainControl: true,
      channelCount: 1,
      ...(cfg.micDeviceId ? { deviceId: { exact: cfg.micDeviceId } } : {}),
    },
  }
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('麦克风无响应/被占用/无权限（8 秒超时）')
      e.code = 'mic-timeout'
      reject(e)
    }, MIC_TIMEOUT_MS)
  })
  try {
    // Promise.race：8s 内没拿到流就明确报错并恢复可触发，绝不悬住等到天荒地老。
    return await Promise.race([navigator.mediaDevices.getUserMedia(constraints), timeout])
  } catch (err) {
    const name = String((err && err.name) || '')
    const e = new Error((err && err.message) || '打不开麦克风')
    // 权限拒绝 / 设备没插 / 被占用：全部映射成明确人话提示
    e.code = name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'mic-denied'
      : name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'mic-not-found'
      : name === 'NotReadableError' || name === 'TrackStartError' ? 'mic-timeout' : 'rec-error'
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ===== ② 录音：MediaRecorder 启停 ===== */
function pickMime() {
  // 优先 wav（服务端 ASR 通吃）；浏览器不直接支持 wav 录制时用 webm，服务端按 mime 转码。
  const prefer = ['audio/wav', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  for (const m of prefer) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m } catch {}
  }
  return ''
}
async function startRec() {
  stream = await openMic()
  chunks = []
  const mime = pickMime()
  const opts = mime ? { mimeType: mime } : undefined
  try {
    recorder = new MediaRecorder(stream, opts)
  } catch (err) {
    const e = new Error('录音器启动失败')
    e.code = 'rec-error'
    throw e
  }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
  recorder.onerror = () => { if (phase !== 'idle') { fail('rec-error'); teardown() } }
  recorder.start(250) // 每 250ms 出一块，避免长录音只在 stop 时一次性给一大块
  recording = true
  phase = 'recording'
  state('listening')
  // ② 录音 60s 自动停：按一下忘了再按也不会永久占用麦克风
  recTimer = setTimeout(() => { if (recording) stopRec() }, REC_MAX_MS)
  // 录音心跳：每 10s 重报一次 listening，主进程看门狗据此确认渲染层还活着（60s 长录音不误杀）
  recHeartbeat = setInterval(() => { if (recording && phase === 'recording') state('listening') }, 10_000)
  reportMics() // 授权后 label 才拿得到，再枚举一次上报
}
/** 第 2 下热键：停止录音 → 编码 → 送出。onstop 里做真正的工作。 */
function stopRec() {
  if (!recording || !recorder) return
  recording = false
  phase = 'working' // 一停就进工作态：防止 onstop 前的极短窗口里第三次按键又开一路录音
  if (recTimer) { clearTimeout(recTimer); recTimer = null }
  if (recHeartbeat) { clearInterval(recHeartbeat); recHeartbeat = null }
  const myRound = round
  const mime = recorder.mimeType || 'audio/webm'
  recorder.onstop = async () => {
    if (myRound !== round) return // 已被 stop/出错作废
    const blob = new Blob(chunks, { type: mime })
    chunks = []
    if (stream) { for (const t of stream.getAudioTracks()) { try { t.stop() } catch {} } stream = null }
    if (!blob.size) { fail('no-audio'); teardown(); return }
    try {
      const b64 = await blobToB64(blob)
      await sendTalk(b64, mime, myRound)
    } catch (err) {
      fail(err && err.code ? err.code : 'network-error', err && err.message)
      teardown()
    }
  }
  try { recorder.stop() } catch { fail('rec-error'); teardown() }
}
/** Blob → base64（FileReader，无新依赖）。 */
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result || '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s) // 去掉 data:<mime>;base64, 前缀
    }
    fr.onerror = () => reject(new Error('音频编码失败'))
    fr.readAsDataURL(blob)
  })
}

/* ===== ③④ 请求服务端 + 播放 ===== */
function withTimeout(promise, ms, code, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error(message); e.code = code; reject(e) }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}
/** 上行字段名必须是 audio（不是 audioB64）——1.1.2 事故的根因，这里写死只发一个名字。 */
async function sendTalk(audio, mime, myRound) {
  phase = 'working' // 请求/播放期间吞掉重复热键（避免重入打乱一轮）
  state('thinking')
  const res = await withTimeout(
    ipcRenderer.invoke('voice:request', { path: '/voice/talk', body: { audio, mime } }),
    NET_TIMEOUT_MS, 'network-timeout', '网络超时了')
  if (myRound !== round) return
  if (!res || res.ok === false) {
    const code = String((res && (res.error || res.reason)) || 'network-error')
    fail(code, res && res.message)
    teardown()
    return
  }
  const audioB64 = String(res.audioB64 || '')
  const outMime = String(res.mime || 'audio/wav')
  state('speaking')
  await playAudio(audioB64, outMime, myRound)
}
/** 播放：new Audio(data) + setSinkId(扬声器 deviceId)；onended/onerror/超时都收尾。 */
async function playAudio(audioB64, mime, myRound) {
  if (!audioB64) { state('idle'); teardown(); return } // 服务端没给音频（heard/replyText 仍可看气泡）
  const el = new Audio('data:' + mime + ';base64,' + audioB64)
  curAudio = el
  let settled = false
  let errored = false
  const finish = () => {
    if (settled) return
    settled = true
    if (playTimer) { clearTimeout(playTimer); playTimer = null }
    if (curAudio === el) curAudio = null
    // 成功播完才收气泡；出错时 error 文案已弹出，别用 idle 把它抹掉
    if (myRound === round && !errored) state('idle')
    teardown()
  }
  el.onended = finish
  el.onerror = () => { if (myRound === round) { errored = true; fail('tts-failed') } finish() }
  playTimer = setTimeout(() => { try { el.pause() } catch {} ; if (myRound === round) errored = true; finish() }, PLAY_TIMEOUT_MS)
  // setSinkId：把声音定向到服务端配置里的扬声器 deviceId；不支持/设备无效就走系统默认，不影响播放。
  try {
    if (typeof el.setSinkId === 'function' && cfg.speakerDeviceId) await el.setSinkId(cfg.speakerDeviceId)
  } catch {}
  try {
    await withTimeout(el.play(), PLAY_TIMEOUT_MS, 'tts-failed', '播放超时')
  } catch {
    if (myRound === round) { errored = true; fail('tts-failed') }
    finish()
  }
}

/* ===== 热键入口（主进程调用） ===== */
window.__voiceToggle = () => {
  // 只在 working（请求/播放中）吞掉重复按键；recording 时允许第二次按下停止并发送。
  if (phase === 'working') return
  if (recording) {
    // 第二次按下：停止并发送
    stopRec()
  } else {
    // 第一次按下：开始录音；任何失败都 teardown 解锁（失败恢复后可再次触发）
    phase = 'working' // 取麦期间不接受新的 toggle（8s 内会成功或超时失败）
    round++
    startRec().catch((err) => { fail(err && err.code ? err.code : 'rec-error', err && err.message); teardown() })
  }
}
/** 托盘"关闭语音对讲"/主进程 45s 兜底时调用：直接放弃这一轮，停录并释放设备（不发送、不残留麦克风占用）。 */
window.__voiceStop = () => {
  round++ // 作废在途回调
  teardown()
}
// 启动：报告一次设备清单（主进程可能还没推配置，label 也许为空；授权后再报）
reportMics()
