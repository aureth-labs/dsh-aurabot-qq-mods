// lib/parse.js —— 指令解析与权限门（纯函数，不碰网络不碰 api，测试好写）

/** 归一化设备名：去空白、转小写（英文型号可比） */
export function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * 解析一段文字里的米家意图。返回：
 *   { intent: 'list' }                       —— 「米家设备 / 设备列表」
 *   { intent: 'on'|'off', name }             —— 「开 客厅灯 / 关掉插座 / 打开灯」
 *   { intent: 'help' }                       —— 「米家帮助」
 *   null                                     —— 不像是米家的话
 * 识别规则：
 *   - 含「米家/小米家」且含「设备/列表/清单」→ list；只含「米家」+「帮助/怎么用」→ help
 *   - 开头是 开/打开/开一下/关/关闭/关掉 → on/off，后面全是设备名（米家前缀可剥掉）
 */
export function parseIntent(text) {
  const t = normName(text)
  if (!t) return null
  const stripped = t.replace(/米家|小米家|小米/g, '')
  if (/^(帮助|怎么用|用法|help)$/.test(stripped)) return { intent: 'help' }
  if (/^(设备|列表|清单|设备列表|设备清单|看设备|设备状态)/.test(stripped)) return { intent: 'list' }
  const m = /^(开一下|打开|开|关掉|关闭|关)\s*[:：,，]?(.+)$/.exec(stripped)
  if (m && m[2]) {
    const name = normName(m[2]).replace(/^(一下|个|下)/, '')
    if (name) return { intent: /^关/.test(m[1]) ? 'off' : 'on', name }
  }
  return null
}

/**
 * 从设备列表里模糊找设备：名字归一化后互相包含，或别名命中；多个命中返回 null 并带 candidates
 */
export function matchDevice(list, query) {
  const q = normName(query)
  if (!q) return { device: null, candidates: [] }
  const hits = (list || []).filter((d) => {
    const n = normName(d.name)
    return n && (n.includes(q) || q.includes(n))
  })
  if (hits.length === 1) return { device: hits[0], candidates: [] }
  return { device: null, candidates: hits }
}

/**
 * 权限门：这个人能不能碰米家。
 * @param {{ userId, kind }} msg   kind: 'private' | 'group'
 * @param {{ isOwner, whitelist, privateOnly }} gate  whitelist 是 QQ 号数组；主人永远放行
 * 返回 { ok, reason }，reason 是给用户的拒绝说明
 */
export function canControl(msg, gate) {
  const { isOwner, whitelist, privateOnly } = gate
  if (privateOnly && msg.kind !== 'private') {
    return { ok: false, reason: '米家控制只开了私聊，群里不碰设备。' }
  }
  if (isOwner) return { ok: true, reason: '' }
  const uid = String(msg.userId || '')
  if (whitelist.includes(uid)) return { ok: true, reason: '' }
  return { ok: false, reason: '你没有米家控制权限，请联系主人把你加进授权名单。' }
}

/** 设备列表排版成给人看的短文案（在线状态 + 名称 + 型号） */
export function formatDevices(items) {
  if (!items || !items.length) return '米家里没找到设备。'
  return items
    .map((d) => `${d.isOnline ? '●在线' : '○离线'} ${d.name}（${d.model}）`)
    .join('\n')
}

// ---- 米家规格属性名英译中（面板显示用）----
// 命中 name 或 description（不分大小写）即译中文；没收录的保留原文。
const PROP_ZH = [
  [/^(on|power|switch)$/i, '电源'],
  [/brightness/i, '亮度'],
  [/colou?r[-._ ]?temp|color_temperature/i, '色温'],
  [/volume/i, '音量'],
  [/mute/i, '静音'],
  [/temperature|temp\b/i, '温度'],
  [/humidity/i, '湿度'],
  [/pm2[_5]*|pm10/i, 'PM2.5/PM10'],
  [/co2|carbon/i, 'CO₂'],
  [/fan[-._ ]?level|fan speed|wind[-._ ]?level|speed/i, '风速'],
  [/swing/i, '摆头'],
  [/sleep/i, '睡眠'],
  [/do[-._ ]?not[-._ ]?disturb|no[-._ ]?disturb|disturb/i, '勿扰'],
  [/play[-._ ]?loop|loop[-._ ]?mode|repeat/i, '循环模式'],
  [/ringtone|ring/i, '铃声'],
  [/playing|play[-._ ]?state/i, '播放状态'],
  [/tts|tts-?text/i, '语音播报'],
  [/switch[-._ ]?status|working[-._ ]?state|run(ning)?[-._ ]?status/i, '运行状态'],
  [/target[-._ ]?position|position|curtain/i, '位置'],
  [/target[-._ ]?temperature/i, '目标温度'],
  [/mode/i, '模式'],
  [/timer|time[-._ ]?on|time[-._ ]?off/i, '定时'],
  [/battery|electric/i, '电量'],
  [/light(?!ness)/i, '氛围灯'],
  [/voice/i, '语音'],
  [/bluetooth/i, '蓝牙'],
  [/alarm/i, '闹钟'],
  [/sensitive/i, '灵敏度'],
  [/level/i, '档位'],
]

/** 规格属性英文名转中文；字典没收录返回 null（调用方保留原文） */
export function zhPropName(name, description) {
  const text = `${description || ''} ${name || ''}`
  for (const [re, zh] of PROP_ZH) {
    if (re.test(text)) return zh
  }
  return null
}

// 「核心参数」判定：当前状态列只报这些（开关永远第一），其余只进展开区
const CORE_PROP_RE = /(brightness|colou?r[-._ ]?temp|color_temperature|volume|target[-._ ]?temperature|temperature|fan[-._ ]?level|fan speed|wind[-._ ]?level|position|playing|play[-._ ]?state|humidity|pm2|mode)/i

/** 该属性是否算核心参数（状态列展示用） */
export function isCoreProp(name, description) {
  return CORE_PROP_RE.test(`${description || ''} ${name || ''}`)
}

/**
 * 按型号（model，如 yeelink.light.lamp1）粗分设备类型；型号看不出门道时按设备名兜底
 * （如「客厅灯带」的型号可能是厂商私有串，name 里的「灯带/灯」能救回来）。
 * 返回 { type, label }；对「有开关」语义的类型挂控制按钮，传感器/摄像头仅展示。
 */
export function classifyDevice(model, name = '') {
  const m = String(model || '').toLowerCase()
  const n = normName(name)
  const rules = [
    [/light|lamp|bulb|ceil|desk-?lamp|strip|lantern/, 'light', '灯', /灯|light|lamp|bulb|strip/],
    [/(^|[.-])(plug|socket|outlet|ctrl_?ln2|switch|090615|dualctrl|wirelessswitch)/, 'switch', '插座/开关', /插座|开关|插线|relay/],
    [/aircondition|acpartner|(^|[.-])ac[.-]|airer/, 'ac', '空调/晾衣机', /空调|晾衣/],
    [/curtain/, 'curtain', '窗帘', /窗帘|帘/],
    [/fan/, 'fan', '风扇', /风扇|fan/],
    [/sensor|detector|motion|weather|thermo|humid/, 'sensor', '传感器', /传感器|探测|感应/],
    [/camera|gateway|hub|remote/, 'hub', '网关/摄像头', /摄像头|网关|相机|遥控/],
  ]
  // 先看型号；型号一无所获再用名字里的关键词兜底
  for (const [re, type, label] of rules) {
    if (re.test(m)) return { type, label, controllable: !['sensor', 'hub'].includes(type) }
  }
  for (const [, type, label, nameRe] of rules) {
    if (nameRe.test(n)) return { type, label, controllable: !['sensor', 'hub'].includes(type) }
  }
  return { type: 'other', label: '其他', controllable: true }
}
