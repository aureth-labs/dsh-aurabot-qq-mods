// 摸鱼人日历。模块接口见宿主 API.md；不修改插件代码。
// 入口只放设置、定时、面板接口和发送。合集、搜狗、RSS、文章和图片在 lib/。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { downloadImage, pruneCache, readCache, removeCache, writeCache } from './lib/image.mjs'
import { clearedState, decideTick, initialState, matchBareCommand, parseCommandAliases, parseTargets, splitLegacyTargets } from './lib/schedule.mjs'
import { resolveCalendar, sourceLabel, traceText } from './lib/source.mjs'
import { beijing } from './lib/time.mjs'

const DESCRIPTION = '每天从公众号「摸鱼人日历」取当日日历图，定时发到指定 QQ 聊天。'

/** 写接口只给面板用：不接受 GET；跨站请求、Origin 和 Host 对不上的都拒绝。 */
export function sameOriginRequest(req) {
  const method = String(req?.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return false
  const site = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
  const origin = String(req?.headers?.origin || '').trim()
  if (!origin) return true
  try { return new URL(origin).host === String(req?.headers?.host || '') } catch { return false }
}

export async function readJsonBody(req, maxBytes = 4096) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > maxBytes) throw new Error('请求体太大')
  }
  return raw ? JSON.parse(raw) : {}
}

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
    version: '1.0.9',
    api: 1,
    description: DESCRIPTION,
    // 面板多一块：看今天从哪取的图，清除已获取的图让模块重新取。
    panel: 'panel.js',
    defaults: {
      daily: true,
      time: '08:00',
      deadline: '12:00',
      privateChats: '',
      groupChats: '',
      rssUrl: '',
      rssAllowPrivate: false,
      caption: '来源：公众号 摸鱼人日历',
      commands: '摸鱼日历\n摸鱼\n摸鱼人日历',
    },
    settings: [
      { key: 'daily', label: '每天自动发送', type: 'switch' },
      { key: 'time', label: '开始时间（北京时间）', type: 'text', hint: '24小时制 HH:mm，默认 08:00。到点后开始找今天的日历。首次安装如果已经过了这个时间，从明天开始。' },
      { key: 'deadline', label: '截止时间（北京时间）', type: 'text', hint: '默认 12:00，要晚于开始时间。到点仍没有今天的文章就记为今日无更新，不再重试。已经下到的图还会补发给没收到的聊天。' },
      { key: 'privateChats', label: '私聊接收', type: 'textarea', hint: '一行一个 QQ 号，不用写 private:。留空发给主人。手动命令仍回复当前聊天。' },
      { key: 'groupChats', label: '群聊接收', type: 'textarea', hint: '一行一个群号，不用写 group:。留空则不发到群。' },
      { key: 'rssUrl', label: 'RSS 地址（可选）', type: 'text', hint: '自建 wechat-mp-tools / we-mp-rss 订阅「摸鱼人日历」的地址。填了就优先用，失败再走合集、搜狗和逛网页。' },
      { key: 'rssAllowPrivate', label: '允许内网 RSS', type: 'switch', hint: '默认关。RSS 跑在本机或局域网（如 192.168.x.x、10.x.x.x、localhost）时打开，否则会被拒绝。地址仍须是 HTTP(S) 且不带账号密码。' },
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
      let lastRemoved = 0

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
          // 最近一次取到图的日期，用来区分「今天取过」和「上次取是哪天」。
          fetched: state.fetched || '',
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
          `取图顺序：${info.rss ? 'RSS → 合集 → 搜狗' : '合集 → 搜狗'}`,
          // 这是实际用了哪一路，和上面的顺序不是一回事。
          `实际来源：${info.fetched ? `${sourceLabel(info.source)}，${info.fetched}${info.title ? `《${info.title}》` : ''}` : '还没取过'}`,
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
        if (cached) {
          // source 是「这一次从哪拿的」，缓存命中就是 cache；origin 记这张图最初是哪一路取的。
          if (state.fetched !== stamp.date) {
            state = { ...state, fetched: stamp.date }
            await persist().catch(error => api.log.warn('写任务记录失败', error.message))
          }
          return { ...cached, title: state.title || '', source: 'cache', origin: state.source || '' }
        }
        const resolved = await resolveCalendar({
          stamp,
          rssUrl: api.settings().rssUrl,
          rssAllowPrivate: api.settings().rssAllowPrivate === true,
          fetchImpl: netFetch,
          getBrowser: () => (browserOf || defaultBrowser)(api),
          signal: controller.signal,
          sleep,
        })
        if (!resolved.ok) {
          const error = new Error(resolved.error || '没找到今天的摸鱼人日历')
          error.missing = Boolean(resolved.missing)
          error.trace = resolved.trace
          throw error
        }
        const downloaded = await downloadImage(resolved.imageUrl, {
          fetchImpl: netFetch,
          signal: controller.signal,
          // RSS 把图片放在自己服务器上时，只认 RSS 自己的站点。
          allowedOrigin: resolved.imageOrigin || '',
        })
        if (!downloaded.ok) throw new Error(downloaded.error)
        const saved = await writeCache(dir, stamp.date, downloaded.bytes, downloaded.mime)
        await pruneCache(dir, 14, now()).catch(error => api.log.warn('清理旧日历图失败', error.message))
        state = { ...state, title: resolved.title || '', source: resolved.source || '', fetched: stamp.date }
        await persist()
        // 每次真正去取都留一条来源，连同前面几路为什么没用上。手动命令和定时任务都从这里过。
        api.log.info('摸鱼日历取到图', `来源：${sourceLabel(resolved.source)}`, traceText(resolved.trace), resolved.title || '')
        return { ...saved, title: state.title, source: state.source, origin: state.source }
      }
      async function exclusive(fn) {
        if (busy) throw new Error('摸鱼日历正在获取中，请稍后再试')
        busy = true
        try { return await fn() } catch (error) {
          lastError = error.message || String(error)
          throw error
        } finally { busy = false }
      }

      // 面板的「清除已获取」：删掉今天缓存的图，今天的进度从头算，定时任务会重新取图并发送。
      async function clearToday() {
        const stamp = clock()
        const removed = await removeCache(dir, stamp.date)
        state = clearedState(state, stamp, removed)
        await persist()
        lastRemoved = removed
        api.log.info('已清除今天获取的摸鱼日历', `删掉 ${removed} 张缓存图`)
        return removed
      }

      async function command(arg, msg) {
        if (stopped) return '摸鱼日历模块已停止'
        if (/^(状态|status)$/i.test(String(arg || '').trim())) return statusText()
        if (!msg?.chatId) return '没有当前聊天，发不出去'
        if (busy) return '摸鱼日历正在获取中，请稍后再试'
        try {
          await exclusive(async () => {
            const card = await loadCard(clock())
            api.log.info('摸鱼日历手动取图',
              card.source === 'cache' ? `用的是缓存里的图，最初来源：${sourceLabel(card.origin)}` : `来源：${sourceLabel(card.source)}`,
              card.title || '')
            await deliver(msg.chatId, card)
            lastError = ''
          })
          // 图已经发到当前聊天。空字符串宿主不会再跟一条文字。
          return ''
        } catch (error) {
          api.log.warn('摸鱼日历手动获取没取到', error.message, traceText(error.trace))
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
            api.log.info('今天的摸鱼人日历已发送', card.source === 'cache' ? '来源：缓存' : `来源：${sourceLabel(card.source)}`, card.title || '')
          })
        } catch (error) {
          if (error.settled) api.log.info('摸鱼日历今天没有更新', error.message, traceText(error.trace))
          else api.log.warn('摸鱼日历稍后重试', error.message, traceText(error.trace))
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
      // 面板的「清除已获取」。只收同源的 POST，并且要带 confirm，别的网页借不到这个接口。
      api.route('/clear', async (req) => {
        if (!sameOriginRequest(req)) return { ok: false, message: '只允许在面板里清除' }
        const body = await readJsonBody(req).catch(() => ({}))
        if (body.confirm !== true) return { ok: false, message: '请点面板上的按钮来清除' }
        if (stopped) return { ok: false, message: '摸鱼日历模块已停止' }
        if (busy) return { ok: false, message: '正在获取中，稍后再清除' }
        try { await clearToday() } catch (error) {
          api.log.warn('清除摸鱼日历缓存失败', error.message)
          return { ok: false, message: `清除失败：${error.message}` }
        }
        return { ok: true, removed: lastRemoved, ...status() }
      })
      api.every(60000, () => { tick().catch(error => api.log.warn('摸鱼日历定时任务出错', error.message)) }, '摸鱼人日历')
      api.onDispose(() => { stopped = true; controller.abort() })
      return { status, tick }
    },
  }
}

export default createModule()
