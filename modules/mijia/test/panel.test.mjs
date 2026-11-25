// test/panel.test.mjs —— 米家面板回归测试（本次 bug：授权名单改了存不进去）
//
// 背景（2026-11-06 实测）：panel.js 曾用组件自己的 useState 存设置草稿，改动只活在组件内部——
// 不进宿主 draft.ext.mijia（底部「有改动还没保存」不出现、切标签页组件重挂就全丢），而面板
// 自身又没有保存按钮，于是「授权名单 / 仅私聊 / 设备缓存秒数」改了等于没改；总开关因为走
// save({enabled}) 是唯一能落盘的项。
//
// 断言口径（登录前 / 登录后都要成立）：
//   1. 设置控件改值 → 必须调宿主 setSettings({...})，不能只改组件内部 state
//   2. 重渲染（等价于宿主 push 新草稿）后输入框仍回显草稿值
//   3. 新宿主下不再出现面板自带的「保存设置」按钮（交给页面底部统一保存）
//   4. 旧宿主（无 setSettings）要退回本地面板 + 自带保存按钮，且按钮能把改动交给 save()

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')

// ---- 面板宿主替身：h / ui / call 都是壳子，React 只实现面板用到的 4 个 hook ----
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false) })
const walk = (node) => (typeof node === 'object' && node ? [node, ...node.children.flatMap(walk), ...walk(node.props?.right)] : [])
const text = (node) => (typeof node === 'string' ? node : (node?.children || []).map(text).join(''))
const ui = Object.fromEntries(['Card', 'Row', 'Btn', 'Switch', 'Empty', 'Select', 'Seg', 'Range'].map((x) => [x, x]))

const DEFAULTS = { enabled: false, whitelist: '', privateOnly: true, cacheSeconds: 300 }

/** 最小 React：hooks 索引每轮渲染归零，等价于「同一次渲染内的调用顺序」 */
function makeReact() {
  const state = []
  let index = 0
  return {
    React: {
      useState(init) {
        const i = index++
        if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
        return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
      },
      useEffect() {},
      useCallback(fn) { return fn },
      useRef(init) { const i = index++; if (!(i in state)) state[i] = { current: init }; return state[i] },
    },
    reset: () => { index = 0 },
  }
}

/**
 * 挂一个面板实例。
 * @param {{ settings, loggedIn, legacy }} opts  legacy=true 模拟没有 setSettings 的旧宿主
 */
function mount({ settings = DEFAULTS, loggedIn = false, legacy = false } = {}) {
  const r = makeReact()
  const calls = []
  const saved = []
  const setSettingsCalls = []
  const toasts = []
  let draftSettings = { ...settings }

  const call = async (p, body) => {
    calls.push({ p, body })
    if (p === '/qr/state') return { ok: true, loggedIn }
    if (p === '/devices') {
      return {
        ok: true,
        devices: loggedIn
          ? [{ did: 'd1', name: '客厅灯', model: 'yeelink.light.lamp1', isOnline: true, controllable: true, label: '灯', type: 'light' }]
          : [],
      }
    }
    if (p === '/state') return { ok: true, states: {}, specs: {} }
    return { ok: true }
  }
  const Panel = new Function('React', 'h', 'ui', 'call', SRC)(r.React, h, ui, call)

  const props = {
    settings,
    save: async (p) => { saved.push(p) },
    toast: (m) => toasts.push(m),
  }
  if (!legacy) {
    props.draftSettings = draftSettings
    props.setSettings = (patch) => {
      setSettingsCalls.push(patch)
      draftSettings = { ...draftSettings, ...patch }
      props.draftSettings = draftSettings
    }
  }
  const render = () => { r.reset(); return Panel(props) }
  return { render, calls, saved, toasts, setSettingsCalls, get draft() { return draftSettings } }
}

/** 面板上的控件定位器 */
const node = {
  whitelist: (tree) => walk(tree).find((n) => n.type === 'textarea'),
  privateOnly: (tree) => walk(tree).find((n) => n.type === 'input' && n.props.type === 'checkbox'),
  cacheSeconds: (tree) => walk(tree).find((n) => n.type === 'input' && n.props.type === 'number'),
  master: (tree) => walk(tree).find((n) => n.type === 'Switch'),
  saveBtn: (tree) => walk(tree).find((n) => n.type === 'Btn' && text(n) === '保存设置'),
}

describe('米家面板：设置必须进宿主草稿（登录前 / 登录后都成立）', () => {
  for (const [label, loggedIn] of [['登录前（未扫码、无设备列表）', false], ['登录后（已扫码、设备列表已渲染）', true]]) {
    test(label + '：授权名单改动要进宿主 setSettings', () => {
      const m = mount({ loggedIn })
      const ta = node.whitelist(m.render())
      assert.ok(ta, '面板必须有授权名单输入框')
      ta.props.onChange({ target: { value: '123456\n789012' } })
      assert.deepEqual(m.setSettingsCalls.find((p) => 'whitelist' in p), { whitelist: '123456\n789012' })
    })

    test(label + '：宿主草稿变化后输入框回显草稿值', () => {
      const m = mount({ loggedIn })
      const ta = node.whitelist(m.render())
      ta.props.onChange({ target: { value: '123456\n789012' } })
      // 宿主把新草稿推回来（等价于下一次渲染）
      assert.equal(node.whitelist(m.render()).props.value, '123456\n789012')
    })

    test(label + '：仅私聊 / 缓存秒数也要进宿主 setSettings', () => {
      const m = mount({ loggedIn })
      node.privateOnly(m.render()).props.onChange({ target: { checked: false } })
      node.cacheSeconds(m.render()).props.onChange({ target: { value: '600' } })
      assert.deepEqual(m.setSettingsCalls.find((p) => 'privateOnly' in p), { privateOnly: false })
      assert.deepEqual(m.setSettingsCalls.find((p) => 'cacheSeconds' in p), { cacheSeconds: '600' })
    })

    test(label + '：总开关即切即存（进宿主草稿）', () => {
      const m = mount({ loggedIn })
      node.master(m.render()).props.onChange()
      assert.deepEqual(m.setSettingsCalls.find((p) => 'enabled' in p), { enabled: true })
    })

    test(label + '：新宿主下不出现面板自带的保存按钮（统一走底部保存）', () => {
      const m = mount({ loggedIn })
      assert.equal(node.saveBtn(m.render()), undefined)
    })
  }
})

describe('米家面板：旧宿主（无 setSettings）兜底', () => {
  test('退回本地面板并给出自带「保存设置」按钮', () => {
    const m = mount({ legacy: true })
    assert.ok(node.saveBtn(m.render()), '没有宿主草稿接口时必须给一个能保存的按钮')
  })

  test('自带保存按钮把改动交给宿主 save()', async () => {
    const m = mount({ legacy: true })
    node.whitelist(m.render()).props.onChange({ target: { value: '999' } })
    const btn = node.saveBtn(m.render())
    await btn.props.onClick()
    assert.equal(m.saved.length, 1)
    assert.equal(m.saved[0].whitelist, '999')
  })

  test('旧宿主下总开关仍然立刻写盘（安全开关不能等）', () => {
    const m = mount({ legacy: true })
    node.master(m.render()).props.onChange()
    assert.equal(m.saved.length, 1)
    assert.equal(m.saved[0].enabled, true)
  })
})
