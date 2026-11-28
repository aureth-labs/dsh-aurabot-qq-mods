import {randomUUID} from 'node:crypto'
import {validate,compatibleSettings,clone,stageOf,round} from './policy.mjs'

export const PRESETS={
 gentle:{name:'自然节奏',description:'保持目前的温和起步，心情起伏不随阶段放大或缩小。',patch:{recoverBoost:{enabled:false},rules:{firstMeetBonus:0,turnRelationPositive:3,stageMoodCoefficients:Array.from({length:5},()=>({negative:1,positive:1})),eventValues:{milestone:{relation:3,mood:8,arousal:0},praise:{relation:.3,mood:4,arousal:0},'ask-intimate':{relation:0,mood:0,arousal:8}}}}},
 original:{name:'原稿节奏',description:'恢复原DSH稿的阶段差异、首次积极互动与慢修复。深夜时长奖励和午夜重置仍按后续决定取消。',patch:{recoverBoost:{enabled:true,days:5,factor:1.25,dailyFirstBonus:2},rules:{firstMeetBonus:.5,turnRelationPositive:5,stageMoodCoefficients:[{negative:1.3,positive:.6},{negative:1.15,positive:.75},{negative:.9,positive:.9},{negative:.65,positive:1.05},{negative:.35,positive:1.2}],eventValues:{milestone:{relation:5,mood:8,arousal:5},praise:{relation:.3,mood:4,arousal:3},'ask-intimate':{relation:0,mood:-1,arousal:8}}},stageProfiles:[
  {meaning:'初步认识',daily:'客气、有自己的距离，不主动接私事。是否带刺由原人格决定。',optional:'会挡开；按人格表达距离，不把普通请求直接判成关系损伤。'},
  {meaning:'逐渐熟络',daily:'聊得来、守住自己的界线，也开始关心近况。',optional:'可以害羞挡开或转移话题。'},
  {meaning:'亲近与信任',daily:'可以撒娇、寻求陪伴、表达在意；具体方式保持原人格。',optional:'可接亲近的玩笑和暗示，但不预设更进一步的行动。'},
  {meaning:'暧昧与主动靠近',daily:'愿意亲近、主动联系，按原来的性格表达。',optional:'可以亲吻、抚摸，表达偏含蓄；仍看双方当轮回应。'},
  {meaning:'稳定深入的亲近',daily:'愿意表白和主动，关系名分仍以双方实际确认的来源为准。',optional:'可以主动表达亲密需要，具体尺度沿用独立亲密正文；高阶段不等于每次都必须接受。'}
 ]}}
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const object=x=>x&&typeof x==='object'&&!Array.isArray(x)
export function configurationDiff(before,after,path=''){
 if(same(before,after))return []
 if(before&&after&&typeof before==='object'&&typeof after==='object')return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(k=>configurationDiff(before[k],after[k],path?path+'.'+k:k))
 return [{path,before:before??null,after:after??null}]
}
/** Three-way merge: unchanged fields follow the other editor; conflicts stay explicit. */
export function mergeDraft(base,local,remote){
 const conflicts=[]
 const walk=(b,l,r,path)=>{
  if(same(l,b))return clone(r)
  if(same(r,b)||same(l,r))return clone(l)
  if(object(b)&&object(l)&&object(r))return Object.fromEntries(Object.keys(r).map(k=>[k,walk(b[k],l[k],r[k],path?path+'.'+k:k)]))
  conflicts.push({path,local:clone(l),remote:clone(r)});return clone(l)
 }
 return {merged:walk(validate(base),validate(local),validate(remote),''),conflicts}
}
export class Configuration {
 constructor(service){this.service=service;this.store=service.store}
 row(persona){const row=this.store.get(persona,this.service.owner());if(!row)throw Error('请先建立这段关系');return row}
 exportArchive(persona){
  this.service.archive.flushPrivacy?.()
  return this.store.transaction(()=>{
   const row=this.row(persona),ledger=this.store.committed,history=[]
   for(let page=0;;page++){
    const result=ledger.page(row,{page,pageSize:100,includePrevious:true});history.push(...result.rows)
    if(history.length>=result.total)break
   }
   const facts=this.store.db.prepare('SELECT payload FROM relation_facts WHERE k=? ORDER BY rowid').all(row.key).map(r=>JSON.parse(r.payload))
   const corrections=ledger.db.prepare('SELECT * FROM simulation_revisions WHERE k=? ORDER BY at').all(row.key).map(({result,...r})=>({...r,result:JSON.parse(result)}))
   return {format:'aurabot-relation-readable-archive',version:1,exportedAt:new Date(this.service.now()).toISOString(),persona:row.persona,owner:row.owner,config:row.config,state:row.state,statusSource:row.state.statusSource||null,facts,history,corrections,sourcePolicy:'保留来源标识与尚未遗忘的判断短引，不额外复制完整聊天或原人格卡。已遗忘内容不会从备份或历史中找回。此可读档案不直接导入，以免覆盖现有状态；恢复使用版本配套的数据库备份。'}
  })
 }
 bindingPreview({persona,owner}){
  if(typeof owner!=='string'||!/^\d{5,20}$/.test(owner))throw Error('请输入有效的主人账号')
  const current=this.store.get(persona,this.service.owner()),next=this.store.get(persona,owner)
  const describe=r=>r?{configured:true,score:r.state.score,stage:r.state.stage,stageName:r.config.stageNames[r.state.stage-1],status:r.state.status,epoch:r.state.epoch}:{configured:false}
  return {currentOwner:this.service.owner(),nextOwner:owner,persona,current:describe(current),next:describe(next),changed:owner!==this.service.owner(),message:owner===this.service.owner()?'账号相同，不会更换关系档案。':'当前账号的关系保留。切换后使用目标账号的独立档案；没有档案则等待新建，不搬运好感、事实、名分或私聊设定。这里只做预览，更换账号仍在 Aurabot 权限页操作。'}
 }
 merge({persona,base,local}){const row=this.row(persona);return {...mergeDraft(base,local,row.config),revision:row.configRevision,latest:row.config}}
 preset({persona,id,patch={}}){const preset=PRESETS[id];if(!preset)throw Error('预设不存在');const row=this.row(persona),current=validate(patch,row.config),config=validate(preset.patch,current);return {name:preset.name,description:preset.description,config,revision:row.configRevision,diff:configurationDiff(current,config),changed:Object.keys(preset.patch)}}
 export(persona){const row=this.row(persona);return {format:'aurabot-relation-settings',version:1,exportedAt:new Date(this.service.now()).toISOString(),persona:row.persona,settings:row.config,progress:{score:row.state.score,stage:row.state.stage},note:'仅用于可读设定备份和跨人格迁移；聊天、事实证明与已确认名分不在此文件中。完整历史通过NAS关系数据库备份保留。'}}
 importPreview({persona,bundle,revision}){const row=this.row(persona);if(row.configRevision!==revision)throw Error('配置已变化');if(!bundle||bundle.format!=='aurabot-relation-settings'||bundle.version!==1)throw Error('不支持此设定文件版本');const config=validate(compatibleSettings(bundle.settings));config.mode='off';config.initialStage=row.config.initialStage;config.initialScore=row.config.initialScore;return {config,revision,fromPersona:String(bundle.persona||'').slice(0,200),warning:'将导入独立设定并先暂停此角色，不导入分数、名分或别人的经历。确认后填入草稿，再由你保存。',diff:configurationDiff(row.config,config),changed:Object.keys(config).filter(k=>!same(config[k],row.config[k]))}}
 transitionPreview({persona,thresholds,timezone,mode='preserve-stage',revision}){
  const row=this.row(persona);if(row.configRevision!==revision)throw Error('配置已更新，请刷新')
  if(!['preserve-stage','preserve-score'].includes(mode))throw Error('请选择映射方式')
  const patch={...(thresholds?{thresholds}:{}),...(timezone?{timezone}:{})},config=validate(patch,row.config)
  const i=row.state.stage-1,progress=(row.state.score-row.config.thresholds[i])/(row.config.thresholds[i+1]-row.config.thresholds[i])
  const score=mode==='preserve-stage'?round(config.thresholds[i]+progress*(config.thresholds[i+1]-config.thresholds[i])):row.state.score
  const token=randomUUID(),plan={persona,owner:row.owner,patch,score,stage:stageOf(score,config),revision,stateRevision:row.state.revision,epoch:row.state.epoch,expires:this.service.now()+300000}
  this.store.setMeta('configuration-preview:'+token,plan)
  return {token,before:{score:row.state.score,stage:row.state.stage,timezone:row.config.timezone},after:{score,stage:plan.stage,timezone:config.timezone},warning:'确认后保留记录，但此前记录退出精确撤销窗口；请先处理需要纠正的旧判断。改时区后24小时按已用额度继续限额，不重新获得今日奖励或模型额度。'}
 }
 transition({token,confirmed}){
  if(!confirmed)throw Error('请先确认变更预览')
  return this.store.transaction(()=>{
   const plan=this.store.meta('configuration-preview:'+token);if(!plan||plan.expires<this.service.now()||plan.owner!==this.service.owner())throw Error('变更预览已过期')
   const row=this.row(plan.persona);if(row.configRevision!==plan.revision||row.state.revision!==plan.stateRevision||row.state.epoch!==plan.epoch)throw Error('关系或配置已变化，请重新预览')
   this.service.cancel(row.key)
   const now=this.service.now(),next={...row.state,score:plan.score,stage:plan.stage,revision:row.state.revision+1}
   if(plan.patch.timezone&&plan.patch.timezone!==row.config.timezone){
    const gain=this.store.committed.db.prepare("SELECT COALESCE(SUM(COALESCE(json_extract(result,'$.positive'),0)),0) n FROM (SELECT * FROM simulation_entries UNION ALL SELECT * FROM simulation_archive) WHERE k=? AND at>=? AND revoked=0").get(row.key,now-86400000).n
    next.quotaCarryValue=Math.max(gain,row.state.quotaCarryUntil>now?row.state.quotaCarryValue||0:0);next.quotaCarryUntil=now+86400000
    this.store.setMeta('timezone-budget-until',now+86400000)
   }
   const overrides=this.store.storeTendencies(row.key,{...row.overrides,...plan.patch})
   this.store.db.prepare('UPDATE scopes SET config=?,config_revision=config_revision+1,state=? WHERE k=?').run(JSON.stringify(overrides),JSON.stringify(next),row.key)
   // Explicit configuration boundary. No old rules are silently replayed through a
   // new threshold map, and all player-visible entries stay in the archive.
   for(const ledger of [this.store.ledger,this.store.committed]){
    ledger.db.prepare('INSERT OR IGNORE INTO simulation_archive SELECT * FROM simulation_entries WHERE k=? AND epoch=?').run(row.key,row.state.epoch)
    ledger.db.prepare('UPDATE simulation_archive SET type=CASE WHEN type=\'privacy\' THEN type ELSE \'archived\' END WHERE k=? AND epoch=?').run(row.key,row.state.epoch)
    ledger.db.prepare('DELETE FROM simulation_entries WHERE k=? AND epoch=?').run(row.key,row.state.epoch)
    ledger.db.prepare('UPDATE simulations SET base=?,state=?,revision=revision+1 WHERE k=? AND epoch=?').run(JSON.stringify(next),JSON.stringify(next),row.key,row.state.epoch)
   }
   this.store.event(row,'transition:'+token,'management',{action:'configuration-transition',before:{score:row.state.score,stage:row.state.stage},after:{score:next.score,stage:next.stage},keys:Object.keys(plan.patch)})
   this.store.db.prepare('DELETE FROM meta WHERE k=?').run('configuration-preview:'+token)
   return this.row(plan.persona)
  })
 }
}
