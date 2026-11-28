import { randomUUID } from 'node:crypto'
import { RelationStore,overridePaths } from './store.mjs'
import { DEFAULTS, MEMORY, SDK, VERSION, clone, validate, validateStartingPoint, initialState,idleFactor,arousalValue,clamp } from './policy.mjs'
import { arousalBand, templateNotice, renderContext } from './context.mjs'
import { requestJudgement } from './judge.mjs'
import {InteractionCollector} from './collector.mjs'
import {LiveState} from './live.mjs'
import {FactRegistry} from './facts.mjs'
import {RelationPrivacy} from './privacy.mjs'
import {RelationConsumers} from './consumers.mjs'
import {Configuration} from './configuration.mjs'
import {RelationActivities} from './activities.mjs'
import {Retention} from './retention.mjs'
import {calibrated,CALIBRATION} from './calibration.mjs'
import {MediaReuse,visualContext,photoReplyContext} from './media.mjs'
import {SemanticReview} from './semantic-review.mjs'

export class RelationService {
  constructor({file,config,settings,model,memory=()=>globalThis[MEMORY],mood=()=>null,modules=()=>[],hostIntegrations=()=>null,dependencies=()=>({resetReady:true}),sourceCheck,archive,deliver,now=Date.now}) {
    this.store=new RelationStore(file,{now});this.config=config;this.settings=settings;this.memory=memory;this.mood=mood;this.modules=modules;this.hostIntegrations=hostIntegrations;this.dependencies=dependencies;this.model=model;this.now=now;this.pending=new Map();this.queue=Promise.resolve();this.closed=false;this.lastIssue='';this.autoJudgeInvocations=0
    this.collector=new InteractionCollector(this,{sourceCheck});this.activities=new RelationActivities(this);this.retention=new Retention(this);this.media=new MediaReuse(this);this.semanticReview=new SemanticReview(this)
    this.archive=archive||{check:()=>false,find:()=>null,recent:()=>[]};this.deliver=deliver||(()=>{throw Error('外部同步适配不可用')});this.live=new LiveState(this);this.facts=new FactRegistry(this);this.privacy=new RelationPrivacy(this);this.consumers=new RelationConsumers(this);this.configuration=new Configuration(this);this.modelLeases=new Map()
  }
  owner(){return String(this.config().ownerQQ||'')}
  persona(){return String(this.config().persona?.current||'default')}
  presentation(persona=this.persona()){
    const row=this.owner()?this.store.get(persona,this.owner()):null
    if(!row||this.store.meta('reset-pending:'+row.key)||this.store.meta('setup-required:'+row.key))return null
    return {persona,stage:row.state.stage,stageName:row.config.stageNames[row.state.stage-1],score:row.state.score,paused:!this.enabled()||!['manual','auto'].includes(row.config.mode)}
  }
  enabled(){return !this.closed&&this.settings().enabled===true&&this.config().enabled!==false&&this.config().debug!==true}
  compatibility(details=false){
    const memory=this.memory(),cfg=this.config(),issues=[]
    if(!memory?.managed?.()||!memory?.session||!memory?.capture)issues.push('需要匹配的人设记忆宿主桥；关闭增强可用，卸载桥不等同')
    if(globalThis[SDK]?.api!==1)issues.push('需要关系模块DSH请求适配')
    if(!this.dependencies().resetReady)issues.push('需要关系档案统一重置适配，避免重开人格后带回旧关系')
    if(this.dependencies().lifecycleReady===false)issues.push('关系来源遗忘与重开适配需要更新')
    if(this.dependencies().photoReady===false)issues.push('当前照片模块缺少相处联动适配，请按组合包更新')
    const modules=this.modules()
    const isRunning=m=>[true,'user','builtin'].includes(m.running),isEnabled=m=>isRunning(m)&&m.enabled!==false&&(m.flag?cfg.ext?.[m.id]?.[m.flag]??m.defaults?.[m.flag]??true:cfg.ext?.[m.id]?.enabled!==false)
    const running=id=>modules.some(m=>m.id===id&&isEnabled(m))
    for(const id of ['love-mode','impression-card'])if(running(id))issues.push(id+'正在运行关系提示；请选择一个关系提供方')
    const integrations=[{name:'人设记忆管理 / 原生记忆',status:memory?.managed?.()?'已接入':'等待档案接入',detail:'遗忘与重开会同步关系来源，原人格卡保持原样。'},{name:'主人私聊',status:this.dependencies().liveReady?'可随交流发展':'自动判定待接入',detail:'只根据玩家互动内容判断，不按任务成功、次数或费用加分。'},{name:'群聊与其他私聊',status:'独立场景',detail:'仅按设置影响心情，不读取或增加主人私聊关系。'},{name:'人设形象锚定',status:running('character-photo')?'已启用':'未启用',detail:'新图、旧图、主动图与日记配图在生成和发送前核对当前设定。'},{name:'B站、游戏与其他玩法',status:'通用工具回执接入',detail:'已发送内容可形成交流；工具结果本身不当作玩家经历。'},{name:'跨会话记忆',status:running('cross-session-memory')?'请检查记忆模块互斥提示':'未检测到运行',detail:'仍遵守人设记忆管理自己的互斥规则，不提供第二套记忆。'}]
    let host=null
    if(details)try{host=this.hostIntegrations()}catch{}
    if(host?.memoryMode)integrations[0].status=({native:'原生记忆接续',enhanced:'增强记忆',paused:'记忆暂停',switching:'正在切换'})[host.memoryMode]||integrations[0].status
    integrations[5].status=running('history-vault')||running('cross-session-memory')?'请核对原记忆提供方的互斥提示':'未检测到运行'
    if(host?.activePolicy)integrations.push({name:'主动联系',status:host.activePolicy==='purpose'?'目的引擎':host.activePolicy==='speakup'?'原主动搭话':'使用宿主策略',detail:'沿用当前宿主策略、静音、安静时段与额度，关系只调整原频率。'})
    const tested={'character-photo':['0.4.2','0.4.3'],'persona-memory':['0.1.0-beta.8'],'character-relation':[VERSION]}
    const capabilities=modules.map(m=>{
      const sameHost=host?.memoryRows?.find(x=>x.id===m.id&&x.version===m.version)
      const coverage=tested[m.id]?(tested[m.id].includes(m.version)?'本机组合版本已适配':'版本变化，需重新验证'):['memory','mood','purpose','speakup','diary','qzone-social'].includes(m.id)&&m.running==='builtin'?'已接宿主关键链路':'通用工具收发范围'
      return {id:m.id,name:m.name||m.id,version:m.version||'宿主内置',provider:m.running==='builtin'?'原生':m.running==='user'?(m.community?'市场版本':'用户模块'):'未运行',running:isRunning(m),enabled:!!isEnabled(m),coverage,hostRole:sameHost?.status||'',detail:({shitu:'复用已有OCR／画面描述；关闭或无结果时不猜画面。',night:'保留睡眠与原调度限制；关系不能绕过暂停。',beliefs:'保留观点处理；不把观点文本当玩家事实，记忆互斥由原模块管理。','token-budget':'原预算管家仍限制其负责的入口；关系判定另有每日额度，两个账本不能相加。','history-vault':'遵循人设记忆管理的提供方互斥，不同时写两套记忆。','character-photo':'复用照片模块已确认送达的引用和描述；任务成功与费用不自动加分。','persona-memory':'同人格档案、来源遗忘和重开接口。'})[m.id]||'只判断经过已接入接口的实际交流；独立定时器、直接SDK或外部出口需逐模块核对。'}
    })
    return {supported:issues.length===0,issues,modules,integrations,capabilities,automaticReady:this.dependencies().liveReady===true,publicContextReady:true,stage:'主人私聊关系；其他域独立心情与场景'}
  }
  resolve(session,{anyDomain=false}={}) {
    if(!this.enabled()||!this.compatibility().supported)return null
    const gate=this.memory(),entry=gate.session(String(session.id))
    if(!entry||entry.retired||entry.persona!==this.persona()||(!anyDomain&&entry.chatId!=='private:'+this.owner())||! /^(private|group):[^:]+$/.test(entry.chatId))return null
    const captured=gate.capture(entry.chatId)
    try {gate.assert(captured)}catch{return null}
    if(captured?.input?.persona!==entry.persona||captured.generation!==entry.generation)return null
    return {persona:entry.persona,owner:this.owner(),chatId:entry.chatId,captured}
  }
  contextForSession(session) {
    this.archive.flushPrivacy?.()
    const context=this.resolve(session,{anyDomain:true});if(!context)return {text:''}
    const row=this.store.get(context.persona,context.owner)
    if(row&&(this.store.meta('reset-pending:'+row.key)||this.store.meta('setup-required:'+row.key)))return {text:'',blocked:true,reason:'关系重开正在等待历史上下文同步'}
    const scope=context.chatId==='private:'+this.owner()?'owner-private':context.chatId.startsWith('group:')?'public':'other-private'
    const storyStatus=scope==='owner-private'&&row&&['auto','manual'].includes(row.config.mode)?this.facts.storyStatus(row,context.captured):null
    const rendered=renderContext(row,{scope,globalOptional:true,now:this.now(),storyStatus})
    if(scope==='owner-private'&&rendered.text)rendered.diagnosticScope={key:row.key,epoch:row.state.epoch}
    if(rendered.blocked)this.lastIssue=rendered.reason
    return rendered
  }
  snapshot(persona=this.persona()) {
    this.archive.flushPrivacy?.()
    const row=this.owner()?this.store.get(persona,this.owner()):null
    const resetPending=row?!!this.store.meta('reset-pending:'+row.key):false
    const setupRequired=row?!!this.store.meta('setup-required:'+row.key):false
    const now=this.now(),compatibility=this.compatibility(true),runningPersona=this.persona()
    const events=row?this.store.history(row):[]
    const lastSettledAt=row?this.store.db.prepare(
      "SELECT max(at) AS at FROM (SELECT at,command FROM committed_entries WHERE k=? AND epoch=? AND type='round' UNION ALL SELECT at,command FROM committed_archive WHERE k=? AND epoch=? AND type='round') WHERE coalesce(json_extract(command,'$.scope'),'owner-private')='owner-private'"
    ).get(row.key,row.state.epoch,row.key,row.state.epoch).at:null
    const ready=!!row&&this.automaticReady(row)
    const automatic={ready,profile:CALIBRATION,configured:this.automaticActive(row,ready)&&persona===runningPersona,observed:this.collector.ownerStatus(row),lastSettledAt}
    const optionalValue=row?arousalValue(row.state,row.config,now):null
    let optionalDisplay=null
    if(row){
      const c=row.config
      if(!c.optionalEnabled||!c.arousal.enabled)optionalDisplay='未启用'
      else if(!this.enabled()||!compatibility.supported||resetPending||setupRequired||persona!==runningPersona||!['manual','auto'].includes(c.mode))optionalDisplay='已暂停'
      else if(row.state.stage<c.stageGate)optionalDisplay='第 '+c.stageGate+' 阶段起'
      else optionalDisplay=renderContext(row,{globalOptional:true,now}).optionalIncluded?arousalBand(c,optionalValue).label:'已暂停'
    }
    return {resetPending,setupRequired,binding:{otherOwnerArchives:this.store.db.prepare('SELECT COUNT(*) n FROM scopes WHERE persona=? AND owner<>?').get(persona,this.owner()).n,policy:'切换主人或角色会使用独立关系；旧关系保留，不自动搬给新对象。'},version:VERSION,viewingPersona:persona,runningPersona,owner:this.owner(),configured:!!row&&!setupRequired,
      row:row||{persona,owner:this.owner(),overrides:{},config:this.store.defaults(),configRevision:0,state:null},defaults:this.store.defaultsSnapshot(),overridePaths:row?overridePaths(row.overrides):[],
      simulation:row?this.store.ledger.get(row):null,simulationEvents:row?this.store.ledger.entries(row):[],committed:row?this.store.committed.get(row):null,committedEvents:row?this.store.committed.entries(row):[],outbox:row?this.live.pending(row):[],facts:row?this.facts.list(row):[],automatic,capture:{...this.collector.metrics,pending:this.collector.turns.size,modelCalls:this.autoJudgeInvocations},
      mood:this.mood(),optionalValue,optionalDisplay,events,usage:this.store.usage(),compatibility,pending:this.pending.size,lastIssue:this.lastIssue}
  }
  create(persona){if(!this.owner())throw Error('请先配置Aurabot主人账号');return this.store.get(persona,this.owner(),{create:true})}
  save({persona,patch,revision,inherit=[]}) {
    if(!patch||typeof patch!=='object')throw Error('设置无效')
    if(!this.owner())throw Error('请先配置Aurabot主人账号');this.cancel(JSON.stringify([persona,this.owner()]))
    if(patch.arousal?.template){const issue=templateNotice(patch.arousal.template);if(issue)throw Error(issue)}
    return this.store.transaction(()=>{
      const old=this.store.get(persona,this.owner()),setup=old&&this.store.meta('setup-required:'+old.key)
      if(setup){
        if(patch.mode===undefined)patch={...patch,mode:setup.resumeMode||'auto'}
        if(this.store.meta('reset-pending:'+old.key))throw Error('关系重开尚未同步完成')
        validateStartingPoint(validate(patch,old.config))
      }
      const next=this.store.saveConfig(persona,this.owner(),patch,revision,inherit)
      if(setup){
        const state={...initialState(next.config,this.now()),epoch:old.state.epoch,revision:old.state.revision+1,historyBefore:old.state.historyBefore}
        this.store.saveState(next,state)
        this.store.db.prepare('DELETE FROM meta WHERE k=?').run('setup-required:'+old.key)
      }
      return this.store.get(persona,this.owner())
    })
  }
  saveDefaults({patch,revision}){
    if(Object.hasOwn(patch,'mode'))throw Error('运行模式按人格设置')
    this.cancel()
    return this.store.saveDefaults(patch,revision)
  }
  undoPreview({persona,...input}){const row=this.store.get(persona,this.owner());if(!row)throw Error('档案不存在');return this.store.ledger.undoPreview(row,input)}
  undo({persona,...input}){const row=this.store.get(persona,this.owner());if(!row)throw Error('档案不存在');this.cancel(row.key);return this.store.ledger.undo(row,input)}
  adjust({persona,...input}){this.cancel(JSON.stringify([persona,this.owner()]));return this.store.adjust(persona,this.owner(),input)}
  async reset({persona,...input}){
    const key=JSON.stringify([persona,this.owner()]);this.cancel(key)
    const existing=this.store.meta('reset-pending:'+key)
    if(!existing&&typeof this.archive.resetBoundary!=='function')throw Error('需要关系重开与历史记忆适配，请先完成升级')
    if(!existing)this.store.transaction(()=>{
      const row=this.store.reset(persona,this.owner(),input)
      this.retention.clearLegacySources(key)
      if(input.restart===true){
        this.store.ledger.clearScope(key);this.live.clear(key);this.collector.clearScope(key)
        this.store.setMeta('setup-required:'+key,{resumeMode:row.config.mode})
        this.store.saveConfig(persona,this.owner(),{mode:'off'},row.configRevision)
        this.store.db.prepare('DELETE FROM events WHERE scope=?').run(key)
      }
      this.store.setMeta('reset-pending:'+key,{id:randomUUID(),persona,owner:row.owner,epoch:row.state.epoch,at:this.now()})
      return row
    })
    const job=this.store.meta('reset-pending:'+key)
    await this.archive.resetBoundary(job)
    this.store.db.prepare('DELETE FROM meta WHERE k=?').run('reset-pending:'+key)
    return this.store.get(persona,this.owner())
  }
  memoryReset({resetId,scopes,selection={}}) {
    if(typeof resetId!=='string'||!resetId||!Array.isArray(scopes))throw Error('统一重置身份无效')
    const rows=this.store.db.prepare('SELECT persona,owner FROM scopes').all().map(r=>this.store.get(r.persona,r.owner)).filter(r=>selection.all||selection.persona===r.persona||scopes.some(s=>s.persona===r.persona&&s.audience==='private'&&s.subject===r.owner))
    for(const row of rows)this.cancel(row.key)
    return this.store.transaction(()=>{
      if(this.store.meta('memory-reset:'+resetId))return {verified:true,duplicate:true}
      for(const row of rows){const next=initialState(row.config,this.now());next.epoch=row.state.epoch+1;next.revision=row.state.revision+1;this.store.saveState(row,next);this.store.db.prepare('DELETE FROM events WHERE scope=?').run(row.key);this.store.ledger.clearScope(row.key);this.live.clear(row.key);this.collector.clearScope(row.key);this.retention.clearLegacySources(row.key);this.store.db.prepare("DELETE FROM meta WHERE k=?").run("reset-pending:"+row.key)}
      this.store.setMeta('memory-reset:'+resetId,{at:this.now(),count:rows.length});return {verified:true,count:rows.length}
    })
  }
  deletePersona(persona){
    if(typeof persona!=='string'||!persona)throw Error('人格标识无效')
    return this.store.transaction(()=>{
      const db=this.store.db
      for(const {k:key} of db.prepare('SELECT k FROM scopes WHERE persona=?').all(persona)){
        this.cancel(key)
        this.store.ledger.clearScope(key)
        this.live.clear(key)
        this.collector.clearScope(key)
        this.retention.clearLegacySources(key)
        db.prepare('DELETE FROM events WHERE scope=?').run(key)
        db.prepare("UPDATE requests SET scope='',details='{}' WHERE scope=?").run(key)
        db.prepare("DELETE FROM meta WHERE k IN (?,?,?,?,?) OR substr(k,1,length(?))=?").run('arousal-tendencies:'+key,'relation-031-options:'+key,'reset-pending:'+key,'setup-required:'+key,'romance-preset:'+key,'seen:'+key+':','seen:'+key+':')
      }
      db.prepare("DELETE FROM meta WHERE k LIKE 'configuration-preview:%' AND json_extract(v,'$.persona')=?").run(persona)
      db.prepare('DELETE FROM scopes WHERE persona=?').run(persona)
    })
  }
  diagnostics(persona,card){
    const row=this.store.get(persona,this.owner())
    if(!row)return {note:'该人格尚未建立关系档案。'}
    const projected=this.preview({persona}),last=this.lastProjection
    const outside=this.preview({persona,scope:'public'}),other=this.preview({persona,scope:'other-private'})
    const observed=row.key===last?.key&&row.state.epoch===last.epoch?last:null
    const conflict=typeof card==='string'&&card.match(/(?:永远不|绝对不|绝不会|从不|绝不)(?:会)?(?:谈恋爱|恋爱|爱上任何人|接受恋爱关系)/u)
    return {note:projected.reason||'已保存设定可组装。',tokens:projected.estimatedTokens||0,limit:row.config.contextTokens,
      outside:outside.reason||'公开场景使用独立社交提示。',other:other.reason||'其他私聊使用独立社交提示。',optional:!!projected.optionalIncluded,cardPhrase:conflict?.[0]||'',cardRead:typeof card==='string'&&!!card,
      observed:observed?{at:observed.at,messages:observed.messages,groups:observed.groups,omittedGroups:observed.omittedGroups,reason:observed.reason,optional:observed.optional}:null}
  }
  preview({persona,patch={},scope='owner-private'}) {
    const row=this.store.get(persona,this.owner())||{persona,owner:this.owner(),config:this.store.defaults(),configRevision:0,state:{epoch:1,score:0,stage:1,status:'未定义',revision:1,arousal:{value:30,at:this.now()}}}
    const config=validate(patch,row.config)
    if(this.store.meta('reset-pending:'+row.key)||this.store.meta('setup-required:'+row.key))return {text:'',blocked:true,reason:'请先完成关系重新设置'}
    if(!row.configRevision)row.state=initialState(config,this.now())
    const active=this.enabled()&&this.compatibility().supported&&persona===this.persona()&&!!row.configRevision
    const captured=active&&scope==='owner-private'?this.memory()?.capture?.('private:'+row.owner):null
    const storyStatus=captured?this.facts.storyStatus(row,captured):null
    const projection=renderContext({...row,config},{scope,globalOptional:true,now:this.now(),storyStatus})
    return active?{...projection,active}:{...projection,active,reason:['当前仅预览草稿，未进入实际聊天请求',projection.reason].filter(Boolean).join('；')}
  }
  cancel(key){this.collector?.clear(key);for(const [id,j] of this.semanticReview?.jobs||[])if(!key||j.key===key)this.semanticReview.jobs.delete(id);for(const task of this.pending.values())if(!key||task.key===key)task.controller.abort(Error('关系配置、范围或运行状态已变化'))}
  automaticReady(row){return !this.store.meta('reset-pending:'+row.key)&&!this.store.meta('setup-required:'+row.key)&&this.compatibility().supported&&this.dependencies().liveReady===true&&calibrated(row.config.judge)}
  automaticActive(row,ready){return this.enabled()&&!this.config().dryRun&&row?.config.mode==='auto'&&this.settings().captureEnabled===true&&(ready??this.automaticReady(row))}
  ownsMood(activity){return this.collector.ownsMood(activity)}
  idleMultiplier(lastOwnerAt=0){const row=this.owner()?this.store.get(this.persona(),this.owner()):null;if(!this.automaticActive(row))return 1;return idleFactor({...row.state,lastOwnerInteractionAt:Math.max(lastOwnerAt,row.state.lastOwnerInteractionAt,this.store.meta('seen:'+row.key+':'+row.state.epoch,0))},row.config,this.now())}
  setOptional({persona,kind,sourceId,quote,expectedRevision,confirmed}){const row=this.store.get(persona,this.owner());if(!row||!confirmed||row.state.revision!==expectedRevision||!['reset','drop'].includes(kind))throw Error('短时状态确认已变化');if(kind==='drop'){const captured=this.memory().capture('private:'+row.owner);if(persona!==this.persona()||!row.config.optionalEnabled||!row.config.arousal.enabled||row.state.stage<row.config.stageGate)throw Error('当前可选模式未激活');if(!this.archive.check(captured,[{sourceId,actor:row.owner,quote}])||typeof quote!=='string'||!quote.trim()||quote.length>300)throw Error('缺少可核对的主人原话')}
    this.cancel(row.key);return this.store.transaction(()=>{const arousal={value:kind==='reset'?row.config.arousal.base:clamp(arousalValue(row.state,row.config,this.now())-row.config.arousal.drop,0,100),at:this.now()},state={...row.state,arousal,revision:row.state.revision+1};this.store.saveState(row,state);for(const l of [this.store.ledger,this.store.committed])if(l.get(row))l.append(row,{at:this.now(),arousal},{manual:true});this.store.event(row,'optional:'+randomUUID(),'management',{action:'optional-'+kind,sourceId:sourceId||'',quote:kind==='drop'?quote:'',value:arousal.value});return {value:arousal.value}})
  }
  leaseModel(id,limit,signal){const lease={limit,signal,attempts:0};this.modelLeases.set(id,lease);return ()=>this.modelLeases.delete(id)}
  claimModel(options){const id=options.messages?.find(m=>m.source?.plugin==='character-relation')?.id,lease=this.modelLeases.get(id);if(!lease||lease.signal.aborted||++lease.attempts>1||options.maxTokens>lease.limit||options.messages.some(m=>m.content.some(c=>c.type!=='text')))throw Error('关系判定请求已过期、重试或超预算');return true}
  queueInteraction(turn){
    const ownerPrivate=turn.scope!=='public'&&turn.scope!=='other-private'
    const noteSkip=code=>{if(ownerPrivate)this.collector.noteOwner(turn.row,'skip',code)}
    if(this.pending.size>=20){turn.mood?.resolve(false);noteSkip('judge-queue');return}
    const token=randomUUID(),controller=new AbortController()
    const captured={key:turn.row.key,persona:turn.row.persona,owner:turn.row.owner,epoch:turn.epoch,config:turn.config,at:turn.at},sources=turn.sources
    const receipts=[...visualContext(sources),...(turn.activities||[]),...(turn.priorReplies||[]),...turn.receipts.map(r=>({sourceId:r.sourceId,kind:'assistant',actor:'role:'+captured.persona,persona:captured.persona,chatId:turn.context.chatId,delivery:'sent',replyTo:r.coveredIds[0],replyToSources:r.coveredIds,text:r.text}))]
    this.pending.set(token,{key:captured.key,controller})
    const work=async()=>{let invoked=false;try{
      controller.signal.throwIfAborted();let row=this.store.get(captured.persona,captured.owner)
      if(!this.automaticActive(row)||this.now()>(turn.expires||captured.at+600000)||row.state.epoch!==captured.epoch||row.configRevision!==captured.config||row.persona!==this.persona()||row.owner!==this.owner())throw Error('排队互动已过期或自动模式不可用')
      this.memory().assert(turn.context.captured)
      if(!this.collector.sourceCheck(turn.context.captured,sources))throw Error('互动原文已不可用')
      if(this.store.committed.hasSources(row,sources)){turn.mood?.resolve(true);return}
      if(this.physicalPending)throw Error('上次底层判定尚未结束')
      this.archive.flushPrivacy?.()
      const context=[...photoReplyContext(turn,row,this.photoFollowup),...receipts]
      const facts=ownerPrivate?this.facts.relevant(row,turn.context.captured,sources.map(s=>s.text).join('\n')):[]
      const recent=this.archive.recent(turn.context.captured,6).filter(r=>r.text.length<=1000&&!sources.some(s=>s.sourceId===r.sourceId)&&!context.some(s=>s.sourceId===r.sourceId)).map(r=>({...r,kind:'history'}))
      const judgeRow=ownerPrivate?row:{...row,owner:turn.actor,state:{...row.state,stage:1}}
      const result=await requestJudgement({row:judgeRow,chatId:turn.context.chatId,sources,context:[...recent,...context],facts,...(ownerPrivate?{prepareFacts:raw=>this.facts.prepare(row,turn.context.captured,raw,{sources:sources.filter(s=>!s.mediaOnly),context,at:this.now()})}:{}),store:this.store,signal:controller.signal,now:this.now,model:async input=>{
        input.signal.throwIfAborted()
        invoked=true;this.autoJudgeInvocations++
        // A started request can have unknown cost or outcome. Do not dispatch a second judge.
        turn.mood?.resolve(true)
        this.physicalPending=true;try{return await this.model(input)}finally{this.physicalPending=false}
      }})
      controller.signal.throwIfAborted();this.memory().assert(turn.context.captured)
      if(!this.enabled()||row.persona!==this.persona()||!this.collector.sourceCheck(turn.context.captured,sources))throw Error('判定返回时身份或来源已变化')
      if(result.facts.some(f=>!this.archive.check(turn.context.captured,[{sourceId:f.sourceId,actor:f.subject,quote:f.quote},...(f.agreement?[{sourceId:f.agreement[0],actor:'role:'+row.persona,quote:f.agreement[1]}]:[])])))throw Error('新提取事实的原文已变化')
      const available=new Set([...this.facts.available(row,turn.context.captured),...result.facts].map(f=>f.id))
      if(result.events.some(e=>e.proofIds?.some(id=>!available.has(id)))||(turn.priorReplies||[]).some(p=>!this.archive.check(turn.context.captured,[{sourceId:p.sourceId,actor:p.actor,quote:p.text}])))throw Error('判定引用的历史证明已变化')
      const command={events:ownerPrivate?result.events:result.events.map(e=>({...e,label:'其他交流的心情变化',evidence:[],proofIds:[]})),sources,scope:turn.scope||'owner-private',at:Math.max(captured.at,row.state.lastEventAt||0),optionalActive:true,facts:result.facts}
      if(sources.some(source=>turn.nativeMoodSources?.has(source.sourceId)))command.nativeMoodObserved=true
      if(ownerPrivate)command.review=[...new Set(result.eligibility.links.map(l=>l.replySourceId))].map(sourceId=>({sourceId,coveredIds:result.eligibility.links.filter(l=>l.replySourceId===sourceId).map(l=>l.playerSourceId)}))
      this.live.commit(row,command,{requestId:result.id});await this.live.drain(row,turn.context.captured);this.live.prune(this.store.get(row.persona,row.owner))
    }catch(error){
      const code=invoked?'judge-unapplied':['证据超过判定预算；没有截断后强行判分','关系判定当日预算不足'].includes(error.message)?'judge-budget':'judge-unavailable'
      noteSkip(code)
      const row=this.store.get(captured.persona,captured.owner)
      if(row?.state.epoch===captured.epoch)this.store.event(row,'skip:'+token,'skipped',{reason:code,sourceIds:sources.map(s=>s.sourceId)})
    }finally{turn.mood?.resolve(false);this.pending.delete(token)}}
    this.queue=this.queue.then(work,work);return this.queue
  }
  async shadow({persona,sources,context=[]}) {
    if(!this.enabled())throw Error('模块未启用')
    const row=this.create(persona)
    if(row.config.mode!=='shadow')throw Error('请先选择影子模式；此操作会调用当前配置的模型')
    if(persona!==this.persona())throw Error('影子判定只接受当前运行人格')
    if(!Array.isArray(sources)||!sources.length||sources.length>20||sources.some(s=>typeof s.sourceId!=='string'||!s.sourceId||s.sourceId.length>200||typeof s.text!=='string'||s.kind!=='user'||s.actor!==row.owner||s.text.length>16000)||new Set(sources.map(s=>s.sourceId)).size!==sources.length)throw Error('来源格式、范围或去重身份无效')
    if(!Array.isArray(context)||context.length>20||context.some(s=>!['assistant','tool','history'].includes(s.kind)||typeof s.text!=='string'||s.text.length>16000||(s.kind==='assistant'&&s.delivery!=='sent')))throw Error('前后文格式无效；未确认发送的回复不能冒充已发生互动')
    if(this.pending.size>=20)throw Error('判定队列已满')
    const token=randomUUID(),controller=new AbortController(),captured={epoch:row.state.epoch,config:row.configRevision,state:row.state.revision,at:this.now()}
    const task={key:row.key,controller};this.pending.set(token,task)
    const work=async()=>{
      try {
        controller.signal.throwIfAborted()
        if(this.store.ledger.hasSources(row,sources))return {duplicate:true,stateChanged:false,modelCalls:0}
        if(this.now()-captured.at>600000)throw Error('队列已过期')
        if(this.physicalPending)throw Error('上次判定的底层请求尚未结束，请先核对未知结果')
        const trackedModel=async input=>{this.physicalPending=true;try{return await this.model(input)}finally{this.physicalPending=false}}
        const result=await requestJudgement({row,sources,context,model:trackedModel,store:this.store,signal:controller.signal,now:this.now})
        if(this.closed)throw Error('模块已停用')
        const current=this.store.get(persona,row.owner)
        if(persona!==this.persona()||row.owner!==this.owner()||!this.enabled()||current.state.epoch!==captured.epoch||current.configRevision!==captured.config||current.state.revision!==captured.state)throw Error('判定已过期，未修改状态')
        const simulation=this.store.transaction(()=>{const saved=this.store.ledger.append(current,{events:result.events,sources,at:captured.at},{requestId:result.id});this.store.event(current,'shadow:'+result.id,'shadow',{events:result.events,eligibility:result.eligibility,requestId:result.id,simulationId:saved.id,synthetic:true});return saved})
        return {events:result.events,eligibility:result.eligibility,requestId:result.id,simulation,stateChanged:false}
      } finally {this.pending.delete(token)}
    }
    const next=this.queue.then(work,work);this.queue=next.catch(e=>{this.lastIssue=e.message});return next
  }
  async dispose(){this.closed=true;this.cancel();await this.queue;await Promise.allSettled([...this.live.draining.values()]);this.store.close()}
}
