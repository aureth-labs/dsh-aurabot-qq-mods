import { createHash } from 'node:crypto'
import { text, uid } from './store.mjs'
import { bodyMeasurements } from './visual-plan.mjs'
import { settings, DEFAULTS, PHOTO_OCCASIONS } from './director.mjs'

export function createManagement(api, service) {
  const db = service.db, owner = () => String(api.config().ownerQQ || '')
  const revision = () => createHash('sha256').update(JSON.stringify([db.state.profiles,db.state.versions,db.state.outfits,db.state.materials,db.state.personaBindings,db.state.assets.map(a=>[a.id,a.note]),service.settings(),db.state.lifeConfigs])).digest('hex')
  function checkRevision(expected) {
    if (expected!==undefined && expected !== revision()) throw new Error('资料已在其他页面变更，请刷新后再保存')
  }
  function saveAll(input) {
    checkRevision(input.revision)
    const patch = Object.fromEntries(Object.entries(input.settings || {}).filter(([k])=>Object.hasOwn(DEFAULTS,k)))
    const next = settings({...service.settings(),...patch,followPersona:true})
    const beforeSettings = service.settings(), erase = new Set(input.deleteAssetIds || [])
    for(const id of input.deletePhotoIds || []) {
      const p = service.photo(id)
      if(p.deliveries?.some(d=>d.status==='sending')) throw new Error('照片正在发送，稍后再删除')
      erase.add(p.assetId)
    }
    for(const id of erase) {
      if(db.asset(id).ownerId !== owner()) throw new Error('只能删除自己的图片')
      if(db.state.jobs.some(j=>['queued','generating','sending'].includes(j.status) && (j.refs?.some(r=>r.id===id)||j.photoId&&db.state.photos.some(p=>p.id===j.photoId&&p.assetId===id)))) throw new Error('图片正被任务使用，稍后再删除')
    }
    const drafts = Array.isArray(input.roles) ? input.roles : []
    const lifeDrafts = input.lifeDrafts ?? []
    if (!Array.isArray(lifeDrafts) || lifeDrafts.length > 100 || new Set(lifeDrafts.map(d=>d?.personaId)).size !== lifeDrafts.length) throw new Error('生活配置请按人格分别保存，不能重复')
    for (const draft of lifeDrafts) service.life.validateDraft(draft)
    const cards = service.snapshot().personas
    const seen = new Set()
    for(const d of drafts) {
      if(!cards.some(p=>p.id===d.personaId) || seen.has(d.personaId)) throw new Error('请选择有效且不重复的人格卡')
      seen.add(d.personaId)
      bodyMeasurements(d.bodyMeasurements)
      const refs=[d.mainId,d.extraId,d.extra2Id].filter(Boolean)
      if(!d.mainId && (d.extraId || d.extra2Id)) throw new Error('补图需要主设定图')
      if(new Set(refs).size!==refs.length) throw new Error('主图和补图不能相同')
      for(const id of refs) {
        const a=db.asset(id)
        if(erase.has(id)||a.ownerId!==owner()||a.purpose!=='identity'||a.personaId&&a.personaId!==d.personaId)throw new Error('角色参考无效、属于其他人格或已准备删除')
      }
      for(const o of d.outfits || []) {
        if(!text(o.name,80)) throw new Error('请填写服装名称')
        if(!text(o.description) && !o.referenceId) throw new Error('服装需要描述或参考图')
        if(o.referenceId && (erase.has(o.referenceId)||db.asset(o.referenceId).ownerId!==owner()||db.asset(o.referenceId).purpose!=='outfit')) throw new Error('服装参考无效或已准备删除')
      }
    }
    try {
      db.transaction(()=>{
        for (const draft of lifeDrafts) service.life.saveDraft(draft)
        for(const d of drafts) {
          const card=cards.find(p=>p.id===d.personaId)
          let p=db.state.profiles.find(p=>p.id===(db.state.personaBindings?.[d.personaId]||d.profileId) && p.ownerId===owner())
          if(d.profileId && (!p || p.id!==d.profileId)) throw new Error('人格绑定已变化，请刷新')
          if(p && Object.entries(db.state.personaBindings||{}).some(([id,v])=>v===p.id&&id!==d.personaId)) throw new Error('该资料已绑定其他人格，请创建此人格自己的设定')
          if(!p) {p={id:uid(),ownerId:owner(),name:card.name,versionId:''};db.state.profiles.push(p)}
          p.name=card.name;(db.state.personaBindings ||= {})[d.personaId]=p.id
          const previous=db.state.versions.find(v=>v.id===p.versionId)
          if(d.mainId) service.saveProfile({profileId:p.id,personaId:d.personaId,name:card.name,references:[d.mainId,d.extraId,d.extra2Id].filter(Boolean),fixedFeatures:d.fixedFeatures??previous?.fixedFeatures,variableAppearance:d.variableAppearance??previous?.variableAppearance,notes:d.notes??previous?.notes,bodyMeasurements:d.bodyMeasurements??previous?.bodyMeasurements,referenceNotes:Object.fromEntries([d.mainId,d.extraId,d.extra2Id].filter(Boolean).map(id=>[id,d.referenceNotes?.[id]??db.asset(id).note]))})
          else p.versionId=''
          const old=db.state.outfits.filter(o=>o.profileId===p.id)
          const list=(d.outfits||[]).map(o=>{
            if(o.id && !old.some(x=>x.id===o.id)) throw new Error('服装不属于此人格')
            return service.materials.draft(p.id,'outfit',o,old.find(x=>x.id===o.id),erase)
          })
          if(d.materials!==undefined){
            if(!Array.isArray(d.materials) || d.materials.some(m=>!['identity','scene','object'].includes(m.kind)))throw Error('未知素材类型')
            const existing=(db.state.materials||[]).filter(x=>x.profileId===p.id)
            const next=d.materials.map(m=>{
              if(m.conversionId && !m.id && m.kind==='identity')return service.materials.adoptedIdentity(p.id,m,erase)
              const prev=existing.find(x=>x.id===m.id)
              if(m.id&&(!prev||prev.kind!==m.kind))throw Error('素材不属于当前人格或分类')
              return service.materials.draft(p.id,m.kind,m,prev,erase)
            })
            if(new Set(next.map(x=>x.id)).size!==next.length)throw Error('不能重复保存同一素材')
            db.state.materials=[...(db.state.materials||[]).filter(x=>x.profileId!==p.id),...next]
          }
          if(new Set(list.map(o=>o.id)).size!==list.length)throw Error('不能重复保存同一套服装')
          const occasions=d.outfitOccasions??p.outfitOccasions??{}
          if(!occasions || typeof occasions!=='object' || Array.isArray(occasions))throw Error('情境穿搭格式无效')
          const outfits=new Set(['original',...list.map(o=>o.id)])
          p.outfitOccasions={}
          for(const [occasion,id] of Object.entries(occasions)){
            if(!PHOTO_OCCASIONS.includes(occasion))throw Error('未知穿搭情境')
            if(outfits.has(id))p.outfitOccasions[occasion]=id
            else if(id && !old.some(o=>o.id===id))throw Error('情境穿搭不属于当前衣柜')
          }
          if(d.defaultOutfit !== undefined){
            const index = Number(d.defaultOutfit)
            const choice = d.defaultOutfit
            if(choice !== 'auto' && choice !== 'original' && !(Number.isInteger(index) && list[index] && String(index) === choice)) throw new Error('请选择当前衣柜中的默认装扮')
            p.defaultOutfit = list[index] && String(index) === choice ? list[index].id : choice
          }
          if(!list.some(o=>o.id===p.defaultOutfit) && p.defaultOutfit!=='original') p.defaultOutfit='auto'
          db.state.outfits=[...db.state.outfits.filter(o=>o.profileId!==p.id),...list]
          if(db.state.currentOutfits?.[p.id]?.id && db.state.currentOutfits[p.id].id!=='original' && !list.some(o=>o.id===db.state.currentOutfits[p.id].id)) delete db.state.currentOutfits[p.id]
          const worn=db.state.currentOutfits?.[p.id];if(worn?.id)Object.assign(worn,list.find(o=>o.id===worn.id))
          if(db.state.currentOutfit?.profileId===p.id)db.state.currentOutfit=db.state.currentOutfits?.[p.id]||null
        }
        for(const entry of input.photoEdits || []) {
          const p=service.photo(entry.photoId)
          if(entry.revision!==undefined && Number(p.annotationRevision||0)!==entry.revision) throw new Error('照片注释已变化，请重新打开编辑')
          service.editPhoto(entry)
        }
        db.state.photos=db.state.photos.filter(p=>!erase.has(p.assetId))
        db.state.versions=db.state.versions.filter(v=>!v.references.some(id=>erase.has(id)))
        for(const p of db.state.profiles.filter(p=>p.ownerId===owner())) {
          const versions=db.state.versions.filter(v=>v.profileId===p.id).reverse().sort((a,b)=>b.at-a.at)
          const keep=new Set([...new Set([p.versionId,...versions.map(v=>v.id)].filter(id=>versions.some(v=>v.id===id)))].slice(0,3))
          db.state.versions=db.state.versions.filter(v=>v.profileId!==p.id||keep.has(v.id))
          if(!db.state.versions.some(v=>v.id===p.versionId)) p.versionId=''
        }
        for(const o of [...db.state.outfits,...(db.state.materials||[])]) {
          if(erase.has(o.referenceId))o.referenceId=''
          if(erase.has(o.boardId)){o.boardId='';o.useBoard=false}
        }
        api.saveSettings(next)
      })
    } catch(e) { api.saveSettings(beforeSettings); throw e }
    // Explicit deletions occur only after validating and committing all edits.
    if(erase.size) db.erase([...erase])
    return {message:'已保存所有修改',...service.snapshot(),revision:revision()}
  }
  function clearJobs(target) {
    const view=target?service.snapshot(target):null
    let count=0
    for(const j of db.state.jobs) if(j.ownerId===owner()&&!j.hidden&&(!view||(j.personaId?j.personaId===target:!!view.viewingProfileId&&j.profileId===view.viewingProfileId))&&!['queued','planning','generating','sending'].includes(j.status)) { j.hidden=true;count++ }
    db.save();return {message:`已清空 ${count} 条已结束记录；进行中的任务保留`,count}
  }
  return {saveAll,clearJobs,revision,checkRevision}
}
