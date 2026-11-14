import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barNames, postUrl, cookieHeader, parseList, parsePost, createTieba } from '../lib/tieba.mjs';
import moduleDef from '../index.mjs';

const list = '<title>测试吧</title><ul><li class="j_thread_list"><a class="j_th_tit" href="/p/12345678">一个有趣的帖子</a><div class="threadlist_abs">摘要</div></li></ul>';
const post = '<title>测试帖</title><h3 class="core_title_txt">真正的标题</h3><div class="l_post" data-field=\'{"content":{"post_no":1}}\'><a class="p_author_name">作者</a><div class="d_post_content">第一楼<br>正文<script>坏代码</script></div></div>';
test('forum names normalize; links reject non-Tieba and non-post paths', () => {
  assert.deepEqual(barNames('deepseek吧，图拉丁\ndeepseek'), ['deepseek','图拉丁']);
  assert.equal(postUrl('https://tieba.baidu.com/p/12345678?pn=2'), 'https://tieba.baidu.com/p/12345678');
  for (const x of ['http://127.0.0.1/p/12345678','https://tieba.baidu.com.evil/p/12345678','https://tieba.baidu.com@evil/p/12345678','https://tieba.baidu.com/f?kw=a','https://tieba.baidu.com:99/p/12345678']) assert.equal(postUrl(x), null);
});
test('cookies filtered, newline refused, HTML list/comments and post parse', () => {
  assert.equal(cookieHeader('BDUSS=secret; evil=x; STOKEN=abc'), 'BDUSS=secret; STOKEN=abc');
  assert.throws(() => cookieHeader('BDUSS=x\r\nevil:y'));
  assert.equal(parseList(list)[0].title, '一个有趣的帖子');
  assert.equal(parseList('<!--' + list + '-->')[0].url, 'https://tieba.baidu.com/p/12345678');
  assert.equal(parsePost(post,'url').posts[0].text, '第一楼 正文');
  assert.throws(() => parseList('<title>百度安全验证</title>'), /安全验证/);
  assert.throws(() => parsePost('<title>空白页面</title>','url'), /未读到/);
});
test('requests read-only, cookies only sent to Tieba; verification falls back to indexed results', async () => {
  const requests=[];
  const client=createTieba({getCookie:()=> 'BDUSS=private; Other=discard', fetchImpl:async (url,init)=>{
    requests.push({url:String(url),init}); return new Response('<title>百度安全验证</title>');
  },searchWeb:async ()=>({sources:[{url:'https://evil.test/p/12345678',title:'evil'},{url:'https://tieba.baidu.com/p/12345678',title:'结果'}]})});
  const r=await client.browse('deepseek');
  assert.equal(r.mode,'indexed'); assert.equal(r.items.length,1);
  assert.match(r.warning,/可能不是最新/);
  assert.equal((await client.read('https://tieba.baidu.com/p/12345678')).ok,false);
  for(const {url,init} of requests){assert.equal(new URL(url).hostname,'tieba.baidu.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.cookie,'BDUSS=private');}
});
test('automatic browse obeys switches, shares a read post once, and deduplicates', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-tieba-test-'));
  const opts={...moduleDef.defaults,bars:'deepseek',autoBrowse:true,startHour:0,endHour:0,intervalMinutes:10};
  const cfg={enabled:true,dryRun:true,ownerQQ:'12345'};
  let sent=0, modelCalls=0;
  const previous=globalThis.fetch;
  globalThis.fetch=async (url)=>new Response(String(url).includes('/p/')?post:list);
  try {
    const api={lib:()=>({registerSecretField(){}}),settings:()=>opts,config:()=>cfg,dataDir:(f)=>join(dir,f),dsh:{get:()=>null},tool:()=>{},rule:()=>{},every:()=>{},route:()=>{},
      core:{onebot:{state:'connected'},mutes:{muted:()=>false},personas:{current:()=> '人格'}},
      ask:async ()=>{modelCalls++;return '{"share":true,"index":0,"text":"这个挺有意思"}';},
      sendText:async ()=>{sent++;return {message_id:1};},use:()=>null,log:{warn:()=>{}}};
    const ext=moduleDef.setup(api,{renderPage:async (url,kind)=>kind==='browse'
      ? {links:[{url:'https://tieba.baidu.com/p/12345678',title:'一个有趣的帖子'}]}
      : {title:'真正的标题',contents:['第一楼正文']}});
    await ext.tick();assert.equal(sent,0);assert.equal(modelCalls,0);
    cfg.dryRun=false;opts.autoBrowse=false;await ext.tick();assert.equal(sent,0);
    opts.autoBrowse=true;await ext.tick();assert.equal(sent,1);assert.equal(ext.state().shares,1);
    await ext.tick();assert.equal(sent,1);assert.equal(modelCalls,1);
    assert.ok(ext.state().seen.includes('https://tieba.baidu.com/p/12345678'));
  } finally {globalThis.fetch=previous;}
});
test('already-bound tools resolve current module exports after a hot reload', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aurabot-tieba-binding-'));
  const builders=[];
  let current={version:'old',read:async()=>({ok:true,title:'old'})};
  const api={lib:()=>({registerSecretField(){}}),dataDir:f=>join(dir,f),settings:()=>moduleDef.defaults,config:()=>({}),
    dsh:{get:()=>null},tool:b=>builders.push(b),defineTool:t=>t,rule:()=>{},every:()=>{},route:()=>{},
    use:()=>current};
  moduleDef.setup(api,{renderPage:async()=>({})});
  const tools=builders[0]({chat:{kind:'private'},level:'social'});
  assert.ok(tools.some(t=>t.name==='tieba_reader_status'));
  const boundRead=tools.find(t=>t.name==='tieba_read');
  current={version:'new',read:async()=>({ok:true,title:'NEW_BROWSER_RESULT'})};
  const r=await boundRead.execute({url:'https://tieba.baidu.com/p/12345678'});
  assert.equal(r.title,'NEW_BROWSER_RESULT');
});

test('login check falls back to newmoindex and tbs when json_userinfo is gone', async () => {
  const seen = [];
  const paths = [];
  const client = createTieba({ getCookie: () => 'BDUSS=ok; evil=x', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path + ':' + init.method);
    // 新版贴吧：json_userinfo 一律 302 跳 passport，newmoindex 才是有效判定。
    if (path === '/f/user/json_userinfo') return new Response('', { status: 302, headers: { location: 'https://passport.baidu.com/' } });
    if (path === '/mo/q/newmoindex') return new Response(JSON.stringify({ no: 0, error: 'success', data: { is_login: true, name: '测试昵称', name_show: '测试昵称' } }));
    return new Response(JSON.stringify({ is_login: 1 }));
  }, searchWeb: async () => ({ sources: [] }) });
  seen.push(await client.account());
  assert.equal(seen[0].loggedIn, true);
  assert.equal(seen[0].name, '测试昵称');
  assert.equal(paths[0], '/mo/q/newmoindex:GET');
});

test('login check reports anonymous accounts as not logged in, with a reason', async () => {
  const client = createTieba({ getCookie: () => 'BDUSS=expired', fetchImpl: async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/mo/q/newmoindex') return new Response(JSON.stringify({ no: 1, error: 'not logined!', data: { is_login: false } }));
    if (path === '/dc/common/tbs') return new Response(JSON.stringify({ tbs: 'x', is_login: 0 }));
    return new Response('null');
  }, searchWeb: async () => ({ sources: [] }) });
  const r = await client.account();
  assert.equal(r.loggedIn, false);
  assert.match(r.message, /已失效|重新登录/);
  assert.match(r.message, /诊断/);
});

test('tbs alone confirms a session when newmoindex cannot be read', async () => {
  const client = createTieba({ getCookie: () => 'BDUSS=ok', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/mo/q/newmoindex') return new Response('boom', { status: 500 });
    if (path === '/dc/common/tbs' && init.method === 'POST') return new Response(JSON.stringify({ is_login: 1 }));
    return new Response('null');
  }, searchWeb: async () => ({ sources: [] }) });
  const r = await client.account();
  assert.equal(r.loggedIn, true);
});
