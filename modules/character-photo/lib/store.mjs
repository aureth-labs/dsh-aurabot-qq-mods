import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const uid = () => randomUUID()
export const text = (s, max = 1500) => String(s ?? '').trim().slice(0, max)
export function automaticPhotoJob(job) {
  if (!job) return false
  if (job.trigger) return ['smart', 'proactive'].includes(job.trigger)
  return job.origin === 'proactive' || (job.origin === 'chat' && job.visualPlan?.visualRequested === false)
}
export function createStore(dir, { mimeOf, imageSize }) {
  mkdirSync(dir, { recursive: true })
  const root = realpathSync(dir)
  const assetsDir = join(root, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  const verify = file => {
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() || realpathSync(file) !== resolve(file))) throw new Error('资产路径发生变化')
  }
  verify(assetsDir)
  const file = join(root, 'state.json')
  verify(file)
  let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
    schema: 1, profiles: [], versions: [], assets: [], outfits: [], photos: [], jobs: [], scenes: {}, activeProfileId: '', currentOutfit: null,
  }
  if (state.schema !== 1) throw new Error('角色数据版本不兼容；原文件已保留')
  // A restart cannot prove whether a provider or gateway completed a request.
  for (const job of state.jobs) if (['generating', 'sending'].includes(job.status)) job.status = 'unknown'
  for (const job of state.jobs) if (['queued','planning'].includes(job.status)) { job.status = job.origin==='material'?'unknown':'failed'; job.error = '重启前任务未结束，未自动续跑' }
  for (const p of state.photos) for (const delivery of p.deliveries || []) if (delivery.status === 'sending') delivery.status = 'unknown'
  for(const p of state.photos) if(p.annotationStatus==='pending') {p.annotationStatus='failed';p.annotationError='服务重载前注释未完成，可在编辑注释中重试'}
  for (const p of state.photos) if(p.visualAnalysisStatus==='pending') {p.visualAnalysisStatus='unknown';p.visualAnalysisError='重启前图片解析结果未知，不自动重复调用；可在编辑注释中手动重试'}
  let batching = false
  const save = () => {
    if (batching) return
    verify(file)
    const tmp = join(root, `state-${uid()}.tmp`)
    writeFileSync(tmp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  }
  save()
  function asset(id) {
    const item = state.assets.find(x => x.id === id)
    if (!item || !/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(item.file)) throw new Error('找不到资产')
    return item
  }
  function path(id) {
    const p = join(assetsDir, asset(id).file)
    verify(assetsDir); verify(p)
    return p
  }
  function read(id) { return readFileSync(path(id)) }
  function inspectImage(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024 || bytes.length < 32) throw new Error('请上传不超过 8MB 的 PNG、JPG、WebP 或 GIF')
    const mime = mimeOf(bytes)
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp','image/gif':'gif' }[mime]
    if(ext==='gif'&&!['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))throw Error('GIF 文件头无效')
    const size = imageSize(bytes)
    if (!ext || !size?.width || !size.height || size.width * size.height > 100_000_000) throw new Error('图片格式或尺寸无效')
    return {mime,ext,size}
  }
  function add(bytes, meta = {}) {
    const {mime,ext,size}=inspectImage(bytes)
    const name = createHash('sha256').update(bytes).digest('hex') + '.' + ext
    const p = join(assetsDir, name)
    verify(assetsDir); verify(p)
    if (!existsSync(p)) writeFileSync(p, bytes, { flag: 'wx', mode: 0o600 })
    const a = { id: uid(), file: name, mime, width: size.width, height: size.height, bytes: bytes.length, at: Date.now(),
      ownerId: text(meta.ownerId, 30), ...(meta.profileId?{profileId:text(meta.profileId,80)}:{}), purpose: ['identity', 'outfit', 'photo', 'scene', 'object'].includes(meta.purpose) ? meta.purpose : 'identity',
      name: text(meta.name, 100), angle: text(meta.angle, 100), framing: text(meta.framing, 100), note: text(meta.note), preserve: text(meta.preserve), ignore: text(meta.ignore) }
    state.assets.push(a); save(); return a
  }
  function transaction(fn) {
    if (batching) throw new Error('已有保存正在进行')
    const before = structuredClone(state)
    const identities = Object.fromEntries(Object.entries(state).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,new Map(v.map(x=>[x.id,x]))]))
    batching = true
    try { const result = fn(); batching = false; save(); return result }
    catch (e) {
      // Preserve references held by in-flight generation/caption tasks when rolling back.
      for (const key of Object.keys(state)) if (!Object.hasOwn(before, key)) delete state[key]
      for(const [k,v] of Object.entries(before)) state[k]=Array.isArray(v)?v.map(x=>{
        const original=identities[k]?.get(x.id)
        if(!original)return x
        for(const key of Object.keys(original))delete original[key]
        return Object.assign(original,x)
      }):v
      batching = false; throw e
    }
  }
  function erase(ids) {
    const targets = ids.map(id=>({id,file:asset(id).file,path:path(id)}))
    state.assets = state.assets.filter(a=>!ids.includes(a.id)); save()
    for(const item of targets) if(!state.assets.some(a=>a.file===item.file) && existsSync(item.path)) { verify(item.path); unlinkSync(item.path) }
  }
  return { get state() { return state }, save, transaction, erase, asset, path, read, inspectImage, add, root }
}
