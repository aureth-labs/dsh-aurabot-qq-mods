import {randomUUID} from 'node:crypto'
import {reduceRound,RULE_VERSION} from './engine.mjs'
import {reduceRound as priorRound} from './engine-v1.mjs'
import {reduceRound as legacyRound} from './engine-beta1.mjs'
import {clone,stageOf} from './policy.mjs'
import {fingerprint} from './evidence.mjs'
import {dateBoundary} from './dates.mjs'
const decode=r=>r?Object.fromEntries(Object.entries(r).map(([k,v])=>[k,['config','command','before_state','after_state','result','source_ids','base','state'].includes(k)?JSON.parse(v):v])):null

/** Separate shadow branch: never writes scopes.state or calls mood/QQ/model services. */
export class SimulationLedger {
 constructor(store,{namespace='simulation'}={}){if(!['simulation','committed'].includes(namespace))throw Error('未知账本');this.store=store;this.namespace=namespace
 const sql=s=>namespace==='simulation'?s:s.replace(/\bsimulations\b/g,'committed_states').replace(/\bsimulation_/g,'committed_')
 this.db={exec:s=>store.db.exec(sql(s)),prepare:s=>store.db.prepare(sql(s))};this.db.exec(`
 CREATE TABLE IF NOT EXISTS simulations(k TEXT,epoch INTEGER,revision INTEGER,base TEXT,state TEXT,PRIMARY KEY(k,epoch));
 CREATE TABLE IF NOT EXISTS simulation_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,k TEXT,epoch INTEGER,round_key TEXT,type TEXT,at INTEGER,config TEXT,command TEXT,before_state TEXT,after_state TEXT,result TEXT,source_ids TEXT,revoked INTEGER DEFAULT 0,UNIQUE(k,epoch,round_key));
 CREATE TABLE IF NOT EXISTS simulation_sources(k TEXT,epoch INTEGER,source_id TEXT,entry_id TEXT,PRIMARY KEY(k,epoch,source_id));
 CREATE TABLE IF NOT EXISTS simulation_revisions(id TEXT PRIMARY KEY,k TEXT,epoch INTEGER,at INTEGER,entry_id TEXT,reason TEXT,previous_revision INTEGER,result TEXT);
 CREATE TABLE IF NOT EXISTS simulation_archive AS SELECT * FROM simulation_entries WHERE 0;
 CREATE UNIQUE INDEX IF NOT EXISTS simulation_archive_id ON simulation_archive(id);
 CREATE INDEX IF NOT EXISTS simulation_archive_scope ON simulation_archive(k,epoch,at);
 `)}
 get(row){return decode(this.db.prepare('SELECT * FROM simulations WHERE k=? AND epoch=?').get(row.key,row.state.epoch))}
 ensure(row){if(!this.get(row))this.db.prepare('INSERT INTO simulations VALUES(?,?,?,?,?)').run(row.key,row.state.epoch,0,JSON.stringify(row.state),JSON.stringify(row.state));return this.get(row)}
 entries(row,limit=100){return this.db.prepare('SELECT * FROM simulation_entries WHERE k=? AND epoch=? ORDER BY seq DESC LIMIT ?').all(row.key,row.state.epoch,Math.min(500,limit)).map(decode)}
 page(row,{page=0,pageSize=10,status='all',axis='all',from='',to='',dateFrom='',dateTo='',sourceId='',stageTo='',stageOnly=false,includePrevious=false}={}){
  if(dateFrom)from=dateBoundary(dateFrom,row.config.timezone)
  if(dateTo)to=dateBoundary(dateTo,row.config.timezone,{end:true})
  page=Number(page);pageSize=Number(pageSize)
  if(!Number.isSafeInteger(page)||page<0||page>100000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!['all','up','down','flat','revoked','privacy','manual'].includes(status)||!['all','relation','mood','arousal'].includes(axis))throw Error('记录筛选格式无效')
  const where=['k=?'],args=[row.key]
  if(stageTo!==''){const stage=Number(stageTo);if(!Number.isInteger(stage)||stage<1||stage>5)throw Error('阶段筛选无效');where.push("json_extract(after_state,'$.stage')=? AND json_extract(before_state,'$.stage')<>json_extract(after_state,'$.stage')");args.push(stage)}
  if(includePrevious!==true&&includePrevious!=='true'){where.push('epoch=?');args.push(row.state.epoch)}
  if(status==='revoked')where.push('revoked=1')
  else if(status==='manual')where.push("(type='manual' OR json_extract(result,'$.management')=1)")
  else if(status==='privacy'){where.push('type=?');args.push(status)}
  else if(status!=='all')where.push('revoked=0 AND json_extract(after_state,\'$.score\')'+({up:'>',down:'<',flat:'='}[status])+"json_extract(before_state,'$.score')")
  if(axis!=='all')where.push(axis==='relation'?"json_extract(after_state,'$.score')<>json_extract(before_state,'$.score')":axis==='arousal'?"(COALESCE(json_extract(result,'$.arousal'),0)<>0 OR (type='manual' AND json_type(command,'$.arousal')='object' AND json_extract(before_state,'$.arousal.value') IS NOT json_extract(after_state,'$.arousal.value')))":"COALESCE(json_extract(result,'$."+axis+"'),0)<>0")
  if(stageOnly===true||stageOnly==='true')where.push("json_extract(after_state,'$.stage')<>json_extract(before_state,'$.stage')")
  for(const [value,operator] of [[from,'>='],[to,'<=']])if(value!==''){const at=Number(value);if(!Number.isSafeInteger(at)||at<0)throw Error('记录日期无效');where.push('at'+operator+'?');args.push(at)}
  if(sourceId){if(typeof sourceId!=='string'||sourceId.length>200)throw Error('来源ID无效');where.push('EXISTS(SELECT 1 FROM json_each(source_ids) WHERE value=?)');args.push(sourceId)}
  const sql=where.join(' AND '),table='(SELECT * FROM simulation_entries UNION ALL SELECT * FROM simulation_archive)',total=this.db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE '+sql).get(...args).n
  page=Math.min(page,Math.max(0,Math.ceil(total/pageSize)-1))
  return {rows:this.db.prepare('SELECT * FROM '+table+' WHERE '+sql+' ORDER BY at DESC,seq DESC LIMIT ? OFFSET ?').all(...args,pageSize,page*pageSize).map(decode),total,page,pageSize,revision:this.get(row)?.revision||0}
 }
 hasSources(row,sources){return sources.some(s=>this.db.prepare('SELECT 1 FROM simulation_sources WHERE k=? AND epoch=? AND source_id=?').get(row.key,row.state.epoch,s.sourceId))}
 play(previous,entry){
  if(entry.result?.ruleVersion&&![RULE_VERSION,'relation-v1-1','relation-beta1-1'].includes(entry.result.ruleVersion))throw Error('旧规则版本不支持精确回放，请手动校准')
  if(entry.revoked)return {state:clone(previous),result:{revoked:true,actualDelta:0,afterScore:previous.score,afterStage:previous.stage}}
  if(entry.type==='privacy')throw Error('回放范围包含已遗忘来源，不能重建判断；请使用手动校准')
  if(entry.type==='manual'&&entry.command.clearStatus){const next={...clone(previous),status:'未定义',statusSource:null,revision:previous.revision+1};return {state:next,result:{management:true,statusRevoked:true,actualDelta:0,beforeStage:previous.stage,afterStage:next.stage,afterScore:next.score}}}
  if(entry.type==='manual'){const next={...clone(previous),revision:previous.revision+1};if(entry.command.score!==undefined){next.score=entry.command.score;next.stage=stageOf(next.score,entry.config)}if(entry.command.arousal)next.arousal=clone(entry.command.arousal);return {state:next,result:{management:true,actualDelta:next.score-previous.score,beforeStage:previous.stage,afterStage:next.stage,afterScore:next.score}}}
  const version=entry.result?.ruleVersion||RULE_VERSION,reducer=version==='relation-beta1-1'?legacyRound:version==='relation-v1-1'?priorRound:reduceRound;const next=reducer(previous,entry.config,entry.command);next.result.ruleVersion=version;return next
 }
 append(row,command,{manual=false,requestId=''}={}){return this.store.transaction(()=>{
  const ids=manual?[]:[...new Set(command.sources.map(s=>s.sourceId))].sort()
  if(!manual&&!ids.length)throw Error('模拟结算缺少可信来源')
  const duplicates=ids.map(id=>this.db.prepare('SELECT entry_id FROM simulation_sources WHERE k=? AND epoch=? AND source_id=?').get(row.key,row.state.epoch,id)).filter(Boolean)
  if(duplicates.length)return {duplicate:true,entryIds:[...new Set(duplicates.map(r=>r.entry_id))],simulation:this.get(row)}
  if(!manual)command={...command,sources:ids.map(sourceId=>({sourceId}))}
  const simulation=this.ensure(row),id=randomUUID(),entry={type:manual?'manual':'round',command,config:clone(row.config),revoked:false}
  const {state,result}=this.play(simulation.state,entry)
  this.db.prepare('INSERT INTO simulation_entries(id,k,epoch,round_key,type,at,config,command,before_state,after_state,result,source_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,row.key,row.state.epoch,manual?'manual:'+id:fingerprint(ids),entry.type,command.at,JSON.stringify(entry.config),JSON.stringify(command),JSON.stringify(simulation.state),JSON.stringify(state),JSON.stringify({...result,requestId,ruleVersion:RULE_VERSION}),JSON.stringify(ids))
  for(const source of ids)this.db.prepare('INSERT INTO simulation_sources VALUES(?,?,?,?)').run(row.key,row.state.epoch,source,id)
  this.db.prepare('UPDATE simulations SET state=?,revision=revision+1 WHERE k=? AND epoch=?').run(JSON.stringify(state),row.key,row.state.epoch)
  return {id,result,duplicate:false,simulation:this.get(row)}
 })}
 manual(row,score){if(this.get(row))return this.append(row,{score,at:this.store.now()},{manual:true})}
 undoPreview(row,{entryId,expectedRevision}){
  const simulation=this.get(row);if(!simulation||simulation.revision!==expectedRevision)throw Error('影子账本已变化，请重新预览')
  let entries=this.entries(row,row.config.replayLimit).filter(e=>this.store.now()-e.at<=row.config.replayDays*86400000).reverse();const target=entries.find(e=>e.id===entryId)
  if(!target||target.type!=='round'||target.revoked||this.store.now()-target.at>row.config.replayDays*86400000)throw Error('此事件不在可精确撤销窗口内；请手动校准')
  if(entries.some(e=>e.type==='privacy'&&e.seq>target.seq))throw Error('后续来源已遗忘，不能精确重建影响；请使用手动校准')
  const barrier=entries.findLastIndex(e=>e.type==='privacy'&&e.seq<target.seq);if(barrier>=0)entries=entries.slice(barrier+1)
  let state=clone(entries[0].before_state),changed=[]
  for(const entry of entries){const before=clone(state),next=this.play(state,{...entry,revoked:entry.revoked||entry.id===entryId});state=next.state;changed.push({id:entry.id,before,state:clone(state),result:next.result})}
  const moodDelta=changed.reduce((sum,c)=>sum+(c.result.mood||0)-(entries.find(e=>e.id===c.id)?.result.mood||0),0)
  return {entryId,expectedRevision,before:simulation.state,after:state,changed,affected:changed.filter(x=>x.id===entryId||entries.find(e=>e.id===x.id)?.seq>target.seq).length,scope:row.key,epoch:row.state.epoch,simulationOnly:this.namespace==='simulation',moodDelta}
 }
 undo(row,{entryId,expectedRevision,reason,confirmed}){return this.store.transaction(()=>{
  if(!confirmed||typeof reason!=='string'||!reason.trim()||reason.length>300)throw Error('请确认撤销预览并填写原因')
  const preview=this.undoPreview(row,{entryId,expectedRevision})
  for(const change of preview.changed)this.db.prepare('UPDATE simulation_entries SET before_state=?,after_state=?,result=? WHERE id=?').run(JSON.stringify(change.before),JSON.stringify(change.state),JSON.stringify({...change.result,ruleVersion:change.result.ruleVersion||RULE_VERSION}),change.id)
  this.db.prepare('UPDATE simulation_entries SET revoked=1 WHERE id=?').run(entryId)
  this.db.prepare('UPDATE simulations SET state=?,revision=revision+1 WHERE k=? AND epoch=?').run(JSON.stringify(preview.after),row.key,row.state.epoch)
  this.db.prepare('INSERT INTO simulation_revisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),row.key,row.state.epoch,this.store.now(),entryId,reason,expectedRevision,JSON.stringify({before:preview.before,after:preview.after,affected:preview.affected}))
  // Source tombstones intentionally remain: a revoked event is not eligible for delivery replay.
  return {simulation:this.get(row),affected:preview.affected,simulationOnly:true}
 })}
 clearScope(key){for(const table of ['simulations','simulation_entries','simulation_archive','simulation_sources','simulation_revisions'])this.db.prepare('DELETE FROM '+table+' WHERE k=?').run(key)}
 reviewPreview(row,input,command){
  const guard=this.undoPreview(row,input),entries=this.entries(row,row.config.replayLimit).filter(e=>e.seq>=this.entries(row,row.config.replayLimit).find(x=>x.id===guard.changed[0].id).seq).reverse()
  const target=entries.find(e=>e.id===input.entryId);if(target.result.ruleVersion!==RULE_VERSION)throw Error('旧规则记录只支持撤销或手动校准')
  let state=clone(entries[0].before_state),changed=[]
  for(const e of entries){const before=clone(state),next=this.play(state,e.id===input.entryId?{...e,command}:e);state=next.state;changed.push({id:e.id,before,state:clone(state),result:next.result})}
  return {...guard,after:state,changed,command}
 }
 review(row,input,command){return this.store.transaction(()=>{
  if(!input.confirmed)throw Error('请先确认依据复核预览')
  const preview=this.reviewPreview(row,input,command)
  for(const c of preview.changed)this.db.prepare('UPDATE simulation_entries SET before_state=?,after_state=?,result=? WHERE id=?').run(JSON.stringify(c.before),JSON.stringify(c.state),JSON.stringify(c.result),c.id)
  this.db.prepare('UPDATE simulation_entries SET command=? WHERE id=?').run(JSON.stringify(command),input.entryId)
  this.db.prepare('UPDATE simulations SET state=?,revision=revision+1 WHERE k=? AND epoch=?').run(JSON.stringify(preview.after),row.key,row.state.epoch)
  this.db.prepare('INSERT INTO simulation_revisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),row.key,row.state.epoch,this.store.now(),input.entryId,'重新核对已有来源证明',input.expectedRevision,JSON.stringify({before:preview.before,after:preview.after,affected:preview.affected}))
  return preview
 })}
}
