// 向量索引：id → 512 个 float，存成一个 json（几千条也才几兆），内存里暴力比。
// 每条还记一个签名（条目改写时间），用来判断要不要重算。换模型时 model 名变了就整库重算。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64')
const unb64 = (s) => {
  const buf = Buffer.from(s, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

export function createVecStore(file, { model = 'bge-small-zh-v1.5-int8' } = {}) {
  let data = { model, dim: 0, items: {}, sigs: {}, updatedAt: 0 }
  let dirty = false
  let stale = false

  function load() {
    try {
      if (!existsSync(file)) return
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw && raw.model === model) data = { ...data, ...raw, sigs: raw.sigs || {} }
      else stale = true
    } catch (error) {}
  }

  function save() {
    if (!dirty) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ ...data, updatedAt: Date.now() }))
      dirty = false
    } catch (error) {}
  }

  load()

  return {
    get size() {
      return Object.keys(data.items).length
    },
    get dim() {
      return data.dim || 0
    },
    get model() {
      return data.model
    },
    get modelMatches() {
      return !stale
    },
    has: (id) => Boolean(data.items[id]),
    /** 这条向量是按哪个版本算的（条目 at） */
    sigOf: (id) => data.sigs[id] || '',
    put(id, vec, sig = '') {
      data.items[id] = b64(vec)
      data.sigs[id] = String(sig || '')
      data.dim = vec.length
      dirty = true
    },
    drop(id) {
      if (data.items[id]) {
        delete data.items[id]
        delete data.sigs[id]
        dirty = true
      }
    },
    /** 只留这些 id，别的当过期清掉（记忆被删/被合并时跟着走） */
    keep(ids) {
      const set = new Set(ids)
      let changed = false
      for (const id of Object.keys(data.items)) {
        if (!set.has(id)) {
          delete data.items[id]
          delete data.sigs[id]
          changed = true
        }
      }
      if (changed) dirty = true
      return changed
    },
    clear() {
      data = { model, dim: 0, items: {}, sigs: {}, updatedAt: Date.now() }
      stale = false
      dirty = true
      save()
    },
    flush: save,
    /** 暴力点积（都已归一化，点积就是余弦），返回 [{ id, sim }] 降序 */
    topK(vec, k = 8, filter) {
      const out = []
      for (const [id, s] of Object.entries(data.items)) {
        if (filter && !filter(id)) continue
        const v = unb64(s)
        if (v.length !== vec.length) continue
        let dot = 0
        for (let i = 0; i < v.length; i++) dot += v[i] * vec[i]
        out.push({ id, sim: dot })
      }
      out.sort((a, b) => b.sim - a.sim)
      return out.slice(0, k)
    },
  }
}
