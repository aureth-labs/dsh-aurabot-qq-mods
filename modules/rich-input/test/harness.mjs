// 测试脚手架：用假 api 驱动 rich-input 的 setup，捕获 message / prompt 钩子。
// 不依赖真实插件源码（api.lib 自己伪造），所以本地和 CI 都能跑。
import def from '../index.mjs'

const PNG = Buffer.from('89504e470d0a1a0a1a0a1a0a1a0a1a0a', 'hex')

export function makeHarness (opts = {}) {
  const handlers = { message: [], prompt: [] }
  const calls = { ask: [], call: [], routes: {} }
  let settings = {
    images: true,
    maxImages: 4,
    forwards: true,
    catchUp: false, // 默认关补课，免得干扰转发/图片用例
    maxForwards: 3,
    maxNodes: 60,
    maxChars: 4000,
    extraForwardText: false,
    logText: false,
    describe: true,
    visionModel: '',
    fallbackModel: '',
    describeTimeout: 30,
    describePrompt: '',
    ...(opts.settings || {})
  }
  const onebot = {
    call: async (action, params) => {
      calls.call.push({ action, params })
      return opts.onCall ? opts.onCall(action, params) : {}
    }
  }
  const askImpl = opts.ask || (async () => '一只橘猫，趴在沙发上')
  const ask = async (req) => { calls.ask.push(req); return askImpl(req) }
  const api = {
    on: (evt, fn) => { if (handlers[evt]) handlers[evt].push(fn) },
    settings: () => settings,
    log: { debug () {}, info () {}, warn () {} },
    lib: (name) => {
      if (name === 'core/net.js') return { segmentBytes: opts.segmentBytes || (async () => PNG) }
      if (name === 'chat/inbound.js') return {
        mimeOf: () => 'image/png',
        parseMessageEvent: opts.parseMessageEvent || ((e) => ({
          text: Array.isArray(e.message)
            ? e.message.map((s) => String(s.data?.text ?? '')).join('')
            : String(e.message || ''),
          nickname: '',
          images: []
        }))
      }
      return {}
    },
    ask,
    core: {
      hub: { selfId: '123', canSeeImages: opts.canSeeImages || (async () => false) },
      onebot,
      listModels: opts.listModels || (async () => [
        { provider: 'p', model: 'vision-main', vision: true, name: 'Main Vision' },
        { provider: 'p', model: 'vision-backup', vision: true, name: 'Backup Vision' }
      ]),
      http: { query: () => ({}) },
      ask
    },
    route: (path, fn) => { calls.routes[path] = fn },
    every: () => {},
    setSettings: (s) => { settings = { ...settings, ...s } }
  }
  const mod = def.setup(api)
  return {
    api, calls, mod, handlers, settings, setSettings: api.setSettings,
    message: async (m) => { for (const fn of handlers.message) await fn(m) },
    prompt: async (content, info) => {
      let out = content
      let changed = false
      for (const fn of handlers.prompt) {
        const r = await fn(out, info)
        if (r !== undefined) { out = r; changed = true }
      }
      return changed ? out : undefined
    }
  }
}

export const imageSeg = (data = {}) => ({ type: 'image', data: { url: 'http://x/a.png', ...data } })
export const forwardSeg = (id) => ({ type: 'forward', data: { id } })
export const textBlock = (text) => ({ type: 'text', text })
export const info = (chatId = 'c1', senderId = 'u1') => ({ chat: { kind: 'group', chatId }, senderId })
export const forwardNode = (name, uid, text) => ({ sender: { user_id: uid, nickname: name }, message: [{ type: 'text', data: { text } }] })
export const msgWith = (id, segs, extra = {}) => ({ messageId: id, chatId: 'c1', userId: 'u1', nickname: '主人', raw: { message: segs }, ...extra })
export const allText = (out) => out.map((b) => b?.text || '').join('\n')
