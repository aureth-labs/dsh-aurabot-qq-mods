// lib/room/navigate.mjs —— 进直播间/主播主页的导航（幂等，不刷新已在的房间）。
import { LIVE_RE, liveRoomId, isLiveUrl } from '../util.mjs'
export function createNavigator({ api, ctx, note, ensureBrowser, currentUrl, navigate, enterFromProfile, saveState, loadState }) {
    async function ensureInRoom(overrideTarget) {
      const s = api.settings()
      const target = String(overrideTarget || s.target || '').trim()
      if (!target) return { ok: false, message: '还没填直播间地址或主播主页' }

      await ensureBrowser()
      let url = await currentUrl()
      if (!url) {
        try { ctx.cdp?.close() } catch {}
        ctx.cdp = null
        await ensureBrowser()
        url = await currentUrl()
      }

      // 已经在直播间里就留着，别刷新 —— 刷新会把播放和评论都打断。
      // 只有明确指定了另一个直播间（id 不同）才换房。
      //
      // 2026-11-10 修 BUG：原来只比房间号（wantId）。目标是**主播主页**时 wantId 取不到，
      //   于是 `!wantId` 直接当成「同一个房间」返回 —— 主人换了主播，模块还挂在老主播的房间里，
      //   灯牌也送给老主播去了。现在多比一个「上次是用哪个目标进的」（记在 state 里），
      //   目标变了就换房；目标是房间号时仍然按房间号比。
      const lastTarget = String((loadState() || {}).lastTarget || '')
      const sameTarget = !lastTarget || lastTarget === target
      if (isLiveUrl(url)) {
        const curId = liveRoomId(url)
        const wantId = liveRoomId(target) || (/^\d{6,}$/.test(String(target).trim()) ? String(target).trim() : '')
        if (wantId && curId) {
          if (wantId === curId && sameTarget) return { ok: true, url, joined: false }
        } else if (sameTarget) {
          return { ok: true, url, joined: false }
        }
        note('目标变了（' + (target || '?') + '），换房', 'debug')
      }

      if (isLiveUrl(target)) {
        const want = target.trim()
        await navigate(want)
        saveState({ lastTarget: target })
        note('进了直播间：' + want)
        return { ok: true, url: want, joined: true, roomId: liveRoomId(want) }
      }
      // 只给了房间号的情况
      if (/^\d{6,}$/.test(String(target).trim())) {
        const one = 'https://live.douyin.com/' + String(target).trim()
        await navigate(one)
        saveState({ lastTarget: target })
        note('进了直播间：' + one)
        return { ok: true, url: one, joined: true, roomId: liveRoomId(one) }
      }
      if (/douyin\.com\/user\//.test(target)) {
        const how = await enterFromProfile(target)
        const now = await currentUrl()
        if (how && LIVE_RE.test(now)) {
          saveState({ lastTarget: target })
          note('主播在播，已经进去了：' + now)
          return { ok: true, url: now, joined: true }
        }
        note('主播现在没在播（页面停在主页）', 'debug')
        return { ok: true, url: now, joined: false, message: '现在没在播' }
      }
      if (/^https?:\/\//.test(target)) {
        await navigate(target)
        saveState({ lastTarget: target })
        return { ok: true, url: target, joined: true }
      }
      throw new Error('地址看不懂，填 https://live.douyin.com/... 或 https://www.douyin.com/user/...')
    }

  return { ensureInRoom }
}
