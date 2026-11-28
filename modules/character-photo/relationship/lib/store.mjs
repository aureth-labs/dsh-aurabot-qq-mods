import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULTS, validate, initialState, validateStartingPoint, compatibleSettings, scopeKey, clone, round, stageOf } from './policy.mjs'
import {SimulationLedger} from './ledger.mjs'
import {restoreModernSettings} from './migration.mjs'
const overlay=(base,patch)=>{const out=clone(base);for(const [k,v] of Object.entries(patch))out[k]=v&&typeof v==='object'&&!Array.isArray(v)&&base[k]&&typeof base[k]==='object'&&!Array.isArray(base[k])?overlay(base[k],v):clone(v);return out}
const tendenciesKey=key=>'arousal-tendencies:'+key
export function overridePaths(object,prefix=''){return Object.entries(object).flatMap(([key,value])=>{const path=prefix?prefix+'.'+key:key;return value&&typeof value==='object'&&!Array.isArray(value)?overridePaths(value,path):[path]})}
function withoutOverrides(overrides,paths){
 if(!Array.isArray(paths)||paths.length>200)throw Error('继承字段列表无效')
 const out=clone(overrides)
 for(const path of paths){
  if(typeof path!=='string'||!path||path.length>200)throw Error('继承字段无效')
  const keys=path.split('.');let schema=DEFAULTS,target=out
  for(const [i,key] of keys.entries()){
   if(!schema||typeof schema!=='object'||Array.isArray(schema)||!Object.hasOwn(schema,key))throw Error('未知继承字段：'+path)
   schema=schema[key]
   if(i===keys.length-1){if(target)delete target[key]}
   else target=target&&typeof target[key]==='object'&&!Array.isArray(target[key])?target[key]:null
  }
 }
 return out
}

export class RelationStore {
  constructor(file,{now=Date.now}={}) {
    mkdirSync(dirname(file),{recursive:true});this.now=now;this.db=new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;')
    this.db.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS scopes(k TEXT PRIMARY KEY,persona TEXT NOT NULL,owner TEXT NOT NULL,config TEXT NOT NULL,config_revision INTEGER NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL,epoch INTEGER NOT NULL,source_id TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(scope,epoch,source_id)); CREATE INDEX IF NOT EXISTS event_scope ON events(scope,epoch,seq); CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,scope TEXT NOT NULL,at INTEGER NOT NULL,day TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,input_reserved INTEGER NOT NULL,output_reserved INTEGER NOT NULL,input_actual INTEGER,output_actual INTEGER,details TEXT NOT NULL);')
    const version=this.meta('schema',1);if(version!==1)throw Error('关系数据版本不受支持')
    this.setMeta('schema',1)
    this.db.exec('CREATE TABLE IF NOT EXISTS request_totals(day TEXT,mode TEXT,requests INTEGER,unknown INTEGER,inputTokens INTEGER,outputTokens INTEGER,PRIMARY KEY(day,mode))')
    this.ledger=new SimulationLedger(this)
    this.committed=new SimulationLedger(this,{namespace:'committed'})
    this.db.exec('CREATE TABLE IF NOT EXISTS delivery_outbox(id TEXT PRIMARY KEY,k TEXT,epoch INTEGER,kind TEXT,payload TEXT,status TEXT DEFAULT \'pending\',error TEXT DEFAULT \'\'); CREATE TABLE IF NOT EXISTS relation_facts(id TEXT PRIMARY KEY,k TEXT,epoch INTEGER,revision INTEGER,payload TEXT);')
    restoreModernSettings(this)
  }
  meta(k,fallback=null){const row=this.db.prepare('SELECT v FROM meta WHERE k=?').get(k);return row?JSON.parse(row.v):clone(fallback)}
  setMeta(k,v){this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,JSON.stringify(v))}
  transaction(fn){if(this.inTransaction){const result=fn();if(result?.then)throw Error('存储事务不允许异步任务');return result}this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try{const result=fn();if(result?.then)throw Error('存储事务不允许异步任务');this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}finally{this.inTransaction=false}}
  configOverrides(key,config){
    config=compatibleSettings(config)
    const modern=this.meta('relation-031-options:'+key,{})
    for(const [name,entry] of Object.entries(modern)){
      const stored=config[name]
      if(stored===entry.compat||name==='dailyCap'&&stored===compatibleSettings({dailyCap:entry.compat}).dailyCap)config[name]=entry.value
    }
    const preset=this.meta('romance-preset:'+key)
    if(preset!==null)config.romancePreset=preset
    const tendencies=this.meta(tendenciesKey(key))
    return tendencies?{...config,arousal:{...config.arousal,tendencies}}:config
  }
  storeTendencies(key,overrides){
    // Keep this field outside the strict 0.1.3 configuration schema. A
    // program rollback can still load the same DB and preserve these texts.
    overrides={...overrides}
    if(Object.hasOwn(overrides,'romancePreset'))this.setMeta('romance-preset:'+key,overrides.romancePreset)
    else this.db.prepare('DELETE FROM meta WHERE k=?').run('romance-preset:'+key)
    delete overrides.romancePreset
    const modern={}
    for(const name of ['initialScore','romanceBackground','dailyCap','stageGate']){
      if(!Object.hasOwn(overrides,name))continue
      const value=overrides[name]
      if(name==='dailyCap'&&value<=20&&![3,6,8].includes(value)||name==='stageGate'&&value>=3)continue
      const compat=name==='dailyCap'?({50:3,75:6,100:8}[value]??Math.min(value,20)):name==='stageGate'?3:undefined
      modern[name]={value,compat}
      if(compat===undefined)delete overrides[name]
      else overrides[name]=compat
    }
    if(Object.keys(modern).length)this.setMeta('relation-031-options:'+key,modern)
    else this.db.prepare('DELETE FROM meta WHERE k=?').run('relation-031-options:'+key)
    const {tendencies,...arousal}=overrides.arousal||{}
    if(tendencies&&Object.keys(tendencies).length)this.setMeta(tendenciesKey(key),tendencies)
    else this.db.prepare('DELETE FROM meta WHERE k=?').run(tendenciesKey(key))
    if(tendencies===undefined)return overrides
    const stored={...overrides}
    if(Object.keys(arousal).length)stored.arousal=arousal
    else delete stored.arousal
    return stored
  }
  defaultsOverrides(){return this.configOverrides('defaults',this.meta('defaults',{}))}
  defaults(){return validate(this.defaultsOverrides())}
  defaultsSnapshot(){return {config:this.defaults(),revision:this.meta('defaults-revision',0)}}
  saveDefaults(patch,expected){return this.transaction(()=>{
    if(expected!==this.meta('defaults-revision',0))throw Error('全局默认已更新，请重新加载')
    const overrides=overlay(this.defaultsOverrides(),patch),config=validate(overrides)
    validateStartingPoint(config)
    const rows=this.db.prepare('SELECT persona,owner FROM scopes').all().map(r=>this.get(r.persona,r.owner))
    for(const row of rows){const next=validate(row.overrides,config);if(next.timezone!==row.config.timezone||next.thresholds.some((v,i)=>v!==row.config.thresholds[i]))throw Error('已有档案时不能通过全局默认重映射阈值或时区')}
    this.setMeta('defaults',this.storeTendencies('defaults',overrides));this.setMeta('defaults-revision',expected+1)
    for(const row of rows){this.db.prepare('UPDATE scopes SET config_revision=config_revision+1 WHERE k=?').run(row.key);this.event(row,'defaults:'+randomUUID(),'management',{action:'defaults',keys:Object.keys(patch)})}
    return this.defaultsSnapshot()
  })}
  get(persona,owner,{create=false}={}) {
    const k=scopeKey(persona,owner);let row=this.db.prepare('SELECT * FROM scopes WHERE k=?').get(k)
    if(!row&&create){const c=this.defaults();validateStartingPoint(c);this.db.prepare('INSERT INTO scopes VALUES(?,?,?,?,?,?)').run(k,persona,owner,'{}',1,JSON.stringify(initialState(c,this.now())));row=this.db.prepare('SELECT * FROM scopes WHERE k=?').get(k)}
    if(!row)return null
    const overrides=this.configOverrides(k,JSON.parse(row.config))
    return {key:k,persona:row.persona,owner:row.owner,overrides,configRevision:row.config_revision,config:validate(overrides,this.defaults()),state:JSON.parse(row.state)}
  }
  saveConfig(persona,owner,patch,expected,inherit=[]) {return this.transaction(()=>{
    validate(patch);withoutOverrides({},inherit)
    let row=this.get(persona,owner)
    if(!row){
      if(expected!==0)throw Error('档案尚未创建，请刷新配置')
      const config=validate(patch,this.defaults()),key=scopeKey(persona,owner);validateStartingPoint(config)
      this.db.prepare('INSERT INTO scopes VALUES(?,?,?,?,?,?)').run(key,persona,owner,JSON.stringify(this.storeTendencies(key,patch)),1,JSON.stringify(initialState(config,this.now())))
      row=this.get(persona,owner);this.event(row,'config:'+randomUUID(),'management',{action:'config',keys:Object.keys(patch),created:true});return row
    }
    if(row.configRevision!==expected)throw Error('配置已在别处更新，请重新加载后合并')
    if(['initialStage','initialScore'].some(k=>Object.hasOwn(patch,k)&&patch[k]!==row.config[k]))validateStartingPoint(validate(patch,row.config))
    validate(patch,row.config)
    const overrides=overlay(withoutOverrides(row.overrides,inherit),patch),c=validate(overrides,this.defaults())
    // Configuration changes never silently remap a saved score or stage.
    if(c.thresholds.some((v,i)=>v!==row.config.thresholds[i]))throw Error('当前版本暂不开放运行中阈值重映射；请保留原阈值')
    if(c.timezone!==row.config.timezone)throw Error('当前版本暂不开放改统计时区，避免重复额度')
    this.db.prepare('UPDATE scopes SET config=?,config_revision=config_revision+1 WHERE k=?').run(JSON.stringify(this.storeTendencies(row.key,overrides)),row.key)
    this.event(row,'config:'+randomUUID(),'management',{action:'config',keys:Object.keys(patch)})
    return this.get(persona,owner)
  })}
  saveState(row,state){this.db.prepare('UPDATE scopes SET state=? WHERE k=?').run(JSON.stringify(state),row.key)}
  event(row,source,kind,body){const e={id:randomUUID(),scope:row.key,epoch:row.state.epoch,source,at:this.now(),kind,body};this.db.prepare('INSERT INTO events(id,scope,epoch,source_id,at,kind,body) VALUES(?,?,?,?,?,?,?)').run(e.id,e.scope,e.epoch,source,e.at,kind,JSON.stringify(body));return e}
  duplicate(row,source){return !!this.db.prepare('SELECT 1 FROM events WHERE scope=? AND epoch=? AND source_id=?').get(row.key,row.state.epoch,source)}
  history(row,limit=100){return this.db.prepare('SELECT * FROM events WHERE scope=? AND epoch=? ORDER BY seq DESC LIMIT ?').all(row.key,row.state.epoch,Math.min(500,limit)).map(e=>({...e,body:JSON.parse(e.body)}))}
  adjust(persona,owner,{score,stage,status,arousal,expectedRevision}) {return this.transaction(()=>{
    const row=this.get(persona,owner,{create:true});if(row.state.revision!==expectedRevision)throw Error('当前状态已变化，请刷新')
    if(status!==undefined)throw Error('关系名分不能通过手动改分创建，请保留实际互动依据')
    const hasArousal=arousal!==undefined
    let value=score;if(value===undefined)value=Number.isInteger(stage)&&stage>=1&&stage<=5?row.config.thresholds[stage-1]:(hasArousal?row.state.score:undefined)
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)throw Error('分数需在0～100')
    if(hasArousal&&(typeof arousal!=='number'||!Number.isFinite(arousal)||arousal<0||arousal>100))throw Error('情欲值需在0～100')
    const roundedScore=round(value)
    const next={...row.state,score:roundedScore,stage:score===undefined&&stage===undefined?row.state.stage:stageOf(roundedScore,row.config),revision:row.state.revision+1}
    if(hasArousal)next.arousal={value:round(arousal),at:this.now()}
    this.committed.ensure(row);this.saveState(row,next);const command={at:this.now(),...(score!==undefined||stage!==undefined?{score:next.score}:{}),...(hasArousal?{arousal:next.arousal}:{})}
    for(const ledger of [this.ledger,this.committed])if(ledger.get(row))ledger.append(row,command,{manual:true});this.event(row,'manual:'+randomUUID(),'management',{action:'adjust',before:row.state,after:next});return this.get(persona,owner)
  })}
  reset(persona,owner,{expectedRevision,expectedEpoch,confirmed}) {return this.transaction(()=>{
    const row=this.get(persona,owner,{create:true});if(!confirmed||row.state.revision!==expectedRevision||row.state.epoch!==expectedEpoch)throw Error('重置预览已变化，请刷新确认')
    const next=initialState(row.config,this.now());next.epoch=row.state.epoch+1;next.revision=row.state.revision+1;next.historyBefore=this.now()
    this.event(row,'reset:'+randomUUID(),'management',{action:'reset',nextEpoch:next.epoch})
    this.saveState(row,next);return this.get(persona,owner)
  })}
  reserve({id,row,day,mode,input,output}) {return this.transaction(()=>{
    const c=row.config.judge,used=this.db.prepare("SELECT COUNT(*) n,COALESCE(SUM(COALESCE(input_actual,input_reserved)),0) i,COALESCE(SUM(COALESCE(output_actual,output_reserved)),0) o FROM requests WHERE day=? OR (? > ? AND at>=?)").get(day,this.meta('timezone-budget-until',0),this.now(),this.now()-86400000)
    if(used.n+1>c.dailyRequests||used.i+input>c.dailyInputTokens||used.o+output>c.dailyOutputTokens)throw Error('关系判定当日预算不足')
    this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,row.key,this.now(),day,mode,'running',input,output,null,null,'{}')
  })}
  settle(id,status,{usage,details={}}={}) {
    const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&Number.isSafeInteger(n)
    const output=usage?.outputTokens
    // DSH DeepSeek Messages reports cached input separately; total includes it.
    // Other adapters may already include caches in inputTokens. Do not add twice.
    const input=valid(usage?.totalTokens)&&valid(output)&&valid(usage?.inputTokens)&&usage.totalTokens>=usage.inputTokens+output?usage.totalTokens-output:usage?.inputTokens
    const complete=valid(input)&&valid(output)
    this.db.prepare('UPDATE requests SET status=?,input_actual=?,output_actual=?,details=? WHERE id=?').run(status,complete?input:null,complete?output:null,JSON.stringify({...details,usageKnown:complete,rawUsage:usage||null}),id)
  }
  usage(){return this.db.prepare('SELECT day,mode,SUM(requests) requests,SUM(unknown) unknown,SUM(inputTokens) inputTokens,SUM(outputTokens) outputTokens FROM (SELECT day,mode,COUNT(*) requests,SUM(CASE WHEN input_actual IS NULL THEN 1 ELSE 0 END) unknown,SUM(COALESCE(input_actual,input_reserved)) inputTokens,SUM(COALESCE(output_actual,output_reserved)) outputTokens FROM requests GROUP BY day,mode UNION ALL SELECT * FROM request_totals) GROUP BY day,mode ORDER BY day DESC LIMIT 60').all()}
  close(){this.closed=true;this.db.close()}
}
