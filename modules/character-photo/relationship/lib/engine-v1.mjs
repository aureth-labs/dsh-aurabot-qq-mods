import {clone,clamp,round,dayKey,stageOf,arousalValue} from './policy.mjs'
export const RULE_VERSION='relation-v1-1'
const HOUR=3600000,DAY=24*HOUR

/** Deterministic candidate rules. No IO, model calls or external mood writes. */
export function reduceRound(previous,config,{events,sources,at,scope='owner-private',optionalActive=false,confirmedStatus,optionalCompleted=false,resolvedIncidents=[]}) {
 const state=clone(previous),before=clone(previous),rules=config.rules,day=dayKey(at,config.timezone)
 const result={version:RULE_VERSION,at,day,beforeScore:before.score,beforeStage:before.stage,positive:0,negative:0,mood:0,arousal:0,stageCorrection:0,notes:[],events:[]}
 if(scope!=='owner-private'){
  if(!['other-private','public'].includes(scope))return {state,result:{...result,notes:['outside-owner-private'],afterScore:state.score,afterStage:state.stage}}
  const factor=config.domainMood?.[scope==='public'?'group':'otherPrivate']??0
  for(const e of events){if(!e.qualified||['flat','uncertain'].includes(e.state)||(e.confidence??1)<rules.eventMinConfidence)continue
   const values=e.category==='relationship-damage'?rules.damageValues[Math.max(0,e.severity-1)]:rules.eventValues[e.category];if(!values)continue
   result.mood+=values.mood*factor
  }
  result.mood=round(clamp(result.mood,-rules.turnMood,rules.turnMood));state.revision++
  return {state,result:{...result,notes:['mood-only:'+scope],afterScore:state.score,afterStage:state.stage}}
 }
 if(!Number.isFinite(at)||at<(state.lastEventAt||0))throw Error('事件时间早于已结算事件，请按来源顺序回放')
 state.daily=state.daily||{};state.repeats=state.repeats||[];state.incidents=state.incidents||[];state.milestones=state.milestones||[]
 state.repeats=state.repeats.filter(x=>at-x.at<rules.repeatHours*HOUR)
 state.incidents=state.incidents.filter(x=>at-x.at<rules.damageWindowHours*HOUR)
 let positive=0,negative=0,mood=0,arousal=0,hasDamage=false,demotion=false,repair=false
 const damageKeys=new Set()
 const sharedIds=new Set(sources.map(s=>s.sourceId))
 for(const e of events){
  const item={category:e.category,label:e.label,evidence:e.evidence,factKey:e.factKey,accepted:e.qualified,reason:e.reasons.join(';'),relation:0,mood:0,arousal:0,repeatFactor:1}
  result.events.push(item)
  if(Number.isFinite(e.confidence)&&e.confidence<(rules.eventMinConfidence??.85)){item.accepted=false;item.reason='insufficient-semantic-signal';continue}
  if(!e.qualified||['flat','uncertain'].includes(e.state))continue
  if(e.milestoneId&&state.milestones.includes(e.milestoneId)){item.accepted=false;item.reason='milestone-already-awarded';continue}
  const values=e.category==='relationship-damage'?rules.damageValues[Math.max(0,e.severity-1)]:rules.eventValues[e.category]
  if(!values)continue
  let relation=values.relation
  if(e.state==='up'&&relation>0){
   const count=state.repeats.filter(r=>r.key===e.factKey).length
   item.repeatFactor=rules.repeatFactors[Math.min(count,rules.repeatFactors.length-1)]
   relation=round(relation*item.repeatFactor);positive+=relation
   state.repeats.push({key:e.factKey,at})
  }else if(e.state==='down'&&relation<0){negative+=relation;hasDamage=hasDamage||e.severity>=2}
  else relation=0
  item.relation=relation;item.mood=round(values.mood>0?values.mood*item.repeatFactor:values.mood);item.arousal=round(values.arousal>0?values.arousal*item.repeatFactor:values.arousal)
  mood+=item.mood;arousal+=item.arousal
  if(e.category==='relationship-damage'&&e.severity>=2&&e.damageConfirmed&&e.incidentKey){
   const sourceIds=(e.evidence||[]).map(r=>r.sourceId)
   state.incidents.push({key:e.incidentKey,at,sourceIds})
   const distinct=new Set(state.incidents.filter(i=>i.key===e.incidentKey).flatMap(i=>i.sourceIds))
   if(e.confidence>=rules.demoteMinConfidence&&(distinct.size>=rules.damageRepeatCount||e.severity===3&&e.demotionConfirmed)){demotion=true;damageKeys.add(e.incidentKey)}
  }
  if(e.repairConfirmed&&state.recovery?.incidentKeys?.includes(e.repairIncidentKey))repair=true
  if(e.milestoneId&&!state.milestones.includes(e.milestoneId))state.milestones.push(e.milestoneId)
 }
 positive=Math.min(rules.turnRelationPositive,positive)
 negative=Math.max(hasDamage?-rules.turnDamageNegative:-rules.turnRelationNegative,negative)
 let recovery=state.recovery
 if(recovery&&(at>=recovery.until||state.score>=recovery.target))recovery=null
 if(recovery&&resolvedIncidents.some(key=>recovery.incidentKeys?.includes(key)))recovery={...recovery,resolved:true}
 repair=repair||recovery?.resolved===true
 if(recovery&&config.recoverBoost.enabled&&repair&&positive>0){
  const bonus=(recovery.bonusDays||[]).includes(day)?0:config.recoverBoost.dailyFirstBonus
  const amplified=positive*config.recoverBoost.factor+bonus
  // Extra reward can only repair the recorded loss; deliberately demoting cannot farm a net gain.
  positive=Math.max(positive,Math.min(amplified,recovery.target-state.score))
  if(bonus>0)recovery={...recovery,bonusDays:[...(recovery.bonusDays||[]),day]}
  result.notes.push('verified-repair-boost')
 }else if(positive>0&&rules.firstMeetBonus>0&&!state.daily[day]?.firstBonus){positive+=rules.firstMeetBonus;result.notes.push('first-positive-bonus')}
 const usedGain=Math.max(state.daily[day]?.gain||0,state.quotaCarryUntil>at?state.quotaCarryValue||0:0)
 positive=round(Math.min(positive,rules.turnRelationPositive,Math.max(0,config.dailyCap-usedGain),Math.max(0,100-state.score)))
 negative=round(negative)
 let next=clamp(round(state.score+positive+negative),0,100),floor=config.thresholds[state.stage-1]
 const cooldown=state.lastDemotionAt!==null&&state.lastDemotionAt!==undefined&&at-state.lastDemotionAt<config.demoteCooldownDays*DAY
 if(demotion&&state.stage>1&&negative<0&&!config.floorLock&&!cooldown){
  const corrected=clamp(next,config.thresholds[state.stage-2],round(floor-.01));result.stageCorrection=round(corrected-next);next=corrected
 }else if(next<floor){
  result.notes.push(config.floorLock?'floor-lock':cooldown?'demotion-cooldown':hasDamage?'demotion-evidence-insufficient':'minor-friction-no-demotion')
  result.stageCorrection=round(floor-next);next=floor
 }
 const stage=stageOf(next,config)
 if(stage<state.stage){
  state.lastDemotionAt=at
  if(config.recoverBoost.enabled&&!recovery)recovery={from:at,until:at+config.recoverBoost.days*DAY,target:state.score,bonusDays:[],incidentKeys:[...damageKeys]}
 }
 state.score=round(next);state.stage=stage;state.lastEventAt=at;state.revision++
 if(events.some(e=>e.qualified)&&sharedIds.size)state.lastOwnerInteractionAt=at
 state.daily[day]={gain:round((state.daily[day]?.gain||0)+positive),firstBonus:state.daily[day]?.firstBonus||positive>0}
 if(state.quotaCarryUntil>at)state.quotaCarryValue=round((state.quotaCarryValue||0)+positive)
 if(recovery&&state.score>=recovery.target)recovery=null
 state.recovery=recovery;state.repeats=state.repeats.slice(-config.replayLimit*4);state.incidents=state.incidents.slice(-config.replayLimit*4)
 // The ledger keeps historical daily entries in snapshots; the active state is bounded.
 state.daily=Object.fromEntries(Object.entries(state.daily).sort(([a],[b])=>a.localeCompare(b)).slice(-366))
 result.positive=positive;result.negative=negative
 result.mood=round(clamp(mood*rules.stageMoodCoefficients[before.stage-1][mood<0?'negative':'positive'],-rules.turnMood,rules.turnMood))
 const optional=optionalActive&&config.optionalEnabled&&config.arousal.enabled&&before.stage>=config.stageGate
 result.arousal=optional?round(clamp(arousal*config.arousal.stageCoefficients[before.stage-1],-rules.turnArousal,rules.turnArousal)):0
 if(optional)state.arousal={value:round(clamp(arousalValue(previous,config,at)+result.arousal,0,100)),at}
 if(optional&&optionalCompleted){const beforeDrop=state.arousal.value;state.arousal.value=round(clamp(beforeDrop-config.arousal.drop,0,100));result.arousal=round(result.arousal+state.arousal.value-beforeDrop);result.notes.push('confirmed-completion-drop')}
 if(confirmedStatus){state.status=confirmedStatus.value;state.statusSource={factId:confirmedStatus.factId,sourceId:confirmedStatus.sourceId,agreementSourceId:confirmedStatus.agreementSourceId};result.notes.push('mutually-confirmed-status')}
 result.afterScore=state.score;result.afterStage=state.stage;result.actualDelta=round(state.score-before.score)
 return {state,result}
}
