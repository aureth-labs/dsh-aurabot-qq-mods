import { createHash } from 'node:crypto'

const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,16)
const minute=s=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s||''))throw Error('日程时间请使用 HH:mm');return Number(s.slice(0,2))*60+Number(s.slice(3))}
const span=(a,b)=>(minute(b)-minute(a)+1440)%1440
export const CALENDAR_DEFAULTS=Object.freeze({scheduleMode:'basic',scheduleAnchor:'2026-01-05',rotationDays:4,scheduleBlocks:[],presetSelection:{},presetVersion:0})
export function calendarSettings(raw={}){
  const c=Object.fromEntries(Object.entries(CALENDAR_DEFAULTS).map(([k,v])=>[k,raw[k]??structuredClone(v)]))
  if(!['basic','weekly','rotation'].includes(c.scheduleMode))throw Error('请选择有效的日程方式')
  if(!Number.isInteger(c.rotationDays)||c.rotationDays<2||c.rotationDays>28)throw Error('轮班周期应为2至28天')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(c.scheduleAnchor)||!Number.isFinite(Date.parse(c.scheduleAnchor+'T00:00Z'))||new Date(c.scheduleAnchor+'T00:00Z').toISOString().slice(0,10)!==c.scheduleAnchor)throw Error('轮班起点日期无效')
  if(!Array.isArray(c.scheduleBlocks)||c.scheduleBlocks.length>48)throw Error('日程最多48个时段')
  const cycle=c.scheduleMode==='rotation'?c.rotationDays:c.scheduleMode==='weekly'?7:28
  c.scheduleBlocks=c.scheduleBlocks.map((x,i)=>{
    if(!x||!['sleep','work','commute','free'].includes(x.phase)||!Array.isArray(x.days)||!x.days.length||x.days.some(d=>!Number.isInteger(d)||d<0||d>=cycle))throw Error('请为日程选择时段类型和有效日期')
    if(!span(x.start,x.end))throw Error('日程开始和结束不能相同')
    return {id:String(x.id||'block-'+i).slice(0,80),phase:x.phase,days:[...new Set(x.days)],start:x.start,end:x.end,label:String(x.label||({sleep:'睡眠',work:'工作或学习',commute:'通勤',free:'自由安排'}[x.phase])).slice(0,80),location:String(x.location||'').slice(0,100)}
  })
  if(c.scheduleMode!=='basic'){
    if(!c.scheduleBlocks.some(x=>x.phase==='sleep'))throw Error('日程需要至少一个睡眠时段')
    const flex=raw.mode==='flexible'?Number(raw.flexMinutes||0):0
    const spans=c.scheduleBlocks.flatMap(b=>b.days.flatMap(day=>[0,1].map(round=>{
      const start=(day+round*cycle)*1440+minute(b.start), margin=b.phase==='sleep'?flex:0
      return {start:start-margin,end:start+span(b.start,b.end)+margin}
    }))).sort((a,b)=>a.start-b.start)
    for(let i=1;i<spans.length;i++){
      if(spans[i].start<spans[i-1].end)throw Error('日程时段有重叠，请调整班次、通勤或睡眠浮动')
    }
  }
  c.presetSelection=Object.fromEntries(['career','temperament','lifestyle'].map(k=>[k,String(c.presetSelection?.[k]||'').slice(0,60)]))
  c.presetVersion=Number.isInteger(c.presetVersion)?c.presetVersion:0
  return c
}
export function calendarState(c,clock,seed){
  const basic=c.scheduleMode==='basic'
  const blocks=basic?[{id:'sleep',phase:'sleep',days:[0,1,2,3,4,5,6],start:c.sleepStart,end:c.wakeTime,label:'睡眠时段',location:c.home},...(c.workEnabled?[{id:'work',phase:'work',days:c.workDays,start:c.workStart,end:c.workEnd,label:c.workLabel,location:c.workPlace}]:[])]:c.scheduleBlocks
  const cycle=c.scheduleMode==='rotation'?c.rotationDays:7,origin=Date.parse(c.scheduleAnchor+'T00:00Z')/86400000
  const absolute=clock.serial*1440+clock.minute,events=[]
  for(let day=clock.serial-Math.max(8,cycle+1);day<=clock.serial+1;day++){
    const dayIndex=c.scheduleMode==='rotation'?((day-origin)%cycle+cycle)%cycle:new Date(day*86400000).getUTCDay()
    const dayText=new Date(day*86400000).toISOString().slice(0,10)
    for(const b of blocks)if(b.days.includes(dayIndex)){
      const spread=c.mode==='flexible'&&b.phase==='sleep'?c.flexMinutes:0
      const offset=spread?parseInt(hash(JSON.stringify([seed,dayText])).slice(0,8),16)%(spread*2+1)-spread:0
      const start=day*1440+minute(b.start)+offset,end=start+span(b.start,b.end)
      events.push({...b,startAbsolute:start,endAbsolute:end,id:hash(JSON.stringify([seed,day,b.id,start,end])),location:b.location||(b.phase==='sleep'?c.home:b.phase==='work'?c.workPlace:'')})
    }
  }
  // A temporary arrangement that interrupts sleep makes that episode unsuitable for automatic dream claims.
  const exceptions=(c.exceptions||[]).map(x=>{const start=Date.parse(x.day+'T00:00Z')/86400000*1440+minute(x.start);return {...x,startAbsolute:start,endAbsolute:start+span(x.start,x.end),phase:'arranged'}})
  const interrupted=e=>exceptions.some(x=>x.startAbsolute<e.endAbsolute&&x.endAbsolute>e.startAbsolute)
  const current=events.find(e=>absolute>=e.startAbsolute&&absolute<e.endAbsolute)
  const previousSleep=events.filter(e=>e.phase==='sleep'&&e.endAbsolute<=absolute).sort((a,b)=>b.endAbsolute-a.endAbsolute)[0]
  const episode=previousSleep&&!interrupted(previousSleep)?{id:previousSleep.id,ended:true,wakeAbsolute:previousSleep.endAbsolute,minutesSinceWake:absolute-previousSleep.endAbsolute,durationMinutes:previousSleep.endAbsolute-previousSleep.startAbsolute}:null
  const localTime=n=>{const m=(n%1440+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`}
  const nextBusy=[...events,...exceptions].filter(e=>e.startAbsolute>absolute&&(e.phase!=='free')).reduce((next,event)=>Math.min(next,event.startAbsolute),absolute+1440)
  const explicit=exceptions.find(e=>absolute>=e.startAbsolute&&absolute<e.endAbsolute)
  const today=[...events,...exceptions].filter(e=>e.startAbsolute<(clock.serial+1)*1440&&e.endAbsolute>clock.serial*1440).sort((a,b)=>a.startAbsolute-b.startAbsolute)
    .map(e=>({id:e.id,phase:e.phase,label:e.label,start:localTime(e.startAbsolute),end:localTime(e.endAbsolute),location:e.location,
      dayOffset:Math.floor(e.startAbsolute/1440)-clock.serial,overnight:Math.floor(e.endAbsolute/1440)>Math.floor(e.startAbsolute/1440),ongoing:e===(explicit||current)}))
  const boundary=explicit||current
  const nextStart=Math.min(...[...events,...exceptions].filter(e=>e.startAbsolute>absolute).map(e=>e.startAbsolute))
  const end=Math.min(boundary?.endAbsolute??Infinity,Number.isFinite(nextStart)?nextStart:absolute+1440)
  const previous=Math.max(...[...events,...exceptions].filter(e=>e.endAbsolute<=absolute).map(e=>e.endAbsolute))
  const start=boundary?.startAbsolute??(Number.isFinite(previous)?previous:absolute)
  const window={start:localTime(start),end:localTime(end),elapsed:absolute-start,remaining:end-absolute}
  return {phase:current?.phase||'free',activity:current?.label||'自由安排',location:current?.location||'',sleepEpisode:episode,plannedActivity:!!current,
    window,episodeId:boundary?.id||`free:${clock.day}:${nextBusy}`,minutesToBoundary:Math.max(1,(boundary?.endAbsolute||nextBusy)-absolute),
    activeSleepId:current?.phase==='sleep'?current.id:'',
    awakeMinutes:previousSleep?absolute-previousSleep.endAbsolute:null,availableMinutes:nextBusy-absolute,today}
}
