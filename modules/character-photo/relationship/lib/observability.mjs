import {fingerprint} from './evidence.mjs'
import {dayKey} from './policy.mjs'
export class Observability {
 constructor(service){this.service=service;this.db=service.store.db;this.db.exec('CREATE TABLE IF NOT EXISTS cost_samples(id TEXT PRIMARY KEY,turn_id TEXT,at INTEGER,day TEXT,kind TEXT,input INTEGER,output INTEGER,unknown INTEGER)')}
 record({sessionId,turn,step,attempt,usage}){
  const s=this.service;if(!s.enabled())return
  const entry=s.memory()?.session?.(String(sessionId));if(!entry||entry.retired||entry.persona!==s.persona()||! /^(private|group):/.test(entry.chatId))return
  const valid=x=>Number.isSafeInteger(x)&&x>=0,output=usage?.outputTokens,input=valid(usage?.totalTokens)&&valid(output)?usage.totalTokens-output:usage?.inputTokens,known=valid(input)&&valid(output),now=s.now()
  this.db.prepare('INSERT OR IGNORE INTO cost_samples VALUES(?,?,?,?,?,?,?,?)').run(fingerprint([sessionId,turn,step,attempt]),fingerprint([sessionId,turn]),now,dayKey(now,'UTC'),'chat',known?input:null,known?output:null,known?0:1)
 }
 summary(){
  const r=this.db.prepare('SELECT COUNT(*) calls,COUNT(DISTINCT turn_id) turns,COALESCE(SUM(input),0) inputTokens,COALESCE(SUM(output),0) outputTokens,COALESCE(SUM(unknown),0) unknown FROM cost_samples').get()
  let native=null,dsh=false
  try{native=this.service.hostUsage()}catch{}
  try{dsh=this.service.dshCostMeter()}catch{}
  return {...r,native,dshCostMeterAvailable:dsh,nativeNote:'沿用 Aurabot 的按模块、缓存及峰谷计费，新增有完整用量的关系判定。DSH 费用页能看到经其 SDK 上报的模型调用，和这里可能重叠；只选同一个口径。',judge:this.service.store.usage(),coverage:['已登记会话主对话请求','关系判定的实际用量与预算预占','走宿主用量接口的后台模型'],missing:['独立 HTTP 生图、语音、未上报及无法定价的用量','不经过 DSH SDK 或宿主记账入口的独立调用'],completeTotal:false,per100:r.turns?{inputTokens:Math.round(r.inputTokens/r.turns*100),outputTokens:Math.round(r.outputTokens/r.turns*100),observedTurns:r.turns,extrapolated:true}:null}
 }
}
