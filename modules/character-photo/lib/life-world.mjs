import { createHash } from 'node:crypto'
import { text } from './store.mjs'

export const WORLD_DEFAULTS = Object.freeze({
  bodyEnabled:true, periodEnabled:false, periodStart:'', periodDays:5, cycleDays:28, periodFeeling:'无明显不适',
  periodMode:'auto', periodPhase:'auto',
  toiletEnabled:false, detailLevel:'discreet', sleepReply:'natural', sleepWakeChance:15,
  places:[], rooms:[], sceneBindings:{}, customIdentity:'', autonomy:true, items:[], interests:[], avoidedActivities:[], exceptions:[], meetingAuto:true,
  innerEnabled:true, automaticInner:false, dreams:true, privateDiary:true, growth:true,
  reflectionHour:'21:00', dailyReflections:2, dailyInputChars:18000, contextChars:2200,
  dreamFrequency:'occasional',dreamStyle:'daily',dreamLength:'short',diaryStyle:'brief',growthMode:'careful',
})
const number=(v,min,max,name)=>{if(!Number.isInteger(v)||v<min||v>max)throw Error(`${name}应为${min}至${max}的整数`);return v}
export const timeMinute=s=>{if(typeof s!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('时间请使用 HH:mm');return +s.slice(0,2)*60 + +s.slice(3)}
export function dateSerial(s){const n=Date.parse(String(s)+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==s)throw Error('请选择有效日期');return n/86400000}
const list=(raw,max,name)=>{if(!Array.isArray(raw)||raw.length>max)throw Error(`${name}最多${max}项`);return raw}
export function worldSettings(raw={}) {
  const c=Object.fromEntries(Object.entries(WORLD_DEFAULTS).map(([k,v])=>[k,raw[k]??structuredClone(v)]))
  for(const k of ['bodyEnabled','periodEnabled','toiletEnabled','innerEnabled','automaticInner','dreams','privateDiary','growth','meetingAuto','autonomy'])if(typeof c[k]!=='boolean')throw Error('生活功能开关格式无效')
  if(!['discreet','direct'].includes(c.detailLevel)||!['natural','brief','after-wake'].includes(c.sleepReply))throw Error('请选择有效的生活表达方式')
  number(c.sleepWakeChance,0,100,'被消息吵醒概率')
  number(c.periodDays,1,10,'经期天数');number(c.cycleDays,15,60,'周期天数')
  if(c.periodDays>=c.cycleDays)throw Error('经期天数应少于周期天数')
  c.periodStart=text(c.periodStart,40);if(c.periodStart)dateSerial(c.periodStart)
  if(raw.periodMode===undefined&&raw.periodStart)c.periodMode='custom'
  if(!['auto','custom'].includes(c.periodMode)||!['auto','period','between'].includes(c.periodPhase))throw Error('请选择有效的周期安排')
  if(c.periodEnabled&&c.periodMode==='custom'&&!c.periodStart)throw Error('自定义周期需要填写起始日期，也可以选择自动安排')
  for(const [key,options] of Object.entries({dreamFrequency:['occasional','often'],dreamStyle:['daily','surreal','free'],dreamLength:['short','medium'],diaryStyle:['brief','regular','reflective'],growthMode:['fixed','careful','natural']}))if(!options.includes(c[key]))throw Error('请选择有效的内在记录偏好')
  c.periodFeeling=text(c.periodFeeling,100)
  number(c.dailyReflections,0,6,'每日整理次数');number(c.dailyInputChars,1000,60000,'每日整理文字额度');number(c.contextChars,800,4000,'生活上下文长度')
  timeMinute(c.reflectionHour)
  for(const k of ['rooms','places','items','interests','avoidedActivities'])c[k]=[...new Set(list(c[k],12,k).map(v=>text(v,80)).filter(Boolean))]
  c.customIdentity=text(c.customIdentity,60)
  if(typeof c.sceneBindings!=='object'||Array.isArray(c.sceneBindings)||Object.keys(c.sceneBindings).length>64)throw Error('地点关联最多可设置 64 项')
  c.sceneBindings=Object.fromEntries(Object.entries(c.sceneBindings).filter(([k,v])=>typeof v==='string'&&text(k,100)&&text(v,100)).map(([k,v])=>[text(k,100),text(v,100)]))
  c.exceptions=list(c.exceptions,12,'临时安排').map((x,i)=>{
    if(!x||typeof x!=='object')throw Error('临时安排格式无效')
    dateSerial(x.day);const start=timeMinute(x.start),end=timeMinute(x.end)
    if(start===end)throw Error('临时安排开始与结束时间不能相同')
    const label=text(x.label,80);if(!label)throw Error('临时安排需要填写活动')
    return {id:text(x.id,80)||`schedule-${i}`,day:x.day,start:x.start,end:x.end,label,location:text(x.location,100)}
  })
  const spans=c.exceptions.map(x=>{const start=dateSerial(x.day)*1440+timeMinute(x.start);return [start,start+(timeMinute(x.end)-timeMinute(x.start)+1440)%1440]})
  for(let i=0;i<spans.length;i++)for(let j=i+1;j<spans.length;j++)if(spans[i][0]<spans[j][1]&&spans[j][0]<spans[i][1])throw Error('临时安排有时间重叠，请保留一种安排')
  return c
}
const pick=(seed,items)=>items[parseInt(createHash('sha256').update(seed).digest('hex').slice(0,8),16)%items.length]
const since=(value,start)=>(value-start+1440)%1440

/** Fictional needs and self-care follow a repeatable local-day rhythm, not a medical model. */
export function worldState(c,base,clock,seed,activities=[],habits=[],history=[]) {
  const result={...base},minute=clock.minute,absolute=clock.serial*1440+minute
  const exception=c.exceptions.find(x=>{const from=dateSerial(x.day)*1440+timeMinute(x.start);return absolute>=from&&absolute<from+(timeMinute(x.end)-timeMinute(x.start)+1440)%1440})
  if(exception)Object.assign(result,{phase:'arranged',activity:exception.label,location:exception.location,environment:'',source:'explicit-schedule',scheduleId:exception.id})
  const elapsed=Math.max(0,base.awakeMinutes??since(minute,timeMinute(c.wakeTime))),awake=result.phase!=='sleep'
  const needs={}
  let care=null
  if(c.bodyEnabled){
    const awakeHours=elapsed/60
    needs.energy=!awake?'正在休息':awakeHours<11?'精力尚可':awakeHours<15?'有些疲倦':'困倦，想休息'
    const mealAge=elapsed<45?elapsed+240:(elapsed-45)%330
    needs.hunger=!awake?'休息中':mealAge<40?'刚吃过东西':mealAge>265?'有些饿了':'暂时不饿'
    needs.thirst=!awake?'休息中':elapsed%120>95?'有点口渴':'暂时不渴'
    if(awake&&elapsed>=45&&(elapsed-45)%330<18)care={type:'eat',label:'吃点东西',stage:'in-progress',until:18-(elapsed-45)%330}
    else if(awake&&elapsed%120<4)care={type:'drink',label:'喝水',stage:'in-progress',until:4-elapsed%120}
  }
  if(c.toiletEnabled&&awake){
    const pee=elapsed%210,poop=since(elapsed,70)
    needs.toilet=pee>=180&&pee<190?'有些尿意':poop>1420?'有些便意':'暂无明显需要'
    if(poop<8)care={type:'toilet',detail:'排便',label:'上洗手间',stage:'in-progress',until:8-poop}
    else if(pee>=190&&pee<195)care={type:'toilet',detail:'排尿',label:'上洗手间',stage:'in-progress',until:195-pee}
    else if((poop>=8&&poop<13)||(pee>=195&&pee<198))care={type:'toilet',label:'刚从洗手间回来',stage:'returned',until:poop>=8&&poop<13?13-poop:198-pee}
  }
  if(c.periodEnabled&&c.periodStart){
    const day=clock.serial-dateSerial(c.periodStart)
    const cycleDay=day<0?null:day%c.cycleDays+1
    needs.period={active:cycleDay!==null&&cycleDay<=c.periodDays,cycleDay,
      feeling:cycleDay!==null&&cycleDay<=c.periodDays?c.periodFeeling:'',source:'configured-fictional-cycle'}
  }
  if(Object.keys(needs).length)result.body={...needs,source:'simulated-self-care',detailLevel:c.detailLevel}
  if(care)result.selfCare={...care,source:'simulated-self-care',fictional:true}
  const active=activities.filter(a=>a.status==='active').sort((a,b)=>b.updatedAt-a.updatedAt)[0]
  const validLocation=active&&(!active.location||active.location===c.home||c.places.includes(active.location))
  const fitsWindow=(result.availableMinutes??1440)>=10
  if(active&&(result.phase!=='free'||!validLocation||!fitsWindow)){
    result.resumeActivity=active.title;result.interruption='当前有已安排时段，持续事项留待空闲继续'
    if(result.phase==='free')result.interruption=validLocation?'临近下一段日程，持续事项留待空闲继续':'当前生活空间未包含该地点，持续事项先保留'
  }
  if(care&&awake&&result.phase==='free'&&!base.plannedActivity&&care.stage==='in-progress'&&(!validLocation||care.type!=='drink')){
    result.resumeActivity=validLocation?active.title:result.activity
    result.activity=care.label;result.kind='simulated-self-care';result.source='simulated-self-care'
    result.location=c.home;result.environment=c.home?c.environment:''
  }else if(validLocation&&fitsWindow&&result.phase==='free'&&!base.plannedActivity){
    Object.assign(result,{activity:active.title,location:active.location||result.location,activityId:active.id,kind:'confirmed-activity',source:active.source,progress:active.progress||''})
    if(care?.stage==='returned')result.interruption=care.label
  }else if(c.autonomy&&result.phase==='free'&&!base.plannedActivity){
    const candidates=(c.interests.length?c.interests:['看书','散步','听音乐']).map(title=>({title,weight:1}))
    const negatives=/(?:不喜欢|讨厌|避免|回避|不再|不想再)\s*(.+)/
    const exclusions=(c.avoidedActivities||[]).map(x=>x.match(negatives)?.[1]||x)
    for(const habit of habits){
      const clauses=(habit.title+'。'+habit.body).split(/[，,；;。！？\n]|但是|但也|但/)
      const positive=clauses.filter(line=>!negatives.test(line)).join(' ')
      for(const clause of clauses)if(negatives.test(clause))exclusions.push(clause.match(negatives)[1])
      for(const x of candidates)if(positive.includes(x.title))x.weight+=2
      for(const title of ['看书','阅读','散步','听音乐','画画','写作','伸展运动','练琴'])
        if(positive.includes(title)&&!candidates.some(x=>x.title===title))candidates.push({title,weight:2})
    }
    const outdoors=title=>/散步|跑步|外出|咖啡馆|游泳|海边|逛街|逛展|公园/.test(title)
    const possible=candidates.filter(x=>{
      if(exclusions.some(word=>x.title.includes(word)||word.includes(x.title)))return false
      if(/跑步|健身|运动/.test(x.title)&&elapsed>15*60)return false
      return (result.availableMinutes??1440)>=(outdoors(x.title)?30:10)
    })
    // Keep this choice stable when a previous activity is filed during the current window.
    const windowStart=base.asOf-base.asOf%60000-elapsed%180*60000
    const recent=new Set(history.filter(e=>e.endedAt<windowStart && windowStart-e.endedAt<=24*3600000).slice(-2).map(e=>e.title))
    const fresh=possible.filter(x=>!recent.has(x.title))
    const options=(fresh.length?fresh:possible).flatMap(x=>Array(x.weight).fill(x.title)).concat('自由休息')
    result.activity=pick(seed+clock.day+Math.floor(elapsed/180),options)
    const outside=outdoors(result.activity)
    const destinations=[[/游泳|下水/,/泳池|游泳馆|海滩/,'泳池'],[/海边/,/海边|沙滩|海滩/,'海边'],[/咖啡/,/咖啡/,'咖啡馆'],[/逛展/,/展馆|美术馆/,'展馆'],[/逛街/,/街区|商场/,'附近街区']]
    const [,match,place]=destinations.find(([action])=>action.test(result.activity)) || [null,/公园|户外|附近/,'附近']
    result.location=outside?(c.places.find(p=>match.test(p))||place):c.home
    result.environment=!outside&&c.home?c.environment:''
    if(habits.length)result.preferenceBasis='已确认偏好参与候选选择'
    result.kind='simulated-activity';result.source='configured-interests'
  }
  result.sleepReply=c.sleepReply
  return result
}
