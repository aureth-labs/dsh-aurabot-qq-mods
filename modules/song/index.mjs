// 从 Aurabot v1.1.9 的内置模块「翻唱」复制出来的，改了就替换内置的。
// 原文件：src/modules/song/index.js
const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 内置模块：翻唱。点歌 → 网易云下载 → 分离人声 → RVC 换成她的音色 → 混音 → 发语音条。
// 换声这一步可以在「本地接口」里接你自己的推理（so-vits-svc、自己训练的 RVC……）；整个模块也可以替换掉。

import { createSongStudio, checkRoot, listDrives } from './studio.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const { defineTool, str, int } = __lib('tools/tools.js')

export default {
  id: 'song',
  name: '翻唱',
  version: '1.0.1',
  api: 1,
  description: '用她的声音翻唱一首歌（音源默认 B 站优先、网易云兜底，可在面板里反过来），做好发语音条（qq_song_cover、/sing）',
  tab: 'song',
  files: ['song/studio.js'],
  setup(api) {
    const { hub, local, http } = api.core
    const mood = api.lazy('mood')
    const memory = api.lazy('memory')
    // 同一首歌半小时内不重复给心情加分：连着唱同一首时，+3 一路叠加也会把心情贴到顶
    const lastSungMoodAt = new Map()

    // 她自己的「歌单」。用户说「随便唱」时从这里挑：先看她唱过的（最近 5 首不重复），
    // 没唱过才用这个兜底池子。shift 是变调——原唱男声要升 12，女声 0。
    // 不加这张表的话，模型手里没有歌名，只能抄工具说明里的那个示例，每次都同一首。
    const SONG_POOL = [
      { query: '起风了 买辣椒也用券', shift: 0 },
      { query: '晴天 周杰伦', shift: 12 },
      { query: '小幸运 田馥甄', shift: 0 },
      { query: '我怀念的 孙燕姿', shift: 0 },
      { query: '后来 刘若英', shift: 0 },
      { query: '好久不见 陈奕迅', shift: 12 },
      { query: '红豆 王菲', shift: 0 },
      { query: '光年之外 邓紫棋', shift: 0 },
      { query: '消愁 毛不易', shift: 12 },
      { query: '平凡之路 朴树', shift: 12 },
      { query: '童话 光良', shift: 12 },
      { query: '一路向北 周杰伦', shift: 12 },
      { query: '告白气球 周杰伦', shift: 12 },
      { query: '体面 于文文', shift: 0 },
      { query: '说散就散 袁娅维', shift: 0 },
      { query: '大鱼 周深', shift: 12 },
      { query: '匆匆那年 王菲', shift: 0 },
    ]

    /** 随便唱一首：先看她唱过什么（最近 5 首不重复），没有就用池子。 */
    // 歌名归一化比对：池子里写「晴天 周杰伦」（空格），历史里记「晴天 - 周杰伦」（横线），
    // 不能直接比字符串 —— 去掉空白和连接符再看谁包含谁（历史里常带「的小迷妹」这种尾巴）。
    const songNorm = (s) => String(s).replace(/[\s\-–—·・()（）\[\]【】]/g, '')
    const sameSong = (a, b) => {
      const x = songNorm(a)
      const y = songNorm(b)
      if (!x || !y) return false
      return x === y || x.includes(y) || y.includes(x)
    }
    /** 歌单池里这首歌的变调。**没收录返回 null**，表示「交给自动变调」——
     *  以前这里返回 0，会被当成「明确要求不变调」，把历史里唱过的男声歌按 0 处理。 */
    const poolShiftOf = (q) => {
      const hit = SONG_POOL.find((x) => sameSong(x.query, q))
      return hit ? hit.shift : null
    }

    function pickSomethingToSing() {
      const sung = []
      try {
        const ev = memory.recentEvents?.(24 * 120, 80) || []
        for (const x of ev) {
          if (!Array.isArray(x.tags) || !x.tags.includes('唱歌')) continue
          const m = String(x.text || '').match(/《([^》]+)》/)
          if (m && m[1].trim()) sung.push(m[1].trim())
        }
      } catch (error) { /* 记忆模块没开就只用池子 */ }
      const recent = sung.slice(0, 5)
      const isRecent = (q) => recent.some((r) => sameSong(q, r))
      const fromHistory = [...new Set(sung.slice(5))].filter((s) => !isRecent(s)).map((s) => ({ query: s, shift: poolShiftOf(s) }))
      const pool = SONG_POOL.filter((x) => !isRecent(x.query))
      const list = fromHistory.length ? fromHistory : (pool.length ? pool : SONG_POOL)
      return list[Math.floor(Math.random() * list.length)]
    }
    const song = createSongStudio({
      local,
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: (chatId, file, note) => hub.sendVoiceFile(chatId, file, note),
      sendText: (chatId, text) => hub.sendText(chatId, text),
      onSung: (title, chatId) => {
        const cfg = api.config()
        // +8 太猛（一首歌就把几小时的衰减抹平），现在 +3，而且同一首歌 30 分钟内只加一次
        const now = Date.now()
        const prev = lastSungMoodAt.get(title) || 0
        if (now - prev > 30 * 60_000) mood.nudge?.(3, `唱完了「${title}」`)
        lastSungMoodAt.set(title, now)
        // 唱过的歌记成她的经历：私聊记到对方头上
        const uid = String(chatId).startsWith('private:') ? String(chatId).slice(8) : ''
        const who = uid === String(cfg.ownerQQ) ? cfg.ownerName || '主人' : uid ? '对方' : '群里'
        memory.addEvent?.({ text: `给${who}唱了《${title}》`, about: uid, tags: ['唱歌'], importance: 0.5 })
        api.emit('song/sung', { title, chatId })
      },
      // 唱完 / 唱不了都算这件事了结：把「承诺追踪」里“歌在准备了”判兑现，
      // 否则 3 分钟后它会再补一句“让你久等啦”，和已经发出去的语音完全脱节。
      onSettled: (chatId) => {
        try { api.lazy('promise')?.clear?.(chatId) } catch (error) {}
      },
    })

    // spark 在长会话里经常“只回一句‘给你唱’、不真的调用工具”，所以主人私聊里明确让唱时
    // 模块直接接管这条消息：回一句“正在弄”，排队翻唱；不再交给模型，避免它继续演。
    // 接管点歌时回一句。**带上歌名**：这句会经 hub.sendText 记进 chatlog 和「她说过什么」，
    // 下一轮真对话时模型才知道刚才点的是哪首；不带歌名的话，点歌内容就断在会话外面了。
    const ACKS = [
      (name) => `好，这就去弄《${name}》，做好了发你。`,
      (name) => `行，《${name}》我去准备，唱好发你。`,
      (name) => `好嘞，去唱《${name}》，你等会儿。`,
    ]
    const PICK_ACKS = [
      '好，我去挑一首最近没唱的，做好了发你。',
      '行，我去挑一首，唱好发你。',
    ]
    const pickAck = (named) => {
      if (named) return ACKS[Math.floor(Math.random() * ACKS.length)](named)
      return PICK_ACKS[Math.floor(Math.random() * PICK_ACKS.length)]
    }
    const cleanSong = (s) => String(s || '').trim()
      .replace(/[（(].*$/, '')
      .replace(/[《》]/g, '')
      .replace(/[吧呗啊呀嘛呢哦哈～~！!。]+$/g, '')
      .trim()
    function songFromText(text) {
      const t = String(text || '').trim()
      const named = t.match(/《([^》]{1,40})》/)
      if (named) return cleanSong(named[1])
      let m = t.match(/点歌\s*([^，。！？!?]{2,40})/)
      if (!m) m = t.match(/来(?:一?首|首歌|首)\s*([^，。！？!?]{2,40})/)
      if (!m) m = t.match(/唱(?:一首|一首歌|个|首|一下)?\s*([^，。！？!?]{2,40})/)
      if (!m) return ''
      let s = cleanSong(m[1])
      // 上面「唱(?:一首|一首歌|个|首|一下)?」的可选组会先吃掉「首」，于是
      // 「唱首歌怎么样」被捕获成「歌怎么样」、「唱首歌听听」成「歌听听」，当歌名去搜就全乱套
      // （2026-11-01 实际把「歌怎么样」搜成了《相爱之前》）。剥掉这个「歌」字再看剩下的：
      // 剩的是语气词就说明没点名；真是以「歌」开头的歌名（歌声与微笑）保持原样。
      if (/^歌/.test(s)) {
        const rest = cleanSong(s.slice(1))
        if (rest.length < 2 || /^(怎么样|好不好|行不行|要不要|可不可以|可以吗|好吗|行吗|听听|吧|呗|吗|嘛|啊|呀|呢)/.test(rest)) s = ''
      }
      // 捕获到的整串本身就是语气（「来一首怎么样」→「怎么样」），同样按没点名处理
      if (/^(怎么样|好不好|行不行|要不要|可不可以|可以吗|好吗|行吗)/.test(s)) s = ''
      // “唱首歌 / 唱个歌 / 来一首”这种没点名具体歌，交给歌单池
      if (!s || s.length < 2 || ['歌', '首歌', '一首', '个', '一下', '什么', '啥', '点啥', '听听', '两句', '几句', '这', '那', '这首歌', '那首歌', '什么歌', '啥歌', '一首歌'].includes(s)) return ''
      return s
    }
    // 判断是不是「点歌」消息。**收得很窄**：只有明确到相当于敲 /唱 的短命令才接管
    // （「点歌 晴天」「唱《晴天》」）；其余一切提到「唱」的话——征询（唱首歌好不好）、
    // 夸奖、聊唱歌——都交给模型自己想，它想唱自然会调 qq_song_cover 工具。
    // 生图模块就是这么做的（完全不拦消息、全靠工具），实际效果好。
    // 之前只要带「唱」或《》就接管（2026-11-02 用户反馈：一说唱就直接触发、不带思考，
    // 等于把聊天变成 /唱 硬命令），已收窄。
    function isSingRequest(text) {
      const t = String(text || '').trim()
      if (!t || t.length > 24) return false
      // 去掉句尾语气词再判断，避免「唱首歌行不行啊」躲过征询过滤
      const core = t.replace(/[吧呗啊呀嘛呢哦哈～~！!。？?]+$/g, '')
      // 征询语气是在商量，不是下令
      if (/(怎么样|好不好|行不行|要不要|可不可以|可以吗|好吗|行吗|吗|如何)$/.test(core)) return false
      // 我给你唱 / 表达喜好 / 谈论唱歌，都不是点歌
      if (/我给|我来|我唱给你|我喜欢|爱听/.test(core)) return false
      if (/唱完|在唱|不唱|别唱|唱得|唱过|唱了|好听|难听|唱功|学唱|合唱|说唱|唱歌/.test(core)) return false
      // —— 接管白名单：短命令 ——
      if (/^点歌/.test(core)) return true
      if (/^(?:你|给我|帮我|再|现在|那)?(?:唱|来)(?:一首|首|个)?\s*《[^》]{1,40}》$/.test(core)) return true
      return false
    }
    function pitchFromText(text) {
      const t = String(text || '')
      const up = t.match(/升\s*(\d+)\s*(?:个)?(?:调|半音)/)
      if (up) return Math.max(-24, Math.min(24, Number(up[1])))
      const down = t.match(/降\s*(\d+)\s*(?:个)?(?:调|半音)/)
      if (down) return -Math.max(1, Math.min(24, Number(down[1])))
      return null
    }

    api.on('message', async (msg) => {
      const cfgNow = api.config()
      if (!cfgNow.song || !cfgNow.song.enabled) return false
      if (msg.kind !== 'private' || String(msg.userId) !== String(cfgNow.ownerQQ)) return false
      const text = String(msg.text || '').trim()
      if (!isSingRequest(text)) return false
      const named = songFromText(text)
      const asked = pitchFromText(text)
      // 用户说了「升N调」就用他的；没说就查歌单池（男声歌 +12）；池子也没收录才传 null 交给自动变调
      const picked = named ? { query: named, shift: asked != null ? asked : poolShiftOf(named) } : pickSomethingToSing()
      const chatId = msg.chatId || ('private:' + String(msg.userId))
      await hub.sendText?.(chatId, pickAck(named))
      const r = song.request({ song: picked.query, pitch: picked.shift, chatId })
      if (!r.ok) await hub.sendText?.(chatId, r.message)
      return true
    })

    api.command({
      name: '唱',
      aliases: ['sing'],
      desc: '唱一首：/唱 歌名；不写歌名就随便唱',
      run: async (arg, msg) => {
        let text = String(arg || '').trim()
        // /唱 波西米亚狂想曲 @219 —— 指定从第 219 秒开始（自动找副歌会挑到歌剧段，没法听）
        let start = null
        const sm = text.match(/@\s*(\d+(?:\.\d+)?)\s*s?\s*$/i)
        if (sm) { start = Number(sm[1]); text = text.slice(0, sm.index).trim() }
        const named = text ? cleanSong(text) : ''
        const asked = pitchFromText(text)
        const picked = named ? { query: named, shift: asked != null ? asked : poolShiftOf(named) } : pickSomethingToSing()
        const r = song.request({ song: picked.query, pitch: picked.shift, chatId: msg.chatId, start })
        return r.ok ? pickAck(named) : r.message
      },
    })

    // 一次性把翻唱默认调到更自然的一档：旧配置里 indexRate 因为中文索引路径一直没生效，
    // 混音又是 2.0:0.1、F0 用 crepe。迁移完打 qualityTuned，之后面板怎么改都不会被覆盖。
    const songCfg = api.config().song || {}
    // Applio 这个版本只实现了 rmvpe / crepe / fcpe；hybrid 能填进 CLI 但 pipeline 没分支，
    // 会 UnboundLocalError。把旧配置里的 hybrid 直接改回 rmvpe。
    const F0_OK = ['rmvpe', 'crepe', 'fcpe']
    if (!F0_OK.includes(songCfg.f0Method)) {
      api.log.warn(`[翻唱] f0Method=${songCfg.f0Method} 不受支持，已改回 rmvpe`)
      api.setConfig({ song: { ...songCfg, f0Method: 'rmvpe' } })
      songCfg.f0Method = 'rmvpe'
    }
    if (songCfg.qualityTuned !== true) {
      const voices = (() => { try { return song.voices() } catch (error) { return [] } })()
      const voice = voices.includes('女声-草莓') ? '女声-草莓' : songCfg.voice
      api.setConfig({ song: { ...songCfg, voice, indexRate: 0.55, protect: 0.35, f0Method: 'rmvpe', vocalVolume: 1, instVolume: 0.8, volumeEnvelope: 0.7, qualityTuned: true } })
      api.log.info(`[翻唱] 已切到新默认：音色 ${voice || '（默认）'} / 人声 1.0 / 伴奏 0.8 / rmvpe / index 0.55 / protect 0.35 / 包络 0.7`)
    }

    // 2026-11-03 实测修正（用户反馈「12 秒、16 秒附近突然不对劲一下」）：
    // rmvpe 在《心墙》11.88~12.03s 和 16.24~16.34s 把音高判错，换声比干声低了整整 7 个半音
    // （466Hz→311Hz、415Hz→277Hz），听感就是那「一下」。同一份输入换 crepe 后这两处回到
    // 正常的 -2 半音，全曲异常帧 34→10。autotune / protect 都救不回来——音是 RVC 直接唱错的，
    // 事后拉不回来（实测 autotune 0.5/0.7、protect 0.5 结果都是 -7.0）。
    // 同时按试听结论把母带激励关掉（E 档：masterExcite=0 / masterPresence=0）。
    // 迁移只做一次，之后面板/配置怎么改都不会被覆盖。
    if (songCfg.audioTuned !== true) {
      api.setConfig({ song: { ...songCfg, f0Method: 'crepe', masterExcite: 0, masterPresence: 0, audioTuned: true } })
      api.log.info('[翻唱] 已切到 crepe 音高检测（修局部掉 7 个半音）+ 关闭母带激励（E 档）')
      Object.assign(songCfg, { f0Method: 'crepe', masterExcite: 0, masterPresence: 0, audioTuned: true })
    }

    // 2026-11-03：protect 一直是 0（最激进档）。同一份干声实测——
    //   protect=0   → 全曲异常帧 12 个，13.90s 处偏 5.7 半音
    //   protect=0.35 → 异常帧 7 个，13.90s 处偏 4.1
    // 面板提示本身也写着「调大不容易撕裂和出电流音，调小更贴音色」。
    // 0 会让清辅音/气声裸露在模型下，是杂音和撕裂的主要来源，调到 0.35 更稳。
    if (songCfg.protectTuned !== true) {
      api.setConfig({ song: { ...songCfg, protect: 0.35, protectTuned: true } })
      api.log.info('[翻唱] 保护齿音 0 → 0.35（实测异常帧 12→7）')
      Object.assign(songCfg, { protect: 0.35, protectTuned: true })
    }

    // 面板新增了「自动变调 / 母带处理 / 激励强度 / 临场高架」四个开关。
    // 开关控件对 undefined 会显示成「关」，而代码里 master 是 `!== false` 才算开，
    // 两边语义不一致会让人以为母带被关了。这里把值显式落盘一次，之后面板改什么就是什么。
    if (songCfg.panelTuned !== true) {
      api.setConfig({
        song: {
          ...songCfg,
          master: songCfg.master !== false,
          autoPitch: songCfg.autoPitch !== false,
          masterExcite: Number.isFinite(Number(songCfg.masterExcite)) ? Number(songCfg.masterExcite) : 0,
          masterPresence: Number.isFinite(Number(songCfg.masterPresence)) ? Number(songCfg.masterPresence) : 0,
          panelTuned: true,
        },
      })
      api.log.info('[翻唱] 面板开关值已显式落盘（master/autoPitch/masterExcite/masterPresence）')
    }

    // 2026-11-03：用户明确要「清唱」。之前伴奏音量停在 0.1 不是选择，是滑块下限只能到 0.1。
    // 光放开滑块没用：配置归一化 src/core/config.js 的 num() 下限也夹在 0.1（已一起放开）。
    // 但那个文件是启动时加载的，热重载时内存里还是旧逻辑 —— 写 0 会被 saveConfig 夹回 0.1。
    // ★ setConfig 之后立刻读 api.config() 不可信（读回 0、落盘 0.1，夹值在 saveConfig 里做），
    //   所以这里等两秒直接读配置文件，只认磁盘。没落成就不写完成标记，重启后再试一次。
    if (songCfg.cleanVocalAt !== 3) {
      api.setConfig({ song: { ...songCfg, instVolume: 0 } })
      api.later(2000, () => {
        let disk = null
        try {
          disk = JSON.parse(readFileSync(resolve(api.dataDir(), '..', '..', 'config.json'), 'utf8'))
        } catch (error) { disk = null }
        const v = Number(disk && disk.song && disk.song.instVolume)
        if (v === 0) {
          api.setConfig({ song: { ...api.config().song, cleanVocal: true, cleanVocalAt: 3 } })
          api.log.info('[翻唱] 伴奏音量 → 0（清唱），已确认落盘')
        } else {
          api.log.warn(`[翻唱] 清唱没落盘（磁盘上 instVolume=${Number.isFinite(v) ? v : '?'}）：config.js 的新下限要重启 DSH 才生效，重启后会再试`)
        }
      })
    }

    // 面板里打开了才给她（没开就别让她答应唱歌）
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && chat.kind !== 'system' ? defineTool({
      name: 'qq_song_cover',
      slow: '好，我这就去弄，稍等一会儿（做好了发你）。',
      description: '用你自己的声音翻唱一首歌，做好后自动以语音条发到当前聊天（要两三分钟）。**只要对方让你唱，就必须调用这个工具**——系统会自己发「正在弄」的提示，所以不要只说一句「等一下」「也给你唱」来代替调用；只说回话不算唱。**调用之后不要再回复「歌已经在准备 / 稍等 / 马上就好」这类承诺**：提示由系统发，承诺会被「承诺追踪」记账、隔几分钟再补一句，跟已经发出去的语音脱节；要说话就一句短的，比如「好」。song **只在用户点名了某首歌时才填**（写歌名，最好带上歌手）；用户说「随便唱 / 你挑一首 / 唱首你喜欢的 / 唱首歌」时不要填 song、也不要自己编一个歌名顶上去 —— 留空就行，会从她唱过的和常听的里挑一首最近没唱过的。pitch 是变调半音：你是女声，原唱是男声时一般 +12，原唱是女声时 0；不确定就别填，挑中那首会自己定。',
      properties: { song: str('歌名（可以带歌手）；用户没点名哪首就别填'), pitch: int('变调半音：原唱男声 +12，女声 0；不确定就别填'), start: int('从第几秒开始唱（可选）。用户说「从 3 分 39 秒开始」就填 219；不填会自动找副歌') },
      execute: async ({ song: name, pitch, start }) => {
        if (api.config().song.ownerOnly && !hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能点歌' }
        const named = String(name || '').trim()
        // 用户点名了：听他的（连同他给的变调）。
        // 没点名：一律用自己挑那首的变调，不看模型给的 pitch —— 它并不知道原唱是男是女，
        // 一路传 0 的话，抽到男歌手的歌会明显不对调。
        // 模型没填 pitch 时先查歌单池；池子没有就传 null 交给自动变调（别硬塞 0）。
        const askedPitch = (pitch == null || pitch === '') ? null : Number(pitch)
        const picked = named
          ? { query: named, shift: Number.isFinite(askedPitch) ? askedPitch : poolShiftOf(named) }
          : pickSomethingToSing()
        const from = (start == null || start === '') ? null : Number(start)
        return song.request({ song: picked.query, pitch: picked.shift, chatId: chat.chatId, start: Number.isFinite(from) ? from : null })
      },
    }) : []))

    api.route('/song/status', async () => ({ ok: true, ...song.status() }))
    api.route('/song/install', async () => song.install())
    api.route('/song/root/check', async (req) => ({ ok: true, ...checkRoot(http.query(req).path || '') }))
    api.route('/song/drives', async () => ({ ok: true, list: listDrives() }))
    api.route('/song/search', async (req) => {
      try { return { ok: true, list: await song.search(http.query(req).q || '') } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })
    api.route('/song/account', async () => song.account())
    // 导入音色：面板把文件原样传上来（.zip / .pth / .index），文件名放在 ?name= 里
    api.route('/song/import', async (req) => {
      const name = http.query(req).name || ''
      try {
        // 上限可配（song.importMaxMB，默认 1024MB）。这是整包读进内存的路径，别把宿主的堆撑爆。
        const maxMB = Math.max(16, Math.min(4096, Number(api.config()?.song?.importMaxMB) || 1024))
        const buf = await http.raw(req, maxMB * 1024 * 1024)
        if (!buf.length) return { ok: false, message: '文件是空的' }
        const r = song.importModels(name, buf)
        if (r.ok) api.log.info('导入音色：' + r.message)
        return r
      } catch (error) {
        return { ok: false, message: '导入失败：' + error.message }
      }
    })
    api.route('/song/voice/delete', async (req) => song.deleteVoice(String((await http.body(req)).id || '')))
    // 面板里试唱：发到主人私聊
    api.route('/song/request', async (req) => {
      const b = await http.body(req)
      const c0 = api.config()
      // 面板「默认变调」是 -12~12 的滑块，0 是它的中间值，**不代表「要求不变调」**。
      // 开着自动变调时把 0 当作「没指定」交给自动检测 —— 否则试唱永远是原调，
      // 男声歌（该 +12）和女声歌都被钉死，日志里表现为「变调用点歌时指定的 +0 半音」。
      const p = Number(b.pitch)
      const autoOn = (c0.song || {}).autoPitch !== false
      const pitch = (autoOn && (!Number.isFinite(p) || p === 0)) ? null : b.pitch
      const start = (b.start == null || b.start === '') ? null : Number(b.start)
      return song.request({
        song: b.song, songId: b.songId, pitch, voice: b.voice,
        chatId: b.chatId || `private:${c0.ownerQQ}`,
        start: Number.isFinite(start) ? start : null,
      })
    })
    return song
  },
}
