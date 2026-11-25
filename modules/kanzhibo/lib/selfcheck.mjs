// lib/selfcheck.mjs —— 自检文本（面板/命令共用）。
import { existsSync } from 'node:fs'
import { VERSION } from './util.mjs'
export function createSelfCheck(deps) {
  const { api, ctx, findBrowser, profileDir, livePort, endedSignals, inWindow, clampCheckSec, getTickAnchor, dayKey, SAY_MAX_CHARS, sayWaitSec, gate, worklog, stateFile, getCommentedDay, getLastNote, currentUrl } = deps
    async function selfCheck() {
      const s = api.settings()
      const bin = findBrowser(api.settings().browserPath)
      const dir = profileDir()
      const cfg = api.config()
      const douyinOn = Boolean((cfg.douyin || {}).enabled)
      const url = ctx.cdp ? await currentUrl() : ''
      const leftoverPort = ctx.cdp ? 0 : await livePort()
      const ended = ctx.cdp ? await endedSignals().catch(() => '') : ''
      return [
        '看直播自检（v' + VERSION + '）',
        '浏览器：' + (bin || '没找到 Edge / Chrome'),
        '专用 profile：' + (existsSync(dir) ? dir : '还没建（第一次进房时才建）'),
        'CDP：' + (ctx.cdp ? '连着，端口 ' + ctx.port : (leftoverPort ? '没连，但发现残留浏览器（端口 ' + leftoverPort + '）' : '没连')) +
          (ended ? '｜页面提示：' + ended : '') +
          (url ? '｜当前页：' + url.slice(0, 80) : ''),
        '挂直播：' + (s.enabled ? '开' : '关') + '｜目标：' + (s.target || '没填'),
        '时段：' + (s.schedule ? s.startTime + '-' + s.endTime + '（' + (inWindow() ? '在时段内' : '不在时段内，不进房（到点浏览器也会关）') + '）' : '不限'),
        '检查间隔：' + clampCheckSec() + ' 秒' +
          (getTickAnchor() ? '（从 ' + new Date(getTickAnchor()).toLocaleTimeString() + ' 开始算，下次约 ' +
            new Date(getTickAnchor() + Math.ceil((Date.now() - getTickAnchor() + 1) / (clampCheckSec() * 1000)) * clampCheckSec() * 1000).toLocaleTimeString() + '）' : ''),
        '刷抖音：' + (douyinOn ? '照常（不归这个模块管）' : '关着（不归这个模块管）'),
        '今日评论：' + (s.liveCommentOn ? (getCommentedDay() === dayKey() ? '开·今天发过' : '开·今天还没发') : '关'),
        '今日灯牌：' + (s.renewBadge ? (ctx.badgeDay === dayKey() ? '今天送过' : '今天还没送') : '关') +
          (ctx.badgeGiveUpDay === dayKey() ? '（今天已放弃自动，改成提醒你）' : ''),
        '私信送礼：' + (s.giftByDm ? '开（只认主人的私聊）' : '关（她不会送）'),
        '私信弹幕：在直播间里就能发（命令 /看直播 说、工具、面板三条路共用 10 秒冷却；字数上限 ' + SAY_MAX_CHARS + '）' +
          (sayWaitSec() ? '｜冷却中，还有 ' + sayWaitSec() + ' 秒' : '') +
          (ctx.cdp ? '' : '｜现在不在直播间，先 /看直播 进'),
        '今日弹幕：' + ((ctx.sayLog.day === dayKey() && ctx.sayLog.items.length) ? ctx.sayLog.items.length + ' 条，最近「' + ctx.sayLog.items[ctx.sayLog.items.length - 1].text + '」' : '还没发过'),
        '打法：' + (s.semiAuto ? '半自动（点之前截图发你，等你回 /看直播 确认）' : '自动（直接点，仍然过命中校验）'),
        '视口：' + (ctx.viewport ? ctx.viewport.w + '×' + ctx.viewport.h + ' · DPR ' + ctx.viewport.dpr + ' · 缩放 ' + ctx.viewport.scale : '还没读（进房后才有）') +
          (ctx.viewport && ctx.viewport.w >= 1500 ? '（已最大化）' : ''),
        '待确认：' + (gate.peek() ? gate.peek().label + '（' + Math.round((gate.peek().deadline - Date.now()) / 1000) + ' 秒后作废）' : '没有'),
        '操作记录：只写本地 jsonl（面板「操作记录」可看）｜今天 ' + worklog.count + ' 步',
        '状态文件：' + stateFile(),
        '最近一条：' + (getLastNote() || '（还没有）'),
      ].join('\n')
    }

  return { selfCheck }
}
