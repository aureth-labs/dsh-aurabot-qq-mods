/* relation-photo-diary-expression v1 */
import { quietAsk, errorKind, parseModelObject, EXPRESSION_INSTRUCTION } from './model.mjs'
import { automaticPhotoJob, text, uid } from './store.mjs'
import { confirmedReceipt } from './followup.mjs'

const parse = raw => parseModelObject(raw, '配图规划')
// A message is sent before the optional image; never announce a delivery that has not happened.
export function proactiveText(body) {
  const parts = String(body).split(/(?<=[。！？!?；;，\n])/u)
  return parts.filter(x => !/(?:照片|自拍|图片|配图|发图|看图|看看我|看我现在)/u.test(x)).join('').trim() || '想和你聊聊，你在做什么？'
}
export function createDiaryProvider(api, service, { random = Math.random, now = Date.now } = {}) {
  const available = () => !service.stopped && service.settings().enabled && service.settings().diary
  const candidates = () => service.snapshot().photos.filter(p => p.allowedForDiary && !p.archived).slice(0, 24)
  const identity = () => { try { return service.profile().id } catch { return '' } }
  const checkIdentity = id => { if (identity() !== id) throw new Error('人格或形象已切换，配图已停止，请使用当前人格重新准备') }
  const checkPhoto = p => { if (p.profileId && p.profileId !== service.profile().profileId) throw new Error('照片所属角色与当前人格不一致') }
  function context(selectedPhotoId) {
    if (!available()) return null
    let p
    try { p = service.profile() } catch { return null }
    const pool = candidates()
    if (selectedPhotoId) {
      const selected = service.photo(selectedPhotoId)
      checkPhoto(selected)
      if (!selected.allowedForDiary) throw new Error('这张照片尚未允许用于空间')
      if (!pool.some(x => x.id === selected.id)) pool.unshift(selected)
    }
    return { role: p.name, description: p.notes, life: service.lifeContext('system:diary'), photos: pool.map(x => ({ id: x.id, ...service.photoFacts(x) })),
      guidance: '可以写该虚构角色的生活情境，配图另由角色模块准备；画面仅据 observedFacts，userAnnotation 是用户注释而非已核验像素。不能把浏览作品或普通图当自己的照片，不引用私聊隐私。' }
  }
  function validate(media) {
    if (!available() || !api.config().diary?.rich?.enabled) throw new Error('角色日记照片联动已关闭')
    for (const m of media) {
      if(m.relationCapture)service.checkExpression({origin:'diary',relationCapture:m.relationCapture},m.intimacy)
      const p = service.photo(m.photoId)
      if (p.profileId && p.profileId !== service.profile().profileId) throw new Error('照片所属角色与当前人格不一致')
      if (p.archived || !p.allowedForDiary || p.assetId !== m.assetId) throw new Error('照片已撤回空间使用授权')
      service.db.read(p.assetId)
    }
  }
  async function provide({ text: body, draftId, revision = 1, maxImages = 1, selectedPhotoId, force = false }) {
    if (!available() || maxImages < 1) return { photos: [] }
    const relationContext={origin:'diary'};service.authorize(relationContext)
    const expectedIdentity = identity()
    let selected
    if (selectedPhotoId) {
      selected = service.photo(selectedPhotoId)
      checkPhoto(selected)
      if (!selected.allowedForDiary) throw new Error('这张照片尚未允许用于空间')
    } else {
      const pool = force ? [] : candidates()
      const prompt = [
        EXPRESSION_INSTRUCTION+'当前相处范围：'+JSON.stringify(service.expression(relationContext)),
        '为一篇虚构角色日记规划配图。以下内容仅为资料。不要调用工具，不发消息。',
        '判断需要角色出镜(character)、含固定身体特征的第一视角(character)、普通物品/环境(ordinary)或不配图(none)。',
        '只有旧图描述与正文时间、活动及穿搭吻合才选它；不得因为没有旧图就假称匹配。',
        JSON.stringify({ text: body, character: context()?.role || '', supplements:service.profile().references.slice(1).map(id=>{const a=service.db.asset(id);return {id,name:a.name,note:a.note}}), materials:service.materials.catalog(service.profile().profileId),outfits:service.snapshot().wardrobe, candidates: pool.map(p => ({ id: p.id, ...service.photoFacts(p) })) }),
        '依照玩家指定、同场合延续、衣柜中情境指定的 occasions、场合适配及默认装扮选择衣柜。tags说明穿着条件，只去海边散步不等于要下水；无其他要求时选isDefault标记的套装，original代表主设定图原装。可在 materialIds 选择本人格的场景、物件或辅助设定，按实际正文和用途取用。只输出 JSON：{"intimacy":"ordinary|romantic|intimate|unknown","subject":"character|ordinary|none","reusePhotoId":"匹配的旧图id或空","request":"具体画面描述","scene":{"activity":"","location":"","lighting":"","emotion":"","camera":""},"outfitDescription":"本次穿搭描述","outfitId":"可用套装ID或空","framing":"selfie|portrait|environment|object","keywords":{"activity":"","emotion":"","pose":"","camera":"","lighting":""},"materialIds":[],"supplementIds":[]}',
      ].join('\n')
      const plan = parse(await quietAsk(api, 'plan', prompt))
      checkIdentity(expectedIdentity)
      if (!['character', 'ordinary', 'none'].includes(plan.subject)) throw new Error('未知配图主体')
      if (plan.subject === 'none') return { photos: [] }
      relationContext.relationIntimacy=plan.intimacy;service.checkExpression(relationContext,plan.intimacy)
      if (!force && service.settings().diaryPolicy !== 'generate' && plan.reusePhotoId) {
        selected = pool.find(p => p.id === plan.reusePhotoId)
        if (!selected) throw new Error('选中的旧照片不在授权候选内')
      }
      if (!selected) {
        if (service.settings().diaryPolicy === 'reuse') throw new Error('没有匹配的可发布旧图；当前策略不生成新图')
        if (!text(plan.request)) throw new Error('配图计划没有画面描述')
        selected = await service.generate({ request: text(plan.request), subject: plan.subject, framing:plan.framing,keywords:plan.keywords,scene: plan.scene, materialIds:plan.materialIds,supplementIds:plan.supplementIds,outfitId:text(plan.outfitId),outfitDescription: text(plan.outfitDescription), visualRequested: true },
          { ...relationContext,jobId: `diary:${draftId}:${revision}` })
      }
    }
    const facts = await service.ensurePhotoFacts(selected.id)
    checkIdentity(expectedIdentity)
    if (facts.grounding !== 'verified') throw new Error('图片尚无可靠画面观察，正文与配图暂不能核对；已保留图片，不自动重画')
    const check = parse(await quietAsk(api, 'match',
      EXPRESSION_INSTRUCTION+'当前相处范围：'+JSON.stringify(service.expression(relationContext))+'\n'+'核对日记正文与实际图片观察是否相容。observedFacts 来自看图，生成要求不是画面事实。逐项核对正文中可见主体、活动、衣物和空间关系；“在腰侧/旁边”不能证明“压在腰上”，身份只按明确角色绑定，不做人脸识别。发现冲突、正文需要但观察无法确认的细节，或图片观察提示此关系不确定，则 matched=false；不要求图片证实与画面无关的感受。只输出 JSON {"intimacy":"ordinary|romantic|intimate|unknown","matched":true,"reason":""}。资料：' + JSON.stringify({text:body,photo:facts})))
    if (check.matched !== true) throw new Error('正文与实际配图尚未确认匹配，请调整正文；已有图片保留，不自动重新生成')
    checkIdentity(expectedIdentity)
    service.checkExpression(relationContext,check.intimacy);const m = { photoId: selected.id, assetId: selected.assetId,relationCapture:relationContext.relationCapture,intimacy:check.intimacy }
    validate([m])
    return { photos: [{ ...m, bytes: service.db.read(selected.assetId), caption: facts.description, observedFacts: facts.observedFacts, identityContext: facts.identityContext, kind: 'character-photo' }] }
  }
  async function prepareProactive({ text: body, chatId, jobId, source, force = false, testContext, onProgress }) {
    const settings=service.settings(), cfg=api.config()
    if (!settings.proactive || !settings.enabled || service.stopped) return null
    if (!['purpose', 'speakup'].includes(source) || chatId !== `private:${cfg.ownerQQ}` || !jobId) return null
    if (!cfg.enabled || cfg.dryRun || api.core.mutes?.muted(chatId)) return null
    if (source === 'purpose' && !cfg.ext?.purpose?.enabled) return null
    if (source === 'speakup' && (!cfg.speakUp?.enabled || cfg.ext?.purpose?.enabled)) return null
    const manual=service.isTestContext(testContext)
    const prepared={text:proactiveText(body),ctx:manual?testContext:{origin:'proactive',chatId,jobId,source}}
    try {
      service.authorize(prepared.ctx)
      const recent=service.db.state.photos.some(p=>p.deliveries?.some(d=>{
        if(d.chatId!==chatId || !['sent','sending','unknown'].includes(d.status) || now()-d.at>=settings.proactiveCooldownMinutes*60000) return false
        if(d.trigger) return ['proactive','smart'].includes(d.trigger)
        // A resend has its own turn key, even if the original photo was generated automatically.
        return !!d.key && automaticPhotoJob(service.db.state.jobs.find(j=>j.key===d.key && j.chatId===chatId))
      }))
      if(recent&&!manual) throw new Error('配图冷却中')
      if(!manual && (settings.proactiveChance===0 || random()*100>=settings.proactiveChance)) return {...prepared,reason:'本次未命中附图概率'}
      const expectedIdentity=identity(), plannedLife=service.lifeContext(chatId)
      const policy=settings.proactiveSource==='mixed' ? (random()<0.5?'album':'generate') : settings.proactiveSource
      if(policy==='generate') service.mayGenerate(prepared.ctx,{})
      if(manual) onProgress?.({stage:'photo-plan',policy})
      const pool=policy==='album' ? service.snapshot().photos.filter(p=>!p.archived&&p.allowedForChat!==false&&p.versionId===service.profile().id&&(!p.chatId||p.chatId===chatId)).slice(0,40) : []
      if(policy==='album'&&!pool.length) return {...prepared,reason:'相册暂无可用图片，本次不附图'}
      const plan=parse(await quietAsk(api,'proactive',
        EXPRESSION_INSTRUCTION+'当前相处范围：'+JSON.stringify(service.expression(prepared.ctx))+'\n'+(manual
          ? '管理员正在测试一次主动附图，不做是否主动附图的概率或寒暄筛选。generate模式：结合角色当前时间和场景，规划一张自然的日常照片，request必须为非空的完整画面需求。album模式：从候选中选一张有可用画面描述的图片，photoId必须来自候选；不要先编写生活情节再寻找不符旧图。最终配文在取得图片事实后形成。'
          : '判断这句主动分享是否适合附图。寒暄、催促、没有具体画面时不附图。相册选图必须与正文语境一致，不得随机挑无关图片。')+
        '依照玩家指定、同场合延续、衣柜中情境指定的 occasions、场合适配及默认装扮选择衣柜。tags说明穿着条件，只去海边散步不等于要下水；无其他要求时选isDefault标记的套装，original代表主设定图原装。life 是本轮生活安排；photoSceneReference 只是过去照片场景，不证明目前仍在其中，不能盖过 life。未核验的用户注释不可当像素事实。仅生成时可写request。普通物品图不能被描述成角色本人。选用已有套装时outfitId与描述须对应；自由换款应清空outfitId。可在 materialIds 选择当前素材 ID，仅按指定用途取用。只输出 JSON {"intimacy":"ordinary|romantic|intimate|unknown","attach":true,"subject":"character|ordinary","photoId":"候选图片ID或空","request":"","scene":{},"framing":"selfie|portrait|environment|object","keywords":{"activity":"","emotion":"","pose":"","camera":"","lighting":""},"materialIds":[],"supplementIds":[],"outfitId":"已存套装ID或空","outfitDescription":"","reason":"选择或不附图的简短理由"}。资料：'+JSON.stringify({text:body||'',character:service.profile().name,notes:service.profile().notes,photoSceneReference:service.currentScene(chatId),life:plannedLife,localTime:new Date(now()).toLocaleString('zh-CN',{timeZone:settings.timezone}),policy,test:manual,materials:service.materials.catalog(service.profile().profileId),outfits:service.snapshot().wardrobe,supplements:service.profile().references.slice(1).map(id=>{const a=service.db.asset(id);return {id,name:a.name,note:a.note}}),photos:pool.map(p=>({id:p.id,createdAt:p.at,source:p.source,...service.photoFacts(p),subject:p.subject}))})))
      checkIdentity(expectedIdentity)
      service.life.assertSnapshot(plannedLife)
      prepared.ctx.relationIntimacy=plan.intimacy
      if(manual) onProgress?.({planReason:text(plan.reason,240)})
      if(!manual&&typeof plan.attach!=='boolean') throw new Error('配图计划缺少附图判断，未调用生图服务')
      if(!manual&&plan.attach!==true) return {...prepared,reason:text(plan.reason,240)||'当前语境不适合附图'}
      service.checkExpression(prepared.ctx,plan.intimacy)
      const finish = async p => {
        if(manual) onProgress?.({stage:'photo-facts',photoId:p.id})
        const facts = await service.ensurePhotoFacts(p.id)
        checkIdentity(expectedIdentity); service.authorize(prepared.ctx)
        if(policy==='album') {
          if(facts.grounding!=='verified') throw new Error('旧图尚无可核对的画面注释，本次不附图')
          const match=manual?{matched:true}:parse(await quietAsk(api,'proactive-match','核对主动分享与旧图实际观察。角色身份、衣服颜色/款式/连体分体、活动、时态和物体空间关系有冲突，或关键事实不能确认，则 matched=false。不能把请求或原生成提示词当成图片事实。普通物品图不能冒充角色自拍。只输出 JSON {"matched":true,"reason":""}。资料：'+JSON.stringify({text:body,photo:facts})))
          checkIdentity(expectedIdentity);service.authorize(prepared.ctx)
          if(match.matched!==true)throw new Error('旧图与本次主动分享不匹配，本次不附图')
        }
        return {...prepared,photoId:p.id,policy,...facts,text:service.groundedReply(service.photo(p.id)),responseGuidance:'附图正文已按实际观察收敛；不要重新拼接先前未经核对的画面细节。'}
      }
      if(policy==='album') {
        const selected=pool.find(p=>p.id===plan.photoId)
        if(!selected) return {...prepared,reason:'没有与本次语境匹配的相册图片'}
        return await finish(selected)
      }
      if(!text(plan.request)) return {...prepared,reason:'模型未返回有效画面需求，尚未调用生图服务'}
      if(manual) onProgress?.({stage:'photo-generation'})
      const p=await service.generate({request:text(plan.request),subject:plan.subject,sceneMode:'current',framing:plan.framing,keywords:plan.keywords,scene:plan.scene,materialIds:plan.materialIds,supplementIds:plan.supplementIds,outfitId:text(plan.outfitId),outfitDescription:text(plan.outfitDescription)},prepared.ctx)
      return await finish(p)
    } catch(error) {api.log.warn('主动照片未附加：',error.message);return {...prepared,error:text(error.message,300),errorCode:error.code,failureKind:errorKind(error),modelDiagnostic:error.diagnostic}}
  }
  function testProactive(requestId) {
    const cfg=api.config(), key='proactive-test:'+text(requestId,120)
    if(!text(requestId)) throw new Error('缺少测试编号')
    const source=cfg.ext?.purpose?.enabled?'purpose':'speakup'
    const ctx=service.createTestContext({origin:'proactive',source,chatId:`private:${cfg.ownerQQ}`,jobId:key+':photo'})
    service.authorize(ctx)
    if(!cfg.enabled||cfg.dryRun||api.core.mutes?.muted(ctx.chatId)) throw new Error('机器人未开启、试运行或聊天已静音')
    service.profile()
    const existing=service.db.state.jobs.find(j=>j.key===key)
    if(existing) return {jobId:existing.id,message:'此测试已受理，请查看任务记录',pending:true}
    const job={id:uid(),key,ownerId:String(cfg.ownerQQ),origin:'proactive-test',status:'queued',at:now(),request:'主动附图测试',chatId:ctx.chatId}
    service.db.state.jobs.push(job);service.db.save()
    const run=async()=>{
      try {
        job.status='planning';service.db.save()
        const version=identity()
        const prepared=await prepareProactive({text:'',...ctx,testContext:ctx,onProgress:patch=>{Object.assign(job,patch);service.db.save()}})
        checkIdentity(version)
        if(!prepared?.photoId) throw Object.assign(new Error(prepared?.error||prepared?.reason||'未能准备附图'),{code:prepared?.errorCode,diagnostic:prepared?.modelDiagnostic,failureKind:prepared?.failureKind})
        service.authorize(ctx)
        if(!api.config().enabled||api.config().dryRun||api.core.mutes?.muted(ctx.chatId)) throw new Error('发送条件已改变')
        job.status='sending';job.stage='delivery';job.photoId=prepared.photoId;service.db.save()
        const result=await api.sendSegments(ctx.chatId,[{type:'text',data:{text:prepared.text}}],'[主动附图测试]')
        if(!result||result.message_id===undefined||/^(sim-|queued-)/.test(String(result.message_id))||result.failed||result.ok===false||result.errors?.length) throw new Error('测试文字发送结果未确认，未补发图片')
        const sent=await sendProactive(prepared,result)
        job.status=sent?.ok?'sent':'unknown';job.error=sent?.ok?'':sent?.message||'图片发送未确认';service.db.save()
      } catch(e) {job.status=job.status==='sending'?'unknown':'failed';job.error=text(e.message,400);job.failureKind=e.failureKind||errorKind(e);job.errorCode=e.code;if(e.diagnostic)job.modelDiagnostic=structuredClone(e.diagnostic);service.db.save()}
    }
    Promise.resolve().then(run).catch(()=>{})
    return {jobId:job.id,pending:true,message:'正在准备主动附图测试；结果会显示在任务记录。成功后给主人发文字和图片。'}
  }
  async function sendProactive(prepared, result) {
    if (!prepared?.photoId) return
    const p = service.photo(prepared.photoId)
    const job = service.db.state.jobs.find(x => x.id === p.jobId)
    const hostTextSent=typeof result?.sent==='string' ? !!result.sent.trim() : Number.isInteger(result?.sent)&&result.sent>0
    if (result?.failed || result?.errors?.length || result?.ok===false || !(confirmedReceipt(result)||hostTextSent)) {
      recordDelivery(prepared,'主动文字送达未确认，图片未发送')
      if (job) { job.delivery = 'text-unconfirmed'; service.db.save() }
      return { ok: false, message: '主动文字未确认发送，照片留在相册' }
    }
    try {
      service.life.assertSnapshot(job?.lifeSnapshot)
      const sent = await service.send(prepared.photoId, prepared.ctx, {repeat:true})
      recordDelivery(prepared,sent.ok?'图片已送达':'图片送达未确认')
      if (job) { job.delivery = sent.ok ? 'sent' : 'partial'; service.db.save() }
      return sent
    } catch (error) {
      recordDelivery(prepared,'图片发送失败或送达未确认')
      if (job) { job.delivery = 'partial'; job.deliveryError = text(error.message, 300); service.db.save() }
      return { ok: false, photoId: p.id, message: '文字已发送，照片未确认发送；可核对后重发同一资产' }
    }
  }
  function recordDelivery(prepared,label) {
    const decision=service.db.state.proactiveDecisions?.[prepared.decisionKey]
    if(!decision || decision.jobId!==prepared.ctx.jobId || service.stopped)return
    decision.label=label
    try{service.db.save()}catch{api.log.warn('最近一次主动附图回执暂未写入磁盘')}
  }
  async function observeProactive(input) {
    const key=JSON.stringify([String(api.config().ownerQQ||''),service.life.current()]),at=now()
    const result=await prepareProactive(input)
    if(!result||service.stopped||service.isTestContext(input.testContext))return result
    const reasons=['本次未命中附图概率','相册暂无可用图片，本次不附图','没有与本次语境匹配的相册图片','模型未返回有效画面需求，尚未调用生图服务','配图冷却中','旧图与本次主动分享不匹配，本次不附图']
    const reason=result.reason||result.error
    const failureLabels={'access-or-quota':'权限或额度不足，未能准备附图','network-unknown':'服务连接中断，结果待核对','model-format':'配图规划格式有误','unsupported':'当前模型或接口不支持本次配图'}
    const label=result.photoId?'图片已准备':reasons.includes(reason)?reason:result.error?(failureLabels[result.failureKind]||'附图准备失败，可在记录或日志查看详情'):'当前主动话题适合只发文字'
    const state=service.db.state
    if(!state.proactiveDecisions?.[key]||state.proactiveDecisions[key].at<=at){
      (state.proactiveDecisions||={})[key]={at,label,jobId:input.jobId}
      result.decisionKey=key
      try{service.db.save()}catch{api.log.warn('最近一次主动附图判断暂未写入磁盘')}
    }
    return result
  }
  return { context, provide, validate, available, prepareProactive:observeProactive, sendProactive, testProactive }
}
