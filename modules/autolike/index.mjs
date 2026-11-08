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
    let day = ''
    let today = 0

    const rollDay = () => {
      const d = new Date().toLocaleDateString('sv-SE')
      if (d !== day) {
        day = d
        today = 0
      }
    }

    const sendLike = async (qq, times) => {
      try {
        await api.onebot('send_like', { user_id: Number(qq), times: Math.min(50, Math.max(1, times)) })
        api.log.info('[autolike] 给 ' + qq + ' 回赞 ' + times + ' 下')
      } catch (error) {
        api.log.warn('[autolike] 回赞失败 ' + qq + '：' + (error && error.message))
      }
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
      await sendLike(uid, Number(st.times ?? 10))
    })

    // 爸爸直接说「赞我」，就给他点（说完她照常回话）
    api.on('message', async (msg) => {
      const text = String((msg && msg.text) || '').trim()
      if (!/^(赞我|给我点赞|给我点个赞|点个赞|点满)$/.test(text)) return false
      const cfg = api.config() || {}
      const owner = Number(cfg.ownerQQ || 0)
      if (!owner || Number(msg.userId) !== owner) return false
      await sendLike(owner, Number((api.settings() || {}).times ?? 10))
      return false
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
