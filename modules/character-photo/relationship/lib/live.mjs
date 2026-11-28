import {randomUUID} from 'node:crypto'
import {clone,arousalValue,clamp} from './policy.mjs'
import {qualifyEvents,fingerprint} from './evidence.mjs'

/** Relation commit and deliveries share one SQLite transaction. External services remain idempotent consumers. */
export class LiveState {
 constructor(service){this.service=service;this.store=service.store;this.db=this.store.db;this.draining=new Map()}
 pending(row){return this.db.prepare("SELECT * FROM delivery_outbox WHERE k=? AND epoch=? AND status='pending' ORDER BY rowid").all(row.key,row.state.epoch).map(r=>({...r,payload:JSON.parse(r.payload)}))}
 enqueue(row,id,kind,payload){this.db.prepare('INSERT OR IGNORE INTO delivery_outbox(id,k,epoch,kind,payload) VALUES(?,?,?,?,?)').run(id,row.key,row.state.epoch,kind,JSON.stringify(payload))}
 commit(row,command,{requestId}){return this.store.transaction(()=>{
  const current=this.store.get(row.persona,row.owner)
  if(current.state.epoch!==row.state.epoch||current.state.revision!==row.state.revision||current.configRevision!==row.configRevision)throw Error('关系版本已变化，结果没有提交')
  const {facts=[],...round}=command
  const status=facts.find(f=>f.kind==='relationship-status')
  if(status)round.confirmedStatus={value:status.value,factId:status.id,sourceId:status.sourceId,agreementSourceId:status.agreement?.[0]}
  round.optionalCompleted=facts.some(f=>f.kind==='optional-completion')
  round.resolvedIncidents=facts.filter(f=>f.kind==='resolution').map(f=>f.relatedId)
  const ledger=this.store.committed
  const previous=ledger.get(current)?.state.arousal
  const actual=current.state.arousal
  // Older builds recorded manual arousal on the profile but omitted it from the ledger.
  if(previous&&actual&&(previous.at!==actual.at||previous.value!==actual.value)&&!ledger.hasSources(current,round.sources)){
    ledger.append(current,{at:actual.at,arousal:clone(actual)},{manual:true})
  }
  const saved=ledger.append(current,round,{requestId})
  if(saved.duplicate)return saved
  this.store.setMeta('relation-modern-state',true)
  this.service.facts.commit(current,facts)
  this.store.saveState(current,saved.simulation.state)
  this.store.event(current,'auto:'+saved.id,'automatic',{requestId,entryId:saved.id,result:saved.result})
  if(saved.result.mood)this.enqueue(current,'mood:'+saved.id,'mood',{id:'relation:'+saved.id,delta:saved.result.mood,reason:'恋爱进行时互动',persona:row.persona})
  const accepted=saved.result.events.filter(e=>e.accepted&&e.relation!==0)
  if(accepted.length)this.enqueue(current,'memory:'+saved.id,'memory',{sourceId:'relation:'+saved.id,text:accepted.map(e=>e.label).join('；').slice(0,500),kind:'relation-interaction',sourceIds:command.sources.map(s=>s.sourceId)})
  return saved
 })}
 async drain(row,captured){
  const key=row.key+':'+row.state.epoch;if(this.draining.has(key))return this.draining.get(key)
  const run=this.drainOnce(row,captured);this.draining.set(key,run);try{return await run}finally{this.draining.delete(key)}
 }
 async drainOnce(row,captured){
  for(const delivery of this.pending(row)){
   if(!this.service.enabled()||row.persona!==this.service.persona()||row.owner!==this.service.owner())return
   try{
    this.service.memory().assert(captured)
    const current=this.store.get(row.persona,row.owner);if(current.state.epoch!==row.state.epoch)throw Error('代际变化')
    const result=await this.service.deliver(delivery.kind,delivery.payload,captured)
    if(result?.applied===false&&!result.duplicate&&!result.disabled||result?.ok===false)throw Error(result.reason||'外部服务暂未接收')
    this.store.transaction(()=>{
    this.db.prepare("UPDATE delivery_outbox SET status='done',error='',payload=? WHERE id=?").run(JSON.stringify({...delivery.payload,receipt:result||{ok:true}}),delivery.id)
    if(delivery.kind==='mood'&&delivery.payload.accounting){
     const a=delivery.payload.accounting,id='mood:'+a.entryId,old=this.db.prepare('SELECT payload FROM delivery_outbox WHERE id=?').get(id),previous=old?JSON.parse(old.payload):null
     const payload={id:'relation:'+a.entryId,delta:a.planned,receipt:{actualDelta:(previous?.receipt?.actualDelta||0)+(result?.actualDelta||0),disabled:result?.disabled===true}}
     this.db.prepare("INSERT INTO delivery_outbox(id,k,epoch,kind,payload,status,error) VALUES(?,?,?,?,?,'done','') ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(id,row.key,row.state.epoch,'mood',JSON.stringify(payload))
    }
    })
   }catch(error){this.db.prepare('UPDATE delivery_outbox SET error=? WHERE id=?').run(String(error.message).slice(0,180),delivery.id);this.service.lastIssue='同步待处理：'+error.message;break}
  }
 }
 previewUndo(row,input){if(this.pending(row).length)throw Error('请先完成待同步事件，再撤销真实记录');const preview=this.store.committed.undoPreview(row,input)
  const original=this.store.committed.entries(row,row.config.replayLimit)
  preview.moodDelta=preview.changed.reduce((sum,change)=>{const old=original.find(e=>e.id===change.id),delivery=this.db.prepare('SELECT payload FROM delivery_outbox WHERE id=?').get('mood:'+change.id);if(!delivery||!old?.result.mood)return sum;const p=JSON.parse(delivery.payload);if(p.receipt?.disabled)return sum;const applied=p.receipt?.actualDelta;if(!Number.isFinite(applied)||!p.delta)throw Error('心情回执缺少实际变化，不能自动补偿');return sum+((change.result.mood||0)-old.result.mood)*(applied/p.delta)},0)
  return preview
 }
 undo(row,input){return this.store.transaction(()=>{
  const preview=this.previewUndo(row,input),saved=this.store.committed.undo(row,input)
  // A management revision cannot go backwards, even if replay removed earlier rounds.
  preview.after.revision=row.state.revision+1;this.store.saveState(row,preview.after)
  this.store.committed.db.prepare('UPDATE simulations SET state=? WHERE k=? AND epoch=?').run(JSON.stringify(preview.after),row.key,row.state.epoch)
  const id=randomUUID();this.store.event(row,'undo:'+id,'management',{action:'undo',entryId:input.entryId,reason:input.reason,before:preview.before,after:preview.after,moodDelta:preview.moodDelta})
  // Compensation preserves unrelated mood changes; consumers apply each bounded part once.
  let remaining=preview.moodDelta,index=0
  while(Math.abs(remaining)>.001){const delta=clamp(remaining,-8,8);this.enqueue(row,'mood-undo:'+id+':'+index,'mood',{id:'relation-undo:'+id+':'+index++,delta,reason:'玩家纠正关系判定',persona:row.persona});remaining-=delta}
  this.enqueue(row,'retract:'+id,'retract',{sourceId:'relation:'+input.entryId})
  const sources=this.store.committed.entries(row,row.config.replayLimit).find(e=>e.id===input.entryId)?.source_ids||[]
  for(const fact of this.service.facts.list(row).filter(f=>f.status==='confirmed'&&sources.includes(f.sourceId)))this.service.facts.revoke(this.store.get(row.persona,row.owner),{id:fact.id})
  return {...saved,simulationOnly:false,after:this.store.get(row.persona,row.owner).state}
 })}
 clear(key){this.store.committed.clearScope(key);for(const table of ['delivery_outbox','relation_facts'])this.db.prepare('DELETE FROM '+table+' WHERE k=?').run(key)}
 reviewFrame(row,input){
  if(row.persona!==this.service.persona()||this.pending(row).length)throw Error('请在当前聊天角色完成同步后核对')
  const target=this.store.committed.entries(row,row.config.replayLimit).find(e=>e.id===input.entryId)
  if(!target?.command.review||target.command.scope!=='owner-private')throw Error('这条记录没有可复核的双方来源，请撤销或手动调整')
  const captured=this.service.memory().capture('private:'+row.owner),frame=target.command.review
  const sources=target.source_ids.map(id=>this.service.archive.find(captured,id))
  if(sources.some(s=>!s||s.actor!==row.owner)||!this.service.archive.check(captured,sources.map(s=>({sourceId:s.sourceId,actor:s.actor,quote:s.text}))))throw Error('玩家来源已不可用')
  const context=frame.map(ref=>{const source=this.service.archive.find(captured,ref.sourceId);if(!source||!this.service.archive.check(captured,[{sourceId:ref.sourceId,actor:'role:'+row.persona,quote:source.text}]))throw Error('角色回应已不可用');return {...source,kind:'assistant',delivery:'sent',replyToSources:ref.coveredIds}})
  return {target,captured,sources,context}
 }
 reviewPreview(row,input,proposal=null){
  const {target,captured,sources,context}=this.reviewFrame(row,input)
  const facts=this.service.facts.available(row,captured),events=qualifyEvents({events:proposal||target.command.events,sources,context,facts,persona:row.persona,owner:row.owner,epoch:row.state.epoch,at:target.at}).events
  const command={...target.command,events},preview=this.store.committed.reviewPreview(row,input,command),old=this.store.committed.entries(row,row.config.replayLimit)
  preview.unchanged=JSON.stringify(events)===JSON.stringify(target.command.events)
  preview.moodChanges=preview.changed.map(c=>{const before=old.find(e=>e.id===c.id),planned=c.result.mood||0,change=planned-(before.result.mood||0),delivery=this.db.prepare('SELECT payload FROM delivery_outbox WHERE id=?').get('mood:'+c.id);if(!delivery)return {entryId:c.id,planned,delta:change};const p=JSON.parse(delivery.payload);if(p.receipt?.disabled)return {entryId:c.id,planned,delta:0};if(!Number.isFinite(p.receipt?.actualDelta))throw Error('心情回执不足，不能复核');return {entryId:c.id,planned,delta:change*(p.delta?p.receipt.actualDelta/p.delta:1)}})
  preview.moodDelta=preview.moodChanges.reduce((sum,c)=>sum+c.delta,0)
  preview.token=fingerprint([row.state.revision,row.configRevision,preview.after,preview.command,preview.moodDelta]);preview.note='不调用模型；只补核已有证据，不把原判定的含糊、玩笑或未来承诺改成确定事实。';return preview
 }
 review(row,input,proposal=null){return this.store.transaction(()=>{
  const preview=this.reviewPreview(row,input,proposal);if(!input.confirmed||preview.token!==input.token)throw Error('复核内容已变化，请重新预览')
  if(preview.unchanged)return {after:row.state,affected:0,unchanged:true}
  this.store.committed.review(row,input,preview.command);preview.after.revision=row.state.revision+1;this.store.saveState(row,preview.after)
  this.store.committed.db.prepare('UPDATE simulations SET state=? WHERE k=? AND epoch=?').run(JSON.stringify(preview.after),row.key,row.state.epoch)
  const id=randomUUID();let index=0
  for(const change of preview.moodChanges){let remaining=change.delta;while(Math.abs(remaining)>.001){const delta=clamp(remaining,-8,8);this.enqueue(row,'review-mood:'+id+':'+index,'mood',{id:'relation-review:'+id+':'+index++,delta,persona:row.persona,reason:'补充依据复核',accounting:{entryId:change.entryId,planned:change.planned}});remaining-=delta}}
  this.enqueue(row,'review-retract:'+id,'retract',{sourceId:'relation:'+input.entryId})
  const accepted=preview.changed.find(c=>c.id===input.entryId).result.events.filter(e=>e.accepted&&e.relation)
  if(accepted.length)this.enqueue(row,'review-memory:'+id,'memory',{entryId:input.entryId,sourceId:'relation-review:'+id,text:accepted.map(e=>e.label).join('；').slice(0,500),sourceIds:preview.command.sources.map(s=>s.sourceId)})
  this.store.event(row,'review:'+id,'management',{entryId:input.entryId,action:'proof-review',before:preview.before,after:preview.after})
  return {after:preview.after,affected:preview.affected}
 })}
 prune(row){
  // Keep source tombstones for dedup. Full replay snapshots are bounded in count and age.
  for(const ledger of [this.store.ledger,this.store.committed]){
   const cutoff=this.service.now()-row.config.replayDays*86400000
   const archival=ledger.db.prepare('SELECT * FROM simulation_entries WHERE k=? AND (epoch<>? OR at<? OR seq NOT IN (SELECT seq FROM simulation_entries WHERE k=? AND epoch=? ORDER BY seq DESC LIMIT ?))').all(row.key,row.state.epoch,cutoff,row.key,row.state.epoch,row.config.replayLimit)
   const stateSummary=text=>{const s=JSON.parse(text);return JSON.stringify({score:s.score,stage:s.stage,arousal:s.arousal})}
   for(const e of archival)ledger.db.prepare('INSERT OR IGNORE INTO simulation_archive VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(e.seq,e.id,e.k,e.epoch,e.round_key,e.type==='privacy'?'privacy':'archived',e.at,'{}',JSON.stringify({archived:true,proofIds:[...new Set((JSON.parse(e.command).events||[]).flatMap(v=>v.proofIds||[]))]}),stateSummary(e.before_state),stateSummary(e.after_state),e.result,e.source_ids,e.revoked)
   ledger.db.prepare('DELETE FROM simulation_entries WHERE k=? AND (epoch<>? OR at<? OR seq NOT IN (SELECT seq FROM simulation_entries WHERE k=? AND epoch=? ORDER BY seq DESC LIMIT ?))').run(row.key,row.state.epoch,cutoff,row.key,row.state.epoch,row.config.replayLimit)
   ledger.db.prepare('DELETE FROM simulation_revisions WHERE k=? AND (epoch<>? OR at<?)').run(row.key,row.state.epoch,cutoff)
   ledger.db.prepare('DELETE FROM simulation_archive WHERE k=? AND (at<? OR id NOT IN (SELECT id FROM simulation_archive WHERE k=? ORDER BY at DESC LIMIT 10000))').run(row.key,this.service.now()-365*86400000,row.key)
  }
  this.db.prepare('DELETE FROM events WHERE scope=? AND seq NOT IN (SELECT seq FROM events WHERE scope=? ORDER BY seq DESC LIMIT 1000)').run(row.key,row.key)
  this.db.prepare("DELETE FROM delivery_outbox WHERE k=? AND status='done' AND rowid NOT IN (SELECT rowid FROM delivery_outbox WHERE k=? ORDER BY rowid DESC LIMIT 1000)").run(row.key,row.key)
 }
}
