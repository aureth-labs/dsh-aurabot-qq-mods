import {ROMANCE_PRESETS,CUSTOM_ROMANCE_TEMPLATE} from './lib/romance.mjs'
import {existsSync,unlinkSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import { personaAvatars } from './lib/avatars.mjs'
import { RelationService } from './lib/service.mjs'
import { RUNTIME, VERSION, DEFAULTS, STARTER_TEMPLATE } from './lib/policy.mjs'
import { projectMessages } from './lib/context.mjs'
import { createModelAdapter } from './lib/judge.mjs'

export default {
  id:'character-relation',name:'恋爱进行时',version:VERSION,api:1,flag:'enabled',
  description:'主人私聊关系进展、独立附加段、心情与纠错；原卡只读，默认关闭。',
  panel:'panel.js',defaults:{enabled:false,optionalEnabled:false,captureEnabled:true,showHeroRelation:true},settings:[],
  setup(api) {
    const previous=globalThis[RUNTIME]
    if(previous)throw Error('已有关系运行提供方，请先停用旧实例')
    const bridge=api.core.personaMemoryBridge
    const dependencies=()=>({resetReady:bridge?.relationshipResetAPI===1,lifecycleReady:bridge?.relationshipLifecycleAPI===1,photoReady:!api.use?.('character-photo')||api.use('character-photo').relationExpressionAPI===1,liveReady:bridge?.relationshipLifecycleAPI===1&&globalThis[Symbol.for('aurabot.character-relation.gameplay.v1')]?.api===1&&!!bridge?.relationArchive&&globalThis[Symbol.for('aurabot.character-relation.transport.v1')]?.api===1&&typeof api.use?.('mood')?.applyRelationEvent==='function'})
    const service=new RelationService({file:api.dataDir('relations.sqlite'),config:api.config,settings:api.settings,model:createModelAdapter(api),modules:()=>api.core.modules?.status?.()||[],dependencies,sourceCheck:(captured,sources)=>bridge?.relationSourcesAvailable?.(captured,sources)===true,
      mood:()=>{const m=api.use?.('mood');return typeof m?.current==='function'?{value:Math.round(m.current()),label:m.label?.()||''}:null},
      hostIntegrations:()=>({memoryMode:bridge?.mode?.(),memoryRows:bridge?.compatibilityStatus?.()?.rows||[],activePolicy:api.core.outbound?.status?.()?.activePolicy}),
      archive:{flushPrivacy:()=>bridge?.relationFlushPrivacy?.(),check:(c,refs)=>bridge?.relationSourceCheck?.(c,refs)===true,find:(c,id)=>bridge?.relationArchive?.(c,{sourceId:id})?.[0],recent:(c,limit)=>bridge?.relationArchive?.(c,{limit})||[],...(bridge?.relationResetBoundary?{resetBoundary:args=>bridge.relationResetBoundary(args)}:{})},
      deliver:async(kind,payload,captured)=>{if(kind==='mood')return api.use('mood').applyRelationEvent(payload);if(kind==='memory')return bridge.recordActivity(captured,{...payload,actor:captured.input.subject,kind:'relation-interpretation',domain:'reported',text:'互动语义记录（非新发生动作）：'+payload.text});if(kind==='retract'){bridge.retractActivity(captured,payload.sourceId);return {ok:true}}throw Error('未知同步类型')}
    })
    let runtime,closing
    const dispose=()=>{
      if(runtime && globalThis[RUNTIME]===runtime)delete globalThis[RUNTIME]
      return closing ||= service.dispose()
    }
    api.onDispose?.(dispose)
    const retiredDir=api.dataDir('retired-personas')
    const clearRetired=()=>{
      if(!existsSync(retiredDir))return
      for(const file of readdirSync(retiredDir)){
        if(!/^[0-9a-f]+\.json$/.test(file))continue
        const path=join(retiredDir,file),id=JSON.parse(readFileSync(path,'utf8'))
        if(typeof id!=='string'||Buffer.from(id).toString('hex')+'.json'!==file)continue
        if(api.core.personas?.list?.().some(p=>p.id===id))continue
        service.deletePersona(id)
        unlinkSync(path)
      }
    }
    clearRetired()
    service.photoFollowup=(chatId,ids)=>{const photo=api.use?.('character-photo');return photo?.settings?.().enabled===true?photo.followupContext?.(chatId,ids):null}
    const safe=(fn,fallback=null)=>(...args)=>{try{return fn(...args)}catch(error){service.lastIssue=String(error.message).slice(0,200);return fallback}}
    runtime={
      api:1,projectRequest:(session,messages,args)=>projectMessages(session,messages,args,service),
      openTurn:safe(args=>service.collector.open(args)),extendTurn:safe((token,sources)=>service.collector.extend(token,sources)),
      sourcesForTurn:safe(token=>service.collector.sourcesFor(token),[]),
      captureMedia:safe(args=>service.media.capture(args)),recordMedia:safe((...args)=>service.media.record(...args),false),attachMedia:(token,sources)=>service.media.attach(token,sources),
      receipt:safe((token,receipt)=>service.collector.receipt(token,receipt)),finishTurn:safe((token,result)=>service.collector.finish(token,result)),
      runTool:(context,fn)=>service.activities.run(context,fn),toolReceipt:safe((chatId,receipt)=>service.activities.receipt(chatId,receipt)),
      activityResult:safe(args=>service.activities.confirmed(args)),
      proactiveReceipt:safe((chatId,sourceId)=>service.activities.share(chatId,sourceId)),
      // Native judgment waits only for the matching captured turn's ownership decision.
      ownsMood:activity=>service.ownsMood(activity),modeRevision:()=>{if(service.closed)return 'disposed';const row=service.owner()?service.store.get(service.persona(),service.owner()):null;return service.closed?'disposed':JSON.stringify([service.enabled(),service.persona(),row?.configRevision,service.settings().captureEnabled])},
      leaseModel:(...args)=>service.leaseModel(...args),claimModelAttempt:options=>service.claimModel(options),
      idleFactor:lastOwnerAt=>service.idleMultiplier(lastOwnerAt),
      forgetImpact:args=>service.privacy.impact(args),forgetSources:args=>service.privacy.forget(args),
      captureExpression:args=>service.consumers.capture(args),assertExpression:(stamp,content)=>service.consumers.assert(stamp,content),
    }
    globalThis[RUNTIME]=runtime
    const http=api.core.http
    const post=fn=>async req=>{
      if(req.method!=='POST'||!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||''))return {ok:false,message:'请从模块管理页操作'}
      try {
        const value=JSON.parse((await http.raw(req,128*1024)).toString('utf8'))
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error('请求格式无效')
        return {ok:true,...await fn(value)}
      }catch(e){return {ok:false,message:String(e.message).slice(0,500)}}
    }
    const route=(path,fn)=>api.route(path,fn,{access:'panel'})
    const personas=()=>personaAvatars(api,api.core.personas?.list?.().map(({id,name})=>({id,name,relation:service.presentation(id),relationEnabled:service.store.get(id,service.owner())?.config.mode!=='off'}))||[{id:service.persona(),name:service.persona(),relation:service.presentation(),relationEnabled:true}],service.persona())
    const known=persona=>{if(!personas().some(p=>p.id===persona))throw Error('此人格卡不存在；不能创建或修改虚构ID的关系档案');return persona}
    route('/state',req=>({ok:true,...service.snapshot(http.query(req).persona||service.persona()),romancePresets:ROMANCE_PRESETS,romanceCustomTemplate:CUSTOM_ROMANCE_TEMPLATE,templates:DEFAULTS,starterTemplate:STARTER_TEMPLATE,personas:personas(),settings:api.settings()}))
    route('/history',req=>{try{const q=http.query(req),persona=known(q.persona||service.persona());bridge?.relationFlushPrivacy?.();const row=service.store.get(persona,service.owner());return {ok:true,...row?service.store.committed.page(row,q):{rows:[],total:0,page:0,pageSize:10}}}catch(e){return {ok:false,message:e.message}}})
    route('/settings',post(data=>{
      if(typeof data.enabled!=='boolean'||typeof data.optionalEnabled!=='boolean')throw Error('开关格式无效')
      if(data.captureEnabled!==undefined&&typeof data.captureEnabled!=='boolean')throw Error('采集开关格式无效')
      service.cancel();api.saveSettings({enabled:data.enabled,optionalEnabled:data.optionalEnabled,captureEnabled:data.captureEnabled??api.settings().captureEnabled??false});return {settings:api.settings()}
    }))
    route('/intimacy-toggle',post(data=>{
      known(data.persona)
      if(typeof data.enabled!=='boolean')throw Error('开关格式无效')
      const row=service.store.get(data.persona,service.owner())
      if(!row)throw Error('请先保存相处方式')
      const next=service.save({persona:data.persona,revision:data.revision,patch:{optionalEnabled:data.enabled,arousal:{enabled:data.enabled}}})
      return {row:next}
    }))
    route('/optional-master',post(data=>{
      if(typeof data.enabled!=='boolean')throw Error('总开关格式无效')
      service.cancel()
      return {settings:api.saveSettings({optionalEnabled:data.enabled})}
    }))
    route('/hero-visibility',post(data=>{if(typeof data.visible!=='boolean')throw Error('顶部显示开关格式无效');return {settings:api.saveSettings({showHeroRelation:data.visible})}}))
    route('/create',post(data=>({row:service.create(known(data.persona))})))
    route('/save',post(data=>{known(data.persona);return {row:service.save(data)}}))
    route('/defaults',post(data=>({defaults:service.saveDefaults(data)})))
    route('/merge-preview',post(data=>{known(data.persona);return service.configuration.merge(data)}))
    route('/preset-preview',post(data=>{known(data.persona);return service.configuration.preset(data)}))
    route('/export-settings',post(data=>({bundle:service.configuration.export(known(data.persona))})))
    route('/export-archive',post(data=>({bundle:service.configuration.exportArchive(known(data.persona))})))
    route('/binding-preview',post(data=>{known(data.persona);return service.configuration.bindingPreview(data)}))
    route('/import-preview',post(data=>{known(data.persona);return service.configuration.importPreview(data)}))
    route('/transition-preview',post(data=>{known(data.persona);return {preview:service.configuration.transitionPreview(data)}}))
    route('/transition',post(data=>({row:service.configuration.transition(data)})))
    route('/undo-preview',post(data=>{known(data.persona);return {preview:service.undoPreview(data)}}))
    route('/undo',post(data=>{known(data.persona);return service.undo(data)}))
    route('/undo-live-preview',post(data=>{known(data.persona);const row=service.store.get(data.persona,service.owner());if(!row)throw Error('档案不存在');return {preview:service.live.previewUndo(row,data)}}))
    route('/undo-live',post(async data=>{known(data.persona);const row=service.store.get(data.persona,service.owner());if(!row)throw Error('档案不存在');service.cancel(row.key);const result=service.live.undo(row,data);if(row.persona===service.persona())await service.live.drain(row,service.memory().capture('private:'+row.owner));return result}))
    const currentRow=data=>{known(data.persona);if(data.persona!==service.persona())throw Error('请切换实际运行人格后确认来源');const row=service.store.get(data.persona,service.owner());if(!row)throw Error('请先创建关系档案');return row}
    route('/sources',post(data=>{const row=currentRow(data);return {sources:service.archive.recent(service.memory().capture('private:'+row.owner),12)}}))
    route('/source-detail',post(data=>{
      const row=currentRow(data)
      if(typeof data.sourceId!=='string'||!data.sourceId||data.sourceId.length>200)throw Error('来源无效')
      service.archive.flushPrivacy()
      const captured=service.memory().capture('private:'+row.owner)
      const source=service.archive.find(captured,data.sourceId)
      return {source:source||null,message:source?'':'原话不在当前可用档案中，可能已遗忘或来自重新开始前的记录。'}
    }))
    route('/fact-confirm',post(data=>({fact:service.facts.confirm(currentRow(data),data)})))
    route('/fact-revoke',post(data=>service.facts.revoke(currentRow(data),data)))
    route('/review-preview',post(data=>({preview:service.live.reviewPreview(currentRow(data),data)})))
    route('/review',post(async data=>{const row=currentRow(data);service.cancel(row.key);const result=service.live.review(row,data);await service.live.drain(row,service.memory().capture('private:'+row.owner));return result}))
    route('/semantic-prepare',post(data=>{currentRow(data);return service.semanticReview.prepare(data)}))
    route('/semantic-evaluate',post(data=>service.semanticReview.evaluate(data)))
    route('/semantic-confirm',post(async data=>{const result=service.semanticReview.confirm(data),row=service.store.get(service.persona(),service.owner());await service.live.drain(row,service.memory().capture('private:'+row.owner));return result}))
    route('/optional',post(data=>{known(data.persona);return service.setOptional(data)}))
    route('/sync',post(async data=>{const row=currentRow(data);await service.live.drain(row,service.memory().capture('private:'+row.owner));return {pending:service.live.pending(row).length}}))
    route('/adjust',post(data=>({row:service.adjust(data)})))
    route('/diagnostics',post(data=>{const persona=known(data.persona);return {diagnostics:service.diagnostics(persona,api.core.personas?.read?.(persona)?.raw)}}))
    route('/preview',post(data=>{known(data.persona);return {preview:service.preview(data),originalCard:api.core.personas?.read?.(data.persona)?.raw||'',composition:'原人格卡与宿主规则照常保留；本模块附加段只进入请求末端，不保存到聊天历史。显示原卡与本模块当轮实际投影。'}}))
    route('/reset',post(async data=>{known(data.persona);return {row:await service.reset(data)}}))
    route('/shadow',post(data=>service.shadow(data)))
    api.every?.(15000,async()=>{if(!service.enabled())return;const row=service.store.get(service.persona(),service.owner());if(row&&service.live.pending(row).length)await service.live.drain(row,service.memory().capture('private:'+row.owner))},'关系待同步')
    api.every?.(900000,()=>{if(service.enabled())service.retention.run()},'关系记录整理')
    return {
      memoryResetAPI:1,memoryReset:args=>service.memoryReset(args),
      afterPersonaDelete:clearRetired,
      snapshot:()=>service.snapshot(),
      presentation:()=>{
        if(api.settings().showHeroRelation===false)return null
        const relation=service.presentation()
        return relation?.paused?null:relation
      },
      dispose,
    }
  }
}
