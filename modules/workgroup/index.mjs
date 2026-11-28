// 工作群：成员只有白名单（主人 + 指定几个 QQ）的群，自动进工作状态——
//   1. 每条消息必回（group/decide 强制 must）；
//   2. 给主人完整本机工具（打开宿主既有的 group.ownerTools，只对判定出的群生效）；
//   3. 单独的模型和思考强度（可选，留空跟随全局）；
//   4. 规则和上下文注入「小步汇报、改动先等点头」的工作方式；
//   5. 工作群里不发任何表情/贴图（硬拦，不靠她自觉），并把判定结果同步进 group.workGroups，
//      好让宿主侧已有的「工作群剥掉情绪上下文」那套机制也认得出这些群。
// 名单在面板里改，不硬编码；群成员定期后台扫描，不阻塞聊天。
//
// 工具是怎么给到的：上游 1.3.0 起有 group.ownerTools（off / owner）与 group.ownerToolsGroups。
// 开了以后这些群走 group-full 档，每一轮由 hub 按 turnSendersAllOwner 开合 tools.restrict——
// 主人说话那一轮工具齐全，别人说话那一轮全局工具整层收走。取舍写在 README「本机工具」一节。
//
// 读成员失败时沿用上一轮判定，连续 3 轮读不到才摘：一次超时不该让「必回」和工具当场失效。

/** 只留数字。QQ 号从网关回来可能是数字也可能是字符串，统一成字符串再比。 */
export const digits = (v) => String(v ?? '').replace(/\D/g, '')

/** 面板里的白名单文本 → 去重后的 QQ 号数组。逗号、分号、空白都算分隔，太短的不收。 */
export const parseWhitelist = (raw) =>
  [...new Set(String(raw || '').split(/[\s,，;；]+/).map(digits).filter((s) => s.length >= 5))]

/**
 * 一个群算不算工作群：主人必须在成员里，且每个成员都在「白名单 + 主人 + 机器人自己」里。
 * 空成员表一律不算——读不到成员就不是「确认全员自己人」，宁可不给。
 */
export const isWorkGroupMembers = (memberIds, allowed, owner) => {
  const ids = [...new Set((memberIds || []).map(digits).filter(Boolean))]
  if (!ids.length) return false
  const me = digits(owner)
  if (!me || !ids.includes(me)) return false
  return ids.every((u) => allowed.has(u))
}

/** 扫描间隔下限：太小会频繁打网关。 */
export const scanInterval = (v) => Math.max(30, Number(v) || 120)

export default {
  id: 'workgroup',
  name: '工作群',
  version: '1.1.0',
  api: 1,
  description: '成员全在白名单的群自动视为工作群：每条必回、给主人完整本机工具、可用独立模型和思考强度，群内不发任何表情',
  defaults: {
    enabled: true,
    whitelist: '',
    intervalSec: 120,
    grantOwnerTools: true,
    syncWorkGroups: true,
    provider: '',
    model: '',
    reasoningEffort: '',
  },
  settings: [
    { key: 'enabled', label: '开启工作群判定', type: 'switch' },
    {
      key: 'whitelist',
      label: '工作群白名单 QQ（除主人外，一行一个）',
      type: 'textarea',
      hint: '主人自己（ownerQQ）永远算在内，不用写；只有全部成员都落在这份名单 + 主人里的群才会被判成工作群',
    },
    { key: 'intervalSec', label: '群成员扫描间隔（秒）', type: 'number', hint: '默认 120；太小会频繁请求网关' },
    {
      key: 'grantOwnerTools',
      label: '工作群给主人完整本机工具',
      type: 'switch',
      hint: '打开后由本模块托管 group.ownerTools 和 group.ownerToolsGroups 两个字段；关掉就不再碰它们，也不给工具',
    },
    {
      key: 'syncWorkGroups',
      label: '把判定结果同步进 group.workGroups',
      type: 'switch',
      hint: '上游没有这个字段，写了不生效也不报错；dsh-aurabot-qq 的部分源码分支用它做「工作群剥掉心情/人格上下文」，需要时才开',
    },
    { key: 'provider', label: '工作群模型 provider（留空跟随全局）', type: 'text' },
    { key: 'model', label: '工作群模型名（留空跟随全局）', type: 'text' },
    {
      key: 'reasoningEffort',
      label: '工作群思考强度',
      type: 'select',
      options: [
        { value: '', label: '跟随全局' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'highest', label: 'highest' },
      ],
    },
  ],

  async setup(api) {
    // ---- 判定结果只放内存：重启后靠 setup 末尾那次立即扫描补回来 ----
    // 不落盘的原因：这份名单是「当前群成员快照推出来的结论」，存下来就会变成另一种真相。
    let lastScan = ''
    let scanning = false
    const warned = new Set()
    let lastWork = new Set()
    const failCount = new Map()
    const STALE_LIMIT = 3

    // onebot.state 是字符串（'connected' / 'connecting' / 'disconnected' / 'stopped' / 'unconfigured'），
    // 不是对象。按对象读会恒为 undefined，等于永远放行，网关断了也照扫一遍。
    const onebotOk = () => {
      const st = api.core?.onebot?.state
      if (!st) return true
      if (typeof st === 'string') return st === 'connected'
      return st.status === 'ok' || st.ready !== false
    }

    async function scanOnce(force = false) {
      if (scanning) return
      scanning = true
      try {
        const cfg = api.config() || {}
        const s = api.settings() || {}
        if (!s.enabled && !force) return
        const owner = digits(cfg.ownerQQ)
        const bot = digits(cfg.botQQ)
        if (!owner) {
          if (!warned.has('owner')) {
            api.log.warn('工作群：ownerQQ 没配置，判定暂停')
            warned.add('owner')
          }
          return
        }
        const allowed = new Set([...parseWhitelist(s.whitelist), owner, bot].filter(Boolean))

        const groups = await api.core.onebot.call('get_group_list', {}, { timeoutMs: 15000 })
        const list = Array.isArray(groups) ? groups : (groups?.groups || [])
        // get_group_list 抽风返回空，不能当成「一个群都没了」把名单整份清空
        if (!list.length) {
          if (!warned.has('empty')) {
            api.log.warn('工作群：网关返回的群列表是空的，这轮不动名单')
            warned.add('empty')
          }
          return
        }
        warned.delete('empty')

        const work = []
        for (const g of list) {
          const gid = digits(g.group_id ?? g.id)
          if (!gid) continue
          let members = null
          let readErr = ''
          try {
            const r = await api.core.onebot.call(
              'get_group_member_list',
              { group_id: Number(gid) },
              { timeoutMs: 15000 },
            )
            members = Array.isArray(r) ? r : (r?.members || [])
          } catch (error) {
            readErr = error.message
          }
          const ids = members ? [...new Set(members.map((m) => digits(m.user_id)).filter(Boolean))] : []
          if (!ids.length) {
            // 读不到成员（超时 / 空表）：沿用上一轮判定。
            // 连续 STALE_LIMIT 轮都读不到才摘掉，这是安全上限——不能因为网关长期不通，
            // 就让一个早就混进外人的群继续享受工作群待遇。
            const n = (failCount.get(gid) || 0) + 1
            failCount.set(gid, n)
            const keep = lastWork.has(gid) && n <= STALE_LIMIT
            if (keep) work.push(gid)
            if (n === 1 || n === STALE_LIMIT || n % 5 === 0) {
              const why = readErr ? `读成员失败（${readErr}）` : '读到空成员表'
              api.log.warn(
                `工作群：群 ${gid} ${why}，第 ${n} 轮——${
                  keep ? `沿用上一轮判定（最多 ${STALE_LIMIT} 轮）` : '已摘掉，不再算工作群'
                }`,
              )
            }
            continue
          }
          failCount.delete(gid)
          warned.delete(gid)
          // 主人必须在成员里，且所有成员都在名单内
          if (isWorkGroupMembers(ids, allowed, owner)) work.push(gid)
        }

        const next = [...new Set(work)].sort()
        lastWork = new Set(next)

        // ---- 工具：只对判定出的群开 group-full，别的白名单群不受影响 ----
        // ⚠ ownerToolsGroups 留空的语义是「所有群」，不是「没有群」（见 access.groupOwnerTools）。
        //   所以绝不能把空数组写进去——那等于把工具开到最宽，和「没有工作群」正好相反。
        if (s.grantOwnerTools) {
          const cur = cfg.group || {}
          const curList = (cur.ownerToolsGroups || []).map(digits).filter(Boolean)
          if (next.length) {
            const curSet = new Set(curList)
            const sameList = curSet.size === next.length && next.every((v) => curSet.has(v))
            if (cur.ownerTools !== 'owner' || !sameList) {
              await api.setConfig({ group: { ownerTools: 'owner', ownerToolsGroups: next } })
              api.log.info(`工作群：本机工具已对 ${next.join('、')} 打开（只主人说话那一轮生效）`)
            }
          } else if (cur.ownerTools === 'owner' && curList.length) {
            // 名单是我们之前写下、现在又空了：收回去。
            // 但如果 ownerToolsGroups 本来就是空的（= 主人自己开给了所有群），一个字都不动——
            // 那是他自己的设置，不该因为「这会儿没工作群」被模块顺手关掉。
            await api.setConfig({ group: { ownerTools: 'off' } })
            api.log.info('工作群：没有群被判成工作群，本机工具已关')
          }
        }

        // ---- 名单同步：让宿主侧按 workGroups 做的隔离认得出这几个群 ----
        // 和上面那档工具开关是两件事，所以单独一段、单独判断有没有变。
        // 语义注意：workGroups 留空是「没有工作群」，和 ownerToolsGroups 留空（= 所有群）正好相反，
        // 所以这里空就写空，是安全的。
        if (s.syncWorkGroups) {
          const curWg = ((cfg.group || {}).workGroups || []).map(digits).filter(Boolean)
          const curSet = new Set(curWg)
          const sameWg = curSet.size === next.length && next.every((v) => curSet.has(v))
          if (!sameWg) {
            await api.setConfig({ group: { workGroups: next } })
            api.log.info(`工作群：group.workGroups 已同步为 ${next.join('、') || '（空）'}`)
          }
        }

        const key = next.join(',')
        if (key !== lastScan) {
          lastScan = key
          api.log.info(`工作群名单更新：${key || '（无）'}（扫了 ${list.length} 个群）`)
        }
      } catch (error) {
        api.log.warn('工作群扫描出错：' + error.message)
      } finally {
        scanning = false
      }
    }

    // 20 秒心跳，攒到 intervalSec 才真扫；改设置里的间隔即时生效，不用重载模块
    let acc = 1e9 // 启动先扫一次
    api.every(
      20_000,
      async () => {
        if (!api.settings().enabled || !onebotOk()) return
        acc += 20
        const want = scanInterval(api.settings().intervalSec)
        if (acc < want) return
        acc = 0
        await scanOnce()
      },
      'workgroup-scan',
    )

    const isWork = (groupId) => {
      if (!api.settings().enabled) return false
      const id = String(groupId || '')
      return !!id && lastWork.has(id)
    }

    // ---- 必回：工作群所有消息都算被叫到 ----
    api.on('group/decide', (decision, { msg }) => {
      const gid = String(msg.groupId || '') || String(msg.chatId || '').replace(/^group:/, '')
      if (!isWork(gid)) return null
      if (decision?.reply) return null // 本来就要回，不抢功
      return { reply: true, mode: 'must', reason: '工作群必回' }
    })

    // ---- 独立模型 ----
    api.on('model', (sel, chat) => {
      if (chat?.kind !== 'group' || !isWork(chat.groupId)) return undefined
      const s = api.settings()
      if (!s.provider || !s.model) return undefined
      return {
        provider: String(s.provider).trim(),
        model: String(s.model).trim(),
        reasoningEffort: String(s.reasoningEffort || ''),
      }
    })

    // ---- 工作状态：规则（system 层最硬）+ 每轮上下文（能精确判群）----
    // 开了 ownerTools 以后工作群走 group-full → preset `aurabot-group-owner`，
    // 那个预设渲染的是 rulesText('group-owner')，所以 api.rule 收到的 kind 是 'group-owner'。
    // 只写 'social' 会让这条规则在真正的工作群里被整个跳过，只剩下面那条 context 孤军作战，
    // 压不住人设闲聊的口气。两档都给，范围用群号名单钉死。
    api.rule((kind) => {
      if (!api.settings().enabled) return ''
      if (kind !== 'social' && kind !== 'group-owner' && kind !== 'workgroup') return ''
      const ids = [...lastWork]
      if (!ids.length) return ''
      return `【工作群】名单：${ids.join('、')}。你当前所在的群，只要群号在上面这份名单里，你就在「工作群」里干活——那时必须做到：每条消息都要回，不许用 [沉默] 躲开；不发表情、不贴图、不用颜文字和网络热梗；不要插科打诨、不要卖萌闲聊，说话简短直接，先给结论再给细节；做一小步就汇报一小步，不要攒一大坨再交；要改动任何东西，先说想改什么，等主人点头再动手。当前群号不在名单里时，按普通群聊照常来，这条不作数。`
    })

    api.context(({ chat }) => {
      if (chat?.kind !== 'group' || !isWork(chat.groupId)) return ''
      return '【工作状态】这个群是工作群：每条消息都要回应，但只谈事——不发表情、不卖萌、不说闲话。做一小步就汇报一小步，别攒一大坨再交；有任何改动，先说想改什么，等主人点头再动手。'
    })

    // ---- 不发表情：工作群里一律摘掉（硬拦，不指望她自己守着）----
    // 两个出口都拦：reply/items 管她正常的回复（表情是拆段之后才补的，所以这里拦得住），
    // send 管绕过前者的发送（慢工具提示、模块代发），那一路只到得了最终 OneBot 段。
    // 认表情段的办法：本地图是 image + sub_type=1，商城表情是 image + emoji_id；
    // 不带这两个标记的 image 是真图片，不碰。
    const isStickerSeg = (seg) => {
      if (!seg || seg.type !== 'image') return false
      const d = seg.data || {}
      return d.emoji_id != null || String(d.sub_type ?? '') === '1'
    }
    const workChat = (chatId) => {
      const id = String(chatId || '')
      return id.startsWith('group:') && isWork(id.slice(6))
    }
    api.on('reply/items', (items, { chatId }) => {
      if (!Array.isArray(items) || !workChat(chatId)) return undefined
      const kept = items.filter((it) => it?.kind !== 'sticker')
      if (kept.length === items.length) return undefined
      api.log.debug(`工作群 ${chatId}：摘掉 ${items.length - kept.length} 张表情`)
      return kept // 全被摘光就返回空数组：这一轮不发，别拿表情凑数
    })
    api.on('send', (message, { chatId }) => {
      if (!Array.isArray(message) || !workChat(chatId)) return undefined
      const kept = message.filter((seg) => !isStickerSeg(seg))
      if (kept.length === message.length) return undefined
      api.log.debug(`工作群 ${chatId}：最终出口又拦下 ${message.length - kept.length} 段表情`)
      return kept.length ? kept : null
    })

    // ---- 沉默兜底监控：规则已明说工作群不许 [沉默]，真出现就记日志，方便回头看 ----
    api.on('reply', (text, ctx) => {
      const gid = String(ctx?.chatId || '').replace(/^group:/, '')
      if (!gid || !isWork(gid)) return undefined
      const t = String(text || '').trim()
      if (!t || /\[沉默\]/.test(t)) api.log.warn(`工作群 ${gid} 里她这轮想沉默，已记录（正常情况不该发生）`)
      return undefined
    })

    // ---- 主人的查询命令 ----
    api.command({
      name: '工作群',
      desc: '看当前判定成工作群的群和名单',
      async run(arg) {
        const wantRescan = /^(重扫|重新扫描|rescan)$/i.test(String(arg || '').trim())
        if (wantRescan) {
          lastWork = new Set()
          failCount.clear()
          acc = 1e9
          await scanOnce(true)
        }
        const wl = parseWhitelist(api.settings().whitelist)
        const groups = [...lastWork]
        const head = `白名单：主人 + ${wl.join('、') || '（空）'}\n本机工具：${
          api.config()?.group?.ownerTools === 'owner' ? '已开（只主人说话那一轮生效）' : '没开'
        }`
        if (!groups.length) return `现在没有群被判成工作群。\n${head}`
        const names = []
        for (const gid of groups) {
          let nm = ''
          try {
            nm = await api.core.hub.groupName(gid)
          } catch {}
          names.push(`· ${gid}${nm ? `（${nm}）` : ''}`)
        }
        return `工作群：\n${names.join('\n')}\n${head}`
      },
    })

    // 启动即扫：判定结果只在内存里，不补这一下要空等到下一个间隔
    await scanOnce()

    return {
      list: () => [...lastWork],
      rescan: () => scanOnce(true),
    }
  },
}