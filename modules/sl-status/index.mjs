// SnowLuma 状态：群里有人发触发词（默认 #sl）时，回一张状态卡。
// 版本、平台、运行时长照正常格式显示；平台可以在设置页里换成任何文字。
// 纯本地回复：不连 SnowLuma，不联网，也不读写文件。

const DEFAULTS = {
  enabled: true,
  triggers: '#sl',
  version: '2.4.2',
  platformPreset: 'MS-DOS',
  platformCustom: '',
}

// 平台预设。最后一个不是平台名，是「用下面输入框里的文字」。
const PRESETS = ['MS-DOS', 'Windows 98', 'Windows XP', 'Windows 7', 'Linux', 'Android', 'macOS']
const CUSTOM = 'custom'

const SETTINGS = [
  { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后触发词不再有反应' },
  { key: 'triggers', label: '触发指令', type: 'text', placeholder: '#sl', hint: '发这条消息就回状态卡；要和设置完全一致才算，多个用空格或逗号隔开，比如 #sl, #状态' },
  { key: 'version', label: '版本号', type: 'text', placeholder: '2.4.2', hint: '状态卡第二行显示的内容' },
  {
    key: 'platformPreset',
    label: '平台',
    type: 'select',
    options: [...PRESETS.map((p) => ({ value: p, label: p })), { value: CUSTOM, label: '自定义（用下面输入框）' }],
    hint: '想写什么就选「自定义」，然后在下一栏里填',
  },
  { key: 'platformCustom', label: '自定义平台文字', type: 'text', placeholder: '比如 MS-DOS 6.22', hint: '「平台」选自定义时用这里的文字；留空按 MS-DOS 显示' },
]

/** 面板里存的是字符串，统一成对象；缺的项用默认值补齐。 */
function settingsOf(api) {
  const saved = api.settings()
  return saved && typeof saved === 'object' ? { ...DEFAULTS, ...saved } : { ...DEFAULTS }
}

/** 触发词：全角 # 也算，大小写不敏感；多个触发词用空格、逗号分隔。 */
function parseTriggers(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((t) => t.replace(/＃/g, '#').trim().toLowerCase())
    .filter(Boolean)
}

/** 运行时长：不到 1 分钟只显示秒，和 SnowLuma 那边一样。 */
export function uptimeText(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分${s % 60}秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时${m % 60}分`
  return `${Math.floor(h / 24)}天${h % 24}小时`
}

function platformOf(st) {
  if (String(st.platformPreset) === CUSTOM) return String(st.platformCustom || '').trim() || 'MS-DOS'
  return String(st.platformPreset || 'MS-DOS')
}

/** 状态卡的正文。 */
export function statusCard(st, uptimeSeconds) {
  return [
    'SnowLuma 状态',
    `版本: ${String(st.version || '').trim() || '2.4.2'}`,
    `平台: ${platformOf(st)}`,
    `运行时长: ${uptimeText(uptimeSeconds)}`,
  ].join('\n')
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'sl-status',
  name: 'SnowLuma 状态',
  version: '1.0.0',
  api: 1,
  description: '谁发 #sl 就回一张 SnowLuma 状态卡，平台可自定义',
  defaults: { ...DEFAULTS },
  settings: SETTINGS,

  setup(api) {
    // 用插件进程的运行时长，和「机器人跑了多久」对得上
    const startedAt = Date.now() - Math.floor(process.uptime() * 1000)

    api.on('message', async (msg) => {
      if (!msg || msg.kind === 'system' || msg.kind === 'bot') return false
      const st = settingsOf(api)
      if (st.enabled === false) return false
      const text = String(msg.text || '').replace(/＃/g, '#').trim().toLowerCase()
      if (!text) return false
      if (!parseTriggers(st.triggers).includes(text)) return false

      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      await api.reply(msg, statusCard(st, seconds))
      api.log.debug?.(`[sl-status] 回了 ${msg.chatId || ''} 一张状态卡`)
      // 接管这条消息，别让模型再回一遍
      return true
    })

    api.log.info('[sl-status] 已加载：默认触发词 #sl')
  },
}
