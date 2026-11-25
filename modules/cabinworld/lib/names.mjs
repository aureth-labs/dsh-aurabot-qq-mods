// aurabot 侧的名字来源：当前人格名 → 机器人 QQ 昵称。
// 只读，不修改任何配置。

export function personaName(api) {
  try {
    const cfg = api.config ? api.config() : null
    const id = cfg && cfg.persona && cfg.persona.current ? String(cfg.persona.current) : ''
    const people = api.core && api.core.personas
    if (people && typeof people.read === 'function' && id) {
      const got = people.read(id)
      if (got && got.name) return String(got.name)
    }
    if (people && typeof people.list === 'function') {
      const list = people.list() || []
      const hit = list.find(function (x) { return x && x.id === id })
      if (hit && hit.name) return String(hit.name)
    }
    return id
  } catch { return '' }
}

export async function qqNickname(api) {
  try {
    const got = await api.onebot('get_login_info', {})
    const nick = got && (got.nickname || (got.data && got.data.nickname))
    return String(nick || '')
  } catch { return '' }
}
