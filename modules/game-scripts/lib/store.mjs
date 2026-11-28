// 脚本目录的读写。所有路径都先过 normalizeName + scriptPath，符号链接一律不碰。
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { normalizeName, scriptPath, ScriptError } from './policy.mjs'

export function createStore(getConfig) {
  async function ensureDir() {
    const { scriptDir } = getConfig()
    try {
      await mkdir(scriptDir, { recursive: true })
    } catch (error) {
      throw new ScriptError(`建不了脚本目录：${error.message}`)
    }
    const stat = await lstat(scriptDir).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new ScriptError(`脚本目录不可用：${scriptDir}`)
    return scriptDir
  }

  async function statSafe(file, name) {
    const stat = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') throw new ScriptError(`没有叫「${name}」的脚本`)
      throw new ScriptError(`读不了「${name}」：${error.message}`)
    })
    if (stat.isSymbolicLink()) throw new ScriptError(`「${name}」是符号链接，不碰`)
    if (!stat.isFile()) throw new ScriptError(`「${name}」不是文件`)
    return stat
  }

  async function list() {
    const config = getConfig()
    await ensureDir()
    const entries = await readdir(config.scriptDir, { withFileTypes: true })
    const result = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith(config.ext)) continue
      const name = entry.name.slice(0, -config.ext.length)
      try {
        normalizeName(name)
      } catch {
        continue
      }
      const file = scriptPath(config, name)
      const stat = await lstat(file).catch(() => null)
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue
      result.push({ name, bytes: stat.size, updatedAt: stat.mtimeMs })
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    return result.slice(0, 100)
  }

  async function read(nameInput) {
    const config = getConfig()
    const name = normalizeName(nameInput)
    const file = scriptPath(config, name)
    const stat = await statSafe(file, name)
    if (stat.size > config.maxScriptBytes) {
      throw new ScriptError(`「${name}」有 ${Math.ceil(stat.size / 1024)} KB，超过 ${config.maxScriptBytes / 1024} KB 上限`)
    }
    return { name, file, code: await readFile(file, 'utf8'), bytes: stat.size }
  }

  async function save(nameInput, codeInput, { overwrite = false } = {}) {
    const config = getConfig()
    const name = normalizeName(nameInput)
    const code = String(codeInput ?? '').replace(/^\uFEFF/, '')
    if (!code.trim()) throw new ScriptError('脚本内容是空的')
    if (code.includes('\u0000')) throw new ScriptError('脚本里不能有 NUL 字符')
    const bytes = Buffer.byteLength(code, 'utf8')
    if (bytes > config.maxScriptBytes) {
      throw new ScriptError(`脚本有 ${Math.ceil(bytes / 1024)} KB，超过 ${config.maxScriptBytes / 1024} KB 上限`)
    }
    await ensureDir()
    const file = scriptPath(config, name)
    const existing = await lstat(file).catch(() => null)
    if (existing && existing.isSymbolicLink()) throw new ScriptError(`「${name}」是符号链接，不覆盖`)
    if (existing && !overwrite) throw new ScriptError(`「${name}」已经存在；要覆盖就让 overwrite=true`)
    try {
      await writeFile(file, code, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' })
    } catch (error) {
      if (error.code === 'EEXIST') throw new ScriptError(`「${name}」已经存在；要覆盖就让 overwrite=true`)
      throw new ScriptError(`写不了「${name}」：${error.message}`)
    }
    return { name, file, bytes }
  }

  async function remove(nameInput) {
    const config = getConfig()
    const name = normalizeName(nameInput)
    const file = scriptPath(config, name)
    await statSafe(file, name)
    await unlink(file)
    return { name }
  }

  return { list, read, save, remove, ensureDir }
}
