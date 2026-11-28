/** A locator is created by a completed Aurabot turn, never guessed from text/date. */
const sessionPattern=/^[-a-zA-Z0-9_]{1,200}$/
const sourcePattern=/^qq:-?\d+(?::asr)?$/
export class NativeLinks {
 constructor(service,available){
  this.service=service;this.db=service.store.db;this.available=available
  this.db.exec('CREATE TABLE IF NOT EXISTS source_locations(k TEXT NOT NULL,epoch INTEGER NOT NULL,source_id TEXT NOT NULL,session_id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(k,epoch,source_id)); CREATE INDEX IF NOT EXISTS source_locations_age ON source_locations(at)')
 }
 record(row,sessionId,sources){
  if(!sessionPattern.test(sessionId||''))return
  const set=this.db.prepare('INSERT OR IGNORE INTO source_locations VALUES(?,?,?,?,?)')
  for(const {sourceId} of sources)if(sourcePattern.test(sourceId))set.run(row.key,row.state.epoch,sourceId,sessionId,this.service.now())
 }
 locate(row,captured,source){
  const s=this.service
  if(!source||source.kind!=='user'||source.actor!==row.owner||source.chatId!=='private:'+row.owner||source.persona!==row.persona||row.persona!==s.persona()||row.owner!==s.owner()||!Number.isFinite(source.at)||source.at<(row.state.historyBefore||0)||s.store.meta('reset-pending:'+row.key))return null
  const saved=this.db.prepare('SELECT session_id FROM source_locations WHERE k=? AND epoch=? AND source_id=?').get(row.key,row.state.epoch,source.sourceId)
  if(!saved)return null
  const id=saved.session_id,registered=s.memory()?.session?.(id)
  if(!sessionPattern.test(id)||!registered||registered.retired||registered.chatId!==source.chatId||registered.persona!==row.persona||registered.generation!==captured?.generation||!s.archive.check(captured,[{sourceId:source.sourceId,actor:source.actor,quote:source.text}])||!this.available(id))return null
  return {sessionId:id,granularity:'session'}
 }
 forget(row,ids){const remove=this.db.prepare('DELETE FROM source_locations WHERE k=? AND source_id=?');for(const id of ids)remove.run(row.key,id)}
 clear(key){this.db.prepare('DELETE FROM source_locations WHERE k=?').run(key)}
 prune(now){this.db.prepare('DELETE FROM source_locations WHERE at<? OR rowid IN (SELECT rowid FROM source_locations ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 15000)').run(now-365*86400000)}
}
