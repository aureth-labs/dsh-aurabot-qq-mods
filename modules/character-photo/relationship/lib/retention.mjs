const DAY=86400000
export class Retention {
 constructor(service){this.service=service;this.store=service.store;this.db=service.store.db}
 hasLegacyTable(name){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))}
 clearLegacySources(key,sourceIds){
  // Older releases stored opaque session/turn locators. Honour forget/reset
  // for those rows so a rollback cannot surface a forgotten source.
  if(this.hasLegacyTable('source_locations')){
   if(sourceIds){
    const remove=this.db.prepare('DELETE FROM source_locations WHERE k=? AND source_id=?')
    for(const id of sourceIds)remove.run(key,id)
   }else this.db.prepare('DELETE FROM source_locations WHERE k=?').run(key)
  }
  if(this.hasLegacyTable('relation_observed_turns'))this.db.prepare('DELETE FROM relation_observed_turns WHERE k=?').run(key)
  if(!sourceIds)this.db.prepare('DELETE FROM meta WHERE k=?').run('observe-turns:'+key)
 }
 run(){const now=this.service.now();return this.store.transaction(()=>{
  // Unknown requests keep their reserved usage. Summaries contain no chat text.
  this.db.prepare("UPDATE requests SET status='unknown' WHERE status='running' AND at<?").run(now-600000)
  const old=this.db.prepare("SELECT id,day,mode,COALESCE(input_actual,input_reserved) i,COALESCE(output_actual,output_reserved) o,input_actual IS NULL u FROM requests WHERE at<? OR (at<? AND id NOT IN (SELECT id FROM requests ORDER BY at DESC LIMIT 20000))").all(now-90*DAY,now-2*DAY)
  for(const r of old){this.db.prepare('INSERT INTO request_totals VALUES(?,?,1,?,?,?) ON CONFLICT(day,mode) DO UPDATE SET requests=requests+1,unknown=unknown+excluded.unknown,inputTokens=inputTokens+excluded.inputTokens,outputTokens=outputTokens+excluded.outputTokens').run(r.day,r.mode,r.u,r.i,r.o);this.db.prepare('DELETE FROM requests WHERE id=?').run(r.id)}
  this.db.prepare('DELETE FROM request_totals WHERE day<?').run(new Date(now-730*DAY).toISOString().slice(0,10))
  if(this.hasLegacyTable('cost_samples'))this.db.prepare('DELETE FROM cost_samples WHERE at<?').run(now-90*DAY)
  if(this.hasLegacyTable('source_locations'))this.db.prepare('DELETE FROM source_locations WHERE at<?').run(now-365*DAY)
  if(this.hasLegacyTable('relation_observed_turns'))this.db.prepare('DELETE FROM relation_observed_turns WHERE at<?').run(now-30*DAY)
  this.db.prepare("DELETE FROM meta WHERE k LIKE 'configuration-preview:%' AND json_extract(v,'$.expires')<?").run(now)
  this.db.prepare("DELETE FROM meta WHERE k LIKE 'configuration-preview:%' AND k NOT IN (SELECT k FROM meta WHERE k LIKE 'configuration-preview:%' ORDER BY rowid DESC LIMIT 32)").run()
  for(const ref of this.db.prepare('SELECT persona,owner FROM scopes').all()){
   const row=this.store.get(ref.persona,ref.owner);this.service.live.prune(row)
   // Only old facts outside exact replay are compacted. Keep all current source
   // dependencies and outstanding promises until the explicit 2000-fact ceiling.
   const protectedFacts=new Set([...this.store.committed.entries(row,row.config.replayLimit),...this.store.ledger.entries(row,row.config.replayLimit)].flatMap(e=>(e.command.events||[]).flatMap(v=>v.proofIds||[])))
   const facts=this.service.facts.list(row),excess=Math.max(0,facts.length-1800)
   for(const f of facts.filter(x=>!protectedFacts.has(x.id)&&x.at<now-row.config.replayDays*DAY&&x.kind!=='commitment'&&x.kind!=='relationship-damage').slice(-excess||facts.length))if(excess&& !facts.some(x=>x.relatedId===f.id&&x.id!==f.id))this.db.prepare('DELETE FROM relation_facts WHERE id=?').run(f.id)
   this.db.prepare('DELETE FROM captured_sources WHERE k=? AND (epoch<>? OR EXISTS(SELECT 1 FROM captured_times t WHERE t.k=captured_sources.k AND t.epoch=captured_sources.epoch AND t.source_id=captured_sources.source_id AND t.at<?))').run(row.key,row.state.epoch,now-2*DAY)
   this.db.prepare('DELETE FROM captured_times WHERE k=? AND (epoch<>? OR at<?)').run(row.key,row.state.epoch,now-2*DAY)
   for(const ledger of [this.store.committed,this.store.ledger])ledger.db.prepare('DELETE FROM simulation_sources WHERE k=? AND entry_id NOT IN (SELECT id FROM simulation_entries WHERE k=? UNION SELECT id FROM simulation_archive WHERE k=?)').run(row.key,row.key,row.key)
  }
  return {requestsCompacted:old.length,retentionDays:90,historyDays:365,historyLimit:10000}
 })}
}
