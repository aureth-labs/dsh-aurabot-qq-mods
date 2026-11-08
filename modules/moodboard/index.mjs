// 模块：心情看板（moodboard）。
// 作用：在桌面固定显示一个小窗（系统默认浏览器弹出），只读展示三块内容：
//   ① 心情模块的当前心情与起伏历史（api.use('mood').state()）；
//   ② 目的引擎的驱力向量（9 维）与心情向量（10 种情绪），以及最近一次主动行为摘要（api.use('purpose').status()）；
//   ③ 记忆库里的相处经验与说话方式（api.use('memory').insights()/styles()）。
// 契约：只读，不写任何数据、不发消息、不联网（只访问本机自己的接口）；跨模块只走 api.use()（AGENTS.md §4）。
// 路由：/board 出看板页面（自己写 res 回 HTML），/state 出聚合 JSON，/open 用系统默认浏览器打开看板。
// 打开方式：面板跑在 DSH 桌面端（Electron 壳）里，window.open / <a target=_blank> 都会被壳吞掉，
// 必须从模块（Node 侧）spawn 系统默认浏览器——照抄 repo/src/features/codex-auth.js 的 openInBrowser：
// Windows 用 rundll32 url.dll,FileProtocolHandler（argv 直传不经 shell，& ? = 都安全），mac 用 open，linux 用 xdg-open。
// /open 的地址从请求的 Host 头拼（面板同源），不需要知道宿主端口。
// 页面渲染全部用 textContent，不拼 HTML，防注入。

import { spawn } from 'node:child_process'

/** 驱力中文标签：与 repo/src/purpose/engine.js 的 NEED_LABELS 保持一致（只读复制，模块不 import 插件内部）。 */
const NEED_LABELS = {
  play: '玩', learn: '学', install: '装', connect: '陪', care: '关心',
  share: '分享', identity: '自我', create: '创作', consume: '体验',
}

/** 心情向量中文标签：与 engine.js 的 EMOTION_LABELS 保持一致。 */
const EMOTION_LABELS = {
  curious: '好奇', excited: '兴奋', lonely: '寂寞', envious: '羡慕',
  worried: '担心', proud: '得意', affectionate: '亲近', bored: '无聊',
  amused: '好笑', content: '平静',
}

/** 心情模块 route 前缀：看板页拉数据用的固定路径（用户模块接口挂 /aurabot/api/ext/<id>/ 下）。 */
const API_BASE = '/aurabot/api/ext/moodboard'

/**
 * 用系统默认浏览器打开链接（照抄 repo/src/features/codex-auth.js 的 openInBrowser）。
 * Windows 上不能用 cmd /c start：链接里的 & 会被 cmd 当命令分隔符截断；
 * rundll32 直接收 argv，不经过 shell，& ? = 都原样带过去。
 * run 可注入（测试用 api.__moodboardTestHooks.run，照 pet 模块的 petHooks 模式），不打真进程。
 */
function openInBrowser(url, { run = spawn, platform = process.platform } = {}) {
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true }
    const child = platform === 'win32' ? run('rundll32', ['url.dll,FileProtocolHandler', url], opts)
      : platform === 'darwin' ? run('open', [url], opts) : run('xdg-open', [url], opts)
    child.on?.('error', () => {}) // 打不开时面板会显示手动访问的地址
    child.unref?.()
    return true
  } catch {
    return false
  }
}

/** 汇总三块数据；每个来源独立 try/catch，某个模块关着时不拖累整页（页面会显示「没在跑」）。 */
function buildState(api) {
  const pick = (fn) => { try { return fn() ?? null } catch { return null } }
  const mood = pick(() => api.use('mood')?.state?.())
  // purpose.state() 是薄摘要（没有驱力/心情向量）；drives 和 moods 在 status()（summarizePurposeState）里，优先用它
  const ps = pick(() => api.use('purpose')?.status?.()) || pick(() => api.use('purpose')?.state?.())
  const purpose = ps
    ? {
        drives: ps.drives || {},
        moods: ps.moods || {},
        lastEmotion: ps.lastEmotion || '',
        lastEmotionText: ps.lastEmotionText || '',
        lastEmotionLabel: ps.lastEmotionLabel || '',
        lastPurpose: ps.lastPurpose || '',
        lastOutcome: ps.lastOutcome || '',
        nextFireAt: ps.nextFireAt || 0,
        nextFireText: ps.nextFireText || '',
      }
    : null
  const memory = {
    // 相处经验：[{key, name, list}]（key 形如 qq:123 / group:456 / self）
    insights: pick(() => api.use('memory')?.insights?.()) || [],
    // 说话方式：{key: ['…', …]}
    styles: pick(() => api.use('memory')?.styles?.()) || {},
  }
  return { ok: true, at: Date.now(), mood, purpose, memory, labels: { needs: NEED_LABELS, emotions: EMOTION_LABELS } }
}

/** 看板页面：自包含单文件（样式 + 脚本内联），小窗尺寸友好，自动轮询 /state。 */
function boardPage(api) {
  const refresh = Math.max(2, Math.min(120, Number(api.settings?.().refresh) || 5))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>心情看板 · 大肥鱼</title>
<style>
  :root { color-scheme: dark; background: #101418; }
  * { box-sizing: border-box; }
  html { overscroll-behavior: none; }
  body { margin: 0; padding: 12px; background: #101418; color: #d8e2ea; min-height: 100vh;
         font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif; }
  h1 { font-size: 14px; margin: 0 0 2px; color: #9fd8ff; }
  .sub { font-size: 11px; color: #6b7c88; margin-bottom: 10px; }
  section { background: #171d23; border: 1px solid #232d36; border-radius: 10px;
            padding: 10px 12px; margin-bottom: 10px; }
  h2 { font-size: 12.5px; margin: 0 0 8px; color: #b9ccd8; }
  .big { font-size: 26px; font-weight: 600; color: #ffd479; }
  .label { color: #9fb4c2; margin-left: 8px; font-size: 13px; }
  .reason { color: #8fa3b0; font-size: 12px; margin-top: 2px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .bar-row .name { width: 4.5em; flex: none; color: #a9bcc9; white-space: nowrap; }
  .bar { flex: 1; min-width: 0; height: 6px; background: #232d36; border-radius: 999px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #58a6ff; border-radius: 999px; }
  .bar-row.mood-emotion .bar i { background: #f0883e; }
  .bar-row .val { width: 3.5em; flex: none; text-align: right; color: #6b7c88; font-size: 11px; white-space: nowrap; }
  .hist { margin: 0; padding: 0; list-style: none; }
  .hist li { padding: 3px 0; border-bottom: 1px dashed #1e262e; font-size: 12px; }
  .hist li:last-child { border-bottom: none; }
  .hist .t { color: #6b7c88; margin-right: 6px; }
  .up { color: #7ee787; } .down { color: #ff7b72; }
  .who { color: #9fd8ff; font-size: 12px; margin: 6px 0 2px; }
  .item { color: #a9bcc9; font-size: 12px; padding-left: 10px; }
  .off { color: #6b7c88; font-style: italic; }
  .err { color: #ff7b72; font-size: 12px; }
</style>
</head>
<body>
  <h1>大肥鱼 · 心情看板</h1>
  <div class="sub" id="sub">加载中…　<a href="#" id="reopen" style="color:#58a6ff">在新窗口打开（可随意拉伸，页面自适应）</a></div>
  <div id="root"></div>
<script>
'use strict'
// 用真锚点打开（用户点击的锚点导航不被弹窗拦截器拦；window.open 会被拦，见 MEMORY.md §3.7）
document.getElementById('reopen').addEventListener('click', function (e) {
  e.preventDefault()
  var a = document.createElement('a')
  a.href = location.href
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
})
var API = '${API_BASE}/state'
var REFRESH = ${refresh} * 1000
function el(tag, cls, text) {
  var n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
function bar(parent, name, value, cls) {
  var row = el('div', 'bar-row' + (cls ? ' ' + cls : ''))
  row.appendChild(el('span', 'name', name))
  var b = el('span', 'bar'); var i = el('i')
  i.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + '%'
  b.appendChild(i); row.appendChild(b)
  row.appendChild(el('span', 'val', Math.round(value * 100) + '%'))
  parent.appendChild(row)
}
function fmt(ms) {
  if (!ms) return ''
  var d = new Date(ms)
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
}
function render(s) {
  var root = document.getElementById('root')
  root.textContent = ''
  document.getElementById('sub').textContent =
    '更新于 ' + new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false })

  // ① 心情
  var m = s.mood
  var sec = el('section'); var h = el('h2', null, '心情'); sec.appendChild(h)
  if (!m) { sec.appendChild(el('div', 'off', '心情模块没在跑')); root.appendChild(sec); }
  else {
    var line = el('div')
    line.appendChild(el('span', 'big', String(m.value)))
    line.appendChild(el('span', 'label', m.label || ''))
    sec.appendChild(line)
    if (m.reason) sec.appendChild(el('div', 'reason', '因为：' + m.reason))
    var hist = m.history || []
    if (hist.length) {
      sec.appendChild(el('h2', null, '心情起伏（最近 ' + Math.min(hist.length, 12) + ' 条）'))
      var ul = el('ul', 'hist')
      hist.slice(0, 12).forEach(function (it) {
        var li = el('li')
        li.appendChild(el('span', 't', fmt(it.at)))
        var delta = (it.to || 0) - (it.from || 0)
        var d = el('span', delta >= 0 ? 'up' : 'down', delta >= 0 ? '+' + delta : String(delta))
        li.appendChild(d)
        if (it.reason) li.appendChild(document.createTextNode(' ' + it.reason))
        ul.appendChild(li)
      })
      sec.appendChild(ul)
    }
    root.appendChild(sec)
  }

  // ② 目的引擎：驱力 + 心情向量
  var p = s.purpose
  sec = el('section'); sec.appendChild(el('h2', null, '目的引擎 · 驱力'))
  if (!p) sec.appendChild(el('div', 'off', '目的引擎没在跑'))
  else {
    // 全量渲染：驱力按 9 维、心情按 10 种情绪，没有数据的也出 0 条（少爷定的口径）
    var drives = Object.keys(s.labels.needs)
      .map(function (k) { return [k, Number((p.drives || {})[k]) || 0] })
      .sort(function (a, b) { return b[1] - a[1] })
    drives.forEach(function (kv) {
      bar(sec, (s.labels.needs[kv[0]] || kv[0]), kv[1])
    })
    sec.appendChild(el('h2', null, '目的引擎 · 心情向量'))
    var moods = Object.keys(s.labels.emotions)
      .map(function (k) { return [k, Number((p.moods || {})[k]) || 0] })
      .sort(function (a, b) { return b[1] - a[1] })
    moods.forEach(function (kv) {
      bar(sec, (s.labels.emotions[kv[0]] || kv[0]), kv[1], 'mood-emotion')
    })
    var emo = p.lastEmotionText || p.lastEmotionLabel
    if (emo) sec.appendChild(el('div', 'reason', '上次行动的情绪：' + emo))
    if (p.lastPurpose) sec.appendChild(el('div', 'reason', '上次主动：' + String(p.lastPurpose).slice(0, 60)))
    var fire = p.nextFireText || (p.nextFireAt ? new Date(p.nextFireAt).toLocaleString('zh-CN', { hour12: false }) : '')
    if (fire) sec.appendChild(el('div', 'reason', '下次可能主动：' + fire))
  }
  root.appendChild(sec)

  // ③ 记忆：相处经验 + 说话方式
  sec = el('section'); sec.appendChild(el('h2', null, '记忆 · 相处经验'))
  var ins = s.memory.insights || []
  if (!ins.length) sec.appendChild(el('div', 'off', '还没有相处经验'))
  ins.forEach(function (g) {
    sec.appendChild(el('div', 'who', g.name || g.key))
    ;(g.list || []).forEach(function (t) {
      // 条目可能是字符串，也可能是 {text,…} 对象（memory.insights() 实测返回对象）
      var text = typeof t === 'string' ? t : (t && t.text) || ''
      if (text) sec.appendChild(el('div', 'item', '· ' + text))
    })
  })
  sec.appendChild(el('h2', null, '记忆 · 说话方式'))
  var styles = s.memory.styles || {}
  var keys = Object.keys(styles).filter(function (k) { return (styles[k] || []).length })
  if (!keys.length) sec.appendChild(el('div', 'off', '还没有说话方式'))
  keys.forEach(function (k) {
    sec.appendChild(el('div', 'who', k))
    styles[k].forEach(function (t) { sec.appendChild(el('div', 'item', '· ' + t)) })
  })
  root.appendChild(sec)
}
function tick() {
  fetch(API).then(function (r) { return r.json() }).then(function (s) {
    if (s && s.ok) render(s)
    else throw new Error(s && s.message || '未知错误')
  }).catch(function (e) {
    document.getElementById('sub').textContent = '拉取失败：' + (e && e.message || e)
  })
}
tick()
setInterval(tick, REFRESH)
</script>
</body>
</html>`
}

export default {
  id: 'moodboard',
  name: '心情看板',
  version: '1.0.0',
  api: 1,
  // 挂 overview（概览）：面板的独立模块页会被两层导航兜底分到「系统」组末尾（client.js NAV_GROUPS 白名单
  // + PLATFORM_EXT 正则，心情看板不命中正则），太深；overview 是最顶上的分组且页面短，按钮最显眼
  tab: 'overview',
  description: '桌面固定小窗：心情与起伏历史、目的引擎驱力与心情向量、记忆里的相处经验与说话方式',
  defaults: { refresh: 5 },
  settings: [
    { key: 'refresh', label: '自动刷新间隔（秒）', type: 'number', min: 2, max: 120, step: 1, hint: '看板页隔多久拉一次新数据，默认 5 秒' },
  ],
  panel: 'panel.js',
  setup(api) {
    const hooks = api.__moodboardTestHooks || {} // 测试注入点（照 pet 模块的 petHooks 模式）
    // 聚合数据接口：页面轮询它
    api.route('/state', async () => buildState(api))
    // 看板页面：自己写 res 回 HTML（不返回值，宿主就不再包 JSON）
    api.route('/board', async (req, res) => {
      api.core.http.send(res, 200, boardPage(api), 'text/html; charset=utf-8')
    })
    // 用系统默认浏览器打开看板（桌面端 Electron 壳里 window.open/锚点都被吞，只能从 Node 侧起进程）。
    // 地址从请求的 Host 头拼（面板同源），不用猜端口。
    api.route('/open', async (req) => {
      const host = String(req?.headers?.host || '').trim()
      if (!host || !/[.:]/.test(host)) {
        return { ok: false, message: '拿不到面板地址，请从面板里点按钮打开' }
      }
      const url = `http://${host}${API_BASE}/board`
      const ok = openInBrowser(url, { run: hooks.run || spawn, platform: hooks.platform || process.platform })
      return ok
        ? { ok: true, message: '已用系统浏览器打开看板', url }
        : { ok: false, message: '自动打开失败，手动访问：' + url }
    })
    return {}
  },
}
