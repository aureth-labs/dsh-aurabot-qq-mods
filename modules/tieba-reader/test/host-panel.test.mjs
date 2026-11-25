import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const host = join(process.env.AURABOT_PLUGIN_DIR || '', 'client', 'client.js');
test('custom panel draft updates reach the shared host draft and preserve other configuration', {skip: !existsSync(host)},()=>{
  const code=readFileSync(host,'utf8');
  // 按括号配平取函数体，不再靠「下一个 const BILI_KIND」当结束标记：宿主把那个常量
  // 挪到别处之后，旧写法会把后面的 const 一起切进来，new Function 直接 SyntaxError。
  const extractFunction=(src,name)=>{
    const start=src.indexOf('    function '+name+'(');
    if(start<0) throw new Error('宿主 client.js 里找不到 '+name+'，测试要跟着宿主改');
    let depth=0,i=src.indexOf('(',start);
    for(;i<src.length;i++){ if(src[i]==='(') depth++; else if(src[i]===')'&&--depth===0) break; }
    let j=src.indexOf('{',i),d=0;
    for(;j<src.length;j++){ if(src[j]==='{') d++; else if(src[j]==='}'&&--d===0){ j++; break; } }
    return src.slice(start,j);
  };
  const ExtPageSrc=extractFunction(code,'ExtPage');
  const h=(type,props,...children)=>({type,props,children});
  const ExtPage=new Function('useField','h','Empty','Card','Row','ExtPanel','return ('+ExtPageSrc.trim()+')')(()=>({}),h,'Empty','Card','Row','ExtPanel');
  let draft={enabled:true,ext:{'tieba-reader':{bars:'old',cookie:''},other:{keep:true}}};const saved=structuredClone(draft);
  const tree=ExtPage({st:{config:saved,modules:[{id:'tieba-reader',defaults:{enabled:true},settings:[],panel:true}]},draft,setDraft:updater=>{draft=updater(draft);},toast(){},reload(){},mod:'tieba-reader'});
  const child=tree.children.find(n=>n&&n.type==='ExtPanel');assert.ok(child);assert.equal(child.props.draftSettings.bars,'old');
  child.props.setSettings({bars:'new'});assert.equal(draft.ext['tieba-reader'].bars,'new');assert.equal(saved.ext['tieba-reader'].bars,'old');assert.equal(draft.ext.other.keep,true);
  assert.notEqual(JSON.stringify(draft),JSON.stringify(saved));
});
