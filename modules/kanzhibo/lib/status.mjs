// lib/status.mjs —— 状态一句话（工具/命令/面板共用）。
export function createStatus({ api, ctx, currentUrl, inWindow, gate, dayKey, getCommentedDay, getLastNote }) {
    const statusLine = async (showDetail = true) => {
      const s = api.settings()
      const url = ctx.cdp ? (await currentUrl()).slice(0, 70) : '没开浏览器'
      const window = s.schedule ? `${s.startTime}-${s.endTime}（${inWindow() ? '在时段内' : '不在时段内'}）` : '不限时段'
      const head = '挂直播：' + (s.enabled ? '开' : '关') +
        '｜时段：' + window + '｜模式：' + (s.semiAuto ? '半自动' : '自动')
      if (!showDetail) return head
      const wait = gate.peek()
      return head +
        '｜目标：' + (s.target || '没填') +
        '｜进房评论：' + (s.liveCommentOn ? (getCommentedDay() === dayKey() ? '开·今天发过（不再发）' : '开·今天还没发') : '已关闭') +
        '｜私信送礼：' + (s.giftByDm ? '开' : '关') +
        '｜现在：' + url +
        (wait ? '\n待确认：' + wait.label + '（回 /看直播 确认 或 /看直播 取消）' : '') +
        (getLastNote() ? '\n最近：' + getLastNote() : '')
    }

  return { statusLine }
}
