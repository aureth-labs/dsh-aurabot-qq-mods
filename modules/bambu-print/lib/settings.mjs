// lib/settings.mjs —— 设置规则表 + 归一化（纯函数，不碰 Node API）
//
// 为什么单独一份：面板（panel.js）、/overview 的 rules、启动时的归一化、命令处理里的
// 「模块开没开」判定，必须读同一份规则。规则写散在几处，就会出现「页面底部保存设置」
// 和「模块实际行为」两套口径——用户看到的就是「保存按钮和规则不一样」。
//
// 约定：
// - SETTING_RULES 是唯一真相：kind / def / min / max / values / label / hint 都在这里。
// - normalizeSettings(raw) 只输出这里列出的键（绝不把 enabled / users / __panelGroup 等
//   历史键或宿主内部标记带回来），越界夹取、类型不对回落默认值。
// - 总开关用 active：宿主给模块子标签页画「开/关」小圆点时读的是 def.flag 指向的
//   defaults 项，所以 flag 必须是 active；同时 defaults / 规则表里都不出现 enabled，
//   否则宿主会在页面标题栏再画一个总开关，变成「两个开关各自为政」。
// - 老配置里只有 enabled 时，effectiveEnabled(raw) 回落到它，保证升级后开关状态不丢。

/** 各设置项的类型与边界。kind 决定怎么夹取；label / hint 直接给面板用。 */
export const SETTING_RULES = {
  active: {
    kind: 'bool',
    def: false,
    label: '总开关',
    hint: '关掉后不再响应任何打印机命令，也不会去连打印机',
  },
  multiUser: {
    kind: 'bool',
    def: true,
    label: '多用户模式',
    hint: '开着：每个 QQ 各绑各的打印机、互相看不到，别人可以用授权共享。关掉：只服务主人一个人，其他人的绑定/授权/命令一律不响应（适合只给主人自己用）。',
  },
  groupMode: {
    kind: 'enum',
    def: 'status',
    values: ['off', 'status', 'control'],
    label: '群模式',
    hint: '只作用于发起人自己的绑定；绑定者本人还能在自己的「群权限」里再收紧或放宽。',
  },
  groupPhoto: {
    kind: 'bool',
    def: true,
    label: '群聊允许拍照',
    hint: '关掉后群里只能看状态，不能要画面。',
  },
  allowGroupName: {
    kind: 'bool',
    def: false,
    label: '群里允许显示文件名',
    hint: '默认关：群里文件行显示「已脱敏」，项目名永远不显示。',
  },
  defaultInterface: {
    kind: 'enum',
    def: 'cloud',
    values: ['cloud', 'lan'],
    label: '默认接口',
    hint: '默认云端；非主人用户默认且只能是云端。',
  },
  ownerInterface: {
    kind: 'enumAllowEmpty',
    def: '',
    values: ['', 'cloud', 'lan'],
    label: '主人的接口覆盖',
    hint: '只影响主人自己。',
  },
  ownerLocalAllowed: {
    kind: 'bool',
    def: true,
    label: '允许主人使用本地接口',
    hint: '关掉后连主人也一律走云端（本地接口要求打印机和这台电脑在同一网段）。',
  },
  ownerNoCode: {
    kind: 'bool',
    def: true,
    label: '主人免码（历史开关）',
    hint: '安全码已经取消：所有账号的凭据都由这台机器的主密钥保管，主人也一样免码。这一项现在没有任何作用，代码里没有分支读它，面板上的免码状态也恒为开；关掉不会让谁需要输入安全码。',
  },
  unlockDays: {
    kind: 'int',
    def: 7,
    min: 1,
    max: 30,
    label: '解锁有效期（天）',
    hint: '到期后内存里的密钥自动清零（1~30 天，默认 7 天）。',
  },
  maxBindings: {
    kind: 'int',
    def: 5,
    min: 1,
    max: 20,
    label: '每人最多凭据数',
    hint: '一个人最多能绑几条凭据（一个云端账号算一条，可含多台）。',
  },
  requestTimeoutMs: {
    kind: 'int',
    def: 6000,
    min: 2000,
    max: 20000,
    label: '打印机超时（毫秒）',
    hint: '等打印机回执最长多久。',
  },
  selectedTtlMinutes: {
    kind: 'int',
    def: 10,
    min: 1,
    max: 60,
    label: '群内选择记忆（分钟）',
    hint: '群里点过「第几台」之后记多久（下一条不用重选）。',
  },
  tutkBridgePath: {
    kind: 'text',
    def: '',
    label: '抓帧桥路径（留空 = 用模块自带的）',
    hint: '只有想换成别的桥程序时才填。',
  },
  tutkLibPath: {
    kind: 'text',
    def: '',
    label: 'BambuSource 库路径（留空 = 先看环境变量，再看桥旁边）',
    hint: '这里不打包它（OBN 的许可证是 AGPL-3.0）。点面板里的「下载」会取回到数据目录的 bambusource/，并把路径自动填进这一项；也可以手动指向已有的库文件。',
  },
  tutkTimeoutMs: {
    kind: 'int',
    def: 20000,
    min: 3000,
    max: 60000,
    label: '抓帧超时（毫秒）',
    hint: '云端抓一帧最长等多久（3000~60000）。',
  },
  enrollBaseUrl: {
    kind: 'text',
    def: '',
    label: '登录网页地址（留空 = 用内置的 GitHub Pages）',
    hint: '用户发「/打印机 登录」时收到的链接前缀，机器人只往后拼 #k=<公钥>。建议填你自己 fork 部署的那份，别人就改不了你要点开的页面。',
  },
  enrollTtlMinutes: {
    kind: 'int',
    def: 60,
    min: 1,
    max: 1440,
    label: '信封生存时间（分钟，历史设置）',
    hint: '登录网页已经固定生成 10 分钟有效的信封；这一项现在只作参考/兼容，改了也不会改变网页的 10 分钟。',
  },
  enrollMaxTtlMinutes: {
    kind: 'int',
    def: 1440,
    min: 1,
    max: 1440,
    label: '信封最大生存时间（分钟）',
    hint: '服务端只接受不超过这个值的信封（1~1440 分钟）。会自动不低于上面那项。',
  },
}

const RULE_KEYS = Object.keys(SETTING_RULES)

/** 深拷贝一条规则（只含数据，绝不含函数），供面板 / 接口直接读。 */
function copyRule (rule) {
  const out = {}
  for (const key of Object.keys(rule)) {
    const value = rule[key]
    out[key] = Array.isArray(value) ? value.slice() : value
  }
  return out
}

/** 按一条规则归一化单个值；kind 未知时按文本处理，永远不抛错。 */
function normalizeValue (rule, value) {
  const kind = String(rule.kind || 'text')
  if (kind === 'bool') {
    // def 为 true 的键：只要没被明确关掉就是开（旧配置缺字段时保持默认开）；
    // def 为 false 的键：只有明确写 true 才算开。null / undefined 都落到 def。
    return rule.def === true ? value !== false : value === true
  }
  if (kind === 'int') {
    if (value === '' || value === null || value === undefined) return rule.def
    const n = Number(value)
    if (!Number.isFinite(n)) return rule.def
    let out = Math.round(n)
    if (Number.isFinite(rule.min)) out = Math.max(rule.min, out)
    if (Number.isFinite(rule.max)) out = Math.min(rule.max, out)
    return out
  }
  if (kind === 'enum' || kind === 'enumAllowEmpty') {
    const values = Array.isArray(rule.values) ? rule.values : []
    const text = value === null || value === undefined ? '' : String(value)
    if (values.includes(text)) return text
    return rule.def
  }
  return String(value || '').trim()
}

/**
 * 把任意来源的设置对象归一化成「只含规则表里的键」的一份新对象。
 * 未知键一律丢弃：宿主 / 旧版本写进来的 enabled、users、__panelGroup 等都不该被复制回去。
 */
export function normalizeSettings (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const key of RULE_KEYS) out[key] = normalizeValue(SETTING_RULES[key], source[key])
  // 交叉约束：最大生存时间不能小于建议生存时间，否则按网页默认值生成的信封
  // 会被服务端自己拒掉（BAD_PAYLOAD），而界面上两处都写着合法范围。
  const ttl = Number(out.enrollTtlMinutes)
  const max = Number(out.enrollMaxTtlMinutes)
  if (Number.isFinite(ttl) && Number.isFinite(max) && max < ttl) out.enrollMaxTtlMinutes = ttl
  return out
}

/** 全部规则（深拷贝）。JSON 可序列化，面板 / 接口拿到就能直接渲染表单。 */
export function describeRules () {
  const out = {}
  for (const key of RULE_KEYS) out[key] = copyRule(SETTING_RULES[key])
  return out
}

/** 单条规则；未知 key 返回 null（面板按内置兜底渲染）。 */
export function describeRule (key) {
  const rule = SETTING_RULES[String(key)]
  return rule ? copyRule(rule) : null
}

/**
 * 「模块到底开没开」的唯一判定。
 * 新配置看 active；active 没写过（老配置）才回落到 enabled，避免升级后总开关被重置。
 */
export function effectiveEnabled (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  if (source.active === true) return true
  if (source.active === undefined || source.active === null) return source.enabled === true
  return false
}
