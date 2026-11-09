// activity（看你在干嘛）回归测试
//
// 模块语义：每 5 秒采一次前台窗口，纯规则分类成 private/work/gaming/entertainment/…
// 再压成「要不要说话、用什么语气」。
// 重点锁住的约束：
//   · 分类是有优先级的回落链：进程名 > 浏览器域名 > 标题；认不出来必须是 unknown 而不是瞎猜
//   · 阈值是边界敏感的：idle 到 15 分钟才算 away，差 1 秒就还不算
//   · 状态机能升降级，但 private 和 away 不该被「刚回来」的问候窗口顶掉
//   · resolveOptions 必须夹取，用户填 1ms 或 1 天都得被拉回可用区间
// 这里只测纯逻辑：不起 PowerShell 子进程、不读真实用户目录、不联网。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

const K = await import(new URL('../lib/keywords.js', import.meta.url).href)
const S = await import(new URL('../lib/state.js', import.meta.url).href)
const SA = await import(new URL('../lib/sampler.js', import.meta.url).href)

/** 真实规则表：模块自带的那份（测试要能证明它真的能用，而不是只有测试插桩能跑） */
const RAW = JSON.parse(readFileSync(join(MOD, 'assets', 'activity-keywords.json'), 'utf8'))
const TABLES = K.buildTables(RAW)

describe('关键词表：buildTables', () => {
  test('真实规则表能编出三张非空表，并认出浏览器', () => {
    assert.ok(TABLES.stats.title > 0, '标题表不能为空')
    assert.ok(TABLES.stats.proc > 0, '进程表不能为空')
    assert.ok(TABLES.stats.domain > 0, '域名表不能为空')
    assert.ok(TABLES.browsers instanceof Set, 'browsers 要编译成 Set，判定才是 O(1)')
    assert.ok(TABLES.browsers.has('chrome.exe'), 'chrome.exe 要在浏览器集合里')
  })

  test('空规则表构建不抛，表格全空', () => {
    const empty = K.buildTables({})
    assert.equal(empty.stats.title, 0)
    assert.equal(empty.stats.proc, 0)
    assert.equal(empty.stats.domain, 0)
    assert.equal(empty.browsers.size, 0)
    // 空表也要能安全分类
    assert.equal(K.classifyTitle(empty, 'YouTube').category, 'unknown')
  })

  test('标题规则里的 tagA 会写进 subcategory（VS Code → ide）', () => {
    const r = K.classifyTitle(TABLES, 'main.js - Visual Studio Code')
    assert.equal(r.category, 'work')
    assert.equal(r.subcategory, 'ide')
    assert.equal(r.canonical, 'VS Code')
  })

  test('游戏标题带上 intensity/genre，启动器则不带', () => {
    const game = K.classifyTitle(TABLES, '原神')
    assert.equal(game.category, 'gaming')
    assert.equal(game.subcategory, 'game')
    assert.equal(game.intensity, 'casual')
    assert.equal(game.genre, 'rpg')

    // Steam 是启动器不是「在玩游戏」，状态机会因此不判 gaming
    const launcher = K.classifyTitle(TABLES, 'Steam')
    assert.equal(launcher.category, 'gaming')
    assert.equal(launcher.subcategory, 'launcher')
    assert.equal(launcher.intensity, undefined, '启动器不该有 intensity，否则会被当成真在打游戏')
  })
})

describe('分类回落链：进程 > 域名 > 标题', () => {
  test('进程名优先于标题：KeePass 配 B 站标题仍然算私人应用', () => {
    // 私人应用的判定必须压过一切，否则她会在主人开密码库时主动开口
    const r = K.classify(TABLES, { proc: 'KeePass.exe', title: 'bilibili.com - 随便看看' })
    assert.equal(r.category, 'private')
  })

  test('浏览器里按域名判：github.com 算工作', () => {
    const r = K.classify(TABLES, { proc: 'chrome.exe', title: 'github.com/login - Google Chrome' })
    assert.equal(r.category, 'work')
    assert.equal(r.subcategory, 'vcs_web')
  })

  test('浏览器里域名没命中就回落标题：YouTube 标题算看视频', () => {
    const r = K.classify(TABLES, { proc: 'chrome.exe', title: 'YouTube - Google Chrome' })
    assert.equal(r.category, 'entertainment')
    assert.equal(r.subcategory, 'video')
  })

  test('非浏览器不按域名判：记事本里写着 github.com 不算在工作', () => {
    // 否则主人在记事本里记一句网址，就会被当成在写代码
    const r = K.classify(TABLES, { proc: 'notepad.exe', title: 'github.com/login' })
    assert.equal(r.category, 'unknown')
  })

  test('全都认不出来时回落到同一个冻结的 UNKNOWN 对象', () => {
    const r = K.classify(TABLES, { proc: 'C:\\Windows\\explorer.exe', title: '一个没见过的窗口' })
    assert.equal(r, K.UNKNOWN, '回落必须是同一个对象，调用方才能用 === 判 unknown')
    assert.equal(r.category, 'unknown')
    assert.ok(Object.isFrozen(K.UNKNOWN))
    assert.equal(K.classifyTitle(TABLES, 'zzzz-没这个词'), K.UNKNOWN)
    // 空输入不能炸
    assert.equal(K.classifyTitle(TABLES, ''), K.UNKNOWN)
    assert.equal(K.classifyProc(TABLES, ''), K.UNKNOWN)
    assert.equal(K.classifyDomain(TABLES, ''), K.UNKNOWN)
  })

  test('标题是数字等脏值时不抛异常（已修：原来直接 title.toLowerCase() 会崩）', () => {
    // 采样脚本吐出来的 title 不保证是字符串；这里崩了会导致整轮 classify 失败、
    // 状态永远停在上一帧。现在统一走 String() 归一。
    assert.equal(K.classifyTitle(TABLES, 123).category, 'unknown')
    assert.equal(K.classifyDomain(TABLES, 123).category, 'unknown')
    // 进程名的路径归一（反斜杠 / 盘符 / 大小写）也要稳
    assert.equal(K.classifyProc(TABLES, 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe').category, 'communication')
    assert.equal(K.isBrowser(TABLES, 'C:/Program Files/Google/Chrome/CHROME.EXE'), true, '路径和大小写都要归一')
    assert.equal(K.isBrowser(TABLES, 'code.exe'), false)
  })
})

describe('时段与文本工具函数', () => {
  test('hourToPeriod 的边界：5 点算上午、12 点算下午、18 点算晚上、23 点回到夜里', () => {
    assert.equal(S.hourToPeriod(0), 'night')
    assert.equal(S.hourToPeriod(4), 'night')
    assert.equal(S.hourToPeriod(5), 'morning')
    assert.equal(S.hourToPeriod(11), 'morning')
    assert.equal(S.hourToPeriod(12), 'afternoon')
    assert.equal(S.hourToPeriod(17), 'afternoon')
    assert.equal(S.hourToPeriod(18), 'evening')
    assert.equal(S.hourToPeriod(22), 'evening')
    assert.equal(S.hourToPeriod(23), 'night')
  })

  test('stripEmotionTags 去掉尖括号标签但保留正文', () => {
    assert.equal(S.stripEmotionTags('<emotion>开心</emotion>好呀'), '开心好呀')
    assert.equal(S.stripEmotionTags('没有标签'), '没有标签')
    // 空值不能炸，否则每次拼上下文都要判空
    assert.equal(S.stripEmotionTags(''), '')
    assert.equal(S.stripEmotionTags(null), '')
    assert.equal(S.stripEmotionTags(undefined), '')
  })

  test('textHasOpenQuestion：问号和中文疑问尾字都要认出来', () => {
    assert.equal(S.textHasOpenQuestion('你要不要也来一口？'), true)
    assert.equal(S.textHasOpenQuestion('要不要来一口?'), true)
    assert.equal(S.textHasOpenQuestion('<emotion>好奇</emotion>你在干嘛呢'), true, '标签要先去干净再判')
    assert.equal(S.textHasOpenQuestion('那就这样吧'), true, '「吧」结尾在口语里也是等他回话')
    assert.equal(S.textHasOpenQuestion('我先睡了'), false)
    assert.equal(S.textHasOpenQuestion(''), false)
    assert.equal(S.textHasOpenQuestion(null), false)
  })
})

describe('倾向 / 语气 / 跳过概率', () => {
  test('derivePropensity：private 硬锁 closed，游戏休闲才放开', () => {
    assert.equal(S.derivePropensity('private'), 'closed')
    assert.equal(S.derivePropensity('focused_work'), 'restricted_screen_only')
    assert.equal(S.derivePropensity('gaming', { intensity: 'immersive' }), 'restricted_screen_only')
    // 休闲游戏跟看视频一样可以聊
    assert.equal(S.derivePropensity('gaming', { intensity: 'casual' }), 'open')
    // 未知状态兜底成 open，不能变成不说话的 closed
    assert.equal(S.derivePropensity('莫名其妙的状态'), 'open')
  })

  test('deriveTone：恐怖游戏屏息、竞技沉默、随便逛耍贫', () => {
    assert.equal(S.deriveTone('gaming', { intensity: 'competitive' }), 'terse')
    assert.equal(S.deriveTone('gaming', { intensity: 'immersive', genre: 'horror' }), 'hushed')
    assert.equal(S.deriveTone('gaming', { intensity: 'immersive', genre: 'rpg' }), 'mellow')
    assert.equal(S.deriveTone('gaming', { intensity: 'casual' }), 'playful')
    assert.equal(S.deriveTone('private'), 'concise', '私人应用下话越少越好')
    assert.equal(S.deriveTone('casual_browsing'), 'witty')
    assert.equal(S.deriveTone('chatting'), 'warm')
    assert.equal(S.deriveTone('idle'), 'playful')
  })

  test('deriveSkipProbability：只有沉浸式恐怖游戏该主动闭嘴', () => {
    assert.ok(Math.abs(S.deriveSkipProbability('gaming', { intensity: 'immersive', genre: 'horror' }) - 0.3) < 1e-9)
    assert.equal(S.deriveSkipProbability('gaming', { intensity: 'casual', genre: 'rpg' }), 0)
    assert.equal(S.deriveSkipProbability('gaming', { intensity: 'immersive', genre: 'action' }), 0)
    // 不在游戏里一律 0 —— 别让工作状态莫名开始跳过
    assert.equal(S.deriveSkipProbability('focused_work', { intensity: 'immersive', genre: 'horror' }), 0)
    assert.equal(S.deriveSkipProbability('gaming'), 0)
  })

  test('TONE_LINES 覆盖每一个可能派出来的语气', () => {
    const tones = new Set([
      S.deriveTone('gaming', { intensity: 'competitive' }),
      S.deriveTone('gaming', { intensity: 'immersive', genre: 'horror' }),
      S.deriveTone('gaming', { intensity: 'immersive', genre: 'rpg' }),
      S.deriveTone('gaming', { intensity: 'casual' }),
      S.deriveTone('casual_browsing'),
      S.deriveTone('chatting'),
      S.deriveTone('idle'),
      S.deriveTone('private'),
    ])
    for (const tone of tones) {
      assert.equal(typeof S.TONE_LINES[tone], 'string', `语气 ${tone} 必须有对应的提示词，否则她会拿到空指令`)
      assert.ok(S.TONE_LINES[tone].length > 0)
    }
  })
})

describe('ActivityStateMachine 状态判定', () => {
  const BASE = 1_800_000_000_000

  test('idle 刚好 15 分钟算 away，差 1 秒还不算', () => {
    const away = new S.ActivityStateMachine()
    away.updateSystem({ idle: S.AWAY_IDLE_SECONDS })
    assert.equal(away.getSnapshot(BASE).state, 'away')

    const here = new S.ActivityStateMachine()
    here.updateSystem({ idle: S.AWAY_IDLE_SECONDS - 1 })
    assert.equal(here.getSnapshot(BASE).state, 'idle')
  })

  test('工作窗口要攒够 90 秒 dwell 且最近有输入才算「专心干活」', () => {
    const m = new S.ActivityStateMachine()
    m.updateWindow({ category: 'work', subcategory: 'ide', canonical: 'VS Code' }, BASE)
    m.updateSystem({ idle: 5 })

    assert.equal(m.getSnapshot(BASE).state, 'idle', '刚切过来还没攒够 dwell')
    assert.equal(m.getSnapshot(BASE + 89_000).state, 'idle', '差 1 秒不能算专注')
    assert.equal(m.getSnapshot(BASE + 90_000).state, 'focused_work')

    // 人离开了工作窗口二十分钟 → 没有最近输入，就只是挂着的工作窗口，不算专注
    const idleLong = new S.ActivityStateMachine()
    idleLong.updateWindow({ category: 'work', subcategory: 'ide', canonical: 'VS Code' }, BASE)
    idleLong.updateSystem({ idle: S.FOCUSED_WORK_RECENT_INPUT_SECONDS + 1 })
    assert.equal(idleLong.getSnapshot(BASE + 90_000).state, 'idle')
  })

  test('视频要 120 秒才算沉浸，音乐 30 秒就算随便逛', () => {
    const video = new S.ActivityStateMachine()
    video.updateWindow({ category: 'entertainment', subcategory: 'video', canonical: 'YouTube' }, BASE)
    video.updateSystem({ idle: 5 })
    assert.equal(video.getSnapshot(BASE + 119_000).state, 'casual_browsing', '119 秒还只是随便逛')
    assert.equal(video.getSnapshot(BASE + 120_000).state, 'focused_video')

    const music = new S.ActivityStateMachine()
    music.updateWindow({ category: 'entertainment', subcategory: 'music', canonical: 'Spotify' }, BASE)
    music.updateSystem({ idle: 5 })
    assert.equal(music.getSnapshot(BASE + 29_000).state, 'idle')
    assert.equal(music.getSnapshot(BASE + 30_000).state, 'casual_browsing')
  })

  test('private 优先级高于一切：人在、在玩游戏也判私人', () => {
    const m = new S.ActivityStateMachine()
    m.updateWindow({ category: 'private', canonical: 'KeePass' }, BASE)
    m.updateSystem({ idle: 1 })
    const snap = m.getSnapshot(BASE)
    assert.equal(snap.state, 'private')
    assert.equal(snap.propensity, 'closed', '私人应用必须是 closed，一个字都不能主动说')
    assert.equal(snap.window, null, '私人应用不该把窗口细节带进快照')

    // 私人应用的优先级要压过游戏
    const g = new S.ActivityStateMachine()
    g.updateWindow({ category: 'private', canonical: 'KeePass' }, BASE)
    g.updateSystem({ idle: 1 })
    assert.equal(g.getSnapshot(BASE).state, 'private')
  })

  test('away 之后回来的 60 秒是打招呼窗口，之后落回原状态', () => {
    const m = new S.ActivityStateMachine()
    m.updateSystem({ idle: S.AWAY_IDLE_SECONDS })
    assert.equal(m.getSnapshot(BASE).state, 'away')

    m.updateSystem({ idle: 1 })
    const back = m.getSnapshot(BASE + 1000)
    assert.equal(back.state, 'stale_returning')
    assert.equal(back.rawState, 'idle', 'rawState 保留真实判定，方便排查')
    assert.equal(back.propensity, 'greeting_window')
    assert.equal(back.tone, 'warm')

    const later = m.getSnapshot(BASE + 1000 + S.STALE_RECOVERY_SECONDS * 1000)
    assert.equal(later.state, 'idle', '60 秒一过就该回到原状态，不能一直挂着打招呼')
  })

  test('频繁切窗口会判成 transitioning', () => {
    const m = new S.ActivityStateMachine()
    m.updateSystem({ idle: 1 })
    for (let i = 0; i < S.WINDOW_SWITCH_TRANSITION_THRESHOLD; i++) {
      m.updateWindow({ category: 'work', subcategory: 'ide', canonical: `w${i}` }, BASE + i * 1000)
    }
    assert.equal(m.getSnapshot(BASE + 5000).state, 'transitioning')
  })

  test('没有前台窗口时 dwellSeconds 是 0（已修：原来会算出十几亿秒）', () => {
    // currentWindowStartedAt 初始值是 0，直接 (now - 0)/1000 会得到 1.8e9，
    // 快照里就写成「这个窗口待了 1800000000 秒」，提示词里非常荒唐。
    const m = new S.ActivityStateMachine()
    m.updateSystem({ idle: 3 })
    const snap = m.getSnapshot(BASE)
    assert.equal(snap.dwellSeconds, 0)
    assert.equal(snap.window, null)
  })

  test('own_app（自己）只冻结 dwell，不覆盖上一个真实窗口', () => {
    // 她自己的窗口弹到前台时，不能把「主人刚才在写代码」抹掉，
    // 但也不能让代码窗口白白继续攒专注时长。
    const m = new S.ActivityStateMachine()
    m.updateWindow({ category: 'work', subcategory: 'ide', canonical: 'VS Code' }, BASE)
    m.updateSystem({ idle: 0 })
    assert.equal(m.getSnapshot(BASE + 50_000).dwellSeconds, 50)

    m.updateWindow({ category: 'own_app', canonical: 'DeepSeek Harness' }, BASE + 50_000)
    assert.equal(m.currentWindow.canonical, 'VS Code', 'own_app 不该顶掉真实窗口')
    assert.equal(m.getSnapshot(BASE + 50_000).dwellSeconds, 0, 'dwell 要重新起算')
  })

  test('挂着的追问：5 分钟内有效，追问一次之后作废', () => {
    const m = new S.ActivityStateMachine()
    m.updateSystem({ idle: 1 })
    m.updateAiMessage('你要不要也来一口？', BASE)
    const open = m.getSnapshot(BASE + 1000).unfinishedThread
    assert.ok(open, '结尾是问句就该开一个追问窗口')
    assert.equal(open.followUps, 0)

    // 主人回话了 → 追问窗口立刻关掉
    m.updateUserMessage(BASE + 2000)
    assert.equal(m.getSnapshot(BASE + 3000).unfinishedThread, null)

    // 追问次数用满一次就作废，避免她追着问
    const once = new S.ActivityStateMachine()
    once.updateSystem({ idle: 1 })
    once.updateAiMessage('吃了吗？', BASE)
    once.markUnfinishedThreadUsed()
    assert.equal(once.getSnapshot(BASE + 1000).unfinishedThread, null)

    // 超过 5 分钟同样作废
    const expired = new S.ActivityStateMachine()
    expired.updateSystem({ idle: 1 })
    expired.updateAiMessage('吃了吗？', BASE)
    assert.equal(expired.getSnapshot(BASE + S.UNFINISHED_THREAD_WINDOW_SECONDS * 1000 + 1000).unfinishedThread, null)

    // 结尾不是问句就不开窗口
    const notQuestion = new S.ActivityStateMachine()
    notQuestion.updateSystem({ idle: 1 })
    notQuestion.updateAiMessage('我先去睡了', BASE)
    assert.equal(notQuestion.getSnapshot(BASE).unfinishedThread, null)
  })

  test('renderSnapshotLine：没快照给空串，有快照要把倾向和语气都带上', () => {
    assert.equal(S.renderSnapshotLine(null), '')
    assert.equal(S.renderSnapshotLine(undefined), '')

    const m = new S.ActivityStateMachine()
    m.updateSystem({ idle: S.AWAY_IDLE_SECONDS })
    const line = S.renderSnapshotLine(m.getSnapshot(BASE))
    assert.ok(line.includes('人不在电脑前'), `要说清状态，实际：${line}`)
    assert.ok(line.includes('15 分钟没动鼠标'), `要带上离开多久，实际：${line}`)
    // away 的倾向是 open（人不在电脑前正是能喊他一句的时候），提示词要跟着拼进去
    assert.ok(line.includes('可以主动找主人说话'), `propensity 的指令必须拼进去，实际：${line}`)
    // 语气没列进分支的状态统一落到 concise
    assert.ok(line.includes(S.TONE_LINES.concise), '语气提示也要拼进去')
  })
})

describe('sampler：纯函数部分', () => {
  test('resolveOptions 夹取采样间隔：太小拉到 1 秒，太大多到 2 分钟', () => {
    assert.equal(SA.resolveOptions({ intervalMs: 1 }).intervalMs, 1000)
    assert.equal(SA.resolveOptions({ intervalMs: 999_999 }).intervalMs, 120_000)
    assert.equal(SA.resolveOptions({ intervalMs: 7000 }).intervalMs, 7000)
    // 非数字要回落到默认值，不能让 NaN 流进 spawn 参数
    assert.equal(SA.resolveOptions({ intervalMs: 'abc' }).intervalMs, SA.DEFAULTS.intervalMs)
    assert.equal(SA.resolveOptions({ intervalMs: null }).intervalMs, SA.DEFAULTS.intervalMs)
  })

  test('resolveOptions 保留默认值并允许覆盖其它字段', () => {
    const def = SA.resolveOptions()
    assert.deepEqual(def, SA.DEFAULTS, '不传参就该完全是默认值')
    assert.equal(def.cpu, false)
    assert.equal(def.maxLogBytes, 24 * 1024 * 1024)

    const custom = SA.resolveOptions({ dataDir: 'H:/tmp/x', cpu: true })
    assert.equal(custom.dataDir, 'H:/tmp/x')
    assert.equal(custom.cpu, true)
    assert.equal(custom.intervalMs, SA.DEFAULTS.intervalMs, '没覆盖的字段要保持默认')
  })

  test('describeSamplerError 把常见错误码翻成人话', () => {
    const enoent = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
    assert.equal(SA.describeSamplerError(enoent), '找不到 powershell.exe')
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    assert.ok(SA.describeSamplerError(eperm).includes('权限被拒'))
    // 别的错就回落到 message，并截断，别把一整个堆栈塞进日志
    assert.equal(SA.describeSamplerError(new Error('x'.repeat(1000))).length, 400)
    assert.equal(SA.describeSamplerError(null), 'unknown')
    assert.equal(SA.describeSamplerError(undefined), 'unknown')
  })

  test('formatSample 截断标题，idle 缺失时写 ? 而不是 undefined（已修）', () => {
    const line = SA.formatSample({ proc: 'Code.exe', title: 'y'.repeat(100), idle: 12 })
    assert.equal(line, `Code.exe｜${'y'.repeat(40)}｜idle=12s`)

    // idle 缺失/非数字时原来会输出 `idle=undefineds`，日志里会误导排查
    assert.ok(!SA.formatSample({ proc: 'a.exe' }).includes('undefined'))
    assert.equal(SA.formatSample({ proc: 'a.exe' }), 'a.exe｜(无标题)｜idle=?')
    assert.equal(SA.formatSample({}), '?｜(无标题)｜idle=?')
    assert.equal(SA.formatSample(null), '')
  })
})
