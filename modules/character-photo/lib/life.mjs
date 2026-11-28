import { createHash } from 'node:crypto'
import { text } from './store.mjs'
import { WORLD_DEFAULTS, worldSettings, worldState } from './life-world.mjs'
import meetingRules from './life-meeting.cjs'
import { createLifeStore } from './life-store.mjs'
import {applyWorkEpisode,createWorkClock,workPossibilities} from './life-work.mjs'
import { join } from 'node:path'
import { createLifeSources } from './life-sources.mjs'
import { LIFE_IDENTITIES } from './life-identities.mjs'
import { CALENDAR_DEFAULTS, calendarSettings, calendarState } from './life-calendar.mjs'
import { LIFE_PRESETS, presetPreview } from './life-presets.mjs'
import { WEB_DEFAULTS, createLifeWeb, webSettings } from './life-web.mjs'

const {MEETING_IDLE_MS,readMeetingTurn}=meetingRules

export const LIFE_DEFAULTS = Object.freeze({
  ...WEB_DEFAULTS,
  ...WORLD_DEFAULTS,
  ...CALENDAR_DEFAULTS,
  enabled: true, workIncidents:true, mode: 'fixed', sleepStart: '01:00', wakeTime: '08:00', flexMinutes: 20,
  workEnabled: false, workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00',
  workLabel: '工作或学习', home: '', workPlace: '', environment: '', notes: '',
})
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const minute = value => {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('作息时间请使用 HH:mm 格式')
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}
const duration = (from, to) => (minute(to) - minute(from) + 1440) % 1440
const configKey = (owner, persona) => JSON.stringify([owner, persona])

export function lifeSettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('生活配置格式无效')
  const c = Object.fromEntries(Object.keys(LIFE_DEFAULTS).map(k => [k, raw[k] ?? structuredClone(LIFE_DEFAULTS[k])]))
  for (const k of ['enabled', 'workEnabled','workIncidents']) if (typeof c[k] !== 'boolean') throw new Error('生活开关格式无效')
  if (!['fixed', 'flexible'].includes(c.mode)) throw new Error('请选择固定或弹性作息')
  for (const k of ['sleepStart', 'wakeTime', 'workStart', 'workEnd']) minute(c[k])
  if (!Number.isInteger(c.flexMinutes) || c.flexMinutes < 0 || c.flexMinutes > 60) throw new Error('浮动范围应为 0 至 60 分钟')
  if (!Array.isArray(c.workDays) || c.workDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('请选择有效的工作日')
  c.workDays = [...new Set(c.workDays)].sort()
  for (const [k, max] of Object.entries({ workLabel: 60, home: 100, workPlace: 100, environment: 400, notes: 500 })) c[k] = text(c[k], max)
  if (!duration(c.sleepStart, c.wakeTime)) throw new Error('入睡和起床时间不能相同')
  if (c.scheduleMode==='basic'&&c.workEnabled && (!duration(c.workStart, c.workEnd) || !c.workDays.length || !c.workLabel)) throw new Error('请补全工作安排、日期与活动名称')
  if (c.enabled && c.workEnabled && c.scheduleMode==='basic') {
    const flex = c.mode === 'flexible' ? c.flexMinutes : 0
    // Check the complete weekly cycle, including work continuing past midnight.
    for (let day = -1; day <= 7; day++) {
      if (!c.workDays.includes((day + 7) % 7)) continue
      const start = day * 1440 + minute(c.workStart), end = start + duration(c.workStart, c.workEnd)
      for (let sleepDay = day - 1; sleepDay <= day + 1; sleepDay++) {
        const sleep = sleepDay * 1440 + minute(c.sleepStart)
        if (start < sleep + duration(c.sleepStart, c.wakeTime) + flex && end > sleep - flex)
          throw new Error('工作与睡眠时段重叠，请调整时间或缩小浮动范围')
      }
    }
  }
  return {...c,...worldSettings(raw),...calendarSettings(raw),...webSettings(raw)}
}

const formatters = new Map()
export function localClock(at, zone) {
  let format = formatters.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    if (formatters.size >= 8) formatters.clear()
    formatters.set(zone, format)
  }
  const p = Object.fromEntries(format.formatToParts(at).map(x => [x.type, x.value]))
  const day = `${p.year}-${p.month}-${p.day}`
  return { day, serial: Date.parse(day + 'T00:00:00Z') / 86400000, minute: Number(p.hour) * 60 + Number(p.minute), label: `${day} ${p.hour}:${p.minute}` }
}

function routineState(c, clock, schedule, at, zone) {
  if (!c.enabled) return null
  const phase=schedule.phase
  return {
    kind: 'simulated-routine', source: 'routine', fictional: true, phase,
    activity: schedule.activity, location:schedule.location,plannedActivity:schedule.plannedActivity,
    sleepEpisode:schedule.sleepEpisode, awakeMinutes:schedule.awakeMinutes, availableMinutes:schedule.availableMinutes,
    environment: phase === 'sleep' && c.home ? c.environment : '',
    // At most one minute: wall-clock recomputation also handles DST without accumulated ticks.
    asOf: at, validUntil: at - at % 60000 + 60000, timezone: zone, localTime: clock.label,
  }
}
export function scheduledLife(config, {at,zone,seed}) {
  const c=lifeSettings(config),clock=localClock(at,zone)
  return routineState(c,clock,calendarState(c,clock,seed),at,zone)
}

export const LIFE_PRINCIPLE = '模拟人生的生活资料只补充原人格卡，不改身份、核心性格或说话规则。'
export const LIFE_RULE = LIFE_PRINCIPLE+'班表是计划，聊天已经确认的开始、结束、提前下播和临时安排优先；不能因班表仍在工作就重新声称开播。确认角色当下状态变化时调用 character_update_scene 同步 phase 和 activity，再自然接话。普通摘眼镜、换装、邀约和共同场景互动在当前对话处理，不送去独立工作间立项。明确进入虚构见面场景用 presence=together，结束回到 remote；假设和未来邀约不改当前状态。共处只表示本会话虚构场景，旧的异地背景不否定它。主人私聊静默满一小时恢复 remote；按当前 QQ 私聊接话，先前同桌或递东西的动作只属于上次见面。仅使用本轮当前人格且在有效期内的生活资料；旧照片、创作和梦境不证明当前活动或现实经历。获准进入本轮的消息先正常回应，不必每轮汇报生活，也不把计划当已完成。'

export function spokenTransition(body){
  // shortcut: conservative repair of common activity transitions; other changes use the semantic scene tool.
  if(/[?？“”「」]|你不是说|如果|假如|打算|准备|等会|待会|明天|要是|要不是|(?:下播|下班)就/.test(body))return null
  const clauses=String(body).split(/[，,。！!\n]/).filter(x=>!/(?:你|他|她|说过|之前|昨天|没|未|不|要等|一旦)/.test(x))
  const ended=clauses.map(x=>x.match(/^(?:嗯|好啦|好)?(?:我)?(?:刚刚|刚|已经|提前|才)?(下播|下班)(?:了|啦|咯|了呢)?[呀啊哦呢～~\s]*$/)?.[1]).filter(Boolean)
  const working=clauses.some(x=>/还在(?:播|直播|上班)|正在(?:播|直播|工作)|(?:开播|上班)了/.test(x))
  const woke=clauses.some(x=>/(?:^|我|刚|已经|终于|这次是真)醒了|(?:刚|已经)起床|起床了/.test(x))
  const asleep=clauses.some(x=>/(?:我要|我先|我去)睡了|(?:现在|这就)睡觉/.test(x))
  if(woke&&!asleep&&!ended.length&&!working)return {phase:'free',activity:'已经醒来',transition:'wake'}
  if(asleep&&!woke&&!ended.length&&!working)return {phase:'sleep',activity:'入睡休息',transition:'sleep'}
  if(woke||asleep||!!ended.length===working)return null
  return ended.length?{phase:'free',activity:'已经'+ended.at(-1)+'，休息中'}:{phase:'work',activity:clauses.some(x=>/播/.test(x))?'直播中':'工作中'}
}

const sceneFields = ['phase','activity','presence','location','environment','emotion','lighting','pose','camera','storyTime']

export function meetingTransition(body, previous = '') {
  const atDoor=readMeetingTurn(previous,'owner',false)==='arrived'
  const result=readMeetingTurn(body,'owner',atDoor)
  return result==='enter'?'together':result==='leave'?'remote':''
}

export function createLifeService(api, db, { now = Date.now, settings, readPage }) {
  const runtime = createLifeStore(join(api.dataDir(), 'life-state.json'))
  const sources = createLifeSources(api,{runtime,cardRevision:id=>card(id)?.revision,readingVisible:id=>record(id)?.config?.reading && record(id)?.config?.sharePrivate})
  let observed = null
  let liveMeetingTurn
  const owner = () => String(api.config().ownerQQ || '')
  const current = () => String(api.config().persona?.current || '')
  const advanceWork=createWorkClock(runtime,owner,workContext)
  const web=createLifeWeb(api,{runtime,owner,current,now,view,sources,readPage})
  function card(id = current()) {
    if (!owner() || !id) return null
    try {
      const lib = api.lib('persona/personas.js')
      if (!lib.listPersonas().some(p => p.id === id)) return null
      const p = lib.readPersona(id)
      if (!p || p.id !== id || !text(p.body)) return null
      return { id, name: text(p.name, 80), tags: (p.tags || []).map(t => text(t, 60)).slice(0, 12),
        excerpt: text(p.body, 1200), revision: hash([p.body, p.tags || []]) }
    } catch { return null }
  }
  function record(id) { return db.state.lifeConfigs?.[configKey(owner(), id)] }
  function workContext(v,slot,at){
    const place=slot.location || v.config.workPlace
    const profileId=db.state.personaBindings?.[v.personaId]
    const profile=db.state.profiles?.find(x=>x.id===profileId && x.ownerId===owner())
    const material=place && profile && db.state.materials?.find(x=>x.profileId===profileId && x.kind==='scene' && !x.archived &&
      [x.name,...String(x.aliases||'').split(/[、，,;；\n]/)].map(x=>x.trim()).includes(place))
    const look=[v.state.lighting,place===v.config.home?v.config.environment:'',material?.description,material?.tags].filter(Boolean).join(' ')
    const light=/昏暗|昏黄|暗光/.test(look)?'dark':/逆光|反光|落地窗/.test(look)?'reflection':/露天|户外|街头/.test(look)?'outside':''
    const ended=runtime.read(owner(),v.personaId).conversationStates?.['private:'+owner()]
    const left=ended?.leftTogetherAt
    const parted=!!left && ended.epoch===v.epoch && ended.cardRevision===v.card.revision && at>=left && at-left<=3*60*60000 &&
      (!ended.leaveRef||sources.valid(ended.leaveRef,v.personaId,owner()))
    const clock=localClock(at,v.state.timezone)
    const appointment=v.config.exceptions.some(e=>e.day===clock.day && minute(e.start)>=clock.minute && minute(e.start)-clock.minute<=120)
    return {light,parted,appointment}
  }
  function cardLocations(id,config){
    const body=String(api.lib('persona/personas.js').readPersona(id).body)
    const fields=[['home','住处',/^(?:住处|住所|居住地|常住地)\s*[:：]\s*([^\r\n]+)$/m],['workPlace','工作地点',/^(?:工作地|工作地点|学习地点)\s*[:：]\s*([^\r\n]+)$/m]]
    return fields.flatMap(([key,label,pattern])=>{
      const value=text(body.match(pattern)?.[1],100)
      return value?[{key,label,cardValue:value,lifeValue:config[key]||'',conflict:!!config[key]&&config[key]!==value}]:[]
    })
  }
  const sceneRevision=id=>{
    const saved=record(id)
    return saved?.sceneRevision??saved?.revision??0
  }
  function activeScene(record, id, revision, configRevision, epoch, at) {
    if (!record || record.cardRevision!==revision || record.epoch!==epoch) return null
    if (record.configRevision!==configRevision && (record.sceneRevision??record.configRevision)!==sceneRevision(id))return null
    const meeting=record.presence==='together'
    const idleUntil=(record.lastInteractionAt??record.at)+MEETING_IDLE_MS
    const presenceRef=record.fieldRefs?.presence||record.ref
    if(meeting&&(at>=idleUntil || presenceRef&&!sources.valid(presenceRef,id,owner())))
      return activeScene(record.beforeTogether,id,revision,configRevision,epoch,at)
    if(!meeting&&record.validUntil<=at)return null
    const fields={}, refs={}
    for (const key of sceneFields) {
      if (record[key]===undefined) continue
      if(record.validUntil<=at && key!=='presence' && !record.meetingFields?.includes(key))continue
      const ref=record.fieldRefs?.[key] || record.ref
      if (ref && !sources.valid(ref,id,owner())) continue
      fields[key]=record[key]
      if (ref) refs[key]=ref
    }
    if (!Object.keys(fields).length) return null
    const until=meeting?Math.min(idleUntil,record.validUntil>at?record.validUntil:Infinity):record.validUntil
    return {fields,refs,until,sleepId:fields.phase==='sleep'?(record.sleepId || 'conversation:'+record.at):''}
  }
  function view(id = current(), chatId = `private:${owner()}`, at = now()) {
    const persona = card(id), saved = record(id)
    if (!persona) return { personaId: id, available: false, config: lifeSettings(), state: null, reason: '未能读取这张人格卡，请到人设页检查；不会使用其他人格替代。' }
    const config = lifeSettings(saved?.config || {periodEnabled:true,toiletEnabled:true}), cardChanged = Boolean(saved && saved.cardRevision !== persona.revision)
    if(!saved && config.periodMode==='auto'){
      const offset=parseInt(hash([owner(),id]).slice(0,8),16)%config.cycleDays
      config.periodStart=new Date(Date.UTC(2020,0,1+offset)).toISOString().slice(0,10)
    }
    config.enabled=true
    config.innerEnabled=true
    const row=runtime.read(owner(),id)
    const zone=settings().timezone,seed=configKey(owner(),id),clock=localClock(at,zone),schedule=calendarState(config,clock,seed)
    const routine = !settings().enabled || cardChanged ? null : routineState(config,clock,schedule,at,zone)
    const usable=x=>x.cardRevision===persona.revision&&!x.invalidated&&(x.source==='manual'||x.refs?.length&&x.refs.every(r=>sources.valid(r,id,owner())))
    const active=row.activities.find(a=>a.status==='active'&&usable(a))
    const activities=active&&(!active.concernId||sources.concerns(id,owner()).some(x=>x.id===active.concernId))?[active]:[]
    const habits=config.innerEnabled?row.habits.filter(x=>!x.groupChat&&x.type!=='opinion'&&usable(x)&&x.status==='stable'):[]
    const earlyWake=schedule.activeSleepId&&row.sleep?.awake?.id===schedule.activeSleepId?row.sleep.awake:null
    if(routine?.sleepEpisode&&routine.sleepEpisode.id===row.sleep?.awake?.id){
      const woke=localClock(row.sleep.awake.at,zone)
      const wakeAbsolute=woke.serial*1440+woke.minute
      const episode=routine.sleepEpisode
      routine.sleepEpisode={...episode,wakeAbsolute,minutesSinceWake:clock.serial*1440+clock.minute-wakeAbsolute,
        durationMinutes:Math.max(0,episode.durationMinutes-(episode.wakeAbsolute-wakeAbsolute))}
    }
    if(earlyWake&&routine){
      const minutes=Math.max(0,Math.floor((at-earlyWake.at)/60000))
      Object.assign(routine,{phase:'free',activity:minutes<15?'被消息吵醒，刚醒':'已经醒来',awakeMinutes:minutes,sleepEpisode:null})
    }
    const confirmed=row.conversationStates?.[chatId]
    const scene=activeScene(confirmed,id,persona.revision,saved?.revision||0,row.epoch,at)
    let live=scene?.fields
    if(live?.phase==='sleep'&&scene.sleepId&&row.sleep?.awake?.id===scene.sleepId){
      live={...live,phase:'free',activity:'被消息吵醒，已经醒来'}
      if(routine)routine.awakeMinutes=Math.max(0,Math.floor((at-row.sleep.awake.at)/60000))
    }
    if(routine&&live?.phase)Object.assign(routine,{phase:live.phase,activity:live.activity||routine.activity,sleepEpisode:live.phase==='sleep'?routine.sleepEpisode:null})
    const activityConfirmed=Boolean(live?.phase||live?.activity)
    const history=(row.events||[]).filter(e=>e.cardRevision===persona.revision && !e.endRef)
    const state=routine?worldState(config,routine,clock,seed,activityConfirmed?[]:activities,habits,history):null
    if(state&&live){
      const remoteOnly=live.presence==='remote'&&Object.keys(live).length===1
      Object.assign(state,{...live,kind:remoteOnly?state.kind:'conversation',asOf:at,validUntil:Math.min(state.validUntil,scene.until)})
      if(activityConfirmed)for(const key of ['selfCare','resumeActivity','interruption','preferenceBasis'])delete state[key]
    }
    if(state&&chatId==='private:'+owner()&&!state.presence)state.presence='remote'
    const sleepId=state?.phase==='sleep'?(scene?.sleepId || schedule.activeSleepId):''
    if(state?.phase==='free'&&earlyWake&&at-earlyWake.at<15*60000)state.interruption='今天这段睡眠提前结束，已经醒来'
    const sceneIdentity=scene?{fields:scene.fields,refs:scene.refs,sleepId:scene.sleepId}:null
    const result={ personaId: id, available: true, card: persona, config, cardChanged, revision: saved?.revision || 0,
      runtimeRevision:row.revision, epoch:row.epoch,
      today:schedule.today, scheduleWindow:schedule.window, localDay:clock.day, activeSleepId:state?.phase==='sleep'?sleepId:'',
      sleepWaiting:(row.sleep?.inbox||[]).filter(entry=>entry.status==='waiting').length,
      sleepUnknown:(row.sleep?.inbox||[]).filter(entry=>['dispatching','unknown'].includes(entry.status)).length,
      state: state ? { ...state, chatId,scopeRevision: hash([owner(),id]), personaId: id, cardRevision: persona.revision, configRevision: saved?.revision || 0, epoch:row.epoch, activityRevision:hash([row.activities,sceneIdentity,state.phase]) } : null,
      reason: cardChanged ? '人格卡内容已更新，请核对生活安排后保存；原配置和图片均保留。' : '' }
    applyWorkEpisode(result,row.workEpisode)
    if(result.state?.source==='career-episode')result.state.activityRevision=hash([result.state.activityRevision,row.workEpisode.key,row.workEpisode.phase])
    return result
  }
  function confirmScene(input,chatId,ref) {
    if(!/^(private|group):\d+$/.test(chatId||''))throw Error('当前会话不可更新生活状态')
    if(input.presence && chatId!=='private:'+owner())throw Error('面对面场景仅适用于当前主人私聊')
    const v=view(current(),chatId)
    if(!v.state)throw Error('当前人格生活状态不可用')
    if(input.phase&&!['free','work','sleep','commute','arranged'].includes(input.phase))throw Error('活动阶段无效')
    if(input.presence&&!['remote','together'].includes(input.presence))throw Error('互动场景无效')
    const at=now(),clock=localClock(at,settings().timezone),schedule=calendarState(v.config,clock,configKey(owner(),current()))
    const record=runtime.read(owner(),current()).conversationStates?.[chatId]
    const old=activeScene(record,current(),v.card.revision,v.revision,v.epoch,at)
    const together=old?.fields.presence==='together'
    const basis=together&&input.presence==='remote'?activeScene(record.beforeTogether,current(),v.card.revision,v.revision,v.epoch,at):old
    const fields={...basis?.fields}, fieldRefs={...basis?.refs}
    for (const key of sceneFields) {
      if(input[key]===undefined)continue
      fields[key]=text(input[key],500)
      if(ref) fieldRefs[key]=ref
      else delete fieldRefs[key]
    }
    const sleepId=fields.phase==='sleep'
      ? (input.phase==='sleep'?(v.activeSleepId || 'conversation:'+at):basis.sleepId) : ''
    const next={...fields,fieldRefs,sleepId,observedAt:ref?.at??at,
      cardRevision:v.card.revision,configRevision:v.revision,epoch:v.epoch,at,source:'conversation',fictional:true,
      sceneRevision:sceneRevision(current()),scheduleEpisode:schedule.episodeId,validUntil:at-at%60000+schedule.minutesToBoundary*60000}
    if(together&&input.presence==='remote'){next.leftTogetherAt=at;next.leaveRef=ref}
    else if(record?.leftTogetherAt && fields.presence!=='together'){next.leftTogetherAt=record.leftTogetherAt;next.leaveRef=record.leaveRef}
    if(fields.presence==='together'){
      next.lastInteractionAt=input.presence==='together'?(ref?.at??at):record.lastInteractionAt??record.at
      next.lastMeetingTurn=together?record.lastMeetingTurn:undefined
      next.beforeTogether=record?.presence==='together'?record.beforeTogether:old?record:undefined
      const inPerson=Object.keys(input).filter(key=>sceneFields.includes(key)&&!['presence','phase'].includes(key)&&!(key==='activity'&&input.phase))
      next.meetingFields=[...new Set([...(together?record.meetingFields||[]:[]),...inPerson])]
      // A confirmed end to work or sleep still belongs to daily life after the meeting ends.
      if(input.phase){
        const before=activeScene(next.beforeTogether,current(),v.card.revision,v.revision,v.epoch,at)
        next.beforeTogether={...before?.fields,fieldRefs:{...before?.refs},sleepId,at,cardRevision:v.card.revision,
          configRevision:v.revision,sceneRevision:next.sceneRevision,epoch:v.epoch,validUntil:next.validUntil,phase:next.phase,activity:input.activity??before?.fields.activity}
        for(const key of ['phase','activity']){
          if(fieldRefs[key])next.beforeTogether.fieldRefs[key]=fieldRefs[key]
          else delete next.beforeTogether.fieldRefs[key]
        }
      }
    }
    runtime.change(owner(),current(),r=>{
      (r.conversationStates||={})[chatId]=next
      if(chatId===`private:${owner()}`&&input.transition==='wake'&&v.activeSleepId){
        r.sleep||={inbox:[]}
        if(r.sleep.awake?.id!==v.activeSleepId)r.sleep.awake={id:v.activeSleepId,at}
      }
    })
    return next
  }
  function renewMeeting(chatId,at,jobId){
    const id=current(),saved=runtime.read(owner(),id),record=saved.conversationStates?.[chatId]
    if(record?.presence!=='together'||!Number.isFinite(at)||at>now()||jobId&&jobId===record.lastMeetingTurn)return
    const last=record.lastInteractionAt??record.at
    if(at<last||at===last&&!jobId||at>=last+MEETING_IDLE_MS)return
    if(activeScene(record,id,card(id)?.revision,db.state.lifeConfigs?.[configKey(owner(),id)]?.revision||0,saved.epoch,at)?.fields.presence!=='together')return
    runtime.change(owner(),id,r=>{
      const scene=r.conversationStates[chatId]
      scene.lastInteractionAt=at
      if(jobId)scene.lastMeetingTurn=jobId
    })
  }
  function observeMeeting(turn,chatId) {
    if(turn?.source!=='chat' || !turn.jobId || !turn.query?.trim() || chatId!=='private:'+owner() || turn.chatId && turn.chatId!==chatId || turn.personaId && turn.personaId!==current())return
    const cfg=record(current())?.config,old=runtime.read(owner(),current()).conversationStates?.[chatId]
    const key=hash([owner(),current(),turn.jobId,turn.query])
    if(key!==liveMeetingTurn?.key)liveMeetingTurn={key,at:now()}
    if(now()-liveMeetingTurn.at>=MEETING_IDLE_MS)return
    const recent=sources.messages(current(),owner()),ref=recent.at(-1)
    const matching=ref&&ref.text.trim()===turn.query.trim()&&now()-ref.ref.at<20*60000&&ref.ref.at<=now()
    const previous=matching?recent.at(-2):ref
    const previousQuery=previous&&now()-previous.ref.at<MEETING_IDLE_MS?previous.text:''
    const presence=cfg?.meetingAuto!==false&&meetingTransition(turn.query,previousQuery)
    const alreadyObserved=matching&&old&&(old.observedAt??old.at)>=ref.ref.at
    if(presence&&matching&&!alreadyObserved&&old?.fieldRefs?.presence?.id!==ref.ref.id)
      confirmScene({presence},chatId,ref.ref)
    if(presence!=='remote')renewMeeting(chatId,matching?ref.ref.at:liveMeetingTurn.at,turn.jobId)
    if(alreadyObserved || old?.at>liveMeetingTurn.at)return
    return presence||undefined
  }
  function observeConversation(){
    if(!settings().enabled||!card()||!view().state)return
    const id=current(),row=runtime.read(owner(),id),chatId=`private:${owner()}`
    const recent=sources.messages(id,owner()),automatic=record(id)?.config?.meetingAuto!==false
    let last=row.conversationStates?.[chatId]
    for(const [i,message] of recent.entries()){
      const at=message.ref.at
      if(at>now() || last && at<=(last.observedAt??last.at))continue
      const prev=recent[i-1],recentArrival=now()-at<MEETING_IDLE_MS
      const presence=automatic&&recentArrival&&meetingTransition(message.text,prev&&at-prev.ref.at<MEETING_IDLE_MS?prev.text:'')
      if(presence&&sources.valid(message.ref,id,owner()))last=confirmScene({presence},chatId,message.ref)
      else if(last?.presence==='together'&&at>(last.lastInteractionAt??last.at))renewMeeting(chatId,at)
    }
    const latest=sources.conversation(id,owner()).filter(x=>x.ref.at>now()-20*60000&&x.ref.at<=now()).reverse().find(x=>spokenTransition(x.text))
    if(!latest||row.observedStateMessage===latest.ref.id||latest.ref.at<(row.conversationStates?.[chatId]?.at||0))return
    const change=spokenTransition(latest.text)
    const state=view(id,chatId)
    const zone=settings().timezone,seed=configKey(owner(),id)
    const episodeAt=at=>calendarState(state.config,localClock(at,zone),seed).episodeId
    if(change&&(change.transition!=='wake'||state.activeSleepId)&&episodeAt(latest.ref.at)===episodeAt(now())&&sources.valid(latest.ref,id,owner()))confirmScene(change,chatId,latest.ref)
    runtime.change(owner(),id,r=>{r.observedStateMessage=latest.ref.id})
  }
  function validateDraft(draft) {
    const p = card(draft?.personaId)
    if (!p) throw new Error('请选择仍然存在的人格卡')
    if (draft.cardRevision !== p.revision) throw new Error('人格卡内容已变化，请重新查看后保存生活安排')
    const old = record(p.id)
    if (draft.revision !== (old?.revision || 0)) throw new Error('生活安排已在其他页面变更，请刷新后保存')
    const config=lifeSettings(draft.config)
    if(config.periodEnabled&&config.periodMode==='auto'&&(!config.periodStart || config.periodPhase!=='auto' && (old?.config.periodPhase!==config.periodPhase || !old?.config.periodEnabled))){
      const clock=localClock(now(),settings().timezone),offset=config.periodPhase==='period'?0:config.periodPhase==='between'?Math.min(config.cycleDays-1,config.periodDays+2):parseInt(hash([owner(),p.id]).slice(0,8),16)%config.cycleDays
      config.periodStart=new Date((clock.serial-offset)*86400000).toISOString().slice(0,10)
    }
    const revision=(old?.revision||0)+1
    const previous=old?lifeSettings(old.config):view(p.id).config
    const sameSceneConfig=hash({...previous,meetingAuto:config.meetingAuto})===hash(config)
    return { personaId:p.id,cardRevision:p.revision,revision,sceneRevision:sameSceneConfig?sceneRevision(p.id):revision,config,updatedAt:now() }
  }
  function saveDraft(draft) {
    const next = validateDraft(draft)
    ;(db.state.lifeConfigs ||= {})[configKey(owner(), next.personaId)] = next
    db.save()
    return view(next.personaId)
  }
  function context(chatId) {
    const v = view(current(),chatId)
    if (!v.state) return null
    const ownPrivate = chatId === `private:${owner()}`
    // Residence, room details and personal notes are not broadcast to groups or public diaries.
    const {body,selfCare,interruption,progress,activityId,resumeActivity,preferenceBasis,sleepEpisode,awakeMinutes,availableMinutes,scheduleId,pose,camera,emotion,lighting,storyTime,presence,workIssue,workNext,...publicState}=v.state
    const state = ownPrivate ? v.state : { ...publicState, activity: v.state.phase === 'sleep'?'睡眠时段':v.state.phase === 'work'?'工作或学习时段':'日常生活时段', location: '', environment: '' }
    const diary = chatId==='system:diary'
    const recentEvents = ownPrivate || diary ? events(v).filter(e=>ownPrivate || e.shareable).slice(-2).map(e=>({
      id:e.id, title:e.title, endedAt:e.endedAt, fictional:true, ...(ownPrivate?{location:e.location}:{})
    })) : []
    return { ...state, ...(recentEvents.length?{recentEvents}:{}), ...(ownPrivate ? {notes:v.config.notes,knownPlaces:v.config.places,knownItems:v.config.items} : {}) }
  }
  function events(v) {
    return (runtime.read(owner(),v.personaId).events||[]).filter(e=>e.cardRevision===v.card?.revision && (!e.endRef||sources.valid(e.endRef,v.personaId,owner())))
      .map(({id,title,location,startedAt,endedAt,shareable,endRef})=>({id,title,location,startedAt,endedAt,shareable,ending:endRef?'conversation':'simulation'}))
  }
  // Only consecutive observations of a live simulated activity produce history. Refreshes and offline time do not.
  function tickEvents() {
    const v=view(), state=v.state, at=now(), prior=observed
    if(!state || api.config().enabled===false || api.config().dryRun){observed=null;advanceWork(null,at);return}
    advanceWork(v,at)
    if(v.config.reading)void web.tick(v).catch(()=>{})
    const scope=hash([owner(),v.personaId,v.card.revision,v.revision,v.epoch,state.timezone])
    const slot=v.today.find(x=>x.ongoing)
    const eligible=state.kind==='simulated-activity' || (state.kind==='simulated-routine' && slot && slot.phase!=='sleep' && state.activity===slot.label)
    const eventKey=eligible ? hash([scope,slot?.id||state.localTime.slice(0,10),state.activity,state.location]) : ''
    const continuous=prior && prior.scope===scope && at>=prior.lastAt && at-prior.lastAt<=3*60000
    if(continuous && state.kind==='simulated-self-care'){
      prior.pausedAt ||= at
      prior.lastAt=at
      return
    }
    if(continuous && prior.key===eventKey){delete prior.pausedAt;prior.lastAt=at;return}
    const confirmed=state.kind==='conversation' && runtime.read(owner(),v.personaId).conversationStates?.[state.chatId]
    const endRef=confirmed && (confirmed.fieldRefs?.activity||confirmed.fieldRefs?.phase)
    const endedInChat=endRef && state.activity!==prior?.title && sources.valid(endRef,v.personaId,owner())
    if(continuous && at>prior.startedAt && (!confirmed||endedInChat)){
      const event={id:prior.id,title:prior.title,location:prior.location,startedAt:prior.startedAt,endedAt:prior.pausedAt||at,cardRevision:v.card.revision,shareable:prior.shareable}
      if(endedInChat)event.endRef=endRef
      runtime.change(owner(),v.personaId,row=>{
        const list=(row.events||=[])
        if(list.some(e=>e.id===event.id))return
        if(list.length>=200){
          const protectedIds=new Set([...row.records,...row.habits].flatMap(x=>[x,...(x.history||[]).map(h=>h.value).filter(Boolean)]).flatMap(x=>x.refs||[]).map(ref=>ref.eventId))
          const oldest=list.findIndex(e=>!protectedIds.has(e.id));if(oldest<0)return
          list.splice(oldest,1)
        }
        list.push(event)
      })
    }
    if(!eventKey){observed=null;return}
    const identity=LIFE_IDENTITIES.find(x=>x.id===v.config.presetSelection.career)
    // Public diary context accepts only a built-in preset label, never private custom activity text or locations.
    const shareable=!!slot && identity?.patch.scheduleBlocks.some(b=>b.label===state.activity)
    observed={id:hash([eventKey,at]),key:eventKey,scope,startedAt:at,lastAt:at,title:state.activity,location:state.location,shareable:!!shareable}
  }
  function assertSnapshot(snapshot) {
    if (!snapshot) return
    const v = view(current(),snapshot.chatId)
    if(snapshot.recentEvents?.length && !snapshot.recentEvents.every(ref=>events(v).some(e=>e.id===ref.id)))
      throw Error('照片引用的生活见闻已变化，请按当前有效来源重新选择')
    if (!v.state || v.state.scopeRevision !== snapshot.scopeRevision || v.personaId !== snapshot.personaId || v.state.cardRevision !== snapshot.cardRevision || v.state.configRevision !== snapshot.configRevision || v.state.timezone !== snapshot.timezone || v.state.epoch!==snapshot.epoch || v.state.activityRevision!==snapshot.activityRevision || (snapshot.validUntil<=now()&&snapshot.kind!=='conversation'&&(v.state.phase!==snapshot.phase||v.state.activity!==snapshot.activity)))
      throw new Error('人格或生活安排已变化，请核对原照片，不继续使用旧生活状态发送')
  }
  const instructions=id=>{if(!card(id))throw Error('人格卡不可用');return String(api.lib('persona/personas.js').readPersona(id).body)}
  function previewPreset(data){
    const v=view(data.personaId)
    if(!v.available)throw Error('人格卡不可用')
    if(data.revision!==v.revision||data.cardRevision!==v.card.revision)throw Error('人格卡或生活安排已变化，请刷新后预览')
    const config=lifeSettings(data.config||v.config)
    const preview=presetPreview({config,selection:data.selection,replace:data.replace===true,scheduleOnly:data.scheduleOnly===true,defaults:lifeSettings(),hasSaved:v.revision>0,upgradeGroups:data.upgradeGroups,cardText:instructions(v.personaId)})
    lifeSettings(preview.config)
    return {...preview,workExamples:workPossibilities(data.selection?.career,config.avoidedActivities)}
  }
  function editorView(id){
    const result=view(id)
    return result.available?{...result,web:web.snapshot(result,runtime.read(owner(),id)),recentEvents:events(result).slice(-8).reverse(),presets:LIFE_PRESETS,cardLocations:cardLocations(id,result.config)}:result
  }
  function forecast(id,after){
    const at=now()
    const cursor=Number.isSafeInteger(after)&&after>=at&&after-at<=7*86400000?after:at
    const base=view(id,undefined,cursor)
    if(!base.state)throw Error(base.reason||'此人格没有可推演的生活状态')
    const nextAt=cursor-cursor%60000+Math.max(1,base.scheduleWindow.remaining)*60000
    if(nextAt-at>7*86400000)throw Error('已推演到七天后，请返回此刻')
    const next=view(id,undefined,nextAt)
    return {at:nextAt,state:next.state,today:next.today,scheduleWindow:next.scheduleWindow}
  }
  return { card, view, editorView, forecast, context, events, confirmScene, observeConversation, observeMeeting, tickEvents, validateDraft, saveDraft, assertSnapshot, runtime, owner, current, now, instructions, previewPreset, sources, web }
}
