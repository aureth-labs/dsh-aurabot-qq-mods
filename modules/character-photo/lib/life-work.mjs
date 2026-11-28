import {createHash} from 'node:crypto'
import scenes from './life-work-scenes.cjs'
import {timeMinute} from './life-world.mjs'

const minute=60_000
const roll=key=>createHash('sha256').update(key).digest().readUInt32BE(0)
const scopeOf=v=>JSON.stringify([v.state.scopeRevision,v.card.revision,v.epoch,v.config.presetSelection.career])

export function workPossibilities(career,avoided=[],variants=[['routine','','']],short=false){
  if(!Object.hasOwn(scenes,career))return []
  const {subjects,situations}=scenes[career]
  const avoid=avoided.map(x=>x.replace(/^(不再|避免|回避|讨厌|不喜欢)\s*/, '')).filter(Boolean)
  return situations.flatMap((lines,i)=>subjects.flatMap((subject,j)=>variants.map(([kind,prefix,resume])=>{
    const fill=n=>lines[n].replaceAll('@',subject)
    return {key:i+'-'+j+'-'+kind,worry:fill(0),action:prefix+fill(short?3:1),follow:resume+fill(short?4:2)}
  }))).filter(x=>!avoid.some(word=>(x.worry+x.action+x.follow).includes(word)))
}

function eligible(v){
  return v.config.workIncidents && Object.hasOwn(scenes,v.config.presetSelection.career)
    && v.state?.phase==='work' && ['simulated-routine','simulated-activity'].includes(v.state.kind)
    && !v.state.selfCare && v.state.presence!=='together'
}

function stageFor(item,day){
  if(item.phase==='respond')return 'respond'
  if(item.phase==='follow' && item.day<day)return 'follow'
  return ''
}

export function applyWorkEpisode(v,item){
  if(!item || !eligible(v) || item.scope!==scopeOf(v))return
  const stage=stageFor(item,v.localDay)
  if(!stage)return
  Object.assign(v.state,{kind:'simulated-activity',activity:stage==='respond'?item.action:item.follow,
    workIssue:item.worry,workNext:stage==='respond'?item.follow:'',source:'career-episode'})
}

// Views can be opened arbitrarily often. Only two consecutive live heartbeats can advance a saved step.
export function createWorkClock(store,owner,contextFor=()=>({})){
  let last=null,elapsed=0
  return function observe(v,at){
    if(!v?.state || !eligible(v)){last=null;elapsed=0;return}
    const scope=scopeOf(v), slot=v.today.find(b=>b.ongoing && b.phase==='work')
    if(!slot){last=null;elapsed=0;return}
    const session=JSON.stringify([scope,v.revision,slot.id,v.localDay])
    const gap=last?.session===session?at-last.at:Infinity
    if(gap<0 || gap>90_000)elapsed=0
    else elapsed+=gap
    last={session,at}
    if(elapsed<5*minute)return
    elapsed-=5*minute
    const persona=v.personaId,day=v.localDay,box=store.read(owner(),persona).workEpisode
    const item=box?.scope===scope?box:null
    const stage=item&&stageFor(item,day)
    if(stage){
      store.change(owner(),persona,row=>{
        const work=row.workEpisode
        work.minutes+=5
        if(work.minutes>=(stage==='respond'?15:10)){
          work.phase=stage==='respond'?'follow':'done'
          work.day=day
          work.minutes=0
        }
      })
      return
    }
    if((item && (item.phase!=='done' || item.day>=day)) || roll(scope+day)%3!==0)return
    const context=contextFor(v,slot,at)
    const untilEnd=(timeMinute(slot.end)-timeMinute(v.state.localTime.slice(-5))+1440)%1440
    const short=untilEnd<45 || context.appointment || roll(scope+day+'pace')%3===0
    const variants=[]
    if(context.appointment)variants.push(['appointment','先留十分钟给下一段安排，','先查上次留下的标记，'])
    if(context.parted)variants.push(['return','重新坐回工作台，先理清做到哪一步，','下次开工时照着收尾清单，'])
    if(context.light==='reflection')variants.push(['reflection','换个不反光的位置，','先在原来的光线下复看一遍，'])
    if(context.light==='dark')variants.push(['dark','把手上的东西挪到亮处，','换到明亮处再复查一次，'])
    if(context.light==='outside')variants.push(['outside','找一个避开人流的位置，','等周围安静下来，'])
    if(!variants.length)variants.push(['routine','',''])
    const options=workPossibilities(v.config.presetSelection.career,v.config.avoidedActivities,variants,short)
    if(!options.length)return
    const recent=item?.recentKeys || (item?[item.key]:[])
    const fresh=options.filter(x=>!recent.includes(x.key))
    const candidates=fresh.length?fresh:options.filter(x=>x.key!==item?.key)
    const pool=candidates.length?candidates:options
    const choice=pool[roll(day+scope+slot.id+JSON.stringify(context))%pool.length]
    store.change(owner(),persona,row=>{row.workEpisode={...choice,scope,day,phase:'respond',minutes:0,recentKeys:[...recent.slice(-4),choice.key]}})
  }
}
