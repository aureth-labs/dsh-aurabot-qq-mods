import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

function fakeApi({ owner = '10001', askImpl, settingsOverrides = {}, withRefs = true } = {}) {
  const settingsMap = { ...mod.defaults, ...settingsOverrides }
  const handlers = {}
  const routes = {}
  const logs = []
  const dir = mkdtempSync(join(tmpdir(), 'love-mode-'))
  if (withRefs) {
    const refsDir = join(dir, 'assets', 'refs')
    mkdirSync(refsDir, { recursive: true })
    writeFileSync(join(refsDir, '巧妙接话技巧：让沟通更流畅的实用指南.md'), '# 接话参考内容')
    writeFileSync(join(refsDir, '为他人提供情绪价值：温暖且有效的回应指南.md'), '# 情绪参考内容')
    writeFileSync(join(refsDir, '实战话术编排器：从一句回复到后续分支.md'), '# 话术参考内容')
    writeFileSync(join(refsDir, '场景感、松弛感与社交校准：从接话到关系推进.md'), '# 场景参考内容')
  }
  const api = {
    config: () => ({ ownerQQ: owner }),
    settings: () => ({ ...settingsMap }),
    saveSettings: (patch) => Object.assign(settingsMap, patch),
    dataDir: (...p) => join(dir, ...p),
    dir,
    log: { info: (s) => logs.push(String(s)), warn: (s) => logs.push('WARN ' + String(s)) },
    context: (fn) => { handlers.context = fn },
    route: (p, fn) => { routes[p] = fn },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
    later: () => {},
    ask: askImpl || (async () => { throw new Error('无模型') }),
    has: () => false,
    use: () => null,
    core: {
      hub: { lastTextOf: () => '你今天吃了吗' },
      http: { body: (req) => req?.body || {} } // 与插件核心一致：body(req) 返回已解析对象
    },
    __test: { handlers, routes, settingsMap, logs, dir }
  }
  return api
}

const OWNER_CHAT = { kind: 'private', userId: '10001', chatId: 'private:10001' }

test('preset mode: dating 注入基调/行为特征/四个技能', async () => {
  const api = fakeApi()
  mod.setup(api)
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's1' })
  assert.match(ctx, /【现在时间】/)
  assert.match(ctx, /【相处模式：单身约会】/)
  assert.match(ctx, /好奇而非审讯/)
  assert.match(ctx, /【行为特征】适度幽默；适度主动；适度走心/)
  assert.match(ctx, /· 接话延伸/)
  assert.match(ctx, /· 情绪感知/)
  assert.match(ctx, /· 调侃张力/)
  assert.match(ctx, /· 主动框架/)
  // 军师链在无模型时降级为关键词路径，且必须记日志
  assert.match(ctx, /【对话技巧参考】/)
  const log = await api.__test.routes['/skill-log']({})
  assert.equal(log.ok, true)
  assert.equal(log.items.length, 1)
  assert.equal(log.items[0].kind, 'fallback')
})

test('mode 切换: marriage 用婚姻基调并换技能组，滑块被 /set-mode 重置', async () => {
  const api = fakeApi()
  mod.setup(api)
  const r = api.__test.routes['/set-mode']({ url: '/set-mode?mode=marriage' })
  assert.equal(r.ok, true)
  assert.equal(r.modeName, '婚姻')
  assert.equal(api.__test.settingsMap.relationMode, 'marriage')
  assert.equal(api.__test.settingsMap.humorLevel, 50) // 婚姻默认 50
  assert.equal(api.__test.settingsMap.personaTone, '') // 基调覆盖被清空
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's2' })
  assert.match(ctx, /【相处模式：婚姻】/)
  assert.match(ctx, /过日子的默契/)
  assert.match(ctx, /· 情绪感知/)
  assert.doesNotMatch(ctx, /· 接话延伸/) // marriage 技能组不含 extend
})

test('自定义模式: create → 选中后注入自建基调与自带滑块 → delete 回退 dating', async () => {
  const api = fakeApi()
  mod.setup(api)
  const created = api.__test.routes['/custom-modes']({
    url: '/custom-modes?action=create',
    body: { name: '暧昧模式', tone: '话里有话，彼此试探' }
  })
  assert.equal(created.ok, true)
  assert.match(created.modeKey, /^c_/)
  api.__test.routes['/set-mode']({ url: '/set-mode?mode=' + created.modeKey })
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's3' })
  assert.match(ctx, /【相处模式：暧昧模式】/)
  assert.match(ctx, /话里有话，彼此试探/)
  assert.match(ctx, /【行为特征】适度幽默；适度主动；适度走心/) // 自建默认 65/55/50
  // 更新滑块
  const up = api.__test.routes['/custom-modes']({ url: '/custom-modes', body: { action: 'update', id: created.id, humor: 95, depth: 10 } })
  assert.equal(up.ok, true)
  const ctx2 = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's4' })
  assert.match(ctx2, /幽默感强/)
  assert.match(ctx2, /走心偏少/)
  // 删除正在使用的模式 → 回退 dating
  const del = api.__test.routes['/custom-modes']({ url: '/custom-modes', body: { action: 'delete', id: created.id } })
  assert.equal(del.ok, true)
  assert.equal(api.__test.settingsMap.relationMode, 'dating')
})

test('军师链成功路径: 注入意图/思路/知识库，30 秒内同文去重只调一次模型', async () => {
  let askCount = 0
  const askImpl = async () => {
    askCount++
    return JSON.stringify({
      intent: '他在找话题', emotion: '轻松',
      candidates: [{ strategy: '接住并反问', why: '延续话题', kb: 1 }],
      best: 0, guidance: '顺着吃的话题往下聊，反问一句他吃了什么'
    })
  }
  const api = fakeApi({ askImpl })
  mod.setup(api)
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's5' })
  assert.match(ctx, /【军师分析·幕后】他的意图：他在找话题；情绪：轻松/)
  assert.match(ctx, /【回复思路】顺着吃的话题/)
  assert.match(ctx, /【知识库·巧妙接话技巧/)
  assert.match(ctx, /# 接话参考内容/)
  assert.match(ctx, /不要提及军师/)
  // 第二次同文调用走缓存
  await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's5' })
  assert.equal(askCount, 1)
  const log = await api.__test.routes['/skill-log']({})
  assert.equal(log.items[0].kind, 'advisor')
  assert.equal(log.items[0].kbName.includes('巧妙接话'), true)
  // 日志去重：5 秒内同文不翻倍
  assert.equal(log.items.length, 1)
})

test('军师链返回无效 JSON → 降级关键词路径且聊天不受影响', async () => {
  const api = fakeApi({ askImpl: async () => '这不是 JSON' })
  mod.setup(api)
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's6' })
  assert.match(ctx, /【现在时间】/)
  assert.match(ctx, /【对话技巧参考】/)
  const log = await api.__test.routes['/skill-log']({})
  assert.equal(log.items[0].kind, 'fallback')
  assert.ok(log.items[0].error)
})

test('降级路径关键词命中: 情绪词命中情绪感知，闲聊兜底接话延伸', async () => {
  const api = fakeApi({ askImpl: async () => { throw new Error('无模型') } })
  api.core.hub.lastTextOf = () => '今天心情好难过'
  mod.setup(api)
  await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's7' })
  let log = await api.__test.routes['/skill-log']({})
  assert.deepEqual(log.items[0].tags, ['情绪感知'])
  assert.equal(log.items[0].fallback, false)
  // 闲聊：兜底
  api.core.hub.lastTextOf = () => '吃了吗'
  await new Promise(r => setTimeout(r, 10)) // 让 entry.t 递增
  // 等过去 5 秒去重窗口太久，改 user 文本即可绕过同文去重
  await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's8' })
  log = await api.__test.routes['/skill-log']({})
  assert.equal(log.items[0].tags.includes('接话延伸'), true)
  assert.equal(log.items[0].fallback, true)
})

test('画像注入: 双方 MBTI/优势/短板进上下文；关系声明开关', async () => {
  const api = fakeApi({
    settingsOverrides: {
      herMbti: 'INFP', herStrengths: '慢热真诚', herWeaknesses: '嘴笨易紧张',
      userMbti: 'INTJ', userStrengths: '直接', userWeaknesses: '话少',
      userGender: 'male', relationNature: 'straight'
    }
  })
  mod.setup(api)
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's9' })
  assert.match(ctx, /【她的画像】MBTI INFP；优势：慢热真诚；短板：嘴笨易紧张/)
  assert.match(ctx, /【他的画像】MBTI INTJ；优势：直接；短板：话少/)
  assert.match(ctx, /【关系声明】他是男生，你们是异性关系/)
})

test('非主人/群聊/system：不跑军师链但仍注入时间+模式基调', async () => {
  let askCount = 0
  const api = fakeApi({ askImpl: async () => { askCount++; return '{}' } })
  mod.setup(api)
  const groupCtx = await api.__test.handlers.context({ chat: { kind: 'group', userId: '20002', chatId: 'group:1' }, sessionId: 'g1' })
  assert.match(groupCtx, /【现在时间】/)
  assert.match(groupCtx, /【相处模式：单身约会】/)
  assert.equal(askCount, 0)
  const sysCtx = await api.__test.handlers.context({ chat: { kind: 'system', chatId: 'system:x' }, sessionId: 'sys1' })
  assert.equal(sysCtx, '')
})

test('保险丝: 剥 HTML 标签 / DSML 残片 / ACP 标签，保留 aurabot 占位符', () => {
  const api = fakeApi()
  mod.setup(api)
  const replyHandlers = api.__test.handlers.reply
  const fuse = (t) => { let cur = t; for (const h of replyHandlers) { const r = h(cur); if (r === null) return null; if (typeof r === 'string') cur = r } return cur }
  assert.equal(fuse('<p>我想你了</p>'), '我想你了')
  assert.equal(fuse('好啊<br>晚上见'), '好啊晚上见')
  assert.equal(fuse('我都不好意思了</｜｜DSML｜｜ parameter>{" type="string"'), '我都不好意思了')
  assert.equal(fuse('<acp tokens="15" type="text">m01990 刚吃完饭'), '刚吃完饭')
  assert.equal(fuse('刚吃完饭 [sticker]'), '刚吃完饭 [sticker]') // 占位符不动
  assert.equal(fuse('❌ [ACP] stream error: broken'), null) // 整条是错误行 → 拦下
  assert.equal(fuse('正常的一句话'), '正常的一句话')
})

test('自动匹配: 有效 JSON 写入模式+双画像并套默认滑块；无效则报错保持现状', async () => {
  const goodAsk = async () => JSON.stringify({
    mode: 'ltr', reason: '聊天像老朋友',
    her: { mbti: 'INFP', strengths: '真诚', weaknesses: '慢热' },
    you: { mbti: 'ENFJ', strengths: '热情', weaknesses: '急' }
  })
  const api = fakeApi({ askImpl: goodAsk })
  mod.setup(api)
  const r = await api.__test.routes['/auto-match']({})
  assert.equal(r.ok, true)
  assert.equal(r.modeName, '长期伴侣')
  const sm = api.__test.settingsMap
  assert.equal(sm.relationMode, 'ltr')
  assert.equal(sm.herMbti, 'INFP')
  assert.equal(sm.userMbti, 'ENFJ')
  assert.equal(sm.humorLevel, 55) // ltr 默认
  assert.equal(sm.personaTone, '')
  // 无效返回
  const api2 = fakeApi({ askImpl: async () => '{"mode":"不存在"}' })
  mod.setup(api2)
  const r2 = await api2.__test.routes['/auto-match']({})
  assert.equal(r2.ok, false)
  assert.equal(api2.__test.settingsMap.relationMode, 'dating') // 保持默认
})

test('旧版单自定义模式迁移: relationMode=custom 转成 customModes 列表项', async () => {
  const api = fakeApi({ settingsOverrides: { relationMode: 'custom', customModeName: '老夫老妻', personaTone: '平淡是真', humorLevel: 40 } })
  mod.setup(api)
  const sm = api.__test.settingsMap
  assert.match(sm.relationMode, /^c_/)
  assert.equal(sm.customModes.length, 1)
  assert.equal(sm.customModes[0].name, '老夫老妻')
  assert.equal(sm.customModes[0].tone, '平淡是真')
  assert.equal(sm.customModes[0].humor, 40)
  const ctx = await api.__test.handlers.context({ chat: OWNER_CHAT, sessionId: 's10' })
  assert.match(ctx, /【相处模式：老夫老妻】/)
})

test('proactivityMultiplier 公式: 0.5 + p/100*1.5', () => {
  const api = fakeApi({ settingsOverrides: { proactivity: 60 } })
  const exp = mod.setup(api)
  assert.ok(Math.abs(exp.proactivityMultiplier() - 1.4) < 1e-9)
})
