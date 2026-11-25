export function isOwner(cfg, msg) {
  return Boolean(cfg.ownerQQ) && String(msg.userId) === String(cfg.ownerQQ)
}

export function allowsSearch(cfg, settings, msg) {
  if (!cfg.enabled) return false
  if (msg.kind === 'group') return (cfg.allow?.groups || []).map(String).includes(String(msg.groupId))
  if (msg.kind !== 'private') return false
  if (isOwner(cfg, msg)) return cfg.ownerLevel !== 'chat'
  return settings.allowPrivateWhitelistSearch === true && (cfg.allow?.private || []).map(String).includes(String(msg.userId))
}
