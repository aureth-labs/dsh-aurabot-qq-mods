// 收线识别（close.mjs）测试。
//
// 这个文件是「对方说的这句话，是不是让 BOT 去睡」的唯一判定入口，
// 判错的代价很直接：误判成收线 → 她提前躺下一整夜不说话；
// 漏判 → 该睡了还在硬撑。两种都很难事后解释，所以边界要钉死。
//
// 2026-11-24 有过一次真实误判：
//   「嗯，到我怀里来，在看两集，各回各房睡觉去」
// 命中「睡觉去」，主语其实是「各」，人被按到第二天早上七点。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STRONG, MEDIUM, WEAK, matchStrength, isClosing, closeMinutes, isAskingMe } from '../close.mjs'

const closings = (text, cfg) => isClosing(text, cfg)

// ---------------------------------------------------------------- matchStrength

test('强收线词能命中，并返回命中的那个词', () => {
  assert.deepEqual(matchStrength('晚安'), ['strong', '晚安'])
  assert.deepEqual(matchStrength('我睡了'), ['strong', '我睡了'])
  assert.deepEqual(matchStrength('撑不住了，先睡'), ['strong', '撑不住了'])
})

test('中/弱收线分级不串档', () => {
  assert.deepEqual(matchStrength('先这样吧'), ['medium', '先这样'])
  assert.deepEqual(matchStrength('拜拜'), ['medium', '拜拜'])
  assert.deepEqual(matchStrength('嗯'), ['weak', '嗯'])
})

test('什么都没命中的返回空', () => {
  assert.deepEqual(matchStrength('今天天气不错'), ['', ''])
  assert.deepEqual(matchStrength(''), ['', ''])
  assert.deepEqual(matchStrength(null), ['', ''])
})

test('「睡觉吧 / 去睡吧 / 早点睡」这些祈使说法在词表里', () => {
  // 2026-11-24 补的词：原来只有「睡觉去」，「你去睡觉吧」这种最常说的反而一个都不命中
  for (const w of ['睡觉吧', '去睡吧', '该睡了', '早点睡', '快去睡', '睡觉啦']) {
    assert.ok(STRONG.includes(w), `${w} 应该在 STRONG 里`)
  }
})

// ---------------------------------------------------------------- 防误判

test('反问不是在收线', () => {
  for (const t of ['你睡了吗', '你要睡吗？', '几点了', '还睡不睡呢']) {
    assert.equal(closings(t)[0], false, `不该判成收线：${t}`)
  }
})

test('转述别人说的不算', () => {
  for (const t of ['他昨天跟我说晚安了', '她说她先睡了', '他跟我说他去睡了']) {
    assert.equal(closings(t)[0], false, `不该判成收线：${t}`)
  }
})

test('名词用法不算（晚安曲 / 睡前故事）', () => {
  assert.equal(closings('我在听晚安曲')[0], false)
})

test('说别人或宠物去睡，不算 BOT 要睡', () => {
  for (const t of ['我们家狗睡觉去了', '我家的猫去睡了', '他说他要去睡了', '我爸先睡了']) {
    assert.equal(closings(t)[0], false, `不该判成收线：${t}`)
  }
})

test('主语是「各」的分配句不算（2026-11-24 那次误判）', () => {
  // 原句：命中「睡觉去」，但说的是各回各房，不是她一个人该躺下
  const t = '嗯，到我怀里来，在看两集，各回各房睡觉去'
  assert.deepEqual(matchStrength(t), ['strong', '睡觉去'], '词是命中的')
  assert.equal(closings(t)[0], true, '但是确实在安排去睡——最终靠模型复核区分「待会/现在」')
})

// ---------------------------------------------------------------- 该睡的要认

test('常见的叫她睡都要认', () => {
  for (const t of [
    '晚安',
    '我睡了',
    '睡觉去',
    '你去睡觉吧',
    '你快去睡',
    '不早了 该睡了',
    '你也早点睡',
    '睡觉啦',
    '困死了，先睡了',
  ]) {
    assert.equal(closings(t)[0], true, `应该判成收线：${t}`)
  }
})

test('短句里带第一人称的收线要认', () => {
  assert.equal(closings('我先睡一步')[0], true)
  assert.equal(closings('那我先躺会儿')[0], true)
})

// ---------------------------------------------------------------- 强度与闭嘴时长

test('closeMinutes：强收线睡到起床点（返回 0）', () => {
  assert.equal(closeMinutes({}, 'strong', '晚安'), 0)
})

test('closeMinutes：午睡类词用午睡时长', () => {
  const minutes = closeMinutes({ noonMuteMinutes: 75 }, 'medium', '眯一会儿')
  assert.equal(minutes, 75)
})

test('closeMinutes：普通中/弱收线用 bye 时长', () => {
  assert.equal(closeMinutes({ byeMuteMinutes: 30 }, 'medium', '拜拜'), 30)
  // 没配就用默认 30
  assert.equal(closeMinutes({}, 'weak', '嗯'), 30)
})

// ---------------------------------------------------------------- isAskingMe

test('问「你睡了吗」是问句，不是收线', () => {
  assert.equal(isAskingMe('你睡了吗'), true)
  assert.equal(isAskingMe('你还醒着吗'), true)
  assert.equal(isAskingMe('我要睡了'), false)
})

// ---------------------------------------------------------------- 词表完整性

test('三档词表都不为空且没有空串', () => {
  for (const [name, list] of [['STRONG', STRONG], ['MEDIUM', MEDIUM], ['WEAK', WEAK]]) {
    assert.ok(list.length > 0, `${name} 不能是空的`)
    assert.ok(list.every((w) => typeof w === 'string' && w.trim()), `${name} 里不能有空项`)
  }
})

// ---------------------------------------------------------------- 自定义词表

test('配置可以覆盖词表，覆盖后原词表不生效', () => {
  const cfg = { closeStrong: ['去睡觉觉'] }
  assert.deepEqual(matchStrength('去睡觉觉啦', cfg), ['strong', '去睡觉觉'])
  // 覆盖后「晚安」不再命中 —— 这是配置的语义，不是 bug
  assert.deepEqual(matchStrength('晚安', cfg), ['', ''])
})
