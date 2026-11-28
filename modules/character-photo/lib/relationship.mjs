import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import original from '../relationship/index.mjs'

const legacyId = 'character-relation'
const draining = Symbol.for('aurabot.sim-life.relationship.draining.v1')

export async function startRelationship(api) {
  // During a staged install, the independent provider keeps owning its hooks and database.
  // The host redirects the nested panel routes to it until the old package is removed.
  if (api.dir && existsSync(join(dirname(api.dir), legacyId, 'index.mjs')) && api.config().modules?.[legacyId]?.enabled !== false) return null
  let stopped = false
  api.onDispose?.(() => { stopped = true })
  if (globalThis[draining]) await globalThis[draining]
  if (stopped) throw Error('模拟人生已停止启动')

  const settings = () => ({ ...original.defaults, ...api.config().ext?.[legacyId] })
  let closeRelationship
  const adapter = {
    ...api,
    config: () => api.settings().enabled === false ? { ...api.config(), enabled: false } : api.config(),
    settings,
    saveSettings(patch) {
      api.setConfig(cfg => ({ ...cfg, ext: { ...cfg.ext, [legacyId]: { ...cfg.ext?.[legacyId], ...patch } } }))
      return settings()
    },
    // Host backup, reset, delete and rollback all refer to this established directory.
    dataDir: (...parts) => join(dirname(api.dataDir()), legacyId, ...parts),
    route: (path, handler, options) => api.route('/relation' + path, handler, options),
    onDispose(dispose) {
      closeRelationship = () => {
        const closed = dispose()
        globalThis[draining] = closed
        const clear = () => { if (globalThis[draining] === closed) delete globalThis[draining] }
        closed.then(clear, clear)
        return closed
      }
      api.onDispose?.(closeRelationship)
    },
  }
  try {
    const exports = original.setup(adapter)
    return { ...exports, dispose: closeRelationship }
  } catch (error) {
    await closeRelationship?.()
    throw error
  }
}
