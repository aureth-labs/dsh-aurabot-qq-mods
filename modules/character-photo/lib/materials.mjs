import { photoImageProvider } from './compatibility.mjs'
import {text, uid} from './store.mjs'
import {quietAsk, parseModelObject} from './model.mjs'
import {localDay} from './director.mjs'
import {createHash} from 'node:crypto'
import {studioPromptPlan} from './studio-prompts.mjs'

const templates = {
  identity: ['外貌、媒介、可见比例、角度、可变配饰及可见神态（只记观察，不推断性格）', '同一人物的补充角度与局部，保留原身份和媒介'],
  outfit: ['衣物款式、配色、材质、结构、鞋袜和指定配饰；排除模特和背景', '无五官浅灰人台正面、侧面和背面服装展示，剥离原模特、头发和背景'],
  scene: ['空间布局、家具、稳定材质及色彩；当时光线单列', '同一空间主视角、反向视角与俯视布局，保持结构'],
  object: ['指定物件的轮廓、结构、材质、纹理和辨识细节；排除持有者', '同一独立物件的多角度展示，排除手、人物与原背景'],
}
const templateVersion = '2026-11-25'
export const materialKinds = Object.keys(templates)
export function materialRef(item) {
  return item?.useBoard && item.boardId ? item.boardId : item?.referenceId || ''
}

export function createMaterials(api, db, {owner, profile, authorize, settings, now, mayGenerate, active, life, saveProfile}) {
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
  function inputImages(kind, images) {
    if(!materialKinds.includes(kind) || !Array.isArray(images) || images.length<1 || images.length>(kind==='identity'?1:4))throw Error('人设图请选择一张，服饰、场景和道具可选择一至四张原图')
    return images.map(image=>{
      if(typeof image?.base64!=='string'||image.base64.length>11184812)throw Error('每张原图最多 8 MB')
      const bytes=Buffer.from(image.base64,'base64')
      const {mime}=db.inspectImage(bytes)
      return {bytes,mime,name:text(image.name,100),hash:digest(bytes)}
    })
  }
  function metadata(fields,kind) {
    const tags=value=>text(Array.isArray(value)?value.map(v=>text(v,80)).join('、'):value,300)
    return {name:text(fields?.name,80),aliases:tags(fields?.aliases),tags:tags(fields?.tags),description:text(fields?.description),expression:kind==='identity'?text(fields?.expression,300):''}
  }
  function panelCard(input,ctx) {
    active();authorize(ctx,true)
    const card=life.card(input.personaId)
    if(ctx.origin!=='panel'||!card||card.id!==input.personaId)throw Error('请选择有效的人格卡')
    return card
  }
  async function studioDraft(input,ctx,check,background=false) {
    const {kind}=input,card=panelCard(input,ctx),ownerId=owner(),images=inputImages(kind,input.images)
    const hashes=images.map(i=>i.hash),hint=text(input.instructions,600)
    const plan=studioPromptPlan(kind,'',hint,images.length)
    const key=digest(JSON.stringify([plan.source,ownerId,card.id,card.revision,kind,hashes,hint]))
    const previous=db.state.jobs.findLast(j=>j.key===key)
    if(previous?.status==='generated'&&!db.asset(previous.boardId).archived)return previous
    if(background && ['planning','generating'].includes(previous?.status))return previous
    if(previous && previous.status!=='failed')throw Error('转换已受理或结果待核对，请查看记录')
    check()
    const gen=photoImageProvider(api)
    if(!gen?.enabled?.()||(gen.referenceCapacity?.()??4)<images.length)throw Error('生图服务当前可用的参考图数量不足')
    mayGenerate(ctx,{})
    const job={id:uid(),key,origin:'material',stage:'studio-draft',requestId:text(ctx.jobId,160),source:plan.source,kind,ownerId,personaId:card.id,cardRevision:card.revision,sourceHashes:hashes,instructions:hint,request:images[0].name||'素材转换',status:'planning',at:now(),day:localDay(now(),settings().timezone)}
    db.state.jobs.push(job);db.save()
    async function render(){
      const validate=()=>{if(owner()!==ownerId||panelCard(input,ctx).revision!==card.revision)throw Error('人格已变化，请重新打开设定')}
      try{
        gen.checkStyle?.()
        if(gen.referenceLimit && images.length>await gen.referenceLimit())throw Error('当前生图服务支持的参考图数量不足')
        if(await Promise.resolve().then(()=>api.lib('core/llm.js').canSeeImages(api.dsh,api.config())).catch(()=>undefined)===false)throw Error('当前聊天模型无法识别图片')
        validate();check()
        const prompt=plan.analysis+(kind==='identity'?'\n在同一 JSON 里增加 expression，记录图片中可见的神态特点，看不清可留空。':'')
        const raw=await quietAsk(api,'material-analysis',prompt,images.map(i=>({data:i.bytes.toString('base64'),mediaType:i.mime})))
        job.metadata=metadata(parseModelObject(raw,'素材识别'),kind)
        if(!job.metadata.name||!job.metadata.description)throw Error('识别结果缺少名称或视觉描述')
        validate();check();mayGenerate(ctx,{})
        job.status='generating';job.attempted=true;db.save()
        const sheet=studioPromptPlan(kind,job.metadata.description,hint,images.length)
        const rendered=await gen.generate(sheet.sheet,{shape:sheet.aspect==='16:9'?'wide':'4:3',images:images.map(i=>i.bytes),styleMode:'reference'})
        validate()
        let concurrentChange
        try{check()}catch(error){concurrentChange=error}
        db.transaction(()=>{
          const board=db.add(rendered,{ownerId,purpose:kind,name:job.metadata.name+' · 设定图'})
          board.personaId=card.id
          Object.assign(job,{boardId:board.id,status:'generated',aspect:sheet.aspect})
          if(concurrentChange)job.reviewNotice='转换稿已留存，资料在生成期间发生变化。刷新后用相同原图和要求取回，无需重新生成'
        })
        if(concurrentChange)throw Error(job.reviewNotice)
        return job
      }catch(error){if(job.status!=='generated'){job.status=job.attempted&&!error.definiteFailure?'unknown':'failed';job.error=text(error.message);db.save()}throw error}
    }
    const result=render()
    if(!background)return result
    // render persists failures for panels that reconnect after the request returns.
    result.catch(()=>{})
    return job
  }
  function adoptStudio(input,ctx,check) {
    const {kind}=input,card=panelCard(input,ctx),ownerId=owner()
    const job=db.state.jobs.find(j=>j.id===input.draftId&&j.stage==='studio-draft'&&j.status==='generated'&&j.ownerId===ownerId&&j.personaId===card.id&&j.cardRevision===card.revision&&j.kind===kind)
    if(!job)throw Error('转换稿与当前人格或分类不一致')
    const fields=metadata({...job.metadata,...input.metadata},kind)
    if(!fields.name||!fields.description)throw Error('请保留素材名称和视觉描述')
    const useBoard=input.useBoard!==false,sourceCover=input.coverChoice==='source',asMain=kind==='identity'&&input.asMain===true
    const keepSource=input.keepOriginal===true||!useBoard||sourceCover
    const intent=digest(JSON.stringify([fields,useBoard,sourceCover,asMain,keepSource,input.targetId||'']))
    if(job.materialId){if(intent===job.adoptIntent)return job.materialId;throw Error('转换稿已经入库，请编辑现有素材')}
    check()
    const images=keepSource?inputImages(kind,input.images):[]
    if(keepSource&&JSON.stringify(images.map(i=>i.hash))!==JSON.stringify(job.sourceHashes))throw Error('所选原图和转换稿不匹配')
    const board=db.asset(job.boardId)
    if(board.archived||board.personaId!==card.id||board.ownerId!==ownerId)throw Error('转换稿不可用')
    return db.transaction(()=>{
      const bindings=db.state.personaBindings||={},bound=bindings[card.id]
      if(bound)scope(bound)
      if(bound&&Object.entries(bindings).some(([other,id])=>other!==card.id&&id===bound))throw Error('当前档案与其他人格重复绑定')
      let p=db.state.profiles.find(x=>x.id===bound)
      if(!p){p={id:uid(),name:card.name,ownerId,versionId:''};db.state.profiles.push(p);bindings[card.id]=p.id}
      const old=input.targetId?item(p.id,kind,input.targetId):null
      const originals=images.map(i=>{const a=db.add(i.bytes,{ownerId,profileId:p.id,purpose:kind,name:i.name});a.personaId=card.id;return a.id})
      const row=draft(p.id,kind,{...fields,referenceId:originals[0]||''},old)
      Object.assign(row,{originalIds:originals,useBoard,boardId:board.id,coverId:sourceCover?originals[0]:board.id,
        boardSource:{jobId:job.id,sourceHash:job.sourceHashes[0],sourceId:originals[0]||'',templateVersion:job.source},analysis:{...job.metadata,sourceId:originals[0]||'',templateVersion:job.source,at:job.at}})
      board.profileId=p.id
      if(old)Object.assign(old,row);else rows(kind).push(row)
      if(asMain){
        const prev=db.state.versions.find(v=>v.id===p.versionId),activeId=db.state.activeProfileId
        saveProfile({...prev,profileId:p.id,personaId:card.id,name:card.name,references:[materialRef(row)]})
        if(life.current()!==card.id)db.state.activeProfileId=activeId
      }
      Object.assign(job,{profileId:p.id,materialId:row.id,adoptIntent:intent})
      return row.id
    })
  }
  async function convertIdentity(input,ctx,beforeStore=()=>{}) {
    authorize(ctx,true)
    const card=life.card(input.personaId), ownerId=owner()
    if(ctx.origin!=='panel'||!card||card.id!==input.personaId)throw Error('请选择有效的人格卡')
    const bytes=Buffer.from(String(input.base64||''),'base64')
    db.inspectImage(bytes)
    const sourceHash=digest(bytes), instructions=text(input.instructions,600)
    const key=digest(JSON.stringify(['identity-board-v1',ownerId,card.id,card.revision,sourceHash,instructions]))
    const prior=db.state.jobs.findLast(j=>j.key===key)
    if(prior?.status==='generated' && db.state.assets.some(a=>a.id===prior.boardId&&!a.archived))return prior
    if(prior && !['generated','failed'].includes(prior.status))throw Error('转换已受理或服务结果待核对，请检查记录')
    const gen=photoImageProvider(api)
    if(!gen?.enabled?.()||(gen.referenceCapacity?.()??4)<1)throw Error('当前生图服务无法使用原图转换')
    mayGenerate(ctx,{})
    const job={id:uid(),key,origin:'material',stage:'identity-convert',ownerId,personaId:card.id,cardRevision:card.revision,sourceHash,instructions,request:text(input.name,100)||'人设图转换',status:'generating',attempted:true,at:now(),day:localDay(now(),settings().timezone)}
    db.state.jobs.push(job);db.save()
    try {
      const plan=studioPromptPlan('identity','',instructions,1)
      const result=await gen.generate(plan.sheet,{shape:'wide',images:[bytes],styleMode:'reference'})
      if(owner()!==ownerId || life.card(card.id)?.revision!==card.revision)throw Error('人格已变化，转换结果未采用')
      beforeStore()
      db.transaction(()=>{
        const board=db.add(result,{ownerId,purpose:'identity',name:job.request+' · 三视图'})
        board.personaId=card.id
        Object.assign(job,{status:'generated',boardId:board.id})
      })
      return job
    }catch(error){job.status=error.definiteFailure?'failed':'unknown';job.error=text(error.message);db.save();throw error}
  }
  function adoptedIdentity(profileId,input,erase) {
    const job=db.state.jobs.find(j=>j.id===input.conversionId&&j.stage==='identity-convert'&&j.status==='generated')
    if(!job||job.ownerId!==owner()||db.state.personaBindings?.[job.personaId]!==profileId || life.card(job.personaId)?.revision!==job.cardRevision || erase.has(job.boardId))throw Error('转换稿与当前人格或版本不一致')
    const board=db.asset(job.boardId)
    if(board.archived||board.personaId!==job.personaId)throw Error('转换稿不可用')
    const data={...input,referenceId:'',id:undefined}
    if(input.originalBase64){
      const bytes=Buffer.from(input.originalBase64,'base64')
      if(digest(bytes)!==job.sourceHash)throw Error('原图与转换稿不匹配')
      data.referenceId=db.add(bytes,{ownerId:owner(),profileId,purpose:'identity',name:job.request}).id
    }
    const row=draft(profileId,'identity',{...data,description:text(data.description)||'人物三视设定图'})
    return {...row,boardId:board.id,useBoard:true,boardSource:{jobId:job.id,sourceHash:job.sourceHash,sourceId:data.referenceId}}
  }
  function scope(id) {
    if (!db.state.profiles.some(x => x.id === id && x.ownerId === owner())) throw Error('素材不属于此人格')
    return id
  }
  function rows(kind) {
    if (!Object.hasOwn(templates, kind)) throw Error('请选择人设、衣柜、场景或道具')
    return kind === 'outfit' ? db.state.outfits : (db.state.materials ||= [])
  }
  function list(profileId) {
    scope(profileId)
    return [...db.state.outfits.map(x=>({...x,kind:'outfit'})),...(db.state.materials||[])].filter(x=>x.profileId===profileId)
  }
  function item(profileId,kind,id) {
    scope(profileId)
    const row=rows(kind).find(x=>x.id===id&&x.profileId===profileId&&(!x.kind||x.kind===kind))
    if(!row)throw Error('当前人格没有这项素材')
    return row
  }
  function catalog(profileId) {
    return list(profileId).filter(x=>x.kind!=='outfit').map(({id,kind,name,description,aliases,tags,expression})=>({id,kind,name,description,aliases,tags,expression}))
  }
  function draft(profileId,kind,input,old,erase=new Set()) {
    const ref=input.referenceId || ''
    if(ref) {
      const a=db.asset(ref)
      if(a.ownerId!==owner() || a.profileId && a.profileId!==profileId || a.purpose!==kind || erase.has(ref) || a.archived) throw Error('素材原图不可用或归属不同')
    }
    if(!text(input.name,80) || !(text(input.description)||ref)) throw Error('素材需要名称以及描述或原图')
    const sameOriginal=old && (old.referenceId||'')===ref && (ref || old.description===text(input.description))
    const sameBoard=old?.boardSource?.sourceHash && (old.referenceId||'')===ref || sameOriginal && old.description===text(input.description)
    return {...(old||{}),id:old?.id||uid(),profileId,kind,name:text(input.name,80),description:text(input.description),aliases:text(input.aliases,300),tags:text(input.tags,300),...(kind==='identity'?{expression:text(input.expression,300)}:{}),referenceId:ref,
      analysis:sameOriginal?old.analysis:null,boardSource:sameBoard?old.boardSource:undefined,boardId:sameBoard?old.boardId||'':'',useBoard:!!(sameBoard&&old.boardId&&input.useBoard),at:now()}
  }
  function resolveInputs(profileId,ids) {
    if(!Array.isArray(ids) || ids.length>4 || new Set(ids).size!==ids.length) throw Error('请选择不重复的视觉素材（最多四项）')
    const all=list(profileId)
    return ids.map(id=>{
      const row=all.find(x=>x.id===id&&x.kind!=='outfit')
      if(!row)throw Error('选用的拍摄素材不属于此人格')
      return {id:row.id,kind:row.kind,name:row.name,description:[row.description||row.analysis?.description,row.expression].filter(Boolean).join('；'),referenceId:materialRef(row)}
    })
  }
  function guard(ctx,profileId) {
    authorize(ctx,true); scope(profileId)
    if(ctx.origin==='chat' && (ctx.chatId!=='private:'+owner() || profile().profileId!==profileId || 'chat:'+api.core.hub.characterPhotoTurn?.(ctx.sessionId)?.jobId!==ctx.jobId)) throw Error('只能在当前主人的真实私聊保存此人格素材')
  }
  async function process(input,ctx) {
    const {profileId,kind,id,op}=input
    guard(ctx,profileId)
    if(!['analyze','board'].includes(op)||!api.config().enabled||api.config().dryRun)throw Error('请先开启机器人并选择识别或制版')
    const row=item(profileId,kind,id)
    const sourceId=(op==='analyze' && (input.analyzeBoard===true || !row.referenceId)?row.boardId:row.referenceId)||'',description=row.description,name=row.name
    if(op==='analyze' && row.analysis?.sourceId===sourceId)return row
    if(op==='board' && row.boardId)return row
    if(op==='board' && kind==='identity'&&!sourceId)throw Error('人物补图需要原始设定图')
    const key=JSON.stringify(['material',profileId,id,op,sourceId,description])
    const prior=db.state.jobs.find(j=>j.key===key)
    if(prior && ['unknown','generating','planning','queued'].includes(prior.status))throw Error('同一素材任务进行中或结果待核对，未重复请求')
    if(!sourceId && !description)throw Error('请先保存原图或文字描述')
    const a=sourceId && db.asset(sourceId)
    const bytes=a?db.read(a.id):null
    const gen=photoImageProvider(api)
    if(op==='board'){
      mayGenerate({origin:'panel',jobId:key},{})
      if(!gen?.enabled?.()||bytes && (gen.referenceCapacity?.()??4)<1)throw Error('当前生图服务无法生成此展示图')
    }else if(bytes && await Promise.resolve().then(()=>api.lib('core/llm.js').canSeeImages(api.dsh,api.config())).catch(()=>undefined)===false)throw Error('当前聊天模型无法识别图片')
    // Recheck after asynchronous capability discovery before claiming the request.
    if(db.state.jobs.some(j=>j.key===key&&['planning','generating','unknown'].includes(j.status)))throw Error('该素材请求已在处理或结果待核对')
    const job={id:uid(),key,ownerId:owner(),profileId,materialId:id,origin:'material',stage:op,status:op==='board'?'generating':'planning',attempted:op==='board',request:name,at:now(),day:localDay(now(),settings().timezone),refs:sourceId?[{id:sourceId}]:[],sourceRequest:row.source?.request||ctx.jobId}
    db.state.jobs.push(job);db.save()
    try{
      const evidence={version:templateVersion,sourceId,description,name}
      let result
      if(op==='analyze'){
        const prompt=studioPromptPlan(kind,description,'',bytes?1:0).analysis+'\n看不清的内容在 uncertainties 中列出，人设图增加可见 expression。已有资料 '+JSON.stringify(evidence)
        result=parseModelObject(await quietAsk(api,'material-analysis',prompt,bytes?[{data:bytes.toString('base64'),mediaType:a.mime}]:[]),'素材识别')
        if(!text(result.description))throw Error('识别结果缺少描述')
      }else{
        const plan=studioPromptPlan(kind,description||row.analysis?.description||name,'',bytes?1:0)
        result=await gen.generate(plan.sheet,{shape:plan.aspect==='16:9'?'wide':'4:3',...(bytes?{images:[bytes],styleMode:'reference'}:{})})
      }
      guard(ctx,profileId)
      const current=item(profileId,kind,id)
      if(((op==='analyze' && (input.analyzeBoard===true || !current.referenceId)?current.boardId:current.referenceId)||'')!==sourceId || current.description!==description || current.name!==name)throw Error('素材在处理期间已变更，结果未应用')
      if(op==='analyze'){
        current.analysis={...Object.fromEntries(['name','description','tags','aliases','expression','uncertainties'].map(k=>[k,text(result[k])])),sourceId,templateVersion,at:now()}
      }else{
        const board=db.add(result,{ownerId:owner(),profileId,purpose:kind,name:name+'展示图'})
        current.boardId=board.id;current.boardSource={sourceId,templateVersion,jobId:job.id}
      }
      job.status='generated';db.save();return current
    }catch(error){job.status=error.definiteFailure?'failed':'unknown';job.error=text(error.message);db.save();throw error}
  }
  async function collect(args,ctx){
    active()
    const profileId=profile().profileId
    guard(ctx,profileId)
    if(!api.config().enabled||api.config().dryRun)throw Error('试运行或机器人关闭，未收藏')
    const turn=api.core.hub.characterPhotoTurn(ctx.sessionId)
    const saved=list(profileId).find(x=>x.source?.request===ctx.jobId)
    if(saved){
      if(saved.source.boardRequired && !saved.boardId)throw Error('素材已经收藏，展示图尚未完成；请核对对应任务')
      return saved
    }
    const selected=args.playerReferenceId && (turn.references||[]).find(r=>r.id===args.playerReferenceId)
    if(args.playerReferenceId&&!selected)throw Error('没有可确认的本会话原图')
    const ref=selected && api.core.hub.characterPhotoReference(ctx.sessionId,turn.jobId,selected.id)
    const key='material-collect:'+ctx.jobId
    if(db.state.jobs.some(j=>j.key===key && j.profileId===profileId))throw Error('该轮素材识别已受理，请查看记录')
    const job={id:uid(),key,ownerId:owner(),profileId,origin:'material',stage:'collect',status:'planning',at:now(),request:'聊天素材识别',sourceRequest:ctx.jobId}
    db.state.jobs.push(job);db.save()
    try {
    const proof=parseModelObject(await quietAsk(api,'material-collect','仅在玩家明确要求长期收藏或指定以后使用时 save=true；autoCollect 开启时也可收纳玩家提供并明确指为角色长期素材的图片。单次试穿、讨论、引用和否定为 false。根据指代判断图片是否正确，不确定则 false。分类 identity/outfit/scene/object。board=true 仅限玩家明确要求另生成整理图。输出 {"save":false,"board":false,"kind":"","name":"","description":"","tags":"","aliases":""}。识别标准 '+JSON.stringify(templates)+'。资料 '+JSON.stringify({autoCollect:settings().autoCollectMaterials,previous:turn.previousQuery,current:turn.query,pending:turn.pendingQuery,requestedReference:selected?.id,available:turn.references?.map(r=>r.id)}),ref?[{data:ref.bytes.toString('base64'),mediaType:ref.mediaType}]:[]),'聊天素材分类')
    guard(ctx,profileId)
    if(proof.save!==true){job.status='skipped';throw Error('本轮未确认收藏，临时试用不会入库')}
    const current=api.core.hub.characterPhotoTurn(ctx.sessionId)
    if(current.query!==turn.query||current.pendingQuery!==turn.pendingQuery)throw Error('玩家需求已改变')
    const existing=list(profileId).find(x=>x.source?.request===ctx.jobId)
    if(existing)return existing
    if(!materialKinds.includes(proof.kind)||!text(proof.name)||!text(proof.description))throw Error('未确认素材分类或描述')
    const savedRow=db.transaction(()=>{
      const referenceId=ref?db.add(ref.bytes,{purpose:proof.kind,ownerId:owner(),profileId,name:proof.name}).id:''
      const row=draft(profileId,proof.kind,{...proof,referenceId})
      row.source={request:ctx.jobId,chatId:ctx.chatId,messageId:ref?.messageId||'',playerReferenceId:selected?.id||'',boardRequired:proof.board===true}
      row.analysis={name:row.name,description:row.description,aliases:row.aliases,tags:row.tags,sourceId:referenceId,templateVersion,at:now()}
      rows(proof.kind).push(row);job.status='generated';job.materialId=row.id;return row
    })
    if(proof.board===true)try{await process({profileId,kind:proof.kind,id:savedRow.id,op:'board'},ctx)}catch(error){throw Error('素材已收藏，展示图未确认完成：'+error.message)}
    return savedRow
    }catch(error){if(job.status==='planning')job.status=error.definiteFailure?'failed':'unknown';job.error=text(error.message);db.save();throw error}
  }
  return {list,item,catalog,draft,process,collect,resolveInputs,convertIdentity,adoptedIdentity,studioDraft,adoptStudio}
}
