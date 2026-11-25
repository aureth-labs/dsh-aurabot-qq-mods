import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const sharedWorkspace = '/workspace/AuraBotDoc'
const cacheFolder = 'daily-art-images'
const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }

export function defaultImageCacheDir(api) {
  return existsSync(sharedWorkspace) ? join(sharedWorkspace, cacheFolder) : api.dataDir(cacheFolder)
}

export async function saveCachedImage(getDirectory, source, bytes, type, log) {
  if (!getDirectory) return
  let temporary
  try {
    const directory = getDirectory()
    if (!directory) return
    if (!isAbsolute(directory)) throw new Error('缓存目录须为绝对路径')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const target = join(directory, `${source}-${hash}${extensions[type]}`)
    await mkdir(directory, { recursive: true })
    temporary = target + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, target)
    temporary = undefined
  } catch (error) {
    log?.warn?.('图片缓存保存失败：' + (error.code || error.message))
  } finally {
    if (temporary) await unlink(temporary).catch(() => {})
  }
}
