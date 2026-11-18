/**
 * 记忆密级与盖章
 *
 * 给记忆加一道「哪些话不能往外说」的判断，顺手盖三档章：
 *   secret   机密：家里人、QQ 号、自己填的机密词
 *   public   公开：知识、群里说的话
 *   internal 内部：其余
 *
 * 它不存记忆，也不检索——只负责判断和盖章。
 *
 * 装好之后第一件事：去面板把「家里人叫什么」填上。
 * 不填也能跑，但只认通用词（家里人 / 保密 / 别告诉），会漏。
 *
 * 代码里没有任何人的真名。名字全从设置来。
 * 作者：分享者  ·  许可：MIT
 */

import { makeGrader, FAMILY_TAG, KNOWLEDGE_TAG, GROUP_TAG } from './lib/grade.mjs'
import { gua, markGua, UPPER, LOWER } from './lib/gua.mjs'
import { openStore } from './lib/store.mjs'
import { strengthOf, stateOf, decay, purgeArchived } from './lib/forget.mjs'

export default {
  id: 'memory-grade',
  name: '记忆总库',
  version: '1.3.1',
  api: 1,
  description: '存记忆、判密级、盖三档章、顺手标八卦。东西全在自己机器上，不联网。',

  defaults: {
    personaName: '',
    familyNames: '',
    ownerQQ: '',
    extraSecretWords: '',
    extraPublicWords: '',
    warnOnStart: true,
    enableGua: false,
    ownerKey: '',
    enableDecay: true,
    decaySleep: 0.12,
    decayArchive: 0.04,
    decayByDays: false,
    decayDays: 90,
    autoDecayHours: 24,
    autoCollect: false,
    collectChats: '',
    collectEveryMin: 30,
  },

  settings: [
    {
      key: 'personaName',
      label: '她自己的名字',
      type: 'text',
      hint: 'AI 角色的名字。填了之后，说到这个名字就判成机密。可以留空。',
      placeholder: '例如：小满',
    },
    {
      key: 'familyNames',
      label: '家里人的名字',
      type: 'textarea',
      hint: '一行一个，或用 | 隔开。这些名字一出现就判机密。这是最重要的一项，别留空。',
      placeholder: '例如：\n张三\n李四',
    },
    {
      key: 'ownerQQ',
      label: '主人的 QQ 号',
      type: 'text',
      hint: '出现这个数字就判机密。多个号用 | 隔开。',
      placeholder: '例如：123456789',
    },
    {
      key: 'extraSecretWords',
      label: '还想加哪些机密词',
      type: 'textarea',
      hint: '公司名、项目代号之类。用 | 或换行隔开。',
      placeholder: '',
    },
    {
      key: 'extraPublicWords',
      label: '哪些词是安全的',
      type: 'textarea',
      hint: '填了机密词，但在某些固定说法里其实安全（比如「保密协议」），填这里。一般不用填。',
      placeholder: '',
    },
    {
      key: 'warnOnStart',
      label: '没填名字时提醒我',
      type: 'switch',
    },
    {
      key: 'enableGua',
      label: '顺便标个八卦',
      type: 'switch',
      hint: '用乾坤震巽坎离艮兑八个字，给记忆标「是什么」和「怎么用」。只是分类标签，不参与检索排序。默认关。',
    },
﻿    {
      key: 'ownerKey',
      label: '这份记忆属于谁',
      type: 'text',
      hint: '同一台机器跑多个角色时填，一个角色一个值，各存各的。只跑一个角色就留空。',
      placeholder: '例如：小满',
    },
    {
      key: 'enableDecay',
      label: '让记忆自己淡下去',
      type: 'switch',
      hint: '久了没用到、又不重要的记忆会先休眠、再归档成一行的摘要。置顶的和机密的不动。默认开。',
    },
    {
      key: 'decaySleep',
      label: '休眠阈值',
      type: 'number',
      hint: '强度掉到这个值以下就先休眠（不参与默认检索，但还在库里）。默认 0.12，越小越晚休眠。',
      placeholder: '0.12',
    },
    {
      key: 'decayArchive',
      label: '归档阈值',
      type: 'number',
      hint: '强度掉到这个值以下就归档，正文压成一行摘要。默认 0.04。',
      placeholder: '0.04',
    },
    {
      key: 'decayByDays',
      label: '按天数忘，而不是按强度',
      type: 'switch',
      hint: '打开后不管重要性，只看多久没被想起。适合想要「固定 90 天忘一次」这种简单规则的人。',
    },
    {
      key: 'decayDays',
      label: '多少天没想起就淡出',
      type: 'number',
      hint: '配合上面那个开关。填 90，就是 90 天休眠、180 天归档。',
      placeholder: '90',
    },
    {
      key: 'autoDecayHours',
      label: '每隔几小时自动清一次',
      type: 'number',
      hint: '自动跑整理。默认 24 小时。填 0 就关掉自动。',
      placeholder: '24',
    },
    {
      key: 'autoCollect',
      label: '自动收各会话的话',
      type: 'switch',
      hint: '打开后按下面的间隔，把指定会话里的话自动记进总库。默认关。',
    },
    {
      key: 'collectChats',
      label: '收哪些会话',
      type: 'textarea',
      hint: '填会话 id，一行一个，或用 | 隔开。例如 private:123456、group:789012。留空就收全部。',
      placeholder: 'private:123456',
    },
    {
      key: 'collectEveryMin',
      label: '多久收一次（分钟）',
      type: 'number',
      hint: '默认 30 分钟。',
      placeholder: '30',
    },
  ],

  setup(api) {
    // 每次判断都现读设置：改了立即生效，不用重载
    const grader = () => makeGrader(api.settings())

    // 遗忘阈值：面板里能改，改了立即生效
    const thresholds = () => {
      const st = api.settings()
      const sleep = Number(st.decaySleep)
      const archive = Number(st.decayArchive)
      return {
        sleep: Number.isFinite(sleep) && sleep > 0 ? sleep : 0.12,
        archive: Number.isFinite(archive) && archive > 0 ? archive : 0.04,
      }
    }

    // 记忆库：存到模块自己的数据目录，别人看不到
    // 填了 ownerKey 就再分一层子目录，避免多个角色串数据
    let store = null
    try {
      const own = String(api.settings().ownerKey || '').trim()
      const dir = own
        ? api.dataDir('owners', own.replace(/[\\/:*?"<>|]/g, '_'))
        : api.dataDir()
      store = openStore(dir)
      if (own) api.log?.info?.('[memory-grade] 记忆库目录：' + dir)
    } catch (error) {
      api.log?.error?.('[memory-grade] 记忆库打不开：' + error.message)
    }

    // 启动自检：没填家人名单时喊一声，别悄悄跑
    if (api.settings().warnOnStart !== false) {
      try {
        const g = grader()
        if (!g.ready()) {
          api.log?.warn?.(
            '[memory-grade] 家人名字还没填，现在只按通用词判断，会漏掉很多。' +
              ' 去面板把「家里人的名字」填上。',
          )
        }
      } catch (error) {
        api.log?.warn?.('[memory-grade] 启动自检失败：' + error.message)
      }
    }

﻿    // ---------- 自动整理 ----------

    let decayTimer = null
    let collectTimer = null
    const lastCollectAt = new Map()
    const recentLines = new Map()
    const KEEP_PER_CHAT = 200

    function stopTimers() {
      if (decayTimer) { clearInterval(decayTimer); decayTimer = null }
      if (collectTimer) { clearInterval(collectTimer); collectTimer = null }
    }

    function startTimers() {
      stopTimers()
      const st = api.settings()

      const hours = Number(st.autoDecayHours)
      if (Number.isFinite(hours) && hours > 0) {
        decayTimer = setInterval(() => {
          try {
            const r = decayNow({ apply: true })
            if (r.changed?.length) {
              api.log?.info?.('[memory-grade] 自动整理：' + r.changed.length + ' 条降级')
            }
          } catch (error) {
            api.log?.warn?.('[memory-grade] 自动整理失败：' + error.message)
          }
        }, hours * 3600000)
        decayTimer.unref?.()
      }

      if (st.autoCollect === true) {
        const mins = Number(st.collectEveryMin)
        const every = Number.isFinite(mins) && mins > 0 ? mins : 30
        collectTimer = setInterval(() => {
          try {
            collectFromChats()
          } catch (error) {
            api.log?.warn?.('[memory-grade] 自动收会话失败：' + error.message)
          }
        }, every * 60000)
        collectTimer.unref?.()
      }
    }

    function decayNow(opts = {}) {
      if (!store) return { active: 0, sleeping: 0, archived: 0, changed: [], total: 0 }
      const st = api.settings()
      return decay(store, {
        thresholds: thresholds(),
        byDays: st.decayByDays === true,
        days: Number(st.decayDays) || 90,
        ...opts,
      })
    }

    function collectFromChats() {
      if (!store) return 0
      const st = api.settings()
      const want = String(st.collectChats || '')
        .split(/[|,，;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean)

      const g = makeGrader(st)
      const useGua = st.enableGua === true
      let n = 0

      for (const [chatId, lines] of recentLines) {
        if (want.length && !want.includes(chatId)) continue
        const since = lastCollectAt.get(chatId) || 0
        for (const line of lines) {
          if (line.at <= since) continue
          const t = String(line.text || '').trim()
          if (t.length < 4) continue
          if (/^\[.+\]$/.test(t)) continue
          const extra = { chatId, source: 'session', at: line.at, tags: ['会话'], state: 'active' }
          extra.cls = g.classify({ text: t, tags: extra.tags })
          if (useGua) {
            const gg = gua(t)
            extra.gua = { u: gg.upper, l: gg.lower }
            extra.guaUpper = gg.upper
            extra.guaLower = gg.lower
          }
          store.add(t, extra)
          n++
        }
        lastCollectAt.set(chatId, Date.now())
      }
      if (n) api.log?.info?.('[memory-grade] 自动收了 ' + n + ' 条会话')
      return n
    }

    api.on('activity', (ev) => {
      try {
        if (!ev?.chatId || !ev?.text) return
        const arr = recentLines.get(ev.chatId) || []
        arr.push({ text: ev.text, at: Date.now(), who: ev.kind })
        if (arr.length > KEEP_PER_CHAT) arr.splice(0, arr.length - KEEP_PER_CHAT)
        recentLines.set(ev.chatId, arr)
      } catch {
        /* 无所谓 */
      }
    })

    startTimers()

    return {
      /** 这句话算机密吗？ -> { secret, reason } */
      judge: (text) => grader().judge(text),
      /** 给一条记忆盖章 -> 'secret' | 'internal' | 'public' */
      classify: (item) => grader().classify(item),
      /** 设置填全了没有 */
      ready: () => grader().ready(),
      /** 设置里填了几个名字 */
      counts: () => grader().counts(),
      /** 给一段文字判八卦 -> { upper, lower, reason } */
      gua: (text) => gua(text),
      /** 按当前开关，给一条记忆补上卦位标签 */
      markGua: (item) => markGua(item, api.settings().enableGua !== false && api.settings().enableGua === true),
      /** 八个卦分别代表什么 */
      guaMeanings: { upper: { ...UPPER }, lower: { ...LOWER } },

      /** 底层的库，想自己操作就用它 */
      store,

      /**
       * 记一条。
       * 会自动补密级和卦位（卦位看开关）。
       */
      remember(text, extra = {}) {
        if (!store) return null
        const g = grader()
        const cls = extra.cls || g.classify({ text, tags: extra.tags || [] })
        let item = { ...extra, text, cls }
        if (api.settings().enableGua === true) {
          item = markGua(item, true)
          item.gua = { u: item.guaUpper, l: item.guaLower }
        }
        item.state = 'active'
        return store.add(text, item)
      },

      /**
       * 找记忆。按关键词打分，机密的不影响——都在本地。
       * opts 可以带 limit / cls / tag
       */
      recall(query, opts = {}) {
        return store ? store.search(query, opts) : []
      },

      /** 最近记的几条 */
      recent(limit = 10) {
        return store ? store.list({ limit }) : []
      },

      /** 按 id 取一条 */
      get(id) {
        return store ? store.get(id) : null
      },

      /** 改一条。传 { id: ... } 里的 id 不会生效 */
      update(id, patch) {
        return store ? store.update(id, patch) : null
      },

      /** 删一条。删了就没了，自己确认 */
      remove(id) {
        return store ? store.remove(id) : false
      },

      /** 列表。可以带 limit / offset / cls / tag / pin */
      list(opts = {}) {
        return store ? store.list(opts) : []
      },

      /** 统计一下有多少条 */
      stats() {
        return store ? store.stats() : { total: 0, pinned: 0, byCls: {}, byTag: {} }
      },

      /** 这条现在有多"牢"（0~1） */
      strength(id) {
        const it = store?.get(id)
        return it ? strengthOf(it) : 0
      },

      /** 这条现在是 active / sleeping / archived */
      state(id) {
        const it = store?.get(id)
        if (!it) return null
        // 置顶的和机密的不参与遗忘，永远算 active
        if (it.pin) return 'active'
        if (it.cls === 'secret') return 'active'
        return it.state || stateOf(strengthOf(it), thresholds())
      },

      /**
       * 扫一遍，算哪些该降级。
       * 默认只算不改；想真降就传 { apply: true }。
       */
      decay(opts = {}) {
        if (!store) return { active: 0, sleeping: 0, archived: 0, changed: [], total: 0 }
        const st = api.settings()
        return decay(store, {
          thresholds: thresholds(),
          byDays: st.decayByDays === true,
          days: Number(st.decayDays) || 90,
          ...opts,
        })
      },

      /** 真删掉长期归档的（不可逆，自己确认了再调） */
      purgeArchived(opts = {}) {
        return store ? purgeArchived(store, opts) : { removed: 0, ids: [] }
      },

      /** 这条被想起来了：加一次命中，强度回来一点 */
      touch(id) {
        return store ? store.touch(id) : null
      },

      /** 立刻收一次会话（手动触发） */
      collect() {
        return collectFromChats()
      },

      /** 立刻把内存里的改动写盘（平时会自动攒一小会儿，这个能强制写） */
      save() {
        try {
          store?.flush()
          return true
        } catch (error) {
          api.log?.warn?.('[memory-grade] 写盘失败：' + error.message)
          return false
        }
      },

      /** 模块停下时收尾：清定时器、把数据落盘 */
      dispose() {
        stopTimers()
        try {
          store?.flush()
        } catch {
          /* 关的时候出错也没辙了 */
        }
      },
      tags: { FAMILY_TAG, KNOWLEDGE_TAG, GROUP_TAG },
    }
  },
}
