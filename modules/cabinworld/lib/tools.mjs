// 小屋世界的工具定义：参数一律取自桥发布的 openai-tools.json（官方 1.1 的 schema），
// 不再手抄——上游改了参数，这边自动跟上。TOOL_SPECS 只是读不到清单时的离线兜底。

import fs from 'node:fs'
import path from 'node:path'
// 描述保持短，够模型判断用途即可——工具清单每轮都会发给模型，越长越费 token。

export const TOOL_SPECS = [
  {
    name: 'cabin_status',
    description: '查看自己在小屋世界里的状态：位置、零花钱、背包、饱腹/口渴/心情、正在做什么、天气。做决定前先看一眼。',
  },
  {
    name: 'cabin_look',
    description: '看身边：这个房间有哪些家具/东西、每样能怎么用（object 和 use 的 id）、出口去哪。',
  },
  {
    name: 'cabin_go',
    description: '走去一个地方，身体在游戏里真的走过去，到了才算到。地方：xjhome 家、park 公园、shop 小卖部、onsen 汤屋（经小卖部）、arcade 电玩城、restaurant 餐厅。',
    properties: {
      place: { type: 'string', description: '地方 id 或中文名' },
      zone: { type: 'string', description: '可选：房间里的具体位置 id' },
    },
    required: ['place'],
  },
  {
    name: 'cabin_use',
    description: '用一件家具或东西：荡秋千(swing/swing)、钓鱼(pier/fish)、喂鱼(fish_tank/feed_fish)、泡汤(onsen_soak/soak)、开灯(xj_lamp/on)。东西不在当前房间也会自己走过去，做完返回真实结果。',
    properties: {
      object: { type: 'string', description: '东西的 id，如 swing、pier、fish_tank' },
      use: { type: 'string', description: '怎么用的 id，如 swing、fish、feed_fish' },
      item: { type: 'string', description: 'object=bag 或货架买时：商品 id' },
      feeling: { type: 'string', description: '可选：此刻的想法' },
    },
    required: ['object', 'use'],
  },
  {
    name: 'cabin_buy',
    description: '去小卖部买一样东西：走到货架挑、收银台付钱、进背包。零花钱和 12 格背包由游戏管，钱不够会失败。',
    properties: {
      product: { type: 'string', description: '商品 id，如 soda、bread、umbrella' },
      feeling: { type: 'string', description: '可选：想法' },
    },
    required: ['product'],
  },
  {
    name: 'cabin_eat',
    description: '吃、喝或使用背包里的小卖部商品（按种类自动判断）。用完才扣，被打断还在包里。餐厅买的菜要用 cabin_restaurant 的 eat。',
    properties: {
      product: { type: 'string', description: '背包里的商品 id' },
      feeling: { type: 'string', description: '可选：想法' },
    },
    required: ['product'],
  },
  {
    name: 'cabin_stop',
    description: '停下正在做的事；已付款/吃完的步骤不撤回。',
  },
  {
    name: 'cabin_task',
    description: '按任务编号查询动作的真实完成回执：running 还在执行、done 才算成功、failed 不能报成功。只在收到 status:"running" 时才用。',
    properties: {
      taskId: { type: 'string', description: '动作返回里的 taskId' },
    },
    required: ['taskId'],
  },
  {
    name: 'cabin_restaurant',
    description: '在餐厅点菜、自己做菜、端到桌边吃或坐下休息；先 action:"menu" 看今天有什么菜。',
    properties: {
      action: { type: 'string', description: 'menu 看菜单 / order 点菜 / cook 自己做 / eat 吃背包里的 / sit 坐一会儿 / status 看进度 / cancel 取消' },
      dish: { type: 'string', description: '菜的 id，如 restaurant-fried-rice（order/cook/eat 必填）' },
    },
    required: ['action'],
  },
  {
    name: 'cabin_catalog',
    description: '搜索所有房间里的家具和能做的事（含自制家具），不知道哪儿有什么的时候用。不带关键词就按编号翻页；一条也没有时换个词或清空关键词。',
    properties: {
      keyword: { type: 'string', description: '可选：要找的东西，比如 五子棋、日记、钓鱼、床' },
      offset: { type: 'number', description: '可选：翻页起点，用上一次返回里的 nextOffset' },
      limit: { type: 'number', description: '可选：这一页要几条，默认 20' },
    },
  },
  {
    name: 'cabin_process',
    description: '把要做的事排成活动：登记、提升主活动、提前收尾或停下。身体动作一次只做一件，其余排队；聊天、想事情可以并行。',
    properties: {
      action: { type: 'string', description: 'list 看现在有哪些活动 / start 登记一件 / promote 提到最前 / stop 停掉 / finish 收尾' },
      kind: { type: 'string', description: 'start 时：body 身体动作、chat 聊天、think 想事情、read 看东西' },
      tool: { type: 'string', description: 'start 且 kind=body 时：cabin_go / cabin_use / cabin_buy / cabin_eat / cabin_restaurant' },
      arguments: { type: 'object', description: 'start 时 tool 那件工具的原始参数' },
      label: { type: 'string', description: '可选：给这件活动起个名字' },
      role: { type: 'string', description: '可选：primary 主活动 / secondary 次要' },
      id: { type: 'string', description: 'promote、stop、finish 时的活动编号' },
    },
    required: ['action'],
  },
]
// 注意：上游 1.1 没有 cabin_arcade 这个工具，电玩城是 cabin_use 用机台的 id（来自 cabin_look），
// 所以兜底清单里也不放它——放进来模型会去调一个桥不认识的名字。

// 默认暴露给模型的：常用的那几个，全部来自桥的工具清单（模块不再自造工具名）。
export const CORE = ['cabin_status', 'cabin_look', 'cabin_catalog', 'cabin_go', 'cabin_use', 'cabin_buy', 'cabin_eat', 'cabin_stop', 'cabin_restaurant', 'cabin_sleep', 'cabin_toolpose', 'cabin_task', 'cabin_process']
/**
 * 从桥的工具清单生成模块工具定义。
 * 优先读副本（bridge-host，含我们把睡觉/姿势加进去的那两个），没有就读官方 bridge/。
 * 只留 CORE（常用的那几个）：桥清单里还有多住户、家具、更新等 20 多个，全挂给模型太费 token。
 */
export function loadSpecs({ hostDir, bridgeDir, log = null }) {
  const dirs = [hostDir, bridgeDir].filter(Boolean)
  for (const dir of dirs) {
    let tools = null
    try { tools = JSON.parse(fs.readFileSync(path.join(String(dir).trim(), 'openai-tools.json'), 'utf8')).tools } catch (e) { continue }
    if (!Array.isArray(tools) || !tools.length) continue
    const specs = []
    for (const item of tools) {
      const fn = item && item.function
      if (!fn || !fn.name) continue
      const params = fn.parameters || {}
      specs.push({
        name: fn.name,
        description: String(fn.description || '').trim(),
        properties: params.properties || {},
        required: Array.isArray(params.required) ? params.required : [],
      })
    }
    const keep = specs.filter(function (s) { return CORE.indexOf(s.name) >= 0 })
    if (keep.length) return keep
  }
  if (log && log.warn) log.warn('小屋世界：读不到桥的工具清单，先用内置的短清单')
  return TOOL_SPECS
}
