/** Withdrawal removes semantic copies, never rewrites an already lived score silently.
 * The numeric history becomes a replay boundary; IDs remain only for deduplication.
 * Called from the memory archive transaction and again by its durable pending journal.
 */
export class RelationPrivacy {
 constructor(service){this.service=service;this.store=service.store;this.db=this.store.db}
 rows({persona,owner}){return this.db.prepare('SELECT persona,owner FROM scopes WHERE persona=? AND owner=?').all(persona,owner).map(r=>this.store.get(r.persona,r.owner))}
 impact({persona,owner,sourceIds=[]}){
  const ids=new Set(sourceIds),facts=[],entries=[]
  for(const row of this.rows({persona,owner})){
   const all=this.db.prepare('SELECT id,payload FROM relation_facts WHERE k=?').all(row.key).map(f=>JSON.parse(f.payload));for(const f of all)if(ids.has(f.sourceId)||ids.has(f.agreement?.[0]))facts.push(f.id)
   let changed=true;while(changed){changed=false;for(const f of all)if(facts.includes(f.relatedId)&&!facts.includes(f.id)){facts.push(f.id);changed=true}}
   for(const table of ['committed_entries','simulation_entries','committed_archive','simulation_archive'])for(const e of this.db.prepare('SELECT id,k,epoch,command,source_ids FROM '+table+' WHERE k=?').all(row.key)){
    const c=JSON.parse(e.command)
    if(JSON.parse(e.source_ids).some(id=>ids.has(id))||c.review?.some(r=>ids.has(r.sourceId))||ids.has(c.confirmedStatus?.sourceId)||ids.has(c.confirmedStatus?.agreementSourceId)||c.proofIds?.some(id=>facts.includes(id))||c.events?.some(v=>v.evidence?.some(x=>ids.has(x.sourceId))||v.proofIds?.some(id=>facts.includes(id))))entries.push({table,id:e.id,epoch:e.epoch})
   }
  }
  return {facts,entries,summary:'关联原话、事实和判断说明将清除；已发生分数保留。清除前如需纠正分数，请先撤销对应判断。'}
 }
 forget(input){
  if(!input||!Array.isArray(input.sourceIds)||input.sourceIds.some(s=>typeof s!=='string'))throw Error('来源撤回身份无效')
  const impact=this.impact(input),entryIds=new Set(impact.entries.map(e=>e.id)),ids=new Set(input.sourceIds)
  for(const row of this.rows(input))this.service.cancel(row.key)
  return this.store.transaction(()=>{
   for(const id of impact.facts)this.db.prepare('DELETE FROM relation_facts WHERE id=?').run(id)
   for(const e of impact.entries){
    const old=this.db.prepare('SELECT before_state,after_state,at,result FROM '+e.table+' WHERE id=?').get(e.id),before=JSON.parse(old.before_state),after=JSON.parse(old.after_state),result=JSON.parse(old.result)
    this.db.prepare('UPDATE '+e.table+' SET command=?,result=?,type=? WHERE id=?').run(JSON.stringify({at:old.at,privacy:true}),JSON.stringify({privacy:true,actualDelta:after.score-before.score,mood:result.mood||0,beforeStage:before.stage,afterStage:after.stage,events:[]}), 'privacy',e.id)
   }
   for(const row of this.rows(input)){
    this.service.retention.clearLegacySources(row.key,ids)
    const cleanState=value=>{
     if(Array.isArray(value))return value.map(cleanState)
     if(!value||typeof value!=='object')return value
     const out=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,cleanState(v)]))
     if(value.statusSource&&(ids.has(value.statusSource.sourceId)||ids.has(value.statusSource.agreementSourceId)||impact.facts.includes(value.statusSource.factId))){out.status='未定义';out.statusSource=null}
     return out
    }
    for(const table of ['committed_entries','simulation_entries','committed_archive','simulation_archive'])for(const e of this.db.prepare('SELECT id,before_state,after_state FROM '+table+' WHERE k=?').all(row.key))this.db.prepare('UPDATE '+table+' SET before_state=?,after_state=? WHERE id=?').run(JSON.stringify(cleanState(JSON.parse(e.before_state))),JSON.stringify(cleanState(JSON.parse(e.after_state))),e.id)
    for(const table of ['committed_states','simulations'])for(const e of this.db.prepare('SELECT epoch,base,state FROM '+table+' WHERE k=?').all(row.key))this.db.prepare('UPDATE '+table+' SET base=?,state=? WHERE k=? AND epoch=?').run(JSON.stringify(cleanState(JSON.parse(e.base))),JSON.stringify(cleanState(JSON.parse(e.state))),row.key,e.epoch)
    for(const table of ['committed_revisions','simulation_revisions'])for(const e of this.db.prepare('SELECT id,result FROM '+table+' WHERE k=?').all(row.key))this.db.prepare('UPDATE '+table+' SET result=? WHERE id=?').run(JSON.stringify(cleanState(JSON.parse(e.result))),e.id)
    // A management explanation may itself quote an earlier judgment. Remove free text
    // in this scope's correction trail once its source has been withdrawn.
    for(const table of ['committed_revisions','simulation_revisions'])this.db.prepare('UPDATE '+table+" SET reason='来源已遗忘' WHERE k=?").run(row.key)
    const mentions=value=>{if(Array.isArray(value))return value.some(mentions);if(value&&typeof value==='object')return Object.values(value).some(mentions);return typeof value==='string'&&(ids.has(value)||entryIds.has(value)||impact.facts.includes(value))}
    for(const e of this.db.prepare('SELECT id,body FROM events WHERE scope=?').all(row.key))if(mentions(JSON.parse(e.body)))this.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify({privacy:true,reason:'来源已遗忘；历史分数未自动更改'}),e.id)
    for(const d of this.db.prepare('SELECT id,kind,payload FROM delivery_outbox WHERE k=?').all(row.key))if(mentions(JSON.parse(d.payload))||[...entryIds].some(id=>d.id.endsWith(id))){
     if(d.kind==='memory')this.service.live.enqueue(row,'privacy-retract:'+d.id,'retract',{sourceId:JSON.parse(d.payload).sourceId,erase:true})
     this.db.prepare("UPDATE delivery_outbox SET payload='{}',status='forgotten',error='' WHERE id=?").run(d.id)
    }
    if(row.state.statusSource&&mentions(row.state.statusSource))this.store.saveState(row,{...row.state,status:'未定义',statusSource:null,revision:row.state.revision+1})
   }
   return {factsRemoved:impact.facts.length,entriesRedacted:impact.entries.length,memorySources:impact.entries.filter(e=>e.table.startsWith('committed_')).map(e=>'relation:'+e.id),scoreChanged:false}
  })
 }
}
