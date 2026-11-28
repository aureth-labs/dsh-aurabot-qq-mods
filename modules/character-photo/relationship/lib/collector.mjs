import {fingerprint} from './evidence.mjs'
const skipLabels={
 'capture-capacity':'有太多互动正在处理，本轮未采集。',
 'missing-sources':'聊天入口未提供可核对的消息来源。',
 'session-binding':'主人会话、人格或记忆档案暂未对上。',
 'invalid-source':'消息来源不完整或身份相冲突。',
 'archive-source':'无法从当前记忆档案核对原消息。',
 'incomplete-round':'本轮未完成、已取消或已过期。',
 'missing-receipt':'没有核实到对应的角色回复。',
 'capture-store':'本轮互动记录未能保存。',
 'judge-queue':'自动判定正在处理其他互动。',
 'judge-budget':'本轮超过判定额度。',
 'judge-unavailable':'本轮没有进入自动判定。',
 'judge-unapplied':'自动判定未能写入正式记录。',
}
/** Host-only receipt collection; automatic mode queues the independently budgeted judge. */
export class InteractionCollector {
 constructor(service,{sourceCheck=()=>false}={}){this.service=service;this.sourceCheck=sourceCheck;this.turns=new Map();this.moodClaims=new WeakMap();this.metrics={opened:0,closed:0,skipped:0};service.store.db.exec('CREATE TABLE IF NOT EXISTS captured_sources(k TEXT,epoch INTEGER,source_id TEXT,PRIMARY KEY(k,epoch,source_id)); CREATE TABLE IF NOT EXISTS captured_times(k TEXT,epoch INTEGER,source_id TEXT,at INTEGER,PRIMARY KEY(k,epoch,source_id))');service.store.db.prepare('INSERT OR IGNORE INTO captured_times SELECT k,epoch,source_id,? FROM captured_sources').run(service.now())}
 noteOwner(row,phase,code){
  const service=this.service
  if(row.persona!==service.persona()||row.owner!==service.owner()||service.store.get(row.persona,row.owner)?.state.epoch!==row.state.epoch)return
  const old=this.observedOwner
  const observation=old?.key===row.key&&old.epoch===row.state.epoch?old:{key:row.key,epoch:row.state.epoch}
  const at=service.now()
  if(phase==='skip')observation.skip={at,code,label:skipLabels[code]}
  else observation[phase+'At']=at
  this.observedOwner=observation
 }
 ownerStatus(row){
  const observation=this.observedOwner
  if(!row||!observation||observation.key!==row.key||observation.epoch!==row.state.epoch)return null
  const {openedAt,closedAt,skip}=observation
  return {openedAt:openedAt||null,closedAt:closedAt||null,skip:skip||null}
 }
 sweep(){for(const [token,turn] of this.turns)if(this.service.now()>(turn.expires||turn.at+600000)){turn.mood?.resolve(false);this.turns.delete(token)}}
 open({sessionId,chatId,sources,expectSources=false}){
  this.sweep();const s=this.service
  if(s.config().dryRun||!s.enabled()||!s.owner()||! /^(private|group):[^:]+$/.test(chatId||''))return null
  const row=s.store.get(s.persona(),s.owner());if(!row)return null
  const capture=s.settings().captureEnabled&&['shadow','auto'].includes(row.config.mode)&&(row.config.mode!=='auto'||s.automaticReady(row))
  if(!capture)return null
  const scope=chatId==='private:'+row.owner?'owner-private':chatId.startsWith('group:')?'public':'other-private'
  if(scope!=='owner-private'&&(s.config().mood?.enabled===false||row.config.domainMood[scope==='public'?'group':'otherPrivate']===0))return null
  // Internal reminders and tool-only turns can legitimately have no QQ sources.
  if(!expectSources&&(!Array.isArray(sources)||!sources.length))return null
  const skip=code=>{this.metrics.skipped++;if(scope==='owner-private')this.noteOwner(row,'skip',code);return null}
  if(this.turns.size>=20)return skip('capture-capacity')
  if(!Array.isArray(sources)||!sources.length||sources.length>20)return skip('missing-sources')
  let context
  try{context=s.resolve({id:sessionId},{anyDomain:true})}catch{return skip('session-binding')}
  if(!context||context.chatId!==chatId||context.persona!==row.persona||context.owner!==row.owner)return skip('session-binding')
  const actors=[...new Set(sources.map(x=>x?.actor))]
  if(!actors.length||actors.some(a=>typeof a!=='string'||!/^\d+$/.test(a))||scope!=='public'&&actors.length!==1)return skip('invalid-source')
  const token=Object.freeze({}),turn={row,context,scope,actor:actors[0],sessionId,at:s.now(),sources:[],receipts:[],nativeMoodSources:new Set(),config:row.configRevision,state:row.state.revision,epoch:row.state.epoch}
  this.turns.set(token,turn)
  try{this.extend(token,sources)}catch{return skip('invalid-source')}
  try{if(!this.sourceCheck(context.captured,turn.sources))throw Error('来源已不可用')}
  catch{this.turns.delete(token);return skip('archive-source')}
  if(scope==='owner-private'){
   s.store.setMeta('seen:'+row.key+':'+row.state.epoch,s.now())
   this.noteOwner(row,'opened')
  }
  if(row.config.mode==='auto'){
   let resolve
   const ready=new Promise(done=>{resolve=done})
   turn.mood={chatId,ready,resolve:handled=>resolve(handled||turn.nativeMoodSources.size>0)}
   this.moodClaims.set(token,turn.mood)
  }
  this.metrics.opened++
  return token
 }
 extend(token,sources){
  const turn=this.turns.get(token);if(!turn)return
  try{
  for(const source of sources){
   if(!source||!/^\d+$/.test(source.actor)||turn.scope!=='public'&&source.actor!==turn.actor||turn.scope==='owner-private'&&source.actor!==turn.row.owner||source.kind!=='user'||typeof source.text!=='string'||!source.text.trim()||source.text.length>16000||typeof source.sourceId!=='string'||!/^qq:-?\d+(?::asr)?$/.test(source.sourceId)||/^qq:0(?::|$)/.test(source.sourceId))throw Error('缺少可信QQ来源')
   const existing=turn.sources.find(s=>s.sourceId===source.sourceId)
   if(existing){if(existing.actor!==source.actor||existing.text!==source.text)throw Error('同一消息ID的主体或内容冲突');if(source.nativeMoodObserved===true)turn.nativeMoodSources.add(source.sourceId);continue}
   const replyTo=typeof source.replyTo==='string'&&/^qq:-?\d+$/.test(source.replyTo)&&source.replyTo!=='qq:0'?source.replyTo:undefined
   turn.sources.push({sourceId:source.sourceId,actor:source.actor,kind:'user',text:source.text,...(source.mediaOnly?{mediaOnly:true}:{}),...(source.visual?.length?{visual:source.visual}:{}),persona:turn.row.persona,chatId:turn.context.chatId,delivery:'received',...(source.sourceId.endsWith(':asr')?{provenance:'voice-transcript',coverage:'宿主ASR识别内容，可能有误听；不是画面、引用或现实动作证明'}:{}),...(replyTo?{replyTo}:{})})
   if(source.nativeMoodObserved===true)turn.nativeMoodSources.add(source.sourceId)
  }
  if(turn.sources.length>20){this.turns.delete(token);throw Error('合并轮次超出来源上限')}
  }catch(error){turn.mood?.resolve(false);this.turns.delete(token);throw error}
 }
 ownsMood(activity){
  if(activity?.kind!=='out')return false
  const claim=this.moodClaims.get(activity.relationTurn)
  if(!claim||claim.chatId!==activity.chatId)return false
  if(claim.outboundChecked)return true
  claim.outboundChecked=true
  return claim.ready
 }
 sourcesFor(token){return (this.turns.get(token)?.sources||[]).map(s=>s.sourceId)}
 receipt(token,{sourceId,text,coveredIds=[]}){
  const turn=this.turns.get(token);if(!turn)return
  if(typeof sourceId!=='string'||!/^qq:-?\d+$/.test(sourceId)||sourceId==='qq:0'||typeof text!=='string'||!text.trim())return
  if(!Array.isArray(coveredIds)||!coveredIds.length)return
  if(!turn.receipts.some(r=>r.sourceId===sourceId)&&turn.receipts.length<20){const matched=coveredIds.filter(id=>turn.sources.some(s=>s.sourceId===id));if(matched.length)turn.receipts.push({sourceId,text:text.slice(0,16000),coveredIds:matched})}
 }
 finish(token,{completed=false}={}){
  const turn=this.turns.get(token);if(!turn)return {captured:false,reason:'no-qualified-turn'}
  this.turns.delete(token);const s=this.service
  let skipCode='incomplete-round'
  try{
   if(!s.enabled()||!s.settings().captureEnabled||!completed||s.now()>(turn.expires||turn.at+600000))throw Error('交流未完成或已过期')
   skipCode='session-binding'
   const current=s.resolve({id:turn.sessionId},{anyDomain:true}),row=s.store.get(turn.row.persona,turn.row.owner)
   // Management changes cancel open turns; an earlier automatic commit may advance revision normally.
   if(!current||current.persona!==turn.row.persona||!row||row.state.epoch!==turn.epoch||row.configRevision!==turn.config)throw Error('身份或关系版本已变化')
   s.memory().assert(turn.context.captured)
   turn.priorReplies=[]
   // Adjacent archive turns can establish an implicit answer to a proactive share.
   // Require a unique latest role message, no intervening player, and a short gap.
   if(turn.scope==='owner-private'&&turn.sources.length===1&&!turn.sources[0].replyTo&&!turn.receipts.length){
    const own=s.archive.find(turn.context.captured,turn.sources[0].sourceId)
    const previous=own&&s.archive.recent(turn.context.captured,20).filter(x=>x.sourceId!==own.sourceId&&x.at<own.at).sort((a,b)=>b.at-a.at)
    const last=previous?.[0]
    const share=s.store.meta('proactive:'+row.key+':'+row.state.epoch)
    if(share?.sourceId===last?.sourceId&&last?.kind==='assistant'&&last.actor==='role:'+row.persona&&last.delivery==='sent'&&own.at-last.at<=300000&&previous.filter(x=>x.at===last.at).length===1)turn.sources[0].adjacentReplyTo=last.sourceId
   }
   for(const source of turn.sources){
    if(!source.replyTo&&!source.adjacentReplyTo)continue
    const prior=s.archive.find(turn.context.captured,source.replyTo||source.adjacentReplyTo)
    if(prior?.actor==='role:'+row.persona&&prior.persona===row.persona&&prior.chatId===turn.context.chatId&&prior.kind==='assistant'&&prior.delivery==='sent'&&prior.at>=(row.state.historyBefore||0)&&prior.at<=turn.at&&!turn.receipts.some(r=>r.sourceId===prior.sourceId)&&!turn.priorReplies.some(r=>r.sourceId===prior.sourceId))turn.priorReplies.push(prior)
   }
   const isClosed=p=>turn.receipts.some(r=>r.coveredIds.includes(p.sourceId))||turn.priorReplies.some(r=>p.replyTo===r.sourceId||p.adjacentReplyTo===r.sourceId)
   turn.sources=turn.sources.filter(isClosed)
   skipCode='missing-receipt'
   if(!turn.sources.length)throw Error('暂未核实到角色回应')
   skipCode='archive-source'
   if(!this.sourceCheck(turn.context.captured,turn.sources))throw Error('原文已删除、更正或停止记录')
   skipCode='capture-store'
   const result=s.store.transaction(()=>{
    const duplicate=p=>!!s.store.db.prepare('SELECT 1 FROM captured_sources WHERE k=? AND epoch=? AND source_id=?').get(row.key,row.state.epoch,p.sourceId)
    turn.sources=turn.sources.filter(p=>!duplicate(p))
    if(!turn.sources.length)return {captured:false,duplicate:true}
    turn.actor=turn.sources[0].actor
    const ids=turn.sources.map(s=>s.sourceId).sort()
    turn.receipts=turn.receipts.map(r=>({...r,coveredIds:r.coveredIds.filter(id=>ids.includes(id))})).filter(r=>r.coveredIds.length)
    turn.priorReplies=turn.priorReplies.filter(r=>turn.sources.some(p=>p.replyTo===r.sourceId||p.adjacentReplyTo===r.sourceId))
    if(turn.activities)turn.activities=turn.activities.filter(a=>a.coveredIds.some(id=>ids.includes(id)))
    for(const id of ids){s.store.db.prepare('INSERT INTO captured_sources VALUES(?,?,?)').run(row.key,row.state.epoch,id);s.store.db.prepare('INSERT INTO captured_times VALUES(?,?,?,?)').run(row.key,row.state.epoch,id,s.now())}
    s.store.event(row,'capture:'+fingerprint(ids),'capture',{sourceIds:ids,receiptIds:[...turn.receipts,...turn.priorReplies].map(r=>r.sourceId),status:'closed-unjudged',synthetic:false,modelCalls:0,reason:'已核实收发，按交流内容判断。'})
    this.metrics.closed++;return {captured:true,modelCalls:0,stateChanged:false}
   })
   if(result.captured){
    if(turn.scope==='owner-private')this.noteOwner(row,'closed')
    if(row.config.mode==='auto')s.queueInteraction(turn)
   }else turn.mood?.resolve(!!result.duplicate)
   return result
  }catch(error){turn.mood?.resolve(false);this.metrics.skipped++;if(turn.scope==='owner-private')this.noteOwner(turn.row,'skip',skipCode);return {captured:false,reason:error.message}}
 }
 clear(key){for(const [token,turn] of this.turns)if(!key||turn.row.key===key){turn.mood?.resolve(false);this.turns.delete(token)}}
 clearScope(key){this.clear(key);this.service.retention.clearLegacySources(key);for(const table of ['captured_sources','captured_times'])this.service.store.db.prepare('DELETE FROM '+table+' WHERE k=?').run(key)}
}
