import { createHash } from 'node:crypto'

const digest=s=>createHash('sha256').update(String(s)).digest('hex')
const gate=()=>globalThis[Symbol.for('aurabot.persona-memory.owner.v1')]

// Read the installed unified archive. No second transcript database or fallback to unrelated sessions.
export function createLifeSources(api,{runtime,cardRevision,readingVisible}={}) {
  const store=()=>api.core.personaMemoryBridge?.management?.getStore?.()
  function scope(persona,owner){
    const db=store();if(!gate()?.managed?.()||!db)return null
    const s=db.db.prepare("SELECT * FROM scopes WHERE persona=? AND audience='private' AND subject=?").get(persona,owner)
    return s&&!s.blocked&&db.scopeAllowed(s)?s:null
  }
  function reference(e,s){return {id:e.id,scope:s.key,epoch:s.epoch,revision:e.revision,hash:digest(e.body),evidenceHash:digest(e.body.normalize('NFKC').replace(/[\s\p{P}]/gu,'').toLowerCase()),actor:e.actor,at:e.at,role:e.role}}
  function messages(persona,owner){
    const db=store(),s=scope(persona,owner);if(!s)return []
    return db.db.prepare("SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND kind='message' AND role='user' AND actor=? ORDER BY at DESC,id DESC LIMIT 24").all(s.key,s.epoch,owner)
      .filter(e=>db.sourceAllowed(s,e)&&e.body&&e.body.length<=3000)
      .map(e=>({ref:reference(e,s),text:e.body})).reverse()
  }
  function conversation(persona,owner){
    const db=store(),s=scope(persona,owner);if(!s)return []
    return db.db.prepare("SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND kind='message' AND role='assistant' ORDER BY at DESC,id DESC LIMIT 12").all(s.key,s.epoch)
      .filter(e=>db.sourceAllowed(s,e)&&e.body&&e.body.length<=3000)
      .map(e=>({ref:{...reference(e,s),kind:'conversation-state'},text:e.body})).reverse()
  }
  function groupMessages(persona) {
    const db=store()
    if(!db || !gate()?.managed?.()) return []
    const groups=db.scopes(persona).filter(s=>s.audience==='group' && !s.blocked && db.scopeAllowed(s))
    const query=db.db.prepare("SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND kind='message' AND role IN ('user','assistant') ORDER BY at DESC,id DESC LIMIT 8")
    return groups.flatMap(s=>query.all(s.key,s.epoch).filter(e=>db.sourceAllowed(s,e)&&e.body&&e.body.length<=3000)
      .map(e=>({text:e.body,ref:{...reference(e,s),kind:'group-message',chatId:'group:'+s.subject}})))
      .sort((a,b)=>b.ref.at-a.ref.at).slice(0,16)
  }
  function valid(ref,persona,owner){
    try{
      if(ref.kind==='public-reading')return readings(persona,owner).some(x=>x.ref.hash===ref.hash&&x.ref.id===ref.id)
      if(ref.kind==='simulated-event'){
        const e=runtime?.read(owner,persona).events?.find(x=>x.id===ref.eventId)
        return !!e && e.cardRevision===cardRevision?.(persona) && ref.scope===`life:${owner}:${persona}` && simulation(e,persona,owner).ref.hash===ref.hash &&
          (!e.endRef || e.endRef.kind!=='simulated-event'&&valid(e.endRef,persona,owner))
      }
      if(ref.kind==='group-message'){
        const db=store()
        if(!gate()?.managed?.()||!db)return false
        const s=db.scopes(persona).find(s=>s.key===ref.scope&&s.audience==='group'&&'group:'+s.subject===ref.chatId)
        const e=db.event(ref.id)
        return !!s&&!s.blocked&&db.scopeAllowed(s)&&s.epoch===ref.epoch&&e?.scope===s.key&&!e.withdrawn&&e.epoch===s.epoch&&e.revision===ref.revision&&e.role===ref.role&&e.actor===ref.actor&&digest(e.body)===ref.hash&&db.sourceAllowed(s,e)
      }
      if(ref.kind==='life-activity'){
        const a=runtime?.read(owner,persona).activities.find(x=>x.id===ref.activityId)
        return !!a&&!a.invalidated&&a.cardRevision===cardRevision?.(persona)&&a.status==='completed'&&ref.scope===`life:${owner}:${persona}`&&activityHash(a)===ref.hash&&(a.source==='manual'||a.refs?.length>0&&a.refs.every(r=>r.kind!=='life-activity'&&valid(r,persona,owner)))
      }
      if(ref.kind==='tool-receipt')return toolSource(ref.id,persona,owner)?.ref.hash===ref.hash
      const db=store(),s=scope(persona,owner);if(!s||s.key!==ref.scope||s.epoch!==ref.epoch)return false
      const e=db.event(ref.id)
      if(ref.kind==='conversation-state')return !!e&&!e.withdrawn&&e.scope===s.key&&e.epoch===s.epoch&&e.role==='assistant'&&e.revision===ref.revision&&digest(e.body)===ref.hash&&db.sourceAllowed(s,e)
      return !!e&&e.scope===s.key&&e.epoch===s.epoch&&e.role==='user'&&e.actor===owner&&e.revision===ref.revision&&digest(e.body)===ref.hash&&db.sourceAllowed(s,e)
    }catch{return false}
  }
  const activityHash=a=>digest(JSON.stringify([a.title,a.progress,a.status,a.updatedAt,a.cardRevision,a.refs]))
  const activityText=a=>`角色经确认的持续事项：${a.title}；进度：${a.progress||'已完成'}。来源：${a.source==='manual'?'作者确认':'聊天确认'}，不等于外部工具执行回执。`
  function simulation(e,persona,owner){
    const hash=digest(JSON.stringify([e.id,e.title,e.location,e.startedAt,e.endedAt,e.cardRevision,e.endRef]))
    return {text:`角色模拟生活见闻：${e.title}${e.location?'（'+e.location+'）':''}。仅记录已观察到的模拟活动，没有外部工具回执。`,
      ref:{id:'event:'+e.id,kind:'simulated-event',eventId:e.id,scope:`life:${owner}:${persona}`,revision:e.endedAt,hash,evidenceHash:e.id,actor:'character',role:'simulated',at:e.endedAt}}
  }
  function toolSource(id,persona,owner){
    const db=store();if(!scope(persona,owner)||!db)return null
    const r=db.record(id),a=r?.data?.activity
    if(!r||r.data.suppressed||r.data.domain==='roleplay'||r.state!=='valid'||!a?.evidence||!['observed','confirmed','created'].includes(a.status)||['diary','night','character-life'].includes(a.moduleId))return null
    const s=db.scopes(persona).find(x=>x.key===r.scope&&x.epoch===r.epoch)
    if(!s||(s.audience!=='system'&&!(s.audience==='private'&&s.subject===owner))||!['owner','public','scope'].includes(a.visibility)||a.visibility==='scope'&&s.audience==='system'||!db.recordAllowed(s,r))return null
    const refs=db.sources(r.id)
    if(!refs.length||!refs.every(link=>{
      const event=db.event(link.event_id)
      return event?.role==='tool'&&event.scope===s.key&&event.epoch===s.epoch&&event.revision===link.event_revision&&db.sourceAllowed(s,event)
    }))return null
    const content=r.summary||r.body
    const hash=digest(JSON.stringify([content,a.evidence,r.revision,r.epoch,refs]))
    return {text:`工具回执（仅确认动作结果）：${content}`,ref:{id:r.id,kind:'tool-receipt',scope:r.scope,epoch:r.epoch,revision:r.revision,hash,evidenceHash:digest(content),at:r.at,actor:'character',role:'tool'}}
  }
  function receipts(persona,owner){
    const db=store(),own=scope(persona,owner);if(!db||!own)return []
    const scopes=db.scopes(persona).filter(s=>s.key===own.key||s.audience==='system')
    return scopes.flatMap(s=>db.db.prepare("SELECT id FROM records WHERE scope=? AND epoch=? AND state='valid' AND kind='episode' AND json_extract(payload,'$.activity.version')=1 ORDER BY at DESC LIMIT 8").all(s.key,s.epoch))
      .map(r=>toolSource(r.id,persona,owner)).filter(Boolean).sort((a,b)=>b.ref.at-a.ref.at).slice(0,8)
  }
  function simulations(persona,owner){
    const revision=cardRevision?.(persona)
    return (runtime?.read(owner,persona).events||[]).filter(e=>e.cardRevision===revision&&(!e.endRef||e.endRef.kind!=='simulated-event'&&valid(e.endRef,persona,owner))).map(e=>simulation(e,persona,owner))
  }
  function readings(persona,owner){
    if(!readingVisible?.(persona))return []
    const row=runtime?.read(owner,persona)
    return (row?.web?.items||[]).filter(a=>a.card===cardRevision(persona)&&a.epoch===row.epoch&&
      (a.audience==='public'||a.audience==='private:'+owner)&&(!a.ref||a.ref.kind!=='public-reading'&&valid(a.ref,persona,owner))).map(a=>{
      const id='reading:'+digest(a.url), scope='life:'+owner+':'+persona
      return {text:'读过的公开网页，仅作阅读来源，不是亲历：'+a.title+' '+a.url+' 摘录：'+a.body,
        ref:{id,kind:'public-reading',scope,revision:a.at,at:a.at,hash:digest(JSON.stringify([a.url,a.title,a.body,a.at])),evidenceHash:id,
          role:'tool',actor:'character',origins:a.ref?[a.ref.scope]:[]}}
    })
  }
  function recent(persona,owner){
    const activities=(runtime?.read(owner,persona).activities||[]).filter(a=>a.status==='completed').sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,12).map(a=>({text:activityText(a),ref:{id:'activity:'+a.id,kind:'life-activity',activityId:a.id,scope:`life:${owner}:${persona}`,revision:a.updatedAt,hash:activityHash(a),evidenceHash:digest(a.title+' '+a.progress),actor:'character',role:'confirmed-activity',at:a.updatedAt,origins:(a.refs||[]).map(r=>r.scope)}})).filter(x=>valid(x.ref,persona,owner))
    const events=simulations(persona,owner).slice(-8)
    return [...messages(persona,owner),...activities,...receipts(persona,owner),...events,...readings(persona,owner).slice(-4)].sort((a,b)=>a.ref.at-b.ref.at).slice(-24)
  }
  function describe(ref,persona,owner){
    if(!valid(ref,persona,owner))return {id:ref.id,available:false,label:'来源已变更或不可用'}
    if(ref.kind==='public-reading')return {id:ref.id,available:true,kind:ref.kind,at:ref.at,text:readings(persona,owner).find(x=>x.ref.id===ref.id).text}
    if(ref.kind==='simulated-event')return {id:ref.id,available:true,kind:ref.kind,at:ref.at,text:simulation(runtime.read(owner,persona).events.find(x=>x.id===ref.eventId),persona,owner).text}
    if(ref.kind==='life-activity')return {id:ref.id,available:true,kind:'confirmed-activity',at:ref.at,text:activityText(runtime.read(owner,persona).activities.find(x=>x.id===ref.activityId))}
    if(ref.kind==='tool-receipt')return {id:ref.id,available:true,kind:'tool-receipt',at:ref.at,text:toolSource(ref.id,persona,owner).text}
    const e=store().event(ref.id);return {id:ref.id,available:true,kind:'user-message',at:e.at,text:e.body}
  }
  function concerns(persona,owner){
    const db=store(),s=scope(persona,owner);if(!s)return []
    return db.db.prepare("SELECT * FROM records WHERE scope=? AND epoch=? AND state IN ('valid','proposed','agreed','due') AND (kind='commitment' OR kind='promise' OR attribute='commitment' OR attribute='promise') ORDER BY at DESC LIMIT 12").all(s.key,s.epoch)
      .filter(r=>db.recordAllowed(s,r)).map(r=>({id:r.id,title:r.summary||r.body||r.value,refs:db.sources(r.id).map(ref=>{const e=db.event(ref.event_id);return e?reference(e,s):null}).filter(Boolean)}))
      .filter(r=>r.refs.length&&r.refs.every(ref=>valid(ref,persona,owner)))
  }
  function unanswered(persona,owner,now){
    const db=store(),s=scope(persona,owner);if(!s)return []
    const events=db.db.prepare("SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND kind='message' AND at BETWEEN ? AND ? AND (role='assistant' OR (role='user' AND actor=?)) ORDER BY at DESC,rowid DESC LIMIT 20").all(s.key,s.epoch,now-86400000,now,owner)
    const lines=[]
    for(const event of events){
      if(!db.sourceAllowed(s,event))continue
      if(event.role==='user')break
      if(event.body)lines.push(event.body.slice(0,150))
      if(lines.length===4)break
    }
    return lines.reverse()
  }
  function readingReceipt(persona,to,url,after,before){
    const db=store()
    if(!db || !gate()?.managed?.())return ''
    const [audience,subject]=to.split(':')
    const s=db.scopes(persona).find(x=>x.audience===audience && x.subject===subject && !x.blocked && db.scopeAllowed(x))
    if(!s)return ''
    const rows=db.db.prepare("SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND kind='message' AND role='assistant' AND actor='self' AND source_id LIKE 'qq:%' AND at BETWEEN ? AND ? AND instr(body,?)>0 ORDER BY at LIMIT 12").all(s.key,s.epoch,after,before,url)
    const sent=rows.find(x=>/^qq:-?\d+$/.test(x.source_id) && db.sourceAllowed(s,x) &&
      (x.body.match(/https?:\/\/[^\s<>）】」。，]+/gu)||[]).some(link=>link.replace(/[),.!]+$/,'')===url))
    return sent?.source_id.slice(3)||''
  }
  return {recent,messages,simulations,conversation,unanswered,groupMessages,valid,concerns,describe,readingReceipt,ready:()=>!!store()&&!!gate()?.managed?.()}
}
