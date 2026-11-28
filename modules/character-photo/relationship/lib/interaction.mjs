/** Transport facts only. Never accept closure or identity asserted by the judgement model.
 * The caller owns authentication. Shadow inputs are synthetic fixtures, not live receipts.
 * A live collector must obtain these fields from the registered session/send adapter.
 */
export function interactionEligibility({persona,owner,scope='private',chatId='private:'+owner,sources=[],context=[]}) {
  const valid = n => n && n.persona===persona && n.chatId===chatId && n.actor && typeof n.sourceId==='string' && n.sourceId.length>0
  if(scope!=='private')return {status:'ineligible',reason:'outside-owner-private',closedSourceIds:[],pendingSourceIds:[],links:[]}
  const players=sources.filter(s=>valid(s)&&s.kind==='user'&&s.actor===owner&&s.delivery==='received')
  const replies=context.filter(s=>valid(s)&&s.kind==='assistant'&&s.actor==='role:'+persona&&s.delivery==='sent')
  const all=[...sources,...context],ids=all.map(s=>s.sourceId).filter(Boolean)
  if(new Set(ids).size!==ids.length)return {status:'pending',reason:'ambiguous-source-id',closedSourceIds:[],pendingSourceIds:sources.map(s=>s.sourceId),links:[]}
  const links=[]
  for(const player of players)for(const reply of replies){
    if(reply.replyTo===player.sourceId||reply.replyToSources?.includes(player.sourceId))links.push({playerSourceId:player.sourceId,replySourceId:reply.sourceId,direction:'player-then-role'})
    else if(player.replyTo===reply.sourceId||player.adjacentReplyTo===reply.sourceId)links.push({playerSourceId:player.sourceId,replySourceId:reply.sourceId,direction:player.replyTo?'role-then-player':'archive-adjacent-role-then-player'})
  }
  const closedSourceIds=[...new Set(links.map(l=>l.playerSourceId))]
  const pendingSourceIds=sources.filter(s=>!closedSourceIds.includes(s.sourceId)).map(s=>s.sourceId)
  return {status:closedSourceIds.length?'eligible':'pending',reason:closedSourceIds.length?'linked-delivered-exchange':'missing-confirmed-exchange',closedSourceIds,pendingSourceIds,links}
}

export function annotateEligibility(events,eligibility) {
  return events.map(event=>({...event,relationshipEligible:event.evidence.every(e=>eligibility.closedSourceIds.includes(e.sourceId)),eligibilityReason:event.evidence.every(e=>eligibility.closedSourceIds.includes(e.sourceId))?'exchange-confirmed-content-still-required':'exchange-not-confirmed'}))
}
