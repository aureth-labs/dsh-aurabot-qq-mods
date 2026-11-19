// 地点中文名 → id。/小屋 去 公园 用得到。

const PLACES = [
  { id: 'xjhome', names: ['小鲸鱼家', '家', '小屋', '回家', 'xjhome'] },
  { id: 'park', names: ['公园', '小屋旁的公园', 'park'] },
  { id: 'shop', names: ['小卖部', '商店', '买东西', 'shop'] },
  { id: 'onsen', names: ['汤屋', '温泉', '泡汤', 'onsen'] },
  { id: 'arcade', names: ['电玩城', '游戏厅', 'arcade'] },
  { id: 'restaurant', names: ['餐厅', '饭店', 'restaurant'] },
]

export const PLACE_LIST = PLACES.map(p => p.id + ' ' + p.names[0]).join('、')

export function resolvePlace(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  // 含否定词（不去 / 别去 / 勿 / 没去）一律不认，免得把否定当成想去。
  if (/[不别勿没]/.test(raw)) return null
  const lower = raw.toLowerCase()
  for (const p of PLACES) {
    if (p.id === lower) return p.id
  }
  for (const p of PLACES) {
    for (const n of p.names) {
      if (n.toLowerCase() === lower) return p.id
    }
  }
  // 只认「名称以输入开头」或「输入以名称开头」且唯一的匹配，多个候选就不猜。
  const hits = new Set()
  for (const p of PLACES) {
    for (const n of p.names) {
      const name = n.toLowerCase()
      if (name.startsWith(lower) || lower.startsWith(name)) hits.add(p.id)
    }
  }
  return hits.size === 1 ? Array.from(hits)[0] : null
}
