import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recognitionRows} from '../lib/speaker/recognition.mjs';
import {recordKey} from '../lib/speaker/cursor.mjs';

test('recognition read returns only bounded text and explicit current-match evidence', () => {
 const rows=Array.from({length:12},(_,i)=>({time:100+i,query:i===11?'小伴你好':'无称呼',requestId:'synthetic-'+i,privateToken:'do-not-return'}));
 const original=JSON.stringify(rows);
 const events=new Map([[recordKey(rows[11]),'已接收，正在处理。']]);
 const result=recognitionRows(rows,{names:['小伴'],greetingNames:[]},events);
 assert.equal(result.length,10);assert.equal(result[0].time,111);assert.equal(result[0].matched,true);
 assert.equal(result[1].matched,false);assert.match(result[1].outcome,/不能据此判断/);
 assert.equal(JSON.stringify(rows),original);assert.doesNotMatch(JSON.stringify(result),/privateToken|do-not-return|requestId/);
 assert.equal(recognitionRows([{time:1,query:'长'.repeat(2000),requestId:'synthetic'}],{names:['小伴'],greetingNames:[]})[0].text.length,1000);
});

test('panel reads only on click, shows failure and records, preserves name drafts and can hide text', async () => {
 const slots=[];let cursor=0,nodes=[],failed=true;const calls=[];
 const React={useState(v){const i=cursor++;if(!(i in slots))slots[i]=v;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useEffect(){},useRef(){return{current:null}}};
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)});
 const ui=new Proxy({},{get:(_,k)=>k});
 const call=async path=>{calls.push(path);if(path.endsWith('/pinyin'))return {ok:true,readings:['cao gao bian ti']};return failed?{ok:false,message:'读取失败'}:{ok:true,listenerActive:false,message:'按当前称呼计算',records:[{time:1,text:'小伴测试',matched:true,outcome:'无本轮处理记录'}]}};
 const Panel=new Function('React','h','ui','call',await readFile(new URL('../panel.js',import.meta.url),'utf8'))(React,h,ui,call);
 const render=()=>{cursor=0;nodes=[];const walk=x=>{if(!x||typeof x!=='object')return;nodes.push(x);x.children?.forEach(walk)};walk(Panel({}))};
 const button=s=>nodes.find(n=>n.type==='Btn'&&n.children.includes(s));
 const field=()=>nodes.find(n=>n.props['aria-label']==='主要称呼');
 render();await field().props.onChange({target:{value:'草稿变体'}});render();assert.deepEqual(calls,['/speaker/wake/pinyin']);
 await button('读取识别日志').props.onClick();render();assert.ok(nodes.some(n=>n.props.role==='alert'));
 failed=false;await button('读取识别日志').props.onClick();render();assert.equal(field().props.value,'草稿变体');
 assert.ok(nodes.some(n=>n.children.includes('识别文字：小伴测试')));assert.deepEqual(calls,['/speaker/wake/pinyin','/speaker/history/read','/speaker/history/read']);
 button('收起日志').props.onClick();render();assert.equal(nodes.some(n=>n.props['aria-label']==='识别日志'),false);
});
