import {fingerprint} from './evidence.mjs'
import {renderContext} from './context.mjs'

/** Read-only expression policy. Existing tool and platform authorization remains
 * with the host; a relationship stage never grants permission to execute/send. */
export class RelationConsumers {
 constructor(service){this.service=service}
 capture({chatId='',origin='chat'}={}){
  const s=this.service,row=s.owner()?s.store.get(s.persona(),s.owner()):null
  const active=!!(s.enabled()&&row&&!s.store.meta('reset-pending:'+row.key)&&!s.store.meta('setup-required:'+row.key)&&['manual','auto'].includes(row.config.mode)&&s.compatibility().supported)
  const scope=origin==='diary'||chatId.startsWith('group:')?'public':chatId==='private:'+s.owner()||origin==='panel'?'owner-private':'other-private'
  const optional=active&&scope==='owner-private'&&row.config.arousal.enabled&&row.config.optionalEnabled&&row.state.stage>=row.config.stageGate
  const policy={api:1,persona:s.persona(),owner:s.owner(),scope,active,optional,epoch:row?.state.epoch||0,config:row?.configRevision||0,state:row?.state.revision||0,enabled:s.settings().enabled===true,globalOptional:true,chatId,origin}
  return Object.freeze({...policy,signature:fingerprint(policy),guidance:active?renderContext(row,{scope,globalOptional:true,now:s.now()}).text||'':''})
 }
 assert(captured,{intimacy}={}){
  if(!captured||captured.api!==1)throw Error('缺少相处状态快照')
  const current=this.capture(captured)
  if(current.signature!==captured.signature)throw Error('相处状态或亲密模式已变化，请按当前状态重新准备')
  if(current.active&&intimacy!==undefined){
   if(!['ordinary','romantic','intimate','unknown'].includes(intimacy))throw Error('尚未确认内容的相处范围')
   if(intimacy==='unknown')throw Error('尚未确认内容的相处范围，请补充明确要求')
   if(['romantic','intimate'].includes(intimacy)&&current.scope!=='owner-private')throw Error('恋爱和亲密互动仅面向主人私聊')
   if(intimacy==='intimate'&&!current.optional)throw Error(current.scope==='owner-private'?'当前亲密设定未生效，请改用日常内容':'公开和其他人的聊天不使用主人私聊亲密设定')
  }
  return current
 }
}
