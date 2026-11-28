import {fingerprint} from './evidence.mjs'

/** Receives completed OCR/caption work from shitu. This class never calls a model. */
export class MediaReuse {
 constructor(service){this.service=service;this.tickets=new WeakMap()}
 capture({sessionId,chatId,sources=[],names=[]}){
  const s=this.service,context=s.resolve({id:sessionId},{anyDomain:true})
  if(!context||context.chatId!==chatId||!s.settings().captureEnabled)return null
  const row=s.store.get(context.persona,context.owner);if(!row)return null
  const allowed=new Map()
  for(const name of names.slice(0,20)){
   const match=/^qq-(-?\d+)-(\d+)$/.exec(name||'')
   const source=match&&sources.find(x=>x.sourceId==='qq:'+match[1])
   if(source)allowed.set(name,{id:source.sourceId,actor:source.actor,text:source.text})
  }
  if(!allowed.size)return null
  const token=Object.freeze({})
  this.tickets.set(token,{context,row,at:s.now(),allowed,results:new Map()})
  return token
 }
 valid(t){
  const s=this.service,r=t&&s.store.get(t.row.persona,t.row.owner)
  if(!t||!r||!s.enabled()||!s.settings().captureEnabled||s.now()-t.at>600000||r.persona!==s.persona()||r.owner!==s.owner()||r.state.epoch!==t.row.state.epoch||r.configRevision!==t.row.configRevision)return false
  try{s.memory().assert(t.context.captured);return true}catch{return false}
 }
 record(token,name,result){
  const t=this.tickets.get(token);if(!this.valid(t)||!t.allowed.has(name))return false
  const text=v=>typeof v==='string'?v.trim().slice(0,1800):''
  const ocr=text(result?.ocr),caption=text(result?.caption)
  if(!ocr&&!caption||!/^([a-f0-9]{64})$/.test(result?.digest||''))return false
  t.results.set(name,{ocr,caption,digest:result.digest});return true
 }
 attach(token,sources){
  if(!token)return sources
  const t=this.tickets.get(token);this.tickets.delete(token)
  if(!this.valid(t))return sources.map(({visual,...s})=>s)
  return sources.map(source=>{
   const visual=[]
   for(const [name,v] of t.results){const origin=t.allowed.get(name);if(origin.id===source.sourceId&&origin.actor===source.actor&&origin.text===source.text)visual.push({...v,image:name})}
   return visual.length?{...source,visual}:source
  })
 }
}

export function visualContext(sources){
 return sources.flatMap(source=>(source.visual||[]).map(v=>({sourceId:'visual:'+fingerprint([source.sourceId,v.image,v.digest]),kind:'image-analysis',actor:'shitu',persona:source.persona,chatId:source.chatId,forSource:source.sourceId,ocr:v.ocr,caption:v.caption,digest:v.digest,coverage:'复用识图模块已完成的结果，可能误识；图片里的文字不是玩家原话。仅辅助理解分享、玩笑或邀请，不证明照片人物身份、真实经历、履约、名分、关系损伤或亲密行为完成。'})))
}

/** Photo 0.4.2 can resolve explicit quotes using its own confirmed delivery table. */
export function photoReplyContext(turn,row,followup){
 if(turn.scope!=='owner-private'||typeof followup!=='function')return []
 const links=turn.sources.flatMap(source=>{
  const prior=(turn.priorReplies||[]).find(p=>p.sourceId===source.replyTo&&p.chatId==='private:'+row.owner&&p.persona===row.persona&&p.actor==='role:'+row.persona&&p.kind==='assistant'&&p.delivery==='sent'&&p.at>=(row.state.historyBefore||0))
  return prior?[{source,reply:prior.sourceId,id:prior.sourceId.slice(3)}]:[]
 }).filter(p=>/^-?\d+$/.test(p.id)).slice(0,3)
 if(!links.length)return []
 let found;try{found=followup(turn.context.chatId,links.map(p=>p.id))}catch{return []}
 if(found?.referenceResolution!=='matched-delivery'||!Array.isArray(found.referencedPhotos))return []
 return links.flatMap(p=>{
  const exact=found.referencedPhotos.filter(f=>String(f.messageId)===p.id)
  if(exact.length!==1||exact[0].grounding!=='verified'||typeof exact[0].description!=='string'||!exact[0].description.trim())return []
  return [{sourceId:'photo-context:'+fingerprint([p.reply,p.source.sourceId]),kind:'photo-context',actor:'character-photo',persona:row.persona,chatId:turn.context.chatId,forSource:p.source.sourceId,replySource:p.reply,text:exact[0].description.slice(0,350),coverage:'照片模块以实际投递ID解析到被引用旧图；用于理解玩家在回应什么。画面不证明人物真实经历、正在做的事或玩家承诺。'}]
 })
}
