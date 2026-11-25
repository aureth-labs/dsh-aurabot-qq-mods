// 自动回赞：有人给大肥鱼的资料点赞，就顺手给那个人也点一下。
// 听 OneBot 原始事件里的 notice（notify / like），用 send_like 回赞。

export default {
  id: 'autolike',
  name: '自动回赞',
  version: '1.0.0',
  api: 1,
  description: '有人给大肥鱼点资料赞时，自动给对方的 QQ 回一个赞',
  defaults: { enabled: true, times: 10, maxPerDay: 200, onlyOwner: false, cooldownMin: 30 },
  settings: [
    { key: 'enabled', label: '开启自动回赞', type: 'switch' },
    { key: 'times', label: '每次点几下（1-50）', type: 'number', hint: '电脑端最多 50 下' },
    { key: 'maxPerDay', label: '每天最多回赞多少人', type: 'number' },
    { key: 'cooldownMin', label: '同一个人多少分钟内不重复回赞', type: 'number' },
    { key: 'onlyOwner', label: '只回爸爸的赞', type: 'switch' },
  ],

  setup(api) {
    const last = new Map() // qq -> 时间戳，防止同一个人一直刷
    const likedDay = new Map() // qq -> 今天已经给他回过赞的日期，用来回「别贪心哦」
    let day = ''
    let today = 0

    const rollDay = () => {
      const d = new Date().toLocaleDateString('sv-SE')
      if (d !== day) {
        day = d
        today = 0
        likedDay.clear()
      }
    }

    const alreadyLikedToday = (qq) => {
      rollDay()
      return likedDay.get(Number(qq)) === day
    }

    const sendLike = async (qq, times) => {
      let left = Math.min(50, Math.max(1, Math.round(Number(times) || 1)))
      let done = 0
      while (left > 0) {
        const batch = Math.min(20, left) // QQ 一次最多认 20 下，多了报「点赞数无效」
        try {
          await api.onebot('send_like', { user_id: Number(qq), times: batch })
          done += batch
          left -= batch
        } catch (error) {
          api.log.warn('[autolike] 回赞失败 ' + qq + '（已点 ' + done + ' 下）：' + (error && error.message))
          break
        }
      }
      if (done > 0) api.log.info('[autolike] 给 ' + qq + ' 回赞 ' + done + ' 下')
      return done
    }

    api.on('onebot', async (ev) => {
      if (!ev || ev.post_type !== 'notice') return
      const st = api.settings() || {}
      if (st.enabled === false) return
      const like = (ev.notice_type === 'notify' && ev.sub_type === 'like') || ev.notice_type === 'like'
      if (!like) return

      const uid = Number(ev.user_id || 0)
      if (!uid) return
      const bot = String((api.config() || {}).botQQ || '')
      if (ev.target_id && bot && String(ev.target_id) !== bot) return // 不是赞我，不管
      if (uid === Number(bot)) return

      if (st.onlyOwner) {
        const owner = Number((api.config() || {}).ownerQQ || 0)
        if (!owner || uid !== owner) return
      }

      const gap = Math.max(0, Number(st.cooldownMin ?? 30)) * 60_000
      const now = Date.now()
      if (gap && last.has(uid) && now - last.get(uid) < gap) return

      rollDay()
      const max = Math.max(1, Number(st.maxPerDay ?? 200))
      if (today >= max) return

      last.set(uid, now)
      today += 1
      const done = await sendLike(uid, Number(st.times ?? 10))
      // 悄悄点，不回任何消息；记下今天已经回过了
      if (done > 0) likedDay.set(uid, day)
    })

    // 任何人说「赞我」（带不带斜杠都行），就给他点满（说完她照常回话）
    api.on('message', async (msg) => {
      const text = String((msg && msg.text) || '').trim().replace(/^[/／]\s*/, '')
      if (!/^(赞我|给我点赞|给我点个赞|点个赞|点满)$/.test(text)) return false
      if (!msg || !msg.userId) return false
      const cfg = api.config() || {}
      if (Number(msg.userId) === Number(cfg.botQQ || 0)) return false
      const st = api.settings() || {}
      if (st.enabled === false) return false
      // 今天已经自动回过他的赞了，就别再点，嘴上告诉他一声
      if (alreadyLikedToday(msg.userId)) return '别贪心哦 已经给你点过赞了'
      await sendLike(msg.userId, Number(st.times ?? 50))
      return false
    })

    api.command({
      name: '赞我',
      aliases: ['点赞我', '给我点赞'],
      desc: '给说这句话的人点个赞',
      run: async (arg, msg) => {
        const st = api.settings() || {}
        if (st.enabled === false) return '自动回赞关着呢'
        if (alreadyLikedToday(msg.userId)) return '别贪心哦 已经给你点过赞了'
        const times = Number(st.times ?? 10)
        try {
          const done = await sendLike(msg.userId, times)
          if (done > 0) {
            likedDay.set(Number(msg.userId), day)
            return '给你点了 ' + done + ' 下'
          }
          return '没点上，QQ 那边不肯收（大概是今天同一好友的点赞上限到了）'
        } catch (e) {
          return '点赞没成功：' + (e && e.message ? e.message : e)
        }
      },
    })

    api.command({
      name: '回赞',
      aliases: ['回赞开关', 'autolike'],
      desc: '看回赞状态，/回赞 10 可以改每次点几下',
      run: (arg) => {
        const st = api.settings() || {}
        if (arg && /^\d+$/.test(arg.trim())) {
          const times = Math.min(50, Math.max(1, Number(arg.trim())))
          api.saveSettings({ times })
          return '好 以后一次点 ' + times + ' 下'
        }
        return '自动回赞：' + (st.enabled === false ? '关着' : '开着') + '，一次 ' + (st.times ?? 10) + ' 下，今天已回 ' + today + '/' + (st.maxPerDay ?? 200)
      },
    })
  },
}

