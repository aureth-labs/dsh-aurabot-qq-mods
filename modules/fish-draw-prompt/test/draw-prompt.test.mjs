// fish-draw-prompt 的单元测试
//
// 重点测 parseDrawAnswer —— 它的输入是模型自由生成的文本，最容易出问题：
//   · 她按三行回了
//   · 她只回了描述（没按格式）
//   · 她说「没有我自己」
//   · 参考图写成了 三视图:3 或者带全角冒号
//   · 空串、null、只有标记行
//
// buildDrawPrompt 主要测结构（三步走在、用途在前、关键特征在、三个 scene 的差异）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDrawPrompt, parseDrawAnswer, ANCHOR } from '../lib/draw-prompt.js'

// ── parseDrawAnswer ────────────────────────────────────────────────

test('parseDrawAnswer：标准三行（画自己）', () => {
  const r = parseDrawAnswer([
    '这张画：有我自己',
    '参考图：self:3',
    '画面：傍晚坐在窗边看雨，穿米白开衫，台灯暖光',
  ].join('\n'))
  assert.equal(r.hasSelf, true)
  assert.equal(r.ref, 'self:3')
  assert.equal(r.prompt, '傍晚坐在窗边看雨，穿米白开衫，台灯暖光')
})

test('parseDrawAnswer：两行（不画自己）', () => {
  const r = parseDrawAnswer([
    '这张画：没有我自己',
    '画面：雨后的老巷子，青石板积着水',
  ].join('\n'))
  assert.equal(r.hasSelf, false)
  assert.equal(r.ref, null)
  assert.equal(r.prompt, '雨后的老巷子，青石板积着水')
})

test('parseDrawAnswer：她没按格式，只有一段描述 → 当纯文字，不乱猜', () => {
  const r = parseDrawAnswer('画一只淋湿的猫蹲在屋檐下，毛发一绺一绺的')
  assert.equal(r.hasSelf, false)
  assert.equal(r.ref, null)
  assert.equal(r.prompt, '画一只淋湿的猫蹲在屋檐下，毛发一绺一绺的')
})

test('parseDrawAnswer：空串 / null / undefined', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = parseDrawAnswer(v)
    assert.equal(r.hasSelf, false)
    assert.equal(r.ref, null)
    assert.equal(r.prompt, '')
  }
})

test('parseDrawAnswer：全角冒号也认', () => {
  const r = parseDrawAnswer('这张画：有我自己\n参考图：self:2\n画面：趴在桌上发呆')
  assert.equal(r.hasSelf, true)
  assert.equal(r.ref, 'self:2')
  assert.equal(r.prompt, '趴在桌上发呆')
})

test('parseDrawAnswer：参考图写成「三视图:3」或「我自己」', () => {
  const a = parseDrawAnswer('这张画：有我自己\n参考图：三视图:3\n画面：站着')
  assert.equal(a.ref, '三视图:3')
  const b = parseDrawAnswer('这张画：有我自己\n参考图：我自己\n画面：站着')
  assert.equal(b.ref, '我自己')
})

test('parseDrawAnswer：标记行不会留在描述里', () => {
  const r = parseDrawAnswer('这张画：有我自己\n参考图：self:1\n画面：坐在桌前')
  assert.equal(r.prompt.includes('这张画'), false)
  assert.equal(r.prompt.includes('参考图'), false)
  assert.equal(r.prompt.includes('self'), false)
})

test('parseDrawAnswer：只有标记行、没有描述 → prompt 为空', () => {
  const r = parseDrawAnswer('这张画：有我自己\n参考图：self:2')
  assert.equal(r.hasSelf, true)
  assert.equal(r.prompt, '')
})

test('parseDrawAnswer：描述超长会被截到 400 字', () => {
  const r = parseDrawAnswer('画面：' + 'x'.repeat(1000))
  assert.equal(r.prompt.length, 400)
})

test('parseDrawAnswer：外面套了引号会剥掉', () => {
  const r = parseDrawAnswer('「画面：坐在窗边」')
  assert.equal(r.prompt, '坐在窗边')
})

// ── buildDrawPrompt ───────────────────────────────────────────────

test('buildDrawPrompt：三个 scene 都带三步走和关键特征', () => {
  for (const scene of ['chat', 'avatar', 'qzone']) {
    const p = buildDrawPrompt({ scene })
    assert.ok(p.includes('第一步：这张画里有你自己吗'), scene + ' 缺第一步')
    assert.ok(p.includes('第二步（只有选了 A 才做）'), scene + ' 缺第二步')
    assert.ok(p.includes('第三步：写画面描述'), scene + ' 缺第三步')
    assert.ok(p.includes('鲸鱼大尾巴'), scene + ' 缺关键特征')
    assert.ok(p.includes('不用每个都写'), scene + ' 没说不用全写')
  }
})

test('buildDrawPrompt：用途段排在三步走之前', () => {
  for (const scene of ['chat', 'avatar', 'qzone']) {
    const p = buildDrawPrompt({ scene })
    const purpose = p.search(/先[说想]清[楚]?这张图是拿来干什么的/)
    const step1 = p.indexOf('第一步：这张画里有你自己吗')
    assert.ok(purpose >= 0, scene + ' 缺用途段')
    assert.ok(purpose < step1, scene + ' 用途段没排在三步走前面')
  }
})

test('buildDrawPrompt：换头像不规定主体（她头像可以是一只猫）', () => {
  for (const scene of ['chat', 'avatar']) {
    const p = buildDrawPrompt({ scene })
    // 不许出现无条件的「脸占大一点」
    assert.equal(/：换头像 —— 脸(要)?占/.test(p), false)
    assert.equal(/· 换头像 —— 脸(要)?占/.test(p), false)
    // 必须有「画人就…画别的就…」的分支
    assert.ok(p.includes('画人就让脸占大'), scene + ' 缺条件分支')
  }
})

test('buildDrawPrompt：四张参考图都列出来了', () => {
  const p = buildDrawPrompt({ scene: 'avatar' })
  for (const r of ['self:1', 'self:2', 'self:3', 'self:4']) {
    assert.ok(p.includes(r), '没列 ' + r)
  }
})

test('buildDrawPrompt：context 排在用途段之前', () => {
  const p = buildDrawPrompt({
    scene: 'avatar',
    context: ['你要给自己换个头像。', '· 此刻心情 70 分'],
  })
  assert.ok(p.startsWith('你要给自己换个头像。'))
  assert.ok(p.indexOf('此刻心情 70 分') < p.search(/先[说想]清[楚]?这张图是拿来干什么的/))
})

test('buildDrawPrompt：wantParseFormat 才给三行格式', () => {
  const withFmt = buildDrawPrompt({ scene: 'avatar', wantParseFormat: true })
  const without = buildDrawPrompt({ scene: 'chat' })
  assert.ok(withFmt.includes('这张画：有我自己'))
  assert.equal(without.includes('这张画：有我自己'), false)
})

test('buildDrawPrompt：不许再出现「长相不用写」这条错误规则', () => {
  for (const scene of ['chat', 'avatar', 'qzone']) {
    const p = buildDrawPrompt({ scene })
    assert.equal(/长相[^\n]{0,10}不用写/.test(p), false, scene)
  }
})

test('buildDrawPrompt：不许再出现「画面里没有人物」（错误归因，已删）', () => {
  for (const scene of ['chat', 'avatar', 'qzone']) {
    const p = buildDrawPrompt({ scene })
    assert.equal(p.includes('画面里只有它，没有人物'), false, scene)
    assert.equal(p.includes('自己塞人进来'), false, scene)
  }
})

test('buildDrawPrompt：unknown scene 退回 chat 的用途段（不报错）', () => {
  const p = buildDrawPrompt({ scene: 'nonsense' })
  assert.ok(p.length > 500)
  assert.ok(p.includes('第一步：这张画里有你自己吗'))
})

test('buildDrawPrompt：不传参数也不报错', () => {
  const p = buildDrawPrompt()
  assert.ok(p.length > 500)
})

// ── ANCHOR ───────────────────────────────────────────────────────

test('ANCHOR 含全部五个关键特征', () => {
  for (const k of ['深海蓝渐变长发', '头顶呆毛', '鲸鱼鳍状耳朵', '鲸鱼大尾巴', '蓝色大眼睛']) {
    assert.ok(ANCHOR.includes(k), 'ANCHOR 缺 ' + k)
  }
})
