// 衣柜：她的衣服、今天的穿搭、按穿搭生图预览。
//
// 一件衣服 = 参考图 + 一段文字描述（描述由看图模型从参考图生成，可手改）。
// 生图时：能带参考图的服务就用参考图，不能（比如 Codex）就用文字描述。
//
// v1：手动选衣服、手动换装、按预设姿势出预览图。聊天里的自动匹配留到下一版。

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const KINDS = ['set']
const KIND_NAME = { set: '整套' }

const POSES = {
  stand: { name: '站姿', text: '全身站姿，正面，双手自然垂下，看着镜头' },
  sit: { name: '坐姿', text: '坐在床边，双腿并拢，手放在膝盖上，看着镜头' },
  lookback: { name: '回眸', text: '侧身回头看向镜头，头发微微扬起' },
  chin: { name: '托腮', text: '坐在桌前单手托腮，看着镜头' },
  peace: { name: '比耶', text: '举一只手比耶，歪着头笑' },
  mirror: { name: '对镜自拍', text: '举着手机对镜自拍，手机挡住半张脸' },
  street: { name: '街拍·摇滚', text: '夜晚街头，老旧居民楼前，墙上挂着空调外机，一楼卷帘门店铺已经关门，二楼铁栏杆阳台，街灯亮着，背景轻微虚化；侧身回头看向镜头，头发被夜风吹起几缕，右手抬到胸前比出摇滚手势（拇指、食指、小指伸出），表情有点拽，嘴角微挑；手机闪光灯直拍，轻微过曝，冷色调，胶片颗粒，浅景深' },
  lean: { name: '街拍·靠杆', text: '夜晚街头，白色路灯杆旁，背景是老旧居民楼和卷帘门店铺，轻微虚化；背靠在白色路灯杆上，双手插在裤兜里，身体微微后仰，侧头看向镜头，头发被夜风吹起几缕，表情慵懒有点酷；手机闪光灯直拍，冷色调，轻微过曝，胶片颗粒，浅景深' },
}

const DEFAULT_BASE = '蓝发少女，蓝色长卷发，发尾渐变成浅海蓝，头顶一撮翘起来的呆毛，一对深蓝色的鲸鱼耳朵，身后拖着一条鲸鱼尾巴，脸偏圆有点婴儿肥，眼睛大而圆是深蓝色，笑起来眼睛会弯、脸颊会红，气质偏软偏可爱，皮肤白皙'
const DEFAULT_OUTFIT = '蓝白配色女仆装，白色荷叶边头饰，围裙上绣着一只小鲸鱼'
const MAKEUP_PRESETS = [
  { id: 'm_bare', name: '素颜', desc: '素颜，皮肤干净，没有明显妆感，唇色淡粉' },
  { id: 'm_daily', name: '日常淡妆', desc: '淡妆，薄底妆，淡腮红，眉毛自然，唇色自然偏粉' },
  { id: 'm_night', name: '夜街妆', desc: '妆容偏浓，眼线清晰，腮红明显，唇色偏红有光泽' },
]
const HAIR_PRESETS = [
  { id: 'h_long', name: '长直发', desc: '蓝黑色长发到腰，发尾褪成浅海蓝，头顶一撮呆毛，轻薄的碎刘海，两侧留碎发，发量多' },
  { id: 'h_bun', name: '低丸子头', desc: '蓝黑色长发在脑后挽成低丸子头，碎发垂在脸侧，轻薄的碎刘海，发尾浅海蓝' },
  { id: 'h_half', name: '半扎发', desc: '蓝黑色长发上半部分扎起，其余披散到腰，发尾褪成浅海蓝，碎刘海，两侧留发丝' },
  { id: 'h_pony', name: '高马尾', desc: '蓝黑色长发扎成高马尾，发尾褪成浅海蓝，碎刘海，脸侧留几缕碎发' },
  { id: 'h_twin', name: '双马尾', desc: '蓝黑色长发扎成两个低马尾，发尾褪成浅海蓝，碎刘海，发量多' },
  { id: 'h_short', name: '齐肩短发', desc: '齐肩长度的蓝黑色短发，发尾褪成浅海蓝，碎刘海，稍微内扣' },
]
const DEFAULT_STYLE = '二次元插画风格，干净线条，柔和上色，白色背景'

const mimeOf = (b64) => (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png')
const extOf = (mime) => (mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png')

export default {
  id: 'wardrobe',
  name: '衣柜',
  version: '1.0.1',
  api: 1,
  description: '她的衣服：参考图 + 文字描述；手动挑今天穿什么，按姿势生成预览图',
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'visionModel', label: '看图模型', type: 'text', hint: '留空 = 用当前聊天模型（能看图就行）；也可以填 provider/model 强制指定，比如 deepseek-official/deepseek-flash' },
  ],

  setup(api) {
    const cfg = () => ({ enabled: true, visionModel: '', ...(api.settings() || {}) })
    const dir = () => api.dataDir()
    const file = () => join(dir(), 'wardrobe.json')
    const imgDir = () => join(dir(), 'images')
    const prevDir = () => join(dir(), 'preview')

    const load = () => {
      try {
        const s = JSON.parse(readFileSync(file(), 'utf8'))
        const today = s.today || {}
        if (!today.set && (today.top || today.bottom || today.outer || today.shoes || today.accessory)) {
          today.set = today.top || today.bottom || today.outer || today.shoes || today.accessory
          delete today.top; delete today.bottom; delete today.outer; delete today.shoes; delete today.accessory
        }
        return { items: Array.isArray(s.items) ? s.items : [], today, history: Array.isArray(s.history) ? s.history : [], base: String(s.base || ''), style: String(s.style || ''), makeups: Array.isArray(s.makeups) && s.makeups.length ? s.makeups : MAKEUP_PRESETS.map((m) => ({ ...m })), makeupId: String(s.makeupId || 'm_bare'), hairdos: Array.isArray(s.hairdos) && s.hairdos.length ? s.hairdos : HAIR_PRESETS.map((h) => ({ ...h })), hairdoId: String(s.hairdoId || 'h_long') }
      } catch (error) { return { items: [], today: {}, history: [], base: '', style: '', makeups: MAKEUP_PRESETS.map((m) => ({ ...m })), makeupId: 'm_bare', hairdos: HAIR_PRESETS.map((h) => ({ ...h })), hairdoId: 'h_long' } }
    }
    const save = (s) => { mkdirSync(dir(), { recursive: true }); writeFileSync(file(), JSON.stringify(s, null, 2)) }

    // 第一次跑的时候放一套默认女仆装，省得衣柜是空的
    const MAID = { id: 'w_maid', name: '女仆装', kind: 'set', desc: DEFAULT_OUTFIT, image: '', mediaType: '', seeded: true }
    function seedOnce() {
      const s = load()
      if (s.seeded) return
      if (!(s.items || []).some((x) => x.id === MAID.id || x.name === MAID.name)) {
        s.items = [...(s.items || []), { ...MAID, createdAt: Date.now() }]
        if (!s.today || !s.today.set) s.today = { ...(s.today || {}), set: MAID.id }
      }
      s.seeded = true
      save(s)
    }
    function itemOf(id, s = load()) { return (s.items || []).find((x) => x.id === id) || null }

    // 描述里可能带列表符号/换行（从人格整段粘过来），拼 prompt 前先捋平
    function cleanText(x) {
      return String(x || '')
        .replace(/^[\s\-•·*]+/gm, '')
        .replace(/\s+[-•·*]\s+/g, '，')
        .replace(/\s*\n+\s*/g, '，')
        .replace(/，{2,}/g, '，')
        .replace(/([。！？])，/g, '$1')
        .replace(/^，|，$/g, '')
        .trim()
    }
    function outfitText(s = load()) {
      const whole = itemOf(s.today.set, s)
      if (whole) return whole.desc || whole.name
      const parts = KINDS.filter((k) => k !== 'set').map((k) => {
        const it = itemOf(s.today[k], s)
        return it ? it.desc || it.name : ''
      }).filter(Boolean)
      return parts.join('，')
    }

    function makeupOf(s = load()) {
      const list = s.makeups && s.makeups.length ? s.makeups : MAKEUP_PRESETS
      return list.find((m) => m.id === s.makeupId) || list[0] || null
    }

    function hairdoOf(s = load()) {
      const list = s.hairdos && s.hairdos.length ? s.hairdos : HAIR_PRESETS
      return list.find((h) => h.id === s.hairdoId) || list[0] || null
    }

    // 挂进人格的那段「当前装扮」：发型 + 妆容 + 穿着，合成一段
    function lookBlock(s = load()) {
      const look = []
      const hair = hairdoOf(s)
      if (hair && hair.desc) look.push('发型：' + cleanText(hair.desc))
      const makeup = makeupOf(s)
      if (makeup && makeup.id !== 'm_bare' && makeup.desc) look.push('妆容：' + cleanText(makeup.desc))
      const outfit = outfitText(s)
      if (outfit) look.push('穿着：' + outfit)
      if (!look.length) return ''
      return '【当前的装扮】\n' + look.join('\n').replace(/。。/g, '。') + '\n画自己的时候，这段原样写进画面描述，别改写、别漏配饰。'
    }
    // 基础描述里如果还写着头发，会和发型维度打架：这里把它摘掉，头发交给发型管
    function baseOf(s = load()) {
      const raw = cleanText(s.base) || DEFAULT_BASE
      return raw
        .replace(/(^|[。，])头发：[^。]*。?/g, '$1')
        .replace(/(^|[。，])蓝黑色?长发到腰[^。]*。?/g, '$1')
        .replace(/，{2,}/g, '，')
        .replace(/^，|，$/g, '')
        .trim()
    }

    function buildPrompt(poseKey, s = load()) {
      const base = baseOf(s)
      const style = cleanText(s.style) || DEFAULT_STYLE
      const outfit = outfitText(s) || DEFAULT_OUTFIT
      const makeup = makeupOf(s)
      const hair = hairdoOf(s)
      const makeLine = makeup ? '妆容：' + cleanText(makeup.desc) : ''
      const hairLine = hair ? '发型：' + cleanText(hair.desc) : ''
      const pose = (POSES[poseKey] || POSES.stand).text
      return [base, hairLine, makeLine, outfit ? '今天穿：' + outfit : '', pose, style]
        .filter(Boolean).join('，')
        .replace(/。，/g, '。').replace(/。。/g, '。')
    }

    /** 看图写描述：优先用设置里的模型，失败就换一个能看图的。 */
    async function caption(b64, mediaType) {
      const c = cfg()
      const [provider, model] = String(c.visionModel || '').split('/').map((x) => x.trim())
      const target = provider && model ? { provider, model } : null
      const ask = (m) => api.ask({
        model: m || undefined,
        system: '你在描述一件衣服或一套穿搭，用来给生图模型当参考。用中文写 60 字以内：品类、颜色、材质、版型、明显细节（图案、领口、长度、配饰）。不要写人、不要写背景、不要评价。',
        text: '描述这张图里的衣服。',
        images: [{ data: b64, mediaType }],
        maxTokens: 300,
        temperature: 0.2,
      })
      try {
        const out = String(await ask(target)).trim()
        if (out) return out
      } catch (error) { api.log.debug?.('指定看图模型失败，换默认：', error.message) }
      return String(await ask(null)).trim()
    }

    async function addItem({ name, kind, image, desc }) {
      const b64 = String(image || '').replace(/^data:[^,]+,/, '')
      const typed = String(desc || '').trim()
      if (!b64 && !typed) return { ok: false, message: '给一张图，或者写一段描述' }
      if (b64.length > 6 * 1024 * 1024) return { ok: false, message: '图片太大了（base64 超过 6MB）' }
      const mediaType = b64 ? mimeOf(b64) : ''
      const id = 'w_' + Math.random().toString(36).slice(2, 8)
      let fname = ''
      if (b64) {
        mkdirSync(imgDir(), { recursive: true })
        fname = id + '.' + extOf(mediaType)
        writeFileSync(join(imgDir(), fname), Buffer.from(b64, 'base64'))
      }
      let text = typed
      if (!text && b64) {
        try { text = await caption(b64, mediaType) } catch (error) { text = '' }
      }
      const s = load()
      s.items.push({
        id,
        name: String(name || '').trim() || (KIND_NAME[kind] || '整套'),
        kind: 'set',
        desc: text.slice(0, 500),
        image: fname,
        mediaType,
        createdAt: Date.now(),
      })
      save(s)
      return { ok: true, item: s.items[s.items.length - 1], captioned: Boolean(text) }
    }

    async function replaceImage({ id, image }) {
      const b64 = String(image || '').replace(/^data:[^,]+,/, '')
      if (!b64) return { ok: false, message: '没有图片' }
      if (b64.length > 6 * 1024 * 1024) return { ok: false, message: '图片太大了（base64 超过 6MB）' }
      const s = load()
      const it = itemOf(String(id || ''), s)
      if (!it) return { ok: false, message: '没这件' }
      const mediaType = mimeOf(b64)
      mkdirSync(imgDir(), { recursive: true })
      const fname = it.id + '-' + Date.now() + '.' + extOf(mediaType)
      writeFileSync(join(imgDir(), fname), Buffer.from(b64, 'base64'))
      it.image = fname
      it.mediaType = mediaType
      it.updatedAt = Date.now()
      save(s)
      return { ok: true, item: it, outfit: outfitText(s) }
    }
    function updateItem({ id, name, desc }) {
      const s = load()
      const it = itemOf(String(id || ''), s)
      if (!it) return { ok: false, message: '没这件' }
      if (typeof name === 'string' && name.trim()) it.name = name.trim().slice(0, 20)
      if (typeof desc === 'string') it.desc = desc.trim().slice(0, 500)
      save(s)
      return { ok: true, item: it, outfit: outfitText(s) }
    }
    function clearAll() {
      const s = load()
      for (const it of s.items || []) {
        try { unlinkSync(join(imgDir(), it.image)) } catch (error) { /* 文件不在就算了 */ }
      }
      s.items = []
      s.today = {}
      save(s)
      return { ok: true }
    }
    function removeItem(id) {
      const s = load()
      const it = itemOf(id, s)
      if (!it) return { ok: false, message: '没这件' }
      s.items = s.items.filter((x) => x.id !== id)
      for (const k of Object.keys(s.today)) if (s.today[k] === id) delete s.today[k]
      save(s)
      try { unlinkSync(join(imgDir(), it.image)) } catch (error) { /* 文件不在就算了 */ }
      return { ok: true }
    }

    function setToday(patch) {
      const s = load()
      s.today = s.today || {}
      for (const k of KINDS) {
        if (!(k in patch)) continue
        const v = String(patch[k] || '')
        if (!v) delete s.today[k]
        else if (itemOf(v, s)) s.today[k] = v
      }
      save(s)
      return { ok: true, today: s.today, outfit: outfitText(s) }
    }

    async function preview(poseKey) {
      const s = load()
      const prompt = buildPrompt(poseKey, s)
      const ig = api.use('imagegen')
      if (!ig || typeof ig.generate !== 'function') return { ok: false, message: '生图模块没开' }
      const provider = String(api.config().imageGen && api.config().imageGen.provider || '')
      // 能带参考图的服务，用当前上衣的参考图；Codex 不支持，直接文字
      let ref = null
      if (provider !== 'codex') {
        const top = itemOf(s.today.top, s) || (s.items || [])[0]
        if (top) {
          try { ref = readFileSync(join(imgDir(), top.image)) } catch (error) { ref = null }
        }
      }
      let buf
      try {
        buf = await ig.generate(prompt, { shape: 'portrait', image: ref || undefined })
      } catch (error) {
        if (ref) {
          // 带图失败就退回纯文字
          try { buf = await ig.generate(prompt, { shape: 'portrait' }) } catch (error2) { return { ok: false, message: '生图失败：' + error2.message } }
        } else {
          return { ok: false, message: '生图失败：' + error.message }
        }
      }
      mkdirSync(prevDir(), { recursive: true })
      const id = 'p_' + Date.now()
      writeFileSync(join(prevDir(), id + '.png'), buf)
      const s2 = load()
      s2.history = [{ id, at: Date.now(), pose: String(poseKey || 'stand'), prompt, outfit: outfitText(s2), usedReference: Boolean(ref) }, ...(s2.history || [])].slice(0, 60)
      save(s2)
      return { ok: true, id, prompt, usedReference: Boolean(ref) }
    }


    // 穿搭进上下文：挂在 persona 上（不改人格文件），用第三人称写成背景，
    // 这样她是“知道自己今天穿什么”，而不是收到一条要执行的指令。
    api.on('persona', (text) => {
      if (!cfg().enabled) return text
      const block = lookBlock(load())
      if (!block) return text
      return String(text || '') + '\n\n' + block
    })
    const sendImage = (res, buf, type) => {
      res.statusCode = 200
      res.setHeader?.('content-type', type || 'image/png')
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(buf)
    }
    seedOnce()

    api.route('/look/apply', async () => {
      const s = load()
      return { ok: true, block: lookBlock(s), outfit: outfitText(s), hairdoId: s.hairdoId || 'h_long', makeupId: s.makeupId || 'm_bare' }
    })
    api.route('/list', async () => {
      const s = load()
      return {
        ok: true,
        items: s.items,
        today: s.today,
        outfit: outfitText(s),
        base: baseOf(s),
        style: cleanText(s.style) || DEFAULT_STYLE,
        makeups: (s.makeups || MAKEUP_PRESETS).map((m) => ({ id: m.id, name: m.name, desc: cleanText(m.desc) })),
        makeupId: s.makeupId || 'm_bare',
        hairdos: (s.hairdos || HAIR_PRESETS).map((h) => ({ id: h.id, name: h.name, desc: cleanText(h.desc) })),
        hairdoId: s.hairdoId || 'h_long',
        poses: Object.entries(POSES).map(([k, v]) => ({ key: k, name: v.name })),
      }
    })
    api.route('/appearance/save', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      if (typeof b.base === 'string') s.base = b.base.trim().slice(0, 300)
      if (typeof b.style === 'string') s.style = b.style.trim().slice(0, 160)
      save(s)
      return { ok: true, base: s.base, style: s.style }
    })
    api.route('/hair/set', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      const id = String(b.id || '')
      const list = s.hairdos || HAIR_PRESETS
      if (!list.some((h) => h.id === id)) return { ok: false, message: '没这个发型' }
      s.hairdoId = id
      save(s)
      return { ok: true, hairdoId: id }
    })
    api.route('/hair/save', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      const list = s.hairdos && s.hairdos.length ? s.hairdos : HAIR_PRESETS.map((h) => ({ ...h }))
      const it = list.find((h) => h.id === String(b.id || s.hairdoId || ''))
      if (!it) return { ok: false, message: '没这个发型' }
      if (typeof b.desc === 'string') it.desc = b.desc.trim().slice(0, 200)
      s.hairdos = list
      save(s)
      return { ok: true, hairdos: list }
    })
    api.route('/hair/add', async (req) => {
      const b = await api.core.http.body(req)
      const name = String(b.name || '').trim().slice(0, 12)
      const desc = String(b.desc || '').trim().slice(0, 200)
      if (!name || !desc) return { ok: false, message: '名字和描述都要写' }
      const s = load()
      const list = s.hairdos && s.hairdos.length ? s.hairdos : HAIR_PRESETS.map((h) => ({ ...h }))
      const id = 'h_' + Math.random().toString(36).slice(2, 8)
      list.push({ id, name, desc })
      s.hairdos = list
      s.hairdoId = id
      save(s)
      return { ok: true, id, hairdos: list }
    })
    api.route('/hair/del', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      const list = s.hairdos && s.hairdos.length ? s.hairdos : HAIR_PRESETS.map((h) => ({ ...h }))
      const id = String(b.id || '')
      if (list.length <= 1) return { ok: false, message: '至少留一个发型' }
      const next = list.filter((h) => h.id !== id)
      if (next.length === list.length) return { ok: false, message: '没这个发型' }
      s.hairdos = next
      if (s.hairdoId === id) s.hairdoId = next[0].id
      save(s)
      return { ok: true, hairdos: next, hairdoId: s.hairdoId }
    })
    api.route('/makeup/set', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      const id = String(b.id || '')
      const list = s.makeups || MAKEUP_PRESETS
      if (!list.some((m) => m.id === id)) return { ok: false, message: '没这个妆容' }
      s.makeupId = id
      save(s)
      return { ok: true, makeupId: id }
    })
    api.route('/makeup/add', async (req) => {
      const b = await api.core.http.body(req)
      const name = String(b.name || '').trim().slice(0, 12)
      const desc = String(b.desc || '').trim().slice(0, 160)
      if (!name || !desc) return { ok: false, message: '名字和描述都要写' }
      const s = load()
      const list = s.makeups && s.makeups.length ? s.makeups : MAKEUP_PRESETS.map((m) => ({ ...m }))
      const id = 'm_' + Math.random().toString(36).slice(2, 8)
      list.push({ id, name, desc })
      s.makeups = list
      s.makeupId = id
      save(s)
      return { ok: true, id, makeups: list }
    })
    api.route('/makeup/del', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      const list = s.makeups && s.makeups.length ? s.makeups : MAKEUP_PRESETS.map((m) => ({ ...m }))
      const id = String(b.id || '')
      if (list.length <= 1) return { ok: false, message: '至少留一个妆容' }
      const next = list.filter((m) => m.id !== id)
      if (next.length === list.length) return { ok: false, message: '没这个妆容' }
      s.makeups = next
      if (s.makeupId === id) s.makeupId = next[0].id
      save(s)
      return { ok: true, makeups: next, makeupId: s.makeupId }
    })
    api.route('/makeup/save', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      const list = s.makeups || MAKEUP_PRESETS.map((m) => ({ ...m }))
      const it = list.find((m) => m.id === String(b.id || s.makeupId || ''))
      if (!it) return { ok: false, message: '没这个妆容' }
      if (typeof b.desc === 'string') it.desc = b.desc.trim().slice(0, 160)
      s.makeups = list
      save(s)
      return { ok: true, makeups: list }
    })
    api.route('/add', async (req) => {
      const b = await api.core.http.body(req)
      return addItem(b)
    })
    api.route('/image/replace', async (req) => {
      const b = await api.core.http.body(req)
      return replaceImage(b || {})
    })
    api.route('/update', async (req) => {
      const b = await api.core.http.body(req)
      return updateItem(b || {})
    })
    api.route('/clear', async () => clearAll())
    api.route('/del', async (req) => {
      const b = await api.core.http.body(req)
      return removeItem(String(b.id || ''))
    })
    api.route('/today', async (req) => {
      const b = await api.core.http.body(req)
      return setToday(b || {})
    })
    api.route('/prompt', async (req) => {
      const pose = String(api.core.http.query(req).pose || 'stand')
      return { ok: true, prompt: buildPrompt(pose), makeup: makeupOf(load())?.desc || '', outfit: outfitText(load()) }
    })
    api.route('/preview', async (req) => {
      const b = await api.core.http.body(req)
      return preview(String(b.pose || 'stand'))
    })
    api.route('/open-folder', async () => {
      const d = prevDir()
      mkdirSync(d, { recursive: true })
      const opts = { detached: true, stdio: 'ignore' }
      if (process.platform === 'win32') spawn('explorer.exe', [d], opts).unref()
      else if (process.platform === 'darwin') spawn('open', [d], opts).unref()
      else spawn('xdg-open', [d], opts).unref()
      return { ok: true, dir: d }
    })
    api.route('/history', async () => {
      const s = load()
      return { ok: true, list: (s.history || []).map((h) => ({ ...h, poses: POSES[h.pose] ? POSES[h.pose].name : h.pose })) }
    })
    api.route('/preview/del', async (req) => {
      const b = await api.core.http.body(req)
      const id = String(b.id || '')
      const s = load()
      s.history = (s.history || []).filter((h) => h.id !== id)
      save(s)
      try { unlinkSync(join(prevDir(), id + '.png')) } catch (error) { /* 文件不在就算了 */ }
      return { ok: true }
    })
    api.route('/preview/file', async (req, res) => {
      const id = String(api.core.http.query(req).id || '')
      if (!/^p_\d+$/.test(id)) return { ok: false, message: 'id 不对' }
      try { return sendImage(res, readFileSync(join(prevDir(), id + '.png'))) } catch (error) { return { ok: false, message: '没有这张图' } }
    })
    api.route('/image/file', async (req, res) => {
      const id = String(api.core.http.query(req).id || '')
      const it = itemOf(id)
      if (!it) return { ok: false, message: '没这件' }
      try { return sendImage(res, readFileSync(join(imgDir(), it.image)), it.mediaType) } catch (error) { return { ok: false, message: '图没了' } }
    })
  },
}
