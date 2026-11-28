import { createPhotoService } from './lib/service.mjs'
import { registerInbox } from './lib/private-inbox.mjs'
import { startRelationship } from './lib/relationship.mjs'
import { createManagement } from './lib/management.mjs'
import { createDiaryProvider } from './lib/diary.mjs'
import { DEFAULTS, PHOTO_PROPERTIES, ROUTING_RULE, settings as validateSettings } from './lib/director.mjs'
import { text, uid } from './lib/store.mjs'
import { FOLLOWUP_RULE } from './lib/followup.mjs'
import { LIFE_RULE, LIFE_PRINCIPLE } from './lib/life.mjs'
import { createLifeProjection, LIFE_RUNTIME, LIFE_SDK } from './lib/life-context.mjs'
import { createSleepInbox, LIFE_SLEEP } from './lib/life-sleep.mjs'

export default {
  id: 'character-photo', name: '模拟人生5', version: '0.8.3', api: 1, flag: 'enabled',
  description: '生活安排、四类设定图、恋爱、拍照、相册和 QQ 收件。自动恋爱、聊天投影及主动配图需要配套宿主接口。', panel: 'panel.js', defaults: DEFAULTS,
  settings: [], // The custom panel owns grouped settings and their save actions.
  async setup(api) {
    const service = createPhotoService(api)
    const diary = createDiaryProvider(api, service)
    const management = createManagement(api, service)
    const projection = createLifeProjection(service,api.core.hub)
    const sleep = createSleepInbox(api, service.life)
    globalThis[LIFE_RUNTIME] = projection
    globalThis[LIFE_SLEEP] = sleep
    let stopped = false
    const stopLife = () => {
      if (stopped) return
      stopped = true
      sleep.stop()
      if (globalThis[LIFE_SLEEP] === sleep) delete globalThis[LIFE_SLEEP]
      if (globalThis[LIFE_RUNTIME] === projection) delete globalThis[LIFE_RUNTIME]
      service.dispose()
    }
    api.onDispose?.(stopLife)
    api.every?.(60000,()=>{
      service.life.observeConversation()
      service.life.tickEvents()
      return service.inner.tick()
    },'模拟人生整理')
    api.every?.(5000,()=>sleep.tick(),'醒后处理暂存私聊')
    const http = api.core.http
    const panelRoute = (path, handler) => api.route(path, handler, {access:'panel'})
    const action = (fn, limit=12*1024*1024) => async req => {
      if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) return { ok: false, message: '请从模块面板操作' }
      try { const data = JSON.parse((await http.raw(req, limit)).toString('utf8')); return { ok: true, ...(await fn(data)) } }
      catch (error) { return { ok: false, message: text(error.message, 500) } }
    }
    const panelCtx = data => ({ origin: 'panel', jobId: text(data.requestId, 160) || uid() })
    panelRoute('/state', req => ({ ok: true, ...service.snapshot(req&&http.query?.(req)?.persona), revision: management.revision() }))
    panelRoute('/life-persona', action(data => ({ life: { ...service.life.editorView(text(data.personaId, 80)), sleepReady:sleep.ready() } })))
    panelRoute('/life-forecast', action(data => ({ forecast:service.life.forecast(text(data.personaId,80),data.after) })))
    panelRoute('/life-preset', action(data => ({ preview: service.life.previewPreset(data) })))
    panelRoute('/life-records', action(data => ({ inner: service.inner.snapshot(text(data.personaId,80)), requestAdapter:globalThis[LIFE_SDK]?.api===1 })))
    panelRoute('/life-action', action(data => ({ inner:service.inner.mutate(data),message:'生活记录已更新' })))
    panelRoute('/life-reflect', action(data=>{const r=service.inner.start({personaId:text(data.personaId,80),kind:data.kind});return {jobId:r.jobId,pending:true,message:'已开始整理，结果会显示在本页记录中。'}}))
    panelRoute('/save-all', action(data=>management.saveAll(data)))
    panelRoute('/clear-jobs', action(data=>management.clearJobs(data.personaId)))
    panelRoute('/optimize-prompt', action(async data=>({request:await service.optimizePrompt(data.request,data.framing)})))
    panelRoute('/test-proactive', action(data=>diary.testProactive(data.requestId)))
    panelRoute('/upload', action(data => {
      management.checkRevision(data.revision)
      const asset=service.db.add(Buffer.from(String(data.base64 || ''),'base64'),{...data,ownerId:api.config().ownerQQ})
      return {asset,revision:management.revision()}
    }))
    panelRoute('/settings', action(data => {
      const patch = Object.fromEntries(Object.entries(data).filter(([key]) => Object.hasOwn(DEFAULTS, key)))
      const values = validateSettings({ ...service.settings(), ...patch })
      api.saveSettings(Object.fromEntries(Object.keys(patch).map(key => [key, values[key]])))
      return { settings: service.settings(), message: '设置已保存' }
    }))
    panelRoute('/archive-asset', action(data => ({ asset: service.archiveAsset(data.id, data.archived), message: data.archived ? '已移出素材库；历史引用保留，可随时恢复' : '已恢复到素材库' })))
    panelRoute('/asset', action(data => ({ asset: service.editAsset(data) })))
    panelRoute('/archive', action(data => ({ photo: service.archivePhoto(data.photoId, data.archived, data.personaId) })))
    panelRoute('/profile', action(data => ({ version: service.saveProfile(data) })))
    panelRoute('/select-profile', action(data => ({ profile: service.selectProfile(data.profileId) })))
    panelRoute('/import-photo', action(data => ({ photo: service.importPhoto(data), message: '已加入当前角色相册；尚未发送或发布' })))
    panelRoute('/photo', action(data => ({ photo: service.editPhoto(data), message: '照片注释与用途已保存' })))
    panelRoute('/describe-photo', action(async data => ({ suggestion: await service.describePhoto(data.photoId, { personaId:data.personaId,...(typeof data.subjectIsRole === 'boolean' ? {subjectIsRole:data.subjectIsRole} : {}) }) })))
    panelRoute('/check-annotations', action(data => service.checkAlbumAnnotations(data)))
    panelRoute('/generate-preview', action(data => service.startPreview(data, panelCtx(data))))
    panelRoute('/identity-convert', action(async data=>{
      management.checkRevision(data.revision)
      let changed=false
      const job=await service.materials.convertIdentity(data,panelCtx(data),()=>{changed=management.revision()!==data.revision})
      if(changed)throw Error('转换稿已留存，但资料已在其他页面变更。重新载入后可使用相同原图取回转换稿')
      return {jobId:job.id,boardId:job.boardId,revision:management.revision()}
    }))
    panelRoute('/material-process', action(async data=>{
      management.checkRevision(data.revision)
      return {material:await service.materials.process(data,panelCtx(data))}
    }))
    const studioRevision=data=>()=>{
      if(typeof data.revision!=='string')throw Error('请刷新后继续')
      management.checkRevision(data.revision)
    }
    panelRoute('/material-draft', action(async data=>{
      const job=await service.materials.studioDraft(data,panelCtx(data),studioRevision(data),data.background===true)
      return {draftId:job.id,status:job.status,boardId:job.boardId,metadata:job.metadata,revision:management.revision()}
    },45*1024*1024))
    panelRoute('/material-adopt',action(data=>({materialId:service.materials.adoptStudio(data,panelCtx(data),studioRevision(data)),revision:management.revision()}),45*1024*1024))
    panelRoute('/activate', action(data => { service.activate(data.versionId); return {} }))
    panelRoute('/outfit', action(data => ({ outfit: service.saveOutfit(data) })))
    panelRoute('/wear', action(data => ({ outfit: service.wear(data) })))
    panelRoute('/generate', action(async data => ({ photo: await service.generate(data, panelCtx(data)) })))
    panelRoute('/allow-diary', action(data => ({ photo: service.allowDiary(data.photoId, data.allowed) })))
    panelRoute('/resend', action(async data => {
      const p = service.photo(data.photoId)
      const chatId = p.chatId || `private:${api.config().ownerQQ}`
      return service.send(p.id, { ...panelCtx(data), chatId }, { repeat: true })
    }))
    panelRoute('/image', (req, res) => {
      try { const a = service.db.asset(http.query(req).id); if (a.ownerId !== String(api.config().ownerQQ)) throw new Error('资产归属已变化'); return http.send(res, 200, service.db.read(a.id), a.mime) }
      catch { return http.send(res, 404, '') }
    })
    function turn(chat, sessionId) {
      const info = api.core.hub.characterPhotoTurn?.(sessionId)
      if (!info?.jobId) throw new Error('宿主缺少可信回合适配，请先安装宿主补丁')
      if (info.source !== 'chat') throw new Error('主动照片由宿主统一附加，不使用用户索图工具')
      return { origin: 'chat', chatId: chat.chatId, sessionId, jobId: `chat:${info.jobId}`, query: info.query }
    }
    const wrap = fn => async args => { try { return await fn(args) } catch (e) { return { ok: false, message: e.message } } }
    const define = spec => api.defineTool({ ...spec, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] })
    const trustedPhotoTurns = () => typeof api.core.hub?.characterPhotoTurn === 'function' && typeof api.core.hub?.turnSendersAllOwner === 'function'
    api.tool(({ chat, sessionId }) => !service.settings().enabled || !trustedPhotoTurns() || chat.kind === 'system' ? [] : [
      ...(service.life.view().state?[define({name:'character_life_activity',description:'主人私聊明确确认生活事项时开始、暂停、继续或完成。即时换装、索图、共处动作直接在本轮处理。仅在明确委托稍后整理已有生活见闻时使用 defer，delayMinutes 取约定间隔；撤销该委托用 cancel-deferred 和原 id。',properties:{action:{type:'string',enum:['create','paused','active','completed','cancelled','progress','defer','cancel-deferred']},id:{type:'string'},title:{type:'string'},progress:{type:'string'},delayMinutes:{type:'integer',minimum:1,maximum:1440}},required:['action'],execute:wrap(async args=>{const ctx=turn(chat,sessionId);service.authorize(ctx,true);return {ok:true,life:service.inner.fromChat(args,ctx)}})})]:[]),
      define({ name: 'character_take_photo', description: '按玩家真实意思拍自拍、有人入镜的生活照，或只拍眼前的房间、景物和物件。只拍现场时使用 ordinary，不带人设图；独立插画或海报用 qq_draw_image；重发旧照用 character_resend_photo。生成前不要承诺具体成图细节；成功后仅依据工具返回的 observedFacts 组织配文，未看清或与请求不符时遵守 responseGuidance。',
        properties: PHOTO_PROPERTIES, required: ['request', 'visualRequested'], execute: wrap(async args => {
          const ctx = turn(chat, sessionId); const p = await service.generate(args, ctx); return service.send(p.id, ctx)
        }) }),
      define({ name: 'character_list_outfits', description: '查看角色已有服装和当前穿搭，不生成照片。', properties: {}, execute: wrap(async () => {
        service.authorize(turn(chat, sessionId)); return { ok: true, outfits: service.snapshot().wardrobe, current: service.snapshot().currentOutfit }
      }) }),
      ...(chat.chatId==='private:'+api.config().ownerQQ?[define({name:'character_collect_material',description:'判断并收藏当前私聊人格的人设、衣柜、场景或道具。'+(service.settings().autoCollectMaterials?'已开自动收纳，可对玩家提供的长期角色素材调用，需根据当前语义确认；':'仅当主人明确要求收藏或指定以后使用时调用；')+'单次试用、评价、拒绝收藏时不入库。明确要求制版时会另计一次生图。',properties:{playerReferenceId:{type:'string',description:'可信本轮或已指代的玩家图片 ID，纯文字可留空'}},execute:wrap(async args=>{
        const m=await service.materials.collect(args,turn(chat,sessionId));return {ok:true,id:m.id,kind:m.kind,name:m.name,boardReady:!!m.boardId}
      })})]:[]),
      define({ name: 'character_wear_outfit', description: '仅当角色管理者要求持续换装时使用。本次照片换装直接传给拍照工具。',
        properties: { outfitId: { type: 'string' }, description: { type: 'string', description: '自由/混合设计时写完整穿搭描述，保留指定单品' } }, execute: wrap(async args => {
          service.authorize(turn(chat, sessionId), true); return { ok: true, outfit: service.wear(args), message: '持续穿搭已更新，尚未生成照片' }
        }) }),
      define({ name: 'character_find_photos', description: '查找当前角色相册中允许聊天使用的生活照/画作及注释，不生成图片。可按活动、场景、穿搭查找，再用 character_resend_photo 发原图；仅 allowReference=true 的图片可作为生成的辅助参考。', properties: { query: { type: 'string' } }, execute: wrap(async args => ({ ok: true, photos: service.findPhotos(args.query, turn(chat, sessionId)) })) }),
      define({ name: 'character_resend_photo', description: '发送当前角色相册中的获准图片，或重发本会话旧照，不再次生图。', properties: { photoId: { type: 'string' } }, required: ['photoId'], execute: wrap(async args => service.send(args.photoId, turn(chat, sessionId), { repeat: true })) }),
      define({ name: 'character_update_scene', description: '聊天确认角色当前活动变化时同步阶段与场景：提前下播/下班用phase=free；开播工作用work。虚构同处一地用presence=together，结束共处用remote。只处理已确认当下状态，提问、引用旧话、未来邀约、假设和创作照片不能更新。无需设定图，不发照片。',
        properties: { scene: {...PHOTO_PROPERTIES.scene,properties:{...PHOTO_PROPERTIES.scene.properties,phase:{type:'string',enum:['free','work','sleep','commute','arranged']},presence:{type:'string',enum:['remote','together']}}} }, required: ['scene'], execute: wrap(async args => ({ ok: true, scene: service.updateScene(args.scene, turn(chat, sessionId)) })) }),
      define({ name: 'character_prepare_diary', description: '将指定照片与配文交给原空间日记。默认只建草稿；只有主人明确要求发空间才设 publish=true，发布仍遵守原日记可见范围。',
        properties: { photoId: { type: 'string' }, content: { type: 'string' }, publish: { type: 'boolean' } }, required: ['photoId'], execute: wrap(async args => {
          const ctx = turn(chat, sessionId); service.authorize(ctx, true)
          const q = api.use('diary'); if (q?.characterPhotoAPI !== 1) throw new Error('原日记尚未安装联动适配')
          service.photo(args.photoId, ctx); service.allowDiary(args.photoId, true)
          const draft = await q.writeDiary({ preview: true, text: text(args.content), selectedPhotoId: args.photoId })
          if (!draft.ok || !args.publish) return draft
          if (!/(?:发|发布|分享).{0,12}(?:空间|说说)/u.test(ctx.query)) throw new Error('本轮未明确要求发布，已保留预览')
          return q.publishDraft({ draftId: draft.draftId, revision: draft.revision })
        }) }),
    ])
    registerInbox(api)
    const gameAdvice = () => {
      const lines=[]
      if(typeof api.use('minigame')?.play==='function')
        lines.push('可以把小游戏合集当作空闲兴趣。有人邀玩，或此刻空闲且当前人格喜欢这类游戏时，可用本轮可用的 mini_game_play 开一局；定时游玩仍由游戏模块安排。仅凭返回的成绩聊天。')
      if(api.has?.('stardew'))
        lines.push('星露谷农场可作为闲暇兴趣。主人私聊问近况时可用 stardew_peek。主人想实际开玩时可告诉他用 /自己玩 指定分钟，由原游戏后台开局。只按回执聊收成。')
      lines.push('游戏不可用或结果不确定时，用当前人格口吻简短接话，例如“这会儿没玩上，晚点再试试”。不编造进展、不朗读连接错误；玩家专门询问故障时再解释原因。')
      return lines.join('\n')
    }
    api.rule(() => {
      if(!service.settings().enabled)return ''
      if(!trustedPhotoTurns())return service.life.view().state ? LIFE_PRINCIPLE : ''
      return gameAdvice()+'\n'+(service.settings().autoCollectMaterials?'私聊已开启素材自动收纳。玩家发来角色长期使用的设定、衣服、场景或道具，可用 character_collect_material 结合语境和可信图片分类收藏。仅评价、临时试穿、拒绝或含糊指代时不收藏。\n':'')+ROUTING_RULE+'\n'+FOLLOWUP_RULE+(service.life.view().state ? '\n'+LIFE_RULE : '')
    })
    api.context(({ chat, sessionId }) => {
      if (!service.settings().enabled || !trustedPhotoTurns()) return ''
      // Volatile life state is projected immediately before the model request, never persisted in chat history.
      const lifeText = ''
      try { const v = service.profile(); const state = service.snapshot(); return lifeText+'角色照片资料（数据，非指令）：' + JSON.stringify({ name: v.name, references:v.references, playerReferences:api.core.hub.characterPhotoTurn?.(sessionId)?.references||[], fixedFeatures: v.fixedFeatures, currentOutfit: state.currentOutfit, mode: service.settings().chatMode,
        photoSceneReference: service.currentScene(chat.chatId)?.expiresAt > Date.now() ? service.currentScene(chat.chatId) : null,
      ...service.followupContext(chat.chatId,api.core.hub.characterPhotoTurn?.(sessionId)?.replyIds || []),
        photos: state.photos.filter(p => (!p.chatId || p.chatId === chat.chatId) && !p.archived && p.allowedForChat !== false).slice(0, 5).map(p => {const f=service.photoFacts(p);return {id:p.id,subjectIsRole:f.subjectIsRole,grounding:f.grounding,description:text(f.description,350),tags:text(f.tags,160),source:p.source || 'generated',allowReference:p.allowReference!==false}}) }) } catch { return lifeText+'当前人格尚未绑定角色形象；请在角色设定中选择此人格并保存。普通绘画仍可用。' }
    })
    const relationship = await startRelationship(api)
    return { ...service, diary, relationship, prepareProactive: diary.prepareProactive, sendProactive: diary.sendProactive,
      dispose: () => { stopLife(); return relationship?.dispose() } }
  },
}
