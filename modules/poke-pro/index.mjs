/**
 * poke-pro —— 专业戳一戳（Aurabot 模块）。
 *
 * 功能对应 astrbot_plugin_pokepro：被戳时按权重随机触发
 * 反戳 / LLM 回复 / QQ 表情 / 表情包 / 语音 / 禁言 / 触发命令，
 * 外加主动戳、关键词戳、定时戳。
 *
 * ======================== 与 Aurabot 的对接要点 ========================
 *
 * 我读了 Aurabot 的 `src/chat/hub.js`，确认了这几件事，模块就是按它们写的：
 *
 * 1. `poke` 事件在**芯层默认处理之前**被调用（hub.js:1595）：
 *
 *        if (hooks?.poke) {
 *          try { if (await hooks.poke(ev)) return } catch (error) {}
 *        }
 *        ... 之后才把戳转成「@你 [戳了戳你]」交给模型
 *
 *    所以模块返回 `true` = 完全接管，她不会再走默认的 LLM 处理。
 *    返回 `false` / 不返回 = 交给芯层，行为和没装模块一样。
 *    这就是为什么本模块**必须自己决定要不要 LLM 回复**（action='llm' 时走 api.think）。
 *
 * 2. `ev` 的字段（来自 OneBot 的 notice.poke）：
 *    `self_id`、`target_id`（被戳的人）、`user_id`（戳的人）、`group_id`（群戳时有）、
 *    `sender_id`（私聊戳时的发起者）、`action`、`suffix`。
 *    注意芯层用 `target_id === self_id` 判断「戳的是她」，模块必须照抄这个判断，
 *    否则会把她戳别人的事件也当成自己被戳。
 *
 * 3. 发戳用 `api.onebot('send_poke', { user_id, group_id })`（hub.js:738 同款）。
 *
 * 4. QQ 表情用消息段 `{ type: 'face', data: { id } }`，通过 `api.sendSegments` 发。
 *
 * 5. 语音条用 `api.sendVoiceFile(chatId, 音频文件)`；纯文字转语音用 `api.send` 加 `<voice>`。
 *
 * 6. 禁言用 `api.onebot('set_group_ban', { group_id, user_id, duration })`。
 *
 * 7. 主人在 QQ 里发的 `/命令` 用 `api.command({ name, aliases, desc, run })`。
 *
 * 8. 定时任务用 `api.every(毫秒, fn, 名字)`，Cron 表达式需要自己换算成毫秒轮询——
 *    Aurabot 没有 cron 支持，这里用「每分钟检查一次是否到点」的等价做法。
 */

import {
  pickWeighted,
  createCooldown,
  weightsToProbabilities,
} from './lib/weighted.mjs'
import {
  ACTION_LABELS,
  DEFAULT_WEIGHTS,
  buildActionList,
  clampInt,
  clampProbability,
  parseCommandPool,
  parseIdList,
  parseLineList,
  parseTargets,
} from './lib/settings.mjs'

/** 设置项默认值。与 module.json 的 defaults 保持同步。 */
export const DEFAULTS = {
  enabled: true,

  // 总开关与冷却
  pokeCooldownSec: 10,
  followProb: 0.1,

  // 权重（0 = 关闭该动作）
  weightAntipoke: 10,
  weightLlm: 10,
  weightFace: 10,
  weightMeme: 30,
  weightRecord: 0,
  weightBan: 10,
  weightCommand: 10,

  // 反戳
  antipokeMaxTimes: 5,

  // LLM
  llmTemplate: '{username} 戳了你一下, 请你用一句话回复一下, 确保符合人设的同时夹带生气甚至愤怒的情绪, 考虑上下文, 确保通顺不突兀',

  // QQ 表情
  facePool: '4,14,15,21,23,25,26,27,31,46,97,98,18,265,266,267,271,287,312,352,427',
  faceMaxCopy: 3,

  // 表情包
  memeTexts: '戳我干嘛\n不要戳我\n哼\n干嘛啦\n再戳就生气了\n呜呜呜',
  memeCooldownSec: 3,
  memePaths: '',
  fallbackToFace: true,

  // 语音
  recordPool: '',

  // 禁言
  banDuration: 60,
  banDelta: 30,
  banTemplate: '{username} 戳了你一下, 然后被你禁言了, 请你用一句话嘲讽一下, 确保符合人设的同时夹带幸灾乐祸的情绪, 考虑上下文, 确保通顺不突兀',
  banFailTemplate: '{username} 戳了你一下, 你因为你的身份比这人低而无法禁言这人, 请你用一句话吐槽一下, 确保符合人设的同时夹带生气甚至愤怒的情绪, 考虑上下文, 确保通顺不突兀',

  // 触发命令
  commandPool: '盒,捣,踩,玩,拍,丢,揍,爬,锤,吃,敲,滚,啃,捏,小丑,震动,晃脑,上香',

  // 主动戳
  pokeMaxTimes: 5,
  pokeIntervalSec: 0.5,
  pokeKeywords: '笨蛋,人机,机器人,bot',

  // 定时戳
  schedulerEnabled: false,
  schedulerCron: '30 22 * * *',
  schedulerTargets: '',
  schedulerTimes: 1,
}

/** 把设置读成结构化对象（面板里改完立刻生效，所以每次现读）。 */
function readSettings(api) {
  const s = api.settings()
  return {
    enabled: s.enabled !== false,
    pokeCooldownSec: clampInt(s.pokeCooldownSec, DEFAULTS.pokeCooldownSec, 0, 3600),
    followProb: clampProbability(s.followProb, DEFAULTS.followProb),
    weights: {
      antipoke: clampInt(s.weightAntipoke, DEFAULT_WEIGHTS.antipoke, 0, 100),
      llm: clampInt(s.weightLlm, DEFAULT_WEIGHTS.llm, 0, 100),
      face: clampInt(s.weightFace, DEFAULT_WEIGHTS.face, 0, 100),
      meme: clampInt(s.weightMeme, DEFAULT_WEIGHTS.meme, 0, 100),
      record: clampInt(s.weightRecord, DEFAULT_WEIGHTS.record, 0, 100),
      ban: clampInt(s.weightBan, DEFAULT_WEIGHTS.ban, 0, 100),
      command: clampInt(s.weightCommand, DEFAULT_WEIGHTS.command, 0, 100),
    },
    antipokeMaxTimes: clampInt(s.antipokeMaxTimes, 5, 1, 10),
    llmTemplate: String(s.llmTemplate ?? DEFAULTS.llmTemplate),
    facePool: parseIdList(s.facePool),
    faceMaxCopy: clampInt(s.faceMaxCopy, 3, 1, 8),
    memeTexts: parseLineList(s.memeTexts),
    memeCooldownSec: clampInt(s.memeCooldownSec, 3, 0, 60),
    memePaths: parseLineList(s.memePaths),
    fallbackToFace: s.fallbackToFace !== false,
    recordPool: parseLineList(s.recordPool),
    banDuration: clampInt(s.banDuration, 60, 1, 3600),
    banDelta: clampInt(s.banDelta, 30, 0, 600),
    banTemplate: String(s.banTemplate ?? DEFAULTS.banTemplate),
    banFailTemplate: String(s.banFailTemplate ?? DEFAULTS.banFailTemplate),
    commandPool: parseCommandPool(s.commandPool),
    pokeMaxTimes: clampInt(s.pokeMaxTimes, 5, 1, 10),
    pokeIntervalSec: Math.max(0, Number(s.pokeIntervalSec) || 0),
    pokeKeywords: parseCommandPool(s.pokeKeywords),
    schedulerEnabled: s.schedulerEnabled === true,
    schedulerCron: String(s.schedulerCron ?? DEFAULTS.schedulerCron),
    schedulerTargets: parseTargets(s.schedulerTargets),
    schedulerTimes: clampInt(s.schedulerTimes, 1, 1, 10),
  }
}

/** 随机整数 [1, max]。 */
const randInt = (max) => 1 + Math.floor(Math.random() * Math.max(1, max))

/** 从数组里随机取一个；空了返回 null。 */
const pickOne = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

/** 把模板里的 {username} 换掉。 */
const fillTemplate = (tpl, vars) => String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))

/**
 * 极简 cron（分 时 日 月 周）匹配：只支持 `*`、数字、逗号列表。
 * 够覆盖 `30 22 * * *` 这种日常用法；范围（`1-5`）和步长（`*\/5`）也支持。
 * 复杂写法（@daily 等）不支持——返回 false，不会静默乱触发。
 */
export function cronMatches(expr, date) {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, month, dow] = parts
  const fieldMatch = (spec, value, minV, maxV) => {
    if (!spec) return false
    for (const raw of spec.split(',')) {
      const s = raw.trim()
      if (!s) continue
      if (s === '*') return true
      const stepMatch = s.match(/^(\*|\d+)\/(\d+)$/)
      if (stepMatch) {
        const step = Number(stepMatch[2])
        if (!Number.isFinite(step) || step <= 0) continue
        const start = stepMatch[1] === '*' ? minV : Number(stepMatch[1])
        if ((value - start) % step === 0 && value >= start) return true
        continue
      }
      const rangeMatch = s.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        const a = Number(rangeMatch[1]); const b = Number(rangeMatch[2])
        if (value >= a && value <= b) return true
        continue
      }
      const n = Number(s)
      if (Number.isInteger(n) && n === value) return true
    }
    return false
  }
  return fieldMatch(min, date.getMinutes(), 0, 59)
    && fieldMatch(hour, date.getHours(), 0, 23)
    && fieldMatch(dom, date.getDate(), 1, 31)
    && fieldMatch(month, date.getMonth() + 1, 1, 12)
    && fieldMatch(dow, date.getDay(), 0, 6)
}

export default {
  id: 'poke-pro',
  name: '专业戳一戳',
  version: '1.0.0',
  api: 1,
  description: '被戳时按权重随机反戳、LLM 回复、发表情、发表情包、发语音、禁言或触发命令；支持主动戳、关键词戳与定时戳。',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后模块完全不干预戳一戳' },
    { key: 'pokeCooldownSec', label: '被戳冷却（秒）', type: 'number', min: 0, max: 3600, step: 1, hint: '同一聊天在这段时间内重复戳只处理一次' },
    { key: 'followProb', label: '跟戳概率', type: 'number', min: 0, max: 1, step: 0.01, hint: '看到别人被戳时跟一下的概率；0 = 不跟' },

    { key: 'weightAntipoke', label: '权重：反戳', type: 'number', min: 0, max: 100, step: 1, hint: '0 = 关闭。概率 = 本权重 / 所有非零权重之和' },
    { key: 'weightLlm', label: '权重：LLM 回复', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'weightFace', label: '权重：QQ 表情', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'weightMeme', label: '权重：表情包', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'weightRecord', label: '权重：语音', type: 'number', min: 0, max: 100, step: 1, hint: '默认 0（关闭）' },
    { key: 'weightBan', label: '权重：禁言', type: 'number', min: 0, max: 100, step: 1 },
    { key: 'weightCommand', label: '权重：触发命令', type: 'number', min: 0, max: 100, step: 1 },

    { key: 'antipokeMaxTimes', label: '反戳次数上限', type: 'number', min: 1, max: 10, step: 1, hint: '实际次数在 1 到这个值之间随机' },
    { key: 'llmTemplate', label: 'LLM 提示模板', type: 'textarea', hint: '可用 {username} 变量' },

    { key: 'facePool', label: 'QQ 表情池', type: 'textarea', hint: '填表情 ID，逗号分隔' },
    { key: 'faceMaxCopy', label: '表情最大复制数', type: 'number', min: 1, max: 8, step: 1 },

    { key: 'memeTexts', label: '表情包文字池', type: 'textarea', hint: '一行一条，随机取用' },
    { key: 'memeCooldownSec', label: '表情包冷却（秒）', type: 'number', min: 0, max: 60, step: 1 },
    { key: 'memePaths', label: '本地图库路径', type: 'textarea', hint: '一行一个目录，随机取图；留空则只用文字' },
    { key: 'fallbackToFace', label: '图片不可用时回退到表情', type: 'switch' },

    { key: 'recordPool', label: '语音文件池', type: 'textarea', hint: '一行一个音频文件绝对路径' },

    { key: 'banDuration', label: '禁言基础时长（秒）', type: 'number', min: 1, max: 3600, step: 1 },
    { key: 'banDelta', label: '禁言时长波动（±秒）', type: 'number', min: 0, max: 600, step: 1 },
    { key: 'banTemplate', label: '禁言成功提示模板', type: 'textarea' },
    { key: 'banFailTemplate', label: '禁言失败提示模板', type: 'textarea' },

    { key: 'commandPool', label: '命令池', type: 'textarea', hint: '逗号分隔，触发时随机发一条（交给别的插件处理）' },

    { key: 'pokeMaxTimes', label: '主动戳次数上限', type: 'number', min: 1, max: 10, step: 1, hint: '主人不受此限制' },
    { key: 'pokeIntervalSec', label: '发戳间隔（秒）', type: 'number', min: 0, max: 3, step: 0.1, hint: '防风控' },
    { key: 'pokeKeywords', label: '关键词触发戳', type: 'textarea', hint: '逗号分隔；消息含这些词就戳几下对方' },

    { key: 'schedulerEnabled', label: '启用定时戳', type: 'switch' },
    { key: 'schedulerCron', label: '定时表达式', type: 'text', hint: '分 时 日 月 周，例如 30 22 * * *' },
    { key: 'schedulerTargets', label: '定时戳目标', type: 'textarea', hint: '一行一个，格式 群号:QQ号' },
    { key: 'schedulerTimes', label: '定时戳次数', type: 'number', min: 1, max: 10, step: 1 },
  ],

  setup(api) {
    const log = api.log
    const config = () => readSettings(api)

    /** 每个聊天的被戳冷却。TTL 跟着设置走，所以读的时候现算。 */
    let pokeCooldown = createCooldown(config().pokeCooldownSec * 1000)
    /** 表情包生成冷却（按用户）。 */
    let memeCooldown = createCooldown(config().memeCooldownSec * 1000)
    /** 定时戳已执行的分钟，避免同一分钟重复触发。 */
    let lastFiredMinute = ''

    /** 设置里改了冷却时长就换一个新的冷却表（旧记录作废，避免 TTL 对不上）。 */
    const syncCooldown = () => {
      const s = config()
      if (pokeCooldown.ttlMs !== s.pokeCooldownSec * 1000) {
        pokeCooldown = createCooldown(s.pokeCooldownSec * 1000)
      }
      if (memeCooldown.ttlMs !== s.memeCooldownSec * 1000) {
        memeCooldown = createCooldown(s.memeCooldownSec * 1000)
      }
    }

    /** 拿到昵称：群名片 > 昵称 > QQ 号（不会把纯号码当昵称展示给模型）。 */
    const nicknameOf = async (ev) => {
      const group = ev.group_id ? Number(ev.group_id) : null
      const userId = Number(ev.user_id ?? ev.sender_id)
      try {
        if (group) {
          const m = await api.onebot('get_group_member_info', { group_id: group, user_id: userId }, { timeoutMs: 5000 })
          return String(m?.card || m?.nickname || '').trim() || null
        }
        const s = await api.onebot('get_stranger_info', { user_id: userId }, { timeoutMs: 5000 })
        return String(s?.nickname || '').trim() || null
      } catch {
        return null
      }
    }

    /** 发 n 次戳，每次间隔 pokeIntervalSec。 */
    const sendPoke = async (groupId, userId, times) => {
      const interval = config().pokeIntervalSec * 1000
      const params = { user_id: Number(userId), ...(groupId ? { group_id: Number(groupId) } : {}) }
      for (let i = 0; i < times; i++) {
        try {
          await api.onebot('send_poke', params, { timeoutMs: 10000 })
        } catch (error) {
          log.debug?.(`戳一戳失败：${error?.message ?? error}`)
          return
        }
        if (i < times - 1 && interval > 0) await new Promise((r) => setTimeout(r, interval))
      }
    }

    /* ------------------------------------------------------------------ */
    /* 各种回复动作                                                        */
    /* ------------------------------------------------------------------ */

    const actAntipoke = async ({ chatId, groupId, poker, s }) => {
      await sendPoke(groupId, poker, randInt(s.antipokeMaxTimes))
      log.info?.(`[poke-pro] ${chatId}：反戳 ${poker}`)
    }

    const actLlm = async ({ chatId, poker, nickname, s }) => {
      const text = fillTemplate(s.llmTemplate, { username: nickname || '某人', qq: poker })
      // 用 api.think：带人格和上下文；返回她的话，我们自己发出去（因为已接管这条戳）
      const reply = await api.think(text, { title: '被戳' })
      if (reply && String(reply).trim()) {
        await api.send(chatId, String(reply).trim())
      }
    }

    const actFace = async ({ chatId, s }) => {
      const id = pickOne(s.facePool)
      if (id === null) return
      const n = randInt(s.faceMaxCopy)
      await api.sendSegments(chatId, Array.from({ length: n }, () => ({ type: 'face', data: { id: String(id) } })), '[表情]')
    }

    const actMeme = async ({ chatId, poker, nickname, s }) => {
      // Aurabot 侧没有 meme_generator；能做的两种：
      //   1) 有本地图库 → 随机取一张发出去
      //   2) 都没有 → 只用文字池发一句话（再不行回退到 QQ 表情）
      const dirs = s.memePaths
      if (dirs.length > 0) {
        const picked = pickOne(dirs)
        if (picked) {
          // 交给 api.sendImage 处理路径/URL；失败就往下走回退
          try {
            await api.sendImage(chatId, picked)
            return
          } catch (error) {
            log.debug?.(`[poke-pro] 发表情包失败：${error?.message ?? error}`)
          }
        }
      }
      const text = pickOne(s.memeTexts)
      if (text) {
        await api.send(chatId, text)
        return
      }
      if (s.fallbackToFace) await actFace({ chatId, s })
    }

    const actRecord = async ({ chatId, s }) => {
      const file = pickOne(s.recordPool)
      if (!file) return
      await api.sendVoiceFile(chatId, file, '[戳一戳语音]')
    }

    const actBan = async ({ chatId, groupId, poker, nickname, s }) => {
      // 私聊没禁言这回事，直接跳过（走回退）
      if (!groupId) return false
      const base = s.banDuration
      const delta = s.banDelta
      const duration = Math.max(1, base + (delta > 0 ? Math.round((Math.random() * 2 - 1) * delta) : 0))
      try {
        await api.onebot('set_group_ban', { group_id: Number(groupId), user_id: Number(poker), duration }, { timeoutMs: 10000 })
      } catch (error) {
        log.info?.(`[poke-pro] 禁言失败：${error?.message ?? error}`)
        const failText = fillTemplate(s.banFailTemplate, { username: nickname || '某人', qq: poker })
        const reply = await api.think(failText, { title: '禁言失败' })
        if (reply && String(reply).trim()) await api.send(chatId, String(reply).trim())
        return true
      }
      const okText = fillTemplate(s.banTemplate, { username: nickname || '某人', qq: poker, duration })
      const reply = await api.think(okText, { title: '禁言成功' })
      if (reply && String(reply).trim()) await api.send(chatId, String(reply).trim())
      return true
    }

    const actCommand = async ({ chatId, s }) => {
      const cmd = pickOne(s.commandPool)
      if (!cmd) return
      // 作为普通消息发出去，交给别的插件/她自己处理
      await api.sendText(chatId, cmd)
    }

    /* ------------------------------------------------------------------ */
    /* 被戳主流程                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 处理一次被戳：抽一个动作执行。
     * 返回 true 表示已接管（芯层不再走默认 LLM 处理）。
     */
    const runAction = async ({ chatId, groupId, poker, nickname }) => {
      const s = config()
      if (!s.enabled) return false

      const action = pickWeighted(buildActionList(s.weights))
      if (!action) {
        log.debug?.('[poke-pro] 所有动作权重都是 0，交回芯层')
        return false
      }

      const ctxArgs = { chatId, groupId, poker, nickname, s }
      try {
        switch (action) {
          case 'antipoke': await actAntipoke(ctxArgs); break
          case 'llm': await actLlm(ctxArgs); break
          case 'face': await actFace(ctxArgs); break
          case 'meme': await actMeme(ctxArgs); break
          case 'record': await actRecord(ctxArgs); break
          case 'ban': {
            const banned = await actBan(ctxArgs)
            if (!banned) await actFace(ctxArgs) // 私聊等禁言不了的情况，回退表情
            break
          }
          case 'command': await actCommand(ctxArgs); break
          default: return false
        }
      } catch (error) {
        log.warn?.(`[poke-pro] 动作 ${ACTION_LABELS[action] ?? action} 失败：${error?.message ?? error}`)
        return false // 出错就交回芯层，别让这条戳没反应
      }

      log.info?.(`[poke-pro] ${chatId}：${poker} 戳 → ${ACTION_LABELS[action] ?? action}`)
      return true
    }

    /* ------------------------------------------------------------------ */
    /* 事件接线                                                            */
    /* ------------------------------------------------------------------ */

    api.on('poke', async (ev) => {
      const s = config()
      if (!s.enabled) return false

      // 和芯层一样的判断：只有戳的是她本人才处理
      const self = String(ev?.self_id ?? api.config()?.botQQ ?? '')
      if (!self || String(ev?.target_id) !== self) return false

      const groupId = ev?.group_id ? String(ev.group_id) : null
      const poker = String(groupId ? ev.user_id : (ev.sender_id ?? ev.user_id) ?? '')
      if (!poker || poker === self) return false

      // 跟戳：别人被戳（不是她）时，按概率跟着戳一下——这需要在 poke 事件里判 target 不是她
      // （那种情况已经 return false 了），所以跟戳单独走 onebot 事件，见下。

      const chatId = groupId ? `group:${groupId}` : `private:${poker}`

      // 冷却
      syncCooldown()
      if (!pokeCooldown.hit(chatId)) {
        log.debug?.(`[poke-pro] ${chatId} 冷却中，跳过`)
        return true // 冷却期内也接管，避免芯层重复走 LLM
      }

      const nickname = await nicknameOf(ev)
      return runAction({ chatId, groupId, poker, nickname })
    })

    /**
     * 跟戳：需要看「别人被戳」的事件，而 poke 钩子只收到「戳她」的。
     * 所以用 onebot 原始事件里 notice/poke 来抓别人被戳。
     */
    api.on('onebot', (ev) => {
      const s = config()
      if (!s.enabled || s.followProb <= 0) return
      if (ev?.post_type !== 'notice' || ev?.notice_type !== 'poke') return
      const self = String(ev.self_id ?? '')
      if (String(ev.target_id) === self) return // 戳她本人，走 poke 钩子
      if (!ev.group_id) return // 只在群里跟
      if (Math.random() >= s.followProb) return
      void sendPoke(String(ev.group_id), String(ev.target_id), 1).catch(() => {})
    })

    /**
     * 关键词触发戳：她收到含关键词的消息时，戳一下说话的人。
     * 用 activity 事件（kind='in'），不拦截消息本身。
     */
    api.on('activity', (a) => {
      const s = config()
      if (!s.enabled || s.pokeKeywords.length === 0) return
      if (a?.kind !== 'in' || !a.text) return
      if (!s.pokeKeywords.some((k) => a.text.includes(k))) return
      const chatId = String(a.chatId ?? '')
      const groupId = chatId.startsWith('group:') ? chatId.slice(6) : null
      const userId = String(a.userId ?? '')
      if (!userId || userId === String(api.config()?.botQQ ?? '')) return
      void sendPoke(groupId, userId, 1).catch(() => {})
    })

    /* ------------------------------------------------------------------ */
    /* 命令                                                                */
    /* ------------------------------------------------------------------ */

    /** 洗牌，用于「戳全体」抽 200 人。 */
    const shuffle = (arr) => {
      const a = [...arr]
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[a[i], a[j]] = [a[j], a[i]]
      }
      return a
    }

    /** 从命令参数里解析「次数 @某人」或「@某人」。 */
    const parsePokeArgs = (arg, msg) => {
      const text = String(arg ?? '')
      // 引用的消息优先
      const quoted = msg?.raw?.message?.find?.((seg) => seg.type === 'reply')?.data?.id
      const ats = [...text.matchAll(/@(\d+)/g)].map((m) => Number(m[1]))
      const numbers = [...text.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]))
      return { ats, numbers, quoted }
    }

    api.command({
      name: '戳',
      aliases: ['poke'],
      desc: '戳某人：/戳 @张三 [次数]；/戳我；/戳全体成员',
      run: async (arg, msg) => {
        const s = config()
        if (!s.enabled) return '戳一戳模块已关闭'
        const { ats, numbers } = parsePokeArgs(arg, msg)
        const isOwner = api.isOwner(msg?.userId)
        const asked = numbers.length ? numbers[numbers.length - 1] : 1
        const limit = isOwner ? 10 : s.pokeMaxTimes
        const times = Math.min(Math.max(1, asked), limit)

        const text = String(arg ?? '').trim()
        if (text.includes('全体')) {
          if (!msg?.groupId) return '群里才能戳全体成员'
          try {
            const list = await api.onebot('get_group_member_list', { group_id: Number(msg.groupId) }, { timeoutMs: 15000 })
            const members = (Array.isArray(list) ? list : []).map((m) => String(m.user_id)).filter((id) => id !== String(api.config()?.botQQ ?? ''))
            if (members.length === 0) return '没拿到群成员列表'
            // 200 人以上随机抽 200
            const pool = members.length > 200 ? shuffle(members).slice(0, 200) : members
            for (const uid of pool) await sendPoke(msg.groupId, uid, 1)
            return `戳了 ${pool.length} 个人`
          } catch (error) {
            return `戳全体失败：${error?.message ?? error}`
          }
        }
        if (text.includes('我')) {
          if (!msg?.userId) return '拿不到你的 QQ 号'
          await sendPoke(msg.groupId ? String(msg.groupId) : null, String(msg.userId), times)
          return `戳了你 ${times} 下`
        }
        if (ats.length === 0) {
          return '用法：/戳 @某人 [次数]、/戳我、/戳全体成员'
        }
        const target = ats[0]
        if (target === Number(api.config()?.botQQ ?? 0)) return '不能戳自己'
        await sendPoke(msg?.groupId ? String(msg.groupId) : null, String(target), times)
        return `戳了 ${target} ${times} 下` + (isOwner ? '' : `（上限 ${limit} 次）`)
      },
    })

    api.command({
      name: '戳状态',
      aliases: ['poke状态'],
      desc: '看看戳一戳模块当前的权重分布和最近统计',
      run: () => {
        const s = config()
        const probs = weightsToProbabilities(buildActionList(s.weights))
        const lines = Object.entries(probs)
          .sort((a, b) => b[1] - a[1])
          .map(([id, p]) => `${ACTION_LABELS[id] ?? id}：${(p * 100).toFixed(1)}%`)
        return [
          `状态：${s.enabled ? '开启' : '关闭'}`,
          `冷却：${s.pokeCooldownSec} 秒　跟戳：${(s.followProb * 100).toFixed(0)}%`,
          '权重分布：',
          ...lines,
        ].join('\n')
      },
    })

    /* ------------------------------------------------------------------ */
    /* 定时戳                                                              */
    /* ------------------------------------------------------------------ */

    // Aurabot 没有 cron，用每分钟轮询 + cron 表达式匹配
    const tickScheduler = async () => {
      const s = config()
      if (!s.enabled || !s.schedulerEnabled) return
      if (s.schedulerTargets.length === 0) return
      const now = new Date()
      const mark = `${now.getFullYear()}${now.getMonth()}${now.getDate()}${now.getHours()}${now.getMinutes()}`
      if (mark === lastFiredMinute) return
      if (!cronMatches(s.schedulerCron, now)) return
      lastFiredMinute = mark
      for (const t of s.schedulerTargets) {
        await sendPoke(String(t.groupId), String(t.userId), s.schedulerTimes).catch(() => {})
      }
      log.info?.(`[poke-pro] 定时戳执行：${s.schedulerTargets.length} 个目标`)
    }

    api.every(60_000, () => { void tickScheduler() }, 'poke-pro-scheduler')

    /* ------------------------------------------------------------------ */
    /* 导出                                                                */
    /* ------------------------------------------------------------------ */

    return {
      /** 给别的模块用：当前概率分布。 */
      probabilities: () => weightsToProbabilities(buildActionList(config().weights)),
      /** 给别的模块用：主动戳。 */
      poke: (groupId, userId, times = 1) => sendPoke(groupId ? String(groupId) : null, String(userId), times),
      /** 给别的模块用：手动跑一次定时戳检查。 */
      tick: tickScheduler,
      dispose() {
        pokeCooldown.clear()
        memeCooldown.clear()
      },
    }
  },
}
