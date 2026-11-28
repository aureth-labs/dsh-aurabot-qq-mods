import {randomUUID} from 'node:crypto'
import {fingerprint} from './evidence.mjs'
import {requestJudgement} from './judge.mjs'

/** Explicit one-call re-interpretation. Model results remain a preview until confirmed. */
export class SemanticReview {
 constructor(service){this.service=service;this.jobs=new Map()}
 sweep(){for(const [id,j] of this.jobs)if(j.expires<this.service.now())this.jobs.delete(id)}
 row(persona){const s=this.service,r=s.store.get(persona,s.owner());if(!r||persona!==s.persona()||!s.automaticReady(r))throw Error('需要当前聊天人格与已验证的判定配置');return r}
 stamp(row,input){const frame=this.service.live.reviewFrame(row,input);return fingerprint([row.key,row.state.epoch,row.state.revision,row.configRevision,frame.target.command,frame.sources,frame.context])}
 prepare({persona,entryId,expectedRevision}){
  this.sweep();if(this.jobs.size>=4)throw Error('仍有复核预览未处理，请稍后重试')
  const row=this.row(persona),input={entryId,expectedRevision},stamp=this.stamp(row,input),id=randomUUID()
  this.jobs.set(id,{id,persona,input,stamp,key:row.key,epoch:row.state.epoch,expires:this.service.now()+300000,status:'prepared'})
  return {id,requests:1,maxInputTokens:row.config.judge.maxInputTokens,maxOutputTokens:row.config.judge.maxOutputTokens,warning:'将按原话与现有依据重新判断互动含义，额外调用模型一次，计入每日额度。先生成修改预览，由你确认后才影响好感及心情；不会自动改写已确认的名分或事实。'}
 }
 async evaluate({id,confirmed}){
  this.sweep();const job=this.jobs.get(id),s=this.service
  if(!confirmed||job?.status!=='prepared')throw Error('请先确认本次模型用量；已开始的请求不会重复发送')
  const row=this.row(job.persona);if(this.stamp(row,job.input)!==job.stamp)throw Error('来源或关系已变化，请重新准备')
  if(s.physicalPending||s.pending.size)throw Error('已有互动正在判断，请稍后再核对')
  const controller=new AbortController(),{target,captured,sources,context}=s.live.reviewFrame(row,job.input)
  if(sources.some(x=>x.text==='[发送了图片，未附文字]'))throw Error('此记录没有保留可重判的画面结果，请撤销或手动校准')
  job.status='started';s.pending.set(id,{key:row.key,controller})
  try{
   const result=await requestJudgement({row,sources,context,facts:s.facts.available(row,captured),chatId:'private:'+row.owner,store:s.store,signal:controller.signal,now:s.now,model:async input=>{s.physicalPending=true;try{return await s.model(input)}finally{s.physicalPending=false}}})
   controller.signal.throwIfAborted();s.memory().assert(captured)
   if(this.stamp(this.row(job.persona),job.input)!==job.stamp)throw Error('返回时来源或关系已变化，结果作废')
   job.events=result.events;job.requestId=result.id;job.status='preview';job.expires=s.now()+300000
   const preview=s.live.reviewPreview(row,job.input,job.events);job.token=preview.token
   return {id,preview:{...preview,note:'模型已重新判断互动含义。确认后重算这条及后续变化；原话、既有事实和名分保留。'},events:result.events,rejected:result.rejected}
  }catch(error){job.status='failed';throw error}finally{s.pending.delete(id)}
 }
 confirm({id,confirmed}){
  this.sweep();const job=this.jobs.get(id)
  if(!confirmed||job?.status!=='preview')throw Error('重判预览已过期或尚未完成')
  const row=this.row(job.persona);if(this.stamp(row,job.input)!==job.stamp)throw Error('关系或来源已变化，请重新核对')
  const result=this.service.live.review(row,{...job.input,confirmed:true,token:job.token},job.events)
  this.jobs.delete(id);return result
 }
}
