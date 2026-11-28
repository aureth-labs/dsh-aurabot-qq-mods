import {randomUUID} from 'node:crypto'
import {fingerprint} from './evidence.mjs'
const KINDS=['detail','commitment','fulfillment','milestone','relationship-damage','resolution','relationship-status','optional-completion']
/** Manual semantic confirmation over immutable, still-available archive sources. No chat copy. */
export class FactRegistry {
 constructor(service){this.service=service;this.db=service.store.db}
 list(row){return this.db.prepare('SELECT payload FROM relation_facts WHERE k=? AND epoch=? ORDER BY rowid DESC LIMIT 2000').all(row.key,row.state.epoch).map(r=>JSON.parse(r.payload))}
 available(row,captured){const all=this.list(row),valid=new Map(all.filter(f=>f.status==='confirmed'&&this.service.archive.check(captured,[{sourceId:f.sourceId,actor:f.subject,kind:f.subject===row.owner?'user':'assistant',quote:f.quote}])&&(!f.agreement||this.service.archive.check(captured,[{sourceId:f.agreement[0],actor:'role:'+row.persona,quote:f.agreement[1]}]))).map(f=>[f.id,f]));let changed=true;while(changed){changed=false;for(const [id,f] of valid)if(f.relatedId&&f.relatedId!==id&&!valid.has(f.relatedId)){valid.delete(id);changed=true}}return [...valid.values()]}
 storyStatus(row,captured){
  const latest=this.db.prepare("SELECT payload FROM relation_facts WHERE k=? AND epoch=? AND json_extract(payload,'$.kind')='story-status' AND json_extract(payload,'$.status')='confirmed' ORDER BY json_extract(payload,'$.at') DESC,rowid DESC LIMIT 1").get(row.key,row.state.epoch)
  if(!latest)return null
  const fact=JSON.parse(latest.payload)
  if(!fact.agreement||!this.service.archive.check(captured,[{sourceId:fact.sourceId,actor:row.owner,quote:fact.quote},{sourceId:fact.agreement[0],actor:'role:'+row.persona,quote:fact.agreement[1]}]))return null
  return fact.value
 }
 relevant(row,captured,text=''){
  const all=this.available(row,captured),words=new Set(String(text).normalize('NFKC').toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]{2}/gu)||[])
  const score=f=>[...words].filter(w=>f.quote.toLowerCase().includes(w)).length*10+(['commitment','relationship-damage'].includes(f.kind)&&!f.completedBy?3:0)
  const ranked=all.map(f=>({f,score:score(f)})).sort((a,b)=>b.score-a.score||b.f.at-a.f.at),selected=new Map();let bytes=0
  for(const {f} of ranked){const chain=[f],prior=all.find(p=>p.id===f.relatedId&&p.id!==f.id);if(prior)chain.push(prior)
   const fresh=chain.filter(x=>!selected.has(x.id)),size=Buffer.byteLength(JSON.stringify(fresh),'utf8');if(selected.size+fresh.length>10||bytes+size>2600)continue
   for(const item of fresh)selected.set(item.id,item);bytes+=size
  }return [...selected.values()]
 }
 prepare(row,captured,proposals,{sources=[],context=[],at}={}){
  if(proposals===undefined)return {facts:[],aliases:{}}
  if(!Array.isArray(proposals)||proposals.length>4)throw Error('自动事实数组无效')
  const known=this.available(row,captured),facts=[],aliases={},current=new Set(sources.map(s=>s.sourceId)),rejected=[],used=new Set()
  if(this.db.prepare('SELECT COUNT(*) n FROM relation_facts WHERE k=? AND epoch=?').get(row.key,row.state.epoch).n>=2000){this.service.lastIssue='可用事实已达2000条，暂不新增证明；日常相处仍可判断，请在维护工具整理。';return {facts,aliases}}
  const capacity=2000-this.db.prepare('SELECT COUNT(*) n FROM relation_facts WHERE k=? AND epoch=?').get(row.key,row.state.epoch).n
  for(const [index,proposal] of proposals.entries()){
   const raw={...proposal}
   // Normalize only an unambiguous wire-shape variant. Attribution and exact
   // source quotations below remain mandatory; never join different speakers.
   if(Array.isArray(raw.a)&&raw.a.length===1&&Array.isArray(raw.a[0]))raw.a=raw.a[0]
   if(Array.isArray(raw.e)&&raw.e.length===2&&raw.e.every(x=>Array.isArray(x)&&x.length===2&&typeof x[0]==='string'&&typeof x[1]==='string'&&x[1].trim())){
    const player=raw.e.filter(x=>sources.some(s=>s.sourceId===x[0]&&s.actor===row.owner&&s.text.includes(x[1])))
    const role=raw.e.filter(x=>context.some(s=>s.sourceId===x[0]&&s.actor==='role:'+row.persona&&s.kind==='assistant'&&s.text.includes(x[1])))
    if(player.length===1&&role.length===1&&Array.isArray(raw.a)&&raw.a.length===2&&raw.a[0]===role[0][0]&&typeof raw.a[1]==='string'&&raw.a[1].includes(role[0][1]))raw.e=player[0]
   }
   if(facts.length>=capacity)break
   if(!KINDS.includes(raw.k)||typeof raw.i!=='string'||!/^f[0-3]$/.test(raw.i)||used.has(raw.i)||!Array.isArray(raw.e)||raw.e.length!==2||typeof raw.e[0]!=='string'||typeof raw.e[1]!=='string'||!raw.e[1].trim()||raw.e[1].length>300){rejected.push({index,reason:'自动事实身份或来源格式无效'});continue}
   used.add(raw.i)
   const linkedPast=raw.k==='fulfillment'&&Array.isArray(raw.f)&&raw.f.length===1&&raw.f[0]==='history'
   // 双方共同投入的角色剧情可以成为关系事实，但仍须角色已发送的回应作确认；
   // 剧情称谓独立存放，不能把它用作现实身份或履约依据。
   const roleplayed=Array.isArray(raw.f)&&raw.f.length===1&&raw.f[0]==='roleplay'
   if(!Number.isFinite(raw.q)||raw.q<.9||raw.q>1||!Array.isArray(raw.f)||raw.f.length&&!linkedPast&&!roleplayed)continue
   if(roleplayed&&['commitment','fulfillment','relationship-damage','resolution'].includes(raw.k))continue
   const source=this.service.archive.find(captured,raw.e[0])
   if(!source||source.provenance==='image-share'||!Number.isFinite(source.at)||source.at>at||!source.text.includes(raw.e[1])||![row.owner,'role:'+row.persona].includes(source.actor))continue
   if(raw.k!=='detail'&&(source.actor!==row.owner||!current.has(source.sourceId)))continue
   if(source.at<(row.state.historyBefore||0))continue
   if(!this.service.archive.check(captured,[{sourceId:source.sourceId,actor:source.actor,quote:raw.e[1]}]))continue
   // Keep the complete proposition for durable details. Dropping the subject from
   // “你做了…” must not turn it into a stored claim about the message sender.
   const clause=x=>x.trim().replace(/[。！？!?；;\s]+$/u,'')
   if(raw.k==='detail'&&!source.text.split(/[。！？!?；;\n]+/u).some(x=>clause(x)===clause(raw.e[1])))continue
   const related=known.find(f=>f.id===raw.p)
   if(['fulfillment','resolution'].includes(raw.k)&&(!related||related.kind!==(raw.k==='fulfillment'?'commitment':'relationship-damage')||related.at>=source.at||related.sourceId===source.sourceId))continue
   if(['relationship-damage','milestone','commitment'].includes(raw.k)&&raw.p&&(!related||related.kind!==raw.k))continue
   if(linkedPast||roleplayed||['milestone','relationship-status','optional-completion','resolution'].includes(raw.k)){
    // Agreement requires a separately delivered role utterance. 剧情轮里角色的回应
    // 回执必须能追溯到本条玩家消息，避免借用上一轮的回复。
    if(!Array.isArray(raw.a)||raw.a.length!==2||typeof raw.a[1]!=='string'||!raw.a[1].trim()||raw.a[1].length>300)continue
    const reply=context.find(s=>s.sourceId===raw.a[0]&&s.kind==='assistant'&&s.actor==='role:'+row.persona&&s.delivery==='sent'&&(s.replyTo===source.sourceId||s.replyToSources?.includes(source.sourceId)))
    if(!reply||!reply.text.includes(raw.a[1])||!this.service.archive.check(captured,[{sourceId:reply.sourceId,actor:reply.actor,quote:raw.a[1]}]))continue
   }
   if(raw.k==='relationship-status'&&(typeof raw.v!=='string'||!raw.v.trim()||raw.v.length>30||!raw.e[1].includes(raw.v)))continue
   const kind=roleplayed&&raw.k==='relationship-status'?'story-status':raw.k
   const old=known.find(f=>f.kind===kind&&f.sourceId===source.sourceId&&f.quote===raw.e[1])
   const id=old?.id||'fact:'+fingerprint([row.key,row.state.epoch,kind,source.sourceId,raw.e[1]])
   aliases[raw.i]=id
   const agreement=Array.isArray(raw.a)&&raw.a.length===2&&this.service.archive.check(captured,[{sourceId:raw.a[0],actor:'role:'+row.persona,quote:raw.a[1]}])?raw.a:null
   facts.push(old||{id,persona:row.persona,owner:row.owner,epoch:row.state.epoch,kind,sourceId:source.sourceId,subject:source.actor,sourceActor:source.actor,quote:raw.e[1],at:source.at,status:'confirmed',story:roleplayed||undefined,relatedId:['relationship-damage','milestone','commitment'].includes(raw.k)?(related?.relatedId||related?.id||id):related?.id||'',relationshipLevel:raw.k==='relationship-damage'&&raw.level===true,confirmedBy:'source-checked-semantic-extraction',agreement,value:raw.k==='relationship-status'?raw.v:'',requestAt:at})
  }
  return {facts,aliases,rejected}
 }
 commit(row,facts){for(const fact of facts){this.db.prepare('INSERT OR IGNORE INTO relation_facts VALUES(?,?,?,?,?)').run(fact.id,row.key,row.state.epoch,1,JSON.stringify(fact));if(['fulfillment','resolution'].includes(fact.kind)){const r=this.db.prepare('SELECT payload FROM relation_facts WHERE id=? AND k=? AND epoch=?').get(fact.relatedId,row.key,row.state.epoch);if(r){const previous=JSON.parse(r.payload);previous.completedBy=fact.id;this.db.prepare('UPDATE relation_facts SET payload=?,revision=revision+1 WHERE id=?').run(JSON.stringify(previous),previous.id)}}}}
 confirm(row,{kind,sourceId,quote,relatedId='',relationshipLevel=false,expectedRevision}){
  if(row.state.revision!==expectedRevision)throw Error('档案变化，请重新确认')
  if(this.db.prepare('SELECT COUNT(*) n FROM relation_facts WHERE k=? AND epoch=?').get(row.key,row.state.epoch).n>=2000)throw Error('事实记录已达2000条，请先整理不再需要的记录')
  if(!KINDS.includes(kind)||['relationship-status','optional-completion'].includes(kind)||typeof quote!=='string'||!quote.trim()||quote.length>300)throw Error('事实类型或原文短引无效；名分和完成需双方实际回应')
  const captured=this.service.memory().capture('private:'+row.owner),source=this.service.archive.find(captured,sourceId)
  if(!source||!source.text.includes(quote)||![row.owner,'role:'+row.persona].includes(source.actor))throw Error('来源不存在、已删除或短引不匹配')
  if(kind!=='detail'&&source.actor!==row.owner)throw Error('此事实必须引用玩家本人原话')
  const prior=this.list(row).find(f=>f.id===relatedId&&f.status==='confirmed')
  if(['fulfillment','resolution'].includes(kind)&&(!prior||prior.kind!==(kind==='fulfillment'?'commitment':'relationship-damage')||prior.at>=source.at||prior.sourceId===sourceId))throw Error('需选择更早且独立的承诺或损伤来源')
  const fact={id:randomUUID(),persona:row.persona,owner:row.owner,epoch:row.state.epoch,kind,sourceId,subject:source.actor,quote,at:source.at,status:'confirmed',relatedId:relatedId||'',relationshipLevel:kind==='relationship-damage'&&relationshipLevel===true,confirmedBy:'player-management'}
  if(kind==='relationship-damage'&&!fact.relatedId)fact.relatedId=fact.id
  this.db.prepare('INSERT INTO relation_facts VALUES(?,?,?,?,?)').run(fact.id,row.key,row.state.epoch,1,JSON.stringify(fact))
  this.service.store.event(row,'fact:'+fact.id,'management',{action:'fact-confirm',factId:fact.id,kind,sourceId});return fact
 }
 revoke(row,{id}){const all=this.list(row);if(!all.some(f=>f.id===id))throw Error('事实不存在');const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const f of all)if(ids.has(f.relatedId)&&!ids.has(f.id)){ids.add(f.id);changed=true}}for(const fact of all)if(ids.has(fact.id)){fact.status='revoked';this.db.prepare('UPDATE relation_facts SET revision=revision+1,payload=? WHERE id=?').run(JSON.stringify(fact),fact.id)}for(const f of all)if(f.completedBy&&ids.has(f.completedBy)){delete f.completedBy;this.db.prepare('UPDATE relation_facts SET payload=?,revision=revision+1 WHERE id=?').run(JSON.stringify(f),f.id)};const current=this.service.store.get(row.persona,row.owner);if(ids.has(current.state.statusSource?.factId)){for(const ledger of [this.service.store.committed,this.service.store.ledger]){if(ledger.namespace==='committed')ledger.ensure(current);if(ledger.get(current))ledger.append(current,{clearStatus:true,at:this.service.now()},{manual:true})}this.service.store.saveState(current,{...current.state,status:'未定义',statusSource:null,revision:current.state.revision+1})};this.service.cancel(row.key);return {revoked:true,count:ids.size,impact:'今后不再使用此证明及依赖它的证明；已发生计分请在相处记录预览撤销。'}}
}
