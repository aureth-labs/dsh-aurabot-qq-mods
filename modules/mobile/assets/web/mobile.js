'use strict'
// Shared with the classic script in index.html. No credentials enter URLs or the worker.
let activeView = 'pairView'
// 在「手机端」安卓 App 里打开时，App 注入 AuraNative：页面经手机本机 127.0.0.1 转发到电脑（算安全环境，
// 可直接录音），扫码、系统通知、换电脑由 App 原生处理。普通浏览器里没有它，行为不变。
const app = window.AuraNative || null
const serverShown = () => (app ? app.serverOrigin() : location.origin)
const HTTPS_HELP = '请主人在电脑面板「手机端 → 连接地址与远程访问」填写 TLS 证书与私钥路径，应用后通过可信 HTTPS 地址重新打开。推荐 Tailscale 证书，面板中有步骤。'
const eventIds = new Set(readStored('aurabot.eventIds', []))
let lastEventAt = Number(store.get('aurabot.lastEventAt')) || Date.now()
let eventFloor = lastEventAt
for (const [id, count] of readStored('aurabot.unread', [])) unread.set(id, count)
function readStored(key, fallback) { try { return JSON.parse(store.get(key)) || fallback } catch { return fallback } }
function saveUnread() { store.set('aurabot.unread', JSON.stringify([...unread])) }
function clearDeviceStorage() {
  try { for (const key of Object.keys(localStorage)) if (/^aurabot\.(draft\.|unread$|eventIds$|lastEventAt$)/.test(key)) store.set(key, null) } catch {}
  eventFloor = lastEventAt = Date.now()
}
function previewText(m) { return m.kind === 'text' || m.kind === 'system' ? m.text : ({ image: '[图片]', sticker: '[表情]', voice: '[语音]' }[m.kind] || m.text) }
function updateChatSubtitle() {
  $('chatSub').textContent = ws?.readyState === 1 ? (current?.ttsPort ? `电脑在线 · TTS 端口 ${current.ttsPort}` : '她在电脑那头') : '连接中，正在等电脑…'
}
function capabilityText() {
  if (!window.isSecureContext) return '当前是 HTTP，浏览器无法录音、调用相机和发送系统通知。' + HTTPS_HELP
  return navigator.mediaDevices?.getUserMedia && window.MediaRecorder ? '已使用安全连接。按住麦克风说话，松开发送；首次使用请允许麦克风。' : '当前浏览器不支持录音，请使用支持 MediaRecorder 的新版浏览器。'
}
$('recordInfo').textContent = window.isSecureContext ? '' : '录音和通知需要 HTTPS。请主人到电脑面板「手机端」配置证书后重新打开。'
$('capabilityInfo').textContent = capabilityText()
$('pairServer').value = $('serverAddress').value = serverShown()
$('uploadDir').value = store.get('aurabot.uploadDir') || ''

for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => {
  current = null; show(b.dataset.view)
  if (b.dataset.view === 'dshView') loadSessions()
  if (b.dataset.view === 'listView') loadBots()
  if (b.dataset.view === 'settingsView') { $('serverAddress').value = serverShown(); loadServerInfo(); updateNotificationInfo() }
}
$('refreshBots').onclick = loadBots
$('refreshDsh').onclick = loadSessions
$('closeStickers').onclick = () => $('sheet').classList.remove('open')

async function loadSessions() {
  $('dshStatus').textContent = '读取会话…'
  try {
    const result = await api('/api/mobile/sessions'), sessions = result.sessions || []
    $('dshStatus').textContent = `已连接 · ${sessions.length} 个会话`
    $('sessions').innerHTML = sessions.length ? sessions.map((s) => `<div class="row"><i class="dot on"></i><div class="mid"><div class="name"><b>${esc(s.title || s.id)}</b></div><div class="last"><span>${esc(s.subtitle || s.id)}</span></div></div></div>`).join('') : '<div class="empty"><b>电脑上没有会话</b>有会话后点击刷新。</div>'
  } catch (e) {
    $('dshStatus').textContent = '未连接'
    $('sessions').innerHTML = `<div class="empty"><b>连不上电脑端</b>${esc(e.message)}。点刷新重试。</div>`
  }
}
function pullToRefresh(id, refresh) {
  const el = $(id); let startY = null
  el.addEventListener('touchstart', (e) => { startY = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null }, { passive: true })
  el.addEventListener('touchend', (e) => { if (startY !== null && e.changedTouches[0].clientY - startY > 80) refresh(); startY = null }, { passive: true })
  el.addEventListener('touchcancel', () => { startY = null }, { passive: true })
}
pullToRefresh('listScroll', loadBots); pullToRefresh('dshScroll', loadSessions)
;(() => {
  const ball = $('dshBall'), parent = $('dshView'); let drag = null, suppressClick = false
  ball.onpointerdown = (e) => {
    if (e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY, left: ball.offsetLeft, top: ball.offsetTop, moved: false }
    ball.style.transition = 'none'; ball.setPointerCapture(e.pointerId)
  }
  ball.onpointermove = (e) => {
    if (!drag) return
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) drag.moved = true
    if (!drag.moved) return
    ball.style.right = 'auto'
    ball.style.left = Math.max(0, Math.min(parent.clientWidth - ball.offsetWidth, drag.left + dx)) + 'px'
    ball.style.top = Math.max(0, Math.min(parent.clientHeight - ball.offsetHeight, drag.top + dy)) + 'px'
  }
  const finish = () => {
    if (!drag) return
    suppressClick = drag.moved; drag = null
    if (suppressClick) {
      ball.style.transition = 'left .18s var(--ease)'; ball.style.right = 'auto'
      ball.style.left = (ball.offsetLeft + ball.offsetWidth / 2 > parent.clientWidth / 2 ? parent.clientWidth - ball.offsetWidth / 2 : -ball.offsetWidth / 2) + 'px'
    }
  }
  ball.onpointerup = finish; ball.onpointercancel = () => { finish(); suppressClick = true }
  ball.onclick = () => { if (!suppressClick) loadSessions(); suppressClick = false }
})()

function showBots() {
  $('botChoices').innerHTML = bots.map((b) => `<button class="row" data-bot="${esc(b.id)}"><div class="av" data-choice-av="${esc(b.id)}"></div><div class="mid"><div class="name"><b>${esc(b.name)}</b></div><div class="last"><span>${current?.id === b.id ? '当前会话' : esc(b.lastText || '点一下开始聊')}</span></div></div></button>`).join('')
  $('botChoices').querySelectorAll('[data-choice-av]').forEach((el) => setAv(el, bots.find((b) => b.id === el.dataset.choiceAv)))
  $('botChoices').querySelectorAll('[data-bot]').forEach((b) => b.onclick = () => { $('botDialog').close(); openChat(b.dataset.bot) })
  $('botDialog').showModal()
}
$('botSwitcher').onclick = $('botDropdown').onclick = showBots
$('closeBots').onclick = () => $('botDialog').close()

function serverOrigin(raw) {
  const url = new URL(raw.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('电脑地址请只填 http(s)://主机:端口')
  return url.origin
}
// Changing server means navigating to its own origin; never send an old token across origins.
function goToServer(raw, code = '') {
  const origin = serverOrigin(raw || serverShown())
  if (origin === serverShown()) return false
  const target = new URL('/', origin)
  if (code) target.searchParams.set('code', code)
  // App 里页面的来源固定是 127.0.0.1，换电脑由 App 清掉旧电脑的本地数据（含 token）后再打开。
  if (app) app.changeServer(target.href)
  else location.assign(target.href)
  return true
}
const originalPairSubmit = $('pairForm').onsubmit
$('pairForm').onsubmit = (e) => {
  e.preventDefault()
  try { if (!goToServer($('pairServer').value, $('codeInput').value.trim())) originalPairSubmit(e) }
  catch (error) { $('pairErr').textContent = error.message }
}
$('settingsForm').onsubmit = async (e) => {
  e.preventDefault()
  try {
    const directory = $('uploadDir').value.trim()
    if (directory && (directory.length > 160 || !directory.split('/').every((p) => /^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,63}$/u.test(p) && !p.endsWith('.') && !p.endsWith(' ') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) throw new Error('上传目录请用相对文件夹，例如 phone/photos，不能有盘符、反斜杠或 ..')
    const code = $('settingsCode').value.trim()
    if (goToServer($('serverAddress').value, code)) return
    store.set('aurabot.uploadDir', directory)
    $('settingsStatus').textContent = '保存好了'
    if (code) await pair(code)
    else await loadServerInfo()
  } catch (error) { $('settingsStatus').textContent = error.message }
}
async function loadServerInfo() {
  $('settingsStatus').textContent = '正在测试连接…'
  try {
    const [settings, library] = await Promise.all([api('/api/mobile/settings'), api('/api/mobile/stickers')])
    $('wakeInfo').textContent = '唤醒词：' + (settings.wakeWord || '未配置')
    $('ttsInfo').textContent = 'TTS：' + (settings.ttsPort === '未配置' || settings.ttsPort == null ? '未配置独立端口' : `端口 ${settings.ttsPort}`)
    $('stickerInfo').textContent = `表情库：${(library.stickers || []).length} 张`
    $('versionInfo').textContent = 'Aurabot ' + (settings.version || '') + ' · 网页版'
    $('settingsStatus').textContent = '已连接电脑端'
  } catch (error) {
    for (const [id, name] of [['wakeInfo', '唤醒词'], ['ttsInfo', 'TTS'], ['stickerInfo', '表情库']]) $(id).textContent = name + '：连不上电脑端'
    $('settingsStatus').textContent = '测试失败：' + error.message
  }
}
$('testConnection').onclick = () => {
  try {
    if (serverOrigin($('serverAddress').value) !== serverShown()) { $('settingsStatus').textContent = '地址已修改，请先保存，网页会打开对应电脑后测试连接。'; return }
    loadServerInfo()
  } catch (e) { $('settingsStatus').textContent = e.message }
}
$('logoutBtn').onclick = async () => {
  $('logoutBtn').disabled = true
  try { await api('/api/mobile/logout', { method: 'POST' }); logout('已退出配对，请重新扫码连接') }
  catch (e) { if (!token) logout('已退出配对，请重新扫码连接'); else toast('撤销失败，请检查连接后重试：' + e.message) }
  finally { $('logoutBtn').disabled = false }
}

// Scanner is optional browser capability. All browsers can open the same QR with the system camera.
let scanStream = null, scanFrame = 0, scanEpoch = 0
function closeScanner() {
  scanEpoch++; cancelAnimationFrame(scanFrame); scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null
  $('scanVideo').srcObject = null; $('scanVideo').hidden = true
  if ($('scanDialog').open) $('scanDialog').close()
}
function showScanner() {
  if (app) { app.scan(); return }
  $('scanInfo').textContent = !window.isSecureContext ? '相机扫码需要 HTTPS。' + HTTPS_HELP + ' 也可用手机系统相机扫描电脑上的二维码直接打开，或粘贴二维码文字。' : '扫描电脑面板中的二维码。若浏览器不支持相机识码，可用手机系统相机扫码打开，或粘贴二维码文字。'
  $('scanText').value = ''; $('scanDialog').showModal()
}
$('pairScan').onclick = $('settingsScan').onclick = showScanner
$('closeScan').onclick = closeScanner
$('scanDialog').addEventListener('cancel', closeScanner)
$('scanDialog').addEventListener('close', () => { if (scanStream) closeScanner() })
function parsePairing(raw) {
  const value = raw.trim(); let url, code
  if (value.startsWith('{')) {
    const json = JSON.parse(value); url = serverOrigin(json.url || serverShown()); code = json.code
  } else {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('二维码地址需要 http(s)')
    url = parsed.origin; code = parsed.searchParams.get('code')
  }
  if (typeof code !== 'string' || !code.trim() || code.length > 128) throw new Error('二维码里没有有效配对码')
  return { url, code: code.trim() }
}
async function applyPairing(raw) {
  try {
    const parsed = parsePairing(raw)
    closeScanner()
    if (!goToServer(parsed.url, parsed.code)) { $('codeInput').value = parsed.code; await pair(parsed.code) }
  } catch (e) { $('scanInfo').textContent = '二维码内容不认识：' + e.message }
}
$('applyScan').onclick = () => applyPairing($('scanText').value)
$('scanCamera').onclick = async () => {
  if (!window.isSecureContext) { $('scanInfo').textContent = '相机需要 HTTPS。' + HTTPS_HELP; return }
  if (!navigator.mediaDevices?.getUserMedia || !window.BarcodeDetector) { $('scanInfo').textContent = '此浏览器不支持网页相机识码，请用手机系统相机扫描电脑二维码打开，或粘贴二维码文字。'; return }
  if (scanStream) return
  const epoch = ++scanEpoch
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] })
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    if (epoch !== scanEpoch || !$('scanDialog').open) { stream.getTracks().forEach((t) => t.stop()); return }
    scanStream = stream; const video = $('scanVideo'); video.srcObject = stream; video.hidden = false; await video.play()
    const detect = async () => {
      if (epoch !== scanEpoch) return
      try {
        const results = video.readyState >= 2 ? await detector.detect(video) : []
        if (epoch !== scanEpoch) return
        if (results[0]?.rawValue) { await applyPairing(results[0].rawValue); if (!$('scanDialog').open) return }
      } catch { $('scanInfo').textContent = '识码失败，请调整距离或粘贴二维码文字。' }
      if (epoch === scanEpoch) scanFrame = requestAnimationFrame(detect)
    }
    detect()
  } catch (e) { if (epoch === scanEpoch) { scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; $('scanVideo').hidden = true; $('scanInfo').textContent = '无法打开相机，请检查网站相机权限：' + e.message } }
}

let workerRegistration = null
// App 里通知走原生，不注册 worker：页面来源固定是本机端口，换电脑后旧 worker 不该留着。
const workerReady = !app && window.isSecureContext && 'serviceWorker' in navigator ? navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(async () => { workerRegistration = await navigator.serviceWorker.ready; return workerRegistration }).catch(() => null) : Promise.resolve(null)
function updateNotificationInfo(extra = '') {
  if (app) { $('notificationInfo').textContent = extra || app.notificationStatus(); return }
  $('notificationInfo').textContent = extra || (!window.isSecureContext ? '系统通知需要 HTTPS。' + HTTPS_HELP : !('Notification' in window) ? '此浏览器没有开放系统通知。iPhone / iPad 请添加到主屏幕后打开。' : ({ granted: '系统通知已允许，网页在后台收到她的新消息时提醒。', denied: '系统通知已被阻止，请在浏览器的网站设置中允许后重试。', default: '尚未授权，点上方按钮允许新消息通知。' }[Notification.permission]))
}
$('enableNotifications').onclick = async () => {
  if (app) { app.requestNotifications(); return }
  if (!window.isSecureContext || !('Notification' in window)) { updateNotificationInfo(); return }
  try { await Notification.requestPermission(); updateNotificationInfo(); await workerReady }
  catch (e) { updateNotificationInfo('无法请求通知权限：' + e.message) }
}
async function openNotificationChat(id) {
  if (!token) return
  if (!bots.some((b) => b.id === id)) await loadBots()
  if (bots.some((b) => b.id === id)) await openChat(id)
  else toast('对应会话已不存在，请刷新列表')
}
async function notifyMessage(m, bot) {
  if (app) { if (token) app.notify(bot?.name || 'Aurabot', previewText(m).slice(0, 80), m.botId, String(m.id)); return }
  if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') return
  const epoch = sessionEpoch
  const options = { body: previewText(m).slice(0, 80), tag: 'aurabot-' + m.id, icon: '/icon.svg', data: { botId: m.botId } }
  try {
    const reg = await workerReady
    if (epoch !== sessionEpoch || !token) return
    if (reg) await reg.showNotification(bot?.name || 'Aurabot', options)
    else { const n = new Notification(bot?.name || 'Aurabot', options); n.onclick = () => { n.close(); window.focus(); openNotificationChat(m.botId) } }
  } catch (e) { updateNotificationInfo('通知发送失败，请检查浏览器权限：' + e.message) }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data?.type === 'open-chat' && typeof event.data.botId === 'string') openNotificationChat(event.data.botId)
})
updateNotificationInfo()

// Capture the target and device generation before requesting permission. Pointer release during
// the permission prompt must not leave the microphone recording indefinitely.
let recording = null, recordEpoch = 0
function finishRecording(cancel = false) {
  const r = recording; if (!r) return
  r.cancelled ||= cancel; r.released = true
  if (r.recorder?.state === 'recording') {
    r.duration = Math.min(120000, Math.round(performance.now() - r.started))
    try { r.recorder.stop() } catch { r.stream?.getTracks().forEach((t) => t.stop()); if (recording === r) recording = null }
  }
  clearTimeout(r.timer); clearInterval(r.clock)
  $('micBtn').style.color = ''; $('recCancel').hidden = true
  $('recordInfo').textContent = window.isSecureContext ? '' : capabilityText()
}
function cancelRecording() { recordEpoch++; finishRecording(true) }
$('recCancel').onclick = cancelRecording
$('micBtn').oncontextmenu = (e) => e.preventDefault()
$('micBtn').onpointerdown = async (e) => {
  e.preventDefault(); if (!current || recording) return
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { $('recordInfo').textContent = capabilityText(); toast('录音需要可信 HTTPS 和麦克风权限'); return }
  const r = recording = { botId: current.id, epoch: sessionEpoch, pointer: e.pointerId, generation: ++recordEpoch, released: false, cancelled: false, chunks: [], recorder: null, stream: null }
  $('micBtn').setPointerCapture(e.pointerId)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); r.stream = stream
    if (r.released || r.cancelled || r.generation !== recordEpoch || r.epoch !== sessionEpoch || !token) { stream.getTracks().forEach((t) => t.stop()); if (recording === r) recording = null; return }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = r.recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    recorder.ondataavailable = (event) => { if (event.data.size) r.chunks.push(event.data) }
    recorder.onerror = () => { r.cancelled = true; finishRecording(true); stream.getTracks().forEach((t) => t.stop()); if (recording === r) recording = null; toast('录音失败，请检查麦克风权限后重试') }
    recorder.onstop = async () => {
      clearTimeout(r.timer); clearInterval(r.clock); stream.getTracks().forEach((t) => t.stop()); if (recording === r) recording = null
      if (r.cancelled || r.epoch !== sessionEpoch || !token) return
      const ms = r.duration || Math.min(120000, Math.round(performance.now() - r.started))
      if (ms < 800) return toast('太短了，按住再说')
      const blob = new Blob(r.chunks, { type: recorder.mimeType || type || 'audio/webm' })
      if (!blob.size || blob.size > 10 * 1024 * 1024) return toast('录音为空或超过 10MB，请重录')
      const local = { id: 'local-' + Date.now(), botId: r.botId, kind: 'voice', text: '', url: URL.createObjectURL(blob), local: true, mine: true, at: Date.now(), durationMs: ms, pending: true }
      if (!msgs.has(r.botId)) msgs.set(r.botId, []); msgs.get(r.botId).push(local); typing.add(r.botId)
      if (current?.id === r.botId) renderMsgs(true)
      const fd = new FormData(); fd.append('botId', r.botId); fd.append('kind', 'voice'); fd.append('dir', store.get('aurabot.uploadDir') || ''); fd.append('durationMs', String(ms)); fd.append('file', blob, 'voice.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'))
      try { await api('/api/mobile/send', { method: 'POST', body: fd }); local.pending = false }
      catch (err) { local.pending = false; local.failed = true; typing.delete(r.botId); toast('语音没发出去：' + err.message) }
      if (current?.id === r.botId) renderMsgs()
    }
    r.started = performance.now(); recorder.start(250)
    $('micBtn').style.color = 'var(--accent)'; $('recCancel').hidden = false
    const tick = () => { $('recordInfo').textContent = `松开发送 · ${Math.floor((performance.now() - r.started) / 1000)} 秒 / 120 秒` }
    tick(); r.clock = setInterval(tick, 250); r.timer = setTimeout(() => finishRecording(), 120000)
  } catch (error) {
    r.stream?.getTracks().forEach((t) => t.stop()); if (recording === r) recording = null
    $('recordInfo').textContent = '拿不到麦克风，请在浏览器网站设置中允许录音，再按住说话。' + (error.message || '')
  }
}
$('micBtn').onpointerup = (e) => { if (recording?.pointer === e.pointerId) finishRecording() }
$('micBtn').onpointercancel = cancelRecording
$('micBtn').onlostpointercapture = () => { if (recording && !recording.released) cancelRecording() }
addEventListener('pagehide', () => { cancelRecording(); closeScanner(); stopPlayback() })
addEventListener('resize', () => { const ball = $('dshBall'); if (!$('dshView').hidden) ball.style.top = Math.max(0, Math.min($('dshView').clientHeight - ball.offsetHeight, ball.offsetTop)) + 'px' })

const params = new URLSearchParams(location.search), code = params.get('code'), notificationBot = params.get('botId')
// Remove the one-time secret even if pairing fails, so it is not left in browser history.
if (code) history.replaceState(null, '', location.pathname)
async function boot() {
  if (code) { show('pairView'); $('codeInput').value = code; await pair(code) }
  else if (token) await start()
  else show('pairView')
  if (notificationBot && token) { history.replaceState(null, '', location.pathname); await openNotificationChat(notificationBot) }
}
boot()
