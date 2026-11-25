// 摸鱼人日历。模块接口见宿主 API.md；不修改插件代码。
// 入口只放设置、定时和发送。搜狗、RSS、文章和图片在 lib/。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { downloadImage, pruneCache, readCache, writeCache } from './lib/image.mjs'
import { decideTick, initialState, matchBareCommand, parseCommandAliases, parseTargets, splitLegacyTargets } from './lib/schedule.mjs'
import { resolveCalendar } from './lib/source.mjs'
import { beijing } from './lib/time.mjs'

const DESCRIPTION = '每天从公众号「摸鱼人日历」取当日日历图，定时发到指定 QQ 聊天。'

function defaultBrowser(api) {
  try {
    const browser = api.use?.('browser-ops')
    if (!browser || typeof browser.launch !== 'function') return null
    return browser
  } catch (error) {
    api.log?.warn?.('逛网页模块不可用', error.message)
    return null
  }
}

export function createModule({ fetchImpl, now = () => Date.now(), browserOf, sleep } = {}) {
  // 生产路径走全局 fetch；测试传入 fetchImpl，避免打到真网络。
  const netFetch = fetchImpl || ((...args) => fetch(...args))
  return {
    id: 'moyu-calendar',
    name: '摸鱼人日历',
    version: '1.0.6',
    api: 1,
    description: DESCRIPTION,
    defaults: {
      daily: true,
      time: '08:00',
      deadline: '12:00',
      privateChats: '',
      groupChats: '',
      rssUrl: '',
      caption: '来源：公众号 摸鱼人日历',
      commands: '摸鱼日历\n摸鱼\n摸鱼人日历',
    },
    settings: [
      { key: 'daily', label: '每天自动发送', type: 'switch' },
      { key: 'time', label: '开始时间（北京时间）', type: 'text', hint: '24小时制 HH:mm，默认 08:00。到点后开始找今天的日历。首次安装如果已经过了这个时间，从明天开始。' },
      { key: 'deadline', label: '截止时间（北京时间）', type: 'text', hint: '默认 12:00，要晚于开始时间。到点仍没有今天的文章就记为今日无更新，不再重试。已经下到的图还会补发给没收到的聊天。' },
      { key: 'privateChats', label: '私聊接收', type: 'textarea', hint: '一行一个 QQ 号，不用写 private:。留空发给主人。手动命令仍回复当前聊天。' },
      { key: 'groupChats', label: '群聊接收', type: 'textarea', hint: '一行一个群号，不用写 group:。留空则不发到群。' },
      { key: 'rssUrl', label: 'RSS 地址（可选）', type: 'text', hint: '自建 we-mp-rss / wechat2rss 订阅「摸鱼人日历」的地址。填了就优先用，失败再走搜狗和逛网页。' },
      { key: 'caption', label: '图片附言', type: 'text', hint: '跟在图片后面。留空则只发图。默认注明来源。' },
      { key: 'commands', label: '发送指令', type: 'textarea', hint: '一行一个。直接发「摸鱼人日历」或 /摸鱼人日历 都会发图。最多 20 个。/moyu 一直可用；后面加「状态」只看任务、不发图。' },
    ],
    async setup(api) {
      const clock = () => beijing(new Date(now()))
      const dir = api.dataDir()
      const stateFile = api.dataDir('daily-state.json')
      const controller = new AbortController()
      let state = {}
      let busy = false
      let stopped = false
      let lastError = ''

      const persist = async () => {
        await mkdir(dir, { recursive: true })
        await writeFile(stateFile, JSON.stringify(state, null, 2))
      }
      try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('任务记录格式不对')
        state = parsed
      } catch (error) {
        if (error.code === 'ENOENT') {
          state = initialState(clock(), api.settings())
          try { await persist() } catch (writeError) { api.log.warn('写任务记录失败', writeError.message) }
        } else {
          // 读坏了就按空记录继续，不把损坏内容再写回去；下一次成功任务会写成新记录。
          state = {}
          api.log.warn('无法读取摸鱼日历任务记录，先按空记录继续', error.message)
        }
      }
      const legacyTargets = String(api.settings().targets || '').trim()
      if (legacyTargets) {
        const split = splitLegacyTargets(legacyTargets)
        if (!split.privateChats && !split.groupChats) api.log.warn('原来的接收聊天没有可用号码，已忽略')
        else api.log.info('已把原来的接收聊天拆成私聊和群号')
        try { await api.saveSettings({ ...split, targets: '' }) } catch (error) {
          api.log.warn('拆分接收聊天失败', error.message)
        }
      }

      function status() {
        const settings = api.settings()
        const stamp = clock()
        return {
          busy,
          lastError,
          daily: settings.daily !== false,
          time: settings.time,
          deadline: settings.deadline,
          rss: Boolean(String(settings.rssUrl || '').trim()),
          source: state.source || '',
          title: state.title || '',
          today: state.noUpdate === stamp.date ? 'none' : state.completed === stamp.date ? 'sent' : 'pending',
          state: {
            date: state.date || '',
            attempts: state.attempts || 0,
            sent: state.sent || [],
            completed: state.completed || '',
            noUpdate: state.noUpdate || '',
            firstSkip: state.firstSkip || '',
          },
        }
      }
      function statusText() {
        const info = status()
        const progress = info.today === 'sent' ? '已发送' : info.today === 'none' ? '无更新' : '未完成'
        // 状态会回到当前聊天，不能把配置里的 QQ 号或群号带出去。
        const shownError = String(info.lastError || '无').replace(/(private|group):\d+/g, '接收聊天')
        return [
          `自动发送：${info.daily ? '开启' : '关闭'}，北京时间 ${info.time} 至 ${info.deadline}`,
          `来源：${info.rss ? 'RSS 优先，失败再用搜狗' : '搜狗 + 逛网页'}`,
          `任务：${info.busy ? '获取中' : '空闲'}`,
          `今天：${progress}`,
          `上次完成：${info.state.completed || '暂无'}`,
          `最近错误：${shownError}`,
        ].join('\n')
      }

      async function deliver(chatId, card) {
        const image = card.bytes.toString('base64')
        // 宿主发送失败或总开关关掉时返回 null，不抛错。没判断的话会被记成已发送，当天不再补发。
        const sent = await api.sendSegments(chatId, [{ type: 'image', data: { file: `base64://${image}` } }], '摸鱼人日历')
        if (!sent) throw new Error('日历图没有发出去，稍后重试')
        if (sent.queued === true) {
          api.log.info('摸鱼日历图片已排队，连上后再补发', chatId)
          return
        }
        const caption = String(api.settings().caption ?? '').trim().slice(0, 200)
        if (!caption) return
        try {
          const text = await api.sendText(chatId, caption)
          if (!text) api.log.warn('摸鱼日历附言没有发出去', chatId)
        } catch (error) {
          api.log.warn('摸鱼日历附言发送失败', chatId, error.message)
        }
      }
      async function loadCard(stamp) {
        const cached = await readCache(dir, stamp.date)
        if (cached) return { ...cached, title: state.title || '', source: state.source || 'cache' }
        const resolved = await resolveCalendar({
          stamp,
          rssUrl: api.settings().rssUrl,
          fetchImpl: netFetch,
          getBrowser: () => (browserOf || defaultBrowser)(api),
          signal: controller.signal,
          sleep,
        })
        if (!resolved.ok) {
          const error = new Error(resolved.error || '没找到今天的摸鱼人日历')
          error.missing = Boolean(resolved.missing)
          throw error
        }
        const downloaded = await downloadImage(resolved.imageUrl, { fetchImpl: netFetch, signal: controller.signal })
        if (!downloaded.ok) throw new Error(downloaded.error)
        const saved = await writeCache(dir, stamp.date, downloaded.bytes, downloaded.mime)
        await pruneCache(dir, 14, now()).catch(error => api.log.warn('清理旧日历图失败', error.message))
        state = { ...state, title: resolved.title || '', source: resolved.source || '' }
        await persist()
        return { ...saved, title: state.title, source: state.source }
      }
      async function exclusive(fn) {
        if (busy) throw new Error('摸鱼日历正在获取中，请稍后再试')
        busy = true
        try { return await fn() } catch (error) {
          lastError = error.message || String(error)
          throw error
        } finally { busy = false }
      }

      async function command(arg, msg) {
        if (stopped) return '摸鱼日历模块已停止'
        if (/^(状态|status)$/i.test(String(arg || '').trim())) return statusText()
        if (!msg?.chatId) return '没有当前聊天，发不出去'
        if (busy) return '摸鱼日历正在获取中，请稍后再试'
        try {
          await exclusive(async () => {
            const card = await loadCard(clock())
            await deliver(msg.chatId, card)
            lastError = ''
          })
          // 图已经发到当前聊天。空字符串宿主不会再跟一条文字。
          return ''
        } catch (error) {
          return `摸鱼日历没取到：${error.message}`
        }
      }

      async function tick() {
        if (stopped) return
        const settings = api.settings()
        const cfg = api.config()
        const stamp = clock()
        let hasImage = false
        try { hasImage = Boolean(await readCache(dir, stamp.date)) } catch (error) {
          lastError = `读缓存失败：${error.message}`
          api.log.warn('读摸鱼日历缓存失败', error.message)
          return
        }
        const decision = decideTick({
          stamp,
          settings,
          state,
          enabled: Boolean(cfg.enabled),
          dryRun: Boolean(cfg.dryRun),
          busy,
          nowMs: now(),
          hasImage,
        })
        if (decision.action === 'error') {
          lastError = decision.reason
          return
        }
        if (decision.action === 'skip') return
        if (decision.action === 'giveup') {
          state = { ...state, date: stamp.date, noUpdate: stamp.date }
          if (!lastError) lastError = '到截止时间还没有今天的摸鱼人日历'
          await persist().catch(error => api.log.warn('写任务记录失败', error.message))
          api.log.info('摸鱼日历今天停止重试', lastError)
          return
        }
        let chats = []
        try { chats = parseTargets(settings.privateChats, settings.groupChats, cfg.ownerQQ) } catch (error) {
          lastError = error.message
          api.log.warn('摸鱼日历接收聊天配置不对', error.message)
          return
        }
        try {
          await exclusive(async () => {
            const sameDay = state.date === stamp.date
            state = {
              ...state,
              date: stamp.date,
              attempts: sameDay ? (state.attempts || 0) + 1 : 1,
              lastAttempt: now(),
              sent: sameDay ? [...(state.sent || [])] : [],
            }
            await persist()
            let card
            try { card = await loadCard(stamp) } catch (error) {
              if (error.missing && stamp.time >= settings.deadline) {
                state.noUpdate = stamp.date
                await persist()
                error.settled = true
              }
              throw error
            }
            const remaining = chats.filter(chat => !(state.sent || []).includes(chat))
            const failures = []
            for (const chat of remaining) {
              const live = api.config()
              if (stopped || live.dryRun || api.settings().daily === false || !live.enabled) {
                throw new Error('自动发送已暂停，本次不记为已发送')
              }
              try {
                await deliver(chat, card)
                state.sent = [...(state.sent || []), chat]
                await persist()
              } catch (error) {
                failures.push(`${chat}：${error.message}`)
                api.log.warn('摸鱼日历发送失败', chat, error.message)
              }
            }
            if (failures.length) throw new Error(failures.join('；'))
            state.completed = stamp.date
            lastError = ''
            await persist()
            api.log.info('今天的摸鱼人日历已发送', card.source || 'cache')
          })
        } catch (error) {
          if (error.settled) api.log.info('摸鱼日历今天没有更新', error.message)
          else api.log.warn('摸鱼日历稍后重试', error.message)
        }
      }

      // 宿主注册时会拷走这个数组的引用，之后改设置，下一条命令就能读到新触发词。
      const aliases = new Proxy([], {
        get(_target, prop) {
          const live = parseCommandAliases(api.settings().commands)
          if (prop === Symbol.iterator) return live[Symbol.iterator].bind(live)
          if (prop === 'length') return live.length
          if (typeof prop === 'string' && /^(?:0|[1-9]\d*)$/.test(prop)) return live[Number(prop)]
          const value = live[prop]
          return typeof value === 'function' ? value.bind(live) : value
        },
      })
      api.command({
        name: 'moyu',
        aliases,
        desc: '发送今天的摸鱼人日历。触发词在设置里改，带不带斜杠都行；/moyu 状态 查看定时任务',
        run: command,
      })
      // 不带斜杠的整句触发词。斜杠形式仍走上面的命令，这里跳过，避免发两次。
      api.on('message', async (msg) => {
        if (stopped || !api.isOwner?.(msg.userId)) return false
        const hit = matchBareCommand(msg.text, parseCommandAliases(api.settings().commands))
        if (!hit) return false
        const reply = await command(hit.arg, msg)
        if (reply) {
          try { await api.sendText(msg.chatId, reply) } catch (error) {
            api.log.warn('摸鱼日历回复失败', error.message)
          }
        }
        return true
      })
      api.route('/status', () => ({ ok: true, ...status() }))
      api.every(60000, () => { tick().catch(error => api.log.warn('摸鱼日历定时任务出错', error.message)) }, '摸鱼人日历')
      api.onDispose(() => { stopped = true; controller.abort() })
      return { status, tick }
    },
  }
}

export default createModule()
