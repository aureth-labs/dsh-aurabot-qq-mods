// lib/room/specs.mjs —— 定位规格/按钮文案（纯常量，从 index 搬出）。
const escapeRe = (s) => String(s || '').replace(/[\\\^\$\.\*\+\?\(\)\[\]\{\}\|]/g, '\\$&')
export const TASK_ENTRY_EXPR = `(() => {
    const nodes = [...document.querySelectorAll('div,span,button,a')].filter((el) => {
      const r = el.getBoundingClientRect()
      if (!(r.width > 8 && r.height > 8 && r.top < innerHeight * 0.75 && r.left < innerWidth * 0.7)) return false
      const t = (el.innerText || '').trim()
      return t && t.length < 30 && /今日任务/.test(t)
    })
    if (!nodes.length) return null
    nodes.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
    return nodes[0]
  })()`

export const BADGE_ENTRY_SPEC = {
  text: '粉丝团|灯牌|加入粉丝团|点亮灯牌|续灯牌|今日任务',
  region: { top: 0, left: 0, right: 0.42, bottom: 0.78 },
  maxTextLen: 24,
  maxWidth: 220,
  maxHeight: 90,
}

export const BADGE_CONFIRM_TEXTS = [
  '^送灯牌$',                                  // 正常续灯牌
  '^送\\s*1\\s*个\\s*基础\\s*灯牌$',           // 2026-11-09 起抖音的实际文案
  '^送\\s*1\\s*个\\s*灯牌$',
  '^送\\s*1\\s*个?$',
  '^赠送$',
  '^点亮\\s*[（(]\\s*\\d+\\s*钻\\s*[）)]$',   // 点亮（1钻）
  '^点亮$',
  '^续费$',
  '^送出$',
  '^一键点亮$',
  '^立即续费$',
]

export const BADGE_CONFIRM_SPEC = {
  text: '^(赠送|点亮|续费|送出|一键点亮|立即续费|送1个|送灯牌|点亮灯牌|送1个基础灯牌|送1个灯牌)(\\s*[（(][^）)]{0,8}[）)])?$',
  region: { top: 0.02, left: 0.2, right: 0.8, bottom: 0.9 },
  maxTextLen: 14,
  maxWidth: 260,
  maxHeight: 100,
  // 观众列表里也有「点亮」，靠祖先里那句「点亮粉丝团恢复勋章」把面板认出来
  ancestorText: '点亮粉丝团|恢复勋章|粉丝团灯牌|灯牌',
  // 1.0.3：星守护/展馆那排「加油鸭 差10个点亮 [点亮]」「点亮送10个150钻」不是灯牌，
  //   它们的祖先文字长这样，按反面筛排掉（只看上两层，别误杀整块面板）。
  excludeAncestor: '差\\s*\\d+\\s*个|点亮送\\s*\\d+\\s*个|集星|展馆|星守护',
}

export const GIFT_CELL_SPEC = (name) => ({
  text: escapeRe(name),
  region: { top: 0.08, left: 0.33, right: 0.86, bottom: 0.86 },
  maxTextLen: 26,
  maxWidth: 300,
  maxHeight: 170,
})

export const GIFT_CONFIRM_SPEC = {
  text: '^(赠送|发送|送出|立即赠送|赠送一个|送\\s*1)(\\s*[（(][^）)]{0,8}[）)])?$',
  region: { top: 0.08, left: 0.3, right: 0.92, bottom: 0.88 },
  maxTextLen: 12,
  maxWidth: 260,
  maxHeight: 120,
  ancestorText: '礼物|赠送|背包',
}
