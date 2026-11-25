import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, matchTemplate, parseInput } from '../lib/catalog.mjs';
import { collectImages, rawText } from '../lib/media.mjs';
const rub = { key: 'rub', keywords: ['贴', '贴贴'], shortcuts: [], params: { minImages: 2, maxImages: 2, minTexts: 0, maxTexts: 0, defaultTexts: [], options: [] } };
const text = { key: 'luxun_say', keywords: ['鲁迅说'], shortcuts: [], params: { minImages: 0, maxImages: 0, minTexts: 1, maxTexts: 1, defaultTexts: ['我没有说过这句话'], options: [] } };
function harness(ats = []) {
  const requested = [];
  const api = { lib: () => ({ fetchImage: async url => { const id = new URL(url).searchParams.get('nk'); requested.push(id || url); return Buffer.from(id || url); } }), onebot: async action => action === 'get_login_info' ? { user_id: '333333' } : { message: [] } };
  const msg = { userId: '111111', nickname: '甲', images: [], raw: { self_id: '333333', message: [{ type: 'text', data: { text: '贴贴' } }, ...ats.map(qq => ({ type: 'at', data: { qq } }))] } };
  return { api, msg, requested };
}
test('关键词边界、最长匹配、自定义触发词', () => {
  const index = buildIndex([rub, text], { 亲密: 'rub' });
  assert.equal(matchTemplate('贴贴', index).item.key, 'rub');
  assert.equal(matchTemplate('亲密', index).item.key, 'rub');
  assert.equal(matchTemplate('贴贴纸在墙上', index), null);
  assert.equal(matchTemplate('鲁迅说 今天开心', index).rest, '今天开心');
});
test('文字缺失统一补齐：默认文案、昵称、多段', () => {
  assert.deepEqual(parseInput('', text).texts, ['我没有说过这句话']);
  assert.deepEqual(parseInput('今天开心', text).texts, ['今天开心']);
  const variant = { ...text, params: { ...text.params, minTexts: 2, maxTexts: 2, defaultTexts: [] } };
  assert.deepEqual(parseInput('第一段', variant, null, '甲').texts, ['第一段', '甲']);
});
for (const [name, ats, expected] of [['甲@乙', ['222222'], ['111111', '222222']], ['甲@机器人', ['333333'], ['111111', '333333']], ['无@关键词', [], ['111111', '333333']], ['呼叫机器人同时@乙', ['333333', '222222'], ['111111', '222222']]]) {
  test(name + '的双头像顺序', async () => {
    const { api, msg } = harness(ats);
    const images = await collectImages(api, msg, rub.params, new Map());
    assert.deepEqual(images.map(i => Buffer.from(i.data, 'base64').toString()), expected);
    assert.equal(rawText(msg), '贴贴');
  });
}
test('引用图片优先，只有一张时统一补齐发送者', async () => {
  const { api, msg } = harness(); msg.replyId = '1';
  api.onebot = async () => ({ message: [{ type: 'image', data: { url: 'https://example.com/image.png' } }] });
  const images = await collectImages(api, msg, rub.params, new Map());
  assert.deepEqual(images.map(i => Buffer.from(i.data, 'base64').toString()), ['111111', 'https://example.com/image.png']);
});
test('零图片模板不请求头像', async () => {
  const { api, msg, requested } = harness();
  assert.deepEqual(await collectImages(api, msg, text.params, new Map()), []); assert.deepEqual(requested, []);
});
test('真正的 @ 只提供头像；手打 @昵称保留为文案，不猜测 QQ 身份', async () => {
  const { api, msg } = harness(['222222']);
  msg.raw.message[0].data.text = '#测试 ';
  msg.raw.message[1].data.name = '带空格的 长昵称';
  assert.equal(rawText(msg), '#测试');
  assert.equal(Buffer.from((await collectImages(api,msg,{minImages:1,maxImages:1},new Map()))[0].data,'base64').toString(), '222222');
  msg.raw.message = [{type:'text',data:{text:'#测试 @带空格的 长昵称'}}];
  assert.equal(rawText(msg), '#测试 @带空格的 长昵称');
});
test('禁止从入站消息读取本机文件', async () => {
  const { api, msg } = harness(); msg.images = [{ type: 'image', data: { url: 'file:///C:/secret' } }];
  await assert.rejects(collectImages(api, msg, rub.params, new Map()), /本机文件/);
});

test('制作、查询、管理统一要求 #；仅显式命令和可选开关例外', async () => {
  const { readRequest } = await import('../lib/catalog.mjs');
  for (const input of ['表情帮助', '表情列表', '表情详情 摸摸', '鲁迅说', '表情关', '今天聊聊表情帮助']) assert.equal(readRequest(input), null);
  for (const input of ['#表情帮助', '#表情列表 2', '#表情详情 摸摸', '#鲁迅说 你好', '#摸摸', '＃表情状态']) assert.ok(readRequest(input));
  assert.equal(readRequest('表情帮助', true).text, '表情帮助');
  assert.equal(readRequest('表情帮助', false, true).text, '表情帮助');
});
test('详情提供触发词、参数取值和带 # 的示例，不展示内部标识或正则', async () => {
  const { describe } = await import('../lib/catalog.mjs');
  const item = { ...rub, shortcuts: [{ pattern: '(?P<name>\\S+)' }], params: { ...rub.params, options: [{ type: 'Boolean', field0: { name: 'circle', description: '圆形头像', default: false } }] } };
  const result = describe(item, ['亲密']);
  assert.match(result, /贴贴.*亲密/); assert.match(result, /--circle/); assert.match(result, /true 或 false/); assert.match(result, /示例：#/);
  assert.doesNotMatch(result, /rub|标识|\(\?P</);
});

for (const type of ['image', 'mface']) test(`引用 ${type} + 自动 @作者：用图片，不抢占单图位置或充当第二个头像`, async () => {
  const { api, msg, requested } = harness(['222222']); msg.replyId = '42';
  api.onebot = async action => action === 'get_msg'
    ? { sender: { user_id: 222222, nickname: '乙' }, message: [{ type, data: { url: 'https://example.com/quoted.png' } }] }
    : { user_id: '333333' };
  const decode = images => images.map(i => Buffer.from(i.data, 'base64').toString());
  assert.deepEqual(decode(await collectImages(api, msg, { minImages:1,maxImages:1 }, new Map())), ['https://example.com/quoted.png']);
  assert.deepEqual(decode(await collectImages(api, msg, rub.params, new Map())), ['111111','https://example.com/quoted.png']);
  assert.ok(!requested.includes('222222'));
});
test('附图、引用图片排在 @头像之前；不同的显式目标可补剩余位置', async () => {
  const { api, msg } = harness(['444444']);msg.replyId='42';
  msg.images=[{type:'image',data:{url:'https://example.com/attached.png'}}];
  api.onebot=async()=>({sender:{user_id:222222},message:[{type:'image',data:{url:'https://example.com/quoted.png'}}]});
  const decode=images=>images.map(i=>Buffer.from(i.data,'base64').toString());
  assert.deepEqual(decode(await collectImages(api,msg,rub.params,new Map())),['https://example.com/attached.png','https://example.com/quoted.png']);
  msg.images=[];
  assert.deepEqual(decode(await collectImages(api,msg,rub.params,new Map())),['https://example.com/quoted.png','444444']);
});
test('引用纯文字仍可使用被引用者头像', async () => {
  const {api,msg}=harness(['222222']);msg.replyId='42';
  api.onebot=async()=>({sender:{user_id:222222},message:[{type:'text',data:{text:'你好'}}]});
  const images=await collectImages(api,msg,{minImages:1,maxImages:1},new Map());
  assert.equal(Buffer.from(images[0].data,'base64').toString(),'222222');
});
