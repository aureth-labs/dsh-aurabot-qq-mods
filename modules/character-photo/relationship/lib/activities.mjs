import {AsyncLocalStorage} from 'node:async_hooks'
/** A tool result is context, never a player event. Correlation is captured at tool
 * entry and real send receipts supply closure; success alone cannot award score. */
export class RelationActivities {
 constructor(service){this.service=service;this.scope=new AsyncLocalStorage()}
 async run({sessionId,chatId,name},fn){
  const matches=[...this.service.collector.turns.entries()].filter(([,t])=>t.sessionId===sessionId&&t.context.chatId===chatId)
  const [token,turn]=matches.length===1?matches[0]:[],stamp=turn?{token,chatId,coveredIds:turn.sources.map(x=>x.sourceId),name:String(name||'工具').slice(0,100)}:null
  if(turn)turn.expires=Math.min(turn.at+7200000,this.service.now()+7200000)
  return this.scope.run(stamp,async()=>{try{const result=await fn();this.note(turn,stamp,result?.ok===false||result?.isError?'failed':'returned');return result}catch(e){this.note(turn,stamp,'failed');throw e}})
 }
 note(turn,stamp,status){if(turn&&this.service.collector.turns.has(stamp.token)){turn.activities||=[];if(turn.activities.length<8)turn.activities.push({sourceId:'tool:'+turn.activities.length,kind:'tool',actor:'role:'+turn.row.persona,persona:turn.row.persona,chatId:turn.context.chatId,text:'角色调用了 '+stamp.name+'；'+(status==='failed'?'工具报告失败':'工具已返回，不能据此推断玩家做过此动作或任务已成功'),status,coveredIds:stamp.coveredIds})}}
 receipt(chatId,receipt){const stamp=this.scope.getStore();if(stamp?.chatId===chatId)this.service.collector.receipt(stamp.token,{...receipt,coveredIds:stamp.coveredIds})}
 confirmed({captured,moduleId,status,summary,coverage}){
  const stamp=this.scope.getStore(),turn=stamp&&this.service.collector.turns.get(stamp.token)
  if(!turn||captured?.input?.persona!==turn.row.persona||!['confirmed','observed','created','failed','unknown','retracted','reported'].includes(status))return
  const scope=captured.input,chatId=scope.audience+':'+scope.subject
  if(chatId!==turn.context.chatId)return
  turn.activities||=[];if(turn.activities.length>=8)return
  turn.activities.push({sourceId:'tool:'+turn.activities.length,kind:'tool',actor:'role:'+turn.row.persona,persona:turn.row.persona,chatId,status,coveredIds:stamp.coveredIds,text:'角色的'+String(moduleId).slice(0,80)+'结果（不是玩家行为）：'+String(summary).slice(0,1200)+'；可知范围：'+String(coverage).slice(0,300)})
 }
 share(chatId,sourceId){const s=this.service,row=s.store.get(s.persona(),s.owner());if(!s.enabled()||!s.settings().captureEnabled||!row||chatId!=='private:'+row.owner)return;s.store.setMeta('proactive:'+row.key+':'+row.state.epoch,{sourceId,at:s.now()})}
}
