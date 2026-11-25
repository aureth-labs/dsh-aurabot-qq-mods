export default {
  id: 'group-mention-etiquette', name: '群友互相 @ 时不插话', version: '1.0.0', api: 1,
  description: '群友 @ 别人时只旁听；也叫到机器人时，仍按原设置回复。',
  setup(api) {
    api.on('group/decide', (decision, { msg }) => {
      if (msg.atOthers !== true || msg.mentioned || !decision.reply) return
      if (decision.mode !== 'engaged' && decision.mode !== 'interject') return
      return { ...decision, reply: false, mode: 'none', reason: '这条在 @ 别人，旁听' }
    })
  },
}
