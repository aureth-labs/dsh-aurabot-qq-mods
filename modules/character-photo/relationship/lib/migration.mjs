import {DatabaseSync} from 'node:sqlite'
import {existsSync,openSync,readSync,closeSync} from 'node:fs'
import {join} from 'node:path'
import {DEFAULTS as oldDefaults,validate as oldValidate} from './policy-beta3.mjs'
import {validate} from './policy.mjs'
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),object=x=>x&&typeof x==='object'&&!Array.isArray(x)
function project(value,schema){if(!object(value)||!object(schema))return structuredClone(value);return Object.fromEntries(Object.entries(value).filter(([key])=>Object.hasOwn(schema,key)).map(([key,v])=>[key,project(v,schema[key])]))}
export function legacySettings(value){const out=project(value,oldDefaults);if(out.rules?.eventValues?.milestone?.relation>3)out.rules.eventValues.milestone.relation=3;oldValidate(out);return out}
function recover(base,current,original){if(same(current,base))return structuredClone(original);if(object(current)&&object(original)&&object(base))return Object.fromEntries([...new Set([...Object.keys(original),...Object.keys(current)])].map(k=>[k,recover(base[k],current[k],original[k])]));return structuredClone(current)}
/** Preserve the complete modern settings before a program rollback. The legacy
 * projection is readable by beta.3; its automatic mode stays paused. */
export function parkForLegacy(file,backup){
 if(!existsSync(file))return {changed:false}
 const fd=openSync(file,'r'),header=Buffer.alloc(16);try{readSync(fd,header,0,16,0)}finally{closeSync(fd)}
 if(header.toString('utf8')!=='SQLite format 3\0')return {changed:false}
 const db=new DatabaseSync(file);try{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get())return {changed:false}
  if(db.prepare("SELECT 1 FROM meta WHERE k='rollback-v1-settings'").get())return {changed:false,alreadyParked:true}
  const get=k=>{const r=db.prepare('SELECT v FROM meta WHERE k=?').get(k);return r?JSON.parse(r.v):null},defaults=get('defaults')||{},scopes=db.prepare('SELECT k,config FROM scopes').all().map(r=>({key:r.k,original:JSON.parse(r.config)}))
  const modern=!!get('relation-modern-state'),changed=modern||!same(defaults,legacySettings(defaults))||scopes.some(r=>!same(r.original,legacySettings(r.original)))
  if(!changed)return {changed:false}
  const saved={format:1,at:Date.now(),defaults:{original:defaults,projected:legacySettings(defaults)},scopes:scopes.map(r=>({...r,projected:{...legacySettings(r.original),mode:'off'}}))}
  saved.defaults.projected.mode='off'
  const snapshot=join(backup,'before-downgrade.sqlite');if(!existsSync(snapshot))db.prepare('VACUUM INTO ?').run(snapshot)
  db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('rollback-v1-settings',JSON.stringify(saved));db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('defaults',JSON.stringify(saved.defaults.projected));for(const r of saved.scopes)db.prepare('UPDATE scopes SET config=?,config_revision=config_revision+1 WHERE k=?').run(JSON.stringify(r.projected),r.key);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  return {changed:true,settingsPreserved:true,snapshot,automaticPaused:true}
 }finally{db.close()}
}
export function restoreModernSettings(store){
 const saved=store.meta('rollback-v1-settings');if(!saved)return
 if(saved.format!==1)throw Error('新旧版设定交接格式未知，未覆盖资料')
 store.transaction(()=>{
  const current=store.meta('defaults',{}),defaults=recover(saved.defaults.projected,current,saved.defaults.original);defaults.mode=current.mode||'off';validate(defaults);store.setMeta('defaults',defaults)
  for(const r of saved.scopes){const live=store.db.prepare('SELECT config FROM scopes WHERE k=?').get(r.key);if(!live)continue;const c=JSON.parse(live.config),merged=recover(r.projected,c,r.original);merged.mode=c.mode||'off';validate(merged,validate(defaults));store.db.prepare('UPDATE scopes SET config=?,config_revision=config_revision+1 WHERE k=?').run(JSON.stringify(merged),r.key)}
  store.setMeta('last-settings-recovery',{at:store.now(),automaticPaused:true});store.db.prepare("DELETE FROM meta WHERE k='rollback-v1-settings'").run()
 })
}
