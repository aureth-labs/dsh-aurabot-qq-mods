import {createHash} from 'node:crypto'
import {interactionEligibility} from './interaction.mjs'
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rank=e=>e.category==='relationship-damage'?100+e.severity:['promise','milestone'].includes(e.category)?80:e.category==='remember-detail'?60:40

/** facts is a host-owned registry snapshot, NEVER model output or a public request field.
 * Until the archive adapter can provide confirmed facts, affected awards abstain.
 */
export function qualifyEvents({events,sources,context=[],facts=[],persona,owner,epoch,at,chatId}) {
 const exchange=interactionEligibility({persona,owner,sources,context,chatId})
 const registry=new Map(facts.filter(f=>f&&f.status==='confirmed'&&f.persona===persona&&f.owner===owner&&f.epoch===epoch&&typeof f.id==='string'&&typeof f.sourceId==='string'&&f.sourceId&&Number.isFinite(f.at)&&f.at<=at).map(f=>[f.id,f]))
 const claimed=[],qualified=[]
 for(const event of [...events].sort((a,b)=>rank(b)-rank(a))){
  const reasons=[],proofs=(event.proofRefs||[]).map(id=>registry.get(id)).filter(Boolean)
  const kind={'promise':'fulfillment','milestone':'milestone','relationship-damage':'relationship-damage'}[event.category]
  const matching=kind?[...registry.values()].filter(f=>f.kind===kind&&typeof f.quote==='string'&&event.evidence?.some(e=>e.sourceId===f.sourceId&&(e.quote.includes(f.quote)||f.quote.includes(e.quote)))):[]
  if(matching.length===1&&!proofs.some(p=>p.id===matching[0].id))proofs.push(matching[0])
  // Follow only a source-checked typed registry edge; the model need not repeat the
  // entire predecessor chain. A missing or ambiguous edge still abstains.
  for(const proof of [...proofs])if(proof.relatedId&&registry.has(proof.relatedId)&&!proofs.some(p=>p.id===proof.relatedId))proofs.push(registry.get(proof.relatedId))
  if(event.actor!==owner)reasons.push('actor-mismatch')
  const imageSources=(event.evidence||[]).map(e=>sources.find(s=>s.sourceId===e.sourceId)).filter(s=>s?.mediaOnly)
  if(imageSources.length){
   if(imageSources.some(s=>!s.visual?.length))reasons.push('image-meaning-unavailable')
   if(!['care','praise','tease','ask-intimate','none'].includes(event.category))reasons.push('image-not-real-life-proof')
  }
  if(!event.evidence?.length||!event.evidence.every(ref=>sources.some(s=>s.sourceId===ref.sourceId&&s.kind==='user'&&s.actor===owner&&s.text.includes(ref.quote))))reasons.push('missing-player-evidence')
  if(!event.evidence?.every(e=>exchange.closedSourceIds.includes(e.sourceId)))reasons.push('exchange-not-confirmed')
  if(event.state==='uncertain')reasons.push('semantic-uncertain')
  if(['care','self-share','remember-detail','promise','milestone','praise','tease'].includes(event.category)&&event.state==='down'||event.category==='pester'&&event.state==='up')reasons.push('event-direction-inconsistent')
  const currentIds=new Set((event.evidence||[]).map(e=>e.sourceId))
  const currentProof=kind=>proofs.find(p=>p.kind===kind&&p.subject===owner&&currentIds.has(p.sourceId))
  if(event.category==='promise'){
   const fulfilled=currentProof('fulfillment'),commitment=proofs.find(p=>p.kind==='commitment'&&p.subject===owner&&p.id===fulfilled?.relatedId&&p.at<(fulfilled?.at||0))
   if(event.promisePhase!=='fulfilled'||!fulfilled||!commitment||fulfilled.sourceId===commitment.sourceId)reasons.push('promise-not-proven-fulfilled')
  }
  if(event.category==='milestone'&&!currentProof('milestone'))reasons.push('milestone-not-confirmed')
  if(event.category==='remember-detail'&&!proofs.some(p=>p.kind==='detail'&&p.at<at&&!currentIds.has(p.sourceId)&&[owner,'role:'+persona].includes(p.subject)))reasons.push('prior-detail-not-verified')
  if(event.category==='self-share'&&event.subject!=='owner')reasons.push('player-experience-subject-unknown')
  if(event.category==='relationship-damage'&&(event.target!=='role'||event.state!=='down'||event.severity<1))reasons.push('damage-target-or-direction-invalid')
  // Ambiguous performative/history contexts need independent, current attribution.
  if(event.category==='relationship-damage'&&(event.contextFlags||[]).some(f=>['joke','quote','roleplay','history'].includes(f))&&!currentProof('relationship-damage'))reasons.push('damage-context-not-verified')
  const spans=(event.evidence||[]).map(ref=>{const s=sources.find(s=>s.sourceId===ref.sourceId);const start=s?.text.indexOf(ref.quote)??-1;return {id:ref.sourceId,start,end:start+ref.quote.length}})
  if(spans.some(s=>claimed.some(p=>p.id===s.id&&s.start<p.end&&p.start<s.end)))reasons.push('overlapping-fact-already-proposed')
  if(!reasons.length)claimed.push(...spans)
  const damage=currentProof('relationship-damage'),repair=currentProof('resolution')
  qualified.push({...event,qualified:reasons.length===0,reasons,
   factKey:fingerprint(proofs.length?proofs.map(p=>p.id).sort():[event.category,...imageSources.flatMap(s=>(s.visual||[]).map(v=>v.digest)),...(event.evidence||[]).map(e=>e.quote.normalize('NFKC').replace(/\s+/g,' ').trim())]),
   proofIds:proofs.map(p=>p.id),incidentKey:damage?.relatedId||'',damageConfirmed:!!damage,
   repairConfirmed:!!repair&&!!repair.relatedId,repairIncidentKey:repair?.relatedId||'',demotionConfirmed:!!damage&&damage.relationshipLevel===true,
   milestoneId:event.category==='milestone'?(currentProof('milestone')?.relatedId||currentProof('milestone')?.id):event.category==='promise'?proofs.find(p=>p.kind==='commitment')?.id:null})
 }
 return {exchange,events:qualified}
}
