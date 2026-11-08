// test/ax.test.mjs —— 无障碍树（AX）通道的离线测试。
//
// 为什么要有这条通道（2026-11-10 真机实测抖音直播页）：
//   粉丝团面板是 **Lynx canvas** 渲染的 —— 面板 iframe 里 32 个节点、一个文本节点都没有，
//   document.body.innerText 里也读不到「加入粉丝团」「送灯牌」这些字。
//   但 Chrome 的无障碍树里**有**，而且 DOM.getBoxModel 给的坐标就是页面坐标。
//   所以「读文字 + 拿坐标 + 直接点」是 Lynx 面板唯一能走的路。
//
// 这里不连浏览器：用假的 CDP / 假的页面把逻辑跑一遍。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAxNodes, axName, axRole, axRectFromQuad, axSig, AX_HIT_SRC, createAxReader } from '../lib/ax.mjs'

/* ---------- 小工具 ---------- */

const axNode = (name, role = 'StaticText', extra = {}) => ({
  nodeId: 'n' + Math.random().toString(36).slice(2, 8),
  role: { type: 'role', value: role },
  name: { type: 'computedString', value: name },
  backendDOMNodeId: extra.bid == null ? 1000 + Math.floor(Math.random() * 100000) : extra.bid,
  frameId: extra.frameId || 'F1',
  ignored: extra.ignored || false,
})

/** 在 Node 里跑 AX_HIT_SRC（它是给页面用的脚本，这里喂假 DOM） */
const runHit = (rect, opts = {}) => {
  const iframes = opts.iframes || []
  const doc = {
    querySelectorAll: (sel) => (sel === 'iframe' ? iframes : []),
    elementFromPoint: opts.elementFromPoint || (() => null),
  }
  const win = { scrollX: opts.sx || 0, scrollY: opts.sy || 0 }
  const fn = new Function('document', 'innerWidth', 'innerHeight', 'window', 'return (' + AX_HIT_SRC + ')(' + JSON.stringify(rect) + ')')
  return fn(doc, opts.vw || 2560, opts.vh || 1313, win)
}

/** 造一个 iframe 元素（getBoundingClientRect + 被 elementFromPoint 命中时返回自己） */
const fakeIframe = (left, top, width, height) => {
  const el = {
    tagName: 'IFRAME',
    className: '',
    _rect: { left, top, width, height, right: left + width, bottom: top + height },
    getBoundingClientRect() { return this._rect },
    contains() { return false },
  }
  el.contains = (n) => n === el
  return el
}

/* ---------- 纯函数 ---------- */

test('axName / axRole 取名字和角色', () => {
  assert.equal(axName(axNode('加入粉丝团')), '加入粉丝团')
  assert.equal(axName(null), '')
  assert.equal(axName({ name: { value: '  送灯牌  ' } }), '送灯牌')
  assert.equal(axRole(axNode('x', 'button')), 'button')
  assert.equal(axRole({}), '')
})

test('pickAxNodes：跳过 ignored、按关键词过滤、去掉重复', () => {
  const nodes = [
    axNode('加入粉丝团', 'StaticText', { bid: 1 }),
    axNode('加入粉丝团', 'StaticText', { bid: 2 }),
    axNode('送灯牌', 'button', { bid: 3 }),
    axNode('不要的', 'StaticText', { bid: 4, ignored: true }),
    axNode('粉丝团', 'StaticText', { bid: 5 }),
  ]
  const all = pickAxNodes(nodes)
  assert.equal(all.length, 3, '重复的按「角色+名字」去重')
  assert.deepEqual(all.map((n) => n.name), ['加入粉丝团', '送灯牌', '粉丝团'])
  const only = pickAxNodes(nodes, '送')
  assert.equal(only.length, 1)
  assert.equal(only[0].name, '送灯牌')
  assert.equal(only[0].backendNodeId, 3, 'backendNodeId 要带出来（后面要拿它取坐标）')
})

test('axRectFromQuad：四点框算外接矩形', () => {
  const r = axRectFromQuad([10, 20, 90, 20, 90, 40, 10, 40])
  assert.deepEqual(r, { x: 10, y: 20, w: 80, h: 20 })
  assert.equal(axRectFromQuad([1, 2, 3]), null)
  assert.equal(axRectFromQuad(null), null)
})

test('axSig：同名同位置同签名，挪动就变', () => {
  const a = { role: 'button', name: '送灯牌', x: 100, y: 200, w: 80, h: 30 }
  const b = { role: 'button', name: '送灯牌', x: 100, y: 200, w: 80, h: 30 }
  const c = { role: 'button', name: '送灯牌', x: 104, y: 200, w: 80, h: 30 }
  assert.equal(axSig(a), axSig(b))
  assert.notEqual(axSig(a), axSig(c))
})

/* ---------- 命中校验 ---------- */

test('AX_HIT_SRC：目标在面板 iframe 上 → 命中通过', () => {
  const frame = fakeIframe(1639, 8, 375, 1217)
  const r = runHit({ x: 1756, y: 1156, w: 87, h: 27 }, {
    iframes: [frame],
    elementFromPoint: () => frame,
  })
  assert.equal(r.ok, true)
  assert.equal(r.good, 9)
  assert.equal(r.owner, 0)
})

test('AX_HIT_SRC：这块位置不在任何面板上 → 挡住不点', () => {
  const r = runHit({ x: 2040, y: 116, w: 58, h: 20 }, { iframes: [] })
  assert.equal(r.ok, false)
  assert.equal(r.good, 0)
  assert.match(r.reason, /不在任何面板/)
})

test('AX_HIT_SRC：有别的遮罩盖在面板上 → 挡住不点', () => {
  const frame = fakeIframe(1639, 8, 375, 1217)
  const mask = { tagName: 'DIV', className: 'mask', contains: () => false }
  const r = runHit({ x: 1756, y: 1156, w: 87, h: 27 }, {
    iframes: [frame],
    elementFromPoint: () => mask,
  })
  assert.equal(r.ok, false)
  assert.equal(r.good, 0)
})

test('AX_HIT_SRC：页面滚动过 → 两种坐标解释都会试', () => {
  const frame = fakeIframe(1639, 8, 375, 1217)
  // AX 给的是页面坐标；页面滚了 300px → 视口坐标要减 300
  const r = runHit({ x: 1756, y: 1156, w: 87, h: 27 }, {
    iframes: [frame],
    sx: 0,
    sy: 300,
    elementFromPoint: () => frame,
  })
  assert.equal(r.ok, true, '扣掉滚动量之后应该正好落在 iframe 上')
  assert.equal(r.coord, 'viewport')
})

/* ---------- 读取器（假 CDP） ---------- */

function fakeCdp({ frames = [], trees = {}, boxes = {} } = {}) {
  const calls = []
  const send = async (method, params) => {
    calls.push(method)
    if (method === 'Page.getFrameTree') {
      return { frameTree: frames[0] || { frame: { id: 'F0', url: 'https://live.douyin.com/1' } } }
    }
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes: trees[params.frameId] || [] }
    }
    if (method === 'DOM.getBoxModel') {
      const q = boxes[params.backendNodeId]
      if (!q) throw new Error('no box')
      return { model: { border: q } }
    }
    return {}
  }
  return { send, calls }
}

test('createAxReader：逐个 frame 取树、拼文字、按名字取坐标', async () => {
  const frameTree = {
    frame: { id: 'F0', url: 'https://live.douyin.com/71389047335' },
    childFrames: [{ frame: { id: 'F1', url: 'blob:https://live.douyin.com/panel' } }],
  }
  const cdp = fakeCdp({
    frames: [frameTree],
    trees: {
      F0: [axNode('关注 G', 'button', { bid: 11 })],
      F1: [axNode('加入粉丝团', 'StaticText', { bid: 22 }), axNode('（1钻石）', 'StaticText', { bid: 23 })],
    },
    boxes: { 22: [1756, 1156, 1843, 1156, 1843, 1183, 1756, 1183] },
  })
  const ax = createAxReader({ send: cdp.send, evalJs: async () => ({ ok: true }), note: () => {} })

  const names = await ax.names({ ttl: 0 })
  assert.equal(names.length, 3)
  assert.ok(names.some((n) => n.name === '加入粉丝团' && n.frameId === 'F1'), '面板帧里的文字也要读到')

  const text = await ax.text({ ttl: 0 })
  assert.match(text, /加入粉丝团/)

  const found = await ax.find(/加入粉丝团/, { ttl: 0 })
  assert.equal(found.length, 1)
  assert.deepEqual(
    { x: found[0].x, y: found[0].y, w: found[0].w, h: found[0].h },
    { x: 1756, y: 1156, w: 87, h: 27 },
    '取到的坐标要和 getBoxModel 给的一致（页面坐标）'
  )

  assert.ok(cdp.calls.includes('Accessibility.getFullAXTree'), '要真的问过无障碍树')
  assert.ok(cdp.calls.includes('Page.getFrameTree'), '要按 frame 逐个取（面板在 blob: iframe 里）')
})

test('createAxReader：找不到就返回空，不抛异常', async () => {
  const cdp = fakeCdp({ frames: [{ frame: { id: 'F0', url: 'x' } }], trees: { F0: [] } })
  const ax = createAxReader({ send: cdp.send, evalJs: async () => ({ ok: true }), note: () => {} })
  assert.deepEqual(await ax.find(/送灯牌/, { ttl: 0 }), [])
  assert.equal(await ax.text({ ttl: 0 }), '')
})
