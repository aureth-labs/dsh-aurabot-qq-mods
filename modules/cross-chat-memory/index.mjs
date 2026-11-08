// 跨聊天近况（cross-chat-memory）
//
// 解决什么：内置记忆只给主人私聊补「别处最近说过什么」（memory.js 的 crossHint 写死了
// chat.userId === ownerQQ）。所以除了主人私聊，别的私聊和群里一开口就像失忆——
// 明明半小时前刚跟某人聊完，换个聊天再被问起，答不上来。
//
// 两条通道，故意分开：
//   1. 自动注入（api.context）——只给主人私聊。别人那儿不会突然冒出「我在别处干了什么」。
//   2. 手动查询（cross_chat_recall 工具）——任何聊天都能查，包括被别人当面问
//      「你跟小椿聊得怎么样」。记忆在，只是不主动推给别人看。
//
// 三道边界：
//   · 主人的私事不外传：主人的私聊流水、主人本人在别处的发言，都不进外人的上下文。
//   · 群与群不串：A 群里的人和事不该冒到 B 群，那最像「记忆混乱」。
//   · 只认 QQ 的 private:/group: 两种真实聊天，qzone、bili 这类旁路记录不算。
//
// 实现在 lib/nearby.mjs（读流水 + 分拣 + 渲染），入口只管接线。

export default {
  id: 'cross-chat-memory',
  api: 1,
  name: '跨聊天近况',
  version: '0.1.0',
  description: '让她知道自己在别的聊天里最近说过什么：主人私聊每轮自动带上，别人当面问时能自己查；默认不外传主人的私事。',

  defaults: {
    enabled: true,
    // 往回看几小时
    hours: 24,
    // 每个聊天各取几条
    quota: 3,
    // 一段最多多少字（太长会挤掉别的上下文）
    maxChars: 420,
    // 单条最短几个字才收（过滤「嗯」「好」这种没信息量的）
    minChars: 4,
    // 主人私聊里，要不要把别人的私聊近况也带出来
    ownerSeesPrivate: true,
    // 群跟群之间要不要串（默认关：最像「记忆混乱」）
    shareGroupToGroup: false,
    // 别人私聊里要不要也自动注入（默认关：跨聊天是主人的特权）
    othersSeeCrossChat: false,
    // 保护主人的私事：主人的私聊流水与主人本人的发言，一律不给外人看
    keepOwnerSecret: true,
  },

  settings: [
    { key: 'enabled', label: '启用', type: 'switch', hint: '关掉就完全不加这段，工具也查不到' },
    { key: 'hours', label: '往回看几小时', type: 'number', hint: '默认 24 小时；调大能串起更早的事，但也更占上下文' },
    { key: 'quota', label: '每个聊天取几条', type: 'number', hint: '默认 3 条，取最近的' },
    { key: 'maxChars', label: '一段最多多少字', type: 'number', hint: '默认 420 字，超了从尾部截断' },
    { key: 'minChars', label: '单条最少字数', type: 'number', hint: '过滤「嗯」「好」这类没信息量的' },
    { key: 'ownerSeesPrivate', label: '主人私聊能看到别人的私聊近况', type: 'switch' },
    { key: 'shareGroupToGroup', label: '群与群互通', type: 'switch', hint: '默认关。打开后 A 群的事会出现在 B 群，容易串台' },
    { key: 'othersSeeCrossChat', label: '别人私聊也自动注入', type: 'switch', hint: '默认关：跨聊天是主人的特权。打开后别人也能自动看到别处近况' },
    { key: 'keepOwnerSecret', label: '保护主人的私事', type: 'switch', hint: '默认开。她仍会查、会说「跟谁聊了啥」，但主人的私聊流水与主人的发言不出门' },
  ],

  setup(api) {
    // lib/nearby.mjs 是懒加载的：模块热重载时不用重新跑一遍整个文件
    let mod = null
    const nearby = async () => {
      if (!mod) mod = await import('./lib/nearby.mjs')
      return mod.createNearby({ api })
    }

    // 缓存一份实例，每轮注入不必反复 import
    let inst = null
    const get = async () => {
      if (!inst) inst = await nearby()
      return inst
    }

    // ——— 通道一：自动注入 ———
    // api.context 每轮聊天前被调用，只返回给这一轮用的文字，不写进记忆、不进归档
    api.context(({ chat }) => {
      // context 是同步调用的，拿不到异步实例就用「上一次预热好的」那个
      if (!inst) { prewarm(); return '' }
      try {
        return inst.build(chat) || ''
      } catch (error) {
        api.log.warn(`跨聊天近况生成失败：${error.message}`)
        return ''
      }
    })

    // 启动时把实例建好，避免第一轮空着
    let warming = false
    function prewarm() {
      if (warming) return
      warming = true
      get().then(() => { warming = false }).catch((error) => {
        warming = false
        api.log.warn(`跨聊天近况预热失败：${error.message}`)
      })
    }
    prewarm()
    api.later(500, () => { prewarm() })

    // ——— 通道二：手动查询 ———
    // 别人当面问「你跟谁聊得怎么样」时，她自己翻得到。这条不自动推给谁。
    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      return api.defineTool({
        name: 'cross_chat_recall',
        description: '看看自己在别的聊天里最近说过什么。想确认「上次在别的群/别的私聊里聊过什么」时用。',
        properties: {
          hours: { type: 'number', description: '往回看几小时，默认用设置里的值' },
          chat: { type: 'string', description: '只看某个聊天，填 private:QQ号 或 group:群号；不填看全部' },
        },
        execute: async ({ hours, chat: only } = {}) => {
          try {
            const it = await get()
            return it.recall(chat, { hours, only })
          } catch (error) {
            return { ok: false, message: `查不到：${error.message}` }
          }
        },
      })
    })

    // ——— 面板与排查用 ———
    api.route('/preview', async () => {
      const it = await get()
      return it.preview()
    })

    api.route('/clear-cache', async () => {
      const it = await get()
      it.clearCache()
      return { ok: true }
    })

    // 定期预热群名缓存：hub.groupName() 是异步的，不能同步里直接调（会变成 [object Promise]）
    api.every(10 * 60_000, async () => {
      try { const it = await get(); it.warmNames() } catch { /* 群名拉不到就退回显示群号 */ }
    }, '预热群名')

    api.log.info('跨聊天近况 已启动')

    return {
      build: async (chat) => (await get()).build(chat),
      recall: async (chat, opts) => (await get()).recall(chat, opts),
    }
  },
}
