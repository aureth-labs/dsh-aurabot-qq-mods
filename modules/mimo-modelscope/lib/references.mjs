import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { audioMime, decodeReference, REFERENCE_LIMIT } from './providers.mjs'

const BUNDLED = { id: 'bundled', name: '懒羊羊.wav', bundled: true }
const UPLOAD_ID = /^ref-[a-f0-9-]{36}\.(wav|mp3)$/

function filename(value, fallback) {
  const name = typeof value === 'string' ? value.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 180) : ''
  return name || fallback
}

export function referenceStore(api) {
  const directory = api.dataDir('reference')
  const bundledPath = join(api.dir, 'assets', BUNDLED.name)
  mkdirSync(directory, { recursive: true })

  function pathOf(id) {
    return id === BUNDLED.id ? bundledPath : join(directory, id)
  }

  function available(id) {
    try {
      const file = lstatSync(pathOf(id))
      return file.isFile() && file.size > 0 && file.size <= REFERENCE_LIMIT
    } catch {
      return false
    }
  }

  function list(settings) {
    const uploads = new Map()
    for (const entry of Array.isArray(settings.references) ? settings.references : []) {
      if (typeof entry?.id !== 'string' || !UPLOAD_ID.test(entry.id) || uploads.has(entry.id) || !available(entry.id)) continue
      const name = ['之前上传的参考音频', '已上传的参考音频'].includes(entry.name) ? '' : entry.name
      uploads.set(entry.id, { id: entry.id, name: filename(name, '参考音频' + entry.id.slice(-4)) })
    }
    // 旧版本只保存了当前文件的内部名称。
    const legacy = settings.referenceFile
    if (typeof legacy === 'string' && UPLOAD_ID.test(legacy) && !uploads.has(legacy) && available(legacy)) {
      uploads.set(legacy, { id: legacy, name: '参考音频' + legacy.slice(-4) })
    }
    const references = [...uploads.values()]
    if (available(BUNDLED.id)) references.unshift(BUNDLED)
    return references
  }

  function status(settings) {
    const references = list(settings)
    const currentReference = references.find(({ id }) => id === settings.referenceFile) || references[0] || null
    return { references, currentReference }
  }

  async function read(settings, signal) {
    const { currentReference } = status(settings)
    if (!currentReference) throw new Error('请先上传一段 WAV 或 MP3 参考音频')
    return readFile(pathOf(currentReference.id), { signal })
  }

  function uploaded(settings) {
    return list(settings).filter(({ bundled }) => !bundled)
  }

  function upload({ base64, name }) {
    const bytes = decodeReference(base64)
    const ext = audioMime(bytes) === 'audio/wav' ? '.wav' : '.mp3'
    const id = 'ref-' + randomUUID() + ext
    const references = [...uploaded(api.settings()), { id, name: filename(name, '参考音频' + ext) }]
    const file = pathOf(id)
    writeFileSync(file, bytes, { flag: 'wx' })
    try { api.saveSettings({ references, referenceFile: id }) } catch (error) {
      unlinkSync(file)
      throw error
    }
  }

  function select(id) {
    const references = list(api.settings())
    if (!references.some((item) => item.id === id)) throw new Error('找不到这段参考音频')
    api.saveSettings({ references: references.filter(({ bundled }) => !bundled), referenceFile: id })
  }

  return { status, read, upload, select }
}
