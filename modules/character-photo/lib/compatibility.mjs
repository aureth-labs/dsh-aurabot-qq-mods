const nativeSizes = {'3:4':'960x1280','4:3':'1280x960','9:16':'864x1536'}

// Official Aurabot returns an asynchronous reference limit and accepts an explicit WxH.
export function photoImageProvider(api, gen = api.use('imagegen')) {
  if (gen?.characterPhotoAPI === 1) return gen
  if (typeof gen?.generate !== 'function' || typeof gen.enabled !== 'function' || typeof gen.referenceLimit !== 'function') return null
  const reject = message => { throw Object.assign(new Error(message), {definiteFailure:true}) }
  function checkStyle() {
    if (api.config().imageGen?.stylePrompt?.trim() && gen.supportsReferenceStyle !== true) {
      reject('此宿主会把全局画风加到参考图上。请清空生图的全局画风，或安装支持参考图独立画风的宿主后重试')
    }
  }
  return {
    enabled: () => gen.enabled(), extendedPhotoRatios:true, checkStyle,
    referenceLimit: () => gen.referenceLimit(),
    async generate(prompt, options = {}) {
      const refs = options.images || []
      if (options.styleMode === 'reference') checkStyle()
      if (refs.length && refs.length > await gen.referenceLimit()) reject('当前生图服务支持的参考图数量不足')
      return gen.generate(prompt, {...options, ...(nativeSizes[options.shape] ? {size:nativeSizes[options.shape]} : {}), count:1})
    },
  }
}

// Read-only diagnostics. Never disable/uninstall another module or change its settings.
export function photoCompatibility(api, inventory) {
  const cfg=api.config(),items=[]
  const use=id=>{try{return api.use(id)}catch{return null}}
  try {inventory??=globalThis.aurabot?.modules?.list?.()} catch {}
  const installed=id=>inventory?.some(m=>m.id===id)||Boolean(api.has?.(id))
  const running=id=>Boolean(inventory?.find(m=>m.id===id)?.running||api.has?.(id))&&cfg.modules?.[id]?.enabled!==false&&cfg.ext?.[id]?.enabled!==false
  const add=(id,level,title,detail)=>items.push({id,level,title,detail})
  const gen=photoImageProvider(api,use('imagegen'))
  if(!gen)add('imagegen','conflict','原生生图接口未适配','需要含参考图接口的 Aurabot 生图服务。')
  if(gen?.checkStyle && cfg.imageGen?.stylePrompt?.trim() && use('imagegen')?.supportsReferenceStyle!==true)add('reference-style','conflict','参考图会叠加全局画风','清空「生图」的全局画风或更新支持独立画风的宿主，即可转换设定图。')
  if(typeof api.core?.hub?.characterPhotoTurn!=='function'||typeof api.core?.hub?.characterPhotoReference!=='function')add('chat-photo-turn','notice','聊天拍照缺少可信回合接口','面板可单独使用。QQ 索图、引用原图及素材收藏需要宿主提供当前消息、发送者和引用图的凭据。')
  if(globalThis[Symbol.for('aurabot.character-life.sdk.v1')]?.api!==1)add('life-sdk','notice','生活状态尚未接入聊天请求','生活页可管理作息。聊天按当下活动或见面情景回应，需要 DSH 请求投影及同人格会话归属。')
  if(api.core?.personaMemoryBridge?.relationshipLifecycleAPI!==1)add('relationship-host','notice','恋爱自动结算尚未接入','需要宿主提供同人格记忆生命周期、实际回执和回合来源。可在「恋爱」查看具体缺项。')
  if(cfg.ext?.['character-photo']?.diary&&use('diary')?.characterPhotoAPI!==1)add('diary','conflict','空间日记接口未适配','角色配图需要原日记的共享草稿接口；聊天拍照可独立使用。')
  if(installed('wardrobe'))add('wardrobe',running('wardrobe')?'conflict':'inactive','旧衣柜',running('wardrobe')?'两套穿搭资料独立，可能向聊天提供不同衣服。建议停用旧衣柜，统一在角色设定管理；不会自动迁移或删除。':'已安装但未启用，当前没有双重穿搭来源。')
  if(installed('history-vault')) {
    const managed=Boolean(api.core?.personaMemoryBridge?.managed?.()||globalThis[Symbol.for('aurabot.persona-memory.owner.v1')]?.managed?.())
    const active=running('history-vault')
    add('history-vault',active&&managed?'conflict':active?'notice':'inactive','跨会话记忆',active&&managed?'统一人设记忆档案已接管，跨会话记忆不可同时运行。请在记忆管理检查接管状态并停用旧模块。':active?'未检测到统一记忆接管，不能仅凭同时安装判定冲突；切换到人设记忆管理前需检查兼容。':'已安装但未运行；不要与已接管的人设记忆管理同时启用。')
  }
  if(running('shitu'))add('shitu','notice','识图','可同时使用。OCR可能替换聊天里的图像块；照片参考保留原始图片，不能用OCR文字代替衣物参考。看图能力仍由当前模型决定。')
  if(running('token-budget'))add('token-budget','notice','预算管家','可同时使用。聊天预算与本模块的生图次数、后台注释调用不同，不代表图片费用已被统一封顶。')
  if(installed('persona-memory'))add('persona-memory','notice','人设记忆管理','照片保留独立资产，配合记忆切换与重置接口；增强关闭并接续原生不等于解除统一档案管理。更新任一模块后需保持配套宿主适配。')
  return {checkedAt:Date.now(),inventoryAvailable:Array.isArray(inventory),items,conflicts:items.filter(x=>x.level==='conflict').length,scope:'按稳定模块ID及接口检查已知组合；没有提醒不代表所有市场模块均已验证。'}
}
