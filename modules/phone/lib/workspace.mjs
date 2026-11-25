// workspace.mjs —— 工作区回合驱动 + 简单 cron 解析（契约 A 节签名仲裁）
// 作用：占锁 → 逐「观察→决策→守门→执行」循环遥控手机完成一句话任务 → 收尾存记忆、放锁。
// 观察层：节点优先（uiautomator brief），当轮取不到节点就立刻截图兜底（视觉模型按像素坐标决策，
//         tap 支持 xy 形态）；模型看不了图才退回 back+重试（连续三次坏步中止）。
// 契约：export async function runWorkspace({ flowKey, prompt, packages = [], maxSteps = 40, guide = '', guideFor = null, ctx })
//   guide：常驻「主流程总纲」（传了 guideFor 时）；只传 guide 不传 guideFor = 整场一份应用手册（旧用法）
//   guideFor(pkg) → 手册文本或 ''：按当前前台应用按需加载单应用手册（省 token），每包只解析一次
//   ctx = { adb, session, safety, memory, ask, report?(chatId, text) }
//   → { ok, summary, steps }
// 另 export cronMatch(expr, date)：五字段简单 cron（分 时 日 月 周），支持 * / 数字 / */n / 逗号列表。

import { parseNodes, nodeCenter } from './nodes.mjs'

/**
 * 站外目标包：普通点击后被带到这些应用，基本就是点了广告（下载页、商城、应用市场）。
 * 测到这种情况就 back 回原应用——模型本来是在逛内容，不该莫名其妙跑到商店里。
 * 模型自己主动 launch 的这些包不算（那是真想去）。
 */
const AD_TARGETS = new Set([
  'com.honor.browser',
  'com.hihonor.browserhomepage',
  'com.hihonor.appmarket',
  'com.huawei.appmarket',
  'com.hihonor.vmall',
  'com.huawei.fastapp',
  'com.huawei.hicloud',
])

/**
 * 系统弹层包：不是模型主动打开的东西，但会突然抢到前台——
 * 误触荣耀搜索、权限授权对话框、安装器提示。
 * 以前这些一律按「前台包不在白名单」整轮中止（71 步跑完发现前台是 com.hihonor.search，白跑）。
 * 现在先在这类界面上找按钮点掉，找不到就 back；连续多次甩不掉才放弃，并如实说是被弹层卡住的。
 *   buttons —— 优先点这些文字的按钮（权限弹窗必须选一个，back 有时关不掉）
 *   back    —— 没有可用按钮时按返回
 */
const DISTRACTOR = {
  // 注意：com.hihonor.search（荣耀搜索）和 com.android.systemui（通知栏/状态栏）**故意不在这里**。
  // 用户 2026-11-08 说「允许模型使用系统弹层」——荣耀搜索是桌面下滑就能拉出来的正常界面，
  // 模型完全可能自己打开、自己退出。把它当"甩不掉的弹层"处理，back 三次没用就整轮中止，
  // 等于把模型正常在用的东西判成故障（实测「高德看世界」就是这么挂的）。
  // 这里只留**必须点掉才过得去**的系统对话框：权限授权、安装确认、系统管理器的确认框。
  'com.android.permissioncontroller': {
    buttons: ['仅在使用中允许', '使用时允许', '允许', '始终允许', '允许所有', '确定', '同意', '好'],
    back: true,
  },
  'com.android.packageinstaller': { buttons: ['安装', '继续', '确定', '允许'], back: true },
  'com.google.android.packageinstaller': { buttons: ['安装', '继续', '确定', '允许'], back: true },
  'com.hihonor.systemmanager': { buttons: ['允许', '确定', '取消', '同意'], back: true },
}


/** 五字段 cron 匹配：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6，0=周日) */
export function cronMatch(expr, date) {
  if (!expr || typeof expr !== 'string') return false
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(), // JS 周日=0，与 cron 惯例一致
  ]
  const bases = [0, 0, 1, 1, 0] // 各字段取值下限（*/n 从下限起算）
  return parts.every((field, i) => field.split(',').some((item) => {
    const f = item.trim()
    if (f === '*') return true
    const step = f.match(/^\*\/(\d+)$/) // */n：从下限起每 n 取一次
    if (step) {
      const n = Number(step[1])
      return n > 0 && (values[i] - bases[i]) % n === 0
    }
    const num = Number(f)
    return Number.isInteger(num) && num === values[i]
  }))
}

/** 稳健解析模型回复里的 JSON 动作：剥 ```json 围栏、取首个 {...}、容错单引号 */
function parseAction(text) {
  if (!text || typeof text !== 'string') return null
  let s = text.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch { /* 继续容错 */ }
  try {
    // 容错单引号键名/字符串：先把 "键 : " 补成双引号键，再把残余单引号换成双引号
    const fixed = s.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ': "$1"')
    return JSON.parse(fixed)
  } catch {
    return null
  }
}

/** 等一小段毫秒（双击两次 tap 之间留间隙用）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 tap / double_tap / long_press 共用的目标坐标：节点号 n（节点模式）> 像素坐标 xy（截图兜底） */
function resolveTarget(act, nodeList) {
  let center = null
  if (act.n != null && act.n !== '') center = nodeCenter(nodeList, Number(act.n))
  if (!center && Array.isArray(act.xy) && act.xy.length === 2 && act.xy.every((v) => Number.isFinite(v) && v > 0)) {
    center = [Math.round(act.xy[0]), Math.round(act.xy[1])]
  }
  if (!center) return { note: act.xy !== undefined ? '坐标 xy 不合法' : `节点 ${act.n} 不存在` }
  return { center }
}

/** scroll 持续时长：模型给的 ms 夹在 100~2000，缺省 300。 */
function scrollMs(act) {
  const n = Number(act.ms)
  return Number.isFinite(n) ? Math.min(2000, Math.max(100, Math.round(n))) : 300
}

/* ---------------- 拟人化 ----------------
 * 真人用手指不会每次都点在控件正中心、不会每次划出同样长度、也不会掐着秒表一步接一步。
 * 机械动作（同一坐标、同一时长、固定节拍）在平台的设备指纹里是最明显的自动化特征，
 * 小红书那次被踢下线就是这类信号攒出来的。这里给每次动作加一点人类噪声：
 *   - 点击点相对控件中心随机偏 ±24 / ±18 像素（人手落点本来就会飘）
 *   - 滑动的起点、终点、时长全部随机，偶尔划短一点（像没划到位）
 *   - 两步之间随机歇 0.5~3 秒，同一个动作连着做很多次时歇得更久（像看进去了）
 */
const rnd = (a, b) => a + Math.random() * (b - a)
const rndInt = (a, b) => Math.round(rnd(a, b))

/** 从动作里取出它指向的节点文字（判断「点的是不是完成/新建」时用）。 */
function nodeLabel(act, list) {
  if (act && act.n != null && act.n !== '' && Array.isArray(list) && list[Number(act.n)]) {
    const nd = list[Number(act.n)]
    return String(nd.text || nd.desc || '')
  }
  return String((act && act.text) || '')
}

/** 点击点相对控件中心抖一下，别永远落在几何中心。 */
function jitter(x, y) {
  return [Math.round(x + rnd(-24, 24)), Math.round(y + rnd(-18, 18))]
}

/**
 * 按控件尺寸抖：大按钮随便抖，小图标几乎不抖。
 * 小图标（顶部工具栏那种，宽高常只有 50~80px）抖 ±24 像素会直接点出可点区域，
 * 表现出来就是「点了没反应、连点三次界面都没变」——这种假失败最耗步数。
 */
function jitterFor(center, size) {
  if (!center) return null
  if (!Array.isArray(size) || size.length !== 2) return jitter(center[0], center[1])
  const [w, h] = size
  // 抖动幅度最多取控件的 1/5，再夹到 24/18 上限
  const maxX = Math.max(0, Math.min(24, Math.floor(w / 5)))
  const maxY = Math.max(0, Math.min(18, Math.floor(h / 5)))
  return [
    Math.round(center[0] + rnd(-maxX, maxX)),
    Math.round(center[1] + rnd(-maxY, maxY)),
  ]
}

/** 两步之间的自然停顿（毫秒）。streak = 这个动作已经连续做了几次。 */
function pauseMs(kind, streak = 1) {
  const table = {
    scroll: [420, 1500],
    tap: [800, 2600],
    double_tap: [700, 1800],
    long_press: [700, 1600],
    input: [1200, 3200],
    clear: [800, 2000],
    back: [600, 1700],
    home: [600, 1500],
    key: [500, 1400],
    launch: [1500, 3600],
    wait: [0, 0],
    drag: [700, 1800],
  }
  // 走神/看进去了：大约每 8 步会有一次长得多的停顿（2.5~6 秒）。
  // 真人刷手机不是匀速的——看到一条有意思的会停住，这一下比任何坐标抖动都更像人。
  if (Math.random() < 0.12) return Math.round(rnd(2500, 6000))
  const [a, b] = table[String(kind || '')] || [600, 1800]
  // 同一个动作连着来，额外多歇一会儿——真人划到第三屏会停一下看看，不会一路狂划
  const extra = streak >= 3 ? rnd(300, 1600) : 0
  return Math.round(rnd(a, b) + extra)
}

/** 把一次模型决策过安全门并执行；返回 { done, note } */
async function applyAction(adb, safety, pkg, act, nodeList) {
  const kind = String(act.action || '').toLowerCase()
  if (kind === 'finish') return { done: true, note: String(act.summary || '任务完成') }

  // 判定本步涉及的界面文本（供写操作关键词判定）：节点 text **和 content-desc** 都算
  // （一审 #19-4：只有 content-desc 的图标按钮，之前只看 text 会漏判写操作）。
  let nodeText = ''
  let blind = false // 盲点：坐标动作（没有节点文字）时无法判断是不是写操作
  if (act.n != null && act.n !== '') {
    const node = nodeList[Number(act.n)]
    if (!node || !nodeCenter(nodeList, Number(act.n))) return { done: false, note: `节点 ${act.n} 不存在` }
    nodeText = [node.text, node.desc].filter(Boolean).join(' ')
  }
  // 复审第 4 条：坐标动作（tap/double_tap/long_press）一律按「盲点」算——不能靠模型自己填 text 绕过；
  // 只有节点模式命中 text/desc 才算有依据。
  if (!nodeText && ['tap', 'double_tap', 'long_press'].includes(kind)) blind = true
  // 回车发送：key enter 也会提交内容，写操作确认开着时按写操作处理。
  if (kind === 'key' && String(act.name || '').toLowerCase() === 'enter' && !nodeText) nodeText = '回车发送'
  if (!nodeText) nodeText = String(act.text || '')

  const verdict = await safety.gate({ pkg, nodeText, kind, blind })
  if (verdict === 'NEED_CONFIRM') return { done: true, confirm: true, note: '等待用户批准写操作，回合暂停（phone confirm 查看）' }
  if (verdict === 'REJECT') {
    // 拒绝原因来自 safety.lastReject（白名单/包级禁令各写各的），让模型知道怎么绕
    const why = safety.lastReject || `该动作被安全策略拒绝（${nodeText || kind}）`
    return { done: false, note: `被拒：${why}。换个动作，别反复试同一个` }
  }
  if (verdict === 'DRY_RUN') return { done: false, note: `试运行：计划 ${kind}${nodeText ? '「' + nodeText + '」' : ''}，未执行` }

  // ALLOW：真执行
  try {
    switch (kind) {
      case 'tap': {
        const t = resolveTarget(act, nodeList)
        if (!t.center) return { done: false, note: t.note }
        const node = act.n != null && act.n !== '' ? nodeList[Number(act.n)] : null
        const [jx, jy] = jitterFor(t.center, node && node.size)
        await adb.tap(jx, jy)
        break
      }
      case 'double_tap': {
        // 双击：两次 tap 留 80ms 间隙，慢于系统双击阈值（约 300ms）会被当成两次单击
        // 真人双击两次落点几乎重合，所以同一点上只抖一次，别两次各抖各的
        const t = resolveTarget(act, nodeList)
        if (!t.center) return { done: false, note: t.note }
        const [jx, jy] = jitter(t.center[0], t.center[1])
        await adb.tap(jx, jy)
        await sleep(80)
        await adb.tap(jx, jy)
        break
      }
      case 'long_press': {
        // 长按：默认 800ms，可用 ms 参数（600~2000）调时长；弹出菜单/多选/拖拽入口用
        const t = resolveTarget(act, nodeList)
        if (!t.center) return { done: false, note: t.note }
        const [jx, jy] = jitter(t.center[0], t.center[1])
        await adb.longPress(jx, jy, Number(act.ms) || 800)
        break
      }
      case 'input': {
        const want = String(act.text || '')
        // 没给文字就直说：模型偶尔只发 {"action":"input","text":" "}，界面上什么都没发生，
        // 它却以为写好了，接着去点「完成」存了个空记录——日历那边就是这么反复空转的。
        if (!want.trim()) {
          return { done: false, note: 'input 没给内容：把要写的文字放进 text 字段，例如 {"action":"input","text":"要写的话"}' }
        }
        // 模型如果指明了输入框（n 或 xy），优先用它选的；没指明就取界面上第一个可编辑节点，
        // 或者「假输入框」占位（DeepSeek 的「发消息或按住说话」就是这种不可点的 TextView）。
        // 坐标必须来自**切换输入法之前**的这轮 dump，交给 inputText 在切完之后点——
        // 那边绝不再 dump（dump 会打断输入连接，之后广播就丢字）。
        let target = null
        if ((act.n != null && act.n !== '') || Array.isArray(act.xy)) {
          const t = resolveTarget(act, nodeList)
          if (t && t.center) target = t.center
        }
        if (!target) {
          const pick = (nodeList || []).find((nd) => nd.editable) || (nodeList || []).find((nd) => nd.placeholder)
          if (pick) target = pick.center
        }
        await adb.inputText(want, target)
        // 回读验证：中文走的是 ADB Keyboard 的 base64 广播，焦点不在输入框时广播会被静默丢弃
        // （Broadcast completed 照样返回 0），模型却以为已经写好了，于是「新建→点正文→输入→返回」
        // 一遍遍空转，20 步烧完什么都没写进去。这里读一次界面，确认文字真的出现在某个节点里。
        if (want.trim()) {
          try {
            const probe = parseNodes(await adb.dumpNodes())
            const needle = want.trim().slice(0, 8)
            const seen = (probe.list || []).some((nd) => String(nd.text || '').includes(needle))
            if (!seen) {
              return { done: false, note: `input「${want}」没写进去：输入框没拿到焦点（广播被丢弃）。下一步先 tap 那个输入框节点，等半秒再 input` }
            }
          } catch { /* 验证本身失败就当输入成功，别因为读不到界面把好好的步骤判死 */ }
        }
        break
      }
      case 'clear': {
        // 清空已输入内容：给了目标（n/xy）就先点一下聚焦，再清空当前输入框
        if (act.n != null && act.n !== '' || Array.isArray(act.xy)) {
          const t = resolveTarget(act, nodeList)
          if (!t.center) return { done: false, note: t.note }
          const [jx, jy] = jitter(t.center[0], t.center[1])
          await adb.tap(jx, jy)
        }
        await adb.clearText()
        break
      }
      case 'drag': {
        // 精确拖拽：起点（n/xy，同 tap）拖到终点 to:[x,y]（或 to_n 节点），ms 可选（100~5000，默认 600）
        const from = resolveTarget(act, nodeList)
        if (!from.center) return { done: false, note: from.note }
        let to = null
        if (act.to_n != null && act.to_n !== '') to = nodeCenter(nodeList, Number(act.to_n))
        if (!to && Array.isArray(act.to) && act.to.length === 2 && act.to.every((v) => Number.isFinite(v) && v > 0)) {
          to = [Math.round(act.to[0]), Math.round(act.to[1])]
        }
        if (!to) return { done: false, note: '终点 to/to_n 不合法' }
        const ms = Math.min(5000, Math.max(100, Number.isFinite(Number(act.ms)) ? Math.round(Number(act.ms)) : 600))
        const [fx, fy] = jitter(from.center[0], from.center[1])
        await adb.swipe(fx, fy, to[0], to[1], Math.round(ms * rnd(0.85, 1.2)))
        break
      }
      case 'key':
        // 白名单按键：enter/tab/volume_up/volume_down/power/notifications；软键盘没「搜索」键时用 enter 顶
        await adb.key(act.name)
        break
      case 'wait': {
        // 等待加载/转场：不碰设备纯空转，夹 500~10000ms，缺省 1000
        const n = Number(act.ms)
        const ms = Number.isFinite(n) ? Math.min(10000, Math.max(500, Math.round(n))) : 1000
        await sleep(ms)
        break
      }
      case 'scroll': {
        // 方向约定（之前写反过，别改回去）：
        //   up   = 内容上移，看下面的内容 —— 手指从下往上划（y 由大到小）
        //   down = 内容下移，看上面的内容 —— 手指从上往下划（y 由小到大）
        // 旧实现把 up 写成了从上往下划，模型想往下翻结果一路滚回顶部，界面看着纹丝不动。
        // 现在起止点、距离、时长全部随机，别每次都从同一条竖线、划同样长度。
        const dur = rndInt(220, 620)
        const cx = rndInt(520, 700) // 手指落点：屏幕中偏左，人手不会每次都对齐中线
        const cx2 = cx + rndInt(-50, 50)
        const spanY = rndInt(650, 1150) // 这一下划多远（真人很少每次正好一整屏）
        // 偶尔像手滑了一下：先往回带一小下再正常滑。真人划屏常有这种小失误，
        // 一条滑动手势的起止点、时长、中途方向都规整一致，反而是机器人的特征。
        if (Math.random() < 0.1) {
          const y0 = rndInt(1100, 1550)
          const dy = rndInt(60, 150)
          const back = ['up', 'down', ''].includes(String(act.dir || ''))
          if (back) {
            await adb.swipe(cx, y0, cx2, act.dir === 'down' ? y0 - dy : y0 + dy, rndInt(120, 260))
            await sleep(rndInt(70, 180))
          }
        }
        switch (act.dir) {
          case 'up': {
            const y1 = rndInt(1500, 1850)
            await adb.swipe(cx, y1, cx2, Math.max(350, y1 - spanY), dur)
            break
          }
          case 'down': {
            const y1 = rndInt(620, 950)
            await adb.swipe(cx, y1, cx2, Math.min(2600, y1 + spanY), dur)
            break
          }
          case 'left':
            await adb.swipe(rndInt(880, 1010), rndInt(1080, 1320), rndInt(140, 320), rndInt(1080, 1320), dur)
            break
          case 'right':
            await adb.swipe(rndInt(140, 320), rndInt(1080, 1320), rndInt(880, 1010), rndInt(1080, 1320), dur)
            break
          default: {
            // 没给方向：按「往下看」处理，这是逛内容时最常见的意图
            const y1 = rndInt(1500, 1850)
            await adb.swipe(cx, y1, cx2, Math.max(350, y1 - spanY), dur)
          }
        }
        break
      }
      case 'back': await adb.pressKey('back'); break
      case 'home': await adb.pressKey('home'); break
      case 'launch': {
        const want = String(act.pkg || act.text || '')
        await adb.launchApp(want)
        // App 冷启动要等：monkey 只是把启动意图丢过去就返回，界面还没起来。
        // 不等就 dump，会读到一个还是旧应用的界面，模型以为没启动成功，再 launch 一次——
        // 如此三四轮就被去重逻辑判成「重复动作」中止（实测就是这么挂的）。
        await sleep(1800)
        return { done: false, note: `已启动 ${want}（等了一秒多让它起来，下一步看前台是不是它）` }
      }
      default:
        return { done: false, note: `未知动作 ${kind}` }
    }
    return { done: false, note: `已执行 ${kind}${nodeText ? '「' + nodeText + '」' : ''}` }
  } catch (e) {
    return { done: false, note: `动作执行失败：${e.message}` }
  }
}

/**
 * 截图兜底：uiautomator 取不到节点（渲染层视频流 / 游戏 / 部分 WebView 常见）时，
 * 当轮立刻截整屏交给视觉模型按像素坐标决策，不走 back+重试计数。
 * 返回 { act }（拿到动作）或 { reason, visionBroken? }（失败原因；visionBroken=这个模型看不了图，本次回合内不再试）。
 * system 由调用方按「总纲 + 当前应用手册 + 历史经验」拼好传入（和节点路径同一套注入）。
 */
async function decideByShot({ adb, ask, pkg, prompt, steps, maxSteps, system, visionBroken }) {
  if (visionBroken) return { reason: '' } // 已知看不了图：直接走老的 back+重试
  let shot
  try { shot = await adb.screenshot() } catch (e) { return { reason: `截屏失败：${e.message}` } }
  const user = [
    `目标：${prompt}`,
    pkg ? `当前前台应用：${pkg}` : '',
    steps > 0 ? `（已执行 ${steps} 步，剩余 ${maxSteps - steps} 步）` : '',
    '只回 JSON 动作。',
  ].filter(Boolean).join('\n')
  try {
    const act = parseAction(await ask({
      system, text: user,
      images: [{ data: shot.toString('base64'), mediaType: 'image/png' }],
    }))
    if (act && act.action) return { act }
    return { reason: '截图兜底：视觉决策没返回有效动作' }
  } catch (e) {
    // 模型不支持看图 / 附件服务不在 / 请求被拒：本次回合内标记，后续轮次不再重复试
    return { reason: `截图兜底失败：${e.message || e}`, visionBroken: true }
  }
}

export async function runWorkspace({ flowKey = 'adhoc', prompt = '', packages = [], maxSteps = 40, guide = '', guideFor = null, ctx }) {
  const { adb, session, safety, memory, ask, report } = ctx
  let steps = 0
  let badSteps = 0 // 连续坏步计数
  let distractorHits = 0 // 连续被系统弹层抢前台的次数（甩不掉就中止，别耗光步数）
  let blankPkgSteps = 0 // 连续几步读不到前台包（息屏时是 AOD 窗口）：攒够就按一次唤醒键
  let offlineSteps = 0 // 连续几步既读不到包名又 dump 不出节点（疑似 USB 掉线）
  let lastKind = '' // 上一个动作类型
  let sameKind = 0 // 这个动作类型连着做了几次（决定停顿要不要加长）
  let sameActKey = '' // 上一步的「动作+目标」指纹
  let sameActCount = 0 // 同一个动作+目标连着重复了几次（防死循环烧步数）
  let lastBrief = '' // 上一轮界面的文字指纹：用来判断动作到底有没有让界面动一下
  let prevKind = '' // 上一步的动作类型（用来判断"点了一下就被带走"）
  let adJumps = 0 // 被广告带去站外应用的次数
  const sentTexts = new Set() // 本轮已经发出去的文字（防同一句话反复发）
  let lastInputText = '' // 刚打进输入框、还没发送的文字
  let repeatedAsks = 0 // 反复重发同一句话的次数
  let savedOnce = false // 日历里已经点过「完成」保存过一次（防止模型再建一条去"确认"）
  let visionBroken = false // 截图兜底被模型拒绝/报错后置位：本回合内不再重复试截图
  let lastBadReason = '' // 最近一次取不到节点时的真实失败原因（中止时如实汇报）
  let ok = false
  let summary = ''
  const visited = new Set() // 本轮实际到过的前台包名（含启动过的），收尾关应用释放内存用
  // 取锁失败（已被别的任务占着）就直接拒绝，别硬跑（复审第 6 条：之前的 {ok:false} 没检查）
  // 排队最多等 5 分钟；等不到就把占用者和原因说清楚（以前只甩一句「稍后再试」，看不出是死锁还是并发）
  const lock = await session.acquire(flowKey, 5 * 60_000)
  if (!lock || lock.ok === false) {
    const st = session.status()
    return {
      ok: false,
      steps: 0,
      visited: [],
      summary: `手机正被其他任务占用（${lock?.reason || '未知'}；占用者 ${st.owner || '无'}，排队 ${st.queued}），这次没跑`,
    }
  }
  // 任务期间保持屏幕常亮：手机自己息屏后，后面的点击/滑动全部打空——界面纹丝不动，
  // 模型却以为「点了没反应」，一路空转到步数耗尽（实测高德那轮 99 步全废在 Dozing 上）。
  try { await adb.shell(['svc', 'power', 'stayon', 'true']) } catch { /* 部分设备不支持，靠下面的兜底唤醒 */ }
  try {
    const mem = memory.load(flowKey)
    // 提示词注入（省 token）：guide 是常驻的「总纲/主流程」（优先注入）；guideFor(pkg) 按需返回
    // 当前前台应用的单应用手册——决定刷某个应用后才加载，没对应手册就不注入。每包只解析一次并缓存。
    // 旧用法（只传 guide 不传 guideFor）保持原语义：整场一份应用手册。
    const appCache = new Map() // pkg → 手册文本（'' = 没有）
    const manualFor = (pkg) => {
      if (!guideFor) return guide
      if (!appCache.has(pkg)) appCache.set(pkg, pkg ? String(guideFor(pkg) || '') : '')
      return appCache.get(pkg) || ''
    }
    const buildSystem = (pkg, isShot) => {
      const manual = manualFor(pkg)
      return [
        isShot
          ? '你是 Android 手机操作决策器。当前界面拿不到控件节点清单，给你一张整屏截图，你只回一个 JSON 动作，不要其他文字。'
          : '你是 Android 手机操作决策器。每回合给你当前界面节点清单，你只回一个 JSON 动作，不要其他文字。',
        'JSON 格式：{"action":"tap|input|clear|drag|scroll|key|wait|back|home|launch|double_tap|long_press|finish","' + (isShot ? 'xy":[x,y]' : 'n":节点号') + ',"text":输入文本,"dir":"up|down|left|right","name":按键名,"to":[x,y],"ms":毫秒,"pkg":包名,"ok":布尔,"summary":"进度一句话"}',
        // 拟人化：机械地一路狂划、每步都点同一个位置，是最像机器人的用法，平台的风控就看这些
        '像真人一样用它：别机械地重复同一个动作。划一屏停下来看看内容，感兴趣的点进去看两眼再退回来；连续划了三四次就停一下。这不是任务考核，没有规定动作。',
        // 输入框专项：笔记/备忘录/搜索框这类编辑区的 text 常是空的，模型容易反复 tap 它
        '清单里标成「输入框」的节点：直接给 input 动作、把要写的字放在 text 里，不用先 tap 它。同一个地方点了两次界面还没变，说明点错了或没聚焦，换成 input / scroll / back，别在原地连续点。',
        // 假输入框（DeepSeek 那种 TextView 占位）：必须"点一下、马上打字"，中间不许插别的动作
        '标着「点一下才能打字」的节点（比如 DeepSeek 底部的「发消息或按住说话」）：**tap 它之后，下一个动作立刻就是 input**，中间不要点别的地方、也不要再 tap 它一次。点第二次会把焦点弄丢，字就打不进去了。',
        '如果你的目的是「打字/提问/搜索」，而清单里有「输入框」或「点一下才能打字」的节点：优先直接给 input（系统会自动帮你点准输入框）。只有 input 之后系统说「没写进去」时，才改成先 tap 再 input。',
        // 发送这条坑得很实在：聊天/提问类输入框都是多行的，回车只换行不发送
        '打完字要发送时：**别用 key enter**。聊天类输入框（DeepSeek、评论、私信）按回车只会插入一个换行，消息根本发不出去，还会堆出一堆空行。去找带「发送」「发布」「搜索」文字的按钮，tap 它。',
        // 发完别重发、要往下读
        '发出消息之后输入框会清空、变回占位文字，**这是正常现象，不是没发出去**。判断依据看内容区：你发的话应该已经出现在对话里。这时候要做的是**往下翻读回答**（scroll dir="up"，多翻几屏），**不要重新打一遍同样的问题**。',
        '读完长回答：一屏只显示开头，回答往往要翻 3~5 屏才见底。滑到底部的信号是内容不再变化、或者出现输入框/相关推荐。',
        // launch 这条也踩过：monkey 只是把启动意图丢过去就返回，界面还没起来
        'launch 之后要等它起来（系统已经帮你等了 1.8 秒）。如果下一步前台还不是那个应用，说明它没启动成功——这时候别连着再 launch 同一个包，换 back 回桌面重试一次，还不行就换别的应用。',
        '界面里能读到的文字都给你了（【页面文字】那一段）。回答、正文、标题这类内容不在节点清单里，但你能读到它们——所以要判断「有没有结果」看那一段，不要只看按钮。',
        // 头一次打开 App 的隐私政策页：不点它永远进不去，会被误判成"打不开"
        '第一次打开一个 App 常常先出现「隐私政策 / 用户协议 / 欢迎页」，底部有「同意」或「同意并继续」：**直接点它就能进去**，这不是系统设置，属于正常流程。一屏没有按钮就横滑看下一屏，或者找「跳过」。',
        // 反复被去重逻辑掐掉的教训：模型连着划屏、连着返回都会被判成卡住
        '连着划几屏、连着按几次返回都是正常的，不算卡住——只要界面内容在变就继续做。真正该停的信号是「同一个地方点了几次、界面一个字都没变」。',
        // 禁区别去
        '被禁掉的应用别去打开（小红书、设置、淘宝）。不小心打开会被系统拦下来并浪费一步，直接换别的应用。',
        // 卡住时的求助通道：用户明确说过「不会的可以去问 DeepSeek」
        '真卡住了——连续两三个动作都没让界面变、或者这个 App 完全不知道该点哪儿——可以 launch com.deepseek.chat，把问题问具体（比如「荣耀日历怎么新建日程」「相册怎么查看原图」），看完回答后 back 回原来的应用继续。问完记得回来，别在 DeepSeek 里聊起来。',
        isShot
          ? 'tap/double_tap/long_press/clear/drag 起点的 xy 填目标在截图里的像素坐标（截图与屏幕同分辨率，原点左上）；看不清或不确定就不要猜坐标，用 finish 并在 summary 说明原因。'
          : 'tap/double_tap/long_press/clear/drag 起点用界面清单里的节点号 n（清单里没有的可交互元素也可以直接给像素坐标 xy:[x,y]，屏幕分辨率与清单同源）；input 时 text 填要输入的内容；clear 清空已聚焦输入框；drag 的 to 填终点坐标；scroll 用 dir 选 up/down/left/right；key 用 name 选 enter/tab/volume_up/volume_down/power/notifications；wait 的 ms 可选（500~10000，默认 1000）；任务做完或确认无法继续用 finish 并写 summary。',
        guide && !guideFor ? `【操作手册（本应用专属，优先照做）】\n${guide}` : (guide ? `【主流程总纲（优先照做）】\n${guide}` : ''),
        manual ? `【操作手册（当前应用，优先照做）】\n${manual}` : '',
        mem?.summary ? `历史经验（优先复用）：${mem.summary}` : '',
      ].filter(Boolean).join('\n')
    }

    for (; steps < maxSteps; steps++) {
      // 一审 #19-6：会话超时被强制释放 / 模块停用时，旧任务要真正停下来，不能和新任务同时操作手机
      if (ctx.signal?.aborted) { summary = '会话超时被强制释放，回合中止'; break }
      // ① 观察：当前前台包 + 界面节点
      let pkg = ''
      try { pkg = await adb.currentPackage() } catch { /* 读不到包名不致命 */ }
      if (pkg) visited.add(pkg)
      // 广告把人带走了：上一步只是普通点击，前台却换成了浏览器 / 应用市场 / 商城。
      // 那不是模型想去的地方（模型本来在逛内容），back 回来继续原来的活儿。
      if (pkg && AD_TARGETS.has(pkg) && ['tap', 'double_tap', 'long_press'].includes(prevKind)) {
        adJumps++
        try { await adb.pressKey('back') } catch { /* back 不掉就下一轮再说 */ }
        await sleep(700 + Math.random() * 600)
        // 上限放宽到 6：应用市场本来就是允许逛的地方，偶尔被带过去几次不算事，
        // 原来 4 次就中止，一晚上废了好几轮
        if (adJumps > 6) {
          summary = `连续 ${adJumps} 次被广告带到 ${pkg}，不再往下试，换个应用`
          break
        }
        continue
      }
      // 熄屏时前台窗口是 AOD / NotificationShade，解析不出包名：亮一次屏再继续，
      // 否则后面每一步都在黑屏上点（stayon 万一没生效也有这层兜底）
      if (!pkg) {
        blankPkgSteps++
        if (blankPkgSteps >= 3) {
          blankPkgSteps = 0
          try { await adb.pressKey(224) } catch { /* 唤醒失败就下一轮再试 */ }
          await sleep(800)
          continue
        }
      } else blankPkgSteps = 0
      let parsed
      try {
        parsed = parseNodes(await adb.dumpNodes())
      } catch {
        parsed = { list: [], brief: '', error: 'DUMP_EMPTY' }
      }
      // 「读不到包名 + 节点也 dump 不出来」还有一种可能是 **USB 掉线**（不只是息屏）。
      // 掉线时按唤醒键没用，会一路空转到步数耗尽；先确认设备在不在，不在就直接说清楚。
      if (!pkg && parsed.error) {
        offlineSteps++
        if (offlineSteps >= 2) {
          offlineSteps = 0
          let alive = false
          try {
            const list = await adb.devices()
            alive = Array.isArray(list) && list.length > 0
          } catch { alive = false }
          if (!alive) {
            summary = '手机断开连接了（USB 没插好或掉线了），这轮没法继续'
            break
          }
        }
      } else if (pkg) offlineSteps = 0
      // 日历收尾：模型点过「完成」、界面又回到了列表页（能看到右上角「新建日程」浮动按钮），
      // 说明这条日程确实存进去了。这时候直接结束，不要让模型再去"确认"——
      // 月视图里事件只是一个色块、看不见标题，模型永远确认不了，只会反复建出同名的日程。
      if (savedOnce && pkg === 'com.hihonor.calendar' && /新建日程/.test(String(parsed.brief || ''))) {
        ok = true
        summary = '日程已保存（点过右上角「完成」，已回到日历列表）。月视图里事件只显示色块，想细看就点顶部「日程」视图。'
        break
      }
      // 不要求对话区立刻渲染出来——DeepSeek 回答要几秒才出现，等它出现黄花菜都凉了，
      // 模型早就以为没发出去又打第二遍（实测就是这样问了两遍）。
      if (lastInputText) {
        const needle = lastInputText.slice(0, 8)
        const inBox = (parsed.list || []).some(
          (nd) => (nd.editable || nd.placeholder) && String(nd.text || '').includes(needle)
        )
        if (!inBox) {
          sentTexts.add(lastInputText)
          lastInputText = ''
        }
      }
      // 系统弹层抢前台：不是模型主动打开的，别按「不在白名单」整轮中止。
      // 先在这层界面上找按钮点掉（权限弹窗必须选一个），找不到就 back；连续甩不掉才放弃。
      if (pkg && DISTRACTOR[pkg]) {
        distractorHits++
        if (distractorHits > 5) {
          summary = `系统弹层 ${pkg} 反复抢前台，试了 5 次甩不掉，回合中止`
          break
        }
        const wanted = DISTRACTOR[pkg].buttons || []
        let hitIdx = -1
        for (let i = 0; i < parsed.list.length; i++) {
          const t = [parsed.list[i].text, parsed.list[i].desc].filter(Boolean).join(' ')
          if (t && wanted.some((w) => t.includes(w))) { hitIdx = i; break }
        }
        const c = hitIdx >= 0 ? nodeCenter(parsed.list, hitIdx) : null
        try {
          if (c) await adb.tap(c[0], c[1])
          // back 前两次、之后换 home：有些系统弹层 back 关不掉、home 一按就回去了
          else if (distractorHits <= 2) await adb.pressKey('back')
          else await adb.pressKey('home')
        } catch { /* 点不掉就等下一轮重试 */ }
        await sleep(800)
        continue
      }
      distractorHits = 0
      // 包名白名单（safety 现读设置）把关；白名单为空 = 不限
      const pkgCheck = safety.checkPackage(pkg)
      if (pkg && !pkgCheck.ok) { summary = `当前前台包 ${pkg} 不在白名单：${pkgCheck.reason || '被拒'}`; break }

      // ② 决策：节点优先；当轮取不到节点就立刻截图兜底（模型看不了图才退回 back+重试计数）
      let act = null
      if (parsed.error || !parsed.list.length) {
        const fb = await decideByShot({ adb, ask, pkg, prompt, steps, maxSteps, system: buildSystem(pkg, true), visionBroken })
        if (fb.act) {
          act = fb.act
        } else {
          if (fb.visionBroken) visionBroken = true
          badSteps++
          if (fb.reason) lastBadReason = fb.reason // 记住最后一次真实失败原因，中止时如实汇报
          if (badSteps >= 3) { summary = lastBadReason || '连续三次取不到界面节点，回合中止'; break }
          // 一审 #19-5：取不到节点时不再替用户按 back（可能误退当前应用/挂断电话），只等界面加载后重试
          await sleep(600)
          continue
        }
      } else {
        const user = [
          `目标：${prompt}`,
          pkg ? `当前前台应用：${pkg}` : '',
          `界面节点：\n${parsed.brief}`,
          parsed.extra ? parsed.extra : '',
          steps > 0 ? `（已执行 ${steps} 步，剩余 ${maxSteps - steps} 步）` : '',
          '只回 JSON 动作。',
        ].filter(Boolean).join('\n')
        try {
          act = parseAction(await ask({ system: buildSystem(pkg, false), text: user }))
        } catch { act = null }
        // 解析失败先重试一次再算坏步：模型偶尔会插一句话、或者 JSON 少个引号，
        // 一次就记坏步太脆（实测一晚上「连续三次无法解析模型动作」中止了四五轮）
        if (!act || !act.action) {
          try {
            act = parseAction(
              await ask({
                system: buildSystem(pkg, false) + '\n上一轮你的回复不是合法 JSON。这次只回一个 JSON 对象，不要任何解释、不要代码围栏。',
                text: user,
              })
            )
          } catch { act = null }
        }
        if (!act || !act.action) {
          badSteps++
          if (badSteps >= 3) { summary = '连续三次无法解析模型动作，回合中止'; break }
          continue
        }
      }
      badSteps = 0 // 拿到合法动作，坏步清零

      // ③ 守门 + 执行 + 心跳 + 日志
      // 重复动作保护：真人确实会连着划好几屏、连着按几次返回，所以**光看动作相同不够**，
      // 还要看界面有没有变化。brief 变了就说明这一步有效，计数直接归零；
      // 只有「同一个动作 + 界面纹丝不动」才算真的卡住（实测荣耀笔记那轮连点 12 次同一处，
      // 但 scroll 被 4 次就掐掉也太严——一晚上十几轮都是这么中止的）。
      const briefNow = String(parsed.brief || '') + '|' + String(parsed.extra || '')
      const briefChanged = briefNow !== lastBrief
      lastBrief = briefNow
      const actKey = `${act.action}:${act.n ?? ''}:${act.xy ?? ''}:${act.text ?? ''}:${act.dir ?? ''}:${act.pkg ?? ''}`
      if (actKey === sameActKey && !briefChanged) {
        sameActCount++
        // 按动作类型给不同耐心：翻页/返回天生就会连着做，点按和启动连着做基本就是卡住了
        const caps = { scroll: 8, drag: 8, back: 6, wait: 8, tap: 3, double_tap: 3, long_press: 3, home: 3, launch: 3 }
        const cap = caps[String(act.action || '')] || 4
        // 到了容忍上限先别急着整轮中止——给它一次明确的纠正机会：
        // 「这个位置点了三次都没反应」通常是因为它已经在这一页、或者那根本不是按钮。
        // 直接中止等于把前面几十步全废了；警告一次让它换路，反而更容易救回来。
        if (sameActCount >= cap && sameActCount < cap + 2) {
          const tip = act.action === 'tap'
            ? `同一个位置已经点了 ${sameActCount} 次，界面一个字都没变——说明它不是按钮，或者你已经在这一页了。别再点它：用 scroll 看看有哪些内容，或者 back 退一层换个入口。`
            : `${act.action} 已经连着做了 ${sameActCount} 次，界面没有变化。换个动作试试。`
          await safety.log(act.action, tip).catch(() => {})
          sameActKey = '' // 让它下一次即使还点同一个地方，也重新计一轮
          await sleep(600)
          continue
        }
        if (sameActCount >= cap + 2) {
          summary = `连续 ${sameActCount} 次重复同一个动作（${act.action}${act.n != null && act.n !== '' ? ' 节点 ' + act.n : ''}）且界面没有变化，回合中止`
          break
        }
      } else {
        sameActKey = actKey
        sameActCount = 1
      }
      if (ctx.signal?.aborted) { summary = '会话超时被强制释放，回合中止'; break }
      await safety.checkRate() // 限速：模块内循环与动作器共用同一套滑动窗口（复审第 5 条）
      // 「同一句话反复发」拦截：发出去了输入框就清空、又变回「发消息或按住说话」的占位，
      // 模型看不到自己的问题，就以为没发出去，于是再打一遍、再发一遍……一轮能问五六遍同一件事。
      // 这里记住"已经发过的文字"，同一句话再想发就直接拦下来，并告诉模型该往下翻看回答。
      // 「同一句话反复发」拦截：**只对提问/聊天类应用生效**。
      // 这是给 DeepSeek 那种「发完输入框清空、模型以为没发出去又重发」的场景准备的。
      // 千万别全局启用——日历/笔记/搜索里「两次输入同样文字」是完全正常的
      // （实测建日程：第一次成功保存，第二次再想写「买菜」被这条拦下，任务直接卡死）。
      const ASK_APPS = ['com.deepseek.chat', 'com.tencent.mobileqq']
      const askMode = ASK_APPS.includes(String(pkg || ''))
      const wantKey = askMode && act.action === 'input' && act.text ? String(act.text).trim().slice(0, 12) : ''
      let result
      if (wantKey && sentTexts.has(wantKey)) {
        repeatedAsks++
        result = {
          done: false,
          note: `这句「${wantKey}…」**已经发出去过了**，不要再发一遍。现在往下翻看它的回答：scroll 用 dir="up"（手指由下往上划 = 内容上移 = 看下面的内容），多翻几屏，回答很长。`,
        }
        if (repeatedAsks >= 2) {
          summary = '同一句话已经发过了，还在反复重发，回合中止（应该往下翻看回答）'
          await safety.log(act.action, result.note).catch(() => {})
          break
        }
      } else if (wantKey && sentTexts.size >= 2) {
        // 已经发过两条了还想继续发：基本可以断定模型没在读回答，而是在刷问题
        summary = `这一轮已经问了 ${sentTexts.size} 个问题，还继续打新的问题，判定为在刷问题而不是读回答，回合中止`
        await safety.log(act.action, summary).catch(() => {})
        break
      } else if (
        pkg === 'com.hihonor.calendar' &&
        act.action === 'tap' &&
        /新建日程|新建事件/.test(String(nodeLabel(act, parsed.list))) &&
        savedOnce
      ) {
        // 日历专属保护：模型已经点过「完成」保存过一次，还去点「新建日程」——基本就是想"再建一条确认刚才那条在不在"。
        // 结果就是反复建出同名日程（实测连建了三条「买菜」），而且月视图只显示色块不显示标题，
        // 模型永远确认不了，于是无限循环。这里直接拦住并告诉模型去哪儿看。
        result = {
          done: false,
          note: '你已经保存过一次了，别再新建：月视图只显示一个色块、看不到标题，所以你"看不到买菜"是正常的。要确认就去点顶部「日程」视图，那里会列出事件标题。',
        }
      } else {
        // 往输入框里打字之前：如果框里已经有别的内容（比如上一句没发出去的），先 clear 清空。
        // 不清的话新文字会接在旧文字后面，发出去就是两句话粘在一起。
        const box = (parsed.list || []).find((nd) => nd.editable || nd.placeholder)
        const boxTxt = String((box && box.text) || '').trim()
        if (act.action === 'input' && boxTxt && !/发消息|按住说话|说点什么|输入|搜索/.test(boxTxt)) {
          await adb.clearText().catch(() => {})
          await sleep(250)
        }
        result = await applyAction(adb, safety, pkg, act, parsed.list)
        // 日历里点过「完成」= 这一条已经存进去了，记下来防止模型"再建一条确认一下"
        if (pkg === 'com.hihonor.calendar' && act.action === 'tap' && /完成|保存/.test(String(nodeLabel(act, parsed.list)))) {
          savedOnce = true
        }
        if (act.action === 'input' && act.text && !/没写进去/.test(result.note || '')) {
          lastInputText = String(act.text).trim().slice(0, 12)
          // 日志里带上实际输入的内容：只记「已执行 input」看不出模型到底打了什么，
          // 排查「反复问同一句话」时完全抓瞎（这次就吃了这个亏）
          result = { ...result, note: `${result.note} 内容「${String(act.text).slice(0, 30)}」` }
        }
      }
      await session.heartbeat(flowKey)
      await safety.log(act.action, result.note).catch((e) => ctx.log?.(`安全审计落盘失败：${e.message}`))
      if (result.done) {
        ok = result.confirm ? false : act.ok !== false
        summary = result.note
        break
      }
      // 拟人化停顿：别一步接一步掐着表干，真人会停下来看两眼。
      // 同一个动作连着做（比如一路往下划），停顿还会额外拉长。
      if (act.action === lastKind) sameKind++
      else { lastKind = act.action; sameKind = 1 }
      prevKind = act.action
      await sleep(pauseMs(act.action, sameKind))
    }
    if (!summary) summary = steps >= maxSteps ? `步数耗尽（${maxSteps} 步），回合中止` : '未执行任何动作'
  } catch (e) {
    ok = false
    summary = `工作区异常：${e.message}`
  } finally {
    // ⑥ 收尾：存记忆 + 放锁 + 汇报
    await memory.save(flowKey, { runLog: { steps, ok, summary }, goal: prompt }).catch((e) => ctx.log?.(`回合记忆写入失败：${e.message}`))
    try { await adb.shell(['svc', 'power', 'stayon', 'false']) } catch { /* 关不掉不影响结果 */ }
    session.release(flowKey)
    if (report) { try { report(null, `手机任务「${prompt}」${ok ? '完成' : '未完成'}：${summary}`) } catch { /* 汇报失败不影响结果 */ } }
  }
  return { ok, summary, steps, visited: [...visited] }
}
