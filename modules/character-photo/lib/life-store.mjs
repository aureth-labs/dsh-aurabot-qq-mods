import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function createLifeStore(file) {
  mkdirSync(dirname(file),{recursive:true})
  const verify=()=>{if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw Error('生活档案路径发生变化')}
  verify()
  let state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{schema:1,rows:{}}
  if(state.schema!==1||!state.rows||typeof state.rows!=='object')throw Error('生活档案格式不兼容，原文件已保留')
  const save=()=>{verify();const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(state),{flag:'wx',mode:0o600});renameSync(tmp,file)}
  let recovered=false
  for(const row of Object.values(state.rows)){
    for(const job of row.jobs||[])if(['running','queued'].includes(job.status)){job.status='unknown';job.error='上次运行结束前未确认结果，不自动重试';recovered=true}
    for(const entry of row.sleep?.inbox||[])if(entry.status==='dispatching'){entry.status='unknown';recovered=true}
  }
  if(recovered)save()
  const key=(owner,persona)=>JSON.stringify([owner,persona])
  const empty=()=>({revision:0,epoch:0,activities:[],records:[],habits:[],jobs:[],usage:{},handled:[]})
  function read(owner,persona){return structuredClone(state.rows[key(owner,persona)]||empty())}
  function change(owner,persona,fn,revision){
    const k=key(owner,persona),row=read(owner,persona)
    if(revision!==undefined&&revision!==row.revision)throw Error('生活记录已更新，请刷新后操作')
    const result=fn(row);row.revision++
    if(row.activities.length>80||row.records.length>300||row.habits.length>100)throw Error('生活档案已达到容量，请先整理不需要的条目')
    const before=state.rows[k];state.rows[k]=row
    try{save()}catch(e){if(before)state.rows[k]=before;else delete state.rows[k];throw e}
    return result
  }
  return {read,change,file}
}
