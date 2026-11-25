// 价格监控的核心逻辑测试：价格解析、指纹、好价判定、匹配、提醒判断。
// 不联网、不依赖宿主，跑 node --test。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePrice, formatPrice, productKey, scoreRate, heatScore,
  qualityOf, matchScore, pickCandidates, evaluateAlert, relevanceOf, rankResults, splitQuery, broadenKeyword,
  pruneRecords, retryIntervalMs, dueWatches, FAIL_BACKOFF_MAX_MS,
} from '../lib/core.mjs'

test('价格解析：只取售价，跳过返还额、满减门槛、原价', () => {
  assert.equal(parsePrice('139元'), 139)
  assert.equal(parsePrice('165.6元（需用券）'), 165.6)
  assert.equal(parsePrice('68.52元（需买2件，共137.04元）'), 68.52, '取单价而不是总价')
  assert.equal(parsePrice('3590元（淘金币可抵25元起）'), 3590, '抵扣额不是售价')
  assert.equal(parsePrice('119.9元（返240积分）'), 119.9)
  assert.equal(parsePrice('原价299元，现价199元'), 199, '原价不算')
  assert.equal(parsePrice('满300元减50元'), null, '门槛不是售价')
  assert.equal(parsePrice(''), null)
  assert.equal(parsePrice('价格未知'), null)
  assert.equal(parsePrice(undefined), null)
})

test('价格展示：保留两位以内小数', () => {
  assert.equal(formatPrice(19.9), '19.9')
  assert.equal(formatPrice(19.999), '20')
  assert.equal(formatPrice(null), '—')
  assert.equal(formatPrice('abc'), '—')
})

test('商品指纹：同一件商品的不同爆料归一到同一个 key', () => {
  const a = productKey('移动端：德龙 Delonghi 全自动咖啡机 白色')
  const b = productKey('德龙 Delonghi 全自动咖啡机 白色（需用券）')
  assert.equal(a, b)
  assert.equal(productKey('立白 洗衣液 24斤'), productKey('立白洗衣液24斤（Plus会员）'))
  assert.equal(productKey('短'), '', '太短的不参与历史价比较')
  assert.ok(productKey('任天堂 Switch 2 标准版').includes('switch'))
})

test('综合分与值票支持率', () => {
  assert.equal(heatScore({ comments: 10, collection: 5, worthy: 8 }), 48)
  assert.equal(scoreRate(8, 2), 0.8)
  assert.equal(scoreRate(0, 0), null)
})

test('超级好价：评论、值、收藏、综合分、支持率都要够', () => {
  // 30 条评论 + 20 值 + 10 收藏 = 综合分 130，够 120
  const hit = qualityOf({ comments: 30, worthy: 20, collection: 10, unworthy: 1 })
  assert.equal(hit.quality, 'super')
  assert.equal(hit.label, '超级好价')
  // 评论不到 20 够不上超级好价，但其余门槛都过，落在早期好价
  assert.equal(qualityOf({ comments: 19, worthy: 20, collection: 10 }).quality, 'early')
  assert.equal(qualityOf({ comments: 30, worthy: 20, collection: 9 }).quality, 'early', '收藏不到 10，够不上超级好价，但够早期好价')
  // 评论差不多但综合分不到 120：降级成早期好价，而不是「超级」
  assert.equal(qualityOf({ comments: 20, worthy: 20, collection: 10 }).quality, 'early')
})

test('早期好价：值 ≥4、评论 ≥6、收藏 ≥4、互动 ≥16、综合分 ≥35、支持率 ≥95%', () => {
  assert.equal(qualityOf({ comments: 9, worthy: 4, collection: 4 }).quality, 'early', '综合分 39、互动 17')
  assert.equal(qualityOf({ comments: 6, worthy: 4, collection: 4 }).quality, '', '综合分只有 30，不够 35')
  assert.equal(qualityOf({ comments: 9, worthy: 4, collection: 3 }).quality, '', '收藏不到 4')
  assert.equal(qualityOf({ comments: 9, worthy: 3, collection: 4 }).quality, '', '值票不到 4')
  // 2 个不值就把支持率压到 95% 以下
  assert.equal(qualityOf({ comments: 9, worthy: 4, collection: 4, unworthy: 2 }).quality, '')
})

test('小样本例外：6 值 1 不值按 85% 算，不该被 95% 门槛一票否决', () => {
  assert.equal(qualityOf({ comments: 9, worthy: 6, collection: 4, unworthy: 1 }).quality, 'early')
  // 但 2 个不值就不享受例外
  assert.equal(qualityOf({ comments: 9, worthy: 6, collection: 4, unworthy: 2 }).quality, '')
})

test('售罄、过期、信号太弱的都不算好价', () => {
  assert.equal(qualityOf({ comments: 30, worthy: 30, collection: 20, soldOut: true }).quality, '')
  assert.equal(qualityOf({ comments: 30, worthy: 30, collection: 20, ended: true }).quality, '')
  assert.equal(qualityOf({ comments: 1, worthy: 1, collection: 1 }).quality, '')
  assert.equal(qualityOf({}).quality, '')
})

test('查询匹配：中文整串与英文词边界', () => {
  assert.ok(matchScore('switch 2', '任天堂 Nintendo Switch 2 港版 标准版') > 0.8)
  assert.ok(matchScore('索尼降噪耳机', '索尼 WH-1000XM5 头戴式无线降噪耳机') > 0.6)
  assert.ok(matchScore('咖啡机', '德龙 全自动咖啡机') >= 0.9)
  assert.equal(matchScore('显卡', '立白洗衣液'), 0)
  assert.equal(matchScore('', '任何标题'), 0)
})

test('品牌中英对照：说拓竹，标题写 Bambu Lab 也算命中', () => {
  assert.ok(matchScore('拓竹 A1', 'Bambu Lab A1 3D打印机 单机版') >= 0.9)
  assert.ok(matchScore('拓竹', 'Bambu Lab A1 mini 3D打印机') >= 0.9)
  assert.ok(matchScore('Bambu Lab A1', '拓竹 A1 3D打印机') >= 0.9, '反过来也认')
  assert.ok(matchScore('红米 K80', 'REDMI 红米 K80 5G手机') >= 0.9)
  assert.ok(matchScore('任天堂 switch', 'Nintendo Switch 2 港版') >= 0.9)
  // 不相干的品牌不能靠别名蹭上
  assert.equal(matchScore('索尼 耳机', 'Bambu Lab A1 3D打印机'), 0)
})

test('型号按边界判断：A1 不被 A1C / A1mini / A2L 蹭到，A1 Pro 算同系列', () => {
  assert.equal(matchScore('拓竹 A1', 'Bambu Lab A1 3D打印机 单机版').toFixed(2), '1.00')
  assert.equal(matchScore('拓竹 A1', 'Bambu Lab A1 热卖 3D打印机 整机').toFixed(2), '1.00', '型号后面跟中文不算另一个型号')
  // 另一个 SKU：压在弱相关线以下，别进强候选
  for (const title of ['Bambu Lab A1C 3D打印机', 'Bambu Lab A1mini 打印机', 'Bambu Lab A2L 3D打印机']) {
    const score = matchScore('拓竹 A1', title)
    assert.ok(score < 0.6, JSON.stringify(title) + ' 不该算强相关，实际 ' + score.toFixed(2))
  }
  // 同系列的另一个版本：算候选，但不是同一件商品，别拿它的价格冒充
  const variant = matchScore('拓竹 A1', '拓竹 A1 Pro 3D打印机')
  assert.ok(variant >= 0.6 && variant < 1, 'A1 Pro 是候选，不是同一个：' + variant)
  assert.ok(matchScore('红米 K80', '红米 K80 Pro 5G手机') >= 0.6, 'K80 Pro 是同系列，算候选')
})

test('粘连写法：拓竹A1 / 红米K80 / 索尼WH-1000XM5 都拆得开', () => {
  assert.deepEqual(splitQuery('拓竹A1'), ['拓竹', 'a1'])
  assert.deepEqual(splitQuery('拓竹 A1'), ['拓竹', 'a1'])
  assert.deepEqual(splitQuery('红米K80'), ['红米', 'k80'])
  assert.deepEqual(splitQuery('索尼WH-1000XM5'), ['索尼', 'wh1000xm5'])
  assert.deepEqual(splitQuery('switch 2'), ['switch', '2'])
  assert.deepEqual(splitQuery('  '), [])
  // 关键：不加空格也要能认出整机，而不是只匹配到「适用拓竹A1」的耗材
  assert.equal(matchScore('拓竹A1', 'Bambu Lab A1 3D打印机 单机版').toFixed(2), '1.00')
  assert.equal(matchScore('拓竹A1', 'kaaber 3D打印耗材 适用拓竹A1').toFixed(2), '1.00')
  const items = [
    { title: 'Bambu Lab A1 3D打印机 单机版', price: 872 },
    { title: 'kaaber 3D打印耗材 适用拓竹A1', price: 18 },
  ]
  assert.equal(rankResults('拓竹A1', items, 3).picked[0].price, 872, '整机排在耗材前面')
  assert.equal(rankResults('拓竹A1', items, 3).hasMain, true)
})

test('只搜到配件时：hasMain=false、onlyAccessory=true，不能当成「最低价」', () => {
  const parts = [
    { title: 'kaaber 3D打印耗材 适用拓竹A1', price: 18 },
    { title: 'Bambu Lab 纹理PEI打印板 配件', price: 17 },
  ]
  const out = rankResults('拓竹 A1', parts, 3)
  assert.equal(out.hasMain, false)
  assert.equal(out.onlyAccessory, true)
  assert.equal(out.weak, false, '相关是相关的，只是全是周边')
})

test('broadenKeyword：拆出型号单独再搜，没有型号就不重搜', () => {
  assert.equal(broadenKeyword('拓竹 A1'), 'a1')
  assert.equal(broadenKeyword('拓竹A1'), 'a1')
  assert.equal(broadenKeyword('红米 K80 Pro'), 'k80')
  assert.equal(broadenKeyword('咖啡机'), '')
})

test('相关度分层：配件 / 耗材不进「强相关且是商品」这一层', () => {
  const printer = relevanceOf('拓竹 A1', { title: 'Bambu Lab A1 3D打印机 单机版' })
  const part = relevanceOf('拓竹 A1', { title: 'Bambu Lab 纹理PEI打印板 3D打印机配件' })
  const filament = relevanceOf('拓竹 A1', { title: 'kaaber 3D打印耗材 PETG 适用拓竹A1' })
  assert.equal(printer.tier, 2)
  assert.equal(part.tier <= 1, true)
  assert.equal(filament.tier <= 1, true)
  // 查询自己带了「打印板」，就不再把打印板当配件降权
  assert.equal(relevanceOf('拓竹 打印板', { title: 'Bambu Lab 纹理PEI打印板' }).tier, 2)
})

test('排序：先像不像这件商品，同层再比价格（便宜的配件不能顶掉主商品）', () => {
  const items = [
    { title: 'kaaber 3D打印耗材 PETG 适用拓竹A1', price: 18.77 },
    { title: 'Bambu Lab 纹理PEI打印板 配件', price: 17 },
    { title: 'Bambu Lab A1 3D打印机 单机版', price: 1449 },
    { title: 'Bambu Lab A1 3D打印机 单机版 需用券', price: 1395 },
  ]
  const out = rankResults('拓竹 A1', items, 3)
  assert.equal(out.weak, false)
  assert.equal(out.picked[0].price, 1395, '主商品里最便宜的排第一')
  assert.equal(out.picked[1].price, 1449)
  assert.ok(out.picked[0].accessory !== true)
})

test('排序：没有强相关结果时老实标成 weak，不假装是这件商品', () => {
  const out = rankResults('完全不存在的型号 X9', [
    { title: 'Bambu Lab A1 3D打印机', price: 1449 },
  ], 3)
  assert.equal(out.weak, true)
  assert.equal(out.picked.length, 1, '弱相关也给候选，但文案要说清楚')
})

test('匹配候选：唯一命中直接选中，多个命中和无命中都给候选项', () => {
  const items = [
    { title: '任天堂 Switch 2 标准版 港版', price: 3200, mall: '京东', key: 'a' },
    { title: '任天堂 Switch 2 收纳包', price: 39, mall: '天猫', key: 'b' },
    { title: '立白 洗衣液', price: 39, mall: '京东', key: 'c' },
  ]
  const one = pickCandidates('switch 2', items)
  assert.equal(one.kind, 'many')
  assert.equal(one.options.length, 2)
  const none = pickCandidates('显示器 4K', items)
  assert.equal(none.kind, 'none')
  assert.equal(none.options.length, 0, '完全不相关不给候选')
  const singleList = [{ title: '德龙 全自动咖啡机', price: 3000, mall: '天猫', key: 'd' }]
  assert.equal(pickCandidates('咖啡机', singleList).kind, 'one')
})

test('同款不同爆料只算一件商品', () => {
  const items = [
    { title: '立白 洗衣液 24斤（需用券）', price: 39, mall: '京东' },
    { title: '移动端：立白 洗衣液 24斤', price: 35, mall: '天猫' },
    { title: '立白 洗衣液 24斤', price: 45, mall: '拼多多' },
  ]
  const key = productKey('立白 洗衣液 24斤')
  const same = items.map((i) => ({ ...i, key: productKey(i.title) || key }))
  const picked = pickCandidates('立白 洗衣液 24斤', same)
  assert.equal(picked.kind, 'one')
  assert.equal(picked.item.price, 35, '同款里挑最便宜的')
})

test('降价提醒：达到百分比或金额才算', () => {
  const prev = { price: 100, lowest: 90 }
  assert.equal(evaluateAlert(prev, 95, { dropPercent: 5, dropAmount: 0 }).alert, true, '正好 5%')
  assert.equal(evaluateAlert(prev, 96, { dropPercent: 5, dropAmount: 0 }).alert, false, '只降了 4%')
  assert.equal(evaluateAlert(prev, 94, { dropPercent: 0, dropAmount: 5 }).alert, true, '只按金额：降 6 元')
  assert.equal(evaluateAlert(prev, 96, { dropPercent: 0, dropAmount: 5 }).alert, false, '只按金额：降 4 元')
  assert.deepEqual(evaluateAlert(prev, 95, { dropPercent: 5, dropAmount: 0 }).reasons, ['降价'])
})

test('降价提醒：创新低也提醒，涨价不提醒', () => {
  const prev = { price: 100, lowest: 90 }
  const low = evaluateAlert(prev, 88, { dropPercent: 5, dropAmount: 5 })
  assert.equal(low.alert, true)
  assert.ok(low.reasons.includes('历史最低'))
  assert.equal(evaluateAlert(prev, 120, { dropPercent: 5, dropAmount: 5 }).alert, false, '涨价不提醒')
  assert.equal(evaluateAlert(prev, 99, { dropPercent: 5, dropAmount: 5 }).alert, false, '小幅波动不提醒')
  assert.equal(evaluateAlert(prev, 92, { dropPercent: 0, dropAmount: 0 }).alert, false, '没设阈值、也没创新低就不提醒')
  assert.equal(evaluateAlert(prev, 70, { dropPercent: 0, dropAmount: 0 }).alert, true, '没设阈值也可能创新低')
  assert.equal(evaluateAlert(null, 88, { dropPercent: 5, dropAmount: 5 }).alert, false, '第一次看到不算降价')
  assert.equal(evaluateAlert({ price: 100 }, 88, { dropPercent: 5, dropAmount: 5 }).alert, true, '没有最低价记录时按降价算')
})

test('降价提醒：价格无效时不报成功', () => {
  assert.equal(evaluateAlert({ price: 100, lowest: 90 }, null).alert, false)
  assert.equal(evaluateAlert({ price: 100, lowest: 90 }, 0).alert, false)
  assert.equal(evaluateAlert({ price: 100, lowest: 90 }, NaN).alert, false)
})

test('记录表 LRU：超出上限时先淘汰最久没碰过的商品指纹', () => {
  const records = {
    a: { lowest: 100, lowestAt: 1000, lastSeen: 3000 },
    b: { lowest: 200, lowestAt: 2000, lastSeen: 1000 },
    c: { lowest: 300, lowestAt: 3000, lastSeen: 2000 },
  }
  pruneRecords(records, 2)
  assert.deepEqual(Object.keys(records).sort(), ['a', 'c'])
  assert.equal(records.b, undefined, 'lastSeen 最旧的那条被淘汰')
  const small = { only: { lastSeen: 1 } }
  assert.equal(pruneRecords(small, 5), small, '不到上限时原对象不动')
  assert.deepEqual(pruneRecords(null, 3), {})
  const noSeen = { x: { lowestAt: 10 }, y: { lowestAt: 20 } }
  pruneRecords(noSeen, 1)
  assert.deepEqual(Object.keys(noSeen), ['y'], '没有 lastSeen 时回落到 lowestAt')
})

test('失败退避：间隔翻倍，最长 6 小时；正常间隔本身更长时不缩短', () => {
  assert.equal(retryIntervalMs(60, 0), 3600000)
  assert.equal(retryIntervalMs(60, 1), 7200000)
  assert.equal(retryIntervalMs(60, 2), 14400000)
  assert.equal(retryIntervalMs(60, 3), FAIL_BACKOFF_MAX_MS, '8 小时被 6 小时封顶')
  assert.equal(retryIntervalMs(10, 10), FAIL_BACKOFF_MAX_MS)
  assert.equal(retryIntervalMs(1440, 3), 86400000, '24 小时正常间隔不该被 6 小时上限压短')
  assert.equal(retryIntervalMs(60, -5), 3600000, '负失败次数按 0 处理')
})

test('到期挑选：按 lastCheck 最旧优先，失败过的按退避顺延，最多取 N 条', () => {
  const now = 10_000_000_000
  const watches = [
    { id: 'new', lastCheck: now - 60_000 },
    { id: 'old', lastCheck: now - 3 * 3600_000 },
    { id: 'mid', lastCheck: now - 2 * 3600_000 },
    { id: 'failed', lastCheck: now - 3 * 3600_000, failCount: 2 },
    { id: 'never', lastCheck: 0 },
  ]
  const due = dueWatches(watches, { now, intervalMinutes: 60, max: 3 })
  assert.deepEqual(due.map((w) => w.id), ['never', 'old', 'mid'], '失败退避中的 failed 不占名额')
  assert.equal(due.length, 3, '每轮仍有上限')
  const manual = dueWatches(watches, { now, intervalMinutes: 60, max: 2, force: true })
  assert.deepEqual(manual.map((w) => w.id), ['never', 'old'], '手动强制不看间隔，但仍按最旧优先并截断')
  assert.deepEqual(dueWatches(watches, { now, only: 'failed', intervalMinutes: 60, max: 5 }).map((w) => w.id), ['failed'], 'only 精确取一条，不受退避影响')
  assert.deepEqual(dueWatches(watches, { now, only: 'nope' }), [])
})
