import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ID = 'mimo-modelscope'
const KEY = 'aurabot.mimo-modelscope.local.v1'
const preferences = { tts: 'attachVoice', image: 'attachImage' }

function adapter(slot) {
  return [
    '// 由 Aurabot 模块 mimo-modelscope 安装。',
    "import { realpathSync } from 'node:fs'",
    "import { fileURLToPath } from 'node:url'",
    ...(slot === 'image' ? ['export const supportsImage = true'] : []),
    'export default async function (input) {',
    "  const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))",
    "  const run = globalThis[Symbol.for('" + KEY + "')]?.get(root)?." + slot,
    "  if (!run) throw new Error('请启用「MiMo 语音与魔搭生图」，或在 Aurabot 本地接口页关闭此接管')",
    '  return run(input)',
    '}',
    '',
  ].join('\n')
}

export function localBindings(api, providers, ready) {
  const root = realpathSync(resolve(api.dataDir(), '..', '..'))
  const directory = join(root, 'local')
  const symbol = Symbol.for(KEY)
  const instances = globalThis[symbol] ??= new Map()
  instances.set(root, providers)

  const known = Object.keys(preferences)
  const path = (slot) => join(directory, slot + '.mjs')
  function ownership(slot) {
    try {
      const file = path(slot)
      const info = lstatSync(file)
      const content = adapter(slot)
      return info.isFile() && info.size === Buffer.byteLength(content) && readFileSync(file, 'utf8') === content ? 'ours' : 'other'
    } catch (error) {
      if (error.code === 'ENOENT') return 'missing'
      throw error
    }
  }

  function install(slot) {
    const state = ownership(slot)
    if (state === 'ours') return
    if (state === 'other') throw new Error('已有本地 ' + slot + '.mjs，请先在本地接口页处理冲突')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path(slot), adapter(slot), { flag: 'wx' })
  }

  function remove(slot) {
    if (ownership(slot) === 'ours') unlinkSync(path(slot))
  }

  function reconcile(cfg = api.config(), before) {
    const settings = api.settings()
    const localPatch = {}
    const preferencePatch = {}
    for (const slot of known) {
      const preference = preferences[slot]
      try {
        const state = ownership(slot)
        const configured = Boolean(cfg.local?.[slot])
        if (state === 'other') continue
        if (state === 'ours' && before?.local?.[slot] && !configured) {
          // 尊重用户在 Aurabot「本地接口」里关掉的接管。
          remove(slot)
          if (settings[preference]) preferencePatch[preference] = false
        } else if (settings[preference] && ready[slot](settings)) {
          if (state === 'missing') install(slot)
          if (!configured) localPatch[slot] = true
        } else if (state === 'ours') {
          remove(slot)
          if (configured) localPatch[slot] = false
        }
      } catch (error) {
        api.log.warn('处理本地接口 ' + slot + ' 失败：' + error.message)
      }
    }
    const patch = {}
    if (Object.keys(localPatch).length) patch.local = localPatch
    if (Object.keys(preferencePatch).length) patch.ext = { [ID]: preferencePatch }
    if (Object.keys(patch).length) api.setConfig(patch)
  }

  api.onDispose(() => {
    if (instances.get(root) !== providers) return
    instances.delete(root)
    for (const slot of known) {
      try { remove(slot) } catch (error) { api.log.warn('清理本地接口 ' + slot + ' 失败：' + error.message) }
    }
    if (!instances.size) delete globalThis[symbol]
  })
  api.on('config', reconcile)
  reconcile()

  function set(slot, enabled) {
    if (!Object.hasOwn(preferences, slot)) throw new Error('未知的本地接口')
    if (enabled && ownership(slot) === 'other') throw new Error('已有本地 ' + slot + '.mjs，请先在本地接口页处理冲突')
    api.saveSettings({ [preferences[slot]]: enabled })
    return status()[slot]
  }

  function status() {
    const settings = api.settings()
    const local = api.config().local
    return Object.fromEntries(known.map((slot) => {
      const state = ownership(slot)
      return [slot, {
        enabled: Boolean(settings[preferences[slot]]),
        ready: ready[slot](settings),
        active: state === 'ours' && Boolean(local?.[slot]),
        conflict: state === 'other',
      }]
    }))
  }

  return { set, status }
}
