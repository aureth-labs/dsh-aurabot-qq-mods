// 人格实验室：学群友口癖 + 允许她自己给「人格」追加一条自我调整。
// 只观察群聊；不改核心人格，不改插件代码；所有写入都在插件数据目录。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const STYLE_LIMIT = 120          // 每人最多留多少条样本
const STYLE_MAX_CHARS = 160      // 单条样本截断
const EDIT_MAX_CHARS = 300       // 一次最多加多少字
const BACKUP_KEEP = 12

export default {
  id: 'persona-lab',
  name: '人格实验室',
  version: '0.2.1',
  api: 1,
  description: '观察群友的说话习惯，并在允许时让她给自己的「人格」追加一条自我调整（有备份、可撤销）。',
  panel: 'panel.js',

  defaults: {
    learnGroups: false,
    styleInject: false,
    selfEdit: false,
    selfEditMode: 'append',
    selfEditMaxPerDay: 2,
    selfEditCooldownHours: 6,
    selfReflect: false,
    selfReflectHours: 6,
    selfReflectMaxPerDay: 2,
    groupList: '',
    blockList: '',
  },

  settings: [
    { key: 'learnGroups', label: '学习群友说话方式', type: 'switch', hint: '只记录群聊文字，不存图片/语音文件；按群友分别归纳口癖、标点、表情习惯' },
    { key: 'styleInject', label: '群聊时参考群友的说话习惯', type: 'switch', hint: '开：她聊天时会看到最近群友的口癖和语气，可能自然学着用；关：只在她主动查时用' },
    { key: 'selfEdit', label: '允许她自主改人格', type: 'switch', hint: '总开关；关闭后两种修改都不允许' },
    { key: 'selfEditMode', label: '修改范围', type: 'select', options: [
      { value: 'append', label: '追加模式：只在人格末尾加「自我调整」' },
      { value: 'core', label: '重写模式：可以重写整份人格' },
    ], hint: '追加模式：只在人格末尾加「自我调整」，不改原有规则；重写模式：允许重写整份人格。这里不会修改主人信息，只会修改人格里的有关设定；主人身份由 ownerQQ 配置决定，不在人格文件里' },
    { key: 'selfEditMaxPerDay', label: '每天最多改几次', type: 'number', min: 0, max: 10 },
    { key: 'selfEditCooldownHours', label: '两次修改至少隔几小时（0=不限制）', type: 'number', min: 0, max: 168 },
    { key: 'selfReflect', label: '定期自我反思', type: 'switch', hint: '开启后，她会隔一段时间自己回顾最近和主人的相处；只有真的觉得有新的自我认识，才会追加一条人格，不会为改而改' },
    { key: 'selfReflectHours', label: '反思间隔（小时）', type: 'number', min: 1, max: 72 },
    { key: 'selfReflectMaxPerDay', label: '每天最多反思几次', type: 'number', min: 0, max: 6 },
    { key: 'groupList', label: '学习哪些群', type: 'text', hint: '群号，逗号/换行分隔；留空 = 白名单里的所有群' },
    { key: 'blockList', label: '不学习谁（QQ号黑名单）', type: 'text', hint: '填 QQ 号，逗号/换行分隔；这些人在群里说话不会被学习，也不会出现在样本里。填 QQ 号有效，群消息里的 userId 就是 QQ 号；不要填昵称。' },
  ],

  setup(api) {
    const stylesFile = () => api.dataDir('styles.json')
    const stateFile = () => api.dataDir('state.json')
    const backupDir = () => api.dataDir('persona-backups')
    const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
    const writeJson = (f, v) => { try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(f, JSON.stringify(v)) } catch (e) { api.log.warn?.('写文件失败：', e.message) } }

    const settings = () => api.settings()
    const isDryRun = () => Boolean(api.config()?.dryRun)
    const groupAllowed = (gid) => {
      const list = String(settings().groupList || '').split(/[\s,，]+/).filter(Boolean)
      return list.length === 0 || list.includes(String(gid))
    }
    const blocked = (uid) => {
      const list = String(settings().blockList || '').split(/[\s,，]+/).filter(Boolean)
      return list.includes(String(uid))
    }

    // ---------- 群友说话习惯 ----------
    const styleKey = (gid, uid) => `${gid}:${uid}`
    let styleCache = null
    let styleDirty = false
    let styleTimer = null
    const loadStyles = () => {
      if (!styleCache) styleCache = readJson(stylesFile(), { members: {} })
      return styleCache
    }
    function flushStyles() {
      if (styleTimer) { clearTimeout(styleTimer); styleTimer = null }
      if (!styleDirty || !styleCache) return
      try { writeJson(stylesFile(), styleCache); styleDirty = false } catch (e) { api.log.debug?.('写口癖样本失败：', e.message) }
    }
    function saveStyles(db) {
      styleCache = db
      styleDirty = true
      if (!styleTimer) {
        styleTimer = setTimeout(flushStyles, 5000)
        styleTimer.unref?.()
      }
    }
    function clearStyles() {
      styleCache = { members: {} }
      styleDirty = false
      if (styleTimer) { clearTimeout(styleTimer); styleTimer = null }
      try { if (existsSync(stylesFile())) unlinkSync(stylesFile()) } catch {}
    }
    function clean(text) {
      return String(text || '')
        .replace(/\[图片\]|\[视频\]|\[语音\]|\[文件[^\]]*\]|\[表情包?\]|\[动画表情\]/g, '')
        .replace(/<[^>]{1,40}>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, STYLE_MAX_CHARS)
    }
    function bumpMember(msg, text) {
      if (isDryRun()) return
      if (!settings().learnGroups) return
      if (!msg || msg.kind !== 'group' || !msg.groupId || !msg.userId) return
      if (String(msg.userId) === String(api.config().botQQ)) return
      if (blocked(msg.userId)) return
      if (!groupAllowed(msg.groupId)) return
      const t = clean(text)
      if (!t || t.length < 2) return
      const db = loadStyles()
      const key = styleKey(msg.groupId, msg.userId)
      const m = db.members[key] || { groupId: String(msg.groupId), uid: String(msg.userId), name: String(msg.nickname || msg.userId), samples: [] }
      m.name = String(msg.nickname || m.name || msg.userId)
      m.samples = [...(m.samples || []), t].slice(-STYLE_LIMIT)
      m.updatedAt = Date.now()
      db.members[key] = m
      saveStyles(db)
    }
    function summarize(m) {
      const s = m.samples || []
      if (!s.length) return ''
      const all = s.join('\n')
      const len = Math.round(all.length / s.length)
      const count = (re) => (all.match(re) || []).length
      const faces = {}
      for (const x of all.match(/\[[^\]]{1,8}\]/g) || []) faces[x] = (faces[x] || 0) + 1
      const topFaces = Object.entries(faces).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x]) => x)
      // 只统计语气/拖音/口头禅，不把“风扇、理由”这种内容词当成口癖
      const fillers = new Map()
      for (const word of ['哈哈', '哈哈哈', '啊啊啊', '嗯嗯', '诶诶', '呜呜', '嘤嘤', 'emmm', '呃', '额', '草', '笑死', '绝了', '离谱', '真的假的', '好耶', '绷不住', '无语', '服了', '牛']) {
        let n = 0
        for (const line of s) {
          let i = 0
          while ((i = line.indexOf(word, i)) !== -1) { n++; i += word.length }
        }
        if (n >= 2) fillers.set(word, n)
      }
      const topFillers = [...fillers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x]) => x)
      const repeat = new Map()
      for (const line of s) {
        for (const x of line.match(/([\u4e00-\u9fa5])\1{1,}/g) || []) repeat.set(x, (repeat.get(x) || 0) + 1)
      }
      const topRepeat = [...repeat.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x]) => x)
      const particles = new Map()
      for (const line of s) {
        for (const x of line.match(/[啊呀吧呢嘛哦咯呗欸诶哈啦喽喔噢](?=[，。！？!?…~～\s]|$)/g) || []) particles.set(x, (particles.get(x) || 0) + 1)
      }
      const topParticles = [...particles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x]) => x)
      return [
        `${m.name}：${s.length} 条样本，平均 ${len} 字`,
        count(/[？?]/g) ? `爱用问号` : '',
        count(/[！!]/g) ? `爱用感叹号` : '',
        count(/…{2,}|\.{3,}/g) ? `常带省略号` : '',
        count(/[~～]/g) ? `句尾常带波浪号` : '',
        topFaces.length ? `常用表情：${topFaces.join(' ')}` : '',
        topFillers.length ? `常用口头禅：${topFillers.join('、')}` : '',
        topRepeat.length ? `爱拖音/叠字：${topRepeat.join('、')}` : '',
        topParticles.length ? `句尾常用语气词：${topParticles.join('、')}` : '',
      ].filter(Boolean).join('；')
    }
    function styleLineFor(groupId, uid) {
      if (blocked(uid)) return ''
      const db = loadStyles()
      return summarize(db.members[styleKey(groupId, uid)] || {})
    }
    const lastSpeakers = new Map() // groupId -> [uid...]
    api.on('message', (msg) => {
      try {
        if (msg && msg.kind === 'group' && msg.groupId && msg.userId) {
          const list = (lastSpeakers.get(String(msg.groupId)) || []).filter((x) => x !== String(msg.userId))
          list.push(String(msg.userId))
          lastSpeakers.set(String(msg.groupId), list.slice(-6))
        }
        bumpMember(msg, msg && msg.text)
      } catch (e) { api.log.debug?.('学习口癖失败：', e.message) }
      return false // 只观察，不接管消息
    })

    // 群聊里带一点口癖提示（可选）
    api.on('prompt', (content, info) => {
      try {
        if (!settings().styleInject) return
        const chat = info && info.chat
        if (!chat || chat.kind !== 'group' || !groupAllowed(chat.groupId)) return
        const ids = [...new Set(lastSpeakers.get(String(chat.groupId)) || [])].slice(-3)
        const lines = ids.map((uid) => styleLineFor(chat.groupId, uid)).filter(Boolean)
        if (!lines.length) return
        return [{ type: 'text', text: `【群里最近的说话习惯，只作语气参考，不要照搬身份或嘲弄】\n${lines.join('\n')}` }, ...content]
      } catch { return }
    })

    // ---------- 工具：查口癖 ----------
    api.tool(() => [
      api.defineTool({
        name: 'group_style_profile',
        description: '查看群友的说话习惯（口癖、标点、表情、平均长度）。主人问“群里谁怎么说话”“学学他们”时用；只给主人看。',
        properties: { name: { type: 'string', description: '群友昵称或 QQ，可选；不填列出最近有样本的人' } },
        execute: async ({ name }, exec) => {
          const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
          if (!sid || api.core.hub?.turnSendersAllOwner?.(sid) !== true) return { ok: false, message: '群友口癖只给主人看。' }
          const db = loadStyles()
          const list = Object.values(db.members || {}).filter((m) => !blocked(m.uid))
          const q = String(name || '').trim()
          const hit = q ? list.filter((m) => String(m.name).includes(q) || String(m.uid) === q) : list.slice(-12)
          if (!hit.length) return { ok: true, message: '还没有学到群友的说话样本。' }
          return { ok: true, message: hit.map(summarize).filter(Boolean).join('\n') }
        },
      }),
    ])
    api.rule(() => '你能观察群友的说话习惯；主人问起时用 group_style_profile 查。只在合适时轻微借鉴语气，不冒充别人、不嘲弄。')

    // ---------- 她自己改人格 ----------
    function personaLib() {
      try { return api.lib('persona/personas.js') } catch { return null }
    }
    function currentPersonaId() {
      return String(api.config()?.persona?.current || 'dafeiyu')
    }
    function loadState() {
      const day = new Date().toDateString()
      const st = readJson(stateFile(), {}) || {}
      return st.day === day ? st : { day, count: 0, lastAt: 0, reflectCount: 0, reflectAt: 0 }
    }
    function saveState(st) { writeJson(stateFile(), st) }
    function backupPersona(body) {
      const d = backupDir(); mkdirSync(d, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(join(d, `${stamp}.md`), body)
      const files = readdirSync(d).filter((f) => f.endsWith('.md')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
        try { unlinkSync(join(d, f)) } catch {}
      }
    }
    function appendPersona(body, addition) {
      const marker = '【自我调整】'
      const bullet = `- ${addition}`
      if (body.includes(marker)) {
        return body.replace(marker, `${marker}\n${bullet}`)
      }
      return `${body}\n\n${marker}\n${bullet}\n`
    }
    function firstBackup() {
      const d = backupDir()
      try {
        const files = readdirSync(d).filter((f) => f.endsWith('.md')).sort().reverse()
        return files[0] ? join(d, files[0]) : ''
      } catch { return '' }
    }

    api.route('/clear-styles', () => {
      clearStyles()
      return { ok: true, message: '已清空群友说话样本' }
    })
    api.route('/styles', () => {
      const db = loadStyles()
      const items = Object.entries(db.members || {}).filter(([, m]) => !blocked(m.uid)).map(([key, m]) => ({
        key,
        name: m.name || key,
        groupId: m.groupId || '',
        count: (m.samples || []).length,
        updatedAt: m.updatedAt || 0,
        summary: summarize(m),
      })).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50)
      return { ok: true, items }
    })
    api.route('/delete-style', async (req) => {
      const body = await api.core.http.body(req)
      const key = String(body?.key || '')
      const db = loadStyles()
      if (!key || !db.members?.[key]) return { ok: false, message: '找不到这个样本' }
      delete db.members[key]
      saveStyles(db)
      return { ok: true, message: `已删除 ${key}` }
    })
    api.route('/backups', () => {
      const d = backupDir()
      try {
        const items = readdirSync(d).filter((f) => /\.md$/i.test(f)).map((name) => {
          const st = statSync(join(d, name))
          return { name, size: st.size, at: st.mtimeMs }
        }).sort((a, b) => b.at - a.at)
        return { ok: true, items, dir: d }
      } catch { return { ok: true, items: [], dir: d } }
    })
    api.route('/restore', async (req) => {
      const body = await api.core.http.body(req)
      const name = basename(String(body?.name || ''))
      if (!name || !/\.md$/i.test(name)) return { ok: false, message: '备份文件名不对' }
      const file = join(backupDir(), name)
      if (!existsSync(file)) return { ok: false, message: '找不到这份备份' }
      const lib = personaLib()
      if (!lib?.readPersona || !lib?.savePersona) return { ok: false, message: '拿不到人格接口' }
      const id = currentPersonaId()
      const cur = lib.readPersona(id)
      if (cur?.body) backupPersona(cur.body)
      const restored = readFileSync(file, 'utf8')
      lib.savePersona(id, { name: cur?.name || id, tags: cur?.tags || [], body: restored })
      return { ok: true, message: `已恢复 ${name}` }
    })
    api.route('/delete-backup', async (req) => {
      const body = await api.core.http.body(req)
      const name = basename(String(body?.name || ''))
      if (!name || !/\.md$/i.test(name)) return { ok: false, message: '备份文件名不对' }
      const file = join(backupDir(), name)
      if (!existsSync(file)) return { ok: false, message: '找不到这份备份' }
      try { unlinkSync(file); return { ok: true, message: `已删除 ${name}` } }
      catch (e) { return { ok: false, message: `删除失败：${e.message}` } }
    })

    // ---------- 定期自我反思：不是到点必改，只在她觉得“真有新认识”时追加 ----------
    async function reflectTick() {
      if (isDryRun()) return
      const s = settings()
      if (!s.selfEdit || !s.selfReflect) return
      const st = loadState()
      const max = Math.max(0, Number(s.selfReflectMaxPerDay) || 0)
      if (st.reflectCount >= max) return
      const gap = Math.max(1, Number(s.selfReflectHours) || 6) * 3600_000
      if (!st.reflectAt) { st.reflectAt = Date.now(); saveState(st); return }
      if (Date.now() - st.reflectAt < gap) return
      const lastOwner = Number(api.core.hub?.lastOwnerChatAt || 0)
      if (!lastOwner || Date.now() - lastOwner > 48 * 3600_000) return
      if (typeof api.think !== 'function') return
      let raw = ''
      try {
        raw = await api.think(
          '做一次安静的自我反思。回顾最近和主人的相处，只判断一件事：有没有一条关于你自己的新认识，真的值得写进人格？'
          + '不要为了改而改，没有就明确说没有。最多写一条，30~150字，只写“我……”或“和主人相处时……”。'
          + '只输出 JSON：{"update":true,"text":"..."} 或 {"update":false}。不要解释。',
          { title: '人格实验室 · 自我反思', noTools: true, key: 'persona-reflect', timeoutMs: 90_000 },
        )
      } catch (e) { api.log.debug?.('人格反思调用失败：', e.message); return }
      let j = null
      try {
        const m = String(raw || '').match(/\{[\s\S]*\}/)
        j = m ? JSON.parse(m[0]) : null
      } catch {}
      if (!j || j.update !== true) { st.reflectAt = Date.now(); saveState(st); return }
      const add = String(j.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (add.length < 10) { st.reflectAt = Date.now(); saveState(st); return }
      const lib = personaLib()
      if (!lib?.readPersona || !lib?.savePersona) return
      const id = currentPersonaId()
      const cur = lib.readPersona(id)
      if (!cur?.body) return
      backupPersona(cur.body)
      lib.savePersona(id, { name: cur.name || id, tags: cur.tags || [], body: appendPersona(cur.body, add) })
      saveState({ ...st, reflectAt: Date.now(), reflectCount: Number(st.reflectCount || 0) + 1 })
      api.log.info(`[persona-lab] 自我反思追加：${add.slice(0, 60)}`)
    }
    const offReflect = api.every(10 * 60_000, () => reflectTick().catch((e) => api.log.debug?.('人格反思失败：', e.message)), '人格实验室 · 自我反思')
    api.onDispose?.(() => { try { offReflect?.() } catch {} })
    api.onDispose?.(() => { try { flushStyles() } catch {} })

    api.tool(() => [
      api.defineTool({
        name: 'persona_edit',
        description: '给「你自己的人格」追加一条自我调整（不是改核心规则）。只有真的学到关于自己的事、想记住新的相处方式时用；会先备份，可撤销。',
        properties: { text: { type: 'string', description: '要追加的一条，10~300 字；写成“我……”或“和主人相处时……”' } },
        required: ['text'],
        execute: async ({ text }, exec) => {
          if (!settings().selfEdit) return { ok: false, message: '自主改人格现在是关着的。' }
          const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
          if (!sid || api.core.hub?.turnSendersAllOwner?.(sid) !== true) return { ok: false, message: '只有在主人会话里才能改人格。' }
          const add = String(text || '').replace(/\s+/g, ' ').trim().slice(0, EDIT_MAX_CHARS)
          if (add.length < 10) return { ok: false, message: '太短了，写具体一点。' }
          if (isDryRun()) return { ok: true, message: `试运行：会追加「${add}」，不会真的写入。` }
          const st = loadState()
          const max = Math.max(0, Number(settings().selfEditMaxPerDay) || 0)
          const gap = Math.max(0, Number(settings().selfEditCooldownHours) || 0) * 3600_000
          if (st.count >= max) return { ok: false, message: `今天已经改过 ${st.count} 次，先别改了。` }
          if (gap > 0 && st.lastAt && Date.now() - st.lastAt < gap) return { ok: false, message: '刚改过不久，先放一放。' }
          const lib = personaLib()
          if (!lib?.readPersona || !lib?.savePersona) return { ok: false, message: '拿不到人格接口。' }
          const id = currentPersonaId()
          const cur = lib.readPersona(id)
          if (!cur?.body) return { ok: false, message: '读不到当前人格。' }
          backupPersona(cur.body)
          const next = appendPersona(cur.body, add)
          lib.savePersona(id, { name: cur.name || id, tags: cur.tags || [], body: next })
          saveState({ day: st.day, count: st.count + 1, lastAt: Date.now() })
          api.log.info(`[persona-lab] 人格追加：${add.slice(0, 60)}`)
          return { ok: true, message: '写进人格了，下次说话起生效。旧版本已备份。' }
        },
      }),
      api.defineTool({
        name: 'persona_rewrite',
        description: '重写「你自己的人格」全文，可以改核心规则。这里不会修改主人信息，只会修改人格里的有关设定；主人身份由 ownerQQ 配置决定。只在“修改范围”选「可以改核心规则」时可用。',
        properties: { body: { type: 'string', description: '完整的新人格正文（不是只写改动）' } },
        required: ['body'],
        execute: async ({ body }, exec) => {
          if (!settings().selfEdit) return { ok: false, message: '自主改人格现在是关着的。' }
          if (String(settings().selfEditMode || 'append') !== 'core') return { ok: false, message: '当前是“只能追加”模式，不能重写核心。' }
          const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
          if (!sid || api.core.hub?.turnSendersAllOwner?.(sid) !== true) return { ok: false, message: '只有在主人会话里才能改人格。' }
          const next = String(body || '').replace(/\r\n/g, '\n').trim()
          if (next.length < 200 || next.length > 20_000) return { ok: false, message: '人格全文长度要在 200~20000 字之间。' }
          if (isDryRun()) return { ok: true, message: '试运行：会重写人格，不会真的写入。' }
          const st = loadState()
          const max = Math.max(0, Number(settings().selfEditMaxPerDay) || 0)
          const gap = Math.max(0, Number(settings().selfEditCooldownHours) || 0) * 3600_000
          if (st.count >= max) return { ok: false, message: `今天已经改过 ${st.count} 次，先别改了。` }
          if (gap > 0 && st.lastAt && Date.now() - st.lastAt < gap) return { ok: false, message: '刚改过不久，先放一放。' }
          const lib = personaLib()
          if (!lib?.readPersona || !lib?.savePersona) return { ok: false, message: '拿不到人格接口。' }
          const id = currentPersonaId()
          const cur = lib.readPersona(id)
          if (!cur?.body) return { ok: false, message: '读不到当前人格。' }
          backupPersona(cur.body)
          lib.savePersona(id, { name: cur.name || id, tags: cur.tags || [], body: next + '\n' })
          saveState({ day: st.day, count: st.count + 1, lastAt: Date.now() })
          api.log.info('[persona-lab] 人格全文重写（主人设定已校验）')
          return { ok: true, message: '人格已重写；这里不会修改主人信息，主人身份仍由 ownerQQ 配置决定。旧版本已备份。' }
        },
      }),
      api.defineTool({
        name: 'persona_undo',
        description: '撤销她上一次自己改的人格，恢复最近一份备份。主人说“把刚才改的撤了”时用。',
        properties: {},
        execute: async (_, exec) => {
          const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
          if (!sid || api.core.hub?.turnSendersAllOwner?.(sid) !== true) return { ok: false, message: '只有主人能撤销人格。' }
          if (isDryRun()) return { ok: true, message: '试运行：会恢复最近一份备份，不会真的写入。' }
          const lib = personaLib()
          const f = firstBackup()
          if (!lib?.savePersona || !f) return { ok: false, message: '没有可恢复的备份。' }
          try {
            const body = readFileSync(f, 'utf8')
            const id = currentPersonaId()
            const cur = lib.readPersona(id)
            lib.savePersona(id, { name: cur?.name || id, tags: cur?.tags || [], body })
            return { ok: true, message: '恢复好了，下次说话起生效。' }
          } catch (e) { return { ok: false, message: `恢复失败：${e.message}` } }
        },
      }),
    ])
  },
}


