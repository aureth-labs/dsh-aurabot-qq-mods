import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTodoBook } from '../todo.mjs'
import definition from '../index.mjs'
const fresh = () => { const file = join(mkdtempSync(join(tmpdir(), 'todo-test-')), 'todo.json'); return {file, book:createTodoBook(file)} }
test('immediate tasks survive restart and overdue repeats advance once', () => {
 const {file,book}=fresh();const result=book.add('private:1|test|private:1|0|3|5');assert.equal(result.ok,true)
 const restored=createTodoBook(file);const due=restored.takeDue(Date.now()+1000);assert.equal(due.length,1);assert.equal(due[0].item.times,2);assert.equal(due[0].item.state,'open');assert.ok(due[0].item.at>Date.now());assert.equal(restored.takeDue().length,0)
})
test('permissions isolate completion and cancellation',()=>{
 const {book}=fresh();const task=book.add('private:2|secret|private:2|23:59|1').item
 assert.equal(book.done(task.id,t=>t.from==='private:1').ok,false);assert.equal(book.drop(task.id,t=>t.from==='private:1').ok,false)
 assert.equal(book.done(task.id,t=>t.from==='private:2').ok,true)
})
test('invalid time rejected; cancelled and done tasks do not fire',()=>{
 const {book}=fresh();assert.equal(book.add('private:1|bad|private:1|25:90|1').ok,false)
 const t=book.add('private:1|cancel|private:1|0|1').item;assert.equal(book.drop(t.id).ok,true);assert.equal(book.takeDue().length,0)
 const d=book.add('private:1|done|private:1|0|1').item;book.done(d.id);assert.equal(book.takeDue().length,0)
})
test('standalone setup schedules immediate tasks and blocks unprivileged cross-chat', async()=>{
 const {file}=fresh();let factory;const deliveries=[];const disposers=[]
 const api={settings:()=>({...definition.defaults}),config:()=>({allow:{private:['1','2']}}),dataDir:()=>join(file,'..'),log:{info(){},warn(){},debug(){}},isOwner:()=>false,
 core:{hub:{turnSenders:()=>['1'],pushToSession:async(...args)=>deliveries.push(args),chatLogDays:()=>[]}},tool:fn=>factory=fn,defineTool:x=>x,rule(){},on(){},every(){},onDispose:fn=>disposers.push(fn),command(){},route(){}}
 const instance=definition.setup(api)
 try {const tools=factory({chat:{chatId:'private:1'},sessionId:'test'});const add=tools.find(t=>t.name==='todo_add');assert.equal((await add.execute({raw:'private:1|cross|private:2|0|1'})).ok,false);assert.equal((await add.execute({raw:'private:1|local|private:1|0|1'})).ok,true);await new Promise(r=>setTimeout(r,80));assert.equal(deliveries.length,1)}finally{instance.book.clearAllTimers();for(const dispose of disposers)dispose()}
})
