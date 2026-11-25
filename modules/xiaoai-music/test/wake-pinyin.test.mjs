import test from 'node:test';
import assert from 'node:assert/strict';
import { matchWakePrefix, describeWakeMatch, validateWakeConfig } from '../lib/speaker/wake.mjs';
import { parseProbeCommand } from '../lib/speaker/probe.mjs';
const wake = { names: ['蓝蓝'], greetingNames: [] };
test('one name matches homophones without tones and preserves the original question', () => {
 for (const name of ['蓝蓝','兰兰','篮篮','懒懒']) {
  const result=parseProbeCommand('小爱同学，'+name+'，播放《测试歌曲》，好吗？',{sessionRouting:true,wakeConfig:wake});
  assert.deepEqual(result,{action:'ask-test',text:'播放《测试歌曲》，好吗？'});
  assert.equal(describeWakeMatch(name+'测试',wake).heardPinyin,'lan lan');
 }
 assert.equal(parseProbeCommand('兰兰',{sessionRouting:true,wakeConfig:wake}).action,'wake-ack');
 for (const text of ['今天兰兰怎么样','南南你好','浪浪你好','兰你好','lanlan你好']) assert.equal(matchWakePrefix(text,wake),null,text);
});
test('explicit pronunciation handles polyphonic names without accepting arbitrary alternative readings', () => {
 const value={names:['重重'],greetingNames:[],primaryPinyin:'chong chong'};
 assert.ok(matchWakePrefix('虫虫你好',value));assert.equal(matchWakePrefix('中中你好',value),null);
 assert.throws(()=>validateWakeConfig({...value,primaryPinyin:'chong'}));
 assert.ok(matchWakePrefix('丁丁你好',{...wake,names:['蓝蓝','丁丁']}));
 assert.equal(matchWakePrefix('丁丁你好',wake),null);
});

test('homophones share one reading while retaining exact spelling and longest-prefix matching', () => {
  const value={names:['蓝蓝','兰兰','兰兰子'],greetingNames:[]};
  assert.equal(describeWakeMatch('普通文字',value).targetPinyin,'lan lan，lan lan zi');
  assert.equal(describeWakeMatch('兰兰你好',value).name,'兰兰');
  assert.equal(matchWakePrefix('篮篮子你好',value)[0],'篮篮子');
});
