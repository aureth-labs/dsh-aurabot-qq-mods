import { fingerprint } from './evidence.mjs'

const limit=100,keep=30*86400000
const validSeq=n=>Number.isSafeInteger(n)&&n>=0
const percent=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null
export class TurnObservation {
 constructor(service){
  this.service=service;this.db=service.store.db;this.reading=false
  this.db.exec(`CREATE TABLE IF NOT EXISTS relation_observed_turns(k TEXT NOT NULL,epoch INTEGER NOT NULL,phase TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,at INTEGER NOT NULL,reply_ms INTEGER NOT NULL,work_ms INTEGER NOT NULL,judge_id TEXT,PRIMARY KEY(session_id,start_seq)); CREATE INDEX IF NOT EXISTS relation_observed_scope ON relation_observed_turns(k,epoch,profile,phase,at)`)
 }
 profile(row){
  const cfg=this.service.config(),memory=this.service.memory()
  // Keep matching persona, chat model, memory provider and native mood settings.
  // Values are hashed locally; neither settings nor text enter an observation row.
  return fingerprint([row.persona,row.owner,cfg.model||null,cfg.chatModels?.privateDefault||null,cfg.chatModels?.privates?.[row.owner]||null,cfg.mood||null,memory?.mode?.()||null])
 }
 flag(row){return this.service.store.meta('observe-turns:'+row.key,false)===true}
 serial(row){return this.service.store.meta('observe-serial:'+row.key,0)}
 set(row,value){if(typeof value!=='boolean')throw Error('采样开关格式无效');if(this.flag(row)!==value)this.service.store.transaction(()=>{this.service.store.setMeta('observe-turns:'+row.key,value);this.service.store.setMeta('observe-serial:'+row.key,this.serial(row)+1)});return this.summary(row)}
 start(turn,{seq,turnNumber}){
  if(!turn?.observe||turn.marker||!validSeq(seq)||!validSeq(turnNumber))return
  turn.marker={seq,turnNumber,at:this.service.now()}
 }
 finish(turn,{endSeq,turnNumber}){
  const s=this.service,row=s.store.get(turn.row.persona,turn.row.owner),m=turn.marker
  if(!turn.observe||!row||!this.flag(row)||turn.observe.serial!==this.serial(row)||!m||!validSeq(endSeq)||endSeq<=m.seq||m.turnNumber!==turnNumber||!Number.isFinite(turn.firstReceiptAt)||turn.firstReceiptAt<m.at||turn.sources.length===0||turn.observe.profile!==this.profile(row))return
  const phase=row.config.mode==='manual'?'manual':s.automaticActive(row)?'auto':null
  if(phase!==turn.observe.phase)return
  this.db.prepare('INSERT OR IGNORE INTO relation_observed_turns VALUES(?,?,?,?,?,?,?,?,?,?,NULL)').run(row.key,row.state.epoch,phase,turn.observe.profile,turn.sessionId,m.seq,endSeq,m.at,turn.firstReceiptAt-turn.at,Math.max(0,s.now()-m.at))
  this.db.prepare('DELETE FROM relation_observed_turns WHERE k=? AND epoch=? AND phase=? AND rowid NOT IN (SELECT rowid FROM relation_observed_turns WHERE k=? AND epoch=? AND phase=? ORDER BY at DESC,start_seq DESC LIMIT 300)').run(row.key,row.state.epoch,phase,row.key,row.state.epoch,phase)
 }
 bind(turn,id){if(turn.observe&&turn.marker)this.db.prepare('UPDATE relation_observed_turns SET judge_id=? WHERE session_id=? AND start_seq=?').run(id,turn.sessionId,turn.marker.seq)}
 observed(row,phase){return this.db.prepare('SELECT * FROM relation_observed_turns WHERE k=? AND epoch=? AND profile=? AND phase=? AND at>=? ORDER BY at DESC,start_seq DESC LIMIT ?').all(row.key,row.state.epoch,this.profile(row),phase,this.service.now()-keep,limit)}
 summary(row){
  if(!row)return {enabled:false,limit,modes:{}}
  const modes={}
  for(const phase of ['manual','auto']){
   const rows=this.observed(row,phase),ms=rows.map(r=>r.reply_ms)
   modes[phase]={turns:rows.length,p50Ms:percent(ms,.5),p95Ms:percent(ms,.95),lastAt:rows[0]?.at??null,judgeAttempts:rows.filter(r=>r.judge_id).length}
  }
  return {enabled:this.flag(row),limit,modes,token:this.token(row),matched:modes.manual.turns===limit&&modes.auto.turns===limit}
 }
 token(row){const parts=['manual','auto'].flatMap(phase=>this.observed(row,phase).map(r=>[r.session_id,r.start_seq,r.end_seq,r.judge_id]));return fingerprint([row.key,row.state.epoch,this.profile(row),parts])}
 async read(row,{phase,offset=0,token}){
  const s=this.service
  if(this.flag(row)||!['manual','auto'].includes(phase)||!validSeq(offset)||offset>=limit||token!==this.token(row))throw Error('请暂停采样并重取样本。')
  if(!s.dshCostMeter())throw Error('DSH 费用统计服务未启用。')
  if(this.reading)throw Error('正在读取费用样本，请稍候。')
  this.reading=true
  try{
   const all=this.observed(row,phase),page=all.slice(offset,offset+5),results=[]
   for(const r of page){
    if(s.closed||s.persona()!==row.persona||s.owner()!==row.owner)throw Error('当前档案已变化。')
    let cost=null
    try{const d=await s.turnCost(r.session_id,r.start_seq,r.end_seq);if(d?.found&&!d.inherited&&Array.isArray(d.calls)&&d.calls.length&&d.calls.every(v=>v.priced===true&&v.metering?.complete!==false)&&Number.isFinite(d.apiCost)&&Number.isFinite(d.cost)&&d.cost>=d.apiCost&&d.apiCost>=0)cost={api:d.apiCost,plan:d.cost-d.apiCost}}catch{}
    if(s.closed)throw Error('当前档案已变化。')
    const j=r.judge_id?s.store.db.prepare('SELECT input_actual,output_actual FROM requests WHERE id=? AND scope=?').get(r.judge_id,row.key):null
    const adjudication=j&&Number.isSafeInteger(j.input_actual)&&Number.isSafeInteger(j.output_actual)?{input:j.input_actual,output:j.output_actual}:null
    results.push({replyMs:r.reply_ms,workMs:r.work_ms,chat:cost,judge:adjudication,judgeAttempt:!!r.judge_id})
   }
   const latest=s.closed?null:s.store.get(row.persona,row.owner)
   if(!latest||s.persona()!==row.persona||s.owner()!==row.owner||token!==this.token(latest))throw Error('采样已变化，请重取样本。')
   return {rows:results,total:all.length,next:offset+page.length<all.length?offset+page.length:null,currency:'CNY'}
  }finally{this.reading=false}
 }
 clear(rowKey,forgetFlag=false){this.db.prepare('DELETE FROM relation_observed_turns WHERE k=?').run(rowKey);if(forgetFlag)this.service.store.setMeta('observe-turns:'+rowKey,false)}
 prune(now){this.db.prepare('DELETE FROM relation_observed_turns WHERE at<?').run(now-keep)}
}
